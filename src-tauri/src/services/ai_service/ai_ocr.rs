
// 全局 AI 服务 · 子模块：OCR / 翻译（OCR）
// （由 ai_service.rs 机械拆分而来，逻辑零改动）

use base64::Engine;
use image::GenericImageView;
use tauri::AppHandle;
use crate::services::ai_service::ai_profile::{AiProfile, AiConfig, ResolvedTarget, find_provider_of_model, load_config, resolve_target};

/// 测试 AI 配置是否可用：向端点发起一次极小开销的非流式请求，
/// 校验 base_url / api_key / model 是否正确，并返回耗时。不消耗对话额度（max_tokens=5）。
#[tauri::command]
pub async fn ai_test_connection(config: AiProfile) -> Result<String, String> {
    if config.api_key.trim().is_empty() {
        return Err("未填写 API Key，无法测试连接".to_string());
    }
    if config.base_url.trim().is_empty() {
        return Err("未填写 API 端点（Base URL）".to_string());
    }
    if config.model.trim().is_empty() {
        return Err("未填写模型名称".to_string());
    }

    let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": config.model,
        "messages": [{ "role": "user", "content": "ping" }],
        "temperature": 0.0,
        "max_tokens": 5,
        "stream": false,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("创建请求客户端失败: {}", e))?;

    let start = std::time::Instant::now();
    let resp = match client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key.trim()))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return Err(format!("请求失败（端点不可达）: {}", e)),
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text.chars().take(300).collect::<String>()));
    }
    // 消费响应体，避免连接复用告警
    let _ = resp.text().await;
    let ms = start.elapsed().as_millis();
    Ok(format!("连接成功（{}，耗时 {} ms）", config.model, ms))
}

// ========== 视觉 OCR + 翻译（非流式便捷命令） ==========
//
// 设计：
// - 复用 ai_config.json 中的模型档案（profile_id 选某份，None 用激活项）
// - 非流式（stream:false）：OCR / 翻译不需要逐字呈现，直接返回完整结果
// - 视觉 OCR：构造 OpenAI Vision 协议的 content 数组（image_url + text）
//   兼容 OpenAI gpt-4o / Anthropic claude-3-opus / 通义 qwen-vl / gemini-2.x 等
// - 翻译：构造 system + user 单轮对话，提示模型只返回译文
// - 失败时返回详细错误信息（含 HTTP 状态码 + 响应体片段），前端直接展示

/// 视觉问答（OpenAI Vision 协议）。`ai_vision_ocr` 命令与 Agent 工具 `analyze_image` 共用。
///
/// overrides（model / base_url / api_key）供「媒体后端自带凭证」时使用：那种后端没有
/// 挂到任何模型档案上，`resolve_target` 找不到它的端点与密钥，必须显式传入。
#[tauri::command]
pub async fn ai_vision_ocr(
    app: AppHandle,
    image_base64: String,
    image_mime: String,
    prompt: Option<String>,
    profile_id: Option<String>,
) -> Result<String, String> {
    vision_ask(&app, &image_base64, &image_mime, prompt.as_deref(), profile_id.as_deref(), None, None, None).await
}

/// 视觉模型的解析顺序 —— **两条调用链共用这一处**，不再各写一份。
///
/// 背景：以前「图片理解」有两套并行解析，各自服务一条链路：
///   - `ai_vision_ocr`（独立命令，桌面发图 / 移动端 / 插件）读**供应商三件套**；
///   - `analyze_image`（agent 工具）读**媒体后端能力链**（配置存在浏览器本地库，
///     插件与移动端读不到）。
/// 于是同一个概念要配两遍，且只有桌面能用上后者。用户要求「一处配置」。
///
/// 现在的顺序：
///   1. 显式覆盖（agent 工具传入的媒体后端模型名）—— 保留，它就是"本次指定用谁"
///   2. **应用级媒体模型**（AI 页「媒体模型」里那一处）—— 用户要的"一处"
///   3. 供应商三件套的视觉模型 —— 兼容改造前的配置，**不退化**
///   4. 对话模型 —— 最后回落（多模态模型时代这是合理的默认）
fn resolve_vision_model(config: &AiConfig, cfg: &ResolvedTarget, explicit: Option<&str>) -> String {
    explicit
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| config.media_models.get("vision").map(str::to_string))
        .or_else(|| cfg.vision_model.clone().filter(|s| !s.trim().is_empty()))
        .unwrap_or_else(|| cfg.model.clone())
}

