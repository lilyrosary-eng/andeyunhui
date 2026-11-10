//! 综合下载引擎1：内置分块多连接引擎。
//!
//! 只使用公开的 HTTP 语义：
//! - 探测拿 `Content-Length` / `Accept-Ranges`，按连接数切分片；
//! - 每片独立临时文件（避免并发 seek 竞争），用 `Range: bytes=start+downloaded-end-1` 续传；
//! - 分片状态实时落 SQLite，进程重启后按 `downloaded` 继续；
//! - 全部完成后按序合并；多地址任务交给 ffmpeg concat。
//!
//! 不涉及浏览器集成 / 系统驱动 / 站点抓取，只负责传输内核。

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::header::RANGE;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::process::Command;

use crate::engine::limiter::SpeedLimiter;
use crate::engine::{DownloadEngine, EngineCtx, EngineOutcome, PartResult};
use crate::manager::{Control, TaskProgress};
use crate::probe::{self, HttpMeta};
use crate::types::{
    DownloadPart, DownloadTask, EngineConfig, EngineKind, PartState, TaskStatus,
};
use crate::util::{tail_text, DEFAULT_UA};

/// 小于这个大小的文件不值得切块（切了也只是多几次请求）。
const MIN_PART_BYTES: u64 = 256 * 1024;
/// 合并分片时的拷贝缓冲。
const COPY_BUFFER: usize = 1024 * 1024;

pub struct NativeEngine {
    config: EngineConfig,
    client: reqwest::Client,
    /// 多地址合并需要；缺失时多段任务会明确报错。
    ffmpeg: Option<PathBuf>,
}

impl NativeEngine {
    pub fn new(config: EngineConfig, ffmpeg: Option<PathBuf>) -> Self {
        let client = probe::build_client(&config).unwrap_or_else(|e| {
            eprintln!("[download-kit] 创建 HTTP 客户端失败，回退默认客户端: {e}");
            reqwest::Client::new()
        });
        Self {
            config,
            client,
            ffmpeg,
        }
    }
}

#[async_trait]
impl DownloadEngine for NativeEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::Native
    }

    async fn run(&self, ctx: EngineCtx) -> Result<EngineOutcome, String> {
        self.run_with_mode(ctx, EngineKind::Native, false).await
    }
}

impl NativeEngine {
    /// 引擎1 与引擎2 共用同一套传输实现；
    /// `single_connection = true` 时强制单连接（不做多分片），用于兼容拒绝并发的站点。
    pub(crate) async fn run_with_mode(
        &self,
        ctx: EngineCtx,
        kind: EngineKind,
        single_connection: bool,
    ) -> Result<EngineOutcome, String> {
        let mut task = ctx.task()?;
        if single_connection {
            task.connections = 1;
        }
        if task.urls.is_empty() {
            return Err("缺少下载地址".to_string());
        }
        if let Some(parent) = Path::new(&task.save_path).parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("创建下载目录失败 {}: {e}", parent.display()))?;
        }
        let parts = ctx.parts()?;
        if task.urls.len() > 1 {
            self.run_multi(ctx, task, parts, kind).await
        } else {
            self.run_single(ctx, task, parts, kind).await
        }
    }
}

