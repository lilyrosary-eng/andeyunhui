//! 音乐模块持久化层（歌单 / 收藏 / 播放状态 / 听歌统计）。
//!
//! 设计借鉴 MusicStorm（MIT）的 SQLite 方案：把歌单、收藏、上次播放状态从前端
//! localStorage 迁到 SQLite，与曲库扫描解耦、落库即持久，根治「重载丢歌单」类问题。
//! 采用「命令内按需打开连接」的轻量模式（与 rag_service 一致），不引入全局 Mutex State，
//! 避免与多线程红线冲突，且桌面级并发下 SQLite 文件锁足够。

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const DB_FILENAME: &str = "music.sqlite";

/// 取应用数据目录下的 music.sqlite 路径。
fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {}", e))?;
    Ok(dir.join(DB_FILENAME))
}

/// 打开连接并初始化表结构（幂等）。
pub fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let path = db_path(app)?;
    let conn = Connection::open(&path).map_err(|e| format!("打开音乐数据库失败: {}", e))?;
    // busy_timeout 避免并发写偶发 SQLITE_BUSY（拖拽重排等高频写场景）
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;")
        .map_err(|e| format!("设置 PRAGMA 失败: {}", e))?;
    init_schema(&conn)?;
    Ok(conn)
}

/// 建表（IF NOT EXISTS），带版本迁移。
fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS playlist (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            source      TEXT NOT NULL DEFAULT 'local',
            cover_path  TEXT,
            created_at  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS playlist_track (
            playlist_id TEXT NOT NULL,
            track_id    TEXT NOT NULL,
            position    INTEGER NOT NULL DEFAULT 0,
            title       TEXT NOT NULL DEFAULT '',
            artist      TEXT NOT NULL DEFAULT '',
            album       TEXT NOT NULL DEFAULT '',
            file_path   TEXT,
            cover_path  TEXT,
            duration_ms INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (playlist_id, track_id),
            FOREIGN KEY (playlist_id) REFERENCES playlist(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_pt_playlist ON playlist_track(playlist_id);
        CREATE TABLE IF NOT EXISTS favorite (
            track_id    TEXT PRIMARY KEY,
            title       TEXT NOT NULL DEFAULT '',
            artist      TEXT NOT NULL DEFAULT '',
            album       TEXT NOT NULL DEFAULT '',
            file_path   TEXT,
            cover_path  TEXT,
            duration_ms INTEGER NOT NULL DEFAULT 0,
            added_at    INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS player_state (
            key         TEXT PRIMARY KEY,
            value       TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS play_session (
            id          TEXT PRIMARY KEY,
            track_id    TEXT NOT NULL,
            source      TEXT NOT NULL,
            title       TEXT,
            artist      TEXT,
            album       TEXT,
            file_path   TEXT,
            started_at  INTEGER NOT NULL,
            ended_at    INTEGER,
            listened_ms INTEGER NOT NULL DEFAULT 0,
            completed   INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS listen_daily (
            day          TEXT PRIMARY KEY,
            play_count   INTEGER NOT NULL DEFAULT 0,
            unique_tracks INTEGER NOT NULL DEFAULT 0,
            track_count  INTEGER NOT NULL DEFAULT 0,
            total_ms     INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS listen_day_track (
            day         TEXT NOT NULL,
            track_id    TEXT NOT NULL,
            title       TEXT NOT NULL DEFAULT '',
            artist      TEXT NOT NULL DEFAULT '',
            album       TEXT NOT NULL DEFAULT '',
            duration_ms INTEGER NOT NULL DEFAULT 0,
            play_count  INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (day, track_id)
        );
        CREATE TABLE IF NOT EXISTS track_cover_override (
            file_path  TEXT PRIMARY KEY,
            cover_path TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS track_mv_path (
            file_path TEXT PRIMARY KEY,
            mv_path   TEXT NOT NULL
        );",
    )
    .map_err(|e| format!("初始化音乐表结构失败: {}", e))?;

    // 标签写回历史（撤销的凭据）：与主表分开建，DDL 是常量，单测共用同一份避免漂移。
    conn.execute_batch(TAG_HISTORY_DDL)
        .map_err(|e| format!("初始化标签历史表失败: {}", e))?;

    // 兼容老库：CREATE TABLE IF NOT EXISTS 对已存在的表无效，
    // 若早期版本建表缺列（listen_daily.track_count / listen_day_track 的明细列），
    // 需在此 ALTER 补齐，否则 music_record_play_session 会因缺列报错。
    migrate_schema(conn)?;
    Ok(())
}

/// 给已存在的老库补列（幂等：先查 pragma table_info 判断列是否存在）。
fn migrate_schema(conn: &Connection) -> Result<(), String> {
    // listen_daily 补 track_count
    let has_track_count: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('listen_daily') WHERE name = 'track_count'",
            [],
            |r| r.get::<_, i64>(0).map(|c| c > 0),
        )
        .unwrap_or(false);
    if !has_track_count {
        conn.execute("ALTER TABLE listen_daily ADD COLUMN track_count INTEGER NOT NULL DEFAULT 0", [])
            .map_err(|e| format!("迁移 listen_daily 失败: {}", e))?;
    }
    // listen_day_track 补明细列
    for col in [
        ("title", "TEXT NOT NULL DEFAULT ''"),
        ("artist", "TEXT NOT NULL DEFAULT ''"),
        ("album", "TEXT NOT NULL DEFAULT ''"),
        ("duration_ms", "INTEGER NOT NULL DEFAULT 0"),
        ("play_count", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        let exists: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('listen_day_track') WHERE name = ?1",
                [col.0],
                |r| r.get::<_, i64>(0).map(|c| c > 0),
            )
            .unwrap_or(false);
        if !exists {
            conn.execute(
                &format!("ALTER TABLE listen_day_track ADD COLUMN {} {}", col.0, col.1),
                [],
            )
            .map_err(|e| format!("迁移 listen_day_track.{} 失败: {}", col.0, e))?;
        }
    }
    Ok(())
}

// ============ 数据结构 ============

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSummary {
    pub id: String,
    pub title: String,
    pub source: String,
    pub cover_path: Option<String>,
    pub track_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistTrack {
    pub track_id: String,
    pub position: i64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub file_path: Option<String>,
    pub cover_path: Option<String>,
    pub duration_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteTrack {
    pub track_id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub file_path: Option<String>,
    pub cover_path: Option<String>,
    pub duration_ms: i64,
    pub added_at: i64,
}

// ============ 歌单命令 ============


pub fn music_create_playlist(app: AppHandle, title: String) -> Result<PlaylistSummary, String> {
    let id = format!("pl_{}", uuid::Uuid::new_v4().simple());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let conn = open_db(&app)?;
    conn.execute(
        "INSERT INTO playlist (id, title, source, created_at) VALUES (?1, ?2, 'local', ?3)",
        params![id, title, now],
    )
    .map_err(|e| format!("创建歌单失败: {}", e))?;
    Ok(PlaylistSummary {
        id,
        title,
        source: "local".into(),
        cover_path: None,
        track_count: 0,
    })
}


pub fn music_rename_playlist(app: AppHandle, playlist_id: String, title: String) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "UPDATE playlist SET title = ?1 WHERE id = ?2",
        params![title, playlist_id],
    )
    .map_err(|e| format!("重命名歌单失败: {}", e))?;
    Ok(())
}


pub fn music_delete_playlist(app: AppHandle, playlist_id: String) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute("DELETE FROM playlist WHERE id = ?1", params![playlist_id])
        .map_err(|e| format!("删除歌单失败: {}", e))?;
    Ok(())
}


pub fn music_list_playlists(app: AppHandle) -> Result<Vec<PlaylistSummary>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.title, p.source, p.cover_path,
                    (SELECT COUNT(*) FROM playlist_track pt WHERE pt.playlist_id = p.id)
             FROM playlist p ORDER BY p.created_at ASC",
        )
        .map_err(|e| format!("查询歌单失败: {}", e))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PlaylistSummary {
                id: r.get(0)?,
                title: r.get(1)?,
                source: r.get(2)?,
                cover_path: r.get(3)?,
                track_count: r.get::<_, i64>(4)? as usize,
            })
        })
        .map_err(|e| format!("读取歌单失败: {}", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("歌单行解析失败: {}", e))?);
    }
    Ok(out)
}


