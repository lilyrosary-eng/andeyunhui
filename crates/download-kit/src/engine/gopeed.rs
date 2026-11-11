//! Gopeed 外部引擎：磁力 / BT / ed2k（P2P）专用。
//!
//! 为什么只做 P2P：HTTP/HTTPS 已由引擎1/2、aria2、curl、wget 覆盖；
//! gopeed 的 CLI 不支持自定义请求头 / Referer，做 HTTP 反而更弱。
//!
//! 许可说明：gopeed 是 GPL-3.0。本 crate 只以**独立进程**方式调用用户自行安装的
//! `gopeed`，不链接、不复制、不随包分发其源码或二进制。

use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncReadExt, BufReader};
use tokio::process::Command;

use crate::engine::{DownloadEngine, EngineCtx, EngineOutcome};
use crate::manager::Control;
use crate::types::{EngineConfig, EngineKind, TaskStatus};
use crate::util::{dir_size, is_p2p_url, parse_human_size, tail_text};

pub struct GopeedEngine {
    config: EngineConfig,
    path: Option<PathBuf>,
}

impl GopeedEngine {
    pub fn new(config: EngineConfig, path: Option<PathBuf>) -> Self {
        Self { config, path }
    }
}

#[async_trait]
impl DownloadEngine for GopeedEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::Gopeed
    }

    fn available(&self) -> Result<(), String> {
        self.path.as_ref().map(|_| ()).ok_or_else(|| {
            "未找到 gopeed：P2P（磁力/BT/ed2k）需要在下载配置中指定路径，或把 gopeed 放入 external-deps / PATH"
                .to_string()
        })
    }

    fn tool_path(&self) -> Option<String> {
        self.path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned())
    }

    async fn run(&self, ctx: EngineCtx) -> Result<EngineOutcome, String> {
        let gopeed = self.path.as_ref().ok_or_else(|| {
            "未找到 gopeed：P2P（磁力/BT/ed2k）需要在下载配置中指定路径，或把 gopeed 放入 external-deps / PATH"
                .to_string()
        })?;
        let task = ctx.task()?;
        if task.urls.len() != 1 || !is_p2p_url(&task.urls[0]) {
            return Err(
                "Gopeed 引擎仅用于磁力 / BT / ed2k 链接；HTTP 请使用其它引擎".to_string(),
            );
        }

        let save_dir = ctx.save_path();
        tokio::fs::create_dir_all(&save_dir)
            .await
            .map_err(|e| format!("创建下载目录失败 {}: {e}", save_dir.display()))?;

        ctx.update_meta(EngineKind::Gopeed, &task.filename, 0)?;
        if let Some(outcome) = check_control(&ctx) {
            return Ok(outcome);
        }
        ctx.transition(TaskStatus::Downloading)?;
        ctx.emit_state();

        let connections = if task.connections == 0 {
            self.config.connections.clamp(1, 32)
        } else {
            task.connections.clamp(1, 32)
        };
        if task.connections == 0 {
            ctx.set_connections(connections)?;
        }
        let mut command = Command::new(gopeed);
        // Go flag 解析遇到第一个位置参数就停止，因此选项必须放在 URL 前面。
        command
            .arg("-C")
            .arg(connections.to_string())
            .arg("-D")
            .arg(&save_dir)
            .arg(&task.urls[0])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if let Some(proxy) = self
            .config
            .proxy
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            // gopeed CLI 没有 --proxy 参数，走通用的代理环境变量。
            command
                .env("http_proxy", proxy)
                .env("https_proxy", proxy)
                .env("all_proxy", proxy)
                .env_remove("no_proxy")
                .env_remove("NO_PROXY");
        }
        #[cfg(windows)]
        {
            command.creation_flags(0x08000000);
        }

        let mut child = command
            .spawn()
            .map_err(|e| format!("启动 gopeed 失败: {e}"))?;
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
        let mut last_total = 0u64;

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
                                let _ = tokio::fs::remove_dir_all(&save_dir).await;
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
                                drain_progress(&mut pending, &ctx, &mut last_downloaded, &mut last_total);
                                if pending.len() > 16 * 1024 {
                                    pending.clear();
                                }
                            }
                        }
                    }
                }
            }
            drain_progress(&mut pending, &ctx, &mut last_downloaded, &mut last_total);
        }

        let status = child
            .wait()
            .await
            .map_err(|e| format!("等待 gopeed 结束失败: {e}"))?;
        let stderr_text = stderr_handle.await.unwrap_or_default();
        if !status.success() {
            let tail = tail_text(&stderr_text, 400);
            return Err(if tail.is_empty() {
                format!("gopeed 退出码 {:?}", status.code())
            } else {
                format!("gopeed 失败（退出码 {:?}）：{tail}", status.code())
            });
        }

        let size = dir_size(&save_dir).max(last_downloaded);
        ctx.set_progress(size, last_total.max(size));
        Ok(EngineOutcome::Done)
    }
}

