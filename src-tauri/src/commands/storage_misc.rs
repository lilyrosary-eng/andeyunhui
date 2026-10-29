//! 目录列举、黑名单、插件持久化存储
//!
//! 本文件由 commands.rs 拆分而来（2026-10-18，P1-5 拆 god file）。
//! 约定：用 `use super::*;` 取父模块的 use 与同级 item，不要在子模块里重复 import
//! 父模块已有的依赖；确需额外 import 时写显式路径（显式优先于 glob，不会冲突）。

#![allow(dead_code)] // 部分命令仅在特定平台/配置下被 invoke_handler 引用

use super::*;
// ================= IDE 项目目录文件列表 =================

#[derive(Debug, Clone, serde::Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[tauri::command]
pub fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| format!("读取目录失败: {}", e))?;
    let mut result: Vec<DirEntry> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = p.is_dir();
        // 跳过隐藏文件/文件夹
        if name.starts_with('.') { continue; }
        result.push(DirEntry { name, path: p.to_string_lossy().to_string(), is_dir });
    }
    result.sort_by(|a, b| {
        if a.is_dir != b.is_dir { b.is_dir.cmp(&a.is_dir) }
        else { a.name.to_lowercase().cmp(&b.name.to_lowercase()) }
    });
    Ok(result)
}

// 确保目录存在（IDE 自主编辑「记忆/原则」文件夹自动创建用）
#[tauri::command]
pub fn ensure_directory(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("创建目录失败: {}", e))
}

// ================= 内容黑名单管理（统一管理图库/音乐/视频的被屏蔽文件夹） =================

/// 黑名单条目
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BlacklistEntry {
    pub path: String,           // 文件夹路径
    pub module: String,         // 所属模块: "image" | "music" | "video"
    pub display_name: String,   // 显示名称（文件夹名）
    pub blocked_at: String,     // 屏蔽时间
}

/// 获取指定模块的黑名单（get_blacklist_paths 内部调用；原命令壳已删——前端只消费 paths 版本）
pub fn get_blacklist(app: tauri::AppHandle, module: String) -> Result<Vec<BlacklistEntry>, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let blacklist_path = app_data.join("content_blacklist.json");
    
    if !blacklist_path.exists() {
        return Ok(Vec::new());
    }
    
    let content = std::fs::read_to_string(&blacklist_path)
        .map_err(|e| format!("读取黑名单失败: {}", e))?;
    
    let all_entries: Vec<BlacklistEntry> = serde_json::from_str(&content)
        .map_err(|e| format!("解析黑名单失败: {}", e))?;
    
    // 按模块筛选
    let filtered: Vec<BlacklistEntry> = all_entries
        .into_iter()
        .filter(|e| e.module == module)
        .collect();
    
    Ok(filtered)
}

/// 获取所有模块的黑名单（用于全局管理）
#[tauri::command]
pub fn get_all_blacklist(app: tauri::AppHandle) -> Result<Vec<BlacklistEntry>, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let blacklist_path = app_data.join("content_blacklist.json");
    
    if !blacklist_path.exists() {
        return Ok(Vec::new());
    }
    
    let content = std::fs::read_to_string(&blacklist_path)
        .map_err(|e| format!("读取黑名单失败: {}", e))?;
    
    serde_json::from_str(&content).map_err(|e| format!("解析黑名单失败: {}", e))
}

/// 添加条目到黑名单
#[tauri::command]
pub fn add_to_blacklist(app: tauri::AppHandle, module: String, path: String, display_name: String) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let blacklist_path = app_data.join("content_blacklist.json");
    
    let mut entries: Vec<BlacklistEntry> = if blacklist_path.exists() {
        let content = std::fs::read_to_string(&blacklist_path)
            .map_err(|e| format!("读取黑名单失败: {}", e))?;
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        Vec::new()
    };
    
    // 去重
    if !entries.iter().any(|e| e.path == path && e.module == module) {
        entries.push(BlacklistEntry {
            path,
            module,
            display_name,
            blocked_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        });
    }
    
    let content = serde_json::to_string_pretty(&entries)
        .map_err(|e| format!("序列化黑名单失败: {}", e))?;
    std::fs::write(&blacklist_path, content)
        .map_err(|e| format!("写入黑名单失败: {}", e))?;
    
    Ok(())
}