pub fn music_list_playlist_tracks(app: AppHandle, playlist_id: String) -> Result<Vec<PlaylistTrack>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT track_id, position, title, artist, album, file_path, cover_path, duration_ms
             FROM playlist_track WHERE playlist_id = ?1 ORDER BY position ASC",
        )
        .map_err(|e| format!("查询歌单曲目失败: {}", e))?;
    let rows = stmt
        .query_map(params![playlist_id], |r| {
            Ok(PlaylistTrack {
                track_id: r.get(0)?,
                position: r.get(1)?,
                title: r.get(2)?,
                artist: r.get(3)?,
                album: r.get(4)?,
                file_path: r.get(5)?,
                cover_path: r.get(6)?,
                duration_ms: r.get(7)?,
            })
        })
        .map_err(|e| format!("读取歌单曲目失败: {}", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("歌单曲目行解析失败: {}", e))?);
    }
    Ok(out)
}


// 整歌单曲目同步（前端每次变更后调用）：删除旧曲目并批量插入新曲目，保持 position 连续。
// 用于前端自建歌单与 SQLite 对齐，避免逐曲 diff 的脆弱性。
pub fn music_replace_playlist_tracks(
    app: AppHandle,
    playlist_id: String,
    tracks: Vec<PlaylistTrack>,
) -> Result<(), String> {
    let conn = open_db(&app)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("开启事务失败: {}", e))?;
    tx.execute(
        "DELETE FROM playlist_track WHERE playlist_id = ?1",
        params![playlist_id],
    )
    .map_err(|e| format!("清空歌单曲目失败: {}", e))?;
    for (i, t) in tracks.iter().enumerate() {
        tx.execute(
            "INSERT OR REPLACE INTO playlist_track
             (playlist_id, track_id, position, title, artist, album, file_path, cover_path, duration_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                playlist_id,
                t.track_id,
                i as i64,
                t.title,
                t.artist,
                t.album,
                t.file_path,
                t.cover_path,
                t.duration_ms
            ],
        )
        .map_err(|e| format!("写入歌单曲目失败: {}", e))?;
    }
    tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
    Ok(())
}

// ============ 收藏命令 ============


pub fn music_set_favorite(app: AppHandle, track: FavoriteTrack, favorite: bool) -> Result<(), String> {
    let conn = open_db(&app)?;
    if favorite {
        conn.execute(
            "INSERT OR REPLACE INTO favorite
             (track_id, title, artist, album, file_path, cover_path, duration_ms, added_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                track.track_id,
                track.title,
                track.artist,
                track.album,
                track.file_path,
                track.cover_path,
                track.duration_ms,
                track.added_at
            ],
        )
        .map_err(|e| format!("收藏失败: {}", e))?;
    } else {
        conn.execute("DELETE FROM favorite WHERE track_id = ?1", params![track.track_id])
            .map_err(|e| format!("取消收藏失败: {}", e))?;
    }
    Ok(())
}


