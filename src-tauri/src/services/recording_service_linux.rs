//! Linux 录屏后端：xdg-desktop-portal ScreenCast → PipeWire → ffmpeg 编码。
//!
//! # 为什么是这个架构
//!
//! Windows 侧用 `windows-capture`(WGC) 持续抓帧、进程内 libavcodec 或 ffmpeg.exe 编码
//! （见 `services/recording_service.rs`）。Linux 没有 WGC；且现代桌面（GNOME/KDE）多为
//! **Wayland** 会话 —— 纯 X11 抓屏（`ffmpeg -f x11grab`）在 Wayland 下抓不到别家窗口
//! （XWayland 根窗是空白）。唯一通吃 Wayland/X11 的正路是
//! **`org.freedesktop.portal.ScreenCast`**：由系统弹授权框让用户选「屏幕/窗口」，
//! 返回一个 **PipeWire 流**；本进程消费该流并把原始帧喂给随包分发的 ffmpeg 编成 MP4。
//!
//! 数据流：portal 授权 → 拿到 fd + node → `pipewire` 流按帧读取（BGRA）→ 有界通道
//! （丢旧保新）→ 写入线程唯一持有 ffmpeg stdin（**绝不在 pipewire 回调里直接写管道**，
//! 与 Windows 侧「回调阻塞 → 帧池耗尽 → 整机卡死」同款教训）→ ffmpeg 编码 → MP4。
//!
//! # 与 Windows 的差异（诚实标注）
//!
//! - **范围选择**：走 portal 原生弹窗（用户选显示器/窗口），不提供本应用自绘的框选覆盖层。
//!   故 `RECORDER_SELECT_LABEL` 覆盖窗在本平台不参与实际选区，仅保持前端契约（空实现）。
//! - **录制边框**：不实现（Linux 没有 WDA_EXCLUDEFROMCAPTURE 这类「对捕获隐藏本窗」的能力，
//!   画了也会被录进去，反而污染画面）。
//! - **音频**：v1 不采集系统音频（需另接 PipeWire monitor 源），先保证视频可用。
//! - **快捷键**：与 Windows 一致，用跨平台的 global-shortcut 注册。
//!
//! # 构建前置（仅 Linux 构建机）
//! `libpipewire-0.3-dev` + `libspa-0.2-dev`（pipewire crate 经 bindgen 生成绑定，另需 clang）。
//! 运行期只需系统 `libpipewire-0.3.so.0`（现代桌面默认自带）。

#![allow(dead_code)]

use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

// ----------------- 常量（与 Windows 版逐字一致，前端/capabilities 依赖这些 label）-----------------
pub const RECORDER_WINDOW_LABEL: &str = "recorder-widget";
pub const RECORDER_SELECT_LABEL: &str = "recorder-select";
pub const RECORDING_BORDER_LABEL: &str = "recording-border";
pub const DEFAULT_RECORDER_SHORTCUT: &str = "Ctrl+Alt+R";

/// 录屏状态（字段与 `serde(rename_all = "camelCase")` 都与 Windows 版一致）。
#[derive(Debug, Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub is_recording: bool,
    pub is_paused: bool,
    pub elapsed_secs: u64,
    pub output_path: String,
}

// ----------------- 录屏热键（与 Windows 版同型）-----------------
static RECORDER_SHORTCUT_STR: OnceLock<Mutex<String>> = OnceLock::new();

pub fn recorder_shortcut_state() -> &'static Mutex<String> {
    RECORDER_SHORTCUT_STR.get_or_init(|| Mutex::new(DEFAULT_RECORDER_SHORTCUT.to_string()))
}

fn recorder_shortcut_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("recorder_shortcut.json"))
}

pub fn read_recorder_shortcut(app: &AppHandle) -> String {
    if let Some(p) = recorder_shortcut_path(app) {
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
    DEFAULT_RECORDER_SHORTCUT.to_string()
}

fn write_recorder_shortcut(app: &AppHandle, sc: &str) -> Result<(), String> {
    let p = recorder_shortcut_path(app).ok_or_else(|| "无法获取 app_data 目录".to_string())?;
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&p, serde_json::json!({ "shortcut": sc }).to_string()).map_err(|e| e.to_string())
}

