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
use std::io::BufRead;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use crate::services::mcp_service;
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
    /// 单请求上下文估算上限（token）：Agent 循环据此决定何时压缩 / 何时熔断，
    /// 默认 200k，适配 128k/1M 等不同上下文模型时按需调高（如设为 1000000）。
    #[serde(default)]
    pub max_context_tokens: Option<u64>,
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

    /// Agent 上下文估算上限（token）。未配置时默认 200k —— 兼容旧行为、对多数模型都留足余量。
    fn context_cap(&self) -> usize {
        self.max_context_tokens
            .filter(|v| *v > 0)
            .and_then(|v| usize::try_from(v).ok())
            .unwrap_or(200_000)
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
        max_context_tokens: None,
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

/// 保险性 messages 截断：估算总 token 上界，超过阈值时按「保留首条 system + 最近 N 条」策略裁剪。
///
/// 背景：2026-08 用户截图复现群聊/插件沙箱内 `useAiChat` 上游调用把累计历史全量塞入单请求，
/// 导致 208 万 token 触发上游 1048576 上限。后端统一兜底，所有调用方（主窗口/胶囊/插件沙箱）
/// 自动受保护，避免任一调用方忘了截断就把上游打挂。
///
/// 估算策略（不引第三方 crate，保持零依赖）：
/// - 中文等 CJK 字符：1 字符 ≈ 1 token；其余 ASCII：4 字符 ≈ 1 token。
/// - 用 `字符数 + 字节数/4` 取较大值作保守上界（单条超阈值直接丢弃）。
/// - 总 token 上限 = 200k，远低于模型 1048576 上限，与前端 safeMessages 对齐成双层防御。
fn truncate_messages_for_safety(messages: Vec<ChatMessage>) -> (Vec<ChatMessage>, bool) {
    const PER_MSG_TOKEN_CAP: usize = 6_000; // 单条 >6k token 视为异常（重复拼接/脏数据），整体丢弃
    const TOTAL_TOKEN_CAP: usize = 200_000; // 距 1048576 上限留足余量，绝不允许接近上游硬限制

    // 估算单条 token
    let est = |s: &str| -> usize {
        let chars = s.chars().count();
        let bytes = s.len();
        // 字节数/4 反映 ASCII 词数；字符数反映 CJK 词数；取较大者作保守上界
        std::cmp::max(chars, bytes / 4)
    };

    // 第一遍：单条超 PER_MSG_TOKEN_CAP 的丢掉
    let mut kept: Vec<ChatMessage> = messages
        .into_iter()
        .filter(|m| est(&m.content) <= PER_MSG_TOKEN_CAP)
        .collect();

    // 第二遍：累计 token 超 TOTAL_TOKEN_CAP 时尾部截断（保留首条 system + 最近 N 条）。
    // 为避免依赖 ChatMessage: Clone（结构体未 derive），用索引搬运而非 clone。
    let total: usize = kept.iter().map(|m| est(&m.content)).sum();
    if total <= TOTAL_TOKEN_CAP {
        return (kept, false);
    }

    // 先把首条 system 从 kept 中抽出（若有），其余消息按索引从尾部取能装下的。
    let mut out: Vec<ChatMessage> = Vec::new();
    let first_system_idx = kept.iter().position(|m| m.role == "system");
    if let Some(i) = first_system_idx {
        out.push(kept.remove(i)); // 抽走 system，后续 kept 不再含它
    }
    let mut acc: usize = out.iter().map(|m| est(&m.content)).sum();
    // 从尾部倒序取，直到预算用尽
    while let Some(m) = kept.pop() {
        let t = est(&m.content);
        if acc + t > TOTAL_TOKEN_CAP {
            break;
        }
        out.push(m);
        acc += t;
    }
    // 此时 out = [system?, ...尾部倒序]，恢复成 system 在最前、对话按原序
    // 因尾部是用 pop 倒取，需再 reverse 对话部分（含 system 一起反也无妨，下面修正）
    out.reverse();
    // reverse 后 system 会跑到末尾，重新把它挪回首位
    if let Some(pos) = out.iter().position(|m| m.role == "system") {
        let sys = out.remove(pos);
        out.insert(0, sys);
    }
    (out, true)
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
    // 前端 per-call 注入的 system（如群聊中每位伴侣的独立人设）；传入时优先于全局 AiProfile.persona，合并为其前置段落。
    system: Option<String>,
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
    // 诊断：截断前总字符数（终端可见）。配合前端 safeMessages 的 console.error 双线验证。
    let pre_chars: usize = messages.iter().map(|m| m.content.chars().count()).sum();
    eprintln!(
        "[ai_chat] 收到 request_id={} msgs={} total_chars={}",
        request_id, messages.len(), pre_chars
    );
    // 保险性截断：后端兜底，防止任一调用方（主窗口/胶囊/插件沙箱）传入爆炸的 messages。
    // 估算 token 上界超 200k 时按「保留首条 system + 最近 N 条」裁剪，并 emit 一次警告事件。
    let (messages, truncated) = truncate_messages_for_safety(messages);
    // 终极兜底：即使截断函数被跳过或估算失真，单请求总字符 >2M 直接 fail-fast 拒绝发送
    // （绝不允许 200 万 token 的请求到达上游）。这是字符级硬切，与 token 估算无关。
    const HARD_CHAR_CAP: usize = 2_000_000; // 200 万字符 ≈ 上限 104 万 token，留 50% 余量
    let post_chars: usize = messages.iter().map(|m| m.content.chars().count()).sum();
    if post_chars > HARD_CHAR_CAP {
        let msg = format!(
            "messages 总字符 {} 仍超硬上限 {}，拒绝发送以保护上游",
            post_chars, HARD_CHAR_CAP
        );
        eprintln!("[ai_chat] FATAL: request_id={} {}", request_id, msg);
        let _ = app.emit(
            "ai-error",
            serde_json::json!({ "requestId": request_id, "error": msg }),
        );
        return Err(msg);
    }
    if truncated {
        let kept = messages.len();
        eprintln!(
            "[ai_chat] WARN: messages 超出安全 token 预算，已尾部截断（保留首条 system + 最近 N 条） request_id={} kept={}",
            request_id, kept
        );
        let _ = app.emit(
            "ai-warn",
            serde_json::json!({
                "requestId": request_id,
                "kind": "messages_truncated",
                "kept": kept,
                "hint": "历史过长已被自动截断，可考虑归档旧对话或调小单次请求历史窗口"
            }),
        );
    }
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
    // 前端 per-call system（群聊各伴侣人设 / 单聊注入）前置，全局 persona 紧随其后。
    let effective_system = match (&system, persona.is_empty()) {
        (Some(s), true) => s.clone(),
        (Some(s), false) => format!("{}\n\n{}", s, persona),
        (None, false) => persona,
        (None, true) => String::new(),
    };
    let mut messages_json = messages_json;
    if !effective_system.is_empty() {
        if let Some(first) = messages_json.first_mut() {
            if first.get("role").and_then(|r| r.as_str()) == Some("system") {
                let existing = first.get("content").and_then(|c| c.as_str()).unwrap_or("");
                first["content"] = serde_json::json!(format!("{}\n\n{}", existing, effective_system));
            } else {
                messages_json.insert(0, serde_json::json!({ "role": "system", "content": effective_system }));
            }
        } else {
            messages_json.insert(0, serde_json::json!({ "role": "system", "content": effective_system }));
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

// ============ Agent 能力：工具注册表 + 原生 tool_calls 循环（阶段1） ============
// 借鉴 dsh(deepseek-harness, MIT) 的 core/tools 与 core/agent-loop 设计思路，
// 落地为本项目的 OpenAI 兼容端点实现。与 ai_chat（纯对话流式）互补：
// 不用流式检测 tool_calls（流式分段叠加易碎），改用「非流式判断 → 含 tool_calls
// 则执行并按 role:"tool" 回填重发 → 直到纯文本」。Agent 为增量能力，默认前端不调即不启用，
// ai_chat 行为完全不受影响。

/// 工具执行时的上下文（前端/本轮请求相关），随每一次调用传入 execute。
#[derive(Clone)]
pub struct ToolContext {
    /// 用于发射授权请求等事件（emit ai-agent-approval）。
    pub app: AppHandle,
    /// 本轮请求 id，事件负载中回传，便于前端按请求区分。
    pub request_id: String,
    /// AI 编程面板当前项目根目录（文件工具判“项目内”用）。
    pub project_root: Option<PathBuf>,
}

/// 模型可调用的工具。
/// execute 为异步实现：文件写给项目根外需等待用户授权、命令执行需限时，故在 async 中 await。
/// 阻塞 IO（std::fs / 进程等待）内部用 spawn_blocking，避免卡住 Tokio 运行时。
#[async_trait::async_trait]
pub trait AiTool: Send + Sync {
    fn name(&self) -> &'static str;
    /// OpenAI functions 格式 schema，供 /chat/completions 的 tools 参数。
    fn function_schema(&self) -> serde_json::Value;
    /// 执行工具；args 为模型传入的 JSON 对象，ctx 提供本轮上下文。
    /// 错误以 Err(text) 返回，仍作为 tool 结果回填给模型。
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<String, String>;
}

/// 当前本机时间工具：模型借此把「现在几点/今天日期」这类实时问题交给工具答，避免凭空编造。
struct NowTool;
#[async_trait::async_trait]
impl AiTool for NowTool {
    fn name(&self) -> &'static str {
        "get_current_time"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "获取当前时刻（本机时区）。当用户询问『现在几点』『今天几号』『什么时候了』时调用。",
                "parameters": { "type": "object", "properties": {} }
            }
        })
    }
    async fn execute(&self, _args: &serde_json::Value, _ctx: &ToolContext) -> Result<String, String> {
        Ok(chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string())
    }
}

/// 安全计算器：仅支持数字与 + - * / ( ) 及一元正负号。递归下降求值，杜绝任意代码执行。
struct CalculatorTool;
#[async_trait::async_trait]
impl AiTool for CalculatorTool {
    fn name(&self) -> &'static str {
        "calculator"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "计算数学表达式。仅支持数字与 + - * / 及括号（如 (12.5+7)*3/2）。需要准确算术时调用。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "expression": { "type": "string", "description": "要计算的数学表达式" }
                    },
                    "required": ["expression"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, _ctx: &ToolContext) -> Result<String, String> {
        let expr = args
            .get("expression")
            .and_then(|v| v.as_str())
            .ok_or("缺少 expression 参数")?;
        let mut p = SafeEval { s: expr, pos: 0 };
        let val = p.parse_expr()?;
        p.skip_ws();
        if p.pos < p.s.len() {
            return Err(format!("表达式存在多余字符: '{}'", &p.s[p.pos..]));
        }
        Ok(format!("= {}", val))
    }
}

