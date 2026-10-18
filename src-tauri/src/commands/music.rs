//! 音乐库扫描、缓存、歌单、收藏、播放态、听歌统计、封面/MV
//!
//! 本文件由 commands.rs 拆分而来（2026-10-18，P1-5 拆 god file）。
//! 约定：用 `use super::*;` 取父模块的 use 与同级 item，不要在子模块里重复 import
//! 父模块已有的依赖；确需额外 import 时写显式路径（显式优先于 glob，不会冲突）。

#![allow(dead_code)] // 部分命令仅在特定平台/配置下被 invoke_handler 引用

use super::*;
// ================= 音乐模块命令 =================

/// 扫描音乐根目录，流式推送结果（适合大目录）
/// 使用 spawn_blocking 将同步 I/O 从 tokio 线程剥离，避免阻塞异步运行时
#[tauri::command]
pub async fn scan_music_root(app: tauri::AppHandle, root_path: String) -> Result<(), String> {
    if MUSIC_SCAN_RUNNING.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return Err("扫描已在进行中，请稍后重试".to_string());
    }
    let app_handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        music_service::scan_music_root_streaming(&app_handle, &root_path)
    })
    .await;
    MUSIC_SCAN_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    result.map_err(|e| format!("扫描任务执行失败: {}", e))?
}

/// 加载音乐扫描缓存（如果存在），返回 None 表示需要重新扫描。
/// 载荷含源根目录 mtime，由前端比对目录是否变更来决定是否复用缓存。
#[tauri::command]
pub fn load_music_cache(app: tauri::AppHandle, root_path: String) -> Result<Option<music_service::MusicCachePayload>, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(cache_service::load_cache::<music_service::MusicCachePayload>(&app_data, "music_scan", &root_path)
        .map(|(data, _mtime)| data))
}

/// 取目录最后修改时间（毫秒），用于判断音乐缓存是否需要失效重扫。
#[tauri::command]
pub fn get_dir_mtime(path: String) -> u64 {
    let p = std::path::Path::new(&path);
    if !p.is_dir() {
        return 0;
    }
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 删除音乐扫描缓存（重新扫描前调用）
#[tauri::command]
pub fn delete_music_cache(app: tauri::AppHandle, root_path: String) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    cache_service::delete_cache(&app_data, "music_scan", &root_path)
}

/// 读取单个音频文件的元数据（标题/歌手/专辑/时长/内嵌封面）。
/// 供「手动添加歌曲」（非目录扫描）复用与目录扫描完全一致的解析逻辑
/// （music_service::extract_track_metadata），从而识别手动添加歌曲的元信息。
#[tauri::command]
pub fn read_track_metadata(app: tauri::AppHandle, file_path: String) -> music_service::Track {
    let cover_dir = app.path().app_data_dir().ok().map(|d| d.join("music_covers"));
    if let Some(ref dir) = cover_dir {
        let _ = std::fs::create_dir_all(dir);
    }
    music_service::extract_track_metadata(std::path::Path::new(&file_path), cover_dir.as_deref())
}

// ================= 音乐：歌单 / 收藏 / 播放状态持久化（SQLite，借鉴 MusicStorm MIT） =================
use crate::services::music_db;

// 薄封装：命令统一在 commands 模块导出（bin 的 generate_handler 引用 andeyunhui_lib::commands::*），
// 实际落库逻辑在 services::music_db。

#[tauri::command]
pub fn music_create_playlist(app: tauri::AppHandle, title: String) -> Result<music_db::PlaylistSummary, String> {
    music_db::music_create_playlist(app, title)
}

#[tauri::command]
pub fn music_rename_playlist(app: tauri::AppHandle, playlist_id: String, title: String) -> Result<(), String> {
    music_db::music_rename_playlist(app, playlist_id, title)
}

#[tauri::command]
pub fn music_delete_playlist(app: tauri::AppHandle, playlist_id: String) -> Result<(), String> {
    music_db::music_delete_playlist(app, playlist_id)
}

#[tauri::command]
pub fn music_list_playlists(app: tauri::AppHandle) -> Result<Vec<music_db::PlaylistSummary>, String> {
    music_db::music_list_playlists(app)
}

