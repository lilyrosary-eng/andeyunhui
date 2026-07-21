// 全局 AI 服务（属于「全局」能力，供「茑萝 · AI 编程」子插件调用）
//
// 设计要点：
// - 插件沙箱屏蔽了 fetch / XMLHttpRequest / WebSocket，插件无法直接联网，
//   因此 LLM 调用必须走本 Rust 后端命令（reqwest 不受前端 CSP 约束）。
// - 兼容 OpenAI Chat Completions 协议（/v1/chat/completions），
//   可对接 OpenAI / DeepSeek / Moonshot / 通义 / 本地 Ollama 等一切兼容端点。
// - 流式输出：SSE 分块解析后通过 Tauri 事件 ai-delta / ai-done / ai-error 推给前端，
//   实现 Cursor / Claude Code 那样的逐字流式体验。
// - 配置（多份「模型档案」profiles，每份含 base_url / api_key / model / temperature 等）
//   持久化到 app_data_dir/ai_config.json，全局共享，任意插件都可读写；
//   ai_chat 可指定 profile_id 选用某份档案，未指定则用 active 激活项。

use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

fn default_temperature() -> f32 {
    0.3
}

/// 单份模型档案（可配置多份，互不影响；IDE / 其他插件按 id 选用）
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AiProfile {
    /// 档案唯一 id（如 "deepseek" / "p_xxx"）
    #[serde(default)]
    pub id: String,
    /// 显示名（下拉框展示，如 "DeepSeek" / "我的 OpenAI"）
    #[serde(default)]
    pub name: String,
    /// OpenAI 兼容端点基址，如 https://api.deepseek.com/v1
    pub base_url: String,
    /// API Key（Bearer）
    pub api_key: String,
    /// 模型名，如 deepseek-chat / gpt-4o-mini
    pub model: String,
    /// 视觉模型名（OCR / 图片理解用，可选）：留空则复用 model。
    /// 多数供应商的对话模型无视觉能力，单独指定视觉模型可避免 OCR 报「模型不支持图片」。
    #[serde(default)]
    pub vision_model: Option<String>,
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

impl AiProfile {
    /// 下拉框展示名：优先 name，其次 model，再次端点
    fn display_name(&self) -> String {
        if !self.name.trim().is_empty() {
            return self.name.trim().to_string();
        }
        if !self.model.trim().is_empty() {
            return self.model.trim().to_string();
        }
        self.base_url.trim().to_string()
    }
}

/// 全部模型档案集合 + 当前默认激活的档案 id
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AiProfiles {
    #[serde(default)]
    pub profiles: Vec<AiProfile>,
    #[serde(default)]
    pub active: Option<String>,
}

/// 首份默认档案（DeepSeek 占位，未填 key 时引导用户去设置）
fn default_profile() -> AiProfile {
    AiProfile {
        id: "deepseek".to_string(),
        name: "DeepSeek".to_string(),
        base_url: "https://api.deepseek.com/v1".to_string(),
        api_key: String::new(),
        model: "deepseek-chat".to_string(),
        vision_model: None,
        temperature: default_temperature(),
        max_tokens: None,
        top_p: None,
        system_prompt: None,
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

/// 读取全部模型档案；兼容旧版「单份 AiConfig」格式（无 id/name 字段）自动升级为单档案。
fn load_profiles(app: &AppHandle) -> AiProfiles {
    let path = match config_path(app) {
        Ok(p) => p,
        Err(_) => return AiProfiles::default(),
    };
    if !path.exists() {
        return AiProfiles::default();
    }
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return AiProfiles::default(),
    };
    // 新格式：多档案
    if let Ok(p) = serde_json::from_str::<AiProfiles>(&text) {
        return p;
    }
    // 旧格式：单份配置（字段兼容 AiProfile，id/name 走默认值）
    if let Ok(legacy) = serde_json::from_str::<AiProfile>(&text) {
        let id = if legacy.id.trim().is_empty() {
            "legacy".to_string()
        } else {
            legacy.id.clone()
        };
        let name = if legacy.name.trim().is_empty() {
            legacy.display_name()
        } else {
            legacy.name.clone()
        };
        return AiProfiles {
            profiles: vec![AiProfile {
                id: id.clone(),
                name,
                ..legacy
            }],
            active: Some(id),
        };
    }
    AiProfiles::default()
}

/// 按 profile_id 解析实际使用的档案：指定 > 激活项 > 首个 > 默认
fn resolve_profile(profiles: &AiProfiles, profile_id: Option<String>) -> AiProfile {
    if let Some(pid) = profile_id {
        if let Some(p) = profiles.profiles.iter().find(|p| p.id == pid) {
            return p.clone();
        }
    }
    if let Some(aid) = &profiles.active {
        if let Some(p) = profiles.profiles.iter().find(|p| p.id == *aid) {
            return p.clone();
        }
    }
    if let Some(first) = profiles.profiles.first() {
        return first.clone();
    }
    default_profile()
}

/// 读取全部模型档案（返回前端用于下拉框 / 配置页；api_key 原样返回，仅本机存储）
#[tauri::command]
pub fn ai_get_profiles(app: AppHandle) -> AiProfiles {
    load_profiles(&app)
}

/// 保存全部模型档案 + 激活项
#[tauri::command]
pub fn ai_set_profiles(app: AppHandle, payload: AiProfiles) -> Result<(), String> {
    let path = config_path(&app)?;
    let json = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("写入配置失败: {}", e))?;
    Ok(())
}

/// 单条对话消息（OpenAI 格式）
#[derive(Debug, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

// ============ Prompt Cache 支持（借鉴 claw-code-main/api/src/prompt_cache.rs） ============
// Anthropic 的 OpenAI 兼容端点支持 cache_control: { type: "ephemeral" } 做前缀缓存，
// 把 system + 稳定历史段标记为 ephemeral 后，provider 侧缓存 5 分钟，
// 后续请求命中缓存时 cache_read_input_tokens 大幅降低成本与延迟。
// Anthropic 允许最多 4 个 cache breakpoint；这里放 2 个：system + 倒数第 3 条消息。

/// 检测是否为 Anthropic 提供商（通过模型名或 base_url 判断）
fn is_anthropic_provider(cfg: &AiProfile) -> bool {
    let model = cfg.model.to_lowercase();
    let base = cfg.base_url.to_lowercase();
    model.starts_with("claude")
        || base.contains("anthropic.com")
        || base.contains("claude.ai")
}

/// 为 Anthropic 提供商构建带 cache_control 的 messages 数组。
/// 把 system 消息和倒数第 3 条消息的 content 从字符串转为 block 数组格式，
/// 并在最后一个 block 上加 cache_control: { type: "ephemeral" }。
/// 这样 provider 侧会缓存 system + 稳定历史前缀，后续请求命中即省 token。
fn build_anthropic_messages(messages: &[ChatMessage]) -> Vec<serde_json::Value> {
    let n = messages.len();
    // 倒数第 3 条的位置（稳定历史段的末尾，放 cache breakpoint）
    // 保留最后 2 条为 volatile（用户最新输入 + 可能的 tool result）
    let stable_end = if n > 4 { n.saturating_sub(3) } else { 0 };
    messages
        .iter()
        .enumerate()
        .map(|(i, m)| {
            // system 消息 或 倒数第 3 条消息（稳定段末尾）加 cache_control
            let needs_cache = m.role == "system" || (stable_end > 0 && i + 1 == stable_end);
            if needs_cache && !m.content.is_empty() {
                serde_json::json!({
                    "role": m.role,
                    "content": [
                        {
                            "type": "text",
                            "text": m.content,
                            "cache_control": { "type": "ephemeral" }
                        }
                    ]
                })
            } else {
                serde_json::json!({ "role": m.role, "content": m.content })
            }
        })
        .collect()
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
    profile_id: Option<String>,
) -> Result<(), String> {
    let profiles = load_profiles(&app);
    let cfg = resolve_profile(&profiles, profile_id);
    if cfg.api_key.trim().is_empty() {
        let msg = "未配置 API Key，请先在全局设置 → 模型 中填写".to_string();
        let _ = app.emit(
            "ai-error",
            serde_json::json!({ "requestId": request_id, "error": msg }),
        );
        return Err(msg);
    }

    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    // Prompt Cache：Anthropic 提供商用 cache_control block 格式，其他提供商用标准字符串格式。
    // 对齐 claw-code-main/api/src/prompt_cache.rs 的设计：system + 稳定历史段标记 ephemeral。
    let use_anthropic_cache = is_anthropic_provider(&cfg);
    let messages_json: Vec<serde_json::Value> = if use_anthropic_cache {
        build_anthropic_messages(&messages)
    } else {
        messages
            .iter()
            .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
            .collect::<Vec<_>>()
    };
    let mut body = serde_json::json!({
        "model": cfg.model,
        "messages": messages_json,
        "temperature": cfg.temperature,
        "stream": true,
        // stream_options.include_usage：让 OpenAI 兼容端点在最终 chunk 返回 usage 字段
        // （OpenAI / DeepSeek / Anthropic OpenAI-compat 均支持）
        "stream_options": { "include_usage": true },
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
    // 累积 usage 字段（OpenAI 在最终 chunk 返回 usage；DeepSeek 返回 prompt_cache_hit_tokens；
    // Anthropic OpenAI-compat 返回 cache_read_input_tokens / cache_creation_input_tokens）
    let mut last_usage: Option<serde_json::Value> = None;
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
                        let _ = app.emit("ai-done", serde_json::json!({
                            "requestId": request_id,
                            "usage": last_usage,
                        }));
                        return Ok(());
                    }
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                        // 提取 usage（最终 chunk 含完整 usage 字段）
                        if let Some(usage) = v.get("usage") {
                            if !usage.is_null() {
                                last_usage = Some(usage.clone());
                            }
                        }
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

    let _ = app.emit("ai-done", serde_json::json!({
        "requestId": request_id,
        "usage": last_usage,
    }));
    Ok(())
}

/// 测试 AI 配置是否可用：向端点发起一次极小开销的非流式请求，
/// 校验 base_url / api_key / model 是否正确，并返回耗时。不消耗对话额度（max_tokens=5）。
#[tauri::command]
pub async fn ai_test_connection(config: AiProfile) -> Result<String, String> {
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

// ========== 视觉 OCR + 翻译（非流式便捷命令） ==========
//
// 设计：
// - 复用 ai_config.json 中的模型档案（profile_id 选某份，None 用激活项）
// - 非流式（stream:false）：OCR / 翻译不需要逐字呈现，直接返回完整结果
// - 视觉 OCR：构造 OpenAI Vision 协议的 content 数组（image_url + text）
//   兼容 OpenAI gpt-4o / Anthropic claude-3-opus / 通义 qwen-vl / gemini-2.x 等
// - 翻译：构造 system + user 单轮对话，提示模型只返回译文
// - 失败时返回详细错误信息（含 HTTP 状态码 + 响应体片段），前端直接展示

/// 视觉 OCR：传入图片 base64 + prompt，返回模型识别的文本
/// 兼容 OpenAI Vision 协议（content 数组：[{type:"text",text:...},{type:"image_url",image_url:{url:"data:..."}}]）
#[tauri::command]
pub async fn ai_vision_ocr(
    app: AppHandle,
    image_base64: String,
    image_mime: String,
    prompt: Option<String>,
    profile_id: Option<String>,
) -> Result<String, String> {
    let profiles = load_profiles(&app);
    let cfg = resolve_profile(&profiles, profile_id);
    if cfg.api_key.trim().is_empty() {
        return Err("未配置 API Key，请先在全局设置 → 模型中填写".to_string());
    }

    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let p = prompt.unwrap_or_else(|| "请提取图片中的全部文字，保持原始排版与顺序，仅输出识别结果不要任何说明".to_string());
    let data_url = format!("data:{};base64,{}", image_mime, image_base64);

    // OCR 优先使用独立的视觉模型；未单独配置时回落到对话模型（兼容旧配置）。
    let ocr_model = cfg
        .vision_model
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| cfg.model.clone());

    let body = serde_json::json!({
        "model": ocr_model,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": p },
                { "type": "image_url", "image_url": { "url": data_url } }
            ]
        }],
        "temperature": 0.0,
        "max_tokens": cfg.max_tokens.unwrap_or(4096),
        "stream": false,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("创建请求客户端失败: {}", e))?;

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.api_key.trim()))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "HTTP {}（模型可能不支持视觉输入）: {}",
            status,
            text.chars().take(300).collect::<String>()
        ));
    }

    // 先取原始文本再解析：某些供应商（如纯文本模型收到图片时）会返回非 JSON 或非标准结构，
    // 直接 .json() 会得到模糊的「error decoding response body」，丢失服务端真实信息。
    let raw = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
        format!(
            "解析响应失败: {}；服务端原始返回：{}",
            e,
            raw.chars().take(300).collect::<String>()
        )
    })?;

    // 若服务端在 200 里夹带 error 字段（部分 OpenAI 兼容网关的做法），直接暴露。
    if let Some(err_obj) = v.get("error") {
        let em = err_obj
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("未知错误");
        return Err(format!("服务端返回错误：{}", em));
    }

    // 兼容两种返回结构：content 为字符串（OpenAI/gpt-4o、Qwen-VL、GLM-4V 多数情况），
    // 或 content 为文本块数组（[{type:"text",text:"..."}]，部分 VL 模型会这样返回）。
    let content_val = &v["choices"][0]["message"]["content"];
    let content = match content_val {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(arr) => arr
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => {
            return Err(format!(
                "响应中未找到 content 字段；服务端原始返回：{}",
                raw.chars().take(300).collect::<String>()
            ))
        }
    };
    Ok(content)
}