// ========== Plan / Todo 工具（B 增强：让 Agent 有「可见、可更新」的任务清单） ==========
//
// 目标：模型在展开长任务时，先用 create_plan 确立计划，再按步骤 add_todo，
// 每完成一步 mark_done，让前端（IDE · AI 编程）实时渲染出一块「计划/待办」面板。
// 计划状态保存在本进程静态存储中（单份当前计划），供同进程内数次请求延续；
// 工具结果回传「完整计划渲染」，使模型每一轮都能看到（并据此更新）任务全貌。
//
// 关键：execute 为同步函数，内部用 Mutex 瞬时加锁读写——无跨 await、无死锁风险。

/// 单条待办。
#[derive(Clone, serde::Serialize)]
struct PlanTodo {
    id: String,
    content: String,
    done: bool,
}

/// 当前计划。
#[derive(Clone, serde::Serialize)]
struct Plan {
    title: String,
    next_id: u64,
    todos: Vec<PlanTodo>,
}

/// 全局计划存储：单份「当前计划」，跨请求延续，供 plan 工具读写。
static PLAN_STORE: OnceLock<Mutex<Plan>> = OnceLock::new();
fn plan_store() -> &'static Mutex<Plan> {
    PLAN_STORE.get_or_init(|| Mutex::new(Plan { title: String::new(), next_id: 1, todos: vec![] }))
}

/// 把当前计划渲染为模型可见的文本（含 id，便于调用方按 id 勾选/删除）。
fn render_plan(p: &Plan) -> String {
    if p.todos.is_empty() {
        return if p.title.is_empty() {
            "（当前尚未创建计划）".to_string()
        } else {
            format!("📋 计划「{}」\n（还没有任何待办）", p.title)
        };
    }
    let mut s = format!("📋 计划「{}」", p.title);
    for t in &p.todos {
        let mark = if t.done { "[x]" } else { "[ ]" };
        s.push_str(&format!("\n- {} #{} {}", mark, t.id, t.content));
    }
    s
}

/// Plan / Todo 工具：维护一份「计划 + 待办清单」并实时回传完整状态。
/// 通过 action 参数区分操作；返回完整计划渲染（模型据此继续决策）。
struct PlanTool;
#[async_trait::async_trait]
impl AiTool for PlanTool {
    fn name(&self) -> &'static str {
        "plan"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "管理一份『计划 + 待办清单』。action 取值：create_plan(title) 新建计划；add_todo(content) 追加待办；mark_done(id) 勾选完成；mark_undone(id) 取消勾选；delete_todo(id) 删除待办；list 查看当前计划。每次返回完整计划，便于你据此继续规划。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": { "type": "string", "description": "create_plan / add_todo / mark_done / mark_undone / delete_todo / list" },
                        "title": { "type": "string", "description": "create_plan 时的新计划标题" },
                        "content": { "type": "string", "description": "add_todo 时的待办内容" },
                        "id": { "type": "string", "description": "mark_done / mark_undone / delete_todo 时的待办 id" }
                    },
                    "required": ["action"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, _ctx: &ToolContext) -> Result<String, String> {
        let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("").trim();
        let mut g = plan_store()
            .lock()
            .map_err(|_| "计划存储锁获取失败".to_string())?;
        match action {
            "create_plan" => {
                g.title = args
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未命名计划")
                    .to_string();
                g.next_id = 1;
                g.todos.clear();
            }
            "add_todo" => {
                let content = args
                    .get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if content.trim().is_empty() {
                    return Err("add_todo 缺少 content 参数".to_string());
                }
                let id = g.next_id.to_string();
                g.next_id += 1;
                g.todos.push(PlanTodo { id, content, done: false });
            }
            "mark_done" | "mark_undone" => {
                let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let done = action == "mark_done";
                let mut hit = false;
                for t in g.todos.iter_mut() {
                    if t.id == id {
                        t.done = done;
                        hit = true;
                        break;
                    }
                }
                if !hit {
                    return Err(format!("找不到待办 #{}", id));
                }
            }
            "delete_todo" => {
                let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let before = g.todos.len();
                g.todos.retain(|t| t.id != id);
                if g.todos.len() == before {
                    return Err(format!("找不到待办 #{}", id));
                }
            }
            "list" => {}
            _ => return Err(format!("未知 action: '{}'（可选 create_plan/add_todo/mark_done/mark_undone/delete_todo/list）", action)),
        }
        Ok(render_plan(&g))
    }
}

// ========== 文件读写 / 命令执行 工具（C 增强：让 Agent 能落到真实文件系统与 shell） ==========
//
// 安全边界（按用户授权意图）：
// - read_file：任意路径读取（只读、非破坏），无审批。
// - write_file：目标在项目根目录内 → 直接写；在项目根外 → 交互式审批（ai-agent-approval 事件
//   → 前端弹窗 → 回调 ai_agent_approve），超时未决则视为拒绝。
// - run_command：任意命令，限时 15s、非 shell 中文案，走项目根或 cwd 参数。
// 阻塞 IO 一律 spawn_blocking，符合本仓库「阻塞操作不得占用 Tokio 运行时」约定。

/// 待用户审批的挂起操作。
struct PendingApproval {
    _tool: String,
    _operation: String,
    sender: tokio::sync::oneshot::Sender<bool>,
}

/// 全局审批注册表：approval_id → 挂起操作。ai_agent_approve 从这张表取回发送端并 resolve。
static APPROVAL_STORE: OnceLock<Mutex<std::collections::HashMap<String, PendingApproval>>> = OnceLock::new();
fn approval_store() -> &'static Mutex<std::collections::HashMap<String, PendingApproval>> {
    APPROVAL_STORE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// 发起一次审批：注册挂起操作 → 发射 ai-agent-approval → 等待用户决定（默认 120s 超时拒绝）。
async fn request_approval(ctx: &ToolContext, tool: &str, operation: &str) -> Result<bool, String> {
    let approval_id = format!("ap_{}_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis()).unwrap_or(0), rand_short());
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    approval_store()
        .lock()
        .map_err(|_| "审批存储锁获取失败".to_string())?
        .insert(
            approval_id.clone(),
            PendingApproval { _tool: tool.to_string(), _operation: operation.to_string(), sender: tx },
        );
    let _ = ctx.app.emit(
        "ai-agent-approval",
        serde_json::json!({
            "requestId": ctx.request_id,
            "approvalId": approval_id,
            "tool": tool,
            "operation": operation,
        }),
    );
    match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
        Ok(Ok(true)) => Ok(true),
        Ok(Ok(false)) => Err("用户拒绝了该文件操作".to_string()),
        Ok(Err(_)) => Err("授权通道已关闭".to_string()),
        Err(_) => {
            let _ = approval_store().lock().map(|mut m| m.remove(&approval_id));
            Err("授权请求超时（120s 未确认，已拒绝）".to_string())
        }
    }
}

/// 简短随机串（事件/审批 id 后缀，避免多请求冲突）。
fn rand_short() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    format!("{:08x}", t)
}

/// 判断 target 是否落在 root 之下（对已存在路径 canonicalize；未存在的写目标取其最近存在祖先）：
/// 用于「写文件项目根内直接放行 / 项目根外需审批」的判定。
fn is_under_path(target: &std::path::Path, root: &std::path::Path) -> bool {
    let r = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let norm = target
        .canonicalize()
        .unwrap_or_else(|_| {
            target
                .parent()
                .and_then(|p| p.canonicalize().ok().map(|c| c.join(target.file_name().unwrap_or_default())))
                .unwrap_or_else(|| target.to_path_buf())
        });
    norm.starts_with(&r)
}

/// 受保护路径判定：VCS 目录、依赖目录、密钥/凭据/环境变量文件。
/// 用于写/编辑/删除的「硬拦截」（读取不受限）。命名大小写不敏感（Windows 友好）。
fn protected_path(p: &std::path::Path) -> bool {
    for seg in p.components() {
        if let std::path::Component::Normal(s) = seg {
            let seg = s.to_string_lossy().to_lowercase();
            if seg == ".git" || seg == ".svn" || seg == ".hg" || seg == "node_modules" {
                return true;
            }
        }
    }
    let name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    const SECRETS: &[&str] = &[
        ".env", "id_rsa", "id_ed25519", "id_dsa", "id_ecdsa", "credentials",
        "credentials.json", "credentials.jsonc", ".npmrc", ".pypirc", ".netrc",
        "known_hosts", "authorized_keys", ".bash_history", ".zsh_history", ".gitconfig",
        ".mcp_config.json", "mcp_config.json",
    ];
    SECRETS.contains(&name.as_str()) || name.starts_with(".env.")
}

/// 危险命令兜底黑名单：命中即拒绝（防御纵深；真正的护栏是任意命令限时+审批）。
/// 仅拦截几乎不可能在 agent 里合法出现的破坏性/不可逆操作，避免误伤正常构建命令。
fn command_is_dangerous(cmd: &str) -> bool {
    let c = cmd.to_lowercase();
    const DANGEROUS: &[&str] = &[
        "format c:", "diskpart", "mkfs", "dd if=/dev/zero",
        "shutdown", "reboot", "init 0", "init 6", "poweroff",
        ":(){", "rm -rf / --no-preserve-root", "rm -rf ~/.config",
        "del /s /q /", "rd /s /q /", "git push --force",
    ];
    DANGEROUS.iter().any(|p| c.contains(p))
}

/// 会话级「信任项目」集合：首次在某个项目根内执行写操作时弹窗确认，
/// 通过后本会话内该项目内写文件免单次审批。
static TRUSTED_PROJECTS: OnceLock<Mutex<std::collections::HashSet<std::path::PathBuf>>> = OnceLock::new();
fn trusted_projects() -> &'static Mutex<std::collections::HashSet<std::path::PathBuf>> {
    TRUSTED_PROJECTS.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

/// 首次访问未信任项目 → 弹「信任此项目」确认；通过后记录本会话信任。已信任则直接返回。
async fn ensure_project_trusted(ctx: &ToolContext) -> Result<(), String> {
    let Some(root) = &ctx.project_root else { return Ok(()); };
    let canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    if trusted_projects().lock().map_err(|_| "信任存储锁失败".to_string())?.contains(&canon) {
        return Ok(());
    }
    let ok = request_approval(
        ctx,
        "trust",
        &format!("首次在此项目内写文件，是否信任该目录（本会话内经此确认后，项目内写文件免单次确认）？\n{}", root.display()),
    ).await?;
    if !ok {
        return Err("用户未信任该项目，已拒绝写入".to_string());
    }
    trusted_projects().lock().map_err(|_| "信任存储锁失败".to_string())?.insert(canon);
    Ok(())
}

