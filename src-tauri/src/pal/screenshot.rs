//! PAL 桩：非 Windows（Android / Linux / macOS）下的截图模块占位实现。
//!
//! 截图捕获（GDI / WGC / Win32 窗口枚举）是 Windows 专属能力，在非 Windows 目标无后端。
//! 本文件通过 `lib.rs` 的 `#[cfg(not(windows))]` 路径替换接管 `screenshot` 模块，
//! 提供与真实实现「同名」的公共 API，但所有捕获类函数返回 `Unsupported` / 空实现，
//! 保证模块在任意非 Windows 目标下可编译（零行为变化；Windows 仍走真实实现）。
//!
//! 当前 v1 阶段这些能力在 Android 上尚未实现，后续 T4+ 可在此接入 Android 截图后端
//! （MediaProjection / 系统截图 API）或保持 Unsupported。

#![allow(dead_code)]

use std::sync::Mutex;
use tauri::{AppHandle, Webview};

/// 窗口信息（与 Windows 实现同名字段，供跨平台调用方使用）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WindowInfo {
    pub hwnd: u64,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub is_self: bool,
    pub is_taskbar: bool,
    pub z: i64,
}

/// 本应用「自身覆盖窗 / 常驻置顶窗」标签集合（与 Windows 实现保持一致，供命中测试共用）。
pub const SELF_OVERLAY_LABELS: &[&str] = &[
    "screenshot-overlay",
    "floating-clipboard",
    "floating-dropzone",
    "recording-border",
    "capsule",
];

/// 当前截图数据（跨平台占位，字段与 Windows 实现保持一致）。
#[derive(Debug, Clone, Default)]
pub struct ScreenshotData {
    pub note_id: String,
    pub shortcut: String,
    pub capturing: bool,
    pub showing: bool,
    pub last_ox: f64,
    pub last_oy: f64,
    pub last_scale: f64,
    pub last_windows: Vec<WindowInfo>,
    pub session: u64,
}

/// 最近一次截屏数据（跨平台占位）。
#[derive(Debug, Clone, Default)]
pub struct Shot {
    pub raw: Vec<u8>,
    pub native_w: u32,
    pub native_h: u32,
    pub native_ox: i32,
    pub native_oy: i32,
}

/// 剪贴板轮询结果（跨平台占位）。
#[derive(Debug, Clone, Default)]
pub struct ClipboardPollResult {
    pub hash: String,
    pub temp_path: String,
    pub thumbnail: String,
}

/// 快捷键类型占位（真实实现为 `tauri_plugin_global_shortcut::Shortcut`）。
pub type Shortcut = String;

// ============ 公共 API 桩 ============

pub fn mark_overlay_destroyed(_label: &str) {}

pub fn hide_overlay_window(_app: AppHandle) {}

pub fn reveal_screenshot_overlay(_app: AppHandle) {}

pub fn set_overlay_transparent(_webview: Webview, _app: AppHandle) {}

pub fn set_overlay_repaint_rate(_webview: Webview, _interval_ms: u64) {}

pub fn present_overlay_now(_webview: Webview) {}

pub fn get_screenshot_desktop_rect() -> Result<serde_json::Value, String> {
    Err("截图在 Android/Linux/macOS 上尚未实现 (Unsupported)".into())
}

pub fn list_windows(_app: AppHandle) -> Result<Vec<WindowInfo>, String> {
    Ok(Vec::new())
}

pub fn get_window_title(_hwnd: u64) -> String {
    String::new()
}

pub fn capture_window_full(_hwnd: u64) -> Result<tauri::ipc::Response, String> {
    Err("capture_window_full 在 Android/Linux/macOS 上尚未实现 (Unsupported)".into())
}

pub fn capture_screen() -> Result<Vec<u8>, String> {
    Err("capture_screen 在 Android/Linux/macOS 上尚未实现 (Unsupported)".into())
}

pub fn capture_recorder_snapshot() {}

pub fn store_screenshot_note_id(
    _note_id: String,
    _state: tauri::State<'_, Mutex<ScreenshotData>>,
) -> Result<(), String> {
    Ok(())
}

pub fn get_screenshot_note_id(
    _state: tauri::State<'_, Mutex<ScreenshotData>>,
) -> Result<Option<String>, String> {
    Ok(None)
}

pub fn peek_screenshot() -> Result<Option<Shot>, String> {
    Ok(None)
}

pub fn clipboard_write_image(_app: AppHandle, _base64_png: String) -> Result<(), String> {
    Err("clipboard_write_image 在 Android/Linux/macOS 上尚未实现 (Unsupported)".into())
}

pub fn clipboard_write_image_from_path(_app: AppHandle, _path: String) -> Result<(), String> {
    Err("clipboard_write_image_from_path 在 Android/Linux/macOS 上尚未实现 (Unsupported)".into())
}

pub fn clipboard_diagnose() -> Result<ClipboardPollResult, String> {
    Ok(ClipboardPollResult::default())
}

pub fn read_screenshot_shortcut(_app: &AppHandle) -> String {
    "Ctrl+Shift+S".into()
}

pub fn parse_shortcut(s: &str) -> Result<Shortcut, String> {
    Ok(s.to_string())
}

pub fn register_screenshot_shortcut(_app: &AppHandle, _sc: &str) -> Result<(), String> {
    Ok(())
}

pub fn get_screenshot_shortcut(_app: AppHandle) -> String {
    "Ctrl+Shift+S".into()
}

pub fn set_screenshot_shortcut(_app: AppHandle, _shortcut: String) -> Result<(), String> {
    Ok(())
}

pub const DEFAULT_CLIPBOARD_SHORTCUT: &str = "Ctrl+Alt+C";

pub fn clipboard_shortcut_state() -> &'static Mutex<String> {
    static S: Mutex<String> = Mutex::new(String::new());
    &S
}

pub fn read_clipboard_shortcut(_app: &AppHandle) -> String {
    DEFAULT_CLIPBOARD_SHORTCUT.into()
}

pub fn register_clipboard_shortcut(_app: &AppHandle, _sc: &str) -> Result<(), String> {
    Ok(())
}

pub fn get_clipboard_shortcut(_app: AppHandle) -> String {
    DEFAULT_CLIPBOARD_SHORTCUT.into()
}

pub fn set_clipboard_shortcut(_app: AppHandle, _shortcut: String) -> Result<(), String> {
    Ok(())
}

pub const DEFAULT_DROPZONE_SHORTCUT: &str = "Ctrl+Alt+V";

pub fn dropzone_shortcut_state() -> &'static Mutex<String> {
    static S: Mutex<String> = Mutex::new(String::new());
    &S
}

pub fn read_dropzone_shortcut(_app: &AppHandle) -> String {
    DEFAULT_DROPZONE_SHORTCUT.into()
}

pub fn register_dropzone_shortcut(_app: &AppHandle, _sc: &str) -> Result<(), String> {
    Ok(())
}

pub fn get_dropzone_shortcut(_app: AppHandle) -> String {
    DEFAULT_DROPZONE_SHORTCUT.into()
}

pub fn set_dropzone_shortcut(_app: AppHandle, _shortcut: String) -> Result<(), String> {
    Ok(())
}
