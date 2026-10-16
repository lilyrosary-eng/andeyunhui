// 多模态服务（multimodal_service.rs）—— 阶段 5 · AI 发图 + 语音合成。
//
// 命令：
//   ai_generate_image(prompt, profile_id) -> data URL（OpenAI 兼容 /images/generations）
//   ai_tts(text, profile_id)             -> data URL（OpenAI 兼容 /audio/speech）
//
// 设计：
// - 复用 ai_service 的 profile 解析与认证（resolve_profile / load_profiles）。
// - 图片生成：POST {base_url}/images/generations，请求 b64_json，返回 data URL。
//   部分供应商返回 URL 而非 base64（如通义），两种都兼容。
// - 语音合成：POST {base_url}/audio/speech，请求 mp3，返回 audio data URL。
// - profile 需配置 image_model / tts_model 才可用；未配置返回明确错误。

use crate::services::ai_service;

/// AI 生成图片（OpenAI 兼容 /images/generations）。
/// 返回 data URL（png）；无法取 base64 时尝试取 url（再转 data URL 会失败则回退原 url）。
#[tauri::command]
pub async fn ai_generate_image(
    app: tauri::AppHandle,
    prompt: String,
    profile_id: Option<String>,
) -> Result<String, String> {
    generate_image_inner(&app, &prompt, profile_id.as_deref(), None).await
}

/// 生图实现体。
///
/// `model_override` 供**媒体后端自带图像模型名**的场景使用：那种配置下模型名来自
/// 媒体后端清单（`extras.models.image`），而不是档案的 `image_model`。
/// 早先工具层忽略了媒体后端的 profileId 与 model，导致「媒体后端里配的 openai 生图条目」
/// 实际不生效（只有视觉那条链真正接通）。
pub async fn generate_image_inner(
    app: &tauri::AppHandle,
    prompt: &str,
    profile_id: Option<&str>,
    model_override: Option<&str>,
) -> Result<String, String> {
    let config = ai_service::load_config(app);
    let cfg = ai_service::resolve_target(&config, profile_id);
    if cfg.api_key.trim().is_empty() {
        return Err("未配置 API Key".to_string());
    }
    // 模型来源：**应用级「媒体模型」优先** → 调用方覆盖（媒体后端旧字段） → 供应商旧字段。
    //
    // ⚠️ 这里刻意**不**回落到 `cfg.model`（对话模型）：拿对话模型当图片模型必然失败，
    //    宁可明确报错。这与视觉那条链不同 —— 视觉回落到对话模型是**合理**的
    //    （多模态模型本身就能看图），生图没有这个前提。
    //
    // 为什么应用级要压过 model_override：后者来自媒体后端的 `extras.models.image`，
    // 那个输入框已经撤了（配置统一到媒体后端面板的能力链下拉框），
    // 属于"看不见、改不掉"的僵尸字段，不该再压过用户新配的值。
    let app_level = config.media_models.get("image").map(str::to_string);
    let model = app_level
        .or_else(|| {
            model_override
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .or_else(|| {
            cfg.image_model
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .ok_or_else(|| {
            "未配置图片生成模型：可在 设置 → 模型 → 媒体后端 的「图像能力链」里选一个".to_string()
        })?;

    let url = format!("{}/images/generations", cfg.base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "n": 1,
        "size": "1024x1024",
        "response_format": "b64_json",
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("创建请求客户端失败: {}", e))?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.api_key.trim()))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text.chars().take(300).collect::<String>()));
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    let data = &v["data"][0];
    // 1) b64_json
    if let Some(b64) = data["b64_json"].as_str() {
        return Ok(format!("data:image/png;base64,{}", b64));
    }
    // 2) url（部分供应商返回 URL）
    if let Some(u) = data["url"].as_str() {
        return Ok(u.to_string());
    }
    Err("图片生成响应缺少数据".to_string())
}

/// AI 语音合成（OpenAI 兼容 /audio/speech）。返回 audio/mpeg data URL。
#[tauri::command]
pub async fn ai_tts(
    app: tauri::AppHandle,
    text: String,
    profile_id: Option<String>,
) -> Result<String, String> {
    tts_inner(&app, &text, profile_id.as_deref(), None).await
}

