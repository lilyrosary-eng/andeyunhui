//! harness 适配层。
//!
//! P0 只有本地 Echo；P1 增加 DeepSeek Harness（`dsh --profile headless`）。
//! 其他 ACP / stream-json / .Talk 仍保持占位，后续按同一接口接入。
//!
//! ## DeepSeek Harness 为什么用 headless，而不是 ACP
//! `dsh --profile headless "job"` 是一个干净的一次性任务入口：stdout 只放最终答案，
//! stderr 放 reasoning / 日志，退出码表达成败。它足以验证「任务分派 → 本地模型执行
//! → 结果回传」的闭环，且不需要引入 ACP 客户端依赖。P2 再换 ACP 以获得流式更新与权限桥接。
//!
//! ## 本地模型
//! 用户的 dsh 设置里已有 `lmstudio` provider。本项目**不读也不改用户全局设置**，
//! 而是在 `ai-collab/dsh-local.patch.yml` 生成一个只作用于本适配器的 patch：
//! - 固定 provider/model 到本地 LM Studio；
//! - 禁用云端 deepseek-official 路由，避免误用云端额度；
//! - 权限固定为 workspace-write：只允许在专属工作目录内读写，不放开 danger-full-access。
//! 模型与 provider 可用环境变量 `ANDY_DSH_PROVIDER` / `ANDY_DSH_MODEL` 覆盖。

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::types::HarnessInfo;

pub const ECHO: &str = "echo";
pub const DSH: &str = "dsh";
/// 外部 harness（Trae / WorkBuddy）通过 `ai-collab-mcp` 参与：
/// 任务只入队，不自动执行，等外部认领。
pub const MCP: &str = "mcp";
pub const ACP: &str = "acp";
pub const STREAM_JSON: &str = "stream-json";
pub const MAILBOX: &str = "mailbox";

const DSH_CONFIG_FILE: &str = "dsh.json";
const DSH_PATCH_FILE: &str = "dsh-local.patch.yml";
const ACP_PATCH_FILE: &str = "dsh-acp-local.patch.yml";
pub(crate) const DEFAULT_PROVIDER: &str = "lmstudio";
pub(crate) const DEFAULT_MODEL: &str = "deepseek-v4-pro-qwen3.5-4b-i1";
const DEFAULT_TIMEOUT_SECS: u64 = 180;

pub trait HarnessAdapter: Send + Sync {
    fn info(&self) -> HarnessInfo;
}

pub struct EchoHarness;

impl HarnessAdapter for EchoHarness {
    fn info(&self) -> HarnessInfo {
        HarnessInfo {
            id: ECHO.to_string(),
            name: "本地模拟（Echo）".to_string(),
            kind: ECHO.to_string(),
            available: true,
            detail: "P0 技术验证用：不拉起外部进程，验证任务分派、事件流与 UI 闭环。".to_string(),
        }
    }
}

/// DeepSeek Harness 的运行配置。落盘到 `<app_data>/ai-collab/dsh.json`，用户可直接编辑。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshConfig {
    /// `bin.js` 的绝对路径，或 PATH 上的可执行命令名。
    #[serde(default)]
    pub bin: String,
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
    /// 本地 OpenAI 兼容端点；默认 LM Studio。
    #[serde(default = "default_base_url")]
    pub base_url: String,
    /// openai-completions / openai-responses 等 pi-ai api 名称。
    #[serde(default = "default_api")]
    pub api: String,
}

fn default_provider() -> String {
    DEFAULT_PROVIDER.to_string()
}
fn default_model() -> String {
    DEFAULT_MODEL.to_string()
}
fn default_timeout() -> u64 {
    DEFAULT_TIMEOUT_SECS
}
fn default_base_url() -> String {
    "http://127.0.0.1:1234/v1".to_string()
}
fn default_api() -> String {
    "openai-completions".to_string()
}

