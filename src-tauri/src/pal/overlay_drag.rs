//! Linux 浮窗拖动通道：应用 → GNOME Shell 扩展（合成器）的 D-Bus 客户端。
//!
//! # 为什么必须这样绕
//! tao 0.35 的 `drag_window()` 实现是
//! `window.begin_move_drag(1, x, y, 0)`
//! （`tao/src/platform_impl/linux/event_loop.rs:343`）——**时间戳恒为 0**。
//! Wayland 的 `xdg_toplevel.move(seat, serial)` 必须带「当前输入事件的 serial」，
//! 传 0 会被合成器直接忽略 ⇒ `startDragging()` 与 `data-tauri-drag-region`
//! （后者也只是 JS 转调 `plugin:window|start_dragging`，
//! `tauri-2.11.5/src/window/scripts/drag.js:105`）在原生 Wayland 上都不可能生效。
//!
//! 只有合成器能搬窗口。所以链路由三段组成：
//!   前端指针事件 → 本模块（zbus 调用）→ 扩展 `org.andeyunhui.Pin` → `Meta.Window.move_frame`
//!
//! 扩展侧优先用 `begin_grab_op(MOVING)` 让 mutter 自己跟随指针（手感最好）；
//! 若该 API 不可用则返回 false，前端回退到「累积 movementX/Y + MoveTo」。
//!
//! 非 Linux 平台：`begin` 恒返回 false、其余是空操作 —— Windows 继续走原生 `startDragging()`。

/// 扩展导出的总线名（通过 Gio.bus_own_name 占用）。
const DEST: &str = "org.andeyunhui.Pin";
const PATH: &str = "/org/andeyunhui/Pin";
const IFACE: &str = "org.andeyunhui.Pin";

#[cfg(target_os = "linux")]
fn conn() -> Result<zbus::blocking::Connection, String> {
    zbus::blocking::Connection::session().map_err(|e| e.to_string())
}

/// 开始拖动。返回 true 表示**合成器已接管**（前端不用再算位移）。
pub fn begin(title: &str) -> bool {
    #[cfg(target_os = "linux")]
    {
        let Ok(c) = conn() else { return false };
        match c.call_method(Some(DEST), PATH, Some(IFACE), "BeginDrag", &(title,)) {
            Ok(reply) => reply.body().deserialize::<bool>().unwrap_or(false),
            Err(e) => {
                eprintln!("[overlay-drag] BeginDrag 失败（扩展未加载？）: {e}");
                false
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = title;
        false
    }
}

/// 把窗口移动到目标逻辑坐标（Wayland 下唯一可行的移动方式）。
pub fn move_to(title: &str, x: i32, y: i32) {
    #[cfg(target_os = "linux")]
    {
        let Ok(c) = conn() else { return };
        if let Err(e) = c.call_method(Some(DEST), PATH, Some(IFACE), "MoveTo", &(title, x, y)) {
            eprintln!("[overlay-drag] MoveTo 失败: {e}");
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (title, x, y);
    }
}

/// 结束拖动（扩展侧保持"用户已手动移动"的状态，本次会话不再钉住该窗口）。
pub fn end(title: &str) {
    #[cfg(target_os = "linux")]
    {
        let Ok(c) = conn() else { return };
        if let Err(e) = c.call_method(Some(DEST), PATH, Some(IFACE), "EndDrag", &(title,)) {
            eprintln!("[overlay-drag] EndDrag 失败: {e}");
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = title;
    }
}
