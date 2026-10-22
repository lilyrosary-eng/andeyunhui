// 全局 AI 服务 · 子模块：能力探测的「工具 / 向量 / 一次多项」扩展（2026-10-22）
//
// 视觉探测原本单独住在 `caps_probe`，这里补上另外两种能力，并提供"一次探多项"的命令。
// 拆文件而不是继续塞 `caps_probe`：那支已经有 349 行 + 一大段历史注释，再堆会把
// 「判定哲学」和「HTTP 细节」搅在一起。两者共享同一套哲学（见下），但不共享代码。
//
// ## 与视觉探测同一套判定哲学
//   - 一次动作 = 一个极短请求（成本可忽略），只有用户点了才会发；
//   - **2xx 才算确证支持**；
//   - 4xx 只有**正文点名该能力**时才判"不支持"；
//   - 429 / 5xx / 401 / 403 / 超时 → **未知，不落盘**。
// 最后一条是刻意的：把限流写成"不支持"就是一条永久脏记忆，用户永远不知道为什么那个模型被判死了。
//
// ## 与视觉不同的地方：工具怎么判成功
// 不能只看 2xx —— 很多模型收下 `tools` 却回一段文字。必须看到 `tool_calls`。
// 但"没回 tool_calls"只判**未知**、不判不支持：可能是模型太弱/没照做，不等于端点不支持。
// 宁可保持原状态，也不要把一个能用的模型标成不能用。

use serde_json::json;
use tauri::AppHandle;

use super::caps_probe::{ai_probe_vision, ProbeOutcome, ProbeVerdict};

/// 工具探测用的假工具：只有一个必填字符串参数，模型一眼能填。
const PROBE_TOOL_NAME: &str = "ping";

fn mentions_tools(err: &str) -> bool {
    let l = err.to_lowercase();
    const KEYS: &[&str] = &[
        "tool", "function", "tool_choice", "tool_calls", "function_call",
        "工具", "函数调用", "does not support tool", "unsupported tool",
    ];
    KEYS.iter().any(|k| l.contains(k))
}

fn mentions_embedding(err: &str) -> bool {
    let l = err.to_lowercase();
    const KEYS: &[&str] = &[
        "embedding", "embeddings", "vector", "embed", "向量", "嵌入",
        "not an embedding model", "only support embedding",
    ];
    KEYS.iter().any(|k| l.contains(k))
}

/// 工具探测：(状态码, 正文) → 结论。纯函数，便于用真实响应体单测。
pub fn tools_verdict(status: u16, body: &str) -> ProbeVerdict {
    if (200..300).contains(&status) {
        // 成功：只有真的回了 tool_calls 才算"确证支持"。
        // 注意 `"tool_calls":null` / `[]` 也含这个子串，必须排除，否则会把
        // "端点接受但模型没调用"误判成支持（一条假阳性，比未知更糟）。
        let has_calls = body.contains("\"tool_calls\"")
            && !body.contains("\"tool_calls\":null")
            && !body.contains("\"tool_calls\":[]");
        return if has_calls { ProbeVerdict::Supported } else { ProbeVerdict::Unknown };
    }
    if status == 429 || status == 408 || status >= 500 || status == 401 || status == 403 {
        return ProbeVerdict::Unknown;
    }
    if (400..500).contains(&status) && mentions_tools(body) {
        return ProbeVerdict::Unsupported;
    }
    ProbeVerdict::Unknown
}

/// 向量探测：(状态码, 正文) → 结论。纯函数。
pub fn embedding_verdict(status: u16, body: &str) -> ProbeVerdict {
    if (200..300).contains(&status) {
        // 成功的嵌入响应里必然有 data[].embedding
        return if body.contains("\"embedding\"") { ProbeVerdict::Supported } else { ProbeVerdict::Unknown };
    }
    if status == 429 || status == 408 || status >= 500 || status == 401 || status == 403 {
        return ProbeVerdict::Unknown;
    }
    if (400..500).contains(&status) && mentions_embedding(body) {
        return ProbeVerdict::Unsupported;
    }
    ProbeVerdict::Unknown
}

