//! 插件能力模型（替代“逐命令全局白名单”）
//!
//! 三个部分：
//! 1. 命令 → 能力规则：一条命令属于哪一类能力（精确表 + 前缀族），新增命令只需补一条规则；
//! 2. 授权账本 `plugin_grants.json`：记录某插件被批准的能力（内置插件自动批准）；
//! 3. 写入范围校验：插件通过 `pluginId` 标识自己，写/删/下载只允许落在授权根内
//!    （AppData、安装资源、插件自身目录、授权追加根、以及对话框里用户亲手指过的路径）。
//!
//! 边界说明（与 dsh 一致的口径）：这不是恶意代码沙箱，而是“API 纪律 + 效果层范围校验”。
//! 插件的 JS 与宿主同进程；真正阻止越权的是这里的路径/能力检查。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// 可授予的能力清单（`plugins.admin` 永远只给宿主，不参与授权）。
pub const CAPABILITIES: &[&str] = &[
    "storage",
    "fs.read",
    "fs.write",
    "fs.pick",
    "media",
    "net",
    "clipboard.read",
    "clipboard.write",
    "window",
    "system",
    "ai",
    "data",
    "attack",
];

/// 精确规则（先于前缀规则匹配）
const EXACT_RULES: &[(&str, &str)] = &[
    // ---- 存储 ----
    ("plugin_storage_get", "storage"),
    ("plugin_storage_set", "storage"),
    // ---- 文件读取 ----
    ("read_file_base64", "fs.read"),
    ("read_text_file", "fs.read"),
    ("read_plugin_file", "fs.read"),
    ("read_external_dep_file", "fs.read"),
    ("read_external_dep_path", "fs.read"),
    ("read_manifest", "fs.read"),
    ("check_file_exists", "fs.read"),
    ("list_directory", "fs.read"),
    ("get_folder_images", "fs.read"),
    ("get_folder_videos", "fs.read"),
    ("get_dir_mtime", "fs.read"),
    ("load_image_cache", "fs.read"),
    ("load_music_cache", "fs.read"),
    ("load_video_cache", "fs.read"),
    ("load_reading_cache", "fs.read"),
    ("read_track_metadata", "fs.read"),
    ("search_content", "fs.read"),
    ("sheet_read_xlsx", "fs.read"),
    ("open_book", "fs.read"),
    ("scan_image_root", "fs.read"),
    ("scan_music_root", "fs.read"),
    ("scan_video_root", "fs.read"),
    ("scan_reading_root", "fs.read"),
    ("cancel_scan", "fs.read"),
    ("cancel_open_book", "fs.read"),
    // ---- 文件写入 ----
    ("write_file_bytes", "fs.write"),
    ("write_text_file", "fs.write"),
    ("delete_file", "fs.write"),
    ("ensure_directory", "fs.write"),
    ("download_file", "fs.write"),
    ("download_hls", "fs.write"),
    ("download_video", "fs.write"),
    ("import_to_openwith_dir", "fs.write"),
    ("add_bytes_to_dropzone", "fs.write"),
    ("delete_image_cache", "fs.write"),
    ("delete_music_cache", "fs.write"),
    ("delete_video_cache", "fs.write"),
    ("cleanup_thumbnail_cache", "fs.write"),
    ("qishui_download_audio", "fs.write"),
    ("qishui_save_temp_audio", "fs.write"),
    ("transcode_media", "fs.write"),
    ("wps_export_docx", "fs.write"),
    ("wps_export_pptx", "fs.write"),
    ("wps_import_pptx", "fs.write"),
    ("wps_import_pptx_diagnose", "fs.write"),
    // ---- 用户选择（对话框） ----
    ("pick_file", "fs.pick"),
    ("pick_directory", "fs.pick"),
    ("pick_save_file", "fs.pick"),
    ("plugin:dialog|save", "fs.pick"),
    ("plugin:dialog|open", "fs.pick"),
    // ---- 剪贴板 ----
    ("clipboard_read", "clipboard.read"),
    ("clipboard_poll_image", "clipboard.read"),
    ("clipboard_write", "clipboard.write"),
    ("clipboard_write_image", "clipboard.write"),
    ("clipboard_write_image_from_path", "clipboard.write"),
    ("clipboard_clear", "clipboard.write"),
    // ---- 媒体 ----
    ("generate_thumbnail", "media"),
    ("convert_image", "media"),
    ("convert_bytes_to_markdown", "media"),
    ("convert_document", "media"),
    ("convert_to_markdown", "media"),
    ("media_http_url", "media"),
    ("audio_to_midi", "media"),
    ("save_track_lyrics", "media"),
    ("get_lyrics", "media"),
    ("get_lyrics_text", "media"),
    ("spectrum_set_listener", "media"),
    // ---- 网络 ----
    ("netease_http_post", "net"),
    ("netease_register_guest", "net"),
    ("kugou_http_post", "net"),
    ("qishui_http_post", "net"),
    ("bilibili_request", "net"),
    // ---- 窗口 / 浮层 ----
    ("show_lyrics_widget", "window"),
    ("hide_lyrics_widget", "window"),
    ("set_lyrics_widget_locked", "window"),
    ("get_lyrics_widget_locked", "window"),
    ("get_lyrics_widget_visible", "window"),
    ("smtc_update", "window"),
    ("smtc_status", "window"),
    ("overlay_window_destroy", "window"),
    ("browser_open", "window"),
    ("browser_close", "window"),
    ("browser_set_bounds", "window"),
    ("browser_sniff", "window"),
    ("set_window_hidden", "window"),
    ("set_active_module", "window"),
    // ---- 系统 ----
    ("scan_ports", "system"),
    ("list_processes", "system"),
    ("get_env_vars", "system"),
    ("set_env_var", "system"),
    ("get_system_memory", "system"),
    ("debug_log", "system"),
    ("debug_flags", "system"),
    ("check_ffmpeg", "system"),
    ("run_shell_command", "system"),
    ("sheet_calc", "data"),
    // ---- 数据 / 配置 ----
    ("get_blacklist_paths", "data"),
    ("add_to_blacklist", "data"),
    ("remove_from_blacklist", "data"),
];

