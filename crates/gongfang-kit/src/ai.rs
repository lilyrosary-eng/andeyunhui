//! AI 客户端：复用全局 ai_config.json（与 ai_service.rs 格式 serde 兼容）
//!
//! 设计：gongfang-kit 不依赖主 crate（避免循环依赖），但复用同一份 AI 配置文件，
//! 实现"AI 接入全局设置"。提供非流式 chat() 供策略生成核调用（流式由前端走 ai_chat 命令）。
//!
//! 协议：OpenAI Chat Completions（/v1/chat/completions），兼容 DeepSeek/OpenAI/Moonshot/Ollama。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn default_temperature() -> f32 {
    0.3
}

/// 单份模型档案（字段与 ai_service.rs::AiProfile 完全一致，serde 兼容）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AiProfile {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub top_p: Option<f32>,
    #[serde(default)]
    pub system_prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AiProfiles {
    #[serde(default)]
    pub profiles: Vec<AiProfile>,
    #[serde(default)]
    pub active: Option<String>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {}", e))?;
    Ok(dir.join("ai_config.json"))
}

/// 读取全局 AI 档案（复用 ai_service.rs 的 ai_config.json）
pub fn load_profiles(app: &AppHandle) -> AiProfiles {
    let path = match config_path(app) {
        Ok(p) => p,
        Err(_) => return AiProfiles::default(),
    };
    if !path.exists() {
        return AiProfiles::default();
    }
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return AiProfiles::default(),
    };
    if let Ok(p) = serde_json::from_str::<AiProfiles>(&text) {
        return p;
    }
    // 旧格式兼容
    if let Ok(legacy) = serde_json::from_str::<AiProfile>(&text) {
        let id = if legacy.id.trim().is_empty() {
            "legacy".to_string()
        } else {
            legacy.id.clone()
        };
        return AiProfiles {
            profiles: vec![AiProfile { id: id.clone(), ..legacy }],
            active: Some(id),
        };
    }
    AiProfiles::default()
}

/// 按 profile_id 解析档案：指定 > 激活项 > 首个 > 默认 DeepSeek
pub fn resolve_profile(profiles: &AiProfiles, profile_id: Option<String>) -> AiProfile {
    if let Some(pid) = profile_id {
        if let Some(p) = profiles.profiles.iter().find(|p| p.id == pid) {
            return p.clone();
        }
    }
    if let Some(aid) = &profiles.active {
        if let Some(p) = profiles.profiles.iter().find(|p| p.id == *aid) {
            return p.clone();
        }
    }
    if let Some(first) = profiles.profiles.first() {
        return first.clone();
    }
    AiProfile {
        id: "deepseek".to_string(),
        name: "DeepSeek".to_string(),
        base_url: "https://api.deepseek.com/v1".to_string(),
        api_key: String::new(),
        model: "deepseek-chat".to_string(),
        temperature: default_temperature(),
        max_tokens: None,
        top_p: None,
        system_prompt: None,
    }
}

/// 单条对话消息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// 非流式一次性 chat（供 AI 常驻推理核调用，返回完整文本）
///
/// 与 ai_service.rs::ai_chat（流式 SSE 推前端）的区别：
/// - 策略生成需要完整 JSON 结构，流式无意义
/// - 500ms 超时由调用方（control.rs）用 tokio::time::timeout 控制
pub async fn chat(profile: &AiProfile, messages: Vec<ChatMessage>) -> Result<String, String> {
    if profile.api_key.trim().is_empty() {
        return Err("未配置 API Key，请先在全局设置 → 模型 中填写".to_string());
    }
    let url = format!(
        "{}/chat/completions",
        profile.base_url.trim_end_matches('/')
    );
    let mut body = serde_json::json!({
        "model": profile.model,
        "messages": messages.iter().map(|m| serde_json::json!({
            "role": m.role, "content": m.content
        })).collect::<Vec<_>>(),
        "temperature": profile.temperature,
        "stream": false,
    });
    if let Some(mt) = profile.max_tokens {
        body["max_tokens"] = serde_json::json!(mt);
    }
    if let Some(tp) = profile.top_p {
        body["top_p"] = serde_json::json!(tp);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建请求客户端失败: {}", e))?;

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", profile.api_key.trim()))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("AI 请求失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("AI HTTP {}: {}", status, text.chars().take(300).collect::<String>()));
    }

    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("AI 响应解析失败: {}", e))?;

    v["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "AI 响应缺少 content 字段".to_string())
}
