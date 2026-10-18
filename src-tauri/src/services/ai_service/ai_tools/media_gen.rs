//! ai_tools 子模块 · media_gen —— 媒体生成工具：generate_image / generate_speech
//!
//! 由 ai_tools.rs（5245 行）按工具族机械拆分而来，逻辑零改动。
//! 父模块的 use 导入与共享项经 `use super::*` 取得；这里的顶层项统一 pub(crate)，
//! 由 ai_tools.rs 的 `pub(crate) use <mod>::*` 转出，外部引用路径不变。
#![allow(unused_imports)] //  glob 取父模块导入，按族切分后必有剩余，逐个删只会漏
use super::*;

// ========== 生图工具（generate_image）——AI 对话直接驱动机器生图 ==========
//
// 路由（前端 comfyuiConfig.ts 解析后经 ToolContext.comfyui 传入）：
//   ① 配了 ComfyUI 且蓝图指定了工作流 → 写入 prompt 参数位 → 整图提交（复用用户工作流）；
//   ② 配了 ComfyUI 无蓝图 → 内置最小 txt2img（需 ckpt）；
//   ③ 未配 ComfyUI → 云端 ai_generate_image（算力来源的 image_model）。
// 图片本体只走 meta（前端渲染卡片），绝不回填进 text——base64 数 MB 会炸模型上下文。

/// 在 API 工作流里启发式找提示词写入位（前端未给 prompt_at 时的兜底）：
/// 优先 CLIPTextEncode 系节点的 text 输入，其次任意含 text 字符串输入的节点。
pub(crate) fn comfyui_prompt_slot(wf: &serde_json::Value) -> Option<ComfyuiSlot> {
    let nodes = wf.as_object()?;
    let text_input = |node: &serde_json::Value| node.pointer("/inputs/text").and_then(|v| v.as_str()).is_some();
    // 第一遍：知名文本编码类（正/负提示词都算，取首个即可被用户工作流覆盖）
    for (id, node) in nodes {
        let ct = node.get("class_type").and_then(|v| v.as_str()).unwrap_or("");
        if (ct.contains("CLIPTextEncode") || ct == "PrimitiveString" || ct == "PrimitiveStringMultiline") && text_input(node) {
            return Some(ComfyuiSlot { node_id: id.clone(), input_key: "text".to_string() });
        }
    }
    // 第二遍：任何带 text 字符串输入的节点
    for (id, node) in nodes {
        if text_input(node) {
            return Some(ComfyuiSlot { node_id: id.clone(), input_key: "text".to_string() });
        }
    }
    None
}

/// 经 ComfyUI 生图：蓝图工作流（写入 prompt 位后整图提交）或内置最小 txt2img。
/// 复用 multimodal_service::comfyui_generate_media（tauri 命令函数，可直接调用）。
/// 找**图片输入位**：`LoadImage` 一类节点的 `image` 字符串输入。
///
/// 前端给了 `image_at` 就用前端的（前端有 /object_info，能按 upload 元数据准确判定）；
/// 这是找不到时的名字启发式。两者都没有 → 该工作流不吃图片输入。
pub(crate) fn comfyui_image_slot(wf: &serde_json::Value) -> Option<ComfyuiSlot> {
    let nodes = wf.as_object()?;
    // 只认**字符串**输入：若该输入是连线（数组 [nodeId, idx]），说明图片来自图内生成而非上传
    let has_str_image = |node: &serde_json::Value| {
        node.pointer("/inputs/image").and_then(|v| v.as_str()).is_some()
    };
    for (id, node) in nodes {
        let ct = node.get("class_type").and_then(|v| v.as_str()).unwrap_or("");
        if ct.contains("LoadImage") && has_str_image(node) {
            return Some(ComfyuiSlot { node_id: id.clone(), input_key: "image".to_string() });
        }
    }
    for (id, node) in nodes {
        if has_str_image(node) {
            return Some(ComfyuiSlot { node_id: id.clone(), input_key: "image".to_string() });
        }
    }
    None
}

/// 把附图的 data URL 解码并上传到 ComfyUI 的 `input/`，返回服务端给的引用名。
pub(crate) async fn upload_input_image(cfg: &MediaToolCfg, data_url: &str) -> Result<String, String> {
    let (mime, b64) = split_data_url(data_url);
    let ext = match mime.to_ascii_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        _ => "png",
    };
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("附图 base64 解码失败: {}", e))?;
    if bytes.is_empty() {
        return Err("附图内容为空".to_string());
    }
    // 文件名带时间戳：多轮/并发之间不互相覆盖（服务端仍会按需改名，以它返回的为准）
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let name = format!("ae_{}.{}", stamp, ext);
    crate::services::multimodal_service::comfyui_upload_image(&cfg.base_url, &name, bytes, &mime).await
}

