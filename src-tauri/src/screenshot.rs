// ================= 微信式截图（多显示器 + 悬浮置顶窗口 + 窗口识别 + 局部/整窗截取）================
// 提供：多显示器整屏物理像素捕获、枚举「其他进程」可见窗口矩形（物理像素）、图片写入剪贴板。
// 实际「选择区域 / 标注 / 窗口识别」在 Web 前端完成（对捕获的全屏图做裁剪），天然规避坐标换算问题。
//
// 关键：DPI 一致性。Tauri v2（TAO/WRY）在 Windows 上默认 Per-Monitor-DPI-Aware V2。
// 在 DPI 感知进程中，GetSystemMetrics / GetWindowRect 返回**真实物理像素**，GDI BitBlt 同坐标系。
//
// 坐标方案（根治「边缘偏移 / 白边 / 截不到」）：
//   覆盖窗的尺寸/位置以**物理像素**直接设定（set_position + set_size 均用 Physical）；
//   设置后读取窗口的 outer_position / outer_size（真实矩形），用实际值作为捕获区域。
//   截图图在 WebView 内 object-fill 铺满覆盖窗，故：
//     图像像素(x,y) ≡ 窗口内 CSS 像素(x,y)   （预览图已按 scale_factor 降采样，1 CSS px = 1 图像 px）
//   映射退化为恒等，彻底消除偏移；且「捕获区域 == 覆盖窗显示区域」，边缘必然完整覆盖，无白边、无截不到。

use base64::Engine;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::ImageEncoder;
use image::{DynamicImage, ExtendedColorType, ImageFormat, RgbaImage};
use serde::Serialize;
use serde_json::json;
use std::io::Cursor;
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

// WGC 屏幕捕获（windows-capture，基于 Windows.Graphics.Capture；硬件加速、可截独占全屏）
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};


#[derive(Serialize, Clone)]
pub struct WindowInfo {
    pub hwnd: u64,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// 是否为本进程自身窗口（截图覆盖窗 / 主窗等）。
    /// 前端命中测试时跳过自身窗口，确保高亮的是「桌面上的目标窗口」而非我们的遮罩。
    pub is_self: bool,
    /// 是否为任务栏（屏幕底部那条系统栏）。前端点选它 = 整屏捕获（含任务栏），
    /// 其余窗口 / 框选一律裁剪掉任务栏那条带，做到「仅点任务栏才截任务栏」。
    #[serde(rename = "isTaskbar")]
    pub is_taskbar: bool,
    /// z 序排名（0 = 最顶层，数值越大越靠后）。前端命中测试在「光标落在多个重叠窗口矩形内」
    /// 时用它选出真正最上层可见的窗口，而不是盲目取最小面积（那会误判被遮挡的小窗口为命中）。
    pub z: i64,
}

/// 返回「本应用自身的全屏覆盖窗」HWND 集合，与 `window_at_point` 的 `excluded` 标签集合保持一致。
/// 用于从 `list_windows` 结果中剔除这些覆盖窗，避免前端纯 JS 命中测试 `hitWindow` 误把
/// 「覆盖窗自身」当成光标下窗口（覆盖窗矩形=整屏、z 序最前 → 悬停高亮整屏 / 卡在覆盖窗，
/// 即用户反馈的「仍有概率卡窗口」）。安得云荟自身的**主窗 / 浮窗**（非覆盖窗标签）不在集合内，
/// 仍保留在列表中，可被正常识别与录制 / 截图。
fn overlay_excluded_hwnds(app: &tauri::AppHandle) -> std::collections::HashSet<usize> {
    let mut set: std::collections::HashSet<usize> = std::collections::HashSet::new();
    for label in [
        "screenshot-overlay",
        "recorder-select",
        "recorder-widget",
        "recording-border",
    ] {
        if let Some(w) = app.get_webview_window(label) {
            if let Ok(h) = w.hwnd() {
                let hwnd = h.0 as winapi::shared::windef::HWND;
                set.insert(hwnd as usize);
                // Tauri WebView2 子控件 HWND 与顶层父 HWND 不同，同时排除 raw 与 GA_ROOT 祖先。
                let root = unsafe { winapi::um::winuser::GetAncestor(hwnd, winapi::um::winuser::GA_ROOT) };
                if !root.is_null() {
                    set.insert(root as usize);
                }
            }
        }
    }
    set
}

/// 计算当前桌面所有顶层窗口的 z 序排名（0 = 最顶层）。
/// 从 `GetTopWindow(NULL)` 出发沿 `GW_HWNDNEXT` 遍历整条 z 序链，hwnd -> rank。
/// 供 `list_windows` 给每个窗口标注 z，使前端命中测试能正确识别「重叠窗口」之上真实可见的那个。
fn zorder_ranks() -> std::collections::HashMap<usize, i64> {
    let mut map: std::collections::HashMap<usize, i64> = std::collections::HashMap::new();
    unsafe {
        let mut hwnd = winapi::um::winuser::GetTopWindow(std::ptr::null_mut());
        let mut rank: i64 = 0;
        while !hwnd.is_null() {
            map.insert(hwnd as usize, rank);
            rank += 1;
            hwnd = winapi::um::winuser::GetWindow(hwnd, winapi::um::winuser::GW_HWNDNEXT);
        }
    }
    map
}

/// 计算「所有显示器物理矩形」的并集（多屏覆盖）。
///
/// 数据源统一：直接用 `GetSystemMetrics(SM_XVIRTUALSCREEN / SM_CXVIRTUALSCREEN)`，
/// 与 `do_capture_region_wgc` 内部的虚拟桌面原点完全一致，消除双数据源不一致风险。
/// PM-DPI-Aware V2 下 `GetSystemMetrics` 返回物理像素，与 `EnumDisplayMonitors` 同坐标系。
fn virtual_desktop_rect() -> (i32, i32, i32, i32) {
    unsafe {
        let x = winapi::um::winuser::GetSystemMetrics(winapi::um::winuser::SM_XVIRTUALSCREEN);
        let y = winapi::um::winuser::GetSystemMetrics(winapi::um::winuser::SM_YVIRTUALSCREEN);
        let w = winapi::um::winuser::GetSystemMetrics(winapi::um::winuser::SM_CXVIRTUALSCREEN);
        let h = winapi::um::winuser::GetSystemMetrics(winapi::um::winuser::SM_CYVIRTUALSCREEN);
        (x, y, w, h)
    }
}



/// 关闭截图覆盖窗口（仅隐藏，复用不销毁）。主窗口全程保持原状。
#[tauri::command]
pub fn hide_overlay_window(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("screenshot-overlay") {
        let _ = w.hide();
    }
    // 复位 showing：下次按下热键才能再次触发（否则会被 start_screenshot 的防重入静默忽略）。
    if let Ok(mut s) = app.state::<std::sync::Mutex<ScreenshotData>>().lock() {
        s.showing = false;
    }
}

/// 枚举「其他进程」的可见窗口，返回**物理像素**矩形，供前端绘制绿色轮廓与窗口识别。
#[tauri::command]
pub fn list_windows(app: tauri::AppHandle) -> Result<Vec<WindowInfo>, String> {
    let mut windows: Vec<WindowInfo> = Vec::new();
    unsafe {
        winapi::um::winuser::EnumWindows(
            Some(enum_callback),
            &mut windows as *mut _ as winapi::shared::minwindef::LPARAM,
        );
    }
    windows.retain(|w| w.width > 8 && w.height > 8);
    // 标注 z 序排名（0 = 最顶层），供前端命中测试在重叠窗口场景取最上层窗口。
    let ranks = zorder_ranks();
    for w in &mut windows {
        w.z = ranks.get(&(w.hwnd as usize)).copied().unwrap_or(i64::MAX);
    }
    // 剔除「本应用自身的全屏覆盖窗」（截图/录屏选区窗、录屏控制台、录制边框）。
    // 关键修复（卡窗口根因）：上一轮为让安得云荟自身窗口（主窗/浮窗）可被识别，移除了命中测试的
    // `is_self` 跳过；但选区覆盖窗本身同为 `is_self` 且是「全屏 + z 序最前」的可见窗口。录屏/截图
    // 的 200ms 增量刷新会在**覆盖窗已显示**时调用本函数，于是覆盖窗被 EnumWindows 枚举进来，
    // 前端纯 JS 命中测试 `hitWindow` 便把「覆盖窗自身」当成光标下窗口 → 悬停高亮整屏 / 卡在覆盖窗
    // （即「仍有概率卡窗口」，且截图、录屏同源）。此处按标签剔除，与 `window_at_point` 的 `excluded`
    // 集合一致；安得云荟的主窗/浮窗（非覆盖窗标签）保留在列表中，仍可被正常识别与录制。
    let excluded = overlay_excluded_hwnds(&app);
    windows.retain(|w| !excluded.contains(&(w.hwnd as usize)));
    Ok(windows)
}