/// 视觉问答的实现体。见 `ai_vision_ocr` 的文档。
#[allow(clippy::too_many_arguments)]
pub async fn vision_ask(
    app: &AppHandle,
    image_base64: &str,
    image_mime: &str,
    prompt: Option<&str>,
    profile_id: Option<&str>,
    model: Option<&str>,
    base_url: Option<&str>,
    api_key: Option<&str>,
) -> Result<String, String> {
    let config = load_config(app);
    let cfg = resolve_target(&config, profile_id);
    // 端点与凭证：显式覆盖 > **按应用级视觉模型名自动归属的供应商** > 当前档案。
    //
    // 中间这一层解决的是：「对话用 A 家、看图用 B 家的模型」时，B 的模型名会被
    // 发到 A 的端点 —— 必然失败，而且失败形态看起来像「该模型不支持图片」
    // （端点不认识这个模型名），排查方向会被带偏。用户既然在配置里加过这个模型，
    // 系统就知道它在哪家，不必让他再配一次端点（那又退回"多处配置"）。
    //
    // 只在没有显式覆盖时才启用，避免抢掉调用方（agent 工具）的明确指定。
    let owner = if api_key.is_none() && base_url.is_none() {
        config
            .media_models
            .get("vision")
            .and_then(|m| find_provider_of_model(&config, m))
    } else {
        None
    };
    // 端点 / 密钥：显式覆盖优先，其次自动归属的供应商，最后用解析出的档案值
    let key = api_key
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| owner.map(|p| p.api_key.trim().to_string()).filter(|s| !s.is_empty()))
        .unwrap_or_else(|| cfg.api_key.trim().to_string());
    if key.is_empty() {
        return Err("未配置 API Key，请先在全局设置 → 模型中填写".to_string());
    }
    let endpoint = base_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| owner.map(|p| p.base_url.trim().to_string()).filter(|s| !s.is_empty()))
        .unwrap_or_else(|| cfg.base_url.trim().to_string());
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));
    let p = prompt
        .map(str::to_string)
        .unwrap_or_else(|| "请提取图片中的全部文字，保持原始排版与顺序，仅输出识别结果不要任何说明".to_string());
    let data_url = format!("data:{};base64,{}", image_mime, image_base64);

    // 模型优先级：显式覆盖 > 档案的视觉模型 > 对话模型（保留旧配置的回落路径）
    let ocr_model = resolve_vision_model(&config, &cfg, model);

    let body = serde_json::json!({
        "model": ocr_model,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": p },
                { "type": "image_url", "image_url": { "url": data_url } }
            ]
        }],
        "temperature": 0.0,
        "max_tokens": cfg.max_tokens.unwrap_or(4096),
        "stream": false,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("创建请求客户端失败: {}", e))?;

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "HTTP {}（模型可能不支持视觉输入）: {}",
            status,
            text.chars().take(300).collect::<String>()
        ));
    }

    // 先取原始文本再解析：某些供应商（如纯文本模型收到图片时）会返回非 JSON 或非标准结构，
    // 直接 .json() 会得到模糊的「error decoding response body」，丢失服务端真实信息。
    let raw = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
        format!(
            "解析响应失败: {}；服务端原始返回：{}",
            e,
            raw.chars().take(300).collect::<String>()
        )
    })?;

    // 若服务端在 200 里夹带 error 字段（部分 OpenAI 兼容网关的做法），直接暴露。
    if let Some(err_obj) = v.get("error") {
        let em = err_obj
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("未知错误");
        return Err(format!("服务端返回错误：{}", em));
    }

    // 兼容两种返回结构：content 为字符串（OpenAI/gpt-4o、Qwen-VL、GLM-4V 多数情况），
    // 或 content 为文本块数组（[{type:"text",text:"..."}]，部分 VL 模型会这样返回）。
    let content_val = &v["choices"][0]["message"]["content"];
    let content = match content_val {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(arr) => arr
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => {
            return Err(format!(
                "响应中未找到 content 字段；服务端原始返回：{}",
                raw.chars().take(300).collect::<String>()
            ))
        }
    };
    Ok(content)
}

