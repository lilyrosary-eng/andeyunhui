//! 中转站文件、托盘模式、备份导出恢复
//!
//! 本文件由 commands.rs 拆分而来（2026-10-18，P1-5 拆 god file）。
//! 约定：用 `use super::*;` 取父模块的 use 与同级 item，不要在子模块里重复 import
//! 父模块已有的依赖；确需额外 import 时写显式路径（显式优先于 glob，不会冲突）。

#![allow(dead_code)] // 部分命令仅在特定平台/配置下被 invoke_handler 引用

use super::*;
// ================= 中转站管理命令 =================

/// 中转站文件信息
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferStationFile {
    pub file_id: String,
    pub file_name: String,
    pub size: u64,
    pub modified: String,
    pub is_backup: bool,
}

/// 把一个已有文件放进中转站（截图 / 录屏产物用）。
///
/// 中转站本体就是 `<app_data>/transfer_station/` 目录（见 `list_transfer_station_files`），
/// 所以"入库"= 复制进去；同名时自动加 `-1/-2` 后缀，不覆盖用户已有的文件。
/// 为什么是复制而不是移动：产物原位置（`~/图片/截图`、`~/视频`）是用户自己也会翻的地方，
/// 我们无权把它搬走。
#[tauri::command]
pub fn add_file_to_transfer_station(
    app: tauri::AppHandle,
    path: String,
) -> Result<String, String> {
    let src = std::path::PathBuf::from(&path);
    if !src.is_file() {
        return Err(format!("文件不存在: {path}"));
    }
    let root = notes_root_dir(&app)?;
    let ts_dir = root.join("transfer_station");
    std::fs::create_dir_all(&ts_dir).map_err(|e| format!("创建中转站目录失败: {e}"))?;

    let name = src
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "取不到文件名".to_string())?;
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let ext = src
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();

    let mut target = ts_dir.join(&name);
    let mut n = 1;
    while target.exists() {
        target = ts_dir.join(format!("{stem}-{n}{ext}"));
        n += 1;
        if n > 999 {
            return Err("中转站里同名文件过多".to_string());
        }
    }
    std::fs::copy(&src, &target).map_err(|e| format!("复制到中转站失败: {e}"))?;
    eprintln!("[中转站] 已入库 {} → {}", path, target.display());
    Ok(target.to_string_lossy().to_string())
}

/// 列出中转站所有文件（当前版本 + 备份）
#[tauri::command]
pub fn list_transfer_station_files(app: tauri::AppHandle) -> Result<Vec<TransferStationFile>, String> {
    let root_dir = notes_root_dir(&app)?;
    let ts_dir = root_dir.join("transfer_station");
    let backups_dir = ts_dir.join("backups");

    let mut files = Vec::new();

    // 扫描当前版本文件
    if ts_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&ts_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let metadata = entry.metadata().ok();
                    let file_name = entry.file_name().to_string_lossy().to_string();
                    let file_id = path.file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    files.push(TransferStationFile {
                        file_id,
                        file_name: file_name.clone(),
                        size: metadata.as_ref().map(|m| m.len()).unwrap_or(0),
                        modified: format_system_time(metadata.as_ref().and_then(|m| m.modified().ok())),
                        is_backup: false,
                    });
                }
            }
        }
    }

    // 扫描备份文件
    if backups_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&backups_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let metadata = entry.metadata().ok();
                    let file_name = entry.file_name().to_string_lossy().to_string();
                    let file_id = path.file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    files.push(TransferStationFile {
                        file_id,
                        file_name: file_name.clone(),
                        size: metadata.as_ref().map(|m| m.len()).unwrap_or(0),
                        modified: format_system_time(metadata.as_ref().and_then(|m| m.modified().ok())),
                        is_backup: true,
                    });
                }
            }
        }
    }

    Ok(files)
}

pub(crate) fn format_system_time(time: Option<std::time::SystemTime>) -> String {
    time.map(|t| {
        let datetime: chrono::DateTime<chrono::Local> = t.into();
        datetime.format("%Y-%m-%d %H:%M:%S").to_string()
    }).unwrap_or_else(|| "未知".to_string())
}

// ================= 托盘模式命令 =================

/// 切换托盘模式（启用/禁用点击关闭按钮时隐藏到托盘）
#[tauri::command]
pub fn toggle_tray_mode(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let root_dir = notes_root_dir(&app)?;
    let config_path = root_dir.join("tray_config.json");

    let config = serde_json::json!({ "enabled": enabled });
    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("序列化托盘配置失败: {}", e))?;
    std::fs::write(&config_path, &content)
        .map_err(|e| format!("写入托盘配置失败: {}", e))?;

    // 更新内存状态
    {
        let state = app.state::<std::sync::Mutex<crate::TrayModeState>>();
        // mutex 中毒（其他线程 panic）时恢复数据，避免二次 panic 导致进程崩溃
        let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
        guard.enabled = enabled;
    }

    log::info!(
        "[TrayMode] 托盘模式已{}，关闭窗口时将{}",
        if enabled { "启用" } else { "禁用" },
        if enabled { "隐藏到托盘" } else { "直接退出" }
    );
    Ok(())
}

