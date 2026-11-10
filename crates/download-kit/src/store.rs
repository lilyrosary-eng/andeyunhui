//! SQLite 事实源：任务表 + 分片表。
//!
//! 分片表就是分片清单：每一片记录 `start/end/downloaded/state/temp_path`，
//! 进程重启后按 `downloaded` 继续，不需要重新规划。

use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::types::{DownloadPart, DownloadTask, EngineKind, PartState, TaskStatus};
use crate::util::now_ms;

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  urls            TEXT NOT NULL,
  save_path       TEXT NOT NULL,
  filename        TEXT NOT NULL,
  referer         TEXT,
  cookie          TEXT,
  user_agent      TEXT,
  headers         TEXT NOT NULL DEFAULT '{}',
  engine          TEXT NOT NULL,
  resolved_engine TEXT,
  status          TEXT NOT NULL,
  total_bytes     INTEGER NOT NULL DEFAULT 0,
  downloaded_bytes INTEGER NOT NULL DEFAULT 0,
  max_bytes       INTEGER,
  connections     INTEGER NOT NULL DEFAULT 1,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  completed_at    INTEGER
);

CREATE TABLE IF NOT EXISTS parts (
  task_id    TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  url        TEXT NOT NULL,
  start      INTEGER NOT NULL,
  end        INTEGER NOT NULL,
  downloaded INTEGER NOT NULL DEFAULT 0,
  state      TEXT NOT NULL,
  temp_path  TEXT NOT NULL,
  PRIMARY KEY (task_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at);
"#;

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(base: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(base)
            .map_err(|e| format!("创建下载数据目录失败 {}: {e}", base.display()))?;
        let path = base.join("tasks.db");
        let conn = Connection::open(&path)
            .map_err(|e| format!("打开下载数据库失败 {}: {e}", path.display()))?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|e| format!("设置数据库忙等待失败: {e}"))?;
        conn.execute_batch(SCHEMA)
            .map_err(|e| format!("初始化下载数据库失败: {e}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.conn
            .lock()
            .map_err(|_| "下载数据库锁已损坏".to_string())
    }

    pub fn insert_task(&self, task: &DownloadTask) -> Result<(), String> {
        let urls = serde_json::to_string(&task.urls)
            .map_err(|e| format!("序列化下载地址失败: {e}"))?;
        let headers = serde_json::to_string(&task.headers)
            .map_err(|e| format!("序列化请求头失败: {e}"))?;
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO tasks (
                id, urls, save_path, filename, referer, cookie, user_agent, headers,
                engine, resolved_engine, status, total_bytes, downloaded_bytes, max_bytes,
                connections, error, created_at, updated_at, completed_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
            params![
                task.id,
                urls,
                task.save_path,
                task.filename,
                task.referer,
                task.cookie,
                task.user_agent,
                headers,
                task.engine.as_str(),
                task.resolved_engine.map(|e| e.as_str()),
                task.status.as_str(),
                task.total_bytes as i64,
                task.downloaded_bytes as i64,
                task.max_bytes.map(|v| v as i64),
                task.connections as i64,
                task.error,
                task.created_at,
                task.updated_at,
                task.completed_at,
            ],
        )
        .map_err(|e| format!("写入下载任务失败: {e}"))?;
        Ok(())
    }

    pub fn task(&self, id: &str) -> Result<Option<DownloadTask>, String> {
        let conn = self.lock()?;
        conn.query_row(
            "SELECT * FROM tasks WHERE id = ?1",
            params![id],
            row_to_task,
        )
        .optional()
        .map_err(|e| format!("读取下载任务失败: {e}"))
    }

    pub fn tasks(
        &self,
        status: Option<TaskStatus>,
        limit: usize,
    ) -> Result<Vec<DownloadTask>, String> {
        let conn = self.lock()?;
        let limit = limit.max(1).min(500) as i64;
        let rows = match status {
            Some(status) => {
                let mut stmt = conn
                    .prepare("SELECT * FROM tasks WHERE status = ?1 ORDER BY created_at DESC LIMIT ?2")
                    .map_err(|e| format!("查询下载任务失败: {e}"))?;
                let collected = stmt
                    .query_map(params![status.as_str(), limit], row_to_task)
                    .map_err(|e| format!("查询下载任务失败: {e}"))?
                    .collect::<Result<Vec<_>, _>>();
                collected
            }
            None => {
                let mut stmt = conn
                    .prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?1")
                    .map_err(|e| format!("查询下载任务失败: {e}"))?;
                let collected = stmt
                    .query_map(params![limit], row_to_task)
                    .map_err(|e| format!("查询下载任务失败: {e}"))?
                    .collect::<Result<Vec<_>, _>>();
                collected
            }
        }
        .map_err(|e| format!("读取下载任务行失败: {e}"))?;
        Ok(rows)
    }

    /// 取最早入队且仍在排队的任务。
    pub fn next_queued(&self) -> Result<Option<DownloadTask>, String> {
        let conn = self.lock()?;
        conn.query_row(
            "SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1",
            [],
            row_to_task,
        )
        .optional()
        .map_err(|e| format!("读取排队任务失败: {e}"))
    }

    /// 原子认领：只有仍处于 queued 时才能切到 downloading，避免暂停/并发抢跑。
    pub fn claim_queued(&self, id: &str) -> Result<bool, String> {
        let conn = self.lock()?;
        let changed = conn
            .execute(
                "UPDATE tasks SET status = 'downloading', updated_at = ?1
                 WHERE id = ?2 AND status = 'queued'",
                params![now_ms(), id],
            )
            .map_err(|e| format!("认领下载任务失败: {e}"))?;
        Ok(changed > 0)
    }

    /// 仅当任务仍处于 `allowed_from` 中的状态时才更新，返回是否真的改到。
    pub fn update_status_guarded(
        &self,
        id: &str,
        status: TaskStatus,
        error: Option<&str>,
        allowed_from: &[TaskStatus],
    ) -> Result<bool, String> {
        if allowed_from.is_empty() {
            return Ok(false);
        }
        // 状态字面量来自固定枚举，不拼接用户输入。
        let allowed = allowed_from
            .iter()
            .map(|s| format!("'{}'", s.as_str()))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "UPDATE tasks SET status = ?1, error = ?2, updated_at = ?3
             WHERE id = ?4 AND status IN ({allowed})"
        );
        let conn = self.lock()?;
        let changed = conn
            .execute(&sql, params![status.as_str(), error, now_ms(), id])
            .map_err(|e| format!("更新下载任务状态失败: {e}"))?;
        Ok(changed > 0)
    }

    pub fn update_progress(&self, id: &str, downloaded: u64, total: u64) -> Result<(), String> {
        let conn = self.lock()?;
        conn.execute(
            "UPDATE tasks SET downloaded_bytes = ?1, total_bytes = ?2, updated_at = ?3 WHERE id = ?4",
            params![downloaded as i64, total as i64, now_ms(), id],
        )
        .map_err(|e| format!("更新下载进度失败: {e}"))?;
        Ok(())
    }

    pub fn update_meta(
        &self,
        id: &str,
        engine: EngineKind,
        filename: &str,
        total: u64,
    ) -> Result<(), String> {
        let conn = self.lock()?;
        conn.execute(
            "UPDATE tasks SET resolved_engine = ?1, filename = ?2, total_bytes = ?3, updated_at = ?4 WHERE id = ?5",
            params![engine.as_str(), filename, total as i64, now_ms(), id],
        )
        .map_err(|e| format!("更新下载任务元信息失败: {e}"))?;
        Ok(())
    }

    pub fn complete(&self, id: &str, downloaded: u64, total: u64) -> Result<bool, String> {
        let conn = self.lock()?;
        let changed = conn
            .execute(
                "UPDATE tasks
                 SET status = 'completed', downloaded_bytes = ?1, total_bytes = ?2,
                     error = NULL, completed_at = ?3, updated_at = ?3
                 WHERE id = ?4 AND status IN ('probing','downloading','merging')",
                params![downloaded as i64, total as i64, now_ms(), id],
            )
            .map_err(|e| format!("标记下载完成失败: {e}"))?;
        Ok(changed > 0)
    }

    pub fn reset_progress(&self, id: &str) -> Result<(), String> {
        let conn = self.lock()?;
        conn.execute(
            "UPDATE tasks SET downloaded_bytes = 0, updated_at = ?1 WHERE id = ?2",
            params![now_ms(), id],
        )
        .map_err(|e| format!("重置下载进度失败: {e}"))?;
        Ok(())
    }

    pub fn parts(&self, task_id: &str) -> Result<Vec<DownloadPart>, String> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare("SELECT * FROM parts WHERE task_id = ?1 ORDER BY idx ASC")
            .map_err(|e| format!("查询下载分片失败: {e}"))?;
        let rows = stmt
            .query_map(params![task_id], row_to_part)
            .map_err(|e| format!("查询下载分片失败: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("读取下载分片行失败: {e}"))?;
        Ok(rows)
    }

    pub fn replace_parts(&self, task_id: &str, parts: &[DownloadPart]) -> Result<(), String> {
        let mut conn = self.lock()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("开启分片事务失败: {e}"))?;
        tx.execute("DELETE FROM parts WHERE task_id = ?1", params![task_id])
            .map_err(|e| format!("清理旧分片失败: {e}"))?;
        for part in parts {
            tx.execute(
                "INSERT INTO parts (task_id, idx, url, start, end, downloaded, state, temp_path)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    task_id,
                    part.index as i64,
                    part.url,
                    part.start as i64,
                    part.end as i64,
                    part.downloaded as i64,
                    part.state.as_str(),
                    part.temp_path,
                ],
            )
            .map_err(|e| format!("写入下载分片失败: {e}"))?;
        }
        tx.commit()
            .map_err(|e| format!("提交分片事务失败: {e}"))?;
        Ok(())
    }

    pub fn update_part(&self, task_id: &str, part: &DownloadPart) -> Result<(), String> {
        let conn = self.lock()?;
        conn.execute(
            "UPDATE parts SET downloaded = ?1, state = ?2 WHERE task_id = ?3 AND idx = ?4",
            params![
                part.downloaded as i64,
                part.state.as_str(),
                task_id,
                part.index as i64
            ],
        )
        .map_err(|e| format!("更新下载分片失败: {e}"))?;
        Ok(())
    }

    pub fn delete_parts(&self, task_id: &str) -> Result<(), String> {
        let conn = self.lock()?;
        conn.execute("DELETE FROM parts WHERE task_id = ?1", params![task_id])
            .map_err(|e| format!("删除下载分片失败: {e}"))?;
        Ok(())
    }

    /// 启动恢复：把上一进程遗留的活动态改成排队或暂停。
    /// 外部引擎（aria2/ffmpeg）的临时产物不动，续传由各自引擎处理。
    pub fn recover_stale(&self, resume: bool) -> Result<u32, String> {
        let target = if resume {
            TaskStatus::Queued
        } else {
            TaskStatus::Paused
        };
        let conn = self.lock()?;
        let changed = conn
            .execute(
                "UPDATE tasks SET status = ?1, updated_at = ?2
                 WHERE status IN ('probing','downloading','merging')",
                params![target.as_str(), now_ms()],
            )
            .map_err(|e| format!("恢复下载任务失败: {e}"))?;
        Ok(changed as u32)
    }
}

