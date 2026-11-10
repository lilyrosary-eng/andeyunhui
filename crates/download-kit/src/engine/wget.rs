//! Wget 外部引擎：单连接 + 断点续传（Unix 环境常见）。
//!
//! 与 cURL 引擎同构：只支持单地址任务；进度按输出文件大小轮询。

use std::path::PathBuf;

use async_trait::async_trait;
use tokio::process::Command;

use crate::engine::{external, DownloadEngine, EngineCtx, EngineOutcome};
use crate::probe::{self, HttpMeta};
use crate::types::{EngineConfig, EngineKind, TaskStatus};

pub struct WgetEngine {
    config: EngineConfig,
    path: Option<PathBuf>,
    client: reqwest::Client,
}

impl WgetEngine {
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
impl DownloadEngine for WgetEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::Wget
    }

    fn available(&self) -> Result<(), String> {
        self.path.as_ref().map(|_| ()).ok_or_else(|| {
            "未找到 wget：请在下载配置中指定路径，或把 wget 放入 external-deps / PATH".to_string()
        })
    }

    fn tool_path(&self) -> Option<String> {
        self.path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned())
    }

    async fn run(&self, ctx: EngineCtx) -> Result<EngineOutcome, String> {
        let wget = self.path.as_ref().ok_or_else(|| {
            "未找到 wget：请在下载配置中指定路径，或把 wget 放入 external-deps / PATH".to_string()
        })?;
        let task = ctx.task()?;
        if task.urls.len() != 1 {
            return Err("Wget 引擎只支持单地址任务；多段任务请使用 auto / native".to_string());
        }
        let save_path = ctx.save_path();
        if let Some(parent) = save_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("创建下载目录失败: {e}"))?;
        }

        let meta = HttpMeta::from_task(&task);
        let probe = match ctx.probe() {
            Some(probe) => probe,
            None => probe::probe(&self.client, &task.urls[0], &meta)
                .await
                .unwrap_or_default(),
        };
        let total = probe.total_bytes.max(task.total_bytes);
        if let Some(max) = task.max_bytes {
            if total > max {
                return Err(format!(
                    "文件过大（{} MB），已超过下载上限",
                    total / 1024 / 1024
                ));
            }
        }
        ctx.update_meta(EngineKind::Wget, &task.filename, total)?;
        if let Some(outcome) = check_control(&ctx) {
            return Ok(outcome);
        }

        let mut partial = tokio::fs::metadata(&save_path)
            .await
            .map(|meta| meta.len())
            .unwrap_or(0);
        if total > 0 && partial >= total {
            ctx.set_progress(partial, total);
            return Ok(EngineOutcome::Done);
        }
        let resume = partial > 0 && probe.accept_ranges;
        if partial > 0 && !resume {
            let _ = tokio::fs::remove_file(&save_path).await;
            partial = 0;
        }

        ctx.transition(TaskStatus::Downloading)?;
        ctx.emit_state();

        let user_agent = task
            .user_agent
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(self.config.user_agent.as_str());
        let mut command = Command::new(wget);
        command
            .arg("--no-verbose")
            .arg("--output-document")
            .arg(&save_path)
            .arg("--user-agent")
            .arg(user_agent)
            .arg("--tries")
            .arg((self.config.retries + 1).to_string())
            .arg("--timeout")
            .arg(self.config.connect_timeout_secs.to_string())
            .arg("--waitretry")
            .arg("1");
        if partial > 0 && resume {
            command.arg("--continue");
        }
        if let Some(referer) = task.referer.as_deref().filter(|s| !s.is_empty()) {
            command.arg("--referer").arg(referer);
        }
        if let Some(cookie) = task.cookie.as_deref().filter(|s| !s.is_empty()) {
            command.arg("--header").arg(format!("Cookie: {cookie}"));
        }
        for (name, value) in &task.headers {
            command.arg("--header").arg(format!("{name}: {value}"));
        }
        command.arg(&task.urls[0]);

        external::run_tool(command, "Wget", &save_path, total, &ctx).await
    }
}

fn check_control(ctx: &EngineCtx) -> Option<EngineOutcome> {
    match ctx.control_state() {
        crate::manager::Control::Pause => Some(EngineOutcome::Paused),
        crate::manager::Control::Cancel => Some(EngineOutcome::Canceled),
        crate::manager::Control::Run => None,
    }
}
