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
/// `ClipboardPollResult` 需要 `#[derive(Serialize)]` 才能作为 Tauri 命令的返回类型
/// （见该结构体定义处的说明）。本桩原先只 derive 了 Debug/Clone/Default，Linux 编译因此失败。
use serde::Serialize;

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
///
/// ⚠ derive 必须与 Windows 侧**逐字一致**：`#[derive(Serialize)]` + `#[serde(rename_all = "camelCase")]`。
///   少写 `Serialize` 时，`clipboard_poll_image`（返回 `Option<ClipboardPollResult>`）会编译失败：
///   `the method 'async_kind' exists for &impl Future<Output = Result<Option<ClipboardPollResult>, String>>,
///   but its trait bounds were not satisfied` —— Tauri 要求命令返回类型可序列化，
///   而这条错误信息里**不会**提到「缺少 Serialize」，非常难定位。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[derive(Debug, Clone, Default)]
pub struct ClipboardPollResult {
    pub hash: String,
    pub temp_path: String,
    pub thumbnail: String,
}

/// 快捷键类型：**直接复用** `tauri_plugin_global_shortcut::Shortcut`，不自造别名。
///
/// ⚠ 这里曾写成 `pub type Shortcut = String;`（当成占位），后果是 main.rs 里
///   `screenshot::parse_shortcut(..).map(|sc| shortcut == &sc)` 的左侧 `shortcut`
///   是插件的**真** `Shortcut`、右侧变成 `String` ⇒ `Shortcut: PartialEq<String>` 不存在
///   ⇒ 编译报 `can't compare Shortcut with String`。
///   该插件是**跨平台**依赖（非 cfg 门控），真实类型在 Linux 上同样可用，
///   所以正确做法是引用它，而不是让每个调用点去适配假类型。
pub use tauri_plugin_global_shortcut::Shortcut;

// ============ 公共 API 桩 ============

pub fn mark_overlay_destroyed(_label: &str) {}

#[tauri::command]
pub fn hide_overlay_window(_app: AppHandle) {}

#[tauri::command]
pub fn reveal_screenshot_overlay(_app: AppHandle) {}

/// 透明覆盖窗背景透明化（Linux / WebKitGTK 实现，对齐 Windows 的同名命令）。
///
/// Windows 侧这一步靠 WebView2 的 `ICoreWebView2Controller2::SetDefaultBackgroundColor(A=0)`
/// 把 WebView 绘制层的默认背景设为全透明——这是「浮岛 / 桌宠 / 歌词」这类置顶浮层能
/// 真正透出桌面（而不是露出一块白底或黑底）的关键。
///
/// WebKitGTK 没有 COM 控制器，等价能力是 `WebKitWebView::set_background_color`，
/// Tauri 把它包成 `Webview::set_background_color`（Linux 有实现，见 tauri 源码
/// `src/webview/mod.rs`，仅 macOS/iOS 标注 Not implemented）。
///
/// 与 Windows 的差异（重要，避免重复造轮子）：
/// wry 在**建窗时**只要 `transparent == true` 就已经设过一次全透明
/// （wry-0.55 `src/webkitgtk/mod.rs`：`if attributes.transparent { webview.set_background_color(RGBA(0,0,0,0)) }`），
/// 所以本命令在 Linux 上通常是幂等的「再确认一次」。保留真实实现而非空桩的收益：
///   1. 与 Windows 语义对齐——浮层页面前端无条件 invoke 本命令，两边行为一致；
///   2. 兜住「建窗时 profile 显式传 transparent=false、运行期又要透明」的场景；
///   3. 万一主窗的 `backgroundColor` 之类配置影响到浮窗，这里有明确的纠正点。
///
/// 注意「两层透明」缺一不可：窗口级透明来自建窗期的 `.transparent(true)`
/// （GTK 侧铺 RGBA visual，需要合成器支持，GNOME/KDE 默认满足）；本命令只管
/// WebView 绘制层。`set_background_color` 内部经 dispatcher 投递到主线程，
/// 因此不必像 Windows 版那样手动 `run_on_main_thread`。
#[tauri::command]
pub fn set_overlay_transparent(webview: Webview, _app: AppHandle) {
    let label = webview.label().to_string();
    if let Err(e) = webview.set_background_color(Some(tauri::webview::Color(0, 0, 0, 0))) {
        eprintln!("[overlay] 设置 WebView 透明背景失败 label={label}: {e}");
    }
}

