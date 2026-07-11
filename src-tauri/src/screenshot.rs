// ================= 微信式截图（多显示器 + 悬浮置顶窗口 + 窗口识别 + 局部/整窗截取）================
// 提供：多显示器整屏物理像素捕获、枚举「其他进程」可见窗口矩形（物理像素）、图片写入剪贴板。
// 实际「选择区域 / 标注 / 窗口识别」在 Web 前端完成（对捕获的全屏图做裁剪），天然规避坐标换算问题。
//
// 关键：DPI 一致性。Tauri v2（TAO/WRY）在 Windows 上默认 Per-Monitor-DPI-Aware V2。
// 在 DPI 感知进程中，GetSystemMetrics / GetWindowRect 返回**真实物理像素**，GDI BitBlt 同坐标系。
//
// 坐标方案（根治「边缘偏移 / 白边 / 截不到」）：
//   覆盖窗的尺寸/位置以「逻辑像素」设定（物理 = 逻辑 × scale_factor）；我们捕获的是
//   **覆盖窗自身的真实矩形**（outer_position/outer_size，物理像素），而非另算的虚拟桌面。
//   截图图在 WebView 内 object-fill 铺满覆盖窗，故：
//     图像像素(x,y) ≡ 窗口内 CSS 像素(x,y)   （预览图已按 scale_factor 降采样，1 CSS px = 1 图像 px）
//   映射退化为恒等，彻底消除偏移；且「捕获区域 == 覆盖窗显示区域」，边缘必然完整覆盖，无白边、无截不到。

use base64::Engine;
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat, RgbaImage};
use serde::Serialize;
use serde_json::json;
use std::borrow::Cow;
use std::io::Cursor;
use std::process;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};


#[derive(Serialize, Clone)]
pub struct WindowInfo {
    pub hwnd: u64,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// 系统 DPI 缩放比（如 150% 显示 → 1.5）。
/// **注意**：此函数返回 `GetDpiForSystem()` 的全局值，混合 DPI 多屏场景下不准确。
/// 覆盖窗创建应使用 `min_monitor_scale()` 取多屏最小缩放比，避免个别显示器裁剪。
fn dpi_scale() -> f64 {
    unsafe {
        let dpi = winapi::um::winuser::GetDpiForSystem();
        if dpi == 0 {
            1.0
        } else {
            dpi as f64 / 96.0
        }
    }
}

/// 多屏枚举结果：物理矩形并集 + 所有显示器中的最小 DPI 缩放比。
struct MonitorLayout {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    min_scale: f64,
}

/// 枚举所有显示器，计算物理矩形并集，同时用 `GetDpiForMonitor` 取每屏独立 DPI，
/// 返回最小缩放比以避免混合 DPI 场景下覆盖窗尺寸偏小 / 边缘裁剪。
fn monitor_layout() -> MonitorLayout {
    #[derive(Clone)]
    struct MData {
        x: i32, y: i32, w: i32, h: i32,
        min_scale: f64,
    }
    let mut data = MData { x: i32::MAX, y: i32::MAX, w: 0, h: 0, min_scale: f64::MAX };

    unsafe extern "system" fn proc(
        hmon: winapi::shared::windef::HMONITOR,
        _hdc: winapi::shared::windef::HDC,
        rect: *mut winapi::shared::windef::RECT,
        lparam: winapi::shared::minwindef::LPARAM,
    ) -> i32 {
        let data = &mut *(lparam as *mut MData);
        let r = &*rect;
        data.x = data.x.min(r.left);
        data.y = data.y.min(r.top);
        let _rw = r.right - r.left;
        let _rh = r.bottom - r.top;
        if r.right > data.x + data.w { data.w = r.right - data.x; }
        if r.bottom > data.y + data.h { data.h = r.bottom - data.y; }

        let mut dpi = 96u32;
        let _ = winapi::um::shellscalingapi::GetDpiForMonitor(
            hmon,
            winapi::um::shellscalingapi::MDT_EFFECTIVE_DPI,
            &mut dpi,
            &mut 0u32,
        );
        let scale = if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 };
        data.min_scale = data.min_scale.min(scale);
        1
    }

    unsafe {
        winapi::um::winuser::EnumDisplayMonitors(
            std::ptr::null_mut(),
            std::ptr::null(),
            Some(proc),
            &mut data as *mut _ as winapi::shared::minwindef::LPARAM,
        );
    }

    if data.x == i32::MAX {
        let ls = dpi_scale();
        return MonitorLayout {
            x: unsafe { winapi::um::winuser::GetSystemMetrics(winapi::um::winuser::SM_XVIRTUALSCREEN) },
            y: unsafe { winapi::um::winuser::GetSystemMetrics(winapi::um::winuser::SM_YVIRTUALSCREEN) },
            w: unsafe { winapi::um::winuser::GetSystemMetrics(winapi::um::winuser::SM_CXVIRTUALSCREEN) },
            h: unsafe { winapi::um::winuser::GetSystemMetrics(winapi::um::winuser::SM_CYVIRTUALSCREEN) },
            min_scale: ls,
        };
    }
    MonitorLayout { x: data.x, y: data.y, w: data.w, h: data.h, min_scale: if data.min_scale == f64::MAX { 1.0 } else { data.min_scale } }
}

/// 取所有显示器中的最小 DPI 缩放比（覆盖窗逻辑像素换算用，确保在高 DPI 屏上不被裁剪）。
fn min_monitor_scale() -> f64 {
    monitor_layout().min_scale
}

/// 计算「所有显示器物理矩形」的并集（多屏覆盖）。
fn virtual_desktop_rect() -> (i32, i32, i32, i32) {
    let m = monitor_layout();
    (m.x, m.y, m.w, m.h)
}

/// 创建悬浮置顶截图窗口（覆盖全虚拟桌面）。
/// 设计为「创建一次、反复复用」：setup 阶段预创建（隐藏），截图时仅 show + 派发事件，避免每次新建 WebView2 实例的卡顿。
/// 尺寸/位置以「逻辑像素」设定，物理像素 = 逻辑 × scale，配合 WebView devicePixelRatio 实现 1:1 对齐。
#[tauri::command]
pub fn create_overlay_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::WebviewUrl;
    if app.get_webview_window("screenshot-overlay").is_some() {
        return Ok(()); // 已存在则复用，不重复创建
    }

    // 用多屏最小 DPI 缩放比换算逻辑尺寸，确保混合 DPI 场景下不会有显示器被裁剪。
    let scale = min_monitor_scale();
    // 覆盖窗精确覆盖「所有显示器物理并集」，否则捕获区域错位 / 绿框偏移。
    // 用 Win32 显示器枚举拿真实物理矩形（GetSystemMetrics 在 PM-DPI-Aware 下返回系统 DPI 逻辑像素，会双重缩小）。
    let (rx, ry, rw, rh) = virtual_desktop_rect();
    let lw = rw as f64 / scale;
    let lh = rh as f64 / scale;
    let lx = rx as f64 / scale;
    let ly = ry as f64 / scale;

    let _win = tauri::WebviewWindowBuilder::new(
        &app,
        "screenshot-overlay",
        WebviewUrl::App("screenshot-overlay.html".into()),
    )
    .title("截图")
    .inner_size(lw, lh)
    .position(lx, ly)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .transparent(true) // 透明：触发瞬间显示覆盖窗时「透出桌面」，用户感知毫秒级响应，不闪白
    .visible(false) // 预创建时隐藏；截图时由 start_screenshot 显示
    .resizable(false)
    .build()
    .map_err(|e| format!("创建截图窗口失败: {}", e))?;

    Ok(())
}

