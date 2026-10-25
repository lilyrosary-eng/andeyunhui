//! 非 Windows（Linux）下 SMTC 的**真实实现**：MPRIS over D-Bus。
//!
//! ## 为什么需要这个文件
//!
//! Windows 的 SMTC 由两块组成，非 Windows 都没有等价 COM 后端：
//!   1. **发布**：`SystemMediaTransportControls`（把本应用正在播的曲目注册成系统媒体会话）；
//!   2. **读取/控制**：`GlobalSystemMediaTransportControlsSessionManager`（枚举整机媒体会话、
//!      发送 play/pause/next/prev）。
//!
//! Linux 桌面的标准是 **MPRIS**（`org.mpris.MediaPlayer2.*` over D-Bus 会话总线），
//! 用两个 crate 分别对齐上面两块：
//!   - `souvlaki` → 发布端；
//!   - `mpris`    → 读取/控制端（`PlayerFinder` 枚举 + `Player` 传输控制）。
//!
//! ## 与 Windows 实现的有意差异
//!
//! - **封面**：Windows 侧 SMTC 给缩略图流，Rust 落盘后返回**本地路径**；MPRIS 的
//!   `mpris:artUrl` 是 URL。前端用 `convertFileSrc(cover_path)` 渲染，只吃本地路径，
//!   因此这里 `file://` → 本地路径（含百分号解码），`http(s)://` → 直接 `None`
//!   （宁可无封面，也不给一个 `convertFileSrc` 会渲染失败的值）。
//! - **媒体键**：Windows 靠 SMTC 按钮回调；Linux 上桌面媒体键由桌面环境经 MPRIS
//!   转发到我们这条会话，故走 `souvlaki` 的事件回调。
//! - 属 WinRT / 注册表概念的字段（`window_aumid_set` / `reg_displayname` 等）保持
//!   `Default`，`smtc_status` 只填 Linux 上有真实含义的项。
//!
//! ## 线程模型（重要）
//!
//! `souvlaki::MediaControls` 不保证 `Send`/`Sync`（Linux 后端内部是 libdbus 连接），
//! 因此**不放进全局 Mutex**，而是让一个后台线程独占持有它，命令经 `mpsc` 下发。
//! 这样既绕开 `Send` 约束，也天然把 D-Bus 调用串行化了。

#![allow(dead_code)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter};

// ============================================================================
// 数据结构：与 Windows 实现**逐字同名同字段**，前端契约不变
// ============================================================================

/// 媒体键事件投递给前端的载荷（与 Windows 实现同名字段）。
///
/// 真正 emit 出去的是下面私有的 `ControlPayload`（多一个 `value`），
/// 与 Windows 侧真实实现一致（音量键要带 0.0~1.0 的值）。
/// 保留本结构是为了与 Windows 侧的类型名对齐。
#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct SmtcControl {
    pub action: String,
    pub target: String,
}

/// 前端推送到 Rust 的媒体状态（与 Windows 实现同名字段）。
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
pub struct SmtcUpdate {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub cover_path: Option<String>,
    /// "music" | "video"
    pub media_type: String,
    pub is_playing: bool,
    pub can_prev: bool,
    pub can_next: bool,
    pub source: Option<String>,
    pub key: Option<String>,
    /// 总时长（毫秒）。Some 时 MPRIS 才有 `mpris:length`——GNOME 媒体卡片的进度条靠它。
    #[serde(default)]
    pub duration_ms: Option<u64>,
    /// 当前播放位置（毫秒）。Some 时 Playing 带 progress，卡片才会显示已播/可拖。
    #[serde(default)]
    pub position_ms: Option<u64>,
}

/// 诊断用：Rust 端 SMTC 会话的真实运行状态（与 Windows 实现同名字段）。
#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct SmtcStatus {
    pub session_created: bool,
    pub window_aumid_set: bool,
    pub aumid: String,
    pub process_aumid: String,
    pub active_module: String,
    pub last_music_title: String,
    pub last_video_title: String,
    pub last_status_playing: Option<bool>,
    pub is_enabled: bool,
    pub playback_status: String,
    pub actual_top_aumid: String,
    pub reg_displayname: String,
    pub system_sessions: Vec<String>,
}

