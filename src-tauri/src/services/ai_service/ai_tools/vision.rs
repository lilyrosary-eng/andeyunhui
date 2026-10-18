//! ai_tools 子模块 · vision —— 图片理解工具：analyze_image
//!
//! 由 ai_tools.rs（5245 行）按工具族机械拆分而来，逻辑零改动。
//! 父模块的 use 导入与共享项经 `use super::*` 取得；这里的顶层项统一 pub(crate)，
//! 由 ai_tools.rs 的 `pub(crate) use <mod>::*` 转出，外部引用路径不变。
#![allow(unused_imports)] //  glob 取父模块导入，按族切分后必有剩余，逐个删只会漏
use super::*;

// ========== 图片理解工具（analyze_image）——AI 对话直接「看图」 ==========
//
// 与 generate_image 对称：那个是「画出来」，这个是「看明白」。
// 图片来自**用户本轮发来的图**（ToolContext.images，前端随 agent 请求带入）。
// 模型不直接持有图片 base64——故用序号引用，避免把数 MB 数据塞进模型上下文。
// 视觉后端走 media.vision（媒体后端链）；未配置时给出可自纠的明确错误。
//
// 注：前端本就会对每张图调一次 ai_vision_ocr 生成泛描述注入消息（兼容不支持视觉的
// 模型）。本工具是**按需深挖**：用户问具体问题（报错说什么 / 有几个人）时，
// 泛描述不够用，需要一个带问题的定向提问。两者互补，不是重复。

/// 视觉调用的目标解析：**媒体后端优先，没有则回落到当前档案**。
///
/// 返回 `(profile_id, model, base_url, api_key)`；为 None 时表示
/// 「交给 `vision_ask` 按它自己的顺序解析」（应用级媒体模型 → 供应商三件套 → 对话模型）。
///
/// ## 为什么要允许回落
/// 以前没配媒体后端时，`analyze_image` 与看图自检会**直接报错**「未配置视觉后端」。
/// 但在多模态已成主流的当下，用户正在用的对话模型往往本身就能看图 ——
/// 让他为了看一眼图先去配一个"媒体后端"，是多余的门槛。
///
/// 于是链条变成：**原生直发 → 媒体后端 → 应用级媒体模型 → 供应商三件套 → 对话模型**，
/// 每一级都是"上一级不可用才走这里"，而最末一级（对话模型）在绝大多数情况下可用。
///
/// ## ⚠️ 为什么媒体后端的模型名会被「有条件忽略」
/// 媒体后端的 `extras.models.vision` 是**已经没有 UI 入口**的旧字段（能力链上的
/// 输入框已撤，模型名统一到 AI 页「媒体模型」）。如果照旧把它当"本次显式指定"传下去，
/// 它的优先级会高于「媒体模型」—— 结果是**用户在「媒体模型」里配了却不生效**
/// （旧数据里存过这个字段的人才会踩到，更难排查）。
///
/// 所以：**应用级配了就以应用级为准**；应用级为空时才用旧字段兜底（不丢老配置）。
/// 媒体后端始终只提供**端点与凭证**这一件事。
/// 解析自检要走的视觉通道，返回 `(profileId, model, baseUrl, apiKey)`。
///
/// 优先级：**配好的视觉后端** → 否则**回落到当前对话档案**（多模态已是主流，
/// 对话模型本身往往就能看图，没配视觉后端不该等于没有自检）。
///
/// ★ 抽成独立函数**是为了让"测试自检通道"按钮走同一段逻辑**。
/// 如果测试与真实路径各写一套，测通了不代表能用 —— 那正是"让用户猜"。
pub(crate) fn resolve_vision_target(
    vision: Option<&MediaToolCfg>,
    profile_id: Option<&str>,
    app_level_vision_configured: bool,
) -> Result<(Option<String>, Option<String>, Option<String>, Option<String>), String> {
    if let Some(v) = vision.filter(|c| c.is_ready()) {
        if v.backend_kind != "openai" {
            return Err(format!("暂不支持的视觉后端类型：{}", v.backend_kind));
        }
        return Ok((
            v.profile_id.clone(),
            if app_level_vision_configured { None } else { v.model.clone() },
            Some(v.base_url.clone()).filter(|s| !s.is_empty()),
            Some(v.api_key.clone()).filter(|s| !s.is_empty()),
        ));
    }
    Ok((profile_id.map(str::to_string), None, None, None))
}