/// 显示截图覆盖窗口（仅 show，不重新捕获）。保留以备他用。
#[tauri::command]
pub fn show_overlay_window(app: tauri::AppHandle) -> Result<(), String> {
    create_overlay_window(app.clone())?;
    if let Some(w) = app.get_webview_window("screenshot-overlay") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit("screenshot-start", ());
    }
    Ok(())
}

/// 关闭截图覆盖窗口（仅隐藏，复用不销毁）。主窗口全程保持原状。
#[tauri::command]
pub fn hide_overlay_window(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("screenshot-overlay") {
        let _ = w.hide();
    }
}

/// 枚举「其他进程」的可见窗口，返回**物理像素**矩形，供前端绘制绿色轮廓与窗口识别。
#[tauri::command]
pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    let mut windows: Vec<WindowInfo> = Vec::new();
    unsafe {
        winapi::um::winuser::EnumWindows(
            Some(enum_callback),
            &mut windows as *mut _ as winapi::shared::minwindef::LPARAM,
        );
    }
    windows.retain(|w| w.width > 8 && w.height > 8);
    Ok(windows)
}

unsafe extern "system" fn enum_callback(
    hwnd: winapi::shared::windef::HWND,
    lparam: winapi::shared::minwindef::LPARAM,
) -> i32 {
    let state = &mut *(lparam as *mut Vec<WindowInfo>);
    // 跳过本进程（岸灯鸢花）自身的窗口：主窗口 / 截图覆盖窗 / 托盘菜单 / 歌词悬浮窗。
    let mut pid: u32 = 0;
    winapi::um::winuser::GetWindowThreadProcessId(hwnd, &mut pid);
    if pid == process::id() {
        return 1;
    }
    if winapi::um::winuser::IsWindowVisible(hwnd) == 0 {
        return 1;
    }
    // 跳过 shell 窗口（整屏桌面背景 / 任务栏 / 桌面合成层等）
    let mut cls: [u16; 256] = [0; 256];
    let cls_len = winapi::um::winuser::GetClassNameW(hwnd, cls.as_mut_ptr(), 256);
    if cls_len > 0 {
        let class = String::from_utf16_lossy(&cls[..cls_len as usize]);
        match class.as_str() {
            "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
            | "Windows.UI.Composition.DesktopWindowManager"
            | "ApplicationFrameInputSinkWindow" | "MsgBox" => return 1,
            _ => {}
        }
    }
    let mut rect: winapi::shared::windef::RECT = std::mem::zeroed();
    if winapi::um::winuser::GetWindowRect(hwnd, &mut rect) == 0 {
        return 1;
    }
    let x = rect.left;
    let y = rect.top;
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    if width <= 0 || height <= 0 {
        return 1;
    }
    // 关键性能：枚举窗口时**不读标题**。原 GetWindowTextW 会向目标线程发 WM_GETTEXT，
    // 遇「活着但响应极慢」的窗口会阻塞数秒 → 每次截图都卡 4-5s。即便改用 SendMessageTimeout，
    // 一旦误加 SMTO_NOTIMEOUTIFNOTHUNG 该超时即失效，仍会挂起。因此这里彻底不发跨线程消息，
    // 标题改由 get_window_title 在悬停时按需懒加载（单次、30ms 超时、绝不挂起）。
    state.push(WindowInfo {
        hwnd: hwnd as u64,
        title: String::new(),
        x,
        y,
        width,
        height,
    });
    1
}

/// 懒加载单个窗口标题（悬停绿框时调用）。单次 `SendMessageTimeout`：
/// 仅用 `SMTO_ABORTIFHUNG`（**不带** `SMTO_NOTIMEOUTIFNOTHUNG`，否则超时失效会挂起），
/// 超时 30ms。无论如何都不会阻塞——目标窗口卡死立即放弃，慢窗口最多等 30ms。
#[tauri::command]
pub fn get_window_title(hwnd: u64) -> String {
    let hw: winapi::shared::windef::HWND = hwnd as winapi::shared::windef::HWND;
    let mut buf = [0u16; 512];
    let mut text_len: usize = 0;
    let sent = unsafe {
        winapi::um::winuser::SendMessageTimeoutW(
            hw,
            winapi::um::winuser::WM_GETTEXT,
            511,
            buf.as_mut_ptr() as winapi::shared::minwindef::LPARAM,
            winapi::um::winuser::SMTO_ABORTIFHUNG,
            30,
            &mut text_len,
        )
    };
    if sent != 0 && text_len > 0 {
        String::from_utf16_lossy(&buf[..text_len])
    } else {
        String::new()
    }
}

/// 将 (x, y, w, h) 区域从整屏 DC 拷出为 RgbaImage（物理像素，BGRA→RGBA）。
///
/// 技术选型说明：
/// - 当前使用 GDI `BitBlt`（`SRCCOPY`）捕获。这覆盖绝大多数桌面应用与窗口。
/// - **已知局限**：独占全屏 DirectX / OpenGL 游戏 和受 HDCP / OPM 保护的视频内容在
///   GDI 层面不可见，`BitBlt` 会截出黑帧。这是 GDI 屏幕捕获的架构天花板，不是代码缺陷。
/// - **正确解法**：`Windows.Graphics.Capture`（DXGI Desktop Duplication API），
///   这是 OBS / Windows 截图工具等的方案。需要引入 `ID3D11Device` +
///   `IDXGIOutputDuplication` COM 链。当前 `winapi` crate 的 COM vtable 绑定不够完整，
///   计划在迁移到 `windows` crate 时统一实现。
/// - **增量兜底**：截到疑似全黑帧时做 1 次重试（`BitBlt` 可能的瞬时竞争），降损但非根治。
fn capture_region(x: i32, y: i32, w: i32, h: i32) -> Result<RgbaImage, String> {
    if w <= 0 || h <= 0 {
        return Err("无效的截图区域".into());
    }

    // 执行一次捕获，若结果为全黑（BitBlt 的瞬时竞争或独占全屏），重试一次。
    let result = do_capture_region(x, y, w, h)?;
    if is_all_black(&result) {
        // 短暂间隙让 GPU 管线稳定后重试
        std::thread::sleep(std::time::Duration::from_millis(10));
        return do_capture_region(x, y, w, h);
    }
    Ok(result)
}

