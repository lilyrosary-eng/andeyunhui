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

/// 最近一次截屏的**原生 RGBA 字节**（与 Windows 侧同结构）。
/// 裁剪/保存全部在 Rust 侧基于它完成，不走「整图过 IPC 再回传」。
static SHOT: Mutex<Option<Shot>> = Mutex::new(None);

/// 取当前笔记 id（把 State 绑到局部变量 —— `app.state::<T>().lock()` 直接链式会在
/// 语句结束时 drop 掉临时 State，导致 E0716）。
fn note_id_of(app: &tauri::AppHandle) -> String {
    use tauri::Manager;
    let st = app.state::<Mutex<ScreenshotData>>();
    st.lock().map(|s| s.note_id.clone()).unwrap_or_default()
}

/// 逻辑桌面尺寸（物理 ÷ 窗口 DPR）。Wayland 的 Xinerama 给的是物理像素，必须除。
fn logical_desktop(app: &tauri::AppHandle) -> Result<(f64, f64, f64), String> {
    use tauri::Manager;
    let rect = get_screenshot_desktop_rect()?;
    let w = rect["width"].as_f64().unwrap_or(0.0);
    let h = rect["height"].as_f64().unwrap_or(0.0);
    let rs = rect["scale"].as_f64().unwrap_or(1.0).max(0.0001);
    // DPR 优先取覆盖窗自己的（Wayland 下它就是实际缩放），拿不到再退回 rect.scale
    let dpr = app
        .get_webview_window("screenshot-overlay")
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(rs)
        .max(0.0001);
    if w <= 0.0 || h <= 0.0 {
        return Err("取不到桌面尺寸".to_string());
    }
    // rect 可能是物理（Wayland/XWayland）也可能是逻辑（Windows 语义），按数值判断：
    // 若 rect.scale 已经是真实 DPR（>1）则 width 是逻辑值，否则 width 是物理值。
    let (lw, lh) = if rs > 1.01 { (w, h) } else { (w / dpr, h / dpr) };
    Ok((lw, lh, dpr))
}

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
pub fn hide_overlay_window(app: AppHandle) {
    // 截图结束（保存/取消）必须把覆盖层收起来，否则它会一直挡在整个屏幕上。
    // 同时复位 showing，避免下一次「按下热键被当成重复触发」。
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("screenshot-overlay") {
        let _ = w.hide();
    }
    // 同样必须把 guard 绑成命名变量（if-let 的临时值会活到块尾，与 st 析构冲突）。
    let st = app.state::<Mutex<ScreenshotData>>();
    let mut guard = match st.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    guard.showing = false;
    guard.capturing = false;
}

#[tauri::command]
pub fn reveal_screenshot_overlay(app: AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("screenshot-overlay") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

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

// ============================================================================
// X11 实现（Linux）
// ============================================================================
//
// Windows 的 GDI/WGC 那套在 Linux 上不存在，X11 侧对应能力：
//   - 虚拟桌面矩形  → Xinerama（多屏并集），退化时用根窗口几何
//   - 窗口枚举      → XQueryTree + _NET_WM_NAME + _NET_WM_PID
//   - 窗口/屏幕捕获 → XGetImage(ZPixmap) + image crate 编码 PNG
//
// ⚠ 已知边界（与 Windows 的实质差异，不是偷懒）：
//   1. **仅覆盖 X11 / XWayland 窗口**。纯 Wayland 会话下 compositor 不允许应用
//      枚举/捕获其他窗口，本实现会拿到空列表。真正的 Wayland 方案是
//      xdg-desktop-portal 的 Screenshot/ScreenCast 接口（需用户交互授权 + D-Bus 异步回调），
//      属另一套架构，未纳入。
//   2. **没有「截图时排除本应用自身」的等价物**。Windows 侧对覆盖窗设
//      WDA_EXCLUDEFROMCAPTURE，本实现没有对应机制 ⇒ 在 X11 下对本应用截图时，
//      浮岛/覆盖窗会出现在画面里（仅影响应用自己截的图，不影响系统截图）。
//   3. 捕获本应用自己的窗口在 X11 下会抓到**当前屏幕像素**（无 DWM 的「窗口独立内容」
//      概念），不是离屏渲染结果。
//
// 依赖：`x11`（pkg-config 链接 libX11，本机 x11.pc 1.8.13）+ `image`（PNG 编码，项目已有）。

// x11 crate 的绑定大量使用 C 原始类型别名，这里统一引入避免到处写 `std::ffi::`
use std::ffi::{c_char, c_int, c_uint, c_ulong, c_void};

/// X11 未映射状态：IsViewable（x11 crate 未导出该全局常量，此处按 X.h 定义）
const IS_VIEWABLE: i32 = 2;
/// ZPixmap 格式（XGetImage）
const Z_PIXMAP: c_int = 2;
/// AllPlanes（XGetImage 的平面掩码，取全部）
const ALL_PLANES: c_ulong = 0xFFFF_FFFF;
/// 预定义 Atom（x11 crate 未导出 Xatom 枚举，按 X11.h 的 XA_* 数值）
const XA_STRING: u64 = 31;
const XA_WM_NAME: u64 = 39;

/// 进程内只需初始化一次的 Xlib 线程支持 + 错误处理器安装。
static X11_INIT: std::sync::Once = std::sync::Once::new();

/// 吞掉 X 协议错误，但**记录**下来。
///
/// Xlib 的**默认**错误处理器会 `exit(1)` —— 也就是说，只要我们发出的任何一个
/// X 请求有错（抓一个刚被销毁的窗口、对一个不可见 drawable 取图……），
/// 整个 Tauri 进程就会被 X server 干掉。截图是用户随手触发的功能，
/// 绝不能因为一次 BadMatch 让应用崩溃，故必须替换成返回 0 的处理器。
/// 仍然打日志：否则「请求被 server 判错」这件事完全不可见，只会表现为
/// 「等不到 ShmCompletion 然后超时」，排查时完全瞎。
unsafe extern "C" fn swallow_x_error(
    _display: *mut x11::xlib::Display,
    err: *mut x11::xlib::XErrorEvent,
) -> c_int {
    if !err.is_null() {
        let e = &*err;
        eprintln!(
            "[screenshot/x11] X 请求被拒绝: error_code={} request_code={} minor={} resource={} —— 已忽略（不终止进程）",
            e.error_code, e.request_code, e.minor_code, e.resourceid
        );
    }
    0
}

/// RAII：打开的显示连接在 drop 时关闭，避免每次调用都漏 `XCloseDisplay`。
struct DisplayGuard(*mut x11::xlib::Display);

impl Drop for DisplayGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { x11::xlib::XCloseDisplay(self.0) };
        }
    }
}

