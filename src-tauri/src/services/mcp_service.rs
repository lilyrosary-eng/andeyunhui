// MCP（Model Context Protocol）客户端服务
//
// 设计取舍（对齐用户「轻量高效、能取巧绝不手搓」原则）：
// - 不引入 rmcp crate（依赖重、架构改动大）
// - 不做完整 MCP 客户端（5 种传输 + 状态机 + OAuth + 进程池）
// - 而是用「单次调用模式」：每次调用都 spawn → initialize → call → kill
//   无状态、无线程池、无并发问题、极简（~300 行）
// - 仅支持 stdio 传输（覆盖大多数 MCP 服务器：filesystem/github/slave/sqlite…）
// - 调用开销约 200-500ms（spawn + initialize），对 agent 偶尔调用完全可接受
//
// 对齐 claw-code-main/runtime/src/mcp_client.rs + mcp_stdio.rs：
// - JSON-RPC 2.0 over stdio（行分隔消息）
// - initialize / tools/list / tools/call 三个核心方法
// - 握手超时 10s（对齐 MCP_INITIALIZE_TIMEOUT_MS = 10_000）
// - 工具调用超时 60s（对齐 DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS = 60_000）

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

// ============ 配置 ============

/// 单个 MCP 服务器配置（stdio 传输）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    /// 服务器 id（用户自定义，如 "filesystem"）
    pub id: String,
    /// 显示名（如 "Filesystem MCP"）
    pub name: String,
    /// 可执行命令（如 "npx" / "node" / "python"）
    pub command: String,
    /// 命令参数（如 ["-y", "@modelcontextprotocol/server-filesystem", "/path"]）
    #[serde(default)]
    pub args: Vec<String>,
    /// 环境变量（如 API key）
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// 是否启用
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

/// 全部 MCP 服务器配置
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct McpServersConfig {
    #[serde(default)]
    pub servers: Vec<McpServerConfig>,
}

// ============ 工具与结果 ============

/// MCP 工具描述（对齐 mcp_client.rs::McpToolDescriptor）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpTool {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Option<Value>,
}

/// 工具调用结果（对齐 mcp_client.rs::McpToolCallResult）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolCallResult {
    pub ok: bool,
    /// 工具返回的内容（text / image / resource）
    pub content: Vec<Value>,
    /// 错误信息（ok=false 时）
    pub error: Option<String>,
    /// 是否是工具内部错误（vs 协议/网络错误）
    pub is_tool_error: bool,
}

// ============ 配置持久化 ============

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {}", e))?;
    Ok(dir.join("mcp_config.json"))
}

fn load_config(app: &AppHandle) -> McpServersConfig {
    let path = match config_path(app) {
        Ok(p) => p,
        Err(_) => return McpServersConfig::default(),
    };
    if !path.exists() {
        return McpServersConfig::default();
    }
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return McpServersConfig::default(),
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_config(app: &AppHandle, config: &McpServersConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("写入配置失败: {}", e))?;
    Ok(())
}

// ============ JSON-RPC over stdio（核心） ============

const INITIALIZE_TIMEOUT_MS: u64 = 10_000;
const LIST_TOOLS_TIMEOUT_MS: u64 = 30_000;
const CALL_TOOL_TIMEOUT_MS: u64 = 60_000;

/// JSON-RPC 请求
#[derive(Debug, Clone, Serialize)]
struct JsonRpcRequest {
    jsonrpc: &'static str,
    id: u64,
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
}

/// MCP stdio 会话：单次调用模式，用完即弃
struct McpStdioSession {
    child: Child,
    next_id: u64,
}

impl McpStdioSession {
    fn spawn(cfg: &McpServerConfig) -> Result<Self, String> {
        let mut cmd = Command::new(&cfg.command);
        cmd.args(&cfg.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // 注入环境变量
        for (k, v) in &cfg.env {
            cmd.env(k, v);
        }
        let child = cmd
            .spawn()
            .map_err(|e| format!("spawn MCP 服务器 '{}' 失败: {}", cfg.command, e))?;
        Ok(Self { child, next_id: 1 })
    }

    /// 发送 JSON-RPC 请求并等待响应（带超时）
    /// 响应通过 id 匹配；忽略 notification（无 id 的消息）
    fn request(&mut self, method: &str, params: Option<Value>, timeout_ms: u64) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            id,
            method: method.to_string(),
            params,
        };
        let line = serde_json::to_string(&req).map_err(|e| format!("序列化请求失败: {}", e))?;