pub fn music_list_favorites(app: AppHandle) -> Result<Vec<FavoriteTrack>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT track_id, title, artist, album, file_path, cover_path, duration_ms, added_at
             FROM favorite ORDER BY added_at DESC",
        )
        .map_err(|e| format!("查询收藏失败: {}", e))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(FavoriteTrack {
                track_id: r.get(0)?,
                title: r.get(1)?,
                artist: r.get(2)?,
                album: r.get(3)?,
                file_path: r.get(4)?,
                cover_path: r.get(5)?,
                duration_ms: r.get(6)?,
                added_at: r.get(7)?,
            })
        })
        .map_err(|e| format!("读取收藏失败: {}", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("收藏行解析失败: {}", e))?);
    }
    Ok(out)
}

// ============ 播放状态持久化 ============


pub fn music_save_player_state(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "INSERT OR REPLACE INTO player_state (key, value) VALUES (?1, ?2)",
        params![key, value],
    )
    .map_err(|e| format!("保存播放状态失败: {}", e))?;
    Ok(())
}


pub fn music_get_player_state(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let conn = open_db(&app)?;
    let r = conn.query_row(
        "SELECT value FROM player_state WHERE key = ?1",
        params![key],
        |r| r.get::<_, String>(0),
    );
    match r {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("读取播放状态失败: {}", e)),
    }
}

// ============ 封面覆盖（手动设封面）============

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverOverrideRow {
    pub file_path: String,
    pub cover_path: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvPathRow {
    pub file_path: String,
    pub mv_path: String,
}

/// 写入/更新本地 MV 绑定：把 file_path 关联的 MV 视频路径持久化到 SQLite，
/// 使所有引用该 file_path 的歌单都能渲染「MV 播放」图标。
pub fn music_set_mv_path(app: AppHandle, file_path: String, mv_path: String) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "INSERT INTO track_mv_path (file_path, mv_path) VALUES (?1, ?2)
         ON CONFLICT(file_path) DO UPDATE SET mv_path = ?2",
        params![file_path, mv_path],
    )
    .map_err(|e| format!("写入 MV 绑定失败: {}", e))?;
    Ok(())
}

/// 读取全部本地 MV 绑定映射（前端挂载/扫描后加载，应用到内存 track）。
pub fn music_get_all_mv_paths(app: AppHandle) -> Result<Vec<MvPathRow>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare("SELECT file_path, mv_path FROM track_mv_path")
        .map_err(|e| format!("查询 MV 绑定失败: {}", e))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(MvPathRow {
                file_path: r.get(0)?,
                mv_path: r.get(1)?,
            })
        })
        .map_err(|e| format!("读取 MV 绑定失败: {}", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("MV 绑定行解析失败: {}", e))?);
    }
    Ok(out)
}

/// 写入封面覆盖：把 file_path 的封面固定为 cover_path（手动设封面持久化真源）。
/// 同时更新 playlist_track / favorite 中该 file_path 的 cover_path，使所有歌单即时生效。
pub fn music_set_cover_override(app: AppHandle, file_path: String, cover_path: String) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "INSERT INTO track_cover_override (file_path, cover_path) VALUES (?1, ?2)
         ON CONFLICT(file_path) DO UPDATE SET cover_path = ?2",
        params![file_path, cover_path],
    )
    .map_err(|e| format!("写入封面覆盖失败: {}", e))?;
    conn.execute(
        "UPDATE playlist_track SET cover_path = ?2 WHERE file_path = ?1",
        params![file_path, cover_path],
    )
    .map_err(|e| format!("更新歌单封面失败: {}", e))?;
    conn.execute(
        "UPDATE favorite SET cover_path = ?2 WHERE file_path = ?1",
        params![file_path, cover_path],
    )
    .map_err(|e| format!("更新收藏封面失败: {}", e))?;
    Ok(())
}

/// 删除封面覆盖（重置封面）：移除 file_path 的手动封面记录，并清空
/// playlist_track / favorite 中该 file_path 的 cover_path，使其回退到音频内嵌封面。
pub fn music_delete_cover_override(app: AppHandle, file_path: String) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "DELETE FROM track_cover_override WHERE file_path = ?1",
        params![file_path],
    )
    .map_err(|e| format!("删除封面覆盖失败: {}", e))?;
    conn.execute(
        "UPDATE playlist_track SET cover_path = NULL WHERE file_path = ?1",
        params![file_path],
    )
    .map_err(|e| format!("重置歌单封面失败: {}", e))?;
    conn.execute(
        "UPDATE favorite SET cover_path = NULL WHERE file_path = ?1",
        params![file_path],
    )
    .map_err(|e| format!("重置收藏封面失败: {}", e))?;
    Ok(())
}

/// 读取全部封面覆盖映射（前端挂载/扫描后加载，应用到内存 track）。
pub fn music_get_all_cover_overrides(app: AppHandle) -> Result<Vec<CoverOverrideRow>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare("SELECT file_path, cover_path FROM track_cover_override")
        .map_err(|e| format!("查询封面覆盖失败: {}", e))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(CoverOverrideRow {
                file_path: r.get(0)?,
                cover_path: r.get(1)?,
            })
        })
        .map_err(|e| format!("读取封面覆盖失败: {}", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("封面覆盖行解析失败: {}", e))?);
    }
    Ok(out)
}

