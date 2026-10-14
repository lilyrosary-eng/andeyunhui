// 全局 AI 服务 · 子模块：能力探测（caps probe）
//
// ## 要解决什么
// `caps.vision` 目前靠**模型名启发式**（caps_infer.rs）。实测在用的
// `agnes-*` / `step-*` / `hy-mt2-*` 等家族，名字里没有任何视觉线索 → 一律判 false。
// 这个标签决定两件事：① UI 上那个「视觉」标签真不真；② 要不要走「原生直发」省一次调用。
// 判错就等于**用错数据做路由**：把不支持视觉的模型判成支持，用户发图直接 400。
//
// ## 探测怎么做
// 发一张 1×1 的 PNG + 一句极短提问给目标模型，看端点的**响应**。
// 用 1×1 是因为：成本可忽略（几个 token），且足以触发「不支持图片」的校验路径
// —— 多数端点在**解析入参**时就拒了，根本不会真去推理。
//
// ## 判定信号（关键，决定会不会写脏记忆）
//   - 成功（2xx）                → **支持**，可确证
//   - 4xx 且正文点名图片/视觉相关 → **不支持**，可确证
//   - 429 / 5xx / 超时 / 网络错   → **未知**，保留原状态，不落盘
//
// 最后一条是刻意的：失败分不清是「模型真不支持」还是「限流/超时/我们 body 写错」。
// 把后者写成「不支持」就是一条**永久脏记忆**，而且用户永远不知道为什么那个模型被判死了。
// ⇒ **成功永久记，失败只报告不落盘**。
//
// ## 与「放行只能来自用户设置」同一原则
// 探测会**真发一次外部请求**（可能计费）。所以不做静默自动探测：
// 必须用户在设置里开启该开关，且每次探测都是用户显式点出来的。

use tauri::AppHandle;

/// 1×1 透明 PNG（68 字节）。硬编码为常量而非运行时编码：
/// 这是探测用的固定素材，不该依赖图像库，也不该有任何随机性。
const PROBE_PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/// 探测结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProbeVerdict {
    /// 端点接受了图片输入 —— 可确证支持。
    Supported,
    /// 端点明确拒绝（4xx + 正文点名图片/视觉）—— 可确证不支持。
    Unsupported,
    /// 无法判定（限流/服务端错/超时/网络）。**不落盘**。
    Unknown,
}

/// 探测结果（回给前端，供展示原因）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProbeOutcome {
    pub verdict: ProbeVerdict,
    /// 给用户看的一句话原因。
    pub detail: String,
    /// 端点的原始响应片段（截断），便于用户自查。Unknown 时尤其有用。
    pub raw: String,
}

/// 正文里点名「图片/视觉」相关的关键词 → 说明这个 4xx 是**因为图**被拒的。
///
/// 为什么必须查正文而不只看状态码：400 太泛了 —— 参数写错、模型名不存在、
/// 内容审核拒绝，都是 400。只有正文点名图片才能归因到「不支持视觉」。
/// 关键词覆盖各家措辞（英文为主，兼顾中英混排的中转站）。
fn mentions_image(err: &str) -> bool {
    let l = err.to_lowercase();
    const KEYS: &[&str] = &[
        "image", "vision", "multimodal", "multi-modal", "visual",
        "image_url", "input_image", "图片", "图像", "视觉", "多模态",
        // 部分端点用这些措辞表达「该模型只吃文本」
        "text-only", "text only", "does not support image",
        "unsupported content", "invalid content type", "modality",
    ];
    KEYS.iter().any(|k| l.contains(k))
}