/// 实际 BitBlt 捕获逻辑（抽取为独立函数，供 capture_region 单次/重试调用）。
fn do_capture_region(x: i32, y: i32, w: i32, h: i32) -> Result<RgbaImage, String> {
    unsafe {
        let screen_dc = winapi::um::winuser::GetDC(std::ptr::null_mut());
        if screen_dc.is_null() {
            return Err("无法获取屏幕 DC".into());
        }
        let mem_dc = winapi::um::wingdi::CreateCompatibleDC(screen_dc);
        let bitmap = winapi::um::wingdi::CreateCompatibleBitmap(screen_dc, w, h);
        let old = winapi::um::wingdi::SelectObject(mem_dc, bitmap as *mut winapi::ctypes::c_void);
        let _ok = winapi::um::wingdi::BitBlt(
            mem_dc,
            0,
            0,
            w,
            h,
            screen_dc,
            x,
            y,
            winapi::um::wingdi::SRCCOPY,
        );

        let mut bi: winapi::um::wingdi::BITMAPINFOHEADER = std::mem::zeroed();
        bi.biSize = std::mem::size_of::<winapi::um::wingdi::BITMAPINFOHEADER>() as u32;
        bi.biWidth = w as i32;
        bi.biHeight = -(h as i32);
        bi.biPlanes = 1;
        bi.biBitCount = 32;
        bi.biCompression = winapi::um::wingdi::BI_RGB;

        let mut buf: Vec<u8> = vec![0u8; (w as usize) * (h as usize) * 4];
        let lines = winapi::um::wingdi::GetDIBits(
            mem_dc,
            bitmap,
            0,
            h as u32,
            buf.as_mut_ptr() as *mut winapi::ctypes::c_void,
            &mut bi as *mut _ as *mut winapi::um::wingdi::BITMAPINFO,
            winapi::um::wingdi::DIB_RGB_COLORS,
        );

        winapi::um::wingdi::SelectObject(mem_dc, old);
        winapi::um::wingdi::DeleteObject(bitmap as *mut winapi::ctypes::c_void);
        winapi::um::wingdi::DeleteDC(mem_dc);
        winapi::um::winuser::ReleaseDC(std::ptr::null_mut(), screen_dc);

        if lines == 0 {
            return Err("BitBlt / GetDIBits 失败".into());
        }

        let mut rgba = vec![0u8; buf.len()];
        for i in 0..((w as usize) * (h as usize)) {
            let j = i * 4;
            rgba[j] = buf[j + 2];
            rgba[j + 1] = buf[j + 1];
            rgba[j + 2] = buf[j];
            rgba[j + 3] = 255;
        }
        RgbaImage::from_raw(w as u32, h as u32, rgba)
            .ok_or_else(|| "图像构造失败".into())
    }
}

/// 检测 RGBA 图像是否全部为非零（全黑）像素。
fn is_all_black(img: &RgbaImage) -> bool {
    let pixels = img.as_raw();
    for chunk in pixels.chunks_exact(4) {
        // BGRA: 检查 R+G+B 三个通道
        if chunk[0] != 0 || chunk[1] != 0 || chunk[2] != 0 {
            return false;
        }
    }
    true
}

// ========== 截图数据跨窗口传输（Rust 管理态） ==========
/// 保存截图过程的跨窗口共享状态：
/// - `note_id`：触发截图时主窗口所在笔记 id（用于「导入当前笔记」；空串表示不在笔记页）。
/// - `shortcut`：当前生效的全局截图热键（字符串，如 "Ctrl+Shift+S"），由设置面板改写并持久化。
/// - `capturing`：是否正在后台捕获，用于防止连按热键重复触发。
pub struct ScreenshotData {
    pub note_id: String,
    pub shortcut: String,
    pub capturing: bool,
}

impl Default for ScreenshotData {
    fn default() -> Self {
        Self {
            note_id: String::new(),
            shortcut: "Ctrl+Shift+S".to_string(),
            capturing: false,
        }
    }
}

/// 最近一次截屏的数据：
/// - `preview`：降采样后的 JPEG（逻辑分辨率），供覆盖窗秒开显示（体积小、编码快）。
/// - `raw`：原生物理分辨率的 RGBA 字节（整屏捕获区），保存/复制时直接在此字节上裁剪，
///   不再编码/解码整张全屏 PNG —— 这是「触发不再卡几秒」「保存从数秒降到毫秒级」的关键。
/// - `native_w/h`：raw 图的像素尺寸。
/// - `native_ox/oy`：raw 图左上角对应的**屏幕物理坐标**（覆盖窗真实客户区原点），
///   用于把前端的物理选区换算到 native 图像坐标。
pub struct Shot {
    pub preview: Vec<u8>,
    pub raw: Vec<u8>,
    pub native_w: u32,
    pub native_h: u32,
    pub native_ox: i32,
    pub native_oy: i32,
}