/// 语音合成实现体。`model_override` 供**媒体后端自带 TTS 模型名**时使用
/// （同 `generate_image_inner`：媒体后端清单里的 models.speech 早先被忽略）。
pub async fn tts_inner(
    app: &tauri::AppHandle,
    text: &str,
    profile_id: Option<&str>,
    model_override: Option<&str>,
) -> Result<String, String> {
    let config = ai_service::load_config(app);
    let cfg = ai_service::resolve_target(&config, profile_id);
    if cfg.api_key.trim().is_empty() {
        return Err("未配置 API Key".to_string());
    }
    // 同 `generate_image_inner`：应用级优先，且**不回落对话模型**（语音模型与对话模型
    // 是两回事，拿前者当后者必然失败）。
    let app_level = config.media_models.get("speech").map(str::to_string);
    let model = app_level
        .or_else(|| {
            model_override
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .or_else(|| {
            cfg.tts_model
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .ok_or_else(|| {
            "未配置语音模型：可在 设置 → 模型 → 媒体后端 的「语音能力链」里选一个".to_string()
        })?;

    let url = format!("{}/audio/speech", cfg.base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model,
        "input": text,
        "voice": "alloy",
        "response_format": "mp3",
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("创建请求客户端失败: {}", e))?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.api_key.trim()))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text.chars().take(300).collect::<String>()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取音频失败: {}", e))?;
    if bytes.is_empty() {
        return Err("语音合成为空".to_string());
    }
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:audio/mpeg;base64,{}", b64))
}

/// 内置 txt2img 的**默认负向提示词**。
///
/// 调用方不传（或传空白）时用它兜底。之所以要有默认值：负向词写不写、写什么，
/// 直接决定成图质量（SD 系在没有人像/质量词约束时会显著跑偏），
/// 而"忘了填"不该等于"没有负向提示"。
pub const DEFAULT_NEGATIVE_PROMPT: &str = "text, watermark, worst quality, low quality, blurry";

/// 决定内置流程用哪个 checkpoint。优先级：**显式指定 > 面板配置 > 自动（列表第一个）**。
///
/// - `explicit` —— 本次调用的显式指定（AI 通过 `generate_image.checkpoint` 给的）
/// - `configured` —— 设置页里配的（可为空 = 用户选了"自动"）
/// - `available` —— ComfyUI 里实际有哪些，**按 ComfyUI 给的顺序**
///
/// 空白一律当"没给"：前端把 `''` 传下来时不该被当成"一个名字为空的模型"。
///
/// ## 为什么"自动"是取第一个，而不是猜哪个"看起来像 SD 模型"
/// 名字启发式在本项目已经踩过坑（`caps_infer` 的经历：真实模型集合里名字线索经常全不成立）。
/// 顺序由 ComfyUI 决定（实测按名称排序），而且**设置页的下拉框会把列表列出来** ——
/// 自动挑的是哪个一眼可见，觉得不对点一下就能换。宁可"可预测但不一定最优"，
/// 也不要"猜错了还看不出来"。
pub fn resolve_checkpoint_choice(
    explicit: Option<&str>,
    configured: Option<&str>,
    available: &[String],
) -> Option<String> {
    for cand in [explicit, configured] {
        if let Some(v) = cand.map(str::trim).filter(|s| !s.is_empty()) {
            return Some(v.to_string());
        }
    }
    available.first().cloned()
}

/// 列 ComfyUI 的 checkpoint 文件名（走它自己的 `/models/checkpoints`）。
/// 失败返回空 —— 调用方据此给出"没有任何 checkpoint"的明确错误，而不是静默瞎猜。
async fn list_checkpoints(base: &str) -> Vec<String> {
    match comfyui_list_models(base.to_string(), Some("checkpoints".to_string())).await {
        Ok(v) => v
            .as_array()
            .map(|a| a.iter().filter_map(|x| x.as_str()).map(str::to_string).collect())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// 标准 SD1.5/SDXL 通用 txt2img 工作流（最小可用集，纯函数便于测试）。
///
/// `negative` 为 `None` 或空白 → 用 [`DEFAULT_NEGATIVE_PROMPT`]；给了就用给的
/// （**两个词都由调用方掌控**：设置页里用户能改，AI 侧也能通过工具参数改）。
///
/// ## ★ 槽位索引必须逐个核对（血案 2026-10-16）
///
/// ComfyUI 是**强类型图**：连线把「某个节点的第 N 个输出」接到「某个输入」，类型不匹配
/// 就直接 400，且报错在**服务端控制台**（`node_errors` 里只有一句
/// `Return type mismatch between linked nodes`），前端只看到 `Prompt outputs failed validation`。
///
/// 这里的 `["node", slot]` 全部写死，一旦槽位错位**测试若不逐个断言就抓不到**。
/// 本函数曾把两个 `CLIPTextEncode.clip` 都接到 `["1", 0]`（= **MODEL**），
/// 而正确值是 `["1", 1]`（= CLIP）——句柄 `vae` 用 `["1",2]` 是对的、`model` 用 `["1",0]`
/// 也是对的，**唯独 CLIP 那两处错**，所以从外部看"大部分连线都对"，很难怀疑到这里。
/// 症状：本地生图**永远 400**，ComfyUI 控制台打
/// `CLIPTextEncode: received_type(MODEL) mismatch input_type(CLIP)`。
///
/// ### 用到的输出槽位（改动本函数前请对照核验）
/// | 节点 | 输出 | 被谁引用 |
/// |---|---|---|
/// | CheckpointLoaderSimple | 0=MODEL / 1=CLIP / 2=VAE | `model`←0、两个 `clip`←**1**、`vae`←2 |
/// | CLIPTextEncode | 0=CONDITIONING | KSampler 的 `positive`/`negative` |
/// | EmptyLatentImage | 0=LATENT | KSampler 的 `latent_image` |
/// | KSampler | 0=LATENT | VAEDecode 的 `samples` |
/// | VAEDecode | 0=IMAGE | SaveImage 的 `images` |
pub fn build_default_txt2img(
    prompt: &str,
    negative: Option<&str>,
    ckpt: &str,
    seed: u64,
) -> serde_json::Value {
    let neg = negative
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_NEGATIVE_PROMPT);
    serde_json::json!({
        "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": ckpt } },
        "2": { "class_type": "CLIPTextEncode", "inputs": { "text": prompt, "clip": ["1", 1] } },
        "3": { "class_type": "CLIPTextEncode", "inputs": { "text": neg, "clip": ["1", 1] } },
        "4": { "class_type": "EmptyLatentImage", "inputs": { "width": 512, "height": 512, "batch_size": 1 } },
        "5": { "class_type": "KSampler", "inputs": {
            "seed": seed, "steps": 20, "cfg": 8.0,
            "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0,
            "model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["4", 0]
        } },
        "6": { "class_type": "VAEDecode", "inputs": { "samples": ["5", 0], "vae": ["1", 2] } },
        "7": { "class_type": "SaveImage", "inputs": { "images": ["6", 0], "filename_prefix": "andeyunhui" } }
    })
}

/// 解析 ComfyUI 有效基址：ComfyUI 每条路由同时挂在裸路径与 /api 前缀下，
/// 但 API-only 反向代理（如 comfy-api-proxy）只转发 /api/*，裸路径探测会 404。
/// 先试 {base}/system_stats，404 则试 {base}/api/system_stats，返回可用基址。
async fn resolve_comfy_base(client: &reqwest::Client, base: &str) -> Result<String, String> {
    for candidate in [base.to_string(), format!("{}/api", base)] {
        match client.get(format!("{}/system_stats", candidate)).send().await {
            Ok(resp) if resp.status().is_success() => return Ok(candidate),
            _ => continue,
        }
    }
    Err(format!("ComfyUI 不可达或非 ComfyUI 服务（{}）：system_stats 探测失败", base))
}

/// 一条 /history 产出里的媒体引用（图片 / 视频 / GIF / 音频）。
#[derive(Debug, Clone, PartialEq)]
pub struct MediaRef {
    /// 媒体种类（错误信息与日志用）：image / video / gif / audio
    pub kind: &'static str,
    pub filename: String,
    pub subfolder: String,
    /// ComfyUI 的 type 字段（output / input / temp）
    pub typ: String,
}

/// 从 history 条目的 outputs 里挑第一个媒体引用（纯函数，便于测试）。
/// 优先级 images > videos > gifs > audio：既有生图调用方行为不变（有图就返图）；
/// 纯视频 / 音频工作流（VHS_VideoCombine、TTS-Audio 等）也能取到结果。
/// 每个数组内取第一个非空 filename 的条目。
pub fn pick_first_media(outputs: &serde_json::Value) -> Option<MediaRef> {
    let outputs = outputs.as_object()?;
    for kind in ["images", "videos", "gifs", "audio"] {
        for out in outputs.values() {
            let arr = match out.get(kind).and_then(|v| v.as_array()) {
                Some(a) => a,
                None => continue,
            };
            for item in arr {
                let filename = item.get("filename").and_then(|v| v.as_str()).unwrap_or("");
                if filename.is_empty() {
                    continue;
                }
                let subfolder = item.get("subfolder").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let typ = item.get("type").and_then(|v| v.as_str()).unwrap_or("output").to_string();
                let label = match kind {
                    "images" => "image",
                    "videos" => "video",
                    "gifs" => "gif",
                    _ => "audio",
                };
                return Some(MediaRef { kind: label, filename: filename.to_string(), subfolder, typ });
            }
        }
    }
    None
}

/// 把 ComfyUI 的「提交被拒」响应整理成**可操作**的错误文本。
///
/// ## 为什么不能让调用方直接看原 body
///
/// ComfyUI 校验失败时返回 400，body 形状是：
/// ```json
/// { "error": { "type": "prompt_outputs_failed_validation",
///              "message": "Prompt outputs failed validation" },
///   "node_errors": { "2": { "class_type": "CLIPTextEncode",
///                           "errors": [ { "message": "Return type mismatch between linked nodes",
///                                         "details": "clip, received_type(MODEL) mismatch input_type(CLIP)" } ] } } }
/// ```
/// 真正能指导"该改哪一条连线"的信息全在 `node_errors.<id>.errors[].details` 里。
///
/// 而原先的实现是 `body.to_string().chars().take(300)` —— **把整个 body 序列化后砍到 300 字符**。
/// `error` 那一坨（type/message/details/extra_info）先占满预算，`node_errors` 恰好被砍在中间。
/// 实测症状（2026-10-16）：界面上只显示到 `"node_errors":{"2":{"class_type":"CLIP`，
/// 用户只能去翻 ComfyUI 服务端控制台，才看到真正的那句
/// `clip, received_type(MODEL) mismatch input_type(CLIP)`。
///
/// 所以这里**按结构提取**而不是按长度截断：先给结论，再逐节点列出原因（每节点最多 3 条、
/// 最多列 6 个节点，超出只报个数）。形状不认识时才回落到原文（放宽到 600 字符），
/// 保证不会比原来更差。
pub fn format_comfy_submit_error(body: &serde_json::Value, status: Option<u16>) -> String {
    let mut out = match status {
        Some(s) => format!("ComfyUI 提交失败 HTTP {}", s),
        None => "ComfyUI 拒绝了该工作流".to_string(),
    };
    let err = body.get("error");
    let msg = err.and_then(|e| e.get("message")).and_then(|v| v.as_str()).unwrap_or("");
    let kind = err.and_then(|e| e.get("type")).and_then(|v| v.as_str()).unwrap_or("");
    let headline = if !msg.is_empty() { msg } else { kind };
    if !headline.is_empty() {
        out.push_str(&format!("（{}）", headline));
    }

    let nodes = match body.get("node_errors").and_then(|v| v.as_object()) {
        Some(m) if !m.is_empty() => m,
        _ => {
            // 形状不认识（或压根没有 node_errors）→ 回落到原文。
            //
            // 但若上面已从 `error.message`/`error.type` 拿到可读结论，且 body 里**没有 error
            // 之外的字段**，就不再把整份 body 倒一遍 —— 那只是把同一句话贴两次。
            // 一旦存在 error 之外的字段（可能藏着额外线索），仍然完整附上，宁可啰嗦不可漏。
            let has_more = body
                .as_object()
                .map(|o| o.keys().any(|k| k != "error"))
                .unwrap_or(true);
            if headline.is_empty() || has_more {
                let raw = body.to_string();
                if raw.len() > 2 {
                    out.push_str(&format!("：{}", raw.chars().take(600).collect::<String>()));
                }
            }
            return out;
        }
    };

    // 节点 id 是数字字符串，按数值排更符合直觉（否则 "10" 会排在 "2" 前面）
    let mut ids: Vec<(&String, &serde_json::Value)> = nodes.iter().collect();
    ids.sort_by_key(|(id, _)| (id.parse::<u64>().unwrap_or(u64::MAX), (*id).clone()));

    let mut parts: Vec<String> = Vec::new();
    for (id, node) in ids.iter().take(6) {
        let ct = node.get("class_type").and_then(|v| v.as_str()).unwrap_or("?");
        let mut reasons: Vec<String> = Vec::new();
        if let Some(arr) = node.get("errors").and_then(|v| v.as_array()) {
            for e in arr.iter().take(3) {
                let m = e.get("message").and_then(|v| v.as_str()).unwrap_or("");
                let d = e.get("details").and_then(|v| v.as_str()).unwrap_or("");
                let s = match (m.is_empty(), d.is_empty()) {
                    (false, false) => format!("{}：{}", m, d),
                    (false, true) => m.to_string(),
                    (true, false) => d.to_string(),
                    (true, true) => continue,
                };
                reasons.push(s);
            }
        }
        // 少数版本把原因直接放在节点上，而不是 errors 数组里
        if reasons.is_empty() {
            if let Some(m) = node.get("message").and_then(|v| v.as_str()) {
                reasons.push(m.to_string());
            }
        }
        let detail = if reasons.is_empty() {
            "（无详情）".to_string()
        } else {
            reasons.join("；")
        };
        parts.push(format!("节点 {} {} — {}", id, ct, detail));
    }
    out.push_str(&format!("。{}", parts.join(" | ")));
    if ids.len() > 6 {
        out.push_str(&format!("（另有 {} 个节点报错）", ids.len() - 6));
    }
    out
}

/// 从 history 条目里提取可读的执行失败原因（status.messages 里的 exception_message）。
fn history_error_text(entry: &serde_json::Value) -> String {
    let mut details: Vec<String> = Vec::new();
    if let Some(msgs) = entry.pointer("/status/messages").and_then(|v| v.as_array()) {
        for m in msgs {
            if let Some(payload) = m.get(1) {
                if let Some(em) = payload.get("exception_message").and_then(|v| v.as_str()) {
                    details.push(em.chars().take(300).collect::<String>());
                } else if let Some(et) = payload.get("exception_type").and_then(|v| v.as_str()) {
                    details.push(et.to_string());
                }
            }
        }
    }
    if details.is_empty() {
        "unknown error".to_string()
    } else {
        details.join("; ")
    }
}

/// 把一张图片上传到 ComfyUI 的 `input/` 目录，返回可用于工作流 `LoadImage.image` 的文件名。
///
/// 这是**图生图 / 重绘 / ControlNet** 的前置条件：ComfyUI 的工作流按**文件名**引用输入图片，
/// 图片必须先落到它的 input 目录。此前只做文生图，正是缺这一步（`/upload/image` 从未被调用）。
///
/// ⚠️ 必须用**服务端返回的 name**，不能想当然用本地文件名：重名时 ComfyUI 会改名。
pub async fn comfyui_upload_image(
    base: &str,
    filename: &str,
    bytes: Vec<u8>,
    mime: &str,
) -> Result<String, String> {
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename.to_string())
        .mime_str(mime)
        .map_err(|e| format!("构造上传部件失败: {}", e))?;
    let form = reqwest::multipart::Form::new()
        .part("image", part)
        .text("type", "input")
        .text("overwrite", "true");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("创建上传客户端失败: {}", e))?;
    let resp = client
        .post(format!("{}/upload/image", base.trim_end_matches('/')))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("上传图片到 ComfyUI 失败（{}）: {}", base, e))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "ComfyUI 上传图片 HTTP {}: {}",
            status,
            body.chars().take(300).collect::<String>()
        ));
    }
    let v: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("解析上传响应失败: {}；原文：{}", e, body.chars().take(200).collect::<String>()))?;
    let name = v
        .get("name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() {
        return Err("ComfyUI 上传成功但未返回文件名".to_string());
    }
    // 有 subfolder 时工作流里要写相对 input 的完整路径
    let sub = v.get("subfolder").and_then(|x| x.as_str()).unwrap_or("").trim();
    Ok(if sub.is_empty() { name } else { format!("{}/{}", sub, name) })
}

