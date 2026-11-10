//! 高危文件草稿区命令外壳（实现见 `services/draft_service.rs`）。

use tauri::AppHandle;

use crate::services::draft_service::{self as ds, DraftMeta};

/// 列出待审阅草稿；传 pluginId 只列该插件的。
#[tauri::command]
pub fn draft_list(app: AppHandle, plugin_id: Option<String>) -> Vec<DraftMeta> {
    ds::list(&app, plugin_id.as_deref())
}

/// 读草稿内容。
#[tauri::command]
pub fn draft_read(app: AppHandle, id: String) -> Result<String, String> {
    ds::read(&app, &id)
}

/// 草稿 vs 当前磁盘的 unified diff。
#[tauri::command]
pub fn draft_diff(app: AppHandle, id: String) -> Result<String, String> {
    ds::diff(&app, &id)
}

/// 应用草稿：原子写回真实路径。返回元数据（含 pluginId，前端据此热重载插件）。
#[tauri::command]
pub fn draft_apply(app: AppHandle, id: String) -> Result<DraftMeta, String> {
    ds::apply(&app, &id)
}

/// 丢弃草稿（真实文件不受影响）。
#[tauri::command]
pub fn draft_discard(app: AppHandle, id: String) -> Result<(), String> {
    ds::discard(&app, &id)
}