/// 当前截图数据（整屏原生 RGBA 字节 + 预览 JPEG）存放于模块级静态锁，
/// 便于后台捕获线程直接写入、前端命令直接读取，避免 `State` 在跨线程时的生命周期难题。
static SHOT: std::sync::Mutex<Option<Shot>> = std::sync::Mutex::new(None);
/// 是否正在后台捕获（防连按热键重复触发）
static CAPTURING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// RAII guard：进入 `start_screenshot` 时获取，离开作用域（正常返回 / 错误返回 / panic 展开）时自动复位 CAPTURING。
/// 彻底杜绝任何路径遗漏复位导致热键永久锁死的风险。
struct CaptureGuard;
impl CaptureGuard {
    fn acquire() -> Self {
        CAPTURING.store(true, std::sync::atomic::Ordering::SeqCst);
        CaptureGuard
    }
}
impl Drop for CaptureGuard {
    fn drop(&mut self) {
        CAPTURING.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[tauri::command]
pub fn store_screenshot_note_id(
    note_id: String,
    state: tauri::State<'_, std::sync::Mutex<ScreenshotData>>,
) -> Result<(), String> {
    let mut s = state.lock().map_err(|e| format!("锁失败: {}", e))?;
    s.note_id = note_id;
    Ok(())
}

#[tauri::command]
pub fn get_screenshot_note_id(
    state: tauri::State<'_, std::sync::Mutex<ScreenshotData>>,
) -> Result<String, String> {
    let s = state.lock().map_err(|e| format!("锁失败: {}", e))?;
    Ok(s.note_id.clone())
}

/// 启动截图：
/// 1) 取覆盖窗「真实矩形」（物理像素）作为捕获区域——保证捕获 == 显示，1:1 对齐、无偏移无白边；
/// 2) BitBlt 整窗 → 原生 PNG 存内存（保存用）+ 降采样 JPEG 预览（秒开用）；
/// 3) 枚举窗口，经事件把「覆盖窗原点 ox/oy + scale + 窗口列表 + noteId」推给覆盖窗。
#[tauri::command]
pub fn start_screenshot(
    app: tauri::AppHandle,
    _state: tauri::State<'_, std::sync::Mutex<ScreenshotData>>,
) -> Result<(), String> {
    create_overlay_window(app.clone())?;
    let overlay = app
        .get_webview_window("screenshot-overlay")
        .ok_or_else(|| "覆盖窗缺失".to_string())?;

    // 防重入：正在捕获或已可见则忽略（避免连按热键重复触发造成卡顿 / 状态错乱）
    if CAPTURING.load(std::sync::atomic::Ordering::SeqCst)
        || overlay.is_visible().unwrap_or(false)
    {
        return Ok(());
    }
    // RAII guard：自此之后直到函数退出（正常 / 错误 / panic），CAPTURING 由 Drop 自动复位。
    let _guard = CaptureGuard::acquire();

    // 先隐藏覆盖窗，避免把覆盖窗自身截入画面；捕获完成后才显示（带冻结图，无「透明→填充」闪烁）。
    let _ = overlay.hide();

    let (rx, ry, rw, rh) = virtual_desktop_rect();

    // 用 HWND + SetWindowPos 同步定位覆盖窗到「所有显示器物理并集」，
    // 随后取其真实「客户区」矩形（GetClientRect + ClientToScreen）作为捕获区域，
    // 使捕获原点 == 覆盖窗客户区左上角，预览图 object-fill 1:1 铺满后「图像像素 ≡ 屏幕区域」，
    // 绿框与截图区域彻底对齐，根除「几 px 偏移」（DWM 隐形边框 / 多屏负坐标）。
    let hwnd = match overlay.hwnd().ok() {
        Some(h) => h,
        None => {
            return Err("无法获取覆盖窗句柄".into());
        }
    };
    let hw = hwnd.0 as winapi::shared::windef::HWND;
    unsafe {
        winapi::um::winuser::SetWindowPos(
            hw,
            winapi::um::winuser::HWND_TOPMOST,
            rx,
            ry,
            rw,
            rh,
            winapi::um::winuser::SWP_NOACTIVATE
                | winapi::um::winuser::SWP_NOREDRAW
                | winapi::um::winuser::SWP_NOSENDCHANGING,
        );
    }
    let (mut ox, mut oy, mut ow, mut oh) = (rx, ry, rw, rh);
    unsafe {
        let mut client: winapi::shared::windef::RECT = std::mem::zeroed();
        if winapi::um::winuser::GetClientRect(hw, &mut client) != 0 {
            let mut pt: winapi::shared::windef::POINT = std::mem::zeroed();
            if winapi::um::winuser::ClientToScreen(hw, &mut pt) != 0 {
                ox = pt.x;
                oy = pt.y;
                ow = client.right - client.left;
                oh = client.bottom - client.top;
            }
        }
    }

    let scale = match overlay.scale_factor().ok() {
        Some(s) => s,
        None => {
            return Err("无法获取缩放比".into());
        }
    };

    // 捕获区域：DC 坐标系以虚拟桌面原点 (rx,ry) 为 (0,0)，故屏幕 (ox,oy) 对应 DC (ox-rx, oy-ry)
    let full = match capture_region(ox - rx, oy - ry, ow, oh) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[截图] 捕获失败: {}", e);
            return Err(e);
        }
    };
    // 原生 RGBA 原始字节直接留存（保存时按选区裁剪，不再编码/解码整张全屏 PNG，毫秒级）
    let raw = full.as_raw().to_vec();
    let full_dyn = DynamicImage::ImageRgba8(full);

    // 预览：降采样到逻辑分辨率 + JPEG（编码快、体积小，是「截图秒开」的关键）
    let nw = ((ow as f64) / scale).round().max(1.0) as u32;
    let nh = ((oh as f64) / scale).round().max(1.0) as u32;
    let preview_dyn: DynamicImage = if nw < (ow as u32) || nh < (oh as u32) {
        full_dyn.resize(nw, nh, FilterType::CatmullRom)
    } else {
        full_dyn
    };
    let preview_rgb = preview_dyn.to_rgb8();
    let mut pv_buf = Cursor::new(Vec::new());
    if let Err(e) = DynamicImage::ImageRgb8(preview_rgb)
        .write_to(&mut pv_buf, ImageFormat::Jpeg)
    {
        eprintln!("[截图] 预览 JPEG 编码失败: {}", e);
        return Err(format!("预览编码失败: {}", e));
    }

    {
        let mut slot = SHOT.lock().expect("截图状态锁失败");
        *slot = Some(Shot {
            preview: pv_buf.into_inner(),
            raw,
            native_w: ow as u32,
            native_h: oh as u32,
            native_ox: ox,
            native_oy: oy,
        });
    }

    let windows = list_windows().unwrap_or_default();
    let note_id = app
        .state::<std::sync::Mutex<ScreenshotData>>()
        .lock()
        .map(|s| s.note_id.clone())
        .unwrap_or_default();
    let payload = json!({
        "ox": ox,
        "oy": oy,
        "scale": scale,
        "windows": windows,
        "noteId": note_id,
    });
    // 捕获完成后再显示覆盖窗（已是冻结图，无需「透明→填充」的二次刷新）
    let _ = overlay.emit("screenshot-start", payload);
    let _ = overlay.show();
    let _ = overlay.set_focus();
    Ok(())
}

/// 覆盖窗读取预览 JPEG（二进制通道，前端 new Blob 解码）。
#[tauri::command]
pub fn read_screenshot() -> Result<tauri::ipc::Response, String> {
    let slot = SHOT.lock().map_err(|e| format!("锁失败: {}", e))?;
    let shot = slot
        .as_ref()
        .ok_or_else(|| "尚无截屏数据，请先触发截图".to_string())?;
    Ok(tauri::ipc::Response::new(shot.preview.clone()))
}