/// 生成图片。`image` 为用户附图（data URL）——给了就是**图生图**：
/// 先把图上传到 ComfyUI 的 `input/`，再把服务端返回的文件名写进工作流的图片输入位。
pub(crate) async fn generate_via_comfy(
    cfg: &MediaToolCfg,
    prompt: &str,
    image: Option<&str>,
    // 负向提示词。**只对内置最小工作流生效** —— 用法②（用户自己的蓝图工作流）里
    // 正负两个词都写在工作流内部，那是用户调好的东西，不该被这里覆盖。
    // 调用方在"传了负向词但走的是工作流"时会把这件事说明白，而不是静默丢掉。
    negative: Option<&str>,
    // checkpoint 的**本次显式指定**（用户直接对 AI 说"用 xxx 模型画"）。
    // 优先级：显式指定 > 设置页配置 > 自动（列表第一个）—— 见 `resolve_checkpoint_choice`。
    ckpt_override: Option<&str>,
) -> Result<String, String> {
    if let Some(wf) = &cfg.workflow {
        let mut wf = wf.clone();
        // 提示词写入位：前端解析结果优先，启发式兜底；都找不到必须报错——
        // 静默提交原提示词会让「按用户描述作画」落空，属不可静默的失败。
        let slot = cfg
            .prompt_at
            .clone()
            .or_else(|| comfyui_prompt_slot(&wf))
            .ok_or_else(|| "蓝图工作流里找不到提示词输入（text），无法按描述作图；请在设置→模型→本地生图换用带 CLIPTextEncode 的工作流".to_string())?;
        if let Some(inputs) = wf.get_mut(&slot.node_id).and_then(|n| n.get_mut("inputs")) {
            if let Some(obj) = inputs.as_object_mut() {
                obj.insert(slot.input_key.clone(), serde_json::json!(prompt));
            }
        }
        // 图生图：上传附图并把文件名写进图片输入位
        if let Some(data_url) = image {
            let name = upload_input_image(cfg, data_url).await?;
            let at = cfg
                .image_at
                .clone()
                .or_else(|| comfyui_image_slot(&wf))
                .ok_or_else(|| {
                    "该工作流没有图片输入位（如 LoadImage 的 image），无法用附图做图生图。\
                     请换一个带图片输入的工作流，或让用户改用文字描述（文生图）"
                        .to_string()
                })?;
            if let Some(inputs) = wf.get_mut(&at.node_id).and_then(|n| n.get_mut("inputs")) {
                if let Some(obj) = inputs.as_object_mut() {
                    obj.insert(at.input_key.clone(), serde_json::json!(name));
                }
            }
        }
        crate::services::multimodal_service::comfyui_generate_media(
            None,
            cfg.base_url.clone(),
            None,
            Some(wf),
            None, // 工作流自带上面的正负提示词，不在这里覆盖
            None, // 采样参数也在工作流里
        )
        .await
    } else {
        // 内置最小 txt2img 不吃图片输入——明确报错，别静默把附图丢掉
        if image.is_some() {
            return Err(
                "内置的最小工作流只支持文生图。要图生图，请在设置→模型→本地生图里指定一个带图片输入（LoadImage）的工作流"
                    .to_string(),
            );
        }
        // 空串交给后端去"自动挑一个"（列表第一个）—— 这里不再报错。
        // 报错会让"设置页留空"这种配置直接不能用，而留空的语义就是"自动"。
        let ckpt = crate::services::multimodal_service::resolve_checkpoint_choice(
            ckpt_override,
            Some(cfg.ckpt.as_str()),
            &[],
        )
        .unwrap_or_default();
        crate::services::multimodal_service::comfyui_generate_media(
            Some(prompt.to_string()),
            cfg.base_url.clone(),
            Some(ckpt),
            None,
            negative.map(str::to_string),
            // 采样参数用**设置页配的那套**（AI 生图走的是内置流程，就该跟用户在面板里选的一致）。
            // 这里没有单独给 AI 开放采样参数 —— 需要精细控制时它该用 comfyui_build_workflow 自己搭图。
            cfg.txt2img.clone(),
        )
        .await
    }
}

