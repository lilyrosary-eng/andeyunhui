//! 图片目录扫描、缓存、缩略图（含各媒体扫描互斥锁）
//!
//! 本文件由 commands.rs 拆分而来（2026-10-18，P1-5 拆 god file）。
//! 约定：用 `use super::*;` 取父模块的 use 与同级 item，不要在子模块里重复 import
//! 父模块已有的依赖；确需额外 import 时写显式路径（显式优先于 glob，不会冲突）。

#![allow(dead_code)] // 部分命令仅在特定平台/配置下被 invoke_handler 引用

use super::*;
// ================= 图片模块命令 =================

/// 扫描并发锁：防止多个扫描同时进行
pub(crate) static IMAGE_SCAN_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub(crate) static MUSIC_SCAN_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub(crate) static VIDEO_SCAN_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub(crate) static READING_SCAN_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 打开书籍并发锁（与扫描同构：已有打开任务进行中则拒绝新的打开请求）
pub(crate) static OPEN_BOOK_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 扫描图片根目录，流式推送结果（适合大目录）
/// 使用 spawn_blocking 将同步 I/O 从 tokio 线程剥离，避免阻塞异步运行时
#[tauri::command]
pub async fn scan_image_root(app: tauri::AppHandle, root_path: String) -> Result<(), String> {
    if IMAGE_SCAN_RUNNING.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return Err("扫描已在进行中，请稍后重试".to_string());
    }
    let app_handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        image_service::scan_image_root_streaming(&app_handle, &root_path)
    })
    .await;
    IMAGE_SCAN_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    result.map_err(|e| format!("扫描任务执行失败: {}", e))?
}

/// 加载图片扫描缓存，比对源目录 mtime——若目录有新变化则返回 None 触发重扫
#[tauri::command]
pub fn load_image_cache(app: tauri::AppHandle, root_path: String) -> Result<Option<Vec<image_service::ImageFolder>>, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    // 获取源目录最新 mtime
    let src_mtime = std::fs::metadata(&root_path)
        .ok().and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // 文件级缓存带有源 mtime 信封
    match cache_service::load_file_cache::<Vec<image_service::ImageFolder>>(&app_data, "image_scan", &root_path) {
        Some((data, cached_mtime)) if cached_mtime >= src_mtime => Ok(Some(data)),
        _ => Ok(None),
    }
}

/// 删除图片扫描缓存（重新扫描前调用）
#[tauri::command]
pub fn delete_image_cache(app: tauri::AppHandle, root_path: String) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    cache_service::delete_cache(&app_data, "image_scan", &root_path)
}

/// 检查文件是否存在
#[tauri::command]
pub fn check_file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

/// 取消当前扫描（同时重置并发锁）
#[tauri::command]
pub fn cancel_scan() -> Result<(), String> {
    image_service::SCAN_CANCEL.store(true, std::sync::atomic::Ordering::SeqCst);
    music_service::MUSIC_SCAN_CANCEL.store(true, std::sync::atomic::Ordering::SeqCst);
    video_service::VIDEO_SCAN_CANCEL.store(true, std::sync::atomic::Ordering::SeqCst);
    // 阅读模块用代次计数器：递增使所有进行中的扫描/打开任务失效
    reading_service::READING_SCAN_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    reading_service::OPEN_BOOK_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    IMAGE_SCAN_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    MUSIC_SCAN_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    VIDEO_SCAN_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    READING_SCAN_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    OPEN_BOOK_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    Ok(())
}

/// 取消正在进行的书籍打开（open_book 流式任务）
#[tauri::command]
pub fn cancel_open_book() -> Result<(), String> {
    // 递增代次使进行中的 open_book 任务失效（任务在章节循环中检测到代次不匹配后自行退出）
    reading_service::OPEN_BOOK_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    OPEN_BOOK_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    Ok(())
}

/// 获取指定文件夹下所有图片的完整路径列表
#[tauri::command]
pub fn get_folder_images(folder_path: String) -> Result<Vec<String>, String> {
    image_service::get_folder_images(&folder_path)
}

/// 生成缩略图（200px 宽 JPEG，首次生成后缓存复用）
/// 异步 + spawn_blocking：图像解码/编码是 CPU 密集操作，同步命令会在主线程执行，
/// 大文件夹批量生成缩略图时会直接把 UI 卡死。
#[tauri::command]
pub async fn generate_thumbnail(app: tauri::AppHandle, image_path: String, width: u32) -> Result<String, String> {
    tokio::task::spawn_blocking(move || image_service::generate_thumbnail(&app, &image_path, width))
        .await
        .map_err(|e| format!("缩略图任务失败: {e}"))?
}

#[tauri::command]
pub async fn cleanup_thumbnail_cache(app: tauri::AppHandle) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || image_service::cleanup_thumbnail_cache(&app))
        .await
        .map_err(|e| format!("清理缩略图缓存任务失败: {e}"))?
}

#[tauri::command]
pub async fn cleanup_old_caches(app: tauri::AppHandle, max_age_days: u64) -> Result<usize, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || crate::services::cache_service::cleanup_old_caches(&app_data, max_age_days))
        .await
        .map_err(|e| format!("清理旧缓存任务失败: {e}"))?
}