/// 按「原生物理像素」选区从原生 RGBA 字节重裁，返回 PNG（保证最终输出清晰，而非降采样预览）。
#[tauri::command]
pub fn crop_native(
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<tauri::ipc::Response, String> {
    let slot = SHOT.lock().map_err(|e| format!("锁失败: {}", e))?;
    let shot = slot
        .as_ref()
        .ok_or_else(|| "尚无截屏数据，请先触发截图".to_string())?;
    let iw = shot.native_w as i32;
    let ih = shot.native_h as i32;
    // 选区物理坐标 → native 图像坐标（减去捕获原点）
    let x0 = (x - shot.native_ox).max(0).min(iw - 1);
    let y0 = (y - shot.native_oy).max(0).min(ih - 1);
    let ww = ((w as u32).min((iw - x0) as u32)).max(1);
    let hh = ((h as u32).min((ih - y0) as u32)).max(1);
    // 直接从留存的原生 RGBA 字节裁剪（避免解码整张全屏 PNG，保存从数秒降到毫秒级）
    let row_bytes = iw as usize * 4;
    let mut out: Vec<u8> = Vec::with_capacity((ww as usize) * (hh as usize) * 4);
    let src = &shot.raw;
    for yy in 0..(hh as usize) {
        let start = ((y0 as usize + yy) * row_bytes) + (x0 as usize * 4);
        out.extend_from_slice(&src[start..start + (ww as usize) * 4]);
    }
    let img = RgbaImage::from_raw(ww, hh, out)
        .ok_or_else(|| "裁剪图像构造失败".to_string())?;
    let mut buf = Cursor::new(Vec::new());
    img.write_to(&mut buf, ImageFormat::Png)
        .map_err(|e| format!("裁剪 PNG 编码失败: {}", e))?;
    Ok(tauri::ipc::Response::new(buf.into_inner()))
}

/// 与 `crop_native` 同逻辑，但**直接返回原生 RGBA 字节**（不编码 PNG）。
/// 用于「保存」链路：前端拿到原始像素后交给 `save_screenshot`，
/// 省去「前端 PNG 编码 → IPC 传 base64 → Rust 再解码」这一最慢的环节，保存真正进入毫秒级。
#[tauri::command]
pub fn crop_native_rgba(
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<tauri::ipc::Response, String> {
    let slot = SHOT.lock().map_err(|e| format!("锁失败: {}", e))?;
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
    let src = &shot.raw;
    for yy in 0..(hh as usize) {
        let start = ((y0 as usize + yy) * row_bytes) + (x0 as usize * 4);
        out.extend_from_slice(&src[start..start + (ww as usize) * 4]);
    }
    Ok(tauri::ipc::Response::new(out))
}

/// 一键保存：把合成好的图像「写入剪贴板 + 存入中转站」，返回 `localimg://` 引用。
///
/// 性能（毫秒级保存的关键）：
/// - 前端直接传**原生 RGBA 字节**（来自 `crop_native_rgba` 或 canvas.getImageData），
///   不再走「前端 PNG 编码 → IPC base64 → Rust 再解码」这一最慢环节；
/// - `bytes` 为原生 RGBA 时直接用 `width/height` 构造图像，零解码；
///   仅当 `bytes` 以 PNG 魔数开头（长截图等旧路径）时才回退到解码，保证兼容。
///   注意：PNG 路径下传入的 `width` / `height` 参数被忽略（尺寸从 PNG 文件头解码），仅 RGBA 直传路径使用这两个参数。
#[tauri::command]
pub fn save_screenshot(
    app: tauri::AppHandle,
    bytes: Vec<u8>,
    width: u32,
    height: u32,
    name: String,
) -> Result<String, String> {
    // 1) 还原 RGBA 图像（原始像素直通，跳过 PNG 编解码）
    let rgba = if bytes.starts_with(b"\x89PNG") {
        // 兼容长截图：其 bytes 仍是 PNG
        image::load_from_memory(&bytes)
            .map_err(|e| format!("图片解码失败: {}", e))?
            .into_rgba8()
    } else {
        RgbaImage::from_raw(width, height, bytes)
            .ok_or_else(|| "图像尺寸与字节长度不匹配，保存失败".to_string())?
    };
    let (w, h) = rgba.dimensions();

    // 2) 写入剪贴板（直传原生 RGBA，arboard 内部按位图写入，无额外编码）
    let raw = rgba.into_raw();
    let mut cb = arboard::Clipboard::new().map_err(|e| format!("无法访问剪贴板: {}", e))?;
    let data = arboard::ImageData {
        width: w as usize,
        height: h as usize,
        bytes: std::borrow::Cow::Owned(raw.clone()),
    };
    cb.set_image(data)
        .map_err(|e| format!("写入剪贴板失败: {}", e))?;

    // 3) 编码一次 PNG 落盘中转站（保存的最终产物必须是 PNG，仅此一次编码）
    let png = {
        let img = image::RgbaImage::from_raw(w, h, raw)
            .ok_or_else(|| "重建图像失败".to_string())?;
        let mut buf = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(img)
            .write_to(&mut buf, ImageFormat::Png)
            .map_err(|e| format!("PNG 编码失败: {}", e))?;
        buf.into_inner()
    };

    // 4) 存入中转站（bytes 已是 PNG，直接落盘，不再 base64 往返）
    let tmp = std::env::temp_dir().join(format!(
        "andeng_shot_{}_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        name
    ));
    std::fs::write(&tmp, &png).map_err(|e| format!("写临时文件失败: {}", e))?;
    let tmp_str = tmp.to_string_lossy().to_string();
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dest = crate::commands::copy_file_to_dropzone(&app_data, &tmp_str, Some(&name));
    let _ = std::fs::remove_file(&tmp);
    match dest {
        Ok(d) => Ok(format!(
            "localimg://{}",
            crate::services::document_parser::js_encode_uri_component(&d.to_string_lossy())
        )),
        Err(e) => Err(e),
    }
}

/// 长截图：以「可见窗口 PrintWindow(flag 0) + 程序化滚动 + BitBlt 逐屏拼接」的方式，
/// 可靠地捕获目标窗口的完整内容，并彻底规避旧版 `PrintWindow(flag 2)` 在浏览器 / Electron /
/// UWP / 硬件加速窗口上的**无限挂起**（曾导致整个应用卡死）。
///
/// 原理：
/// 1) `PrintWindow(hw, hdc, 0)` 只捕获「当前可见」窗口，对几乎所有窗口都快速返回、不会挂起；
/// 2) 找到带垂直滚动条的窗口（自身或子控件），反复发送 `WM_VSCROLL`(SB_PAGEDOWN) 翻页，每翻一页
///    用 PrintWindow 重新捕获整窗，再与上一屏做「重叠行比对」去重后拼接；
/// 3) 滚动到底或新内容不再增加时停止。非滚动窗口则直接返回单屏（整窗可见内容，同样不挂起）。
#[tauri::command]
pub fn capture_window_full(hwnd: u64) -> Result<tauri::ipc::Response, String> {
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    thread::spawn(move || {
        let _ = tx.send(capture_window_full_inner(hwnd));
    });
    // 留足滚动拼接时间（普通窗口 <1s 完成），同时仍以超时守护防止极个别情况下的挂起
    match rx.recv_timeout(Duration::from_secs(30)) {
        Ok(Ok(bytes)) => Ok(tauri::ipc::Response::new(bytes)),
        Ok(Err(e)) => Err(e),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(
            "长截图超时：该窗口可能无法正常滚动 / 渲染，请改用普通框选 / 单击窗口。"
                .to_string(),
        ),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err("长截图线程异常退出".to_string()),
    }
}

/// 用 PrintWindow(flag 0) 捕获窗口「当前可见」内容，返回 RGBA 图像（物理像素，BGRA→RGBA）。
fn print_window_capture(
    hw: winapi::shared::windef::HWND,
    w: i32,
    h: i32,
) -> Result<RgbaImage, String> {
    unsafe {
        let screen_dc = winapi::um::winuser::GetDC(std::ptr::null_mut());
        if screen_dc.is_null() {
            return Err("无法获取屏幕 DC".into());
        }
        let mem_dc = winapi::um::wingdi::CreateCompatibleDC(screen_dc);
        let bitmap = winapi::um::wingdi::CreateCompatibleBitmap(screen_dc, w, h);
        let old = winapi::um::wingdi::SelectObject(mem_dc, bitmap as *mut winapi::ctypes::c_void);
        // flag 0：仅捕获可见内容，快速且不挂起（区别于会挂起的 flag 2）
        let _ok = winapi::um::winuser::PrintWindow(hw, mem_dc, 0);

        let mut bi: winapi::um::wingdi::BITMAPINFOHEADER = std::mem::zeroed();
        bi.biSize = std::mem::size_of::<winapi::um::wingdi::BITMAPINFOHEADER>() as u32;
        bi.biWidth = w as i32;
        bi.biHeight = -(h as i32);
        bi.biPlanes = 1;
        bi.biBitCount = 32;
        bi.biCompression = winapi::um::wingdi::BI_RGB;

        let mut buf: Vec<u8> = vec![0u8; (w as usize) * (h as usize) * 4];
        let lines = winapi::um::wingdi::GetDIBits(
            mem_dc,
            bitmap,
            0,
            h as u32,
            buf.as_mut_ptr() as *mut winapi::ctypes::c_void,
            &mut bi as *mut _ as *mut winapi::um::wingdi::BITMAPINFO,
            winapi::um::wingdi::DIB_RGB_COLORS,
        );
        winapi::um::wingdi::SelectObject(mem_dc, old);
        winapi::um::wingdi::DeleteObject(bitmap as *mut winapi::ctypes::c_void);
        winapi::um::wingdi::DeleteDC(mem_dc);
        winapi::um::winuser::ReleaseDC(std::ptr::null_mut(), screen_dc);

        if lines == 0 {
            return Err("PrintWindow / GetDIBits 失败".into());
        }
        let mut rgba = vec![0u8; buf.len()];
        for i in 0..((w as usize) * (h as usize)) {
            let j = i * 4;
            rgba[j] = buf[j + 2];
            rgba[j + 1] = buf[j + 1];
            rgba[j + 2] = buf[j];
            rgba[j + 3] = 255;
        }
        match RgbaImage::from_raw(w as u32, h as u32, rgba) {
            Some(im) => Ok(im),
            None => Err("图像构造失败".into()),
        }
    }
}

/// 比对 prev 底部 o 行与 cur 顶部 o 行是否一致（容差内），用于去重拼接。
fn rows_match(prev: &[u8], cur: &[u8], w: usize, o: usize) -> bool {
    let row_bytes = w * 4;
    if o == 0 {
        return true;
    }
    let prev_start = prev.len() - o * row_bytes;
    let mut diff = 0u64;
    let budget = (o as u64) * (row_bytes as u64) / 6; // 平均差异 <~16% 视为相同
    for i in 0..(o * row_bytes) {
        diff += (prev[prev_start + i] as i32 - cur[i] as i32).abs() as u64;
        if diff > budget {
            return false;
        }
    }
    true
}

/// 找到 prev 与 cur 之间的最大重叠行数（cur 顶部与 prev 底部对齐的行数）。
fn find_overlap(prev: &RgbaImage, cur: &RgbaImage) -> usize {
    let w = prev.width() as usize;
    let h = prev.height() as usize;
    if cur.height() as usize != h {
        return 0;
    }
    let pr = prev.as_raw();
    let cr = cur.as_raw();
    for o in (0..h).rev() {
        if rows_match(pr, cr, w, o) {
            return o;
        }
    }
    0
}

/// 将 cur 的 [overlap..] 行拼接到 full 之后，返回更高的一张图。
fn append_rows(full: &RgbaImage, cur: &RgbaImage, overlap: usize) -> RgbaImage {
    let w = full.width() as usize;
    let row_bytes = w * 4;
    let fh = full.height() as usize;
    let ch = cur.height() as usize;
    let new_h = fh + (ch - overlap);
    let fr = full.as_raw();
    let cr = cur.as_raw();
    let mut buf: Vec<u8> = Vec::with_capacity(w * new_h * 4);
    buf.extend_from_slice(&fr[0..fh * row_bytes]);
    buf.extend_from_slice(&cr[overlap * row_bytes..]);
    RgbaImage::from_raw(w as u32, new_h as u32, buf).unwrap_or_else(|| full.clone())
}

unsafe extern "system" fn find_scroll_child(
    hwnd: winapi::shared::windef::HWND,
    lparam: winapi::shared::minwindef::LPARAM,
) -> i32 {
    let best = &mut *(lparam as *mut (i32, winapi::shared::windef::HWND));
    let style = winapi::um::winuser::GetWindowLongW(hwnd, winapi::um::winuser::GWL_STYLE);
    if style & winapi::um::winuser::WS_VSCROLL as i32 != 0 {
        let mut si: winapi::um::winuser::SCROLLINFO = std::mem::zeroed();
        si.cbSize = std::mem::size_of::<winapi::um::winuser::SCROLLINFO>() as u32;
        si.fMask = winapi::um::winuser::SIF_ALL;
        if winapi::um::winuser::GetScrollInfo(hwnd, winapi::um::winuser::SB_VERT as i32, &mut si) != 0 {
            let range = si.nMax as i32 - si.nMin as i32;
            if range > si.nPage as i32 && range > best.0 {
                best.0 = range;
                best.1 = hwnd;
            }
        }
    }
    1
}

/// 实际执行长截图（在独立线程中运行，便于超时放弃）。
fn capture_window_full_inner(hwnd: u64) -> Result<Vec<u8>, String> {
    let hw: winapi::shared::windef::HWND = hwnd as winapi::shared::windef::HWND;
    unsafe {
        let mut rect: winapi::shared::windef::RECT = std::mem::zeroed();
        if winapi::um::winuser::GetWindowRect(hw, &mut rect) == 0 {
            return Err("获取窗口矩形失败".into());
        }
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        if w <= 0 || h <= 0 {
            return Err("窗口尺寸无效".into());
        }

        // 是否可垂直滚动？优先自身，否则找带 WS_VSCROLL 的子控件
        let mut self_si: winapi::um::winuser::SCROLLINFO = std::mem::zeroed();
        self_si.cbSize = std::mem::size_of::<winapi::um::winuser::SCROLLINFO>() as u32;
        self_si.fMask = winapi::um::winuser::SIF_ALL;
        let self_scrollable = winapi::um::winuser::GetScrollInfo(hw, winapi::um::winuser::SB_VERT as i32, &mut self_si) != 0
            && ((self_si.nMax as i32) - (self_si.nMin as i32)) > self_si.nPage as i32;

        let mut best: (i32, winapi::shared::windef::HWND) = (-1, std::ptr::null_mut());
        winapi::um::winuser::EnumChildWindows(
            hw,
            Some(find_scroll_child),
            &mut best as *mut _ as winapi::shared::minwindef::LPARAM,
        );
        let child_scrollable = best.1 != std::ptr::null_mut();

        // 不可滚动：直接返回单屏（整窗可见内容），绝不挂起
        if !self_scrollable && !child_scrollable {
            let img = print_window_capture(hw, w, h)?;
            return encode_png(img);
        }

        // 可滚动：逐页滚动 + 拼接。
        // 用 SendInput 模拟鼠标滚轮替代 WM_VSCROLL —— 现代应用（Chrome/VS Code/Electron）
        // 几乎一律响应真实滚轮事件，而不一定响应老式窗口滚动消息。
        let scroll_hw = if self_scrollable { hw } else { best.1 };
        let first = print_window_capture(hw, w, h)?;
        let mut full = first.clone();
        let mut prev = first;
        let mut prev_pos: i32 = -1;
        let mut guard = 0u32;

        // 保存原光标位置，将光标移到目标窗口中心（SendInput 滚轮相对于光标所在窗口）
        let mut saved_cursor: winapi::shared::windef::POINT = std::mem::zeroed();
        winapi::um::winuser::GetCursorPos(&mut saved_cursor);
        let cx = rect.left + w / 2;
        let cy = rect.top + h / 2;
        winapi::um::winuser::SetCursorPos(cx, cy);
        // 给目标窗口焦点（滚轮事件需要窗口前台或有焦点）
        let _ = winapi::um::winuser::SetForegroundWindow(scroll_hw);
        std::thread::sleep(std::time::Duration::from_millis(50));

        // 单次滚轮 INPUT 模板（INPUT 为 Copy 类型，zeroed 安全）
        let mut wheel_input: winapi::um::winuser::INPUT = std::mem::zeroed();
        wheel_input.type_ = winapi::um::winuser::INPUT_MOUSE;
        {
            let mi = &mut *(&mut wheel_input.u as *mut _ as *mut winapi::um::winuser::MOUSEINPUT);
            mi.dx = 0;
            mi.dy = 0;
            mi.mouseData = (winapi::um::winuser::WHEEL_DELTA as i32).wrapping_neg() as u32;
            mi.dwFlags = winapi::um::winuser::MOUSEEVENTF_WHEEL;
            mi.time = 0;
            mi.dwExtraInfo = 0;
        }

        loop {
            guard += 1;
            if guard > 400 {
                break;
            }

            // 发送 6 次滚轮事件（模拟一次「页下翻」），每次间隔 5ms
            for _ in 0..6 {
                winapi::um::winuser::SendInput(
                    1,
                    &mut wheel_input as *mut winapi::um::winuser::INPUT,
                    std::mem::size_of::<winapi::um::winuser::INPUT>() as i32,
                );
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            // 等待目标窗口重绘
            std::thread::sleep(std::time::Duration::from_millis(40));

            let mut si: winapi::um::winuser::SCROLLINFO = std::mem::zeroed();
            si.cbSize = std::mem::size_of::<winapi::um::winuser::SCROLLINFO>() as u32;
            si.fMask = winapi::um::winuser::SIF_ALL;
            winapi::um::winuser::GetScrollInfo(scroll_hw, winapi::um::winuser::SB_VERT as i32, &mut si);
            let pos = si.nPos as i32;
            let nmax = si.nMax as i32;
            let npage = si.nPage as i32;
            if pos <= prev_pos {
                break; // 已到底 / 无法继续滚动
            }
            let cur = print_window_capture(hw, w, h)?;
            let overlap = find_overlap(&prev, &cur);
            if overlap >= h as usize {
                break; // 无新增内容
            }
            full = append_rows(&full, &cur, overlap);
            prev = cur;
            prev_pos = pos;
            if pos + npage >= nmax {
                break; // 到达底部
            }
        }
        // 恢复原光标位置
        winapi::um::winuser::SetCursorPos(saved_cursor.x, saved_cursor.y);
        encode_png(full)
    }
}

/// 将 RgbaImage 编码为 PNG 字节。
fn encode_png(img: RgbaImage) -> Result<Vec<u8>, String> {
    let mut out = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(img)
        .write_to(&mut out, ImageFormat::Png)
        .map_err(|e| format!("长截图 PNG 编码失败: {}", e))?;
    Ok(out.into_inner())
}

// 旧命令保留（备用）：直接捕获整虚拟桌面为 PNG（未降采样）。
#[tauri::command]
pub fn capture_screen() -> Result<Vec<u8>, String> {
    let x = unsafe { winapi::um::winuser::GetSystemMetrics(winapi::um::winuser::SM_XVIRTUALSCREEN) };
    let y = unsafe { winapi::um::winuser::GetSystemMetrics(winapi::um::winuser::SM_YVIRTUALSCREEN) };
    let w = unsafe { winapi::um::winuser::GetSystemMetrics(winapi::um::winuser::SM_CXVIRTUALSCREEN) };
    let h = unsafe { winapi::um::winuser::GetSystemMetrics(winapi::um::winuser::SM_CYVIRTUALSCREEN) };
    let img = capture_region(x, y, w, h)?;
    let mut buf = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(img)
        .write_to(&mut buf, ImageFormat::Png)
        .map_err(|e| format!("PNG 编码失败: {}", e))?;
    Ok(buf.into_inner())
}

/// 将 PNG（data URL 或纯 base64）写入系统剪贴板
#[tauri::command]
pub fn clipboard_write_image(base64_png: String) -> Result<(), String> {
    let b64 = base64_png
        .split(',')
        .nth(1)
        .unwrap_or(&base64_png);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("Base64 解码失败: {}", e))?;
    let img = image::load_from_memory(&bytes)
        .map_err(|e| format!("图片解码失败: {}", e))?;
    let rgba = img.into_rgba8();
    let (w, h) = rgba.dimensions();
    let mut cb = arboard::Clipboard::new().map_err(|e| format!("无法访问剪贴板: {}", e))?;
    let data = arboard::ImageData {
        width: w as usize,
        height: h as usize,
        bytes: Cow::Owned(rgba.into_raw()),
    };
    cb.set_image(data)
        .map_err(|e| format!("写入图片到剪贴板失败: {}", e))
}

// ============ 截图热键：设置面板可改写并持久化 ============
/// 截图热键持久化路径（app_data_dir/screenshot_shortcut.json）
fn screenshot_shortcut_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("screenshot_shortcut.json"))
}