/// 精简诊断（与 Windows 实现同名字段）。
#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct SmtcDiag {
    pub session_created: bool,
    pub process_aumid: String,
    pub actual_top_aumid: String,
}

/// 与 Windows 侧 `smtc_control` 里 emit 出去的私有载荷形状一致。
#[derive(serde::Serialize, Clone, Debug)]
pub(crate) struct ControlPayload {
    pub(crate) action: String,
    pub(crate) target: String,
    pub(crate) value: Option<f64>,
}

// ============================================================================
// 全局状态
// ============================================================================

/// 发布端命令（provider 线程独占 `MediaControls`，经通道接收指令）。
pub(crate) enum ProviderCmd {
    Update(Box<SmtcUpdate>),
    Volume(f64),
}

static PROVIDER_TX: OnceLock<Mutex<mpsc::Sender<ProviderCmd>>> = OnceLock::new();
/// 发布端是否已成功建立 MPRIS 会话（dbus 名抢到并 export 成功）。
static PROVIDER_READY: AtomicBool = AtomicBool::new(false);
/// 轮询线程是否已启动（幂等保护）。
static POLL_STARTED: AtomicBool = AtomicBool::new(false);
/// 当前活动模块（"music" / "video"），由前端 `set_active_module` 设置。
static ACTIVE_MODULE: Mutex<Option<String>> = Mutex::new(None);
/// 最近一次前端推送的媒体状态（供 `smtc_status` 使用）。
static LAST_UPDATE: Mutex<Option<SmtcUpdate>> = Mutex::new(None);
/// 主窗口是否隐藏（Linux 仅记录）。
static WINDOW_HIDDEN: AtomicBool = AtomicBool::new(false);

/// 本应用在会话总线上的 MPRIS 名（须符合 D-Bus 命名规范，不能有中文/下划线）。
const MPRIS_APP_NAME: &str = "andeyunhui";
/// 展示名（桌面媒体控件里显示的名字）。
const APP_DISPLAY_NAME: &str = "安得云荟";
/// 系统轮询间隔：浮岛在展开态按秒级刷新，这里与之匹配。
const POLL_INTERVAL: Duration = Duration::from_millis(1000);

// ============================================================================
// URL / 路径 互转（封面）
// ============================================================================

/// `file://` URI → 本地路径（含百分号解码）。非 `file://` 一律 `None`。
fn file_url_to_path(url: &str) -> Option<String> {
    let rest = url.strip_prefix("file://")?;
    // 形如 file:///home/x/a.jpg → 去掉 scheme 后得到 /home/x/a.jpg。
    // 只处理本地文件，不处理 file://host/share 这种。
    if !rest.starts_with('/') {
        return None;
    }
    Some(percent_decode(rest))
}

/// 本地路径 → `file://` URI（对非 URL 安全字节做百分号编码）。
///
/// MPRIS 规范要求本地封面以 `file://` 开头且是 UTF-8 字符串。中文路径必须编码，
/// 否则桌面侧的 URI 解析会失败（表现为「封面永远不显示」）。
pub(crate) fn path_to_file_url(path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 8);
    out.push_str("file://");
    for &b in path.as_bytes() {
        let safe = b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'/' | b'-' | b'_' | b'.' | b'~' | b'!' | b'$' | b'&' | b'\'' | b'(' | b')'
                    | b'*' | b'+' | b',' | b';' | b'=' | b':' | b'@'
            );
        if safe {
            out.push(b as char);
        } else {
            out.push('%');
            out.push_str(&format!("{b:02X}"));
        }
    }
    out
}

/// 最小百分号解码（只处理 `%XX`，非法序列原样保留）。
fn percent_decode(s: &str) -> String {
    fn hex(c: u8) -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    }

    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ============================================================================
// 发布端（本应用 → 系统）
// ============================================================================

