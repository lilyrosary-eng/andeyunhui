//! ffmpeg 外部引擎：HLS(m3u8) 拉流转封装、本地分段拼接。
//!
//! 直链 HTTP 分块下载不归它管（那是 native 的强项）；这里只负责 ffmpeg 明显更擅长的两件事：
//! - `m3u8` → mp4（切片拉取 + 容器重写）；
//! - 多个本地分段按序 concat（`-c copy` 不重编码）。
//!
//! 进度用 `-progress pipe:1` 的 `total_size=` 行，比解析 stderr 的 `size=` 稳定。

use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

use crate::engine::{DownloadEngine, EngineCtx, EngineOutcome};
use crate::manager::Control;
use crate::types::{EngineConfig, EngineKind, TaskStatus};
use crate::util::{parse_ffmpeg_total_size, tail_text};

pub struct FfmpegEngine {
    config: EngineConfig,
    path: Option<PathBuf>,
}

impl FfmpegEngine {
    pub fn new(config: EngineConfig, path: Option<PathBuf>) -> Self {
        Self { config, path }
    }
}

#[async_trait]
impl DownloadEngine for FfmpegEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::Ffmpeg
    }

    fn available(&self) -> Result<(), String> {
        self.path.as_ref().map(|_| ()).ok_or_else(|| {
            "未找到 ffmpeg：请在下载配置中指定路径，或确认 external-deps 中存在 ffmpeg".to_string()
        })
    }

    fn tool_path(&self) -> Option<String> {
        self.path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned())
    }

    async fn run(&self, ctx: EngineCtx) -> Result<EngineOutcome, String> {
        let ffmpeg = self.path.as_ref().ok_or_else(|| {
            "未找到 ffmpeg：请在下载配置中指定路径，或确认 external-deps 中存在 ffmpeg".to_string()
        })?;
        let task = ctx.task()?;
        if task.urls.is_empty() {
            return Err("缺少下载地址".to_string());
        }
        if let Some(parent) = Path::new(&task.save_path).parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("创建下载目录失败: {e}"))?;
        }

        let local_concat = task.urls.len() > 1;
        // 不探测 m3u8：HEAD 拿到的是播放列表文本大小，不是最终媒体大小；
        // 统一按未知总长计，进度只显示已写字节（完成时再以文件实际大小回填）。
        let total = 0u64;
        if local_concat {
            for url in &task.urls {
                if !Path::new(url).is_file() {
                    return Err(format!(
                        "ffmpeg 引擎的多段模式只接受本地文件，远程分段请使用 auto / native：{url}"
                    ));
                }
            }
        }
        ctx.update_meta(EngineKind::Ffmpeg, &task.filename, total)?;
        if let Some(outcome) = check_control(&ctx) {
            return Ok(outcome);
        }

        ctx.transition(TaskStatus::Downloading)?;
        ctx.emit_state();
        // ffmpeg 不能从半成品精确续传；每次开跑都从 0 记进度（-y 会覆盖旧输出）。
        ctx.set_progress(0, total);

        let output = ctx.save_path();
        let temp_dir = ctx.temp_dir();
        let mut command = Command::new(ffmpeg);
        command
            .arg("-nostdin")
            .arg("-y")
            .arg("-loglevel")
            .arg("error")
            .arg("-progress")
            .arg("pipe:1");

        if local_concat {
            tokio::fs::create_dir_all(&temp_dir)
                .await
                .map_err(|e| format!("创建临时目录失败: {e}"))?;
            let list_path = temp_dir.join("concat.txt");
            let mut list = String::new();
            for url in &task.urls {
                let path = url.replace('\\', "/").replace('\'', "'\\''");
                list.push_str(&format!("file '{path}'\n"));
            }
            tokio::fs::write(&list_path, list)
                .await
                .map_err(|e| format!("写入拼接清单失败: {e}"))?;
            command
                .arg("-f")
                .arg("concat")
                .arg("-safe")
                .arg("0")
                .arg("-i")
                .arg(&list_path);
        } else {
            let headers = build_ffmpeg_headers(&task, &self.config);
            if !headers.is_empty() {
                command.arg("-headers").arg(headers);
            }
            if let Some(proxy) = self.config.proxy.as_deref().filter(|s| !s.is_empty()) {
                command.arg("-http_proxy").arg(proxy);
            }
            command.arg("-i").arg(&task.urls[0]);
        }
        command
            .arg("-c")
            .arg("copy")
            .arg(&output)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            command.creation_flags(0x08000000);
        }

        let mut child = command
            .spawn()
            .map_err(|e| format!("启动 ffmpeg 失败: {e}"))?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let stderr_handle = tokio::spawn(async move {
            let mut text = String::new();
            if let Some(stderr) = stderr {
                let mut reader = BufReader::new(stderr);
                let mut buffer = [0u8; 4096];
                loop {
                    match reader.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => {
                            if text.len() < 16 * 1024 {
                                text.push_str(&String::from_utf8_lossy(&buffer[..read]));
                            }
                        }
                    }
                }
            }
            text
        });

        let mut ticker = tokio::time::interval(Duration::from_millis(250));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last_size = 0u64;

        if let Some(stdout) = stdout {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                tokio::select! {
                    _ = ticker.tick() => {
                        match ctx.control_state() {
                            Control::Pause => {
                                let _ = child.start_kill();
                                let _ = child.wait().await;
                                stderr_handle.abort();
                                return Ok(EngineOutcome::Paused);
                            }
                            Control::Cancel => {
                                let _ = child.start_kill();
                                let _ = child.wait().await;
                                stderr_handle.abort();
                                let _ = tokio::fs::remove_file(&output).await;
                                let _ = tokio::fs::remove_dir_all(&temp_dir).await;
                                return Ok(EngineOutcome::Canceled);
                            }
                            Control::Run => {}
                        }
                    }
                    line = lines.next_line() => {
                        match line {
                            Ok(Some(line)) => {
                                if let Some(size) = parse_ffmpeg_total_size(&line) {
                                    last_size = size;
                                    ctx.set_progress(size, total);
                                }
                            }
                            Ok(None) | Err(_) => break,
                        }
                    }
                }
            }
        }

        let status = child
            .wait()
            .await
            .map_err(|e| format!("等待 ffmpeg 结束失败: {e}"))?;
        let stderr_text = stderr_handle.await.unwrap_or_default();
        let _ = tokio::fs::remove_dir_all(&temp_dir).await;

        if !status.success() {
            let _ = tokio::fs::remove_file(&output).await;
            let tail = tail_text(&stderr_text, 400);
            return Err(if tail.is_empty() {
                format!("ffmpeg 退出码 {:?}", status.code())
            } else {
                format!("ffmpeg 失败（退出码 {:?}）：{tail}", status.code())
            });
        }

        let size = tokio::fs::metadata(&output)
            .await
            .map(|meta| meta.len())
            .unwrap_or(last_size);
        if total > 0 && size != total {
            return Err(format!(
                "ffmpeg 完成后大小不符：期望 {} 字节，实际 {} 字节",
                total, size
            ));
        }
        ctx.set_progress(size.max(last_size), total.max(size));
        Ok(EngineOutcome::Done)
    }
}

fn build_ffmpeg_headers(task: &crate::types::DownloadTask, config: &EngineConfig) -> String {
    let mut headers = String::new();
    let user_agent = task
        .user_agent
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(config.user_agent.as_str());
    headers.push_str(&format!("User-Agent: {user_agent}\r\n"));
    if let Some(referer) = task.referer.as_deref().filter(|s| !s.is_empty()) {
        headers.push_str(&format!("Referer: {referer}\r\n"));
    }
    if let Some(cookie) = task.cookie.as_deref().filter(|s| !s.is_empty()) {
        headers.push_str(&format!("Cookie: {cookie}\r\n"));
    }
    for (name, value) in &task.headers {
        headers.push_str(&format!("{name}: {value}\r\n"));
    }
    headers
}

fn check_control(ctx: &EngineCtx) -> Option<EngineOutcome> {
    match ctx.control_state() {
        Control::Pause => Some(EngineOutcome::Paused),
        Control::Cancel => Some(EngineOutcome::Canceled),
        Control::Run => None,
    }
}
