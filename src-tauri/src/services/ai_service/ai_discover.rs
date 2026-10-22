// 「填 base URL 或只填端口 → 拉取该端点的全部模型」的 Rust 侧实现。
//
// 分层：解析层（本文件的纯函数，可单测）与探测层（reqwest，需真实网络）分开，
// 绝大多数逻辑能在 cargo test 里覆盖，不用起本地 HTTP 服务。
//
// ★ 拉到的模型永远是「候选」，本命令绝不写盘。写盘由前端勾选后调 ai_set_config 完成，
//   用户始终保有否决权。

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::task::JoinSet;

use super::ai_profile::{Caps, CapsSource};
use super::ai_profile::CapacitySource;
use super::caps_infer::{infer_capacity, infer_caps};
use super::reasoning::{builtin_spec, spec_from_entry, ReasoningSpec};

pub const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct DiscoveredModel {
    /// 上游实际模型名——这就是要发出去的 model 值
    pub model: String,
    /// 展示名，仅当上游给了不同于 model 的名字时才有值
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub context_tokens: Option<u64>,
    #[serde(default)]
    pub max_tokens: Option<u64>,
    /// 容量来源：端点自报 or 兜底表推断。前端据此落盘，决定重扫时能否覆盖。
    #[serde(default)]
    pub ctx_source: Option<CapacitySource>,
    #[serde(default)]
    pub out_source: Option<CapacitySource>,
    /// 按模型名推断的能力标记，由 caps_infer::infer_caps 填充
    #[serde(default)]
    pub caps: Caps,
    /// true = 能力来自供应商**权威上报**（Ollama `capabilities` / OpenRouter `input_modalities`），
    /// 此时不再用名字启发式覆盖。不参与序列化——纯内部标记。
    #[serde(skip)]
    pub caps_reported: bool,
    /// 推理档位：供应商上报优先（spec_from_entry），没有则内置保守兜底（builtin_spec）。
    /// UI 只从这里列出的档位中选，避免发出端点不认识的值。
    #[serde(default)]
    pub reasoning: Option<ReasoningSpec>,
}

