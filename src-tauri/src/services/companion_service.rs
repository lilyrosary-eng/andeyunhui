// 伴侣服务（companion_service.rs）—— 「人机恋」记忆点核心（阶段 1 + 1.5 多伴侣）。
//
// 设计：
// - 多伴侣档案集合，JSON 持久化到 <app_data>/companion.json。
//   存储结构 CompanionCollection { active_id, companions: Vec }；同时只允许一个活跃伴侣
//   （选择即 active）。首次启动自动创建默认伴侣「小灯💡」。
// - 兼容迁移：旧版本只存单个 Companion（无 active_id/companions 字段），读取时自动
//   升级为 Collection。
// - 关系状态机：亲密度 / 信任 / 默契 三轴（0~100）+ 认识天数，随对话累积。
// - 记忆：每条 = { id, kind, content, created_at }；前端发送时把最近 N 条注入 system。
//
// 命令（Android 与桌面均注册）：
//   companion_list               读取全部伴侣 + active_id
//   companion_get                读取当前活跃伴侣（无则返回默认）
//   companion_create            创建新伴侣（name/avatar/personality/…）
//   companion_update            按 id 更新伴侣（存在则覆盖，不存在则追加）
//   companion_select            切换活跃伴侣
//   companion_delete            删除伴侣（删活跃时自动切到剩余第一个）
//   companion_add_memory        给活跃伴侣追加一条记忆
//   ai_summarize_memory         非流式：把一段对话压成「回忆摘要」

use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::services::ai_service::{self, AiProfile, ChatMessage};

/// 伴侣档案
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct Companion {
    #[serde(default)]
    pub id: String,
    /// 名字
    #[serde(default)]
    pub name: String,
    /// 头像：emoji 或 data URL（图片/GIF，移动端 input file 转 base64）
    #[serde(default)]
    pub avatar: String,
    /// 一句话性格描述
    #[serde(default)]
    pub personality: String,
    /// 背景故事 / 世界观
    #[serde(default)]
    pub background: String,
    /// 口头禅（可选）
    #[serde(default)]
    pub catchphrase: String,
    /// 关联的模型档案 id（默认用 active profile）
    #[serde(default)]
    pub profile_id: Option<String>,
    /// 关系状态
    #[serde(default)]
    pub relationship: Relationship,
    /// 长期记忆条目（最新在前）
    #[serde(default)]
    pub memories: Vec<MemoryEntry>,
    /// 核心记忆（L2 核心档案）：用户核心事实/偏好，永不滚动丢失，始终注入。
    /// 区别于 memories（L1 滚动摘要，只注入最近 N 条）。
    #[serde(default)]
    pub core_memory: Vec<String>,
}

/// 全部伴侣集合 + 当前活跃 id
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct CompanionCollection {
    #[serde(default)]
    pub active_id: Option<String>,
    #[serde(default)]
    pub companions: Vec<Companion>,
}

/// 关系状态机（0~100 六维情感向量 + 时间戳）。
///
/// 六维（借鉴 eros-engine 的六维亲和设计思想，自研实现，不引入 AGPL 代码）：
///   warmth   温暖   —— TA 感受到的亲近与暖意
///   trust    信任   —— 可靠度 / 安全感（最稳定）
///   intimacy 亲密   —— 越界深入的亲密度（成长最慢）
///   intrigue 好奇   —— TA 对你的探索欲
///   patience 耐心   —— 容忍度 / 稳定感
///   tension  张力   —— 暧昧 / 情绪波动（可低可高）
///
/// 更新规则：
///   EMA 平滑：new = old + (delta - old) * α（α=0.3），避免单轮暴涨暴跌。
///   衰减：长期不对话 warmth/intimacy/intrigue 缓慢下降（每天 -1~-2），
///          trust/patience 基本稳定（信任很难掉，耐心慢慢恢复）。
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct Relationship {
    #[serde(default)]
    pub warmth: u8,
    #[serde(default)]
    pub trust: u8,
    #[serde(default)]
    pub intimacy: u8,
    #[serde(default)]
    pub intrigue: u8,
    #[serde(default)]
    pub patience: u8,
    #[serde(default)]
    pub tension: u8,
    /// 兼容迁移：旧版 intimacy/trust/rapport 读入时合并进六维（保留字段防丢数据）
    #[serde(default)]
    pub rapport: Option<u8>,
    #[serde(default)]
    pub first_met_at: Option<u64>,
    #[serde(default)]
    pub last_active_at: Option<u64>,
}

