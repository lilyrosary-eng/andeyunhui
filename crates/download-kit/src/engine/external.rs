//! 外部 CLI 引擎共用逻辑：等待进程、响应暂停/取消、按输出文件大小回报进度。
//!
//! curl / wget 都没有稳定的机器可读进度流；直接轮询输出文件大小最简单，
//! 也不会因为解析格式变化而失效。

use std::path::Path;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use tokio::io::{AsyncReadExt, BufReader};
use tokio::process::{Child, ChildStderr, Command};

use crate::engine::{EngineCtx, EngineOutcome};
use crate::manager::Control;
use crate::util::tail_text;

pub(crate) enum CliWait {
    Finished(ExitStatus),
    Paused,
    Canceled,
}

/// 每 300ms 检查一次：进程是否退出、是否收到暂停/取消、输出文件增长了多少。
pub(crate) async fn wait_with_progress(
    child: &mut Child,
    save_path: &Path,
    total: u64,
    ctx: &EngineCtx,
) -> Result<CliWait, String> {
    let mut last_size = u64::MAX;
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("查询外部进程状态失败: {e}"))?
        {
            let size = tokio::fs::metadata(save_path)
                .await
                .map(|meta| meta.len())
                .unwrap_or(0);
            ctx.set_progress(size, if total > 0 { total } else { size });
            return Ok(CliWait::Finished(status));
        }

        match ctx.control_state() {
            Control::Pause => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Ok(CliWait::Paused);
            }
            Control::Cancel => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                let _ = tokio::fs::remove_file(save_path).await;
                return Ok(CliWait::Canceled);
            }
            Control::Run => {}
        }

        if let Ok(meta) = tokio::fs::metadata(save_path).await {
            let size = meta.len();
            if size != last_size {
                last_size = size;
                ctx.set_progress(size, if total > 0 { total } else { size });
            }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// 启动外部工具并等待结束；统一处理暂停/取消/失败与最终大小校验。
pub(crate) async fn run_tool(
    mut command: Command,
    tool_name: &str,
    save_path: &Path,
    total: u64,
    ctx: &EngineCtx,
) -> Result<EngineOutcome, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("启动 {tool_name} 失败: {e}"))?;
    let stderr_handle = spawn_stderr_reader(child.stderr.take());

    match wait_with_progress(&mut child, save_path, total, ctx).await? {
        CliWait::Paused => {
            stderr_handle.abort();
            return Ok(EngineOutcome::Paused);
        }
        CliWait::Canceled => {
            stderr_handle.abort();
            return Ok(EngineOutcome::Canceled);
        }
        CliWait::Finished(status) => {
            let stderr_text = stderr_handle.await.unwrap_or_default();
            if !status.success() {
                let tail = tail_text(&stderr_text, 400);
                return Err(if tail.is_empty() {
                    format!("{tool_name} 退出码 {:?}", status.code())
                } else {
                    format!("{tool_name} 失败（退出码 {:?}）：{tail}", status.code())
                });
            }
        }
    }

    let size = tokio::fs::metadata(save_path)
        .await
        .map(|meta| meta.len())
        .unwrap_or(0);
    if total > 0 && size != total {
        return Err(format!(
            "{tool_name} 完成后大小不符：期望 {} 字节，实际 {} 字节",
            total, size
        ));
    }
    ctx.set_progress(size, total.max(size));
    Ok(EngineOutcome::Done)
}

/// 读取子进程 stderr（避免管道写满阻塞子进程）；返回尾部文本用于报错。
pub(crate) fn spawn_stderr_reader(stderr: Option<ChildStderr>) -> tokio::task::JoinHandle<String> {
    tokio::spawn(async move {
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
    })
}