/// 视觉调用的**带 HTTP 上下文的**错误。
///
/// 为什么需要单独一个类型：`vision_ask` 把一切失败都压成 String，但**能力探测**
/// 必须区分「400 说图片不支持」（可确证不支持）与「429 限流」（与能力无关）——
/// 只看字符串就得回去正则解析我们自己拼的文案，比直接带出状态码脆弱得多。
#[derive(Debug, Clone)]
pub struct VisionHttpError {
    pub status: u16,
    pub body: String,
}

impl std::fmt::Display for VisionHttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "HTTP {}: {}", self.status, self.body.chars().take(300).collect::<String>())
    }
}

/// 与 `vision_ask` 完全同一条请求路径，但：① 保留 HTTP 状态码与响应体；
/// ② **不把服务端在 200 里夹带的 error 当成功**。
///
/// 后者是探测正确性的关键：部分 OpenAI 兼容网关对不支持的模态返回
/// **HTTP 200 + body 里带 error**。若按 `vision_ask` 的口径（200 即成功），
/// 探测会把「不支持」误记成「支持」——正是我们要防的脏记忆。
pub async fn vision_ask_raw(
    app: &AppHandle,
    image_base64: &str,
    image_mime: &str,
    prompt: Option<&str>,
    profile_id: Option<&str>,
    model: Option<&str>,
    base_url: Option<&str>,
    api_key: Option<&str>,
) -> Result<String, VisionHttpError> {
    let config = load_config(app);
    let cfg = resolve_target(&config, profile_id);
    let key = api_key
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| cfg.api_key.trim().to_string());
    if key.is_empty() {
        // 没有 key 是配置问题，用 0 表示「未发出请求」——探测据此判未知
        return Err(VisionHttpError { status: 0, body: "未配置 API Key".to_string() });
    }
    let endpoint = base_url.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(cfg.base_url.trim());
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));
    let p = prompt.map(str::to_string).unwrap_or_else(|| "请描述这张图片".to_string());
    let data_url = format!("data:{};base64,{}", image_mime, image_base64);

    let ocr_model = resolve_vision_model(&config, &cfg, model);

    let body = serde_json::json!({
        "model": ocr_model,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": p },
                { "type": "image_url", "image_url": { "url": data_url } }
            ]
        }],
        "temperature": 0.0,
        "max_tokens": 64,
        "stream": false,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| VisionHttpError { status: 0, body: format!("创建请求客户端失败: {}", e) })?;

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| VisionHttpError { status: 0, body: format!("请求失败: {}", e) })?;

    let status = resp.status().as_u16();
    let raw = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(VisionHttpError { status, body: raw });
    }

    // 200 里夹带 error → 仍算失败（见上方文档）。用 200 保留状态码，
    // 让 verdict_from 通过正文关键词判定「是否点名图片」。
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Err(VisionHttpError { status, body: raw });
    };
    if let Some(err_obj) = v.get("error") {
        let em = err_obj.get("message").and_then(|m| m.as_str()).unwrap_or("未知错误");
        return Err(VisionHttpError { status, body: em.to_string() });
    }
    let content_val = &v["choices"][0]["message"]["content"];
    let content = match content_val {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(arr) => arr
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => return Err(VisionHttpError { status, body: raw }),
    };
    Ok(content)
}