/// 一次待审阅的暂存编辑。write/edit/delete 先落到该结构（不立即写盘），
/// read_file 会叠加这些暂存生成 overlay 视图（模型能读到改后内容），
/// agent-loop 结束后 emit ai-agent-edits 交由前端审阅，用户确认后才真正写盘。
#[derive(Clone)]
struct PendingEdit {
    id: String,
    action: String, // write / edit / delete
    path: String,
    // write: 新全文；edit: 用于精确定位替换信息（old/new）；delete 无
    new_content: Option<String>,
    old_string: Option<String>,
    new_string: Option<String>,
    order: usize,
}

/// 请求级编辑暂存：request_id → 该请求产出的待审阅编辑（按到达顺序）。
static EDIT_STORE: OnceLock<Mutex<std::collections::HashMap<String, Vec<PendingEdit>>>> = OnceLock::new();
fn edit_store() -> &'static Mutex<std::collections::HashMap<String, Vec<PendingEdit>>> {
    EDIT_STORE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// 记录一次暂存编辑；order 为追加序号，read overlay 与最终落盘都按此顺序重放。
fn record_edit(request_id: &str, mut e: PendingEdit) {
    let mut store = edit_store().lock().unwrap_or_else(|_| {
        // 锁中毒兜底：清空重建，极罕见
        *EDIT_STORE.get_or_init(|| Mutex::new(std::collections::HashMap::new())).lock().expect("edit store lock") = Default::default();
        edit_store().lock().expect("edit store relock")
    });
    let list = store.entry(request_id.to_string()).or_default();
    e.order = list.len();
    list.push(e);
}

/// 把当前磁盘内容叠加该请求所有暂存编辑，重放生成「改后视图」。
/// 返回 (overlay_text, deleted)。若该路径被 <delete> 暂存，deleted=true 且 overlay 为空。
fn apply_pending_overlay(request_id: &str, path: &std::path::Path, base: String) -> Result<(String, bool), String> {
    let store = edit_store().lock().map_err(|_| "编辑存储锁获取失败".to_string())?;
    let Some(list) = store.get(request_id) else {
        return Ok((base, false));
    };
    // 只取作用于同一文件的编辑，按 order 顺序重放
    let mut text = base.clone();
    let mut deleted = false;
    let mut applied = 0usize;
    for e in list {
        if e.path != path.to_string_lossy().as_ref() { continue; }
        match e.action.as_str() {
            "delete" => { deleted = true; text = String::new(); applied += 1; }
            "write" => {
                text = e.new_content.clone().unwrap_or_default();
                deleted = false;
                applied += 1;
            }
            "edit" => {
                let old = e.old_string.clone().unwrap_or_default();
                let new = e.new_string.clone().unwrap_or_default();
                if !old.is_empty() && text.contains(&old) {
                    let all = text.matches(&old).count() > 1;
                    if all {
                        text = text.replace(&old, &new);
                    } else {
                        // 替换首个匹配
                        if let Some(idx) = text.find(&old) {
                            let mut s = String::with_capacity(text.len() + new.len().saturating_sub(old.len()));
                            s.push_str(&text[..idx]);
                            s.push_str(&new);
                            s.push_str(&text[idx + old.len()..]);
                            text = s;
                        }
                    }
                    applied += 1;
                }
            }
            _ => {}
        }
    }
    if deleted {
        Ok((String::new(), true))
    } else if applied > 0 {
        // 追加提示「叠加了 N 条未确认改动」，帮助模型理解这是改后视图
        Ok((format!("{}（已叠加 {} 条待审阅改动，尚未写入磁盘）", text, applied), false))
    } else {
        Ok((text, false))
    }
}

/// 文件工具：read_file（只读，叠加暂存视图）/ write_file（暂存）/ edit（暂存）/ delete（暂存）。
/// 所有写操作先进请求级暂存，经 ai-agent-edits 审阅后才真正落盘；项目根外写入仍先交互审批。
struct FileTool;
#[async_trait::async_trait]
impl AiTool for FileTool {
    fn name(&self) -> &'static str {
        "file"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "读写/编辑/删除文件。action：read_file(path, offset?, limit?) 读取文件内容（任意路径，只读；offset 为起始字符偏移、limit 为字符数，用于大文件分段读取）；write_file(path, content) 整写文件；edit(path, old_string, new_string, occurrences?) 精准补丁——在原文中定位并替换（不重写整个文件；occurrences 省略替换首个、填 all 替换全部，旧文本须可唯一定位）；delete(path) 删除文件。写/删操作不会立即落盘：会先进入待审阅状态，由用户逐条确认后才真正写入磁盘；期间你用 read_file 读到的是叠加了你所有未确认改动后的视图。项目根外的写/删会额外触发交互授权。路径请传绝对路径。改代码优先用 edit，避免整写覆盖遗漏。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": { "type": "string", "description": "read_file / write_file / edit / delete" },
                        "path": { "type": "string", "description": "绝对路径" },
                        "content": { "type": "string", "description": "write_file 时写入的完整内容" },
                        "offset": { "type": "integer", "description": "read_file 时的起始字符偏移（从 0 开始，默认 0）" },
                        "limit": { "type": "integer", "description": "read_file 时的最大字符数（默认 60000）" },
                        "old_string": { "type": "string", "description": "edit 时要在原文中查找的旧文本（须唯一或由 occurrences 指定）" },
                        "new_string": { "type": "string", "description": "edit 时替换成的新文本" },
                        "occurrences": { "type": "string", "description": "edit 时替换数量：省略=首个，all=全部（默认首个）" }
                    },
                    "required": ["action", "path"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<String, String> {
        use tokio::task::spawn_blocking;
        let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("").trim();
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("").trim();
        if path.is_empty() { return Err("file 工具缺少 path 参数".to_string()); }
        let p = std::path::PathBuf::from(path);
        match action {
            "read_file" => {
                // 偏移读取：offset/limit 按字符计，便于大文件分段（dsh 对齐）
                let offset: usize = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                let limit: usize = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(60_000) as usize;
                let overlay_req = ctx.request_id.clone();
                let content = spawn_blocking(move || -> Result<String, String> {
                    let data = std::fs::read(&p).map_err(|e| format!("读取失败 {}: {}", p.display(), e))?;
                    let full = String::from_utf8_lossy(&data).to_string();
                    // 叠加该请求先前的未确认改动，生成「改后视图」（未删除时）
                    let (overlaid, deleted) = apply_pending_overlay(&overlay_req, &p, full).map_err(|e| format!("叠加视图失败: {}", e))?;
                    if deleted {
                        return Ok(format!("（文件 {} 已被本请求暂存删除，尚未提交）", p.display()));
                    }
                    let chars = overlaid.chars().collect::<Vec<_>>();
                    // 偏移取自叠加后内容的开头
                    let total = chars.len();
                    let start = offset.min(total);
                    let end = (start + limit).min(total);
                    let window: String = chars[start..end].iter().collect();
                    let head = if offset > 0 {
                        format!("（已从字符 #{} 开始显示，共 {} 字符）\n", start, total)
                    } else if total > limit {
                        format!("（文件较大，显示前 {} 字符,共 {} 字符；可用 offset 继续读取）\n", limit, total)
                    } else {
                        String::new()
                    };
                    Ok(format!("{}{}", head, window))
                }).await.map_err(|e| format!("读取任务调度失败: {}", e))??;
                Ok(content)
            }
            "write_file" => {
                let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if protected_path(&p) {
                    return Err(format!("拒绝写入受保护路径（密钥/凭据/VCS/依赖目录）: {}", p.display()));
                }
                let under = ctx.project_root.as_ref().map(|r| is_under_path(&p, r)).unwrap_or(false);
                if under {
                    ensure_project_trusted(ctx).await?;
                } else {
                    request_approval(ctx, "file", &format!("写入外部路径: {}", p.display())).await?;
                }
                let edit_id = format!("e_{}_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis()).unwrap_or(0), rand_short());
                record_edit(&ctx.request_id, PendingEdit {
                    id: edit_id,
                    action: "write".to_string(),
                    path: p.to_string_lossy().to_string(),
                    new_content: Some(content.clone()),
                    old_string: None,
                    new_string: None,
                    order: 0,
                });
                Ok(format!("已暂存写入 {}（内容 {} 字符，等用户审阅确认后落盘；可用 read_file 查看改后视图）", p.display(), content.chars().count()))
            }
            "edit" => {
                let old_string = args.get("old_string").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let new_string = args.get("new_string").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if old_string.is_empty() {
                    return Err("edit 缺少 old_string 参数".to_string());
                }
                if protected_path(&p) {
                    return Err(format!("拒绝编辑受保护路径（密钥/凭据/VCS/依赖目录）: {}", p.display()));
                }
                // 写语义与 write_file 一致：项目根内直写、根外审批；首次需信任项目
                let under = ctx.project_root.as_ref().map(|r| is_under_path(&p, r)).unwrap_or(false);
                if under {
                    ensure_project_trusted(ctx).await?;
                } else {
                    request_approval(ctx, "file", &format!("编辑外部路径: {}", p.display())).await?;
                }
                // 暂存前先本地校验 old_string 在「当前叠加视图」中可定位（避免审阅时才发现替换失败）
                let overlay_req = ctx.request_id.clone();
                let p_for_ov = p.clone();
                let wants = old_string.clone();
                let preview_ok = spawn_blocking(move || -> Result<(bool, String), String> {
                    let text = if let Ok(data) = std::fs::read(&p_for_ov) {
                        String::from_utf8_lossy(&data).to_string()
                    } else {
                        String::new()
                    };
                    let (overlaid, _deleted) = apply_pending_overlay(&overlay_req, &p_for_ov, text)?;
                    Ok((overlaid.contains(&wants), overlaid))
                }).await.map_err(|e| format!("校验任务调度失败: {}", e))??;
                if !preview_ok.0 {
                    return Err(format!("old_string 在当前视图不存在，无法定位：{}", old_string));
                }
                let edit_id = format!("e_{}_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis()).unwrap_or(0), rand_short());
                record_edit(&ctx.request_id, PendingEdit {
                    id: edit_id,
                    action: "edit".to_string(),
                    path: p.to_string_lossy().to_string(),
                    new_content: None,
                    old_string: Some(old_string),
                    new_string: Some(new_string),
                    order: 0,
                });
                Ok(format!("已暂存编辑 {}（等用户审阅确认后落盘）", p.display()))
            }
            "delete" => {
                let under = ctx.project_root.as_ref().map(|r| is_under_path(&p, r)).unwrap_or(false);
                if protected_path(&p) {
                    return Err(format!("拒绝删除受保护路径（密钥/凭据/VCS/依赖目录）: {}", p.display()));
                }
                if under {
                    ensure_project_trusted(ctx).await?;
                } else {
                    request_approval(ctx, "file", &format!("删除外部路径: {}", p.display())).await?;
                }
                let edit_id = format!("e_{}_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis()).unwrap_or(0), rand_short());
                record_edit(&ctx.request_id, PendingEdit {
                    id: edit_id,
                    action: "delete".to_string(),
                    path: p.to_string_lossy().to_string(),
                    new_content: None,
                    old_string: None,
                    new_string: None,
                    order: 0,
                });
                Ok(format!("已暂存删除 {}（等用户审阅确认后落盘）", p.display()))
            }
            _ => Err(format!("未知 action: '{}'（可选 read_file/write_file/edit/delete）", action)),
        }
    }
}

/// 命令工具：运行 shell 命令，限时 15s、非交互，返回 stdout/stderr（截断）。
struct CommandTool;
#[async_trait::async_trait]
impl AiTool for CommandTool {
    fn name(&self) -> &'static str {
        "run_command"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "执行 shell 命令并返回输出。非交互。参数：command(必填，要执行的命令)；cwd(可选，工作目录，默认项目根)；timeout(可选，超时秒数，默认15，上限120)。用于运行 git/npm/pnpm/node/脚本等。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "要执行的 shell 命令" },
                        "cwd": { "type": "string", "description": "工作目录（默认项目根目录）" },
                        "timeout": { "type": "integer", "description": "超时秒数（默认15，上限120）" }
                    },
                    "required": ["command"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<String, String> {
        let command = args.get("command").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if command.is_empty() { return Err("run_command 缺少 command 参数".to_string()); }
        if command_is_dangerous(&command) {
            return Err("该命令命中危险操作黑名单（格式化/磁盘/关机/不可逆删除等），已拒绝执行".to_string());
        }
        // timeout：可选超时秒数，默认 15，封顶 120，最小 1
        let timeout_secs: u64 = args.get("timeout")
            .and_then(|v| v.as_u64())
            .map(|t| t.clamp(1, 120))
            .unwrap_or(15);
        let cwd = args.get("cwd").and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty());
        let cwd: Option<std::path::PathBuf> = cwd.map(std::path::PathBuf::from).or_else(|| ctx.project_root.clone());

        // Windows 用 cmd /C，其余平台用 sh -c；由模型提供整条命令。
        let (program, shell_arg): (&str, &str) = if cfg!(windows) {
            ("cmd", "/C")
        } else {
            ("sh", "-c")
        };
        let mut proc = tokio::process::Command::new(program);
        proc.arg(shell_arg).arg(&command);
        if let Some(d) = &cwd { proc.current_dir(d); }
        proc.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());

        let out = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), proc.output()).await;
        let status = out.map_err(|_| format!("命令执行超时（>{}s，已中止）", timeout_secs))?
            .map_err(|e| format!("命令执行失败: {}", e))?;
        let mut text = String::new();
        if !status.stdout.is_empty() {
            text.push_str(&String::from_utf8_lossy(&status.stdout));
        }
        if !status.stderr.is_empty() {
            if !text.is_empty() { text.push('\n'); }
            text.push_str(&String::from_utf8_lossy(&status.stderr));
        }
        const OCAP: usize = 8000;
        let text = if text.chars().count() > OCAP {
            format!("{}（输出过长，已截断）", text.chars().take(OCAP).collect::<String>())
        } else { text };
        if status.status.success() {
            Ok(if text.trim().is_empty() { "（命令成功，无输出）".to_string() } else { text })
        } else {
            Err(format!("命令退出码 {}：{}", status.status.code().unwrap_or(-1), text))
        }
    }
}