fn row_to_task(row: &Row<'_>) -> rusqlite::Result<DownloadTask> {
    let urls_raw: String = row.get("urls")?;
    let headers_raw: String = row.get("headers")?;
    let engine_raw: String = row.get("engine")?;
    let resolved_raw: Option<String> = row.get("resolved_engine")?;
    let status_raw: String = row.get("status")?;
    Ok(DownloadTask {
        id: row.get("id")?,
        urls: serde_json::from_str(&urls_raw).unwrap_or_default(),
        save_path: row.get("save_path")?,
        filename: row.get("filename")?,
        referer: row.get("referer")?,
        cookie: row.get("cookie")?,
        user_agent: row.get("user_agent")?,
        headers: serde_json::from_str(&headers_raw).unwrap_or_default(),
        engine: EngineKind::parse(&engine_raw).unwrap_or_default(),
        resolved_engine: resolved_raw.as_deref().and_then(EngineKind::parse),
        status: TaskStatus::parse(&status_raw).unwrap_or(TaskStatus::Failed),
        total_bytes: row.get::<_, i64>("total_bytes")? as u64,
        downloaded_bytes: row.get::<_, i64>("downloaded_bytes")? as u64,
        max_bytes: row.get::<_, Option<i64>>("max_bytes")?.map(|v| v as u64),
        connections: row.get::<_, i64>("connections")?.max(1) as u32,
        error: row.get("error")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        completed_at: row.get("completed_at")?,
    })
}

fn row_to_part(row: &Row<'_>) -> rusqlite::Result<DownloadPart> {
    let state_raw: String = row.get("state")?;
    Ok(DownloadPart {
        index: row.get::<_, i64>("idx")? as u32,
        url: row.get("url")?,
        start: row.get::<_, i64>("start")? as u64,
        end: row.get::<_, i64>("end")? as u64,
        downloaded: row.get::<_, i64>("downloaded")? as u64,
        state: PartState::parse(&state_raw).unwrap_or(PartState::Pending),
        temp_path: row.get("temp_path")?,
    })
}
