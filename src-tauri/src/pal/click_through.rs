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
    if let Ok(mut m) = desired_rects().lock() {
        m.remove(label);
    }
}

/// label → 期望的输入区域（**逻辑**像素，窗口坐标）。
#[cfg(target_os = "linux")]
fn desired_rects() -> &'static Mutex<HashMap<String, (i32, i32, i32, i32)>> {
    static D: OnceLock<Mutex<HashMap<String, (i32, i32, i32, i32)>>> = OnceLock::new();
    D.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(target_os = "linux")]
fn rect_enforcer_started() -> &'static Mutex<bool> {
    static S: OnceLock<Mutex<bool>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(false))
}

#[cfg(target_os = "linux")]
fn rect_dumped() -> &'static Mutex<std::collections::HashSet<String>> {
    static S: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

/// 把窗口的**输入区域**限制成给定矩形（**逻辑像素**，窗口坐标）。
/// `w <= 0 || h <= 0` 表示恢复整窗可交互。
///
/// 为什么需要它：浮岛窗在 Wayland 上缩不到胶囊大小（实测停在 460×200 逻辑像素），
/// 而整窗穿透又会把胶囊本身变成点不到。于是"透明边距挡点击"只有一个解：
/// 让**输入区域**等于可见胶囊的矩形，矩形外一律不吃事件。
/// 矩形由前端用 `getBoundingClientRect()` 实测传入（CSS/逻辑像素），设备像素换算在这里做。
///
/// # 单位（2026-10-28 核实）
/// `gdk_window_get_scale_factor` 的文档写的是「maps from **window coordinates** to the actual
/// device pixels」⇒ **窗口坐标就是逻辑/CSS 像素**，GDK 自己在内部换算成设备像素。
/// 所以这里**不要再乘 scale_factor**（我一度乘了，那会把区域放大成 2 倍，
/// 变成"更多地方吃点击"——反而更糟）。调用方传 `getBoundingClientRect()` 的原值即可。
#[cfg(target_os = "linux")]
fn apply_input_rect(win: &gdk::Window, x: i32, y: i32, w: i32, h: i32) {
    // 注意：gdk 的签名只接受 `&Region`（没有 Option 版本）。"整窗可交互"用
    // **超大矩形**表达，不要用 geometry()（GDK3 文档明说 Wayland 下不可靠，
    // 可能返回 0×0 ⇒ 整窗都不接受输入），也不要传空 region（同样导致点不到）。
    let region = if w <= 0 || h <= 0 {
        cairo::Region::create_rectangle(&cairo::RectangleInt::new(0, 0, 32767, 32767))
    } else {
        cairo::Region::create_rectangle(&cairo::RectangleInt::new(x, y, w, h))
    };
    win.input_shape_combine_region(&region, 0, 0);
    for child in win.children() {
        apply_input_rect(&child, x, y, w, h);
    }
}

