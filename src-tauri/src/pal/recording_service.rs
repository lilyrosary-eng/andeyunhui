// ============ 非 Windows 平台的录屏 / 诊断服务桩 ============
//
// 为什么需要这个文件（而不是在 main.rs 里逐处 `#[cfg(windows)]`）：
//   `services::recording_service` 与 `services::diagnostics` 依赖 `windows-capture`（WGC 屏幕捕获）、
//   `winapi`（Win32 窗口/DPI/GDI），因此在 `services/mod.rs` 里是 `#[cfg(windows)]` 模块。
//   而 `main.rs` 在**命令注册表（invoke_handler）与托盘/菜单回调**里共 29 处引用它们——
//   这些引用点分散在 `main()` 主体、托盘事件、`setup` 闭包等不同作用域。
//   逐处加 `#[cfg]` 的代价是可维护性灾难：每加一个新平台要重新审一遍所有引用点，
//   而且极易漏（漏了就是「Linux 编译不过」这种与功能无关的失败）。
//   ⇒ 改为在本模块提供**同名同签名的空实现**：调用点一行都不用改，
//     Windows 行为完全不变，非 Windows 得到一个诚实的「该平台不支持」。
//
// ⚠ 签名必须与 Windows 版**逐字一致**（含参数个数、类型、`Result` 的错误类型、
//   异步性、返回类型）。改动 Windows 侧签名时必须同步这里，否则 Linux 编译会以
//   「参数不匹配」失败——这是本文件唯一需要人工维护的地方，注释里标了核对方法。
//   核对方法：`grep -n 'pub fn <名字>\|pub async fn <名字>' src/services/recording_service.rs`
//
// 能力边界（诚实说明，不要在这些函数里编造数据）：
//   · 录屏：**已接入**（2026-10-28）。Wayland 走 xdg-desktop-portal `ScreenCast` +
//     PipeWire + `gst-launch-1.0`（见 `pal/portal_screencast.rs`）。与 Windows 的差别：
//     用户必须先在**系统对话框**里选录制来源（我们无法指定 monitor/region），输出为 WebM。
//     暂停/恢复仍未实现（gst 侧要发事件，不是改状态位）。
//   · 快捷键：Linux **可以**实现（global-shortcut crate 跨平台），此处返回默认值即可，
//     因为录屏面板本身不存在，快捷键无意义。
#![allow(dead_code)]

use std::sync::Mutex;
use tauri::AppHandle;

// ----------------- 常量（与 Windows 版逐字一致）-----------------
// 窗口 label 保持原值：前端与 capabilities/default.json 里已按这些 label 声明权限，
// 改值会让前端找不到窗口。
pub const RECORDER_WINDOW_LABEL: &str = "recorder-widget";
pub const RECORDER_SELECT_LABEL: &str = "recorder-select";
pub const RECORDING_BORDER_LABEL: &str = "recording-border";
pub const DEFAULT_RECORDER_SHORTCUT: &str = "Ctrl+Alt+R";

/// 录屏状态。字段与 `serde(rename_all = "camelCase")` 都与 Windows 版一致，
/// 保证前端 `invoke('get_recording_status')` 拿到的 JSON 形状相同（只是值全为「空闲」）。
#[derive(Debug, Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub is_recording: bool,
    pub is_paused: bool,
    pub elapsed_secs: u64,
    pub output_path: String,
}

/// 全局快捷键字符串的共享槽（与 Windows 版同型：返回 `&'static Mutex<String>`）。
static RECORDER_SHORTCUT_STR: std::sync::OnceLock<Mutex<String>> = std::sync::OnceLock::new();

pub fn recorder_shortcut_state() -> &'static Mutex<String> {
    RECORDER_SHORTCUT_STR.get_or_init(|| Mutex::new(DEFAULT_RECORDER_SHORTCUT.to_string()))
}

/// 统一错误文案：让用户看到的是「平台不支持」而不是「未知命令」或空白。
const UNSUPPORTED: &str = "录屏功能仅在 Windows 上可用（捕获后端为 WGC / Win32，Linux 尚未接入）";

// ----------------- 录屏：全部返回「不支持」-----------------