/// 调整覆盖窗的重绘频率。
///
/// Windows 版的用途是「透明分层窗失焦被 WebView2 判定为遮挡 → 停渲染」，故用定时器
/// 强制重绘续命。WebKitGTK 不按 Windows 那套遮挡检测停渲染，Linux 上无需该机制，
/// 保留同名空实现只为不破坏前端调用契约。
#[tauri::command]
pub fn set_overlay_repaint_rate(_webview: Webview, _interval_ms: u64) {}

/// 立即呈现覆盖窗（Windows 版用于唤醒被判定遮挡的 renderer）。
/// Linux 无此问题，空实现。
#[tauri::command]
pub fn present_overlay_now(_webview: Webview) {}

#[tauri::command]
pub fn get_screenshot_desktop_rect() -> Result<serde_json::Value, String> {
    Err("截图在 Android/Linux/macOS 上尚未实现 (Unsupported)".into())
}

#[tauri::command]
pub fn list_windows(_app: AppHandle) -> Result<Vec<WindowInfo>, String> {
    Ok(Vec::new())
}

#[tauri::command]
pub fn get_window_title(_hwnd: u64) -> String {
    String::new()
}

#[tauri::command]
pub fn capture_window_full(_hwnd: u64) -> Result<tauri::ipc::Response, String> {
    Err("capture_window_full 在 Android/Linux/macOS 上尚未实现 (Unsupported)".into())
}

pub fn capture_screen() -> Result<Vec<u8>, String> {
    Err("capture_screen 在 Android/Linux/macOS 上尚未实现 (Unsupported)".into())
}

pub fn capture_recorder_snapshot() {}

#[tauri::command]
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

/// 对应 Windows 版：
///   `pub fn peek_screenshot(state: State<'_, Mutex<ScreenshotData>>) -> Result<serde_json::Value, String>`
///
/// ⚠ 这里原先写的是 `peek_screenshot() -> Result<Option<Shot>, String>` —— 那是**旧签名**，
///   Windows 侧后来改成了「吃 `ScreenshotData` 状态、返回 JSON」，桩没跟着改。
///   后果不是功能退化，而是 Tauri 的 `generate_handler!` 宏按**实际类型**分派
///   （async → `async_kind`，同步 → `blocking_kind`），签名对不上就直接编译失败：
///   `the method 'blocking_kind' exists for &Result<Option<Shot>, String>, but its
///   trait bounds were not satisfied`。
///   ⇒ **桩的签名必须与 Windows 侧逐字一致**（参数、返回类型、async 性），这是本文件最易踩的坑。
#[tauri::command]
pub fn peek_screenshot(
    _state: tauri::State<'_, Mutex<ScreenshotData>>,
) -> Result<serde_json::Value, String> {
    Err("截图预览仅在 Windows 上可用（GDI 内存 DC）".into())
}

#[tauri::command]
pub fn clipboard_write_image(_app: tauri::AppHandle, _base64_png: String) -> Result<(), String> {
    Err("clipboard_write_image 在 Android/Linux/macOS 上尚未实现 (Unsupported)".into())
}

#[tauri::command]
pub fn clipboard_write_image_from_path(_app: tauri::AppHandle, _path: String) -> Result<(), String> {
    Err("clipboard_write_image_from_path 在 Android/Linux/macOS 上尚未实现 (Unsupported)".into())
}

/// 对应 Windows 版：
///   `pub fn clipboard_diagnose(app, write_test: Option<bool>, expect_w: Option<u32>, expect_h: Option<u32>, series: Option<bool>) -> Result<serde_json::Value, String>`
///
/// ⚠ 同 `peek_screenshot`：桩原先是 `clipboard_diagnose() -> Result<ClipboardPollResult, String>`，
///   那是**旧签名**（Windows 侧早已改成吃 5 个可选参数、返回 JSON）。签名不匹配会让
///   `generate_handler!` 的 `blocking_kind` 分派失败 → 编译错误。
#[tauri::command]
pub fn clipboard_diagnose(
    _app: tauri::AppHandle,
    _write_test: Option<bool>,
    _expect_w: Option<u32>,
    _expect_h: Option<u32>,
    _series: Option<bool>,
) -> Result<serde_json::Value, String> {
    // 诊断命令：返回结构完整的「无数据」结果，而不是 Err ——
    // 调用方（诊断面板）按固定 JSON 形状渲染，缺字段会连带崩前端。
    Ok(serde_json::json!({
        "ok": false,
        "supported": false,
        "reason": "剪贴板诊断在非 Windows 平台未实现",
    }))
}

