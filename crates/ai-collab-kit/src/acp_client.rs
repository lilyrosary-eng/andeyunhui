//! 最小 ACP 客户端（stdio / JSON-RPC 2.0）。
//!
//! 目的只有一个：把已导入的 dsh 会话**原地恢复并继续**。
//! 相比 headless 一次性任务，ACP 能拿到 `session/list` / `session/resume`，
//! 并且在 `session/prompt` 期间收到标准 `session/update` 流。
//!
//! 刻意不引入官方 Rust SDK：
//! - 我们只需要 initialize / session.resume / session.prompt / session.close 四个调用；
//! - 顺序调用即可，不需要并发请求路由；
//! - 少一个依赖、少一层版本适配，出错时日志更直接。
//!
//! 安全约束：
//! - 启动时用 `dsh-acp-local.patch.yml` 把 provider/model 固定到本地；
//! - resume 后再校验一次模型配置，确认目录里有本地模型才发 prompt；
//! - 权限请求只自动允许 `allow_once`，其它一律拒绝；
//! - 取消 / 超时直接 kill 子进程。

use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};

use crate::harness::DshConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpUpdateKind {
    Text,
    Thought,
    Tool,
}

#[derive(Debug, Clone)]
pub struct AcpUpdate {
    pub kind: AcpUpdateKind,
    pub text: String,
}

pub struct AcpTurnResult {
    pub session_id: String,
    pub text: String,
    pub stop_reason: String,
    pub created: bool,
}

struct AcpClient {
    child: Child,
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
    next_id: u64,
    stderr: Arc<Mutex<String>>,
}

