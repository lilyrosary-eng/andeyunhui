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


pub fn music_add_track_to_playlist(
    app: AppHandle,
    playlist_id: String,
    track: PlaylistTrack,
) -> Result<(), String> {
    let conn = open_db(&app)?;
    let pos: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_track WHERE playlist_id = ?1",
            params![playlist_id],
            |r| r.get::<_, i64>(0),
        )
        .map_err(|e| format!("计算曲目位置失败: {}", e))?;
    conn.execute(
        "INSERT INTO playlist_track
         (playlist_id, track_id, position, title, artist, album, file_path, cover_path, duration_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(playlist_id, track_id) DO NOTHING",
        params![
            playlist_id,
            track.track_id,
            pos,
            track.title,
            track.artist,
            track.album,
            track.file_path,
            track.cover_path,
            track.duration_ms
        ],
    )
    .map_err(|e| format!("添加曲目到歌单失败: {}", e))?;
    Ok(())
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

pub fn music_remove_track_from_playlist(
    app: AppHandle,
    playlist_id: String,
    track_id: String,
) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "DELETE FROM playlist_track WHERE playlist_id = ?1 AND track_id = ?2",
        params![playlist_id, track_id],
    )
    .map_err(|e| format!("从歌单移除曲目失败: {}", e))?;
    // 重排 position，保持连续
    conn.execute(
        "UPDATE playlist_track SET position = (
            SELECT COUNT(*) FROM playlist_track p2
            WHERE p2.playlist_id = playlist_track.playlist_id
              AND p2.position <= playlist_track.position
        ) - 1 WHERE playlist_id = ?1",
        params![playlist_id],
    )
    .map_err(|e| format!("重排歌单位置失败: {}", e))?;
    Ok(())
}


pub fn music_reorder_playlist_track(
    app: AppHandle,
    playlist_id: String,
    track_id: String,
    new_position: i64,
) -> Result<(), String> {
    let conn = open_db(&app)?;
    // 先把目标曲目移到末尾，再按 (原 position 排序, 排除目标) 重新连续编号，
    // 最后把目标插到 new_position。避免相关子查询的 AND/OR 优先级与跨歌单污染问题。
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM playlist_track WHERE playlist_id = ?1",
            params![playlist_id],
            |r| r.get(0),
        )
        .map_err(|e| format!("查询曲目数失败: {}", e))?;
    if count == 0 {
        return Ok(());
    }
    let clamped = new_position.clamp(0, count - 1);
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("开启事务失败: {}", e))?;
    // 1) 目标曲目临时置为最大 position（排到末尾）
    tx.execute(
        "UPDATE playlist_track SET position = ?1 WHERE playlist_id = ?2 AND track_id = ?3",
        params![count, playlist_id, track_id],
    )
    .map_err(|e| format!("暂存目标曲目失败: {}", e))?;
    // 2) 其余曲目按原 position 升序重新连续编号 0..count-2
    let mut ids: Vec<String> = Vec::new();
    {
        let mut stmt = tx
            .prepare(
                "SELECT track_id FROM playlist_track
                 WHERE playlist_id = ?1 AND track_id <> ?2
                 ORDER BY position ASC",
            )
            .map_err(|e| format!("查询重排序列失败: {}", e))?;
        let mut rows = stmt
            .query(params![playlist_id, track_id])
            .map_err(|e| format!("读取重排序列失败: {}", e))?;
        while let Some(row) = rows.next().map_err(|e| format!("重排序列行迭代失败: {}", e))? {
            let id: String = row.get(0).map_err(|e| format!("重排序列行解析失败: {}", e))?;
            ids.push(id);
        }
    }
    for (i, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE playlist_track SET position = ?1 WHERE playlist_id = ?2 AND track_id = ?3",
            params![i as i64, playlist_id, id],
        )
        .map_err(|e| format!("重排曲目失败: {}", e))?;
    }
    // 3) 目标曲目放到 clamped 位置（把 >=clamped 的都后移一位）
    tx.execute(
        "UPDATE playlist_track SET position = position + 1
         WHERE playlist_id = ?1 AND track_id <> ?2 AND position >= ?3",
        params![playlist_id, track_id, clamped],
    )
    .map_err(|e| format!("后移曲目失败: {}", e))?;
    tx.execute(
        "UPDATE playlist_track SET position = ?1 WHERE playlist_id = ?2 AND track_id = ?3",
        params![clamped, playlist_id, track_id],
    )
    .map_err(|e| format!("放置目标曲目失败: {}", e))?;
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

/// 删除本地 MV 绑定（如用户取消 MV 关联）。
pub fn music_delete_mv_path(app: AppHandle, file_path: String) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "DELETE FROM track_mv_path WHERE file_path = ?1",
        params![file_path],
    )
    .map_err(|e| format!("删除 MV 绑定失败: {}", e))?;
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

/// 元数据规范化：全角空格→半角、折叠连续空白、去首尾空白、小写——用于「同一首歌」判定
fn normalize_meta(s: &str) -> String {
    let replaced: String = s.chars().map(|c| if c == '\u{3000}' { ' ' } else { c }).collect();
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
    out
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
        let mut clusters: Vec<(i64, i64, i64, String, String, String)> = Vec::new(); // (rep_dur, pc_sum, best_pc, tid, title, artist)
        for (tid, title, artist, dur, pc) in items {
            match clusters.last_mut() {
                Some(c) if (dur - c.0).abs() <= 3000 => {
                    c.1 += pc;
                    if pc > c.2 { c.2 = pc; c.3 = tid; c.4 = title; c.5 = artist; }
                }
                _ => clusters.push((dur, pc, pc, tid, title, artist)),
            }
        }
        for (_, pc, _, tid, title, artist) in clusters {
            out.push(RankingTrack { track_id: tid, title, artist, play_count: pc });
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
