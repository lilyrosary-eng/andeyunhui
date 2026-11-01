//! Linux 全局热键后端：xdg-desktop-portal `GlobalShortcuts`。
//!
//! # 为什么需要这个模块（而不是复用 `tauri-plugin-global-shortcut`）
//!
//! 插件的 Linux 后端是 `global-hotkey` → X11 `XGrabKey`。**Wayland 会话下抓不到全局按键**
//! （输入全部经过合成器，XWayland 只收到自己窗口内的事件），所以：
//!   · X11 会话：插件可用；
//!   · Wayland 会话：只有 portal 这一条路。
//!
//! 本机实测（2026-11-01，GNOME Shell 50.1 / Wayland）：
//!   `busctl --user introspect org.freedesktop.portal.Desktop …` 有
//!   `org.freedesktop.portal.GlobalShortcuts`；`/usr/share/xdg-desktop-portal/portals/gnome.portal`
//!   的 Interfaces 里也声明了 `org.freedesktop.impl.portal.GlobalShortcuts`
//!   ⇒ GNOME 后端确实实现了它。
//!
//! # 语义差异（必须知道的坑）
//!
//! · **绑定是「整组」的**：`BindShortcuts` 一次提交一组 shortcut，不能只改其中一个。
//!   所以本模块维护「四个热键的当前值」，每次变更整组同步；与上次已绑定的相同就跳过
//!   （否则 setup 阶段连续 4 次 register 会弹 4 次授权框）。
//! · **用户会看到一次系统授权框**：这是 portal 的硬性设计（应用不能静默劫持全局按键）。
//!   用户拒绝 → `BindShortcuts` 返回错误 → 调用方回退 `global-hotkey`（X11 可能仍可用）。
//! · **触发是靠信号**：`Activated(shortcut_id)`。我们只把 id 映射成与 Windows 完全相同的
//!   前端事件（`open-screenshot` / `open-clipboard-floating` / …），前端零改动。
//!
//! # 线程模型
//!
//! 不能在 Tauri 的 tokio 工作线程里再起 runtime（会 panic，且 release 是 `panic = "abort"`）。
//! 这里自建一条 `linux-hotkeys` 线程 + 自己的 `current_thread` runtime；
//! 同步命令经 `tokio::sync::mpsc::Sender::blocking_send` 送入，需要结果的用一次性 channel
//! 等最多 30s（够用户点完授权框）。

use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Duration;

use ashpd::desktop::global_shortcuts::{GlobalShortcuts, NewShortcut};
use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};

use crate::screenshot;

/// shortcut id：与前端事件一一对应，改值会导致已授权过的用户丢失绑定。
pub const ID_SCREENSHOT: &str = "adyh-screenshot";
pub const ID_CLIPBOARD: &str = "adyh-clipboard";
pub const ID_DROPZONE: &str = "adyh-dropzone";
pub const ID_FAVORITE: &str = "adyh-favorite";

/// 四个热键的当前值（与 `pal/screenshot.rs` 里的状态共享，统一由本模块持有）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Bindings {
    pub screenshot: String,
    pub clipboard: String,
    pub dropzone: String,
    pub favorite: String,
}

impl Default for Bindings {
    fn default() -> Self {
        Self {
            screenshot: screenshot::DEFAULT_SCREENSHOT_SHORTCUT.to_string(),
            clipboard: screenshot::DEFAULT_CLIPBOARD_SHORTCUT.to_string(),
            dropzone: screenshot::DEFAULT_DROPZONE_SHORTCUT.to_string(),
            favorite: screenshot::DEFAULT_FAVORITE_SHORTCUT.to_string(),
        }
    }
}

fn state() -> &'static std::sync::Mutex<Bindings> {
    static S: OnceLock<std::sync::Mutex<Bindings>> = OnceLock::new();
    S.get_or_init(|| std::sync::Mutex::new(Bindings::default()))
}

fn state_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("linux_hotkeys.json"))
}

/// 幂等的一次性加载：由 `read_screenshot_shortcut` 在 setup 首次调用时触发，
/// 这样不用改 `main.rs`（共享文件，Windows 也会走），也不会丢掉用户改过的值。
pub fn load_once(app: &AppHandle) {
    static DONE: OnceLock<()> = OnceLock::new();
    if DONE.get().is_some() {
        return;
    }
    let _ = DONE.set(());
    load(app);
}

