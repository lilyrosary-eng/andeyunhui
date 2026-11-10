//! aria2c 外部引擎。
//!
//! 为什么是外部进程而不是库：aria2 是 GPLv2，随包分发会带来源码提供等义务；
//! 这里只调用用户自己安装的 `aria2c`（配置文件里指定路径，或 external-deps / PATH 自动发现）。
//!
//! 续传依赖 aria2 自己的 `.aria2` 控制文件：暂停时保留，取消时清理。

use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncReadExt, BufReader};
use tokio::process::Command;

use crate::engine::{DownloadEngine, EngineCtx, EngineOutcome};
use crate::manager::Control;
use crate::probe::{self, HttpMeta};
use crate::types::{EngineConfig, EngineKind, TaskStatus};
use crate::util::{parse_aria2_progress, tail_text};

pub struct Aria2Engine {
    config: EngineConfig,
    path: Option<PathBuf>,
    client: reqwest::Client,
}

impl Aria2Engine {
    pub fn new(config: EngineConfig, path: Option<PathBuf>) -> Self {
        let client = probe::build_client(&config).unwrap_or_else(|_| reqwest::Client::new());
        Self {
            config,
            path,
            client,
        }
    }
}

#[async_trait]
impl DownloadEngine for Aria2Engine {
    fn kind(&self) -> EngineKind {
        EngineKind::Aria2
    }

    fn available(&self) -> Result<(), String> {
        self.path
            .as_ref()
            .map(|_| ())
            .ok_or_else(|| {
                "未找到 aria2c：请在下载配置中指定路径，或把 aria2c 放入 external-deps / PATH"
                    .to_string()
            })
    }

    fn tool_path(&self) -> Option<String> {
        self.path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned())
    }

    async fn run(&self, ctx: EngineCtx) -> Result<EngineOutcome, String> {
        let aria2 = self.path.as_ref().ok_or_else(|| {
            "未找到 aria2c：请在下载配置中指定路径，或把 aria2c 放入 external-deps / PATH"
                .to_string()
        })?;
        let task = ctx.task()?;
        if task.urls.len() != 1 {
            return Err("aria2 引擎只支持单地址任务；多段任务请使用 auto / native".to_string());
        }
        if let Some(parent) = std::path::Path::new(&task.save_path).parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("创建下载目录失败: {e}"))?;
        }

        let meta = HttpMeta::from_task(&task);
        let probe = probe::probe(&self.client, &task.urls[0], &meta)
            .await
            .unwrap_or_default();
        let total = if probe.total_bytes > 0 {
            probe.total_bytes
        } else {
            task.total_bytes
        };
        if let Some(max) = task.max_bytes {
            if total > max {
                return Err(format!(
                    "文件过大（{} MB），已超过下载上限",
                    total / 1024 / 1024
                ));
            }
        }
        ctx.update_meta(EngineKind::Aria2, &task.filename, total)?;
        if let Some(outcome) = check_control(&ctx) {
            return Ok(outcome);
        }

        ctx.transition(TaskStatus::Downloading)?;
        ctx.emit_state();

        let save_path = PathBuf::from(&task.save_path);
        let dir = save_path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        let filename = save_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| task.filename.clone());
        let split = task.connections.clamp(1, 16);
        let user_agent = task
            .user_agent
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(self.config.user_agent.as_str());

        let mut command = Command::new(aria2);
        command
            .arg("--no-conf")
            .arg("--dir")
            .arg(&dir)
            .arg("--out")
            .arg(&filename)
            .arg("--continue=true")
            .arg("--allow-overwrite=true")
            .arg("--auto-file-renaming=false")
            .arg("--file-allocation=none")
            .arg("--max-connection-per-server=16")
            .arg("--split")
            .arg(split.to_string())
            .arg("--min-split-size=1M")
            .arg("--summary-interval=1")
            .arg("--console-log-level=warn")
            .arg("--download-result=hide")
            .arg("--user-agent")
            .arg(user_agent);
        if let Some(referer) = task.referer.as_deref().filter(|s| !s.is_empty()) {
            command.arg("--referer").arg(referer);
        }
        if let Some(cookie) = task.cookie.as_deref().filter(|s| !s.is_empty()) {
            command.arg("--header").arg(format!("Cookie: {cookie}"));
        }
        for (name, value) in &task.headers {
            command.arg("--header").arg(format!("{name}: {value}"));
        }
        command
            .arg(&task.urls[0])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            command.creation_flags(0x08000000);
        }

        let mut child = command
            .spawn()
            .map_err(|e| format!("启动 aria2c 失败: {e}"))?;
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
        let mut pending = String::new();
        let mut last_downloaded = 0u64;
        let mut last_total = total;

        if let Some(stdout) = stdout {
            let mut reader = BufReader::new(stdout);
            let mut buffer = [0u8; 8192];
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
                                cleanup_partial(&task.save_path).await;
                                return Ok(EngineOutcome::Canceled);
                            }
                            Control::Run => {}
                        }
                    }
                    read = reader.read(&mut buffer) => {
                        match read {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                pending.push_str(&String::from_utf8_lossy(&buffer[..n]));
                                drain_progress_lines(&mut pending, &ctx, &mut last_downloaded, &mut last_total);
                                if pending.len() > 16 * 1024 {
                                    pending.clear();
                                }
                            }
                        }
                    }
                }
            }
            drain_progress_lines(&mut pending, &ctx, &mut last_downloaded, &mut last_total);
        }

        let status = child
            .wait()
            .await
            .map_err(|e| format!("等待 aria2c 结束失败: {e}"))?;
        let stderr_text = stderr_handle.await.unwrap_or_default();

        if !status.success() {
            let tail = tail_text(&stderr_text, 400);
            return Err(if tail.is_empty() {
                format!("aria2c 退出码 {:?}", status.code())
            } else {
                format!("aria2c 失败（退出码 {:?}）：{tail}", status.code())
            });
        }

        let size = tokio::fs::metadata(&task.save_path)
            .await
            .map(|meta| meta.len())
            .unwrap_or(last_downloaded);
        if last_total > 0 && size != last_total {
            return Err(format!(
                "aria2c 完成后大小不符：期望 {} 字节，实际 {} 字节",
                last_total, size
            ));
        }
        ctx.set_progress(size.max(last_downloaded), last_total.max(size));
        Ok(EngineOutcome::Done)
    }
}

/// 从增量输出里切出完整行（aria2 用 `\r` 刷新进度，不能只按 `\n` 切）。
fn drain_progress_lines(
    pending: &mut String,
    ctx: &EngineCtx,
    last_downloaded: &mut u64,
    last_total: &mut u64,
) {
    loop {
        let Some(position) = pending.find(|c| c == '\r' || c == '\n') else {
            break;
        };
        let line = pending[..position].to_string();
        pending.drain(..=position);
        if let Some((downloaded, total)) = parse_aria2_progress(&line) {
            *last_downloaded = downloaded;
            *last_total = total;
            ctx.set_progress(downloaded, total);
        }
    }
}

async fn cleanup_partial(save_path: &str) {
    let _ = tokio::fs::remove_file(save_path).await;
    let control = format!("{save_path}.aria2");
    let _ = tokio::fs::remove_file(control).await;
}

fn check_control(ctx: &EngineCtx) -> Option<EngineOutcome> {
    match ctx.control_state() {
        Control::Pause => Some(EngineOutcome::Paused),
        Control::Cancel => Some(EngineOutcome::Canceled),
        Control::Run => None,
    }
}