/// 有**独立**记录的历史：容量表/名字启发式都判不出视觉的模型，
/// 探测是唯一的真相来源。所以探测结论一经确证就按 `Provider`（硬事实）记录。
///
/// 从响应判定结论。抽成纯函数便于单测（构造各种真实错误体）。
pub fn verdict_from(status: u16, body: &str) -> ProbeVerdict {
    if (200..300).contains(&status) {
        return ProbeVerdict::Supported;
    }
    // 429（限流）/ 5xx（服务端）/ 408（超时）→ 与模型能力无关，判未知
    if status == 429 || status == 408 || status >= 500 {
        return ProbeVerdict::Unknown;
    }
    // 401/403：密钥或权限问题 → 未知（不是「不支持视觉」）
    if status == 401 || status == 403 {
        return ProbeVerdict::Unknown;
    }
    // 400/404/422 等：只有正文点名图片才算「确证不支持」
    if (400..500).contains(&status) && mentions_image(body) {
        return ProbeVerdict::Unsupported;
    }
    // 其余（400 但正文没提图、404 模型不存在等）→ 未知
    ProbeVerdict::Unknown
}

/// 对指定模型做一次视觉探测。
///
/// 走 `ai_ocr::vision_ask` 复用现成请求层（它已支持 profile_id/model/base_url/api_key
/// 四要素覆盖），不另写一份 HTTP 逻辑 —— 避免两套实现逐渐不一致。
async fn probe_once(
    app: &AppHandle,
    profile_id: Option<&str>,
    base_url: Option<&str>,
    api_key: Option<&str>,
    model: &str,
) -> ProbeOutcome {
    let q = "这是测试图，只回答 OK 四个字母，不要解释。";
    match crate::services::ai_service::ai_ocr::vision_ask_raw(
        app,
        PROBE_PNG_B64,
        "image/png",
        Some(q),
        profile_id,
        Some(model),
        base_url,
        api_key,
    )
    .await
    {
        Ok(_) => ProbeOutcome {
            verdict: ProbeVerdict::Supported,
            detail: "端点接受了图片输入，可确证支持视觉。".to_string(),
            raw: String::new(),
        },
        Err(e) => {
            let v = verdict_from(e.status, &e.body);
            let detail = match v {
                ProbeVerdict::Unsupported => format!(
                    "端点拒绝图片输入（HTTP {}），判定为不支持视觉。",
                    e.status
                ),
                ProbeVerdict::Unknown => format!(
                    "HTTP {} 但无法归因到「不支持视觉」（可能是限流、密钥、模型名或参数问题），保留原状态。",
                    e.status
                ),
                ProbeVerdict::Supported => unreachable!("错误路径不会判为支持"),
            };
            ProbeOutcome {
                verdict: v,
                detail,
                raw: e.body.chars().take(400).collect(),
            }
        }
    }
}

/// 探测开关：默认**关闭**。
///
/// 与 `ai.comfyuiAllowedModules` 同一套「能力开关必须来自用户设置」的口径：
/// 探测会真发一次可能计费的外部请求，不能由代码或模型自行决定开。
#[tauri::command]
pub fn ai_get_caps_probe_enabled(app: AppHandle) -> bool {
    read_enabled(&app)
}

#[tauri::command]
pub fn ai_set_caps_probe_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    write_enabled(&app, enabled)
}

/// 开关存哪：与 AI 配置同目录的一个小 JSON，避免为此引入新的存储机制。
fn flag_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = crate::data_location::resolve_data_root(app);
    Some(dir.join("ai_caps_probe.json"))
}

fn read_enabled(app: &AppHandle) -> bool {
    let Some(p) = flag_path(app) else { return false };
    let Ok(t) = std::fs::read_to_string(p) else { return false };
    serde_json::from_str::<serde_json::Value>(&t)
        .ok()
        .and_then(|v| v.get("enabled").and_then(|x| x.as_bool()))
        .unwrap_or(false)
}

fn write_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let p = flag_path(app).ok_or_else(|| "无法定位数据目录".to_string())?;
    let body = serde_json::json!({ "enabled": enabled });
    let text = serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?;
    std::fs::write(p, text).map_err(|e| format!("写入探测开关失败: {}", e))
}

