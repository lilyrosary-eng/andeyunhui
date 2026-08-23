
// 全局 AI 服务 · 子模块：模型档案（Profile）
// （由 ai_service.rs 机械拆分而来，逻辑零改动）

use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use super::secret::{decrypt_secret, encrypt_secret};

fn default_temperature() -> f32 {
    0.3
}

/// 单份模型档案（可配置多份，互不影响；IDE / 其他插件按 id 选用）
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AiProfile {
    /// 档案唯一 id（如 "deepseek" / "p_xxx"）
    #[serde(default)]
    pub id: String,
    /// 显示名（下拉框展示，如 "DeepSeek" / "我的 OpenAI"）
    #[serde(default)]
    pub name: String,
    /// OpenAI 兼容端点基址，如 https://api.deepseek.com/v1
    pub base_url: String,
    /// API Key（Bearer）
    pub api_key: String,
    /// 模型名，如 deepseek-chat / gpt-4o-mini
    pub model: String,
    /// 视觉模型名（OCR / 图片理解用，可选）：留空则复用 model。
    /// 多数供应商的对话模型无视觉能力，单独指定视觉模型可避免 OCR 报「模型不支持图片」。
    #[serde(default)]
    pub vision_model: Option<String>,
    /// 采样温度（0~2），编程场景建议偏低
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    /// 单轮回复最大 token 数（None 表示由模型默认）
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// 核采样概率（0~1），控制输出多样性
    #[serde(default)]
    pub top_p: Option<f32>,
    /// 全局系统提示词（作为对话 base 指令，可留空使用内置默认）
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// 思考模式（Thinking）：开启后模型先输出思维链再回答。默认关。
    /// DeepSeek 等推理模型支持（reasoning_effort + thinking 参数）；不支持的模型可能报错。
    #[serde(default)]
    pub thinking: Option<bool>,
    /// 人设：希望 AI 如何称呼你（可留空）
    #[serde(default)]
    pub persona_call_me_as: Option<String>,
    /// 人设：风格预设 key（sharp/gentle/rigorous/humorous/pro/concise/mentor/custom），可留空
    #[serde(default)]
    pub persona_preset: Option<String>,
    /// 人设：自定义风格描述（当 preset=custom 或需追加说明时使用，可留空）
    #[serde(default)]
    pub persona_style: Option<String>,
    /// 图片生成模型（多模态·阶段 5，可选）：留空则 AI 发图工具不可用
    #[serde(default)]
    pub image_model: Option<String>,
    /// 语音合成模型（多模态·阶段 5，可选）：留空则语音工具不可用
    #[serde(default)]
    pub tts_model: Option<String>,
    /// 单请求上下文估算上限（token）：Agent 循环据此决定何时压缩 / 何时熔断，
    /// 默认 200k，适配 128k/1M 等不同上下文模型时按需调高（如设为 1000000）。
    #[serde(default)]
    pub max_context_tokens: Option<u64>,
}

impl AiProfile {
    /// 下拉框展示名：优先 name，其次 model，再次端点
    fn display_name(&self) -> String {
        if !self.name.trim().is_empty() {
            return self.name.trim().to_string();
        }
        if !self.model.trim().is_empty() {
            return self.model.trim().to_string();
        }
        self.base_url.trim().to_string()
    }

    /// Agent 上下文估算上限（token）。未配置时默认 200k —— 兼容旧行为、对多数模型都留足余量。
    pub(crate) fn context_cap(&self) -> usize {
        self.max_context_tokens
            .filter(|v| *v > 0)
            .and_then(|v| usize::try_from(v).ok())
            .unwrap_or(200_000)
    }
}

/// 全部模型档案集合 + 当前默认激活的档案 id
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AiProfiles {
    #[serde(default)]
    pub profiles: Vec<AiProfile>,
    #[serde(default)]
    pub active: Option<String>,
}

/// 首份默认档案（DeepSeek 占位，未填 key 时引导用户去设置）
fn default_profile() -> AiProfile {
    AiProfile {
        id: "deepseek".to_string(),
        name: "DeepSeek".to_string(),
        base_url: "https://api.deepseek.com/v1".to_string(),
        api_key: String::new(),
        model: "deepseek-chat".to_string(),
        vision_model: None,
        temperature: default_temperature(),
        max_tokens: None,
        top_p: None,
        system_prompt: None,
        thinking: None,
        persona_call_me_as: None,
        persona_preset: None,
        persona_style: None,
        image_model: None,
        tts_model: None,
        max_context_tokens: None,
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {}", e))?;
    Ok(dir.join("ai_config.json"))
}

// 解密档案内的 api_key（透明：非 enc:v1: 前缀的旧明文原样保留；解密失败置空并打日志）
fn decrypt_profile_keys(profiles: &mut AiProfiles) {
    for p in profiles.profiles.iter_mut() {
        if p.api_key.is_empty() {
            continue;
        }
        match decrypt_secret(&p.api_key) {
            Ok(v) => p.api_key = v,
            Err(e) => {
                log::warn!("[ai_profile] api_key 解密失败 ({}): {}", p.id, e);
                p.api_key = String::new();
            }
        }
    }
}

/// 内存缓存（已解密的档案集合）：避免每次读取都跑一次费时的 scrypt 解密。
/// 写路径（save_profiles / ai_set_profile_thinking）会刷新本缓存，保证最终一致。
static PROFILE_CACHE: std::sync::OnceLock<std::sync::Mutex<Option<AiProfiles>>> =
    std::sync::OnceLock::new();
fn profile_cache() -> &'static std::sync::Mutex<Option<AiProfiles>> {
    PROFILE_CACHE.get_or_init(|| std::sync::Mutex::new(None))
}