impl NativeEngine {
    /// 单地址：分块并发 + 合并。
    async fn run_single(
        &self,
        ctx: EngineCtx,
        mut task: DownloadTask,
        mut parts: Vec<DownloadPart>,
        kind: EngineKind,
    ) -> Result<EngineOutcome, String> {
        let meta = HttpMeta::from_task(&task);
        // 已有分片时不切源：不同镜像的同名文件不保证字节一致，混着续会写坏。
        let has_progress = parts
            .iter()
            .any(|part| part.downloaded > 0 || part.state == PartState::Completed);
        let (source_url, probe) = match ctx.probe() {
            Some(probe) => (task.urls[0].clone(), probe),
            None if has_progress => {
                let result = probe::probe(&self.client, &task.urls[0], &meta)
                    .await
                    .unwrap_or_default();
                (task.urls[0].clone(), result)
            }
            None => {
                probe::select_source(&self.client, &task.urls[0], &task.mirrors, &meta).await
            }
        };
        task.urls[0] = source_url;
        if probe.total_bytes > 0 {
            task.total_bytes = probe.total_bytes;
        }
        if task.filename.trim().is_empty() {
            if let Some(filename) = probe.filename {
                task.filename = filename;
            }
        }
        enforce_max_bytes(&task)?;
        ctx.update_meta(kind, &task.filename, task.total_bytes)?;

        if let Some(outcome) = check_control(&ctx) {
            return Ok(outcome);
        }

        // 上次探测失败（total=0）留下了未知长度的单片：这次拿到总长后只补齐 end，
        // 不能重排分片，否则会把已下载的字节清零。
        if parts.len() == 1 && parts[0].end == 0 && task.total_bytes > 0 {
            parts[0].end = task.total_bytes;
            ctx.replace_parts(&parts)?;
        }

        let temp_dir = ctx.temp_dir();
        tokio::fs::create_dir_all(&temp_dir)
            .await
            .map_err(|e| format!("创建分片目录失败 {}: {e}", temp_dir.display()))?;

        let plan = plan_single(&task, &temp_dir);
        if needs_replan(&parts, &plan, task.total_bytes) {
            ctx.replace_parts(&plan)?;
            parts = plan;
        }

        let multipart = parts.len() > 1;
        ctx.transition(TaskStatus::Downloading)?;
        ctx.emit_state();

        let mut final_progress = Arc::new(TaskProgress::new(
            task.total_bytes,
            task.connections,
            parts.len() as u32,
        ));
        for part in &parts {
            final_progress.seed(part);
        }
        let limiter = task
            .max_speed
            .and_then(SpeedLimiter::new)
            .map(Arc::new);

        let mut attempt = self
            .download_parts(
                &ctx,
                &task,
                &parts,
                &final_progress,
                task.connections as usize,
                multipart,
                limiter.clone(),
            )
            .await;

        // 降级 1：并发被服务器拒绝/超时，保留已完成分片，改为单连接顺序下载。
        if let Err(error) = &attempt {
            let kind = error.kind;
            if kind != PartErrorKind::RangeUnsupported && task.connections > 1 {
                let reloaded = ctx.parts()?;
                let retry_progress = Arc::new(TaskProgress::new(
                    task.total_bytes,
                    1,
                    reloaded.len() as u32,
                ));
                for part in &reloaded {
                    retry_progress.seed(part);
                }
                attempt = self
                    .download_parts(
                        &ctx,
                        &task,
                        &reloaded,
                        &retry_progress,
                        1,
                        multipart,
                        limiter.clone(),
                    )
                    .await;
                if attempt.is_ok() {
                    final_progress = retry_progress;
                }
            }
        }

        // 降级 2：服务器实际不支持 Range（多分片收到 200）→ 重置为单流从头下载。
        if matches!(&attempt, Err(error) if error.kind == PartErrorKind::RangeUnsupported) {
            let single = plan_single_stream(&task, &ctx.temp_dir());
            ctx.replace_parts(std::slice::from_ref(&single))?;
            let retry_progress = Arc::new(TaskProgress::new(task.total_bytes, 1, 1));
            attempt = self
                .download_parts(
                    &ctx,
                    &task,
                    std::slice::from_ref(&single),
                    &retry_progress,
                    1,
                    false,
                    limiter.clone(),
                )
                .await;
            if attempt.is_ok() {
                final_progress = retry_progress;
            }
        }

        match attempt {
            Ok(PartsOutcome::Done) => {}
            Ok(PartsOutcome::Paused) => return Ok(EngineOutcome::Paused),
            Ok(PartsOutcome::Canceled) => return Ok(EngineOutcome::Canceled),
            Err(error) => return Err(error.message),
        }

        let downloaded = final_progress.downloaded.load(Ordering::Relaxed);
        ctx.set_progress(downloaded, task.total_bytes);
        if task.total_bytes > 0 && downloaded != task.total_bytes {
            return Err(format!(
                "分片总字节与文件大小不一致：期望 {}，实际 {}",
                task.total_bytes, downloaded
            ));
        }

        if let Some(outcome) = check_control(&ctx) {
            return Ok(outcome);
        }
        ctx.transition(TaskStatus::Merging)?;
        ctx.emit_state();

        // 以库里的分片状态为准：并发 abort 后内存副本可能落后。
        let merged_parts = ctx.parts()?;
        merge_parts(&merged_parts, &ctx.save_path()).await?;
        let _ = tokio::fs::remove_dir_all(&ctx.temp_dir()).await;
        Ok(EngineOutcome::Done)
    }

