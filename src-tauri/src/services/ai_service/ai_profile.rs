
// 全局 AI 服务 · 子模块：模型档案（Profile）
// （由 ai_service.rs 机械拆分而来，逻辑零改动）

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use super::secret::{decrypt_secret, encrypt_secret};

/// 采样温度缺省值。legacy_compat.rs 也用它派生 v1 形状，
/// 两处各写一份 0.3 的话，改了一处另一处就会静默跑偏。
pub(crate) fn default_temperature() -> f32 {
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

// ============ v2：供应商 / 模型 两层结构 ============
//
// 为什么要重构：v1 的每条 AiProfile 只能装一个 model，所以一个中转站的 87 个模型
// 要建 87 条档案，各自重复填 base_url 与 api_key。v2 把 endpoint + key 上提到 Provider，
// 模型只留 id / 上游模型名 / 能力标记 / 逐模型参数覆盖。
//
// ★ ModelEntry.id 沿用 v1 的 profile.id。这不是偷懒：usage_service.rs:148 按
//   profile_id 记账的历史数据、companion_service.rs:51 持久化的引用、会话里存的 id
//   全部靠它继续有效，换 id 就得写历史数据迁移。

/// 能力标记。text 默认 true——没打标但有 id 的模型至少能做文本对话。
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq)]
pub struct Caps {
    #[serde(default = "caps_text_default")]
    pub text: bool,
    #[serde(default)]
    pub vision: bool,
    #[serde(default)]
    pub reasoning: bool,
    #[serde(default)]
    pub embedding: bool,
}

fn caps_text_default() -> bool {
    true
}

impl Default for Caps {
    fn default() -> Self {
        Caps {
            text: caps_text_default(),
            vision: false,
            reasoning: false,
            embedding: false,
        }
    }
}

/// 逐模型参数覆盖。语义与 v1 AiProfile 的同名字段一致，只是从「档案」挪到了「模型」。
/// 全部 Option：None 表示用默认值，用户没改过就不占空间。
#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
pub struct Overrides {
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub top_p: Option<f32>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub thinking: Option<bool>,
    #[serde(default)]
    pub persona_call_me_as: Option<String>,
    #[serde(default)]
    pub persona_preset: Option<String>,
    #[serde(default)]
    pub persona_style: Option<String>,
    #[serde(default)]
    pub max_context_tokens: Option<u64>,
}

/// 供应商 = 一个端点 + 一把 key，旗下挂多个模型。
#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
pub struct Provider {
    #[serde(default)]
    pub id: String,
    /// 空则 UI 回落到 base_url 的主机名
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub base_url: String,
    /// API Key（Bearer）。AES-GCM 加密在这一层，不是每个模型一份。
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub models: Vec<ModelEntry>,
    /// 多模态三件套属于「供应商」而非单个模型：同端点不同模型名，
    /// 且多数 /v1/models 列表里并不包含它们。
    #[serde(default)]
    pub vision_model: Option<String>,
    #[serde(default)]
    pub image_model: Option<String>,
    #[serde(default)]
    pub tts_model: Option<String>,
    #[serde(default)]
    pub last_scanned_at: Option<u64>,
}

/// 单个模型条目。
#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
pub struct ModelEntry {
    /// ★ 沿用 v1 的 profile.id，见上方注释
    #[serde(default)]
    pub id: String,
    /// 上游真实模型名，如 "qwen3:8b"
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub caps: Caps,
    /// 端点自报的上下文长度（`/v1/models` 的 context_window / context_length）。
    /// 用户手工调整的值存在 overrides.max_context_tokens 里，后者优先。
    #[serde(default)]
    pub context_tokens: Option<u64>,
    #[serde(default)]
    pub overrides: Overrides,
}