/// 从黑名单移除条目（恢复显示）
#[tauri::command]
pub fn remove_from_blacklist(app: tauri::AppHandle, module: String, path: String) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let blacklist_path = app_data.join("content_blacklist.json");
    
    if !blacklist_path.exists() {
        return Ok(());
    }
    
    let content = std::fs::read_to_string(&blacklist_path)
        .map_err(|e| format!("读取黑名单失败: {}", e))?;
    let mut entries: Vec<BlacklistEntry> = serde_json::from_str(&content)
        .map_err(|e| format!("解析黑名单失败: {}", e))?;
    
    entries.retain(|e| !(e.path == path && e.module == module));
    
    let content = serde_json::to_string_pretty(&entries)
        .map_err(|e| format!("序列化黑名单失败: {}", e))?;
    std::fs::write(&blacklist_path, content)
        .map_err(|e| format!("写入黑名单失败: {}", e))?;
    
    Ok(())
}

/// 获取指定模块的黑名单路径集合（前端过滤器用，返回仅路径的数组）
#[tauri::command]
pub fn get_blacklist_paths(app: tauri::AppHandle, module: String) -> Result<Vec<String>, String> {
    let entries = get_blacklist(app, module)?;
    Ok(entries.into_iter().map(|e| e.path).collect())
}

// ================= 插件持久化存储（plugin_storage_get/set）=================
// 每个插件一个 JSON 文档：<app_data>/plugin_storage/<plugin_id>.json。
// 供插件保存自身设置/状态（插件模板文档已承诺此 API）。plugin_id 由
// pluginSandbox 在转发时自动注入（防伪造其它插件的存储空间）。

pub(crate) fn plugin_storage_path(app: &tauri::AppHandle, plugin_id: &str) -> Result<std::path::PathBuf, String> {
    let safe: String = plugin_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    if safe.is_empty() {
        return Err("plugin_id 无效".to_string());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("plugin_storage");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建插件存储目录失败: {e}"))?;
    Ok(dir.join(format!("{safe}.json")))
}

pub(crate) fn read_plugin_doc(path: &std::path::Path) -> std::collections::HashMap<String, serde_json::Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 读取插件存储中某个 key 的值（不存在返回 None）
#[tauri::command]
pub fn plugin_storage_get(
    app: tauri::AppHandle,
    plugin_id: String,
    key: String,
) -> Result<Option<serde_json::Value>, String> {
    let path = plugin_storage_path(&app, &plugin_id)?;
    let doc = read_plugin_doc(&path);
    Ok(doc.get(&key).cloned())
}

/// 写入插件存储的某个 key（整文档原子写：临时文件 + rename）
#[tauri::command]
pub fn plugin_storage_set(
    app: tauri::AppHandle,
    plugin_id: String,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let path = plugin_storage_path(&app, &plugin_id)?;
    let mut doc = read_plugin_doc(&path);
    doc.insert(key, value);
    let json = serde_json::to_string(&doc).map_err(|e| format!("序列化插件存储失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("写入插件存储失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("写入插件存储失败: {e}"))?;
    Ok(())
}

// ================= IDE 会话持久化（ide_session_*，2026-10-19） =================
//
// ## 为什么要搬出 localStorage
// IDE 的 Agent 会话此前存在 `localStorage['ide_session_<id>']`，为此定了三条硬限制：
//   - 单条 content 超 8KB 截断（长回答 / 代码 diff 直接被砍）
//   - 单会话超过 256KB 只保留首尾各 20 条（中间对话永久丢失）
//   - 最多 20 个会话，超出按时间删最旧的 body
// 且写入失败是 `catch { /* localStorage 满 */ }` —— 静默丢，用户看不到。
// 现在把**完整会话**落到 app_data/ide-sessions/<id>.json（原子写），localStorage 只留
// 截断版当"秒开缓存"：列表与轮转逻辑不变，打开会话时优先读后端拿到完整内容。
//
// 安全：id 只允许 [A-Za-z0-9_-]，杜绝 `../` 之类路径穿越；单文件上限 64MB。

/// 会话文件目录（不存在则创建）。
fn ide_session_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("ide-sessions");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 IDE 会话目录失败: {e}"))?;
    Ok(dir)
}

/// 校验会话 id 并返回文件名。非法 id 直接拒绝（不替换成下划线——那会让两个不同 id 撞同一文件）。
fn ide_session_path(app: &tauri::AppHandle, id: &str) -> Result<std::path::PathBuf, String> {
    if id.is_empty() || id.len() > 128 {
        return Err(format!("会话 id 非法（长度 {}）", id.len()));
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("会话 id 含非法字符（只允许 [A-Za-z0-9_-]）: {id}"));
    }
    Ok(ide_session_dir(app)?.join(format!("{id}.json")))
}

