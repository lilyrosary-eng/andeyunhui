//! Linux 原生 MPRIS 播放器（**替代 souvlaki 的发布端**，仅 Linux 编译）。
//!
//! # 为什么不用 souvlaki 了
//! 读 `souvlaki 0.8.3` 源码确认它的硬边界：
//!   - `PlatformConfig` 只有 `display_name` / `dbus_name` / `hwnd` ⇒ **无法设置 `DesktopEntry`**，
//!     于是 GNOME 媒体卡片拿不到本应用图标；
//!   - MPRIS 接口里**没有 `Capabilities` 属性**（`interfaces.rs` 只写了 CanXxx）；
//!   - `Seek` / `SetPosition` 它会发事件，但没有轨道 id 语义支撑。
//! 换成 `mpris-server 0.10`：完整实现 MediaPlayer2 / Player 两个接口，DesktopEntry、
//! Capabilities、Seek/SetPosition、Position 全都有。
//!
//! # 线程模型（重要）
//! `mpris_server::Player` 内部是 `Rc<LocalServer<..>>`（**!Send**），只能在单线程里用。
//! 所以这里自建一个 `mpris-player` 线程：current_thread 的 tokio runtime 上同时跑
//! 「zbus 服务（player.run()）」和「命令循环」，二者用 `tokio::select!` 合流。
//! 外部（前端命令线程）通过 std mpsc 送 `ProviderCmd`，由桥线程转成 tokio channel。

use std::sync::mpsc::Receiver;
use std::sync::{Mutex, OnceLock};

use mpris_server::{Metadata, PlaybackStatus, Player, Time, TrackId};
use tauri::{AppHandle, Emitter};

use crate::smtc::{ControlPayload, ProviderCmd};

/// MPRIS 总线名后缀（完整名 `org.mpris.MediaPlayer2.<suffix>`）。
const BUS_SUFFIX: &str = "andeyunhui";
/// 媒体卡片上显示的名字。
const IDENTITY: &str = "安得云荟";
/// 桌面文件名（GNOME 用它取图标；对应 `/usr/share/applications/andeyunhui.desktop`）。
const DESKTOP_ENTRY: &str = "andeyunhui";
/// 当前曲目的对象路径（单曲模型：轨道换了也只复用这一个 id，够 MPRIS 客户端做 seek 校验）。
const TRACK_PATH: &str = "/com/andeyunhui/track/current";

/// 发布端是否已就绪（与 smtc.rs 的 PROVIDER_READY 同义，供命令侧判断是否要补 init）。
static READY: OnceLock<bool> = OnceLock::new();

/// 仅用于诊断/幂等：是否已经起过线程。
static STARTED: Mutex<bool> = Mutex::new(false);

fn log(msg: &str) {
    eprintln!("[mpris/player] {msg}");
}

/// 启动 MPRIS 发布线程（幂等）。由 `smtc::provider_loop` 在 Linux 分支调用。
pub(crate) fn run_provider(app: AppHandle, rx: Receiver<ProviderCmd>) {
    {
        let mut started = STARTED.lock().unwrap();
        if *started {
            return;
        }
        *started = true;
    }

    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            log(&format!("tokio runtime 建立失败: {e}"));
            return;
        }
    };

    rt.block_on(async move {
        let mut builder = Player::builder(BUS_SUFFIX)
            .identity(IDENTITY)
            .desktop_entry(DESKTOP_ENTRY)
            .playback_status(PlaybackStatus::Stopped)
            .can_play(true)
            .can_pause(true)
            .can_seek(true)
            .can_go_next(true)
            .can_go_previous(true)
            .can_control(true)
            .can_raise(true)
            .can_quit(false)
            .has_track_list(false)
            .supported_uri_schemes(Vec::<String>::new())
            .supported_mime_types(Vec::<String>::new());

        // 初始元数据（空标题 = 没有曲目）
        builder = builder.metadata(Metadata::builder().build());

        let player = match builder.build().await {
            Ok(p) => p,
            Err(e) => {
                log(&format!("Player::build 失败（媒体卡片将不出现）: {e}"));
                return;
            }
        };

        wire_events(&app, &player);
        let _ = READY.set(true);
        log(&format!("MPRIS 已就绪: org.mpris.MediaPlayer2.{BUS_SUFFIX}"));

        // std mpsc → tokio channel 的桥（只有 1 个线程，开销可忽略）
        let (ctx, mut crx) = tokio::sync::mpsc::unbounded_channel::<ProviderCmd>();
        std::thread::Builder::new()
            .name("mpris-bridge".into())
            .spawn(move || {
                for cmd in rx {
                    if ctx.send(cmd).is_err() {
                        break;
                    }
                }
            })
            .ok();

        let mut server = Box::pin(player.run());
        loop {
            tokio::select! {
                _ = &mut server => {
                    log("zbus 服务已结束");
                    break;
                }
                cmd = crx.recv() => {
                    let Some(cmd) = cmd else { break };
                    apply(&player, cmd).await;
                }
            }
        }
    });
}