unsafe extern "system" fn enum_callback(
    hwnd: winapi::shared::windef::HWND,
    lparam: winapi::shared::minwindef::LPARAM,
) -> i32 {
    let state = &mut *(lparam as *mut Vec<WindowInfo>);
    // 不再排除本进程（安得云荟）自身窗口：窗口识别统一处理所有可见窗口，
    // 避免为「自我屏蔽」增加特殊分支与维护成本（截图 / 录屏共用本枚举）。
    // 截图覆盖窗本身在枚举时已隐藏（IsWindowVisible 跳过），不会出现在列表中。
    if winapi::um::winuser::IsWindowVisible(hwnd) == 0 {
        return 1;
    }
    // 过滤最小化窗口（IsIconic = true 时窗口已最小化到任务栏，rect 无意义）
    if winapi::um::winuser::IsIconic(hwnd) != 0 {
        return 1;
    }
    // 过滤子窗口（WS_CHILD）：子窗口嵌套在父窗口内，会产生重复/碎片化的高亮框
    let gwl_style = winapi::um::winuser::GetWindowLongW(hwnd, winapi::um::winuser::GWL_STYLE);
    if gwl_style & winapi::um::winuser::WS_CHILD as i32 != 0 {
        return 1;
    }
    // 跳过 shell 窗口（整屏桌面背景 / 桌面合成层等）。
    // 注意：任务栏（Shell_TrayWnd / Shell_SecondaryTrayWnd）**不再跳过**，改为纳入可识别列表
    // （标记 is_taskbar），供前端实现「点任务栏=整屏（含任务栏）、其余一律不截任务栏」。
    let mut cls: [u16; 256] = [0; 256];
    let cls_len = winapi::um::winuser::GetClassNameW(hwnd, cls.as_mut_ptr(), 256);
    let class = if cls_len > 0 {
        String::from_utf16_lossy(&cls[..cls_len as usize])
    } else {
        String::new()
    };
    match class.as_str() {
        "Progman" | "WorkerW"
        | "Windows.UI.Composition.DesktopWindowManager"
        | "ApplicationFrameInputSinkWindow" | "MsgBox" => return 1,
        _ => {}
    }
    let is_taskbar = class == "Shell_TrayWnd" || class == "Shell_SecondaryTrayWnd";
    // 使用 DWM 扩展边框（DWMWA_EXTENDED_FRAME_BOUNDS）替代 GetWindowRect。
    // GetWindowRect 包含 Windows 10/11 的不可见调整边框（每侧约 7px），导致高亮框比实际窗口大一圈。
    // DWM 扩展边框精确匹配可见窗口边缘，消除「多了一点」的视觉偏差。
    // 失败时回退到 GetWindowRect（旧系统或无 DWM 合成的窗口）。
    const DWMWA_EXTENDED_FRAME_BOUNDS: u32 = 4;
    let mut rect: winapi::shared::windef::RECT = std::mem::zeroed();
    let hr = winapi::um::dwmapi::DwmGetWindowAttribute(
        hwnd,
        DWMWA_EXTENDED_FRAME_BOUNDS,
        &mut rect as *mut _ as *mut _,
        std::mem::size_of::<winapi::shared::windef::RECT>() as u32,
    );
    // **关键修复（窗口识别只剩一个）**：旧实现仅在 `hr != 0`（DWM 查询失败）时回退
    // GetWindowRect。但在部分机器/配置下，DWM 对大多数窗口返回 `hr == 0` 却给出**退化矩形**
    // （right<=left 或 bottom<=top，即宽高≤0），这些窗口随后被 `width<=0||height<=0`
    // 分支跳过 → 列表里只剩个别矩形正常的窗口 → 表现为「只识别一个窗口 / 鼠标移动无效」。
    // 因此只要 DWM 返回失败**或**矩形退化，一律回退到 GetWindowRect（最稳妥的兜底）。
    let use_rect = if hr != 0 || rect.right <= rect.left || rect.bottom <= rect.top {
        let mut gwr: winapi::shared::windef::RECT = std::mem::zeroed();
        if winapi::um::winuser::GetWindowRect(hwnd, &mut gwr) == 0 {
            return 1;
        }
        gwr
    } else {
        rect
    };
    let x = use_rect.left;
    let y = use_rect.top;
    let width = use_rect.right - use_rect.left;
    let height = use_rect.bottom - use_rect.top;
    if width <= 0 || height <= 0 {
        return 1;
    }
    // 关键性能：枚举窗口时**不读标题**。原 GetWindowTextW 会向目标线程发 WM_GETTEXT，
    // 遇「活着但响应极慢」的窗口会阻塞数秒 → 每次截图都卡 4-5s。即便改用 SendMessageTimeout，
    // 一旦误加 SMTO_NOTIMEOUTIFNOTHUNG 该超时即失效，仍会挂起。因此这里彻底不发跨线程消息，
    // 标题改由 get_window_title 在悬停时按需懒加载（单次、30ms 超时、绝不挂起）。
    // is_self：标记本进程窗口（截图覆盖窗 / 主窗）。GetWindowThreadProcessId 是轻量本机调用
    // （不发跨线程消息），不会阻塞。前端命中时跳过 is_self，确保高亮的是桌面目标窗口而非遮罩。
    let mut pid: u32 = 0;
    winapi::um::winuser::GetWindowThreadProcessId(hwnd, &mut pid);
    let is_self = pid == winapi::um::processthreadsapi::GetCurrentProcessId();
    state.push(WindowInfo {
        hwnd: hwnd as u64,
        title: String::new(),
        x,
        y,
        width,
        height,
        is_self,
        is_taskbar,
        z: 0,
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

/// 由 HWND 构造 `WindowInfo`：矩形优先用 `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)`
/// （不含阴影/边框，贴合用户感知），失败时回退 `GetWindowRect`；附带 `is_self`（是否本进程）与
/// `is_taskbar`。矩形退化（宽高<=0）返回 None，调用方跳过该窗口。
fn build_window_info(hwnd: winapi::shared::windef::HWND) -> Option<WindowInfo> {
    unsafe {
        const DWMWA_EXTENDED_FRAME_BOUNDS: u32 = 4;
        let mut rect: winapi::shared::windef::RECT = std::mem::zeroed();
        let hr = winapi::um::dwmapi::DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut _ as *mut _,
            std::mem::size_of::<winapi::shared::windef::RECT>() as u32,
        );
        let use_rect = if hr != 0 || rect.right <= rect.left || rect.bottom <= rect.top {
            let mut gwr: winapi::shared::windef::RECT = std::mem::zeroed();
            if winapi::um::winuser::GetWindowRect(hwnd, &mut gwr) == 0 {
                return None;
            }
            gwr
        } else {
            rect
        };
        let x = use_rect.left;
        let y = use_rect.top;
        let width = use_rect.right - use_rect.left;
        let height = use_rect.bottom - use_rect.top;
        if width <= 0 || height <= 0 {
            return None;
        }
        let mut pid: u32 = 0;
        winapi::um::winuser::GetWindowThreadProcessId(hwnd, &mut pid);
        let is_self = pid == winapi::um::processthreadsapi::GetCurrentProcessId();
        let mut cls: [u16; 256] = [0; 256];
        let cls_len = winapi::um::winuser::GetClassNameW(hwnd, cls.as_mut_ptr(), 256);
        let class = if cls_len > 0 {
            String::from_utf16_lossy(&cls[..cls_len as usize])
        } else {
            String::new()
        };
        let is_taskbar = class == "Shell_TrayWnd" || class == "Shell_SecondaryTrayWnd";
        Some(WindowInfo {
            hwnd: hwnd as u64,
            title: String::new(),
            x,
            y,
            width,
            height,
            is_self,
            is_taskbar,
            z: 0,
        })
    }
}

/// 实时命中测试：返回光标下（物理屏幕坐标 x,y）真实的顶层窗口，**排除本应用自身的全屏透明
/// 覆盖窗 / 控制台 / 浮窗**。用于悬停高亮与单击选取，替代「枚举全列表 + JS 矩形求交」——
/// 后者依赖一份可能残缺/陈旧的窗口列表，偶发漏窗时表现为「只识别一个窗口 / 鼠标移动无效」。
/// 本函数直接以 OS 为权威（等价于 `WindowFromPoint`，但跳过自身覆盖窗），任何时刻都返回光标下
/// 真实窗口，彻底消除该问题，且天然处理 z 序裁剪、透明区域、被遮挡窗口与 UWP 现代应用。
///
/// 实现：从 `WindowFromPoint(pt)` 得到的真实顶层窗口出发，沿全局 Z 序（`GetWindow(GW_HWNDNEXT)`）
/// 向下遍历，跳过「自身覆盖窗集合」与不可见窗口，返回第一个矩形包含该点的真实窗口。
/// 桌面合成层（Progman / WorkerW 等）返回 None，避免悬停桌面时高亮整屏。
#[tauri::command]
pub async fn window_at_point(app: tauri::AppHandle, x: i32, y: i32) -> Option<WindowInfo> {
    // 放工作线程执行：WindowFromPoint / GetWindowRect / DwmGetWindowAttribute 等 OS 调用
    // 若在主线程同步跑，悬停/单击期间会阻塞 Tauri UI 线程导致卡顿。单击仅调用一次，开销可忽略。
    let result = tauri::async_runtime::spawn_blocking(move || unsafe {
        let pt = winapi::shared::windef::POINT { x, y };
        // 自身覆盖窗 / 控制台 / 浮窗的顶层 HWND 集合（与 filter_self_overlay_windows 一致）。
        // Tauri WebView2 的子控件 HWND 与顶层父 HWND 不同，故同时排除 raw 与 GA_ROOT 祖先。
        let mut excluded: Vec<winapi::shared::windef::HWND> = Vec::new();
        for label in [
            "recorder-select",
            "recorder-widget",
            "screenshot-overlay",
            "floating-clipboard",
        ] {
            if let Some(w) = app.get_webview_window(label) {
                if let Ok(h) = w.hwnd() {
                    let hwnd = h.0 as winapi::shared::windef::HWND;
                    excluded.push(hwnd);
                    let root = winapi::um::winuser::GetAncestor(hwnd, winapi::um::winuser::GA_ROOT);
                    if !root.is_null() {
                        excluded.push(root);
                    }
                }
            }
        }
        let mut hwnd = winapi::um::winuser::WindowFromPoint(pt);
        let mut guard: u32 = 0;
        while !hwnd.is_null() && guard < 256 {
            if !excluded.contains(&hwnd) && winapi::um::winuser::IsWindowVisible(hwnd) != 0 {
                let mut r = std::mem::zeroed();
                if winapi::um::winuser::GetWindowRect(hwnd, &mut r) != 0
                    && pt.x >= r.left
                    && pt.x <= r.right
                    && pt.y >= r.top
                    && pt.y <= r.bottom
                {
                    if let Some(info) = build_window_info(hwnd) {
                        // 不再跳过 is_self：本应用自身的窗口（主窗 / 浮窗）同样是用户可能
                        // 想截图/录制的可见窗口。截图/录屏覆盖窗已通过上方 `excluded` 集合按标签排除，
                        // 不会在这里被误返回。
                        // 桌面合成层不高亮（返回 None），避免悬停桌面时高亮整屏。
                        let mut cls_buf: [u16; 256] = [0; 256];
                        let cls_len =
                            winapi::um::winuser::GetClassNameW(hwnd, cls_buf.as_mut_ptr(), 256);
                        let class = if cls_len > 0 {
                            String::from_utf16_lossy(&cls_buf[..cls_len as usize])
                        } else {
                            String::new()
                        };
                        match class.as_str() {
                            "Progman" | "WorkerW"
                            | "Windows.UI.Composition.DesktopWindowManager"
                            | "ApplicationFrameInputSinkWindow" | "MsgBox" => return None,
                            _ => return Some(info),
                        }
                    }
                }
            }
            hwnd = winapi::um::winuser::GetWindow(hwnd, winapi::um::winuser::GW_HWNDNEXT);
            guard += 1;
        }
        None
    });
    result.await.unwrap_or(None)
}

/// 将 (x, y, w, h) 区域从整屏捕获为 RgbaImage（物理像素，RGBA）。
///
/// 技术选型说明（截图后端已从 GDI `BitBlt` 重构为 WGC）：
/// - 后端使用 `Windows.Graphics.Capture`（WGC），由 `windows-capture` crate 封装。该 crate
///   依赖 `windows` 0.61.3，与 Tauri 锁定的版本完全一致，因此零双份编译、无版本冲突。
/// - WGC 是微软主推的硬件加速捕获路径，可截**独占全屏** DirectX / OpenGL 游戏，较 GDI
///   `BitBlt` 更快、更省 CPU，且更新按需（不活动时零开销）。
/// - **仍有的系统级天花板（非本架构可消除）**：对 HDCP / OPM 受保护视频，WGC 同样返回
///   黑帧（与 GDI 一致），应用层无法绕过；此情形 `is_all_black` 兜底重试无效，前端可提示。
/// - **多显示器**：WGC 以显示器为单位捕获，故逐显示器抓取后按虚拟桌面偏移拼成整图，
///   与 GDI「一次抓整 DC」语义等价，`native_ox/oy/w/h` 对外不变 → 覆盖层与保存链路零改动。
/// - **增量兜底**：截到疑似全黑帧时做 1 次重试（WGC 首帧可能为初始化空帧），降损但非根治。
fn capture_region(x: i32, y: i32, w: i32, h: i32) -> Result<RgbaImage, String> {
    if w <= 0 || h <= 0 {
        return Err("无效的截图区域".into());
    }

    // 执行一次捕获，若结果为全黑（WGC 初始化空帧 / 受保护内容），重试一次。
    let result = do_capture_region_wgc(x, y, w, h)?;
    if is_all_black(&result) {
        // 短暂间隙让 GPU 管线稳定后重试
        std::thread::sleep(std::time::Duration::from_millis(10));
        return do_capture_region_wgc(x, y, w, h);
    }
    Ok(result)
}

/// WGC 单帧捕获处理器：首帧到达后把像素经 channel 传出并 `stop()` 终止会话。
///
/// `windows-capture` 的 `start` 会进入阻塞式消息循环接管当前线程，故 `capture_monitor_wgc`
/// 在独立线程中调用它；本 handler 仅负责「取到一帧 → 转 RGBA → 发出 → 停止」。
struct WgcSingleFrame {
    tx: std::sync::mpsc::Sender<Result<(u32, u32, Vec<u8>), String>>,
}

impl GraphicsCaptureApiHandler for WgcSingleFrame {
    // 把外部 channel 经 flags 传入 new
    type Flags = std::sync::mpsc::Sender<Result<(u32, u32, Vec<u8>), String>>;
    type Error = String;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self { tx: ctx.flags })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let w = frame.width();
        let h = frame.height();
        let buffer = frame.buffer().map_err(|e| e.to_string())?;
        // `ColorFormat::Rgba8` 下 WGC 帧池即输出 RGBA，`as_nopadding_buffer` 返回无 pitch
        // 填充的连续 RGBA 字节（长度 = w * h * 4），可直接构造 RgbaImage。
        let mut scratch = Vec::new();
        let src = buffer.as_nopadding_buffer(&mut scratch);
        // 复制并强制 alpha=255（桌面像素 alpha 无意义，避免透明 PNG 怪象）
        let len = src.len();
        let mut rgba = vec![0u8; len];
        let mut p = 0usize;
        while p + 3 < len {
            rgba[p] = src[p];
            rgba[p + 1] = src[p + 1];
            rgba[p + 2] = src[p + 2];
            rgba[p + 3] = 255;
            p += 4;
        }
        let _ = self.tx.send(Ok((w, h, rgba)));
        // 首帧已取得，优雅停止捕获会话（库通过 WM_QUIT 退出消息循环并释放 D3D/COM 资源）
        capture_control.stop();
        Ok(())
    }
}