fn nonempty_str(v: Option<&serde_json::Value>) -> Option<String> {
    v.and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn pos_u64(v: Option<&serde_json::Value>) -> Option<u64> {
    v.and_then(|x| x.as_u64()).filter(|n| *n > 0)
}

/// 上下文长度：各家 `/v1/models` 的字段名**不统一**，这里穷尽已知方言。
///
/// 实测教训：只认 `context_window` / `context_length` 时，59 个模型里只认出 4 个上下文。
/// Ollama 的 `details.context_length`（0.30+ 才有）在 `details` 子对象里，同样要读。
/// 上下文长度的**方言键**，按「对本次发送最有约束力」排序。
///
/// ⚠️ 顺序有实质影响：`loaded_context_length`（服务端**当前已加载**的窗口）必须排在
/// `max_context_length`（模型理论上限）**前面**。LM Studio 里同一个模型可以
/// 「最大 131072、当前只加载 4096」，按最大值放行 ⇒ 请求必被 400；
/// 按已加载窗口算压缩阈值才是"这次真能发多少"。
const CONTEXT_KEYS: &[&str] = &[
    "loaded_context_length",    // LM Studio / llama.cpp server：当前已加载窗口（最贴近真实）
    "max_context_length",       // LM Studio：模型最大
    "context_window",           // 部分中转站
    "context_length",           // OpenRouter、Ollama /v1/models
    "max_model_len",            // vLLM
    "max_input_tokens",         // 若干中转站
    "n_ctx",                    // llama.cpp
];

/// 取上下文长度 + **命中的键名**（键名决定来源标 `provider` 还是 `loaded`）。
fn context_of_with_key(e: &serde_json::Value) -> Option<(u64, &'static str)> {
    CONTEXT_KEYS
        .iter()
        .find_map(|k| pos_u64(e.get(*k)).map(|v| (v, *k)))
        .or_else(|| {
            pos_u64(e.get("details").and_then(|d| d.get("context_length")))
                .map(|v| (v, "details.context_length"))
        })
}

/// 仅测试用：只要值不要键名（生产路径统一走 [`context_of_with_key`]，因为来源要区分
/// `loaded`（当前已加载窗口）与 `provider`（模型最大））。
#[cfg(test)]
fn context_of(e: &serde_json::Value) -> Option<u64> {
    context_of_with_key(e).map(|(v, _)| v)
}

/// 单次最大输出。`max_tokens` 语义最含糊（有的端点拿它当上下文），故排在最后。
fn max_output_of(e: &serde_json::Value) -> Option<u64> {
    const KEYS: &[&str] = &["max_output_tokens", "max_completion_tokens", "max_tokens"];
    KEYS.iter()
        .find_map(|k| pos_u64(e.get(*k)))
        // OpenRouter：单次最大输出挂在 top_provider 下
        .or_else(|| pos_u64(e.get("top_provider").and_then(|t| t.get("max_completion_tokens"))))
}

/// 供应商**权威**能力上报。返回 None = 没报，调用方回落名字启发式（`infer_caps`）。
///
/// 支持两种已知形状：
/// - Ollama 0.30+ `/api/tags`：`capabilities: ["completion","vision","tools","thinking","embedding"]`
/// - OpenRouter `/api/v1/models`：`architecture.input_modalities`（含 `image` → 视觉）
///   + `architecture.output_modalities` + `supported_parameters`（含 `tools` / `reasoning`）
fn caps_from_entry(e: &serde_json::Value) -> Option<Caps> {
    let as_arr = |v: Option<&serde_json::Value>| v.and_then(|x| x.as_array()).cloned();
    let has_in = |arr: &Option<Vec<serde_json::Value>>, k: &str| {
        arr.as_ref().map(|a| a.iter().filter_map(|v| v.as_str()).any(|s| s.eq_ignore_ascii_case(k))).unwrap_or(false)
    };

    // ① Ollama：capabilities 数组
    let caps = as_arr(e.get("capabilities"));
    if caps.as_ref().map(|a| !a.is_empty()).unwrap_or(false) {
        let embedding = has_in(&caps, "embedding");
        return Some(Caps {
            text: has_in(&caps, "completion") || !embedding,
            vision: has_in(&caps, "vision"),
            reasoning: has_in(&caps, "thinking") || has_in(&caps, "reasoning"),
            tools: has_in(&caps, "tools"),
            embedding,
            // 供应商上报 = 权威。视觉这一位标 Provider，重扫时不会被名字启发式冲掉。
            vision_source: Some(CapsSource::Provider),
            ..Default::default()
        });
    }

    // ② OpenRouter：architecture.input/output_modalities + supported_parameters
    let arch = e.get("architecture");
    let in_mods = as_arr(arch.and_then(|a| a.get("input_modalities")));
    if in_mods.as_ref().map(|a| !a.is_empty()).unwrap_or(false) {
        let out_mods = as_arr(arch.and_then(|a| a.get("output_modalities")));
        let params = as_arr(e.get("supported_parameters"));
        let embedding = has_in(&in_mods, "embedding")
            || has_in(&out_mods, "embeddings")
            || has_in(&out_mods, "embedding");
        return Some(Caps {
            text: has_in(&in_mods, "text") && !embedding,
            vision: has_in(&in_mods, "image"),
            reasoning: has_in(&params, "reasoning") || has_in(&params, "include_reasoning"),
            tools: has_in(&params, "tools"),
            embedding,
            vision_source: Some(CapsSource::Provider),
            ..Default::default()
        });
    }

    None
}

/// OpenAI 兼容形状的一行。上游用 `id` 表示模型名；缺失/为空 → None（跳过该行，不整批失败）。
fn parse_openai_entry(e: &serde_json::Value) -> Option<DiscoveredModel> {
    let model = nonempty_str(e.get("id"))?;
    let reported = caps_from_entry(e);
    // 同一个读法，但把"命中的是哪个键"一起记下来：`loaded_context_length` 是
    // 当前已加载窗口（来源标 loaded），其余都是模型自报上限（来源标 provider）。
    let ctx = context_of_with_key(e);
    Some(DiscoveredModel {
        model,
        label: nonempty_str(e.get("name")).or_else(|| nonempty_str(e.get("display_name"))),
        context_tokens: ctx.map(|(v, _)| v),
        max_tokens: max_output_of(e),
        ctx_source: ctx.map(|(_, k)| {
            if k == "loaded_context_length" {
                CapacitySource::Loaded
            } else {
                CapacitySource::Provider
            }
        }),
        out_source: None,
        caps: reported.clone().unwrap_or_default(),
        caps_reported: reported.is_some(),
        // 供应商若在上报里列了档位就原样采用；没列则留 None，由 with_caps 落兜底表
        reasoning: spec_from_entry(e),
    })
}

/// Ollama 原生形状的一行：`{ name, model, details: { context_length }, capabilities: [...] }`。
///
/// 注意：**0.30 起 `/api/tags` 会报** `details.context_length` 与权威 `capabilities`，
/// 所以这里不再是无脑留空（旧注释「Ollama 不报 context」已过时）。
fn parse_ollama_entry(e: &serde_json::Value) -> Option<DiscoveredModel> {
    let model = nonempty_str(e.get("model")).or_else(|| nonempty_str(e.get("name")))?;
    let reported = caps_from_entry(e);
    let ctx = context_of_with_key(e);
    Some(DiscoveredModel {
        model,
        label: nonempty_str(e.get("name")),
        context_tokens: ctx.map(|(v, _)| v),
        max_tokens: max_output_of(e),
        ctx_source: ctx.map(|(_, k)| {
            if k == "loaded_context_length" {
                CapacitySource::Loaded
            } else {
                CapacitySource::Provider
            }
        }),
        out_source: None,
        caps: reported.clone().unwrap_or_default(),
        caps_reported: reported.is_some(),
        reasoning: spec_from_entry(e),
    })
}

/// 按响应体形状自动解析：先试 OpenAI 的 `data[]`，再试 Ollama 的 `models[]`。
/// 两个都没有就直接报错，不猜其他形状——猜错与「该端点确实没有模型」
/// 在用户看来完全一样，报错比给出错误列表诚实。
pub fn parse_listing(body: &serde_json::Value) -> Result<Vec<DiscoveredModel>, String> {
    if let Some(data) = body.get("data").and_then(|v| v.as_array()) {
        return Ok(with_caps(data.iter().filter_map(parse_openai_entry).collect()));
    }
    if let Some(models) = body.get("models").and_then(|v| v.as_array()) {
        return Ok(with_caps(models.iter().filter_map(parse_ollama_entry).collect()));
    }
    let keys: Vec<String> = body
        .as_object()
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    Err(format!(
        "响应里既没有 data 也没有 models 数组（实际顶层键：{}）。请确认填的是 API 端点（如 https://x/v1），不是网页地址。",
        if keys.is_empty() { "无".to_string() } else { keys.join(", ") }
    ))
}

/// 给解析出的模型批量补上「按模型名推断的能力标记」，并在端点未报容量时用静态表兜底。
/// 推断与兜底表只有后端有（caps_infer），前端不复制这两张表。
///
/// 容量优先级：**端点自报 > 兜底表 > 留空**。绝大多数 OpenAI 兼容端点的 /v1/models
/// 只回 id，兜底表让上下文/输出长度在设置页有个可用的初始值（用户仍可改）。
fn with_caps(mut models: Vec<DiscoveredModel>) -> Vec<DiscoveredModel> {
    for m in models.iter_mut() {
        // 能力：供应商**权威上报**优先，没报才退回名字启发式
        if !m.caps_reported {
            m.caps = infer_caps(&m.model);
        }

        // 容量：端点自报优先，缺的用兜底表补；并**如实记录来源**，
        // 供重扫时判断该字段能否覆盖（见 CapacitySource::refreshable）。
        // 来源由解析阶段就写好（loaded / provider），这里只负责"没自报时用表补"。
        let ctx_from_endpoint = m.ctx_source.is_some() || m.context_tokens.is_some();
        let out_from_endpoint = m.max_tokens.is_some();
        if let Some((ctx, out)) = infer_capacity(&m.model) {
            if m.context_tokens.is_none() {
                m.context_tokens = Some(ctx);
            }
            if m.max_tokens.is_none() {
                m.max_tokens = Some(out);
            }
        }
        if m.ctx_source.is_none() {
            m.ctx_source = if ctx_from_endpoint {
                Some(CapacitySource::Provider)
            } else if m.context_tokens.is_some() {
                Some(CapacitySource::Table)
            } else {
                None
            };
        }
        m.out_source = if out_from_endpoint {
            Some(CapacitySource::Provider)
        } else if m.max_tokens.is_some() {
            Some(CapacitySource::Table)
        } else {
            None
        };

        // 档位：供应商上报优先，没给才落内置保守表（见 reasoning.rs 的取值谨慎原则）
        if m.reasoning.is_none() {
            m.reasoning = Some(builtin_spec(&m.model));
        }
    }
    models
}

/// 4 MiB 上限的两段式检查。抽成纯函数是因为 reqwest::Response 不好在单测里构造。
///
/// 先看声明的 content-length（超限直接拒，省流量），再看流式累加的实际字节
/// （防服务端少报或用分块传输）。超限是 reject 不是 truncate——模型列表被截断后无法解析。
pub fn size_guard(declared: Option<u64>, total: u64) -> Result<(), String> {
    if let Some(d) = declared {
        if d > MAX_RESPONSE_BYTES {
            return Err(format!("响应体过大（声明 {} 字节，上限 {} 字节）", d, MAX_RESPONSE_BYTES));
        }
    }
    if total > MAX_RESPONSE_BYTES {
        return Err(format!("响应体过大（实际 {} 字节，上限 {} 字节）", total, MAX_RESPONSE_BYTES));
    }
    Ok(())
}

/// 把用户填的 endpoint 变成候选请求 URL 列表。
///
/// 完整 base_url（含 `://`）→ 只打一枪。**base_url 当前缀，不做 URL resolve**，
/// 所以 `https://gateway.example/openai/v1` 会保留 `/openai/v1` 这段路径。
///
/// 纯端口或 `host:port` → 候选 `/v1/models` 与裸 `/models` 两种形状（OpenAI 兼容与
/// Ollama 风格都常见）。`/api/models` 是 Ollama 专用端点，几乎只在本地，仅在本地
/// 追加，避免远端多等一个超时。
pub fn candidate_urls(endpoint: &str) -> Vec<String> {
    let e = endpoint.trim();
    if e.is_empty() {
        return Vec::new();
    }
    if e.contains("://") {
        return vec![format!("{}/models", e.trim_end_matches('/'))];
    }
    let (host, port) = match e.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => {
            (h.trim().to_string(), p.to_string())
        }
        _ => ("127.0.0.1".to_string(), e.to_string()),
    };
    let host = if host.is_empty() { "127.0.0.1".to_string() } else { host };
    let is_local = host == "localhost" || host == "127.0.0.1";
    // ⚠️ 顺序是有意的：**本地先试原生富端点，再回落 OpenAI 兼容端点**。
    //    原因：Ollama 的 `/v1/models` 也**能成功**，若排在前面就会永远命中它，
    //    从而拿不到 `/api/tags` 的 `details.context_length` 与权威 `capabilities`
    //    （旧代码正是这样，注释里还写着"Ollama 不报 context"——0.30 起已经报了）。
    let mut out: Vec<String> = Vec::new();
    if is_local {
        out.push(format!("http://{host}:{port}/api/tags")); // Ollama 原生（容量 + 能力）
        out.push(format!("http://{host}:{port}/api/v0/models")); // LM Studio 原生（含 max_context_length）
    }
    out.push(format!("http://{host}:{port}/v1/models"));
    // 裸 /models 对所有主机都试
    out.push(format!("http://{host}:{port}/models"));
    out
}