/// 中断 ComfyUI 当前正在执行的工作流（`POST /interrupt`）。
///
/// 此前生成一旦提交就只能干等（轮询上限 5 分钟），用户点错了也没有退路。
#[tauri::command]
pub async fn comfyui_interrupt(comfyui_url: String) -> Result<(), String> {
    let base = comfyui_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err("未配置 ComfyUI 地址".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("创建请求客户端失败: {}", e))?;
    let base = resolve_comfy_base(&client, &base).await?;
    let resp = client
        .post(format!("{}/interrupt", base))
        .send()
        .await
        .map_err(|e| format!("ComfyUI 不可达（{}）: {}", base, e))?;
    if !resp.status().is_success() {
        return Err(format!("中断 ComfyUI 执行 HTTP {}", resp.status()));
    }
    Ok(())
}

/// 列出 ComfyUI 已安装的模型文件（`GET /models`，或 `GET /models/{folder}` 只列某类）。
///
/// 这是「AI 自建工作流」的**事实来源**之一：`CheckpointLoaderSimple.ckpt_name` 这类字段
/// 只能填这里真实存在的文件名（通常还有子目录前缀）。让模型凭空编，只会换来一次失败执行。
#[tauri::command]
pub async fn comfyui_list_models(
    comfyui_url: String,
    folder: Option<String>,
) -> Result<serde_json::Value, String> {
    let base = comfyui_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err("未配置 ComfyUI 地址".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建请求客户端失败: {}", e))?;
    let base = resolve_comfy_base(&client, &base).await?;
    let path = match folder.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(f) => format!("{}/models/{}", base, f),
        None => format!("{}/models", base),
    };
    let resp = client
        .get(&path)
        .send()
        .await
        .map_err(|e| format!("ComfyUI 不可达（{}）: {}", base, e))?;
    if !resp.status().is_success() {
        return Err(format!("获取 ComfyUI 模型清单 HTTP {}", resp.status()));
    }
    resp.json().await.map_err(|e| format!("解析 ComfyUI 模型清单失败: {}", e))
}