/// 极简安全表达式求值器（递归下降）。
struct SafeEval<'a> {
    s: &'a str,
    pos: usize,
}

impl<'a> SafeEval<'a> {
    fn peek(&self) -> Option<char> {
        self.s.get(self.pos..)?.chars().next()
    }
    fn skip_ws(&mut self) {
        while let Some(c) = self.peek() {
            if c.is_ascii_whitespace() {
                self.pos += c.len_utf8();
            } else {
                break;
            }
        }
    }
    fn parse_expr(&mut self) -> Result<f64, String> {
        self.parse_add()
    }
    fn parse_add(&mut self) -> Result<f64, String> {
        let mut v = self.parse_mul()?;
        loop {
            self.skip_ws();
            match self.peek() {
                Some('+') => {
                    self.pos += 1;
                    v += self.parse_mul()?;
                }
                Some('-') => {
                    self.pos += 1;
                    v -= self.parse_mul()?;
                }
                _ => return Ok(v),
            }
        }
    }
    fn parse_mul(&mut self) -> Result<f64, String> {
        let mut v = self.parse_atom()?;
        loop {
            self.skip_ws();
            match self.peek() {
                Some('*') => {
                    self.pos += 1;
                    v *= self.parse_atom()?;
                }
                Some('/') => {
                    self.pos += 1;
                    let d = self.parse_atom()?;
                    if d == 0.0 {
                        return Err("除数为 0".into());
                    }
                    v /= d;
                }
                _ => return Ok(v),
            }
        }
    }
    fn parse_atom(&mut self) -> Result<f64, String> {
        self.skip_ws();
        match self.peek() {
            Some('(') => {
                self.pos += 1;
                let v = self.parse_expr()?;
                self.skip_ws();
                if self.peek() != Some(')') {
                    return Err("缺少右括号".into());
                }
                self.pos += 1;
                Ok(v)
            }
            Some('+') | Some('-') => {
                let sign = if self.peek() == Some('-') { -1.0 } else { 1.0 };
                self.pos += 1;
                Ok(sign * self.parse_atom()?)
            }
            _ => self.parse_number(),
        }
    }
    fn parse_number(&mut self) -> Result<f64, String> {
        self.skip_ws();
        let start = self.pos;
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() || c == '.' {
                self.pos += c.len_utf8();
            } else {
                break;
            }
        }
        let tok = &self.s[start..self.pos];
        if tok.is_empty() {
            return Err("表达式为空".into());
        }
        tok.parse::<f64>()
            .map_err(|_| format!("数字无效: '{}'", tok))
    }
}

// ========== 代码智能 + 扩展 工具（合并 IDE Agent 长处，参照 dsh tool-fs-search 设计） ==========
//
// 保留 Rust function-call 底座，把 IDE Agent 里最有价值的搜索/扩展能力并入：
// - grep：内容搜索，gitignore 感知，pattern/path/include 参数、按文件分组输出、匹配上限兜底（对齐 dsh）
// - glob：文件名搜索，gitignore 感知，pattern/path 参数、按修改时间排序、路径上限兜底（对齐 dsh）
// - mcp：复用本项目 mcp_service，把已配置的 MCP 工具暴露给 Agent（对齐 IDE 的 server+tool+args 范式）
// 三者只读/非破坏，无需交互审批；阻塞 IO 一律 spawn_blocking。

/// 单次 grep 最多保留的行匹配数（对齐 Claude Code GrepTool 默认 head_limit / dsh GREP_MAX_MATCHES）。
const GREP_MAX_MATCHES: usize = 250;
/// 单条匹配行的最大字符数（超出截断，UTF-8 安全）。
const GREP_MAX_LINE_CHARS: usize = 2000;
/// 单次 glob 最多返回路径数（对齐 dsh GLOB_MAX_RESULTS）。
const GLOB_MAX_RESULTS: usize = 100;
/// glob 遍历时顶层的 VCS 元数据目录（对齐 dsh GLOB_VCS_EXCLUDES）。
const GLOB_VCS_EXCLUDES: &[&str] = &[".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];

/// 判断路径是否命中单一 glob：完整路径或仅文件名命中其一即可（align dsh「无分隔符 pattern 匹配任意深度 basename」）。
fn glob_matches(matcher: &globset::GlobMatcher, path: &std::path::Path) -> bool {
    if matcher.is_match(path.to_string_lossy().as_ref()) {
        return true;
    }
    match path.file_name() {
        Some(n) => matcher.is_match(n.to_string_lossy().as_ref()),
        None => false,
    }
}

/// grep：在项目内用正则搜索文件内容，返回匹配行及行号（按文件分组输出）。
struct GrepTool;
#[async_trait::async_trait]
impl AiTool for GrepTool {
    fn name(&self) -> &'static str {
        "grep"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "在项目内用正则表达式搜索文件内容，返回匹配行及行号、按文件分组。gitignore 感知（自动跳过 node_modules/.git 等）。定位关键词/代码时应使用本工具，而非 run_command 'grep'。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "要搜索的正则表达式（regex 语法，如 'fn .*_tool'）" },
                        "path": { "type": "string", "description": "搜索的目标目录或文件，默认当前项目根；相对路径基于项目根解析" },
                        "include": { "type": "string", "description": "仅搜索匹配该单一 glob 的文件（如 '*.ts'、'*.{js,ts}'），不支持逗号列表或取反" }
                    },
                    "required": ["pattern"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<String, String> {
        let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if pattern.is_empty() {
            return Err("grep 缺少 pattern 参数".to_string());
        }
        // 提前校验正则合法性
        regex::Regex::new(&pattern).map_err(|e| format!("正则无效: {}", e))?;
        let root = args
            .get("path").and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .or_else(|| ctx.project_root.clone())
            .ok_or_else(|| "grep 缺少 path，且未提供项目根目录".to_string())?;
        let include = args
            .get("include").and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let matcher = match &include {
            Some(g) => Some(
                globset::GlobBuilder::new(g).literal_separator(false).build()
                    .map_err(|e| format!("include glob 无效: {}", e))?.compile_matcher(),
            ),
            None => None,
        };

        // gitignore 感知遍历 + 逐行正则匹配，全部阻塞 IO → spawn_blocking
        let (matches, truncated) = tokio::task::spawn_blocking(move || -> Result<(Vec<(String, usize, String)>, bool), String> {
            let re = regex::Regex::new(&pattern).map_err(|e| format!("正则无效: {}", e))?;
            let mut out: Vec<(String, usize, String)> = Vec::new();
            let mut truncated = false;
            let mut walk = ignore::WalkBuilder::new(&root);
            walk.standard_filters(true);
            for entry in walk.build().flatten() {
                if out.len() >= GREP_MAX_MATCHES {
                    truncated = true;
                    break;
                }
                if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    continue;
                }
                let fp = entry.path();
                if let Some(m) = &matcher {
                    if !glob_matches(m, fp) {
                        continue;
                    }
                }
                let Ok(file) = std::fs::File::open(fp) else { continue; };
                let mut reader = std::io::BufReader::new(file);
                let mut line_no = 0usize;
                let mut first_read = true;
                let mut tmp: Vec<u8> = Vec::with_capacity(512);
                loop {
                    if out.len() >= GREP_MAX_MATCHES {
                        truncated = true;
                        break;
                    }
                    tmp.clear();
                    let n = reader
                        .read_until(b'\n', &mut tmp)
                        .map_err(|e| format!("读取 {} 失败: {}", fp.display(), e))?;
                    if n == 0 {
                        break;
                    }
                    if first_read {
                        // 二进制探针：首块含 NUL 视为二进制，跳过整文件
                        if tmp.contains(&0) {
                            break;
                        }
                        first_read = false;
                    }
                    line_no += 1;
                    if tmp.last() == Some(&b'\n') {
                        tmp.pop();
                    }
                    if tmp.last() == Some(&b'\r') {
                        tmp.pop();
                    }
                    let line = String::from_utf8_lossy(&tmp);
                    if re.is_match(&line) {
                        let capped: String = line.chars().take(GREP_MAX_LINE_CHARS).collect();
                        out.push((fp.to_string_lossy().to_string(), line_no, capped));
                    }
                }
            }
            if out.len() >= GREP_MAX_MATCHES {
                truncated = true;
            }
            Ok((out, truncated))
        })
        .await
        .map_err(|e| format!("grep 任务调度失败: {}", e))??;

        let count = matches.len();
        if count == 0 {
            return Ok("No matches found".to_string());
        }
        // 按文件分组输出（dsh 约定：每个文件一段，下挂 Line N 行）
        let mut grouped: Vec<(String, Vec<String>)> = Vec::new();
        for (p, ln, line) in &matches {
            match grouped.iter_mut().find(|(k, _)| k == p) {
                Some((_, rows)) => rows.push(format!("Line {}: {}", ln, line)),
                None => grouped.push((p.clone(), vec![format!("Line {}: {}", ln, line)])),
            }
        }
        let mut s = format!("Found {} matches", count);
        if truncated {
            s.push_str(&format!("（已达单次上限 {} 条，结果已截断；请用更精确的 pattern/path/include）", GREP_MAX_MATCHES));
        }
        for (p, rows) in grouped {
            s.push('\n');
            s.push_str(&p);
            s.push('\n');
            s.push_str(&rows.join("\n"));
        }
        Ok(s)
    }
}