/// 解除 GTK 的**尺寸下限**，让浮岛窗能真正缩到胶囊大小。
///
/// # 为什么窗口一直停在 460×200
/// GTK3 官方文档（`gtk_window_resize`）：*"windows may not be smaller than their
/// size request; to override this constraint, call gtk_widget_set_size_request()"*。
/// 而 tao 的 `min_inner_size` 走的是 `gdk` 的 geometry hints（合成器侧），**不会**降低
/// GTK 内部的 size request ⇒ `setSize(240,36)` 被顶回来，透明区永远是 460×200。
/// 这带来两个后果：① 透明区挡点击；② GNOME 扩展按窗口矩形判悬停 ⇒ 触发范围过大。
///
/// 这里把窗口与整条子控件链的 size request 设成 1×1（只是**下限**，控件仍会被拉伸填满），
/// 之后 `setSize` 才真正生效。返回一条诊断串供日志留痕。
#[cfg(target_os = "linux")]
pub fn relax_min_size(app: &AppHandle, label: &str) -> Result<String, String> {
    use gtk::prelude::*;

    let win = app
        .get_webview_window(label)
        .ok_or_else(|| format!("找不到窗口 {label}"))?;
    let gtk_win = win.gtk_window().map_err(|e| format!("取 GTK 窗口失败: {e}"))?;

    fn relax<W: IsA<gtk::Widget>>(w: &W, depth: usize, out: &mut String) {
        if depth > 4 {
            return;
        }
        let (rw, rh) = w.size_request();
        let (mw, mh) = w.preferred_width();
        out.push_str(&format!(
            "\n{}[{} req={rw}x{rh} min={mw}x{mh}]",
            "  ".repeat(depth),
            w.type_().name()
        ));
        w.set_size_request(1, 1);
        if let Some(c) = w.dynamic_cast_ref::<gtk::Container>() {
            for ch in c.children() {
                relax(&ch, depth + 1, out);
            }
        }
    }

    // 同时用 Tauri 的公开 API 把**合成器侧的** min 提示也清掉：tao 对不可缩放窗口会写
    // min=max 的 geometry hints，只压 GTK 的 size request 不够（两层约束都要清）。
    let _ = win.set_min_size(Some(tauri::LogicalSize::new(1.0, 1.0)));
    let _ = win.set_max_size(None::<tauri::LogicalSize<f64>>);

    let mut info = format!("[gtk-min] {label} 尺寸下限已解除：");
    relax(&gtk_win, 0, &mut info);
    if let Some(gdk_win) = gtk_win.window() {
        info.push_str(&format!(
            "\n[gtk-min] gdk 当前={}x{} sf={}",
            gdk_win.width(),
            gdk_win.height(),
            gdk_win.scale_factor()
        ));
    }
    Ok(info)
}
#[cfg(target_os = "linux")]
fn apply_rect_now(app: &AppHandle, label: &str, rect: (i32, i32, i32, i32)) {
    use gtk::prelude::*;

    let Some(win) = app.get_webview_window(label) else {
        return;
    };
    let Ok(gtk_win) = win.gtk_window() else { return };
    let Some(gdk_win) = gtk_win.window() else { return };
    if !gdk_win.display().supports_input_shapes() {
        return;
    }
    apply_input_rect(&gdk_win, rect.0, rect.1, rect.2, rect.3);

    // 一次性诊断：把 GTK 的尺寸请求链打出来，回答"窗口为什么缩不到 240×36"。
    // `gtk_window_resize` 的官方文档明说**不能小于 size request**；这里把 window / 子控件的
    // request 与 preferred(min,natural) 都记下来，下一次就不用再猜。
    // 每次窗口尺寸变化都打一条（不只是首次）：正好用来验证"解除下限 + 重设尺寸"是否真的生效。
    let gdk_now = (gdk_win.width(), gdk_win.height());
    let should_dump = rect_dumped()
        .lock()
        .map(|mut s| s.insert(format!("{label}:{}x{}", gdk_now.0, gdk_now.1)))
        .unwrap_or(false);
    if should_dump {
        let (rw, rh) = gtk_win.size_request();
        let (minw, natw) = gtk_win.preferred_width();
        let (minh, nath) = gtk_win.preferred_height();
        let (sw, sh) = gtk_win.size();
        let (gw, gh) = (gdk_win.width(), gdk_win.height());
        let sf = gdk_win.scale_factor();
        eprintln!(
            "[gtk-size] {label} gdk={gw}x{gh} gtk_size={sw}x{sh} size_request={rw}x{rh} \
             preferred_min={minw}x{minh} preferred_nat={natw}x{nath} sf={sf}"
        );
        // 子控件（WebKit 的 webview 就在里面）的 request 可能才是真正的下限。
        if let Some(child) = gtk_win.child() {
            let (crw, crh) = child.size_request();
            let (cminw, cnatw) = child.preferred_width();
            let (cminh, cnath) = child.preferred_height();
            eprintln!(
                "[gtk-size] {label} child={} size_request={crw}x{crh} \
                 preferred_min={cminw}x{cminh} preferred_nat={cnatw}x{cnath}",
                child.type_().name()
            );
        }
    }
}

/// 每秒重放一次所有已保存的输入区域。
///
#[cfg(target_os = "linux")]
/// 和整窗穿透同理：WebKit 的渲染用子 GdkWindow，resize/重绘时会销毁重建，
/// 新建出来的默认是**整窗吃事件** ⇒ 只设一次的话，过一会儿透明区又开始挡点击。
fn ensure_rect_enforcer(app: &AppHandle) {
    let mut started = match rect_enforcer_started().lock() {
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
        let snapshot: Vec<(String, (i32, i32, i32, i32))> = match desired_rects().lock() {
            Ok(m) => m.iter().map(|(k, v)| (k.clone(), *v)).collect(),
            Err(_) => continue,
        };
        if snapshot.is_empty() {
            continue;
        }
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            for (l, r) in snapshot {
                apply_rect_now(&app2, &l, r);
            }
        });
    });
}

/// 设置输入区域（仅 Linux）。入参是**逻辑像素**（见 [`apply_input_rect`] 的单位说明）。
pub fn set_input_rect(app: &AppHandle, label: &str, x: i32, y: i32, w: i32, h: i32) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        if let Ok(mut m) = desired_rects().lock() {
            m.insert(label.to_string(), (x, y, w, h));
        }
        // 立即应用一次，然后交给重放线程维持（子 GdkWindow 重建后会被重新裁平）。
        let app2 = app.clone();
        let label2 = label.to_string();
        let _ = app.run_on_main_thread(move || {
            apply_rect_now(&app2, &label2, (x, y, w, h));
        });
        ensure_rect_enforcer(app);
        // 只在矩形变化时打日志（每次展开都会调用，避免刷屏）
        {
            static LAST: OnceLock<Mutex<(i32, i32, i32, i32)>> = OnceLock::new();
            let holder = LAST.get_or_init(|| Mutex::new((-1, -1, -1, -1)));
            if let Ok(mut last) = holder.lock() {
                if *last != (x, y, w, h) {
                    *last = (x, y, w, h);
                    eprintln!("[input-region] {label} = ({x},{y},{w},{h}) 逻辑像素");
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