/// 清理孤儿封面文件：删除 music_covers 目录下未被任何 track 引用的封面文件。
/// keep 为当前所有 cover_path 集合（绝对路径）。
pub fn music_clean_cover_cache(app: AppHandle, keep: Vec<String>) -> Result<usize, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 app_data 失败: {}", e))?;
    let cover_dir = dir.join("music_covers");
    if !cover_dir.is_dir() {
        return Ok(0);
    }
    let keep_set: std::collections::HashSet<String> = keep.into_iter().collect();
    let mut removed = 0usize;
    let entries = std::fs::read_dir(&cover_dir).map_err(|e| format!("读取封面目录失败: {}", e))?;
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let p = path.to_string_lossy().to_string();
        if !keep_set.contains(&p) {
            let _ = std::fs::remove_file(&path);
            removed += 1;
        }
    }
    Ok(removed)
}

// ============ 听歌统计 ============

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenStatRow {
    pub day: String,
    pub play_count: i64,
    pub track_count: i64,
    pub total_ms: i64,
}

/// 元数据规范化：多歌手分隔符归一（/ & ， 、 ； 等统一视为空格）、全角空格→半角、
/// 折叠连续空白、去首尾空白、小写——用于「同一首歌」判定。
/// 只归一不拆分不排序：乐队名（如 AC/DC）保持整体不被误拆；键是小写，显示名保留原文。
pub(crate) fn normalize_meta(s: &str) -> String {
    let replaced: String = s.chars().map(|c| match c {
        // 多歌手分隔符（半角/全角）→ 空格，使 "A/B"、"A & B"、"A、B" 归并为同一键
        '/' | '\u{FF0F}' | '&' | '\u{FF06}' | ',' | '\u{FF0C}' | ';' | '\u{FF1B}' | '、' => ' ',
        '\u{3000}' => ' ', // 全角空格
        _ => c,
    }).collect();
    let mut out = String::new();
    let mut prev_space = true;
    for c in replaced.chars() {
        if c == ' ' {
            if !prev_space { out.push(' '); prev_space = true; }
        } else {
            prev_space = false;
            out.extend(c.to_lowercase());
        }
    }
    out.trim_end().to_string()
}

/// 同一首歌判定：规范化(标题,歌手)完全一致 且 时长差 ≤3s。
/// 同一首歌被复制到多个文件夹时 track_id 不同、但元数据与时长一致 → 合并统计；
/// 不同演绎（Live/Remix/翻唱）时长不同 → 保持分开，不误合并。
/// 输入行 (track_id, title, artist, duration_ms, play_count)；返回按 play_count 降序的合并结果，
/// track_id/title/artist 取簇内播放次数最多的行。仅读取层合并，历史数据无需迁移。
fn merge_listen_tracks(
    rows: Vec<(String, String, String, i64, i64)>,
) -> Vec<RankingTrack> {
    use std::collections::HashMap;
    let mut groups: HashMap<(String, String), Vec<(String, String, String, i64, i64)>> = HashMap::new();
    for (tid, title, artist, dur, pc) in rows {
        groups
            .entry((normalize_meta(&title), normalize_meta(&artist)))
            .or_default()
            .push((tid, title, artist, dur, pc));
    }
    let mut out = Vec::new();
    for (_, mut items) in groups {
        items.sort_by_key(|(_, _, _, dur, _)| *dur);
        // 时长聚簇：排序后相邻差 ≤3000ms 归为同一演绎
        let mut clusters: Vec<(i64, i64, i64, String, String, String, i64)> = Vec::new(); // (rep_dur, pc_sum, best_pc, tid, title, artist, group_size)
        for (tid, title, artist, dur, pc) in items {
            match clusters.last_mut() {
                Some(c) if (dur - c.0).abs() <= 3000 => {
                    c.1 += pc;
                    c.6 += 1;
                    if pc > c.2 { c.2 = pc; c.3 = tid; c.4 = title; c.5 = artist; }
                }
                _ => clusters.push((dur, pc, pc, tid, title, artist, 1)),
            }
        }
        for (_, pc, _, tid, title, artist, gc) in clusters {
            out.push(RankingTrack { track_id: tid, title, artist, play_count: pc, group_count: gc });
        }
    }
    out.sort_by(|a, b| b.play_count.cmp(&a.play_count));
    out
}

/// 记录一次播放（每次切歌/开始播放调用）。同时维护 listen_daily 与 listen_day_track 聚合。
pub fn music_record_play_session(
    app: AppHandle,
    track_id: String,
    title: String,
    artist: String,
    album: String,
    duration_ms: i64,
    played_ms: i64,
) -> Result<(), String> {
    let conn = open_db(&app)?;
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    conn.execute(
        "INSERT INTO listen_daily (day, play_count, track_count, total_ms) VALUES (?1, 1, 1, ?2)
         ON CONFLICT(day) DO UPDATE SET
            play_count = play_count + 1,
            track_count = track_count + (CASE WHEN ?3 NOT IN (SELECT track_id FROM listen_day_track WHERE day = ?1) THEN 1 ELSE 0 END),
            total_ms = total_ms + ?2",
        params![date, played_ms, track_id],
    )
    .map_err(|e| format!("写入每日统计失败: {}", e))?;
    conn.execute(
        "INSERT INTO listen_day_track (day, track_id, title, artist, album, duration_ms, play_count) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)
         ON CONFLICT(day, track_id) DO UPDATE SET play_count = play_count + 1",
        params![date, track_id, title, artist, album, duration_ms],
    )
    .map_err(|e| format!("写入每日曲目统计失败: {}", e))?;
    Ok(())
}

