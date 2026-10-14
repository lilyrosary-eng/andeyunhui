// 按模型名推断能力标记 + 兜底容量。
//
// 为什么需要：绝大多数 /v1/models 端点不返回能力信息，只有 id。
// 折叠面板上要显示「文本 · 思考 · 视觉 · 工具」标签，需要一个初始值。
//
// ⚠️ 现状：本文件的推断结果**只用于 UI 展示**。`resolve_target` 的视觉模型回落是
//    **无条件**的，并不看 `caps.vision`（见 ai_profile.rs 的对应注释）。
//    即「原生支持视觉就直连、不支持才回落独立视觉模型」这条逻辑**尚未实现**。
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
pub(crate) fn has_token(n: &str, tok: &str) -> bool {
    n.split(|c: char| !c.is_ascii_alphanumeric()).any(|seg| seg == tok)
}

/// 按模型名推断能力标记。
///
/// ⚠️ 产出的 `vision` **必须**带 `vision_source: Inferred` —— 这个标记是
/// 「重扫时能否被覆盖」与「UI 该显示实测还是推断」的唯一依据。
/// 把它标成 None 会让探测结论被名字启发式永久压制（或反之）。
pub fn infer_caps(model_name: &str) -> Caps {
    let n = model_name.to_lowercase();
    let has = |hints: &[&str]| hints.iter().any(|h| n.contains(h));

    // 向量模型既不是对话模型，也无视觉/思考/工具可言
    if has(EMBEDDING_HINTS) {
        return Caps {
            text: false,
            embedding: true,
            vision_source: Some(super::ai_profile::CapsSource::Inferred),
            ..Default::default()
        };
    }
    let reasoning = has(REASONING_HINTS) || REASONING_TOKENS.iter().any(|t| has_token(&n, t));
    let vision = has(VISION_HINTS);
    let tools = !has(NO_TOOLS_HINTS);
    Caps {
        text: true,
        vision,
        reasoning,
        tools,
        embedding: false,
        vision_source: Some(super::ai_profile::CapsSource::Inferred),
    }
}

/// 容量兜底表：模型名片段 → (上下文, 单次最大输出)。
///
/// 匹配规则：大小写不敏感的**子串包含**，**按顺序先命中先赢**——所以更具体的名字必须排在
/// 更泛的前面（`gpt-4o-mini` 在 `gpt-4o` 前，`gpt-4o` 在 `gpt-4` 前）。
///
/// ⚠️ 值为公开资料的近似值，仅供参考。优先级：**用户手填 > 端点自报 > 本表**。
///
/// 数据源：`assets/model_capacity.json`（编译期内嵌为默认值）。应用数据目录下若有同名文件
/// 则**覆盖**内嵌默认——不必改代码/重编译即可更新，见 `init_capacity_table`。
const DEFAULT_CAPACITY_JSON: &str = include_str!("../../../assets/model_capacity.json");

#[derive(serde::Deserialize)]
struct CapacityEntry {
    /// 匹配片段（加载时统一转小写）
    #[serde(rename = "match")]
    pattern: String,
    ctx: u64,
    out: u64,
}

#[derive(serde::Deserialize)]
struct CapacityFile {
    entries: Vec<CapacityEntry>,
}

/// 已加载的容量表。启动时由 `init_capacity_table` 填入；未初始化则惰性用内嵌默认。
static CAPACITY_TABLE: std::sync::OnceLock<Vec<CapacityEntry>> = std::sync::OnceLock::new();

/// 解析容量表 JSON。空表/解析失败返回 None（调用方回落内嵌默认）。
fn parse_capacity_json(text: &str) -> Option<Vec<CapacityEntry>> {
    let f: CapacityFile = serde_json::from_str(text).ok()?;
    let entries: Vec<CapacityEntry> = f
        .entries
        .into_iter()
        .filter(|e| !e.pattern.trim().is_empty())
        .map(|mut e| {
            e.pattern = e.pattern.trim().to_lowercase();
            e
        })
        .collect();
    if entries.is_empty() {
        None
    } else {
        Some(entries)
    }
}