pub(crate) fn vision_target(
    ctx: &ToolContext,
) -> Result<(Option<String>, Option<String>, Option<String>, Option<String>), String> {
    let app_level = crate::services::ai_service::ai_profile::load_config(&ctx.app)
        .media_models
        .get("vision")
        .is_some();
    resolve_vision_target(ctx.media.vision.as_ref(), ctx.profile_id.as_deref(), app_level)
}

/// 让视觉模型看一眼刚生成的媒体，按用户的原始要求指出最该改的点。
///
/// 为什么需要：研究里反复强调「**零错误的图 ≠ 正确的图**」——图能跑出来不代表画对了，
/// 偏移、接缝、糊掉的手、过强的效果只有看像素才知道。没有这一步，AI 建图就是
/// 「跑完即交付」，用户只能自己发现不对再来一轮。
///
/// ⚠️ 自检失败**不算生成失败**：它是增强，拿不到就如实说明，绝不能把已经生成好的图丢掉。
pub(crate) async fn critique_output(ctx: &ToolContext, data_url: &str, request: &str) -> Result<String, String> {
    let (mime, b64) = split_data_url(data_url);
    let prompt = format!(
        "这是刚刚生成的图。用户最初的要求是：「{}」。\n请判断它是否满足要求，并指出**最该改的 1-3 点**，每点给出具体可执行的调整（提示词 / 采样步数 / 尺寸 / 模型 / 节点参数）。若已完全满足要求，只回复「符合」。",
        request
    );
    let app_level = crate::services::ai_service::ai_profile::load_config(&ctx.app)
        .media_models
        .get("vision")
        .is_some();

    // 视觉链：配好的视觉后端优先，按链兜底；一个都没配 → 回落到当前对话档案（既有语义）。
    let mut stations: Vec<MediaToolCfg> = Vec::new();
    if let Some(v) = ctx.media.vision.as_ref().filter(|c| c.is_ready()) {
        stations.push(v.clone());
        stations.extend(ctx.media.fallbacks.vision.iter().filter(|c| c.is_ready()).cloned());
    }
    if stations.is_empty() {
        let (pid, model, url, key) =
            resolve_vision_target(None, ctx.profile_id.as_deref(), app_level)?;
        return crate::services::ai_service::ai_ocr::vision_ask(
            &ctx.app,
            &b64,
            &mime,
            Some(&prompt),
            pid.as_deref(),
            model.as_deref(),
            url.as_deref(),
            key.as_deref(),
        )
        .await;
    }

    let primary = stations.remove(0);
    let app_c = ctx.app.clone();
    let b64_c = b64.clone();
    let mime_c = mime.clone();
    let prompt_c = prompt.clone();
    let pf = ctx.profile_id.clone();
    let attempt = move |c: MediaToolCfg| {
        let (app, b64, mime, prompt, pf) =
            (app_c.clone(), b64_c.clone(), mime_c.clone(), prompt_c.clone(), pf.clone());
        async move {
            // 每一站各自解析（app 级视觉模型名会覆盖站里的 model，规则与真实自检一致）
            let (pid, model, url, key) = resolve_vision_target(Some(&c), pf.as_deref(), app_level)?;
            crate::services::ai_service::ai_ocr::vision_ask(
                &app,
                &b64,
                &mime,
                Some(&prompt),
                pid.as_deref(),
                model.as_deref(),
                url.as_deref(),
                key.as_deref(),
            )
            .await
        }
    };
    let (res, notices) = run_media_chain("自检", &primary, &stations, attempt).await;
    match res {
        Ok(text) => Ok(with_notices(text, &notices)),
        Err(e) => Err(err_with_notices(e, &notices)),
    }
}