/// 当前选中的供应商与模型。单选——「当前用哪个」就这一个值，
/// 不同模型各自的温度/人设靠 overrides 天然区分，不需要额外的 enabled 位。
#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
pub struct Selection {
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub model_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
pub struct AiConfig {
    #[serde(default)]
    pub providers: Vec<Provider>,
    #[serde(default)]
    pub selection: Selection,
}

/// FNV-1a 64 位。不用 std 的 DefaultHasher——它的输出不保证跨 Rust 版本稳定，
/// 而 provider.id 必须在重复迁移时得到同一个值，否则「再迁移一次」会造出重复供应商。
fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

pub(crate) fn provider_id_for(base_url: &str, plain_key: &str) -> String {
    format!("pv_{:016x}", fnv1a(&format!("{}\u{1}{}", base_url, plain_key)))
}

/// v1 → v2 迁移。raw 是 ai_config.json 的原始 JSON：
/// - 顶层有 `providers` → 已是 v2，原样反序列化
/// - 顶层有 `profiles` → 按 (base_url, 解密后的明文 key) 分组合并为供应商
///
/// 分组键必须用**解密后的明文**：每次加密都用随机 salt/IV，同一明文两次密文不同，
/// 用密文分组会把同一把 key 拆成两个供应商。
///
/// 整份解析失败一律退回空配置，但**必须打日志**：静默清空等于告诉用户「档案全没了」，
/// 比报错难查得多。所以各字段都带 `#[serde(default)]`，让单个字段缺失不至于报废整份配置，
/// 真到了整体无法解析的地步，日志里也留得下线索。
pub fn migrate_v1_to_v2(raw: &serde_json::Value) -> AiConfig {
    if raw.get("providers").is_some() {
        // 已经是 v2。解析失败必须留痕——静默退回空配置等于告诉用户「档案全没了」
        return match serde_json::from_value(raw.clone()) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[ai_profile] v2 配置解析失败，按空配置处理: {}", e);
                AiConfig::default()
            }
        };
    }
    let v1: AiProfiles = serde_json::from_value(raw.clone()).unwrap_or_default();

    let mut cfg = AiConfig::default();
    // (base_url, 明文 key) → cfg.providers 中的下标
    let mut groups: Vec<((String, String), usize)> = Vec::new();

    for p in &v1.profiles {
        // 解密失败按空串处理，与 decrypt_profile_keys 既有行为一致。
        // 不能退回密文：AES-GCM 每次随机 salt/IV，同一把 key 的多条档案密文各不相同，
        // 用密文分组会把一个供应商拆成 N 个。
        let plain_key = decrypt_secret(&p.api_key).unwrap_or_default();
        let group_key = (p.base_url.clone(), plain_key.clone());
        let idx = match groups.iter().find(|(k, _)| *k == group_key) {
            Some((_, i)) => *i,
            None => {
                cfg.providers.push(Provider {
                    id: provider_id_for(&p.base_url, &plain_key),
                    name: p.name.trim().to_string(),
                    base_url: p.base_url.clone(),
                    api_key: p.api_key.clone(),
                    models: Vec::new(),
                    // 三件套一律置 None，统一由下面的「取组内第一个非空值」逻辑填，
                    // 免得这里赋一遍、那里再判一次，两处真相源容易走偏
                    vision_model: None,
                    image_model: None,
                    tts_model: None,
                    last_scanned_at: None,
                });
                let i = cfg.providers.len() - 1;
                groups.push((group_key, i));
                i
            }
        };
        let prov = &mut cfg.providers[idx];
        // 供应商级的三件套取组内第一个非空值
        if prov.vision_model.is_none() {
            prov.vision_model = p.vision_model.clone();
        }
        if prov.image_model.is_none() {
            prov.image_model = p.image_model.clone();
        }
        if prov.tts_model.is_none() {
            prov.tts_model = p.tts_model.clone();
        }
        prov.models.push(ModelEntry {
            id: p.id.clone(),
            model: p.model.clone(),
            label: None,
            // vision 留到分组结束后统一判定，见下方注释
            caps: Caps { text: true, vision: false, reasoning: false, embedding: false },
            context_tokens: None,
            overrides: Overrides {
                temperature: Some(p.temperature),
                max_tokens: p.max_tokens,
                top_p: p.top_p,
                system_prompt: p.system_prompt.clone(),
                thinking: p.thinking,
                persona_call_me_as: p.persona_call_me_as.clone(),
                persona_preset: p.persona_preset.clone(),
                persona_style: p.persona_style.clone(),
                max_context_tokens: p.max_context_tokens,
            },
        });
    }

    // caps.vision 的判定必须在分组之后做。
    // v1 的写法有两种：单独配一个视觉模型（vision_model: "gpt-4v" + model: "gpt-4o"），
    // 或留空回落到对话模型（vision_model: None）。在循环里用
    // `profile.model == profile.vision_model` 判，只在「两者恰好同名」的退化情形下成立，
    // 会让单独配了视觉模型的用户整组没有模型被标 vision，OCR 静默失效。
    for prov in cfg.providers.iter_mut() {
        if let Some(vm) = prov.vision_model.clone() {
            for m in prov.models.iter_mut() {
                if m.model == vm {
                    m.caps.vision = true;
                }
            }
        }
    }

    // v1 的 active 落到 v2 的 selection
    if let Some(active) = &v1.active {
        if let Some(prov) = cfg.providers.iter().find(|p| p.models.iter().any(|m| &m.id == active)) {
            cfg.selection = Selection {
                provider_id: Some(prov.id.clone()),
                model_id: Some(active.clone()),
            };
        }
    }
    cfg
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

