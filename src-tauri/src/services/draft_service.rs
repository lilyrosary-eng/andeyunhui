//! 高危文件草稿区：AI 改动先落草稿，用户确认后才写回真实路径。
//!
//! 为什么只拦 AI 写入：
//! - 用户手动保存（IDE 编辑器 / 导出）是明确意图，直接生效；出事有安装基线 diff 与启动守卫兜。
//! - AI 写入是批量、不可预览的，高危文件（插件 manifest、插件入口、宿主核心文件）一旦写坏，
//!   轻则插件消失，重则主界面起不来，所以必须先审阅。
//!
//! 已知边界：AI 通过 `run_command` 用 shell 重定向写文件绕不过这里 ——
//! 那种情况只能靠安装基线 diff 事后发现、启动守卫保证能起来。
//!
//! 目录：`<AppData>/drafts/<id>/`
//!   - `meta.json`  目标绝对路径 / 来源 / 类型 / 时间
//!   - `content`    草稿内容
//!   - `before`     首次暂存时的原文件副本（应用前想反悔可用）

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 高危类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtectKind {
    /// 插件 manifest.json：写坏 = 插件直接消失
    Manifest,
    /// 插件 manifest 声明的入口脚本：写坏 = 插件加载失败
    Entry,
    /// 宿主核心文件：写坏 = 主界面可能起不来
    HostCore,
}

impl ProtectKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ProtectKind::Manifest => "manifest",
            ProtectKind::Entry => "entry",
            ProtectKind::HostCore => "host-core",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ProtectKind::Manifest => "插件清单",
            ProtectKind::Entry => "插件入口",
            ProtectKind::HostCore => "宿主核心文件",
        }
    }
}

/// 宿主核心文件：按路径尾部片段匹配（只在 AI 写入时判定）。
const HOST_CORE_SUFFIXES: &[&str] = &[
    "src-tauri/src/main.rs",
    "src-tauri/tauri.conf.json",
    "src-tauri/Cargo.toml",
    "src/App.tsx",
    "src/core/PluginHost.tsx",
    "src/core/pluginRegistry.ts",
    "src/core/pluginSandbox.ts",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftMeta {
    pub id: String,
    /// 目标绝对路径
    pub path: String,
    /// 所属插件（宿主核心文件为 None）
    pub plugin_id: Option<String>,
    /// manifest | entry | host-core
    pub kind: String,
    /// ai | user
    pub source: String,
    pub session_id: String,
    pub created_at: u64,
    pub size: u64,
    /// 目标文件当前是否存在（UI 里区分"新建"与"覆盖"）
    pub target_exists: bool,
}

/// 判定是否为高危写入；None = 普通文件，照旧直写。
pub fn classify(abs: &Path) -> Option<ProtectKind> {
    let file = abs.file_name()?.to_str()?;

    if file == "manifest.json" {
        // 只拦「插件清单」，别误伤工作区里第三方包的 manifest.json：
        // 路径在插件树内，或现有内容确实是插件清单（含 kind / hostApiVersion）。
        let norm = abs.to_string_lossy().replace('\\', "/");
        let in_plugin_tree = norm.contains("/plugins/")
            || norm.contains("/bundled-plugins/")
            || norm.contains("/user_plugins/");
        let is_plugin_manifest = std::fs::read_to_string(abs)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .map(|v| v.get("hostApiVersion").is_some() || v.get("kind").is_some())
            .unwrap_or(false);
        if in_plugin_tree || is_plugin_manifest {
            return Some(ProtectKind::Manifest);
        }
    }

    // 插件入口：父目录的 manifest.json 声明的 entry 正好是它
    if let Some(parent) = abs.parent() {
        if let Ok(text) = std::fs::read_to_string(parent.join("manifest.json")) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if v.get("entry").and_then(|x| x.as_str()) == Some(file) {
                    return Some(ProtectKind::Entry);
                }
            }
        }
    }

    let norm = abs.to_string_lossy().replace('\\', "/");
    if HOST_CORE_SUFFIXES.iter().any(|s| norm.ends_with(s)) {
        return Some(ProtectKind::HostCore);
    }
    None
}

// ================= 存储 =================

fn drafts_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 app_data_dir 失败: {e}"))?
        .join("drafts");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建草稿目录失败: {e}"))?;
    Ok(dir)
}

fn meta_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(drafts_root(app)?.join(sanitize_id(id)?).join("meta.json"))
}

fn content_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(drafts_root(app)?.join(sanitize_id(id)?).join("content"))
}

fn before_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(drafts_root(app)?.join(sanitize_id(id)?).join("before"))
}

fn sanitize_id(id: &str) -> Result<String, String> {
    if id.is_empty() || id.contains("..") || id.contains('/') || id.contains('\\') {
        return Err(format!("非法草稿 id: {id}"));
    }
    Ok(id.to_string())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 同一目标路径恒定同一个草稿 id：重复暂存只覆盖内容，`before` 保留最早的原始版本。
fn draft_id(abs: &Path) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in abs.to_string_lossy().as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    format!("d_{h:016x}")
}

fn infer_plugin_id(abs: &Path) -> Option<String> {
    let mut dir = abs.parent();
    while let Some(d) = dir {
        let mf = d.join("manifest.json");
        if mf.is_file() {
            return std::fs::read_to_string(mf)
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|v| v.get("id").and_then(|x| x.as_str()).map(|s| s.to_string()));
        }
        dir = d.parent();
    }
    None
}

