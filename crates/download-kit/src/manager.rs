//! 任务管理器：队列调度、状态机、暂停/恢复/取消、进度事件。
//!
//! 并发模型：
//! - 一个常驻调度循环（`scheduler`）按 `max_concurrent_tasks` 认领 `queued` 任务；
//! - 每个任务一个 tokio 任务，内部再按分片并发（native 引擎）；
//! - 暂停/取消通过 `watch` 通道下发，分片在块边界检查，不依赖 kill 线程。

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{watch, Notify};

use crate::engine::{self as engines, DownloadEngine, EngineCtx, EngineOutcome};
use crate::engine::limiter::SpeedLimiter;
use crate::probe;
use crate::store::Store;
use crate::types::{
    DownloadPart, DownloadSpec, DownloadTask, EngineConfig, EngineInfo, EngineKind, EngineStatus,
    HlsVariant, PartState, ProbeRequest, ProbeResult, ProgressPayload, TaskDetail, TaskStatus,
};
use crate::util::{
    dir_size, filename_from_url, is_dash_url, is_ftp_url, is_hls_url, is_metalink_url,
    is_p2p_url, now_ms, sanitize_filename, should_sniff_content_type,
};
use crate::{EVENT_PROGRESS, EVENT_STATE};

/// 任务控制信号。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Control {
    Run,
    Pause,
    Cancel,
}

/// 活动态：只有这些状态允许被引擎继续推进。
const ACTIVE: &[TaskStatus] = &[
    TaskStatus::Probing,
    TaskStatus::Downloading,
    TaskStatus::Merging,
];

/// 分片进度聚合器（native 引擎用）。
pub(crate) struct TaskProgress {
    pub total: AtomicU64,
    pub downloaded: AtomicU64,
    pub connections: AtomicU32,
    pub parts_total: AtomicU32,
    pub parts_done: AtomicU32,
    last_report: Mutex<Option<Instant>>,
    last_bytes: AtomicU64,
    last_time: Mutex<Option<Instant>>,
}

impl TaskProgress {
    pub fn new(total: u64, connections: u32, parts_total: u32) -> Self {
        Self {
            total: AtomicU64::new(total),
            downloaded: AtomicU64::new(0),
            connections: AtomicU32::new(connections),
            parts_total: AtomicU32::new(parts_total),
            parts_done: AtomicU32::new(0),
            last_report: Mutex::new(None),
            last_bytes: AtomicU64::new(0),
            last_time: Mutex::new(None),
        }
    }