// （`comfyui_custom_nodes` 已删除：它是"列出自定义节点包"的对外命令，但
//  前端早已改用 `/object_info` 自己归纳（`core/ai/media/customNodes.ts` 的
//  `customModulesOf`），Rust 侧也没有任何内部调用者 —— 是一条彻底的死命令。
//  2026-10-15 前后端审查查出，连同 tauri 注册一并移除。）


/// 提交 API 工作流 → 轮询 /history 出媒体 → 从 /view 取字节 → 媒体 data URL（image/video/gif/audio）。
/// 本地 SD 出图可能数十秒~数分钟，轮询上限 5 分钟；执行失败（status=error）立即返回，不空等。
async fn run_comfy_workflow(
    client: &reqwest::Client,
    base: &str,
    workflow: &serde_json::Value,
) -> Result<String, String> {
    // 1) 提交工作流
    let submit_resp = client
        .post(format!("{}/prompt", base))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "prompt": workflow, "client_id": "andeyunhui" }))
        .send()
        .await
        .map_err(|e| format!("ComfyUI 不可达（{}）: {}", base, e))?;
    let submit_status = submit_resp.status();
    let submit_body: serde_json::Value = submit_resp
        .json()
        .await
        .map_err(|e| format!("解析 ComfyUI 提交响应失败: {}", e))?;
    if !submit_status.is_success() {
        // 按结构提取（而不是把整个 body 砍 300 字符）—— 见 format_comfy_submit_error 的文档：
        // 后者会把真正可操作的 `node_errors.<id>.errors[].details` 恰好砍掉。
        return Err(format_comfy_submit_error(&submit_body, Some(submit_status.as_u16())));
    }
    if let Some(errs) = submit_body.get("node_errors").and_then(|v| v.as_object()) {
        if !errs.is_empty() {
            // 少数实现即使 2xx 也带 node_errors（校验没过但没改状态码）
            return Err(format_comfy_submit_error(&submit_body, None));
        }
    }
    let prompt_id = submit_body
        .get("prompt_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "ComfyUI 提交响应缺少 prompt_id".to_string())?
        .to_string();

    // 2) 轮询 /history/{prompt_id} 直到产出媒体
    let mut media_ref: Option<MediaRef> = None;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
    loop {
        if std::time::Instant::now() > deadline {
            return Err("ComfyUI 生成超时（5 分钟）".to_string());
        }
        let hist: serde_json::Value = client
            .get(format!("{}/history/{}", base, prompt_id))
            .send()
            .await
            .map_err(|e| format!("查询 ComfyUI 历史失败: {}", e))?
            .json()
            .await
            .map_err(|e| format!("解析 ComfyUI 历史失败: {}", e))?;
        // history["<prompt_id>"].outputs.<node>.{images,videos,gifs,audio}[0]
        if let Some(entry) = hist.get(&prompt_id) {
            // 执行失败快速返回（不空等到超时）
            let status_str = entry.pointer("/status/status_str").and_then(|v| v.as_str()).unwrap_or("");
            if status_str == "error" {
                return Err(format!("ComfyUI 执行失败: {}", history_error_text(entry)));
            }
            if let Some(outputs) = entry.get("outputs") {
                if let Some(m) = pick_first_media(outputs) {
                    media_ref = Some(m);
                }
            }
        }
        if media_ref.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    }

    let media = media_ref.ok_or_else(|| "ComfyUI 未返回媒体（图片/视频/音频）".to_string())?;
    // 3) 取媒体字节 → data URL（content-type 缺省按 png）
    let media_resp = client
        .get(format!("{}/view", base))
        .query(&[("filename", media.filename.as_str()), ("subfolder", media.subfolder.as_str()), ("type", media.typ.as_str())])
        .send()
        .await
        .map_err(|e| format!("获取 ComfyUI 媒体失败: {}", e))?;
    if !media_resp.status().is_success() {
        return Err(format!("获取 ComfyUI 媒体 HTTP {}", media_resp.status()));
    }
    let content_type = media_resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    let bytes = media_resp.bytes().await.map_err(|e| format!("读取 ComfyUI 媒体失败: {}", e))?;
    if bytes.is_empty() {
        return Err("ComfyUI 媒体为空".to_string());
    }
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", content_type, b64))
}