    /// 多地址：逐段下载（每段一个分片）+ ffmpeg 按序拼接。
    /// 与既有 `download_video` 的口径一致，避免把 durl 分段写成互相覆盖。
    async fn run_multi(
        &self,
        ctx: EngineCtx,
        mut task: DownloadTask,
        mut parts: Vec<DownloadPart>,
        kind: EngineKind,
    ) -> Result<EngineOutcome, String> {
        let meta = HttpMeta::from_task(&task);
        let mut lengths = Vec::with_capacity(task.urls.len());
        let mut total = 0u64;
        for url in &task.urls {
            let length = probe::probe(&self.client, url, &meta)
                .await
                .map(|result| result.total_bytes)
                .unwrap_or(0);
            lengths.push(length);
            total = total.saturating_add(length);
        }
        if total > 0 {
            task.total_bytes = total;
        }
        enforce_max_bytes(&task)?;
        ctx.update_meta(kind, &task.filename, task.total_bytes)?;

        if let Some(outcome) = check_control(&ctx) {
            return Ok(outcome);
        }

        let temp_dir = ctx.temp_dir();
        tokio::fs::create_dir_all(&temp_dir)
            .await
            .map_err(|e| format!("创建分片目录失败 {}: {e}", temp_dir.display()))?;

        let plan = plan_multi(&task, &temp_dir, &lengths);
        let same_layout = parts.len() == task.urls.len()
            && parts
                .iter()
                .zip(task.urls.iter())
                .all(|(part, url)| part.url == *url);
        if !same_layout {
            ctx.replace_parts(&plan)?;
            parts = plan;
        }

        let progress = Arc::new(TaskProgress::new(
            task.total_bytes,
            1,
            parts.len() as u32,
        ));
        for part in &parts {
            progress.seed(part);
        }
        let limiter = task
            .max_speed
            .and_then(SpeedLimiter::new)
            .map(Arc::new);

        ctx.transition(TaskStatus::Downloading)?;
        ctx.emit_state();

        for part in parts.iter_mut() {
            if part.state == PartState::Completed {
                continue;
            }
            let mut owned = part.clone();
            let result = download_part(
                &self.client,
                &self.config,
                &ctx,
                &task,
                &mut owned,
                &progress,
                false,
                limiter.clone(),
            )
            .await
            .map_err(|error| error.message)?;
            *part = owned;
            match result {
                PartResult::Done => {}
                PartResult::Paused => return Ok(EngineOutcome::Paused),
                PartResult::Canceled => return Ok(EngineOutcome::Canceled),
            }
        }

        if let Some(outcome) = check_control(&ctx) {
            return Ok(outcome);
        }
        ctx.transition(TaskStatus::Merging)?;
        ctx.emit_state();

        let ffmpeg = self.ffmpeg.clone().ok_or_else(|| {
            "多段合并需要 ffmpeg：请在下载配置中指定路径，或确认 external-deps 中存在 ffmpeg"
                .to_string()
        })?;
        let output = ctx.save_path();
        run_ffmpeg_concat(&ffmpeg, &parts, &output, &temp_dir).await?;
        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
        Ok(EngineOutcome::Done)
    }
}

