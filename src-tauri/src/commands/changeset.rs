//! 安装基线变更集命令外壳（实现见 `services/changeset_service.rs`）。
//!
//! 这一层是**额外**的只读对照：回答「从下载到现在改了什么」。
//! AI 编程自带的会话回退 / 审阅 / 变更展示不走这里，互不影响。

use std::path::PathBuf;
use tauri::AppHandle;

use crate::services::changeset_service::{self as cs, Summary};

/// 插件根目录 + manifest 版本号。
fn locate(app: &AppHandle, plugin_id: &str) -> Result<(PathBuf, String), String> {
    let dir = crate::commands::plugins::find_plugin_root(app, plugin_id)?;
    let version = std::fs::read_to_string(dir.join("manifest.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("version").and_then(|x| x.as_str()).map(|s| s.to_string()))
        .unwrap_or_default();
    Ok((dir, version))
}

/// 变更总览。首次调用会自动建立「下载时版本」的基线。
#[tauri::command]
pub fn changeset_summary(app: AppHandle, plugin_id: String) -> Result<Summary, String> {
    let (dir, version) = locate(&app, &plugin_id)?;
    cs::ensure_baseline(&app, &plugin_id, &dir, &version);
    cs::scan_changes(&app, &plugin_id, &dir)
}

/// 单文件 unified diff（前端按 + / - / @@ 着色）。
#[tauri::command]
pub fn changeset_diff(app: AppHandle, plugin_id: String, path: String) -> Result<String, String> {
    let (dir, _) = locate(&app, &plugin_id)?;
    cs::diff_file(&app, &plugin_id, &dir, &path)
}

/// 单文件恢复到安装版本；新增文件会被删除。返回是否真的改了磁盘。
#[tauri::command]
pub fn changeset_restore_file(app: AppHandle, plugin_id: String, path: String) -> Result<bool, String> {
    let (dir, _) = locate(&app, &plugin_id)?;
    cs::restore_file(&app, &plugin_id, &dir, &path)
}

/// 整插件恢复到安装版本，返回 { restored, removed }。
#[tauri::command]
pub fn changeset_restore_all(app: AppHandle, plugin_id: String) -> Result<serde_json::Value, String> {
    let (dir, _) = locate(&app, &plugin_id)?;
    let (restored, removed) = cs::restore_all(&app, &plugin_id, &dir)?;
    Ok(serde_json::json!({ "restored": restored, "removed": removed }))
}

/// 放弃安装基线对照：以当前文件为新基线（用户确认"这些改动我都认了"）。
#[tauri::command]
pub fn changeset_reset_baseline(app: AppHandle, plugin_id: String) -> Result<(), String> {
    let (dir, version) = locate(&app, &plugin_id)?;
    cs::reset_baseline(&app, &plugin_id, &dir, &version)
}

/// 导出统一 patch 到导出目录，返回文件路径。
#[tauri::command]
pub fn changeset_export_patch(app: AppHandle, plugin_id: String) -> Result<String, String> {
    let (dir, _) = locate(&app, &plugin_id)?;
    cs::export_patch(&app, &plugin_id, &dir)
}

/// 把当前插件打包成 .mufurong，返回文件路径。
#[tauri::command]
pub fn changeset_pack_plugin(app: AppHandle, plugin_id: String) -> Result<String, String> {
    let (dir, version) = locate(&app, &plugin_id)?;
    cs::pack_plugin(&app, &plugin_id, &dir, &version)
}

/// 在系统文件管理器中定位刚导出的文件。
#[tauri::command]
pub fn changeset_reveal_file(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| format!("打开所在目录失败: {e}"))
}