/// 获取当前托盘模式配置
#[tauri::command]
pub fn get_tray_mode(app: tauri::AppHandle) -> Result<bool, String> {
    let root_dir = notes_root_dir(&app)?;
    let config_path = root_dir.join("tray_config.json");

    if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("读取托盘配置失败: {}", e))?;
        let config: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("解析托盘配置失败: {}", e))?;
        Ok(config.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false))
    } else {
        Ok(false)
    }
}

// ================= 导出备份命令 =================

/// 导出所有笔记到指定 zip 路径
#[tauri::command]
pub fn export_backup(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let root_dir = notes_root_dir(&app)?;
    let notes_dir = root_dir.join("notes");

    if !notes_dir.exists() {
        return Err("没有可导出的笔记".to_string());
    }

    // 使用 std::fs 递归拷贝 notes 目录到临时目录，再打包为 zip
    let tmp_dir = root_dir.join("_export_tmp");
    if tmp_dir.exists() {
        std::fs::remove_dir_all(&tmp_dir).map_err(|e| format!("清理临时目录失败: {}", e))?;
    }
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;

    // 递归拷贝
    copy_dir(&notes_dir, &tmp_dir.join("notes"))?;

    // 使用系统命令创建 zip（Windows 内置）。路径含单引号时用 '' 转义，防命令破裂。
    let mut zip_cmd = std::process::Command::new("powershell");
    zip_cmd.args([
            "-NoProfile", "-Command",
            &format!(
                "Compress-Archive -Path '{}' -DestinationPath '{}' -Force",
                tmp_dir.join("notes").display().to_string().replace('\'', "''"),
                path.replace('\'', "''"),
            ),
        ]);
    #[cfg(windows)]
    zip_cmd.creation_flags(0x08000000);
    let output = zip_cmd.output()
        .map_err(|e| format!("执行打包命令失败: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("打包失败: {}", err));
    }

    // 清理临时目录
    let _ = std::fs::remove_dir_all(&tmp_dir);

    eprintln!("[ExportBackup] 备份导出成功: {}", path);
    Ok(())
}

pub(crate) fn copy_dir(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建目录失败: {}", e))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("读取目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let path = entry.path();
        let dest = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir(&path, &dest)?;
        } else {
            std::fs::copy(&path, &dest).map_err(|e| format!("复制文件失败: {}", e))?;
        }
    }
    Ok(())
}

// ================= 中转站交互命令 =================

/// 从中转站还原文件到笔记目录
#[tauri::command]
pub fn restore_transfer_station_file(
    app: tauri::AppHandle,
    file_name: String,
    is_backup: bool,
) -> Result<(), String> {
    let root_dir = notes_root_dir(&app)?;
    let ts_dir = root_dir.join("transfer_station");
    let source_dir = if is_backup { ts_dir.join("backups") } else { ts_dir.clone() };
    let source_path = source_dir.join(&file_name);

    if !source_path.exists() {
        return Err(format!("中转站文件不存在: {}", file_name));
    }

    let content = std::fs::read_to_string(&source_path)
        .map_err(|e| format!("读取中转站文件失败: {}", e))?;

    let notes_dir = root_dir.join("notes");
    std::fs::create_dir_all(&notes_dir).map_err(|e| format!("创建笔记目录失败: {}", e))?;

    // 提取原始 note_id（备份文件名格式: {note_id}_{YYYYMMDD_HHMMSS}.md）
    let note_id = if is_backup {
        file_name
            .strip_suffix(".md")
            .unwrap_or(&file_name)
            .split_once('_')
            .map(|(id, _)| id.to_string())
            .unwrap_or_else(|| file_name.replace(".md", ""))
    } else {
        file_name.replace(".md", "")
    };

    let note_path = notes_dir.join(format!("{}.md", note_id));
    std::fs::write(&note_path, &content)
        .map_err(|e| format!("写入笔记文件失败: {}", e))?;

    eprintln!(
        "[TransferStation] 还原文件: {} -> notes/{}.md, is_backup={}, content_len={}",
        file_name, note_id, is_backup, content.len()
    );
    Ok(())
}

/// 删除中转站中的单个文件
#[tauri::command]
pub fn delete_transfer_station_file(
    app: tauri::AppHandle,
    file_name: String,
    is_backup: bool,
) -> Result<(), String> {
    // 首次备份不可删除
    if is_backup {
        return Err("首次备份不可删除".to_string());
    }

    let root_dir = notes_root_dir(&app)?;
    let ts_dir = root_dir.join("transfer_station");
    let file_path = ts_dir.join(&file_name);

    if !file_path.exists() {
        return Err(format!("中转站文件不存在: {}", file_name));
    }

    std::fs::remove_file(&file_path)
        .map_err(|e| format!("删除中转站文件失败: {}", e))?;

    eprintln!("[TransferStation] 删除文件: {}", file_name);
    Ok(())
}

/// 清空中转站「当前暂存」分组（不影响「首次备份」分组）
#[tauri::command]
pub fn clear_transfer_station(app: tauri::AppHandle) -> Result<u32, String> {
    let root_dir = notes_root_dir(&app)?;
    let ts_dir = root_dir.join("transfer_station");

    if !ts_dir.exists() {
        return Ok(0);
    }

    let mut count = 0u32;
    if let Ok(entries) = std::fs::read_dir(&ts_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                std::fs::remove_file(&path)
                    .map_err(|e| format!("删除文件失败: {}", e))?;
                count += 1;
            }
        }
    }

    eprintln!("[TransferStation] 清空中转站: 已删除 {} 个文件", count);
    Ok(count)
}