/// 单个候选 URL 的探测结果
struct Probe {
    url: String,
    models: Result<Vec<DiscoveredModel>, String>,
    /// 诊断：响应顶层出现的键（成功解析时才有）。
    top_keys: Vec<String>,
    /// 诊断：所有模型条目里出现过的键（去重排序）。
    model_keys: Vec<String>,
}

/// 我们从端点响应里**读过**的键（诊断时用来算"报了但我们没读"的那批）。
///
/// 维护要求：给 `context_of` / `max_output_of` / `caps_from_entry` / `parse_*_entry`
/// 新增字段名时，**必须同步加到这里**，否则新读的字段会被诊断误报成"未识别"。
const RECOGNIZED_KEYS: &[&str] = &[
    // 模型标识
    "id", "name", "model", "display_name",
    // 上下文长度方言
    "context_window", "context_length", "max_context_length", "loaded_context_length",
    "max_model_len", "max_input_tokens", "n_ctx", "details",
    // 单次最大输出
    "max_output_tokens", "max_completion_tokens", "max_tokens", "top_provider",
    // 权威能力上报
    "capabilities", "architecture", "supported_parameters",
    // 推理档位
    "reasoning", "reasoning_effort", "supported_reasoning_efforts", "thinking",
    // 时间戳（OpenAI 形状自带，无信息量但也不该报成"未识别"）
    "created", "object", "owned_by", "permission", "root", "parent",
];

