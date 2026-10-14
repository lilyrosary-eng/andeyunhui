// 按模型名推断能力标记 + 兜底容量。
//
// 为什么需要：绝大多数 /v1/models 端点不返回能力信息，只有 id。
// 折叠面板上要显示「文本 · 思考 · 视觉 · 工具」标签，resolve_target 要按 caps.vision
// 决定视觉模型能否回落到自身，两者都需要一个初始值。
//
// ⚠️ 这是启发式，不是权威信息。用户在模型编辑器里可以手动改，改过的以用户为准。
//   判据与容量表改动集中在本文件，便于日后按实测修正。

use super::ai_profile::Caps;

/// 名称里含这些片段 → 推理模型（思考）。
/// 长片段可直接 contains；短的 `o1/o3/o4` 走 has_token 按词边界匹配（见下）。
const REASONING_HINTS: &[&str] = &[
    "deepseek-reasoner", "deepseek-r1", "qwq", "thinking", "reasoning",
    "-r1", "r1-", "-think", "-reasoner",
];

/// 名称里的**短标记** → 推理模型。必须按词边界匹配：
/// 直接 contains 会让 `foo-bar-o1` 命中，也会让非词边界写法误判。
const REASONING_TOKENS: &[&str] = &["o1", "o3", "o4"];

/// 名称里含这些片段 → 视觉模型。
/// 三类来源：①显式视觉命名；②本地视觉模型；③旗舰对话模型自带视觉。
const VISION_HINTS: &[&str] = &[
    // ① 显式视觉命名（覆盖 -vl / vl- / _vl / :vl 等各种分隔习惯）
    "-vl", "vl-", "vl:", "_vl", "-vision", "vision-", "_vision",
    "qwen-vl", "qwen2-vl", "qwen2.5-vl", "qwen2.5vl", "qwen3-vl",
    "glm-4v", "glm-4.1v", "-4v", "4v-",
    // ② 本地视觉模型（Ollama / LM Studio 常见）
    "llava", "pixtral", "moondream", "minicpm-v", "internvl", "cogvlm",
    // ③ 旗舰对话模型自带视觉能力
    "gpt-4o", "gpt-4-turbo", "gpt-4.1", "gpt-5",
    "claude-3", "claude-4", "claude-sonnet", "claude-opus", "claude-haiku",
    "gemini",
];

/// 名称里含这些片段 → 向量模型（不是对话模型）
const EMBEDDING_HINTS: &[&str] = &["embed", "embedding", "bge-", "nomic-embed", "e5-"];

/// 名称里含这些片段 → **明确不擅长工具调用**的纯视觉/标注类模型。
/// 其余「文本且非向量」的模型都按支持工具调用处理——绝大多数 OpenAI 兼容端点
/// 的对话模型都支持 function calling，保守不标反而让标签失去意义。
const NO_TOOLS_HINTS: &[&str] = &["llava", "moondream", "minicpm-v", "cogvlm"];

/// 短标记按**词边界**匹配：以非字母数字切分后逐段等值比对。
/// 这样 `o1-mini` → ["o1","mini"] 命中，`gpt-4o` → ["gpt","4o"] 不命中。
fn has_token(n: &str, tok: &str) -> bool {
    n.split(|c: char| !c.is_ascii_alphanumeric()).any(|seg| seg == tok)
}

/// 按模型名推断能力标记。
pub fn infer_caps(model_name: &str) -> Caps {
    let n = model_name.to_lowercase();
    let has = |hints: &[&str]| hints.iter().any(|h| n.contains(h));

    // 向量模型既不是对话模型，也无视觉/思考/工具可言
    if has(EMBEDDING_HINTS) {
        return Caps { text: false, embedding: true, ..Default::default() };
    }
    let reasoning = has(REASONING_HINTS) || REASONING_TOKENS.iter().any(|t| has_token(&n, t));
    let vision = has(VISION_HINTS);
    let tools = !has(NO_TOOLS_HINTS);
    Caps { text: true, vision, reasoning, tools, embedding: false }
}