/// 翻译：传入文本 + 目标语言代码（如 "en"/"zh"/"ja"），返回译文
/// 走非流式 AI 对话；若未配置 AI 则返回错误供前端降级提示
#[tauri::command]
pub async fn translate_text(
    app: AppHandle,
    text: String,
    target_lang: Option<String>,
    profile_id: Option<String>,
) -> Result<String, String> {
    let profiles = load_profiles(&app);
    let cfg = resolve_profile(&profiles, profile_id);
    if cfg.api_key.trim().is_empty() {
        return Err("未配置 API Key，请先在全局设置 → 模型中填写".to_string());
    }

    let lang = target_lang.unwrap_or_else(|| "中文".to_string());
    let system = format!(
        "你是专业翻译助手。将用户输入的文本翻译为{}，仅输出译文，不加注释、不加引号、不保留原文。如果原文已是目标语言则原样返回。",
        lang
    );

    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": cfg.model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": text }
        ],
        "temperature": 0.1,
        "max_tokens": cfg.max_tokens.unwrap_or(4096),
        "stream": false,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("创建请求客户端失败: {}", e))?;

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.api_key.trim()))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "HTTP {}: {}",
            status,
            text.chars().take(300).collect::<String>()
        ));
    }

    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;
    let content = v["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| "响应中未找到 content 字段".to_string())?
        .to_string();
    Ok(content)
}