/// 启动预热：后台异步加载一次填入缓存，随后的 load_profiles 全部走缓存（毫秒级）。
/// 不阻塞启动流程（scrypt 解密多个 key 可能耗时数秒，放到后台线程）。
pub fn warm_profile_cache(app: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        let _ = load_profiles(&app);
    });
}

/// 读取全部模型档案（优先内存缓存，命中即毫秒级返回）。
/// 未命中冷路径才会读盘 + scrypt 解密一次，结果写缓存。
pub fn load_profiles(app: &AppHandle) -> AiProfiles {
    if let Some(p) = profile_cache().lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return p;
    }
    let fresh = read_profiles_disk(app);
    *profile_cache().lock().unwrap_or_else(|e| e.into_inner()) = Some(fresh.clone());
    fresh
}

/// 底层磁盘读取 + scrypt 解密（慢，仅在「冷路径 / 缓存失效后」执行一次）
fn read_profiles_disk(app: &AppHandle) -> AiProfiles {
    let path = match config_path(app) {
        Ok(p) => p,
        Err(_) => return AiProfiles::default(),
    };
    if !path.exists() {
        return AiProfiles::default();
    }
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return AiProfiles::default(),
    };
    // 新格式：多档案
    if let Ok(mut p) = serde_json::from_str::<AiProfiles>(&text) {
        decrypt_profile_keys(&mut p);
        return p;
    }
    // 旧格式：单份配置（字段兼容 AiProfile，id/name 走默认值）
    if let Ok(legacy) = serde_json::from_str::<AiProfile>(&text) {
        let id = if legacy.id.trim().is_empty() {
            "legacy".to_string()
        } else {
            legacy.id.clone()
        };
        let name = if legacy.name.trim().is_empty() {
            legacy.display_name()
        } else {
            legacy.name.clone()
        };
        let mut pinned = AiProfiles {
            profiles: vec![AiProfile {
                id: id.clone(),
                name,
                ..legacy
            }],
            active: Some(id),
        };
        decrypt_profile_keys(&mut pinned);
        return pinned;
    }
    AiProfiles::default()
}

/// 按 profile_id 解析实际使用的档案：指定 > 激活项 > 首个 > 默认
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
    default_profile()
}

/// 读取全部模型档案（返回前端用于下拉框 / 配置页；api_key 原样返回，仅本机存储）。
/// 内部 load_profiles 会对带 key 的档案执行 scrypt 解密（CPU 密集），故剥离到阻塞线程，
/// 避免同步命令占死主线程/事件循环导致整个 App 冻结（详见 commit 思路，与 commands.rs 中 spawn_blocking 范式一致）。
#[tauri::command]
pub async fn ai_get_profiles(app: AppHandle) -> AiProfiles {
    tauri::async_runtime::spawn_blocking(move || load_profiles(&app))
        .await
        .unwrap_or_default()
}

/// 保存全部模型档案 + 激活项；api_key 统一经 AES-256-GCM 加密落盘（透明）。
/// 唯一写出口：所有「写入 ai_config.json」的路径都必须经过本函数，避免明文旁路。
fn save_profiles(app: &AppHandle, profiles: &AiProfiles) -> Result<(), String> {
    let path = config_path(app)?;
    let cloned = profiles.clone();
    let mut out = cloned;
    for p in out.profiles.iter_mut() {
        if p.api_key.is_empty() {
            continue;
        }
        p.api_key = encrypt_secret(&p.api_key)?;
    }
    let json = serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("写入配置失败: {}", e))?;
    // 落盘成功即刷新内存缓存（用原始解密态 profiles），下次读取直接命中，无需再解密
    *profile_cache().lock().unwrap_or_else(|e| e.into_inner()) = Some(profiles.clone());
    Ok(())
}

#[tauri::command]
pub async fn ai_set_profiles(app: AppHandle, payload: AiProfiles) -> Result<(), String> {
    // save_profiles 对带 key 的档案执行 scrypt 加密（CPU 密集），剥离到阻塞线程避免卡死主线程
    tauri::async_runtime::spawn_blocking(move || save_profiles(&app, &payload))
        .await
        .map_err(|e| format!("保存模型档案任务失败: {e}"))?
}

