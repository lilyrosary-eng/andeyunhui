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

/// 标准 SD1.5/SDXL 通用 txt2img 工作流（最小可用集，纯函数便于测试）。
/// CheckpointLoaderSimple 输出 [MODEL, CLIP, VAE]，索引分别 0/1/2，故 vae 取 ["1",2]。
pub fn build_default_txt2img(prompt: &str, ckpt: &str, seed: u64) -> serde_json::Value {
    serde_json::json!({
        "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": ckpt } },
        "2": { "class_type": "CLIPTextEncode", "inputs": { "text": prompt, "clip": ["1", 0] } },
        "3": { "class_type": "CLIPTextEncode", "inputs": { "text": "text, watermark, worst quality, low quality, blurry", "clip": ["1", 0] } },
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
        return Err(format!(
            "ComfyUI 提交失败 HTTP {}: {}",
            submit_status,
            submit_body.to_string().chars().take(300).collect::<String>()
        ));
    }
    if let Some(errs) = submit_body.get("node_errors").and_then(|v| v.as_object()) {
        if !errs.is_empty() {
            return Err(format!(
                "ComfyUI 工作流节点错误: {}",
                submit_body["node_errors"].to_string().chars().take(300).collect::<String>()
            ));
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
#[tauri::command]
pub async fn comfyui_generate_media(
    prompt: Option<String>,
    comfyui_url: String,
    checkpoint: Option<String>,
    workflow: Option<serde_json::Value>,
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
    let ckpt = checkpoint.unwrap_or_default().trim().to_string();
    if ckpt.is_empty() {
        return Err("未配置 ComfyUI 模型（checkpoint 文件名）".to_string());
    }
    let prompt = prompt.unwrap_or_default().trim().to_string();
    if prompt.is_empty() {
        return Err("画图提示词为空".to_string());
    }
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let wf = build_default_txt2img(&prompt, &ckpt, seed);
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
        let wf = build_default_txt2img("a cat", "sd_xl_base.safetensors", 42);
        let obj = wf.as_object().unwrap();
        assert_eq!(obj.len(), 7);
        assert_eq!(obj["1"]["class_type"], "CheckpointLoaderSimple");
        assert_eq!(obj["1"]["inputs"]["ckpt_name"], "sd_xl_base.safetensors");
        assert_eq!(obj["2"]["class_type"], "CLIPTextEncode");
        assert_eq!(obj["2"]["inputs"]["text"], "a cat");
        // CheckpointLoaderSimple 输出 [MODEL, CLIP, VAE] → vae 引 ["1",2]
        assert_eq!(obj["6"]["inputs"]["vae"], serde_json::json!(["1", 2]));
        assert_eq!(obj["5"]["inputs"]["seed"], 42);
        assert_eq!(obj["7"]["class_type"], "SaveImage");
        // 负向提示词固定兜底
        assert!(obj["3"]["inputs"]["text"].as_str().unwrap().contains("worst quality"));
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
}