/// 端点不报容量时的**兜底**知识表：(模型名片段, 上下文窗口, 最大输出)。
///
/// 匹配规则：**按数组顺序，先命中先赢**——所以更具体的名字必须排在更泛的前面
/// （`gpt-4o-mini` 在 `gpt-4o` 前，`gpt-4o` 在 `gpt-4` 前）。
///
/// ⚠️ 值为公开资料的近似值，仅供参考：**端点自报的值优先**于本表；
///    用户在模型编辑器里填的值又优先于端点。三者优先级：用户 > 端点 > 本表。
const CAPACITY: &[(&str, u64, u64)] = &[
    // ---- OpenAI ----
    ("gpt-4o-mini", 128_000, 16_384),
    ("gpt-4o", 128_000, 16_384),
    ("gpt-4-turbo", 128_000, 4_096),
    ("gpt-4.1-mini", 1_047_576, 32_768),
    ("gpt-4.1-nano", 1_047_576, 32_768),
    ("gpt-4.1", 1_047_576, 32_768),
    ("gpt-4-32k", 32_768, 4_096),
    ("gpt-3.5-turbo", 16_385, 4_096),
    ("gpt-4", 8_192, 8_192),
    ("o1-mini", 128_000, 65_536),
    ("o3-mini", 200_000, 100_000),
    ("o4-mini", 200_000, 100_000),
    ("o1", 200_000, 100_000),
    ("o3", 200_000, 100_000),
    // ---- Anthropic ----
    ("claude-3-7-sonnet", 200_000, 64_000),
    ("claude-3-5-sonnet", 200_000, 8_192),
    ("claude-3-5-haiku", 200_000, 8_192),
    ("claude-3-opus", 200_000, 4_096),
    ("claude-3-haiku", 200_000, 4_096),
    ("claude-3-sonnet", 200_000, 4_096),
    ("claude-sonnet-4", 200_000, 64_000),
    ("claude-opus-4", 200_000, 32_000),
    ("claude", 200_000, 8_192),
    // ---- Google ----
    ("gemini-1.5-pro", 2_097_152, 8_192),
    ("gemini-1.5-flash", 1_048_576, 8_192),
    ("gemini-2.5", 1_048_576, 65_536),
    ("gemini-2.0", 1_048_576, 8_192),
    ("gemini", 1_048_576, 8_192),
    // ---- DeepSeek ----
    ("deepseek-reasoner", 65_536, 8_192),
    ("deepseek-chat", 65_536, 8_192),
    ("deepseek-coder", 65_536, 8_192),
    ("deepseek", 65_536, 8_192),
    // ---- 通义千问 ----
    ("qwen-vl-max", 32_768, 2_048),
    ("qwen-vl-plus", 32_768, 2_048),
    ("qwen2.5-vl", 131_072, 8_192),
    ("qwen-max", 32_768, 8_192),
    ("qwen-plus", 131_072, 8_192),
    ("qwen-turbo", 131_072, 8_192),
    ("qwen2.5", 131_072, 8_192),
    ("qwen3", 131_072, 32_768),
    ("qwen", 32_768, 8_192),
    // ---- 智谱 GLM ----
    ("glm-4v", 8_192, 1_024),
    ("glm-4-plus", 128_000, 4_096),
    ("glm-4-air", 128_000, 4_096),
    ("glm-4-flash", 128_000, 4_096),
    ("glm-4", 128_000, 4_096),
    // ---- 本地常见（Ollama / LM Studio）----
    ("llama3.2", 131_072, 4_096),
    ("llama3.1", 131_072, 4_096),
    ("llama3", 8_192, 4_096),
    ("mistral", 32_768, 8_192),
    ("mixtral", 32_768, 8_192),
    ("gemma", 8_192, 4_096),
];