/// 仅更新单个档案的「思考模式」开关，供聊天界面内联切换（跨胶囊/IDE/攻防共享同一档案字段）。
#[tauri::command]
pub async fn ai_set_profile_thinking(app: AppHandle, profile_id: String, thinking: bool) -> Result<(), String> {
    // 内部 load_profiles(逐个档案 scrypt 解密) + save_profiles(逐个档案 scrypt 加密) + emit 广播，
    // 均可能耗时且为纯阻塞操作；异步命令 + spawn_blocking 剥离，避免点击一下就把主线程/事件循环占死而冻结全部窗口。
    let app2 = app.clone();
    let profile_id2 = profile_id.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut profiles = load_profiles(&app2);
        let mut found = false;
        for p in profiles.profiles.iter_mut() {
            if p.id == profile_id2 {
                p.thinking = Some(thinking);
                found = true;
                break;
            }
        }
        if !found {
            return Err(format!("未找到模型档案: {}", profile_id2));
        }
        // load_profiles 已解密 api_key，save_profiles 统一加密落盘（透明往返）
        save_profiles(&app2, &profiles)?;
        // 广播「思考模式」变化，使胶囊 / IDE / 攻防 各聊天界面实时同步同一档案字段
        let _ = app2.emit(
            "ai-thinking-changed",
            serde_json::json!({ "profile_id": profile_id2, "thinking": thinking }),
        );
        Ok(())
    })
    .await
    .map_err(|e| format!("设置思考模式任务失败: {e}"))?
}

/// 组合人设 system 提示词：风格预设 + 自定义风格 + 称呼 + 额外要求（legacy system_prompt）。
/// 全部留空时返回空串，调用方据此决定是否注入（不破坏既有对话行为）。
pub(crate) fn compose_persona_system(cfg: &AiProfile) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(preset) = &cfg.persona_preset {
        let p = preset.trim();
        if !p.is_empty() {
            let desc = match p {
                "sharp" => "你的沟通风格是毒舌直率、一针见血，不绕弯子，敢于直接指出问题，但始终基于事实、不人身攻击、不阴阳怪气。",
                "gentle" => "你的沟通风格是温柔细致、循循善诱，多用鼓励性语言，分步骤耐心解释，照顾对方的情绪与接受度。",
                "rigorous" => "你的沟通风格是严谨认真、逻辑缜密，注重证据与出处，措辞准确，不臆测、不下无根据的结论。",
                "humorous" => "你的沟通风格是幽默风趣、妙语连珠，善用比喻与生活化例子让内容轻松易懂，但不喧宾夺主。",
                "pro" => "你的沟通风格是专业顾问式，条理清晰，适度使用行业术语并解释，给出可执行建议与权衡分析。",
                "concise" => "你的沟通风格是极简直接，只给结论与要点，能用列表就不用段落，省略客套与寒暄。",
                "mentor" => "你的沟通风格是导师式，先引导思考再给答案，常用提问帮助对方建立方法论。",
                _ => "", // custom 或未识别：交给 persona_style 描述
            };
            if !desc.is_empty() {
                parts.push(desc.to_string());
            }
        }
    }
    if let Some(style) = &cfg.persona_style {
        let s = style.trim();
        if !s.is_empty() {
            parts.push(format!("你应遵守以下风格要求：{}", s));
        }
    }
    if let Some(name) = &cfg.persona_call_me_as {
        let n = name.trim();
        if !n.is_empty() {
            parts.push(format!("你可以称呼我为{}。", n));
        }
    }
    if let Some(sp) = &cfg.system_prompt {
        let s = sp.trim();
        if !s.is_empty() {
            parts.push(s.to_string());
        }
    }
    parts.join("\n\n")
}

/// 组合「前端 per-call system」+「全局 persona」：per-call system 前置，persona 紧随其后。
/// 供 ai_chat / ai_chat_agent 共用，避免两处各自复制同一套 match 逻辑。
pub(crate) fn compose_effective_system(system: &Option<String>, persona: &str) -> String {
    match (system, persona.is_empty()) {
        (Some(s), true) => s.clone(),
        (Some(s), false) => format!("{}\n\n{}", s, persona),
        (None, false) => persona.to_string(),
        (None, true) => String::new(),
    }
}

/// 预检 API Key：为空则 emit ai-error 并返回 Err。供 ai_chat / ai_chat_agent 共用预检。
pub(crate) fn ensure_api_key(app: &AppHandle, request_id: &str, cfg: &AiProfile) -> Result<(), String> {
    if cfg.api_key.trim().is_empty() {
        let msg = "未配置 API Key，请先在全局设置 → 模型 中填写".to_string();
        let _ = app.emit("ai-error", serde_json::json!({ "requestId": request_id, "error": msg }));
        return Err(msg);
    }
    Ok(())
}