/// 抓取单块显示器的整屏为 RGBA `RgbaImage`（物理像素）。
///
/// 在独立线程中运行 `WgcSingleFrame::start`（阻塞式消息循环），通过 channel 取回首帧，
/// 超时 5s 兜底（显示器不支持或被系统策略拦截时不会永久挂起）。
fn capture_monitor_wgc(monitor: Monitor) -> Result<RgbaImage, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        let tx_err = tx.clone();
        let settings = Settings::new(
            monitor,
            CursorCaptureSettings::Default,
            DrawBorderSettings::Default,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Rgba8,
            tx,
        );
        // 正常 stop 路径下 start 返回 Ok；仅真正错误才 Err，上报供上层判定。
        if let Err(e) = WgcSingleFrame::start(settings) {
            let _ = tx_err.send(Err(format!("WGC 捕获会话异常: {}", e)));
        }
    });
    match rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Ok((w, h, rgba))) => {
            let _ = handle.join();
            RgbaImage::from_raw(w, h, rgba)
                .ok_or_else(|| "WGC 帧构造失败（尺寸与字节长度不匹配）".to_string())
        }
        Ok(Err(e)) => {
            let _ = handle.join();
            Err(e)
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            let _ = handle.join();
            Err("WGC 捕获超时（显示器可能不支持或被系统策略拦截）".to_string())
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            let _ = handle.join();
            Err("WGC 捕获线程异常退出".to_string())
        }
    }
}

/// 取显示器物理像素矩形（PM-DPI-Aware V2 下 `GetMonitorInfoW` 返回真实物理像素）。
fn monitor_rect_phys(monitor: &Monitor) -> (i32, i32, i32, i32) {
    unsafe {
        let hmon = monitor.as_raw_hmonitor() as winapi::shared::windef::HMONITOR;
        let mut info: winapi::um::winuser::MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<winapi::um::winuser::MONITORINFO>() as u32;
        winapi::um::winuser::GetMonitorInfoW(hmon, &mut info);
        (
            info.rcMonitor.left,
            info.rcMonitor.top,
            info.rcMonitor.right,
            info.rcMonitor.bottom,
        )
    }
}

/// 实际 WGC 捕获逻辑（抽取为独立函数，供 `capture_region` 单次/重试调用）。
///
/// 坐标语义与旧 GDI 版一致：`(x, y)` 为相对虚拟桌面原点 `(rx, ry)` 的偏移，
/// 捕获区域绝对屏幕坐标为 `(rx + x, ry + y)` 起的 `w × h`。逐显示器 WGC 抓取后，
/// 按其在虚拟桌面中的偏移用 `imageops::replace` 拼成整图（超出捕获区的部分被裁掉，
/// 显示器间空隙保持黑底），即可被前端 `read_screenshot` 与 `save_cropped` 直接消费。
fn do_capture_region_wgc(x: i32, y: i32, w: i32, h: i32) -> Result<RgbaImage, String> {
    if w <= 0 || h <= 0 {
        return Err("无效的截图区域".into());
    }
    let rx = unsafe { winapi::um::winuser::GetSystemMetrics(winapi::um::winuser::SM_XVIRTUALSCREEN) };
    let ry = unsafe { winapi::um::winuser::GetSystemMetrics(winapi::um::winuser::SM_YVIRTUALSCREEN) };
    let ax = rx + x;
    let ay = ry + y;

    let mut full =
        image::RgbaImage::from_pixel(w as u32, h as u32, image::Rgba([0u8, 0, 0, 255]));

    let monitors = Monitor::enumerate().map_err(|e| format!("枚举显示器失败: {}", e))?;
    for mon in monitors {
        let (ml, mt, mr, mb) = monitor_rect_phys(&mon);
        // 与捕获区域求交：仅拼接交集部分（提升任意裁剪场景的效率）
        let ix = ax.max(ml);
        let iy = ay.max(mt);
        let ix2 = (ax + w).min(mr);
        let iy2 = (ay + h).min(mb);
        if ix2 <= ix || iy2 <= iy {
            continue;
        }
        let img = capture_monitor_wgc(mon)?;
        // 交集在 full 中的目标偏移（相对捕获区域左上角 ax, ay）
        let dx = (ix - ax) as i64;
        let dy = (iy - ay) as i64;
        image::imageops::replace(&mut full, &img, dx, dy);
    }
    Ok(full)
}

/// 检测 RGBA 图像是否全部为零（全黑）像素。
fn is_all_black(img: &RgbaImage) -> bool {
    let pixels = img.as_raw();
    for chunk in pixels.chunks_exact(4) {
        // RGBA: 检查 R+G+B 三个通道（WGC ColorFormat::Rgba8 输出 RGBA，非 BGRA）
        if chunk[0] != 0 || chunk[1] != 0 || chunk[2] != 0 {
            return false;
        }
    }
    true
}

/// GDI BitBlt 兜底捕获：直接抓「虚拟桌面」(x, y, w, h) 区域（物理像素）。
///
/// 在 PM-DPI-Aware V2 进程里，`GetDC(NULL)` 原点即虚拟桌面左上角、坐标即物理像素，
/// 与 WGC 同坐标系。当 WGC 失败或返回全黑帧（驱动/初始化空帧/受保护内容）时，
/// 此路径作为可靠兜底——旧版本即采用 GDI，在各类机器上稳定可用，可截常规桌面内容。
/// （注意：GDI 无法截「独占全屏」DirectX 游戏，那是 WGC 的强项；故二者互补而非互斥。）
fn capture_region_gdi(x: i32, y: i32, w: i32, h: i32) -> Result<RgbaImage, String> {
    if w <= 0 || h <= 0 {
        return Err("无效的截图区域".into());
    }
    unsafe {
        let screen = winapi::um::winuser::GetDC(std::ptr::null_mut());
        if screen.is_null() {
            return Err("获取屏幕 DC 失败".into());
        }
        let mem = winapi::um::wingdi::CreateCompatibleDC(screen);
        if mem.is_null() {
            winapi::um::winuser::ReleaseDC(std::ptr::null_mut(), screen);
            return Err("创建兼容 DC 失败".into());
        }
        let bitmap = winapi::um::wingdi::CreateCompatibleBitmap(screen, w, h);
        if bitmap.is_null() {
            winapi::um::wingdi::DeleteDC(mem);
            winapi::um::winuser::ReleaseDC(std::ptr::null_mut(), screen);
            return Err("创建兼容位图失败".into());
        }
        let old = winapi::um::wingdi::SelectObject(mem, bitmap as *mut winapi::ctypes::c_void);
        let ok = winapi::um::wingdi::BitBlt(mem, 0, 0, w, h, screen, x, y, winapi::um::wingdi::SRCCOPY);

        let result = if ok != 0 {
            let mut bi: winapi::um::wingdi::BITMAPINFOHEADER = std::mem::zeroed();
            bi.biSize = std::mem::size_of::<winapi::um::wingdi::BITMAPINFOHEADER>() as u32;
            bi.biWidth = w;
            bi.biHeight = -(h); // 顶行在前（自下而上 → 自上而下）
            bi.biPlanes = 1;
            bi.biBitCount = 32;
            bi.biCompression = winapi::um::wingdi::BI_RGB;
            let mut buf: Vec<u8> = vec![0u8; (w as usize) * (h as usize) * 4];
            let lines = winapi::um::wingdi::GetDIBits(
                mem,
                bitmap,
                0,
                h as u32,
                buf.as_mut_ptr() as *mut winapi::ctypes::c_void,
                &mut bi as *mut _ as *mut winapi::um::wingdi::BITMAPINFO,
                winapi::um::wingdi::DIB_RGB_COLORS,
            );
            if lines == 0 {
                Err("GetDIBits 失败".into())
            } else {
                // BGRA → RGBA，alpha 强制 255（桌面像素无意义）
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
                    None => Err("GDI 图像构造失败".into()),
                }
            }
        } else {
            Err("BitBlt 失败".into())
        };

        // 清理 GDI 资源（顺序：还原选中的旧对象 → 删位图 → 删 DC → 释放屏幕 DC）
        if old != winapi::um::wingdi::HGDI_ERROR {
            winapi::um::wingdi::SelectObject(mem, old);
        }
        winapi::um::wingdi::DeleteObject(bitmap as *mut winapi::ctypes::c_void);
        winapi::um::wingdi::DeleteDC(mem);
        winapi::um::winuser::ReleaseDC(std::ptr::null_mut(), screen);
        result
    }
}

/// 全虚拟桌面捕获（区域始终为整虚拟桌面 (ox,oy,ow,oh)）。
///
/// GDI BitBlt 为主路径（同步、毫秒级），仅当 GDI 失败时回退 WGC（可截独占全屏游戏）。
/// 返回图像尺寸严格为 (ow, oh)，与覆盖窗显示区域 1:1 对齐，
/// 彻底消除「边缘偏移 / 左侧几 px 间隙无法截屏」问题。
fn capture_full(ox: i32, oy: i32, ow: i32, oh: i32) -> Result<RgbaImage, String> {
    // GDI BitBlt 为主路径：同步可靠、无 WGC 会话启动开销（~500ms-1s）。
    // GDI 成功即直接返回——不再做 is_all_black 检查：
    //   1) GDI BitBlt 是同步的，不像 WGC 有「首帧初始化空帧」问题；
    //   2) is_all_black 会在屏幕较暗（深色壁纸/夜间模式）时误判为全黑 → 触发 WGC 回退，
    //      导致每次截图都卡 ~1s（用户 Issue: 截图启动速度慢）；
    //   3) 仅当 GDI 本身失败（Err）时才回退 WGC（可截独占全屏 DirectX/OpenGL 游戏）。
    match capture_region_gdi(ox, oy, ow, oh) {
        Ok(img) => Ok(img),
        Err(e) => {
            eprintln!("[截图] GDI 捕获失败，回退 WGC: {}", e);
            capture_region(0, 0, ow, oh)
        }
    }
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
    // 覆盖窗当前是否正在显示（用于防重入）：由 start_screenshot 显示后置 true、
    // hide_overlay_window 关闭后置 false。替代 overlay.is_visible() 判定——
    // 后者在 hide 后有 1 帧状态延迟，会误判为「仍在显示」而静默 return Ok(())，
    // 表现为「按截图键毫无反应」（用户 Issue 5）。
    pub showing: bool,
    // 最近一次截图推送的载荷快照：覆盖层在「screenshot-start」push 事件丢失时，
    // 通过 peek_screenshot 主动拉取作为兜底恢复路径（根治打包版偶发「只有透明遮罩、全屏卡死」）。
    // `session` 每次 start_screenshot 自增；覆盖层轮询到 session 变大即视为「有新截图待显示」，
    // 天然规避事件丢失、窗口复用导致的重复触发问题。
    pub last_ox: f64,
    pub last_oy: f64,
    pub last_scale: f64,
    pub last_windows: Vec<WindowInfo>,
    pub session: u64,
}

impl Default for ScreenshotData {
    fn default() -> Self {
        Self {
            note_id: String::new(),
            shortcut: "Ctrl+Shift+S".to_string(),
            capturing: false,
            showing: false,
            last_ox: 0.0,
            last_oy: 0.0,
            last_scale: 1.0,
            last_windows: Vec::new(),
            session: 0,
        }
    }
}

