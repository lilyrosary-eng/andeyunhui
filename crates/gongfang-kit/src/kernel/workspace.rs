//! 目标工作区持久化（多目标管理 + 项目级保存）
//!
//! 设计：
//! - 每个 Target 代表一个攻防目标（URL/IP/主机名），独立保存扫描结果/逆向资产/策略
//! - Workspace 持有目标列表 + 当前激活目标 ID
//! - 存储路径：app_data_dir/gongfang_targets.json
//! - 命令族：gongfang_target_list / save / delete / activate / get
//!
//! 替代方案对比：
//! - SQLite：桌面场景过度工程，JSON 文件 + fsync 足够
//! - Sled：嵌入式 KV，但 GPL 协议被排除
//! - ReDB：纯 Rust，但增加 ~500KB 依赖，不值得

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

// ============ 目标类型 ============

/// 目标类型（决定默认框架 Tab）
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TargetKind {
    /// 爬虫目标（URL）
    Crawler,
    /// 渗透目标（IP/主机）
    Pentest,
    /// 逆向目标（文件路径/URL）
    Reverse,
    /// 自动化目标（流程 URL）
    Automation,
    /// 网关目标（API 端点）
    Gateway,
    /// 通用目标
    General,
}

impl Default for TargetKind {
    fn default() -> Self {
        Self::General
    }
}

impl TargetKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Crawler => "crawler",
            Self::Pentest => "pentest",
            Self::Reverse => "reverse",
            Self::Automation => "automation",
            Self::Gateway => "gateway",
            Self::General => "general",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "crawler" => Some(Self::Crawler),
            "pentest" => Some(Self::Pentest),
            "reverse" => Some(Self::Reverse),
            "automation" => Some(Self::Automation),
            "gateway" => Some(Self::Gateway),
            "general" => Some(Self::General),
            _ => None,
        }
    }
}

// ============ 目标结构 ============

/// 单个攻防目标
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Target {
    /// 唯一 ID（uuid v4 简化版，时间戳 + 随机后缀）
    pub id: String,
    /// 显示名称
    pub name: String,
    /// 目标地址（URL / IP / 文件路径）
    pub address: String,
    /// 目标类型
    pub kind: TargetKind,
    /// 创建时间（Unix 毫秒）
    pub created_at: i64,
    /// 最后激活时间（Unix 毫秒）
    pub last_active_at: i64,
    /// 自由元数据（各框架可挂载自己的状态：扫描结果/符号表/策略等）
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
    /// 备注
    #[serde(default)]
    pub note: String,
    /// 标签（用于过滤）
    #[serde(default)]
    pub tags: Vec<String>,
}

impl Target {
    /// 创建新目标
    pub fn new(name: String, address: String, kind: TargetKind) -> Self {
        let ts = chrono::Utc::now().timestamp_millis();
        Self {
            id: format!(
                "t_{}_{}",
                ts,
                rand_suffix()
            ),
            name,
            address,
            kind,
            created_at: ts,
            last_active_at: ts,
            metadata: HashMap::new(),
            note: String::new(),
            tags: Vec::new(),
        }
    }
}

/// 简单随机后缀（不引入 uuid 依赖，6 位 alphanum）
fn rand_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut x = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    let chars: Vec<u8> = (b'a'..=b'z').chain(b'0'..=b'9').collect();
    let mut s = String::with_capacity(6);
    for _ in 0..6 {
        x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let idx = ((x >> 33) as usize) % chars.len();
        s.push(chars[idx] as char);
    }
    s
}

// ============ 工作区（目标列表 + 激活项） ============

/// 目标工作区
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Workspace {
    /// 所有目标
    pub targets: Vec<Target>,
    /// 当前激活目标 ID（null 表示未选中）
    pub active_id: Option<String>,
    /// 工作区版本（用于未来 schema 迁移）
    pub version: u32,
}

impl Workspace {
    /// 列出所有目标（按 last_active_at 倒序）
    pub fn list_sorted(&self) -> Vec<&Target> {
        let mut v: Vec<&Target> = self.targets.iter().collect();
        v.sort_by(|a, b| b.last_active_at.cmp(&a.last_active_at));
        v
    }

    /// 获取激活目标
    pub fn active(&self) -> Option<&Target> {
        self.active_id
            .as_ref()
            .and_then(|id| self.targets.iter().find(|t| &t.id == id))
    }

    /// 获取目标（by id）
    pub fn get(&self, id: &str) -> Option<&Target> {
        self.targets.iter().find(|t| t.id == id)
    }

    /// 获取目标（by id, mutable）
    pub fn get_mut(&mut self, id: &str) -> Option<&mut Target> {
        self.targets.iter_mut().find(|t| t.id == id)
    }

    /// 添加目标（返回新目标 ID）
    pub fn add(&mut self, target: Target) -> String {
        let id = target.id.clone();
        self.targets.push(target);
        self.active_id = Some(id.clone());
        id
    }

    /// 删除目标（同时清除 active_id 如果指向它）
    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.targets.len();
        self.targets.retain(|t| t.id != id);
        let removed = self.targets.len() < before;
        if removed {
            if let Some(aid) = &self.active_id {
                if aid == id {
                    self.active_id = self.targets.first().map(|t| t.id.clone());
                }
            }
        }
        removed
    }

    /// 激活目标（更新 last_active_at）
    pub fn activate(&mut self, id: &str) -> bool {
        if let Some(t) = self.get_mut(id) {
            t.last_active_at = chrono::Utc::now().timestamp_millis();
            self.active_id = Some(id.to_string());
            true
        } else {
            false
        }
    }

    /// 更新目标元数据字段
    pub fn set_metadata(&mut self, id: &str, key: &str, value: serde_json::Value) -> bool {
        if let Some(t) = self.get_mut(id) {
            t.metadata.insert(key.to_string(), value);
            t.last_active_at = chrono::Utc::now().timestamp_millis();
            true
        } else {
            false
        }
    }
}

// ============ 持久化 ============

/// 工作区文件路径：app_data_dir/gongfang_targets.json
fn workspace_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {}", e))?;
    Ok(dir.join("gongfang_targets.json"))
}

/// 加载工作区（文件不存在时返回空工作区）
pub fn load(app: &AppHandle) -> Workspace {
    let path = match workspace_path(app) {
        Ok(p) => p,
        Err(_) => return Workspace::default(),
    };
    if !path.exists() {
        return Workspace::default();
    }
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return Workspace::default(),
    };
    serde_json::from_str(&text).unwrap_or_default()
}

/// 保存工作区（原子写入：先写临时文件再 rename，避免损坏）
pub fn save(app: &AppHandle, ws: &Workspace) -> Result<(), String> {
    let path = workspace_path(app)?;
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(ws).map_err(|e| format!("序列化失败: {}", e))?;
    std::fs::write(&tmp, text).map_err(|e| format!("写入临时文件失败: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("重命名失败: {}", e))?;
    Ok(())
}