/// 初始化 SMTC（Linux：建立 MPRIS 发布会话 + 启动系统媒体轮询）。幂等。
pub fn init_smtc(app: AppHandle) {
    // —— 发布端：一个独占线程持有 MediaControls ——
    let (tx, rx) = mpsc::channel::<ProviderCmd>();
    if PROVIDER_TX.set(Mutex::new(tx)).is_ok() {
        let provider_app = app.clone();
        if let Err(e) = std::thread::Builder::new()
            .name("mpris-provider".to_string())
            .spawn(move || provider_loop(provider_app, rx))
        {
            eprintln!("[smtc/mpris] 发布线程启动失败: {e}");
        }
    }

    // —— 读取端：轮询系统上的 MPRIS 播放器，变化时 emit `now-playing` ——
    if !POLL_STARTED.swap(true, Ordering::SeqCst) {
        if let Err(e) = std::thread::Builder::new()
            .name("mpris-poll".to_string())
            .spawn(move || poll_loop(app))
        {
            eprintln!("[smtc/mpris] 轮询线程启动失败: {e}");
        }
    }
}

/// 发布端主循环：独占 `MediaControls`，串行处理来自命令线程的指令。
fn provider_loop(app: AppHandle, rx: mpsc::Receiver<ProviderCmd>) {
    // Linux 走自研 MPRIS（mpris-server）：souvlaki 给不了 DesktopEntry / Capabilities /
    // Seek·SetPosition，媒体卡片会缺图标且不能拖进度（2026-10-24）。
    #[cfg(target_os = "linux")]
    {
        // Linux 改为**只用 WebKitGTK 内置的 MPRIS**：WebKit 每播放一次媒体就会发布一个播放器，
        // 我们再发一个 ⇒ GNOME 显示两张卡（用户实测，且 WebKit 4.1 没有开关能关掉它）。
        // 所以这里默认不再启动自定义发布端；需要对比时设 ANDY_OWN_MPRIS=1 打开。
        if std::env::var("ANDY_OWN_MPRIS").ok().as_deref() == Some("1") {
            crate::mpris_player::run_provider(app, rx);
        } else {
            eprintln!("[smtc/mpris] Linux 使用 WebKit 内置 MPRIS（自有发布端已关闭；ANDY_OWN_MPRIS=1 可打开）");
            // 保持通道不阻塞：丢弃命令即可
            std::thread::spawn(move || for _ in rx {});
        }
        return;
    }

    #[cfg(not(target_os = "linux"))]
    provider_loop_souvlaki(app, rx);
}

#[cfg(not(target_os = "linux"))]
fn provider_loop_souvlaki(app: AppHandle, rx: mpsc::Receiver<ProviderCmd>) {
    use souvlaki::{MediaControlEvent, MediaControls, PlatformConfig};

    let config = PlatformConfig {
        display_name: APP_DISPLAY_NAME,
        dbus_name: MPRIS_APP_NAME,
        hwnd: None, // 仅 Windows 需要
    };

    let mut controls = match MediaControls::new(config) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[smtc/mpris] MediaControls::new 失败（退化为只读模式）: {e}");
            return;
        }
    };

    // 事件回调：桌面媒体键 → 前端已有的 `smtc-control` 事件。
    // SetVolume 需要我们自己回写 set_volume（MPRIS 后端的要求，见 souvlaki 文档）。
    let ev_app = app.clone();
    if let Err(e) = controls.attach(move |event: MediaControlEvent| {
        let (action, value) = match event {
            MediaControlEvent::Play => ("play", None),
            MediaControlEvent::Pause => ("pause", None),
            MediaControlEvent::Toggle => ("toggle", None),
            MediaControlEvent::Next => ("next", None),
            MediaControlEvent::Previous => ("previous", None),
            MediaControlEvent::Stop => ("stop", None),
            MediaControlEvent::SetVolume(v) => ("volume", Some(v)),
            // Seek / SetPosition / OpenUri / Raise / Quit 暂不映射：
            // 前端控制面目前只有 play/pause/previous/next/volume 五档，
            // 凭空塞新 action 只会被忽略，不如显式留白。
            _ => return,
        };
        let _ = ev_app.emit(
            "smtc-control",
            ControlPayload {
                action: action.to_string(),
                target: "app".to_string(),
                value,
            },
        );
    }) {
        eprintln!("[smtc/mpris] attach 事件回调失败: {e}");
    }

    PROVIDER_READY.store(true, Ordering::SeqCst);
    eprintln!("[smtc/mpris] MPRIS 发布会话已就绪: org.mpris.MediaPlayer2.{MPRIS_APP_NAME}");

    while let Ok(cmd) = rx.recv() {
        match cmd {
            ProviderCmd::Update(info) => apply_update(&mut controls, &info),
            ProviderCmd::Volume(v) => {
                // MPRIS Volume 取值 0.0~1.0；前端可能传 0~100，这里归一。
                let norm = if v > 1.0 { v / 100.0 } else { v };
                if let Err(e) = controls.set_volume(norm.clamp(0.0, 1.0)) {
                    eprintln!("[smtc/mpris] set_volume 失败: {e}");
                }
            }
        }
    }
}