/// 从原始响应里提取「端点到底报了什么」。
///
/// ## 为什么需要
/// 容量识别不行的原因分两种，**修法完全不同**：
///   ① 端点压根不报（只能靠兜底表 / 手填）；
///   ② 端点报了，但字段名是另一种方言，我们没读（改几行代码就能修）。
/// 在拿到原始键集合之前，这两者无法区分 —— 实测用户 184 个模型里只有 9 个拿到
/// provider 值，但"是不是端点真没报"此前纯靠推测。
///
/// 返回 `(顶层键, 模型条目键集合)`，都已排序去重。
fn extract_key_set(body: &serde_json::Value) -> (Vec<String>, Vec<String>) {
    let mut top: Vec<String> = body
        .as_object()
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    top.sort();

    // 模型数组：OpenAI 的 data[] 或 Ollama 的 models[]
    let arr = body
        .get("data")
        .and_then(|v| v.as_array())
        .or_else(|| body.get("models").and_then(|v| v.as_array()));

    let mut keys: std::collections::BTreeSet<String> = Default::default();
    if let Some(a) = arr {
        for e in a {
            if let Some(o) = e.as_object() {
                for k in o.keys() {
                    keys.insert(k.clone());
                }
            }
        }
    }
    (top, keys.into_iter().collect())
}

/// 诊断结果：把「端点报了什么」与「我们读了什么」摊开对照。
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EndpointDiagnostics {
    /// 实际命中的 URL。
    pub reached_url: String,
    /// 响应顶层键。
    pub top_keys: Vec<String>,
    /// 所有模型条目里出现过的键。
    pub model_keys: Vec<String>,
    /// **端点报了、但我们没读**的键 —— 这份清单就是下一步该支持的新方言。
    pub unrecognized_keys: Vec<String>,
    /// 命中端点上报告容量的模型数 / 总模型数（判断"端点报不报"的直接指标）。
    pub ctx_reported: usize,
    pub out_reported: usize,
    pub total: usize,
}

impl EndpointDiagnostics {
    fn build(url: String, top_keys: Vec<String>, model_keys: Vec<String>, models: &[DiscoveredModel]) -> Self {
        let unrecognized: Vec<String> = model_keys
            .iter()
            .filter(|k| !RECOGNIZED_KEYS.contains(&k.as_str()))
            .cloned()
            .collect();
        Self {
            reached_url: url,
            top_keys,
            model_keys,
            unrecognized_keys: unrecognized,
            // 「端点自报」而不是「最终值」：后者可能是兜底表补的，
            // 用它判断"端点报不报"会得出错误结论（这正是之前的盲区）。
            ctx_reported: models.iter().filter(|m| m.ctx_source == Some(CapacitySource::Provider)).count(),
            out_reported: models.iter().filter(|m| m.out_source == Some(CapacitySource::Provider)).count(),
            total: models.len(),
        }
    }
}