/// 返回最近 N 天的每日汇总（按 day 升序）。track_count 读取层按「同一首歌」规则重算，
/// 避免同一首歌被复制到多个文件夹时重复计数。
pub fn music_get_listen_stats(app: AppHandle, days: i64) -> Result<Vec<ListenStatRow>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT day, play_count, track_count, total_ms FROM listen_daily
             WHERE day >= date('now', ?1) ORDER BY day ASC",
        )
        .map_err(|e| format!("查询统计失败: {}", e))?;
    let rows = stmt
        .query_map(params![format!("-{} days", days.max(1) - 1)], |r| {
            Ok(ListenStatRow {
                day: r.get(0)?,
                play_count: r.get(1)?,
                track_count: r.get(2)?,
                total_ms: r.get(3)?,
            })
        })
        .map_err(|e| format!("读取统计失败: {}", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("统计行解析失败: {}", e))?);
    }

    // 每天曲目数重算：读取区间内逐行 (day, title, artist, duration_ms)，按「同一首歌」聚簇去重
    let mut stmt = conn
        .prepare(&format!(
            "SELECT day, title, artist, duration_ms FROM listen_day_track
             WHERE day >= date('now', '-{} days')",
            days.max(1) - 1
        ))
        .map_err(|e| format!("查询每日曲目失败: {}", e))?;
    let raw = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e| format!("读取每日曲目失败: {}", e))?;
    let mut per_day: std::collections::HashMap<String, Vec<(String, String, i64)>> = std::collections::HashMap::new();
    for row in raw {
        let (day, title, artist, dur) = row.map_err(|e| format!("每日曲目行解析失败: {}", e))?;
        per_day.entry(day).or_default().push((title, artist, dur));
    }
    for row in out.iter_mut() {
        if let Some(items) = per_day.get(&row.day) {
            let mut groups: std::collections::HashMap<(String, String), Vec<i64>> = std::collections::HashMap::new();
            for (t, a, d) in items {
                groups
                    .entry((normalize_meta(t), normalize_meta(a)))
                    .or_default()
                    .push(*d);
            }
            let mut cnt = 0i64;
            for (_, mut durs) in groups {
                durs.sort_unstable();
                let mut last: Option<i64> = None;
                for d in durs {
                    match last {
                        Some(l) if (d - l).abs() <= 3000 => {}
                        _ => cnt += 1,
                    }
                    last = Some(d);
                }
            }
            row.track_count = cnt;
        }
    }
    Ok(out)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankingTrack {
    pub track_id: String,
    pub title: String,
    pub artist: String,
    pub play_count: i64,
    /// 合并来源数：同曲被复制到多个文件夹时 >1，前端显示「×N」徽章
    pub group_count: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankingArtist {
    pub artist: String,
    pub play_count: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenRanking {
    pub total_plays: i64,
    pub total_ms: i64,
    pub prev_total_plays: i64,
    pub prev_total_ms: i64,
    pub top_tracks: Vec<RankingTrack>,
    pub top_artists: Vec<RankingArtist>,
}

/// 返回最近 N 天的排行与环比：Top 歌曲、Top 歌手，以及与前 N 天的对比。
pub fn music_get_listen_ranking(app: AppHandle, days: i64) -> Result<ListenRanking, String> {
    let days = days.max(1);
    let conn = open_db(&app)?;

    // 当前区间：最近 days 天（含今天）
    let cur_cond = format!("day >= date('now', '-{} days')", days - 1);

    // 前序区间：再往前 days 天
    let prev_cond = format!(
        "day >= date('now', '-{} days') AND day < date('now', '-{} days')",
        days * 2 - 1,
        days - 1
    );

    let sum_field = |cond: &str, field: &str| -> Result<i64, String> {
        let sql = format!(
            "SELECT COALESCE(SUM({}), 0) FROM listen_daily WHERE {}",
            field, cond
        );
        let v: i64 = conn
            .query_row(&sql, [], |r| r.get(0))
            .map_err(|e| format!("统计汇总失败: {}", e))?;
        Ok(v)
    };

    let total_plays = sum_field(&cur_cond, "play_count")?;
    let total_ms = sum_field(&cur_cond, "total_ms")?;
    let prev_total_plays = sum_field(&prev_cond, "play_count")?;
    let prev_total_ms = sum_field(&prev_cond, "total_ms")?;

    // Top 歌曲：读取原始行后按「同一首歌」合并（规范化标题+歌手 100% 相等 且 时长差 ≤3s），
    // 同一首歌被复制到多个文件夹时合并统计；不同演绎（Live/Remix/翻唱）时长不同保持分开
    let mut stmt = conn
        .prepare(&format!(
            "SELECT track_id, title, artist, duration_ms, SUM(play_count) AS pc FROM listen_day_track
             WHERE day >= date('now', '-{} days') GROUP BY track_id",
            days - 1
        ))
        .map_err(|e| format!("查询 Top 歌曲失败: {}", e))?;
    let raw_tracks = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })
        .map_err(|e| format!("读取 Top 歌曲失败: {}", e))?;
    let raw_tracks = raw_tracks
        .map(|x| x.map_err(|e| format!("Top 歌曲行解析失败: {}", e)))
        .collect::<Result<Vec<_>, _>>()?;
    let mut top_tracks = merge_listen_tracks(raw_tracks);
    top_tracks.truncate(10);

    // Top 歌手：按规范化歌手名合并（同一歌手的不同写法合并统计），显示名取播放次数最多的原文
    let mut stmt = conn
        .prepare(&format!(
            "SELECT artist, SUM(play_count) AS pc FROM listen_day_track
             WHERE day >= date('now', '-{} days') AND artist IS NOT NULL AND artist != ''
             GROUP BY artist",
            days - 1
        ))
        .map_err(|e| format!("查询 Top 歌手失败: {}", e))?;
    let raw_artists = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
            ))
        })
        .map_err(|e| format!("读取 Top 歌手失败: {}", e))?;
    let mut artist_agg: std::collections::HashMap<String, (i64, String, i64)> = std::collections::HashMap::new();
    for row in raw_artists {
        let (artist, pc) = row.map_err(|e| format!("Top 歌手行解析失败: {}", e))?;
        let key = normalize_meta(&artist);
        let e = artist_agg.entry(key).or_insert((0, artist.clone(), 0));
        e.0 += pc;
        if pc > e.2 { e.2 = pc; e.1 = artist; }
    }
    let mut top_artists: Vec<RankingArtist> = artist_agg
        .into_iter()
        .map(|(_, (pc, name, _))| RankingArtist { artist: name, play_count: pc })
        .collect();
    top_artists.sort_by(|a, b| b.play_count.cmp(&a.play_count));
    top_artists.truncate(10);

    // 空 artist 兜底为「未知」
    for t in top_tracks.iter_mut() {
        if t.artist.trim().is_empty() {
            t.artist = "未知".to_string();
        }
    }
    for a in top_artists.iter_mut() {
        if a.artist.trim().is_empty() {
            a.artist = "未知".to_string();
        }
    }

    Ok(ListenRanking {
        total_plays,
        total_ms,
        prev_total_plays,
        prev_total_ms,
        top_tracks,
        top_artists,
    })
}