pub fn read_screenshot_shortcut(app: &tauri::AppHandle) -> String {
    if let Some(p) = screenshot_shortcut_path(app) {
        if let Ok(s) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                if let Some(s2) = v.get("shortcut").and_then(|x| x.as_str()) {
                    if !s2.is_empty() {
                        return s2.to_string();
                    }
                }
            }
        }
    }
    "Ctrl+Shift+S".to_string()
}

fn write_screenshot_shortcut(app: &tauri::AppHandle, sc: &str) -> Result<(), String> {
    let p = screenshot_shortcut_path(app).ok_or_else(|| "无法获取 app_data 目录".to_string())?;
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&p, serde_json::json!({ "shortcut": sc }).to_string())
        .map_err(|e| e.to_string())
}

/// 解析快捷键字符串（如 "Ctrl+Shift+S" 或 "Ctrl + Shift + S"）为 tauri global_shortcut::Shortcut
fn parse_shortcut(s: &str) -> Result<Shortcut, String> {
    let s = s.replace(' ', "");
    if s.is_empty() {
        return Err("空快捷键".to_string());
    }
    let parts: Vec<&str> = s.split('+').collect();
    let key = *parts.last().unwrap();
    let mut modifiers = Modifiers::empty();
    for p in &parts[..parts.len() - 1] {
        match p.to_uppercase().as_str() {
            "CTRL" | "CONTROL" => modifiers |= Modifiers::CONTROL,
            "SHIFT" => modifiers |= Modifiers::SHIFT,
            "ALT" => modifiers |= Modifiers::ALT,
            "META" | "WIN" | "SUPER" | "CMD" | "WINDOWS" => modifiers |= Modifiers::SUPER,
            _ => return Err(format!("不支持的修饰键: {}", p)),
        }
    }
    let code = parse_code(key)?;
    Ok(Shortcut::new(Some(modifiers), code))
}