/// 打开 X11 显示连接（`$DISPLAY`，传 null 让 Xlib 自己取环境变量）。
fn open_display() -> Result<DisplayGuard, String> {
    X11_INIT.call_once(|| unsafe {
        x11::xlib::XInitThreads();
        // 必须在任何 X 请求之前替换掉「遇错即 exit(1)」的默认处理器
        x11::xlib::XSetErrorHandler(Some(swallow_x_error));
    });
    let dpy = unsafe { x11::xlib::XOpenDisplay(std::ptr::null()) };
    if dpy.is_null() {
        return Err("无法连接 X11 显示（DISPLAY 未设置或 XWayland 不可用）".into());
    }
    Ok(DisplayGuard(dpy))
}

/// `XInternAtom` 的安全包装。
unsafe fn intern_atom(dpy: *mut x11::xlib::Display, name: &[u8]) -> u64 {
    match std::ffi::CString::new(name) {
        Ok(c) => x11::xlib::XInternAtom(dpy, c.as_ptr(), 0),
        Err(_) => 0,
    }
}

/// 读一个 CARDINAL 属性（如 `_NET_WM_PID`）。
///
/// ⚠ `x11` crate 生成的绑定把 C 参数名反写成了 `_12.._1`，实际调用顺序仍按
/// C 签名：`(dpy, window, property, long_offset, long_length, delete, req_type,
/// actual_type, actual_format, nitems, bytes_after, prop)`。
unsafe fn get_cardinal_prop(
    dpy: *mut x11::xlib::Display,
    win: x11::xlib::Window,
    atom: u64,
) -> Option<u64> {
    let mut actual_type: u64 = 0;
    let mut actual_fmt: i32 = 0;
    let mut nitems: u64 = 0;
    let mut bytes_after: u64 = 0;
    let mut prop: *mut u8 = std::ptr::null_mut();
    let rc = x11::xlib::XGetWindowProperty(
        dpy, win, atom, 0, 1, 0, 0, &mut actual_type, &mut actual_fmt, &mut nitems,
        &mut bytes_after, &mut prop,
    );
    if rc != 0 || prop.is_null() || nitems == 0 {
        if !prop.is_null() {
            x11::xlib::XFree(prop as *mut c_void);
        }
        return None;
    }
    let v = *(prop as *const u32) as u64;
    x11::xlib::XFree(prop as *mut c_void);
    Some(v)
}