/// 生图工具：用户说「画张图」时由模型调用。图片经 meta 回传前端直接渲染。
pub(crate) struct GenerateImageTool;
#[async_trait::async_trait]
impl AiTool for GenerateImageTool {
    fn name(&self) -> &'static str {
        "generate_image"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "生成图片。当用户要求画画、生成图像、出图、配图时调用。prompt 写详细的画面描述（主体、风格、构图、光线等，中英文均可）。若用户**发来了一张图**并希望「照着这张图改/把它变成…/以它为基础生成」，把 image 设为那张图的序号（从 1 开始，可与 analyze_image 用同一个序号），即为图生图；不带 image 就是纯文生图。已配置 ComfyUI 时走本地工作流（含用户在 ComfyUI 里调好的流程），否则走云端图片模型。生成成功后图片会直接展示在对话中，无需你转述画面内容。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "prompt": { "type": "string", "description": "画面描述（越具体越好：主体、风格、构图、光线等）" },
                        "image": { "type": "integer", "description": "（可选）以用户发来的第几张图为底稿做图生图，从 1 开始。仅当用户明确要求「基于/参照/修改」某张附图时使用；纯文字作画时不要传。" },
                        "checkpoint": { "type": "string", "description": "（可选）指定用哪个 checkpoint 模型文件。**只在用户明确点名了某个模型时**填（如「用 waiIllustriousSDXL 画」），名字必须来自 comfyui_list_models 的返回值原文。留空则由系统按「设置页配置 > 列表第一个」自行选择；用你自己搭图的能力（comfyui_build_workflow）时不需要它。" },
                        "negative": { "type": "string", "description": "（可选）负向提示词——不希望出现的元素/质量缺陷，如「blurry, extra fingers, watermark」。留空则用内置默认质量词（text, watermark, worst quality, low quality, blurry）。当用户抱怨「画崩了/多手指/糊」时，把对应缺陷写进这里再重画，比只改正向提示词有效得多。仅对内置流程有效；若已启用用户自己的 ComfyUI 工作流，工作流内部的负向词不会被覆盖（功能会明确告知）。" },
                        "check": { "type": "string", "description": "（可选）要拿来对照的画面要求原文。**留空即可**：系统会自动用你最近收到的那条用户消息做自检（视觉模型看一眼成图并指出最该改的 1-3 点）。用户要求「改到满意 / 反复调整」时，直接照自检结论改就行，不必自己回想原文。" }
                    },
                    "required": ["prompt"]
                }
            }
        })
    }
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let short: String = args
            .get("prompt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .chars()
            .take(30)
            .collect();
        serde_json::json!({ "card": "generic", "kind": "other", "title": format!("生成图片 {}", short) })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let prompt = args
            .get("prompt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if prompt.is_empty() {
            return Err("缺少 prompt 参数（画面描述）".to_string());
        }
        // 附图（图生图）：与 analyze_image 同一套序号约定（1 起），越界时报出实际张数便于自纠
        let image_data: Option<String> = match args.get("image").and_then(|v| v.as_u64()) {
            None => None,
            Some(n) => {
                if ctx.images.is_empty() {
                    return Err("传了 image 参数但本轮对话没有附带图片；纯文字作画请去掉 image".to_string());
                }
                match usize::try_from(n) {
                    Ok(v) if v >= 1 && v <= ctx.images.len() => Some(ctx.images[v - 1].clone()),
                    _ => return Err(format!("图片序号 {} 越界：本轮共附带 {} 张图", n, ctx.images.len())),
                }
            }
        };
        // checkpoint 的**本次显式指定**（可选）。只有用户点名某个模型时才该有值；
        // 空白当"没传"，落到「设置页配置 > 列表第一个」。
        let ckpt_override: Option<String> = args
            .get("checkpoint")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        // 负向提示词（可选）。空白一律当"没传"，交给后端回落内置默认 ——
        // 否则模型随手填个空串就会把默认质量词抹掉，成图质量无端变差。
        let negative: Option<String> = args
            .get("negative")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let cfg = ctx.media.image.as_ref().filter(|c| c.is_ready());

        // ── 按链执行（每站策略）──────────────────────────────────────────────
        // 一次尝试：按这一站的类型分派。抽成闭包是为了让链执行器在失败后能换下一站 ——
        // **兜底决策只能在 Rust 做**：前端在发请求时就退场了，它不知道这一站成没成。
        let prompt_c = prompt.clone();
        let img_c = image_data.clone();
        let neg_c = negative.clone();
        let cko_c = ckpt_override.clone();
        let app_c = ctx.app.clone();
        let profile_fallback = ctx.profile_id.clone();
        let attempt = move |c: MediaToolCfg| {
            let prompt = prompt_c.clone();
            let img = img_c.clone();
            let neg = neg_c.clone();
            let cko = cko_c.clone();
            let app = app_c.clone();
            let pf = profile_fallback.clone();
            async move {
                if c.backend_kind == "comfyui" {
                    // 失败原因带上技能包 slug 前缀（前端据此 append 进该工作流备注）
                    generate_via_comfy(&c, &prompt, img.as_deref(), neg.as_deref(), cko.as_deref())
                        .await
                        .map(|u| (u, "comfyui".to_string()))
                        .map_err(|e| tag_skill_fail(Some(&c), e))
                } else {
                    // 云端 /images/generations 是纯文生图，没有图片输入位：明确拒绝，
                    // 别静默把附图丢掉让用户以为「照图生成」成功了。
                    if img.is_some() {
                        return Err(
                            "当前图片后端是云端模型，不支持「以图生图」。要改图请改用 ComfyUI 并指定一个带图片输入（LoadImage）的工作流；或改为纯文字描述重新生成"
                                .to_string(),
                        );
                    }
                    // ★ 尊重媒体后端配置：优先用后端自带的档案与图像模型名，都没有才回落当前对话档案。
                    let profile = c.profile_id.clone().or_else(|| pf);
                    crate::services::multimodal_service::generate_image_inner(
                        &app,
                        &prompt,
                        profile.as_deref(),
                        c.model.as_deref(),
                    )
                    .await
                    .map(|u| (u, "cloud".to_string()))
                }
            }
        };

        // 未配置图片后端 → 沿用既有语义：走**当前对话档案**（合成一站，交给链执行器统一处理）。
        let primary = cfg.cloned().unwrap_or_else(|| MediaToolCfg {
            kind: "image".to_string(),
            backend_kind: "openai".to_string(),
            name: "当前对话档案".to_string(),
            ..Default::default()
        });
        let (res, notices) = run_media_chain("图像", &primary, &ctx.media.fallbacks.image, attempt).await;
        let (data_url, source) = match res {
            Ok(v) => v,
            Err(e) => return Err(err_with_notices(e, &notices)),
        };
        let source = source.as_str();
        let used_workflow = cfg.map(|c| c.workflow.is_some()).unwrap_or(false);
        // 传了负向词、但走的是**用户自己的工作流** → 那个词没有被使用。
        // 必须说出来：静默忽略会让模型以为"改负向词没用"，从而反复重试同一件事。
        let neg_ignored = negative.is_some() && used_workflow && source == "comfyui";
        // ⚠️ 必须按 dataURL 的**实际 MIME** 判定，不能无条件当图片：
        //    ComfyUI 工作流可以把视频/音频当输出（data:video/mp4;... 等），
        //    硬编码 card:"image" 会让前端把视频贴进 <img>，显示成一张坏图。
        let (card, kind) = media_card_for(&data_url);
        let noun = match card {
            "video" => "视频",
            "audio" => "音频",
            _ => "图片",
        };
        let text = if source == "comfyui" {
            format!(
                "{}已生成（ComfyUI 本地{}{}），已直接展示给用户，无需转述内容。{}",
                noun,
                if used_workflow { "工作流" } else { "内置流程" },
                if image_data.is_some() { "，图生图" } else { "" },
                if neg_ignored {
                    "⚠️ 你这次传的 negative 没有被使用：当前走的是用户自己的 ComfyUI 工作流，\
                     它内部自带正负提示词。要改负向词，请改用 comfyui_build_workflow 自己搭图\
                     （在 CLIPTextEncode 节点里写），或请用户换成内置流程。"
                } else {
                    ""
                }
            )
        } else {
            format!("{}已生成（云端图片模型），已直接展示给用户，无需转述画面内容。", noun)
        };
        // 自检在组装 meta 之前做（data_url 之后要被移动进 meta）
        // 自检：模型显式给的 `check` 优先；**没给就回落到用户最近一条原话** ——
        // 让这一步默认发生，而不是指望模型想起来填（实测本地 9B 从不填）。
        // 显式 check 一定跑；否则看设置里的「生成后自动自检」（默认开）。
        // 关掉 = 连"回落用户原话"也不做 —— 省掉那次视觉调用。
        let explicit_check = check_request_of(args);
        let auto_on = cfg.and_then(|c| c.selfcheck).unwrap_or(true);
        let auto = explicit_check.is_none();
        let check = explicit_check.or_else(|| if auto_on { last_user_ask(ctx) } else { None });
        let text = append_critique(ctx, text, &data_url, check.as_deref(), auto).await;
        // 兜底/降级/警告一律显式呈现（用户 2026-10-17 明确要求：不允许只进日志）
        let text = with_notices(text, &notices);
        let title: String = prompt.chars().take(60).collect();
        let mut meta = serde_json::json!({
            "card": card,
            "kind": kind,
            "title": title,
            "source": source,
        });
        // 媒体本体挂在以 card 为名的键上（image / video / audio 三选一），前端按 card 取
        meta[card] = serde_json::json!(data_url);
        Ok(ToolExecResult::with_meta(text, meta))
    }
}

