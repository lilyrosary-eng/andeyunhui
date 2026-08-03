//! Android 中转站（Dropzone）命令 —— 与桌面语义一致的最小可用子集。
//!
//! 背景：桌面版中转站命令位于 `commands.rs`，而该模块整体是 Windows 专属
//! （`#[cfg(not(target_os = "android"))] pub mod commands;`，见 lib.rs），
//! 因此 Android 端拿不到 `list_dropzone_files` / `delete_dropzone_file` 等命令。
//!
//! 这些函数本身是纯 `std::fs` + `AppHandle`，与平台无关。此处按移动端实际需要
//! 内联最小子集（列表 / 读文本 / 删除 / 清空），**存储布局与桌面完全一致**：
//!   `<app_data_dir>/transfer_station/dropzone/<file_id>.<ext>`
//! 这样「Windows 中转站」与「Android 中转站」是同一套语义，未来同步/迁移不会出现结构分叉。
//!
//! 注意：不复制桌面的 `start_native_file_drag`（OS 原生拖放，Windows DoDragDrop 专属）、
//! `export_dropzone_file`（依赖系统文件对话框）等平台强相关命令。

use std::fs;
use std::path::PathBuf;
use tauri::Manager;

/// 中转站文件元信息（字段与桌面 `commands::ImportedFile` 保持一致，
/// 前端 `mobile/types` 可与桌面共用同一套 TS 类型）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DropzoneFile {
    pub file_id: String,
    pub original_name: String,
    pub extension: String,
    pub size: u64,
    pub stored_path: String,
    pub absolute_path: String,
    pub imported_at: String,
    pub is_readable: bool,
}

/// 可直接以文本预览的扩展名（与桌面口径一致）
const READABLE_EXTS: &[&str] = &[
    "txt", "md", "markdown", "json", "xml", "yaml", "yml", "toml", "ini", "log", "csv", "rs", "ts",
    "tsx", "js", "jsx", "html", "css", "py", "java", "kt", "go", "c", "cpp", "h", "sh",
];

fn dropzone_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = app_data.join("transfer_station").join("dropzone");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("创建中转站目录失败: {}", e))?;
    }
    Ok(dir)
}

/// 列出中转站内的全部文件（按修改时间倒序，最新在前）。
#[tauri::command]
pub fn dropzone_list(app: tauri::AppHandle) -> Result<Vec<DropzoneFile>, String> {
    let dir = dropzone_dir(&app)?;
    let mut out: Vec<(std::time::SystemTime, DropzoneFile)> = Vec::new();

    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(Vec::new()),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        let file_name = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let extension = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        let file_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&file_name)
            .to_string();

        let imported_at = modified
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis().to_string())
            .unwrap_or_default();

        out.push((
            modified,
            DropzoneFile {
                file_id,
                original_name: file_name.clone(),
                extension: extension.clone(),
                size: meta.len(),
                stored_path: file_name,
                absolute_path: path.to_string_lossy().to_string(),
                imported_at,
                is_readable: READABLE_EXTS.contains(&extension.as_str()),
            },
        ));
    }

    // 最新导入排最前
    out.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(out.into_iter().map(|(_, f)| f).collect())
}

/// 读取中转站中的文本文件内容（用于移动端预览）。
#[tauri::command]
pub fn dropzone_read_text(app: tauri::AppHandle, stored_path: String) -> Result<String, String> {
    let file_path = dropzone_dir(&app)?.join(&stored_path);
    if !file_path.exists() {
        return Err("文件不存在".to_string());
    }
    // 上限 2MB，避免移动端读大文件卡 UI
    let meta = fs::metadata(&file_path).map_err(|e| e.to_string())?;
    if meta.len() > 2 * 1024 * 1024 {
        return Err("文件过大，暂不支持预览（上限 2MB）".to_string());
    }
    fs::read_to_string(&file_path).map_err(|e| format!("读取文件失败: {}", e))
}

/// 删除中转站中的单个文件。
#[tauri::command]
pub fn dropzone_delete(app: tauri::AppHandle, stored_path: String) -> Result<(), String> {
    let file_path = dropzone_dir(&app)?.join(&stored_path);
    if !file_path.exists() {
        return Ok(());
    }
    fs::remove_file(&file_path).map_err(|e| format!("删除文件失败: {}", e))
}

/// 清空中转站，返回删除的文件数。
#[tauri::command]
pub fn dropzone_clear(app: tauri::AppHandle) -> Result<u32, String> {
    let dir = dropzone_dir(&app)?;
    let mut count = 0u32;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && fs::remove_file(&path).is_ok() {
                count += 1;
            }
        }
    }
    Ok(count)
}