/// 注册录屏热键（复用 screenshot::parse_shortcut 解析）。
pub fn register_recorder_shortcut(app: &AppHandle, sc: &str) -> Result<(), String> {
    let shortcut = crate::screenshot::parse_shortcut(sc)?;
    app.global_shortcut()
        .register(shortcut)
        .map_err(|e| format!("注册录屏热键失败: {}", e))
}

#[tauri::command]
pub fn get_recorder_shortcut(app: AppHandle) -> String {
    let sc = read_recorder_shortcut(&app);
    if let Ok(mut state) = recorder_shortcut_state().lock() {
        *state = sc.clone();
    }
    sc
}

#[tauri::command]
pub fn set_recorder_shortcut(app: AppHandle, shortcut: String) -> Result<(), String> {
    let new = crate::screenshot::parse_shortcut(&shortcut)?;
    let old = recorder_shortcut_state()
        .lock()
        .map(|s| s.clone())
        .unwrap_or_else(|_| DEFAULT_RECORDER_SHORTCUT.to_string());

    if let Ok(old_sc) = crate::screenshot::parse_shortcut(&old) {
        let _ = app.global_shortcut().unregister(old_sc);
    }
    app.global_shortcut().register(new).map_err(|e| {
        if let Ok(old_sc) = crate::screenshot::parse_shortcut(&old) {
            let _ = app.global_shortcut().register(old_sc);
        }
        format!("注册失败（已回退原热键）: {}", e)
    })?;
    write_recorder_shortcut(&app, &shortcut)?;
    if let Ok(mut state) = recorder_shortcut_state().lock() {
        *state = shortcut;
    }
    Ok(())
}

// ----------------- 采集会话状态 -----------------
struct Session {
    stop: Arc<AtomicBool>,
    pause: Arc<AtomicBool>,
    started: Instant,
    /// 暂停起点时刻（毫秒；0 = 当前未暂停）
    pause_mark: Arc<Mutex<u64>>,
    /// 累计暂停时长（毫秒）
    paused_total: Arc<Mutex<u64>>,
    output: String,
    /// ffmpeg 子进程句柄（stop 时 kill 兜底）。
    child: Arc<Mutex<Option<Child>>>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

/// 解析随包 ffmpeg：优先 `external-deps/全局/ffmpeg/ffmpeg`（Linux 无 `.exe`），回退系统 PATH。
pub fn get_ffmpeg_path(app: &AppHandle) -> String {
    if let Some(dir) = crate::commands::get_ffmpeg_dir(app) {
        let ffmpeg = dir.join("ffmpeg");
        if ffmpeg.exists() {
            // 兜底：随包 .mujin 解压出的是普通文件，zip 解压不保证保留可执行位 →
            // 这里显式补一次 0755，避免「ffmpeg 在，但 spawn 报 permission denied」。
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&ffmpeg, std::fs::Permissions::from_mode(0o755));
            }
            return ffmpeg.to_string_lossy().to_string();
        }
    }
    "ffmpeg".to_string()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// portal 授权 + 拿到 PipeWire fd/node/尺寸。**必须在有 tokio runtime 的上下文里 await。**
