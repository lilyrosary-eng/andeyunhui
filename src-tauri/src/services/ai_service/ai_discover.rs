// 「填 base URL 或只填端口 → 拉取该端点的全部模型」的 Rust 侧实现。
//
// 分层：解析层（本文件的纯函数，可单测）与探测层（reqwest，需真实网络）分开，
// 绝大多数逻辑能在 cargo test 里覆盖，不用起本地 HTTP 服务。
//
// ★ 拉到的模型永远是「候选」，本命令绝不写盘。写盘由前端勾选后调 ai_set_config 完成，
//   用户始终保有否决权。

use serde::{Deserialize, Serialize};

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
}

fn nonempty_str(v: Option<&serde_json::Value>) -> Option<String> {
    v.and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn pos_u64(v: Option<&serde_json::Value>) -> Option<u64> {
    v.and_then(|x| x.as_u64()).filter(|n| *n > 0)
}

/// OpenAI 兼容形状的一行。上游用 `id` 表示模型名；缺失/为空 → None（跳过该行，不整批失败）。
fn parse_openai_entry(e: &serde_json::Value) -> Option<DiscoveredModel> {
    let model = nonempty_str(e.get("id"))?;
    Some(DiscoveredModel {
        model,
        label: nonempty_str(e.get("name")).or_else(|| nonempty_str(e.get("display_name"))),
        context_tokens: pos_u64(e.get("context_window"))
            .or_else(|| pos_u64(e.get("context_length"))),
        max_tokens: pos_u64(e.get("max_output_tokens")).or_else(|| pos_u64(e.get("max_tokens"))),
    })
}

/// Ollama 原生形状的一行：{ name: "llama3:latest", model: "llama3:latest" }
/// 取不到容量字段——Ollama 原生的 /api/tags 不报 context。
fn parse_ollama_entry(e: &serde_json::Value) -> Option<DiscoveredModel> {
    let model = nonempty_str(e.get("model")).or_else(|| nonempty_str(e.get("name")))?;
    Some(DiscoveredModel { model, label: nonempty_str(e.get("name")), context_tokens: None, max_tokens: None })
}

/// 按响应体形状自动解析：先试 OpenAI 的 `data[]`，再试 Ollama 的 `models[]`。
/// 两个都没有就直接报错，不猜其他形状——猜错与「该端点确实没有模型」
/// 在用户看来完全一样，报错比给出错误列表诚实。
pub fn parse_listing(body: &serde_json::Value) -> Result<Vec<DiscoveredModel>, String> {
    if let Some(data) = body.get("data").and_then(|v| v.as_array()) {
        return Ok(data.iter().filter_map(parse_openai_entry).collect());
    }
    if let Some(models) = body.get("models").and_then(|v| v.as_array()) {
        return Ok(models.iter().filter_map(parse_ollama_entry).collect());
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
    let mut out = vec![format!("http://{host}:{port}/v1/models")];
    // 裸 /models 对所有主机都试；/api/models 仅本地追加。
    out.push(format!("http://{host}:{port}/models"));
    if is_local {
        out.push(format!("http://{host}:{port}/api/models"));
    }
    out
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
    fn 候选_纯端口试三个本地形状() {
        assert_eq!(
            candidate_urls("11434"),
            vec![
                "http://127.0.0.1:11434/v1/models",
                "http://127.0.0.1:11434/models",
                "http://127.0.0.1:11434/api/models",
            ]
        );
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
}