/// 最近一次截屏的数据：
/// - `raw`：原生物理分辨率的 RGBA 字节（整屏捕获区）。保存/复制时直接在此字节上按选区裁剪，零编码；
///   这正与微信/QQ 一致——抓屏后几乎不做图像处理，故能毫秒级响应。
/// - `native_w/h`：raw 图的像素尺寸。
/// - `native_ox/oy`：raw 图左上角对应的**屏幕物理坐标**（覆盖窗真实客户区原点），
///   用于把前端的物理选区换算到 native 图像坐标。
pub struct Shot {
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
// 注意：本命令为 `async fn`，Tauri v2 会把 async 命令调度到独立异步任务线程，
// 不再占用主（UI）线程。捕获与窗口操作期间主线程仍可正常泵消息，
// 杜绝「保存/捕获时主线程被阻塞 → Windows 显示（无响应）幽灵窗口 / 界面卡死」。
#[tauri::command]
pub async fn start_screenshot(
    app: tauri::AppHandle,
    _state: tauri::State<'_, std::sync::Mutex<ScreenshotData>>,
) -> Result<(), String> {
    // 覆盖窗由前端 new WebviewWindow 在 WebView2 环境就绪后创建（与浮窗同款安全路径）。
    // 注意：切勿在此 async 命令内调用 create_overlay_window 同步 build()——
    // async 命令运行于 Tauri 异步线程（MTA），在该线程创建 WebView2 会触发
    // 0x8007139F（"组或资源状态不正确"），且窗口 HWND 建出后 WebView2 初始化失败，
    // 导致下方 scale_factor() 返回 Err（"无法获取缩放比"）。
    let overlay = app
        .get_webview_window("screenshot-overlay")
        .ok_or_else(|| "覆盖窗缺失，请重启应用".to_string())?;

    // 防重入：正在捕获（CAPTURING 原子）或覆盖窗正在显示（state.showing）则忽略。
    // 注意：不再用 overlay.is_visible() —— 窗口 hide 后状态上报有 1 帧延迟，会误判为「仍在显示」
    // 从而静默 return Ok(())，表现为「按截图键毫无反应」（用户 Issue 5）。
    let st = _state.lock().map_err(|e| format!("锁失败: {}", e))?;
    if CAPTURING.load(std::sync::atomic::Ordering::SeqCst) || st.showing {
        return Ok(());
    }
    // RAII guard：函数退出（正常 / 错误 / panic）时 CAPTURING 自动复位。
    let _guard = CaptureGuard::acquire();
    drop(st); // 尽早释放锁，避免后续长操作持锁

    // 立即显示透明覆盖窗（秒开选区 UI，与录屏选区窗一致），捕获完成后再注入冻结图，
    // 消除「先冻结全屏捕获、再显示」带来的等待感。透明覆盖窗在 GDI BitBlt 主路径下
    // 不参与桌面合成像素、不会被截入画面；WGC 兜底路径同样只截到「透明→桌面」，安全。
    let (rx, ry, rw, rh) = virtual_desktop_rect();

    // 缓存上次的虚拟桌面矩形：若未变化（显示器配置未改），跳过 set_position/set_size，
    // 省 ~16ms DWM 重排时间。只有首次或分辨率变更时才重新贴位。
    // shadow(false) + decorations(false) 确保窗口尺寸 == 客户区尺寸，无隐藏边框偏移。
    static LAST_VD_RECT: std::sync::OnceLock<std::sync::Mutex<(i32, i32, i32, i32)>> = std::sync::OnceLock::new();
    let cache = LAST_VD_RECT.get_or_init(|| std::sync::Mutex::new((0, 0, 0, 0)));
    let need_reposition = {
        let last = cache.lock().unwrap();
        *last != (rx, ry, rw, rh)
    };
    if need_reposition {
        let _ = overlay.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: rx, y: ry }));
        let _ = overlay.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: rw as u32, height: rh as u32 }));
        *cache.lock().unwrap() = (rx, ry, rw, rh);
    }

    let ox = rx;
    let oy = ry;
    let ow = rw;
    let oh = rh;

    let scale = match overlay.scale_factor() {
        Ok(s) => s,
        Err(_) => return Err("无法获取缩放比".into()),
    };

    // 先枚举窗口（轻量、~几 ms），让窗口识别在选区阶段立即可用；重捕获放后台。
    // 注意：list_windows 必须早于 overlay 显示，否则「透明待加载态」期间 windows 为空，
    // 导致鼠标悬停无法高亮窗口（只能框选全屏）。
    let windows_now = list_windows(app.clone()).unwrap_or_default();

    // 先推送 meta 并立即可见（前端进入透明待加载态，选区交互 + 窗口识别立即可用）。
    let init_payload = json!({
        "ox": ox,
        "oy": oy,
        "scale": scale,
        "windows": windows_now,
        "noteId": "",
    });
    let _ = overlay.emit("screenshot-start", &init_payload);
    let _ = overlay.show();
    let _ = overlay.set_focus();
    // 标记覆盖窗正在显示：用于防重入（用户再次按下热键时忽略，直到关闭）。
    if let Ok(mut s) = app.state::<std::sync::Mutex<ScreenshotData>>().lock() {
        s.showing = true;
    }

    // 重捕获放后台线程执行；窗口枚举已完成（windows_now），完成后推送 screenshot-ready 注入冻结图。
    // 期间选区交互 + 窗口识别已在透明覆盖窗上进行，用户无需等待捕获完成即可框选/识别窗口。
    let app2 = app.clone();
    let windows_for_ready = windows_now.clone();
    std::thread::spawn(move || {
        let full_result = std::thread::scope(|s| {
            let capture_handle = s.spawn(|| capture_full(ox, oy, ow, oh));
            capture_handle.join().unwrap_or(Err("捕获线程 panic".into()))
        });
        let full = match full_result {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[截图] 捕获失败: {}", e);
                return;
            }
        };
        // 留存「原生物理分辨率 RGBA 字节」：保存/复制时直接在此字节上按选区裁剪，零编码。
        let raw = full.as_raw().to_vec();
        {
            let mut slot = SHOT.lock().expect("截图状态锁失败");
            *slot = Some(Shot {
                raw,
                native_w: ow as u32,
                native_h: oh as u32,
                native_ox: ox,
                native_oy: oy,
            });
        }
        // 写入跨窗口快照 + 自增 session：这是「兜底恢复」的权威数据源。
        let note_id = {
            let state = app2.state::<std::sync::Mutex<ScreenshotData>>();
            let mut s = state.lock().map_err(|e| format!("锁失败: {}", e)).unwrap();
            s.last_ox = ox as f64;
            s.last_oy = oy as f64;
            s.last_scale = scale;
            s.last_windows = windows_for_ready.clone();
            s.session = s.session.wrapping_add(1);
            s.note_id.clone()
        };
        let payload = json!({
            "ox": ox,
            "oy": oy,
            "scale": scale,
            "windows": windows_for_ready,
            "noteId": note_id,
        });
        if let Some(w) = app2.get_webview_window("screenshot-overlay") {
            let _ = w.emit("screenshot-ready", payload);
        }
    });
    Ok(())
}

/// 覆盖层兜底拉取：返回最近一次截图的载荷快照 + 单调递增的 `session`。
/// 覆盖层轮询本命令，一旦发现 `session` 大于自己已处理的值，即视为「有新截图待显示」，
/// 主动读取冻结图渲染——即使 `screenshot-start` push 事件在打包版里丢失也能自愈。
#[tauri::command]
pub fn peek_screenshot(
    state: tauri::State<'_, std::sync::Mutex<ScreenshotData>>,
) -> Result<serde_json::Value, String> {
    let s = state.lock().map_err(|e| format!("锁失败: {}", e))?;
    Ok(json!({
        "ox": s.last_ox,
        "oy": s.last_oy,
        "scale": s.last_scale,
        "windows": s.last_windows,
        "noteId": s.note_id,
        "session": s.session,
    }))
}

/// 覆盖窗读取截图预览：前 8 字节为宽/高（u32 LE，逻辑分辨率），其后为 RGBA 字节。
/// 在 Rust 侧直接「最近邻」降采样到逻辑分辨率（≈窗口 CSS 像素），体积约为原图的 1/scale²，
/// 大幅减少 IPC 传输与前端建图开销（这是截图「2-3×微信」耗时的主要来源之一）；
/// 裁剪/保存仍走 SHOT 原生字节（save_cropped / crop_native_rgba），不损失最终清晰度。
// async：最近邻降采样整屏图在主线程外执行，覆盖窗预览「秒开」且不卡 UI。
#[tauri::command]
pub async fn read_screenshot(scale: f64) -> Result<tauri::ipc::Response, String> {
    // `scale`（覆盖窗 devicePixelRatio）保留为契约参数：预览已改为「原图交前端按 CSS 尺寸
    // 降采样显示」，不再在 Rust 侧按 scale 下采样，故此处不再直接使用，仅占位以兼容前端调用。
    let _ = scale;
    let slot = SHOT.lock().map_err(|e| format!("锁失败: {}", e))?;
    let shot = slot
        .as_ref()
        .ok_or_else(|| "尚无截屏数据，请先触发截图".to_string())?;
    let fw = shot.native_w as u32;
    let fh = shot.native_h as u32;
    // 预览分辨率：默认「原生物理分辨率」直接交给前端，由浏览器按窗口 CSS 尺寸（= 物理 ÷ scale）
    // GPU 降采样显示——此时图像像素 ≥ 显示像素，1:1 对齐且天然清晰；同时前端以 object-fit:fill
    // 铺满覆盖窗时，预览像素与屏幕物理像素严格一一对应，选区映射零偏移（旧方案在 >2800px 时做
    // Triangle 降采样，预览被拉伸 → 边缘偏移、左边几 px 截不到、画面发糊，即用户 Issue 6）。
    // 仅当单边超过 CAP（≈4K+ 超大屏）才做一次轻微平滑降采样，约束 IPC 体积、避免极端卡顿。
    const CAP: u32 = 4500;
    let max_dim = fw.max(fh);
    let factor = if max_dim > CAP {
        CAP as f64 / max_dim as f64
    } else {
        1.0
    };
    let pw = ((fw as f64 * factor).round().max(1.0)) as u32;
    let ph = ((fh as f64 * factor).round().max(1.0)) as u32;
    let src_img = image::RgbaImage::from_raw(fw, fh, shot.raw.clone())
        .ok_or_else(|| "截屏数据构造失败".to_string())?;
    // factor == 1.0 时直接透传原图（零重采样、绝对清晰）；仅超限时平滑降采样（Triangle）。
    let resized = if factor < 1.0 {
        image::imageops::resize(&src_img, pw, ph, image::imageops::FilterType::Triangle)
    } else {
        src_img
    };
    let raw = resized.into_raw();
    let mut out: Vec<u8> = Vec::with_capacity(8 + raw.len());
    out.extend_from_slice(&(pw as u32).to_le_bytes());
    out.extend_from_slice(&(ph as u32).to_le_bytes());
    out.extend_from_slice(&raw);
    Ok(tauri::ipc::Response::new(out))
}