async fn probe_one(client: &reqwest::Client, url: String, api_key: Option<String>) -> Probe {
    let mut req = client.get(&url).header("accept", "application/json");
    // 没填 key 不算错误：Ollama / LM Studio 这类本地端点本来就无认证，
    // 此时完全不带 Authorization 头，而不是带一个空 Bearer。
    if let Some(k) = api_key.as_ref().filter(|s| !s.trim().is_empty()) {
        req = req.header("Authorization", format!("Bearer {}", k.trim()));
    }

    let outcome = async {
        let mut resp = req.send().await.map_err(|e| format!("端点不可达: {}", e))?;
        let status = resp.status();
        if !status.is_success() {
            let hint = if status == 401 || status == 403 { "；请检查 API Key" } else { "" };
            return Err(format!("HTTP {}{}", status, hint));
        }
        let declared = resp.content_length();
        if let Err(e) = size_guard(declared, 0) {
            return Err(e);
        }
        let mut total: u64 = 0;
        let mut buf: Vec<u8> = Vec::new();
        loop {
            match resp.chunk().await {
                Ok(Some(bytes)) => {
                    total += bytes.len() as u64;
                    size_guard(declared, total)?;
                    buf.extend_from_slice(&bytes);
                }
                Ok(None) => break,
                Err(e) => return Err(format!("读取响应体失败: {}", e)),
            }
        }
        let body: serde_json::Value = serde_json::from_slice(&buf)
            .map_err(|_| "响应不是合法 JSON（多半不是 API 端点）".to_string())?;
        let (top, keys) = extract_key_set(&body);
        Ok((parse_listing(&body), top, keys))
    }
    .await;

    match outcome {
        Ok((models, top_keys, model_keys)) => Probe { url, models, top_keys, model_keys },
        // 失败路径也给一份空键集合：诊断面板仍要能显示「这个候选没成、原因是什么」
        Err(e) => Probe { url, models: Err(e), top_keys: Vec::new(), model_keys: Vec::new() },
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchModelsInput {
    /// 完整 base_url（"https://api.deepseek.com/v1"），或仅端口（"11434"），
    /// 或 "host:port"。不含 "://" 即判定为端口模式。
    pub endpoint: String,
    /// 表单里输入、尚未保存的 key。为空则完全不带 Authorization 头。
    #[serde(default)]
    pub api_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchModelsOutput {
    /// 探测命中的 base_url（去掉末尾的 /models）。端口模式下可能与用户输入不同，
    /// 前端要拿它回填表单——用户填 11434 可能命中 /v1 也可能命中 /api。
    pub resolved_base_url: String,
    pub models: Vec<DiscoveredModel>,
    /// 试过但失败的候选，仅用于错误提示（「试过这些地址都没成功：…」）
    pub attempted: Vec<String>,
    /// 端点诊断：把「端点报了什么」与「我们读了什么」摊开对照。
    /// 让「端点不报」与「端点报了但我们没读」这两种情况可区分 —— 修法完全不同。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<EndpointDiagnostics>,
}

/// 拉取端点的全部模型。
///
/// 并发打所有候选 URL，第一个返回可解析列表的胜出，其余立刻中止。
/// 本命令**只读不写**——结果由前端勾选后经 ai_set_config 落盘。
#[tauri::command]
pub async fn ai_fetch_models(input: FetchModelsInput) -> Result<FetchModelsOutput, String> {
    let urls = candidate_urls(&input.endpoint);
    if urls.is_empty() {
        return Err("请先填写 API 地址或端口".to_string());
    }
    let is_port_mode = !input.endpoint.contains("://");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(if is_port_mode { 5 } else { 10 }))
        .build()
        .map_err(|e| format!("创建请求客户端失败: {}", e))?;

    let mut set = JoinSet::new();
    for url in urls.iter() {
        let c = client.clone();
        let u = url.clone();
        let k = input.api_key.clone();
        set.spawn(async move { probe_one(&c, u, k).await });
    }

    let mut attempted: Vec<String> = Vec::new();
    let mut winner: Option<FetchModelsOutput> = None;
    while let Some(joined) = set.join_next().await {
        let Ok(p) = joined else { continue };
        match p.models {
            Ok(models) => {
                let diag = EndpointDiagnostics::build(
                    p.url.clone(),
                    p.top_keys.clone(),
                    p.model_keys.clone(),
                    &models,
                );
                winner = Some(FetchModelsOutput {
                    resolved_base_url: p.url.trim_end_matches("/models").to_string(),
                    models,
                    attempted: attempted.clone(),
                    diagnostics: Some(diag),
                });
                break;
            }
            Err(msg) => attempted.push(format!("{} — {}", p.url, msg)),
        }
    }
    // 胜出后中止其余仍在飞的请求，别让用户干等剩下的超时
    set.abort_all();

    if let Some(out) = winner {
        return Ok(out);
    }
    Err(format!(
        "试过这些地址都没拿到模型列表：\n{}",
        attempted.join("\n")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 解析_openai形状() {
        let body = json!({ "object": "list", "data": [
            { "id": "gpt-4o", "object": "model", "owned_by": "openai",
              "context_window": 128000, "max_output_tokens": 16384 }
        ]});
        let m = parse_listing(&body).unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].model, "gpt-4o");
        assert_eq!(m[0].context_tokens, Some(128000));
        assert_eq!(m[0].max_tokens, Some(16384));
    }

    #[test]
    fn 解析_字段别名都认() {
        let body = json!({ "data": [
            { "id": "a", "display_name": "别名名", "context_length": 8192, "max_tokens": 2048 },
            { "id": "b", "name": "原名", "context_window": 4096, "max_output_tokens": 1024 }
        ]});
        let m = parse_listing(&body).unwrap();
        assert_eq!(m[0].label.as_deref(), Some("别名名"));
        assert_eq!(m[0].context_tokens, Some(8192));
        assert_eq!(m[0].max_tokens, Some(2048));
        assert_eq!(m[1].label.as_deref(), Some("原名"));
        assert_eq!(m[1].context_tokens, Some(4096));
        assert_eq!(m[1].max_tokens, Some(1024));
    }

    #[test]
    fn 解析_跳过坏行但不整批失败() {
        let body = json!({ "data": [
            { "id": "good" }, { "name": "没有 id" }, { "id": "" }, { "id": 123 }, "不是对象"
        ]});
        let m = parse_listing(&body).unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].model, "good");
    }

    #[test]
    fn 解析_非正整数字段丢弃() {
        let body = json!({ "data": [{ "id": "x", "context_window": 0, "max_tokens": -5 }]});
        let m = parse_listing(&body).unwrap();
        assert_eq!(m[0].context_tokens, None);
        assert_eq!(m[0].max_tokens, None);
    }

    #[test]
    fn 解析_ollama原生形状() {
        let body = json!({ "models": [{ "name": "llama3:latest", "model": "llama3:latest" }] });
        let m = parse_listing(&body).unwrap();
        assert_eq!(m[0].model, "llama3:latest");
        assert_eq!(m[0].label.as_deref(), Some("llama3:latest"));
    }

    #[test]
    fn 解析_两个都有时优先data() {
        let body = json!({ "data": [{ "id": "from-data" }], "models": [{ "model": "from-models" }] });
        assert_eq!(parse_listing(&body).unwrap()[0].model, "from-data");
    }

    #[test]
    fn 解析_都没有时报错且带上实际键名() {
        let err = parse_listing(&json!({ "error": "unauthorized" })).unwrap_err();
        assert!(err.contains("error"), "错误信息应列出实际顶层键：{}", err);
    }

    #[test]
    fn 解析_空数组是合法结果() {
        assert_eq!(parse_listing(&json!({ "data": [] })).unwrap().len(), 0);
    }

    #[test]
    fn 候选_完整baseurl只打一枪且保留路径段() {
        assert_eq!(
            candidate_urls("https://gateway.example/openai/v1"),
            vec!["https://gateway.example/openai/v1/models"]
        );
    }

    #[test]
    fn 候选_结尾斜杠归一() {
        assert_eq!(candidate_urls("http://127.0.0.1:8000/v1/"), vec!["http://127.0.0.1:8000/v1/models"]);
    }

    #[test]
    fn 候选_纯端口本地优先原生富端点() {
        // 顺序是有意的：Ollama 的 /v1/models 也能成功，若排在前面就会永远命中它，
        // 从而拿不到 /api/tags 的 details.context_length 与权威 capabilities。
        assert_eq!(
            candidate_urls("11434"),
            vec![
                "http://127.0.0.1:11434/api/tags",
                "http://127.0.0.1:11434/api/v0/models",
                "http://127.0.0.1:11434/v1/models",
                "http://127.0.0.1:11434/models",
            ]
        );
    }

    #[test]
    fn 候选_远端不试原生端点() {
        // 远端只打 /v1/models 与 /models，避免多等超时；且不含曾经写错的 /api/models
        let u = candidate_urls("example.com:8000");
        assert_eq!(u, vec!["http://example.com:8000/v1/models", "http://example.com:8000/models"]);
    }

    /// **已加载窗口优先于模型最大**（2026-10-22）。
    ///
    /// LM Studio 同一个模型可以「最大 131072 / 当前只加载 4096」。按最大值放行 ⇒ 上游必 400；
    /// 按已加载窗口算压缩阈值才是"这次真能发多少"。这条顺序错了，压缩阈值就整体虚高。
    #[test]
    fn 容量_已加载窗口优先于模型最大() {
        let both = serde_json::json!({
            "id": "qwen2.5-1.5b-instruct",
            "max_context_length": 131072,
            "loaded_context_length": 4096,
            "state": "loaded"
        });
        let m = parse_openai_entry(&both).expect("应能解析");
        assert_eq!(m.context_tokens, Some(4096), "应取已加载窗口，而不是模型最大");
        assert_eq!(m.ctx_source, Some(CapacitySource::Loaded), "来源要标 loaded");

        // 没加载（只有最大）时退回最大值，来源标 provider
        let max_only = serde_json::json!({ "id": "x", "max_context_length": 131072, "state": "not-loaded" });
        let m2 = parse_openai_entry(&max_only).expect("应能解析");
        assert_eq!(m2.context_tokens, Some(131072));
        assert_eq!(m2.ctx_source, Some(CapacitySource::Provider));
    }

    #[test]
    fn 容量_字段方言全覆盖() {
        let j = |k: &str, v: u64| serde_json::json!({ k: v });
        for (key, val) in [
            ("context_window", 111u64),
            ("context_length", 222),
            ("max_context_length", 333),
            ("loaded_context_length", 444),
            ("max_model_len", 555),
            ("max_input_tokens", 666),
            ("n_ctx", 777),
        ] {
            assert_eq!(context_of(&j(key, val)), Some(val), "{} 应被识别", key);
        }
        // Ollama 把上下文塞在 details 子对象里
        assert_eq!(
            context_of(&serde_json::json!({ "details": { "context_length": 8192 } })),
            Some(8192)
        );
        // OpenRouter 的单次最大输出在 top_provider 下
        assert_eq!(
            max_output_of(&serde_json::json!({ "top_provider": { "max_completion_tokens": 4096 } })),
            Some(4096)
        );
        // 都读不到 → None（不猜）
        assert_eq!(context_of(&serde_json::json!({ "id": "x" })), None);
    }

    #[test]
    fn 能力_优先供应商权威上报() {
        // Ollama capabilities
        let c = caps_from_entry(&serde_json::json!({
            "capabilities": ["completion", "vision", "tools", "thinking"]
        }))
        .expect("应识别 Ollama capabilities");
        assert!(c.vision && c.tools && c.reasoning && c.text && !c.embedding);

        // Ollama 向量模型：capabilities 只有 embedding → 不算对话模型
        let e = caps_from_entry(&serde_json::json!({ "capabilities": ["embedding"] })).unwrap();
        assert!(e.embedding && !e.text);

        // OpenRouter：input_modalities 含 image → 视觉
        let o = caps_from_entry(&serde_json::json!({
            "architecture": { "input_modalities": ["text", "image"], "output_modalities": ["text"] },
            "supported_parameters": ["tools", "reasoning"]
        }))
        .expect("应识别 OpenRouter 形状");
        assert!(o.vision && o.tools && o.reasoning && o.text && !o.embedding);

        // 没报 → None（调用方回落名字启发式）
        assert!(caps_from_entry(&serde_json::json!({ "id": "gpt-4o" })).is_none());
    }

    #[test]
    fn 容量来源_端点与兜底表可区分() {
        // 端点自报 → provider；兜底表命中 → table；都没有 → 无来源
        let out = parse_listing(&serde_json::json!({
            "data": [
                { "id": "gpt-4o", "context_length": 99999 },
                { "id": "unknown-xyz-1" }
            ]
        }))
        .unwrap();
        assert_eq!(out[0].ctx_source, Some(CapacitySource::Provider));
        assert_eq!(out[0].context_tokens, Some(99999), "端点值优先于表");
        assert_eq!(out[1].ctx_source, None, "表和端点都没有 → 无来源");
    }

    #[test]
    fn 候选_带主机名只试两个() {
        assert_eq!(
            candidate_urls("192.168.1.5:8000"),
            vec!["http://192.168.1.5:8000/v1/models", "http://192.168.1.5:8000/models"]
        );
    }

    #[test]
    fn 候选_localhost等同回环() {
        assert_eq!(candidate_urls("localhost:1234"), candidate_urls("1234").iter()
            .map(|u| u.replace("127.0.0.1", "localhost")).collect::<Vec<_>>());
    }

    #[test]
    fn 候选_空输入返回空() {
        assert!(candidate_urls("   ").is_empty());
    }

    #[test]
    fn 上限_声明超限即拒() {
        assert!(size_guard(Some(MAX_RESPONSE_BYTES + 1), 0).is_err());
        assert!(size_guard(Some(MAX_RESPONSE_BYTES), 0).is_ok());
    }

    #[test]
    fn 上限_少报时靠累加兜底() {
        // 服务端只声明 1 KiB 却吐 5 MiB
        assert!(size_guard(Some(1024), MAX_RESPONSE_BYTES + 1).is_err());
    }

    #[test]
    fn 上限_无声明时只看累加() {
        assert!(size_guard(None, 100).is_ok());
        assert!(size_guard(None, MAX_RESPONSE_BYTES + 1).is_err());
    }

    #[test]
    fn 解析_附带推断的能力标记() {
        let body = json!({ "data": [{ "id": "qwen2.5-vl-72b" }, { "id": "nomic-embed-text" }] });
        let m = parse_listing(&body).unwrap();
        assert!(m[0].caps.vision);
        assert!(m[1].caps.embedding);
        assert!(!m[1].caps.text);
    }

    #[test]
    fn 容量_端点未报时用兜底表() {
        // 只回 id 的端点（绝大多数情况）：兜底表给出上下文与输出长度
        let body = json!({ "data": [{ "id": "gpt-4o" }] });
        let m = parse_listing(&body).unwrap();
        assert_eq!(m[0].context_tokens, Some(128_000));
        assert_eq!(m[0].max_tokens, Some(16_384));
    }

    #[test]
    fn 容量_端点自报优先于兜底表() {
        // 端点报了 context_length/max_output_tokens：必须以端点为准，不被兜底表覆盖
        let body = json!({ "data": [{
            "id": "gpt-4o", "context_length": 99999, "max_output_tokens": 777
        }] });
        let m = parse_listing(&body).unwrap();
        assert_eq!(m[0].context_tokens, Some(99_999));
        assert_eq!(m[0].max_tokens, Some(777));
    }

    #[test]
    fn 容量_表外模型留空不猜() {
        let body = json!({ "data": [{ "id": "some-unknown-model-2026" }] });
        let m = parse_listing(&body).unwrap();
        assert_eq!(m[0].context_tokens, None);
        assert_eq!(m[0].max_tokens, None);
    }
}