/// 单地址分片计划。
fn plan_single(task: &DownloadTask, dir: &Path) -> Vec<DownloadPart> {
    let total = task.total_bytes;
    let connections = task.connections.clamp(1, 32);
    let max_parts = if total == 0 {
        1
    } else {
        (total / MIN_PART_BYTES).max(1).min(32) as u32
    };
    let count = connections.min(max_parts).max(1);

    let mut parts = Vec::with_capacity(count as usize);
    if count == 1 || total == 0 {
        parts.push(DownloadPart {
            index: 0,
            url: task.urls[0].clone(),
            start: 0,
            end: total,
            downloaded: 0,
            state: PartState::Pending,
            temp_path: temp_file(dir, "part", 0),
        });
        return parts;
    }

    let chunk = total / count as u64;
    for index in 0..count {
        let start = chunk * index as u64;
        let end = if index + 1 == count {
            total
        } else {
            chunk * (index + 1) as u64
        };
        parts.push(DownloadPart {
            index,
            url: task.urls[0].clone(),
            start,
            end,
            downloaded: 0,
            state: PartState::Pending,
            temp_path: temp_file(dir, "part", index as usize),
        });
    }
    parts
}

/// 多地址计划：一段一个分片。
fn plan_multi(task: &DownloadTask, dir: &Path, lengths: &[u64]) -> Vec<DownloadPart> {
    task.urls
        .iter()
        .enumerate()
        .map(|(index, url)| DownloadPart {
            index: index as u32,
            url: url.clone(),
            start: 0,
            end: lengths.get(index).copied().unwrap_or(0),
            downloaded: 0,
            state: PartState::Pending,
            temp_path: temp_file(dir, "seg", index),
        })
        .collect()
}

/// 降级用的单流计划：一个从 0 开始的分片，不再发多段 Range。
fn plan_single_stream(task: &DownloadTask, dir: &Path) -> DownloadPart {
    DownloadPart {
        index: 0,
        url: task.urls[0].clone(),
        start: 0,
        end: task.total_bytes,
        downloaded: 0,
        state: PartState::Pending,
        temp_path: dir
            .join("part-single.bin")
            .to_string_lossy()
            .into_owned(),
    }
}

fn temp_file(dir: &Path, prefix: &str, index: usize) -> String {
    dir.join(format!("{prefix}-{index:03}.bin"))
        .to_string_lossy()
        .into_owned()
}

/// 已有分片是否还能用：
/// - 服务端没给总长（total == 0）→ 保留，继续按已下载字节续传；
/// - 给了总长但对不上 → 重排；
/// - 分片数变了但都还没开始 → 按新连接数重排。
fn needs_replan(parts: &[DownloadPart], plan: &[DownloadPart], total: u64) -> bool {
    if parts.is_empty() {
        return true;
    }
    if total == 0 {
        return false;
    }
    let sum: u64 = parts
        .iter()
        .map(|part| part.end.saturating_sub(part.start))
        .sum();
    if sum != total {
        return true;
    }
    parts.len() != plan.len() && parts.iter().all(|part| part.downloaded == 0)
}