fn parse_code(key: &str) -> Result<Code, String> {
    let k = key.to_uppercase();
    if k.len() == 1 {
        let c = k.chars().next().unwrap();
        if c.is_ascii_alphabetic() {
            return Ok(match c {
                'A' => Code::KeyA, 'B' => Code::KeyB, 'C' => Code::KeyC, 'D' => Code::KeyD,
                'E' => Code::KeyE, 'F' => Code::KeyF, 'G' => Code::KeyG, 'H' => Code::KeyH,
                'I' => Code::KeyI, 'J' => Code::KeyJ, 'K' => Code::KeyK, 'L' => Code::KeyL,
                'M' => Code::KeyM, 'N' => Code::KeyN, 'O' => Code::KeyO, 'P' => Code::KeyP,
                'Q' => Code::KeyQ, 'R' => Code::KeyR, 'S' => Code::KeyS, 'T' => Code::KeyT,
                'U' => Code::KeyU, 'V' => Code::KeyV, 'W' => Code::KeyW, 'X' => Code::KeyX,
                'Y' => Code::KeyY, 'Z' => Code::KeyZ,
                _ => return Err(format!("不支持的按键: {}", key)),
            });
        }
        if c.is_ascii_digit() {
            return Ok(match c {
                '0' => Code::Digit0, '1' => Code::Digit1, '2' => Code::Digit2, '3' => Code::Digit3,
                '4' => Code::Digit4, '5' => Code::Digit5, '6' => Code::Digit6, '7' => Code::Digit7,
                '8' => Code::Digit8, '9' => Code::Digit9,
                _ => return Err(format!("不支持的按键: {}", key)),
            });
        }
    }
    if let Some(n) = k.strip_prefix('F') {
        if let Ok(num) = n.parse::<u32>() {
            return Ok(match num {
                1 => Code::F1, 2 => Code::F2, 3 => Code::F3, 4 => Code::F4, 5 => Code::F5,
                6 => Code::F6, 7 => Code::F7, 8 => Code::F8, 9 => Code::F9, 10 => Code::F10,
                11 => Code::F11, 12 => Code::F12,
                _ => return Err(format!("不支持的 F 键: {}", key)),
            });
        }
    }
    Err(format!("不支持的按键: {}", key))
}

