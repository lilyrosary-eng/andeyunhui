//! Windows 更新编排：检查走官方 updater（配置/清单/签名元数据），
//! 下载走项目内的 download-kit（Range 续传 / 多源镜像 / 重试 / 取消 / SHA-256），
//! 安装交给 SYSTEM 计划任务里的 helper（/UPDATE /S），避免 perMachine 每次更新弹 UAC。
//! 非 Windows 仅返回“不支持”，不引入任何新行为。

use serde::Serialize;
use tauri::AppHandle;

const TASK_NAME: &str = "AndeYunhuiUpdateHelper";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub supported: bool,
    pub available: bool,
    pub current_version: String,
    pub version: Option<String>,
    pub date: Option<String>,
    pub body: Option<String>,
    pub download_url: Option<String>,
    /// 安装包大小（清单里的 size，字节）。
    pub size: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    phase: String,
    version: String,
    downloaded: u64,
    total: u64,
    speed: f64,
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::collections::BTreeMap;
    use std::fs;
    use std::io::Read;
    use std::path::Path;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use reqwest::header::RANGE;
    use sha2::{Digest, Sha256};
    use tauri::Emitter;
    use tauri_plugin_updater::UpdaterExt;

    use download_kit::commands::manager as download_manager;
    use download_kit::{DownloadSpec, EngineKind, TaskStatus};

    /// 当前下载任务 ID；取消命令据此操作 download-kit。
    static ACTIVE_TASK: Mutex<Option<String>> = Mutex::new(None);

    fn program_data_root() -> PathBuf {
        std::env::var_os("ProgramData")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
            .join("AndeYunhuiUpdater")
    }

    fn staging_dir() -> PathBuf {
        program_data_root().join("staging")
    }

    fn request_file() -> PathBuf {
        staging_dir().join("request.json")
    }

    fn status_file() -> PathBuf {
        program_data_root().join("status.json")
    }

    pub fn logs_dir() -> PathBuf {
        program_data_root().join("logs")
    }

    fn run_hidden(program: &str, args: &[&str]) -> Result<std::process::Output, String> {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        Command::new(program)
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("执行 {program} 失败: {e}"))
    }

    fn task_installed() -> bool {
        run_hidden("schtasks", &["/query", "/tn", TASK_NAME])
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    /// 正常用配置里的 endpoints；测试时可用 ANDEYUNHUI_UPDATE_ENDPOINT
    /// 指向一个临时 HTTPS 清单（如 GitHub prerelease 的 latest.json），不改变最终发布地址。
    fn build_updater(
        app: &AppHandle,
    ) -> Result<tauri_plugin_updater::Updater, String> {
        let mut builder = app.updater_builder();
        if let Ok(endpoint) = std::env::var("ANDEYUNHUI_UPDATE_ENDPOINT") {
            let endpoint = endpoint.trim();
            if !endpoint.is_empty() {
                let url = reqwest::Url::parse(endpoint)
                    .map_err(|e| format!("测试更新端点无效: {e}"))?;
                builder = builder
                    .endpoints(vec![url])
                    .map_err(|e| format!("测试更新端点不可用: {e}"))?;
            }
        }
        builder
            .build()
            .map_err(|e| format!("初始化更新器失败: {e}"))
    }

    fn sha256_file(path: &Path) -> Result<String, String> {
        let mut file = fs::File::open(path)
            .map_err(|e| format!("打开安装包失败 {}: {e}", path.display()))?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 1024 * 1024];
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|e| format!("读取安装包失败: {e}"))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok(format!("{:x}", hasher.finalize()))
    }

    fn clear_active_task() {
        if let Ok(mut guard) = ACTIVE_TASK.lock() {
            *guard = None;
        }
    }

    pub fn cancel(app: &AppHandle) -> Result<(), String> {
        let id = ACTIVE_TASK
            .lock()
            .ok()
            .and_then(|guard| guard.clone());
        if let Some(id) = id {
            if let Ok(manager) = download_manager(app) {
                // 取消并删除半成品；错误忽略：任务可能已经结束。
                let _ = manager.cancel(&id, true);
            }
        }
        Ok(())
    }

    pub fn open_logs() -> Result<(), String> {
        let dir = logs_dir();
        fs::create_dir_all(&dir).map_err(|e| format!("创建日志目录失败: {e}"))?;
        Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("打开日志目录失败: {e}"))?;
        Ok(())
    }

    pub async fn check(app: AppHandle) -> Result<UpdateInfo, String> {
        let updater = build_updater(&app)?;
        let update = updater
            .check()
            .await
            .map_err(|e| format!("检查更新失败: {e}"))?;
        let current_version = app.package_info().version.to_string();

        Ok(match update {
            Some(update) => {
                let (_, _, size) = manifest_extra(&update);
                UpdateInfo {
                    supported: true,
                    available: true,
                    current_version,
                    version: Some(update.version.clone()),
                    date: update.date.map(|date| date.to_string()),
                    body: update.body.clone(),
                    download_url: Some(update.download_url.to_string()),
                    size,
                }
            }
            None => UpdateInfo {
                supported: true,
                available: false,
                current_version,
                version: None,
                date: None,
                body: None,
                download_url: None,
                size: None,
            },
        })
    }

    fn collect_extra(
        value: &serde_json::Value,
        mirrors: &mut Vec<String>,
        sha256: &mut Option<String>,
        size: &mut Option<u64>,
    ) {
        if let Some(list) = value.get("mirrors").and_then(|item| item.as_array()) {
            for item in list {
                if let Some(url) = item.as_str() {
                    let url = url.trim();
                    if !url.is_empty() {
                        mirrors.push(url.to_string());
                    }
                }
            }
        }
        if sha256.is_none() {
            if let Some(value) = value.get("sha256").and_then(|item| item.as_str()) {
                if !value.trim().is_empty() {
                    *sha256 = Some(value.trim().to_string());
                }
            }
        }
        if size.is_none() {
            if let Some(value) = value.get("size").and_then(|item| item.as_u64()) {
                if value > 0 {
                    *size = Some(value);
                }
            }
        }
    }

    /// 清单里的扩展字段：`mirrors`（安装包镜像）、`sha256`、`size`。
    /// 官方 manifest 只规定 url/signature，扩展字段会原样保留在 raw_json。
    fn manifest_extra(
        update: &tauri_plugin_updater::Update,
    ) -> (Vec<String>, Option<String>, Option<u64>) {
        let mut mirrors = Vec::new();
        let mut sha256 = None;
        let mut size = None;
        let raw = &update.raw_json;

        if let Some(platforms) = raw.get("platforms").and_then(|value| value.as_object()) {
            let candidates = [
                update.target.clone(),
                format!("{}-nsis", update.target),
                "windows-x86_64-nsis".to_string(),
                "windows-x86_64".to_string(),
            ];
            let mut found = false;
            for key in &candidates {
                if let Some(platform) = platforms.get(key) {
                    collect_extra(platform, &mut mirrors, &mut sha256, &mut size);
                    found = true;
                    break;
                }
            }
            if !found {
                for platform in platforms.values() {
                    collect_extra(platform, &mut mirrors, &mut sha256, &mut size);
                    if !mirrors.is_empty() || sha256.is_some() || size.is_some() {
                        break;
                    }
                }
            }
        }
        collect_extra(raw, &mut mirrors, &mut sha256, &mut size);
        mirrors.dedup();
        (mirrors, sha256, size)
    }

    /// 下载前的轻量预检：只发 1 字节 Range，快速判断主源/镜像是否可达。
    /// 被墙的 GitHub 通常几秒内就失败，而不是让用户盯着 0% 等重试。
    async fn reachable_urls(urls: &[String]) -> Vec<String> {
        let Ok(client) = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(4))
            .timeout(Duration::from_secs(8))
            .user_agent(concat!("andeyunhui-updater/", env!("CARGO_PKG_VERSION")))
            .build()
        else {
            return urls.to_vec();
        };

        let mut reachable = Vec::new();
        for url in urls {
            match client
                .get(url.as_str())
                .header(RANGE, "bytes=0-0")
                .send()
                .await
            {
                Ok(response)
                    if response.status().is_success()
                        || response.status() == reqwest::StatusCode::PARTIAL_CONTENT =>
                {
                    reachable.push(url.clone());
                }
                _ => {}
            }
        }
        reachable
    }

    pub async fn download_and_apply(app: AppHandle) -> Result<(), String> {
        if !task_installed() {
            return Err("更新助手未安装：请先用本版本的安装包装一次（之后更新不再需要）".into());
        }

        let updater = build_updater(&app)?;
        let Some(update) = updater
            .check()
            .await
            .map_err(|e| format!("检查更新失败: {e}"))?
        else {
            return Err("当前已是最新版本".into());
        };

        let staging = staging_dir();
        fs::create_dir_all(&staging).map_err(|e| format!("创建更新目录失败: {e}"))?;
        let setup_path = staging.join("setup.exe");
        let parts_dir = PathBuf::from(format!("{}.parts", setup_path.display()));

        // 清掉上一次进程崩溃时遗留的同路径下载任务，避免旧 scheduler 与新任务抢写同一个文件。
        if let Ok(manager) = download_manager(&app) {
            if let Ok(tasks) = manager.list(None, 200) {
                let target = setup_path.to_string_lossy();
                for task in tasks {
                    if task
                        .save_path
                        .eq_ignore_ascii_case(target.as_ref())
                    {
                        if task.status == TaskStatus::Completed {
                            let _ = manager.forget(&task.id);
                        } else {
                            let _ = manager.cancel(&task.id, true);
                            let _ = manager.forget(&task.id);
                        }
                    }
                }
            }
        }

        // 上一轮残留的安装包/分片文件不能参与本轮续传。
        let _ = fs::remove_file(&setup_path);
        let _ = fs::remove_dir_all(&parts_dir);

        let (mirrors, expected_sha, package_size) = manifest_extra(&update);
        let mut candidates = Vec::with_capacity(1 + mirrors.len());
        candidates.push(update.download_url.to_string());
        candidates.extend(mirrors);
        candidates.dedup();

        let reachable = reachable_urls(&candidates).await;
        if reachable.is_empty() {
            return Err(
                "无法连接更新服务器（主源与镜像均不可达）。可稍后重试，或打开发布页手动下载。"
                    .into(),
            );
        }
        let primary = reachable[0].clone();
        let mirror_urls = reachable[1..].to_vec();

        let manager = download_manager(&app)?;
        let spec = DownloadSpec {
            urls: vec![primary],
            save_path: setup_path.to_string_lossy().into_owned(),
            filename: None,
            referer: None,
            cookie: None,
            user_agent: None,
            headers: BTreeMap::new(),
            engine: EngineKind::Auto,
            connections: Some(32),
            max_bytes: Some(2 * 1024 * 1024 * 1024),
            mirrors: mirror_urls,
            sha256: expected_sha.clone(),
            max_speed: None,
            priority: 0,
        };
        let task_id = manager.enqueue(spec)?;
        if let Ok(mut guard) = ACTIVE_TASK.lock() {
            *guard = Some(task_id.clone());
        }

        let version = update.version.clone();
        let started = Instant::now();
        let deadline = Duration::from_secs(30 * 60);
        let mut last_bytes = 0u64;
        let mut last_sample = Instant::now();

        let downloaded = loop {
            tokio::time::sleep(Duration::from_millis(300)).await;

            let manager_for_poll = manager.clone();
            let id_for_poll = task_id.clone();
            let detail = tokio::task::spawn_blocking(move || manager_for_poll.get(&id_for_poll))
                .await
                .map_err(|e| format!("读取下载状态失败: {e}"))?
                .map_err(|e| format!("读取下载状态失败: {e}"))?;
            let task = detail.task;

            match task.status {
                TaskStatus::Completed => break task.downloaded_bytes,
                TaskStatus::Failed => {
                    let _ = manager.cancel(&task_id, true);
                    let _ = manager.forget(&task_id);
                    clear_active_task();
                    return Err(task
                        .error
                        .unwrap_or_else(|| "下载更新失败（主源与镜像均失败）".into()));
                }
                TaskStatus::Canceled => {
                    let _ = manager.forget(&task_id);
                    clear_active_task();
                    return Err("更新已取消".into());
                }
                _ => {}
            }

            if started.elapsed() > deadline {
                let _ = manager.cancel(&task_id, true);
                let _ = manager.forget(&task_id);
                clear_active_task();
                return Err("下载超时（30 分钟），可稍后重试或手动下载。".into());
            }

            let now = Instant::now();
            let elapsed = now.duration_since(last_sample).as_secs_f64().max(0.001);
            let speed = task.downloaded_bytes.saturating_sub(last_bytes) as f64 / elapsed;
            last_bytes = task.downloaded_bytes;
            last_sample = now;

            let _ = app.emit(
                "update-progress",
                UpdateProgress {
                    phase: "downloading".into(),
                    version: version.clone(),
                    downloaded: task.downloaded_bytes,
                    total: if task.total_bytes > 0 {
                        task.total_bytes
                    } else {
                        package_size.unwrap_or(0)
                    },
                    speed,
                },
            );
        };

        let _ = manager.forget(&task_id);
        clear_active_task();

        let setup_size = fs::metadata(&setup_path)
            .map_err(|e| format!("读取安装包大小失败: {e}"))?
            .len();
        let digest = sha256_file(&setup_path)?;
        if let Some(expected) = &expected_sha {
            if !digest.eq_ignore_ascii_case(expected.trim_start_matches("sha256:")) {
                let _ = fs::remove_file(&setup_path);
                return Err("安装包 SHA-256 校验失败，已丢弃。".into());
            }
        }

        let _ = app.emit(
            "update-progress",
            UpdateProgress {
                phase: "installing".into(),
                version: update.version.clone(),
                downloaded,
                total: package_size.unwrap_or(setup_size),
                speed: 0.0,
            },
        );

        let request = serde_json::json!({
            "version": update.version,
            "installer": setup_path.to_string_lossy(),
            "sha256": digest,
            "signature": update.signature,
            "pid": std::process::id(),
        });
        fs::write(
            request_file(),
            serde_json::to_vec_pretty(&request).map_err(|e| format!("序列化更新请求失败: {e}"))?,
        )
        .map_err(|e| format!("写入更新请求失败: {e}"))?;

        let output = run_hidden("schtasks", &["/run", "/tn", TASK_NAME])?;
        if !output.status.success() {
            return Err(format!(
                "启动更新助手失败: {}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ));
        }

        // 正常退出被托盘/浮窗卡住时，5 秒后强制结束，避免安装遮罩永远停在屏幕上。
        let exit_handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1500));
            exit_handle.exit(0);
            std::thread::sleep(Duration::from_millis(3500));
            std::process::exit(0);
        });
        Ok(())
    }

    pub fn take_status() -> Option<serde_json::Value> {
        let raw = fs::read_to_string(status_file()).ok()?;
        let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
        let status = value
            .get("status")
            .and_then(|item| item.as_str())
            .unwrap_or_default();
        if status == "installing" {
            let timestamp = value.get("timestamp").and_then(|item| item.as_i64()).unwrap_or(0);
            let now = chrono::Local::now().timestamp();
            if now.saturating_sub(timestamp) > 15 * 60 {
                let _ = fs::remove_file(status_file());
                return Some(serde_json::json!({
                    "status": "failed",
                    "version": value.get("version").cloned().unwrap_or(serde_json::Value::Null),
                    "error": "上次更新可能未完成（安装超时或中断），请重试或手动安装。",
                    "timestamp": now,
                }));
            }
            return None;
        }
        if status == "success" || status == "failed" {
            let _ = fs::remove_file(status_file());
            Some(value)
        } else {
            None
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    pub async fn check(app: AppHandle) -> Result<UpdateInfo, String> {
        Ok(UpdateInfo {
            supported: false,
            available: false,
            current_version: app.package_info().version.to_string(),
            version: None,
            date: None,
            body: None,
            download_url: None,
            size: None,
        })
    }

    pub async fn download_and_apply(_app: AppHandle) -> Result<(), String> {
        Err("当前平台暂不支持应用内更新".into())
    }

    pub fn cancel(_app: &AppHandle) -> Result<(), String> {
        Ok(())
    }

    pub fn open_logs() -> Result<(), String> {
        Err("当前平台暂不支持应用内更新".into())
    }

    pub fn take_status() -> Option<serde_json::Value> {
        None
    }
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateInfo, String> {
    imp::check(app).await
}

#[tauri::command]
pub async fn update_download_and_apply(app: AppHandle) -> Result<(), String> {
    imp::download_and_apply(app).await
}

#[tauri::command]
pub fn update_cancel(app: AppHandle) -> Result<(), String> {
    imp::cancel(&app)
}

#[tauri::command]
pub fn update_open_logs() -> Result<(), String> {
    imp::open_logs()
}

#[tauri::command]
pub fn update_take_status() -> Option<serde_json::Value> {
    imp::take_status()
}