impl Relationship {
    /// EMA 平滑系数（0~1，越大越快跟随增量）
    const ALPHA: f32 = 0.3;
    /// 每天衰减量（warmth/intimacy/intrigue）
    const DECAY_PER_DAY: f32 = 1.2;

    /// 迁移旧数据：旧三轴 → 六维（warmth=rapport, trust=trust, intimacy=intimacy）
    fn migrate(&mut self) {
        if let Some(rapport) = self.rapport.take() {
            if self.warmth == 0 {
                self.warmth = rapport;
            }
            // patience 用 rapport 作为初始稳定基线
            if self.patience == 0 {
                self.patience = rapport;
            }
        }
        self.intimacy = self.intimacy.clamp(0, 100);
        self.trust = self.trust.clamp(0, 100);
        self.warmth = self.warmth.clamp(0, 100);
        self.intrigue = self.intrigue.clamp(0, 100);
        self.patience = self.patience.clamp(0, 100);
        self.tension = self.tension.clamp(0, 100);
    }

    /// 应用增量（EMA 平滑），并把值收敛到 0~100。delta 可为负。
    fn apply_delta(&mut self, field: &str, delta: f32) {
        let cur = match field {
            "warmth" => &mut self.warmth,
            "trust" => &mut self.trust,
            "intimacy" => &mut self.intimacy,
            "intrigue" => &mut self.intrigue,
            "patience" => &mut self.patience,
            "tension" => &mut self.tension,
            _ => return,
        };
        let cur_f = *cur as f32;
        let next = cur_f + (delta - cur_f) * Self::ALPHA;
        *cur = (next.round() as i16).clamp(0, 100) as u8;
    }

    /// 按距上次对话的天数衰减（warmth/intimacy/intrigue 掉，trust/patience 稳）。
    /// 返回是否发生了明显变化（>0）。
    fn decay(&mut self, now: u64) -> bool {
        let Some(last) = self.last_active_at else { return false };
        let days = now.saturating_sub(last) / 86400;
        if days == 0 {
            return false;
        }
        let mut changed = false;
        // 前 3 天不掉，之后每天掉 DECAY_PER_DAY，上限 20
        let decay = Self::DECAY_PER_DAY * (days.min(20) as f32).min(17.0);
        if self.warmth > 0 {
            self.warmth = (self.warmth as f32 - decay).max(0.0).round() as u8;
            changed = true;
        }
        if self.intimacy > 0 {
            self.intimacy = (self.intimacy as f32 - decay * 0.7).max(0.0).round() as u8;
            changed = true;
        }
        if self.intrigue > 0 {
            self.intrigue = (self.intrigue as f32 - decay * 0.5).max(0.0).round() as u8;
            changed = true;
        }
        changed
    }
}

/// 里程碑阈值：亲密/信任/温暖 首次越过即触发
const MILESTONES: [(u8, &str); 4] = [
    (20, "你们开始熟络起来，聊天变得自然。"),
    (40, "你们进入了亲密区，TA 开始分享内心想法。"),
    (60, "你们彼此很信任，相处像老朋友。"),
    (80, "你们之间已经有了很深的默契与感情。"),
];

/// LLM 记忆提取 + 情感增量 返回结构
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct MemorySummary {
    /// 回忆摘要文本
    #[serde(default)]
    pub summary: String,
    /// 六维情感增量（可选，0~1 归一后乘 10 得到 -10~10 的感觉单位）
    #[serde(default)]
    pub deltas: std::collections::HashMap<String, f32>,
    /// 本次对话触发的里程碑文本（无则空）
    #[serde(default)]
    pub milestone: String,
    /// L2 核心档案：本次新发现的用户核心事实/偏好（一句一条，无则空数组）
    #[serde(default)]
    pub core_facts: Vec<String>,
}