/// 发一个 JSON 请求，返回 (状态码, 正文)。网络层失败返回 Err。
///
/// 超时 25s：探测是"用户点了在等结果"的交互，不能像后台任务那样拖。
async fn post_json(url: &str, key: &str, body: serde_json::Value) -> Result<(u16, String), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(25))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let resp = client
        .post(url)
        .header("Authorization", format!("Bearer {}", key.trim()))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    Ok((status, text))
}

fn endpoint_of(base_url: &str, path: &str) -> String {
    format!("{}/{}", base_url.trim_end_matches('/'), path.trim_start_matches('/'))
}

/// 探测「工具/函数调用」能力。返回 `(结论, 实际请求数)`。
///
/// ## max_tokens 必须给足（2026-10-22 实测）
/// 最初写 48，实测本地思考型模型把预算全花在 `reasoning_content` 上，
/// 返回 `finish_reason: "length"` + `tool_calls: []` —— 会被误判成"端点不支持工具"。
/// 放到 512 后同一模型立刻正常返回 tool_calls。探测的成本主要是 token 数，
/// 所以这里宁可给宽一点。
pub async fn probe_tools(base_url: &str, api_key: &str, model: &str) -> (ProbeOutcome, usize) {
    let body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": "直接调用 ping 工具，x 填 1，不要思考不要解释。" }],
        "tools": [{
            "type": "function",
            "function": {
                "name": PROBE_TOOL_NAME,
                "description": "测试用的空工具，调用它即可",
                "parameters": {
                    "type": "object",
                    "properties": { "x": { "type": "string" } },
                    "required": ["x"]
                }
            }
        }],
        "tool_choice": "auto",
        "max_tokens": 512,
        "stream": false
    });
    // tools 先抠出来：body 要整个交给 post_json（会被 move），重试时还要复用同一份定义
    let tools = body["tools"].clone();
    let mut requests = 1usize;
    match post_json(&endpoint_of(base_url, "chat/completions"), api_key, body).await {
        Ok((status, text)) => {
            let v = tools_verdict(status, &text);
            // 2xx 但没调用：多半不是"不支持"，而是模型没照做或输出被截断
            // （思考型模型会把预算全花在 reasoning_content 上）。
            // 于是重发一次并强制 `tool_choice: "required"` —— OpenAI / vLLM / LM Studio 都支持
            // 这个**字符串**值；对象形式 {type:function,...} 反而会被 LM Studio 400 拒绝（实测）。
            if v == ProbeVerdict::Unknown && (200..300).contains(&status) {
                let truncated = text.contains("\"finish_reason\":\"length\"")
                    || text.contains("\"finish_reason\": \"length\"");
                log::info!(
                    "[caps-probe] {model} 工具探测未拿到 tool_calls（截断={truncated}），改用 required 重试一次"
                );
                let forced = json!({
                    "model": model,
                    "messages": [{ "role": "user", "content": "调用 ping 工具" }],
                    "tools": tools.clone(),
                    "tool_choice": "required",
                    "max_tokens": 512,
                    "stream": false
                });
                requests += 1;
                if let Ok((s2, t2)) =
                    post_json(&endpoint_of(base_url, "chat/completions"), api_key, forced).await
                {
                    if tools_verdict(s2, &t2) == ProbeVerdict::Supported {
                        return (
                            ProbeOutcome {
                                verdict: ProbeVerdict::Supported,
                                detail: "强制 tool_choice=required 后返回了 tool_calls，支持工具调用（auto 模式下模型自己不主动调用）。".to_string(),
                                raw: t2.chars().take(400).collect(),
                            },
                            requests,
                        );
                    }
                    // 端点不认识 required（部分网关）→ 无法判定，保持未知
                    if (400..500).contains(&s2) && t2.to_lowercase().contains("tool_choice") {
                        log::warn!(
                            "[caps-probe] {model} 端点不支持 tool_choice=required：{}",
                            t2.chars().take(120).collect::<String>()
                        );
                    }
                }
            }
            let detail = match v {
                ProbeVerdict::Supported => "端点按 tools 定义返回了 tool_calls，可确证支持工具调用。".to_string(),
                ProbeVerdict::Unsupported => format!(
                    "端点拒绝 tools 字段（HTTP {status}）且正文点名工具/函数，判定为不支持工具调用。"
                ),
                ProbeVerdict::Unknown if (200..300).contains(&status) => {
                    if text.contains("length") {
                        format!(
                            "HTTP {status} 但输出被 max_tokens 截断（finish_reason=length），没跑到工具调用；required 重试也没拿到，暂判未知，保留原状态。"
                        )
                    } else {
                        format!(
                            "HTTP {status} 但响应里没有 tool_calls（模型没照做，或端点静默忽略 tools），保留原状态。"
                        )
                    }
                }
                ProbeVerdict::Unknown => format!(
                    "HTTP {status} 但无法归因到「不支持工具调用」（可能是限流、密钥、模型名或参数问题），保留原状态。"
                ),
            };
            (ProbeOutcome { verdict: v, detail, raw: text.chars().take(400).collect() }, requests)
        }
        Err(e) => (
            ProbeOutcome { verdict: ProbeVerdict::Unknown, detail: e, raw: String::new() },
            requests,
        ),
    }
}

