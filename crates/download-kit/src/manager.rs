//! 任务管理器：队列调度、状态机、暂停/恢复/取消、进度事件。
//!
//! 并发模型：
//! - 一个常驻调度循环（`scheduler`）按 `max_concurrent_tasks` 认领 `queued` 任务；
//! - 每个任务一个 tokio 任务，内部再按分片并发（native 引擎）；
//! - 暂停/取消通过 `watch` 通道下发，分片在块边界检查，不依赖 kill 线程。

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{watch, Notify};

use crate::engine::{self as engines, DownloadEngine, EngineCtx, EngineOutcome};
use crate::probe;
use crate::store::Store;
use crate::types::{
    DownloadPart, DownloadSpec, DownloadTask, EngineConfig, EngineInfo, EngineKind, EngineStatus,
    PartState, ProbeRequest, ProbeResult, ProgressPayload, TaskDetail, TaskStatus,
};
use crate::util::{dir_size, filename_from_url, is_p2p_url, now_ms, sanitize_filename};
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
    controls: Mutex<HashMap<String, watch::Sender<Control>>>,
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
                speed: 0.0,
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

    fn complete(&self, id: &str) -> Result<(), String> {
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
        Ok(())
    }

    /// auto 规则的唯一出处：P2P → gopeed；HLS → ffmpeg；多段 → native。
    fn resolve_engine(&self, task: &DownloadTask) -> (EngineKind, bool) {
        if task.engine != EngineKind::Auto {
            return (task.engine, true);
        }
        if task.urls.len() == 1 && is_p2p_url(&task.urls[0]) {
            // P2P 没有 HTTP 探针/分片语义，必须交给支持 BT/磁力/ed2k 的引擎。
            return (EngineKind::Gopeed, true);
        }
        if task.urls.len() == 1 && engines::is_hls(&task.urls[0]) {
            // HLS 形态决定必须用 ffmpeg；这是硬约束，不能在缺 ffmpeg 时退回 native
            //（否则会只下到一个 m3u8 文本文件）。
            return (EngineKind::Ffmpeg, true);
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
            controls: Mutex::new(HashMap::new()),
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
        let raw_save = spec.save_path.trim();
        if raw_save.is_empty() {
            return Err("缺少保存路径".to_string());
        }
        let p2p = spec.engine == EngineKind::Gopeed || is_p2p_url(&urls[0]);
        let mut save_path = PathBuf::from(raw_save);
        let filename;
        if p2p {
            // P2P 的落盘单位是目录（种子内可能多文件）。
            // 目标目录已存在且非空时追加任务专属子目录，避免取消任务时误删用户已有内容。
            let non_empty = save_path.is_dir()
                && std::fs::read_dir(&save_path)
                    .map(|mut entries| entries.next().is_some())
                    .unwrap_or(false);
            let dir = if non_empty {
                save_path.join(format!("torrent-{}", &id[..8]))
            } else {
                save_path
            };
            std::fs::create_dir_all(&dir)
                .map_err(|e| format!("创建 P2P 下载目录失败 {}: {e}", dir.display()))?;
            filename = dir
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "torrent".to_string());
            save_path = dir;
        } else {
            let directory_target = raw_save.ends_with('/')
                || raw_save.ends_with('\\')
                || save_path.is_dir();
            if directory_target {
                let name =
                    filename_from_url(&urls[0]).unwrap_or_else(|| "download.bin".to_string());
                save_path = save_path.join(sanitize_filename(&name));
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

        let config = self.inner.config();
        let connections = spec.connections.unwrap_or(config.connections).clamp(1, 32);
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
}

fn temp_dir_for(save_path: &str) -> PathBuf {
    let mut name = std::ffi::OsString::from(save_path);
    name.push(".parts");
    PathBuf::from(name)
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
    let Some(task) = inner.store.task(id)? else {
        return Ok(());
    };
    if task.status != TaskStatus::Downloading {
        return Ok(());
    }
    // 认领后先进入 probing；若这期间被暂停（状态已变），直接退出。
    if !inner.advance(id, TaskStatus::Probing)? {
        return Ok(());
    }

    let (requested, explicit) = inner.resolve_engine(&task);
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

    if let Ok(Some(current)) = inner.store.task(id) {
        let _ = inner
            .store
            .update_meta(id, kind, &current.filename, current.total_bytes);
    }

    let ctx = EngineCtx {
        inner: inner.clone(),
        task_id: id.to_string(),
        save_path: PathBuf::from(&task.save_path),
        control,
    };

    match engine.run(ctx).await {
        Ok(EngineOutcome::Done) => {
            if let Err(message) = inner.complete(id) {
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
            inner.fail(id, &message);
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

    fn test_inner(base: PathBuf, store: Store, config: EngineConfig) -> Arc<Inner> {
        Arc::new(Inner {
            base,
            app: None,
            store,
            config: RwLock::new(config),
            engine_map: RwLock::new(HashMap::new()),
            controls: Mutex::new(HashMap::new()),
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
            connections,
            error: None,
            created_at: now,
            updated_at: now,
            completed_at: None,
        }
    }

    async fn spawn_range_server(payload: Vec<u8>) -> String {
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
                    serve(stream, payload).await;
                });
            }
        });
        format!("http://{address}/file.bin")
    }

    async fn serve(mut stream: TcpStream, payload: Arc<Vec<u8>>) {
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
            ("GET", Some((start, end))) if start <= end && end < total => {
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
            control: receiver,
        };
        let engine = crate::engine::native::NativeEngine::new(config, None);
        let outcome = engine.run(ctx).await.unwrap();
        assert_eq!(outcome, EngineOutcome::Done);
        inner.complete(&task.id).unwrap();

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
            control: receiver,
        };
        let engine = crate::engine::native::NativeEngine::new(config, None);
        let outcome = engine.run(ctx).await.unwrap();
        assert_eq!(outcome, EngineOutcome::Done);
        inner.complete(&task.id).unwrap();

        assert_eq!(std::fs::read(&save_path).unwrap(), payload);
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
            control: receiver,
        };
        let engine = crate::engine::simple::SimpleEngine::new(config, None);
        let outcome = engine.run(ctx).await.unwrap();
        assert_eq!(outcome, EngineOutcome::Done);
        inner.complete(&task.id).unwrap();

        assert_eq!(std::fs::read(&save_path).unwrap(), payload);
        let parts = inner.store.parts(&task.id).unwrap();
        assert_eq!(parts.len(), 1);

        let _ = std::fs::remove_dir_all(&base);
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
}