/// 按模型名查兜底容量，返回 (上下文窗口, 最大输出)。
/// 查不到返回 None——**不猜**：给一个错的数字比留空更误导（用户会以为已识别）。
pub fn infer_capacity(model_name: &str) -> Option<(u64, u64)> {
    let n = model_name.to_lowercase();
    CAPACITY.iter().find(|(pat, _, _)| n.contains(pat)).map(|(_, ctx, out)| (*ctx, *out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 普通对话模型标文本与工具() {
        let c = infer_caps("deepseek-chat");
        assert!(c.text && !c.vision && !c.reasoning && !c.embedding);
        assert!(c.tools, "对话模型应能工具调用");
    }

    #[test]
    fn 推理模型带思考标记() {
        assert!(infer_caps("deepseek-reasoner").reasoning);
        assert!(infer_caps("deepseek-r1:7b").reasoning);
        assert!(infer_caps("qwq-32b").reasoning);
        assert!(infer_caps("o3-mini").reasoning);
    }

    #[test]
    fn 短标记按词边界不误伤() {
        // o1/o3/o4 是词级标记：命中真名，不命中「恰好含 sub 串」的名字
        assert!(infer_caps("o1").reasoning);
        assert!(infer_caps("o1-preview").reasoning);
        assert!(!infer_caps("codellama-o1x").reasoning, "非词边界不应命中");
        // gpt-4o 的 4o 不是 o1/o3/o4，不得被误标推理
        assert!(!infer_caps("gpt-4o").reasoning);
    }

    #[test]
    fn 视觉模型带视觉标记() {
        assert!(infer_caps("qwen2.5-vl-72b-instruct").vision);
        assert!(infer_caps("llava:7b").vision);
        assert!(infer_caps("minicpm-v-2_6").vision);
    }

    #[test]
    fn 旗舰对话模型自带视觉() {
        // 用户反馈的核心场景：这些以前全判不出视觉
        assert!(infer_caps("gpt-4o").vision, "gpt-4o 有视觉");
        assert!(infer_caps("gpt-4o-mini").vision);
        assert!(infer_caps("gpt-4-turbo").vision);
        assert!(infer_caps("claude-3-5-sonnet-20241022").vision);
        assert!(infer_caps("claude-sonnet-4").vision);
        assert!(infer_caps("gemini-2.5-pro").vision);
        assert!(infer_caps("glm-4v-flash").vision);
    }

    #[test]
    fn 多能力可同时成立() {
        // 视觉 + 思考 + 文本 + 工具 四项齐备（用户点名的场景）
        let c = infer_caps("gpt-4o");
        assert!(c.text && c.vision && c.tools && !c.embedding);
    }

    #[test]
    fn 向量模型不算对话模型且无工具() {
        let c = infer_caps("nomic-embed-text");
        assert!(c.embedding);
        assert!(!c.text, "向量模型不能当对话模型用");
        assert!(!c.vision && !c.reasoning && !c.tools);
    }

    #[test]
    fn 纯视觉本地模型不标工具() {
        assert!(!infer_caps("llava:7b").tools);
        assert!(!infer_caps("moondream2").tools);
    }

    #[test]
    fn 大小写不敏感() {
        assert!(infer_caps("QWEN2.5-VL-7B").vision);
    }

    #[test]
    fn 未知模型不猜() {
        let c = infer_caps("some-random-model-2026");
        assert!(c.text);
        assert!(!c.vision && !c.reasoning && !c.embedding);
    }

    #[test]
    fn ollama标签形式能命中() {
        // Ollama 返回 "qwen2.5vl:7b" 这种无分隔的写法
        assert!(infer_caps("qwen2.5vl:7b").vision);
    }

    #[test]
    fn 容量表按顺序先命中先赢() {
        // 更具体的名字必须排在泛化之前，否则会拿到错的值
        assert_eq!(infer_capacity("gpt-4.1-mini").map(|c| c.0), Some(1_047_576));
        // gpt-4o 命中 4o（128k），而不是泛化的 gpt-4（8k）
        assert_eq!(infer_capacity("gpt-4o").map(|c| c.0), Some(128_000));
        assert_eq!(infer_capacity("gpt-4-0613").map(|c| c.0), Some(8_192));
    }

    #[test]
    fn 容量表带版本后缀仍命中() {
        assert_eq!(infer_capacity("claude-3-5-sonnet-20241022").map(|c| c.1), Some(8_192));
        assert_eq!(infer_capacity("deepseek-chat").map(|c| c.0), Some(65_536));
    }

    #[test]
    fn 容量表未知返回None不猜() {
        assert!(infer_capacity("some-random-model-2026").is_none());
    }
}