// ========== 语音合成工具（generate_speech）——AI 对话直接出声 ==========
//
// 路由（前端 resolve.ts 解析后经 ToolContext.media.speech 传入）：
//   - openai 档 → ai_tts（走 profile_id 取该档案的 tts_model 与凭证）。
// 当前仅云端一种后端；后端清单抽象已为将来的本地 TTS 后端留位。
// 音频本体只走 meta（前端渲染播放器），绝不回填进 text——base64 会炸模型上下文。

/// 语音合成工具：用户说「读出来」「念一下」「转成语音」时由模型调用。
pub(crate) struct GenerateSpeechTool;
#[async_trait::async_trait]
impl AiTool for GenerateSpeechTool {
    fn name(&self) -> &'static str {
        "generate_speech"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "把文本合成语音（TTS）。当用户要求朗读、念出来、转成语音、配音时调用。text 为要朗读的文本内容（可直接用用户给的原文，或你整理后的朗读稿）。生成成功后音频会直接展示在对话中供播放，无需你转述内容。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "text": { "type": "string", "description": "要朗读的文本内容" }
                    },
                    "required": ["text"]
                }
            }
        })
    }
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let short: String = args
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .chars()
            .take(24)
            .collect();
        serde_json::json!({ "card": "generic", "kind": "other", "title": format!("合成语音 {}", short) })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let text = args
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if text.is_empty() {
            return Err("缺少 text 参数（要朗读的文本）".to_string());
        }
        let cfg = ctx.media.speech.as_ref().filter(|c| c.is_ready());
        let Some(c) = cfg else {
            return Err(
                "未配置语音后端：请在设置 → 模型 → 媒体后端里添加一个并绑定到「语音」能力（需该算力来源配好 TTS 模型）".to_string(),
            );
        };
        // 目前只有 openai 兼容 /audio/speech 一种实现；其余后端类型暂未支持。
        let app_c = ctx.app.clone();
        let text_c = text.clone();
        let pf = ctx.profile_id.clone();
        let attempt = move |cc: MediaToolCfg| {
            let (app, t, pf) = (app_c.clone(), text_c.clone(), pf.clone());
            async move {
                match cc.backend_kind.as_str() {
                    "openai" => {
                        // ★ 尊重媒体后端配置：档案优先用后端自带的，其次当前对话档案；
                        //   模型名用后端声明的（早先被忽略，导致它只当就绪判据用）。
                        let profile = cc.profile_id.clone().or_else(|| pf);
                        crate::services::multimodal_service::tts_inner(
                            &app,
                            &t,
                            profile.as_deref(),
                            cc.model.as_deref(),
                        )
                        .await
                    }
                    // ComfyUI：跑用户的 **TTS 工作流**（文本经 `comfyui_prompt_slot` 写进
                    // 工作流里的 text 输入；产出由 `pick_first_media` 按 audio 键取回）。
                    //
                    // ⚠️ **必须显式要求工作流**：不要求的话会落到内置 txt2img ——
                    // 那个只会生成一张图，然后用"语音"的名义交出去。
                    "comfyui" => {
                        if cc.workflow.is_none() {
                            return Err(
                                "语音后端配的是 ComfyUI，但没有指定工作流。请在「本地生图」里选一个 \
                                 TTS 工作流（内置 txt2img 只能出图，不能合成语音）"
                                    .to_string(),
                            );
                        }
                        generate_via_comfy(&cc, &t, None, None, None).await
                    }
                    other => Err(format!("暂不支持的语音后端类型：{}", other)),
                }
            }
        };
        let (res, notices) = run_media_chain("语音", c, &ctx.media.fallbacks.speech, attempt).await;
        let data_url = match res {
            Ok(v) => v,
            Err(e) => return Err(err_with_notices(e, &notices)),
        };
        let text_out = with_notices(
            "语音已生成，已直接展示给用户供播放，无需转述内容。".to_string(),
            &notices,
        );
        let title: String = text.chars().take(60).collect();
        let mut meta = serde_json::json!({
            "card": "audio",
            "kind": "audio",
            "title": title,
            "source": "cloud",
        });
        meta["audio"] = serde_json::json!(data_url);
        Ok(ToolExecResult::with_meta(text_out, meta))
    }
}