/// 把一条前端指令写进 MPRIS。
async fn apply(player: &Player, cmd: ProviderCmd) {
    match cmd {
        ProviderCmd::Update(info) => {
            let title = info.title.trim();
            let mut md = Metadata::builder().title(if title.is_empty() {
                "未知曲目".to_string()
            } else {
                info.title.clone()
            });
            if !info.artist.trim().is_empty() {
                md = md.artist(vec![info.artist.clone()]);
            }
            if !info.album.trim().is_empty() {
                md = md.album(info.album.clone());
            }
            if let Some(cover) = info.cover_path.as_deref().filter(|p| !p.is_empty()) {
                // 本地封面要转 file://；在线曲目的封面本身就是 URL —— 直接给 MPRIS，
                // 否则在线播放时卡片永远是音符占位（2026-10-24 用户实测）。
                let url = if cover.starts_with("http://") || cover.starts_with("https://") {
                    cover.to_string()
                } else {
                    crate::smtc::path_to_file_url(cover)
                };
                md = md.art_url(url);
            }
            if let Some(ms) = info.duration_ms {
                md = md.length(Time::from_millis(ms as i64));
            }
            let mut metadata = md.build();
            if let Ok(tid) = TrackId::try_from(TRACK_PATH) {
                metadata.set_trackid(Some(tid));
            }

            if let Err(e) = player.set_metadata(metadata).await {
                log(&format!("set_metadata 失败: {e}"));
            }

            let status = if info.is_playing {
                PlaybackStatus::Playing
            } else if title.is_empty() {
                PlaybackStatus::Stopped
            } else {
                PlaybackStatus::Paused
            };
            if let Err(e) = player.set_playback_status(status).await {
                log(&format!("set_playback_status 失败: {e}"));
            }
            if let Some(pos) = info.position_ms {
                // set_position 是非 async 的「通知型」setter（只发 PropertiesChanged，不返回 Result）
                player.set_position(Time::from_millis(pos as i64));
            }
            let _ = player.set_can_go_next(info.can_next).await;
            let _ = player.set_can_go_previous(info.can_prev).await;
        }
        ProviderCmd::Volume(v) => {
            // MPRIS Volume 是 0.0~1.0；前端可能给 0~100
            let norm = if v > 1.0 { v / 100.0 } else { v };
            if let Err(e) = player.set_volume(norm.clamp(0.0, 1.0)).await {
                log(&format!("set_volume 失败: {e}"));
            }
        }
    }
}

fn emit(app: &AppHandle, action: &str, value: Option<f64>) {
    let _ = app.emit(
        "smtc-control",
        ControlPayload {
            action: action.to_string(),
            // 与 Windows 侧一致：target 是当前活动模块（music/video），
            // 前端据此决定谁来响应（否则会两个播放器同时动作）。
            target: crate::smtc::active_module_or_music(),
            value,
        },
    );
}

/// 桌面媒体控件 → 前端 `smtc-control` 事件（与 Windows 侧同名字段契约）。
fn wire_events(app: &AppHandle, player: &Player) {
    let a = app.clone();
    player.connect_play(move |_| emit(&a, "play", None));
    let a = app.clone();
    player.connect_pause(move |_| emit(&a, "pause", None));
    let a = app.clone();
    player.connect_play_pause(move |_| emit(&a, "toggle", None));
    let a = app.clone();
    player.connect_stop(move |_| emit(&a, "stop", None));
    let a = app.clone();
    player.connect_next(move |_| emit(&a, "next", None));
    let a = app.clone();
    player.connect_previous(move |_| emit(&a, "previous", None));
    let a = app.clone();
    player.connect_raise(move |_| emit(&a, "raise", None));
    // 拖动进度：SetPosition 给绝对位置，Seek 给偏移。前端控制面里新增 `seek`，
    // value 一律是**绝对毫秒**（前端拿到就直接 seekTo），Seek 的偏移由这里先叠加。
    let a = app.clone();
    player.connect_set_position(move |p, _track, pos| {
        let ms = pos.as_millis() as f64;
        let _ = p; // 位置由前端回写，这里只转发
        emit(&a, "seek", Some(ms));
    });
    let a = app.clone();
    player.connect_seek(move |p, offset| {
        let cur = p.position().as_millis() as f64;
        emit(&a, "seek", Some((cur + offset.as_millis() as f64).max(0.0)));
    });
    // 音量：只转发给前端。属性回写由前端把新音量推回 smtc_update 时统一做
    // （apply() 里 set_volume）——回调用例是同步的，这里 await 不了。
    let a = app.clone();
    player.connect_set_volume(move |_p, vol| {
        emit(&a, "volume", Some(f64::from(vol)));
    });
}

/// 发布端是否已就绪（当前仅供诊断；smtc.rs 用 PROVIDER_READY 判定）。
#[allow(dead_code)]
pub(crate) fn is_ready() -> bool {
    READY.get().copied().unwrap_or(false)
}
