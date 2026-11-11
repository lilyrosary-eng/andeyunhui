//! Tauri 命令层：统一 `dl_` 前缀，宿主只需注册一次。
//!
//! 管理器按进程惰性初始化（首次命令触发）：拆掉本 crate 的依赖与这些注册项即可整体移除。

use std::path::Path;
use std::sync::{Mutex, OnceLock};

use tauri::AppHandle;

use crate::manager::DownloadManager;
use crate::types::{
    DownloadSpec, DownloadTask, EngineConfig, EngineStatus, ProbeRequest, ProbeResult, TaskDetail,
    TaskStatus,
};
use crate::util::{filename_from_url, is_metalink_url, is_p2p_url};

static MANAGER: OnceLock<DownloadManager> = OnceLock::new();
static INIT_LOCK: Mutex<()> = Mutex::new(());

/// 宿主注入的写入范围校验（插件能力模型）。
///
/// download-kit 自己不依赖插件的授权账本，只留一个函数指针；宿主在启动时把
/// `plugin_access::ensure_plugin_write` 接进来，crate 依旧是可整体拆卸的。
type WriteGuard = fn(&AppHandle, Option<&str>, &str) -> Result<(), String>;
static WRITE_GUARD: OnceLock<WriteGuard> = OnceLock::new();

pub fn set_write_guard(guard: WriteGuard) {
    let _ = WRITE_GUARD.set(guard);
}

fn ensure_write(app: &AppHandle, plugin_id: Option<&str>, path: &str) -> Result<(), String> {
    if let Some(guard) = WRITE_GUARD.get() {
        guard(app, plugin_id, path)?;
    }
    Ok(())
}

/// 取进程内单例管理器。
///
/// `pub` 是给宿主用的：中转站要把「已完成的下载」合并进自己的列表，必须复用**同一个**
/// 管理器实例——自己 `DownloadManager::init()` 会再起一个 scheduler，
/// 两个调度器抢同一个 `tasks.db`，表现是任务被重复认领、进度抖动。
pub fn manager(app: &AppHandle) -> Result<DownloadManager, String> {
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
///
/// 目录目标且 URL 本身拿不到可用文件名时，先做一次 HEAD/GET 探测拿
/// `Content-Disposition` / 重定向后的名字（失败不影响入队）。
#[tauri::command]
pub async fn dl_enqueue(
    app: AppHandle,
    plugin_id: Option<String>,
    mut spec: DownloadSpec,
) -> Result<String, String> {
    ensure_write(&app, plugin_id.as_deref(), &spec.save_path)?;
    let manager = manager(&app)?;
    if should_probe_filename(&spec) {
        let url = spec
            .urls
            .iter()
            .map(|value| value.trim())
            .find(|value| !value.is_empty())
            .unwrap_or_default()
            .to_string();
        let request = ProbeRequest {
            url,
            referer: spec.referer.clone(),
            cookie: spec.cookie.clone(),
            user_agent: spec.user_agent.clone(),
            headers: spec.headers.clone(),
        };
        if let Ok(result) = manager.probe(request).await {
            spec.filename = result.filename;
        }
    }
    manager.enqueue(spec)
}

/// 目录目标 + 地址末尾没有可用扩展名时才探测，避免给每条下载都加一次 HEAD。
fn should_probe_filename(spec: &DownloadSpec) -> bool {
    if spec
        .filename
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        return false;
    }
    let urls: Vec<&str> = spec
        .urls
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .collect();
    if urls.len() != 1 {
        return false;
    }
    let url = urls[0];
    if !(url.starts_with("http://") || url.starts_with("https://"))
        || is_p2p_url(url)
        || is_metalink_url(url)
    {
        return false;
    }
    let save = spec.save_path.trim();
    let directory_target = save.ends_with('/') || save.ends_with('\\') || Path::new(save).is_dir();
    if !directory_target {
        return false;
    }
    match filename_from_url(url) {
        Some(name) => match Path::new(&name).extension().and_then(|value| value.to_str()) {
            Some(extension) => GENERIC_URL_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()),
            None => true,
        },
        None => true,
    }
}

/// 这些后缀通常只是动态下载入口，不是真实文件类型，值得再探一次名字。
const GENERIC_URL_EXTENSIONS: &[&str] = &[
    "php", "asp", "aspx", "jsp", "cgi", "html", "htm", "do", "action",
];

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

/// 已完成的下载任务（宿主用，**不是**命令）。
///
/// 中转站把「已落盘的文件」并入自己的列表时用它。只返回 completed：
/// pending/downloading 的文件在磁盘上还不完整，列出来会让用户对一个半成品
/// 做重命名/删除，那是在改一个正在被写入的文件。
pub fn completed_tasks(app: &AppHandle, limit: usize) -> Result<Vec<DownloadTask>, String> {
    manager(app)?.list(Some(TaskStatus::Completed), limit)
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
pub fn dl_cancel(
    app: AppHandle,
    plugin_id: Option<String>,
    id: String,
    delete_file: Option<bool>,
) -> Result<(), String> {
    let manager = manager(&app)?;
    let delete_file = delete_file.unwrap_or(true);
    if delete_file {
        // 删除落盘文件前同样过一遍写入范围校验，避免第三方插件借取消删别人的文件。
        let task = manager.get(&id)?.task;
        ensure_write(&app, plugin_id.as_deref(), &task.save_path)?;
    }
    manager.cancel(&id, delete_file)
}

/// 忘掉一条任务记录：**只删库，不删磁盘文件**。
#[tauri::command]
pub fn dl_forget(app: AppHandle, plugin_id: Option<String>, id: String) -> Result<(), String> {
    // 只删记录，不涉及路径；保留 plugin_id 参数是为了走统一的插件能力注入。
    let _ = plugin_id;
    manager(&app)?.forget(&id)
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