#[cfg(test)]
mod meta_tests {
    use super::{normalize_meta, merge_listen_tracks};

    #[test]
    fn multi_artist_separators_merge_to_same_key() {
        assert_eq!(normalize_meta("A/B"), normalize_meta("A & B"));
        assert_eq!(normalize_meta("A、B"), normalize_meta("A/B"));
        assert_eq!(normalize_meta("A，B"), normalize_meta("A & B"));
        assert_eq!(normalize_meta("周杰伦／费玉清"), normalize_meta("周杰伦 & 费玉清"));
    }

    #[test]
    fn case_and_spaces_fold() {
        assert_eq!(normalize_meta("Taylor Swift"), normalize_meta("taylor  swift"));
        assert_eq!(normalize_meta("　全角　空格　"), "全角 空格");
    }

    #[test]
    fn band_names_stay_whole_in_key() {
        // 只归一为稳定键，不拆分语义：AC/DC → "ac dc"，与 "AC DC" 同键
        assert_eq!(normalize_meta("AC/DC"), normalize_meta("AC DC"));
    }

    #[test]
    fn merge_same_song_from_two_folders() {
        // 同一首歌复制到两个文件夹：track_id 不同、元数据时长一致 → 合并，播放数累加
        let rows = vec![
            ("t1".into(), "Song".into(), "Singer".into(), 200_000, 3),
            ("t2".into(), "song".into(), "singer".into(), 200_100, 5),
        ];
        let out = merge_listen_tracks(rows);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].play_count, 8);
        // 代表行取播放次数最多的原文
        assert_eq!(out[0].track_id, "t2");
        assert_eq!(out[0].title, "song");
    }

    #[test]
    fn different_versions_stay_apart() {
        // 同名同歌手但时长差异大（Live/Remix）→ 保持分开
        let rows = vec![
            ("t1".into(), "Song".into(), "Singer".into(), 200_000, 3),
            ("t2".into(), "Song".into(), "Singer".into(), 320_000, 2),
        ];
        let out = merge_listen_tracks(rows);
        assert_eq!(out.len(), 2);
    }
}

// ============ 标签写回历史（写前快照 / 整批撤销） ============

/// 标签写回历史表。一行 = 「某批次里某个文件的改前状态」。
///
/// - `old_json`：`music_service::TagSnapshot` 的序列化，即写回**之前**文件里的字段值
/// - `cover_backup`：该次若同时换了封面，指向被覆盖掉的旧封面留底文件；没换则 NULL
///
/// 整批撤销按 `batch_id` 取出全部行逐条写回，成功后删掉这批历史 —— 撤销是一次性的，
/// 否则连点两次会把文件滚回同一个旧快照（第二次其实是"重放"而不是"撤销"）。
pub const TAG_HISTORY_DDL: &str = "
CREATE TABLE IF NOT EXISTS tag_edit_history (
    batch_id     TEXT NOT NULL,
    file_path    TEXT NOT NULL,
    old_json     TEXT NOT NULL,
    cover_backup TEXT,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (batch_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_teh_batch ON tag_edit_history(batch_id);";

/// 历史行（撤销时按行取回改前快照与封面留底路径）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagHistoryRow {
    pub file_path: String,
    pub old_json: String,
    pub cover_backup: Option<String>,
}

/// 落一条改前快照。
///
/// 同批次同文件重复写入时**保留最早那份 old_json**：一次批量刮库对同一文件可能先写字段
/// 再换封面，第二次的快照已经是"被本批改过之后"的状态，拿它撤销等于什么也没撤。
/// `cover_backup` 走 COALESCE 合并 —— 后到的那一步才带得上封面留底路径。
pub fn record_tag_snapshot_conn(
    conn: &Connection,
    batch_id: &str,
    file_path: &str,
    old_json: &str,
    cover_backup: Option<&str>,
) -> Result<(), String> {
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO tag_edit_history (batch_id, file_path, old_json, cover_backup, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(batch_id, file_path) DO UPDATE SET
            cover_backup = COALESCE(excluded.cover_backup, tag_edit_history.cover_backup)",
        params![batch_id, file_path, old_json, cover_backup, created_at],
    )
    .map_err(|e| format!("写入标签改前快照失败: {}", e))?;
    Ok(())
}

pub fn tag_history_rows_conn(conn: &Connection, batch_id: &str) -> Result<Vec<TagHistoryRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT file_path, old_json, cover_backup FROM tag_edit_history
             WHERE batch_id = ?1 ORDER BY created_at ASC, file_path ASC",
        )
        .map_err(|e| format!("准备查询标签历史失败: {}", e))?;
    let rows = stmt
        .query_map(params![batch_id], |r| {
            Ok(TagHistoryRow {
                file_path: r.get(0)?,
                old_json: r.get(1)?,
                cover_backup: r.get(2)?,
            })
        })
        .map_err(|e| format!("查询标签历史失败: {}", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("读取标签历史行失败: {}", e))?);
    }
    Ok(out)
}