/// 读一个字符串属性（UTF-8 / STRING，如 `_NET_WM_NAME`）。
unsafe fn get_text_prop(
    dpy: *mut x11::xlib::Display,
    win: x11::xlib::Window,
    atom: u64,
) -> Option<String> {
    if atom == 0 {
        return None;
    }
    let mut actual_type: u64 = 0;
    let mut actual_fmt: i32 = 0;
    let mut nitems: u64 = 0;
    let mut bytes_after: u64 = 0;
    let mut prop: *mut u8 = std::ptr::null_mut();
    // long_length 以 32 位字为单位，取 1024 字 = 4KB，足够窗口标题
    let rc = x11::xlib::XGetWindowProperty(
        dpy, win, atom, 0, 1024, 0, 0, &mut actual_type, &mut actual_fmt, &mut nitems,
        &mut bytes_after, &mut prop,
    );
    if rc != 0 || prop.is_null() || nitems == 0 {
        if !prop.is_null() {
            x11::xlib::XFree(prop as *mut c_void);
        }
        return None;
    }
    let bytes = std::slice::from_raw_parts(prop, nitems as usize);
    let s = String::from_utf8_lossy(bytes)
        .trim_end_matches('\0')
        .trim()
        .to_string();
    x11::xlib::XFree(prop as *mut c_void);
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// `XFetchName`（读 `WM_NAME`，老式应用只有这个）。
unsafe fn fetch_name(dpy: *mut x11::xlib::Display, win: x11::xlib::Window) -> Option<String> {
    let mut name: *mut c_char = std::ptr::null_mut();
    if x11::xlib::XFetchName(dpy, win, &mut name) == 0 || name.is_null() {
        return None;
    }
    let s = std::ffi::CStr::from_ptr(name).to_string_lossy().trim().to_string();
    x11::xlib::XFree(name as *mut c_void);
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// 把窗口内坐标原点换算成根（桌面）坐标。
///
/// 注意：X11 里 `XGetWindowAttributes` 返回的 x/y 是**相对父窗口**的，
/// 而 Windows 侧 `WindowInfo.x/y` 语义是屏幕绝对坐标 ⇒ 必须换算，
/// 否则所有窗口的左上角都会挤在左上角附近，绿色高亮框会全部错位。
unsafe fn to_root_coords(
    dpy: *mut x11::xlib::Display,
    root: x11::xlib::Window,
    win: x11::xlib::Window,
    x: i32,
    y: i32,
) -> (i32, i32) {
    let mut rx: i32 = 0;
    let mut ry: i32 = 0;
    let mut child: x11::xlib::Window = 0;
    if x11::xlib::XTranslateCoordinates(dpy, win, root, x, y, &mut rx, &mut ry, &mut child) == 0
    {
        return (x, y); // 失败则退回原值，至少不是 0
    }
    (rx, ry)
}

/// 把 XImage 的像素读成 RGBA 图像（统一补 alpha=255）。
///
/// X11 的 ZPixmap 常见 32bpp（小端下内存序 **BGRX**）或 24bpp（**BGR**），
/// 两者都是「蓝在最低地址」⇒ R 取 +2、G 取 +1、B 取 +0。
unsafe fn ximage_to_rgba(
    img: *mut x11::xlib::XImage,
    w: i32,
    h: i32,
) -> Option<image::RgbaImage> {
    use image::{Rgba, RgbaImage};

    let im = &*img;
    let bpp = im.bits_per_pixel / 8;
    if bpp != 3 && bpp != 4 {
        return None;
    }
    let mut out = RgbaImage::new(w as u32, h as u32);
    let bytes = im.bytes_per_line as isize;
    let base = im.data as *const u8;
    for row in 0..h {
        for col in 0..w {
            let p = base.offset(row as isize * bytes + col as isize * bpp as isize);
            out.put_pixel(col as u32, row as u32, Rgba([*p.add(2), *p.add(1), *p, 255]));
        }
    }
    Some(out)
}

/// 单块抓取时允许的最大像素数。
///
/// X11 的 GetImage **reply 里直接带像素数据**，上限约 65535 个 32 位字
/// ≈ 256KB ≈ 6.5 万像素。本机屏幕 3840×2160 需 33MB，一次性 `XGetImage`
/// 必然 `BadMatch`（实测已验证）。
const TILE_MAX_PIXELS: i64 = 60_000; // 留余量
/// 分块宽度（像素）。256 × 234 ≈ 5.99 万，稳在上限内。
const TILE_W: i32 = 256;
const TILE_H: i32 = (TILE_MAX_PIXELS / TILE_W as i64) as i32;

/// 捕获一块 drawable 的像素 → RGBA 图像，**分块抓取后拼接**。
///
/// # 为什么不用 MIT-SHM
///
/// 理论上 XShmGetImage（共享内存）能绕开上面的 reply 上限，一次搞定整屏。
/// 本项目实测走了 5 轮仍不可用：请求发出后连接上**收不到任何事件**
/// （既无 ShmCompletion 也无 X 错误，shm_event_base=65、收到事件列表为空），
/// 加 XFlush 也没有；期间还踩了两个更隐蔽的坑：
///   - `XSync` **不足以**等 SHM 写完：它的 reply 由 server 主循环同步产生，
///     可能早于异步 SHM worker；而 X11 不保证 reply 一定先于后续事件到达；
///   - 直接阻塞 `XNextEvent` 等 ShmCompletion 会**永久挂死**（请求被判错时
///     server 只发 X 错误、不发 completion），实测卡死 7 分钟。
/// ⇒ 改走「切小块 + 同步 XGetImage」：只用最基础、兼容性最好的 XGetImage，
///   代价是 3434×1896 需要约 110 次往返（实测在毫秒级，完全可接受）。
///   纯 X11 会话与 XWayland 下行为一致。
unsafe fn capture_drawable(
    dpy: *mut x11::xlib::Display,
    drawable: x11::xlib::Drawable,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<image::RgbaImage, String> {
    if w <= 0 || h <= 0 {
        return Err(format!("捕获区域尺寸非法: {w}x{h}"));
    }
    let mut out = image::RgbaImage::new(w as u32, h as u32);

    let mut ty = 0i32;
    while ty < h {
        let th = TILE_H.min(h - ty);
        let mut tx = 0i32;
        while tx < w {
            let tw = TILE_W.min(w - tx);
            let img = x11::xlib::XGetImage(
                dpy,
                drawable,
                x + tx,
                y + ty,
                tw as c_uint,
                th as c_uint,
                ALL_PLANES,
                Z_PIXMAP,
            );
            if img.is_null() {
                return Err(format!(
                    "XGetImage 失败（{tw}x{th} @ {}+{}，窗口可能已销毁/不可见）",
                    x + tx,
                    y + ty
                ));
            }
            // 把这一块贴进大图
            let tile = ximage_to_rgba(img, tw, th);
            x11::xlib::XDestroyImage(img);
            let tile = tile.ok_or_else(|| "暂不支持的像素深度".to_string())?;
            image::imageops::replace(&mut out, &tile, i64::from(tx), i64::from(ty));
            tx += tw;
        }
        ty += th;
    }
    Ok(out)
}

/// 编码为 PNG 字节流（与 Windows 侧返回格式一致，前端统一按 PNG 消费）。
fn encode_png(img: &image::RgbaImage) -> Result<Vec<u8>, String> {
    let mut buf: Vec<u8> = Vec::with_capacity(img.width() as usize * img.height() as usize / 2);
    image::DynamicImage::ImageRgba8(img.clone())
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
        .map_err(|e| format!("PNG 编码失败: {e}"))?;
    Ok(buf)
}

/// 返回虚拟桌面矩形（物理像素）与缩放比。
///
/// JSON 形状与 Windows 侧**逐字一致**：`{x, y, width, height, scale}`。
/// 前端用它算截图覆盖窗的「逻辑全屏」尺寸（`inner_size` 取逻辑像素）。
///
/// `scale` 恒为 1.0：X11 没有 Windows 那套每显示器 DPI 缩放，
/// X11 坐标本身就是物理像素；Wayland 下由 compositor 自行处理。
#[tauri::command]
pub fn get_screenshot_desktop_rect() -> Result<serde_json::Value, String> {
    let guard = open_display()?;
    let dpy = guard.0;

    let (mut min_x, mut min_y, mut max_x, mut max_y) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);

    // 优先 Xinerama（多显示器并集，含负坐标的副屏）
    let mut used_xinerama = false;
    if unsafe { x11::xinerama::XineramaIsActive(dpy) } != 0 {
        let mut n: i32 = 0;
        let screens = unsafe { x11::xinerama::XineramaQueryScreens(dpy, &mut n) };
        if !screens.is_null() && n > 0 {
            let list = unsafe { std::slice::from_raw_parts(screens, n as usize) };
            for s in list {
                let x = s.x_org as i32;
                let y = s.y_org as i32;
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x + s.width as i32);
                max_y = max_y.max(y + s.height as i32);
            }
            used_xinerama = true;
        }
        if !screens.is_null() {
            unsafe { x11::xlib::XFree(screens as *mut c_void) };
        }
    }

    // 退化路径：Xinerama 不可用（如单屏且扩展未加载）时用根窗口几何
    if !used_xinerama {
        let root = unsafe { x11::xlib::XDefaultRootWindow(dpy) };
        // XGetGeometry(dpy, drawable, root_return, x, y, width, height, border_width, depth)
        let mut rw: u32 = 0;
        let mut rh: u32 = 0;
        let mut root_ret: u64 = 0;
        let mut bx: i32 = 0;
        let mut by: i32 = 0;
        let mut bw: u32 = 0;
        let mut depth: u32 = 0;
        unsafe {
            x11::xlib::XGetGeometry(
                dpy,
                root,
                &mut root_ret,
                &mut bx,
                &mut by,
                &mut rw,
                &mut rh,
                &mut bw,
                &mut depth,
            )
        };
        min_x = 0;
        min_y = 0;
        max_x = rw as i32;
        max_y = rh as i32;
    }

    let (w, h) = (max_x - min_x, max_y - min_y);
    if w <= 0 || h <= 0 {
        return Err("无法获取虚拟桌面尺寸".into());
    }
    Ok(serde_json::json!({
        "x": min_x,
        "y": min_y,
        "width": w,
        "height": h,
        "scale": 1.0,
    }))
}

/// 枚举「其他进程」的可见顶层窗口，返回**物理像素**矩形，供前端绘制绿色轮廓与窗口识别。
///
/// Linux 上没有 HWND 可用作 `hwnd` 字段 —— 这里填 **X11 window id**（同样是一个
/// 无符号整数，可直接回传给 `get_window_title` / `capture_window_full`）。
///
/// `is_self` 的判定方式与 Windows 不同：Windows 靠枚举自身窗口的 HWND 集合，
/// X11 没有跨进程句柄可比，改用 **`_NET_WM_PID` == 本进程 pid**（更直接也更准）。
#[tauri::command]
pub fn list_windows(_app: AppHandle) -> Result<Vec<WindowInfo>, String> {
    list_windows_x11()
}

/// `list_windows` 的实际实现。独立成普通函数以便单元测试直接调用
/// （Tauri 命令需要 `AppHandle`，测试里拿不到）。
fn list_windows_x11() -> Result<Vec<WindowInfo>, String> {
    let guard = open_display()?;
    let dpy = guard.0;
    let root = unsafe { x11::xlib::XDefaultRootWindow(dpy) };

    let mut root_ret: u64 = 0;
    let mut parent_ret: u64 = 0;
    let mut children: *mut x11::xlib::Window = std::ptr::null_mut();
    let mut count: u32 = 0;
    let rc = unsafe {
        x11::xlib::XQueryTree(dpy, root, &mut root_ret, &mut parent_ret, &mut children, &mut count)
    };
    if rc == 0 || children.is_null() {
        return Ok(Vec::new());
    }

    let atom_net_wm_name = unsafe { intern_atom(dpy, b"_NET_WM_NAME") };
    let atom_net_wm_pid = unsafe { intern_atom(dpy, b"_NET_WM_PID") };
    let my_pid = std::process::id() as u64;

    let list = unsafe { std::slice::from_raw_parts(children, count as usize) };
    // XQueryTree 返回顺序为「底 → 顶」，即数组下标越大越靠上层（越晚获得焦点）
    let mut out: Vec<WindowInfo> = Vec::with_capacity(count as usize);
    for (idx, &w) in list.iter().enumerate() {
        if w == 0 {
            continue;
        }
        let mut attrs = unsafe { std::mem::zeroed::<x11::xlib::XWindowAttributes>() };
        if unsafe { x11::xlib::XGetWindowAttributes(dpy, w, &mut attrs) } == 0 {
            continue;
        }
        // 只要已映射（IsViewable）的窗口
        if attrs.map_state != IS_VIEWABLE {
            continue;
        }
        if attrs.width <= 0 || attrs.height <= 0 {
            continue;
        }
        // 跳过本应用自身的窗口（含浮岛 / 覆盖窗）
        let pid = unsafe { get_cardinal_prop(dpy, w, atom_net_wm_pid) }.unwrap_or(0);
        if pid != 0 && pid == my_pid {
            continue;
        }
        // 标题：优先 _NET_WM_NAME（UTF-8），退回 WM_NAME / XFetchName
        let title = unsafe {
            get_text_prop(dpy, w, atom_net_wm_name)
                .or_else(|| get_text_prop(dpy, w, XA_WM_NAME))
                .or_else(|| fetch_name(dpy, w))
                .or_else(|| get_text_prop(dpy, w, XA_STRING))
                .unwrap_or_default()
        };
        if title.is_empty() {
            continue; // 无标题的多为未映射的辅助窗口，直接过滤
        }
        let (ax, ay) = unsafe { to_root_coords(dpy, root, w, attrs.x, attrs.y) };
        out.push(WindowInfo {
            hwnd: w as u64,
            title,
            x: ax,
            y: ay,
            width: attrs.width,
            height: attrs.height,
            is_self: false,
            is_taskbar: false, // X11 无「任务栏窗口」概念；GNOME 的 dash-to-dock 也在 z 序里，
                               // 前端可按标题自行排除
            z: idx as i64,
        });
    }

    if !children.is_null() {
        unsafe { x11::xlib::XFree(children as *mut c_void) };
    }
    Ok(out)
}

/// 取窗口标题（`hwnd` 传 `list_windows` 返回的 X11 window id）。
#[tauri::command]
pub fn get_window_title(hwnd: u64) -> String {
    let Ok(guard) = open_display() else {
        return String::new();
    };
    let dpy = guard.0;
    let win = hwnd as x11::xlib::Window;
    unsafe {
        let atom = intern_atom(dpy, b"_NET_WM_NAME");
        get_text_prop(dpy, win, atom)
            .or_else(|| get_text_prop(dpy, win, XA_WM_NAME))
            .or_else(|| fetch_name(dpy, win))
            .unwrap_or_default()
    }
}

/// 捕获指定窗口的当前可见内容，返回 PNG 字节流。
///
/// 与 Windows 侧同样「起线程 + 超时守护」：`XGetImage` 是同步阻塞调用，
/// 遇到异常窗口（销毁竞态 / 巨大尺寸 / 服务端不响应）可能长时间不返回，
/// 直接在命令线程里调会拖住整个 IPC 通道。
#[tauri::command]
pub fn capture_window_full(hwnd: u64) -> Result<tauri::ipc::Response, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<Vec<u8>, String>>();
    std::thread::spawn(move || {
        let r = capture_window_inner(hwnd);
        let _ = tx.send(r);
    });
    match rx.recv_timeout(std::time::Duration::from_secs(30)) {
        Ok(Ok(bytes)) => Ok(tauri::ipc::Response::new(bytes)),
        Ok(Err(e)) => Err(e),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            Err("捕获超时：该窗口可能无法正常渲染，请改用普通框选 / 单击窗口。".to_string())
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            Err("捕获线程异常退出".to_string())
        }
    }
}

