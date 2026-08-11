//! 音乐模块持久化层（歌单 / 收藏 / 播放状态 / 听歌统计）。
//!
//! 设计借鉴 MusicStorm（MIT）的 SQLite 方案：把歌单、收藏、上次播放状态从前端
//! localStorage 迁到 SQLite，与曲库扫描解耦、落库即持久，根治「重载丢歌单」类问题。
//! 采用「命令内按需打开连接」的轻量模式（与 rag_service 一致），不引入全局 Mutex State，
//! 避免与多线程红线冲突，且桌面级并发下 SQLite 文件锁足够。

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
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
fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let path = db_path(app)?;
    let conn = Connection::open(&path).map_err(|e| format!("打开音乐数据库失败: {}", e))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("设置外键失败: {}", e))?;
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
            total_ms     INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS listen_day_track (
            day       TEXT NOT NULL,
            track_id  TEXT NOT NULL,
            PRIMARY KEY (day, track_id)
        );",
    )
    .map_err(|e| format!("初始化音乐表结构失败: {}", e))
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
        "INSERT OR REPLACE INTO playlist_track
         (playlist_id, track_id, position, title, artist, album, file_path, cover_path, duration_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
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
    conn.execute(
        "UPDATE playlist_track SET position = ?1 WHERE playlist_id = ?2 AND track_id = ?3",
        params![new_position, playlist_id, track_id],
    )
    .map_err(|e| format!("调整曲目顺序失败: {}", e))?;
    // 归一化，消除重复 position
    conn.execute(
        "UPDATE playlist_track SET position = (
            SELECT COUNT(*) FROM playlist_track p2
            WHERE p2.playlist_id = playlist_track.playlist_id
              AND p2.position < playlist_track.position
              OR (p2.position = playlist_track.position AND p2.track_id <= playlist_track.track_id)
        ) - 1 WHERE playlist_id = ?1",
        params![playlist_id],
    )
    .map_err(|e| format!("归一化顺序失败: {}", e))?;
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

// 占位：避免未使用导入告警（Path 在后续 Phase 2 封面缓存会用到）
#[allow(dead_code)]
fn _unused(_: &Path) {}
