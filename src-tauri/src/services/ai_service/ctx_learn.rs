// 全局 AI 服务 · 子模块：从上游报错里「学」上下文上限
//
// ## 为什么需要这个模块（2026-10-22）
// 上下文长度是**压缩阈值**的唯一依据：cap 决定 `压缩线 = cap/5`、`熔断线 = cap/2`。
// 但"精准识别"这件事，任何主动探测都做不到全覆盖：
//   - 端点可能压根不报（大量 OpenAI 兼容中转站的 `/v1/models` 只有 id）；
//   - 本地服务端的"已加载窗口"会随用户重载模型而变；
//   - 兜底表只能覆盖叫得出名字的家族。
// ⇒ 唯一**必然准确**的时刻，是上游因为上下文太长而拒绝我们的那一刻。
//   报错正文里几乎都带着真值（"maximum context length is 8192 tokens"），
//   抓到它、回写到模型档案、下一轮按真值压缩 —— 覆盖率问题就此闭环。
//
// ## 边界
// - 只认**明确带数字**的句式；认不出来返回 None，绝不猜。
// - 只写回 `ModelEntry.context_tokens`（来源 `Learned`），**不动用户手填的值**。
// - 学到的值必须落在合理区间（512 ~ 1e8），否则视为解析噪声丢弃。

use tauri::AppHandle;

use super::ai_profile::{self, CapacitySource, ResolvedTarget};

/// 学到的值允许的区间：小于 512 说明匹配到的是别处的数字；大于 1e8 没有现实意义。
const MIN_PLAUSIBLE: u64 = 512;
const MAX_PLAUSIBLE: u64 = 100_000_000;

/// 各家端点报"上下文超限"的句式。全部小写匹配（正文先 to_lowercase）。
///
/// 维护要求：新增句式**必须**配一条测试（`ctx_learn_tests`），用厂商的原始文案。
static PATTERNS: once_cell::sync::Lazy<Vec<regex::Regex>> = once_cell::sync::Lazy::new(|| {
    let raw = [
        // OpenAI / DeepSeek / vLLM / 多数中转：
        // "This model's maximum context length is 65536 tokens."
        r"maximum context length is (\d+)",
        // "This endpoint's maximum context length is 8192 tokens."
        r"maximum context (?:length|window) (?:is|of) (\d+)",
        // "the model supports up to 32768 tokens"
        r"supports? (?:only |up to |a maximum of )?(\d+) (?:tokens?|context)",
        // "input tokens exceed the configured limit of 8192 tokens"（Mistral / 部分自建）
        r"limit of (\d+) tokens",
        // "210000 tokens > 200000 maximum"（Anthropic 风格）
        r"\d+ tokens? ?[>＞] ?(\d+)",
        // 兜底：任何 "context length/window ... 4096"
        r"context (?:length|window)[^\d]{0,24}(\d{3,})",
    ];
    raw.iter()
        .filter_map(|p| regex::Regex::new(p).ok())
        .collect()
});

/// 从上游错误正文里解析出模型真实的上下文上限；认不出返回 `None`。
///
/// 只做字符串解析，不依赖网络/文件，便于单测。
pub fn parse_context_limit_from_error(body: &str) -> Option<u64> {
    if body.trim().is_empty() {
        return None;
    }
    let low = body.to_lowercase();
    // 先要求正文确实在说"上下文/长度"相关，避免把限流、计费类报错里的数字当上下文
    let context_related = low.contains("context")
        || low.contains("token")
        || low.contains("prompt is too long")
        || low.contains("input length");
    if !context_related {
        return None;
    }
    for re in PATTERNS.iter() {
        if let Some(c) = re.captures(&low) {
            if let Some(m) = c.get(1) {
                if let Ok(v) = m.as_str().parse::<u64>() {
                    if (MIN_PLAUSIBLE..=MAX_PLAUSIBLE).contains(&v) {
                        return Some(v);
                    }
                }
            }
        }
    }
    None
}

/// 从一次失败响应里学习并回写；返回学到的值（没学到 / 没写回则为 `None`）。
///
/// 写回失败只打日志：学习是"顺带的好处"，绝不能因为它影响本轮错误上报。
pub fn learn_from_error(app: &AppHandle, cfg: &ResolvedTarget, body: &str) -> Option<u64> {
    let learned = parse_context_limit_from_error(body)?;
    log::warn!(
        "[ctx-learn] 从上游报错学到上下文上限：模型 {} = {learned} token（正文片段：{}）",
        cfg.model,
        body.chars().take(160).collect::<String>()
    );
    match ai_profile::update_model_context_tokens(app, &cfg.id, learned, CapacitySource::Learned) {
        Ok(true) => log::warn!(
            "[ctx-learn] 已写入模型档案（来源 learned），下一轮压缩线 = {}，熔断线 = {}",
            (learned as usize / 5).max(8_000),
            (learned as usize / 2).max(16_000)
        ),
        Ok(false) => log::info!("[ctx-learn] 学到的值与现有档案一致或被更可信来源覆盖，未改动"),
        Err(e) => log::error!("[ctx-learn] 回写上下文上限失败（不影响本轮报错）：{e}"),
    }
    Some(learned)
}

#[cfg(test)]
mod ctx_learn_tests {
    use super::parse_context_limit_from_error;

    /// 各家真实文案 → 解析出的真值。这些字符串是从各厂商文档/实测里抄的原句。
    #[test]
    fn parses_real_provider_messages() {
        let cases: &[(&str, Option<u64>)] = &[
            // OpenAI / DeepSeek
            (
                "This model's maximum context length is 65536 tokens. However, you requested 70000 \
                 tokens (69000 in the messages, 1000 in the completion). Please reduce the length of \
                 the messages or completion.",
                Some(65536),
            ),
            // vLLM
            (
                "This model's maximum context length is 4096 tokens. However, you requested 5000 tokens.",
                Some(4096),
            ),
            // OpenRouter
            ("This endpoint's maximum context length is 8192 tokens.", Some(8192)),
            // Mistral 风格
            ("Input tokens exceed the configured limit of 32768 tokens.", Some(32768)),
            // Anthropic 风格（210000 tokens > 200000 maximum）
            ("prompt is too long: 210000 tokens > 200000 maximum", Some(200000)),
            // llama.cpp server
            ("the prompt exceeds the context window of 2048 tokens", Some(2048)),
        ];
        for (body, want) in cases {
            assert_eq!(
                parse_context_limit_from_error(body),
                *want,
                "解析失败，正文：{body}"
            );
        }
    }

    /// 认不出的文案一律返回 None —— 宁可不学，也不能写一条错的进档案。
    #[test]
    fn refuses_to_guess() {
        for body in [
            // 只说超了，没给数字
            "the input length exceeds the context length",
            "context_length_exceeded",
            "Please reduce the length of the messages or completion.",
            // 与上下文无关的报错（限流/鉴权/模型不存在）
            "Rate limit reached for requests",
            "Incorrect API key provided",
            "The model `gpt-x` does not exist",
            "",
            "   ",
        ] {
            assert_eq!(parse_context_limit_from_error(body), None, "不该解析出数字：{body}");
        }
    }

    /// 数量级不合理当噪声丢弃（避免把 "context length 50" 这类文案当成上限）。
    #[test]
    fn rejects_implausible_numbers() {
        assert_eq!(parse_context_limit_from_error("maximum context length is 50 tokens"), None);
        assert_eq!(
            parse_context_limit_from_error("maximum context length is 999999999999 tokens"),
            None
        );
    }
}
