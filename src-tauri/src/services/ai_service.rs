// 全局 AI 服务（属于「全局」能力，供「茑萝 · AI 编程」子插件调用）
//
// 设计要点：
// - 插件沙箱屏蔽了 fetch / XMLHttpRequest / WebSocket，插件无法直接联网，
//   因此 LLM 调用必须走本 Rust 后端命令（reqwest 不受前端 CSP 约束）。
// - 兼容 OpenAI Chat Completions 协议（/v1/chat/completions），
//   可对接 OpenAI / DeepSeek / Moonshot / 通义 / 本地 Ollama 等一切兼容端点。
// - 流式输出：SSE 分块解析后通过 Tauri 事件 ai-delta / ai-done / ai-error 推给前端，
//   实现 Cursor / Claude Code 那样的逐字流式体验。
// - 配置（base_url / api_key / model / temperature）持久化到 app_data_dir/ai_config.json，
//   全局共享，任意插件都可读写。

use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// AI 全局配置
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiConfig {
    /// OpenAI 兼容端点基址，如 https://api.deepseek.com/v1
    pub base_url: String,
    /// API Key（Bearer）
    pub api_key: String,
    /// 模型名，如 deepseek-chat / gpt-4o-mini
    pub model: String,
    /// 采样温度（0~2），编程场景建议偏低
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    /// 单轮回复最大 token 数（None 表示由模型默认）
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// 核采样概率（0~1），控制输出多样性
    #[serde(default)]
    pub top_p: Option<f32>,
    /// 全局系统提示词（作为对话 base 指令，可留空使用内置默认）
    #[serde(default)]
    pub system_prompt: Option<String>,
}

fn default_temperature() -> f32 {
    0.3
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            base_url: "https://api.deepseek.com/v1".to_string(),
            api_key: String::new(),
            model: "deepseek-chat".to_string(),
            temperature: default_temperature(),
            max_tokens: None,
            top_p: None,
            system_prompt: None,
        }
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {}", e))?;
    Ok(dir.join("ai_config.json"))
}

fn load_config(app: &AppHandle) -> AiConfig {
    match config_path(app) {
        Ok(p) if p.exists() => fs::read_to_string(&p)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default(),
        _ => AiConfig::default(),
    }
}

/// 读取 AI 全局配置（返回给前端；api_key 原样返回，仅本机存储）
#[tauri::command]
pub fn ai_get_config(app: AppHandle) -> AiConfig {
    load_config(&app)
}

/// 保存 AI 全局配置
#[tauri::command]
pub fn ai_set_config(app: AppHandle, config: AiConfig) -> Result<(), String> {
    let path = config_path(&app)?;
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("写入配置失败: {}", e))?;
    Ok(())
}

/// 单条对话消息（OpenAI 格式）
#[derive(Debug, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// 流式对话：向 OpenAI 兼容端点发起 stream 请求，
/// 逐块解析 SSE 并通过事件推给前端。
/// 事件（payload 含 requestId 以便前端多请求区分）：
///   - ai-delta { requestId, delta }  增量文本
///   - ai-done  { requestId }         结束
///   - ai-error { requestId, error }  出错
#[tauri::command]
pub async fn ai_chat(
    app: AppHandle,
    request_id: String,
    messages: Vec<ChatMessage>,
) -> Result<(), String> {
    let cfg = load_config(&app);
    if cfg.api_key.trim().is_empty() {
        let msg = "未配置 API Key，请先在 AI 编程设置里填写".to_string();
        let _ = app.emit(
            "ai-error",
            serde_json::json!({ "requestId": request_id, "error": msg }),
        );
        return Err(msg);
    }

    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let mut body = serde_json::json!({
        "model": cfg.model,
        "messages": messages
            .iter()
            .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
            .collect::<Vec<_>>(),
        "temperature": cfg.temperature,
        "stream": true,
    });
    if let Some(mt) = cfg.max_tokens {
        body["max_tokens"] = serde_json::json!(mt);
    }
    if let Some(tp) = cfg.top_p {
        body["top_p"] = serde_json::json!(tp);
    }

    let client = reqwest::Client::new();
    let resp = match client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.api_key.trim()))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("请求失败: {}", e);
            let _ = app.emit(
                "ai-error",
                serde_json::json!({ "requestId": request_id, "error": msg }),
            );
            return Err(msg);
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let msg = format!("HTTP {}: {}", status, text);
        let _ = app.emit(
            "ai-error",
            serde_json::json!({ "requestId": request_id, "error": msg }),
        );
        return Err(msg);
    }

    // 逐块读取 SSE。reqwest::Response::chunk() 无需 stream 特性 / futures-util。
    let mut resp = resp;
    let mut buf = String::new();
    loop {
        match resp.chunk().await {
            Ok(Some(bytes)) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                // 逐行处理已完整接收的行
                while let Some(pos) = buf.find('\n') {
                    let line: String = buf.drain(..=pos).collect();
                    let line = line.trim();
                    let data = match line.strip_prefix("data:") {
                        Some(d) => d.trim(),
                        None => continue,
                    };
                    if data == "[DONE]" {
                        let _ =
                            app.emit("ai-done", serde_json::json!({ "requestId": request_id }));
                        return Ok(());
                    }
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                        if let Some(delta) = v["choices"][0]["delta"]["content"].as_str() {
                            if !delta.is_empty() {
                                let _ = app.emit(
                                    "ai-delta",
                                    serde_json::json!({ "requestId": request_id, "delta": delta }),
                                );
                            }
                        }
                    }
                }
            }
            Ok(None) => break,
            Err(e) => {
                let msg = format!("流读取失败: {}", e);
                let _ = app.emit(
                    "ai-error",
                    serde_json::json!({ "requestId": request_id, "error": msg }),
                );
                return Err(msg);
            }
        }
    }

    let _ = app.emit("ai-done", serde_json::json!({ "requestId": request_id }));
    Ok(())
}

/// 测试 AI 配置是否可用：向端点发起一次极小开销的非流式请求，
/// 校验 base_url / api_key / model 是否正确，并返回耗时。不消耗对话额度（max_tokens=5）。
#[tauri::command]
pub async fn ai_test_connection(config: AiConfig) -> Result<String, String> {
    if config.api_key.trim().is_empty() {
        return Err("未填写 API Key，无法测试连接".to_string());
    }
    if config.base_url.trim().is_empty() {
        return Err("未填写 API 端点（Base URL）".to_string());
    }
    if config.model.trim().is_empty() {
        return Err("未填写模型名称".to_string());
    }

    let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": config.model,
        "messages": [{ "role": "user", "content": "ping" }],
        "temperature": 0.0,
        "max_tokens": 5,
        "stream": false,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("创建请求客户端失败: {}", e))?;

    let start = std::time::Instant::now();
    let resp = match client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key.trim()))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return Err(format!("请求失败（端点不可达）: {}", e)),
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text.chars().take(300).collect::<String>()));
    }
    // 消费响应体，避免连接复用告警
    let _ = resp.text().await;
    let ms = start.elapsed().as_millis();
    Ok(format!("连接成功（{}，耗时 {} ms）", config.model, ms))
}