fn capture_window_inner(hwnd: u64) -> Result<Vec<u8>, String> {
    let guard = open_display()?;
    let dpy = guard.0;
    let win = hwnd as x11::xlib::Window;

    let mut attrs = unsafe { std::mem::zeroed::<x11::xlib::XWindowAttributes>() };
    if unsafe { x11::xlib::XGetWindowAttributes(dpy, win, &mut attrs) } == 0 {
        return Err("取窗口属性失败（窗口可能已销毁）".into());
    }
    if attrs.width <= 0 || attrs.height <= 0 {
        return Err(format!("窗口尺寸非法: {}x{}", attrs.width, attrs.height));
    }
    // ⚠ 必须从**窗口自身**取图，不能从 root window 按偏移取。
    //   实测：对 root drawable 做 XGetImage 必报 BadMatch（error_code=8,
    //   request_code=73），因为 root 的 depth/visual 与按屏幕坐标取图的要求不匹配；
    //   而对窗口 drawable 取图（ImageMagick `import -window <id>` 就是这么做的）正常。
    // ⚠ X11 没有 DWM 那种「窗口独立渲染表面」：这样取到的是窗口当前**露在屏幕上的
    //   那部分**。被遮挡/最小化的窗口会取到错误内容（全屏或黑）。
    //   这是与 Windows `PrintWindow` 的实质差异。
    let img = unsafe {
        capture_drawable(
            dpy,
            win as x11::xlib::Drawable,
            0,
            0,
            attrs.width,
            attrs.height,
        )
    }?;
    encode_png(&img)
}

