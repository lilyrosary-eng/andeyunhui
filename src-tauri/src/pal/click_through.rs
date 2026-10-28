//! 整窗"点击穿透"（Linux 专用）。
//!
//! # 为什么不能用 tao 的那条
//! `set_ignore_cursor_events(true)` → tao 在 GTK 上走
//! `gtk::Window::input_shape_combine_region(1×1 区域)`（`tao-0.35.3/src/platform_impl/
//! linux/event_loop.rs:452`）。实测在 Wayland 会话下**不生效**：窗口照样吞掉鼠标事件，
//! 只是前端 JS 不再响应 ⇒ "点它没反应，被它遮住的东西也点不到"（2026-10-24 用户实测）。
//!
//! # 正确做法
//! GTK3 为这件事有专门 API：`gdk_window_set_pass_through(win, TRUE)`
//! （Wayland 后端 `gdk_display_supports_input_shapes()` 返回 true，实测已确认）。
//!
//! # 为什么要"持续维持"而不是设一次
//! WebKit 的渲染用的是**子 GdkWindow**，它们在 resize / 页面重绘 / 视频起播时会被销毁重建；
//! 新建出来的子窗口默认**不穿透**，于是"设了穿透，过一会儿又开始吃点击"
//! （2026-10-27 用户实测：浮岛透明区、桌宠、歌词都有这个现象）。
//! ⇒ 这里保存"期望状态"，并按秒级重放，重建出来的子窗口会被重新压平。
//! 用户明确表示：桌宠/歌词的开关都在主窗里，这两个窗口**整窗无视鼠标**即可，所以可以放心重放。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Manager};

#[cfg(target_os = "linux")]
fn apply_recursive(win: &gdk::Window, ignore: bool) {
    win.set_pass_through(ignore);
    for child in win.children() {
        apply_recursive(&child, ignore);
    }
}

/// label → 期望的穿透状态。只有 true 的会被周期性重放。
fn desired() -> &'static Mutex<HashMap<String, bool>> {
    static D: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    D.get_or_init(|| Mutex::new(HashMap::new()))
}

fn enforcer_started() -> &'static Mutex<bool> {
    static S: OnceLock<Mutex<bool>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(false))
}

/// 在主线程上对某个窗口立即应用一次穿透。
#[cfg(target_os = "linux")]
fn apply_now(app: &AppHandle, label: &str, ignore: bool) {
    use gtk::prelude::*;

    let Some(win) = app.get_webview_window(label) else {
        return;
    };
    let Ok(gtk_win) = win.gtk_window() else { return };
    let Some(gdk_win) = gtk_win.window() else { return };
    if !gdk_win.display().supports_input_shapes() {
        return;
    }
    apply_recursive(&gdk_win, ignore);
}

/// 每秒重放一次所有"期望穿透"的窗口（子 GdkWindow 重建后会被重新压平）。
fn ensure_enforcer(app: &AppHandle) {
    let mut started = match enforcer_started().lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if *started {
        return;
    }
    *started = true;
    drop(started);

    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(1000));
        let labels: Vec<String> = match desired().lock() {
            Ok(m) => m.iter().filter(|(_, v)| **v).map(|(k, _)| k.clone()).collect(),
            Err(_) => continue,
        };
        if labels.is_empty() {
            continue;
        }
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            for l in labels {
                apply_now(&app2, &l, true);
            }
        });
    });
}

/// 给指定 label 的浮窗设置/取消整窗穿透。返回 Err 时调用方可回退到 tao 的旧接口。
pub fn apply(app: &AppHandle, label: &str, ignore: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        if let Ok(mut m) = desired().lock() {
            m.insert(label.to_string(), ignore);
        }
        // 立即在主线程应用一次（GDK 调用必须在主线程），然后交给重放线程维持。
        let app2 = app.clone();
        let label2 = label.to_string();
        let _ = app.run_on_main_thread(move || {
            apply_now(&app2, &label2, ignore);
            eprintln!("[click-through] {label2} pass_through={ignore}（持续维持）");
        });
        if ignore {
            ensure_enforcer(app);
        }
        return Ok(());
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, label, ignore);
        Err("仅 Linux 需要该路径".to_string())
    }
}

/// 关闭时清理（窗口销毁前调用，避免重放线程继续找已销毁的窗口）。
pub fn forget(label: &str) {
    if let Ok(mut m) = desired().lock() {
        m.remove(label);
    }
}

/// 把窗口的**输入区域**限制成给定矩形（逻辑像素，窗口坐标）。
/// `w <= 0 || h <= 0` 表示恢复整窗可交互。
///
/// 为什么需要它：浮岛窗在 Wayland 上不总是能缩到胶囊大小（实测稳定停在 460×200），
/// 而整窗穿透又会把胶囊本身也变成点不到。于是"透明边距挡点击"只有一个解：
/// 让**输入区域**等于可见胶囊的矩形，矩形外一律不吃事件。
/// 矩形由前端用 `getBoundingClientRect()` 实测传入，不靠任何尺寸假设。
#[cfg(target_os = "linux")]
fn apply_input_rect(win: &gdk::Window, x: i32, y: i32, w: i32, h: i32) {
    // 注意：gdk 的签名只接受 `&Region`（没有 Option 版本）。"整窗可交互"用
    // **全窗口矩形**表达，而不是传 None —— 传空 region 会变成"整窗都不接受输入"。
    let region = if w <= 0 || h <= 0 {
        // GdkWindow 没有 size()；用几何信息（含边框）取整窗尺寸。
        let (_gx, _gy, gw, gh) = win.geometry();
        cairo::Region::create_rectangle(&cairo::RectangleInt::new(0, 0, gw, gh))
    } else {
        cairo::Region::create_rectangle(&cairo::RectangleInt::new(x, y, w, h))
    };
    win.input_shape_combine_region(&region, 0, 0);
    for child in win.children() {
        apply_input_rect(&child, x, y, w, h);
    }
}

/// 设置输入区域（仅 Linux）。见 [`apply_input_rect`]。
pub fn set_input_rect(app: &AppHandle, label: &str, x: i32, y: i32, w: i32, h: i32) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        let win = app
            .get_webview_window(label)
            .ok_or_else(|| format!("找不到窗口 {label}"))?;
        let gtk_win = win.gtk_window().map_err(|e| format!("取 GTK 窗口失败: {e}"))?;
        let gdk_win = gtk_win
            .window()
            .ok_or_else(|| "GdkWindow 尚未创建".to_string())?;
        if !gdk_win.display().supports_input_shapes() {
            return Err("当前后端不支持 input shapes".to_string());
        }
        apply_input_rect(&gdk_win, x, y, w, h);
        // 只在矩形变化时打日志（每次展开都会调用，避免刷屏）
        {
            static LAST: OnceLock<Mutex<(i32, i32, i32, i32)>> = OnceLock::new();
            let holder = LAST.get_or_init(|| Mutex::new((-1, -1, -1, -1)));
            if let Ok(mut last) = holder.lock() {
                if *last != (x, y, w, h) {
                    *last = (x, y, w, h);
                    eprintln!("[input-region] {label} = ({x},{y},{w},{h})");
                }
            }
        }
        return Ok(());
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, label, x, y, w, h);
        Err("仅 Linux 需要该路径".to_string())
    }
}