async fn portal_acquire() -> Result<(std::os::fd::OwnedFd, u32, i32, i32), String> {
    use ashpd::desktop::screencast::{CursorMode, Screencast, SourceType};
    use ashpd::desktop::PersistMode;
    use ashpd::enumflags2::BitFlags;

    let proxy = Screencast::new().await.map_err(|e| format!("连接 xdg-desktop-portal 失败: {e}"))?;
    let session = proxy
        .create_session()
        .await
        .map_err(|e| format!("创建 ScreenCast 会话失败: {e}"))?;

    // 原生选择弹窗：让用户选显示器（v1 仅显示器；窗口可选但不做多源管理）。
    proxy
        .select_sources(
            &session,
            CursorMode::Embedded,
            BitFlags::from(SourceType::Monitor | SourceType::Window),
            false,
            None,
            PersistMode::DoNot,
        )
        .await
        .map_err(|e| format!("配置录屏源失败: {e}"))?
        .response()
        .map_err(|e| format!("录屏源选择被拒绝或失败: {e}"))?;

    let streams = proxy
        .start(&session, None)
        .await
        .map_err(|e| format!("启动录屏会话失败: {e}"))?
        .response()
        .map_err(|e| format!("录屏启动被拒绝或失败: {e}"))?;

    let first = streams
        .streams()
        .first()
        .ok_or_else(|| "portal 未返回任何流".to_string())?;
    let node_id = first.pipe_wire_node_id();
    let (w, h) = first.size().unwrap_or((0, 0));

    let fd = proxy
        .open_pipe_wire_remote(&session)
        .await
        .map_err(|e| format!("获取 PipeWire 远端 fd 失败: {e}"))?;

    // 会话必须保活到录制结束：把 session/proxy 通过泄漏（mem::forget 等价）延续到进程级。
    // portal 会话在 D-Bus 连接断开时自动结束，故只要连接在（zbus 自持）会话就在。
    std::mem::forget(session);

    if w <= 0 || h <= 0 {
        return Err(format!("portal 返回的流尺寸无效: {w}x{h}"));
    }
    Ok((fd, node_id, w, h))
}

/// 启动录屏：portal 授权 → 起 ffmpeg → PipeWire 取帧写管道。
#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    output_path: String,
    fps: Option<u32>,
    _monitor_index: Option<usize>,
    _region_x: Option<i32>,
    _region_y: Option<i32>,
    _region_w: Option<i32>,
    _region_h: Option<i32>,
) -> Result<(), String> {
    {
        let guard = SESSION.lock().map_err(|_| "录屏状态锁中毒".to_string())?;
        if guard.is_some() {
            return Err("已有录制进行中".to_string());
        }
    }

    let fps = fps.unwrap_or(30).clamp(5, 120);
    let ffmpeg = get_ffmpeg_path(&app);

    let stop = Arc::new(AtomicBool::new(false));
    let pause = Arc::new(AtomicBool::new(false));
    let pause_mark = Arc::new(Mutex::new(0u64));
    let paused_total = Arc::new(Mutex::new(0u64));
    let child_slot: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));

    let stop_c = stop.clone();
    let pause_c = pause.clone();
    let child_c = child_slot.clone();
    let out_c = output_path.clone();
    let ffmpeg_c = ffmpeg.clone();

    // 采集线程：portal 授权（阻塞等待用户点弹窗）→ pipewire 主循环取帧。
    std::thread::Builder::new()
        .name("linux-recorder".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(e) => {
                    eprintln!("[录屏/linux] 创建 tokio runtime 失败: {e}");
                    return;
                }
            };

            let acquired = rt.block_on(portal_acquire());
            let (fd, node_id, w, h) = match acquired {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[录屏/linux] ❌ {e}");
                    return;
                }
            };

            if let Err(e) = run_capture(fd, node_id, w, h, fps, &ffmpeg_c, &out_c, &stop_c, &pause_c, &child_c) {
                eprintln!("[录屏/linux] ❌ 采集结束（异常）: {e}");
            }
            // rt / session 保活到线程结束
            drop(rt);
        })
        .map_err(|e| format!("创建录屏线程失败: {e}"))?;

    let mut guard = SESSION.lock().map_err(|_| "录屏状态锁中毒".to_string())?;
    *guard = Some(Session {
        stop,
        pause,
        started: Instant::now(),
        pause_mark,
        paused_total,
        output: output_path,
        child: child_slot,
    });
    Ok(())
}

