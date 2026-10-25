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
//! 它对整个 GdkWindow 生效，比"设一块 1×1 输入形状"语义更明确，也不依赖 X11。
//!
//! 注意：Wayland 没有"逐像素输入区域"以外的自由——这就是能做到的最细粒度（整窗）。

use tauri::{AppHandle, Manager};

#[cfg(target_os = "linux")]
fn apply_recursive(win: &gdk::Window, ignore: bool) {
    win.set_pass_through(ignore);
    for child in win.children() {
        apply_recursive(&child, ignore);
    }
}

/// 给指定 label 的浮窗设置/取消整窗穿透。返回 Err 时调用方可回退到 tao 的旧接口。
pub fn apply(app: &AppHandle, label: &str, ignore: bool) -> Result<(), String> {
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
        // 只设顶层不够：WebKit 的渲染用到子 GdkWindow，子窗口仍会吞事件
        // （用户实测"设了穿透，被遮住处还是点不到"）。递归整棵子树。
        apply_recursive(&gdk_win, ignore);
        eprintln!("[click-through] {label} pass_through={ignore}");
        // 打开穿透后再补几次：WebKit 的渲染子窗口/子 surface 有时在开关之后才创建或重建，
        // 只在开关瞬间设一次会漏掉它们（用户实测：光标变了但下面仍点不到）。
        if ignore {
            let label_owned = label.to_string();
            let app2 = app.clone();
            // 回到主线程再定时（GDK 调用必须在主线程）
            let _ = app.run_on_main_thread(move || {
                use gtk::glib;
                let app3 = app2.clone();
                glib::timeout_add_local(std::time::Duration::from_millis(400), move || {
                    if let Some(w) = app3.get_webview_window(&label_owned) {
                        if let Ok(g) = w.gtk_window() {
                            if let Some(gd) = g.window() {
                                apply_recursive(&gd, true);
                            }
                        }
                    }
                    glib::ControlFlow::Break
                });
            });
        }
        return Ok(());
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, label, ignore);
        Err("仅 Linux 需要该路径".to_string())
    }
}