/// ComfyUI 本地媒体生成（程序化接入）——与 ai_generate_image（OpenAI 兼容云端）并列的另一条生图后端。
/// 两种用法：
///   ① 传 prompt + checkpoint：走内置最小 txt2img 工作流（build_default_txt2img）；
///   ② 传 workflow（API 格式 JSON，前端已用 applyWorkflowParameters 应用参数覆盖）：直接提交，
///      复用用户在 ComfyUI 里调好的工作流（ControlNet/LoRA/精细流程均可）。
/// comfyui_url 形如 http://127.0.0.1:8188；checkpoint 为 ComfyUI models/checkpoints 下的模型文件名。
/// 轮询上限 5 分钟；执行失败（status=error）立即返回。返回首个媒体输出的 data URL
/// （图片/视频/GIF/音频均可，content-type 取自 /view 响应；有图优先返图）。
///
/// `negative_prompt` 只对**用法①（内置最小 txt2img）**生效：留空用
/// [`DEFAULT_NEGATIVE_PROMPT`]。用法②（调用方提交完整工作流）里正负提示词都在工作流内，
/// 由调用方自己写（AI 自建工作流就是自己写 CLIPTextEncode 节点）。
#[tauri::command]
pub async fn comfyui_generate_media(
    prompt: Option<String>,
    comfyui_url: String,
    checkpoint: Option<String>,
    workflow: Option<serde_json::Value>,
    negative_prompt: Option<String>,
) -> Result<String, String> {
    let base = comfyui_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err("未配置 ComfyUI 地址".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建请求客户端失败: {}", e))?;
    let base = resolve_comfy_base(&client, &base).await?;

    // 用法②：调用方提交完整工作流（优先）
    if let Some(wf) = workflow {
        let obj = wf
            .as_object()
            .filter(|o| !o.is_empty())
            .ok_or_else(|| "workflow 必须是非空 JSON 对象".to_string())?;
        // 每个节点都应是 { class_type, inputs } 形状
        for (id, node) in obj {
            let ok = node.get("class_type").and_then(|v| v.as_str()).is_some()
                && node.get("inputs").and_then(|v| v.as_object()).is_some();
            if !ok {
                return Err(format!("workflow 节点 {} 缺少 class_type/inputs", id));
            }
        }
        return run_comfy_workflow(&client, &base, &wf).await;
    }

    // 用法①：内置最小 txt2img
    //
    // checkpoint 的优先级：**显式指定 > 面板配置 > 自动（列表第一个）**。
    // 前端负责前两级（把"面板配置"作为显式值传下来，AI 的显式指定又会覆盖它），
    // 传空就落到这里走自动 —— 这样"空白则自动选择"在两条路径上口径一致。
    let ckpt = match checkpoint.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string) {
        Some(c) => c,
        None => {
            let available = list_checkpoints(&base).await;
            resolve_checkpoint_choice(None, None, &available).ok_or_else(|| {
                "ComfyUI 里没有任何 checkpoint 模型，无法用内置流程生成。\
                 请在 ComfyUI 的 models/checkpoints 里放一个模型（或在设置里指定一个）。"
                    .to_string()
            })?
        }
    };
    let prompt = prompt.unwrap_or_default().trim().to_string();
    if prompt.is_empty() {
        return Err("画图提示词为空".to_string());
    }
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let wf = build_default_txt2img(&prompt, negative_prompt.as_deref(), &ckpt, seed);
    run_comfy_workflow(&client, &base, &wf).await
}