/// 从磁盘读取（首次运行时写入默认值）。文件损坏时退回默认值，不阻断启动。
pub fn load(app: &AppHandle) {
    let Some(p) = state_path(app) else { return };
    if let Ok(raw) = std::fs::read_to_string(&p) {
        if let Ok(b) = serde_json::from_str::<Bindings>(&raw) {
            if let Ok(mut g) = state().lock() {
                *g = b;
            }
            return;
        }
    }
    save(app);
}

pub fn save(app: &AppHandle) {
    let Some(p) = state_path(app) else { return };
    let Ok(g) = state().lock() else { return };
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(s) = serde_json::to_string_pretty(&*g) {
        let _ = std::fs::write(&p, s);
    }
}

/// 当前四个值（读不到锁时退回默认值，避免把 panic 传出去）。
pub fn current() -> Bindings {
    state().lock().map(|g| g.clone()).unwrap_or_default()
}

/// 只读某一个（给 `get_*_shortcut` 用）。
pub fn get(which: Which) -> String {
    let b = current();
    match which {
        Which::Screenshot => b.screenshot,
        Which::Clipboard => b.clipboard,
        Which::Dropzone => b.dropzone,
        Which::Favorite => b.favorite,
    }
}

#[derive(Clone, Copy, Debug)]
pub enum Which {
    Screenshot,
    Clipboard,
    Dropzone,
    Favorite,
}

/// 更新一个字段并整组重新绑定。
///
/// **首次**（启动时 setup 里那几次 register）走后台：否则 portal 的授权框会把主窗口启动
/// 卡住最多 30s。用户之后在设置里改键时才同步等待，好在失败时把原因回给界面。
pub fn set_and_sync(app: &AppHandle, which: Which, value: String) -> Result<(), String> {
    {
        let mut g = state().lock().map_err(|_| "热键状态锁中毒".to_string())?;
        match which {
            Which::Screenshot => g.screenshot = value,
            Which::Clipboard => g.clipboard = value,
            Which::Dropzone => g.dropzone = value,
            Which::Favorite => g.favorite = value,
        }
    }
    save(app);

    static REG_COUNT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    // 启动阶段 setup 会连调 4 次（截图/剪贴板/中转站/收藏），把它们全部丢后台，
    // 避免主窗口被 portal 授权框卡住；第 5 次起才是用户在设置里改键，同步等结果。
    if REG_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) < 4 {
        let app = app.clone();
        std::thread::spawn(move || {
            if let Err(e) = sync(&app) {
                log::warn!("[hotkeys] 启动阶段绑定全局热键失败: {e}");
            }
        });
        return Ok(());
    }
    sync(app)
}

/// 把当前四个值整组提交给 portal。
///
/// 与上次已绑定的一致时直接返回 Ok（不打扰用户、不重复弹授权框）。
pub fn sync(app: &AppHandle) -> Result<(), String> {
    ensure_worker(app);
    // worker 是异步起的：短暂等它把命令通道装上（最多 2s），否则并发调用会误报「未就绪」。
    let mut waited = 0u32;
    let tx = loop {
        if let Some(t) = CMD_TX.get() {
            break t;
        }
        if waited >= 2000 {
            return Err("热键后端未就绪（portal 线程未启动）".to_string());
        }
        std::thread::sleep(Duration::from_millis(50));
        waited += 50;
    };
    let (rtx, rrx) = mpsc::channel();
    tx.blocking_send(Cmd::Sync(rtx))
        .map_err(|_| "热键后端已退出".to_string())?;
    match rrx.recv_timeout(Duration::from_secs(30)) {
        Ok(r) => r,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err("等待系统授权超时（30s）：全局热键需要你在弹出的对话框里确认".to_string())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => Err("热键后端异常退出".to_string()),
    }
}

// ---------------------------------------------------------------- worker

enum Cmd {
    /// 请求整组同步（载荷为空：worker 会读「当前值」，见下面对 300ms 合并窗口的说明）。
    Sync(mpsc::Sender<Result<(), String>>),
}

static CMD_TX: OnceLock<tokio::sync::mpsc::Sender<Cmd>> = OnceLock::new();

fn ensure_worker(app: &AppHandle) {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if CMD_TX.get().is_some() {
        return;
    }
    // 启动阶段会有 4 个后台线程同时进来，只允许真正起一次。
    if STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("linux-hotkeys".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    log::error!("[hotkeys] 创建 runtime 失败: {e}");
                    return;
                }
            };
            rt.block_on(run(app));
        })
        .is_ok();
    if !spawned {
        log::error!("[hotkeys] 无法启动工作线程");
    }
}