/// 删除整批历史，返回删除行数。撤销成功后调用，保证撤销不可重放。
pub fn drop_tag_history_batch_conn(conn: &Connection, batch_id: &str) -> Result<usize, String> {
    conn.execute("DELETE FROM tag_edit_history WHERE batch_id = ?1", params![batch_id])
        .map_err(|e| format!("清理标签历史失败: {}", e))
}

/// 上面三个 `*_conn` 变体的 AppHandle 包装（与本项目其它命令一致的按需开连接模式），
/// 拆开两层是为了让 SQL 能用内存库直接单测。
pub fn music_record_tag_snapshot(
    app: &AppHandle,
    batch_id: &str,
    file_path: &str,
    old_json: &str,
    cover_backup: Option<&str>,
) -> Result<(), String> {
    let conn = open_db(app)?;
    record_tag_snapshot_conn(&conn, batch_id, file_path, old_json, cover_backup)
}

pub fn music_tag_history_rows(app: &AppHandle, batch_id: &str) -> Result<Vec<TagHistoryRow>, String> {
    let conn = open_db(app)?;
    tag_history_rows_conn(&conn, batch_id)
}

pub fn music_drop_tag_history_batch(app: &AppHandle, batch_id: &str) -> Result<usize, String> {
    let conn = open_db(app)?;
    drop_tag_history_batch_conn(&conn, batch_id)
}

/// 一批写回的概览（给「写回记录」面板列历史用）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagBatchRow {
    pub batch_id: String,
    /// 这批动了几个文件
    pub files: i64,
    /// 这批里有封面留底的行数（= 换过封面的文件数）
    pub covers: i64,
    /// 这批最早一条快照的时间（毫秒）
    pub created_at: i64,
    /// 文件名样本（最多几条，够人认出是哪一批就行，整份列表在点撤销时才需要）
    pub sample: Vec<String>,
    /// 是否最近一批。**只有最近一批允许撤销**，理由见 music_service::rollback_tag_batch
    pub latest: bool,
}

/// 按批次汇总历史，新的在前。
///
/// `sample_each` 是每条批次带几个文件名样本 —— 面板靠它认「这批是哪次操作」，
/// 不需要全部文件名（一次批量刮库可能几百个文件，全塞进 IPC 只是白给）。
pub fn tag_batches_conn(
    conn: &Connection,
    limit: i64,
    sample_each: usize,
) -> Result<Vec<TagBatchRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT batch_id, COUNT(*), MIN(created_at),
                    SUM(CASE WHEN cover_backup IS NOT NULL THEN 1 ELSE 0 END)
             FROM tag_edit_history
             GROUP BY batch_id
             ORDER BY MIN(created_at) DESC, batch_id DESC
             LIMIT ?1",
        )
        .map_err(|e| format!("准备批次汇总失败: {}", e))?;
    let mut rows: Vec<TagBatchRow> = Vec::new();
    let listed = stmt
        .query_map(params![limit], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e| format!("汇总批次失败: {}", e))?;
    for row in listed {
        let (batch_id, files, created_at, covers) =
            row.map_err(|e| format!("读取批次汇总失败: {}", e))?;
        rows.push(TagBatchRow {
            batch_id,
            files,
            covers,
            created_at,
            sample: Vec::new(),
            latest: false,
        });
    }
    // 文件名样本按批次数取，N 很小（面板一屏），不做 JOIN 是为了让 SQL 各自可读
    for (i, r) in rows.iter_mut().enumerate() {
        let mut s = conn
            .prepare(
                "SELECT file_path FROM tag_edit_history WHERE batch_id = ?1
                 ORDER BY file_path ASC LIMIT ?2",
            )
            .map_err(|e| format!("准备批次文件样本失败: {}", e))?;
        let got = s
            .query_map(params![r.batch_id, sample_each as i64], |row| row.get::<_, String>(0))
            .map_err(|e| format!("查询批次文件样本失败: {}", e))?;
        for v in got.flatten() {
            r.sample.push(v);
        }
        // 排序第一条就是全表最新的一批（上面按 MIN(created_at) 倒排）
        r.latest = i == 0;
    }
    Ok(rows)
}

pub fn music_tag_batches(app: &AppHandle, limit: i64) -> Result<Vec<TagBatchRow>, String> {
    let conn = open_db(app)?;
    tag_batches_conn(&conn, limit, 6)
}