impl AcpClient {
    async fn spawn(config: &DshConfig, patch: &Path, workspace: &Path) -> Result<Self, String> {
        let mut command = if config.is_script() {
            let mut command = tokio::process::Command::new("node");
            command.arg(&config.bin);
            command
        } else {
            tokio::process::Command::new(&config.bin)
        };
        command
            .arg("--profile")
            .arg("acp")
            .arg("--patch")
            .arg(patch)
            .current_dir(workspace)
            .env("DSH_PERMISSION_MODE", "workspace-write")
            .env("NO_COLOR", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if std::env::var_os("LMSTUDIO_API_KEY").is_none() {
            command.env("LMSTUDIO_API_KEY", "lm-studio");
        }

        let mut child = command
            .spawn()
            .map_err(|e| format!("启动 DeepSeek Harness ACP 失败: {e}"))?;
        let stdin = child.stdin.take().ok_or_else(|| "ACP stdin 不可用".to_string())?;
        let stdout = child.stdout.take().ok_or_else(|| "ACP stdout 不可用".to_string())?;
        let stderr = child.stderr.take();

        let stderr_buf = Arc::new(Mutex::new(String::new()));
        if let Some(stderr) = stderr {
            let buf = stderr_buf.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Ok(mut guard) = buf.lock() {
                        guard.push_str(&line);
                        guard.push('\n');
                        if guard.len() > 8000 {
                            guard.clear();
                        }
                    }
                }
            });
        }

        Ok(Self {
            child,
            stdin,
            reader: BufReader::new(stdout),
            next_id: 1,
            stderr: stderr_buf,
        })
    }

    async fn write_line(&mut self, value: &Value) -> Result<(), String> {
        let line = serde_json::to_string(value).map_err(|e| format!("序列化 ACP 请求失败: {e}"))?;
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("写入 ACP stdin 失败: {e}"))?;
        self.stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("写入 ACP stdin 失败: {e}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("刷新 ACP stdin 失败: {e}"))
    }

    fn stderr_snapshot(&self) -> String {
        self.stderr
            .lock()
            .map(|guard| crate::runtime::clip_text(guard.trim(), 800))
            .unwrap_or_default()
    }

    async fn read_message(&mut self, assignment_id: &str) -> Result<Value, String> {
        loop {
            if crate::runtime::is_cancelled(assignment_id) {
                return Err("任务已取消".to_string());
            }
            let mut line = String::new();
            match tokio::time::timeout(Duration::from_millis(250), self.reader.read_line(&mut line)).await {
                Err(_) => continue,
                Ok(Err(error)) => return Err(format!("读取 ACP 输出失败: {error}")),
                Ok(Ok(0)) => {
                    let stderr = self.stderr_snapshot();
                    return Err(if stderr.is_empty() {
                        "ACP 进程提前退出".to_string()
                    } else {
                        format!("ACP 进程提前退出\n{stderr}")
                    });
                }
                Ok(Ok(_)) => {
                    let text = line.trim();
                    if text.is_empty() {
                        continue;
                    }
                    if let Ok(value) = serde_json::from_str::<Value>(text) {
                        return Ok(value);
                    }
                }
            }
        }
    }

    async fn request<F>(
        &mut self,
        method: &str,
        params: Value,
        assignment_id: &str,
        on_update: &mut F,
    ) -> Result<Value, String>
    where
        F: FnMut(AcpUpdate) + Send,
    {
        let id = self.next_id;
        self.next_id += 1;
        self.write_line(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .await?;

        loop {
            let message = self.read_message(assignment_id).await?;
            match message.get("method").and_then(|value| value.as_str()) {
                None => {
                    if message.get("id").and_then(|value| value.as_u64()) == Some(id) {
                        if let Some(error) = message.get("error") {
                            return Err(format!("ACP {method} 失败: {error}"));
                        }
                        return Ok(message.get("result").cloned().unwrap_or(Value::Null));
                    }
                }
                Some("session/update") => {
                    if let Some(update) = message.pointer("/params/update") {
                        handle_update(update, on_update);
                    }
                }
                Some("session/request_permission") => {
                    let request_id = message.get("id").cloned().unwrap_or(Value::Null);
                    let options = message.pointer("/params/options").and_then(|value| value.as_array());
                    let allow_once = options.and_then(|options| {
                        options
                            .iter()
                            .find(|option| option.get("kind").and_then(|value| value.as_str()) == Some("allow_once"))
                            .and_then(|option| option.get("optionId").and_then(|value| value.as_str()))
                    });
                    let outcome = if let Some(option_id) = allow_once {
                        json!({ "outcome": { "outcome": "selected", "optionId": option_id } })
                    } else {
                        json!({ "outcome": { "outcome": "cancelled" } })
                    };
                    self.write_line(&json!({
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "result": outcome,
                    }))
                    .await?;
                }
                Some(other) => {
                    // 我们没有声明 fs / terminal 能力；遇到未知客户端请求一律拒绝。
                    if let Some(request_id) = message.get("id") {
                        let _ = self
                            .write_line(&json!({
                                "jsonrpc": "2.0",
                                "id": request_id,
                                "error": { "code": -32601, "message": format!("unsupported client method: {other}") },
                            }))
                            .await;
                    }
                }
            }
        }
    }

    async fn initialize<F>(&mut self, assignment_id: &str, on_update: &mut F) -> Result<(), String>
    where
        F: FnMut(AcpUpdate) + Send,
    {
        self.request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false,
                },
            }),
            assignment_id,
            on_update,
        )
        .await?;
        Ok(())
    }

    async fn open_session<F>(
        &mut self,
        resume: Option<&str>,
        workspace: &Path,
        provider: &str,
        model: &str,
        assignment_id: &str,
        on_update: &mut F,
    ) -> Result<(String, bool), String>
    where
        F: FnMut(AcpUpdate) + Send,
    {
        let cwd = workspace.to_string_lossy().to_string();
        let result = if let Some(session_id) = resume {
            self.request(
                "session/resume",
                json!({ "sessionId": session_id, "cwd": cwd, "mcpServers": [] }),
                assignment_id,
                on_update,
            )
            .await?
        } else {
            self.request(
                "session/new",
                json!({ "cwd": cwd, "mcpServers": [] }),
                assignment_id,
                on_update,
            )
            .await?
        };
        let session_id = result
            .get("sessionId")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
            .or_else(|| resume.map(|value| value.to_string()))
            .ok_or_else(|| "ACP session/new 未返回 sessionId".to_string())?;

        let options = result.get("configOptions").cloned().unwrap_or(Value::Null);
        self.ensure_local_model(&session_id, &options, provider, model, assignment_id, on_update)
            .await?;
        Ok((session_id, resume.is_none()))
    }

    /// 关键安全闸：resume 可能带回旧会话里的云端模型；这里核对模型目录，
    /// 找不到本地模型就拒绝发 prompt，交给上层回退到 headless（本地进程）。
    async fn ensure_local_model<F>(
        &mut self,
        session_id: &str,
        options: &Value,
        provider: &str,
        model: &str,
        assignment_id: &str,
        on_update: &mut F,
    ) -> Result<(), String>
    where
        F: FnMut(AcpUpdate) + Send,
    {
        let target = json!([provider, model]).to_string();
        let Some(option) = options
            .as_array()
            .and_then(|items| {
                items.iter().find(|item| {
                    item.get("id").and_then(|value| value.as_str()) == Some("model")
                })
            })
        else {
            return Err("ACP 未提供模型配置，无法确认走本地模型；已拒绝继续".to_string());
        };
        if option.get("currentValue").and_then(|value| value.as_str()) == Some(target.as_str()) {
            return Ok(());
        }
        if !model_option_has(option, &target) {
            return Err(format!(
                "ACP 模型目录没有本地模型 {provider}/{model}；已拒绝继续，避免走云端"
            ));
        }
        self.request(
            "session/set_config_option",
            json!({ "sessionId": session_id, "configId": "model", "value": target }),
            assignment_id,
            on_update,
        )
        .await?;
        Ok(())
    }

    async fn prompt<F>(
        &mut self,
        session_id: &str,
        prompt: &str,
        assignment_id: &str,
        on_update: &mut F,
    ) -> Result<(String, String), String>
    where
        F: FnMut(AcpUpdate) + Send,
    {
        let mut text = String::new();
        let mut callback = |update: AcpUpdate| {
            if update.kind == AcpUpdateKind::Text {
                text.push_str(&update.text);
            }
            on_update(update);
        };
        let result = self
            .request(
                "session/prompt",
                json!({
                    "sessionId": session_id,
                    "prompt": [{ "type": "text", "text": prompt }],
                }),
                assignment_id,
                &mut callback,
            )
            .await?;
        // callback 持有 text 的可变借用；先释放再读取累计文本。
        drop(callback);
        let stop_reason = result
            .get("stopReason")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown")
            .to_string();
        Ok((text, stop_reason))
    }

    async fn close(&mut self, session_id: &str) {
        let _ = self
            .request(
                "session/close",
                json!({ "sessionId": session_id }),
                "close",
                &mut |_| {},
            )
            .await;
        let _ = self.child.kill().await;
    }
}

