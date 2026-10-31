//! 插件与依赖安装（bundled / user / dep 文件）
//!
//! 本文件由 commands.rs 拆分而来（2026-10-18，P1-5 拆 god file）。
//! 约定：用 `use super::*;` 取父模块的 use 与同级 item，不要在子模块里重复 import
//! 父模块已有的依赖；确需额外 import 时写显式路径（显式优先于 glob，不会冲突）。

#![allow(dead_code)] // 部分命令仅在特定平台/配置下被 invoke_handler 引用

use super::*;
// ============================================================
// 路线 A — 分发解耦：插件下载安装
// ============================================================

/// 将插件文件写入 `user_plugins/{plugin_id}/{file_name}`。
/// 用于分发解耦：前端从清单获取文件内容后，调此命令写盘，再触发热加载。
#[tauri::command]
pub fn install_plugin_file(
    app: tauri::AppHandle,
    plugin_id: String,
    file_name: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let user_plugins_dir = get_user_plugins_dir(&app)
        .ok_or_else(|| "无法解析 user_plugins 目录".to_string())?;
    let dir = user_plugins_dir.join(&plugin_id);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("创建目录失败: {}", e))?;
    let safe_name = sanitize_filename(&file_name);
    std::fs::write(dir.join(&safe_name), &data)
        .map_err(|e| format!("写入 {} 失败: {}", safe_name, e))?;
    Ok(())
}

/// 读取插件清单（JSON），返回原始文本。
/// 统一从 bundled-plugins/manifest.json 读取（开发时项目根，打包后 resource_dir）
#[tauri::command]
pub fn read_manifest(app: tauri::AppHandle) -> Result<String, String> {
    if let Some(bundled_dir) = get_bundled_plugins_dir(&app) {
        let manifest_path = bundled_dir.join("manifest.json");
        if manifest_path.exists() {
            return std::fs::read_to_string(&manifest_path)
                .map_err(|e| format!("读取清单失败: {}", e));
        }
    }
    Err("未找到插件清单 manifest.json".into())
}

/// 路线 A 分发解耦：从 bundled-plugins 一次性复制整个插件到 user_plugins，
/// 然后触发热加载。省去前端逐文件 fetch 的复杂性。
#[tauri::command]
pub fn install_bundled_plugin(app: tauri::AppHandle, plugin_id: String) -> Result<String, String> {
    let bundled_base = get_bundled_plugins_dir(&app)
        .ok_or_else(|| "无法解析 bundled-plugins 目录".to_string())?;
    let src = if bundled_base.join(&plugin_id).exists() {
        bundled_base.join(&plugin_id)
    } else {
        let user_plugins_dir = get_user_plugins_dir(&app)
            .ok_or_else(|| "无法解析 user_plugins 目录".to_string())?;
        return Err(format!(
            "未找到插件包。请将 {} 的 manifest.json 与 index.js 放入:\n  {}\\\n然后点击「检测新插件」。",
            plugin_id,
            user_plugins_dir.display()
        ));
    };

    let dst = get_user_plugins_dir(&app)
        .ok_or_else(|| "无法解析 user_plugins 目录".to_string())?
        .join(&plugin_id);

    // 递归复制
    copy_dir_recursive(&src, &dst)
        .map_err(|e| format!("复制插件文件失败: {}", e))?;

    // 从清单中取插件名用于提示
    let manifest = src.join("manifest.json");
    let name = std::fs::read_to_string(&manifest)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(String::from))
        .unwrap_or_else(|| plugin_id.clone());

    Ok(name)
}

use std::path::Path;

pub(crate) fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), std::io::Error> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let dest = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else {
            std::fs::copy(entry.path(), &dest)?;
        }
    }
    Ok(())
}

// ================= 开发者控制台 =================
// 全局设置-关于 内置的轻量级命令行 REPL：
//   - 前端通过命令白名单 + 危险关键词黑名单双重过滤
//   - 联网能力通过 dev_console_http 走 Rust 端 reqwest
//   - 安装 .mujin 依赖通过 install_dep_file 写入 user_external_deps/

/// 安装 .mujin 依赖文件到 user_external_deps/<target_subpath>。
/// target_subpath 形如 "茑萝/ide/codemirror.mujin" 或 "全局/markitdown.mujin"，
/// 自动创建母文件夹。data 为 .mujin 文件原始字节。
/// 安装完成后下次扫描会自动解压（extract_mujin_deps）。
#[tauri::command]
pub fn install_dep_file(
    app: tauri::AppHandle,
    plugin_id: Option<String>,
    target_subpath: String,
    data: Vec<u8>,
) -> Result<(), String> {
    // 路径越界防护：禁止 .. 与绝对路径
    let trimmed = target_subpath.trim_start_matches(['/', '\\']);
    if trimmed.contains("..") || trimmed.contains(':') {
        return Err(format!("非法 target_subpath: {}", target_subpath));
    }
    let user_deps_dir = get_user_external_deps_dir(&app)
        .ok_or_else(|| "无法解析 user_external_deps 目录".to_string())?;
    let path = user_deps_dir.join(trimmed);
    crate::services::plugin_access::ensure_plugin_write(&app, plugin_id.as_deref(), &path.to_string_lossy())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    std::fs::write(&path, &data).map_err(|e| format!("写入依赖文件失败: {}", e))?;
    eprintln!("[DevConsole] 已安装依赖: {} -> {}", trimmed, path.display());
    Ok(())
}

/// 安装 .mufurong 插件文件到 user_plugins/<target_subpath>。
/// target_subpath 形如 "茑萝/ai.mufurong" 或 "全局/markitdown.mufurong"，
/// 自动创建母文件夹。data 为 .mufurong 文件原始字节。
/// 安装完成后下次扫描会自动解压（extract_mufurong_plugins）。
#[tauri::command]
pub fn install_user_plugin_file(
    app: tauri::AppHandle,
    plugin_id: Option<String>,
    target_subpath: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let trimmed = target_subpath.trim_start_matches(['/', '\\']);
    if trimmed.contains("..") || trimmed.contains(':') {
        return Err(format!("非法 target_subpath: {}", target_subpath));
    }
    let user_plugins_dir = get_user_plugins_dir(&app)
        .ok_or_else(|| "无法解析 user_plugins 目录".to_string())?;
    let path = user_plugins_dir.join(trimmed);
    crate::services::plugin_access::ensure_plugin_write(&app, plugin_id.as_deref(), &path.to_string_lossy())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    std::fs::write(&path, &data).map_err(|e| format!("写入插件文件失败: {}", e))?;
    eprintln!("[DevConsole] 已安装插件: {} -> {}", trimmed, path.display());
    Ok(())
}