#[cfg(test)]
mod history_tests {
    use super::*;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().expect("内存库打开失败");
        conn.execute_batch(TAG_HISTORY_DDL).expect("建历史表失败");
        conn
    }

    #[test]
    fn 快照写入后可按批次读回并带着封面留底路径() {
        let conn = mem_db();
        record_tag_snapshot_conn(&conn, "b1", "/m/a.flac", r#"{"title":"旧"}"#, Some("/bak/a_1.jpg"))
            .unwrap();
        record_tag_snapshot_conn(&conn, "b1", "/m/b.flac", r#"{"title":"B"}"#, None).unwrap();
        record_tag_snapshot_conn(&conn, "b2", "/m/a.flac", r#"{"title":"别的批次"}"#, None).unwrap();

        let rows = tag_history_rows_conn(&conn, "b1").unwrap();
        assert_eq!(rows.len(), 2, "只应取到本批次的两行");
        assert_eq!(rows[0].file_path, "/m/a.flac");
        assert_eq!(rows[0].cover_backup.as_deref(), Some("/bak/a_1.jpg"));
        assert_eq!(rows[1].cover_backup, None);
    }

    #[test]
    fn 同批次同文件保留最早快照_封面留底后补进来() {
        let conn = mem_db();
        // 批量刮库对同一文件：第一步写字段（此时还没换封面），第二步换封面才产生留底
        record_tag_snapshot_conn(&conn, "b1", "/m/a.flac", r#"{"title":"本批之前的标题"}"#, None).unwrap();
        record_tag_snapshot_conn(
            &conn,
            "b1",
            "/m/a.flac",
            r#"{"title":"已被本批改过之后的标题"}"#,
            Some("/bak/a_2.jpg"),
        )
        .unwrap();
        let rows = tag_history_rows_conn(&conn, "b1").unwrap();
        assert_eq!(rows.len(), 1);
        // 撤销要回到「这批动手之前」，所以 earliest 的 old_json 不能被后一次覆盖
        assert_eq!(rows[0].old_json, r#"{"title":"本批之前的标题"}"#);
        assert_eq!(rows[0].cover_backup.as_deref(), Some("/bak/a_2.jpg"));
    }

    #[test]
    fn 已有封面留底不会被后到的空值抹掉() {
        let conn = mem_db();
        record_tag_snapshot_conn(&conn, "b1", "/m/a.flac", "{}", Some("/bak/a_1.jpg")).unwrap();
        record_tag_snapshot_conn(&conn, "b1", "/m/a.flac", "{}", None).unwrap();
        let rows = tag_history_rows_conn(&conn, "b1").unwrap();
        assert_eq!(rows[0].cover_backup.as_deref(), Some("/bak/a_1.jpg"));
    }

    #[test]
    fn 撤销后整批历史被清空_防止重放() {
        let conn = mem_db();
        record_tag_snapshot_conn(&conn, "b1", "/m/a.flac", "{}", None).unwrap();
        record_tag_snapshot_conn(&conn, "b1", "/m/b.flac", "{}", None).unwrap();
        record_tag_snapshot_conn(&conn, "b2", "/m/c.flac", "{}", None).unwrap();

        assert_eq!(drop_tag_history_batch_conn(&conn, "b1").unwrap(), 2);
        assert!(tag_history_rows_conn(&conn, "b1").unwrap().is_empty());
        // 其它批次不受牵连
        assert_eq!(tag_history_rows_conn(&conn, "b2").unwrap().len(), 1);
    }

    #[test]
    fn 批次汇总新的在前_只有第一条算最近一批() {
        let conn = mem_db();
        record_tag_snapshot_conn(&conn, "b1", "/m/a.flac", "{}", Some("/bak/a.jpg")).unwrap();
        record_tag_snapshot_conn(&conn, "b1", "/m/b.flac", "{}", None).unwrap();
        record_tag_snapshot_conn(&conn, "b2", "/m/c.flac", "{}", None).unwrap();

        let all = tag_batches_conn(&conn, 20, 6).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].batch_id, "b2", "同毫秒时按批次号倒排，新写的批次在前");
        assert_eq!(all[1].batch_id, "b1");
        assert!(all[0].latest, "只有最近一批该是 latest");
        assert!(!all[1].latest, "更早那批绝不能带 latest —— 前端据此不给撤销入口");
        // 每批各自的计数不能互相串
        assert_eq!((all[1].files, all[1].covers, all[1].latest), (2, 1, false));
        assert_eq!((all[0].files, all[0].covers), (1, 0));
    }

    #[test]
    fn 批次汇总的文件名样本有上限_条数受_limit_约束() {
        let conn = mem_db();
        for i in 0..10 {
            record_tag_snapshot_conn(&conn, "big", &format!("/m/{}.flac", i), "{}", None).unwrap();
        }
        record_tag_snapshot_conn(&conn, "small", "/m/z.flac", "{}", None).unwrap();

        let got = tag_batches_conn(&conn, 5, 3).unwrap();
        assert_eq!(got.len(), 2, "批次数少于 limit 时全给");
        let big_row = got.iter().find(|b| b.batch_id == "big").unwrap();
        assert_eq!(big_row.files, 10, "计数是总数，不受样本条数影响");
        assert_eq!(big_row.sample.len(), 3, "样本按 sample_each 截断，一次刮库几百文件不该全进 IPC");
        assert!(big_row.sample.iter().all(|p| p.starts_with("/m/")));
        assert!(!got.iter().any(|b| b.batch_id == "不存在的批次"));

        let only_one = tag_batches_conn(&conn, 1, 6).unwrap();
        assert_eq!(only_one.len(), 1);
        assert_eq!(only_one[0].batch_id, "small");
        assert!(only_one[0].latest, "limit=1 时那一条就是全表最新");
    }

    #[test]
    fn 闸门_撤销更早批次必须被后端拦住() {
        // 判据要在后端：面板上列历史 = 多给了一种点法，只靠前端隐藏按钮等于没拦
        let src = include_str!("music_service.rs");
        let body = src
            .split("pub fn rollback_tag_batch(")
            .nth(1)
            .expect("rollback_tag_batch 应存在")
            .split("\n}\n")
            .next()
            .unwrap();
        assert!(
            body.contains("music_tag_batches(app, 1)"),
            "撤销必须先比对是不是最近一批"
        );
        let at = body
            .find("music_tag_batches(app, 1)")
            .expect("批次比对应在 rollback 体内");
        let write_at = body
            .find("restore_one(")
            .expect("restore_one 调用应存在");
        assert!(
            at < write_at,
            "批次比对必须排在真正写回之前 —— 先拦再动文件"
        );
    }
}
