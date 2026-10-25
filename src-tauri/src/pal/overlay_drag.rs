//! Linux 浮窗拖动通道：应用 → GNOME Shell 扩展（合成器）的 D-Bus 客户端。
//!
//! # 为什么必须这样绕
//! tao 0.35 的 `drag_window()` 实现是 `window.begin_move_drag(1, x, y, 0)`
//! （`tao/src/platform_impl/linux/event_loop.rs:343`）——**时间戳恒为 0**。
//! Wayland 的 `xdg_toplevel.move(seat, serial)` 必须带「当前输入事件的 serial」，
//! 传 0 会被合成器忽略 ⇒ `startDragging()` 与 `data-tauri-drag-region`
//! （后者也只是 JS 转调 `plugin:window|start_dragging`，
//! `tauri-2.11.5/src/window/scripts/drag.js:105`）在原生 Wayland 上都不可能生效。
//!
//! 只有合成器能搬窗口：前端指针事件 → 本模块（zbus）→ 扩展 `org.andeyunhui.Pin`
//! → `Meta.Window.move_frame`。扩展优先用 `begin_grab_op(MOVING)` 让 mutter 自己跟随指针。
//!
//! # 线程模型（踩过的坑）
//! **不能在 Tauri 的 tokio 工作线程里用 zbus 的 `blocking` API**：那会在已有 runtime 里
//! 再起一个 runtime ⇒ panic；而 release 是 `panic = "abort"`，一次 panic 直接整进程退出。
//! 所以这里自建一条 `overlay-drag` 线程，用它自己的 current_thread runtime 持有一条
//! **复用的** async 连接；命令经 std mpsc 送进来，需要返回值的调用用一次性 channel 等最多 300ms。

use std::sync::mpsc;
use std::sync::OnceLock;

const DEST: &str = "org.andeyunhui.Pin";
const PATH: &str = "/org/andeyunhui/Pin";
const IFACE: &str = "org.andeyunhui.Pin";

enum Call {
    Begin(String, mpsc::Sender<bool>),
    Move { title: String, x: i32, y: i32 },
    Place { title: String, x: i32, y: i32 },
    End(String),
    Pointer(mpsc::Sender<Option<(i32, i32)>>),
    Near(String, mpsc::Sender<bool>),
}

fn tx() -> Option<&'static mpsc::Sender<Call>> {
    static TX: OnceLock<mpsc::Sender<Call>> = OnceLock::new();
    if let Some(t) = TX.get() {
        return Some(t);
    }
    let (tx, rx) = mpsc::channel::<Call>();
    let spawned = std::thread::Builder::new()
        .name("overlay-drag".into())
        .spawn(move || worker(rx))
        .is_ok();
    if !spawned {
        return None;
    }
    let _ = TX.set(tx);
    TX.get()
}

fn worker(rx: mpsc::Receiver<Call>) {
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("[overlay-drag] 建 runtime 失败: {e}");
            return;
        }
    };
    rt.block_on(async move {
        // 连接建失败就退化成 no-op（扩展没加载时不至于刷屏报错）
        let conn = match zbus::Connection::session().await {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[overlay-drag] 连接会话总线失败: {e}");
                return;
            }
        };
        // std mpsc → async 通道的桥（复用 mpris 那套做法）
        let (atx, mut arx) = tokio::sync::mpsc::unbounded_channel::<Call>();
        std::thread::Builder::new()
            .name("overlay-drag-bridge".into())
            .spawn(move || {
                for c in rx {
                    if atx.send(c).is_err() {
                        break;
                    }
                }
            })
            .ok();

        while let Some(call) = arx.recv().await {
            match call {
                Call::Begin(title, reply) => {
                    let r = conn
                        .call_method(Some(DEST), PATH, Some(IFACE), "BeginDrag", &(title.as_str(),))
                        .await
                        .map(|m| m.body().deserialize::<bool>().unwrap_or(false))
                        .unwrap_or(false);
                    let _ = reply.send(r);
                }
                Call::Move { title, x, y } => {
                    let _ = conn
                        .call_method(Some(DEST), PATH, Some(IFACE), "MoveTo", &(title.as_str(), x, y))
                        .await;
                }
                Call::Place { title, x, y } => {
                    let _ = conn
                        .call_method(Some(DEST), PATH, Some(IFACE), "Place", &(title.as_str(), x, y))
                        .await;
                }
                Call::Pointer(reply) => {
                    let r = conn
                        .call_method(Some(DEST), PATH, Some(IFACE), "Pointer", &())
                        .await
                        .ok()
                        .and_then(|m| m.body().deserialize::<(i32, i32)>().ok());
                    let _ = reply.send(r);
                }
                Call::Near(title, reply) => {
                    let r = conn
                        .call_method(Some(DEST), PATH, Some(IFACE), "Near", &(title.as_str(),))
                        .await
                        .ok()
                        .and_then(|m| m.body().deserialize::<bool>().ok())
                        .unwrap_or(false);
                    let _ = reply.send(r);
                }
                Call::End(title) => {
                    let _ = conn
                        .call_method(Some(DEST), PATH, Some(IFACE), "EndDrag", &(title.as_str(),))
                        .await;
                }
            }
        }
    });
}

/// 开始拖动。返回 true 表示**合成器已接管**（前端不用再算位移）。
pub fn begin(title: &str) -> bool {
    let Some(tx) = tx() else { return false };
    let (rtx, rrx) = mpsc::channel::<bool>();
    if tx.send(Call::Begin(title.to_string(), rtx)).is_err() {
        return false;
    }
    // 最多等 300ms：扩展没装/卡住时不拖住 UI 线程
    rrx.recv_timeout(std::time::Duration::from_millis(300)).unwrap_or(false)
}

/// 把窗口移动到目标逻辑坐标。
pub fn move_to(title: &str, x: i32, y: i32) {
    if let Some(tx) = tx() {
        let _ = tx.send(Call::Move { title: title.to_string(), x, y });
    }
}

/// 放置并**记为已释放**（启动时恢复用户上次拖到的位置用）。
pub fn place(title: &str, x: i32, y: i32) {
    if let Some(tx) = tx() {
        let _ = tx.send(Call::Place { title: title.to_string(), x, y });
    }
}

/// 读全局光标位置（逻辑像素）。Wayland 下客户端拿不到，只能问合成器。
pub fn pointer() -> Option<(i32, i32)> {
    let tx = tx()?;
    let (rtx, rrx) = mpsc::channel();
    tx.send(Call::Pointer(rtx)).ok()?;
    rrx.recv_timeout(std::time::Duration::from_millis(200)).ok().flatten()
}

/// 光标是否贴近某窗口（判定在合成器侧做，因为 Wayland 下应用拿不到可靠的窗口坐标）。
pub fn near(title: &str) -> bool {
    let Some(tx) = tx() else { return false };
    let (rtx, rrx) = mpsc::channel();
    if tx.send(Call::Near(title.to_string(), rtx)).is_err() {
        return false;
    }
    rrx.recv_timeout(std::time::Duration::from_millis(200)).unwrap_or(false)
}

/// 结束拖动。
pub fn end(title: &str) {
    if let Some(tx) = tx() {
        let _ = tx.send(Call::End(title.to_string()));
    }
}
