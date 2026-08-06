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
use base64::Engine;
use image::GenericImageView;
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
    /// 思考模式（Thinking）：开启后模型先输出思维链再回答。默认关。
    /// DeepSeek 等推理模型支持（reasoning_effort + thinking 参数）；不支持的模型可能报错。
    #[serde(default)]
    pub thinking: Option<bool>,
    /// 人设：希望 AI 如何称呼你（可留空）
    #[serde(default)]
    pub persona_call_me_as: Option<String>,
    /// 人设：风格预设 key（sharp/gentle/rigorous/humorous/pro/concise/mentor/custom），可留空
    #[serde(default)]
    pub persona_preset: Option<String>,
    /// 人设：自定义风格描述（当 preset=custom 或需追加说明时使用，可留空）
    #[serde(default)]
    pub persona_style: Option<String>,
    /// 图片生成模型（多模态·阶段 5，可选）：留空则 AI 发图工具不可用
    #[serde(default)]
    pub image_model: Option<String>,
    /// 语音合成模型（多模态·阶段 5，可选）：留空则语音工具不可用
    #[serde(default)]
    pub tts_model: Option<String>,
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
        thinking: None,
        persona_call_me_as: None,
        persona_preset: None,
        persona_style: None,
        image_model: None,
        tts_model: None,
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
pub fn load_profiles(app: &AppHandle) -> AiProfiles {
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
pub fn resolve_profile(profiles: &AiProfiles, profile_id: Option<String>) -> AiProfile {
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

/// 仅更新单个档案的「思考模式」开关，供聊天界面内联切换（跨胶囊/IDE/攻防共享同一档案字段）。
#[tauri::command]
pub fn ai_set_profile_thinking(app: AppHandle, profile_id: String, thinking: bool) -> Result<(), String> {
    let mut profiles = load_profiles(&app);
    let mut found = false;
    for p in profiles.profiles.iter_mut() {
        if p.id == profile_id {
            p.thinking = Some(thinking);
            found = true;
            break;
        }
    }
    if !found {
        return Err(format!("未找到模型档案: {}", profile_id));
    }
    let path = config_path(&app)?;
    let json = serde_json::to_string_pretty(&profiles).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("写入配置失败: {}", e))?;
    // 广播「思考模式」变化，使胶囊 / IDE / 攻防 各聊天界面实时同步同一档案字段
    let _ = app.emit(
        "ai-thinking-changed",
        serde_json::json!({ "profile_id": profile_id, "thinking": thinking }),
    );
    Ok(())
}

/// 组合人设 system 提示词：风格预设 + 自定义风格 + 称呼 + 额外要求（legacy system_prompt）。
/// 全部留空时返回空串，调用方据此决定是否注入（不破坏既有对话行为）。
fn compose_persona_system(cfg: &AiProfile) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(preset) = &cfg.persona_preset {
        let p = preset.trim();
        if !p.is_empty() {
            let desc = match p {
                "sharp" => "你的沟通风格是毒舌直率、一针见血，不绕弯子，敢于直接指出问题，但始终基于事实、不人身攻击、不阴阳怪气。",
                "gentle" => "你的沟通风格是温柔细致、循循善诱，多用鼓励性语言，分步骤耐心解释，照顾对方的情绪与接受度。",
                "rigorous" => "你的沟通风格是严谨认真、逻辑缜密，注重证据与出处，措辞准确，不臆测、不下无根据的结论。",
                "humorous" => "你的沟通风格是幽默风趣、妙语连珠，善用比喻与生活化例子让内容轻松易懂，但不喧宾夺主。",
                "pro" => "你的沟通风格是专业顾问式，条理清晰，适度使用行业术语并解释，给出可执行建议与权衡分析。",
                "concise" => "你的沟通风格是极简直接，只给结论与要点，能用列表就不用段落，省略客套与寒暄。",
                "mentor" => "你的沟通风格是导师式，先引导思考再给答案，常用提问帮助对方建立方法论。",
                _ => "", // custom 或未识别：交给 persona_style 描述
            };
            if !desc.is_empty() {
                parts.push(desc.to_string());
            }
        }
    }
    if let Some(style) = &cfg.persona_style {
        let s = style.trim();
        if !s.is_empty() {
            parts.push(format!("你应遵守以下风格要求：{}", s));
        }
    }
    if let Some(name) = &cfg.persona_call_me_as {
        let n = name.trim();
        if !n.is_empty() {
            parts.push(format!("你可以称呼我为{}。", n));
        }
    }
    if let Some(sp) = &cfg.system_prompt {
        let s = sp.trim();
        if !s.is_empty() {
            parts.push(s.to_string());
        }
    }
    parts.join("\n\n")
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

/// DeepSeek 提供商判定：base_url 含 deepseek（api.deepseek.com 等）。
fn is_deepseek_provider(cfg: &AiProfile) -> bool {
    cfg.base_url.to_lowercase().contains("deepseek")
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
    let thinking = cfg.thinking.unwrap_or(false);
    // 人设 system：组合后合并进首条 system 消息（不破坏插件自带的项目上下文 / SOP / 状态注入）。
    let persona = compose_persona_system(&cfg);
    let mut messages_json = messages_json;
    if !persona.is_empty() {
        if let Some(first) = messages_json.first_mut() {
            if first.get("role").and_then(|r| r.as_str()) == Some("system") {
                let existing = first.get("content").and_then(|c| c.as_str()).unwrap_or("");
                first["content"] = serde_json::json!(format!("{}\n\n{}", existing, persona));
            } else {
                messages_json.insert(0, serde_json::json!({ "role": "system", "content": persona }));
            }
        } else {
            messages_json.insert(0, serde_json::json!({ "role": "system", "content": persona }));
        }
    }
    let mut body = serde_json::json!({
        "model": cfg.model,
        "messages": messages_json,
        "stream": true,
        // stream_options.include_usage：让 OpenAI 兼容端点在最终 chunk 返回 usage 字段
        // （OpenAI / DeepSeek / Anthropic OpenAI-compat 均支持）
        "stream_options": { "include_usage": true },
    });
    if thinking {
        // 思考模式：思维链通过 reasoning_content 返回（与 content 同级）。
        // 思考模式不支持 temperature / top_p（OpenAI o-series 直接报错，DeepSeek 忽略），故省略。
        body["reasoning_effort"] = serde_json::json!("high");
        // DeepSeek 需显式 thinking 开关；OpenAI o-series 仅靠 reasoning_effort，多余字段会 400，
        // 故 thinking 块仅对 DeepSeek 附加。
        if is_deepseek_provider(&cfg) {
            body["thinking"] = serde_json::json!({ "type": "enabled" });
        }
    } else {
        body["temperature"] = serde_json::json!(cfg.temperature);
        if let Some(mt) = cfg.max_tokens {
            body["max_tokens"] = serde_json::json!(mt);
        }
        if let Some(tp) = cfg.top_p {
            body["top_p"] = serde_json::json!(tp);
        }
        // 关闭时主动禁用思考，真正省 token（仅 DeepSeek 支持该开关；o-series 无法关闭，仅显示层忽略）。
        if is_deepseek_provider(&cfg) {
            body["thinking"] = serde_json::json!({ "type": "disabled" });
        }
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
    //
    // 重要：必须按「原始字节」累积，只在遇到完整 \n 时才解码该行。
    // 若用 String::from_utf8_lossy 逐 chunk 转 String，多字节 UTF-8 字符（emoji/中文）
    // 被 chunk 边界切成两半时会产生 U+FFFD（�）乱码——正是真机上看到「���」的根因。
    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::new();
    // 累积 usage 字段（OpenAI 在最终 chunk 返回 usage；DeepSeek 返回 prompt_cache_hit_tokens；
    // Anthropic OpenAI-compat 返回 cache_read_input_tokens / cache_creation_input_tokens）
    let mut last_usage: Option<serde_json::Value> = None;
    loop {
        match resp.chunk().await {
            Ok(Some(bytes)) => {
                buf.extend_from_slice(&bytes);
                // 逐行处理已完整接收的行（行级解码：保证 UTF-8 完整，不截断）
                while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                    let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
                    let line = String::from_utf8_lossy(&line_bytes);
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
                        // 思考过程（reasoning_content）：与 content 同级，流式逐块返回。
                        // 严格隔离：仅当思考模式开启才转发，关闭时即使模型返回也丢弃（不烧 token、不显示）。
                        if thinking {
                            if let Some(rc) = v["choices"][0]["delta"]["reasoning_content"].as_str() {
                                if !rc.is_empty() {
                                    let _ = app.emit(
                                        "ai-reasoning-delta",
                                        serde_json::json!({ "requestId": request_id, "delta": rc }),
                                    );
                                }
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

/// 翻译：传入文本 + 目标语言 + 可选源语言（"auto" 或留空表示自动识别），返回译文
/// 走非流式 AI 对话；若未配置 AI 则返回错误供前端降级提示
#[tauri::command]
pub async fn translate_text(
    app: AppHandle,
    text: String,
    target_lang: Option<String>,
    source_lang: Option<String>,
    profile_id: Option<String>,
) -> Result<String, String> {
    let profiles = load_profiles(&app);
    let cfg = resolve_profile(&profiles, profile_id);
    if cfg.api_key.trim().is_empty() {
        return Err("未配置 API Key，请先在全局设置 → 模型中填写".to_string());
    }

    let lang = target_lang.unwrap_or_else(|| "中文".to_string());
    // 源语言：仅当明确给出且非 "auto" 时才写入提示词；其余（auto / 空）视为自动识别
    let source = source_lang
        .filter(|s| !s.is_empty() && s != "auto");
    let system = match source {
        Some(src) => format!(
            "你是专业翻译助手。将用户输入的{}文本翻译为{}，仅输出译文，不加注释、不加引号、不保留原文。如果原文已是目标语言则原样返回。",
            src, lang
        ),
        None => format!(
            "你是专业翻译助手。将用户输入的文本翻译为{}，仅输出译文，不加注释、不加引号、不保留原文。如果原文已是目标语言则原样返回。",
            lang
        ),
    };

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

/// OCR 文本校对 / 整理：将本地或云端 OCR 得到的原文发送给文本模型，
/// 修正错别字、补全省略号与标点、按语义整理段落，返回校对后的纯文本。
/// 主要用于「DeepSeek 等不支持图像识别的模型」场景：先用 PaddleOCR 本地识别，
/// 再交给文本模型做分析 / 纠错。会消耗 token，由前端以显式开关控制（用户同意、可随时关闭）。
#[tauri::command]
pub async fn ai_ocr_enhance(
    app: AppHandle,
    text: String,
    profile_id: Option<String>,
) -> Result<String, String> {
    let profiles = load_profiles(&app);
    let cfg = resolve_profile(&profiles, profile_id);
    if cfg.api_key.trim().is_empty() {
        return Err("未配置 API Key，请先在全局设置 → 模型中填写".to_string());
    }
    let system = "你是一个 OCR 校对与整理助手。下面是一段由光学字符识别（OCR）从图片中提取的文本内容，可能含有错别字、断行错误、漏识别或符号混淆。请在不改变原意与原文语言的前提下：1）修正明显的错别字与识别错误；2）按合理语义补齐全角 / 半角标点与段落；3）保留原有的排版意图（如标题、列表、代码块、表格）。仅输出校对整理后的纯文本，不要添加任何解释、前言或 Markdown 代码围栏。若原文已无误则原样返回。";
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
        let t = resp.text().await.unwrap_or_default();
        return Err(format!(
            "HTTP {}: {}",
            status,
            t.chars().take(300).collect::<String>()
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

/// 将 OCR 源图导出为保留原始版面的 PDF：以原图作为整页背景（图像保真，版面 / 特点 100% 不变），
/// 等比适配 A4。用于「保存为 PDF」功能，使 OCR 结果可像成熟 OCR 产品一样以 PDF 形态交付。
#[tauri::command]
pub fn ocr_export_pdf(path: String, image_base64: String, mime: String) -> Result<(), String> {
    let _ = mime; // 接受但按像素解码，具体格式由图片解码器自动识别
    let b64 = image_base64.split(',').last().unwrap_or(&image_base64);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("图片 base64 解码失败: {}", e))?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("图片解析失败: {}", e))?;
    let (w, h) = img.dimensions();
    // 用 lopdf 内建 embed_image 能力把源图编码为图片 XObject（自动处理色彩空间与压缩）
    let img_stream = lopdf::xobject::image_from(bytes).map_err(|e| format!("图像编码失败: {}", e))?;
    let mut doc = lopdf::Document::new();
    let img_id = doc.add_object(img_stream);

    // 等比适配 A4（595×842pt），保留原始版面比例
    let page_w = 595.0_f64;
    let page_h = 842.0_f64;
    let scale = (page_w / w as f64).min(page_h / h as f64);
    let pw = w as f64 * scale;
    let ph = h as f64 * scale;
    let content = format!("q\n{:.4} 0 0 {:.4} 0 0 cm\n/Im0 Do\nQ\n", scale, scale);
    let content_id = doc.add_object(lopdf::Object::Stream(lopdf::Stream::new(
        lopdf::Dictionary::new(),
        content.into_bytes(),
    )));

    let pages_id = doc.new_object_id();
    let page_id = doc.new_object_id();
    let mut page_dict = lopdf::Dictionary::new();
    page_dict.set("Type", "Page");
    page_dict.set(
        "MediaBox",
        lopdf::Object::Array(vec![
            lopdf::Object::Integer(0),
            lopdf::Object::Integer(0),
            lopdf::Object::Real(pw as f32),
            lopdf::Object::Real(ph as f32),
        ]),
    );
    page_dict.set("Parent", lopdf::Object::Reference(pages_id));
    page_dict.set("Contents", lopdf::Object::Reference(content_id));
    doc.objects.insert(page_id, lopdf::Object::Dictionary(page_dict));
    let _ = doc.add_xobject(page_id, b"Im0", img_id);

    let mut pages_dict = lopdf::Dictionary::new();
    pages_dict.set("Type", "Pages");
    pages_dict.set(
        "Kids",
        lopdf::Object::Array(vec![lopdf::Object::Reference(page_id)]),
    );
    pages_dict.set("Count", lopdf::Object::Integer(1));
    doc.objects.insert(pages_id, lopdf::Object::Dictionary(pages_dict));

    let catalog_id = doc.add_object(lopdf::Object::Dictionary({
        let mut c = lopdf::Dictionary::new();
        c.set("Type", "Catalog");
        c.set("Pages", lopdf::Object::Reference(pages_id));
        c
    }));
    doc.trailer.set("Root", lopdf::Object::Reference(catalog_id));

    doc.save(&path)
        .map_err(|e| format!("保存 PDF 失败: {}", e))?;
    Ok(())
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
    Ok(dir.join("ai_conversations_v2.json"))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: role.to_string(),
            content: content.to_string(),
        }
    }

    // ---------- build_anthropic_messages ----------
    #[test]
    fn anthropic_messages_system_gets_cache_block() {
        let msgs = vec![msg("system", "你是助手"), msg("user", "hi")];
        let out = build_anthropic_messages(&msgs);
        assert_eq!(out.len(), 2);
        // system → block 数组 + cache_control
        assert_eq!(out[0]["role"], "system");
        assert_eq!(out[0]["content"][0]["type"], "text");
        assert_eq!(out[0]["content"][0]["text"], "你是助手");
        assert_eq!(out[0]["content"][0]["cache_control"]["type"], "ephemeral");
        // 非 system → 字符串 content，无 cache_control
        assert_eq!(out[1]["role"], "user");
        assert_eq!(out[1]["content"], "hi");
    }

    #[test]
    fn anthropic_messages_empty_system_content_no_cache() {
        let out = build_anthropic_messages(&[msg("system", "")]);
        assert_eq!(out[0]["content"], "");
        assert!(out[0]["content"].is_string());
    }

    #[test]
    fn anthropic_messages_stable_segment_breakpoint() {
        // n=6 → stable_end=3 → 倒数第 3 条（index 2）加 cache breakpoint
        let msgs = vec![
            msg("system", "sys"),
            msg("user", "u1"),
            msg("assistant", "a1"),
            msg("user", "u2"),
            msg("assistant", "a2"),
            msg("user", "u3"),
        ];
        let out = build_anthropic_messages(&msgs);
        assert_eq!(out.len(), 6);
        assert_eq!(out[0]["content"][0]["cache_control"]["type"], "ephemeral");
        assert_eq!(out[2]["content"][0]["text"], "a1");
        assert_eq!(out[2]["content"][0]["cache_control"]["type"], "ephemeral");
        // 其余保持字符串 content
        assert_eq!(out[1]["content"], "u1");
        assert_eq!(out[3]["content"], "u2");
        assert_eq!(out[4]["content"], "a2");
        assert_eq!(out[5]["content"], "u3");
    }

    #[test]
    fn anthropic_messages_small_history_no_stable_breakpoint() {
        // n=4 → stable_end=0 → 只有 system 带 cache
        let msgs = vec![
            msg("system", "s"),
            msg("user", "u1"),
            msg("assistant", "a1"),
            msg("user", "u2"),
        ];
        let out = build_anthropic_messages(&msgs);
        assert_eq!(out[0]["content"][0]["cache_control"]["type"], "ephemeral");
        assert_eq!(out[1]["content"], "u1");
        assert_eq!(out[2]["content"], "a1");
        assert_eq!(out[3]["content"], "u2");
    }

    #[test]
    fn anthropic_messages_empty_input() {
        assert!(build_anthropic_messages(&[]).is_empty());
    }

    // ---------- 提供商判定 ----------
    #[test]
    fn anthropic_provider_detection() {
        let mut cfg = AiProfile::default();
        cfg.model = "claude-sonnet-4".into();
        cfg.base_url = "https://api.anthropic.com".into();
        assert!(is_anthropic_provider(&cfg));
        // base_url 命中，模型名不命中
        cfg.model = "deepseek-chat".into();
        assert!(is_anthropic_provider(&cfg));
        // 都不命中
        cfg.base_url = "https://api.deepseek.com/v1".into();
        assert!(!is_anthropic_provider(&cfg));
        assert!(is_deepseek_provider(&cfg));
        cfg.base_url = "https://api.anthropic.com".into();
        assert!(!is_deepseek_provider(&cfg));
    }

    // ---------- compose_persona_system ----------
    #[test]
    fn persona_all_empty_returns_empty() {
        assert_eq!(compose_persona_system(&AiProfile::default()), "");
    }

    #[test]
    fn persona_preset_maps_to_description() {
        let mut cfg = AiProfile::default();
        cfg.persona_preset = Some("sharp".into());
        let s = compose_persona_system(&cfg);
        assert!(s.contains("毒舌直率"));
        assert!(s.contains("一针见血"));
    }

    #[test]
    fn persona_unknown_preset_falls_back_to_style() {
        let mut cfg = AiProfile::default();
        cfg.persona_preset = Some("custom".into());
        cfg.persona_style = Some("简洁".into());
        let s = compose_persona_system(&cfg);
        assert!(s.contains("你应遵守以下风格要求：简洁"));
        assert!(!s.contains("毒舌"));
    }

    #[test]
    fn persona_combines_all_parts() {
        let mut cfg = AiProfile::default();
        cfg.persona_preset = Some("gentle".into());
        cfg.persona_style = Some("多举例".into());
        cfg.persona_call_me_as = Some("小安".into());
        cfg.system_prompt = Some("你是助手。".into());
        let s = compose_persona_system(&cfg);
        assert!(s.contains("温柔细致"));
        assert!(s.contains("你应遵守以下风格要求：多举例"));
        assert!(s.contains("你可以称呼我为小安。"));
        assert!(s.contains("你是助手。"));
    }
}
