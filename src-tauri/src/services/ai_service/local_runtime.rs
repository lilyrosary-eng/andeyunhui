// 全局 AI 服务 · 子模块：本地模型运行时观测（显存 / 驻留 / 释放）
//
// ## 为什么只"观测 + 引导"，不做显存调度器
// 模型驻留是**服务端**的职责：LM Studio / Ollama / llama.cpp 都已实现 JIT 加载、
// 空闲 TTL 驱逐、显存守卫。我们在外面再排一遍会跟它打架（它刚加载好，我们让它卸），
// 而且我们拿不到可靠数字：NVML 只管 NVIDIA，AMD / Intel / 统一内存要另写，
// "哪个进程占了显存"更是需要 server 侧信息。
//
// 所以这里只做三件对用户真正有用、且**零风险**的事：
//   1. 问端点"你现在驻留了哪些模型、占多少"（官方接口，不是猜）；
//   2. 给一个**显式**的释放动作（Ollama `keep_alive: 0` 是官方语义）；
//   3. 端点不支持时**明说**，不要假装释放成功。
//
// ## 端点差异（实测）
// - Ollama：`GET /api/ps` 直接给 `size` / `size_vram` / `expires_at`；
//   卸载 = `POST /api/generate {model, keep_alive: 0}`（空 prompt 不会真的生成）。
// - LM Studio：`GET /api/v0/models` 给 `state`（loaded / not-loaded）与
//   `max_context_length` / `loaded_context_length`，**不给显存占用**，也没有
//   HTTP 卸载接口（卸载要在 LM Studio 客户端里点）。这两点如实告诉用户。

use serde_json::json;

/// 本地运行时类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LocalRuntimeKind {
    Ollama,
    LmStudio,
    Unknown,
}

/// 一个驻留中的模型。
#[derive(Debug, Clone, serde::Serialize)]
pub struct ResidentModel {
    /// 上游模型名（就是请求里要用的那个）
    pub model: String,
    /// 是否已加载（LM Studio 会列出未加载的模型，Ollama 的 /api/ps 只列已加载的）
    pub loaded: bool,
    /// 已加载窗口（token），未知为 None
    pub context_tokens: Option<u64>,
    /// 显存占用（字节），Ollama 才给
    pub vram_bytes: Option<u64>,
    /// 到期时间（Ollama 的 keep_alive 到期点），未知为 None
    pub expires_at: Option<String>,
}

/// 观测结果。
#[derive(Debug, Clone, serde::Serialize)]
pub struct RuntimeStatus {
    pub kind: LocalRuntimeKind,
    pub reachable: bool,
    pub models: Vec<ResidentModel>,
    /// 给用户看的一句话（为什么没有显存数字 / 为什么不能释放）
    pub note: String,
    /// 是否可以通过本应用的按钮释放
    pub can_release: bool,
}

fn host_of(base_url: &str) -> String {
    // 从 http://127.0.0.1:1234/v1 取出 http://127.0.0.1:1234
    let t = base_url.trim().trim_end_matches('/');
    if let Some(idx) = t.find("/v1") {
        t[..idx].to_string()
    } else if let Some(idx) = t.find("/api") {
        t[..idx].to_string()
    } else {
        t.to_string()
    }
}