/// 注册截图热键（解析失败时返回错误，不影响其他启动流程）
pub fn register_screenshot_shortcut(app: &tauri::AppHandle, sc: &str) -> Result<(), String> {
    let shortcut = parse_shortcut(sc)?;
    app.global_shortcut()
        .register(shortcut)
        .map_err(|e| format!("注册截图热键失败: {}", e))
}

#[tauri::command]
pub fn get_screenshot_shortcut(app: tauri::AppHandle) -> String {
    read_screenshot_shortcut(&app)
}

#[tauri::command]
pub fn set_screenshot_shortcut(app: tauri::AppHandle, shortcut: String) -> Result<(), String> {
    let new = parse_shortcut(&shortcut)?;
    let old = app
        .state::<std::sync::Mutex<ScreenshotData>>()
        .lock()
        .ok()
        .map(|s| s.shortcut.clone())
        .unwrap_or_else(|| "Ctrl+Shift+S".to_string());

    // 先注销旧键
    if let Ok(old_sc) = parse_shortcut(&old) {
        let _ = app.global_shortcut().unregister(old_sc);
    }

    // 注册新键：注册成功后才能落盘，杜绝「配置文件写入无效值」问题。
    // 注册失败时保持旧键（或降级）、返回错误，文件不受影响。
    app.global_shortcut().register(new).map_err(|e| {
        if let Ok(old_sc) = parse_shortcut(&old) {
            let _ = app.global_shortcut().register(old_sc);
        }
        format!("注册失败（已回退原热键）: {}", e)
    })?;

    // 注册成功 → 持久化文件 + 更新内存态
    write_screenshot_shortcut(&app, &shortcut)?;
    if let Ok(mut s) = app.state::<std::sync::Mutex<ScreenshotData>>().lock() {
        s.shortcut = shortcut;
    }
    Ok(())
}