/// 捕获整个屏幕（虚拟桌面范围），返回 PNG 字节流。
///
/// # ⚠ Wayland 下不可用，且是**故意报错**而不是给一张纯色图
///
/// 本机是 GNOME **Wayland** 会话（XWayland 兼容层）。此时 X11 的 root window
/// 并不是合成后的屏幕画面，而是一张**空白表面** —— 对它做 XShmGetImage 会得到
/// 一张纯色图（实测 3840×2160、颜色数=1、标准差=0）。此时任何"看起来像黑屏"的
/// 返回值都会让上层误判成"屏幕是黑的"，比直接报错更难排查。
///
/// 纯 X11 会话（无 WAYLAND_DISPLAY）下本函数正常。
/// Wayland 的正确做法是 `xdg-desktop-portal` 的 Screenshot 接口
/// （需用户交互授权 + 异步 D-Bus 回调），属另一套架构，未纳入。
pub fn capture_screen() -> Result<Vec<u8>, String> {
    if std::env::var("WAYLAND_DISPLAY")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
    {
        return Err(
            "当前为 Wayland 会话：X11 根窗口不等于屏幕内容，无法全屏捕获（需 xdg-desktop-portal）"
                .into(),
        );
    }
    let rect = get_screenshot_desktop_rect()?;
    let x = rect["x"].as_i64().unwrap_or(0) as i32;
    let y = rect["y"].as_i64().unwrap_or(0) as i32;
    let w = rect["width"].as_i64().unwrap_or(0) as i32;
    let h = rect["height"].as_i64().unwrap_or(0) as i32;

    let guard = open_display()?;
    let dpy = guard.0;
    let root = unsafe { x11::xlib::XDefaultRootWindow(dpy) };
    let img = unsafe { capture_drawable(dpy, root as x11::xlib::Drawable, x, y, w, h) }?;
    encode_png(&img)
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
    state: tauri::State<'_, Mutex<ScreenshotData>>,
) -> Result<serde_json::Value, String> {
    let s = state.lock().map_err(|e| format!("锁失败: {e}"))?;
    Ok(serde_json::json!({
        "ox": s.last_ox,
        "oy": s.last_oy,
        "scale": s.last_scale,
        "windows": s.last_windows,
        "noteId": s.note_id,
        "session": s.session,
    }))
}