#[tauri::command]
pub fn music_list_playlist_tracks(app: tauri::AppHandle, playlist_id: String) -> Result<Vec<music_db::PlaylistTrack>, String> {
    music_db::music_list_playlist_tracks(app, playlist_id)
}

#[tauri::command]
pub fn music_replace_playlist_tracks(app: tauri::AppHandle, playlist_id: String, tracks: Vec<music_db::PlaylistTrack>) -> Result<(), String> {
    music_db::music_replace_playlist_tracks(app, playlist_id, tracks)
}

#[tauri::command]
pub fn music_set_favorite(app: tauri::AppHandle, track: music_db::FavoriteTrack, favorite: bool) -> Result<(), String> {
    music_db::music_set_favorite(app, track, favorite)
}

#[tauri::command]
pub fn music_list_favorites(app: tauri::AppHandle) -> Result<Vec<music_db::FavoriteTrack>, String> {
    music_db::music_list_favorites(app)
}

#[tauri::command]
pub fn music_save_player_state(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    music_db::music_save_player_state(app, key, value)
}

#[tauri::command]
pub fn music_get_player_state(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    music_db::music_get_player_state(app, key)
}

#[tauri::command]
pub fn music_record_play_session(
    app: tauri::AppHandle,
    track_id: String,
    title: String,
    artist: String,
    album: String,
    duration_ms: i64,
    played_ms: i64,
) -> Result<(), String> {
    music_db::music_record_play_session(app, track_id, title, artist, album, duration_ms, played_ms)
}

#[tauri::command]
pub fn music_get_listen_stats(app: tauri::AppHandle, days: i64) -> Result<Vec<music_db::ListenStatRow>, String> {
    music_db::music_get_listen_stats(app, days)
}

#[tauri::command]
pub fn music_get_listen_ranking(app: tauri::AppHandle, days: i64) -> Result<music_db::ListenRanking, String> {
    music_db::music_get_listen_ranking(app, days)
}

#[tauri::command]
pub fn music_set_cover(
    app: tauri::AppHandle,
    file_path: String,
    data_base64: String,
    mime: Option<String>,
) -> Result<String, String> {
    music_service::set_cover_from_base64(&app, file_path, data_base64, mime)
}

/// 按远程 URL 下载封面并写入音频文件内嵌标签（用于自动获取元信息）。
#[tauri::command]
pub async fn music_set_cover_url(
    app: tauri::AppHandle,
    file_path: String,
    url: String,
) -> Result<String, String> {
    music_service::set_cover_from_url(&app, file_path, url).await
}

#[tauri::command]
pub fn music_rescan_metadata(app: tauri::AppHandle, file_path: String) -> Result<music_service::Track, String> {
    music_service::rescan_track_metadata(&app, file_path)
}

#[tauri::command]
pub fn music_edit_track(
    app: tauri::AppHandle,
    file_path: String,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    track_number: Option<u32>,
) -> Result<(), String> {
    music_service::edit_track_tags(&app, file_path, title, artist, album, track_number)
}

#[tauri::command]
pub fn music_get_all_cover_overrides(app: tauri::AppHandle) -> Result<Vec<music_db::CoverOverrideRow>, String> {
    music_db::music_get_all_cover_overrides(app)
}

#[tauri::command]
pub fn music_delete_cover_override(app: tauri::AppHandle, file_path: String) -> Result<(), String> {
    music_db::music_delete_cover_override(app, file_path)
}

#[tauri::command]
pub fn music_clean_cover_cache(app: tauri::AppHandle, keep: Vec<String>) -> Result<usize, String> {
    music_db::music_clean_cover_cache(app, keep)
}

#[tauri::command]
pub fn music_set_mv_path(
    app: tauri::AppHandle,
    file_path: String,
    mv_path: String,
) -> Result<(), String> {
    music_db::music_set_mv_path(app, file_path, mv_path)
}

#[tauri::command]
pub fn music_get_all_mv_paths(
    app: tauri::AppHandle,
) -> Result<Vec<music_db::MvPathRow>, String> {
    music_db::music_get_all_mv_paths(app)
}