fn enforce_max_bytes(task: &DownloadTask) -> Result<(), String> {
    if let Some(max) = task.max_bytes {
        if task.total_bytes > max {
            return Err(format!(
                "文件过大（{} MB），已超过下载上限",
                task.total_bytes / 1024 / 1024
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PartErrorKind {
    RetryExhausted,
    RangeUnsupported,
    Fatal,
}

struct PartsError {
    message: String,
    kind: PartErrorKind,
}

impl PartsError {
    fn retry(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            kind: PartErrorKind::RetryExhausted,
        }
    }

    fn fatal(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            kind: PartErrorKind::Fatal,
        }
    }

    fn range_unsupported(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            kind: PartErrorKind::RangeUnsupported,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PartsOutcome {
    Done,
    Paused,
    Canceled,
}

impl NativeEngine {
    /// 按指定并发度执行分片。
    ///
    /// `connections == 1` 时顺序执行：这是并发降级的执行路径，保留已完成分片，
    /// 只把「同时开多个连接」降为「一次一个」。
    async fn download_parts(
        &self,
        ctx: &EngineCtx,
        task: &DownloadTask,
        parts: &[DownloadPart],
        progress: &Arc<TaskProgress>,
        connections: usize,
        multipart: bool,
        limiter: Option<Arc<SpeedLimiter>>,
    ) -> Result<PartsOutcome, PartsError> {
    let pending: Vec<DownloadPart> = parts
        .iter()
        .filter(|part| part.state != PartState::Completed)
        .cloned()
        .collect();
    if pending.is_empty() {
        return Ok(PartsOutcome::Done);
    }

    if connections <= 1 {
        for part in pending {
            let mut part = part;
            match download_part(
                &self.client,
                &self.config,
                ctx,
                task,
                &mut part,
                progress,
                multipart,
                limiter.clone(),
            )
            .await
            {
                Ok(PartResult::Done) => {}
                Ok(PartResult::Paused) => return Ok(PartsOutcome::Paused),
                Ok(PartResult::Canceled) => return Ok(PartsOutcome::Canceled),
                Err(error) => return Err(error),
            }
        }
        return Ok(PartsOutcome::Done);
    }

    let mut set: tokio::task::JoinSet<Result<PartResult, PartsError>> =
        tokio::task::JoinSet::new();
    for part in pending {
        let ctx2 = ctx.clone();
        let task2 = task.clone();
        let client = self.client.clone();
        let config = self.config.clone();
        let progress = progress.clone();
        let limiter = limiter.clone();
        set.spawn(async move {
            let mut part = part;
            download_part(
                &client,
                &config,
                &ctx2,
                &task2,
                &mut part,
                &progress,
                multipart,
                limiter,
            )
            .await
        });
    }

    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(Ok(PartResult::Done)) => {}
            Ok(Ok(PartResult::Paused)) => {
                set.abort_all();
                set.shutdown().await;
                return Ok(PartsOutcome::Paused);
            }
            Ok(Ok(PartResult::Canceled)) => {
                set.abort_all();
                set.shutdown().await;
                return Ok(PartsOutcome::Canceled);
            }
            Ok(Err(error)) => {
                set.abort_all();
                set.shutdown().await;
                return Err(error);
            }
            Err(join_error) => {
                set.abort_all();
                set.shutdown().await;
                return Err(PartsError::fatal(format!("分片任务异常: {join_error}")));
            }
        }
    }
    Ok(PartsOutcome::Done)
}
}

/// 分片执行器：负责重试与退避；真正的单次传输在 `download_once`。
async fn download_part(
    client: &reqwest::Client,
    config: &EngineConfig,
    ctx: &EngineCtx,
    task: &DownloadTask,
    part: &mut DownloadPart,
    progress: &Arc<TaskProgress>,
    multipart: bool,
    limiter: Option<Arc<SpeedLimiter>>,
) -> Result<PartResult, PartsError> {
    let mut attempt = 0u32;
    loop {
        match ctx.control_state() {
            Control::Pause => return Ok(PartResult::Paused),
            Control::Cancel => return Ok(PartResult::Canceled),
            Control::Run => {}
        }

        match download_once(
            client,
            ctx,
            task,
            part,
            progress,
            multipart,
            limiter.as_deref(),
        )
        .await
        {
            Ok(()) => {
                part.state = PartState::Completed;
                progress.parts_done.fetch_add(1, Ordering::Relaxed);
                let _ = ctx.update_part(part);
                return Ok(PartResult::Done);
            }
            Err(PartFailure::Paused) => return Ok(PartResult::Paused),
            Err(PartFailure::Canceled) => return Ok(PartResult::Canceled),
            Err(PartFailure::RangeUnsupported) => {
                return Err(PartsError::range_unsupported(
                    "服务器不支持 Range，无法多连接分块下载",
                ));
            }
            Err(PartFailure::Fatal(message)) => return Err(PartsError::fatal(message)),
            Err(PartFailure::Retry(message)) => {
                attempt += 1;
                if attempt > config.retries {
                    return Err(PartsError::retry(format!(
                        "重试 {} 次后仍失败：{message}",
                        config.retries
                    )));
                }
                let backoff = config
                    .retry_base_ms
                    .saturating_mul(1u64 << attempt.min(6))
                    .min(config.retry_max_ms);
                if let Some(outcome) = sleep_with_control(ctx, backoff).await {
                    return Ok(outcome);
                }
            }
        }
    }
}

enum PartFailure {
    Retry(String),
    Fatal(String),
    RangeUnsupported,
    Paused,
    Canceled,
}

/// 单次传输。成功返回即代表该分片已下满（长度校验通过）。
async fn download_once(
    client: &reqwest::Client,
    ctx: &EngineCtx,
    task: &DownloadTask,
    part: &mut DownloadPart,
    progress: &Arc<TaskProgress>,
    multipart: bool,
    limiter: Option<&SpeedLimiter>,
) -> Result<(), PartFailure> {
    let expected = part.expected();
    if expected > 0 && part.downloaded >= expected {
        return Ok(());
    }

    let temp = PathBuf::from(&part.temp_path);
    if let Some(parent) = temp.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| PartFailure::Fatal(format!("创建分片目录失败: {e}")))?;
    }

    let offset = part.start + part.downloaded;
    let meta = HttpMeta::from_task(task);
    let mut request = probe::apply_headers(client.get(&part.url), &meta, DEFAULT_UA);
    if expected > 0 {
        request = request.header(RANGE, format!("bytes={}-{}", offset, part.end - 1));
    } else if part.downloaded > 0 {
        request = request.header(RANGE, format!("bytes={}-", offset));
    }

    let response = request
        .send()
        .await
        .map_err(|e| PartFailure::Retry(format!("请求失败: {e}")))?;

    let status = response.status();
    if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        // 常见于「本地其实已经下满，只是 last 1 字节的记录没落库」。
        if expected > 0 && part.downloaded >= expected {
            return Ok(());
        }
        return Err(PartFailure::Fatal(
            "服务端拒绝 Range 请求（416），无法继续续传".to_string(),
        ));
    }
    if !status.is_success() {
        return Err(PartFailure::Retry(format!("下载地址返回状态 {status}")));
    }

    let partial = status == reqwest::StatusCode::PARTIAL_CONTENT;
    if !partial {
        if multipart {
            // 多分片任务若收到整文件 200，继续写会把整文件塞进第一个分片。
            // 交给上层降级为单流下载，而不是直接失败。
            return Err(PartFailure::RangeUnsupported);
        }
        if part.downloaded > 0 || part.start > 0 {
            // 单连接续传被服务器忽略：从头重来（保证字节不重复）。
            progress
                .downloaded
                .fetch_sub(part.downloaded, Ordering::Relaxed);
            part.downloaded = 0;
        }
    }

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(&temp)
        .await
        .map_err(|e| PartFailure::Fatal(format!("打开分片文件失败: {e}")))?;
    // 上次可能写入了尚未落库的尾部字节；截到已记录位置再续，避免重复。
    file.set_len(part.downloaded)
        .await
        .map_err(|e| PartFailure::Fatal(format!("截断分片文件失败: {e}")))?;
    file.seek(std::io::SeekFrom::Start(part.downloaded))
        .await
        .map_err(|e| PartFailure::Fatal(format!("定位分片文件失败: {e}")))?;

    let mut stream = response.bytes_stream();
    loop {
        match ctx.control_state() {
            Control::Pause => {
                let _ = file.flush().await;
                let _ = ctx.update_part(part);
                return Err(PartFailure::Paused);
            }
            Control::Cancel => {
                let _ = file.flush().await;
                let _ = ctx.update_part(part);
                return Err(PartFailure::Canceled);
            }
            Control::Run => {}
        }

        let chunk = match stream.next().await {
            Some(Ok(chunk)) => chunk,
            Some(Err(e)) => {
                let _ = file.flush().await;
                let _ = ctx.update_part(part);
                return Err(PartFailure::Retry(format!("读取下载内容失败: {e}")));
            }
            None => break,
        };
        let length = chunk.len() as u64;
        file.write_all(&chunk)
            .await
            .map_err(|e| PartFailure::Fatal(format!("写入分片失败: {e}")))?;
        part.downloaded += length;
        progress.downloaded.fetch_add(length, Ordering::Relaxed);
        if let Some(limiter) = limiter {
            if let Some(failure) = throttle(limiter, length, ctx).await {
                let _ = file.flush().await;
                let _ = ctx.update_part(part);
                return Err(failure);
            }
        }
        if ctx.tick(progress) {
            let _ = ctx.update_part(part);
        }
    }

    file.flush()
        .await
        .map_err(|e| PartFailure::Retry(format!("刷新分片文件失败: {e}")))?;
    drop(file);
    let _ = ctx.update_part(part);

    if expected > 0 && part.downloaded != expected {
        return Err(PartFailure::Retry(format!(
            "分片未下满：期望 {} 字节，实际 {} 字节",
            expected, part.downloaded
        )));
    }
    Ok(())
}