/// 单文件上限：64MB。超出说明调用方把整份会话反复拼接了，宁可直接报错也不要写爆磁盘。
const IDE_SESSION_MAX_BYTES: usize = 64 * 1024 * 1024;

/// 保存一个会话的完整 JSON（原子写：临时文件 + rename）。
#[tauri::command]
pub fn ide_session_save(app: tauri::AppHandle, id: String, body: String) -> Result<(), String> {
    if body.len() > IDE_SESSION_MAX_BYTES {
        let msg = format!(
            "IDE 会话过大：{} MB 超过 {} MB 上限（id={}）",
            body.len() / (1024 * 1024),
            IDE_SESSION_MAX_BYTES / (1024 * 1024),
            id
        );
        log::error!("[ide-session] {msg}");
        return Err(msg);
    }
    let path = ide_session_path(&app, &id)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body.as_bytes()).map_err(|e| format!("写入会话临时文件失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("重命名会话文件失败: {e}"))?;
    Ok(())
}

/// 读取会话完整 JSON；不存在返回 None（前端据此回落到 localStorage 缓存）。
#[tauri::command]
pub fn ide_session_load(app: tauri::AppHandle, id: String) -> Result<Option<String>, String> {
    let path = ide_session_path(&app, &id)?;
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("读取会话文件失败: {e}"))
}

/// 列出磁盘上所有会话 id（用于迁移与"清空全部"）。
#[tauri::command]
pub fn ide_session_list(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = ide_session_dir(&app)?;
    let mut ids = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("枚举会话目录失败: {e}"))?;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if let Some(id) = name.strip_suffix(".json") {
            ids.push(id.to_string());
        }
    }
    Ok(ids)
}

/// 删除一个会话文件（不存在视为成功）。
#[tauri::command]
pub fn ide_session_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path = ide_session_path(&app, &id)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => {
            log::warn!("[ide-session] 删除失败 id={} path={:?}: {}", id, path, e);
            Err(format!("删除会话文件失败: {e}"))
        }
    }
}

// ================= 工程快照（checkpoint_*，2026-10-20） =================
//
// 实现都在 services/checkpoint.rs（快照的存储布局、捕获、回滚、滚动淘汰）。
// 这里只做命令外壳 —— `#[tauri::command]` 生成的 `__cmd__*` 宏必须在 main.rs 能 glob 到的
// 模块里展开，写在 services 里 re-export 过不来（编译期会报 cannot find macro）。

/// 列出快照（前端「历史快照」面板用）。projectRoot 为空则列出全部项目的快照。
#[tauri::command]
pub fn checkpoint_list(project_root: Option<String>) -> Vec<crate::services::checkpoint::CheckpointMeta> {
    let pr = project_root
        .filter(|s| !s.trim().is_empty())
        .map(std::path::PathBuf::from);
    crate::services::checkpoint::list(pr.as_deref())
}