/// 按「原生物理像素」选区从原生 RGBA 字节重裁，返回 PNG（保证最终输出清晰，而非降采样预览）。
// async：PNG 编码在主线程外执行，避免大图裁剪时卡 UI。
#[tauri::command]
pub async fn crop_native(
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
// async：原生 RGBA 重裁在主线程外执行，避免整屏裁剪（33MP）时卡 UI。
#[tauri::command]
pub async fn crop_native_rgba(
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

/// Win32 剪贴板写入位图（CF_DIB）。
///
/// 替代 `arboard`：`arboard::Clipboard::new()` 内部调用 `OleInitialize(NULL)` 需要 STA，
/// 即便 spawn 新线程也可能因进程级 COM 状态冲突而静默失败。
/// Win32 API（`OpenClipboard` + `SetClipboardData`）不依赖 COM/OLE，任何线程均可调用，是最可靠的路径。
///
/// 双格式写入（解决 Ctrl+V 粘贴失败问题）：
/// - CF_DIB：传统 Win32 应用（画图、Office 等）
/// - PNG（RegisterClipboardFormat("PNG")）：现代应用（浏览器、微信、QQ、Electron、Tiptap 等）
///   许多现代应用仅识别 PNG 格式，不识别 CF_DIB，导致 Ctrl+V 粘贴失败。
///
/// 数据格式（CF_DIB）：`BITMAPINFOHEADER` + BGRA 像素（bottom-up，正高度）。
/// 输入 `raw` 为 RGBA top-down，需逐行翻转并转 BGRA。
///
/// 剪贴板写入：`CF_DIB`（32bit BGRA bottom-up）+ `PNG` 双格式。
///
/// **持久化修复（根治「写入成功却粘贴为空」）**：裸 Win32 `SetClipboardData` 写入的数据，
/// 所有权绑定到 `OpenClipboard` 时传入的窗口；截图覆盖窗（WebView2）关闭 / 失焦时，
/// Chromium 的 OLE 剪贴板控制器会清空系统剪贴板，导致「写入返回成功、但用户切到微信粘贴时
/// 数据已空」。故改用 OLE `IDataObject` + `OleSetClipboard` + `OleFlushClipboard`：
/// `OleFlushClipboard` 把数据固化进系统剪贴板，与窗口生命周期彻底解耦，关闭 / 失焦后仍可粘贴。
/// 若 OLE 路径异常，回退到经典 Win32 `SetClipboardData`（至少保证「写入成功」）。
fn write_clipboard_with_formats(
    raw: &[u8],
    w: u32,
    h: u32,
    png: &[u8],
) -> Result<(), String> {
    if w == 0 || h == 0 {
        return Err("无效图像尺寸".into());
    }

    // 复制为 owned 数据交给独立线程：Vec<u8> 满足 Send；HWND 转 usize 规避 !Send。
    // 用独立 std 线程（非 tokio worker）执行，彻底避开 tokio MTA 线程与进程级 COM 状态冲突。
    let raw_v = raw.to_vec();
    let png_v = png.to_vec();
    let ww = w as usize;
    let hh = h as usize;

    let handle = std::thread::spawn(move || -> Result<(), String> {
        let png_format = unsafe {
            winapi::um::winuser::RegisterClipboardFormatA(b"PNG\0".as_ptr() as *const i8)
        };

        // 主路径：**单次** OpenClipboard 会话内 EmptyClipboard → SetClipboardData(CF_DIB) +
        // SetClipboardData("PNG")。关键点：
        // - NULL 所有者：数据归系统所有，与本进程任意 WebView2 窗口解耦，覆盖窗关闭/失焦后仍可粘贴
        //   （根治「写入成功却粘贴为空」——旧路径把剪贴板挂到主窗 HWND，Chromium 失焦即清空）。
        // - 同一会话：EmptyClipboard 使本次调用成为剪贴板所有者，两个 SetClipboardData 才会成功
        //   （旧实现 arboard 写完即关闭会话，再新开会话 append PNG 时并非所有者 → PNG 静默失败）。
        // - 仅写 CF_DIB（32bit BGRA，alpha 置 255）：Windows 会从 CF_DIB **自动合成** CF_BITMAP /
        //   CF_DIBV5 / CF_PALETTE，传统应用（画图/Office）与现代应用（微信/QQ/浏览器，识别 "PNG"）
        //   均可粘贴；且避开 arboard 写 CF_DIBV5 的预乘 alpha 被部分应用渲染成黑图的问题。
        let win32_ok = unsafe {
            match build_dib_and_png(&raw_v, w, h, &png_v) {
                Ok((h_dib, h_png)) => match write_clipboard_win32_fallback(h_dib, h_png, png_format)
                {
                    Ok(()) => true,
                    Err(e) => {
                        eprintln!("[剪贴板写入] Win32 写入失败，转 arboard 兜底: {}", e);
                        false
                    }
                },
                Err(e) => {
                    eprintln!("[剪贴板写入] 构建 DIB/PNG 失败，转 arboard 兜底: {}", e);
                    false
                }
            }
        };

        // 兜底：Win32 路径异常时用 arboard 写入位图（CF_DIB + CF_DIBV5），至少保证有位图可粘贴。
        if !win32_ok {
            match arboard::Clipboard::new() {
                Ok(mut cb) => {
                    let img = arboard::ImageData {
                        width: ww,
                        height: hh,
                        bytes: std::borrow::Cow::Borrowed(&raw_v),
                    };
                    cb.set_image(img)
                        .map_err(|e| format!("arboard 兜底写入失败: {}", e))?;
                }
                Err(e) => return Err(format!("arboard 初始化失败: {}", e)),
            }
        }

        // 读回校验：确认剪贴板确有位图或 PNG，杜绝「返回成功却为空」。
        unsafe {
            let ok = winapi::um::winuser::IsClipboardFormatAvailable(winapi::um::winuser::CF_DIB)
                != 0
                || (png_format != 0
                    && winapi::um::winuser::IsClipboardFormatAvailable(png_format) != 0);
            if ok {
                Ok(())
            } else {
                Err("剪贴板读回校验失败（内容为空）".into())
            }
        }
    });

    handle
        .join()
        .map_err(|_| "剪贴板写入线程异常".to_string())?
}

/// 构建 CF_DIB（32bit BGRA bottom-up）与 PNG 两个 HGLOBAL，供单会话 Win32 剪贴板写入。
unsafe fn build_dib_and_png(
    raw: &[u8],
    w: u32,
    h: u32,
    png: &[u8],
) -> Result<
    (
        winapi::shared::minwindef::HGLOBAL,
        winapi::shared::minwindef::HGLOBAL,
    ),
    String,
> {
    let row_bytes = (w as usize) * 4;
    let pixel_bytes = (w as usize) * (h as usize) * 4;
    let header_size = std::mem::size_of::<winapi::um::wingdi::BITMAPINFOHEADER>();
    let dib_total = header_size + pixel_bytes;

    let h_dib = winapi::um::winbase::GlobalAlloc(winapi::um::winbase::GMEM_MOVEABLE, dib_total);
    if h_dib.is_null() {
        return Err("GlobalAlloc (DIB) 失败".into());
    }
    let ptr = winapi::um::winbase::GlobalLock(h_dib);
    if ptr.is_null() {
        winapi::um::winbase::GlobalFree(h_dib);
        return Err("GlobalLock (DIB) 失败".into());
    }
    let hdr = ptr as *mut winapi::um::wingdi::BITMAPINFOHEADER;
    (*hdr).biSize = header_size as u32;
    (*hdr).biWidth = w as i32;
    (*hdr).biHeight = h as i32;
    (*hdr).biPlanes = 1;
    (*hdr).biBitCount = 32;
    (*hdr).biCompression = winapi::um::wingdi::BI_RGB;
    (*hdr).biSizeImage = pixel_bytes as u32;
    (*hdr).biXPelsPerMeter = 0;
    (*hdr).biYPelsPerMeter = 0;
    (*hdr).biClrUsed = 0;
    (*hdr).biClrImportant = 0;
    let px = (ptr as *mut u8).add(header_size);
    let dst = std::slice::from_raw_parts_mut(px, pixel_bytes);
    for y in 0..(h as usize) {
        let src_off = y * row_bytes;
        let dst_off = (h as usize - 1 - y) * row_bytes;
        let src_row = &raw[src_off..src_off + row_bytes];
        let dst_row = &mut dst[dst_off..dst_off + row_bytes];
        for x in 0..(w as usize) {
            let si = x * 4;
            dst_row[si] = src_row[si + 2];
            dst_row[si + 1] = src_row[si + 1];
            dst_row[si + 2] = src_row[si];
            dst_row[si + 3] = 255;
        }
    }
    winapi::um::winbase::GlobalUnlock(h_dib);

    let h_png = winapi::um::winbase::GlobalAlloc(winapi::um::winbase::GMEM_MOVEABLE, png.len());
    if h_png.is_null() {
        winapi::um::winbase::GlobalFree(h_dib);
        return Err("GlobalAlloc (PNG) 失败".into());
    }
    let pptr = winapi::um::winbase::GlobalLock(h_png);
    if pptr.is_null() {
        winapi::um::winbase::GlobalFree(h_dib);
        winapi::um::winbase::GlobalFree(h_png);
        return Err("GlobalLock (PNG) 失败".into());
    }
    std::ptr::copy_nonoverlapping(png.as_ptr(), pptr as *mut u8, png.len());
    winapi::um::winbase::GlobalUnlock(h_png);

    Ok((h_dib, h_png))
}

/// OLE 失败时的经典 Win32 兜底：直接用 `SetClipboardData` 写入（至少保证「写入成功」）。
/// 调用前 OLE 未接管 `h_dib`/`h_png`，故所有权可安全转移给系统；失败则自行释放。
unsafe fn write_clipboard_win32_fallback(
    h_dib: winapi::shared::minwindef::HGLOBAL,
    h_png: winapi::shared::minwindef::HGLOBAL,
    png_format: u32,
) -> Result<(), String> {
    let mut opened = false;
    for _attempt in 0..10u32 {
        // NULL 所有者：数据归系统所有，避免 WebView2 失焦时清空剪贴板。
        let h = std::ptr::null_mut();
        if winapi::um::winuser::OpenClipboard(h) != 0 {
            opened = true;
            eprintln!("[剪贴板写入] OpenClipboard 成功（兜底, owner=null）");
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    if !opened {
        winapi::um::winbase::GlobalFree(h_dib);
        winapi::um::winbase::GlobalFree(h_png);
        return Err("OpenClipboard 失败（重试 10 次仍被占用）".into());
    }
    winapi::um::winuser::EmptyClipboard();
    let r_dib = winapi::um::winuser::SetClipboardData(winapi::um::winuser::CF_DIB, h_dib as *mut _);
    eprintln!("[剪贴板写入] SetClipboardData(CF_DIB) = {}", if r_dib.is_null() { "失败" } else { "成功" });
    let r_png = if png_format != 0 {
        let r = winapi::um::winuser::SetClipboardData(png_format, h_png as *mut _);
        eprintln!("[剪贴板写入] SetClipboardData(PNG) = {}", if r.is_null() { "失败" } else { "成功" });
        r
    } else {
        std::ptr::null_mut()
    };
    winapi::um::winuser::CloseClipboard();
    if r_dib.is_null() {
        winapi::um::winbase::GlobalFree(h_dib);
    }
    if r_png.is_null() {
        winapi::um::winbase::GlobalFree(h_png);
    }
    if r_dib.is_null() && r_png.is_null() {
        return Err("SetClipboardData 失败（DIB 和 PNG 均失败）".into());
    }
    Ok(())
}

/// 一键保存：把合成好的图像「写入剪贴板 + 存入中转站」，返回 `localimg://` 引用。
///
/// 极致优化（对比旧实现）：
/// - 剪贴板改用 Win32 API（`OpenClipboard` + `SetClipboardData`），不依赖 COM/OLE，
///   彻底解决 arboard 在 tokio MTA 线程下 `OleInitialize` 失败导致剪贴板静默不写入的问题；
/// - 不再写临时文件 + `std::fs::copy` + `archive_snapshot`（旧流程 3 次磁盘写入），
///   改为直接写入 dropzone 目录（1 次磁盘写入）；
/// - 截图无需 `archive_snapshot` 备份（截图是新增文件，不存在「旧版本需要存档」的语义）；
/// - 保存后 emit `dropzone-changed` 事件，前端立即刷新中转站列表。
fn write_clipboard_and_dropzone(
    app: tauri::AppHandle,
    rgba: RgbaImage,
    name: String,
) -> Result<String, String> {
    let (w, h) = rgba.dimensions();
    eprintln!("[截图保存] write_clipboard_and_dropzone: {}x{}, name={}", w, h, name);
    let raw = rgba.into_raw();

    // 1) 快速 PNG 编码（zlib level 1，全屏 33MP ~0.3s）
    let png = encode_png_fast(&raw, w, h)?;
    eprintln!("[截图保存] PNG 编码完成: {} 字节", png.len());

    // 2) 剪贴板写入（CF_DIB + PNG 双格式，兼容传统应用和现代应用）
    //    **关键修复（截图「保存」被拖垮）**：剪贴板写入是「尽力而为」的便利功能，
    //    绝不能因为某次 OpenClipboard 被占用 / owner 跨线程不被接受就整段 return Err，
    //    否则 save_cropped/save_screenshot/save_annotated 全部失败 → 用户「截图都截不了」。
    //    因此这里把写入失败降级为警告：仍继续写中转站、仍返回 localimg:// 引用。
    match write_clipboard_with_formats(&raw, w, h, &png) {
        Ok(()) => eprintln!("[截图保存] ✓ 剪贴板写入成功"),
        Err(e) => eprintln!(
            "[截图保存] ⚠ 剪贴板写入失败（不影响保存到中转站）: {}",
            e
        ),
    }

    // 3) 直接写入 dropzone 目录（跳过临时文件 + copy + archive_snapshot）
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dropzone_dir = app_data.join("transfer_station").join("dropzone");
    std::fs::create_dir_all(&dropzone_dir).map_err(|e| format!("创建目录失败: {}", e))?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = dropzone_dir.join(format!("{}_{}", timestamp, name));
    std::fs::write(&dest, &png).map_err(|e| format!("写入 dropzone 失败: {}", e))?;

    // 4) 通知前端刷新中转站列表（Tauri 事件，前端 TransferStationPanel 监听后自动 reload）
    let _ = app.emit("dropzone-changed", ());

    Ok(format!(
        "localimg://{}",
        crate::services::document_parser::js_encode_uri_component(&dest.to_string_lossy())
    ))
}

/// 快速 PNG 编码：使用 `CompressionType::Fast`（zlib level 1）替代 `image` 默认 level 6，
/// 全屏大图编码耗时下降约 5×，文件体积仅略增；适合「截图实时保存」这种对延迟极敏感的场景。
/// 直接对 RGBA 切片编码，无需先构造 `RgbaImage`，少一次整块拷贝。
fn encode_png_fast(raw: &[u8], w: u32, h: u32) -> Result<Vec<u8>, String> {
    let mut buf = Vec::with_capacity(raw.len() / 2 + 4096);
    {
        let encoder = PngEncoder::new_with_quality(
            &mut buf,
            CompressionType::Fast,
            FilterType::Sub,
        );
        encoder
            .write_image(raw, w, h, ExtendedColorType::Rgba8)
            .map_err(|e| format!("PNG 编码失败: {}", e))?;
    }
    Ok(buf)
}

/// 一键保存：把合成好的图像「写入剪贴板 + 存入中转站」，返回 `localimg://` 引用。
///
/// 性能（毫秒级保存的关键）：
/// - 前端直接传**原生 RGBA 字节**（来自 `crop_native_rgba` 或 canvas.getImageData），
///   不再走「前端 PNG 编码 → IPC base64 → Rust 再解码」这一最慢环节；
/// - `bytes` 为原生 RGBA 时直接用 `width/height` 构造图像，零解码；
///   仅当 `bytes` 以 PNG 魔数开头（长截图等旧路径）时才回退到解码，保证兼容。
///   注意：PNG 路径下传入的 `width` / `height` 参数被忽略（尺寸从 PNG 文件头解码），仅 RGBA 直传路径使用这两个参数。
// 注意：本命令为 `async fn`。保存是整个截图链路最重的环节（原生 RGBA → PNG 编码 +
// 33MB 剪贴板写入 + 落盘中转站）。改为 async 后运行在独立任务线程，主线程（UI）全程
// 不被阻塞，彻底消除「保存时卡挺长时间 → 界面（无响应）→ 弹出幽灵窗口」的问题。
#[tauri::command]
pub async fn save_screenshot(
    app: tauri::AppHandle,
    bytes: Vec<u8>,
    width: u32,
    height: u32,
    name: String,
) -> Result<String, String> {
    // 还原 RGBA 图像（原始像素直通，跳过 PNG 编解码）
    let rgba = if bytes.starts_with(b"\x89PNG") {
        // 兼容长截图：其 bytes 仍是 PNG
        image::load_from_memory(&bytes)
            .map_err(|e| format!("图片解码失败: {}", e))?
            .into_rgba8()
    } else {
        RgbaImage::from_raw(width, height, bytes)
            .ok_or_else(|| "图像尺寸与字节长度不匹配，保存失败".to_string())?
    };
    tauri::async_runtime::spawn_blocking(move || {
        write_clipboard_and_dropzone(app, rgba, name)
    })
    .await
    .map_err(|e| format!("保存任务失败: {}", e))?
}

/// 无标注普通截图快路径：直接从 SHOT 原生 RGBA 字节按选区裁剪，
/// 全程在 Rust 端完成（剪贴板 + 落盘中转站），前端只传一个极小矩形，
/// 彻底省去「整图 RGBA 经 IPC 传给前端、再由前端回传」这一最慢、最易卡死（无响应）的环节。
// 注意：本命令为 `async fn`，与 save_screenshot 同理——零传输快路径也在主线程外执行，
// 保存不再冻结 UI（微信式「截完即存」体验）。
/// 从 SHOT 原生 RGBA 按「原生物理像素」选区裁剪，返回 `RgbaImage`。
/// `save_cropped` 与 `save_annotated` 共用，避免裁剪逻辑重复。
fn crop_shot_rgba(x: i32, y: i32, w: i32, h: i32) -> Result<RgbaImage, String> {
    let slot = SHOT.lock().map_err(|e| format!("锁失败: {}", e))?;
    let shot = slot
        .as_ref()
        .ok_or_else(|| "尚无截屏数据，请先触发截图".to_string())?;
    let iw = shot.native_w as i32;
    let ih = shot.native_h as i32;
    // 选区物理坐标 → native 图像坐标（减去捕获原点），与 crop_native 同逻辑
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
    RgbaImage::from_raw(ww, hh, out).ok_or_else(|| "裁剪图像构造失败".to_string())
}

#[tauri::command]
pub async fn save_cropped(
    app: tauri::AppHandle,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    name: String,
) -> Result<String, String> {
    eprintln!("[截图保存] save_cropped: ({},{},{},{})", x, y, w, h);
    let img = crop_shot_rgba(x, y, w, h)?;
    // spawn_blocking: 确保剪贴板 Win32 API + 文件 I/O 在专用阻塞线程执行，
    // 不占用 tokio async 线程，也避免与剪贴板轮询器在同一线程池竞争
    tauri::async_runtime::spawn_blocking(move || {
        write_clipboard_and_dropzone(app, img, name)
    })
    .await
    .map_err(|e| format!("保存任务失败: {}", e))?
}

/// 标注截图「极致优化」路径：前端只回传**极小的标注层 PNG**（drawRef 画布，预览分辨率、
/// 透明区域经 PNG 压缩仅几 KB~几百 KB），Rust 端从 SHOT 原生字节裁出底图，再把标注层
/// 缩放贴合到原生分辨率后 alpha 合成，最后走与 save_cropped 相同的快速剪贴板 + 落盘。
///
/// 相比旧实现（前端 `getImageData` 整屏 132MB + IPC 回传 132MB RGBA）：
/// - 前端零大数组操作（`toBlob` 一个透明 PNG 远快于 `getImageData` 132MB）；
/// - IPC 仅传极小标注 PNG，无 132MB 像素回传；
/// - 底图始终取 SHOT 原生字节（清晰度无损），标注按 native/preview 比例缩放贴合。
/// 这是逼近微信「截完即存、几乎无感」体验的关键改动（允许动 Rust 后的核心优化）。
#[tauri::command]
pub async fn save_annotated(
    app: tauri::AppHandle,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    annotation_png: Vec<u8>,
    name: String,
) -> Result<String, String> {
    eprintln!("[截图保存] save_annotated: ({},{},{},{})", x, y, w, h);
    let mut base = crop_shot_rgba(x, y, w, h)?;
    let ann = image::load_from_memory(&annotation_png)
        .map_err(|e| format!("标注层解码失败: {}", e))?
        .into_rgba8();
    let (bw, bh) = base.dimensions();
    let (aw, ah) = ann.dimensions();
    // 标注层为预览分辨率，需缩放贴合到原生裁剪图尺寸（等价于前端 drawImage 的 sx/sy 放大）
    if aw != bw || ah != bh {
        let resized =
            image::imageops::resize(&ann, bw, bh, image::imageops::FilterType::Nearest);
        image::imageops::overlay(&mut base, &resized, 0, 0);
    } else {
        image::imageops::overlay(&mut base, &ann, 0, 0);
    }
    tauri::async_runtime::spawn_blocking(move || {
        write_clipboard_and_dropzone(app, base, name)
    })
    .await
    .map_err(|e| format!("保存任务失败: {}", e))?
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

        // 保存原光标位置 + 原前台窗口，将光标移到目标窗口中心（SendInput 滚轮相对于光标所在窗口）
        let mut saved_cursor: winapi::shared::windef::POINT = std::mem::zeroed();
        winapi::um::winuser::GetCursorPos(&mut saved_cursor);
        let saved_fg = winapi::um::winuser::GetForegroundWindow();
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
        // 恢复原光标位置 + 原前台窗口（避免长截图后用户焦点被意外切换）
        winapi::um::winuser::SetCursorPos(saved_cursor.x, saved_cursor.y);
        if !saved_fg.is_null() {
            let _ = winapi::um::winuser::SetForegroundWindow(saved_fg);
        }
        encode_png(full)
    }
}

/// 将 RgbaImage 编码为 PNG 字节（快速压缩，见 `encode_png_fast`）。
fn encode_png(img: RgbaImage) -> Result<Vec<u8>, String> {
    let (w, h) = img.dimensions();
    encode_png_fast(img.as_raw(), w, h)
}

// 旧命令保留（备用）：直接捕获整虚拟桌面为 PNG（未降采样）。
#[tauri::command]
pub fn capture_screen() -> Result<Vec<u8>, String> {
    // 注意：capture_region 的 (x,y) 是「相对虚拟桌面原点的偏移」，整桌面即传 (0,0)
    let x = 0;
    let y = 0;
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
///
/// 改用 Win32 API（`OpenClipboard` + `SetClipboardData`，CF_DIB + PNG 双格式），
/// 彻底解决 arboard 在 tokio MTA 线程下 `OleInitialize` 静默失败导致
/// Ctrl+V 粘贴截图无反应的问题。Win32 路径不依赖 COM/OLE，任何线程均可用。
#[tauri::command]
pub fn clipboard_write_image(_app: tauri::AppHandle, base64_png: String) -> Result<(), String> {
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
    let raw = rgba.into_raw();
    // 复用截图保存路径的 Win32 双格式写入（CF_DIB + PNG），数据归系统所有（NULL 所有者）
    write_clipboard_with_formats(&raw, w, h, &bytes)
}

/// 从文件路径读取图片并写入系统剪贴板（Win32 API，可靠）
/// 用于剪贴板历史浮窗：前端只存临时文件路径，复制时从此命令写入
#[tauri::command]
pub fn clipboard_write_image_from_path(_app: tauri::AppHandle, path: String) -> Result<(), String> {
    let bytes = std::fs::read(&path)
        .map_err(|e| format!("读取文件失败: {}", e))?;
    let img = image::load_from_memory(&bytes)
        .map_err(|e| format!("图片解码失败: {}", e))?;
    let rgba = img.into_rgba8();
    let (w, h) = rgba.dimensions();
    let raw = rgba.into_raw();
    // 复用截图保存路径的 Win32 双格式写入（CF_DIB + PNG），数据归系统所有（NULL 所有者）
    write_clipboard_with_formats(&raw, w, h, &bytes)
}

/// 「全面彻底」的剪贴板诊断 / 验证。两种用法：
///
/// 1) 算法自测（writeTest=true，默认）：写入一张 400x300 测试图，再跨进程验证，
///    用于确认「写入算法本身 + 不被本进程清空」。开发者可在 DevTools 调
///    `invoke('clipboard_diagnose')` 单独跑。
///
/// 2) 真实截图验证（writeTest=false，并传 expectW/expectH）：**不写入任何数据**，
///    只回读当前系统剪贴板里的图片，对比尺寸是否与本次截图一致。这样既能在截完即复制后
///    确认「真实截图真的存活在系统剪贴板」，又不会把用户的截图覆盖成测试图。
///
/// 两个维度：进程内回读（OpenClipboard + GetClipboardData）确认本进程写成功；
/// 跨进程回读（powershell Get-Clipboard -Format Image，模拟微信 Ctrl+V）确认数据在多窗口
/// 环境下存活（不被本进程 WebView2 / 焦点变化清空）。
///
/// 返回 JSON 报告。关键判断：若「进程内 OK 但跨进程空」→ 写入算法没问题，问题在
/// 「写入后被本进程 / WebView2 清空」；若跨进程尺寸与 expect 一致 → 真实截图已成功存活。
/// 跨进程读取剪贴板图片（模拟微信 Ctrl+V）：powershell Get-Clipboard -Format Image
fn cross_process_image() -> String {
    match std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "(Get-Clipboard -Format Image | ForEach-Object { \"$($_.Width)x$($_.Height)\" })",
        ])
        .output()
    {
        Ok(o) => {
            let out = String::from_utf8_lossy(&o.stdout).trim().to_string();
            let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
            if out.is_empty() {
                if err.is_empty() {
                    "空（无图片）".to_string()
                } else {
                    format!("空（stderr: {}）", err)
                }
            } else {
                format!("OK {}", out)
            }
        }
        Err(e) => format!("无法启动 powershell: {}", e),
    }
}

/// 当前剪贴板所有者 HWND + 窗口类 + 标题（NULL 表示归系统所有 / 无所有者）。
fn clipboard_owner_str() -> String {
    unsafe {
        let hwnd = winapi::um::winuser::GetClipboardOwner();
        if hwnd.is_null() {
            return "owner=NULL(归系统所有)".into();
        }
        let mut buf = [0u16; 256];
        let n = winapi::um::winuser::GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        let class = if n > 0 {
            String::from_utf16_lossy(&buf[..n as usize])
        } else {
            "?".into()
        };
        let mut tbuf = [0u16; 256];
        let tn = winapi::um::winuser::GetWindowTextW(hwnd, tbuf.as_mut_ptr(), tbuf.len() as i32);
        let title = if tn > 0 {
            String::from_utf16_lossy(&tbuf[..tn as usize])
        } else {
            "".into()
        };
        format!(
            "owner=0x{:X} class={} title={}",
            hwnd as usize, class, title
        )
    }
}

#[tauri::command]
pub fn clipboard_diagnose(
    _app: tauri::AppHandle,
    write_test: Option<bool>,
    expect_w: Option<u32>,
    expect_h: Option<u32>,
    series: Option<bool>,
) -> Result<serde_json::Value, String> {
    use image::{ImageBuffer, Rgba};

    let do_write = write_test.unwrap_or(true);

    // 生成测试图（仅自测模式写入）
    let (w, h, raw, png_buf): (u32, u32, Vec<u8>, Vec<u8>) = if do_write {
        let tw = 400u32;
        let th = 300u32;
        let mut img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::new(tw, th);
        for y in 0..th {
            for x in 0..tw {
                let r = ((x as f32 / tw as f32) * 255.0) as u8;
                let g = ((y as f32 / th as f32) * 255.0) as u8;
                img.put_pixel(x, y, Rgba([r, g, 128, 255]));
            }
        }
        let mut pb: Vec<u8> = Vec::new();
        {
            let mut cur = Cursor::new(&mut pb);
            img.write_to(&mut cur, ImageFormat::Png)
                .map_err(|e| format!("PNG 编码失败: {}", e))?;
        }
        let rw = img.into_raw();
        (tw, th, rw, pb)
    } else {
        // 验证模式：不生成测试图（避免覆盖真实截图）
        (0, 0, Vec::new(), Vec::new())
    };

    // 1) 自测模式才真正写入（与截图保存完全相同的路径）
    if do_write {
        write_clipboard_with_formats(&raw, w, h, &png_buf)?;
    }

    // 2) 进程内回读
    let in_proc = unsafe {
        let mut opened = false;
        for _ in 0..5u32 {
            if winapi::um::winuser::OpenClipboard(std::ptr::null_mut()) != 0 {
                opened = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        if !opened {
            "进程内回读：OpenClipboard 失败".to_string()
        } else {
            let mut s = String::new();
            if winapi::um::winuser::IsClipboardFormatAvailable(winapi::um::winuser::CF_DIB) != 0 {
                let hd = winapi::um::winuser::GetClipboardData(winapi::um::winuser::CF_DIB);
                if !hd.is_null() {
                    let p = winapi::um::winbase::GlobalLock(hd);
                    if !p.is_null() {
                        let hdr = p as *const winapi::um::wingdi::BITMAPINFOHEADER;
                        s.push_str(&format!(
                            "CF_DIB OK {}x{}; ",
                            (*hdr).biWidth, (*hdr).biHeight
                        ));
                        winapi::um::winbase::GlobalUnlock(hd);
                    } else {
                        s.push_str("CF_DIB GetData 锁失败; ");
                    }
                } else {
                    s.push_str("CF_DIB 无数据; ");
                }
            } else {
                s.push_str("无 CF_DIB; ");
            }
            let pf = winapi::um::winuser::RegisterClipboardFormatA(b"PNG\0".as_ptr() as *const i8);
            if pf != 0 && winapi::um::winuser::IsClipboardFormatAvailable(pf) != 0 {
                let hp = winapi::um::winuser::GetClipboardData(pf);
                if !hp.is_null() {
                    let p = winapi::um::winbase::GlobalLock(hp);
                    if !p.is_null() {
                        s.push_str(&format!("PNG OK {} 字节", winapi::um::winbase::GlobalSize(hp)));
                        winapi::um::winbase::GlobalUnlock(hp);
                    } else {
                        s.push_str("PNG 锁失败");
                    }
                } else {
                    s.push_str("PNG 无数据");
                }
            } else {
                s.push_str("无 PNG");
            }
            winapi::um::winuser::CloseClipboard();
            s
        }
    };

    // 3) 跨进程回读（模拟微信 Ctrl+V）+ 当前所有者
    std::thread::sleep(Duration::from_millis(200));
    let cross_proc = cross_process_image();
    let owner_now = clipboard_owner_str();

    // 验证模式 + 时间序列：在 T+0.2/1/3/10s 各回读一次，看数据何时、被谁清空。
    // （仅在不写测试图的验证模式下做，避免覆盖用户的真实截图）
    let series_out = if !do_write && series.unwrap_or(false) {
        let mut arr: Vec<serde_json::Value> = Vec::new();
        for (label, delay) in [
            ("T+0.2s", 0u64),
            ("T+1s", 800u64),
            ("T+3s", 2800u64),
            ("T+10s", 9800u64),
        ] {
            if delay > 0 {
                std::thread::sleep(Duration::from_millis(delay));
            }
            arr.push(json!({
                "t": label,
                "crossProcess": cross_process_image(),
                "owner": clipboard_owner_str(),
            }));
        }
        Some(arr)
    } else {
        None
    };

    // 验证模式：比对跨进程读回的尺寸与本次截图是否一致
    let matches = if !do_write {
        if let (Some(ew), Some(eh)) = (expect_w, expect_h) {
            let expected = format!("{}x{}", ew, eh);
            Some(cross_proc.contains(&expected))
        } else {
            None
        }
    } else {
        None
    };

    let verdict = if do_write {
        if cross_proc.contains("OK") {
            "算法正确且跨进程存活：写入本身没问题，若真实粘贴仍为空，请检查粘贴目标（微信需先点一下窗口）或粘贴时机"
        } else {
            "跨进程为空：写入后数据被本进程/WebView2 清空 —— 需改用主窗 JS Clipboard API 写入"
        }
    } else if let Some(m) = matches {
        if m {
            "✓ 真实截图已成功存活在系统剪贴板（跨进程尺寸一致），可直接 Ctrl+V 粘贴"
        } else if cross_proc.contains("OK") {
            "跨进程有图但尺寸与本次截图不一致（可能被其它来源覆盖），请检查写入时机"
        } else {
            "✗ 跨进程为空：真实截图写入后被清空 —— 看 series 各时间点 owner 变化判断是谁清空"
        }
    } else {
        "验证模式：未提供期望尺寸，仅回读"
    };

    Ok(json!({
        "written": do_write,
        "inProcess": in_proc,
        "crossProcess": cross_proc,
        "ownerNow": owner_now,
        "series": series_out,
        "matches": matches,
        "verdict": verdict,
    }))
}


// ============ 剪贴板图片高效轮询（Win32 API，不依赖 OLE，任何线程可用）============
//
// 问题：pro-tools-kit 中的 clipboard_poll_image 使用 arboard，而 arboard::Clipboard::new()
// 调用 OleInitialize(None)，在 tokio spawn_blocking 的 MTA 线程上返回 RPC_E_CHANGED_MODE。
// 且原实现是同步 #[tauri::command]，在主线程执行 PNG 编码 + 缩略图生成，大图阻塞 1.5-3s。
//
// 方案：在主 crate（已有 winapi 依赖）中用 Win32 API 读取剪贴板，改为 async + spawn_blocking。
// Win32 API（OpenClipboard + GetClipboardData）不依赖 COM/OLE，任何线程均可用。

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardPollResult {
    hash: String,
    temp_path: String,
    thumbnail: String,
}

/// 快速计算图片 hash：尺寸 + 首尾采样像素
fn clip_fast_image_hash(bytes: &[u8], w: u32, h: u32) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    w.hash(&mut hasher);
    h.hash(&mut hasher);
    let len = bytes.len();
    let mid = len / 2;
    let head = &bytes[..len.min(256)];
    let middle = &bytes[mid..len.min(mid + 256)];
    let tail = &bytes[len.saturating_sub(256)..];
    head.hash(&mut hasher);
    middle.hash(&mut hasher);
    tail.hash(&mut hasher);
    hasher.finish()
}

/// 将 RGBA 图片保存到临时文件（PNG 格式）
fn clip_save_image_to_temp(bytes: &[u8], w: u32, h: u32) -> Result<String, String> {
    let mut buf = Vec::with_capacity(bytes.len() / 2 + 4096);
    let encoder = PngEncoder::new(&mut buf);
    encoder
        .write_image(bytes, w, h, ExtendedColorType::Rgba8)
        .map_err(|e| format!("PNG 编码失败: {}", e))?;

    let temp_dir = std::env::temp_dir();
    let file_name = format!("andeng_clip_{}.png", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0));
    let path = temp_dir.join(&file_name);
    use std::io::Write;
    let mut file = std::fs::File::create(&path)
        .map_err(|e| format!("创建临时文件失败: {}", e))?;
    file.write_all(&buf)
        .map_err(|e| format!("写入临时文件失败: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

/// 生成缩略图 data URL（JPEG 70%，最大 120px）
fn clip_generate_thumbnail(bytes: &[u8], w: u32, h: u32, max_size: u32) -> Result<String, String> {
    let img = RgbaImage::from_raw(w, h, bytes.to_vec())
        .ok_or("图片数据无效")?;
    let dyn_img = DynamicImage::ImageRgba8(img);
    let scale = (max_size as f32 / w.max(h) as f32).min(1.0);
    let tw = (w as f32 * scale).round() as u32;
    let th = (h as f32 * scale).round() as u32;
    let thumbnail = dyn_img.resize(tw, th, image::imageops::FilterType::Nearest);
    let thumb_rgba = thumbnail.to_rgba8();
    let (tw2, th2) = thumb_rgba.dimensions();
    let mut buf = Vec::with_capacity(8192);
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 70);
    encoder
        .write_image(&thumb_rgba.into_raw(), tw2, th2, ExtendedColorType::Rgba8)
        .map_err(|e| format!("JPEG 编码失败: {}", e))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
    Ok(format!("data:image/jpeg;base64,{}", b64))
}

/// 读取剪贴板图片（Win32 API，不依赖 OLE）
/// 优先读取 PNG 格式（截图功能写入的原始数据），回退到 CF_DIB
/// 返回 (rgba_bytes, width, height)；无图片返回 None
fn read_clipboard_image_win32() -> Result<Option<(Vec<u8>, u32, u32)>, String> {
    unsafe {
        // 打开剪贴板（带重试：其他应用可能正占用剪贴板）
        let mut opened = false;
        for _ in 0..5u32 {
            if winapi::um::winuser::OpenClipboard(std::ptr::null_mut()) != 0 {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        if !opened {
            return Err("OpenClipboard 失败（重试 5 次仍被占用）".into());
        }

        let result: Option<(Vec<u8>, u32, u32)>;

        // 1) 优先读取 PNG 格式（截图功能写入的原始 PNG 数据）
        let png_format = winapi::um::winuser::RegisterClipboardFormatA(b"PNG\0".as_ptr() as *const i8);
        if png_format != 0 {
            let h_png = winapi::um::winuser::GetClipboardData(png_format);
            if !h_png.is_null() {
                let ptr = winapi::um::winbase::GlobalLock(h_png);
                if !ptr.is_null() {
                    let size = winapi::um::winbase::GlobalSize(h_png);
                    let png_bytes = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
                    winapi::um::winbase::GlobalUnlock(h_png);
                    // 解码 PNG → RGBA
                    if let Ok(img) = image::load_from_memory(&png_bytes) {
                        let rgba = img.into_rgba8();
                        let (w, h) = rgba.dimensions();
                        result = Some((rgba.into_raw(), w, h));
                    } else {
                        result = None;
                    }
                } else {
                    result = None;
                }
            } else {
                result = None;
            }
        } else {
            result = None;
        }

        // 2) 回退到 CF_DIB（传统 Win32 应用写入的 DIB 数据）
        let result = if result.is_some() {
            result
        } else {
            let h_dib = winapi::um::winuser::GetClipboardData(winapi::um::winuser::CF_DIB);
            if !h_dib.is_null() {
                let ptr = winapi::um::winbase::GlobalLock(h_dib);
                if !ptr.is_null() {
                    let size = winapi::um::winbase::GlobalSize(h_dib);
                    let dib_bytes = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
                    winapi::um::winbase::GlobalUnlock(h_dib);
                    parse_cf_dib_to_rgba(&dib_bytes)
                } else {
                    None
                }
            } else {
                None
            }
        };

        winapi::um::winuser::CloseClipboard();
        Ok(result)
    }
}

/// 解析 CF_DIB 数据（BITMAPINFOHEADER + BGRA bottom-up）为 RGBA top-down
fn parse_cf_dib_to_rgba(dib: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let header_size = std::mem::size_of::<winapi::um::wingdi::BITMAPINFOHEADER>();
    if dib.len() < header_size {
        return None;
    }
    let hdr = unsafe { &*(dib.as_ptr() as *const winapi::um::wingdi::BITMAPINFOHEADER) };
    let w = hdr.biWidth as u32;
    let h = (hdr.biHeight).unsigned_abs();
    let bit_count = hdr.biBitCount;
    let compression = hdr.biCompression;

    // 仅支持 32 位未压缩 DIB（BGRA）
    if bit_count != 32 || compression != winapi::um::wingdi::BI_RGB {
        return None;
    }
    if w == 0 || h == 0 {
        return None;
    }

    let row_bytes = (w * 4) as usize;
    let pixel_offset = header_size;
    let pixel_size = row_bytes * h as usize;

    if dib.len() < pixel_offset + pixel_size {
        return None;
    }

    // BGRA bottom-up → RGBA top-down（行翻转 + 通道交换）
    let mut rgba = vec![0u8; pixel_size];
    let is_bottom_up = hdr.biHeight > 0;
    for y in 0..(h as usize) {
        let src_y = if is_bottom_up { h as usize - 1 - y } else { y };
        let src_off = pixel_offset + src_y * row_bytes;
        let dst_off = y * row_bytes;
        for x in 0..(w as usize) {
            let si = x * 4;
            rgba[dst_off + si] = dib[src_off + si + 2];     // R <- B
            rgba[dst_off + si + 1] = dib[src_off + si + 1]; // G
            rgba[dst_off + si + 2] = dib[src_off + si];     // B <- R
            rgba[dst_off + si + 3] = 255;                    // A（DIB 无 alpha，强制 255）
        }
    }
    Some((rgba, w, h))
}

/// 高效剪贴板图片轮询（Win32 API + spawn_blocking）
///
/// - Win32 API 读取剪贴板（CF_DIB / PNG），不依赖 OLE，任何线程可用
/// - spawn_blocking 在线程池执行，不阻塞主线程
/// - hash 检测变化：前端传入上次已知的 hash（lastHash），仅当 hash 不同时才处理并返回
///   这样多个视图（浮窗 + 主面板）可独立轮询，互不干扰，无全局状态竞争
#[tauri::command]
pub async fn clipboard_poll_image(last_hash: Option<String>) -> Result<Option<ClipboardPollResult>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<ClipboardPollResult>, String> {
        let img_data = read_clipboard_image_win32()?;
        match img_data {
            Some((rgba, w, h)) => {
                let hash = clip_fast_image_hash(&rgba, w, h);
                let hash_str = format!("{:016x}", hash);
                // 前端传入的 hash 与当前一致 → 图片未变化，跳过
                if last_hash.as_deref() == Some(&hash_str) {
                    return Ok(None);
                }
                // 图片变化：保存到临时文件 + 生成缩略图
                let temp_path = clip_save_image_to_temp(&rgba, w, h)?;
                let thumbnail = clip_generate_thumbnail(&rgba, w, h, 120)?;
                eprintln!("[剪贴板轮询] 检测到新图片: {}x{}, hash={}", w, h, hash_str);
                Ok(Some(ClipboardPollResult {
                    hash: hash_str,
                    temp_path,
                    thumbnail,
                }))
            }
            None => Ok(None), // 剪贴板无图片
        }
    })
    .await
    .map_err(|e| format!("剪贴板轮询任务失败: {}", e))?
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
pub fn parse_shortcut(s: &str) -> Result<Shortcut, String> {
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

// ============ 剪贴板浮窗热键（设置面板可改写并持久化）============
pub const DEFAULT_CLIPBOARD_SHORTCUT: &str = "Ctrl+Alt+C";

pub static CLIPBOARD_SHORTCUT_STR: OnceLock<Mutex<String>> = OnceLock::new();
pub fn clipboard_shortcut_state() -> &'static Mutex<String> {
    CLIPBOARD_SHORTCUT_STR.get_or_init(|| Mutex::new(DEFAULT_CLIPBOARD_SHORTCUT.to_string()))
}

fn clipboard_shortcut_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("clipboard_shortcut.json"))
}

pub fn read_clipboard_shortcut(app: &tauri::AppHandle) -> String {
    if let Some(p) = clipboard_shortcut_path(app) {
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
    DEFAULT_CLIPBOARD_SHORTCUT.to_string()
}

fn write_clipboard_shortcut(app: &tauri::AppHandle, sc: &str) -> Result<(), String> {
    let p = clipboard_shortcut_path(app).ok_or_else(|| "无法获取 app_data 目录".to_string())?;
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&p, serde_json::json!({ "shortcut": sc }).to_string())
        .map_err(|e| e.to_string())
}

pub fn register_clipboard_shortcut(app: &tauri::AppHandle, sc: &str) -> Result<(), String> {
    let shortcut = parse_shortcut(sc)?;
    app.global_shortcut()
        .register(shortcut)
        .map_err(|e| format!("注册剪贴板热键失败: {}", e))
}

#[tauri::command]
pub fn get_clipboard_shortcut(app: tauri::AppHandle) -> String {
    let sc = read_clipboard_shortcut(&app);
    if let Ok(mut state) = clipboard_shortcut_state().lock() {
        *state = sc.clone();
    }
    sc
}

#[tauri::command]
pub fn set_clipboard_shortcut(app: tauri::AppHandle, shortcut: String) -> Result<(), String> {
    let new = parse_shortcut(&shortcut)?;
    let old = clipboard_shortcut_state()
        .lock()
        .map(|s| s.clone())
        .unwrap_or_else(|_| DEFAULT_CLIPBOARD_SHORTCUT.to_string());
    if let Ok(old_sc) = parse_shortcut(&old) {
        let _ = app.global_shortcut().unregister(old_sc);
    }
    app.global_shortcut().register(new).map_err(|e| {
        if let Ok(old_sc) = parse_shortcut(&old) {
            let _ = app.global_shortcut().register(old_sc);
        }
        format!("注册失败（已回退原热键）: {}", e)
    })?;
    write_clipboard_shortcut(&app, &shortcut)?;
    if let Ok(mut state) = clipboard_shortcut_state().lock() {
        *state = shortcut;
    }
    Ok(())
}

// ============ 中转站浮窗热键（设置面板可改写并持久化）============
pub const DEFAULT_DROPZONE_SHORTCUT: &str = "Ctrl+Alt+V";

pub static DROPZONE_SHORTCUT_STR: OnceLock<Mutex<String>> = OnceLock::new();
pub fn dropzone_shortcut_state() -> &'static Mutex<String> {
    DROPZONE_SHORTCUT_STR.get_or_init(|| Mutex::new(DEFAULT_DROPZONE_SHORTCUT.to_string()))
}

fn dropzone_shortcut_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("dropzone_shortcut.json"))
}