/// ComfyUI 节点定义（/object_info）——前端 convertGraphToApi 需要它把 UI 图转成 API 工作流。
/// 完整 object_info 可能有数 MB（自定义节点越多越大），按需拉取、经 Rust 中转（避开 WebView 直连的 CORS）。
#[tauri::command]
pub async fn comfyui_object_info(comfyui_url: String) -> Result<serde_json::Value, String> {
    let base = comfyui_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err("未配置 ComfyUI 地址".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("创建请求客户端失败: {}", e))?;
    let base = resolve_comfy_base(&client, &base).await?;
    let resp = client
        .get(format!("{}/object_info", base))
        .send()
        .await
        .map_err(|e| format!("ComfyUI 不可达（{}）: {}", base, e))?;
    if !resp.status().is_success() {
        return Err(format!("获取 ComfyUI object_info HTTP {}", resp.status()));
    }
    resp.json().await.map_err(|e| format!("解析 ComfyUI object_info 失败: {}", e))
}

/// 一个 ComfyUI 工作流文件（UI 图或已转好的 API 工作流，均为 .json）。
#[derive(serde::Serialize, Clone)]
pub struct ComfyWorkflowFile {
    /// 文件名（不含 .json）
    pub name: String,
    /// 完整路径
    pub path: String,
    /// 相对扫描目录的路径（子目录组织时保留层级，分隔符统一为 /）
    pub relative: String,
    /// 字节数
    pub size: u64,
    /// 修改时间（unix 秒）
    pub modified_at: u64,
}

/// 扫描目录下的 ComfyUI 工作流文件（*.json）：递归子目录（深度≤4）、跳过隐藏项、上限 500 个，
/// 按修改时间倒序（新的在前）。ComfyUI 端保存的工作流一般在
/// <ComfyUI>/user/default/workflows（新）或 <ComfyUI>/userdata/workflows（旧）。
pub fn scan_workflows_sync(dir: &str) -> Result<Vec<ComfyWorkflowFile>, String> {
    let root = std::path::PathBuf::from(dir.trim());
    if root.as_os_str().is_empty() {
        return Err("未配置 ComfyUI 工作流目录".to_string());
    }
    if !root.exists() {
        return Err(format!("目录不存在: {}", root.display()));
    }
    if !root.is_dir() {
        return Err(format!("不是目录: {}", root.display()));
    }
    let mut out: Vec<ComfyWorkflowFile> = Vec::new();
    walk_workflow_dir(&root, &root, 0, &mut out);
    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at).then(a.relative.cmp(&b.relative)));
    Ok(out)
}

fn walk_workflow_dir(root: &std::path::Path, dir: &std::path::Path, depth: usize, out: &mut Vec<ComfyWorkflowFile>) {
    if depth > 4 || out.len() >= 500 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            walk_workflow_dir(root, &path, depth + 1, out);
            continue;
        }
        let is_json = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("json"))
            .unwrap_or(false);
        if !is_json {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified_at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| name.clone());
        out.push(ComfyWorkflowFile {
            name: stem,
            path: path.to_string_lossy().to_string(),
            relative,
            size: meta.len(),
            modified_at,
        });
    }
}

/// 扫描 ComfyUI 工作流目录（Tauri 命令壳，逻辑在 scan_workflows_sync）。
#[tauri::command]
pub async fn comfyui_scan_workflows(dir: String) -> Result<Vec<ComfyWorkflowFile>, String> {
    scan_workflows_sync(&dir)
}