    /// 续传时把已下载的分片计入聚合值。
    pub fn seed(&self, part: &DownloadPart) {
        let value = if part.state == PartState::Completed {
            part.expected().max(part.downloaded)
        } else {
            part.downloaded
        };
        self.downloaded.fetch_add(value, Ordering::Relaxed);
        if part.state == PartState::Completed {
            self.parts_done.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// 跨任务共享的运行时状态。
pub(crate) struct Inner {
    pub(crate) base: PathBuf,
    pub(crate) app: Option<AppHandle>,
    pub(crate) store: Store,
    config: RwLock<EngineConfig>,
    engine_map: RwLock<HashMap<EngineKind, Arc<dyn DownloadEngine>>>,
    /// 全局聚合限速：内置引擎1/2 的所有任务共享。
    global_limiter: RwLock<Option<Arc<SpeedLimiter>>>,
    controls: Mutex<HashMap<String, watch::Sender<Control>>>,
    /// 自动重试计数：成功、取消或手动重试时清零。
    retry_attempts: Mutex<HashMap<String, u32>>,
    active: AtomicU32,
    wake: Notify,
    scheduler_guard: tokio::sync::Mutex<()>,
}

impl Inner {
    pub(crate) fn config(&self) -> EngineConfig {
        self.config
            .read()
            .map(|guard| guard.clone())
            .unwrap_or_else(|poisoned| poisoned.into_inner().clone())
    }

    pub(crate) fn engine(&self, kind: EngineKind) -> Option<Arc<dyn DownloadEngine>> {
        self.engine_map
            .read()
            .map(|guard| guard.get(&kind).cloned())
            .unwrap_or_else(|poisoned| poisoned.into_inner().get(&kind).cloned())
    }

    pub(crate) fn global_limiter(&self) -> Option<Arc<SpeedLimiter>> {
        self.global_limiter
            .read()
            .map(|guard| guard.clone())
            .unwrap_or_else(|poisoned| poisoned.into_inner().clone())
    }

    fn emit<S: serde::Serialize + Clone>(&self, event: &str, payload: S) {
        if let Some(app) = &self.app {
            let _ = app.emit(event, payload);
        }
    }

    pub(crate) fn emit_state(&self, task: &DownloadTask) {
        self.emit(EVENT_STATE, task.clone());
    }

    fn emit_state_by_id(&self, id: &str) {
        if let Ok(Some(task)) = self.store.task(id) {
            self.emit_state(&task);
        }
    }

    pub(crate) fn set_live_progress(&self, id: &str, downloaded: u64, total: u64) {
        self.set_live_progress_speed(id, downloaded, total, 0.0);
    }

    pub(crate) fn set_live_progress_speed(
        &self,
        id: &str,
        downloaded: u64,
        total: u64,
        speed: f64,
    ) {
        let _ = self.store.update_progress(id, downloaded, total);
        let (status, connections) = self
            .store
            .task(id)
            .ok()
            .flatten()
            .map(|task| (task.status, task.connections))
            .unwrap_or((TaskStatus::Downloading, 0));
        // 已暂停/取消的任务不再发进度，避免前端把旧进度条又点亮。
        if !status.is_active() {
            return;
        }
        self.emit(
            EVENT_PROGRESS,
            ProgressPayload {
                task_id: id.to_string(),
                status,
                downloaded,
                total,
                speed,
                connections,
                parts_total: 0,
                parts_done: 0,
                error: None,
            },
        );
    }

    /// 分片进度节流上报（约 350ms 一次）。返回 true 表示本次需要顺带落分片行。
    pub(crate) fn tick(&self, id: &str, progress: &TaskProgress) -> bool {
        let now = Instant::now();
        {
            let mut last = progress
                .last_report
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(previous) = *last {
                if now.duration_since(previous) < Duration::from_millis(350) {
                    return false;
                }
            }
            *last = Some(now);
        }

        let downloaded = progress.downloaded.load(Ordering::Relaxed);
        let total = progress.total.load(Ordering::Relaxed);
        let previous_bytes = progress.last_bytes.swap(downloaded, Ordering::Relaxed);
        let speed = {
            let mut last_time = progress
                .last_time
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let elapsed = last_time
                .map(|time| now.duration_since(time).as_secs_f64())
                .unwrap_or(0.0)
                .max(0.001);
            *last_time = Some(now);
            downloaded.saturating_sub(previous_bytes) as f64 / elapsed
        };

        let _ = self.store.update_progress(id, downloaded, total);
        self.emit(
            EVENT_PROGRESS,
            ProgressPayload {
                task_id: id.to_string(),
                status: TaskStatus::Downloading,
                downloaded,
                total,
                speed,
                connections: progress.connections.load(Ordering::Relaxed),
                parts_total: progress.parts_total.load(Ordering::Relaxed),
                parts_done: progress.parts_done.load(Ordering::Relaxed),
                error: None,
            },
        );
        true
    }

    pub(crate) fn advance(&self, id: &str, status: TaskStatus) -> Result<bool, String> {
        let changed = self.store.update_status_guarded(id, status, None, ACTIVE)?;
        if changed {
            self.emit_state_by_id(id);
        }
        Ok(changed)
    }

    fn fail(&self, id: &str, message: &str) {
        if let Ok(changed) =
            self.store
                .update_status_guarded(id, TaskStatus::Failed, Some(message), ACTIVE)
        {
            if changed {
                self.emit_state_by_id(id);
            }
        }
    }

    fn send_control(&self, id: &str, control: Control) {
        if let Ok(controls) = self.controls.lock() {
            if let Some(sender) = controls.get(id) {
                let _ = sender.send(control);
            }
        }
    }

    async fn complete(&self, id: &str) -> Result<(), String> {
        let Some(task) = self.store.task(id)? else {
            return Ok(());
        };
        let metadata = std::fs::metadata(&task.save_path)
            .map_err(|e| format!("下载文件不存在或不可读: {e}"))?;
        // P2P 任务落盘为目录（种子可能多文件），按目录递归统计。
        let size = if metadata.is_dir() {
            dir_size(std::path::Path::new(&task.save_path))
        } else {
            metadata.len()
        };
        // 只有「单地址 + 内置/CLI 直写引擎」的总长等于最终文件字节数。
        // 多段拼接与 ffmpeg 转封装会重写容器，输出大小允许与探测值不同。
        let strict_size = task.urls.len() == 1
            && !metadata.is_dir()
            && matches!(
                task.resolved_engine,
                Some(EngineKind::Native)
                    | Some(EngineKind::Simple)
                    | Some(EngineKind::Aria2)
                    | Some(EngineKind::Curl)
                    | Some(EngineKind::Wget)
            );
        if strict_size && task.total_bytes > 0 && size != task.total_bytes {
            return Err(format!(
                "文件大小校验失败：期望 {} 字节，实际 {} 字节",
                task.total_bytes, size
            ));
        }
        if let Some(expected) = task.sha256.as_deref() {
            if metadata.is_dir() {
                return Err("目录任务不支持单一 SHA-256 校验".to_string());
            }
            let path = task.save_path.clone();
            let actual = tokio::task::spawn_blocking(move || {
                crate::util::sha256_file(std::path::Path::new(&path))
            })
            .await
            .map_err(|e| format!("SHA-256 校验任务异常: {e}"))??;
            if actual != expected {
                return Err(format!(
                    "SHA-256 校验失败：期望 {expected}，实际 {actual}"
                ));
            }
        }
        let downloaded = if strict_size && task.total_bytes > 0 {
            task.total_bytes
        } else {
            size
        };
        let total = if strict_size {
            task.total_bytes.max(downloaded)
        } else {
            size.max(downloaded)
        };
        if self.store.complete(id, downloaded, total)? {
            self.emit_state_by_id(id);
        }
        if let Ok(mut guard) = self.retry_attempts.lock() {
            guard.remove(id);
        }
        Ok(())
    }

    fn engine_available(&self, kind: EngineKind) -> bool {
        self.engine(kind)
            .map(|engine| engine.available().is_ok())
            .unwrap_or(false)
    }

    /// auto 规则的唯一出处：
    /// P2P → gopeed；FTP → 可用的外部 CLI；HLS/DASH → ffmpeg；Metalink → aria2；多段 → native。
    fn resolve_engine(
        &self,
        task: &DownloadTask,
        sniff: Option<&ProbeResult>,
    ) -> (EngineKind, bool) {
        if task.engine != EngineKind::Auto {
            return (task.engine, true);
        }
        if task.urls.len() == 1 {
            let url = &task.urls[0];
            if is_p2p_url(url) {
                // P2P 没有 HTTP 探针/分片语义，必须交给支持 BT/磁力/ed2k 的引擎。
                return (EngineKind::Gopeed, true);
            }
            if is_ftp_url(url) {
                for kind in [EngineKind::Aria2, EngineKind::Curl, EngineKind::Wget] {
                    if self.engine_available(kind) {
                        return (kind, true);
                    }
                }
                return (EngineKind::Aria2, true);
            }
            if is_hls_url(url) || is_dash_url(url) || sniffed_stream(sniff) {
                // HLS / DASH 是流清单，必须由 ffmpeg 拉流；不能退回普通 HTTP 下载。
                return (EngineKind::Ffmpeg, true);
            }
            if is_metalink_url(url) || sniffed_metalink(sniff) {
                // Metalink 内含多源与校验值，aria2 原生支持。
                return (EngineKind::Aria2, true);
            }
        }
        if task.urls.len() > 1 {
            return (EngineKind::Native, false);
        }
        let default = self.config().default_engine;
        if default == EngineKind::Gopeed {
            // Gopeed 只适合 P2P；HTTP 任务即使被设为默认也不能落到它。
            return (EngineKind::Native, false);
        }
        if default != EngineKind::Auto {
            return (default, false);
        }
        (EngineKind::Native, false)
    }
}

fn sniffed_stream(sniff: Option<&ProbeResult>) -> bool {
    sniff
        .and_then(|probe| probe.content_type.as_deref())
        .map(|content_type| {
            let value = content_type.to_ascii_lowercase();
            value.contains("mpegurl") || value.contains("dash+xml")
        })
        .unwrap_or(false)
}

fn sniffed_metalink(sniff: Option<&ProbeResult>) -> bool {
    sniff
        .and_then(|probe| probe.content_type.as_deref())
        .map(|content_type| content_type.to_ascii_lowercase().contains("metalink"))
        .unwrap_or(false)
}

/// 统一 SHA-256 口径：允许 `sha256:` 前缀，落库统一小写 hex。
fn normalize_sha256(value: Option<String>) -> Result<Option<String>, String> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let lower = raw.trim().to_ascii_lowercase();
    let hex = lower.trim_start_matches("sha256:").trim();
    if hex.is_empty() {
        return Ok(None);
    }
    if hex.len() != 64 || !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("SHA-256 必须是 64 位十六进制字符串".to_string());
    }
    Ok(Some(hex.to_string()))
}

/// 对外管理器。内部 `Arc` 可安全克隆给命令层/定时任务。
#[derive(Clone)]
pub struct DownloadManager {
    inner: Arc<Inner>,
}

impl DownloadManager {
    pub fn init(app: AppHandle) -> Result<Self, String> {
        let base = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("获取应用数据目录失败: {e}"))?
            .join("download-kit");
        std::fs::create_dir_all(&base)
            .map_err(|e| format!("创建下载数据目录失败 {}: {e}", base.display()))?;

        let store = Store::open(&base)?;
        let config = crate::config::load(&base);
        let registry = engines::build_registry(&app, &config);

