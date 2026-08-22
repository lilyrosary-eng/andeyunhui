
// 全局 AI 服务 · 子模块：OCR / 翻译（OCR）
// （由 ai_service.rs 机械拆分而来，逻辑零改动）

use base64::Engine;
use image::GenericImageView;
use tauri::AppHandle;
use crate::services::ai_service::{AiProfile, load_profiles, resolve_profile};

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

/// 视觉 OCR：传入图片 base64 + prompt，返回模型识别的文本
/// 兼容 OpenAI Vision 协议（content 数组：[{type:"text",text:...},{type:"image_url",image_url:{url:"data:..."}}]）
#[tauri::command]
pub async fn ai_vision_ocr(
    app: AppHandle,
    image_base64: String,
    image_mime: String,
    prompt: Option<String>,
    profile_id: Option<String>,
) -> Result<String, String> {
    let profiles = load_profiles(&app);
    let cfg = resolve_profile(&profiles, profile_id);
    if cfg.api_key.trim().is_empty() {
        return Err("未配置 API Key，请先在全局设置 → 模型中填写".to_string());
    }

    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let p = prompt.unwrap_or_else(|| "请提取图片中的全部文字，保持原始排版与顺序，仅输出识别结果不要任何说明".to_string());
    let data_url = format!("data:{};base64,{}", image_mime, image_base64);

    // OCR 优先使用独立的视觉模型；未单独配置时回落到对话模型（兼容旧配置）。
    let ocr_model = cfg
        .vision_model
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| cfg.model.clone());

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
    let profiles = load_profiles(&app);
    let cfg = resolve_profile(&profiles, profile_id);
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
    let profiles = load_profiles(&app);
    let cfg = resolve_profile(&profiles, profile_id);
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