/// glob：在项目内按文件名模式搜索文件路径（gitignore 感知、跳过 VCS 目录），按修改时间由新到旧排序。
struct GlobTool;
#[async_trait::async_trait]
impl AiTool for GlobTool {
    fn name(&self) -> &'static str {
        "glob"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "按文件名 glob 模式搜索项目内文件路径（如 '**/*.ts'、'src/**/*.test.*'），返回文件路径列表，按修改时间由新到旧。gitignore 感知并跳过 VCS 目录。模式不含 '/' 时按任意深度 basename 匹配。定位文件用本工具而非 shell find/ls。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "匹配文件路径的 glob 模式（如 '**/*.ts'、'*.tsx'、'src/**/*.go'）" },
                        "path": { "type": "string", "description": "搜索的起始目录，默认当前项目根；相对路径基于项目根解析" }
                    },
                    "required": ["pattern"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<String, String> {
        let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if pattern.is_empty() {
            return Err("glob 缺少 pattern 参数".to_string());
        }
        let matcher = globset::GlobBuilder::new(&pattern).literal_separator(false).build()
            .map_err(|e| format!("glob 模式无效: {}", e))?.compile_matcher();
        let root = args
            .get("path").and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .or_else(|| ctx.project_root.clone())
            .ok_or_else(|| "glob 缺少 path，且未提供项目根目录".to_string())?;

        // 遍历收集命中文件及其修改时间，最后按 mtime 由新到旧排序、取前 N
        let hit: Vec<(PathBuf, std::time::SystemTime)> = tokio::task::spawn_blocking(move || -> Result<Vec<(PathBuf, std::time::SystemTime)>, String> {
            let mut found: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
            let mut walk = ignore::WalkBuilder::new(&root);
            walk.standard_filters(true);
            walk.filter_entry(|e| {
                if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    let n = e.file_name().to_string_lossy();
                    return !GLOB_VCS_EXCLUDES.contains(&n.as_ref());
                }
                true
            });
            for entry in walk.build().flatten() {
                if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    continue;
                }
                let fp = entry.path();
                if !glob_matches(&matcher, fp) {
                    continue;
                }
                let mtime = std::fs::metadata(fp).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                found.push((fp.to_path_buf(), mtime));
            }
            found.sort_by(|a, b| b.1.cmp(&a.1));
            Ok(found)
        })
        .await
        .map_err(|e| format!("glob 任务调度失败: {}", e))??;

        if hit.is_empty() {
            return Ok("No files found".to_string());
        }
        let total = hit.len();
        let truncated = total > GLOB_MAX_RESULTS;
        let mut out: Vec<String> = hit.into_iter().take(GLOB_MAX_RESULTS).map(|(p, _)| p.to_string_lossy().to_string()).collect();
        if truncated {
            out.push(format!("（Showing {} of {} paths；请缩小 pattern 或指定 path 查看更多）", GLOB_MAX_RESULTS, total));
        }
        Ok(out.join("\n"))
    }
}

/// mcp：调用已配置的 MCP 服务器工具。复用 mcp_service::mcp_call_tool（spawn → call → kill）。
/// 服务器 id 见 agent 系统提示注入的 MCP 工具清单；arguments 为该工具输入 schema 对应的 JSON 对象。
struct McpTool;
#[async_trait::async_trait]
impl AiTool for McpTool {
    fn name(&self) -> &'static str {
        "mcp"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "调用已配置的 MCP（Model Context Protocol）服务器工具。server 填服务器 id，tool 填该服务器上的工具原始名，arguments 填工具输入结构对应的 JSON 对象（可省略则传空）。可调用的服务器与工具清单会在本会话系统提示中列出。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "server": { "type": "string", "description": "MCP 服务器 id（系统提示中列出的 id）" },
                        "tool": { "type": "string", "description": "该服务器上的工具原始名" },
                        "arguments": { "type": "object", "description": "工具输入参数 JSON 对象（可选，默认空）" }
                    },
                    "required": ["server", "tool"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<String, String> {
        let server = args.get("server").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let tool_name = args.get("tool").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if server.is_empty() {
            return Err("mcp 缺少 server 参数".to_string());
        }
        if tool_name.is_empty() {
            return Err("mcp 缺少 tool 参数".to_string());
        }
        let arguments = args.get("arguments").cloned().filter(|v| v.is_object()).unwrap_or(serde_json::json!({}));
        // 挂起/异常服务器不应无限阻塞 Agent：整体限时 30s
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            mcp_service::mcp_call_tool(ctx.app.clone(), server.clone(), tool_name.clone(), arguments),
        )
        .await
        .map_err(|_| format!("MCP 调用超时（>30s，已中止）: {}:{}", server, tool_name))?
        .map_err(|e| format!("MCP 调用失败: {}", e))?;
        if !result.ok {
            let detail = result.error.clone().unwrap_or_else(|| "无错误信息".to_string());
            return Err(format!("MCP 工具 {}:{} 返回错误: {}", server, tool_name, detail));
        }
        // 渲染 content 块：text 拼接、image/audio/resource 占位（对齐 dsh extractText）
        let mut parts: Vec<String> = Vec::new();
        for block in &result.content {
            let t = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match t {
                "text" => {
                    if let Some(txt) = block.get("text").and_then(|v| v.as_str()) {
                        parts.push(txt.to_string());
                    }
                }
                "image" => parts.push(format!("[image: {}, 内容已丢弃]", block.get("mimeType").and_then(|v| v.as_str()).unwrap_or("unknown"))),
                "audio" => parts.push(format!("[audio: {}, 内容已丢弃]", block.get("mimeType").and_then(|v| v.as_str()).unwrap_or("unknown"))),
                "resource" | "resource_link" => parts.push("[resource: 内容已丢弃]".to_string()),
                _ => {}
            }
        }
        if parts.is_empty() {
            return Ok(format!("（MCP 工具 {}:{} 返回空内容）", server, tool_name));
        }
        Ok(parts.join("\n"))
    }
}

/// 当前注册的全部工具（有序数组）。
fn registered_tools() -> Vec<Box<dyn AiTool>> {
    vec![
        Box::new(NowTool),
        Box::new(CalculatorTool),
        Box::new(PlanTool),
        Box::new(FileTool),
        Box::new(CommandTool),
        Box::new(GrepTool),
        Box::new(GlobTool),
        Box::new(McpTool),
    ]
}

/// 聚合已启用 MCP 服务器的工具清单，作为 guide 注入 agent 系统提示，让模型知道 mcp 工具可调用什么。
/// 任一个服务器 list_tools 失败都静默降级（mcp_list_all_tools 内部已捕获）；整体限时 5s 防挂起。
async fn mcp_tools_guide(app: &AppHandle) -> String {
    let list = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        mcp_service::mcp_list_all_tools(app.clone()),
    )
    .await
    .unwrap_or_else(|_| Ok(Vec::new()))
    .unwrap_or_default();
    if list.is_empty() {
        return String::new();
    }
    let mut s = String::from("\n\n可用 MCP 工具（用 mcp 工具调用，server 填服务器 id；arguments 按工具输入结构传 JSON）：");
    for (id, name, tools) in list {
        let names: Vec<String> = tools.iter().map(|t| t.name.clone()).collect();
        s.push_str(&format!("\n- [{}] {}：{}", id, name, names.join(", ")));
    }
    s
}