        let inner = Arc::new(Inner {
            base: base.clone(),
            app: Some(app),
            store,
            config: RwLock::new(config.clone()),
            engine_map: RwLock::new(registry),
            global_limiter: RwLock::new(
                SpeedLimiter::new(config.total_speed_limit).map(Arc::new),
            ),
            controls: Mutex::new(HashMap::new()),
            retry_attempts: Mutex::new(HashMap::new()),
            active: AtomicU32::new(0),
            wake: Notify::new(),
            scheduler_guard: tokio::sync::Mutex::new(()),
        });

        let recovered = inner.store.recover_stale(config.resume_on_start)?;
        if recovered > 0 {
            eprintln!("[download-kit] 已恢复 {recovered} 个上次未完成的任务");
        }

        let scheduler_inner = inner.clone();
        tauri::async_runtime::spawn(async move {
            scheduler(scheduler_inner).await;
        });
        inner.wake.notify_one();

        Ok(Self { inner })
    }

    pub fn enqueue(&self, spec: DownloadSpec) -> Result<String, String> {
        let urls: Vec<String> = spec
            .urls
            .into_iter()
            .map(|url| url.trim().to_string())
            .filter(|url| !url.is_empty())
            .collect();
        if urls.is_empty() {
            return Err("缺少下载地址".to_string());
        }

        let id = uuid::Uuid::new_v4().to_string();
        let p2p = spec.engine == EngineKind::Gopeed || is_p2p_url(&urls[0]);
        let metalink = is_metalink_url(&urls[0]);
        let sha256 = normalize_sha256(spec.sha256)?;
        if sha256.is_some() && (p2p || metalink) {
            return Err("P2P / Metalink 任务包含多个文件，不支持单一 SHA-256 校验".to_string());
        }

        let mut mirrors: Vec<String> = spec
            .mirrors
            .into_iter()
            .map(|url| url.trim().to_string())
            .filter(|url| !url.is_empty())
            .collect();
        let mut seen = std::collections::HashSet::new();
        mirrors.retain(|url| url != &urls[0] && seen.insert(url.clone()));
        if !mirrors.is_empty() && (p2p || urls.len() > 1) {
            return Err("P2P / 多段任务不支持 mirrors".to_string());
        }

        let raw_save = spec.save_path.trim();
        if raw_save.is_empty() {
            return Err("缺少保存路径".to_string());
        }
        let p2p = spec.engine == EngineKind::Gopeed || is_p2p_url(&urls[0]);
        let directory_output = p2p || metalink;
        let mut save_path = PathBuf::from(raw_save);
        let mut filename;
        if directory_output {
            // P2P / Metalink 的落盘单位是目录（可能包含多个文件）。
            // 目标目录已存在且非空时追加任务专属子目录，避免取消任务时误删用户已有内容。
            let non_empty = save_path.is_dir()
                && std::fs::read_dir(&save_path)
                    .map(|mut entries| entries.next().is_some())
                    .unwrap_or(false);
            let dir = if non_empty {
                save_path.join(format!("task-{}", &id[..8]))
            } else {
                save_path
            };
            std::fs::create_dir_all(&dir)
                .map_err(|e| format!("创建任务下载目录失败 {}: {e}", dir.display()))?;
            filename = dir
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "download".to_string());
            save_path = dir;
        } else {
            let directory_target = raw_save.ends_with('/')
                || raw_save.ends_with('\\')
                || save_path.is_dir();
            if directory_target {
                // 探测到的文件名优先：`/download?id=123` 这类地址从 URL 拿不到可用名字，
                // 而 Content-Disposition / 重定向后的地址通常带正确扩展名。
                let name = spec
                    .filename
                    .as_deref()
                    .map(sanitize_filename)
                    .or_else(|| filename_from_url(&urls[0]))
                    .unwrap_or_else(|| "download.bin".to_string());
                // 不覆盖目录里已有的同名文件：自动追加 ` (1)`、` (2)`。
                save_path = unique_download_path(&save_path.join(name));
            }
            if let Some(parent) = save_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("创建下载目录失败 {}: {e}", parent.display()))?;
            }
            filename = save_path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "download.bin".to_string());
        }

        // HLS / DASH 的清单本身不是最终媒体文件；ffmpeg 会按输出扩展名选封装器，
        // 若保留 .m3u8/.mpd 会写成播放列表或直接失败，这里统一改成 .mp4。
        if urls.len() == 1 && (is_hls_url(&urls[0]) || is_dash_url(&urls[0])) {
            if let Some(renamed) = stream_output_name(&filename) {
                filename = renamed;
                save_path.set_file_name(&filename);
            }
        }

        let config = self.inner.config();
        let connections = spec.connections.unwrap_or(config.connections).clamp(1, 32);
        let speed = spec.max_speed.unwrap_or(config.speed_limit);
        let max_speed = (speed > 0).then_some(speed);
        let now = now_ms();
        let task = DownloadTask {
            id,
            urls,
            save_path: save_path.to_string_lossy().into_owned(),
            filename,
            referer: spec.referer,
            cookie: spec.cookie,
            user_agent: spec.user_agent,
            headers: BTreeMap::from_iter(spec.headers),
            engine: spec.engine,
            resolved_engine: None,
            status: TaskStatus::Queued,
            total_bytes: 0,
            downloaded_bytes: 0,
            max_bytes: spec.max_bytes,
            mirrors,
            sha256,
            max_speed,
            priority: spec.priority,
            etag: None,
            last_modified: None,
            connections,
            error: None,
            created_at: now,
            updated_at: now,
            completed_at: None,
        };

        self.inner.store.insert_task(&task)?;
        self.inner.emit_state(&task);
        self.inner.wake.notify_one();
        Ok(task.id)
    }

    pub fn list(
        &self,
        status: Option<TaskStatus>,
        limit: usize,
    ) -> Result<Vec<DownloadTask>, String> {
        self.inner.store.tasks(status, limit)
    }

    pub fn get(&self, id: &str) -> Result<TaskDetail, String> {
        let task = self
            .inner
            .store
            .task(id)?
            .ok_or_else(|| format!("下载任务不存在: {id}"))?;
        let parts = self.inner.store.parts(id)?;
        Ok(TaskDetail { task, parts })
    }

    pub fn pause(&self, id: &str) -> Result<(), String> {
        let task = self
            .inner
            .store
            .task(id)?
            .ok_or_else(|| format!("下载任务不存在: {id}"))?;
        if task.status == TaskStatus::Paused {
            return Ok(());
        }
        if !matches!(
            task.status,
            TaskStatus::Queued
                | TaskStatus::Probing
                | TaskStatus::Downloading
                | TaskStatus::Merging
        ) {
            return Err(format!("当前状态（{}）不可暂停", task.status.as_str()));
        }
        self.inner.send_control(id, Control::Pause);
        self.inner.store.update_status_guarded(
            id,
            TaskStatus::Paused,
            None,
            &[
                TaskStatus::Queued,
                TaskStatus::Probing,
                TaskStatus::Downloading,
                TaskStatus::Merging,
            ],
        )?;
        self.inner.emit_state_by_id(id);
        Ok(())
    }

    /// `delete_file`：取消时是否连同半成品/临时分片一起删掉（默认由命令层传 true）。
    pub fn cancel(&self, id: &str, delete_file: bool) -> Result<(), String> {
        let task = self
            .inner
            .store
            .task(id)?
            .ok_or_else(|| format!("下载任务不存在: {id}"))?;
        if task.status == TaskStatus::Completed {
            return Err("任务已完成，无需取消".to_string());
        }
        if task.status == TaskStatus::Canceled {
            return Ok(());
        }

        self.inner.send_control(id, Control::Cancel);
        let changed = self.inner.store.update_status_guarded(
            id,
            TaskStatus::Canceled,
            None,
            &[
                TaskStatus::Queued,
                TaskStatus::Probing,
                TaskStatus::Downloading,
                TaskStatus::Paused,
                TaskStatus::Merging,
                TaskStatus::Failed,
            ],
        )?;
        if !changed {
            return Ok(());
        }
        self.inner.store.delete_parts(id)?;
        if let Ok(mut guard) = self.inner.retry_attempts.lock() {
            guard.remove(id);
        }
        // 只有真正开始写过盘的才删；刚入队就取消时不能误删用户已有的同名文件。
        let touched = task.status != TaskStatus::Queued || task.downloaded_bytes > 0;
        if delete_file && touched {
            let target = std::path::Path::new(&task.save_path);
            let _ = std::fs::remove_dir_all(temp_dir_for(&task.save_path));
            let _ = std::fs::remove_file(format!("{}.aria2", task.save_path));
            if target.is_dir() {
                let _ = std::fs::remove_dir_all(target);
            } else {
                let _ = std::fs::remove_file(target);
            }
        }
        self.inner.emit_state_by_id(id);
        Ok(())
    }

    pub fn resume(&self, id: &str) -> Result<(), String> {
        let task = self
            .inner
            .store
            .task(id)?
            .ok_or_else(|| format!("下载任务不存在: {id}"))?;
        if matches!(
            task.status,
            TaskStatus::Queued
                | TaskStatus::Probing
                | TaskStatus::Downloading
                | TaskStatus::Merging
        ) {
            return Ok(());
        }
        if task.status == TaskStatus::Completed {
            return Err("任务已完成".to_string());
        }
        // ffmpeg 不能精确续传，重新从 0 开始计数（-y 覆盖旧输出）。
        if task.resolved_engine == Some(EngineKind::Ffmpeg) {
            self.inner.store.reset_progress(id)?;
        }
        if let Ok(mut controls) = self.inner.controls.lock() {
            controls.remove(id);
        }
        if let Ok(mut guard) = self.inner.retry_attempts.lock() {
            guard.remove(id);
        }
        let changed = self.inner.store.update_status_guarded(
            id,
            TaskStatus::Queued,
            None,
            &[
                TaskStatus::Paused,
                TaskStatus::Failed,
                TaskStatus::Canceled,
            ],
        )?;
        if changed {
            self.inner.emit_state_by_id(id);
            self.inner.wake.notify_one();
        }
        Ok(())
    }

    pub fn config(&self) -> EngineConfig {
        self.inner.config()
    }

    /// 文件被移动/重命名后，把新的落盘路径同步回任务记录。
    ///
    /// 只在文件**已经**移到位之后调用：先动磁盘再改库，中间失败最多是记录指向旧路径，
    /// 反过来则会出现「记录说在新地方、文件还在老地方」，续传会写坏另一个文件。
    pub fn relocate(&self, id: &str, save_path: &str, filename: &str) -> Result<(), String> {
        self.inner.store.update_save_path(id, save_path, filename)?;
        self.inner.emit_state_by_id(id);
        Ok(())
    }

    /// 忘掉一条已完成任务：只删库里的记录，**磁盘文件原封不动**。
    ///
    /// 这是「移除记录」在下载侧的对应动作。和 `cancel(.., delete_file=true)`
    /// 是两件完全不同的事，别混用：那个会删文件，这个不会。
    pub fn forget(&self, id: &str) -> Result<(), String> {
        if !self.inner.store.delete_task(id)? {
            return Err(format!("下载任务不存在: {id}"));
        }
        eprintln!("[download-kit] 已移除任务记录（未动文件）: {id}");
        Ok(())
    }

    pub fn set_config(&self, config: EngineConfig) -> Result<EngineConfig, String> {
        let config = config.normalize();
        crate::config::save(&self.inner.base, &config)?;
        if let Ok(mut guard) = self.inner.config.write() {
            *guard = config.clone();
        }
        if let Ok(mut guard) = self.inner.global_limiter.write() {
            *guard = SpeedLimiter::new(config.total_speed_limit).map(Arc::new);
        }
        if let Some(app) = &self.inner.app {
            let registry = engines::build_registry(app, &config);
            if let Ok(mut guard) = self.inner.engine_map.write() {
                *guard = registry;
            }
        }
        self.inner.wake.notify_one();
        Ok(config)
    }

    pub fn engines(&self) -> EngineStatus {
        let config = self.inner.config();
        let list = engines::DESCRIPTORS
            .iter()
            .map(|descriptor| {
                let (available, path) = match self.inner.engine(descriptor.kind) {
                    Some(engine) => (engine.available().is_ok(), engine.tool_path()),
                    None => (false, None),
                };
                EngineInfo {
                    kind: descriptor.kind,
                    name: descriptor.name.to_string(),
                    description: descriptor.description.to_string(),
                    builtin: descriptor.builtin,
                    platform: descriptor.platform.to_string(),
                    available,
                    path,
                    default: config.default_engine == descriptor.kind,
                }
            })
            .collect();
        EngineStatus {
            default_engine: config.default_engine,
            engines: list,
        }
    }

    pub async fn probe(&self, request: ProbeRequest) -> Result<ProbeResult, String> {
        let config = self.inner.config();
        let client = probe::build_client(&config)?;
        let meta = probe::HttpMeta::from_request(&request);
        probe::probe(&client, &request.url, &meta).await
    }

    /// 解析 HLS 主播放列表的清晰度变体；媒体播放列表返回空列表。
    pub async fn hls_variants(&self, request: ProbeRequest) -> Result<Vec<HlsVariant>, String> {
        let config = self.inner.config();
        let client = probe::build_client(&config)?;
        let meta = probe::HttpMeta::from_request(&request);
        probe::hls_variants(&client, &request.url, &meta, &config.user_agent).await
    }
}