/// 取出工具的可选自检参数（用户最初的画面要求原文）。
pub(crate) fn check_request_of(args: &serde_json::Value) -> Option<String> {
    args.get("check")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 把自检结论追加到工具文本上。失败只附一句说明，不影响已生成的结果。
///
/// `auto` = 这次自检是**系统自动补的**（模型没显式要求，见 `last_user_ask`），
/// 只影响措辞：自动补的那次会带上"可在哪里关掉"的指引。
///
/// ⚠️ **两种失败都如实报告，不静默**。我最初把自动补的那次做成了静默，
/// 理由是"没配视觉后端时每张图都带一句用户没要过的噪音"——但那是**让用户猜**：
/// 图看着不对、自检又没动静，人根本不知道该去检查什么。用户明确要求显性化。
/// 噪音问题改由**开关**解决（设置里可关掉自动自检），而不是靠隐藏失败。
pub(crate) async fn append_critique(
    ctx: &ToolContext,
    text: String,
    data_url: &str,
    check: Option<&str>,
    auto: bool,
) -> String {
    let Some(req) = check else { return text };
    match critique_output(ctx, data_url, req).await {
        Ok(c) => format!("{}\n\n自检（视觉模型对成图的评价，据此可再调整重试）：{}", text, c),
        Err(e) if auto => format!(
            "{}\n\n（自动自检未完成：{}｜可在 设置 → 模型 关掉「生成后自动自检」，或用「测试自检通道」看完整错误）",
            text,
            e.chars().take(160).collect::<String>()
        ),
        Err(e) => format!("{}\n\n（未能自检：{}）", text, e),
    }
}

/// 从事件日志里取**最后一条非空用户发言**（纯函数，便于测试）。
pub(crate) fn last_user_ask_in(events: &[SessionEvent]) -> Option<String> {
    events.iter().rev().find_map(|e| match e {
        SessionEvent::User { content, .. } => {
            let s = content.trim();
            if s.is_empty() {
                None
            } else {
                Some(s.to_string())
            }
        }
        _ => None,
    })
}

/// 用户**最近一条原话**（当前会话的最后一条 User 事件）。
///
/// ## 为什么工具要自己去会话里捞
/// 自检要的是"用户最初的画面要求原文"，而那个文本**不在工具参数里** —— 模型得主动填
/// `check`。实测本地 9B **从不填**（它连"该不该迭代"都判断不好），于是这一整条
/// "把能跑出图变成画得对"的机制形同不存在。
///
/// 工具手里有 `app` + `request_id`，而**会话文件就是按 request_id 命名的**
/// （`run_agent` 也是这么 `load_agent_session` 的）⇒ 直接读会话日志的最后一条用户发言即可。
/// 取"最后一条"而不是"第一条"：多轮追问（「再亮点」）时，最近那条才是要对照的要求。
///
/// 拿不到一律返回 `None`（就当没有自检，不是错误）。
pub(crate) fn last_user_ask(ctx: &ToolContext) -> Option<String> {
    let s = crate::services::ai_service::ai_session::load_agent_session(&ctx.app, &ctx.request_id)?;
    last_user_ask_in(s.events())
}

/// 按 data URL 的**实际 MIME** 判定媒体卡片类型，返回 `(card, kind)`。
///
/// 为什么必须按 mime 判而不是写死：ComfyUI 工作流可以把**视频/音频**当输出
/// （`pick_first_media` 就认 `videos` 键），拼出来的 dataURL 是 `data:video/mp4;...`。
/// 早先无条件写 `card:"image"`，前端就把它贴进 `<img>` → 显示成一张坏图。
pub(crate) fn media_card_for(data_url: &str) -> (&'static str, &'static str) {
    let mime = data_url
        .strip_prefix("data:")
        .and_then(|r| r.split(';').next())
        .unwrap_or("")
        .to_ascii_lowercase();
    if mime.starts_with("video/") {
        ("video", "video")
    } else if mime.starts_with("audio/") {
        ("audio", "audio")
    } else {
        ("image", "image")
    }
}

/// 把 data URL 拆成 (mime, base64)。不是 data URL 时按 image/png 兜底（容错）。///
/// 按 RFC 2397 解析：`data:[<mediatype>][;base64],<data>` —— **数据从第一个逗号之后开始**。
/// （早先按「分号后一位」取数据，遇到 `data:image/jpeg;,XXX` 这种「有分号无 base64 标记」
/// 的写法会把逗号一起带进 base64，把坏数据发给视觉端点。单测抓到的。）
pub(crate) fn split_data_url(u: &str) -> (String, String) {
    let fallback = || ("image/png".to_string(), u.to_string());
    let Some(rest) = u.strip_prefix("data:") else { return fallback() };
    let Some(comma) = rest.find(',') else { return fallback() };
    let meta = &rest[..comma]; // "image/png" 或 "image/png;base64"
    let b64 = rest[comma + 1..].to_string();
    let mime = meta.split(';').next().unwrap_or("").trim();
    if mime.is_empty() {
        ("image/png".to_string(), b64)
    } else {
        (mime.to_string(), b64)
    }
}

pub(crate) struct AnalyzeImageTool;
#[async_trait::async_trait]
impl AiTool for AnalyzeImageTool {
    fn name(&self) -> &'static str {
        "analyze_image"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "查看并分析用户本轮发来的图片。当用户针对图片提问（图里有什么、这个报错说什么、图上有几个人、截图里的文字是什么）时调用。image 为图片序号（从 1 开始，对应用户发图的顺序），question 为要问的具体问题。分析结果直接用于组织回答，无需转述。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "image": { "type": "integer", "description": "图片序号，从 1 开始" },
                        "question": { "type": "string", "description": "针对这张图片要问的具体问题" }
                    },
                    "required": ["image", "question"]
                }
            }
        })
    }
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let n = args.get("image").and_then(|v| v.as_u64()).unwrap_or(0);
        let q: String = args
            .get("question")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .chars()
            .take(24)
            .collect();
        serde_json::json!({ "card": "generic", "kind": "other", "title": format!("分析图 {} {}", n, q) })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let n = args.get("image").and_then(|v| v.as_u64()).unwrap_or(0);
        let q = args
            .get("question")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if q.is_empty() {
            return Err("缺少 question 参数（要问这张图片什么问题）".to_string());
        }
        if ctx.images.is_empty() {
            return Err("本轮对话没有附带图片。请让用户先发图，或改用文字描述需求。".to_string());
        }
        // 序号 1 起；越界时报出实际张数，让模型能自纠（它常从 0 开始数）
        let idx = match usize::try_from(n) {
            Ok(v) if v >= 1 && v <= ctx.images.len() => v - 1,
            _ => return Err(format!("图片序号 {} 越界：本轮共附带 {} 张图", n, ctx.images.len())),
        };
        let (pid, model, url, key) = vision_target(ctx)?;
        let (mime, b64) = split_data_url(&ctx.images[idx]);
        // 只接 OpenAI 兼容视觉协议（ComfyUI 是生图后端，不做理解）——
        // backend_kind 的校验已在 vision_target 里做过。
        let text = crate::services::ai_service::ai_ocr::vision_ask(
            &ctx.app,
            &b64,
            &mime,
            Some(&q),
            pid.as_deref(),
            model.as_deref(),
            url.as_deref(),
            key.as_deref(),
        )
        .await?;
        Ok(ToolExecResult::plain(text))
    }
}