impl Default for DshConfig {
    fn default() -> Self {
        Self {
            bin: detect_bin().unwrap_or_default().to_string_lossy().to_string(),
            provider: default_provider(),
            model: default_model(),
            timeout_secs: default_timeout(),
            base_url: default_base_url(),
            api: default_api(),
        }
    }
}

impl DshConfig {
    pub(crate) fn is_script(&self) -> bool {
        self.bin.ends_with(".js") || self.bin.ends_with(".mjs") || self.bin.ends_with(".cjs")
    }
}

/// 常见安装位置（本机已知路径 + 用户桌面），只做兜底；正式值应写进 `dsh.json`。
pub(crate) fn detect_bin() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(home) = env::var("USERPROFILE") {
        candidates.push(PathBuf::from(&home).join("Desktop/deepseek_desktop/harness/apps/cli/lib/bin.js"));
        candidates.push(PathBuf::from(&home).join("deepseek_desktop/harness/apps/cli/lib/bin.js"));
    }
    candidates.push(PathBuf::from("D:/Desktop/deepseek_desktop/harness/apps/cli/lib/bin.js"));
    candidates.into_iter().find(|path| path.exists())
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::store::base_dir(app)?.join(DSH_CONFIG_FILE))
}

pub fn patch_path(base: &Path) -> PathBuf {
    base.join(DSH_PATCH_FILE)
}

pub fn acp_patch_path(base: &Path) -> PathBuf {
    base.join(ACP_PATCH_FILE)
}

fn write_atomic(path: &Path, body: &str) -> Result<(), String> {
    let tmp = path.with_file_name(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("dsh"),
        std::process::id()
    ));
    fs::write(&tmp, body).map_err(|e| format!("写临时文件失败 {}: {e}", tmp.display()))?;
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&tmp, path).map_err(|e| format!("替换文件失败 {}: {e}", path.display()))
}

/// 把本地 provider/model 写进只作用于本适配器的 patch。
/// 每次 resolve 都重写，保证 `dsh.json` 改动立即生效；用户若想自定义可改这里的生成规则。
/// dsh 的 CLI profile 可能没有挂载 settings 服务，导致 llm-pi-ai 拿不到全局 provider 配置；
/// 这里把本地 provider 显式写进 patch，保证 ACP/headless 两条路径都能解析到本地模型。
fn provider_patch(config: &DshConfig) -> String {
    let provider = config.provider.trim();
    let model = config.model.trim();
    let base_url = config.base_url.trim();
    let api = config.api.trim();
    let api_key = if provider.eq_ignore_ascii_case("lmstudio") {
        "        apiKeyEnv: LMSTUDIO_API_KEY\n"
    } else {
        ""
    };
    format!(
r#"- id: llm-pi-ai
  config:
    providers:
      {provider}:
        displayName: {provider}
{api_key}        api: {api}
        baseURL: {base_url}
        models:
          - id: {model}
            name: {model}
            contextWindow: 128000
            maxTokens: 32000

"#
    )
}

pub fn ensure_patch(base: &Path, config: &DshConfig) -> Result<PathBuf, String> {
    let patch = patch_path(base);
    let mut body = String::from(
        "# 由 ai-collab-kit 生成：只作用于本适配器，固定本地模型并禁用云端 DeepSeek 路由。\n",
    );
    body.push_str(&format!(
        "- id: agent-default-model\n  config:\n    provider: {}\n    model: {}\n\n",
        config.provider.trim(),
        config.model.trim()
    ));
    body.push_str(&provider_patch(config));
    body.push_str(
        "- id: permission\n  config:\n    defaultPreset: workspace-write\n\n\
         - id: llm-deepseek\n  disabled: true\n\n\
         - id: llm-deepseek-account\n  disabled: true\n\n\
         - id: session-title-llm\n  disabled: true\n",
    );
    write_atomic(&patch, &body)?;
    Ok(patch)
}