#[cfg(test)]
mod diag_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 提取顶层键与模型键() {
        let body = json!({
            "object": "list",
            "data": [
                { "id": "a", "context_length": 8192, "weird_field": 1 },
                { "id": "b", "context_length": 4096, "another_odd": true }
            ]
        });
        let (top, keys) = extract_key_set(&body);
        assert_eq!(top, vec!["data", "object"]);
        // 模型条目的键取并集并排序去重
        assert_eq!(keys, vec!["another_odd", "context_length", "id", "weird_field"]);
    }

    #[test]
    fn 支持ollama形状() {
        let body = json!({ "models": [{ "name": "x", "details": { "context_length": 2048 } }] });
        let (top, keys) = extract_key_set(&body);
        assert_eq!(top, vec!["models"]);
        assert_eq!(keys, vec!["details", "name"]);
    }

    #[test]
    fn 没有模型数组时键集合为空() {
        let body = json!({ "error": "nope" });
        let (top, keys) = extract_key_set(&body);
        assert_eq!(top, vec!["error"]);
        assert!(keys.is_empty());
    }

    #[test]
    fn 未识别键清单只留我们没读的() {
        let body = json!({
            "data": [{ "id": "m", "context_length": 8192, "vendor_specific_ctx": 999, "max_tokens": 512 }]
        });
        let (top, keys) = extract_key_set(&body);
        let models = parse_listing(&body).unwrap();
        let d = EndpointDiagnostics::build("http://x/models".into(), top, keys, &models);
        // id / context_length / max_tokens 都是我们读的 → 不该出现在"未识别"里
        assert_eq!(d.unrecognized_keys, vec!["vendor_specific_ctx"]);
    }

    #[test]
    fn 自报计数看的是来源而不是最终值() {
        // ★ 关键回例：这行端点**只报了 id**，容量是兜底表补的。
        //   如果用「最终值非空」计数，会误判成"端点报了容量" —— 那正是之前的盲区。
        let body = json!({ "data": [{ "id": "gpt-4o" }] });
        let (top, keys) = extract_key_set(&body);
        let models = parse_listing(&body).unwrap();
        assert!(models[0].context_tokens.is_some(), "兜底表应补上了值");
        let d = EndpointDiagnostics::build("u".into(), top, keys, &models);
        assert_eq!(d.ctx_reported, 0, "端点没报，计数必须是 0（尽管最终值非空）");
        assert_eq!(d.out_reported, 0);
        assert_eq!(d.total, 1);
    }

    #[test]
    fn 自报计数能认出端点真的报了() {
        let body = json!({ "data": [{ "id": "m", "context_window": 200000 }] });
        let (top, keys) = extract_key_set(&body);
        let models = parse_listing(&body).unwrap();
        let d = EndpointDiagnostics::build("u".into(), top, keys, &models);
        assert_eq!(d.ctx_reported, 1, "端点报了上下文，应计 1");
        assert_eq!(d.out_reported, 0, "但没报最大输出");
    }

    #[test]
    fn 已识别键清单覆盖各家方言() {
        // 防"新增了读取字段但忘了同步 RECOGNIZED_KEYS" —— 那会把已支持的字段
        // 误报成"未识别"，让诊断结论反向误导。
        for k in [
            "context_window", "context_length", "max_context_length", "loaded_context_length",
            "max_model_len", "max_input_tokens", "n_ctx",
            "max_output_tokens", "max_completion_tokens", "max_tokens", "top_provider",
            "capabilities", "architecture", "supported_parameters",
        ] {
            assert!(RECOGNIZED_KEYS.contains(&k), "`{}` 应被视为已识别", k);
        }
    }
}