/// 读取项目级「记忆/原则/工程契约」注入 Agent 上下文（对齐 IDE runAgent 的约定）：
/// - 记忆/当日.md（今日不存在则取 记忆/ 目录下按文件名字典序最近一份 .md）
/// - 原则/原则.md
/// - 工程契约：AGENTS.md / CLAUDE.md / .cursorrules / GEMINI.md（取首个存在者）
/// 仅读、仅在项目根内、各段有长度裁剪，避免上下文膨胀。
async fn agent_memory_context(project_root: Option<&std::path::Path>) -> String {
    use std::path::Path;
    let Some(root) = project_root else { return String::new(); };
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let root_c = root.to_path_buf();
    let (mem, prin, contract) = tokio::task::spawn_blocking(move || {
        let read_top = |p: &Path, cap: usize| -> Option<String> {
            std::fs::read_to_string(p).ok().map(|s| truncate_str(s, cap))
        };
        // 今日记忆；不存在则取目录下最近一份 .md（文件名升序取末个）
        let mem = read_top(&root_c.join("记忆").join(format!("{}.md", today)), 9000).or_else(|| {
            let mem_dir = root_c.join("记忆");
            let mut names: Vec<String> = Vec::new();
            if let Ok(rd) = std::fs::read_dir(&mem_dir) {
                for e in rd.flatten() {
                    let p = e.path();
                    if p.extension().map(|x| x == "md").unwrap_or(false) {
                        if let Some(n) = p.file_name().map(|n| n.to_string_lossy().to_string()) {
                            names.push(n);
                        }
                    }
                }
            }
            names.sort();
            names.last().and_then(|n| read_top(&mem_dir.join(n), 9000))
        });
        let prin = read_top(&root_c.join("原则").join("原则.md"), 6000);
        let contract = ["AGENTS.md", "CLAUDE.md", ".cursorrules", "GEMINI.md"]
            .iter()
            .find_map(|c| read_top(&root_c.join(c), 8000));
        (mem, prin, contract)
    })
    .await
    .unwrap_or_default();
    let mut s = String::new();
    if let Some(m) = mem {
        s.push_str(&format!("\n\n【今日/最近项目记忆】\n{}\n", m));
    }
    if let Some(p) = prin {
        s.push_str(&format!("\n【项目原则】\n{}\n", p));
    }
    if let Some(c) = contract {
        s.push_str(&format!("\n【项目工程契约】\n{}\n", c));
    }
    s
}

/// 按字符数截断到上限（UTF-8 安全），过长加省略标记。
fn truncate_str(s: String, cap: usize) -> String {
    if s.chars().count() <= cap {
        s
    } else {
        let t: String = s.chars().take(cap).collect();
        format!("{}…（过长已截断）", t)
    }
}

/// 粗估一组消息的 token 用量（启发式：字符数/2 + 每条消息固定开销）。仅用于触发/熔断阈值，无需精确。
fn estimate_tokens(msgs: &[serde_json::Value]) -> usize {
    let mut chars = 0usize;
    let mut count = 0usize;
    for m in msgs {
        count += 1;
        if let Some(c) = m.get("content").and_then(|c| c.as_str()) {
            chars += c.chars().count();
        }
    }
    chars / 2 + count * 3
}

/// 估算工具定义（tools 数组）的固定开销 token —— 它对每个请求都会发送，
/// 不计入会低估真实发送量，进而在工具增多时逼近上游硬限制。
fn estimate_tools_tokens(tools: &[serde_json::Value]) -> usize {
    let mut chars = 0usize;
    for t in tools {
        if let Some(s) = serde_json::to_string(t).ok() {
            chars += s.chars().count();
        }
    }
    chars / 2 + tools.len() * 4
}

// ============ 事件溯源会话模型（对齐 dsh 的 append-only Session + surface 派生） ============
// 核心思想：Agent 的交互历史不直接存成「消息数组」，而是维护一份**只追加（append-only）的事件日志**，
// LLM 请求所需的 messages 每次都从日志**派生（derive）**。这样：
//   - 日志只存不回改 → 审计、精确重放每一轮工具调用边界；
//   - 上下文压缩通过追加一条 `Compact` 事件做 **replace 遮蔽**（不删除原始事件），
//     到 high 阈值时用摘要替换被遮蔽段落，短尾保留最新回合；
//   - 会话末尾若出现「assistant 声称调用了工具但缺对应 Tool 事件」（中断），
//     派生时自动补齐 `TOOL_OUTCOME_UNKNOWN` 恢复消息，避免模型盲目重试副作用操作。
// 本阶段（A：循环内事件化）不改前后端契约：前端仍发全量 messages，后端先落日志再改造成事件，
// 值即事件化 + 遮蔽压缩 + 中断修复 + 审计落盘。

/// 会话日志中的一条事件。所有变体都是「发生过的一次事实」，只追加、不原地修改。
#[derive(Debug, Clone, Serialize, Deserialize)]
enum SessionEvent {
    /// 用户回合（初始历史中的 user 消息，或后续多轮追加的用户新指令）。
    User {
        seq: u64,
        content: String,
    },
    /// 模型回合（可能携带工具请求）。`tool_calls` 采用 OpenAI 原生形状 `[{id,type,function:{name,arguments}}]`。
    Assistant {
        seq: u64,
        content: String,
        tool_calls: Vec<serde_json::Value>,
    },
    /// 一条工具结果，通过 `call_id` 与之对应的 assistant 请求配对。
    Tool {
        seq: u64,
        call_id: String,
        name: String,
        ok: bool,
        content: String,
    },
    /// 压缩检查点（replace 遮蔽）：`summary` 是早期回合的摘要求，`shadow_until=<seq>` 表示
    /// seq ≤ 该值的旧事件被遮蔽、不再进入派生（但日志中仍保留，可审计）。
    Compact {
        seq: u64,
        summary: String,
        shadow_until: u64,
    },
    /// 中断修复：assistant 请求了工具但日志里始终没有对应 Tool 结果。
    Interrupted {
        seq: u64,
        call_id: String,
        content: String,
    },
}

/// 一次 Agent 会话的事件日志。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct EventSession {
    id: String,
    created_at: String,
    /// 当前事件序号（严格递增；等价于事件数组长度，但显式记录更稳健）。
    seq: u64,
    events: Vec<SessionEvent>,
}

impl EventSession {
    /// 新建空会话，会话 ID = request_id（本阶段后端独有，不改前端契约）。
    fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            created_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            seq: 0,
            events: Vec::new(),
        }
    }

    fn push(&mut self, mut ev: SessionEvent) {
        // 为事件补齐递增序号（Compact/Interrupted 之外的事件无官方来源，统一在此赋 seq）
        if let Some(s) = ev_seq_mut(&mut ev) {
            *s = self.seq;
            self.seq += 1;
        }
        self.events.push(ev);
    }
}

/// 若事件带 `seq` 字段，返回其可变引用（Compact/Interrupted 无则 None）。
fn ev_seq_mut(ev: &mut SessionEvent) -> Option<&mut u64> {
    let seq = match ev {
        SessionEvent::User { seq, .. }
        | SessionEvent::Assistant { seq, .. }
        | SessionEvent::Tool { seq, .. } => seq,
        _ => return None,
    };
    Some(seq)
}

/// 派生该会话当前应发送给 LLM 的 messages 数组，前面外挂 system。
/// - 找到最新（且仍生效）的 Compact 事件，得到 `shadow_until`；
/// - 遍历事件：seq ≤ shadow_until 的被遮蔽跳过，并把摘要插到遮蔽段的开头；
/// - 若 assistant 带 tool_calls 但缺对应 Tool 结果，补一条 TOOL_OUTCOME_UNKNOWN 恢复消息。
fn derive_messages(session: &EventSession, system: &str, extra_repairs: Vec<SessionEvent>) -> Vec<serde_json::Value> {
    // 第一遍：定位最新 Compact 的遮蔽边界（append-only 下最新 Compact `shadow_until` 覆盖更早段落）。
    let mut shadow_until = 0u64;
    let mut summary: Option<String> = None;
    for ev in &session.events {
        if let SessionEvent::Compact { shadow_until: su, summary: sm, .. } = ev {
            shadow_until = *su;
            summary = Some(sm.clone());
        }
    }

    // 把待派生的全部事件（原日志 + 额外修复）按 seq 排序合并，Append-only 保证大部分已有序。
    let mut all: Vec<SessionEvent> = session.events.clone();
    all.extend(extra_repairs);

    let mut out = vec![serde_json::json!({ "role": "system", "content": system })];
    let mut inserted_summary = false;
    for ev in all {
        match &ev {
            // 用户回合直接派生为 role:"user"（遮蔽时同样跳过并插入摘要）。
            SessionEvent::User { seq, content } => {
                if *seq <= shadow_until {
                    if !inserted_summary {
                        if let Some(s) = &summary {
                            out.push(serde_json::json!({ "role": "user", "content": s.clone() }));
                        }
                        inserted_summary = true;
                    }
                    continue;
                }
                out.push(serde_json::json!({ "role": "user", "content": content }));
            }
            SessionEvent::Assistant { seq, content, tool_calls } => {
                if *seq <= shadow_until {
                    // 被遮蔽 → 在其开头插入一次摘要（只插一次）
                    if !inserted_summary {
                        if let Some(s) = &summary {
                            out.push(serde_json::json!({ "role": "user", "content": s.clone() }));
                        }
                        inserted_summary = true;
                    }
                    continue;
                }
                let mut m = serde_json::json!({ "role": "assistant", "content": content });
                if !tool_calls.is_empty() {
                    m["tool_calls"] = serde_json::Value::Array(tool_calls.clone());
                }
                out.push(m);
            }
            SessionEvent::Tool { seq, call_id, ok, content, .. } => {
                if *seq <= shadow_until {
                    continue;
                }
                // 失败时前置 "Error: "（对齐 Claude Code 工具错误回填约定）让模型感知失败
                let c = if *ok { content.clone() } else { format!("Error: {}", content) };
                out.push(serde_json::json!({ "role": "tool", "tool_call_id": call_id, "content": c }));
            }
            SessionEvent::Compact { .. } => { /* 压缩检查点本身不产生消息，仅作为遮蔽边界 */ }
            SessionEvent::Interrupted { seq, call_id, content, .. } => {
                if *seq <= shadow_until {
                    continue;
                }
                out.push(serde_json::json!({ "role": "tool", "tool_call_id": call_id, "content": content }));
            }
        }
    }
    out
}

/// 对一条 append-only 会话做 **replace 遮蔽式压缩**：估算超阈值时，把「保留尾部之外」的历史事件
/// 压成一条摘要 `Compact` 事件追加进日志；其 `shadow_until` 遮蔽被压缩段落。
/// 注意：**不从日志删除**任何事件 —— 之所以能达到省 token 的目的，是因为派生（derive）只发送
/// 未被遮蔽的事件给 LLM；真正要控制的成本是「发送过去的 token」，而不是内存条数。
/// 而日志保持 append-only，正好满足审计与精确重放。返回是否发生了压缩。
fn maybe_compress_session(session: &mut EventSession, high: usize, keep_tail: usize) -> bool {
    let msg_est = estimate_tokens(&derive_messages(session, "", Vec::new()));
    if msg_est < high {
        return false;
    }
    let n = session.events.len();
    if n <= keep_tail + 2 {
        return false; // 事件太少，无需压缩
    }
    let end = n - keep_tail;
    let mut sum = String::from("【早期上下文已压缩为以下已完成工具回合的摘要，供你在此基础上延续任务】");
    let mut shadow_until = 0u64;
    for ev in &session.events[..end] {
        match ev {
            SessionEvent::User { seq, content } => {
                shadow_until = shadow_until.max(*seq);
                let cont: String = content.chars().take(60).collect();
                if !cont.is_empty() {
                    sum.push_str(&format!("\n  · 用户指令：{}", cont));
                }
            }
            SessionEvent::Assistant { seq, content, tool_calls } => {
                shadow_until = shadow_until.max(*seq);
                let names: Vec<String> = tool_calls
                    .iter()
                    .filter_map(|c| c["function"]["name"].as_str().map(String::from))
                    .collect();
                let cont: String = content.chars().take(60).collect();
                if !names.is_empty() {
                    sum.push_str(&format!("\n  · 调用工具：[{}] {}", names.join(", "), cont));
                } else if !cont.is_empty() {
                    sum.push_str(&format!("\n  · 内容：{}", cont));
                }
            }
            SessionEvent::Tool { seq, content, name, .. } => {
                shadow_until = shadow_until.max(*seq);
                let len = content.chars().count();
                let head: String = content.chars().take(90).collect();
                sum.push_str(&format!("\n  · 工具 `{}` 返回（{} 字）：{}", name, len, head));
            }
            SessionEvent::Compact { seq, .. } | SessionEvent::Interrupted { seq, .. } => {
                shadow_until = shadow_until.max(*seq);
            }
        }
    }
    session.push(SessionEvent::Compact {
        seq: session.seq, // push() 会覆盖 seq，此处字段仍以 push 赋值为准
        summary: sum,
        shadow_until,
    });
    true
}