/// 明文 api_key → 密文 的进程内缓存：只对「变更过 / 新出现的」api_key 跑一次 scrypt 派生，
/// 未变（如仅切换 thinking）则直接复用上次落盘密文，避免每次保存都全量重算导致写档案卡几十秒。
static ENC_CACHE: std::sync::OnceLock<std::sync::Mutex<HashMap<String, String>>> =
    std::sync::OnceLock::new();
fn enc_cache() -> &'static std::sync::Mutex<HashMap<String, String>> {
    ENC_CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// 启动预热：后台异步加载一次填入缓存，随后的 load_profiles 全部走缓存（毫秒级）。
/// 不阻塞启动流程（scrypt 解密多个 key 可能耗时数秒，放到后台线程）。
pub fn warm_profile_cache(app: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        // 先预热固定盐派生密钥，再解密档案：首次「切换思考 → save_profiles 加密」不再冷跑 scrypt
        let _ = super::secret::warm_fixed_key();
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

/// 解析出的实际调用参数。字段名与 v1 AiProfile 的请求相关字段逐一对应，
/// 所以 11 个 resolve_profile 调用点是机械替换而非重写。
#[derive(Debug, Clone)]
pub struct ResolvedTarget {
    /// 模型 id，usage_service 按它记账
    pub id: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub vision_model: Option<String>,
    pub image_model: Option<String>,
    pub tts_model: Option<String>,
    pub temperature: f32,
    pub max_tokens: Option<u32>,
    pub top_p: Option<f32>,
    pub system_prompt: Option<String>,
    pub thinking: Option<bool>,
    pub persona_call_me_as: Option<String>,
    pub persona_preset: Option<String>,
    pub persona_style: Option<String>,
    pub max_context_tokens: Option<u64>,
}

impl ResolvedTarget {
    /// Agent 上下文估算上限（token）。未配置时默认 200k —— 兼容 v1 行为，
    /// 对多数模型都留足余量。优先取用户手工设的值，其次端点自报的，最后 200k。
    pub(crate) fn context_cap(&self) -> usize {
        self.max_context_tokens
            .filter(|v| *v > 0)
            .and_then(|v| usize::try_from(v).ok())
            .unwrap_or(200_000)
    }
}

/// 内置 DeepSeek 占位：配置为空时用它，引导用户去设置。
pub fn placeholder_target() -> ResolvedTarget {
    ResolvedTarget {
        id: "deepseek".to_string(),
        base_url: "https://api.deepseek.com/v1".to_string(),
        api_key: String::new(),
        model: "deepseek-chat".to_string(),
        vision_model: None,
        image_model: None,
        tts_model: None,
        temperature: default_temperature(),
        max_tokens: None,
        top_p: None,
        system_prompt: None,
        thinking: None,
        persona_call_me_as: None,
        persona_preset: None,
        persona_style: None,
        max_context_tokens: None,
    }
}

/// 跨全部供应商按模型 id 找条目。与「取首个」严格分开：找不到就返回 None。
fn find_model_by_id<'a>(config: &'a AiConfig, wanted: &str) -> Option<(&'a Provider, &'a ModelEntry)> {
    for prov in &config.providers {
        if let Some(m) = prov.models.iter().find(|m| m.id == wanted) {
            return Some((prov, m));
        }
    }
    None
}

