// 推理（思考）档位：**优先用供应商上报的档位，缺省回落内置保守表**。
//
// 为什么这么设计（用户明确要求「从供应商获取+兜底，因为有的发错会直接不可用」）：
//   reasoning_effort 的取值集合因端点/版本而异，发一个端点不认识的值会被**直接 400**，
//   表现为「这个模型忽然不能用了」。所以取值必须**来源可靠**：
//     ① 供应商在上报里给了档位（`reasoning.efforts` 等）→ 原样采用，绝不臆造；
//     ② 没给 → 回落内置表，且内置表**只放已被本项目验证过或官方文档明确的值**；
//     ③ 兜底永远是 off + high：这正是改造前 thinking 开关发的两个状态，**零回归**。
//
// off 是特殊值：不发 reasoning_effort（等价于旧 thinking=false，且恢复 temperature 等采样参数）。

use serde::{Deserialize, Serialize};

use super::caps_infer::has_token;

/// 「关」档的 id。特殊：发送时**不发** reasoning_effort。
pub const EFFORT_OFF: &str = "off";

/// 一个可选档位。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EffortOption {
    /// 线上值（会作为 reasoning_effort 原样发出；off 除外）。
    pub id: String,
    /// 展示名（供应商给了名字就用它，否则由 id 首字母大写）。
    pub name: String,
}

/// 某模型可用的推理档位集合。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningSpec {
    /// 恒含 off，且按由弱到强有序。
    pub efforts: Vec<EffortOption>,
    /// 默认档位；缺省时调用方取第一个非 off，再不行取 off。
    #[serde(default)]
    pub default: Option<String>,
    /// true = 来自供应商上报；false = 内置保守兜底（UI 可据此提示来源）。
    #[serde(default)]
    pub from_provider: bool,
}

impl ReasoningSpec {
    /// 默认档位（保证落在集合内）。
    pub fn default_effort(&self) -> String {
        if let Some(d) = self.default.as_deref() {
            if self.has(d) {
                return d.to_string();
            }
        }
        self.efforts
            .iter()
            .find(|e| !e.id.eq_ignore_ascii_case(EFFORT_OFF))
            .map(|e| e.id.clone())
            .unwrap_or_else(|| EFFORT_OFF.to_string())
    }

    /// 集合里是否有该档位（大小写不敏感）。
    pub fn has(&self, id: &str) -> bool {
        let id = id.trim();
        !id.is_empty() && self.efforts.iter().any(|e| e.id.eq_ignore_ascii_case(id))
    }
}

fn o(id: &str, name: &str) -> EffortOption {
    EffortOption { id: id.to_string(), name: name.to_string() }
}