/// 对某个「供应商 + 模型」探测视觉能力。
///
/// 返回结论；**调用方**（前端）据 verdict 决定是否落盘：
///   - Supported / Unsupported → 写回该 ModelEntry 的 caps.vision + vision_source=Provider
///   - Unknown → 什么都不改
///
/// 为什么由前端落盘而不是后端：模型档案是前端持有并整体保存的（ai_set_config 是
/// 全量覆盖），后端单独改一小块会与前端尚未保存的编辑打架。让改动跟着正常的保存流程
/// 走，用户「改了什么就是什么」。
#[tauri::command]
pub async fn ai_probe_vision(
    app: AppHandle,
    profile_id: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    model: String,
) -> Result<ProbeOutcome, String> {
    if !read_enabled(&app) {
        return Err("能力探测未开启。请在设置 → 模型 → 媒体后端中开启「能力探测」后再试。".to_string());
    }
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("未指定要探测的模型名".to_string());
    }
    Ok(probe_once(
        &app,
        profile_id.as_deref(),
        base_url.as_deref(),
        api_key.as_deref(),
        &model,
    )
    .await)
}

// ========== 批次探测（一键把所有未知模型扫一遍）==========
//
// 刻意**不做**在这里：一键扫 59 个模型会一次性产生 59 次外部请求，
// 成本与耗时都不可接受，且用户中途无法叫停。
// 趋势上正确的方法是前端按队列逐个调用上面的单人命令，边跑边显示进度、可随时停。
// 保持「一个命令只做一件事」也让每次调用的成本可预期。

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 成功判为支持() {
        assert_eq!(verdict_from(200, ""), ProbeVerdict::Supported);
        assert_eq!(verdict_from(201, ""), ProbeVerdict::Supported);
    }

    #[test]
    fn 四百且点名图片判不支持() {
        let body = r#"{"error":{"message":"Invalid content type. image_url is only supported by certain models."}}"#;
        assert_eq!(verdict_from(400, body), ProbeVerdict::Unsupported);
        let body2 = r#"{"error":"this model does not support image input"}"#;
        assert_eq!(verdict_from(400, body2), ProbeVerdict::Unsupported);
    }

    #[test]
    fn 中文错误体也认() {
        let body = r#"{"message":"当前模型不支持图片输入"}"#;
        assert_eq!(verdict_from(400, body), ProbeVerdict::Unsupported);
    }

    #[test]
    fn 四百但正文没提图判未知() {
        // 关键回例：400 太泛，不能一律当「不支持视觉」
        let body = r#"{"error":{"message":"model `foo` not found"}}"#;
        assert_eq!(
            verdict_from(400, body),
            ProbeVerdict::Unknown,
            "模型名不存在不是「不支持视觉」"
        );
    }

    #[test]
    fn 限流与服务端错判未知() {
        assert_eq!(verdict_from(429, "rate limit exceeded"), ProbeVerdict::Unknown);
        assert_eq!(verdict_from(500, "internal error"), ProbeVerdict::Unknown);
        assert_eq!(verdict_from(503, ""), ProbeVerdict::Unknown);
        assert_eq!(verdict_from(408, ""), ProbeVerdict::Unknown);
    }

    #[test]
    fn 鉴权失败判未知() {
        // 401/403 是密钥问题，不是模型能力问题 —— 判「不支持」就是脏记忆
        assert_eq!(verdict_from(401, "invalid api key"), ProbeVerdict::Unknown);
        assert_eq!(verdict_from(403, "forbidden"), ProbeVerdict::Unknown);
    }

    #[test]
    fn 四百零四模型不存在判未知() {
        assert_eq!(
            verdict_from(404, r#"{"error":"the model does not exist"}"#),
            ProbeVerdict::Unknown
        );
    }

    #[test]
    fn 关键词匹配不误伤() {
        // 「image」出现在无关语境仍会命中 —— 这是启发式，不是形式证明。
        // 但比只看状态码强：至少要求正文提到图片相关词。
        assert!(mentions_image("image_url is not supported"));
        assert!(mentions_image("Vision is not enabled for this model"));
        assert!(!mentions_image("invalid request body"));
    }

    #[test]
    fn 探测素材是合法的1x1png() {
        // 校验素材确实是 PNG（魔数），避免常量被改坏后探测全假阴
        let bytes = crate::services::ai_service::image_store::test_decode(PROBE_PNG_B64)
            .expect("探测素材必须是合法 base64");
        assert_eq!(&bytes[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a], "PNG 魔数");
        assert!(bytes.len() > 40, "1x1 PNG 应有一个完整的 IHDR");
    }
}