/// ACP profile 需要同时覆盖 `acp` 与 `agent-default-model` 两处路由；
/// 否则 resume 会沿用旧会话里的云端 provider，违背「只用本地模型」的前提。
pub fn ensure_acp_patch(base: &Path, config: &DshConfig) -> Result<PathBuf, String> {
    let patch = acp_patch_path(base);
    let mut body = String::from(
        "# 由 ai-collab-kit 生成：ACP 只走本地模型，并禁用云端 DeepSeek 路由。\n",
    );
    body.push_str(&format!(
        "- id: acp\n  config:\n    provider: {}\n    model: {}\n\n\
         - id: agent-default-model\n  config:\n    provider: {}\n    model: {}\n\n",
        config.provider.trim(),
        config.model.trim(),
        config.provider.trim(),
        config.model.trim()
    ));
    body.push_str(&provider_patch(config));
    body.push_str(
        "- id: permission\n  config:\n    defaultPreset: workspace-write\n\n\
         - id: llm-deepseek\n  disabled: true\n\n\
         - id: llm-deepseek-account\n  disabled: true\n\n\
         - id: session-title-llm\n  disabled: true\n",
    );
    write_atomic(&patch, &body)?;
    Ok(patch)
}

/// 读取 / 初始化 dsh 配置，并校验 bin 是否存在。
pub fn resolve_dsh(app: &AppHandle) -> Result<DshConfig, String> {
    let base = crate::store::base_dir(app)?;
    let path = config_path(app)?;
    let mut config = if path.exists() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<DshConfig>(&s).ok())
            .unwrap_or_default()
    } else {
        let default = DshConfig::default();
        if let Ok(body) = serde_json::to_string_pretty(&default) {
            let _ = write_atomic(&path, &body);
        }
        default
    };

    if let Ok(value) = env::var("ANDY_DSH_BIN") {
        if !value.trim().is_empty() {
            config.bin = value;
        }
    }
    if let Ok(value) = env::var("ANDY_DSH_PROVIDER") {
        if !value.trim().is_empty() {
            config.provider = value;
        }
    }
    if let Ok(value) = env::var("ANDY_DSH_MODEL") {
        if !value.trim().is_empty() {
            config.model = value;
        }
    }

    // 首次运行时若没找到 CLI，配置里会留空；后续用户移动/安装后应能自动重新探测。
    if config.bin.trim().is_empty() {
        if let Some(found) = detect_bin() {
            config.bin = found.to_string_lossy().to_string();
        }
    }
    if config.bin.trim().is_empty() {
        return Err(format!(
            "未找到 DeepSeek Harness CLI。请设置环境变量 ANDY_DSH_BIN，或编辑 {}",
            path.display()
        ));
    }
    // 绝对/相对路径必须存在；裸命令名交给 PATH。
    let bin = PathBuf::from(config.bin.trim());
    if (config.bin.contains('/') || config.bin.contains('\\')) && !bin.exists() {
        return Err(format!("DeepSeek Harness CLI 不存在: {}", bin.display()));
    }

    ensure_patch(&base, &config)?;
    ensure_acp_patch(&base, &config)?;
    Ok(config)
}