/// 把前端推来的状态写入 MPRIS 会话（元数据 + 播放状态）。
fn apply_update(controls: &mut souvlaki::MediaControls, info: &SmtcUpdate) {
    use souvlaki::{MediaMetadata, MediaPlayback};

    // 封面：仅本地文件可用（见文件头的差异说明）
    let cover_owned: Option<String> = info
        .cover_path
        .as_deref()
        .filter(|p| !p.is_empty())
        .map(path_to_file_url);

    // 时长/进度：souvlaki 的 MediaMetadata.duration 与 Playing{progress} 都支持，
    // 之前一律传 None ⇒ MPRIS 里没有 mpris:length、Position 恒 0，GNOME 媒体卡片于是没有进度条
    // （2026-10-24 与 busctl introspect 对照确认）。
    let duration = info.duration_ms.map(std::time::Duration::from_millis);
    // souvlaki 0.8 的 Playing{progress} 只吃「位置」（MediaPosition 是个 newtype），
    // 时长走 MediaMetadata.duration，两者分开传。
    let progress = info
        .position_ms
        .map(|pos| souvlaki::MediaPosition(std::time::Duration::from_millis(pos)));

    let metadata = MediaMetadata {
        title: non_empty(&info.title),
        artist: non_empty(&info.artist),
        album: non_empty(&info.album),
        cover_url: cover_owned.as_deref(),
        duration,
    };
    if let Err(e) = controls.set_metadata(metadata) {
        eprintln!("[smtc/mpris] set_metadata 失败: {e}");
    }

    let playback = if info.is_playing {
        MediaPlayback::Playing { progress }
    } else if info.title.is_empty() {
        MediaPlayback::Stopped
    } else {
        MediaPlayback::Paused { progress }
    };
    if let Err(e) = controls.set_playback(playback) {
        eprintln!("[smtc/mpris] set_playback 失败: {e}");
    }
}

fn non_empty(s: &str) -> Option<&str> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

// ============================================================================
// 读取端（系统 → 本应用）
// ============================================================================

/// 枚举系统上其他 MPRIS 播放器的当前状态。
///
/// 排除本应用自己的 MPRIS 名（它走前端的 `smtc_update` → `appPlay` 通道；
/// 若同时出现在外部快照里，浮岛会出现两张同名卡片）。
fn list_system_players() -> Vec<SmtcUpdate> {
    use mpris::{PlaybackStatus, PlayerFinder};

    let finder = match PlayerFinder::new() {
        Ok(f) => f,
        Err(e) => {
            // 会话总线不可用（如无 DBUS_SESSION_BUS_ADDRESS）属正常降级，不刷屏
            eprintln!("[smtc/mpris] 连接会话总线失败: {e}");
            return Vec::new();
        }
    };
    let players = match finder.find_all() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[smtc/mpris] 枚举播放器失败: {e}");
            return Vec::new();
        }
    };

    let mut out = Vec::new();
    for player in players {
        let bus = player.bus_name().to_string();
        if bus.contains(MPRIS_APP_NAME) {
            continue; // 跳过自己
        }

        let meta = player.get_metadata().ok();
        let title = meta
            .as_ref()
            .and_then(|m| m.title())
            .unwrap_or("")
            .to_string();
        // 曲目为空（播放器空闲/刚启动）时不产出条目，避免浮岛出现空卡片
        if title.is_empty() {
            continue;
        }
        let artist = meta
            .as_ref()
            .and_then(|m| m.artists())
            .map(|a| a.join(", "))
            .unwrap_or_default();
        let album = meta
            .as_ref()
            .and_then(|m| m.album_name())
            .unwrap_or("")
            .to_string();
        // 只认本地封面：http(s) 封面 convertFileSrc 渲染不了，宁缺勿错
        let cover_path = meta
            .as_ref()
            .and_then(|m| m.art_url())
            .and_then(file_url_to_path);

        let is_playing =
            matches!(player.get_playback_status(), Ok(PlaybackStatus::Playing));

        // 这是「读系统其它播放器」的那条路（轮询），没有可靠的时长/位置信息，置空。
        out.push(SmtcUpdate {
            duration_ms: None,
            position_ms: None,
            title,
            artist,
            album,
            cover_path,
            media_type: "music".to_string(),
            is_playing,
            can_prev: player.can_go_previous().unwrap_or(false),
            can_next: player.can_go_next().unwrap_or(false),
            source: Some("system".to_string()),
            key: Some(bus),
        });
    }

    // 正在播放的排前面，便于前端「跟随实时」
    out.sort_by_key(|p| !p.is_playing);
    out
}