/// 对应 Windows 版：`pub async fn start_recording(app, output_path, fps, monitor_index, region_x, region_y, region_w, region_h) -> Result<(), String>`
#[tauri::command]
pub async fn start_recording(
    _app: AppHandle,
    output_path: String,
    fps: Option<u32>,
    _monitor_index: Option<usize>,
    _region_x: Option<i32>,
    _region_y: Option<i32>,
    _region_w: Option<i32>,
    _region_h: Option<i32>,
) -> Result<(), String> {
    // Linux：走 portal ScreenCast（**会弹一次系统"共享屏幕"对话框**，用户在那里选
    // 整个屏幕还是某个窗口），拿到 PipeWire 节点后由 gst 子进程写成 WebM。
    //
    // 与 Windows 的差别（诚实说明，不假装等价）：
    // · `region_*` / `monitor_index` 在 Wayland 下**无法由我们指定** —— 只能让用户在
    //   系统对话框里选来源。硬要裁区域可以在 gst 里加 videocrop，但"哪个区域"得用户先选；
    // · 输出强制 .webm（本机 gstreamer 没有 x264enc ⇒ H.264/MP4 出不来）；
    // · 没有自己的选区覆盖层（那套在 Wayland 上要重写，用户已明确不做）。
    let _ = crate::portal_screencast::start(&output_path, fps.unwrap_or(30)).await?;
    Ok(())
}

/// 对应 Windows 版：`pub async fn stop_recording(app: AppHandle) -> Result<String, String>`
#[tauri::command]
pub async fn stop_recording(_app: AppHandle) -> Result<String, String> {
    crate::portal_screencast::stop().await
}

#[tauri::command]
pub fn pause_recording() -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub fn resume_recording() -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

/// 空闲状态：前端据此把录屏面板显示为「未在录制」，而不是报未知错误。
#[tauri::command]
pub fn get_recording_status() -> RecordingStatus {
    let (rec, secs) = crate::portal_screencast::status();
    if !rec {
        return RecordingStatus::default();
    }
    RecordingStatus {
        is_recording: true,
        is_paused: false,
        elapsed_secs: secs,
        output_path: String::new(),
    }
}

#[tauri::command]
pub fn show_recorder_widget(_app: AppHandle) {}
#[tauri::command]
pub fn hide_recorder_widget(_app: AppHandle) {}

/// 对应 Windows 版：`pub async fn show_recorder_select(app: AppHandle) -> Result<(), String>`
#[tauri::command]
pub async fn show_recorder_select(_app: AppHandle) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub fn hide_recorder_select(_app: AppHandle) {}

/// 对应 Windows 版：`pub fn get_recorder_select_coords(app: AppHandle) -> Result<serde_json::Value, String>`
#[tauri::command]
pub fn get_recorder_select_coords(_app: AppHandle) -> Result<serde_json::Value, String> {
    Err(UNSUPPORTED.into())
}

/// 对应 Windows 版：`pub fn get_recorder_shortcut(app: AppHandle) -> String`
#[tauri::command]
pub fn get_recorder_shortcut(_app: AppHandle) -> String {
    DEFAULT_RECORDER_SHORTCUT.to_string()
}

/// 对应 Windows 版：`pub fn set_recorder_shortcut(app: AppHandle, shortcut: String) -> Result<(), String>`
/// 存下来是**有意的**：用户设过的值不该因为换平台就丢；但它不会真的注册全局快捷键。
#[tauri::command]
pub fn set_recorder_shortcut(_app: AppHandle, shortcut: String) -> Result<(), String> {
    if let Ok(mut g) = recorder_shortcut_state().lock() {
        *g = shortcut;
    }
    Ok(())
}

/// 对应 Windows 版：`pub fn read_recorder_shortcut(app: &AppHandle) -> String`
pub fn read_recorder_shortcut(_app: &AppHandle) -> String {
    recorder_shortcut_state()
        .lock()
        .map(|s| s.clone())
        .unwrap_or_else(|_| DEFAULT_RECORDER_SHORTCUT.to_string())
}

/// 对应 Windows 版：`pub fn register_recorder_shortcut(app: &AppHandle, sc: &str) -> Result<(), String>`
pub fn register_recorder_shortcut(_app: &AppHandle, _sc: &str) -> Result<(), String> {
    Ok(())
}

/// 对应 Windows 版：`pub fn delete_recording_file(path: String) -> Result<(), String>`
///
/// ⚠ 这里**可以**真实删除（rm 一个不存在的路径是幂等无害的），但为避免误删用户文件，
/// 仍然直接返回不支持：非 Windows 上这个命令没有任何正常调用场景。
#[tauri::command]
pub fn delete_recording_file(_path: String) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

/// 对应 Windows 版：`pub async fn convert_recording_to_gif(app: AppHandle, mp4_path: String) -> Result<String, String>`
#[tauri::command]
pub async fn convert_recording_to_gif(_app: AppHandle, _mp4_path: String) -> Result<String, String> {
    Err(UNSUPPORTED.into())
}
