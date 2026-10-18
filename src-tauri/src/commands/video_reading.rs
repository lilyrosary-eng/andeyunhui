//! 视频目录与阅读（书籍）目录扫描、打开书籍
//!
//! 本文件由 commands.rs 拆分而来（2026-10-18，P1-5 拆 god file）。
//! 约定：用 `use super::*;` 取父模块的 use 与同级 item，不要在子模块里重复 import
//! 父模块已有的依赖；确需额外 import 时写显式路径（显式优先于 glob，不会冲突）。

#![allow(dead_code)] // 部分命令仅在特定平台/配置下被 invoke_handler 引用

use super::*;
// ================= 视频模块命令 =================

/// 扫描视频根目录，流式推送结果（适合大目录）
#[tauri::command]
pub async fn scan_video_root(app: tauri::AppHandle, root_path: String) -> Result<(), String> {
    if VIDEO_SCAN_RUNNING.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return Err("扫描已在进行中，请稍后重试".to_string());
    }
    let app_handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        video_service::scan_video_root_streaming(&app_handle, &root_path)
    })
    .await;
    VIDEO_SCAN_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    result.map_err(|e| format!("扫描任务执行失败: {}", e))?
}

/// 加载视频扫描缓存（如果存在），返回 None 表示需要重新扫描
#[tauri::command]
pub fn load_video_cache(app: tauri::AppHandle, root_path: String) -> Result<Option<Vec<video_service::VideoFolder>>, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(cache_service::load_cache::<Vec<video_service::VideoFolder>>(&app_data, "video_scan", &root_path)
        .map(|(data, _mtime)| data))
}

/// 删除视频扫描缓存（重新扫描前调用）
#[tauri::command]
pub fn delete_video_cache(app: tauri::AppHandle, root_path: String) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    cache_service::delete_cache(&app_data, "video_scan", &root_path)
}

/// 获取指定文件夹下所有视频文件信息
#[tauri::command]
pub fn get_folder_videos(folder_path: String) -> Result<Vec<video_service::VideoFile>, String> {
    video_service::get_folder_videos(&folder_path)
}

// ================= 阅读模块命令 =================

/// 扫描阅读根目录，流式推送结果（适合大目录，扫整个磁盘也不卡死）
/// 使用 spawn_blocking 将同步 I/O 从 tokio 线程剥离，避免阻塞异步运行时
#[tauri::command]
pub async fn scan_reading_root(app: tauri::AppHandle, root_path: String) -> Result<Vec<reading_service::BookSummary>, String> {
    if READING_SCAN_RUNNING.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return Err("扫描已在进行中，请稍后重试".to_string());
    }
    let app_handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        reading_service::scan_reading_root_streaming(&app_handle, &root_path)
    })
    .await;
    READING_SCAN_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    result.map_err(|e| format!("扫描任务执行失败: {}", e))?
}

/// 加载阅读扫描缓存（如果存在），返回 None 表示需要重新扫描
#[tauri::command]
pub fn load_reading_cache(app: tauri::AppHandle, root_path: String) -> Result<Option<Vec<reading_service::BookSummary>>, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(cache_service::load_cache::<Vec<reading_service::BookSummary>>(&app_data, "reading_scan", &root_path)
        .map(|(data, _mtime)| data))
}

/// 流式打开书籍：先推 open-book-meta，再按章分块推 open-book-chunk，
/// 完成推 open-book-progress(done=true)。命中书籍缓存时秒开；解析结果落盘缓存。
/// 与扫描同构：spawn_blocking 卸载同步解析 + 并发锁拒绝重复打开 + 支持 cancel_open_book 取消。
#[tauri::command]
pub async fn open_book(app: tauri::AppHandle, file_path: String) -> Result<(), String> {
    if OPEN_BOOK_RUNNING.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return Err("正在打开其他书籍，请稍后".to_string());
    }
    let app_handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        reading_service::open_book_streaming(&app_handle, &file_path)
    })
    .await;
    OPEN_BOOK_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    result.map_err(|e| format!("打开书籍任务执行失败: {}", e))?
}
