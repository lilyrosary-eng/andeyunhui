// 按模型名推断能力标记。
//
// 为什么需要：绝大多数 /v1/models 端点不返回能力信息，只有 id。
// 折叠面板上要显示「文本 · 思考 · 视觉」标签，resolve_target 要按 caps.vision
// 决定视觉模型能否回落到自身，两者都需要一个初始值。
//
// ⚠️ 这是启发式，不是权威信息。用户在模型编辑器里可以手动改，改过的以用户为准。
//   前缀规则改动集中在本文件的两个常量里，便于日后按实测修正。

use super::ai_profile::Caps;

/// 名称里含这些片段 → 推理模型
const REASONING_HINTS: &[&str] = &[
    "deepseek-reasoner", "deepseek-r1", "qwq", "thinking", "reasoning",
    "-r1", "r1-", "o1", "o3", "o4",
];

/// 名称里含这些片段 → 视觉模型
const VISION_HINTS: &[&str] = &[
    "-vl", "vl-", "vl:", "-vision", "vision-", "llava", "pixtral", "moondream",
    "minicpm-v", "internvl", "qwen-vl",
];

/// 名称里含这些片段 → 向量模型（不是对话模型）
const EMBEDDING_HINTS: &[&str] = &[
    "embed", "embedding", "bge-", "nomic-embed", "e5-",
];

pub fn infer_caps(model_name: &str) -> Caps {
    let n = model_name.to_lowercase();
    let has = |hints: &[&str]| hints.iter().any(|h| n.contains(h));

    let embedding = has(EMBEDDING_HINTS);
    Caps {
        text: !embedding,
        vision: !embedding && has(VISION_HINTS),
        reasoning: !embedding && has(REASONING_HINTS),
        embedding,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 普通对话模型只标文本() {
        let c = infer_caps("deepseek-chat");
        assert!(c.text && !c.vision && !c.reasoning && !c.embedding);
    }

    #[test]
    fn 推理模型带思考标记() {
        assert!(infer_caps("deepseek-reasoner").reasoning);
        assert!(infer_caps("deepseek-r1:7b").reasoning);
        assert!(infer_caps("qwq-32b").reasoning);
        assert!(infer_caps("o3-mini").reasoning);
    }

    #[test]
    fn 视觉模型带视觉标记() {
        assert!(infer_caps("qwen2.5-vl-72b-instruct").vision);
        assert!(infer_caps("llava:7b").vision);
        assert!(infer_caps("minicpm-v-2_6").vision);
    }

    #[test]
    fn 向量模型不算对话模型() {
        let c = infer_caps("nomic-embed-text");
        assert!(c.embedding);
        assert!(!c.text, "向量模型不能当对话模型用");
        assert!(!c.vision && !c.reasoning);
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
}