pub fn read_screenshot_shortcut(_app: &AppHandle) -> String {
    "Ctrl+Shift+S".into()
}

/// 解析 `"Ctrl+Shift+S"` 这类字符串为 `Shortcut`。
///
/// 与 Windows 版共用插件自带的 `Shortcut::from_str`，**不另写一份解析逻辑**：
/// 两边必须对同一串文本得出相等的结果，否则 Linux 上「快捷键设置里显示已注册」
/// 与实际状态会不一致。解析失败按 Windows 版相同的语义返回 Err。
pub fn parse_shortcut(s: &str) -> Result<Shortcut, String> {
    use std::str::FromStr;
    Shortcut::from_str(s).map_err(|e| format!("快捷键字符串无效: {e}"))
}

pub fn register_screenshot_shortcut(_app: &AppHandle, _sc: &str) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn get_screenshot_shortcut(_app: AppHandle) -> String {
    "Ctrl+Shift+S".into()
}

#[tauri::command]
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

#[tauri::command]
pub fn get_clipboard_shortcut(_app: AppHandle) -> String {
    DEFAULT_CLIPBOARD_SHORTCUT.into()
}

#[tauri::command]
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

#[tauri::command]
pub fn get_dropzone_shortcut(_app: AppHandle) -> String {
    DEFAULT_DROPZONE_SHORTCUT.into()
}

#[tauri::command]
pub fn set_dropzone_shortcut(_app: AppHandle, _shortcut: String) -> Result<(), String> {
    Ok(())
}

pub const DEFAULT_FAVORITE_SHORTCUT: &str = "Ctrl+Shift+N";

pub fn favorite_shortcut_state() -> &'static Mutex<String> {
    static S: Mutex<String> = Mutex::new(String::new());
    &S
}

pub fn read_favorite_shortcut(_app: &AppHandle) -> String {
    DEFAULT_FAVORITE_SHORTCUT.into()
}

pub fn register_favorite_shortcut(_app: &AppHandle, _sc: &str) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn get_favorite_shortcut(_app: AppHandle) -> String {
    DEFAULT_FAVORITE_SHORTCUT.into()
}

#[tauri::command]
pub fn set_favorite_shortcut(_app: AppHandle, _shortcut: String) -> Result<(), String> {
    Ok(())
}

/// 命中测试：返回屏幕坐标 (x, y) 下最顶层窗口的标题。
///
/// 对应 Windows 版 `#[tauri::command] pub async fn window_at_point(app, x: i32, y: i32) -> Result<String, String>`
/// （实现在 `src/screenshot.rs:762`，内部走 `WindowFromPoint` + `GetWindowRect`）。
///
/// ⚠ 必须补上这个命令，否则 main.rs 的 `invoke_handler` 列表在非 Windows 目标上
///   编译失败（`could not find __cmd__window_at_point in screenshot`）——
///   即使该功能在 Linux 上完全用不到，**命令本身仍需存在**才能通过编译。
#[tauri::command]
pub async fn window_at_point(
    _app: tauri::AppHandle,
    _x: i32,
    _y: i32,
) -> Result<String, String> {
    Err("窗口命中测试仅在 Windows 上可用（依赖 Win32 WindowFromPoint）".into())
}