/// 轮询线程：系统媒体状态变化时 emit `now-playing`（与 Windows 行为对齐）。
fn poll_loop(app: AppHandle) {
    let mut last: Option<String> = None;
    loop {
        std::thread::sleep(POLL_INTERVAL);

        let players = list_system_players();
        // 优先「正在播放」的那个作为系统源
        let top = players
            .iter()
            .find(|p| p.is_playing)
            .or_else(|| players.first());

        let fingerprint = top.map(|p| {
            format!(
                "{}|{}|{}|{}|{}",
                p.key.as_deref().unwrap_or(""),
                p.title,
                p.artist,
                p.is_playing,
                p.cover_path.as_deref().unwrap_or("")
            )
        });

        if fingerprint == last {
            continue; // 无变化不打扰前端（浮岛的 play 指纹去重也需要这个节流）
        }
        last = fingerprint;

        match top {
            Some(p) => {
                let _ = app.emit("now-playing", p);
            }
            None => {
                // 系统侧全部消失 → 推空载荷，让浮岛收回系统卡片
                let _ = app.emit(
                    "now-playing",
                    SmtcUpdate {
                        source: Some("system".to_string()),
                        ..Default::default()
                    },
                );
            }
        }
    }
}

// ============================================================================
// 对前端暴露的命令
// ============================================================================

/// 前端推送本应用播放状态 → 写入 MPRIS 会话（对应 Windows 的 SMTC session 更新）。
#[tauri::command]
pub fn smtc_update(app: AppHandle, info: SmtcUpdate) {
    if let Ok(mut last) = LAST_UPDATE.lock() {
        *last = Some(info.clone());
    }

    // 首次推送时若发布端还没建起来，补一次 init
    // （与 Windows 的「session not ready 则重试 init」一致）
    if !PROVIDER_READY.load(Ordering::SeqCst) {
        init_smtc(app.clone());
    }

    if let Some(tx) = PROVIDER_TX.get() {
        if let Ok(tx) = tx.lock() {
            let _ = tx.send(ProviderCmd::Update(Box::new(info)));
        }
    }
}

/// 枚举系统媒体会话（对应 Windows 的 SessionManager 快照）。
#[tauri::command]
pub fn smtc_list_sessions() -> Vec<SmtcUpdate> {
    list_system_players()
}

