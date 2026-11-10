//! Tauri 命令层：统一 `dl_` 前缀，宿主只需注册一次。
//!
//! 管理器按进程惰性初始化（首次命令触发）：拆掉本 crate 的依赖与这些注册项即可整体移除。

use std::sync::{Mutex, OnceLock};

use tauri::AppHandle;

use crate::manager::DownloadManager;
use crate::types::{
    DownloadSpec, DownloadTask, EngineConfig, EngineStatus, ProbeRequest, ProbeResult, TaskDetail,
    TaskStatus,
};

static MANAGER: OnceLock<DownloadManager> = OnceLock::new();
static INIT_LOCK: Mutex<()> = Mutex::new(());

fn manager(app: &AppHandle) -> Result<DownloadManager, String> {
    if let Some(existing) = MANAGER.get() {
        return Ok(existing.clone());
    }
    let _guard = INIT_LOCK
        .lock()
        .map_err(|_| "下载管理器初始化锁已损坏".to_string())?;
    if let Some(existing) = MANAGER.get() {
        return Ok(existing.clone());
    }
    let created = DownloadManager::init(app.clone())?;
    let _ = MANAGER.set(created);
    MANAGER
        .get()
        .cloned()
        .ok_or_else(|| "下载管理器初始化失败".to_string())
}

/// 入队一个下载任务，返回任务 ID。
#[tauri::command]
pub fn dl_enqueue(app: AppHandle, spec: DownloadSpec) -> Result<String, String> {
    manager(&app)?.enqueue(spec)
}

/// 列出任务；`status` 为空表示全部，`limit` 默认 200。
#[tauri::command]
pub fn dl_list(
    app: AppHandle,
    status: Option<TaskStatus>,
    limit: Option<usize>,
) -> Result<Vec<DownloadTask>, String> {
    manager(&app)?.list(status, limit.unwrap_or(200))
}

/// 单任务详情（含分片明细）。
#[tauri::command]
pub fn dl_get(app: AppHandle, id: String) -> Result<TaskDetail, String> {
    manager(&app)?.get(&id)
}

#[tauri::command]
pub fn dl_pause(app: AppHandle, id: String) -> Result<(), String> {
    manager(&app)?.pause(&id)
}

#[tauri::command]
pub fn dl_resume(app: AppHandle, id: String) -> Result<(), String> {
    manager(&app)?.resume(&id)
}

/// 失败重试：语义与 resume 一致，单独命名方便前端区分按钮文案。
#[tauri::command]
pub fn dl_retry(app: AppHandle, id: String) -> Result<(), String> {
    manager(&app)?.resume(&id)
}

/// 取消任务；`delete_file` 默认 true（连同半成品/分片一起清理）。
#[tauri::command]
pub fn dl_cancel(app: AppHandle, id: String, delete_file: Option<bool>) -> Result<(), String> {
    manager(&app)?.cancel(&id, delete_file.unwrap_or(true))
}

#[tauri::command]
pub fn dl_config_get(app: AppHandle) -> Result<EngineConfig, String> {
    Ok(manager(&app)?.config())
}

#[tauri::command]
pub fn dl_config_set(app: AppHandle, config: EngineConfig) -> Result<EngineConfig, String> {
    manager(&app)?.set_config(config)
}

/// 引擎可用性总览（native 恒可用；aria2/ffmpeg 给出自动发现到的路径）。
#[tauri::command]
pub fn dl_engines(app: AppHandle) -> Result<EngineStatus, String> {
    Ok(manager(&app)?.engines())
}

/// 探测 URL：大小 / 是否支持 Range / 最终地址 / 文件名。
#[tauri::command]
pub async fn dl_probe(
    app: AppHandle,
    request: ProbeRequest,
) -> Result<ProbeResult, String> {
    manager(&app)?.probe(request).await
}