/// 由 id 生成展示名（"medium" → "Medium"）。
fn title(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// OpenAI 推理系（o1/o3/o4 与 gpt-5）：其 reasoning_effort 取值有官方文档，
/// low/medium/high 可以放心发。
fn is_openai_reasoning(n: &str) -> bool {
    ["o1", "o3", "o4"].iter().any(|t| has_token(n, t)) || n.contains("gpt-5")
}

/// 内置保守兜底表。**改动此处请务必确认取值有据**。
pub fn builtin_spec(model: &str) -> ReasoningSpec {
    let n = model.to_lowercase();
    if is_openai_reasoning(&n) {
        return ReasoningSpec {
            efforts: vec![o("off", "Off"), o("low", "Low"), o("medium", "Medium"), o("high", "High")],
            default: Some("medium".into()),
            from_provider: false,
        };
    }
    // 其余一律只给 off/high —— 正是改造前 thinking 开关的两个状态，绝不臆造中间档。
    ReasoningSpec {
        efforts: vec![o("off", "Off"), o("high", "High")],
        default: Some(EFFORT_OFF.into()),
        from_provider: false,
    }
}

/// 解析供应商上报的档位数组，宽松支持几种形状：
/// `["low","high"]`、`[{id,name}]`、`[{value,label}]`、`[{effort}]`。
fn parse_options(v: &serde_json::Value) -> Vec<EffortOption> {
    let Some(arr) = v.as_array() else { return Vec::new() };
    let mut out: Vec<EffortOption> = Vec::new();
    for it in arr {
        let (id, name) = if let Some(s) = it.as_str() {
            (s.trim().to_string(), String::new())
        } else if let Some(map) = it.as_object() {
            let id = map
                .get("id")
                .or_else(|| map.get("value"))
                .or_else(|| map.get("effort"))
                .and_then(|x| x.as_str())
                .map(str::trim)
                .unwrap_or("")
                .to_string();
            let name = map
                .get("name")
                .or_else(|| map.get("label"))
                .and_then(|x| x.as_str())
                .map(str::trim)
                .unwrap_or("")
                .to_string();
            (id, name)
        } else {
            (String::new(), String::new())
        };
        if id.is_empty() || out.iter().any(|e| e.id.eq_ignore_ascii_case(&id)) {
            continue;
        }
        out.push(EffortOption { name: if name.is_empty() { title(&id) } else { name }, id });
    }
    out
}

/// 从供应商上报的模型条目里解析档位。返回 None = 供应商没给（调用方回落内置表）。
pub fn spec_from_entry(e: &serde_json::Value) -> Option<ReasoningSpec> {
    let reasoning = e.get("reasoning");
    let raw = reasoning
        .and_then(|r| r.get("efforts"))
        .or_else(|| e.get("efforts"))?;
    let mut efforts = parse_options(raw);
    if efforts.is_empty() {
        return None;
    }
    // 供应商常只列「正档」（low/medium/high）而不列 off；补一个 off，
    // 否则用户无法真正关掉推理（那是旧 thinking 开关就有的能力，不能退化）。
    if !efforts.iter().any(|x| x.id.eq_ignore_ascii_case(EFFORT_OFF)) {
        efforts.insert(0, o(EFFORT_OFF, "Off"));
    }
    let default = reasoning
        .and_then(|r| r.get("defaultEffort").or_else(|| r.get("default")))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Some(ReasoningSpec { efforts, default, from_provider: true })
}

/// 供应商上报优先，没有则内置兜底。
pub fn resolve_spec(model: &str, entry: Option<&serde_json::Value>) -> ReasoningSpec {
    entry.and_then(spec_from_entry).unwrap_or_else(|| builtin_spec(model))
}

/// 把想用的档位收敛到 spec 允许的集合内。
///
/// 用途：配置里可能留着「在**别的**模型上设过的档位」（比如从 gpt-5 的 medium 切到
/// 只认 off/high 的模型），直接把那个值发出去就会 400。收敛到默认档位比发错值安全。
pub fn clamp_effort(spec: &ReasoningSpec, wanted: &str) -> String {
    if spec.has(wanted) { wanted.trim().to_lowercase() } else { spec.default_effort() }
}

#[cfg(test)]
mod tests {
    // 测试名写中文是故意的（见 caps_infer.rs 同处说明），关掉 non_snake_case。
    #![allow(non_snake_case)]
    use super::*;
    use serde_json::json;

    #[test]
    fn 兜底表_非OpenAI只给off与high() {
        let s = builtin_spec("deepseek-chat");
        assert_eq!(s.efforts.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), vec!["off", "high"]);
        assert!(!s.from_provider);
    }

    #[test]
    fn 兜底表_OpenAI推理系给四档() {
        for m in ["o1", "o3-mini", "o4-mini", "gpt-5.6"] {
            let s = builtin_spec(m);
            assert_eq!(
                s.efforts.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
                vec!["off", "low", "medium", "high"],
                "{} 应给四档", m
            );
            assert_eq!(s.default.as_deref(), Some("medium"));
        }
    }

    #[test]
    fn 供应商上报优先于兜底() {
        let entry = json!({ "reasoning": { "efforts": ["low", "high"], "defaultEffort": "high" } });
        let s = resolve_spec("deepseek-chat", Some(&entry));
        assert!(s.from_provider);
        // 供应商没列 off，自动补上
        assert_eq!(s.efforts.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), vec!["off", "low", "high"]);
        assert_eq!(s.default_effort(), "high");
    }

    #[test]
    fn 供应商上报支持对象与别名形状() {
        let entry = json!({ "efforts": [{ "value": "minimal", "label": "Minimal" }, { "id": "high", "name": "High" }] });
        let s = resolve_spec("x", Some(&entry)).clone();
        let ids: Vec<&str> = s.efforts.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["off", "minimal", "high"]);
        assert_eq!(s.efforts[1].name, "Minimal");
        assert_eq!(s.efforts[2].name, "High");
    }

    #[test]
    fn 供应商给了但为空则回落兜底() {
        let entry = json!({ "reasoning": { "efforts": [] } });
        let s = resolve_spec("deepseek-chat", Some(&entry));
        assert!(!s.from_provider, "空数组视为没给，应回落兜底");
    }

    #[test]
    fn 上报里已有off不重复补() {
        let entry = json!({ "reasoning": { "efforts": ["off", "high"] } });
        let s = resolve_spec("x", Some(&entry));
        assert_eq!(s.efforts.iter().filter(|e| e.id == "off").count(), 1);
    }

    #[test]
    fn 重复档位去重() {
        let entry = json!({ "reasoning": { "efforts": ["high", "HIGH", "low"] } });
        let s = resolve_spec("x", Some(&entry));
        let ids: Vec<&str> = s.efforts.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["off", "high", "low"]);
    }

    #[test]
    fn 默认档位保证落在集合内() {
        // 供应商给了个不在集合里的 default → 回落到第一个非 off
        let entry = json!({ "reasoning": { "efforts": ["low", "high"], "defaultEffort": "ultra" } });
        let s = resolve_spec("x", Some(&entry));
        assert_eq!(s.default_effort(), "low");
    }

    #[test]
    fn clamp把越界档位收到默认() {
        let s = builtin_spec("deepseek-chat"); // 只有 off/high
        assert_eq!(clamp_effort(&s, "medium"), "off", "medium 不在集合内 → 收敛到默认");
        assert_eq!(clamp_effort(&s, "high"), "high");
        assert_eq!(clamp_effort(&s, "OFF"), "off", "大小写不敏感");
    }
}
