pub mod note_service;
pub mod transfer_station;
pub mod image_service;
pub mod music_service;
pub mod video_service;
pub mod cache_service;
pub mod document_parser;
pub mod docx_wps;
pub mod pptx_wps;
pub mod pptx_import;
pub mod lyrics_service;
pub mod reading_service;
// 录屏捕获（WGC / D3D11 / AudioCapture）为 Windows 专属后端：非 Windows 目标不编译该模块，
// 避免裸引 windows / windows_capture / winapi 等仅 Windows 可用的 crate。
#[cfg(windows)]
pub mod recording_service;
pub mod window_manager;
// 诊断模块依赖 Windows 捕获后端（windows_capture），仅 Windows 编译。
#[cfg(windows)]
pub mod diagnostics;
pub mod log_service;
pub mod ai_service;
pub mod rag_service;
pub mod shell_service;
pub mod lsp_service;
pub mod mcp_service;
// IDE 内容搜索（gitignore 感知并行遍历 + 字面量匹配）：命令面板 `#` 模式 / agent grep 工具
pub mod search_service;
// IDE 源码管理（git CLI 封装）：status/diff/stage/commit/log/branch，供 sourceControl/gitHistory 前端调用
// 不引入 git2 原生依赖，借用系统 git（兼容至上、轻量高效）
pub mod git_service;
// IDE 真 PTY 终端（portable-pty）：spawn/读写/resize/kill + 事件推流，供 xterm.js 前端桥接。
// portable-pty 的 Unix 后端依赖 termios（无 android 分支），故 Android/iOS 不编译该模块，
// 依赖侧已同步迁至 [target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]。
// 无需移动端桩：pty_create/pty_write/pty_resize/pty_kill 四个命令仅由桌面二进制 main.rs 注册，
// lib 侧（Android 入口 android/mod.rs）无任何引用。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod pty_service;

use std::path::{Path, PathBuf};

/// 安全地把用户输入的 id 拼接到 base 目录上，防止路径遍历。
///
/// 校验链：
/// 1. id 不能为空、不能含路径分隔符（`/` `\`）或 `..`；
/// 2. join 后 canonicalize，确保规范路径仍位于 base 之内。
///
/// 用于 note_id、plugin_id 等会被拼接进文件路径的不可信输入。
/// `base` 通常是已存在的应用数据目录。
pub fn safe_join(base: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty()
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
        || id.chars().any(|c| c.is_control())
    {
        return Err(format!("非法标识符: {id:?}"));
    }
    let joined = base.join(id);
    // base 可能尚未存在（首次写入）；若已存在则做 canonicalize 校验
    if let Ok(base_canon) = base.canonicalize() {
        if let Ok(joined_canon) = joined.canonicalize() {
            if !joined_canon.starts_with(&base_canon) {
                return Err(format!("路径越界: {}", joined_canon.display()));
            }
            return Ok(joined_canon);
        }
    }
    // base 或 joined 尚不存在：依赖前面的字符校验保证安全性
    Ok(joined)
}

/// 用安全方式拼接 `{id}.{ext}` 到 base，用于 `.md` / `.pin` 等扩展名文件。
pub fn safe_join_ext(base: &Path, id: &str, ext: &str) -> Result<PathBuf, String> {
    let safe_id = if id.is_empty()
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
        || id.chars().any(|c| c.is_control())
    {
        return Err(format!("非法标识符: {id:?}"));
    } else {
        id
    };
    let fname = format!("{safe_id}.{ext}");
    let joined = base.join(fname);
    if let Ok(base_canon) = base.canonicalize() {
        if let Ok(joined_canon) = joined.canonicalize() {
            if !joined_canon.starts_with(&base_canon) {
                return Err(format!("路径越界: {}", joined_canon.display()));
            }
            return Ok(joined_canon);
        }
    }
    Ok(joined)
}