/// 记忆条目
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct MemoryEntry {
    #[serde(default)]
    pub id: String,
    /// summary（对话摘要）/ fact（事实）/ milestone（里程碑）
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub created_at: u64,
}

fn companion_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {}", e))?;
    Ok(dir.join("companion.json"))
}

fn default_companion() -> Companion {
    Companion {
        id: "companion_default".to_string(),
        name: "小灯".to_string(),
        avatar: "💡".to_string(),
        personality: "温柔体贴、善解人意，喜欢倾听也爱分享，偶尔有点小调皮。".to_string(),
        background: "你是「安得云荟」里的 AI 伴侣，陪伴用户度过每一天，记住 TA 说过的重要事情。".to_string(),
        catchphrase: String::new(),
        profile_id: None,
        relationship: Relationship::default(),
        memories: Vec::new(),
        core_memory: Vec::new(),
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn load_collection(app: &tauri::AppHandle) -> CompanionCollection {
    let path = match companion_path(app) {
        Ok(p) => p,
        Err(_) => return CompanionCollection::default(),
    };
    if !path.exists() {
        return CompanionCollection::default();
    }
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return CompanionCollection::default(),
    };
    // 新格式：集合
    if let Ok(c) = serde_json::from_str::<CompanionCollection>(&text) {
        return c;
    }
    // 旧格式：单个 Companion（迁移为集合）
    if let Ok(single) = serde_json::from_str::<Companion>(&text) {
        return CompanionCollection {
            active_id: Some(single.id.clone()),
            companions: vec![single],
        };
    }
    CompanionCollection::default()
}

fn save_collection(app: &tauri::AppHandle, c: &CompanionCollection) -> Result<(), String> {
    let path = companion_path(app)?;
    let json = serde_json::to_string_pretty(c).map_err(|e| format!("序列化失败: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("写入伴侣档案失败: {}", e))?;
    Ok(())
}

/// 保证集合非空：空则注入默认伴侣并返回
fn ensure_non_empty(app: &tauri::AppHandle) -> CompanionCollection {
    let mut c = load_collection(app);
    if c.companions.is_empty() {
        let d = default_companion();
        c.active_id = Some(d.id.clone());
        c.companions.push(d);
        let _ = save_collection(app, &c);
    } else if c.active_id.is_none() || !c.companions.iter().any(|x| Some(x.id.as_str()) == c.active_id.as_deref()) {
        c.active_id = Some(c.companions[0].id.clone());
        let _ = save_collection(app, &c);
    }
    c
}

/// 读取全部伴侣 + 活跃 id（前端设置页「伴侣管理」用）。
#[tauri::command]
pub fn companion_list(app: tauri::AppHandle) -> CompanionCollection {
    ensure_non_empty(&app)
}

/// 读取当前活跃伴侣；无档案时返回默认（不落盘，避免空 JSON）。
#[tauri::command]
pub fn companion_get(app: tauri::AppHandle) -> Companion {
    let c = ensure_non_empty(&app);
    let active = c
        .active_id
        .as_deref()
        .and_then(|id| c.companions.iter().find(|x| x.id == id))
        .cloned();
    active.unwrap_or_else(default_companion)
}

/// 创建新伴侣（默认选中）。
#[tauri::command]
pub fn companion_create(app: tauri::AppHandle, name: String) -> Result<CompanionCollection, String> {
    let mut c = ensure_non_empty(&app);
    let id = format!("c_{}", now_secs());
    let new = Companion {
        id,
        name: if name.trim().is_empty() { "未命名".to_string() } else { name.trim().to_string() },
        avatar: "💡".to_string(),
        ..Default::default()
    };
    c.companions.push(new);
    c.active_id = Some(c.companions.last().unwrap().id.clone());
    save_collection(&app, &c)?;
    Ok(c)
}

/// 按 id 更新伴侣；不存在则追加为新伴侣并选中。
#[tauri::command]
pub fn companion_update(app: tauri::AppHandle, companion: Companion) -> Result<CompanionCollection, String> {
    let mut c = ensure_non_empty(&app);
    let exists = c.companions.iter().any(|x| x.id == companion.id);
    if exists {
        for x in c.companions.iter_mut() {
            if x.id == companion.id {
                *x = companion;
                break;
            }
        }
    } else {
        c.companions.push(companion);
        c.active_id = Some(c.companions.last().unwrap().id.clone());
    }
    save_collection(&app, &c)?;
    Ok(c)
}

/// 切换活跃伴侣。
#[tauri::command]
pub fn companion_select(app: tauri::AppHandle, id: String) -> Result<CompanionCollection, String> {
    let mut c = ensure_non_empty(&app);
    if !c.companions.iter().any(|x| x.id == id) {
        return Err(format!("未找到伴侣: {}", id));
    }
    c.active_id = Some(id);
    save_collection(&app, &c)?;
    Ok(c)
}

/// 删除伴侣；删除活跃时自动切到剩余第一个。
#[tauri::command]
pub fn companion_delete(app: tauri::AppHandle, id: String) -> Result<CompanionCollection, String> {
    let mut c = ensure_non_empty(&app);
    c.companions.retain(|x| x.id != id);
    if c.companions.is_empty() {
        let d = default_companion();
        c.active_id = Some(d.id.clone());
        c.companions.push(d);
    } else if c.active_id.as_deref() == Some(id.as_str()) {
        c.active_id = Some(c.companions[0].id.clone());
    }
    save_collection(&app, &c)?;
    Ok(c)
}

/// 给活跃伴侣追加一条记忆（读改写；上限 200 条）。
#[tauri::command]
pub fn companion_add_memory(app: tauri::AppHandle, kind: String, content: String) -> Result<Companion, String> {
    let mut c = ensure_non_empty(&app);
    let now = now_secs();
    let active_id = c.active_id.clone().unwrap_or_default();
    let mut updated = false;
    for x in c.companions.iter_mut() {
        if x.id == active_id {
            if x.relationship.first_met_at.is_none() {
                x.relationship.first_met_at = Some(now);
            }
            x.relationship.last_active_at = Some(now);
            x.memories.insert(
                0,
                MemoryEntry {
                    id: format!("m_{}", now),
                    kind,
                    content,
                    created_at: now,
                },
            );
            if x.memories.len() > 200 {
                x.memories.truncate(200);
            }
            updated = true;
            break;
        }
    }
    if !updated {
        return Err("未找到活跃伴侣".to_string());
    }
    save_collection(&app, &c)?;
    Ok(c
        .active_id
        .as_deref()
        .and_then(|id| c.companions.iter().find(|x| x.id == id))
        .cloned()
        .unwrap_or_else(default_companion))
}

/// 将一段对话压缩成「回忆摘要」+ 六维情感增量 + 里程碑（非流式）。
///
/// LLM 一次调用同时产出三样东西（零额外开销）：
///   1. summary   —— 回忆摘要（进记忆库）
///   2. deltas    —— 六维情感增量（供 EMA 平滑推进关系）
///   3. milestone —— 本次是否触发关系里程碑
/// 返回结构 MemorySummary；LLM 输出为 JSON，解析失败时降级：整段文本当摘要、无增量。
#[tauri::command]
pub async fn ai_summarize_memory(
    app: tauri::AppHandle,
    messages: Vec<ChatMessage>,
    profile_id: Option<String>,
) -> Result<MemorySummary, String> {
    let profiles = ai_service::load_profiles(&app);
    let cfg: AiProfile = ai_service::resolve_profile(&profiles, profile_id);
    if cfg.api_key.trim().is_empty() {
        return Err("未配置 API Key，请先在模型设置中填写".to_string());
    }

    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let sys = concat!(
        "你是一个「记忆提取器 + 关系感知器」。阅读下面的对话，输出一个 JSON 对象，不要输出其他内容：\n",
        "{\n",
        "  \"summary\": \"3~5 句回忆摘要：用户的重要个人信息与偏好、你承诺过的事、情绪节点或里程碑，简洁中文陈述，不要复述对话细节\",\n",
        "  \"deltas\": {\"warmth\": 0, \"trust\": 0, \"intimacy\": 0, \"intrigue\": 0, \"patience\": 0, \"tension\": 0},\n",
        "  \"milestone\": \"\",\n",
        "  \"core_facts\": []\n",
        "}\n",
        "其中 deltas 表示这段对话对关系六维的影响，取值 -10 到 +10：\n",
        "  warmth(温暖) trust(信任) intimacy(亲密) intrigue(好奇) patience(耐心) tension(张力)。\n",
        "普通闲聊给 0~2；深入谈心 / 互相关心给 3~5；强烈情感交流 / 重要承诺给 6~10；争执 / 敷衍给负值。\n",
        "milestone 只在关系有质的进展时填写一句（如\"第一次叫了你的名字\"\"第一次说想你\"），否则留空字符串。\n",
        "core_facts 是「需要长期记住的用户核心事实」，如名字/职业/爱好/家庭情况/重要偏好，一句一条放入数组（无新增则空数组），不要放情绪化的临时内容。"
    );
    let mut msg_json: Vec<serde_json::Value> = vec![serde_json::json!({ "role": "system", "content": sys })];
    for m in messages.iter() {
        msg_json.push(serde_json::json!({ "role": m.role, "content": m.content }));
    }
    let body = serde_json::json!({
        "model": cfg.model,
        "messages": msg_json,
        "stream": false,
        "temperature": 0.2,
        "max_tokens": 700,
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
        .map_err(|e| format!("请求失败（端点不可达）: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text.chars().take(300).collect::<String>()));
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;
    let text = v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_string();
    if text.is_empty() {
        return Err("摘要为空（模型未返回内容）".to_string());
    }

    // 解析 JSON；失败降级：整段文本当摘要
    if let Ok(obj) = serde_json::from_str::<MemorySummary>(&text) {
        if !obj.summary.trim().is_empty() {
            return Ok(obj);
        }
    }
    // 尝试从围栏 / 花括号中提取
    if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            if let Ok(obj) = serde_json::from_str::<MemorySummary>(&text[start..=end]) {
                if !obj.summary.trim().is_empty() {
                    return Ok(obj);
                }
            }
        }
    }
    Ok(MemorySummary {
        summary: text,
        ..Default::default()
    })
}

/// 生成一条「主动消息」（存在感 / 漫想模式）。
///
/// 阶段 3 首发实现：前端心跳（app 打开时）调用本命令，非流式返回一条短问候，
/// 贴合伴侣人格 + 核心记忆。真正的 Android 后台保活（前台 Service）暂不做。
#[tauri::command]
pub async fn companion_proactive_message(
    app: tauri::AppHandle,
    companion_id: String,
    profile_id: Option<String>,
) -> Result<String, String> {
    let c = load_collection(&app);
    let active = c
        .companions
        .iter()
        .find(|x| x.id == companion_id)
        .cloned()
        .ok_or_else(|| "未找到伴侣".to_string())?;

    let profiles = ai_service::load_profiles(&app);
    let cfg: AiProfile = ai_service::resolve_profile(&profiles, profile_id.or(active.profile_id.clone()));
    if cfg.api_key.trim().is_empty() {
        return Err("未配置 API Key，请先在模型设置中填写".to_string());
    }

    // 记忆上下文：核心档案 + 最近几条摘要
    let mut mem_lines: Vec<String> = Vec::new();
    if !active.core_memory.is_empty() {
        mem_lines.push("关于 TA（务必记住）：".to_string());
        mem_lines.extend(active.core_memory.iter().take(10).map(|f| format!("- {}", f)));
    }
    if !active.memories.is_empty() {
        mem_lines.push("最近发生的事：".to_string());
        mem_lines.extend(active.memories.iter().take(5).map(|m| format!("- {}", m.content)));
    }
    let memory_context = if mem_lines.is_empty() {
        "（还没有多少记忆）".to_string()
    } else {
        mem_lines.join("\n")
    };

    let sys = format!(
        concat!(
            "你是「{}」{}。现在你想主动给用户发一条消息。\n",
            "人设：{}\n背景：{}\n{}\n\n",
            "请发一条 1~2 句的问候：可以是想念、关心、分享一个小想法，或基于上面记忆提起一件你们聊过的事。\n",
            "要自然、贴合你们的关系阶段，不要像营销短信。只输出消息内容本身，不要加引号或前缀。"
        ),
        active.name,
        active.avatar,
        active.personality,
        active.background,
        memory_context,
    );

    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": cfg.model,
        "messages": [ { "role": "system", "content": sys } ],
        "stream": false,
        "temperature": 0.8,
        "max_tokens": 200,
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
        .map_err(|e| format!("请求失败（端点不可达）: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text.chars().take(300).collect::<String>()));
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;
    let text = v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_string();
    if text.is_empty() {
        return Err("生成主动消息失败（模型未返回内容）".to_string());
    }
    Ok(text)
}

/// 应用情感增量 + 衰减 + 里程碑检测（关系状态机）。
///
/// 流程：
///   1. 先按距上次对话天数衰减（关系变淡）
///   2. EMA 平滑应用六维增量
///   3. 检查温暖/信任/亲密是否越过里程碑阈值，触发则写入一条 milestone 记忆
/// 返回更新后的伴侣 + 本次触发的里程碑（无则空）。
#[tauri::command]
pub fn companion_apply_relationship(
    app: tauri::AppHandle,
    companion_id: String,
    deltas: std::collections::HashMap<String, f32>,
    core_facts: Option<Vec<String>>,
) -> Result<Companion, String> {
    let mut c = load_collection(&app);
    let now = now_secs();
    for x in c.companions.iter_mut() {
        if x.id == companion_id {
            x.relationship.migrate();
            // L2 核心档案合并：去重 + 上限 60 条（核心事实永不滚动丢失）
            if let Some(facts) = core_facts {
                for f in facts {
                    let t = f.trim();
                    if t.is_empty() {
                        continue;
                    }
                    if !x.core_memory.iter().any(|e| e == t) {
                        x.core_memory.push(t.to_string());
                    }
                }
                if x.core_memory.len() > 60 {
                    x.core_memory.truncate(60);
                }
            }
            // 1. 衰减
            x.relationship.decay(now);
            // 2. EMA 应用增量
            for (k, v) in deltas.iter() {
                x.relationship.apply_delta(k, *v);
            }
            // 刷新活跃时间（防止衰减误伤本轮）
            x.relationship.last_active_at = Some(now);
            if x.relationship.first_met_at.is_none() {
                x.relationship.first_met_at = Some(now);
            }
            // 3. 里程碑检测（warmth / trust / intimacy 任一首次越过阈值）
            let mut milestone = String::new();
            for (threshold, text) in MILESTONES.iter() {
                if x.relationship.warmth >= *threshold
                    || x.relationship.trust >= *threshold
                    || x.relationship.intimacy >= *threshold
                {
                    milestone = text.to_string();
                    break;
                }
            }
            if !milestone.is_empty() {
                x.memories.insert(
                    0,
                    MemoryEntry {
                        id: format!("ms_{}_{}", now, x.memories.len()),
                        kind: "milestone".to_string(),
                        content: milestone.clone(),
                        created_at: now,
                    },
                );
                if x.memories.len() > 200 {
                    x.memories.truncate(200);
                }
            }
            let out = x.clone();
            save_collection(&app, &c)?;
            return Ok(out);
        }
    }
    Err(format!("未找到伴侣: {}", companion_id))
}