/// 读取并解析一个工作流文件（JSON）。上限 8MB——UI 图内嵌缩略图元数据时可能较大。
#[tauri::command]
pub async fn comfyui_read_workflow(path: String) -> Result<serde_json::Value, String> {
    let p = std::path::PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return Err("路径为空".to_string());
    }
    let meta = std::fs::metadata(&p).map_err(|e| format!("读取文件信息失败: {}", e))?;
    if meta.len() > 8 * 1024 * 1024 {
        return Err("工作流文件过大（>8MB）".to_string());
    }
    let text = std::fs::read_to_string(&p).map_err(|e| format!("读取文件失败: {}", e))?;
    serde_json::from_str(&text).map_err(|e| format!("解析工作流 JSON 失败: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_txt2img_shape() {
        let wf = build_default_txt2img("a cat", None, "sd_xl_base.safetensors", 42);
        let obj = wf.as_object().unwrap();
        assert_eq!(obj.len(), 7);
        assert_eq!(obj["1"]["class_type"], "CheckpointLoaderSimple");
        assert_eq!(obj["1"]["inputs"]["ckpt_name"], "sd_xl_base.safetensors");
        assert_eq!(obj["2"]["class_type"], "CLIPTextEncode");
        assert_eq!(obj["2"]["inputs"]["text"], "a cat");
        assert_eq!(obj["5"]["inputs"]["seed"], 42);
        assert_eq!(obj["7"]["class_type"], "SaveImage");
        // 负向提示词固定兜底
        assert!(obj["3"]["inputs"]["text"].as_str().unwrap().contains("worst quality"));
    }

    /// ★ 逐条断言**所有连线的槽位** —— 这一条才是本地生图那个 400 的回归网。
    ///
    /// ComfyUI 是**强类型图**：把某节点的错误输出槽接到某个输入，只会得到服务端一句
    /// `Return type mismatch between linked nodes: clip, received_type(MODEL) mismatch
    /// input_type(CLIP)`，而前端拿到的 `error` 里**没有**指向具体槽位的信息
    /// （只有 `node_errors` 里一句 `class_type`）。所以槽位错位**极难从报错反推**。
    ///
    /// 而"只断言其中几条"正是本函数曾经的漏洞来源：`vae` 与 `model` 被断言过，
    /// 唯独两个 `clip` 漏了 —— 它们一直写着 `["1", 0]`（= **MODEL**），正确值 `["1", 1]`（= CLIP），
    /// 于是**本地生图每次都 400**，且外部看起来"大部分连线都对"，不会怀疑到这里。
    ///
    /// ⇒ 结论：**这类连线的测试必须逐条覆盖，不能只挑几条**。所以本用例把每条链接都钉死，
    /// 并额外校验"被引用的节点 id 真实存在"。
    #[test]
    fn default_txt2img_all_link_slots_are_type_correct() {
        let wf = build_default_txt2img("p", None, "ckpt.safetensors", 1);
        let link = |node: &str, input: &str| wf[node]["inputs"][input].clone();

        // CheckpointLoaderSimple 输出 0=MODEL / 1=CLIP / 2=VAE
        assert_eq!(
            link("2", "clip"),
            serde_json::json!(["1", 1]),
            "正向 CLIPTextEncode.clip 必须接 CLIP(槽1)，接 MODEL(槽0) 会被 ComfyUI 拒为 400"
        );
        assert_eq!(
            link("3", "clip"),
            serde_json::json!(["1", 1]),
            "负向 CLIPTextEncode.clip 同上"
        );
        assert_eq!(link("5", "model"), serde_json::json!(["1", 0]), "KSampler.model ← MODEL(槽0)");
        assert_eq!(link("6", "vae"), serde_json::json!(["1", 2]), "VAEDecode.vae ← VAE(槽2)");

        // 其余连线都取单输出节点的槽 0
        assert_eq!(link("5", "positive"), serde_json::json!(["2", 0]), "← CLIPTextEncode 的 CONDITIONING");
        assert_eq!(link("5", "negative"), serde_json::json!(["3", 0]));
        assert_eq!(link("5", "latent_image"), serde_json::json!(["4", 0]), "← EmptyLatentImage");
        assert_eq!(link("6", "samples"), serde_json::json!(["5", 0]), "← KSampler");
        assert_eq!(link("7", "images"), serde_json::json!(["6", 0]), "← VAEDecode");

        // 被引用的节点必须真实存在（防"引用了不存在的 id"，那同样是整单被拒）
        for id in ["1", "2", "3", "4", "5", "6", "7"] {
            assert!(wf.get(id).is_some(), "节点 {id} 缺失");
        }
    }

    #[test]
    fn scan_workflows_finds_json_recursively_and_skips_hidden() {
        let base = std::env::temp_dir().join(format!("ady_wf_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("sub")).unwrap();
        std::fs::write(base.join("a.json"), "{}").unwrap();
        std::fs::write(base.join("sub/b.json"), "{}").unwrap();
        std::fs::write(base.join("note.txt"), "x").unwrap();
        std::fs::write(base.join(".hidden.json"), "{}").unwrap();
        let files = scan_workflows_sync(&base.to_string_lossy()).unwrap();
        let mut relatives: Vec<String> = files.iter().map(|f| f.relative.clone()).collect();
        relatives.sort();
        assert_eq!(relatives, vec!["a.json".to_string(), "sub/b.json".to_string()]);
        assert_eq!(files.iter().find(|f| f.relative == "a.json").unwrap().name, "a");
        // 错误路径明确报错
        assert!(scan_workflows_sync(&base.join("nope").to_string_lossy()).is_err());
        assert!(scan_workflows_sync("").is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn pick_first_media_priority_and_shapes() {
        let img = |name: &str| serde_json::json!({ "filename": name, "subfolder": "", "type": "output" });
        // 只有图片
        let out = serde_json::json!({ "7": { "images": [img("a.png")] } });
        let m = pick_first_media(&out).unwrap();
        assert_eq!(m.kind, "image");
        assert_eq!(m.filename, "a.png");
        assert_eq!(m.typ, "output");
        // 图 + 视频同在 → 图优先（既有生图调用方行为不变）
        let out = serde_json::json!({
            "9": { "videos": [{ "filename": "v.mp4", "subfolder": "sub", "type": "output" }] },
            "7": { "images": [img("a.png")] },
        });
        let m = pick_first_media(&out).unwrap();
        assert_eq!(m.kind, "image");
        // 纯视频
        let out = serde_json::json!({ "9": { "videos": [{ "filename": "v.mp4", "subfolder": "s", "type": "temp" }] } });
        let m = pick_first_media(&out).unwrap();
        assert_eq!(m.kind, "video");
        assert_eq!(m.subfolder, "s");
        assert_eq!(m.typ, "temp");
        // GIF 与音频
        let out = serde_json::json!({ "1": { "gifs": [img("a.webp")] } });
        assert_eq!(pick_first_media(&out).unwrap().kind, "gif");
        let out = serde_json::json!({ "1": { "audio": [img("a.mp3")] } });
        assert_eq!(pick_first_media(&out).unwrap().kind, "audio");
        // 空 filename 跳过；完全没有媒体 → None
        let out = serde_json::json!({ "1": { "images": [{ "filename": "" }] } });
        assert!(pick_first_media(&out).is_none());
        assert!(pick_first_media(&serde_json::json!({})).is_none());
        assert!(pick_first_media(&serde_json::json!({ "1": { "text": ["x"] } })).is_none());
    }

    /// ★ 提交被拒时，**必须把 node_errors 里的 details 原样吐出来**。
    ///
    /// 这条用**用户实测的真实 body**（2026-10-16，本地生图 400）写。
    /// 原实现是 `body.to_string().chars().take(300)`：`error` 那坨先占满预算，
    /// `node_errors` 恰好被砍在 `"class_type":"CLIP` 处 —— 用户只能去翻 ComfyUI
    /// 服务端控制台才看到 `clip, received_type(MODEL) mismatch input_type(CLIP)`。
    /// 而那句话才是「该改哪条连线」的唯一线索。
    #[test]
    fn 提交错误_提取节点详情而不是截断原body() {
        let body = serde_json::json!({
            "error": {
                "details": "", "extra_info": {},
                "message": "Prompt outputs failed validation",
                "type": "prompt_outputs_failed_validation"
            },
            "node_errors": {
                "2": { "class_type": "CLIPTextEncode", "errors": [{
                    "type": "return_type_mismatch",
                    "message": "Return type mismatch between linked nodes",
                    "details": "clip, received_type(MODEL) mismatch input_type(CLIP)"
                }]},
                "3": { "class_type": "CLIPTextEncode", "errors": [{
                    "type": "return_type_mismatch",
                    "message": "Return type mismatch between linked nodes",
                    "details": "clip, received_type(MODEL) mismatch input_type(CLIP)"
                }]}
            }
        });
        let s = format_comfy_submit_error(&body, Some(400));
        assert!(s.contains("HTTP 400"), "应带状态码：{s}");
        assert!(s.contains("Prompt outputs failed validation"), "应带结论：{s}");
        assert!(s.contains("节点 2 CLIPTextEncode"), "应指出是哪个节点：{s}");
        assert!(s.contains("节点 3 CLIPTextEncode"), "两个节点都要列：{s}");
        // 这一句是原实现被砍掉的关键信息，必须完整保留（且两处都出现）
        assert_eq!(
            s.matches("clip, received_type(MODEL) mismatch input_type(CLIP)").count(),
            2,
            "details 必须原样保留且不被截断：{s}"
        );
        // 不该把原始 body 倒出来（那正是旧实现的问题：预算被无关字段吃掉）
        assert!(!s.contains("extra_info"), "不应回吐原始 body 字段：{s}");
    }

    #[test]
    fn 提交错误_无节点错误时回落原文() {
        // 形状不认识（例如网关返回的 `{"error":"bad gateway"}`）→ 至少不能比原来更差
        let s = format_comfy_submit_error(&serde_json::json!({ "error": "bad gateway" }), Some(502));
        assert!(s.contains("HTTP 502"));
        assert!(s.contains("bad gateway"), "回落到原文：{s}");
    }

    /// 正负两个词都**由调用方掌控**（设置页里用户改、AI 侧通过工具参数改），
    /// 但"没传"不能等于"没有负向提示" —— SD 系在缺质量词约束时会明显跑偏。
    /// 所以这里是三态：给了就用给的、空白回落到默认、默认必须非空。
    #[test]
    fn 正负提示词都由调用方决定_留空才用默认() {
        // 给了就用给的，并落到**各自**的节点（2=正向 / 3=负向）
        let wf = build_default_txt2img("a red cat", Some("blurry, lowres"), "c.safetensors", 1);
        assert_eq!(wf["2"]["inputs"]["text"], "a red cat", "正向应落节点 2");
        assert_eq!(wf["3"]["inputs"]["text"], "blurry, lowres", "负向应落节点 3");

        // 不传 / 传空白 → 内置默认（且默认本身非空，别退化成"没有负向提示"）
        assert!(!DEFAULT_NEGATIVE_PROMPT.trim().is_empty());
        for empty in [None, Some(""), Some("   ")] {
            let wf = build_default_txt2img("x", empty, "c.safetensors", 1);
            assert_eq!(wf["3"]["inputs"]["text"], DEFAULT_NEGATIVE_PROMPT);
        }

        // 两侧都 trim（用户/模型常见尾随空白）
        let wf = build_default_txt2img("  x  ", Some("  ugly  "), "c.safetensors", 1);
        assert_eq!(wf["2"]["inputs"]["text"], "  x  ", "正向原样保留（不擅自 trim 用户正文）");
        assert_eq!(wf["3"]["inputs"]["text"], "ugly");
    }

    /// checkpoint 的优先级：**显式指定 > 面板配置 > 自动（列表第一个）**。
    /// 这条是用户明确点名的语义（"填入的是指定使用；给 AI 下达确切模型时可以绕过；
    /// 未指定时用配置的那个"），所以逐档钉住。
    #[test]
    fn checkpoint_优先级与自动选择() {
        let avail = vec!["a.safetensors".to_string(), "b.safetensors".to_string()];

        // 显式（AI 指定 / 本次调用）压过配置
        assert_eq!(
            resolve_checkpoint_choice(Some("x.safetensors"), Some("y.safetensors"), &avail).unwrap(),
            "x.safetensors"
        );
        // 没有显式 → 用配置
        assert_eq!(
            resolve_checkpoint_choice(None, Some("y.safetensors"), &avail).unwrap(),
            "y.safetensors"
        );
        // 都没有 → 自动取列表第一个
        assert_eq!(resolve_checkpoint_choice(None, None, &avail).unwrap(), "a.safetensors");
        // 空白一律当"没给"（前端常把 '' 传下来）——否则会变成"一个名字为空的模型"
        assert_eq!(resolve_checkpoint_choice(Some("   "), Some(""), &avail).unwrap(), "a.safetensors");
        // 两侧 trim
        assert_eq!(resolve_checkpoint_choice(Some(" x.safetensors "), None, &avail).unwrap(), "x.safetensors");
        // 一个都没有 → None：调用方据此报出明确错误，而不是静默瞎猜
        assert!(resolve_checkpoint_choice(None, None, &[]).is_none());
    }

    #[test]
    fn 提交错误_空body不产生多余尾巴() {
        // 空对象不该拼出「：{}」这种噪音
        assert_eq!(format_comfy_submit_error(&serde_json::json!({}), Some(400)), "ComfyUI 提交失败 HTTP 400");
        // 非 2xx 且无 node_errors → 给结论但不宣称是"节点错误"
        let s = format_comfy_submit_error(&serde_json::json!({ "error": { "message": "boom" } }), None);
        assert_eq!(s, "ComfyUI 拒绝了该工作流（boom）");
    }
}