async fn run(app: AppHandle) {
    let (ctx, mut crx) = tokio::sync::mpsc::channel::<Cmd>(8);
    if CMD_TX.set(ctx).is_err() {
        return; // 已有实例
    }

    // 建 session：失败就没必要继续（调用方会回退 global-hotkey）
    let gs = match GlobalShortcuts::new().await {
        Ok(g) => g,
        Err(e) => {
            log::warn!("[hotkeys] portal GlobalShortcuts 不可用: {e}（回退 global-hotkey）");
            return;
        }
    };
    let session = match gs.create_session().await {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[hotkeys] 创建 portal 会话失败: {e}");
            return;
        }
    };
    let mut activated = match gs.receive_activated().await {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[hotkeys] 订阅 Activated 失败: {e}");
            return;
        }
    };

    // 首次绑定：用磁盘上的当前值
    let mut last_bound: Option<Bindings> = None;
    let first = current();
    match bind(&gs, &session, &first).await {
        Ok(n) => {
            log::info!("[hotkeys] portal 已绑定 {n} 个全局热键");
            last_bound = Some(first);
        }
        Err(e) => log::warn!("[hotkeys] 首次绑定失败: {e}"),
    }

    loop {
        tokio::select! {
            Some(sig) = activated.next() => {
                let id = sig.shortcut_id().to_string();
                emit_for(&app, &id);
            }
            Some(cmd) = crx.recv() => {
                match cmd {
                    Cmd::Sync(reply) => {
                        // 300ms 合并窗口：启动时 setup 会连着调 4 次 register（截图/剪贴板/
                        // 中转站/收藏），若不合并就会弹 4 次系统授权框。等这一小段后再读
                        // **当前值**（而不是消息里的快照），4 次调用会被压成 1 次绑定。
                        tokio::time::sleep(Duration::from_millis(300)).await;
                        let b = current();
                        if last_bound.as_ref() == Some(&b) {
                            let _ = reply.send(Ok(()));
                            continue;
                        }
                        let r = match bind(&gs, &session, &b).await {
                            Ok(_) => { last_bound = Some(b); Ok(()) }
                            Err(e) => Err(e),
                        };
                        let _ = reply.send(r);
                    }
                }
            }
            else => break,
        }
    }
    log::warn!("[hotkeys] 工作线程退出，全局热键不再可用");
}

async fn bind(
    gs: &GlobalShortcuts<'_>,
    session: &ashpd::desktop::Session<'_, GlobalShortcuts<'_>>,
    b: &Bindings,
) -> Result<usize, String> {
    // preferred_trigger 用的是 XDG shortcuts spec 的 accelerator 形式（`CTRL+SHIFT+s`），
    // 与设置面板显示的 `Ctrl+Shift+S` 不是同一套写法，必须先转换。
    let trig = [
        to_xdg_accel(&b.screenshot),
        to_xdg_accel(&b.clipboard),
        to_xdg_accel(&b.dropzone),
        to_xdg_accel(&b.favorite),
    ];
    let mut shortcuts = Vec::with_capacity(4);
    // 只提交转换成功的：某个值写坏了不应该让另外三个也绑不上
    if let Some(t) = trig[0].as_deref() {
        shortcuts.push(NewShortcut::new(ID_SCREENSHOT, "截图").preferred_trigger(t));
    }
    if let Some(t) = trig[1].as_deref() {
        shortcuts.push(NewShortcut::new(ID_CLIPBOARD, "剪贴板浮窗").preferred_trigger(t));
    }
    if let Some(t) = trig[2].as_deref() {
        shortcuts.push(NewShortcut::new(ID_DROPZONE, "中转站浮窗").preferred_trigger(t));
    }
    if let Some(t) = trig[3].as_deref() {
        shortcuts.push(NewShortcut::new(ID_FAVORITE, "常用笔记").preferred_trigger(t));
    }
    if shortcuts.is_empty() {
        return Err("四个热键字符串都无法解析".to_string());
    }

    let req = gs
        .bind_shortcuts(session, &shortcuts, None)
        .await
        .map_err(|e| format!("BindShortcuts 调用失败: {e}"))?;
    // `Proxy::request` 在返回前已经等到 Response 信号，这里取的是结果本身。
    let bound = req
        .response()
        .map_err(|e| format!("系统未授权全局热键: {e}"))?;
    Ok(bound.shortcuts().len())
}