fn model_option_has(option: &Value, target: &str) -> bool {
    let Some(groups) = option.get("options").and_then(|value| value.as_array()) else {
        return false;
    };
    for group in groups {
        let Some(items) = group.get("options").and_then(|value| value.as_array()) else {
            continue;
        };
        for item in items {
            if item.get("value").and_then(|value| value.as_str()) == Some(target) {
                return true;
            }
        }
    }
    false
}

fn extract_text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    if let Some(text) = value.get("text").and_then(|item| item.as_str()) {
        return Some(text.to_string());
    }
    if let Some(items) = value.as_array() {
        let mut out = String::new();
        for item in items {
            if let Some(text) = extract_text(item) {
                out.push_str(&text);
            }
        }
        return Some(out);
    }
    None
}

fn handle_update<F>(update: &Value, on_update: &mut F)
where
    F: FnMut(AcpUpdate),
{
    let kind = update.get("sessionUpdate").and_then(|value| value.as_str()).unwrap_or("");
    match kind {
        "agent_message_chunk" => {
            if let Some(text) = update.get("content").and_then(extract_text) {
                on_update(AcpUpdate { kind: AcpUpdateKind::Text, text });
            }
        }
        "agent_thought_chunk" => {
            if let Some(text) = update.get("content").and_then(extract_text) {
                on_update(AcpUpdate { kind: AcpUpdateKind::Thought, text });
            }
        }
        "tool_call" | "tool_call_update" => {
            let title = update.get("title").and_then(|value| value.as_str()).unwrap_or("工具");
            let status = update.get("status").and_then(|value| value.as_str()).unwrap_or("");
            on_update(AcpUpdate {
                kind: AcpUpdateKind::Tool,
                text: format!("{title} {status}").trim().to_string(),
            });
        }
        _ => {}
    }
}

