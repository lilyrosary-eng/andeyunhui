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