/// 前缀规则（族级）
const PREFIX_RULES: &[(&str, &str)] = &[
    ("plugin_storage_", "storage"),
    ("read_", "fs.read"),
    ("load_", "fs.read"),
    ("scan_", "fs.read"),
    ("list_", "fs.read"),
    ("get_folder_", "fs.read"),
    ("write_", "fs.write"),
    ("delete_", "fs.write"),
    ("download_", "fs.write"),
    ("ensure_", "fs.write"),
    ("pick_", "fs.pick"),
    ("plugin:dialog|", "fs.pick"),
    ("clipboard_write", "clipboard.write"),
    ("clipboard_read", "clipboard.read"),
    ("clipboard_poll", "clipboard.read"),
    ("browser_", "window"),
    ("smtc_", "window"),
    ("show_", "window"),
    ("hide_", "window"),
    ("convert_", "media"),
    ("audio_", "media"),
    ("spectrum_", "media"),
    ("netease_", "net"),
    ("kugou_", "net"),
    ("qishui_", "net"),
    ("bilibili_", "net"),
    ("music_", "data"),
    ("ide_session_", "data"),
    ("sheet_", "data"),
    ("wps_", "data"),
    ("git_", "system"),
    ("pty_", "system"),
    ("lsp_", "system"),
    ("mcp_", "ai"),
    ("ai_", "ai"),
    ("rag_", "ai"),
    ("gongfang_", "attack"),
    ("plugin:", "system"),
];

/// 命令 → 能力。未命中 = 未归类（宿主拒绝，提示补规则）。
pub fn capability_for(command: &str) -> Option<&'static str> {
    if let Some((_, cap)) = EXACT_RULES.iter().find(|(cmd, _)| *cmd == command) {
        return Some(cap);
    }
    if let Some((_, cap)) = PREFIX_RULES
        .iter()
        .find(|(prefix, _)| command.starts_with(prefix))
    {
        return Some(cap);
    }
    None
}

#[derive(Serialize)]
pub struct CapabilityRules {
    exact: Vec<(String, String)>,
    prefix: Vec<(String, String)>,
    capabilities: Vec<String>,
}

/// 返回规则表给前端沙箱（数据驱动，前端不再维护命令白名单）。
#[tauri::command]
pub fn plugin_capability_rules() -> CapabilityRules {
    CapabilityRules {
        exact: EXACT_RULES
            .iter()
            .map(|(c, cap)| (c.to_string(), cap.to_string()))
            .collect(),
        prefix: PREFIX_RULES
            .iter()
            .map(|(p, cap)| (p.to_string(), cap.to_string()))
            .collect(),
        capabilities: CAPABILITIES.iter().map(|s| s.to_string()).collect(),
    }
}