pub fn read_dropzone_shortcut(app: &tauri::AppHandle) -> String {
    if let Some(p) = dropzone_shortcut_path(app) {
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
    DEFAULT_DROPZONE_SHORTCUT.to_string()
}

fn write_dropzone_shortcut(app: &tauri::AppHandle, sc: &str) -> Result<(), String> {
    let p = dropzone_shortcut_path(app).ok_or_else(|| "无法获取 app_data 目录".to_string())?;
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&p, serde_json::json!({ "shortcut": sc }).to_string())
        .map_err(|e| e.to_string())
}

pub fn register_dropzone_shortcut(app: &tauri::AppHandle, sc: &str) -> Result<(), String> {
    let shortcut = parse_shortcut(sc)?;
    app.global_shortcut()
        .register(shortcut)
        .map_err(|e| format!("注册中转站热键失败: {}", e))
}

#[tauri::command]
pub fn get_dropzone_shortcut(app: tauri::AppHandle) -> String {
    let sc = read_dropzone_shortcut(&app);
    if let Ok(mut state) = dropzone_shortcut_state().lock() {
        *state = sc.clone();
    }
    sc
}

#[tauri::command]
pub fn set_dropzone_shortcut(app: tauri::AppHandle, shortcut: String) -> Result<(), String> {
    let new = parse_shortcut(&shortcut)?;
    let old = dropzone_shortcut_state()
        .lock()
        .map(|s| s.clone())
        .unwrap_or_else(|_| DEFAULT_DROPZONE_SHORTCUT.to_string());
    if let Ok(old_sc) = parse_shortcut(&old) {
        let _ = app.global_shortcut().unregister(old_sc);
    }
    app.global_shortcut().register(new).map_err(|e| {
        if let Ok(old_sc) = parse_shortcut(&old) {
            let _ = app.global_shortcut().register(old_sc);
        }
        format!("注册失败（已回退原热键）: {}", e)
    })?;
    write_dropzone_shortcut(&app, &shortcut)?;
    if let Ok(mut state) = dropzone_shortcut_state().lock() {
        *state = shortcut;
    }
    Ok(())
}