/// 限速等待：每 200ms 检查一次控制信号，低速限速下暂停也能及时生效。
async fn throttle(limiter: &SpeedLimiter, bytes: u64, ctx: &EngineCtx) -> Option<PartFailure> {
    loop {
        match limiter.reserve(bytes) {
            None => return None,
            Some(wait) => {
                tokio::time::sleep(wait.min(Duration::from_millis(200))).await;
                match ctx.control_state() {
                    Control::Pause => return Some(PartFailure::Paused),
                    Control::Cancel => return Some(PartFailure::Canceled),
                    Control::Run => {}
                }
            }
        }
    }
}

async fn sleep_with_control(ctx: &EngineCtx, millis: u64) -> Option<PartResult> {
    let deadline = Instant::now() + Duration::from_millis(millis);
    loop {
        match ctx.control_state() {
            Control::Pause => return Some(PartResult::Paused),
            Control::Cancel => return Some(PartResult::Canceled),
            Control::Run => {}
        }
        let now = Instant::now();
        if now >= deadline {
            return None;
        }
        let step = (deadline - now).min(Duration::from_millis(100));
        tokio::time::sleep(step).await;
    }
}

fn check_control(ctx: &EngineCtx) -> Option<EngineOutcome> {
    match ctx.control_state() {
        Control::Pause => Some(EngineOutcome::Paused),
        Control::Cancel => Some(EngineOutcome::Canceled),
        Control::Run => None,
    }
}