fn read_meta(app: &AppHandle, id: &str) -> Option<DraftMeta> {
    let text = std::fs::read_to_string(meta_path(app, id).ok()?).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_meta(app: &AppHandle, meta: &DraftMeta) -> Result<(), String> {
    let path = meta_path(app, &meta.id)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建草稿目录失败: {e}"))?;
    }
    let json = serde_json::to_string_pretty(meta).map_err(|e| format!("序列化草稿失败: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("写入草稿元数据失败: {e}"))
}

// ================= 暂存 / 读取 =================

/// 把内容暂存为草稿（同路径覆盖），返回元数据。
pub fn stage(
    app: &AppHandle,
    abs: &Path,
    content: &str,
    source: &str,
    session_id: &str,
    kind: ProtectKind,
) -> Result<DraftMeta, String> {
    let id = draft_id(abs);
    let dir = drafts_root(app)?.join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建草稿目录失败: {e}"))?;

    // 首次暂存时留一份原文件，便于"应用前反悔"
    let before = dir.join("before");
    if !before.exists() && abs.is_file() {
        let _ = std::fs::copy(abs, &before);
    }

    let content_file = dir.join("content");
    let tmp = dir.join("content.tmp");
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| format!("写入草稿失败: {e}"))?;
    std::fs::rename(&tmp, &content_file).map_err(|e| format!("替换草稿失败: {e}"))?;

    let meta = DraftMeta {
        id,
        path: abs.to_string_lossy().to_string(),
        plugin_id: infer_plugin_id(abs),
        kind: kind.as_str().to_string(),
        source: source.to_string(),
        session_id: session_id.to_string(),
        created_at: now_secs(),
        size: content.len() as u64,
        target_exists: abs.is_file(),
    };
    write_meta(app, &meta)?;
    Ok(meta)
}

/// 读草稿内容（用于"AI 连续编辑同一文件"时基于草稿继续改）。
pub fn read_overlay(app: &AppHandle, abs: &Path) -> Option<String> {
    let id = draft_id(abs);
    let p = content_path(app, &id).ok()?;
    std::fs::read_to_string(p).ok()
}

/// 某路径是否已有草稿。
pub fn has_draft(app: &AppHandle, abs: &Path) -> bool {
    read_meta(app, &draft_id(abs)).is_some()
}

/// 列出草稿；`plugin_id` 为 Some 时只列该插件的。
pub fn list(app: &AppHandle, plugin_id: Option<&str>) -> Vec<DraftMeta> {
    let Ok(root) = drafts_root(app) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in entries.filter_map(|x| x.ok()) {
        if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let id = e.file_name().to_string_lossy().to_string();
        let Some(meta) = read_meta(app, &id) else {
            continue;
        };
        if let Some(want) = plugin_id {
            if meta.plugin_id.as_deref() != Some(want) {
                continue;
            }
        }
        out.push(meta);
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

pub fn read(app: &AppHandle, id: &str) -> Result<String, String> {
    let p = content_path(app, id)?;
    std::fs::read_to_string(p).map_err(|e| format!("读取草稿失败: {e}"))
}

/// 草稿 vs 当前磁盘内容的 unified diff。
pub fn diff(app: &AppHandle, id: &str) -> Result<String, String> {
    let meta = read_meta(app, id).ok_or_else(|| format!("草稿不存在: {id}"))?;
    let draft = read(app, id)?;
    let live = std::fs::read(&meta.path)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default();
    if draft == live {
        return Ok(String::new());
    }
    let d = similar::TextDiff::from_lines(&live, &draft);
    Ok(d
        .unified_diff()
        .context_radius(3)
        .header(&format!("a/{}", short_name(&meta.path)), &format!("b/{}", short_name(&meta.path)))
        .to_string())
}

fn short_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

// ================= 应用 / 丢弃 =================

/// 把草稿原子写回真实路径，并删除草稿。返回被写入的绝对路径。
pub fn apply(app: &AppHandle, id: &str) -> Result<DraftMeta, String> {
    let meta = read_meta(app, id).ok_or_else(|| format!("草稿不存在: {id}"))?;
    let content = read(app, id)?;
    let target = PathBuf::from(&meta.path);

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    // 原子替换：半截写入比不写更糟
    let tmp = target.with_extension(format!(
        "{}.draft.tmp",
        target.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| format!("写入失败: {e}"))?;
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("替换失败: {e}")
    })?;

    let _ = std::fs::remove_dir_all(drafts_root(app)?.join(sanitize_id(id)?));
    Ok(meta)
}

/// 丢弃草稿（真实文件不受影响）。
pub fn discard(app: &AppHandle, id: &str) -> Result<(), String> {
    let dir = drafts_root(app)?.join(sanitize_id(id)?);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("删除草稿失败: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_rejects_traversal() {
        assert!(sanitize_id("d_abc").is_ok());
        assert!(sanitize_id("../x").is_err());
        assert!(sanitize_id("a/b").is_err());
    }

    #[test]
    fn same_path_gets_same_draft_id() {
        let a = draft_id(Path::new("C:/x/y/index.js"));
        let b = draft_id(Path::new("C:/x/y/index.js"));
        let c = draft_id(Path::new("C:/x/z/index.js"));
        assert_eq!(a, b);
        assert_ne!(a, c);
    }
}