/// 恢复（或新建）一个 ACP 会话并提交一条 prompt。
/// `resume_session` 为 Some 时优先原位恢复；失败由上层决定是否回退 headless。
#[allow(clippy::too_many_arguments)]
pub async fn run_turn<F>(
    config: &DshConfig,
    patch: &Path,
    workspace: &Path,
    prompt: &str,
    assignment_id: &str,
    resume_session: Option<&str>,
    provider: &str,
    model: &str,
    mut on_update: F,
) -> Result<AcpTurnResult, String>
where
    F: FnMut(AcpUpdate) + Send,
{
    let mut client = AcpClient::spawn(config, patch, workspace).await?;
    let inner = async {
        client.initialize(assignment_id, &mut on_update).await?;
        let (session_id, created) = client
            .open_session(resume_session, workspace, provider, model, assignment_id, &mut on_update)
            .await?;
        let (text, stop_reason) = client
            .prompt(&session_id, prompt, assignment_id, &mut on_update)
            .await?;
        client.close(&session_id).await;
        Ok(AcpTurnResult { session_id, text, stop_reason, created })
    };
    match tokio::time::timeout(Duration::from_secs(config.timeout_secs.max(10)), inner).await {
        Err(_) => Err(format!("ACP 接管超时（{}s）", config.timeout_secs.max(10))),
        Ok(result) => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::{self, DshConfig, DEFAULT_MODEL, DEFAULT_PROVIDER};

    /// 本地实跑（需要 LM Studio + dsh CLI，默认忽略）：
    /// `cargo test -p ai-collab-kit acp_resume_smoke -- --ignored --nocapture`
    ///
    /// 先用 headless 建一个本地会话并记住 42，再用 ACP resume 追问；能答出 42 才说明
    /// 「原位恢复旧会话」真的生效，而不是新建会话或走云端。
    #[tokio::test]
    #[ignore]
    async fn acp_resume_smoke() {
        let bin = harness::detect_bin().expect("dsh bin.js not found; set ANDY_DSH_BIN");
        let config = DshConfig {
            bin: bin.to_string_lossy().to_string(),
            provider: DEFAULT_PROVIDER.to_string(),
            model: DEFAULT_MODEL.to_string(),
            timeout_secs: 180,
            ..Default::default()
        };
        let dir = std::env::temp_dir().join(format!(
            "ai-collab-acp-smoke-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let headless_patch = harness::ensure_patch(&dir, &config).unwrap();
        let first = harness::dsh_run_turn(
            &config,
            &headless_patch,
            &dir,
            "请记住这个数字：42。只回答「已记住」。",
            "acp-smoke-first",
        )
        .await
        .expect("headless seed failed");
        println!("headless seed: {:?}", first.stdout);

        let sessions = crate::dsh_sessions::list_sessions().expect("list sessions failed");
        let target = sessions
            .iter()
            .find(|session| session.cwd.to_lowercase() == dir.to_string_lossy().to_lowercase())
            .expect("seed session not found");
        println!("resume session: {} ({})", target.id, target.title);

        let acp_patch = harness::ensure_acp_patch(&dir, &config).unwrap();
        let result = run_turn(
            &config,
            &acp_patch,
            &dir,
            "刚才让你记住的数字是多少？只回答数字。",
            "acp-smoke-resume",
            Some(&target.id),
            &config.provider,
            &config.model,
            |_| {},
        )
        .await
        .expect("ACP resume failed");
        println!(
            "acp resume: session={} created={} stop={} text={:?}",
            result.session_id, result.created, result.stop_reason, result.text
        );
        assert!(result.text.contains("42") || result.text.contains("四十二"), "resume did not keep context: {:?}", result.text);

        let created = run_turn(
            &config,
            &acp_patch,
            &dir,
            "2+3 等于几？只回答数字。",
            "acp-smoke-new",
            None,
            &config.provider,
            &config.model,
            |_| {},
        )
        .await
        .expect("ACP session/new failed");
        println!(
            "acp new: session={} created={} stop={} text={:?}",
            created.session_id, created.created, created.stop_reason, created.text
        );
        assert!(created.created, "session/new should report created=true");
        assert!(created.text.contains('5'), "new session answer unexpected: {:?}", created.text);
        let _ = std::fs::remove_dir_all(dir);
    }
}