/// 合并分片：单片直接 rename，多片顺序拷贝。
async fn merge_parts(parts: &[DownloadPart], output: &Path) -> Result<(), String> {
    if parts.is_empty() {
        return Err("没有可合并的分片".to_string());
    }
    if parts.len() == 1 {
        let source = PathBuf::from(&parts[0].temp_path);
        if let Some(parent) = output.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("创建下载目录失败: {e}"))?;
        }
        let _ = tokio::fs::remove_file(output).await;
        return tokio::fs::rename(&source, output)
            .await
            .map_err(|e| format!("移动下载文件失败: {e}"));
    }

    let parts = parts.to_vec();
    let output = output.to_path_buf();
    tokio::task::spawn_blocking(move || merge_blocking(&parts, &output))
        .await
        .map_err(|e| format!("合并任务异常: {e}"))?
}

fn merge_blocking(parts: &[DownloadPart], output: &Path) -> Result<(), String> {
    use std::io::{Read, Write};

    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建下载目录失败 {}: {e}", parent.display()))?;
    }
    let mut target =
        std::fs::File::create(output).map_err(|e| format!("创建目标文件失败: {e}"))?;
    let mut buffer = vec![0u8; COPY_BUFFER];
    for part in parts {
        let mut source = std::fs::File::open(&part.temp_path)
            .map_err(|e| format!("打开分片失败 {}: {e}", part.temp_path))?;
        loop {
            let read = source
                .read(&mut buffer)
                .map_err(|e| format!("读取分片失败: {e}"))?;
            if read == 0 {
                break;
            }
            target
                .write_all(&buffer[..read])
                .map_err(|e| format!("写入目标文件失败: {e}"))?;
        }
    }
    target.flush().map_err(|e| format!("刷新目标文件失败: {e}"))?;
    Ok(())
}