/// 初始化容量表（**幂等**，只有第一次调用生效）。
///
/// 来源优先级：`override_path` 指向的文件 > 内嵌默认。
/// 覆盖文件读不到或解析失败时**静默回落内嵌默认**——容量只是增强信息，
/// 不该因为一个坏文件让整个模型发现功能报错。
pub fn init_capacity_table(override_path: Option<&std::path::Path>) {
    let from_file = override_path
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| parse_capacity_json(&t));
    let table = from_file
        .or_else(|| parse_capacity_json(DEFAULT_CAPACITY_JSON))
        .unwrap_or_default();
    let _ = CAPACITY_TABLE.set(table);
}

fn capacity_table() -> &'static [CapacityEntry] {
    CAPACITY_TABLE.get_or_init(|| parse_capacity_json(DEFAULT_CAPACITY_JSON).unwrap_or_default())
}

/// 按模型名查兜底容量，返回 (上下文窗口, 最大输出)。
/// 查不到返回 None——**不猜**：给一个错的数字比留空更误导（用户会以为已识别）。
pub fn infer_capacity(model_name: &str) -> Option<(u64, u64)> {
    let n = model_name.to_lowercase();
    capacity_table()
        .iter()
        .find(|e| n.contains(&e.pattern))
        .map(|e| (e.ctx, e.out))
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
    fn 内嵌默认表必须是合法json且条目充足() {
        // ★ 血案（2026-10-14）：删容量条目时删掉了数组末尾那几条，但**漏改末条逗号**
        //   → JSON 非法 → `parse_capacity_json` 返回 None → 回落内嵌默认 →
        //   而内嵌默认就是这份坏文件 → **整张表静默变空**。
        //   后果：所有模型容量全变横线，且没有任何错误提示（解析失败是刻意静默的，
        //   见 init_capacity_table 的文档）。三个测试同时挂掉才暴露出这一点。
        //
        //   这条测试把「坏表」挡在最早的一道门：只要文件语法错或条目被误删到离谱，
        //   编译后第一次跑测试就会红，而不是等用户发现"怎么全是横线"。
        let parsed = parse_capacity_json(DEFAULT_CAPACITY_JSON);
        assert!(parsed.is_some(), "内嵌默认容量表必须能解析（JSON 语法错 / entries 为空都会到这里）");
        let t = parsed.unwrap();
        assert!(t.len() >= 30, "条目数异常少（{} 条），可能被误删或格式损坏", t.len());

        // 抽查常用条目必须还在（防止"批量清理"时顺手删掉主力）
        let has = |p: &str| t.iter().any(|e| e.pattern == p);
        for p in ["gpt-4o", "claude-3-5-sonnet", "deepseek-chat", "qwen2.5"] {
            assert!(has(p), "常用条目 `{}` 不该缺失", p);
        }

        // pattern 一律小写（匹配是按小写子串做的，混入大写会永远命不中）
        assert!(
            t.iter().all(|e| e.pattern == e.pattern.to_lowercase()),
            "所有 pattern 必须已归一为小写"
        );
    }

    #[test]
    fn 跨代泛化条目不该存在() {
        // 这类 pattern 会命中规格完全不同的多代模型，必然给错值。
        // 实测证据：`gemma` → 8192 同时命中 gemma-2（确实 8k）与 gemma-3（实际 128k）；
        // `mistral` → 32768 命中 mistral-large-2（实际 128k）。
        // 用户要求「兜底表收缩到可确认的」——宁缺不错：留空至少用户知道是空的。
        let t = parse_capacity_json(DEFAULT_CAPACITY_JSON).expect("表应可解析");
        for bad in ["claude", "gemini", "deepseek", "qwen", "glm-4", "mistral", "gemma"] {
            assert!(
                !t.iter().any(|e| e.pattern == bad),
                "跨代泛化条目 `{}` 会给多代模型同一个错值，应已移除",
                bad
            );
        }
    }

    #[test]
    fn 容量表未知返回None不猜() {        assert!(infer_capacity("some-random-model-2026").is_none());
    }
}