// ========== 对话持久化 ==========
//
// 设计要点：
// - 对话（含多条历史 + 全部消息）持久化到 app_data_dir/ai_conversations.json，
//   与 ai_config.json 同目录、同模式（serde_json + fs::write），零新增依赖。
// - 不引入 NPSL / IndexedDB / SQLite：对话量级为「几条到几十条」桌面场景，
//   JSON 文件足够；强传染协议（GPL/AGPL 系）依赖被用户明确禁止。
// - 流式状态（streaming）不持久化：加载后所有消息默认 streaming=false。
// - 错误消息（error=true）仍持久化，便于回看失败上下文；前端可手动清除。

/// 单条对话消息（前端 Msg 的子集，仅持久化必要字段）
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AiMessage {
    pub id: String,
    pub role: String, // "user" | "assistant"
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<bool>,
}

/// 单条对话（含标题与全部消息）
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AiConversation {
    pub id: String,
    pub title: String,
    pub messages: Vec<AiMessage>,
}

/// 持久化的对话集合（顶层包装，便于后续扩展元数据字段）
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AiConversations {
    #[serde(default)]
    pub conversations: Vec<AiConversation>,
    /// 持久化时的活跃对话 id（前端 AiPanel 当前打开的对话）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_id: Option<String>,
}