/// 控制媒体会话。
///
/// ⚠ 签名必须与 Windows 侧**逐字一致**（`action` + `Option<f64> value` + `Option<String> target`）。
/// 否则前端 `invoke('smtc_control', { action, value, target })` 会因参数不匹配直接报错——
/// 这曾是本桩的真实缺陷：旧签名只有 `(action, target)`，缺 `value` 导致该命令在 Linux 上
/// **不是空转而是抛错**（浮岛音量键完全无效，play/next 之前的动作也一起失败）。
#[tauri::command]
pub fn smtc_control(app: AppHandle, action: String, value: Option<f64>, target: Option<String>) {
    // target 为 None / "" / "app" → 针对本应用；其余 → 指定的外部 MPRIS 播放器。
    let is_app = matches!(target.as_deref(), None | Some("") | Some("app"));

    if is_app {
        // 音量：同步写入我们自己的 MPRIS 会话
        if action == "volume" {
            if let Some(v) = value {
                if let Some(tx) = PROVIDER_TX.get() {
                    if let Ok(tx) = tx.lock() {
                        let _ = tx.send(ProviderCmd::Volume(v));
                    }
                }
            }
        }
        // play/pause/previous/next 由播放器插件自己执行，这里只需回环给前端，
        // 保持与 Windows 一致的行为（Windows 同样 emit smtc-control）。
        let _ = app.emit(
            "smtc-control",
            ControlPayload {
                action,
                target: "app".to_string(),
                value,
            },
        );
        return;
    }

    // —— 控制外部播放器 ——
    let want = target.unwrap_or_default();
    let finder = match mpris::PlayerFinder::new() {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[smtc/mpris] 控制失败，会话总线不可用: {e}");
            return;
        }
    };
    let players = match finder.find_all() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[smtc/mpris] 控制失败，枚举播放器出错: {e}");
            return;
        }
    };
    let Some(player) = players.into_iter().find(|p| p.bus_name() == want) else {
        eprintln!("[smtc/mpris] 目标会话不存在，忽略: {want}");
        return;
    };

    let result = match action.as_str() {
        "play" => player.play(),
        "pause" => player.pause(),
        "toggle" => player.play_pause(),
        "next" => player.next(),
        "previous" => player.previous(),
        "stop" => player.stop(),
        "volume" => player.set_volume(value.unwrap_or(1.0).clamp(0.0, 1.0)),
        other => {
            eprintln!("[smtc/mpris] 未知 action，忽略: {other}");
            return;
        }
    };
    if let Err(e) = result {
        eprintln!("[smtc/mpris] 执行 {action} 失败: {e}");
    }
}

/// 当前活动模块（"music" / "video"）。
#[tauri::command]
pub fn set_active_module(module: String) {
    if let Ok(mut m) = ACTIVE_MODULE.lock() {
        *m = Some(module);
    }
}

/// 当前活动模块，缺省按 "music"（与 Windows SMTC 按键载荷的 target 契约一致）。
/// MPRIS 侧发事件时用它做 target，前端据此只在对应模块里响应。
pub(crate) fn active_module_or_music() -> String {
    ACTIVE_MODULE
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| "music".to_string())
}

/// 主窗口显隐（Windows 用它决定媒体键分发目标；Linux 仅记录）。
#[tauri::command]
pub fn set_window_hidden(hidden: bool) {
    WINDOW_HIDDEN.store(hidden, Ordering::SeqCst);
}

#[tauri::command]
pub fn debug_log(msg: String) {
    log::info!("[FE] {msg}");
}

/// 诊断：返回 Rust 端媒体会话的真实运行状态。
///
/// 返回 `Default`（全 false / 空串）而非 Err：这是**诊断**命令，语义上「查不到任何状态」
/// 就是合法结论，让调用方能正常拿到 JSON 展示，不必处理异常分支。
#[tauri::command]
pub async fn smtc_status() -> SmtcStatus {
    let players = list_system_players();
    let last = LAST_UPDATE.lock().ok().and_then(|g| g.clone());
    let module = ACTIVE_MODULE
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_default();

    let our_playing = last.as_ref().map(|i| i.is_playing).unwrap_or(false);
    let bus_name = format!("org.mpris.MediaPlayer2.{MPRIS_APP_NAME}");

    SmtcStatus {
        session_created: PROVIDER_READY.load(Ordering::SeqCst),
        window_aumid_set: false,
        // Linux 用 D-Bus 名代替 Windows 的 AUMID
        aumid: bus_name.clone(),
        process_aumid: bus_name,
        active_module: module,
        last_music_title: last
            .as_ref()
            .filter(|i| i.media_type != "video")
            .map(|i| i.title.clone())
            .unwrap_or_default(),
        last_video_title: last
            .as_ref()
            .filter(|i| i.media_type == "video")
            .map(|i| i.title.clone())
            .unwrap_or_default(),
        last_status_playing: last.as_ref().map(|i| i.is_playing),
        is_enabled: PROVIDER_READY.load(Ordering::SeqCst),
        playback_status: if our_playing { "Playing" } else { "Paused" }.to_string(),
        actual_top_aumid: players
            .first()
            .and_then(|p| p.key.clone())
            .unwrap_or_default(),
        reg_displayname: APP_DISPLAY_NAME.to_string(),
        system_sessions: players.into_iter().filter_map(|p| p.key).collect(),
    }
}

/// Windows 侧用于确保进程有 AUMID（任务栏媒体卡片归属）。Linux 无此概念。
pub fn ensure_app_identity() {}