/// 翻译：传入文本 + 目标语言 + 可选源语言（"auto" 或留空表示自动识别），返回译文
/// 走非流式 AI 对话；若未配置 AI 则返回错误供前端降级提示
#[tauri::command]
pub async fn translate_text(
    app: AppHandle,
    text: String,
    target_lang: Option<String>,
    source_lang: Option<String>,
    profile_id: Option<String>,
) -> Result<String, String> {
    let config = load_config(&app);
    let cfg = resolve_target(&config, profile_id.as_deref());
    if cfg.api_key.trim().is_empty() {
        return Err("未配置 API Key，请先在全局设置 → 模型中填写".to_string());
    }

    let lang = target_lang.unwrap_or_else(|| "中文".to_string());
    // 源语言：仅当明确给出且非 "auto" 时才写入提示词；其余（auto / 空）视为自动识别
    let source = source_lang
        .filter(|s| !s.is_empty() && s != "auto");
    let system = match source {
        Some(src) => format!(
            "你是专业翻译助手。将用户输入的{}文本翻译为{}，仅输出译文，不加注释、不加引号、不保留原文。如果原文已是目标语言则原样返回。",
            src, lang
        ),
        None => format!(
            "你是专业翻译助手。将用户输入的文本翻译为{}，仅输出译文，不加注释、不加引号、不保留原文。如果原文已是目标语言则原样返回。",
            lang
        ),
    };

    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": cfg.model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": text }
        ],
        "temperature": 0.1,
        "max_tokens": cfg.max_tokens.unwrap_or(4096),
        "stream": false,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
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
        return Err(format!(
            "HTTP {}: {}",
            status,
            text.chars().take(300).collect::<String>()
        ));
    }

    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;
    let content = v["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| "响应中未找到 content 字段".to_string())?
        .to_string();
    Ok(content)
}

/// OCR 文本校对 / 整理：将本地或云端 OCR 得到的原文发送给文本模型，
/// 修正错别字、补全省略号与标点、按语义整理段落，返回校对后的纯文本。
/// 主要用于「DeepSeek 等不支持图像识别的模型」场景：先用 PaddleOCR 本地识别，
/// 再交给文本模型做分析 / 纠错。会消耗 token，由前端以显式开关控制（用户同意、可随时关闭）。
#[tauri::command]
pub async fn ai_ocr_enhance(
    app: AppHandle,
    text: String,
    profile_id: Option<String>,
) -> Result<String, String> {
    let config = load_config(&app);
    let cfg = resolve_target(&config, profile_id.as_deref());
    if cfg.api_key.trim().is_empty() {
        return Err("未配置 API Key，请先在全局设置 → 模型中填写".to_string());
    }
    let system = "你是一个 OCR 校对与整理助手。下面是一段由光学字符识别（OCR）从图片中提取的文本内容，可能含有错别字、断行错误、漏识别或符号混淆。请在不改变原意与原文语言的前提下：1）修正明显的错别字与识别错误；2）按合理语义补齐全角 / 半角标点与段落；3）保留原有的排版意图（如标题、列表、代码块、表格）。仅输出校对整理后的纯文本，不要添加任何解释、前言或 Markdown 代码围栏。若原文已无误则原样返回。";
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": cfg.model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": text }
        ],
        "temperature": 0.1,
        "max_tokens": cfg.max_tokens.unwrap_or(4096),
        "stream": false,
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
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
        let t = resp.text().await.unwrap_or_default();
        return Err(format!(
            "HTTP {}: {}",
            status,
            t.chars().take(300).collect::<String>()
        ));
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;
    let content = v["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| "响应中未找到 content 字段".to_string())?
        .to_string();
    Ok(content)
}