// ============ 剪贴板写图（Linux：arboard 真实实现）============
//
// Windows 侧走 Win32 `OpenClipboard` + `SetClipboardData`（见 src/screenshot.rs），Linux 无该 API；
// 这里用 arboard 写入 RGBA8，补齐「截图 → 复制到剪贴板」这条在 Linux 上原先直接报 Unsupported 的路径。
//
// ⚠ 关键：X11 剪贴板是「选区所有权」模型 —— 写入方（本进程）必须在**存活期间持续持有**该选区，
//   一次 drop 就让内容失效（Ctrl+V 拿不到）。所以用一个**进程级常驻**的 Clipboard，绝不每次
//   调用新建后即 drop（那样写进去也立刻失效）。Wayland 下若无 XWayland / wl-clipboard，arboard
//   会返回错误，命令如实返回 Err（与既有「平台不支持」的降级一致，不会崩）。
#[cfg(target_os = "linux")]
static LINUX_CLIPBOARD: std::sync::OnceLock<Mutex<arboard::Clipboard>> = std::sync::OnceLock::new();

#[cfg(target_os = "linux")]
fn linux_clipboard() -> Result<&'static Mutex<arboard::Clipboard>, String> {
    if let Some(c) = LINUX_CLIPBOARD.get() {
        return Ok(c);
    }
    let cb = arboard::Clipboard::new().map_err(|e| format!("初始化系统剪贴板失败: {e}"))?;
    // set 失败说明其它线程已抢先初始化 —— 无害，直接用现有的
    let _ = LINUX_CLIPBOARD.set(Mutex::new(cb));
    LINUX_CLIPBOARD.get().ok_or_else(|| "初始化系统剪贴板失败".to_string())
}

/// 解码图片字节（PNG 等）并写入 Linux 系统剪贴板。
#[cfg(target_os = "linux")]
fn linux_write_image_to_clipboard(bytes: &[u8]) -> Result<(), String> {
    let img = image::load_from_memory(bytes).map_err(|e| format!("图片解码失败: {e}"))?;
    let rgba = img.into_rgba8();
    let (w, h) = rgba.dimensions();
    let data = arboard::ImageData {
        width: w as usize,
        height: h as usize,
        bytes: std::borrow::Cow::Owned(rgba.into_raw()),
    };
    let cb = linux_clipboard()?;
    let mut guard = cb.lock().map_err(|_| "剪贴板访问失败（锁中毒）".to_string())?;
    guard.set_image(data).map_err(|e| format!("写入系统剪贴板失败: {e}"))
}

#[tauri::command]
pub fn clipboard_write_image(_app: tauri::AppHandle, base64_png: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use base64::Engine as _;
        // 兼容 data URL（`data:image/png;base64,xxxx`）与纯 base64 两种入参
        let b64 = base64_png.split(',').nth(1).unwrap_or(&base64_png);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("Base64 解码失败: {e}"))?;
        return linux_write_image_to_clipboard(&bytes);
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = base64_png;
        Err("clipboard_write_image 在 Android/iOS/macOS 上尚未实现 (Unsupported)".into())
    }
}

#[tauri::command]
pub fn clipboard_write_image_from_path(_app: tauri::AppHandle, path: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))?;
        return linux_write_image_to_clipboard(&bytes);
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = path;
        Err("clipboard_write_image_from_path 在 Android/iOS/macOS 上尚未实现 (Unsupported)".into())
    }
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
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<tauri::ipc::Response, String> {
    // 与 Windows 同逻辑：入参是**捕获取原点坐标系**的物理像素矩形，先减 native_ox/oy 再夹取。
    let slot = SHOT.lock().map_err(|e| format!("锁失败: {e}"))?;
    let shot = slot
        .as_ref()
        .ok_or_else(|| "尚无截屏数据，请先触发截图".to_string())?;
    let iw = shot.native_w as i32;
    let ih = shot.native_h as i32;
    let x0 = (x - shot.native_ox).max(0).min(iw - 1);
    let y0 = (y - shot.native_oy).max(0).min(ih - 1);
    let ww = ((w as u32).min((iw - x0) as u32)).max(1);
    let hh = ((h as u32).min((ih - y0) as u32)).max(1);
    let row_bytes = iw as usize * 4;
    let mut out: Vec<u8> = Vec::with_capacity((ww as usize) * (hh as usize) * 4);
    for yy in 0..(hh as usize) {
        let start = ((y0 as usize + yy) * row_bytes) + (x0 as usize * 4);
        out.extend_from_slice(&shot.raw[start..start + (ww as usize) * 4]);
    }
    Ok(tauri::ipc::Response::new(out))
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
    // 契约与 Windows 逐字一致：`[w_le32][h_le32][RGBA…]`，原生物理分辨率直传，
    // 前端用 object-fit 铺满覆盖窗做 GPU 降采样显示（不在 Rust 侧降采样，见 Windows 侧注释）。
    let slot = SHOT.lock().map_err(|e| format!("锁失败: {e}"))?;
    let shot = slot
        .as_ref()
        .ok_or_else(|| "尚无截屏数据，请先触发截图".to_string())?;
    let mut out: Vec<u8> = Vec::with_capacity(8 + shot.raw.len());
    out.extend_from_slice(&shot.native_w.to_le_bytes());
    out.extend_from_slice(&shot.native_h.to_le_bytes());
    out.extend_from_slice(&shot.raw);
    Ok(tauri::ipc::Response::new(out))
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
    app: tauri::AppHandle,
    bytes: Vec<u8>,
    width: u32,
    height: u32,
    name: String,
) -> Result<String, String> {
    // 与 Windows 同语义：`bytes` 可能是 PNG（已编码）或裸 RGBA（crop_native_rgba 的原样输出）。
    let (png, w, h) = if bytes.starts_with(b"\x89PNG") {
        let img = image::load_from_memory(&bytes).map_err(|e| format!("图片解码失败: {e}"))?;
        let (w, h) = (img.width(), img.height());
        (bytes.clone(), w, h)
    } else {
        let img = image::RgbaImage::from_raw(width, height, bytes)
            .ok_or_else(|| "图像尺寸与字节长度不匹配，保存失败".to_string())?;
        let (w, h) = (img.width(), img.height());
        let mut out: Vec<u8> = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .map_err(|e| format!("PNG 编码失败: {e}"))?;
        (out, w, h)
    };

    // 顺带写系统剪贴板（Linux 侧已有 arboard 实现；失败不影响落盘）
    let clip_err = linux_write_image_to_clipboard(&png).err();

    // 落盘：优先 图片目录/andeyunhui-screenshots，退回应用数据目录
    use tauri::Manager;
    let base = app
        .path()
        .picture_dir()
        .ok()
        .map(|p| p.join("andeyunhui-screenshots"))
        .or_else(|| app.path().app_data_dir().ok().map(|p| p.join("screenshots")))
        .ok_or_else(|| "取不到保存目录".to_string())?;
    std::fs::create_dir_all(&base).map_err(|e| format!("创建目录失败: {e}"))?;
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let file = base.join(format!(
        "{}-{}-{}x{}.png",
        if safe.is_empty() { "screenshot" } else { safe.as_str() },
        stamp,
        w,
        h
    ));
    std::fs::write(&file, &png).map_err(|e| format!("写入截图失败: {e}"))?;
    if let Some(e) = clip_err {
        eprintln!("[截图] 写剪贴板失败（已落盘）: {e}");
    }
    Ok(file.to_string_lossy().to_string())
}