/// 回滚到指定快照：把该轮改过的文件写回改前内容，该轮新建的文件删除。
/// 返回 { restored, removed, skipped }（skipped = 当初因超限未备份、无法恢复的文件数）。
#[tauri::command]
pub fn checkpoint_rollback(project_root: String, id: String) -> Result<serde_json::Value, String> {
    let root = std::path::PathBuf::from(&project_root);
    let (restored, removed, skipped) = crate::services::checkpoint::rollback(&root, &id)?;
    Ok(serde_json::json!({
        "restored": restored,
        "removed": removed,
        "skipped": skipped,
    }))
}

// ================= 项目工作区 .adyh / .Talk =================
//
// 实现见 services/adyh_service.rs。这里只做命令外壳（命令宏必须在 main.rs 能 glob
// 到的模块里展开，services 里的 re-export 不参与宏解析）。

/// 首次任务建立 .adyh / .Talk。幂等，只补缺失文件。
#[tauri::command]
pub fn adyh_bootstrap(project_root: String) -> Result<serde_json::Value, String> {
    crate::services::adyh_service::bootstrap(std::path::Path::new(&project_root))
}

/// 工作区状态（是否已初始化、代号、会话数）。
#[tauri::command]
pub fn adyh_status(project_root: String) -> serde_json::Value {
    crate::services::adyh_service::status(std::path::Path::new(&project_root))
}

/// 读取内置默认提示词与用户自定义注入。
#[tauri::command]
pub fn adyh_prompt_get(app: tauri::AppHandle) -> serde_json::Value {
    crate::services::adyh_service::prompt_payload(&app)
}

/// 保存用户自定义注入（空串 = 只用内置默认）。新会话立即生效。
#[tauri::command]
pub fn adyh_prompt_set(app: tauri::AppHandle, custom: String) -> Result<(), String> {
    let mut g = crate::services::adyh_service::load_global(&app);
    g.custom_injection = custom;
    crate::services::adyh_service::save_global(&app, &g)
}

/// 读取项目会话库（.adyh/conversations）。
#[tauri::command]
pub fn adyh_conversations_load(project_root: String) -> serde_json::Value {
    crate::services::adyh_service::load_conversations(std::path::Path::new(&project_root))
}

/// 写入项目会话库（按会话目录 upsert，不删除未出现的会话）。
#[tauri::command]
pub fn adyh_conversations_save(
    project_root: String,
    payload: serde_json::Value,
) -> Result<usize, String> {
    crate::services::adyh_service::save_conversations(std::path::Path::new(&project_root), &payload)
}

/// 清空项目会话库（用户点「清空全部对话」）。
#[tauri::command]
pub fn adyh_conversations_clear(project_root: String) -> Result<usize, String> {
    crate::services::adyh_service::clear_conversations(std::path::Path::new(&project_root))
}

/// 读取 .Talk 未读消息（不自动标记已读）。
#[tauri::command]
pub fn adyh_talk_unread(project_root: String, code: Option<String>) -> serde_json::Value {
    let root = std::path::Path::new(&project_root);
    let code = code.unwrap_or_else(|| crate::services::adyh_service::harness_code(root));
    let (text, latest) = crate::services::adyh_service::talk_unread(root, &code);
    serde_json::json!({ "text": text, "latest": latest })
}

/// 把游标推进到指定消息（只写自己的 _routing/<code>.json）。
#[tauri::command]
pub fn adyh_talk_mark_read(
    project_root: String,
    code: Option<String>,
    last_read: String,
) -> Result<(), String> {
    let root = std::path::Path::new(&project_root);
    let code = code.unwrap_or_else(|| crate::services::adyh_service::harness_code(root));
    crate::services::adyh_service::talk_mark_read(root, &code, &last_read)
}

/// 发一条 .Talk 消息（不可变文件）。
#[tauri::command]
pub fn adyh_talk_post(
    project_root: String,
    to: String,
    body: String,
    thread: Option<String>,
) -> Result<String, String> {
    crate::services::adyh_service::talk_post(
        std::path::Path::new(&project_root),
        &to,
        &body,
        thread.as_deref(),
    )
}