/// 探测「向量/嵌入」能力。
pub async fn probe_embedding(base_url: &str, api_key: &str, model: &str) -> ProbeOutcome {
    let body = json!({ "model": model, "input": "ping" });
    match post_json(&endpoint_of(base_url, "embeddings"), api_key, body).await {
        Ok((status, text)) => {
            let v = embedding_verdict(status, &text);
            let detail = match v {
                ProbeVerdict::Supported => "端点返回了向量数组，可确证支持嵌入。".to_string(),
                ProbeVerdict::Unsupported => format!(
                    "端点拒绝 /embeddings（HTTP {status}）且正文点名嵌入，判定为不支持向量。"
                ),
                ProbeVerdict::Unknown => format!(
                    "HTTP {status} 但无法归因（可能是限流、密钥、模型名或参数问题），保留原状态。"
                ),
            };
            ProbeOutcome { verdict: v, detail, raw: text.chars().take(400).collect() }
        }
        Err(e) => ProbeOutcome { verdict: ProbeVerdict::Unknown, detail: e, raw: String::new() },
    }
}

/// 一次探测该模型的**多项**能力（vision / tools / embedding）。
///
/// 每项各发**一个**极短请求（视觉 1×1 PNG、工具带一个假工具、向量一个词），
/// 返回里的 `requests` 就是实际发出的请求数 —— 前端据此告诉用户这次点下去的成本。
/// 没点名的能力不探、也不返回（前端按"未测"处理）。
#[tauri::command]
pub async fn ai_probe_caps(
    app: AppHandle,
    profile_id: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    model: String,
    caps: Vec<String>,
) -> Result<serde_json::Value, String> {
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("未指定要探测的模型名".to_string());
    }
    let base = base_url.unwrap_or_default();
    let key = api_key.unwrap_or_default();
    if base.trim().is_empty() || key.trim().is_empty() {
        return Err("探测需要供应商的 base_url 与 api_key".to_string());
    }

    let mut results = serde_json::Map::new();
    let mut requests = 0usize;
    for cap in caps.iter().map(|s| s.trim().to_lowercase()) {
        let out = match cap.as_str() {
            "vision" => {
                requests += 1;
                ai_probe_vision(
                    app.clone(),
                    profile_id.clone(),
                    Some(base.clone()),
                    Some(key.clone()),
                    model.clone(),
                )
                .await?
            }
            "tools" => {
                let (out, n) = probe_tools(&base, &key, &model).await;
                requests += n;
                out
            }
            "embedding" => {
                requests += 1;
                probe_embedding(&base, &key, &model).await
            }
            other => {
                log::warn!("[caps-probe] 忽略未知能力项: {other}");
                continue;
            }
        };
        log::info!("[caps-probe] {model} / {cap} → {:?}（{}）", out.verdict, out.detail);
        results.insert(
            cap,
            serde_json::to_value(&out).map_err(|e| format!("序列化探测结果失败: {e}"))?,
        );
    }
    Ok(json!({ "results": results, "requests": requests }))
}