fn temp_dir_for(save_path: &str) -> PathBuf {
    let mut name = std::ffi::OsString::from(save_path);
    name.push(".parts");
    PathBuf::from(name)
}

/// ffmpeg 能按扩展名识别的常见容器；命中则保留用户/地址给的名字。
const MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mkv", "webm", "mov", "ts", "m2ts", "flv", "avi", "mpg", "mpeg", "mp3", "m4a",
    "aac", "flac", "wav", "ogg", "opus", "wma",
];

/// ffmpeg 输出文件名：清单（.m3u8/.mpd）、`.bin`、无扩展名或未知扩展名统一改 `.mp4`。
/// 返回 `None` 表示原名已经可用，不需要改动。
fn stream_output_name(filename: &str) -> Option<String> {
    let path = Path::new(filename);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());
    if extension
        .as_deref()
        .map(|ext| MEDIA_EXTENSIONS.contains(&ext))
        .unwrap_or(false)
    {
        return None;
    }
    let stem = path
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "download".to_string());
    Some(format!("{stem}.mp4"))
}

/// 目录下载时的同名避让：`file.zip` → `file (1).zip` → `file (2).zip`。
fn unique_download_path(target: &Path) -> PathBuf {
    if !target.exists() {
        return target.to_path_buf();
    }
    let stem = target
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".to_string());
    let extension = target
        .extension()
        .map(|value| value.to_string_lossy().into_owned());
    for index in 1..1000 {
        let name = match extension.as_deref() {
            Some(ext) => format!("{stem} ({index}).{ext}"),
            None => format!("{stem} ({index})"),
        };
        let candidate = target.with_file_name(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    target.to_path_buf()
}

/// 只对看起来可恢复的失败做自动重试；确定性错误（404 / 校验失败 / 配置缺失）直接终止。
fn is_retryable_failure(message: &str) -> bool {
    const FATAL_MARKERS: &[&str] = &[
        "404",
        "401",
        "403",
        "410",
        "校验失败",
        "不支持",
        "未找到",
        "缺少",
        "文件过大",
        "磁盘空间",
        "没有可用的下载引擎",
        "SHA-256",
    ];
    !FATAL_MARKERS.iter().any(|marker| message.contains(marker))
}

/// 失败后按配置延迟重新排队；返回 true 表示已安排自动重试。
///
/// 等待期间保持 `failed` 状态（不占并发槽，也不会被调度器提前认领）；
/// 延迟结束后只在「仍处于 failed」时改回 queued，用户取消/手动重试都不会被覆盖。
fn schedule_retry(inner: &Arc<Inner>, id: &str, message: &str) -> bool {
    let config = inner.config();
    if config.task_retries == 0 || !is_retryable_failure(message) {
        return false;
    }
    let attempt = {
        let Ok(mut guard) = inner.retry_attempts.lock() else {
            return false;
        };
        let entry = guard.entry(id.to_string()).or_insert(0);
        if *entry >= config.task_retries {
            return false;
        }
        *entry += 1;
        *entry
    };
    let delay = config
        .retry_base_ms
        .saturating_mul(1u64 << (attempt - 1).min(5))
        .clamp(1_000, config.retry_max_ms.max(1_000));
    let notice = format!(
        "第 {attempt}/{} 次自动重试将在 {} 秒后开始：{message}",
        config.task_retries,
        (delay + 999) / 1000
    );
    let changed = inner
        .store
        .update_status_guarded(id, TaskStatus::Failed, Some(&notice), ACTIVE)
        .unwrap_or(false);
    if !changed {
        return false;
    }
    inner.emit_state_by_id(id);
    let inner = inner.clone();
    let task_id = id.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(delay)).await;
        if let Ok(true) = inner.store.update_status_guarded(
            &task_id,
            TaskStatus::Queued,
            None,
            &[TaskStatus::Failed],
        ) {
            inner.emit_state_by_id(&task_id);
            inner.wake.notify_one();
        }
    });
    true
}

