
// 全局 AI 服务 · 子模块：对话（Chat）
// （由 ai_service.rs 机械拆分而来，逻辑零改动）

use serde::Deserialize;
use tauri::{AppHandle, Emitter};
use crate::services::ai_service::ai_profile::{AiProfile, load_profiles, resolve_profile, compose_persona_system, compose_effective_system, ensure_api_key};

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
pub(crate) fn is_deepseek_provider(cfg: &AiProfile) -> bool {
    cfg.base_url.to_lowercase().contains("deepseek")
}

/// reasoning_effort 被上游拒绝的判定：各端点取值集合不统一（LM Studio 新版为
/// none/minimal/low/medium/high/xhigh，旧版为 on/off），发错会返回 400 并在正文标注该参数名。
fn is_reasoning_effort_rejected(text: &str) -> bool {
    text.contains("reasoning_effort")
}

/// 粗判提供商（用于用量统计分组）。优先看 base_url 域名，其次看模型名前缀。
fn detect_provider(cfg: &AiProfile) -> String {
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
fn fire_chat_done(app: &AppHandle, cfg: &AiProfile, request_id: &str, last_usage: &Option<serde_json::Value>) {
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
) -> Result<(), String> {
    let profiles = load_profiles(&app);
    let cfg = resolve_profile(&profiles, profile_id);
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
    let thinking = cfg.thinking.unwrap_or(false);
    // 人设 system：组合后合并进首条 system 消息（不破坏插件自带的项目上下文 / SOP / 状态注入）。
    // 伴侣模式（exclude_global_persona=true）：跳过全局人设，仅保留前端注入的伴侣人设。
    let persona = if exclude_global_persona.unwrap_or(false) {
        String::new()
    } else {
        compose_persona_system(&cfg)
    };
    // 前端 per-call system（群聊各伴侣人设 / 单聊注入）前置，全局 persona 紧随其后。
    let effective_system = compose_effective_system(&system, &persona);
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
        // reasoning_effort：OpenAI 兼容端点统一发 high；端点取值集合不一致时由下方发送逻辑
        // 按 400 响应自适应降级（去掉该字段重发），不在此处按 base_url 猜端点类型。
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
        let msg = format!("HTTP {}: {}", status, text);
        let _ = app.emit(
            "ai-error",
            serde_json::json!({ "requestId": request_id, "error": msg }),
        );
        return Err(msg);
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
    use crate::services::ai_service::ai_profile::AiProfile;

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
