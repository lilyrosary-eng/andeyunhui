// Agent 单轮协议层：请求体构造 + 响应消息解析。
//
// 从 `ai_agent::run_agent` 的循环里抽出，目的是让「主对话 Agent」与「协作 native 成员」
// 共用同一套 OpenAI 兼容协议细节；循环本身仍由各自调用方驱动。
// 这里只放纯逻辑（不发事件、不落盘），方便单测与后续复用。

use serde_json::{json, Value};

use crate::services::ai_service::ai_chat::is_deepseek_provider;
use crate::services::ai_service::ai_profile::ResolvedTarget;

/// 一次响应里的 token 用量（OpenAI 兼容端点的 `usage` 字段）。
#[derive(Debug, Clone, Copy, Default)]
pub struct AgentUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

/// 一次非流式响应的 assistant 消息。
#[derive(Debug)]
pub(crate) struct AgentTurn {
    pub content: String,
    /// 思考过程（reasoning_content）；关闭思考时应忽略。
    pub reasoning: Option<String>,
    pub tool_calls: Vec<Value>,
    /// 端点返回的 token 用量；部分兼容端点不返回则为 None。
    pub usage: Option<AgentUsage>,
}

/// 构造一次非流式 agent 请求体，返回 (body, thinking)。
///
/// thinking 由调用方复用：关思考时即使端点回了 reasoning_content 也不展示。
/// 档位口径与 `ai_chat` 一致：显式 effort 优先，回落到档案里的推理配置。
pub(crate) fn build_agent_body(
    cfg: &ResolvedTarget,
    messages: Vec<Value>,
    tools: Vec<Value>,
    effort: Option<&str>,
) -> (Value, bool) {
    let mut body = json!({
        "model": cfg.model,
        "messages": messages,
        "stream": false,
        "tools": tools,
        "tool_choice": "auto",
    });
    let effective_effort = cfg.effort_with_override(effort);
    let thinking = effective_effort != "off";
    if thinking {
        body["reasoning_effort"] = json!(effective_effort);
        // DeepSeek 的思考开关是独立字段，与 reasoning_effort 并存才生效。
        if is_deepseek_provider(cfg) {
            body["thinking"] = json!({ "type": "enabled" });
        }
    } else {
        body["temperature"] = json!(cfg.temperature);
        if let Some(mt) = cfg.max_tokens {
            body["max_tokens"] = json!(mt);
        }
    }
    (body, thinking)
}

/// 解析非流式响应里的 assistant 消息。
///
/// 上游错误也可能以 HTTP 200 + `error` 字段返回（部分兼容端点如此），所以一并兜住。
pub(crate) fn parse_agent_message(payload: &Value) -> Result<AgentTurn, String> {
    if let Some(err) = payload.get("error") {
        return Err(format!("上游报错: {err}"));
    }
    let message = &payload["choices"][0]["message"];
    let content = message
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    let reasoning = message
        .get("reasoning_content")
        .and_then(|v| v.as_str())
        .filter(|text| !text.is_empty())
        .map(|text| text.to_string());
    let tool_calls = message
        .get("tool_calls")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    let usage = payload.get("usage").and_then(|value| {
        if !value.is_object() {
            return None;
        }
        let prompt_tokens = value.get("prompt_tokens").and_then(Value::as_u64).unwrap_or(0);
        let completion_tokens = value
            .get("completion_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let total_tokens = value
            .get("total_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(prompt_tokens + completion_tokens);
        Some(AgentUsage {
            prompt_tokens,
            completion_tokens,
            total_tokens,
        })
    });
    Ok(AgentTurn {
        content,
        reasoning,
        tool_calls,
        usage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::ai_service::ai_profile::placeholder_target;

    /// 关思考：不发 reasoning_effort，回落到 temperature / max_tokens。
    #[test]
    fn body_without_thinking_uses_sampling_params() {
        let cfg = placeholder_target();
        let (body, thinking) = build_agent_body(&cfg, vec![], vec![], Some("off"));
        assert!(!thinking);
        assert!(body.get("reasoning_effort").is_none());
        assert!(body.get("temperature").is_some());
        assert_eq!(body["model"], cfg.model);
        assert_eq!(body["tool_choice"], "auto");
    }

    /// 开思考：带 reasoning_effort；DeepSeek 端点还要额外带 thinking 开关。
    #[test]
    fn body_with_thinking_carries_effort_and_deepseek_flag() {
        let cfg = placeholder_target();
        let (body, thinking) = build_agent_body(&cfg, vec![], vec![], Some("high"));
        assert!(thinking);
        assert_eq!(body["reasoning_effort"], "high");
        assert_eq!(body["thinking"]["type"], "enabled");
        assert!(body.get("temperature").is_none());
    }

    /// 纯文本响应：content 与 reasoning 都解析出来，无工具调用。
    #[test]
    fn parses_plain_text_with_reasoning() {
        let payload = json!({
            "choices": [{ "message": { "content": "答案", "reasoning_content": "想一想" } }]
        });
        let turn = parse_agent_message(&payload).unwrap();
        assert_eq!(turn.content, "答案");
        assert_eq!(turn.reasoning.as_deref(), Some("想一想"));
        assert!(turn.tool_calls.is_empty());
        assert!(turn.usage.is_none());
    }

    /// usage 解析：端点不返回 total 时用 prompt + completion 兜底。
    #[test]
    fn parses_usage_with_total_fallback() {
        let payload = json!({
            "usage": { "prompt_tokens": 10, "completion_tokens": 5 },
            "choices": [{ "message": { "content": "ok" } }]
        });
        let usage = parse_agent_message(&payload).unwrap().usage.unwrap();
        assert_eq!(usage.prompt_tokens, 10);
        assert_eq!(usage.completion_tokens, 5);
        assert_eq!(usage.total_tokens, 15);
    }

    /// 工具调用响应：保留原生 tool_calls 形状，content 为空也允许。
    #[test]
    fn parses_tool_calls() {
        let payload = json!({
            "choices": [{ "message": {
                "content": null,
                "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": { "name": "file", "arguments": "{\"action\":\"read\"}" }
                }]
            } }]
        });
        let turn = parse_agent_message(&payload).unwrap();
        assert_eq!(turn.content, "");
        assert!(turn.reasoning.is_none());
        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0]["function"]["name"], "file");
    }

    /// 上游把错误塞在 200 响应里：必须变成 Err，不能当成空回答。
    #[test]
    fn surfaces_upstream_error_payload() {
        let payload = json!({ "error": { "message": "quota exceeded" } });
        let error = parse_agent_message(&payload).unwrap_err();
        assert!(error.contains("quota exceeded"), "{error}");
    }
}
