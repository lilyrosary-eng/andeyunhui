//! Linux 原生托盘：`libappindicator` + `gtk-rs`。
//!
//! # 为什么不用 Tauri 的 `TrayIconBuilder`
//!
//! muda 在 GTK 上建菜单项的方式是
//! `gtk::MenuItem::builder().child(GtkBox{ GtkImage + GtkAccelLabel })`
//! （`muda-0.19.3/src/platform_impl/gtk/mod.rs:1030-1070`）——
//! 菜单项**没有** GTK 的 label 属性（`gtk_menu_item_get_label()` 返回 NULL），
//! 文本被塞进自定义子控件里。libappindicator 能把它导进 D-Bus
//! （`GetLayout` / `GetGroupProperties` 都能读到干净的 UTF-8 中文），
//! 但 GNOME 的 AppIndicator 扩展渲染出来是**空白按钮**。
//!
//! 同环境对照：`/usr/libexec/omen-control/omen-tray` 用
//! `Gtk.MenuItem(label=...)`，菜单显示完全正常。所以这里复刻那条路径。
//!
//! # 生命周期
//!
//! `AppIndicator` 与 `gtk::Menu` 都必须活到进程结束：drop 会卸载托盘项、
//! 销毁 GTK 菜单（`Menu::drop` 会 `menu.destroy()`）。这里主动泄漏一次。
//!
//! # 线程
//!
//! 全部 GTK 调用必须在 GTK 主线程。调用点就在 Tauri 的 setup 里（主线程）。

use std::rc::Rc;

use gtk::prelude::*;
use libappindicator::{AppIndicator, AppIndicatorStatus};
use tauri::AppHandle;

/// 建立托盘与原生菜单。
///
/// `on_summon` / `on_quit` 由 bin crate 传入：`tray_summon_main` / `tray_quit`
/// 定义在 `main.rs`，lib 看不到它们。
pub fn setup(
    app: &AppHandle,
    icon_name: &str,
    on_summon: impl Fn() + 'static,
    on_quit: impl Fn() + 'static,
) -> Result<(), String> {
    let _ = app; // 预留：后续若要在菜单里放动态项需要 app.handle()
    if !gtk::is_initialized() {
        return Err("GTK 未初始化（必须在 setup 的主线程里调用）".into());
    }

    // Rc 是因为同一个回调要能挂给多个信号（这里各挂一次，但避免闭包被 move 走）
    let summon: Rc<dyn Fn()> = Rc::new(on_summon);
    let quit: Rc<dyn Fn()> = Rc::new(on_quit);

    let mut menu = gtk::Menu::new();

    // ⚠ 关键：用 `MenuItem::with_label`（会设 GTK 的 label 属性），
    // 不要用 `MenuItem::new()` + 自定义 child —— 后者正是 muda 踩的坑。
    let item_show = gtk::MenuItem::with_label("显示主窗口");
    {
        let f = summon.clone();
        item_show.connect_activate(move |_| f());
    }

    let item_quit = gtk::MenuItem::with_label("退出安得云荟");
    {
        let f = quit.clone();
        item_quit.connect_activate(move |_| f());
    }

    menu.append(&item_show);
    menu.append(&gtk::SeparatorMenuItem::new());
    menu.append(&item_quit);
    menu.show_all();

    let mut indicator = AppIndicator::new("andeyunhui", icon_name);
    indicator.set_icon_full(icon_name, "安得云荟");
    // set_title 决定 GNOME 托盘里鼠标悬停/无障碍读到的名字
    indicator.set_title("安得云荟");
    indicator.set_menu(&mut menu);
    indicator.set_status(AppIndicatorStatus::Active);

    // 活到进程结束（见模块头注释）
    std::mem::forget(menu);
    std::mem::forget(indicator);
    Ok(())
}
