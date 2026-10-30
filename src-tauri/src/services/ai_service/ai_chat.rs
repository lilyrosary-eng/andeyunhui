
// 全局 AI 服务 · 子模块：对话（Chat）
// （由 ai_service.rs 机械拆分而来，逻辑零改动）

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use crate::services::ai_service::ai_profile::{ResolvedTarget, load_config, resolve_target, compose_persona_system, compose_effective_system, ensure_api_key};

/// 单条对话消息（OpenAI 格式）
#[derive(Debug, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

// ============ 停止（取消）本次流式对话 ============
//
// agent 那条链（`ai_chat_agent`）从一开始就有 `ai_agent_cancel`：worker 存在注册表里，
// 取消即 `abort.abort()`。但**纯对话这条链什么也没有** —— 一旦 `ai_chat` 发出，
// 前端 `await invoke(...)` 要等到流结束才 resolve，用户只能干等（长回答可达数十秒）。
//
// 这里补上：一个按 `request_id` 索引的取消标志表，流式循环每读一块前查一次。
// 用 `AtomicBool`（而非 abort 句柄）是因为 reqwest 的 `chunk()` 是可取消点，
// 循环顶部轮询即可，不需要打断 future。
//
// ⚠️ 刻意**不发 `ai-error`**：用户主动停止不是错误。发 `ai-done` 让前端按正常路径收尾
//    （复位 busy、保留已收到的部分文本）—— `useAiStream` 的 finish 会把 `content` 原样留下。
static CHAT_CANCELS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn chat_cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    CHAT_CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 请求结束时自动摘除标志，避免注册表随会话数无限增长。
/// 用 Drop 而不是在每个 return 前手写 remove —— `ai_chat` 有 6 条提前返回路径
/// （密钥缺失 / 建请求失败 / 非 2xx / 硬上限 / 读流失败 / 正常完成），漏一条就是一次泄漏。
struct ChatCancelGuard {
    id: String,
}

impl Drop for ChatCancelGuard {
    fn drop(&mut self) {
        chat_cancels().lock().unwrap().remove(&self.id);
    }
}

/// 停止一次进行中的流式对话。
///
/// 前端在用户点「停止」时调用，与 `ai_chat` **并行**发起（后者仍挂在 `await` 上）。
/// 找不到对应 request_id 时返回 Err（可能这一轮已经自然结束），调用方应忽略该错误。
#[tauri::command]
pub fn ai_chat_cancel(request_id: String) -> Result<(), String> {
    let m = chat_cancels().lock().unwrap();
    match m.get(&request_id) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            Ok(())
        }
        None => Err(format!("没有进行中的对话：{request_id}")),
    }
}

// ============ Prompt Cache 支持（借鉴 claw-code-main/api/src/prompt_cache.rs） ============
// Anthropic 的 OpenAI 兼容端点支持 cache_control: { type: "ephemeral" } 做前缀缓存，
// 把 system + 稳定历史段标记为 ephemeral 后，provider 侧缓存 5 分钟，
// 后续请求命中缓存时 cache_read_input_tokens 大幅降低成本与延迟。
// Anthropic 允许最多 4 个 cache breakpoint；这里放 2 个：system + 倒数第 3 条消息。

/// 检测是否为 Anthropic 提供商（通过模型名或 base_url 判断）
fn is_anthropic_provider(cfg: &ResolvedTarget) -> bool {
    let model = cfg.model.to_lowercase();
    let base = cfg.base_url.to_lowercase();
    model.starts_with("claude")
        || base.contains("anthropic.com")
        || base.contains("claude.ai")
}

/// DeepSeek 提供商判定：base_url 含 deepseek（api.deepseek.com 等）。
pub(crate) fn is_deepseek_provider(cfg: &ResolvedTarget) -> bool {
    cfg.base_url.to_lowercase().contains("deepseek")
}

/// reasoning_effort 被上游拒绝的判定：各端点取值集合不统一（LM Studio 新版为
/// none/minimal/low/medium/high/xhigh，旧版为 on/off），发错会返回 400 并在正文标注该参数名。
fn is_reasoning_effort_rejected(text: &str) -> bool {
    text.contains("reasoning_effort")
}

