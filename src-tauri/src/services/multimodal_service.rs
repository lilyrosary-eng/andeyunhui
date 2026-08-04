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

use crate::services::ai_service::{self, AiProfile};

/// AI 生成图片（OpenAI 兼容 /images/generations）。
/// 返回 data URL（png）；无法取 base64 时尝试取 url（再转 data URL 会失败则回退原 url）。
#[tauri::command]
pub async fn ai_generate_image(
    app: tauri::AppHandle,
    prompt: String,
    profile_id: Option<String>,
) -> Result<String, String> {
    let profiles = ai_service::load_profiles(&app);
    let cfg: AiProfile = ai_service::resolve_profile(&profiles, profile_id);
    if cfg.api_key.trim().is_empty() {
        return Err("未配置 API Key".to_string());
    }
    let model = cfg
        .image_model
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "该算力来源未配置图片生成模型（image_model），无法发图".to_string())?;

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
    let profiles = ai_service::load_profiles(&app);
    let cfg: AiProfile = ai_service::resolve_profile(&profiles, profile_id);
    if cfg.api_key.trim().is_empty() {
        return Err("未配置 API Key".to_string());
    }
    let model = cfg
        .tts_model
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "该算力来源未配置语音模型（tts_model），无法播报".to_string())?;

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