        let stdin = self
            .child
            .stdin
            .as_mut()
            .ok_or_else(|| "stdin 不可用".to_string())?;
        stdin
            .write_all(format!("{}\n", line).as_bytes())
            .map_err(|e| format!("写 stdin 失败: {}", e))?;
        stdin.flush().map_err(|e| format!("flush stdin 失败: {}", e))?;

        // 读取响应（按 id 匹配，带超时）
        let stdout = self
            .child
            .stdout
            .as_mut()
            .ok_or_else(|| "stdout 不可用".to_string())?;
        let mut reader = BufReader::new(stdout);
        let start = Instant::now();
        let timeout = Duration::from_millis(timeout_ms);
        loop {
            if start.elapsed() > timeout {
                return Err(format!("等待 {} 响应超时（{}ms）", method, timeout_ms));
            }
            let mut buf = String::new();
            let n = reader
                .read_line(&mut buf)
                .map_err(|e| format!("读 stdout 失败: {}", e))?;
            if n == 0 {
                return Err(format!("MCP 服务器关闭了 stdout（method={}）", method));
            }
            let trimmed = buf.trim();
            if trimmed.is_empty() {
                continue;
            }
            let v: Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(_) => continue, // 非 JSON 行（如日志输出），跳过
            };
            // 跳过 notification（无 id 的消息，如 initialized 通知）
            let resp_id = v.get("id");
            if resp_id.is_none() {
                continue;
            }
            // 检查 id 是否匹配（JSON-RPC id 可能是 number 或 string）
            let id_matches = match resp_id {
                Some(Value::Number(n)) => n.as_u64() == Some(id),
                Some(Value::String(s)) => s.parse::<u64>().ok() == Some(id),
                _ => false,
            };
            if !id_matches {
                continue;
            }
            // 检查 error
            if let Some(err) = v.get("error") {
                let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("未知错误");
                let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
                return Err(format!("JSON-RPC 错误 [{}]: {}", code, msg));
            }
            // 返回 result
            return Ok(v.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    /// 完整握手：initialize → notifications/initialized
    fn initialize(&mut self) -> Result<Value, String> {
        let params = json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "andeyunhui-ide",
                "version": "1.0.0"
            }
        });
        let result = self.request("initialize", Some(params), INITIALIZE_TIMEOUT_MS)?;
        // 发送 initialized 通知（无 id，无需等待响应）
        let notif = json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        });
        if let Some(stdin) = self.child.stdin.as_mut() {
            let line = serde_json::to_string(&notif).unwrap_or_default();
            let _ = stdin.write_all(format!("{}\n", line).as_bytes());
            let _ = stdin.flush();
        }
        Ok(result)
    }

    /// 列出工具
    fn list_tools(&mut self) -> Result<Vec<McpTool>, String> {
        let result = self.request("tools/list", None, LIST_TOOLS_TIMEOUT_MS)?;
        let tools_val = result.get("tools").cloned().unwrap_or(Value::Array(vec![]));
        let tools: Vec<McpTool> = serde_json::from_value(tools_val)
            .map_err(|e| format!("解析 tools/list 响应失败: {}", e))?;
        Ok(tools)
    }

    /// 调用工具
    fn call_tool(&mut self, name: &str, args: Value) -> Result<McpToolCallResult, String> {
        let params = json!({
            "name": name,
            "arguments": args
        });
        let result = self.request("tools/call", Some(params), CALL_TOOL_TIMEOUT_MS)?;
        // MCP 工具调用结果：{ content: [{type: "text", text: "..."}, ...], isError: bool }
        let content = result.get("content").cloned().unwrap_or(Value::Array(vec![]));
        let content_arr: Vec<Value> = match content {
            Value::Array(arr) => arr,
            other => vec![other],
        };
        let is_error = result.get("isError").and_then(|v| v.as_bool()).unwrap_or(false);
        Ok(McpToolCallResult {
            ok: !is_error,
            content: content_arr,
            error: if is_error {
                Some("工具返回 isError=true".to_string())
            } else {
                None
            },
            is_tool_error: is_error,
        })
    }

    /// 关闭会话（kill 子进程）
    fn close(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// ============ Tauri 命令 ============

/// 列出所有已配置的 MCP 服务器
#[tauri::command]
pub fn mcp_list_servers(app: AppHandle) -> McpServersConfig {
    load_config(&app)
}

/// 添加/更新 MCP 服务器配置
#[tauri::command]
pub fn mcp_save_server(app: AppHandle, server: McpServerConfig) -> Result<McpServersConfig, String> {
    let mut config = load_config(&app);
    // 按 id 替换或追加
    if let Some(existing) = config.servers.iter_mut().find(|s| s.id == server.id) {
        *existing = server;
    } else {
        config.servers.push(server);
    }
    save_config(&app, &config)?;
    Ok(config)
}

/// 删除 MCP 服务器配置
#[tauri::command]
pub fn mcp_remove_server(app: AppHandle, server_id: String) -> Result<McpServersConfig, String> {
    let mut config = load_config(&app);
    config.servers.retain(|s| s.id != server_id);
    save_config(&app, &config)?;
    Ok(config)
}

/// 列出某 MCP 服务器的工具（spawn → initialize → list_tools → kill）
/// 用于配置面板预览 + agent 系统提示词注入
#[tauri::command]
pub async fn mcp_list_tools(app: AppHandle, server_id: String) -> Result<Vec<McpTool>, String> {
    let config = load_config(&app);
    let server = config
        .servers
        .into_iter()
        .find(|s| s.id == server_id)
        .ok_or_else(|| format!("MCP 服务器 '{}' 不存在", server_id))?;
    if !server.enabled {
        return Err(format!("MCP 服务器 '{}' 已禁用", server_id));
    }
    // 在阻塞线程中执行 stdio 通信（避免阻塞主线程）
    let server = tokio::task::spawn_blocking(move || -> Result<Vec<McpTool>, String> {
        let mut session = McpStdioSession::spawn(&server)?;
        let _ = session.initialize();
        let tools = session.list_tools();
        session.close();
        tools
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;
    Ok(server)
}

/// 列出所有启用服务器的工具（聚合，用于 agent 系统提示词注入）
#[tauri::command]
pub async fn mcp_list_all_tools(app: AppHandle) -> Result<Vec<(String, String, Vec<McpTool>)>, String> {
    let config = load_config(&app);
    let enabled: Vec<McpServerConfig> = config.servers.into_iter().filter(|s| s.enabled).collect();
    let mut results = Vec::new();
    for server in enabled {
        let id = server.id.clone();
        let name = server.name.clone();
        // 每个服务器独立 spawn，失败不影响其他
        let server_clone = server.clone();
        let tools_result = tokio::task::spawn_blocking(move || -> Result<Vec<McpTool>, String> {
            let mut session = McpStdioSession::spawn(&server_clone)?;
            let _ = session.initialize();
            let tools = session.list_tools();
            session.close();
            tools
        })
        .await
        .map_err(|e| format!("任务执行失败: {}", e))?;
        match tools_result {
            Ok(tools) => results.push((id, name, tools)),
            Err(e) => {
                // 记录失败但继续其他服务器
                eprintln!("MCP 服务器 '{}' list_tools 失败: {}", server.id, e);
            }
        }
    }
    Ok(results)
}

/// 调用 MCP 工具（spawn → initialize → call_tool → kill）
#[tauri::command]
pub async fn mcp_call_tool(
    app: AppHandle,
    server_id: String,
    tool_name: String,
    arguments: Value,
) -> Result<McpToolCallResult, String> {
    let config = load_config(&app);
    let server = config
        .servers
        .into_iter()
        .find(|s| s.id == server_id)
        .ok_or_else(|| format!("MCP 服务器 '{}' 不存在", server_id))?;
    if !server.enabled {
        return Err(format!("MCP 服务器 '{}' 已禁用", server_id));
    }
    let result = tokio::task::spawn_blocking(move || -> Result<McpToolCallResult, String> {
        let mut session = McpStdioSession::spawn(&server)?;
        let _ = session.initialize();
        let result = session.call_tool(&tool_name, arguments);
        session.close();
        result
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))??;
    Ok(result)
}