// ============ 补齐：Windows 侧有、本桩原先缺失的命令 ============
//
// 这批函数是「Windows 侧真实实现里存在、但非 Windows 桩里漏写」的。
// 漏写的后果不是功能退化，而是**编译直接失败**：
//   main.rs 的 `invoke_handler` 会为每个命令引用 `__cmd__<名字>` 宏，
//   而该宏由 `#[tauri::command]` 生成 —— 桩里没有这个函数 ⇒ 宏不存在 ⇒ 编译报错。
// ⇒ 即便某功能在 Linux 上完全用不到，**命令桩也必须存在**，否则整个 crate 编不过。
//
// 签名逐字取自 `src/screenshot.rs`（生成方式：括号配平提取，避免手抄多行签名出错）。

/// 对应 Windows 版：`clipboard_poll_image(last_hash: Option<String>)`
#[tauri::command]
pub async fn clipboard_poll_image(
    _last_hash: Option<String>,
) -> Result<Option<ClipboardPollResult>, String> {
    // 剪贴板轮询无内容可报：返回 Ok(None) 而不是 Err，让前端的轮询循环正常继续，
    // 而不是每次都弹一条错误（Linux 上剪贴板能力同样缺失，但不应制造噪音）。
    Ok(None)
}

/// 对应 Windows 版：`crop_native_rgba(x, y, w, h) -> Result<tauri::ipc::Response, String>`
#[tauri::command]
pub async fn crop_native_rgba(
    _x: i32,
    _y: i32,
    _w: i32,
    _h: i32,
) -> Result<tauri::ipc::Response, String> {
    Err("原生裁剪仅在 Windows 上可用（依赖 GDI 内存 DC 拷贝）".into())
}

/// 对应 Windows 版：`dcomp_is_active(label: String) -> bool`
///
/// 恒 false：非 Windows 没有 DirectComposition 合成路径。
/// 前端用它决定「该窗是否需要手动 Notify 上屏」，false 意味着走常规上屏 —— 正确。
#[tauri::command]
pub fn dcomp_is_active(_label: String) -> bool {
    false
}

/// 对应 Windows 版：`read_recorder_snapshot() -> Result<tauri::ipc::Response, String>`
#[tauri::command]
pub async fn read_recorder_snapshot() -> Result<tauri::ipc::Response, String> {
    Err("录屏快照仅在 Windows 上可用".into())
}

/// 对应 Windows 版：`read_screenshot(scale: f64) -> Result<tauri::ipc::Response, String>`
#[tauri::command]
pub async fn read_screenshot(_scale: f64) -> Result<tauri::ipc::Response, String> {
    Err("截图捕获仅在 Windows 上可用（GDI / WGC）".into())
}

/// 对应 Windows 版：`save_annotated(app, x, y, w, h, annotation_png, name)`
#[tauri::command]
pub async fn save_annotated(
    _app: tauri::AppHandle,
    _x: i32,
    _y: i32,
    _w: i32,
    _h: i32,
    _annotation_png: Vec<u8>,
    _name: String,
) -> Result<String, String> {
    Err("截图标注保存仅在 Windows 上可用".into())
}

/// 对应 Windows 版：`save_cropped(app, x, y, w, h, name)`
#[tauri::command]
pub async fn save_cropped(
    _app: tauri::AppHandle,
    _x: i32,
    _y: i32,
    _w: i32,
    _h: i32,
    _name: String,
) -> Result<String, String> {
    Err("截图裁剪保存仅在 Windows 上可用".into())
}

/// 对应 Windows 版：`save_screenshot(app, bytes, width, height, name)`
///
/// ⚠ 这个其实**可以在 Linux 上真实工作**（把收到的 PNG 字节写到用户选定的路径），
///   但签名里没有路径参数（路径由前端先调 dialog 选定再传），缺了落盘目标就无从实现；
///   且前端在 Linux 上根本不会走到这里（截图入口已不可用）。故返回不支持，不做半截实现。
#[tauri::command]
pub async fn save_screenshot(
    _app: tauri::AppHandle,
    _bytes: Vec<u8>,
    _width: u32,
    _height: u32,
    _name: String,
) -> Result<String, String> {
    Err("截图保存仅在 Windows 上可用".into())
}

/// 对应 Windows 版：`start_screenshot(app, _state)`
#[tauri::command]
pub async fn start_screenshot(
    _app: tauri::AppHandle,
    _state: tauri::State<'_, Mutex<ScreenshotData>>,
) -> Result<(), String> {
    Err("截图功能仅在 Windows 上可用".into())
}