/// 同步跑完「起 ffmpeg → 消费 PipeWire 流 → 收尾」。
#[allow(clippy::too_many_arguments)]
fn run_capture(
    fd: std::os::fd::OwnedFd,
    node_id: u32,
    width: i32,
    height: i32,
    fps: u32,
    ffmpeg: &str,
    output: &str,
    stop: &Arc<AtomicBool>,
    pause: &Arc<AtomicBool>,
    child_slot: &Arc<Mutex<Option<Child>>>,
) -> Result<(), String> {
    use pipewire as pw;

    // 1) ffmpeg：rawvideo(BGRA) → H.264/MP4
    let mut child = Command::new(ffmpeg)
        .args([
            "-hide_banner", "-loglevel", "error", "-y",
            "-f", "rawvideo", "-pix_fmt", "bgra",
            "-s", &format!("{width}x{height}"),
            "-r", &fps.to_string(),
            "-i", "-",
            "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            output,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动 ffmpeg 失败（{ffmpeg}）: {e}"))?;
    let mut stdin = child.stdin.take().ok_or_else(|| "无法获取 ffmpeg stdin".to_string())?;
    if let Ok(mut slot) = child_slot.lock() {
        *slot = Some(child);
    }

    // 2) 有界通道 + 唯一写线程（回调绝不阻塞）
    let frame_bytes = (width as usize) * (height as usize) * 4;
    let (tx, rx): (SyncSender<Vec<u8>>, _) = sync_channel(3);
    let writer = std::thread::Builder::new()
        .name("linux-recorder-writer".into())
        .spawn(move || {
            use std::io::Write;
            while let Ok(buf) = rx.recv() {
                if stdin.write_all(&buf).is_err() {
                    break;
                }
            }
            let _ = stdin.flush();
        })
        .map_err(|e| format!("创建写入线程失败: {e}"))?;

    // 3) PipeWire：连 fd → 建流连到 portal 给的 node → 逐帧拷贝送通道
    let result = (|| -> Result<(), String> {
        let mainloop = pw::main_loop::MainLoop::new(None).map_err(|e| format!("创建 PipeWire MainLoop 失败: {e}"))?;
        let context = pw::context::Context::new(&mainloop).map_err(|e| format!("创建 PipeWire Context 失败: {e}"))?;
        let core = context
            .connect_fd(fd, None)
            .map_err(|e| format!("连接 PipeWire fd 失败: {e}"))?;

        let stream = pw::stream::Stream::new(
            &core,
            "andeyunhui-capture",
            pw::properties::properties! {
                *pw::keys::MEDIA_TYPE => "Video",
                *pw::keys::MEDIA_CATEGORY => "Capture",
                *pw::keys::MEDIA_ROLE => "Screen",
            },
        )
        .map_err(|e| format!("创建 PipeWire Stream 失败: {e}"))?;

        let tx_cb = tx.clone();
        let pause_cb = pause.clone();
        let _listener = stream
            .add_local_listener_with_user_data(frame_bytes)
            .process(move |stream, user: &mut usize| {
                if pause_cb.load(Ordering::Relaxed) {
                    return; // 暂停：取走缓冲但丢弃，避免管道回压
                }
                let Some(mut buffer) = stream.dequeue_buffer() else { return };
                let datas = buffer.datas_mut();
                if datas.is_empty() {
                    return;
                }
                let d0 = &mut datas[0];
                let size = d0.chunk().size() as usize;
                if let Some(slice) = d0.data() {
                    let n = size.min(slice.len()).min(*user);
                    // 丢旧保新：通道满则丢弃本帧，绝不阻塞 PipeWire 线程
                    let _ = tx_cb.try_send(slice[..n].to_vec());
                }
            })
            .register()
            .map_err(|e| format!("注册 PipeWire 回调失败: {e}"))?;

        // 构造 EnumFormat：mediaType=video / mediaSubtype=raw / format=BGRA / size / framerate。
        // ⚠ libspa 的 VideoInfoRaw **没有** Into<Vec<Property>>（只有 audio 的 AudioInfoRaw 有），
        //   故这里手写属性列表，与 libspa 内 audio 的 `From<AudioInfoRaw> for Vec<Property>` 同构。
        use pw::spa::param::format::{FormatProperties, MediaSubtype, MediaType};
        use pw::spa::param::video::VideoFormat;
        use pw::spa::pod::{Property, Value};
        use pw::spa::utils::{Fraction, Id, Rectangle};
        let props = vec![
            Property::new(FormatProperties::MediaType.as_raw(), Value::Id(Id(MediaType::Video.as_raw()))),
            Property::new(FormatProperties::MediaSubtype.as_raw(), Value::Id(Id(MediaSubtype::Raw.as_raw()))),
            Property::new(FormatProperties::VideoFormat.as_raw(), Value::Id(Id(VideoFormat::BGRA.as_raw()))),
            Property::new(FormatProperties::VideoSize.as_raw(), Value::Rectangle(Rectangle { width: width as u32, height: height as u32 })),
            Property::new(FormatProperties::VideoFramerate.as_raw(), Value::Fraction(Fraction { num: fps, denom: 1 })),
        ];
        let values: Vec<u8> = pw::spa::pod::serialize::PodSerializer::serialize(
            std::io::Cursor::new(Vec::new()),
            &pw::spa::pod::Value::Object(pw::spa::pod::Object {
                type_: pw::spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
                id: pw::spa::param::ParamType::EnumFormat.as_raw(),
                properties: props,
            }),
        )
        .map_err(|e| format!("序列化 PipeWire 格式失败: {e}"))?
        .0
        .into_inner();

        let mut params = [pw::spa::pod::Pod::from_bytes(&values)
            .ok_or_else(|| "PipeWire 格式 Pod 解析失败".to_string())?];

        stream
            .connect(
                pw::spa::utils::Direction::Input,
                Some(node_id),
                pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
                &mut params,
            )
            .map_err(|e| format!("连接 PipeWire 目标节点失败: {e}"))?;

        // 停止哨兵：主循环内定时器（200ms 一跳）检查 stop → 退出主循环。
        // 不能用独立线程持 MainLoop/WeakMainLoop —— 它们基于 Rc、非 Send，不能跨线程。
        let timer = mainloop.loop_().add_timer({
            let ml = mainloop.clone();
            let stop_poll = stop.clone();
            move |_expirations: u64| {
                if stop_poll.load(Ordering::Relaxed) {
                    ml.quit();
                }
            }
        });
        let _ = timer.update_timer(Some(Duration::from_millis(200)), Some(Duration::from_millis(200)));

        mainloop.run(); // 阻塞直到 quit()
        let _keep_timer_alive = &timer;
        Ok(())
    })();

    // 4) 收尾：结束写线程 → 关 ffmpeg stdin → 回收进程
    drop(tx);
    let _ = writer.join();
    if let Ok(mut slot) = child_slot.lock() {
        if let Some(mut c) = slot.take() {
            let _ = c.wait();
        }
    }

    result
}