fn drain_progress(
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
        if let Some((downloaded, total)) = parse_progress_line(&line) {
            *last_downloaded = downloaded;
            *last_total = total;
            ctx.set_progress_speed(downloaded, total, parse_progress_speed(&line).unwrap_or(0.0));
        }
    }
}

/// 从同一进度行提取 `1.2 MiB/s` 的速度。
pub(crate) fn parse_progress_speed(line: &str) -> Option<f64> {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    for (index, token) in tokens.iter().enumerate() {
        let Some(unit) = token.strip_suffix("/s") else {
            continue;
        };
        let candidate = if unit.chars().any(|ch| ch.is_ascii_digit()) {
            unit.to_string()
        } else if index > 0 {
            format!("{}{}", tokens[index - 1], unit)
        } else {
            unit.to_string()
        };
        if let Some(value) = parse_human_size(&candidate) {
            return Some(value as f64);
        }
    }
    None
}

/// 解析 gopeed CLI 的进度行：
/// `downloading... [■■■□□] 45.0%    1.2 MiB/s    10 MiB`
pub(crate) fn parse_progress_line(line: &str) -> Option<(u64, u64)> {
    let line = line.trim();
    let percent_index = line.find('%')?;
    let before = &line[..percent_index];
    let number: String = before
        .chars()
        .rev()
        .take_while(|ch| ch.is_ascii_digit() || *ch == '.')
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let percent: f64 = number.parse().ok()?;
    if !percent.is_finite() || percent < 0.0 {
        return None;
    }

    let tail = &line[percent_index + 1..];
    let tokens: Vec<&str> = tail.split_whitespace().collect();
    if tokens.len() < 2 {
        return None;
    }
    let value = tokens[tokens.len() - 2];
    let unit = tokens[tokens.len() - 1];
    let total = parse_human_size(&format!("{value}{unit}"))?;
    if total == 0 {
        return None;
    }
    let downloaded = ((total as f64) * percent / 100.0).round() as u64;
    Some((downloaded.min(total), total))
}

fn check_control(ctx: &EngineCtx) -> Option<EngineOutcome> {
    match ctx.control_state() {
        Control::Pause => Some(EngineOutcome::Paused),
        Control::Cancel => Some(EngineOutcome::Canceled),
        Control::Run => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_progress_bar() {
        let line = "downloading... [■■■■□□] 45.0%    1.2 MiB/s    10 MiB";
        assert_eq!(parse_progress_line(line), Some((4_718_592, 10_485_760)));
        assert_eq!(parse_progress_speed(line), Some(1_258_291.0));
        assert_eq!(parse_progress_line("saving path: C:/tmp"), None);
        assert_eq!(parse_progress_speed("saving path: C:/tmp"), None);
        assert_eq!(parse_progress_line("downloading... [□□] 0.0% 0 B/s 0 B"), None);
    }

    #[test]
    fn unavailable_without_path() {
        let engine = GopeedEngine::new(EngineConfig::default(), None);
        assert!(engine.available().is_err());
    }
}
