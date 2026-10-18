//! 目录/文件选择对话框与基础文件读写
//!
//! 本文件由 commands.rs 拆分而来（2026-10-18，P1-5 拆 god file）。
//! 约定：用 `use super::*;` 取父模块的 use 与同级 item，不要在子模块里重复 import
//! 父模块已有的依赖；确需额外 import 时写显式路径（显式优先于 glob，不会冲突）。

#![allow(dead_code)] // 部分命令仅在特定平台/配置下被 invoke_handler 引用

use super::*;
/// 打开目录选择对话框，返回选中的路径（用户取消时返回 None）
#[tauri::command]
pub async fn pick_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let folder = app.dialog().file().blocking_pick_folder();
    if let Some(ref p) = folder {
        // 运行时把用户选定目录加入 asset 协议 scope（递归），
        // 这样静态 scope 可保持最小（仅 $APPDATA），降低攻击面。
        let s = p.to_string();
        let _ = app.asset_protocol_scope().allow_directory(std::path::Path::new(&s), true);
    }
    Ok(folder.map(|p| p.to_string()))
}

/// 文件选择对话框过滤器（前端传入）
#[derive(serde::Deserialize)]
pub struct FileDialogFilter {
    name: String,
    extensions: Vec<String>,
}

/// 打开文件选择对话框，返回选中的文件路径列表
#[tauri::command]
pub async fn pick_file(
    app: tauri::AppHandle,
    filters: Option<Vec<FileDialogFilter>>,
    // 对话框标题（可选）。
    // ⚠️ 这两个参数**原先根本没有**，而三处调用方都在传 `title` / `multiple` ——
    // serde 默认忽略未知字段，所以调用成功、参数**静默失效**（标题是系统默认、只能单选）。
    // 是 `tauriCommands.test.ts` 的参数名防线把这三处翻出来的。
    title: Option<String>,
    // 是否允许多选（可选，默认 false = 单选）。
    multiple: Option<bool>,
) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mut builder = app.dialog().file();
    if let Some(t) = title.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        builder = builder.set_title(t);
    }
    if let Some(filter_list) = &filters {
        for f in filter_list {
            let exts: Vec<&str> = f.extensions.iter().map(|s| s.as_str()).collect();
            builder = builder.add_filter(&f.name, &exts);
        }
    }
    let files = if multiple.unwrap_or(false) {
        builder.blocking_pick_files()
    } else {
        builder.blocking_pick_file().map(|p| vec![p])
    };
    let paths: Vec<String> = files.unwrap_or_default().into_iter().map(|p| p.to_string()).collect();
    // 运行时把所选文件的父目录加入 asset scope，便于后续 convertFileSrc 加载
    for p in &paths {
        if let Some(parent) = std::path::Path::new(p).parent() {
            let _ = app.asset_protocol_scope().allow_directory(parent, false);
        }
    }
    Ok(paths)
}

// 另存为：打开「保存文件」对话框，返回选中的路径（取消时 None）
#[tauri::command]
pub async fn pick_save_file(app: tauri::AppHandle, default_name: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .blocking_save_file();
    Ok(path.map(|p| p.to_string()))
}

// 写入纯文本文件（IDE 子插件「保存」用）。原子写入：先写同目录临时文件，再 rename 替换，
// 避免 AI 生成到一半断网/崩溃导致原文件被截断为 0 字节（写前锁定 / 原子替换）。
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
        }
    }
    let tmp = format!("{}.{}.tmp", path, std::process::id());
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| format!("写入失败: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("写入失败: {}", e)
    })
}

/// 写入二进制文件（base64 解码）。供前端导出 XLSX / 图片等二进制产物到磁盘。
/// 采用与 `write_text_file` 一致的原子写（临时文件 + rename），避免写一半被读取导致损坏。
#[tauri::command]
pub fn write_file_bytes(path: String, content_base64: String) -> Result<(), String> {
    use base64::Engine as _;
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
        }
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content_base64)
        .map_err(|e| format!("base64 解码失败: {}", e))?;
    let tmp = format!("{}.{}.tmp", path, std::process::id());
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写入失败: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("写入失败: {}", e)
    })
}

// 读取文本文件内容（IDE 子插件用），以 UTF-8 解析（含非法字节时容错替换）
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("读取失败: {}", e))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

// 删除文件（IDE 自主编辑「撤销新建文件」用；不存在时视为成功）
#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Ok(());
    }
    std::fs::remove_file(&path).map_err(|e| format!("删除失败: {}", e))
}