/// 配置中的首个模型条目（对应 v1 resolve_profile 的「首个档案」那一级）。
/// 跳过空供应商，否则「有供应商但一个模型都没加」会误判成整份配置为空。
fn first_model(config: &AiConfig) -> Option<(&Provider, &ModelEntry)> {
    config
        .providers
        .iter()
        .find_map(|prov| prov.models.first().map(|m| (prov, m)))
}

/// 按模型 id 解析实际调用参数：指定 > selection > 首个 > 内置占位。
/// 级联语义与 v1 的 resolve_profile 一致，只是作用点从「档案」变成「模型」。
pub fn resolve_target(config: &AiConfig, model_id: Option<&str>) -> ResolvedTarget {
    // 三级查找各自独立返回 None，「取首个」不能混进按 id 查找里：
    // 否则 model_id 为 None 时会在第一级就返回配置里的第一条模型，
    // selection 永远轮不到——「不指定模型」就变成了「永远用第一条」而不是「用用户选中的那条」。
    let found = model_id
        .and_then(|id| find_model_by_id(config, id))
        .or_else(|| {
            config
                .selection
                .model_id
                .as_deref()
                .and_then(|id| find_model_by_id(config, id))
        })
        .or_else(|| first_model(config));

    let (prov, m) = match found {
        Some(v) => v,
        None => return placeholder_target(),
    };

    let o = &m.overrides;
    // 供应商级三件套优先；为空时回落到该模型自身的模型名。
    //
    // ★ 回落是无条件的，不看 m.caps.vision。v1 的 ai_ocr.rs:92-97 写的是「未单独配置时
    //   回落到对话模型」，AiProfile.vision_model 的字段文档也写「留空则复用 model」。
    //   加 caps.vision 条件会让 v1 的单档案配置 { model: "qwen2-vl", vision_model: None }
    //   在迁移后拿不到视觉模型名——而 v1 的 OCR 正是拿这条档案的对话模型跑的，迁移反而让它失效。
    // caps.vision 是模型自身能力的标签（给 UI 显示用），不是 OCR 的选择依据，两者允许不一致。
    let vision_model = prov
        .vision_model
        .clone()
        .or_else(|| Some(m.model.clone()));

    ResolvedTarget {
        id: m.id.clone(),
        base_url: prov.base_url.clone(),
        api_key: prov.api_key.clone(),
        model: m.model.clone(),
        vision_model,
        image_model: prov.image_model.clone(),
        tts_model: prov.tts_model.clone(),
        temperature: o.temperature.unwrap_or_else(default_temperature),
        max_tokens: o.max_tokens,
        top_p: o.top_p,
        system_prompt: o.system_prompt.clone(),
        thinking: o.thinking,
        persona_call_me_as: o.persona_call_me_as.clone(),
        persona_preset: o.persona_preset.clone(),
        persona_style: o.persona_style.clone(),
        max_context_tokens: o.max_context_tokens.or(m.context_tokens),
    }
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
    let mut out = profiles.clone();
    // 复用「明文→密文」缓存，避免 api_key 未变时全量重跑 scrypt（写库瞬时）。
    let mut enc_guard = enc_cache().lock().unwrap_or_else(|e| e.into_inner());
    let mut next_enc: HashMap<String, String> = HashMap::with_capacity(out.profiles.len());
    for p in out.profiles.iter_mut() {
        if p.api_key.is_empty() {
            continue;
        }
        let enc = match enc_guard.get(&p.api_key) {
            Some(e) => e.clone(),
            None => encrypt_secret(&p.api_key)?,
        };
        next_enc.insert(p.api_key.clone(), enc.clone());
        p.api_key = enc;
    }
    *enc_guard = next_enc; // 仅当全部加密成功后才刷新缓存
    drop(enc_guard);
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

#[cfg(test)]
mod v2_tests {
    use super::*;
    use serde_json::json;

    /// 三条档案：前两条同端点同 key（应合并），第三条独立；active 指向第二条。
    fn v1_json() -> serde_json::Value {
        json!({
            "profiles": [
                { "id": "p_aaa", "name": "本地", "base_url": "http://127.0.0.1:11434/v1",
                  "api_key": "sk-x", "model": "qwen3:8b", "temperature": 0.5, "max_tokens": 4096 },
                { "id": "p_bbb", "name": "", "base_url": "http://127.0.0.1:11434/v1",
                  "api_key": "sk-x", "model": "llama3", "temperature": 0.3 },
                { "id": "p_ccc", "name": "官方", "base_url": "https://api.deepseek.com/v1",
                  "api_key": "sk-y", "model": "deepseek-chat", "temperature": 0.3,
                  "vision_model": "deepseek-chat" }
            ],
            "active": "p_bbb"
        })
    }

    #[test]
    fn 迁移_模型id沿用原profile_id() {
        let cfg = migrate_v1_to_v2(&v1_json());
        let ids: Vec<&str> = cfg.providers.iter()
            .flat_map(|p| p.models.iter().map(|m| m.id.as_str())).collect();
        assert_eq!(ids, vec!["p_aaa", "p_bbb", "p_ccc"]);
    }

    #[test]
    fn 迁移_同端点同key合并为一个供应商() {
        let cfg = migrate_v1_to_v2(&v1_json());
        assert_eq!(cfg.providers.len(), 2);
        let local = &cfg.providers[0];
        assert_eq!(local.base_url, "http://127.0.0.1:11434/v1");
        assert_eq!(local.models.len(), 2);
    }

    #[test]
    fn 迁移_同端点不同key不合并() {
        let raw = json!({ "profiles": [
            { "id": "a", "base_url": "http://x/v1", "api_key": "sk-1", "model": "m1" },
            { "id": "b", "base_url": "http://x/v1", "api_key": "sk-2", "model": "m2" }
        ]});
        assert_eq!(migrate_v1_to_v2(&raw).providers.len(), 2);
    }

    #[test]
    fn 迁移_active成为selection() {
        let cfg = migrate_v1_to_v2(&v1_json());
        assert_eq!(cfg.selection.model_id.as_deref(), Some("p_bbb"));
        assert_eq!(cfg.selection.provider_id.as_deref(), Some(cfg.providers[0].id.as_str()));
    }

    #[test]
    fn 迁移_provider_id可重复() {
        // 同一输入跑两次必须得到同一 id，否则「重新迁移」会造出重复供应商
        let a = migrate_v1_to_v2(&v1_json());
        let b = migrate_v1_to_v2(&v1_json());
        let ids_a: Vec<&str> = a.providers.iter().map(|p| p.id.as_str()).collect();
        let ids_b: Vec<&str> = b.providers.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids_a, ids_b);
    }

    #[test]
    fn 迁移_provider_id是稳定的字面量() {
        // 把哈希实现钉死：换算法会让同一配置生成不同的 provider id，
        // 于是「重新迁移一次」会造出重复供应商，用户看到同一端点出现多张卡。
        // 单纯的「同输入两次相等」守不住这个约束——DefaultHasher 在同进程内也是确定的，
        // 所以必须拿字面量比。
        let cfg = migrate_v1_to_v2(&v1_json());
        assert_eq!(cfg.providers[0].id, "pv_98e910dd905305ff", "本地端点 (127.0.0.1:11434 + sk-x)");
        assert_eq!(cfg.providers[1].id, "pv_ac2e803f27a9f29a", "DeepSeek 端点 (+ sk-y)");
        assert_ne!(cfg.providers[0].id, cfg.providers[1].id, "两个供应商不该撞 id");
    }

    #[test]
    fn 迁移_覆盖项承接原字段() {
        let cfg = migrate_v1_to_v2(&v1_json());
        let qwen = &cfg.providers[0].models[0];
        assert_eq!(qwen.overrides.temperature, Some(0.5));
        assert_eq!(qwen.overrides.max_tokens, Some(4096));
        assert!(qwen.caps.text);
    }

    #[test]
    fn 迁移_vision_model标记对应模型能力() {
        let cfg = migrate_v1_to_v2(&v1_json());
        let ds = &cfg.providers[1].models[0];
        assert!(ds.caps.vision, "vision_model 指向自身的模型应标 vision");
    }

    #[test]
    fn 已是v2的原样返回() {
        let cfg = migrate_v1_to_v2(&v1_json());
        let again = migrate_v1_to_v2(&serde_json::to_value(&cfg).unwrap());
        assert_eq!(again, cfg);
    }

    #[test]
    fn 空文件不炸() {
        let cfg = migrate_v1_to_v2(&json!({}));
        assert!(cfg.providers.is_empty());
        assert!(cfg.selection.model_id.is_none());
    }

    #[test]
    fn 迁移_解不开的key归到空串组不分裂() {
        // 同端点、两条解不开的 key（密文各不相同）应合并成一个供应商
        let raw = json!({ "profiles": [
            { "id": "a", "base_url": "http://x/v1", "api_key": "enc:v1:AAAA", "model": "m1" },
            { "id": "b", "base_url": "http://x/v1", "api_key": "enc:v1:BBBB", "model": "m2" }
        ]});
        let cfg = migrate_v1_to_v2(&raw);
        assert_eq!(cfg.providers.len(), 1, "解不开的 key 不该把供应商拆开");
        assert_eq!(cfg.providers[0].models.len(), 2);
    }

    #[test]
    fn v2缺字段不报废整份配置() {
        // 缺 ModelEntry.model 也应解析成功，而不是整份变空
        let raw = json!({ "providers": [{ "id": "pv_1", "base_url": "http://x/v1",
                                         "models": [{ "id": "m1" }] }] });
        let cfg = migrate_v1_to_v2(&raw);
        assert_eq!(cfg.providers.len(), 1);
        assert_eq!(cfg.providers[0].models.len(), 1);
        assert_eq!(cfg.providers[0].models[0].id, "m1");
    }

    #[test]
    fn v2缺供应商字段不报废整份配置() {
        // 缺 Provider.id / base_url 也应解析成功，模型条目一个都不能少
        let raw = json!({ "providers": [{ "models": [{ "id": "m1", "model": "gpt-x" }] }] });
        let cfg = migrate_v1_to_v2(&raw);
        assert_eq!(cfg.providers.len(), 1, "供应商缺字段不该让整份配置报废");
        assert_eq!(cfg.providers[0].id, "");
        assert_eq!(cfg.providers[0].models[0].model, "gpt-x");
    }

    #[test]
    fn 迁移_单独配置的视觉模型被标出() {
        // v1 的真实用法：对话模型与视觉模型是两条独立档案
        let raw = json!({ "profiles": [
            { "id": "chat", "base_url": "http://x/v1", "api_key": "k", "model": "gpt-4o",
              "vision_model": "gpt-4v" },
            { "id": "vis", "base_url": "http://x/v1", "api_key": "k", "model": "gpt-4v" }
        ]});
        let cfg = migrate_v1_to_v2(&raw);
        assert_eq!(cfg.providers.len(), 1);
        assert_eq!(cfg.providers[0].vision_model.as_deref(), Some("gpt-4v"));
        let vis = cfg.providers[0].models.iter().find(|m| m.id == "vis").unwrap();
        assert!(vis.caps.vision, "被配成视觉模型的那条应标 vision");
        let chat = cfg.providers[0].models.iter().find(|m| m.id == "chat").unwrap();
        assert!(!chat.caps.vision, "对话模型不应被标 vision");
    }

    #[test]
    fn 迁移_未配视觉模型时无人被标() {
        let raw = json!({ "profiles": [
            { "id": "a", "base_url": "http://x/v1", "api_key": "k", "model": "gpt-4o" }
        ]});
        assert!(!migrate_v1_to_v2(&raw).providers[0].models[0].caps.vision);
    }

    #[test]
    fn 迁移_九个覆盖项全部承接() {
        let raw = json!({ "profiles": [{
            "id": "p_full", "base_url": "http://x/v1", "api_key": "k", "model": "m",
            "temperature": 0.77, "max_tokens": 1234, "top_p": 0.33,
            "system_prompt": "提示", "thinking": true,
            "persona_call_me_as": "老板", "persona_preset": "rigorous",
            "persona_style": "严肃", "max_context_tokens": 1000000
        }]});
        let o = &migrate_v1_to_v2(&raw).providers[0].models[0].overrides;
        assert!((o.temperature.unwrap() - 0.77).abs() < f32::EPSILON);
        assert_eq!(o.max_tokens, Some(1234));
        assert!((o.top_p.unwrap() - 0.33).abs() < f32::EPSILON);
        assert_eq!(o.system_prompt.as_deref(), Some("提示"));
        assert_eq!(o.thinking, Some(true));
        assert_eq!(o.persona_call_me_as.as_deref(), Some("老板"));
        assert_eq!(o.persona_preset.as_deref(), Some("rigorous"));
        assert_eq!(o.persona_style.as_deref(), Some("严肃"));
        assert_eq!(o.max_context_tokens, Some(1_000_000));
    }

    // ---------- resolve_target ----------

    /// v2 配置：由 v1_json() 迁移而来，与迁移测试共用同一份输入
    fn cfg_with() -> AiConfig {
        migrate_v1_to_v2(&v1_json())
    }

    #[test]
    fn 解析_按指定模型() {
        let cfg = cfg_with();
        let t = resolve_target(&cfg, Some("p_ccc"));
        assert_eq!(t.model, "deepseek-chat");
        assert_eq!(t.id, "p_ccc");
        assert_eq!(t.base_url, "https://api.deepseek.com/v1");
        assert_eq!(t.api_key, "sk-y");
    }

    #[test]
    fn 解析_未指定时用selection() {
        let cfg = cfg_with();
        let t = resolve_target(&cfg, None);
        assert_eq!(t.id, "p_bbb", "v1 active=p_bbb 应成为 selection");
    }

    #[test]
    fn 解析_指定的模型不存在时回落selection() {
        let cfg = cfg_with();
        let t = resolve_target(&cfg, Some("p_nope"));
        assert_eq!(t.id, "p_bbb");
    }

    #[test]
    fn 解析_没有selection时用首个模型() {
        // 级联的第三级：selection 缺失、或指向已被删掉的模型时，退回配置里的第一个模型。
        // 「首个」必须排在 selection 之后——反过来就变成「永远用第一条」。
        let mut cfg = cfg_with();
        cfg.selection.model_id = None;
        assert_eq!(resolve_target(&cfg, None).id, "p_aaa");
        cfg.selection.model_id = Some("p_gone".into());
        assert_eq!(resolve_target(&cfg, Some("p_gone")).id, "p_aaa");
    }

    #[test]
    fn 解析_空配置回落占位() {
        let t = resolve_target(&AiConfig::default(), None);
        assert_eq!(t.base_url, "https://api.deepseek.com/v1");
        assert_eq!(t.model, "deepseek-chat");
        assert_eq!(t.temperature, 0.3);
    }

    #[test]
    fn 解析_温度缺省补03() {
        let mut cfg = cfg_with();
        cfg.providers[0].models[0].overrides.temperature = None;
        let t = resolve_target(&cfg, Some("p_aaa"));
        assert!((t.temperature - 0.3).abs() < f32::EPSILON);
    }

    #[test]
    fn 解析_视觉模型回落自身_不看caps() {
        // v1 的回落是无条件的：caps.vision 为 false 也要回落，
        // 否则 { model: "qwen2-vl", vision_model: None } 这类配置迁移后 OCR 会失效
        let mut cfg = cfg_with();
        cfg.providers[0].vision_model = None;
        cfg.providers[0].models[0].caps.vision = false;
        let t = resolve_target(&cfg, Some("p_aaa"));
        assert_eq!(t.vision_model.as_deref(), Some("qwen3:8b"));
    }

    #[test]
    fn 解析_供应商未建档的视觉模型仍可用() {
        // v1 合法配置：单独配了 vision_model，但没为它单独建档。
        // 此时没有任何模型被标 caps.vision，OCR 仍必须拿到 gpt-4v。
        let mut cfg = cfg_with();
        cfg.providers[0].vision_model = Some("gpt-4v".into());
        cfg.providers[0].models[0].caps.vision = false;
        let t = resolve_target(&cfg, Some("p_aaa"));
        assert_eq!(t.vision_model.as_deref(), Some("gpt-4v"));
    }

    #[test]
    fn 解析_供应商级视觉模型优先() {
        let mut cfg = cfg_with();
        cfg.providers[0].vision_model = Some("qwen-vl-max".into());
        cfg.providers[0].models[0].caps.vision = true;
        let t = resolve_target(&cfg, Some("p_aaa"));
        assert_eq!(t.vision_model.as_deref(), Some("qwen-vl-max"));
    }

    #[test]
    fn 解析_上下文上限缺省20万() {
        let cfg = cfg_with();
        assert_eq!(resolve_target(&cfg, Some("p_aaa")).context_cap(), 200_000);
    }
}