/// harness 目录。DeepSeek 的可用性取决于本机 CLI 是否可定位，不影响 Echo 房间。
pub fn catalog(app: &AppHandle) -> Vec<HarnessInfo> {
    let dsh = resolve_dsh(app);
    let base = crate::store::base_dir(app).ok();
    let (stream_available, stream_detail) = match base.as_deref() {
        Some(base) => match resolve_stream_json(base) {
            Ok(config) => (
                true,
                format!(
                    "P3：命令 {}；promptMode {}；配置 {}",
                    config.command,
                    config.prompt_mode,
                    stream_json_config_path(base).display()
                ),
            ),
            Err(error) => (false, format!("P3：{error}")),
        },
        None => (false, "P3：无法定位协作数据目录".to_string()),
    };
    let (available, detail) = match &dsh {
        Ok(config) => (
            true,
            format!(
                "P2：本地 headless + ACP。导入会话优先 ACP session/resume 原位恢复，失败回退 headless；模型 {} / {}，CLI {}",
                config.provider, config.model, config.bin
            ),
        ),
        Err(error) => (false, format!("P2：DeepSeek Harness 不可用 —— {error}")),
    };

    vec![
        EchoHarness.info(),
        HarnessInfo {
            id: DSH.to_string(),
            name: "DeepSeek Harness（本地）".to_string(),
            kind: "headless".to_string(),
            available,
            detail,
        },
        HarnessInfo {
            id: MCP.to_string(),
            name: "MCP 外部 harness".to_string(),
            kind: MCP.to_string(),
            available: true,
            detail: "任务只入队，由外部 harness（Trae / WorkBuddy）通过 ai-collab-mcp 认领并回报结果。".to_string(),
        },
        HarnessInfo {
            id: ACP.to_string(),
            name: "ACP CLI".to_string(),
            kind: ACP.to_string(),
            available: false,
            detail: "P2：通过 Agent Client Protocol 获得流式更新与权限桥接。".to_string(),
        },
        HarnessInfo {
            id: STREAM_JSON.to_string(),
            name: "通用 CLI（stream-json）".to_string(),
            kind: STREAM_JSON.to_string(),
            available: stream_available,
            detail: stream_detail,
        },
        HarnessInfo {
            id: MAILBOX.to_string(),
            name: ".Talk 信箱".to_string(),
            kind: MAILBOX.to_string(),
            available: false,
            detail: "P3：复用项目 `.Talk` 文件通道，适配只能开 IDE 的 harness 与人工协作者。".to_string(),
        },
    ]
}