async fn scheduler(inner: Arc<Inner>) {
    loop {
        inner.wake.notified().await;
        // 认领动作串行化：避免多个唤醒同时把并发数冲过上限。
        let _guard = inner.scheduler_guard.lock().await;
        loop {
            let max = inner.config().max_concurrent_tasks.max(1);
            if inner.active.load(Ordering::SeqCst) >= max {
                break;
            }
            let next = match inner.store.next_queued() {
                Ok(Some(task)) => task,
                Ok(None) => break,
                Err(error) => {
                    eprintln!("[download-kit] 读取排队任务失败: {error}");
                    break;
                }
            };
            match inner.store.claim_queued(&next.id) {
                Ok(true) => {}
                Ok(false) => continue,
                Err(error) => {
                    eprintln!("[download-kit] 认领任务失败: {error}");
                    break;
                }
            }

            let (sender, receiver) = watch::channel(Control::Run);
            if let Ok(mut controls) = inner.controls.lock() {
                controls.insert(next.id.clone(), sender);
            }
            inner.active.fetch_add(1, Ordering::SeqCst);

            let task_inner = inner.clone();
            let task_id = next.id.clone();
            tauri::async_runtime::spawn(async move {
                run_task(task_inner, task_id, receiver).await;
            });
        }
    }
}

async fn run_task(inner: Arc<Inner>, id: String, control: watch::Receiver<Control>) {
    let result = run_engine(&inner, &id, control).await;
    inner.active.fetch_sub(1, Ordering::SeqCst);
    if let Ok(mut controls) = inner.controls.lock() {
        controls.remove(&id);
    }
    inner.wake.notify_one();
    if let Err(error) = result {
        eprintln!("[download-kit] 任务 {id} 结束于错误: {error}");
    }
}