#[cfg(test)]
mod tests {
    use super::{embedding_verdict, tools_verdict};
    use super::super::caps_probe::ProbeVerdict;

    /// 支持：响应里真的带 tool_calls。
    #[test]
    fn tools_supported_when_tool_calls_present() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":null,
            "tool_calls":[{"id":"c1","type":"function","function":{"name":"ping","arguments":"{\"x\":\"1\"}"}}]}}]}"#;
        assert_eq!(tools_verdict(200, body), ProbeVerdict::Supported);
    }

    /// 端点接受但模型没调用 → **未知**（不是不支持，也不是支持）。
    #[test]
    fn tools_unknown_when_accepted_but_no_calls() {
        assert_eq!(
            tools_verdict(200, r#"{"choices":[{"message":{"role":"assistant","content":"我不会用工具"}}]}"#),
            ProbeVerdict::Unknown
        );
        // tool_calls 为 null / 空数组也算"没有调用"，不能误判成支持
        assert_eq!(tools_verdict(200, r#"{"choices":[{"message":{"tool_calls":null}}]}"#), ProbeVerdict::Unknown);
        assert_eq!(tools_verdict(200, r#"{"choices":[{"message":{"tool_calls":[]}}]}"#), ProbeVerdict::Unknown);
    }

    /// **实测踩到过的坑**：思考型模型把 max_tokens 全花在 reasoning_content 上，
    /// 返回 `finish_reason: "length"` + `tool_calls: []`。
    /// 这种情况必须判"未知"（随后 probe_tools 会放大预算 + required 重试），
    /// 绝不能判成"不支持工具"——那会把一个能用的模型永久标死。
    #[test]
    fn tools_truncated_output_is_unknown_not_unsupported() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"",
            "reasoning_content":"用户想调用 ping……","tool_calls":[]},"finish_reason":"length"}]}"#;
        assert_eq!(tools_verdict(200, body), ProbeVerdict::Unknown);
    }

    /// 明确拒绝 tools 字段才判"不支持"。
    #[test]
    fn tools_unsupported_only_when_body_names_tools() {
        assert_eq!(
            tools_verdict(400, r#"{"error":{"message":"This model does not support tools"}}"#),
            ProbeVerdict::Unsupported
        );
        // 400 但正文没提工具 → 未知（参数/模型名/审核都可能）
        assert_eq!(
            tools_verdict(400, r#"{"error":{"message":"invalid request: temperature out of range"}}"#),
            ProbeVerdict::Unknown
        );
        // 限流 / 鉴权 / 服务端错 → 未知
        assert_eq!(tools_verdict(429, "rate limit"), ProbeVerdict::Unknown);
        assert_eq!(tools_verdict(401, "invalid api key"), ProbeVerdict::Unknown);
        assert_eq!(tools_verdict(503, "overloaded"), ProbeVerdict::Unknown);
    }

    /// 向量：成功必须有 embedding 数组。
    #[test]
    fn embedding_verdict_cases() {
        assert_eq!(
            embedding_verdict(200, r#"{"data":[{"embedding":[0.1,0.2],"index":0}],"model":"m"}"#),
            ProbeVerdict::Supported
        );
        assert_eq!(embedding_verdict(200, r#"{"data":[]}"#), ProbeVerdict::Unknown);
        assert_eq!(
            embedding_verdict(400, r#"{"error":"this is not an embedding model"}"#),
            ProbeVerdict::Unsupported
        );
        assert_eq!(
            embedding_verdict(404, r#"{"error":"model not found"}"#),
            ProbeVerdict::Unknown
        );
        assert_eq!(embedding_verdict(429, "rate limit"), ProbeVerdict::Unknown);
    }
}