/// headless 一次运行的原始结果。
pub struct DshOutcome {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

/// 运行一次 DeepSeek Harness headless 任务。
///
/// 关键点：
/// - `kill_on_drop(true)`：超时或取消时 drop future 即杀进程；
/// - 每 250ms 轮询取消标记，取消后返回「任务已取消」，由上层决定是否补发事件；
/// - 只看 stdout 作为最终答案，stderr 只作为失败诊断；
/// - 权限固定 workspace-write，写入被限制在专属工作目录内。
pub async fn dsh_run_turn(
    config: &DshConfig,
    patch: &Path,
    workspace: &Path,
    prompt: &str,
    assignment_id: &str,
) -> Result<DshOutcome, String> {
    fs::create_dir_all(workspace)
        .map_err(|e| format!("创建 Harness 工作目录失败 {}: {e}", workspace.display()))?;

    let mut command = if config.is_script() {
        let mut command = tokio::process::Command::new("node");
        command.arg(&config.bin);
        command
    } else {
        tokio::process::Command::new(&config.bin)
    };
    command
        .arg("--profile")
        .arg("headless")
        .arg("--patch")
        .arg(patch)
        .arg(prompt)
        .current_dir(workspace)
        // workspace-write：写入只发生在专属工作目录内；不放开 danger-full-access。
        .env("DSH_PERMISSION_MODE", "workspace-write")
        .env("NO_COLOR", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if env::var_os("LMSTUDIO_API_KEY").is_none() {
        // LM Studio 本地端点不校验真实密钥；给一个占位值即可，绝不触网。
        command.env("LMSTUDIO_API_KEY", "lm-studio");
    }

    let child = command
        .spawn()
        .map_err(|e| format!("启动 DeepSeek Harness 失败: {e}"))?;
    let wait = child.wait_with_output();
    let cancel = async {
        loop {
            if crate::runtime::is_cancelled(assignment_id) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    };

    let output = tokio::select! {
        _ = cancel => return Err("任务已取消".to_string()),
        result = tokio::time::timeout(Duration::from_secs(config.timeout_secs.max(10)), wait) => {
            match result {
                Err(_) => return Err(format!("DeepSeek Harness 超时（{}s）", config.timeout_secs.max(10))),
                Ok(Err(error)) => return Err(format!("等待 DeepSeek Harness 失败: {error}")),
                Ok(Ok(output)) => output,
            }
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let detail = if stderr.is_empty() { stdout.clone() } else { stderr.clone() };
        return Err(format!(
            "DeepSeek Harness 退出码 {:?}: {}",
            output.status.code(),
            crate::runtime::clip_text(&detail, 800)
        ));
    }

    Ok(DshOutcome {
        stdout,
        stderr,
        exit_code: output.status.code(),
    })
}

// ========== stream-json 通用 CLI（P3）==========
//
// 适配「一次任务、stdout 按行输出 JSON」的 harness（Claude Code / Trae CLI 等）。
// 不做协议级适配，只做两件事：把 prompt 交给进程、把 stdout 里的文本抽出来。
// 配置落在 `<base>/stream-json.json`，首次访问自动写模板（command 为空 = 未接入）。

const STREAM_JSON_CONFIG_FILE: &str = "stream-json.json";
/// 流式累计的答案上限，避免把整段输出无限堆在内存里。
const MAX_STREAM_TEXT: usize = 20_000;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamJsonConfig {
    /// 可执行文件或命令名；空表示未配置。
    #[serde(default)]
    pub command: String,
    /// 参数模板：含 `{prompt}` 时原位替换，否则按 promptMode 处理。
    #[serde(default)]
    pub args: Vec<String>,
    /// `arg`：prompt 作为最后一个参数；`stdin`：prompt 写入 stdin。
    #[serde(default = "default_prompt_mode")]
    pub prompt_mode: String,
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
}

fn default_prompt_mode() -> String {
    "arg".to_string()
}

/// 配置文件路径（catalog 与错误信息里直接展示，用户照着改）。
pub fn stream_json_config_path(base: &Path) -> PathBuf {
    base.join(STREAM_JSON_CONFIG_FILE)
}

/// 读取 stream-json 配置；缺文件时写模板。可用环境变量 `ANDY_STREAM_JSON_CMD` 临时覆盖命令。
pub fn resolve_stream_json(base: &Path) -> Result<StreamJsonConfig, String> {
    let path = stream_json_config_path(base);
    let mut config = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<StreamJsonConfig>(&text).ok())
        .unwrap_or_else(|| {
            let template = StreamJsonConfig {
                command: String::new(),
                args: vec![
                    "--output-format".to_string(),
                    "stream-json".to_string(),
                    "{prompt}".to_string(),
                ],
                prompt_mode: default_prompt_mode(),
                env: std::collections::HashMap::new(),
                timeout_secs: DEFAULT_TIMEOUT_SECS,
            };
            let body = serde_json::to_vec_pretty(&template).unwrap_or_default();
            let _ = fs::write(&path, body);
            template
        });

    if let Ok(command) = env::var("ANDY_STREAM_JSON_CMD") {
        let command = command.trim();
        if !command.is_empty() {
            config.command = command.to_string();
        }
    }
    if config.command.trim().is_empty() {
        return Err(format!(
            "未配置 stream-json 命令：请编辑 {}（command / args / promptMode）",
            path.display()
        ));
    }
    Ok(config)
}

pub struct StreamJsonOutcome {
    pub text: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    /// 调用方主动取消（进程已被杀掉），上层不要再补 failed。
    pub cancelled: bool,
}

/// stdout 里抽出来的一段内容：`Text` 是流式增量，`Final` 是显式最终结果。
#[derive(Debug, PartialEq)]
enum StreamPiece {
    Text(String),
    Final(String),
}

fn parse_stream_line(line: &str) -> Option<StreamPiece> {
    let trimmed = line.trim();
    if trimmed.is_empty() || !trimmed.starts_with('{') {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    // 显式结果优先：`{"type":"result","result":"..."}` 这类终止事件。
    if let Some(text) = value.get("result").and_then(|item| item.as_str()) {
        let text = text.trim();
        if !text.is_empty() {
            return Some(StreamPiece::Final(text.to_string()));
        }
    }
    let text = text_from_json(&value)?;
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    Some(StreamPiece::Text(text.to_string()))
}

/// 从任一层级里找文本：兼容 text / delta / content / message.content / 数组。
fn text_from_json(value: &serde_json::Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    if let Some(items) = value.as_array() {
        let joined: String = items.iter().filter_map(text_from_json).collect();
        return if joined.is_empty() { None } else { Some(joined) };
    }
    let object = value.as_object()?;
    for key in ["text", "delta", "content", "output_text"] {
        if let Some(inner) = object.get(key) {
            if let Some(text) = text_from_json(inner) {
                return Some(text);
            }
        }
    }
    object.get("message").and_then(text_from_json)
}

/// 运行一次 stream-json 任务：边读边回调文本，结束时返回最终答案与诊断。
pub async fn run_stream_json_turn(
    config: &StreamJsonConfig,
    workspace: &Path,
    prompt: &str,
    assignment_id: &str,
    mut on_text: impl FnMut(&str),
) -> Result<StreamJsonOutcome, String> {
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

    fs::create_dir_all(workspace)
        .map_err(|e| format!("创建 Harness 工作目录失败 {}: {e}", workspace.display()))?;

    let mut args: Vec<String> = config
        .args
        .iter()
        .map(|arg| arg.replace("{prompt}", prompt))
        .collect();
    let has_placeholder = config.args.iter().any(|arg| arg.contains("{prompt}"));
    let use_stdin = config.prompt_mode.eq_ignore_ascii_case("stdin") && !has_placeholder;
    if !has_placeholder && !use_stdin {
        args.push(prompt.to_string());
    }

    let mut command = tokio::process::Command::new(&config.command);
    command
        .args(&args)
        .current_dir(workspace)
        .stdin(if use_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NO_COLOR", "1")
        .kill_on_drop(true);
    for (key, value) in &config.env {
        command.env(key, value);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("启动 stream-json harness 失败（{}）: {e}", config.command))?;
    if use_stdin {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(prompt.as_bytes()).await;
            let _ = stdin.flush().await;
            drop(stdin);
        }
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取 stream-json stdout".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法读取 stream-json stderr".to_string())?;
    let stderr_task = tokio::spawn(async move {
        let mut buffer = Vec::new();
        let _ = stderr.read_to_end(&mut buffer).await;
        buffer
    });

    let mut streamed = String::new();
    let mut final_text: Option<String> = None;
    let mut cancelled = false;
    let mut lines = tokio::io::BufReader::new(stdout).lines();
    let timeout = Duration::from_secs(config.timeout_secs.max(10));

    let read_stream = async {
        loop {
            if crate::runtime::is_cancelled(assignment_id) {
                cancelled = true;
                return Ok::<(), String>(());
            }
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let Some(piece) = parse_stream_line(&line) else {
                        continue;
                    };
                    match piece {
                        StreamPiece::Text(text) => {
                            on_text(&text);
                            if streamed.len() < MAX_STREAM_TEXT {
                                streamed.push_str(&text);
                            }
                        }
                        StreamPiece::Final(text) => {
                            on_text(&text);
                            final_text = Some(text);
                        }
                    }
                }
                Ok(None) => return Ok(()),
                Err(error) => return Err(format!("读取 stream-json stdout 失败: {error}")),
            }
        }
    };

    match tokio::time::timeout(timeout, read_stream).await {
        Err(_) => {
            let _ = child.kill().await;
            return Err(format!("stream-json 超时（{}s）", timeout.as_secs()));
        }
        Ok(Err(error)) => {
            let _ = child.kill().await;
            return Err(error);
        }
        Ok(Ok(())) => {}
    }
    if cancelled {
        let _ = child.kill().await;
    }
    let status = child.wait().await.ok();
    let stderr_bytes = stderr_task.await.unwrap_or_default();

    Ok(StreamJsonOutcome {
        text: final_text.unwrap_or(streamed).trim().to_string(),
        stderr: String::from_utf8_lossy(&stderr_bytes).trim().to_string(),
        exit_code: status.as_ref().and_then(|status| status.code()),
        cancelled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_patch_is_local_only() {
        let dir = std::env::temp_dir().join(format!(
            "ai-collab-dsh-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let config = DshConfig {
            bin: String::new(),
            provider: DEFAULT_PROVIDER.to_string(),
            model: DEFAULT_MODEL.to_string(),
            timeout_secs: 10,
            ..Default::default()
        };
        let patch = ensure_patch(&dir, &config).unwrap();
        let body = fs::read_to_string(&patch).unwrap();
        assert!(body.contains("provider: lmstudio"));
        assert!(body.contains("defaultPreset: workspace-write"));
        assert!(body.contains("id: llm-deepseek\n  disabled: true"));
        let acp = ensure_acp_patch(&dir, &config).unwrap();
        let acp_body = fs::read_to_string(&acp).unwrap();
        assert!(acp_body.contains("id: acp"));
        assert!(acp_body.contains("id: agent-default-model"));
        assert!(acp_body.contains("provider: lmstudio"));
        let _ = fs::remove_dir_all(dir);
    }

    /// 本地实跑（需要 LM Studio + dsh CLI，默认忽略）：
    /// `cargo test -p ai-collab-kit dsh_local_smoke -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn dsh_local_smoke() {
        let bin = detect_bin().expect("dsh bin.js not found; set ANDY_DSH_BIN");
        let config = DshConfig {
            bin: bin.to_string_lossy().to_string(),
            provider: DEFAULT_PROVIDER.to_string(),
            model: DEFAULT_MODEL.to_string(),
            timeout_secs: 180,
            ..Default::default()
        };
        let dir = std::env::temp_dir().join(format!(
            "ai-collab-dsh-smoke-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let patch = ensure_patch(&dir, &config).unwrap();
        let outcome = dsh_run_turn(
            &config,
            &patch,
            &dir,
            "用一句中文回答：2+2 等于几？只回答结果。",
            "smoke",
        )
        .await
        .expect("dsh headless run failed");
        println!("stdout={:?}\nstderr={:?}", outcome.stdout, outcome.stderr);
        assert!(!outcome.stdout.trim().is_empty(), "empty stdout from dsh");
        let _ = fs::remove_dir_all(dir);
    }

    /// 常见 stream-json 事件形状（Claude Code / 通用 CLI）都要能抽出文本。
    #[test]
    fn stream_json_extracts_common_event_shapes() {
        let assistant =
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"你好"}]}}"#;
        assert_eq!(
            parse_stream_line(assistant),
            Some(StreamPiece::Text("你好".to_string()))
        );

        let delta =
            r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"世界"}}"#;
        assert_eq!(
            parse_stream_line(delta),
            Some(StreamPiece::Text("世界".to_string()))
        );

        // 显式结果优先于流式文本
        let result = r#"{"type":"result","result":"最终答案"}"#;
        assert_eq!(
            parse_stream_line(result),
            Some(StreamPiece::Final("最终答案".to_string()))
        );

        // 非 JSON / 空对象忽略，避免日志行污染答案
        assert_eq!(parse_stream_line("plain text"), None);
        assert_eq!(parse_stream_line("{}"), None);
    }

    /// stream-json 实跑（用 powershell 充当 CLI，默认忽略）：
    /// `cargo test -p ai-collab-kit stream_json_smoke -- --ignored --nocapture`
    #[cfg(windows)]
    #[tokio::test]
    #[ignore]
    async fn stream_json_smoke() {
        let config = StreamJsonConfig {
            command: "powershell.exe".to_string(),
            args: vec![
                "-NoProfile".to_string(),
                "-Command".to_string(),
                "Write-Output '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}'"
                    .to_string(),
            ],
            prompt_mode: "stdin".to_string(),
            ..Default::default()
        };
        let dir = std::env::temp_dir().join(format!(
            "ai-collab-stream-json-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let outcome = run_stream_json_turn(
            &config,
            &dir,
            "prompt",
            "smoke",
            |text| println!("delta={text}"),
        )
        .await
        .expect("stream-json run failed");
        assert_eq!(outcome.text, "hello");
        assert_eq!(outcome.exit_code, Some(0));
        let _ = fs::remove_dir_all(dir);
    }
}