/// 多段拼接：ffmpeg concat demuxer，`-c copy` 不重编码。
async fn run_ffmpeg_concat(
    ffmpeg: &Path,
    parts: &[DownloadPart],
    output: &Path,
    temp_dir: &Path,
) -> Result<(), String> {
    if parts.len() == 1 {
        let source = PathBuf::from(&parts[0].temp_path);
        let _ = tokio::fs::remove_file(output).await;
        return tokio::fs::rename(&source, output)
            .await
            .map_err(|e| format!("移动下载文件失败: {e}"));
    }

    let list_path = temp_dir.join("concat.txt");
    let mut list = String::new();
    for part in parts {
        // concat demuxer 的单引号转义：' -> '\''
        let path = part.temp_path.replace('\\', "/").replace('\'', "'\\''");
        list.push_str(&format!("file '{path}'\n"));
    }
    tokio::fs::write(&list_path, list)
        .await
        .map_err(|e| format!("写入拼接清单失败: {e}"))?;

    let mut command = Command::new(ffmpeg);
    command
        .arg("-nostdin")
        .arg("-y")
        .arg("-loglevel")
        .arg("error")
        .arg("-f")
        .arg("concat")
        .arg("-safe")
        .arg("0")
        .arg("-i")
        .arg(&list_path)
        .arg("-c")
        .arg("copy")
        .arg(output)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }

    let result = command
        .output()
        .await
        .map_err(|e| format!("启动 ffmpeg 失败: {e}"))?;
    let _ = tokio::fs::remove_file(&list_path).await;
    if !result.status.success() {
        let _ = tokio::fs::remove_file(output).await;
        return Err(format!(
            "分段合并失败: {}",
            tail_text(&String::from_utf8_lossy(&result.stderr), 400)
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::DownloadTask;
    use std::collections::BTreeMap;

    fn task(total: u64, connections: u32) -> DownloadTask {
        DownloadTask {
            id: "t".into(),
            urls: vec!["https://example.test/file.bin".into()],
            save_path: "C:/tmp/file.bin".into(),
            filename: "file.bin".into(),
            referer: None,
            cookie: None,
            user_agent: None,
            headers: BTreeMap::new(),
            engine: EngineKind::Native,
            resolved_engine: None,
            status: TaskStatus::Queued,
            total_bytes: total,
            downloaded_bytes: 0,
            max_bytes: None,
            mirrors: Vec::new(),
            sha256: None,
            max_speed: None,
            connections,
            error: None,
            created_at: 0,
            updated_at: 0,
            completed_at: None,
        }
    }

    #[test]
    fn splits_into_contiguous_ranges() {
        let task = task(1_000_000, 4);
        let parts = plan_single(&task, Path::new("C:/tmp/file.bin.parts"));
        // 1MB / 256KiB 上限 → 最多 3 片；每片边界连续且总和等于文件大小。
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].start, 0);
        for pair in parts.windows(2) {
            assert_eq!(pair[0].end, pair[1].start);
        }
        assert_eq!(parts.last().unwrap().end, 1_000_000);
        let sum: u64 = parts.iter().map(|p| p.end - p.start).sum();
        assert_eq!(sum, 1_000_000);
    }

    #[test]
    fn small_file_stays_single_part() {
        let task = task(100, 8);
        let parts = plan_single(&task, Path::new("C:/tmp/file.bin.parts"));
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].end, 100);
    }

    #[test]
    fn unknown_size_stays_single_part() {
        let task = task(0, 8);
        let parts = plan_single(&task, Path::new("C:/tmp/file.bin.parts"));
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].end, 0);
    }
}