/// 把 portal 的 shortcut id 映射成**与 Windows 完全相同的前端事件**。
///
/// 前端不需要知道热键来自哪个后端：它监听的一直是这几个事件名。
fn emit_for(app: &AppHandle, id: &str) {
    match id {
        ID_SCREENSHOT => {
            let _ = app.emit("open-screenshot", ());
        }
        ID_CLIPBOARD => {
            let _ = app.emit("open-clipboard-floating", ());
        }
        ID_DROPZONE => {
            let _ = app.emit("open-dropzone-floating", ());
        }
        ID_FAVORITE => {
            let _ = app.emit("favorite-shortcut-triggered", ());
        }
        other => log::debug!("[hotkeys] 未知 shortcut id: {other}"),
    }
}

/// `Ctrl+Shift+S` → `CTRL+SHIFT+s`。
///
/// XDG shortcuts spec：修饰键大写（CTRL/ALT/SHIFT/LOGO），普通键名小写，
/// 功能键（F1..F35）与 keysym 名（Return/Escape/Page_Up…）保持规范写法。
/// 解析不出「键」时返回 None（调用方跳过该条，不连累其它三个）。
fn to_xdg_accel(s: &str) -> Option<String> {
    let mut mods: Vec<&'static str> = Vec::new();
    let mut key: Option<String> = None;
    for part in s.split('+').map(str::trim).filter(|p| !p.is_empty()) {
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => mods.push("CTRL"),
            "alt" => mods.push("ALT"),
            "shift" => mods.push("SHIFT"),
            "super" | "meta" | "win" | "cmd" | "logo" => mods.push("LOGO"),
            other => key = Some(normalize_key(other)),
        }
    }
    let k = key?;
    Some(if mods.is_empty() {
        k
    } else {
        format!("{}+{}", mods.join("+"), k)
    })
}

fn normalize_key(k: &str) -> String {
    if k.chars().count() == 1 {
        return k.to_ascii_lowercase();
    }
    let upper = k.to_ascii_uppercase();
    if upper.len() >= 2
        && upper.starts_with('F')
        && upper[1..].chars().all(|c| c.is_ascii_digit())
    {
        return upper;
    }
    match k {
        "space" => "space",
        "enter" | "return" => "Return",
        "esc" | "escape" => "Escape",
        "tab" => "Tab",
        "backspace" => "BackSpace",
        "delete" | "del" => "Delete",
        "insert" => "Insert",
        "home" => "Home",
        "end" => "End",
        "pageup" => "Page_Up",
        "pagedown" => "Page_Down",
        "up" => "Up",
        "down" => "Down",
        "left" => "Left",
        "right" => "Right",
        other => other,
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accel_converts_common_forms() {
        assert_eq!(to_xdg_accel("Ctrl+Shift+S").as_deref(), Some("CTRL+SHIFT+s"));
        assert_eq!(to_xdg_accel("Ctrl+Alt+C").as_deref(), Some("CTRL+ALT+c"));
        assert_eq!(to_xdg_accel("Ctrl+Alt+V").as_deref(), Some("CTRL+ALT+v"));
        assert_eq!(to_xdg_accel("Ctrl+Shift+N").as_deref(), Some("CTRL+SHIFT+n"));
    }

    #[test]
    fn accel_handles_function_and_named_keys() {
        assert_eq!(to_xdg_accel("Ctrl+F5").as_deref(), Some("CTRL+F5"));
        assert_eq!(to_xdg_accel("Super+space").as_deref(), Some("LOGO+space"));
        assert_eq!(to_xdg_accel("Alt+Return").as_deref(), Some("ALT+Return"));
    }

    #[test]
    fn accel_rejects_garbage() {
        assert_eq!(to_xdg_accel(""), None);
        assert_eq!(to_xdg_accel("Ctrl+"), None);
        assert_eq!(to_xdg_accel("+"), None);
    }

    #[test]
    fn defaults_are_all_parseable() {
        let b = Bindings::default();
        assert!(to_xdg_accel(&b.screenshot).is_some());
        assert!(to_xdg_accel(&b.clipboard).is_some());
        assert!(to_xdg_accel(&b.dropzone).is_some());
        assert!(to_xdg_accel(&b.favorite).is_some());
    }
}