fn conversations_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {}", e))?;
    Ok(dir.join("ai_conversations.json"))
}

/// 读取全部持久化的对话；文件不存在或解析失败时返回空集合（不抛错，避免阻塞 UI）。
#[tauri::command]
pub fn ai_get_conversations(app: AppHandle) -> AiConversations {
    let path = match conversations_path(&app) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[ai] 读取对话失败（路径）: {}", e);
            return AiConversations::default();
        }
    };
    if !path.exists() {
        return AiConversations::default();
    }
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            log::warn!("[ai] 读取对话失败（IO）: {}", e);
            return AiConversations::default();
        }
    };
    match serde_json::from_str::<AiConversations>(&text) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[ai] 解析对话 JSON 失败（已忽略旧格式）: {}", e);
            AiConversations::default()
        }
    }
}

/// 保存全部对话 + 当前激活 id。
/// 前端防抖调用（约 500ms），避免流式增量触发频繁磁盘写入。
#[tauri::command]
pub fn ai_save_conversations(app: AppHandle, payload: AiConversations) -> Result<(), String> {
    let path = conversations_path(&app)?;
    // 先写临时文件再 rename，避免写入中途崩溃导致 JSON 损坏（原子性近似）
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(&payload).map_err(|e| format!("序列化失败: {}", e))?;
    fs::write(&tmp, json).map_err(|e| format!("写入临时文件失败: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("重命名失败: {}", e))?;
    Ok(())
}