/// 解析 Ollama `GET /api/ps` 的响应形状。
///
/// ⚠️ **必须按形状判、不能按状态码判**（2026-10-22 实测）：
/// LM Studio 对 `/api/ps` 返回的是 **HTTP 200 + `{"error":"Unexpected endpoint or method..."}`**。
/// 只看 2xx 就会把 LM Studio 误认成 Ollama，并显示"没有驻留模型"——一条假阴性。
fn parse_ollama_ps(v: &serde_json::Value) -> Option<Vec<ResidentModel>> {
    if v.get("error").is_some() {
        return None;
    }
    let arr = v.get("models")?.as_array()?;
    let mut out = Vec::with_capacity(arr.len());
    for m in arr {
        let name = m
            .get("name")
            .or_else(|| m.get("model"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        out.push(ResidentModel {
            model: name,
            loaded: true,
            context_tokens: m.get("context_length").and_then(|x| x.as_u64()),
            vram_bytes: m.get("size_vram").and_then(|x| x.as_u64()),
            expires_at: m.get("expires_at").and_then(|x| x.as_str()).map(str::to_string),
        });
    }
    Some(out)
}

/// 解析 LM Studio `GET /api/v0/models` 的响应形状（`data[]`，含 `state`）。
fn parse_lmstudio_models(v: &serde_json::Value) -> Option<Vec<ResidentModel>> {
    if v.get("error").is_some() {
        return None;
    }
    let arr = v.get("data")?.as_array()?;
    let mut out = Vec::with_capacity(arr.len());
    for m in arr {
        let name = m.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        out.push(ResidentModel {
            model: name,
            loaded: m.get("state").and_then(|x| x.as_str()) == Some("loaded"),
            context_tokens: m
                .get("loaded_context_length")
                .and_then(|x| x.as_u64())
                .or_else(|| m.get("max_context_length").and_then(|x| x.as_u64())),
            vram_bytes: None,
            expires_at: None,
        });
    }
    Some(out)
}

async fn get_json(url: &str) -> Option<serde_json::Value> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .build()
        .ok()?;
    let resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<serde_json::Value>().await.ok()
}

/// 探测本地运行时状态。`base_url` 是供应商的端点（如 `http://127.0.0.1:1234/v1`）。
#[tauri::command]
pub async fn ai_local_runtime_status(base_url: String) -> Result<RuntimeStatus, String> {
    let host = host_of(&base_url);
    if host.trim().is_empty() {
        return Err("未提供端点地址".to_string());
    }

    // 先试 Ollama（/api/ps 只列已加载的，语义最贴近"现在占了显存的是谁"）。
    // 判据是**响应形状**：必须真有 `models` 数组（空数组也算 Ollama），
    // 不能只看 2xx —— LM Studio 对同一路径返回 200 + {"error": ...}。
    if let Some(v) = get_json(&format!("{host}/api/ps")).await {
        if let Some(models) = parse_ollama_ps(&v) {
        let total: u64 = models.iter().filter_map(|m| m.vram_bytes).sum();
        log::info!(
            "[local-runtime] Ollama 可达：驻留 {} 个模型，显存合计 {} 字节（{}）",
            models.len(),
            total,
            host
        );
        // 先算好文案再用：结构体字面量里 `models` 会被 move，之后不能再借用
        let count = models.len();
        let note = if count == 0 {
            "当前没有驻留模型（显存已释放）".to_string()
        } else {
            format!("共 {count} 个模型驻留，显存合计 {}（可逐条释放）", human_bytes(total))
        };
        return Ok(RuntimeStatus {
            kind: LocalRuntimeKind::Ollama,
            reachable: true,
            models,
            note,
            can_release: true,
        });
        }
    }

    // 再试 LM Studio 原生
    if let Some(v) = get_json(&format!("{host}/api/v0/models")).await {
        if let Some(models) = parse_lmstudio_models(&v) {
        let loaded = models.iter().filter(|m| m.loaded).count();
        log::info!(
            "[local-runtime] LM Studio 可达：{} 个模型，其中 {} 个已加载（{}）",
            models.len(),
            loaded,
            host
        );
        return Ok(RuntimeStatus {
            kind: LocalRuntimeKind::LmStudio,
            reachable: true,
            models,
            // 如实说明：LM Studio 的 HTTP API 不报显存，也没有卸载接口
            note: format!(
                "LM Studio：{loaded} 个模型已加载。它的 HTTP 接口不提供显存占用，也没有卸载端点，\
                 需要释放请在 LM Studio 客户端里卸载（或用它的 lms 命令行）。"
            ),
            can_release: false,
        });
        }
    }

    log::warn!("[local-runtime] {host} 既不是 Ollama 也不是 LM Studio（或未启动）");
    Ok(RuntimeStatus {
        kind: LocalRuntimeKind::Unknown,
        reachable: false,
        models: vec![],
        note: format!("{host} 未响应 /api/ps 与 /api/v0/models：可能没启动，或不是本地运行时。"),
        can_release: false,
    })
}

/// 释放一个已驻留的模型（仅 Ollama：`keep_alive: 0` 是官方卸载语义）。
///
/// 别的运行时不假装成功：返回 `Err` 让前端把原因展示出来 —— 静默"成功"比失败更糟。
#[tauri::command]
pub async fn ai_local_runtime_release(base_url: String, model: String) -> Result<String, String> {
    let host = host_of(&base_url);
    let model = model.trim().to_string();
    if host.trim().is_empty() || model.is_empty() {
        return Err("缺少端点或模型名".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    // prompt 为空 + keep_alive=0：Ollama 只做"立刻卸载"，不会真的生成
    let body = json!({ "model": model, "prompt": "", "keep_alive": 0 });
    let resp = client
        .post(format!("{host}/api/generate"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if (200..300).contains(&status) {
        log::warn!("[local-runtime] 已请求 Ollama 卸载模型 {model}（keep_alive=0）");
        Ok(format!("已请求卸载 {model}（Ollama keep_alive=0）"))
    } else {
        let msg = format!("卸载失败：HTTP {status}: {}", text.chars().take(200).collect::<String>());
        log::error!("[local-runtime] {msg}");
        Err(msg)
    }
}

/// 字节 → 人类可读（只用于提示文案，不参与任何计算）。
fn human_bytes(n: u64) -> String {
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    if n as f64 >= GB {
        format!("{:.1} GB", n as f64 / GB)
    } else {
        format!("{:.0} MB", n as f64 / MB)
    }
}

#[cfg(test)]
mod tests {
    use super::{host_of, human_bytes, parse_lmstudio_models, parse_ollama_ps};

    /// **实测血案**：LM Studio 对 `/api/ps` 返回 HTTP 200 + `{"error": ...}`。
    /// 只判状态码会把它当成 Ollama，并显示"没有驻留模型"（假阴性）。
    #[test]
    fn lmstudio_error_body_is_not_mistaken_for_ollama() {
        let body = serde_json::json!({"error":"Unexpected endpoint or method. (GET /api/ps)"});
        assert!(parse_ollama_ps(&body).is_none(), "带 error 的 200 不能被当成 Ollama");
    }

    /// 真 Ollama `/api/ps`：给出 size_vram 与 expires_at。
    #[test]
    fn parses_real_ollama_ps() {
        let body = serde_json::json!({"models":[
            {"name":"qwen2.5:7b","size":4700000000u64,"size_vram":4700000000u64,
             "expires_at":"2026-10-22T12:34:56Z"}
        ]});
        let m = parse_ollama_ps(&body).expect("应识别为 Ollama");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].model, "qwen2.5:7b");
        assert!(m[0].loaded);
        assert_eq!(m[0].vram_bytes, Some(4_700_000_000));
        assert_eq!(m[0].expires_at.as_deref(), Some("2026-10-22T12:34:56Z"));
    }

    /// 空 `models` 数组：是真 Ollama、只是没驻留模型（不能判成"不是 Ollama"）。
    #[test]
    fn empty_ollama_ps_is_still_ollama() {
        let body = serde_json::json!({"models":[]});
        assert_eq!(parse_ollama_ps(&body).map(|v| v.len()), Some(0));
    }

    /// 真 LM Studio `/api/v0/models`：state 决定 loaded，窗口优先取已加载值。
    #[test]
    fn parses_real_lmstudio_models() {
        let body = serde_json::json!({"data":[
            {"id":"qwen2.5-1.5b-instruct","state":"loaded",
             "max_context_length":131072u64,"loaded_context_length":4096u64},
            {"id":"gpt-oss-20b","state":"not-loaded","max_context_length":131072u64}
        ]});
        let m = parse_lmstudio_models(&body).expect("应识别为 LM Studio");
        assert_eq!(m.len(), 2);
        assert!(m[0].loaded);
        assert_eq!(m[0].context_tokens, Some(4096), "已加载窗口优先于最大");
        assert!(!m[1].loaded);
        assert_eq!(m[1].context_tokens, Some(131072), "未加载时退回最大值");
        assert_eq!(m[1].vram_bytes, None, "LM Studio 不报显存");
    }

    /// 端点 → 主机根：必须能从 `/v1` 与 `/api` 两种尾巴里剥出来。
    #[test]
    fn host_extraction() {
        assert_eq!(host_of("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234");
        assert_eq!(host_of("http://127.0.0.1:11434/v1/"), "http://127.0.0.1:11434");
        assert_eq!(host_of("http://127.0.0.1:11434/api"), "http://127.0.0.1:11434");
        assert_eq!(host_of("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
    }

    #[test]
    fn human_readable_bytes() {
        assert_eq!(human_bytes(0), "0 MB");
        assert_eq!(human_bytes(512 * 1024 * 1024), "512 MB");
        assert_eq!(human_bytes(3 * 1024 * 1024 * 1024), "3.0 GB");
    }
}