/// 对应 Windows 版：`start_screenshot(app, _state)`
/// Linux 版截图启动：**先让覆盖层上屏，再在后台走 portal 抓图**。
///
/// 顺序理由（与 Windows 一致）：覆盖层先显示，用户立刻能看到十字光标与框选；
/// 抓图在后台完成后再发 `screenshot-ready` 把冻结图注进去。若反过来，用户要等 portal 往返
/// （实测 200~600ms）才有反应，体感是"按了没反应"。
#[tauri::command]
pub async fn start_screenshot(
    app: tauri::AppHandle,
    _state: tauri::State<'_, Mutex<ScreenshotData>>,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};

    let overlay = app
        .get_webview_window("screenshot-overlay")
        .ok_or_else(|| "截图覆盖窗未创建（前端应先 ensureOverlayWindow）".to_string())?;

    let (lw, lh, dpr) = logical_desktop(&app)?;
    // 覆盖窗按「逻辑全屏」铺满，位置归零（前端创建时是离屏 -4000,-4000）
    let _ = overlay.set_position(tauri::LogicalPosition::new(0.0, 0.0));
    let _ = overlay.set_size(tauri::LogicalSize::new(lw, lh));
    let _ = overlay.show();
    let _ = overlay.set_focus();

    let note_id = note_id_of(&app);
    {
        let st = app.state::<Mutex<ScreenshotData>>();
        let mut s = st.lock().map_err(|e| format!("锁失败: {e}"))?;
        s.showing = true;
        s.capturing = true;
        s.last_ox = 0.0;
        s.last_oy = 0.0;
        s.last_scale = dpr;
        s.last_windows = Vec::new();
        s.session = s.session.wrapping_add(1);
    }
    let _ = overlay.emit(
        "screenshot-start",
        serde_json::json!({
            "ox": 0.0, "oy": 0.0, "scale": dpr, "windows": [], "noteId": note_id,
        }),
    );

    // 后台抓图：portal 往返 + PNG 解码都很短，但不能占 async 线程（解码是同步 CPU 活）。
    let app2 = app.clone();
    std::thread::spawn(move || {
        use tauri::{Emitter, Manager};
        let res = tauri::async_runtime::block_on(super::portal_shot::capture_png(false));
        let shot = match res {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[截图] portal 抓图失败: {e}");
                if let Some(w) = app2.get_webview_window("screenshot-overlay") {
                    let _ = w.emit("screenshot-error", serde_json::json!({ "message": e }));
                }
                {
                    // 注意：`if let Ok(s) = st.lock()` 会让 MutexGuard 的临时值活到块尾，
                    // 与 `st` 的析构顺序冲突（E0597）。必须先把 guard 绑成命名变量。
                    let st = app2.state::<Mutex<ScreenshotData>>();
                    let mut guard = match st.lock() {
                        Ok(g) => g,
                        Err(_) => return,
                    };
                    guard.capturing = false;
                }
                return;
            }
        };
        // PNG → RGBA（后续裁剪/保存都用这份字节）
        let img = match image::load_from_memory(&shot.png) {
            Ok(i) => i.into_rgba8(),
            Err(e) => {
                eprintln!("[截图] PNG 解码失败: {e}");
                return;
            }
        };
        let (iw, ih) = (img.width(), img.height());
        {
            let mut slot = match SHOT.lock() {
                Ok(s) => s,
                Err(_) => return,
            };
            *slot = Some(Shot {
                raw: img.into_raw(),
                native_w: iw,
                native_h: ih,
                native_ox: 0,
                native_oy: 0,
            });
        }
        // 图是物理像素，覆盖层是逻辑像素 ⇒ 用实际比例回报，前端据此把选区换算成物理坐标
        let scale = iw as f64 / lw.max(1.0);
        {
            let st = app2.state::<Mutex<ScreenshotData>>();
            let mut guard = match st.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            guard.capturing = false;
            guard.last_scale = scale;
        }
        let note_id = note_id_of(&app2);
        if let Some(w) = app2.get_webview_window("screenshot-overlay") {
            let _ = w.emit(
                "screenshot-ready",
                serde_json::json!({
                    "ox": 0.0, "oy": 0.0, "scale": scale, "windows": [], "noteId": note_id,
                }),
            );
        }
    });

    Ok(())
}