async fn run_engine(
    inner: &Arc<Inner>,
    id: &str,
    control: watch::Receiver<Control>,
) -> Result<(), String> {
    let Some(mut task) = inner.store.task(id)? else {
        return Ok(());
    };
    if task.status != TaskStatus::Downloading {
        return Ok(());
    }
    // 认领后先进入 probing；若这期间被暂停（状态已变），直接退出。
    if !inner.advance(id, TaskStatus::Probing)? {
        return Ok(());
    }

    // auto 且地址形态不明确时，先嗅探一次 Content-Type，用真实响应而不是猜后缀路由。
    // 结果会放进 EngineCtx，引擎不再重复 HEAD。
    let mut sniffed = None;
    if task.engine == EngineKind::Auto
        && task.urls.len() == 1
        && should_sniff_content_type(&task.urls[0])
    {
        let config = inner.config();
        if let Ok(client) = probe::build_client(&config) {
            let meta = probe::HttpMeta::from_task(&task);
            sniffed = probe::probe(&client, &task.urls[0], &meta).await.ok();
        }
    }

    let (requested, explicit) = inner.resolve_engine(&task, sniffed.as_ref());
    let mut kind = requested;
    let mut engine = inner.engine(kind);
    let available = engine.as_ref().map(|engine| engine.available());
    if let Some(Err(message)) = available {
        if explicit {
            inner.fail(id, &message);
            return Ok(());
        }
        // auto 规则命中了外部引擎但本机没装：回退 native，不让任务无意义失败。
        kind = EngineKind::Native;
        engine = inner.engine(kind);
    }
    let Some(engine) = engine else {
        inner.fail(id, "没有可用的下载引擎");
        return Ok(());
    };

    // 靠 Content-Type 嗅探才认出是 HLS/DASH 的地址没有 .m3u8/.mpd 后缀，入队阶段改不到；
    // ffmpeg 按输出扩展名选封装器，这里在真正开跑前再兜一次（.bin / 无扩展名 → .mp4）。
    if kind == EngineKind::Ffmpeg {
        if let Some(renamed) = stream_output_name(&task.filename) {
            let mut path = PathBuf::from(&task.save_path);
            path.set_file_name(&renamed);
            let path_text = path.to_string_lossy().into_owned();
            match inner.store.update_save_path(id, &path_text, &renamed) {
                Ok(()) => {
                    task.save_path = path_text;
                    task.filename = renamed;
                    inner.emit_state_by_id(id);
                }
                Err(error) => eprintln!("[download-kit] 修正流媒体输出名失败: {error}"),
            }
        }
    }

    if let Ok(Some(current)) = inner.store.task(id) {
        let _ = inner
            .store
            .update_meta(id, kind, &current.filename, current.total_bytes);
    }

    let ctx = EngineCtx {
        inner: inner.clone(),
        task_id: id.to_string(),
        save_path: PathBuf::from(&task.save_path),
        probe: sniffed,
        control,
    };

    match engine.run(ctx).await {
        Ok(EngineOutcome::Done) => {
            if let Err(message) = inner.complete(id).await {
                inner.fail(id, &message);
                return Err(message);
            }
            Ok(())
        }
        Ok(EngineOutcome::Paused) => {
            let _ = inner
                .store
                .update_status_guarded(id, TaskStatus::Paused, None, ACTIVE);
            inner.emit_state_by_id(id);
            Ok(())
        }
        Ok(EngineOutcome::Canceled) => Ok(()),
        Err(message) => {
            if schedule_retry(inner, id, &message) {
                eprintln!("[download-kit] 任务 {id} 将按配置自动重试: {message}");
            } else {
                inner.fail(id, &message);
            }
            Err(message)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::DownloadEngine;
    use crate::types::DownloadPart;
    use std::collections::BTreeMap;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    fn sha256_hex(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(bytes))
    }

    fn test_inner(base: PathBuf, store: Store, config: EngineConfig) -> Arc<Inner> {
        let global_limiter = SpeedLimiter::new(config.total_speed_limit).map(Arc::new);
        Arc::new(Inner {
            base,
            app: None,
            store,
            config: RwLock::new(config),
            engine_map: RwLock::new(HashMap::new()),
            global_limiter: RwLock::new(global_limiter),
            controls: Mutex::new(HashMap::new()),
            retry_attempts: Mutex::new(HashMap::new()),
            active: AtomicU32::new(0),
            wake: Notify::new(),
            scheduler_guard: tokio::sync::Mutex::new(()),
        })
    }

    fn temp_base(name: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "download-kit-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    fn sample_task(url: &str, save_path: &PathBuf, connections: u32, total: u64) -> DownloadTask {
        let now = now_ms();
        DownloadTask {
            id: uuid::Uuid::new_v4().to_string(),
            urls: vec![url.to_string()],
            save_path: save_path.to_string_lossy().into_owned(),
            filename: save_path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "out.bin".to_string()),
            referer: None,
            cookie: None,
            user_agent: None,
            headers: BTreeMap::new(),
            engine: EngineKind::Auto,
            resolved_engine: None,
            status: TaskStatus::Downloading,
            total_bytes: total,
            downloaded_bytes: 0,
            max_bytes: None,
            mirrors: Vec::new(),
            sha256: None,
            max_speed: None,
            priority: 0,
            etag: None,
            last_modified: None,
            connections,
            error: None,
            created_at: now,
            updated_at: now,
            completed_at: None,
        }
    }

    async fn spawn_range_server(payload: Vec<u8>) -> String {
        spawn_server(payload, false).await
    }

    /// 谎报支持 Range 的服务器：HEAD 说 Accept-Ranges，GET 却总是 200 整文件。
    async fn spawn_lying_server(payload: Vec<u8>) -> String {
        spawn_server(payload, true).await
    }

    async fn spawn_server(payload: Vec<u8>, lying: bool) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let payload = Arc::new(payload);
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let payload = payload.clone();
                tokio::spawn(async move {
                    serve(stream, payload, lying).await;
                });
            }
        });
        format!("http://{address}/file.bin")
    }

    async fn serve(mut stream: TcpStream, payload: Arc<Vec<u8>>, lying: bool) {
        let mut request = Vec::new();
        let mut buffer = [0u8; 1024];
        loop {
            let read = match stream.read(&mut buffer).await {
                Ok(0) | Err(_) => return,
                Ok(read) => read,
            };
            request.extend_from_slice(&buffer[..read]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        let text = String::from_utf8_lossy(&request);
        let mut lines = text.split("\r\n");
        let request_line = lines.next().unwrap_or("");
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or("");
        let mut range: Option<(usize, usize)> = None;
        for line in lines {
            let lower = line.to_ascii_lowercase();
            if let Some(value) = lower.strip_prefix("range:") {
                if let Some(spec) = value.trim().strip_prefix("bytes=") {
                    let mut iter = spec.split('-');
                    let start = iter.next().and_then(|s| s.parse::<usize>().ok()).unwrap_or(0);
                    let end = iter
                        .next()
                        .filter(|s| !s.is_empty())
                        .and_then(|s| s.parse::<usize>().ok())
                        .unwrap_or(payload.len().saturating_sub(1));
                    range = Some((start, end.min(payload.len().saturating_sub(1))));
                }
            }
        }

        let total = payload.len();
        let response = match (method, range) {
            ("HEAD", _) => format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {total}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n"
            )
            .into_bytes(),
            ("GET", Some((start, end))) if !lying && start <= end && end < total => {
                let body = &payload[start..=end];
                let header = format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{end}/{total}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let mut response = header.into_bytes();
                response.extend_from_slice(body);
                response
            }
            _ => {
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {total}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n"
                );
                let mut response = header.into_bytes();
                response.extend_from_slice(&payload);
                response
            }
        };
        let _ = stream.write_all(&response).await;
        let _ = stream.shutdown().await;
    }

    /// 端到端：HEAD 探针 → 4 分片并发 Range → 顺序合并。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn native_downloads_chunked_and_merges() {
        let payload: Vec<u8> = (0..1_500_000usize).map(|i| (i % 251) as u8).collect();
        let url = spawn_range_server(payload.clone()).await;

        let base = temp_base("chunked");
        let store = Store::open(&base).unwrap();
        let config = EngineConfig {
            connections: 4,
            read_timeout_secs: 30,
            ..Default::default()
        };
        let inner = test_inner(base.clone(), store, config.clone());
        let save_path = base.join("out.bin");
        let task = sample_task(&url, &save_path, 4, 0);
        inner.store.insert_task(&task).unwrap();

        let (sender, receiver) = watch::channel(Control::Run);
        inner
            .controls
            .lock()
            .unwrap()
            .insert(task.id.clone(), sender);
        let ctx = EngineCtx {
            inner: inner.clone(),
            task_id: task.id.clone(),
            save_path: save_path.clone(),
            probe: None,
            control: receiver,
        };
        let engine = crate::engine::native::NativeEngine::new(config, None);
        let outcome = engine.run(ctx).await.unwrap();
        assert_eq!(outcome, EngineOutcome::Done);
        inner.complete(&task.id).await.unwrap();

        assert_eq!(std::fs::read(&save_path).unwrap(), payload);
        let stored = inner.store.task(&task.id).unwrap().unwrap();
        assert_eq!(stored.status, TaskStatus::Completed);
        assert_eq!(stored.total_bytes, payload.len() as u64);
        let parts = inner.store.parts(&task.id).unwrap();
        assert_eq!(parts.len(), 4);
        assert!(parts.iter().all(|part| part.state == PartState::Completed));

        let _ = std::fs::remove_dir_all(&base);
    }

    /// 续传：已落库的分片从 `downloaded` 偏移继续，不重复写字节。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn native_resumes_from_persisted_parts() {
        let payload: Vec<u8> = (0..1_500_000usize).map(|i| (i % 233) as u8).collect();
        let url = spawn_range_server(payload.clone()).await;
        let total = payload.len() as u64;

        let base = temp_base("resume");
        let store = Store::open(&base).unwrap();
        let config = EngineConfig {
            connections: 4,
            read_timeout_secs: 30,
            ..Default::default()
        };
        let inner = test_inner(base.clone(), store, config.clone());
        let save_path = base.join("resume.bin");
        let task = sample_task(&url, &save_path, 4, total);
        inner.store.insert_task(&task).unwrap();

        let mut temp_dir = std::ffi::OsString::from(&task.save_path);
        temp_dir.push(".parts");
        let temp_dir = PathBuf::from(temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let chunk = total / 4;
        let mut parts = Vec::new();
        for index in 0..4u32 {
            let start = chunk * index as u64;
            let end = if index == 3 {
                total
            } else {
                chunk * (index + 1) as u64
            };
            parts.push(DownloadPart {
                index,
                url: url.clone(),
                start,
                end,
                downloaded: 0,
                state: PartState::Pending,
                temp_path: temp_dir
                    .join(format!("part-{index:03}.bin"))
                    .to_string_lossy()
                    .into_owned(),
            });
        }
        // 模拟上次已下 100KB（记录与临时文件一致）。
        let resumed: u64 = 100_000;
        std::fs::write(&parts[0].temp_path, &payload[..resumed as usize]).unwrap();
        parts[0].downloaded = resumed;
        parts[0].state = PartState::Downloading;
        inner.store.replace_parts(&task.id, &parts).unwrap();

        let (sender, receiver) = watch::channel(Control::Run);
        inner
            .controls
            .lock()
            .unwrap()
            .insert(task.id.clone(), sender);
        let ctx = EngineCtx {
            inner: inner.clone(),
            task_id: task.id.clone(),
            save_path: save_path.clone(),
            probe: None,
            control: receiver,
        };
        let engine = crate::engine::native::NativeEngine::new(config, None);
        let outcome = engine.run(ctx).await.unwrap();
        assert_eq!(outcome, EngineOutcome::Done);
        inner.complete(&task.id).await.unwrap();

        assert_eq!(std::fs::read(&save_path).unwrap(), payload);
        let stored = inner.store.task(&task.id).unwrap().unwrap();
        assert_eq!(stored.status, TaskStatus::Completed);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// 服务器谎报 Range：多分片收到 200 时，必须自动降级为单流并成功。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn native_degrades_to_single_stream_on_lying_range() {
        let payload: Vec<u8> = (0..1_200_000usize).map(|i| (i % 211) as u8).collect();
        let url = spawn_lying_server(payload.clone()).await;

        let base = temp_base("lying");
        let store = Store::open(&base).unwrap();
        let config = EngineConfig {
            connections: 4,
            read_timeout_secs: 30,
            ..Default::default()
        };
        let inner = test_inner(base.clone(), store, config.clone());
        let save_path = base.join("lying.bin");
        let task = sample_task(&url, &save_path, 4, 0);
        inner.store.insert_task(&task).unwrap();

        let (sender, receiver) = watch::channel(Control::Run);
        inner
            .controls
            .lock()
            .unwrap()
            .insert(task.id.clone(), sender);
        let ctx = EngineCtx {
            inner: inner.clone(),
            task_id: task.id.clone(),
            save_path: save_path.clone(),
            probe: None,
            control: receiver,
        };
        let engine = crate::engine::native::NativeEngine::new(config, None);
        let outcome = engine.run(ctx).await.unwrap();
        assert_eq!(outcome, EngineOutcome::Done);
        inner.complete(&task.id).await.unwrap();

        assert_eq!(std::fs::read(&save_path).unwrap(), payload);
        // 降级后应只剩一个单流分片。
        let parts = inner.store.parts(&task.id).unwrap();
        assert_eq!(parts.len(), 1);
        let stored = inner.store.task(&task.id).unwrap().unwrap();
        assert_eq!(stored.status, TaskStatus::Completed);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// 引擎2：即使请求了多连接，也必须只产生一个分片（单连接兼容模式）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn simple_engine_uses_single_connection() {
        let payload: Vec<u8> = (0..900_000usize).map(|i| (i % 197) as u8).collect();
        let url = spawn_range_server(payload.clone()).await;

        let base = temp_base("simple");
        let store = Store::open(&base).unwrap();
        let config = EngineConfig {
            connections: 8,
            read_timeout_secs: 30,
            ..Default::default()
        };
        let inner = test_inner(base.clone(), store, config.clone());
        let save_path = base.join("simple.bin");
        let task = sample_task(&url, &save_path, 8, 0);
        inner.store.insert_task(&task).unwrap();

        let (sender, receiver) = watch::channel(Control::Run);
        inner
            .controls
            .lock()
            .unwrap()
            .insert(task.id.clone(), sender);
        let ctx = EngineCtx {
            inner: inner.clone(),
            task_id: task.id.clone(),
            save_path: save_path.clone(),
            probe: None,
            control: receiver,
        };
        let engine = crate::engine::simple::SimpleEngine::new(config, None);
        let outcome = engine.run(ctx).await.unwrap();
        assert_eq!(outcome, EngineOutcome::Done);
        inner.complete(&task.id).await.unwrap();

        assert_eq!(std::fs::read(&save_path).unwrap(), payload);
        let parts = inner.store.parts(&task.id).unwrap();
        assert_eq!(parts.len(), 1);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// 主地址不可用时，按 mirrors 顺序切到可用镜像。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn native_uses_mirror_when_primary_is_dead() {
        let payload: Vec<u8> = (0..600_000usize).map(|i| (i % 179) as u8).collect();
        let mirror = spawn_range_server(payload.clone()).await;

        let base = temp_base("mirror");
        let store = Store::open(&base).unwrap();
        let config = EngineConfig {
            connections: 2,
            connect_timeout_secs: 1,
            read_timeout_secs: 10,
            ..Default::default()
        };
        let inner = test_inner(base.clone(), store, config.clone());
        let save_path = base.join("mirror.bin");
        let mut task = sample_task("http://127.0.0.1:9/file.bin", &save_path, 2, 0);
        task.mirrors = vec![mirror];
        inner.store.insert_task(&task).unwrap();

        let (sender, receiver) = watch::channel(Control::Run);
        inner
            .controls
            .lock()
            .unwrap()
            .insert(task.id.clone(), sender);
        let ctx = EngineCtx {
            inner: inner.clone(),
            task_id: task.id.clone(),
            save_path: save_path.clone(),
            probe: None,
            control: receiver,
        };
        let engine = crate::engine::native::NativeEngine::new(config, None);
        let outcome = engine.run(ctx).await.unwrap();
        assert_eq!(outcome, EngineOutcome::Done);
        inner.complete(&task.id).await.unwrap();

        assert_eq!(std::fs::read(&save_path).unwrap(), payload);
        // 镜像列表必须能从库里读回，否则引擎根本不会切源。
        let stored = inner.store.task(&task.id).unwrap().unwrap();
        assert_eq!(stored.mirrors.len(), 1);
        assert_eq!(stored.status, TaskStatus::Completed);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn sha256_match_allows_completion() {
        let payload: Vec<u8> = (0..500_000usize).map(|i| (i % 163) as u8).collect();
        let url = spawn_range_server(payload.clone()).await;

        let base = temp_base("sha-ok");
        let store = Store::open(&base).unwrap();
        let config = EngineConfig::default();
        let inner = test_inner(base.clone(), store, config.clone());
        let save_path = base.join("sha-ok.bin");
        let mut task = sample_task(&url, &save_path, 2, 0);
        task.sha256 = Some(sha256_hex(&payload));
        inner.store.insert_task(&task).unwrap();

        let (sender, receiver) = watch::channel(Control::Run);
        inner
            .controls
            .lock()
            .unwrap()
            .insert(task.id.clone(), sender);
        let ctx = EngineCtx {
            inner: inner.clone(),
            task_id: task.id.clone(),
            save_path: save_path.clone(),
            probe: None,
            control: receiver,
        };
        let engine = crate::engine::native::NativeEngine::new(config, None);
        engine.run(ctx).await.unwrap();
        inner.complete(&task.id).await.unwrap();

        let stored = inner.store.task(&task.id).unwrap().unwrap();
        assert_eq!(stored.status, TaskStatus::Completed);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn sha256_mismatch_blocks_completion() {
        let payload: Vec<u8> = (0..500_000usize).map(|i| (i % 157) as u8).collect();
        let url = spawn_range_server(payload.clone()).await;

        let base = temp_base("sha-bad");
        let store = Store::open(&base).unwrap();
        let config = EngineConfig::default();
        let inner = test_inner(base.clone(), store, config.clone());
        let save_path = base.join("sha-bad.bin");
        let mut task = sample_task(&url, &save_path, 2, 0);
        task.sha256 = Some("0".repeat(64));
        inner.store.insert_task(&task).unwrap();

        let (sender, receiver) = watch::channel(Control::Run);
        inner
            .controls
            .lock()
            .unwrap()
            .insert(task.id.clone(), sender);
        let ctx = EngineCtx {
            inner: inner.clone(),
            task_id: task.id.clone(),
            save_path: save_path.clone(),
            probe: None,
            control: receiver,
        };
        let engine = crate::engine::native::NativeEngine::new(config, None);
        engine.run(ctx).await.unwrap();
        let error = inner.complete(&task.id).await.unwrap_err();
        assert!(error.contains("SHA-256"), "unexpected error: {error}");

        let stored = inner.store.task(&task.id).unwrap().unwrap();
        assert_ne!(stored.status, TaskStatus::Completed);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn content_type_routes_stream_and_metalink() {
        let mut probe = ProbeResult::default();
        probe.content_type = Some("application/vnd.apple.mpegurl".to_string());
        assert!(sniffed_stream(Some(&probe)));
        probe.content_type = Some("application/dash+xml".to_string());
        assert!(sniffed_stream(Some(&probe)));
        probe.content_type = Some("application/metalink4+xml".to_string());
        assert!(sniffed_metalink(Some(&probe)));
        assert!(!sniffed_stream(Some(&probe)));
        probe.content_type = Some("video/mp4".to_string());
        assert!(!sniffed_stream(Some(&probe)));
        assert!(!sniffed_metalink(Some(&probe)));
    }

    #[test]
    fn engine_descriptors_cover_all_choices() {
        let names: Vec<&str> = crate::engine::DESCRIPTORS
            .iter()
            .map(|descriptor| descriptor.name)
            .collect();
        assert_eq!(names.len(), 7);
        assert!(names.contains(&"综合下载引擎1"));
        assert!(names.contains(&"综合下载引擎2"));
        assert!(names.contains(&"cURL 外部引擎"));
        assert!(names.contains(&"Wget 外部引擎"));
        assert!(names.contains(&"Gopeed 外部引擎"));
    }

    #[test]
    fn stream_output_renames_playlists_and_unknown_extensions() {
        assert_eq!(stream_output_name("movie.m3u8").as_deref(), Some("movie.mp4"));
        assert_eq!(stream_output_name("movie.mpd").as_deref(), Some("movie.mp4"));
        assert_eq!(stream_output_name("download.bin").as_deref(), Some("download.mp4"));
        assert_eq!(stream_output_name("playlist").as_deref(), Some("playlist.mp4"));
        // 已知媒体容器保留用户选择，不强行改 mp4。
        assert_eq!(stream_output_name("clip.mkv"), None);
        assert_eq!(stream_output_name("audio.m4a"), None);
    }

    #[test]
    fn unique_download_path_avoids_overwrite() {
        let base = temp_base("unique-name");
        let first = base.join("file.zip");
        std::fs::write(&first, b"old").unwrap();
        let second = unique_download_path(&first);
        assert_eq!(second.file_name().unwrap(), "file (1).zip");
        std::fs::write(&second, b"old").unwrap();
        let third = unique_download_path(&first);
        assert_eq!(third.file_name().unwrap(), "file (2).zip");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn retryable_failures_exclude_deterministic_errors() {
        assert!(is_retryable_failure("连接超时"));
        assert!(is_retryable_failure("HTTP 503 Service Unavailable"));
        assert!(!is_retryable_failure("HTTP 404 Not Found"));
        assert!(!is_retryable_failure("SHA-256 校验失败"));
        assert!(!is_retryable_failure("未找到 aria2c"));
    }

    #[test]
    fn enqueue_prefers_probed_filename_and_avoids_existing_file() {
        let base = temp_base("enqueue-name");
        std::fs::create_dir_all(&base).unwrap();
        let store = Store::open(&base).unwrap();
        let inner = test_inner(base.clone(), store, EngineConfig::default());
        let manager = DownloadManager { inner: inner.clone() };

        let dir = base.join("out");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("report.pdf"), b"old").unwrap();

        let spec: DownloadSpec = serde_json::from_value(serde_json::json!({
            "urls": ["https://example.test/download?id=1"],
            "savePath": format!("{}/", dir.display()),
            "filename": "report.pdf",
            "engine": "native",
            "priority": 0
        }))
        .unwrap();
        let id = manager.enqueue(spec).unwrap();
        let task = manager.get(&id).unwrap().task;
        assert_eq!(task.filename, "report (1).pdf");
        assert_eq!(Path::new(&task.save_path), dir.join("report (1).pdf"));
        let _ = std::fs::remove_dir_all(&base);
    }
}