/// 检查会话：对「assistant 带了 tool_calls 但缺对应 Tool 结果」的调用补齐恢复消息。
/// 返回需并入派生的 Interrupted 事件（不改写日志，仅在本次派生时补充）。
fn collect_interrupted_tools(session: &EventSession) -> Vec<SessionEvent> {
    let mut requested: Vec<(u64, String)> = Vec::new();
    let mut have_results: std::collections::HashSet<String> = std::collections::HashSet::new();
    for ev in &session.events {
        match ev {
            SessionEvent::Assistant { seq, tool_calls, .. } => {
                for c in tool_calls {
                    if let Some(id) = c["id"].as_str() {
                        requested.push((*seq, id.to_string()));
                    }
                }
            }
            SessionEvent::Tool { call_id, .. } => {
                have_results.insert(call_id.clone());
            }
            _ => {}
        }
    }
    let mut repairs = Vec::new();
    for (owner_seq, cid) in requested {
        if !have_results.contains(&cid) {
            repairs.push(SessionEvent::Interrupted {
                seq: owner_seq,
                call_id: cid.clone(),
                content: "The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.".to_string(),
            });
        }
    }
    repairs
}

/// plan 工具执行后，返回当前计划的结构化快照（供前端渲染计划/待办面板）。
fn plan_snapshot_json() -> serde_json::Value {
    if let Ok(g) = plan_store().lock() {
        serde_json::to_value(&*g).unwrap_or_default()
    } else {
        serde_json::Value::Null
    }
}

/// 统一发送 ai-error 事件 + 返回错误消息。
fn emit_agent_error(app: &AppHandle, request_id: &str, msg: &str) {
    let _ = app.emit("ai-error", serde_json::json!({ "requestId": request_id, "error": msg }));
}

/// 工具结果修剪器：超大工具输出（如 grep 命中大量内容、read 大文件）全量写入日志会拉升
/// 后续每轮真实发送量。入事件前按长度截断，保留头尾 + 长度标注，控制上下文成本。
/// 仅作用于入日志的 Tool.content；前端展示仍用完整 detail（emit 未走此函数）。
const TOOL_RESULT_HEAD: usize = 4_000; // 保留前 4k 字符
const TOOL_RESULT_TAIL: usize = 1_000; // 保留尾 1k 字符
fn trim_tool_result(content: &str) -> String {
    let total = content.chars().count();
    if total <= TOOL_RESULT_HEAD + TOOL_RESULT_TAIL {
        return content.to_string();
    }
    let head: String = content.chars().take(TOOL_RESULT_HEAD).collect();
    let tail: String = content.chars().skip(total - TOOL_RESULT_TAIL).collect();
    format!("{}…[中间 {} 字已省略以实现上下文控制]…{}", head, total - TOOL_RESULT_HEAD - TOOL_RESULT_TAIL, tail)
}

/// 把一次 Agent 会话的事件日志落盘到 app_data_dir/ai_sessions/<request_id>.json。
/// append-only 快照：既做审计、也供 crash-resume 精确重放。
fn persist_agent_session(app: &AppHandle, session: &EventSession) {
    let dir = app.path().app_data_dir();
    let Ok(dir) = dir else { return };
    let sessions_dir = dir.join("ai_sessions");
    let _ = fs::create_dir_all(&sessions_dir);
    let file = sessions_dir.join(format!("{}.json", session.id));
    if let Ok(json) = serde_json::to_string_pretty(session) {
        let _ = fs::write(file, json);
    }
}

/// 若磁盘上已有同名 request_id 的事件日志（此前崩溃或上一轮正常结束），加载它作为续接基础；
/// 否则返回一个全新的空会话。这样前端只需沿用同一会话 id 再次请求，即可自动“续聊”。
fn load_agent_session(app: &AppHandle, id: &str) -> Option<EventSession> {
    let dir = app.path().app_data_dir().ok()?;
    let file = dir.join("ai_sessions").join(format!("{}.json", id));
    let Ok(text) = fs::read_to_string(file) else { return None };
    serde_json::from_str(&text).ok()
}