#[tauri::command]
pub async fn stop_recording(app: AppHandle) -> Result<String, String> {
    let session = {
        let mut guard = SESSION.lock().map_err(|_| "录屏状态锁中毒".to_string())?;
        guard.take()
    };
    let Some(s) = session else {
        return Err("当前没有录制进行中".to_string());
    };
    // 通知采集线程退出主循环；采集线程在收尾时会 take 掉 child 槽位。
    s.stop.store(true, Ordering::Relaxed);

    // 等采集线程收尾（含 portal 弹窗仍挂着的最坏情况）；超时则强杀 ffmpeg 兜底。
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let finished = s.child.lock().map(|slot| slot.is_none()).unwrap_or(true);
        if finished || Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if let Ok(mut slot) = s.child.lock() {
        if let Some(child) = slot.as_mut() {
            if let Ok(None) = child.try_wait() {
                let _ = child.kill();
            }
        }
    }
    let _ = app; // 预留：后续可持久化 restore_token
    Ok(s.output)
}

#[tauri::command]
pub fn pause_recording() -> Result<(), String> {
    let guard = SESSION.lock().map_err(|_| "录屏状态锁中毒".to_string())?;
    let Some(s) = guard.as_ref() else {
        return Err("当前没有录制进行中".to_string());
    };
    // 记录暂停起点（仅首次，重复调用幂等）
    if let Ok(mut m) = s.pause_mark.lock() {
        if *m == 0 {
            *m = now_ms();
        }
    }
    s.pause.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn resume_recording() -> Result<(), String> {
    let guard = SESSION.lock().map_err(|_| "录屏状态锁中毒".to_string())?;
    let Some(s) = guard.as_ref() else {
        return Err("当前没有录制进行中".to_string());
    };
    let mark = s.pause_mark.lock().map(|m| *m).unwrap_or(0);
    if mark > 0 {
        if let Ok(mut acc) = s.paused_total.lock() {
            *acc += now_ms().saturating_sub(mark);
        }
        if let Ok(mut m) = s.pause_mark.lock() {
            *m = 0;
        }
    }
    s.pause.store(false, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn get_recording_status() -> RecordingStatus {
    let Ok(guard) = SESSION.lock() else {
        return RecordingStatus::default();
    };
    match guard.as_ref() {
        None => RecordingStatus::default(),
        Some(s) => {
            let paused = s.pause.load(Ordering::Relaxed);
            // 真正录制时长 = 已流逝 - 累计暂停（含当前这次进行中的暂停）
            let acc = s.paused_total.lock().map(|v| *v).unwrap_or(0);
            let ongoing = if paused {
                s.pause_mark.lock().map(|m| now_ms().saturating_sub(*m)).unwrap_or(0)
            } else {
                0
            };
            let elapsed = (s.started.elapsed().as_millis() as u64).saturating_sub(acc + ongoing) / 1000;
            RecordingStatus {
                is_recording: true,
                is_paused: paused,
                elapsed_secs: elapsed,
                output_path: s.output.clone(),
            }
        }
    }
}

// ----------------- 录屏浮窗（保持前端契约）-----------------
#[tauri::command]
pub async fn show_recorder_widget(app: AppHandle) -> Result<(), String> {
    if app.get_webview_window(RECORDER_WINDOW_LABEL).is_none() {
        let win = WebviewWindowBuilder::new(
            &app,
            RECORDER_WINDOW_LABEL,
            WebviewUrl::App("recorder-widget.html".into()),
        )
        .title("录屏")
        .inner_size(320.0, 52.0)
        .decorations(false)
        .always_on_top(true)
        .transparent(true)
        .resizable(false)
        .visible(false)
        .build()
        .map_err(|e| format!("创建录屏控制台失败: {e}"))?;
        // 定位到主显示器底部居中后显示
        if let Ok(Some(mon)) = app.primary_monitor() {
            let size = mon.size();
            let scale = mon.scale_factor();
            let lw = size.width as f64 / scale;
            let lh = size.height as f64 / scale;
            let _ = win.set_position(tauri::LogicalPosition::new((lw - 320.0) / 2.0, lh - 120.0));
        }
        let _ = win.show();
    } else if let Some(w) = app.get_webview_window(RECORDER_WINDOW_LABEL) {
        let _ = w.show();
    }
    Ok(())
}

#[tauri::command]
pub fn hide_recorder_widget(app: AppHandle) {
    if let Some(w) = app.get_webview_window(RECORDER_WINDOW_LABEL) {
        let _ = w.hide();
    }
}

/// Linux 走 portal 原生选区，自绘选择覆盖窗不参与实际选区；保持命令存在（前端契约）。
#[tauri::command]
pub async fn show_recorder_select(_app: AppHandle) -> Result<(), String> {
    Err("Linux 下由系统 portal 弹窗选择录制区域，无需自绘选择层".into())
}

#[tauri::command]
pub fn hide_recorder_select(_app: AppHandle) {}

#[tauri::command]
pub fn get_recorder_select_coords(_app: AppHandle) -> Result<serde_json::Value, String> {
    Err("Linux 下无自绘选区坐标（由 portal 决定）".into())
}

/// 转 GIF：复用随包 ffmpeg（两段式调色板，得到较好的 GIF）。
#[tauri::command]
pub async fn convert_recording_to_gif(app: AppHandle, mp4_path: String) -> Result<String, String> {
    let ffmpeg = get_ffmpeg_path(&app);
    let out = std::path::Path::new(&mp4_path)
        .with_extension("gif")
        .to_string_lossy()
        .to_string();
    let filter = "fps=12,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse";
    let status = Command::new(&ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i", &mp4_path, "-vf", filter, &out])
        .status()
        .map_err(|e| format!("启动 ffmpeg 失败: {e}"))?;
    if !status.success() {
        return Err("ffmpeg 转 GIF 失败".into());
    }
    Ok(out)
}

#[tauri::command]
pub fn delete_recording_file(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|e| format!("删除文件失败: {e}"))
}