/// 将 OCR 源图导出为保留原始版面的 PDF：以原图作为整页背景（图像保真，版面 / 特点 100% 不变），
/// 等比适配 A4。用于「保存为 PDF」功能，使 OCR 结果可像成熟 OCR 产品一样以 PDF 形态交付。
#[tauri::command]
pub fn ocr_export_pdf(path: String, image_base64: String, mime: String) -> Result<(), String> {
    let _ = mime; // 接受但按像素解码，具体格式由图片解码器自动识别
    let b64 = image_base64.split(',').last().unwrap_or(&image_base64);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("图片 base64 解码失败: {}", e))?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("图片解析失败: {}", e))?;
    let (w, h) = img.dimensions();
    // 用 lopdf 内建 embed_image 能力把源图编码为图片 XObject（自动处理色彩空间与压缩）
    let img_stream = lopdf::xobject::image_from(bytes).map_err(|e| format!("图像编码失败: {}", e))?;
    let mut doc = lopdf::Document::new();
    let img_id = doc.add_object(img_stream);

    // 等比适配 A4（595×842pt），保留原始版面比例
    let page_w = 595.0_f64;
    let page_h = 842.0_f64;
    let scale = (page_w / w as f64).min(page_h / h as f64);
    let pw = w as f64 * scale;
    let ph = h as f64 * scale;
    let content = format!("q\n{:.4} 0 0 {:.4} 0 0 cm\n/Im0 Do\nQ\n", scale, scale);
    let content_id = doc.add_object(lopdf::Object::Stream(lopdf::Stream::new(
        lopdf::Dictionary::new(),
        content.into_bytes(),
    )));

    let pages_id = doc.new_object_id();
    let page_id = doc.new_object_id();
    let mut page_dict = lopdf::Dictionary::new();
    page_dict.set("Type", "Page");
    page_dict.set(
        "MediaBox",
        lopdf::Object::Array(vec![
            lopdf::Object::Integer(0),
            lopdf::Object::Integer(0),
            lopdf::Object::Real(pw as f32),
            lopdf::Object::Real(ph as f32),
        ]),
    );
    page_dict.set("Parent", lopdf::Object::Reference(pages_id));
    page_dict.set("Contents", lopdf::Object::Reference(content_id));
    doc.objects.insert(page_id, lopdf::Object::Dictionary(page_dict));
    let _ = doc.add_xobject(page_id, b"Im0", img_id);

    let mut pages_dict = lopdf::Dictionary::new();
    pages_dict.set("Type", "Pages");
    pages_dict.set(
        "Kids",
        lopdf::Object::Array(vec![lopdf::Object::Reference(page_id)]),
    );
    pages_dict.set("Count", lopdf::Object::Integer(1));
    doc.objects.insert(pages_id, lopdf::Object::Dictionary(pages_dict));

    let catalog_id = doc.add_object(lopdf::Object::Dictionary({
        let mut c = lopdf::Dictionary::new();
        c.set("Type", "Catalog");
        c.set("Pages", lopdf::Object::Reference(pages_id));
        c
    }));
    doc.trailer.set("Root", lopdf::Object::Reference(catalog_id));

    doc.save(&path)
        .map_err(|e| format!("保存 PDF 失败: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::ai_service::ai_profile::MediaModels;

    fn target(vision_model: Option<&str>, model: &str) -> ResolvedTarget {
        ResolvedTarget {
            model: model.to_string(),
            vision_model: vision_model.map(str::to_string),
            ..Default::default()
        }
    }

    fn config(media_vision: Option<&str>) -> AiConfig {
        AiConfig {
            media_models: MediaModels {
                vision: media_vision.map(str::to_string),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    #[test]
    fn 视觉模型解析_显式覆盖最优先() {
        // agent 工具（analyze_image）传的媒体后端模型名 = 本次指定用谁
        let got = resolve_vision_model(&config(Some("app-level")), &target(Some("prov"), "chat"), Some("explicit"));
        assert_eq!(got, "explicit");
    }

    #[test]
    fn 视觉模型解析_应用级优先于供应商三件套() {
        // ★ 这条是「一处配置」的核心：AI 页里配的那一个，要压过每个供应商各配一个的旧字段
        let got = resolve_vision_model(&config(Some("app-level")), &target(Some("prov"), "chat"), None);
        assert_eq!(got, "app-level");
    }

    #[test]
    fn 视觉模型解析_没配应用级时回落供应商三件套() {
        // 兼容保护：改造前只配了三件套的用户，行为必须与之前**完全一致**
        let got = resolve_vision_model(&config(None), &target(Some("prov"), "chat"), None);
        assert_eq!(got, "prov");
    }

    #[test]
    fn 视觉模型解析_都没配时回落对话模型() {
        // 多模态时代这是最合理的默认：你正在用哪个模型，就用它看图
        let got = resolve_vision_model(&config(None), &target(None, "chat-model"), None);
        assert_eq!(got, "chat-model");
    }

    #[test]
    fn 视觉模型解析_空白串视为未配() {
        // 用户把输入框清空（留下空串）不该被当成一个名为 "" 的模型发出去
        assert_eq!(resolve_vision_model(&config(Some("   ")), &target(Some("  "), "chat"), None), "chat");
        assert_eq!(resolve_vision_model(&config(None), &target(None, "chat"), Some("")), "chat");
    }

    #[test]
    fn 按模型名找到所属供应商() {
        // 用 serde 构造，避免依赖 Provider 的 Default 实现（字段多，构造噪音大）
        let c: AiConfig = serde_json::from_str(r#"{
            "providers": [
                {"id":"a","name":"A","base_url":"https://a/v1","api_key":"ka",
                 "models":[{"id":"ma","model":"m-a"}]},
                {"id":"b","name":"B","base_url":"https://b/v1","api_key":"kb",
                 "models":[{"id":"mb","model":"m-b"}]}
            ]
        }"#).unwrap();
        let p = find_provider_of_model(&c, "m-b").expect("应找到 B");
        assert_eq!(p.name, "B");
        assert_eq!(p.base_url, "https://b/v1");
        assert_eq!(p.api_key, "kb");
    }

    #[test]
    fn 找不到归属返回None而不是瞎猜() {
        let c = AiConfig::default();
        assert!(find_provider_of_model(&c, "nope").is_none());
        assert!(find_provider_of_model(&c, "   ").is_none(), "空白名不该匹配到任何东西");
    }

    #[test]
    fn 归属匹配是全等而非前缀或忽略大小写() {
        // ★ 刻意不做模糊匹配：一旦错，用户看到的是「配了 A 却打到了 B」，
        //   比"找不到就回落当前档案"更难排查。
        let c: AiConfig = serde_json::from_str(r#"{
            "providers": [{"id":"a","name":"A","base_url":"https://a/v1",
              "models":[{"id":"m1","model":"glm-4v"}]}]
        }"#).unwrap();
        assert!(find_provider_of_model(&c, "glm-4v-flash").is_none(), "前缀不该命中");
        assert!(find_provider_of_model(&c, "GLM-4V").is_none(), "大小写不猜");
        assert!(find_provider_of_model(&c, "glm-4v").is_some(), "全等应命中");
    }

    #[test]
    fn media_models_读取与空判定() {
        let m = MediaModels {
            vision: Some(" v ".into()),
            speech: Some("".into()),
            ..Default::default()
        };
        assert_eq!(m.get("vision"), Some("v"), "应 trim 后返回");
        assert_eq!(m.get("speech"), None, "空白视为未配");
        assert_eq!(m.get("nonexistent"), None);
        assert!(!m.is_empty(), "有任意一项非空就不算空");

        let empty = MediaModels::default();
        assert!(empty.is_empty());
        // 全空时不该落盘（配置里不会出现一个空的 media_models 块）
        let json = serde_json::to_string(&empty).unwrap();
        assert_eq!(json, "{}", "字段级 skip_serializing_if 也不该输出空值");
    }
}
