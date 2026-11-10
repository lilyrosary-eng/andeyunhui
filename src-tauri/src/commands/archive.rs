//! 存档快照（笔记/文件变动即存档，可恢复）
//!
//! 本文件由 commands.rs 拆分而来（2026-10-18，P1-5 拆 god file）。
//! 约定：用 `use super::*;` 取父模块的 use 与同级 item，不要在子模块里重复 import
//! 父模块已有的依赖；确需额外 import 时写显式路径（显式优先于 glob，不会冲突）。

#![allow(dead_code)] // 部分命令仅在特定平台/配置下被 invoke_handler 引用

use super::*;
// ================= 通用存档（快照）命令 =================

/// 生成一份存档快照（content 为 base64 编码，支持二进制）。
#[tauri::command]
pub async fn archive_snapshot(
    app: tauri::AppHandle,
    kind: String,
    source_id: String,
    name: String,
    content_base64: String,
    ext: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || archive_snapshot_impl(app, kind, source_id, name, content_base64, ext))
        .await
        .map_err(|e| format!("archive_snapshot 任务失败: {e}"))?
}

/// 同步实现（内部用；不要直接作为命令暴露 —— 同步命令跑在主线程）
fn archive_snapshot_impl(
    app: tauri::AppHandle,
    kind: String,
    source_id: String,
    name: String,
    content_base64: String,
    ext: String,
) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let bytes = base64_decode(content_base64.trim().as_bytes())
        .map_err(|e| format!("存档解码失败: {}", e))?;
    transfer_station::archive_snapshot(&app_data, &kind, &source_id, &name, &bytes, &ext)
        .map(|_| ())
        .ok_or_else(|| "存档写入失败".to_string())
}

/// 列出所有存档快照。
#[tauri::command]
pub fn list_archives(app: tauri::AppHandle) -> Result<Vec<transfer_station::ArchiveEntry>, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(transfer_station::list_archives(&app_data))
}

/// 回收站用量摘要（条数 / 已占用字节 / 配额）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveUsage {
    pub count: usize,
    pub total_bytes: u64,
    pub limit_bytes: u64,
    pub limit_entries: usize,
}

#[tauri::command]
pub fn archives_usage(app: tauri::AppHandle) -> Result<ArchiveUsage, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(ArchiveUsage {
        count: transfer_station::list_archives(&app_data).len(),
        total_bytes: transfer_station::archive_total_bytes(&app_data),
        limit_bytes: transfer_station::MAX_ARCHIVE_BYTES,
        limit_entries: transfer_station::MAX_ARCHIVE_ENTRIES,
    })
}

/// 恢复存档到原位置（原目录不可用时回退到中转站），返回实际写入的绝对路径。
///
/// ★ async + spawn_blocking：这里要 `fs::read` 整个快照再 `fs::write` 出去。
///   回收站里可能有上百 MB 的文件，同步命令跑在主线程上会让整个界面卡住
///   （与 `load_image_cache` 同一类事故），所以必须挪到阻塞线程池。
#[tauri::command]
pub async fn restore_archive(app: tauri::AppHandle, id: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
        transfer_station::restore_archive(&app_data, &id)
    })
    .await
    .map_err(|e| format!("restore_archive 任务失败: {e}"))?
}

/// 删除单个存档快照。
#[tauri::command]
pub fn delete_archive(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    transfer_station::delete_archive(&app_data, &id)
}

/// 清空所有存档快照。
#[tauri::command]
pub fn clear_archives(app: tauri::AppHandle) -> Result<u32, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    transfer_station::clear_archives(&app_data)
}