/// 把最终文本按「换行 / 最长 ~96 字符」切成增量块，推给前端保持近似逐字流式观感。字符级安全（不切 UTF-8）。
fn split_deltas(text: &str) -> Vec<String> {
    const MAX: usize = 96;
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    for c in text.chars() {
        cur.push(c);
        if c == '\n' || cur.chars().count() >= MAX {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Agent 对话：原生 tool_calls + 循环。
/// 流程：非流式请求（带 tools）→ 若返回 message.tool_calls →
///   顺序执行工具 → 追加 assistant(含 tool_calls) + 若干 role:"tool" 消息 → 重发 → 重复
///   → 直到返回纯文本内容，将其作为 ai-delta 分块推给前端，ai-done 收尾。
/// 事件（payload 含 requestId 便于前端多请求区分）：
///   - ai-agent-step { requestId, stage:"tool", name, ok, detail }  工具调用/结果（供前端透传展示）
///   - ai-delta / ai-done / ai-error   与 ai_chat 一致
#[tauri::command]
pub async fn ai_chat_agent(
    app: AppHandle,
    request_id: String,
    messages: Vec<ChatMessage>,
    profile_id: Option<String>,
    system: Option<String>,
    max_rounds: Option<u32>,
    project_root: Option<String>,
) -> Result<(), String> {
    let max_rounds = max_rounds.unwrap_or(4).clamp(1u32, 12u32);
    let profiles = load_profiles(&app);
    let cfg = resolve_profile(&profiles, profile_id);
    if cfg.api_key.trim().is_empty() {
        let msg = "未配置 API Key，请先在全局设置 → 模型 中填写".to_string();
        emit_agent_error(&app, &request_id, &msg);
        return Err(msg);
    }

    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let (messages, _truncated) = truncate_messages_for_safety(messages);

    // system：人设 + 前端 per-call（与 ai_chat 同规则），并追加 agent 工具使用提示。
    let persona = compose_persona_system(&cfg);
    let effective_system = match (&system, persona.is_empty()) {
        (Some(s), true) => s.clone(),
        (Some(s), false) => format!("{}\n\n{}", s, persona),
        (None, false) => persona,
        (None, true) => String::new(),
    };
    let agent_hint = "你被允许并且应当在合适时调用下方提供的工具来获取实时信息或完成计算。需要时先调用工具，拿到结果后再组织最终回答；不要编造工具返回的数据。";
    // 注入已启用 MCP 服务器的工具清单，让模型的 mcp 工具可正确填写 server/tool
    let mcp_guide = mcp_tools_guide(&app).await;
    // 注入项目级记忆/原则/工程契约（对齐 IDE 约定），仅读、限长
    let project_root_pb = project_root.filter(|s| !s.trim().is_empty()).map(PathBuf::from);
    let mem_ctx = agent_memory_context(project_root_pb.as_deref()).await;
    let base_system = if effective_system.trim().is_empty() {
        agent_hint.to_string()
    } else {
        format!("{}\n\n{}", effective_system, agent_hint)
    };
    let system_final = format!("{}{}{}", base_system, mcp_guide, mem_ctx);

    let tools: Vec<serde_json::Value> = registered_tools().iter().map(|t| t.function_schema()).collect();
    let client = reqwest::Client::new();
    // 本轮工具上下文：文件工具靠 project_root 判“项目内”，命令默认 cwd、审批事件靠 app/request_id 回发
    let tool_ctx = ToolContext {
        app: app.clone(),
        request_id: request_id.clone(),
        project_root: project_root_pb,
    };
    let mut final_text = String::new();
    let mut tool_calls_occurred = false;

    // 事件溯源会话：request_id 即会话 id。
    //   - 若磁盘已有同名日志（崩溃恢复 / 上一轮续聊）→ 加载为续接基础，仅把本轮新消息（不含 system）追加；
    //   - 否则全新会话 → 把前端传入的环境之外历史（user/assistant 文本）作为初始事件灌入。
    // 此后每一轮模型回合 / 工具结果都以事件追加，LLM 消息每次由 derive 派生。
    let mut session = match load_agent_session(&app, &request_id) {
        Some(mut old) => {
            // 续接：追加新 user 指令即可；旧历史已在日志里，无需也不可能重复灌入。
            for m in &messages {
                if m.role == "system" {
                    continue;
                }
                if m.role == "user" {
                    old.push(SessionEvent::User {
                        seq: 0, // push() 会覆写
                        content: m.content.clone(),
                    });
                }
            }
            old
        }
        None => {
            let mut fresh = EventSession::new(&request_id);
            for m in &messages {
                if m.role == "system" {
                    continue;
                }
                // 严格按角色分流：user 落 User 事件、assistant 落 Assistant 事件，杜绝角色混淆。
                match m.role.as_str() {
                    "user" => fresh.push(SessionEvent::User {
                        seq: 0, // push() 会覆写
                        content: m.content.clone(),
                    }),
                    _ => fresh.push(SessionEvent::Assistant {
                        seq: 0, // push() 会覆写
                        content: m.content.clone(),
                        tool_calls: Vec::new(),
                    }),
                }
            }
            fresh
        }
    };

    for _round in 0..max_rounds {
        // 熔断阈值随模型档案可配置：未配置则沿用旧默认（high=36k / hard=96k）。
        // 对 1M/128k 等大上下文模型调高 profile.max_context_tokens 即可放宽，不再一刀切。
        // 统一按档案换算、不按模型类别分档：因为我们 AI 路由统一且 profile 已足够完备。
        let cap = cfg.context_cap();
        let token_high = (cap / 5).max(8_000);       // 估算 token 达到即压缩
        let token_hard = (cap / 2).min(cap).max(16_000); // 压缩后仍超 → 熔断终止

        // 上下文压缩：replace 遮蔽式（append-only，不删事件），早期回合压成摘要。
        let compressed = maybe_compress_session(&mut session, token_high, 8);
        if compressed {
            let _ = app.emit("ai-agent-step", serde_json::json!({
                "requestId": request_id, "stage": "compress", "name": "context", "ok": true,
                "detail": "早期工具回合已压缩为摘要，历史保持可用",
            }));
        }
        // 派生当次请求的 messages（含中断工具恢复；纯文本系统已并入 system_final）。
        let derived = derive_messages(&session, &system_final, collect_interrupted_tools(&session));
        // 真实发送量 = 派生消息 + 工具定义固定开销（tools 每请求都携带，必须计入，
        // 否则工具增多时会低估实际上下文、逼近上游硬限制）。
        let fixed_overhead = estimate_tools_tokens(&tools);
        if estimate_tokens(&derived) > token_hard || estimate_tokens(&derived) + fixed_overhead > cap {
            let msg = format!("上下文超限（估算 >{} token，尝试压缩后仍超出），已终止本轮", token_hard);
            emit_agent_error(&app, &request_id, &msg);
            return Err(msg);
        }
        let mut body = serde_json::json!({
            "model": cfg.model,
            "messages": derived,
            "stream": false,
            "tools": tools,
            "tool_choice": "auto",
        });
        let thinking = cfg.thinking.unwrap_or(false);
        if thinking {
            body["reasoning_effort"] = serde_json::json!("high");
            if is_deepseek_provider(&cfg) {
                body["thinking"] = serde_json::json!({ "type": "enabled" });
            }
        } else {
            body["temperature"] = serde_json::json!(cfg.temperature);
            if let Some(mt) = cfg.max_tokens {
                body["max_tokens"] = serde_json::json!(mt);
            }
        }

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
                emit_agent_error(&app, &request_id, &msg);
                return Err(msg);
            }
        };
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            let msg = format!("HTTP {}: {}", status, text);
            emit_agent_error(&app, &request_id, &msg);
            return Err(msg);
        }
        let payload: serde_json::Value = resp.json().await.map_err(|e| format!("解析响应失败: {}", e))?;
        if let Some(err) = payload.get("error") {
            let msg = format!("上游报错: {}", err);
            emit_agent_error(&app, &request_id, &msg);
            return Err(msg);
        }
        let msg_obj = payload["choices"][0]["message"].clone();
        let content = msg_obj
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();

        // 含工具调用 → 执行并回填，进入下一轮。
        if let Some(calls) = msg_obj.get("tool_calls").and_then(|c| c.as_array()) {
            if calls.is_empty() {
                if !content.is_empty() {
                    final_text.push_str(&content);
                }
                break;
            }
            tool_calls_occurred = true;
            // 模型回合：记录 assistant 事件（含原生 tool_calls 形状）。
            session.push(SessionEvent::Assistant {
                seq: 0, // push() 会覆写
                content: content.clone(),
                tool_calls: msg_obj["tool_calls"].as_array().cloned().unwrap_or_default(),
            });

            for call in calls {
                let cid = call.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let fname = call["function"]["name"].as_str().unwrap_or("").to_string();
                let arguments = call["function"]["arguments"].as_str().unwrap_or("");
                let found = registered_tools().into_iter().find(|t| t.name() == fname);
                let (ok, detail) = match found {
                    None => (false, format!("未知工具: {}", fname)),
                    Some(tool) => {
                        // 宽松解析参数：部分模型返回非标准/截断 JSON → 降级为 error 回填给模型。
                        let args: serde_json::Value =
                            serde_json::from_str(arguments).unwrap_or_else(|_| serde_json::json!({}));
                        match tool.execute(&args, &tool_ctx).await {
                            Ok(r) => (true, r),
                            Err(e) => (false, e),
                        }
                    }
                };
                let _ = app.emit(
                    "ai-agent-step",
                    serde_json::json!({
                        "requestId": request_id,
                        "stage": "tool",
                        "name": fname,
                        "ok": ok,
                        "detail": detail,
                        // plan 工具执行后附带当前计划结构化快照，供前端渲染计划/待办面板
                        "plan": if fname == "plan" { plan_snapshot_json() } else { serde_json::Value::Null },
                    }),
                );
                // 工具结果：记录 Tool 事件（仅日志事实，不携带角色字段——由 derive 统一派生成 role:"tool"）。
                // 入日志前经过修剪器控制上下文成本；前端展示仍用完整 detail。
                session.push(SessionEvent::Tool {
                    seq: 0, // push() 会覆写
                    call_id: cid.clone(),
                    name: fname.clone(),
                    ok,
                    content: trim_tool_result(&detail),
                });
            }
            // 崩溃恢复：每轮工具结果落地即持久化一次，进程在中途被杀也能从那轮续拉。
            persist_agent_session(&app, &session);
            continue;
        }

        // 纯文本 → 最终回答。
        final_text.push_str(&content);
        break;
    }

    // 达到最大轮数仍停在工具调用且无最终内容 → 给出收敛提示而非静默。
    if final_text.trim().is_empty() {
        final_text = if tool_calls_occurred {
            format!("（已达单次请求最大工具轮数 {}，我暂停以避免失控。你可以继续让我往下做。）", max_rounds)
        } else {
            "[Agent 未返回内容]".to_string()
        };
    }

    for chunk in split_deltas(&final_text) {
        let _ = app.emit("ai-delta", serde_json::json!({ "requestId": request_id, "delta": chunk }));
    }
    // agent-loop 结束后，把该请求所有暂存编辑发往前端审阅（前端逐个保留/撤销，经 ai_agent_apply_edits 落盘）
    let staged = {
        let store = edit_store().lock().map_err(|_| "编辑存储锁获取失败".to_string())?;
        store.get(&request_id).cloned().unwrap_or_default()
    };
    if !staged.is_empty() {
        let _ = app.emit("ai-agent-edits", serde_json::json!({
            "requestId": request_id,
            "edits": staged.iter().map(|e| serde_json::json!({
                "id": e.id,
                "action": e.action,
                "path": e.path,
                // 暴露摘要便于前端展示：write 记新内容前若干字；edit 记 old→new 前若干字
                "summary": match e.action.as_str() {
                    "write" => format!("写入 {} 字符", e.new_content.clone().unwrap_or_default().chars().count()),
                    "edit" => format!("{} → {}", e.old_string.clone().unwrap_or_default(), e.new_string.clone().unwrap_or_default()),
                    _ => "删除".to_string(),
                }
            })).collect::<Vec<_>>(),
        }));
    }
    // 事件日志落盘（审计 + 精确重放；append-only 快照）。
    persist_agent_session(&app, &session);
    let _ = app.emit("ai-done", serde_json::json!({ "requestId": request_id }));
    Ok(())
}

/// 前端回调用以决定一次待审批的 Agent 操作：approved=true 放行，false 拒绝。
/// approval_id 来自 ai-agent-approval 事件。
#[tauri::command]
pub async fn ai_agent_approve(approval_id: String, approved: bool) -> Result<(), String> {
    let pending = approval_store()
        .lock()
        .map_err(|_| "审批存储锁获取失败".to_string())?
        .remove(&approval_id);
    match pending {
        Some(p) => {
            let _ = p.sender.send(approved);
            Ok(())
        }
        None => Err("授权请求不存在或已过期".to_string()),
    }
}

/// 把某请求暂存的编辑审阅后真正落盘。keep_ids 为空时全部落盘；
/// 否则仅落盘 keep_ids 中通过审阅的编辑，其余丢弃。
/// 按暂存顺序重放 write/edit/delete，保证与模型所见视图一致。
#[tauri::command]
pub async fn ai_agent_apply_edits(request_id: String, keep_ids: Option<Vec<String>>) -> Result<usize, String> {
    let store = edit_store()
        .lock()
        .map_err(|_| "编辑存储锁获取失败".to_string())?;
    let edits = store.get(&request_id).cloned().unwrap_or_default();
    drop(store);
    if edits.is_empty() {
        return Ok(0);
    }
    let keep_all = keep_ids.as_ref().map(|v| v.is_empty()).unwrap_or(true);
    let mut written = 0usize;
    // 先串行重放 write/edit，最后处理 delete，避免碰撞。
    // edits 按 record_edit 的 order 升序保存，直接按此顺序重放即可。
    let mut deletions: Vec<&PendingEdit> = Vec::new();
    for e in &edits {
        if !keep_all && !keep_ids.as_ref().map(|k| k.contains(&e.id)).unwrap_or(false) {
            continue;
        }
        let p = std::path::PathBuf::from(&e.path);
        match e.action.as_str() {
            "delete" => { deletions.push(e); }
            "write" => {
                if let Some(parent) = p.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|err| format!("创建目录失败 {}: {}", parent.display(), err))?;
                }
                let content = e.new_content.clone().unwrap_or_default();
                std::fs::write(&p, content.as_bytes())
                    .map_err(|err| format!("写入失败 {}: {}", p.display(), err))?;
                written += 1;
            }
            "edit" => {
                let old = e.old_string.clone().unwrap_or_default();
                let new = e.new_string.clone().unwrap_or_default();
                let text = std::fs::read_to_string(&p)
                    .map_err(|err| format!("编辑前读取失败 {}: {}", p.display(), err))?;
                if !text.contains(&old) {
                    return Err(format!("落盘失败 {}：old_string 已不在文件中（可能被其它改动覆盖），{}", p.display(), old));
                }
                let new_text = if text.matches(&old).count() > 1 {
                    text.replace(&old, &new)
                } else {
                    text.replacen(&old, &new, 1)
                };
                std::fs::write(&p, new_text.as_bytes())
                    .map_err(|err| format!("编辑写入失败 {}: {}", p.display(), err))?;
                written += 1;
            }
            _ => {}
        }
    }
    for e in deletions {
        if !keep_all && !keep_ids.as_ref().map(|k| k.contains(&e.id)).unwrap_or(false) {
            continue;
        }
        let p = std::path::PathBuf::from(&e.path);
        std::fs::remove_file(&p).map_err(|err| format!("删除失败 {}: {}", p.display(), err))?;
        written += 1;
    }
    // 清理该请求的暂存
    let store = edit_store()
        .lock()
        .map_err(|_| "编辑存储锁获取失败".to_string())?;
    let mut s = store;
    s.remove(&request_id);
    Ok(written)
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