// ============================================================================
// 冒烟测试：X11 能力真实验证（不需要 GUI 窗口）
// ============================================================================
//
// 为什么用测试而不是「跑起来截图看」：本工程的截图命令都要经 Tauri IPC 触发，
// 验证就得把整个应用拉起来并弹窗；而 X11 侧的核心是纯 FFI 逻辑，
// 在有 DISPLAY 的环境里 `cargo test` 就能直接打到真实 X server，证据更硬、无副作用。
//
// 无 DISPLAY（CI / 纯无头）时自动跳过并打印原因，不让测试红。

#[cfg(test)]
mod x11_tests {
    use super::*;

    fn have_display() -> bool {
        std::env::var("DISPLAY").map(|v| !v.is_empty()).unwrap_or(false)
    }

    #[test]
    fn desktop_rect_matches_screen() {
        if !have_display() {
            eprintln!("[skip] 无 DISPLAY，跳过");
            return;
        }
        let r = get_screenshot_desktop_rect().expect("应能取到虚拟桌面矩形");
        let w = r["width"].as_i64().unwrap_or(0);
        let h = r["height"].as_i64().unwrap_or(0);
        println!("desktop_rect = {r}");
        assert!(w > 0 && h > 0, "桌面尺寸应 > 0，实际 {w}x{h}");
        // scale 在 X11 下恒为 1.0（X11 坐标本身即物理像素）
        assert_eq!(r["scale"].as_f64(), Some(1.0));
    }

    #[test]
    fn enumerate_and_title() {
        if !have_display() {
            eprintln!("[skip] 无 DISPLAY，跳过");
            return;
        }
        let wins = list_windows_x11().expect("窗口枚举不应失败");
        println!("枚举到 {} 个窗口", wins.len());
        assert!(!wins.is_empty(), "当前桌面至少应有窗口");
        for w in wins.iter().take(10) {
            println!(
                "  win={} title={:?} {}x{}+{}+{} z={}",
                w.hwnd, w.title, w.width, w.height, w.x, w.y, w.z
            );
            assert!(!w.title.is_empty(), "标题不应为空");
            assert!(w.width > 0 && w.height > 0, "窗口尺寸应 > 0");
        }
        // 用返回的 id 反查标题，必须能对上（前端就是这条链路）
        let first = &wins[0];
        let t = get_window_title(first.hwnd);
        println!("反查 title({}) = {:?}", first.hwnd, t);
        assert!(!t.is_empty(), "按 window id 反查标题不应为空");
    }

    #[test]
    fn screen_capture_is_png() {
        if !have_display() {
            eprintln!("[skip] 无 DISPLAY，跳过");
            return;
        }
        match capture_screen() {
            Ok(bytes) => {
                println!("全屏 PNG 字节数 = {}", bytes.len());
                assert!(bytes.len() > 8, "PNG 太小: {}", bytes.len());
                assert_eq!(&bytes[1..4], b"PNG", "应为 PNG 格式");
            }
            Err(e) => {
                // Wayland 会话下预期走到这里：X11 根窗口不是合成画面，
                // 应当明确报错而不是返回一张纯色图。
                println!("全屏捕获按设计报错: {e}");
                assert!(
                    std::env::var("WAYLAND_DISPLAY").is_ok(),
                    "非 Wayland 会话却捕获失败: {e}"
                );
            }
        }
    }

    /// 窗口级捕获：这是 X11 侧**真正可用**的能力（对 XWayland 窗口）。
    /// 校验抓到的不是纯色 —— 否则说明又踩了「异步没等完」的坑。
    #[test]
    fn window_capture_has_real_pixels() {
        if !have_display() {
            eprintln!("[skip] 无 DISPLAY，跳过");
            return;
        }
        let wins = list_windows_x11().expect("窗口枚举不应失败");
        // 挑面积最大的一个，通常是真实应用窗口
        let target = wins
            .iter()
            .max_by_key(|w| (w.width as i64) * (w.height as i64))
            .expect("至少一个窗口");
        println!(
            "目标窗口 {:?} {}x{}+{}+{}",
            target.title, target.width, target.height, target.x, target.y
        );

        let guard = open_display().expect("应能打开显示");
        let dpy = guard.0;
        // 从窗口自身取图（不是 root + 偏移，见 capture_window_inner 里的说明）
        let img = unsafe {
            capture_drawable(
                dpy,
                target.hwnd as x11::xlib::Drawable,
                0,
                0,
                target.width,
                target.height,
            )
        }
        .expect("窗口区域捕获不应失败");

        // 统计不同颜色数：纯色说明没抓到真实内容
        let mut colors = std::collections::HashSet::new();
        for p in img.pixels() {
            colors.insert(p.0);
            if colors.len() > 64 {
                break;
            }
        }
        println!("窗口捕获尺寸 {}x{}，取样颜色数 >= {}", img.width(), img.height(), colors.len());
        assert!(
            colors.len() > 1,
            "抓到的是纯色（颜色数=1）—— 窗口捕获没拿到真实像素"
        );

        if let Ok(dir) = std::env::var("SCREENSHOT_DUMP_DIR") {
            let path = std::path::Path::new(&dir).join("x11-window-capture.png");
            std::fs::write(&path, encode_png(&img).expect("编码失败")).expect("写 PNG 失败");
            println!("已写出 {}", path.display());
        }
    }
}