/// 粗判提供商（用于用量统计分组）。优先看 base_url 域名，其次看模型名前缀。
fn detect_provider(cfg: &ResolvedTarget) -> String {
    let base = cfg.base_url.to_lowercase();
    let model = cfg.model.to_lowercase();
    if base.contains("deepseek") {
        "deepseek"
    } else if base.contains("anthropic") || base.contains("claude.ai") || model.starts_with("claude") {
        "anthropic"
    } else if base.contains("googleapis") || base.contains("generativelanguage") || model.starts_with("gemini") {
        "google"
    } else if base.contains("openai") || model.starts_with("gpt") || model.starts_with("o1") || model.starts_with("o3") {
        "openai"
    } else if base.contains("moonshot") {
        "moonshot"
    } else if base.contains("dashscope") || base.contains("qwen") {
        "qwen"
    } else {
        "other"
    }
    .to_string()
}

/// 请求结束收尾：触发 `chat.done` 钩点 + 把用量落库（幂等、尽力而为、异步）。
fn fire_chat_done(app: &AppHandle, cfg: &ResolvedTarget, request_id: &str, last_usage: &Option<serde_json::Value>) {
    let app = app.clone();
    let profile_id = cfg.id.clone();
    let provider = detect_provider(cfg);
    let model = cfg.model.clone();
    let usage = last_usage.clone();
    // 触发全局钩点：payload 含模型/请求 id/usage，供外部管线（审计/联动/扩展）消费。
    crate::services::hook_service::trigger(
        crate::services::hook_service::HOOK_CHAT_DONE,
        &serde_json::json!({
            "requestId": request_id,
            "profileId": profile_id,
            "provider": provider,
            "model": model,
            "usage": usage,
        }),
    );
    let Some(u) = last_usage else { return };
    let nums = crate::services::usage_service::parse_usage(u);
    if nums.prompt_tokens + nums.completion_tokens <= 0 {
        return;
    }
    // 把阻塞落库交给后台任务，不阻塞当前对话流
    tauri::async_runtime::spawn(async move {
        crate::services::usage_service::record_usage_async(&app, profile_id, provider, model, nums).await;
    });
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

/// 把原生图片挂到最后一条 user 消息上（OpenAI Vision 的 content block 形状）。
///
/// 只处理最后一条 user：本轮用户新发的内容在末尾，历史里的旧图不在这里重复发送
/// （历史图片目前仍以当时的文本描述/记录形式存在）。
fn inject_native_images(messages: &mut [serde_json::Value], images: &[String]) {
    let Some(pos) = messages
        .iter()
        .rposition(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
    else {
        return;
    };
    let text = messages[pos]
        .get("content")
        .map(|c| match c {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Array(parts) => parts
                .iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("
"),
            _ => String::new(),
        })
        .unwrap_or_default();
    let mut blocks: Vec<serde_json::Value> = Vec::new();
    if !text.is_empty() {
        blocks.push(serde_json::json!({ "type": "text", "text": text }));
    }
    for url in images.iter().take(8) {
        blocks.push(serde_json::json!({
            "type": "image_url",
            "image_url": { "url": url },
        }));
    }
    if !blocks.is_empty() {
        messages[pos]["content"] = serde_json::Value::Array(blocks);
    }
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
pub(crate) fn truncate_messages_for_safety(messages: Vec<ChatMessage>) -> (Vec<ChatMessage>, bool) {
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
    // 伴侣模式下调用方置 true：跳过全局 AI 人设，仅使用前端 per-call 注入的伴侣人设，
    // 满足「ai 对话启动伴侣模式后只走伴侣人设、不受全局 AI 人设控制」。
    exclude_global_persona: Option<bool>,
    // 请求级档位覆盖（对话页里临时选的思考档位；留空 = 用配置）。
    // 只影响本次请求、不改配置 —— 见 `ResolvedTarget::effort_with_override` 的文档。
    // （用 // 而不是 ///：doc 注释不允许出现在函数参数上。）
    effort: Option<String>,
    // 原生多模态图片（data URL）：仅当当前模型被确证支持视觉时由前端传入。
    // 非视觉模型不应传（前端会改走 ai_vision_ocr 兜底），这里也会再校验一次。
    images: Option<Vec<String>>,
) -> Result<(), String> {
    // 取消标志：先登记再干活，保证用户在首个 token 到达前就能停（否则「点了没反应」）。
    // guard 持有期间标志常驻表中；函数返回（无论哪条路径）即自动摘除。
    let cancel = Arc::new(AtomicBool::new(false));
    chat_cancels()
        .lock()
        .unwrap()
        .insert(request_id.clone(), cancel.clone());
    let _cancel_guard = ChatCancelGuard { id: request_id.clone() };

    let config = load_config(&app);
    let cfg = resolve_target(&config, profile_id.as_deref());
    ensure_api_key(&app, &request_id, &cfg)?;

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
    // 生效档位由 ResolvedTarget::effort() 统一推导（显式 effort 优先，回落到旧 thinking 开关）。
    // thinking 仅表示「推理是否开着」，用于下方 reasoning_content 的转发门控。
    // 档位先应用**请求级覆盖**（对话页选的），再据此决定推理开关 —— 两者必须同源，
    // 否则会出现「档位发了 off 但 reasoning 仍被转发」这类自相矛盾的状态。
    let effective_effort = cfg.effort_with_override(effort.as_deref());
    let thinking = effective_effort != "off";
    // 人设 system：组合后合并进首条 system 消息（不破坏插件自带的项目上下文 / SOP / 状态注入）。
    // 伴侣模式（exclude_global_persona=true）：跳过全局人设，仅保留前端注入的伴侣人设。
    let persona = if exclude_global_persona.unwrap_or(false) {
        String::new()
    } else {
        compose_persona_system(&cfg)
    };
    // 前端 per-call system（群聊各伴侣人设 / 单聊注入）前置，全局 persona 紧随其后。
    let mut effective_system = compose_effective_system(&system, &persona);
    // 主机级 ADYH 默认规则：所有聊天共用。用户自定义注入层只在 AI 编程（agent）里生效，
    // 避免把项目级编码约束带进普通聊天。
    let builtin = crate::services::adyh_service::base_rules(&app);
    if !builtin.trim().is_empty() {
        effective_system = if effective_system.trim().is_empty() {
            builtin
        } else {
            format!("{}\n\n{}", builtin.trim_end(), effective_system)
        };
    }
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
    // 原生多模态：当前模型确证支持视觉时，图片直接随本轮 user 消息发给模型；
    // 否则忽略（前端应已走 ai_vision_ocr 兜底，把描述拼进文本）。
    if let Some(imgs) = images.as_ref().filter(|v| !v.is_empty()) {
        let native_vision = config
            .providers
            .iter()
            .flat_map(|p| p.models.iter())
            .find(|m| m.id == cfg.id)
            .map(|m| m.vision_native_trusted())
            .unwrap_or(false);
        if native_vision {
            inject_native_images(&mut messages_json, imgs);
        } else {
            log::warn!(
                "[ai_chat] 当前模型未确证支持原生视觉，忽略 {} 张图片（应由前端走 ai_vision_ocr 兜底）",
                imgs.len()
            );
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
        // 档位取值来自「供应商上报 → 内置保守表」的集合（见 reasoning.rs），
        // 不在此处按 base_url 猜端点类型；端点仍拒绝时由下方 400 自适应降级兜底。
        body["reasoning_effort"] = serde_json::json!(effective_effort);
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
    // 自适应降级：reasoning_effort 的取值集合因端点/版本而异，发错会被直接 400 拒绝。
    // 命中「400 + 正文点名 reasoning_effort」时摘掉该字段重发一次，交由服务端用模型默认思考策略，
    // 从而不依赖 base_url 猜测端点类型（本地 LM Studio、中转站、各家 OpenAI 兼容层通吃）。
    let mut degraded = false;
    let resp = loop {
        let sent = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", cfg.api_key.trim()))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await;
        let r = match sent {
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
        // 成功，或已降级过（降级后仍失败则走下方统一错误上报，避免死循环）。
        if r.status().is_success() || degraded {
            break r;
        }
        let status = r.status();
        let text = r.text().await.unwrap_or_default();
        if status == reqwest::StatusCode::BAD_REQUEST && is_reasoning_effort_rejected(&text) {
            if let Some(obj) = body.as_object_mut() {
                obj.remove("reasoning_effort");
            }
            degraded = true;
            eprintln!(
                "[ai_chat] reasoning_effort 被上游拒绝（{}），已摘除该字段重发一次",
                cfg.model
            );
            continue;
        }
        // 4xx 一律打印请求形状（模型/工具清单/缺 type 的工具），否则只剩一行上游文案无从定位
        crate::services::ai_service::log_rejected_request("ai_chat", &url, &body, status.as_u16(), &text);
        // 上下文超限的正文常带真值，顺手学到并回写（见 ctx_learn 模块注释）
        let learned = crate::services::ai_service::ctx_learn::learn_from_error(&app, &cfg, &text);
        let msg = match learned {
            Some(n) => format!("HTTP {}: {}
（已记录该模型上下文上限 = {} token，下一轮起按它压缩）", status, text, n),
            None => format!("HTTP {}: {}", status, text),
        };
        let _ = app.emit(
            "ai-error",
            serde_json::json!({ "requestId": request_id, "error": msg }),
        );
        return Err(msg);
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        // 4xx 一律打印请求形状（模型/工具清单/缺 type 的工具），否则只剩一行上游文案无从定位
        crate::services::ai_service::log_rejected_request("ai_chat", &url, &body, status.as_u16(), &text);
        // 上下文超限的正文常带真值，顺手学到并回写（见 ctx_learn 模块注释）
        let learned = crate::services::ai_service::ctx_learn::learn_from_error(&app, &cfg, &text);
        let msg = match learned {
            Some(n) => format!("HTTP {}: {}
（已记录该模型上下文上限 = {} token，下一轮起按它压缩）", status, text, n),
            None => format!("HTTP {}: {}", status, text),
        };
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
        // ★ 用户点了「停止」→ 立刻收口，不再向下游索要数据。
        //   发 `ai-done`（而非 `ai-error`）：主动停止不是故障，前端据此复位 busy，
        //   并把已经收到的部分文本原样留在气泡里（`useAiStream` 的 finish 不覆写 content）。
        if cancel.load(Ordering::SeqCst) {
            let _ = app.emit(
                "ai-done",
                serde_json::json!({ "requestId": request_id, "stopped": true, "usage": last_usage }),
            );
            return Ok(());
        }
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
                        fire_chat_done(&app, &cfg, &request_id, &last_usage);
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

    fire_chat_done(&app, &cfg, &request_id, &last_usage);
    let _ = app.emit("ai-done", serde_json::json!({
        "requestId": request_id,
        "usage": last_usage,
    }));
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::ai_service::ai_profile::ResolvedTarget;

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
        let mut cfg = ResolvedTarget::default();
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
        assert_eq!(compose_persona_system(&ResolvedTarget::default()), "");
    }

    #[test]
    fn persona_preset_maps_to_description() {
        let mut cfg = ResolvedTarget::default();
        cfg.persona_preset = Some("sharp".into());
        let s = compose_persona_system(&cfg);
        assert!(s.contains("毒舌直率"));
        assert!(s.contains("一针见血"));
    }

    #[test]
    fn persona_unknown_preset_falls_back_to_style() {
        let mut cfg = ResolvedTarget::default();
        cfg.persona_preset = Some("custom".into());
        cfg.persona_style = Some("简洁".into());
        let s = compose_persona_system(&cfg);
        assert!(s.contains("你应遵守以下风格要求：简洁"));
        assert!(!s.contains("毒舌"));
    }

    #[test]
    fn persona_combines_all_parts() {
        let mut cfg = ResolvedTarget::default();
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
    // ── 流式对话的「停止」注册表 ────────────────────────────────────────────
    // 每条用例用**唯一 id**：注册表是进程级 static，而 cargo test 默认多线程并行，
    // 复用 id 会让两条用例互相摘除对方的表项（这个坑在本项目已踩过一次）。

    #[test]
    fn 取消注册表_取消置位且guard负责摘除() {
        let id = "t-cancel-guard".to_string();
        let flag = Arc::new(AtomicBool::new(false));
        chat_cancels().lock().unwrap().insert(id.clone(), flag.clone());
        let guard = ChatCancelGuard { id: id.clone() };

        assert!(ai_chat_cancel(id.clone()).is_ok(), "登记后应能取消");
        assert!(flag.load(Ordering::SeqCst), "取消后标志必须置位");

        drop(guard);
        assert!(
            ai_chat_cancel(id.clone()).is_err(),
            "guard drop 后表中不应再残留它（否则注册表随会话数泄漏）"
        );
        assert!(chat_cancels().lock().unwrap().get(&id).is_none());
    }

    #[test]
    fn 取消注册表_未知id如实报错而不是静默成功() {
        // 静默成功会让前端以为「已停止」，而实际仍在跑 —— 必须如实报错，
        // 让调用方有机会回落（例如本地复位 busy，至少 UI 不会卡住）。
        assert!(ai_chat_cancel("不存在的请求id-3f9a".into()).is_err());
    }
}