// ===== 授权账本 =====

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GrantScopes {
    pub fs_read: Vec<String>,
    pub fs_write: Vec<String>,
    pub net: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PluginGrant {
    pub capabilities: Vec<String>,
    pub trusted_dev: bool,
    pub manifest_hash: String,
    pub updated_at: u64,
    pub scopes: GrantScopes,
}

const GRANTS_FILENAME: &str = "plugin_grants.json";
static GRANTS_LOCK: Mutex<()> = Mutex::new(());
/// 对话框里用户亲手选过的路径（按插件记，进程内有效）
static PICKED_PATHS: Mutex<Option<HashMap<String, Vec<PathBuf>>>> = Mutex::new(None);

fn grants_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(GRANTS_FILENAME))
}

pub fn load_grants(app: &AppHandle) -> HashMap<String, PluginGrant> {
    let Ok(path) = grants_path(app) else {
        return HashMap::new();
    };
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<HashMap<String, PluginGrant>>(&s).ok())
        .unwrap_or_default()
}

fn save_grants(app: &AppHandle, grants: &HashMap<String, PluginGrant>) -> Result<(), String> {
    let path = grants_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    let json = serde_json::to_string_pretty(grants).map_err(|e| format!("序列化授权失败: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("写入授权失败: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("写入授权失败: {}", e))
}

#[tauri::command]
pub fn plugin_grants_all(app: AppHandle) -> Result<HashMap<String, PluginGrant>, String> {
    Ok(load_grants(&app))
}

/// 写入/更新一个插件的授权。capabilities 只保留已知能力；未知项记日志后丢弃。
#[tauri::command]
pub fn plugin_grant_set(
    app: AppHandle,
    plugin_id: String,
    capabilities: Vec<String>,
    trusted_dev: bool,
    manifest_hash: String,
    scopes: Option<GrantScopes>,
) -> Result<PluginGrant, String> {
    let _guard = GRANTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut grants = load_grants(&app);
    let known: Vec<String> = capabilities
        .into_iter()
        .filter(|c| {
            let ok = CAPABILITIES.contains(&c.as_str());
            if !ok {
                log::warn!("[plugin-access] 忽略未知能力: {}", c);
            }
            ok
        })
        .collect();
    let grant = PluginGrant {
        capabilities: known,
        trusted_dev,
        manifest_hash,
        updated_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        scopes: scopes.unwrap_or_default(),
    };
    grants.insert(plugin_id.clone(), grant.clone());
    save_grants(&app, &grants)?;
    log::info!(
        "[plugin-access] 已授权 {}：capabilities={:?} trusted_dev={}",
        plugin_id,
        grant.capabilities,
        grant.trusted_dev
    );
    Ok(grant)
}

#[tauri::command]
pub fn plugin_grant_clear(app: AppHandle, plugin_id: String) -> Result<(), String> {
    let _guard = GRANTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut grants = load_grants(&app);
    if grants.remove(&plugin_id).is_some() {
        save_grants(&app, &grants)?;
    }
    if let Ok(mut guard) = PICKED_PATHS.lock() {
        if let Some(map) = guard.as_mut() {
            map.remove(&plugin_id);
        }
    }
    Ok(())
}

/// 删除插件时清掉授权与临时路径（由 delete_plugin 调用）。
pub fn clear_plugin_access(app: &AppHandle, plugin_id: &str) {
    let _guard = GRANTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut grants = load_grants(app);
    if grants.remove(plugin_id).is_some() {
        let _ = save_grants(app, &grants);
    }
    if let Ok(mut guard) = PICKED_PATHS.lock() {
        if let Some(map) = guard.as_mut() {
            map.remove(plugin_id);
        }
    }
}

/// 记录对话框里用户亲手选中的路径（写入范围白名单，进程内有效）。
pub fn record_picked_path(app: &AppHandle, plugin_id: Option<&str>, path: &str) {
    let Some(pid) = plugin_id.filter(|s| !s.is_empty()) else {
        return;
    };
    if path.is_empty() {
        return;
    }
    let mut guard = match PICKED_PATHS.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    let map = guard.get_or_insert_with(HashMap::new);
    let entry = map.entry(pid.to_string()).or_default();
    let p = PathBuf::from(path);
    // 保存对话框返回的是“目标文件路径”，记录其父目录；目录选择记录自身。
    let record = if p.is_dir() {
        p
    } else {
        p.parent().map(|x| x.to_path_buf()).unwrap_or(p)
    };
    if !entry.iter().any(|x| x == &record) {
        entry.push(record.clone());
        if entry.len() > 128 {
            entry.remove(0);
        }
    }
    // 持久化到账本：第三方插件重启后仍可写用户选过的目录；没授权过的不记录。
    {
        let _guard = GRANTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut grants = load_grants(app);
        if let Some(grant) = grants.get_mut(pid) {
            let s = record.to_string_lossy().to_string();
            if !grant.scopes.fs_write.iter().any(|x| x == &s) {
                grant.scopes.fs_write.push(s);
                if grant.scopes.fs_write.len() > 64 {
                    grant.scopes.fs_write.remove(0);
                }
                let _ = save_grants(app, &grants);
            }
        }
    }
}

fn canonical_existing_ancestor(path: &Path) -> PathBuf {
    let mut cur = path.to_path_buf();
    loop {
        if cur.exists() {
            return std::fs::canonicalize(&cur).unwrap_or(cur);
        }
        if !cur.pop() {
            return cur;
        }
    }
}

fn is_within(root: &Path, target: &Path) -> bool {
    let r = canonical_existing_ancestor(root);
    let t = canonical_existing_ancestor(target);
    t.starts_with(&r)
}

/// 插件的写/删/下载目标是否允许。`plugin_id` 为空 = 宿主自身调用，放行。
pub fn ensure_plugin_write(
    app: &AppHandle,
    plugin_id: Option<&str>,
    target: &str,
) -> Result<(), String> {
    let Some(pid) = plugin_id.filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    let grants = load_grants(app);
    let Some(grant) = grants.get(pid) else {
        return Err(format!(
            "插件 \"{pid}\" 尚未授权任何能力，不能写入文件（请在 设置 → 扩展 中授权）"
        ));
    };
    if grant.trusted_dev {
        return Ok(());
    }
    if !grant.capabilities.iter().any(|c| c == "fs.write") {
        return Err(format!(
            "插件 \"{pid}\" 缺少 fs.write 能力，不能写入文件（请重新授权）"
        ));
    }
    let target_path = Path::new(target);
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(d) = app.path().app_data_dir() {
        roots.push(d);
    }
    if let Ok(d) = app.path().resource_dir() {
        roots.push(d);
    }
    if let Ok(dir) = crate::commands::plugins::find_plugin_root(app, pid) {
        // 内置插件随包出厂、随应用签名发布，视为可信；第三方才做写入范围校验。
        if crate::commands::plugins::is_bundled_plugin_dir(app, &dir) {
            return Ok(());
        }
        roots.push(dir);
    }
    for r in grant
        .scopes
        .fs_write
        .iter()
        .chain(grant.scopes.fs_read.iter())
        .filter(|s| !s.is_empty())
    {
        roots.push(PathBuf::from(r));
    }
    if let Ok(guard) = PICKED_PATHS.lock() {
        if let Some(map) = guard.as_ref() {
            if let Some(list) = map.get(pid) {
                roots.extend(list.iter().cloned());
            }
        }
    }
    if roots.iter().any(|r| is_within(r, target_path)) {
        return Ok(());
    }
    Err(format!(
        "插件 \"{pid}\" 越界写入被拒绝: {} —— 只允许写 AppData / 安装资源 / 插件目录 / 用户在选择框里选过的路径；\
         如需其他目录，请在插件里通过 pick_save_file / pick_directory 让用户选择",
        target
    ))
}


#[cfg(test)]
mod tests {
    use super::*;

    /// 插件源码里声明过的每一条命令都必须能归到某个能力，否则它会莫名其妙被拒。
    #[test]
    fn every_plugin_manifest_command_maps_to_capability() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("plugins");
        if !root.exists() {
            return;
        }
        let mut missing: Vec<String> = Vec::new();
        fn walk(dir: &Path, missing: &mut Vec<String>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, missing);
                } else if p.file_name().and_then(|s| s.to_str()) == Some("manifest.json") {
                    let Ok(text) = std::fs::read_to_string(&p) else { continue };
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                    if let Some(cmds) = v
                        .get("permissions")
                        .and_then(|x| x.get("commands"))
                        .and_then(|x| x.as_array())
                    {
                        for c in cmds {
                            if let Some(name) = c.as_str() {
                                if capability_for(name).is_none() {
                                    missing.push(format!("{}: {}", p.display(), name));
                                }
                            }
                        }
                    }
                }
            }
        }
        walk(&root, &mut missing);
        assert!(
            missing.is_empty(),
            "以下插件命令没有能力归类:
{}",
            missing.join("
")
        );
    }

    #[test]
    fn known_commands_resolve() {
        assert_eq!(capability_for("generate_thumbnail"), Some("media"));
        assert_eq!(capability_for("music_set_favorite"), Some("data"));
        assert_eq!(capability_for("read_file_base64"), Some("fs.read"));
        assert_eq!(capability_for("write_file_bytes"), Some("fs.write"));
        assert_eq!(capability_for("gongfang_scan"), Some("attack"));
        assert_eq!(capability_for("no_such_command_xyz"), None);
    }
}
