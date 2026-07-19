// Windows 任务栏「正在播放」媒体控件 —— Rust 自有 SMTC 会话。
//
// 背景：WebView2/Chromium 播放音频/视频时会在系统注册一个媒体会话，但它跑在
// msedgewebview2.exe 子进程里，既不继承主进程显示名（→ 任务栏显「未知应用」），
// 也不会把系统媒体键（键盘/触摸板/任务栏）回传给我们。仅靠 JS navigator.mediaSession
// 无法纠正这两点。
//
// 正解：用 WinRT 的 Windows.Media.SystemMediaTransportControls，通过
// ISystemMediaTransportControlsInterop::GetForWindow(主窗口 HWND) 在我们自己的
// 进程里创建一个媒体会话。该会话：
//   1) 使用我们设置的 AUMID + 注册表显示名「岸灯鸢花」→ 任务栏正确显示应用名；
//   2) 元信息（标题/艺术家/专辑）由前端经 smtc_update 命令推送；
//   3) 系统媒体键通过 ButtonPressed 事件回传前端（smtc-control 事件）。
//
// 仅 Windows 生效；其余平台为 no-op。

use serde::Deserialize;
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

/// 媒体键事件投递给前端的载荷：action=按键名，target=当前应响应的模块（music/video）。
/// 之前直接 emit 字符串 action，导致 music/video 两个监听器都响应；改为带 target 后，
/// 各监听器只处理 target 与自身一致的事件，实现"按键只给任务栏当前展示的那个模块"。
#[derive(serde::Serialize, Clone, Debug)]
pub struct SmtcControl {
    pub action: String,
    pub target: String,
}

/// 前端推送到 Rust 的媒体状态。
#[derive(Deserialize, Clone, Debug, Default)]
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
}

/// 诊断用：返回 Rust 端 SMTC 会话的真实运行状态。
#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct SmtcStatus {
    /// 本进程媒体会话是否已创建（GetForWindow 成功）。
    pub session_created: bool,
    /// 主窗口 HWND 的 AUMID 属性是否成功写入（任务栏据此解析显示名）。
    pub window_aumid_set: bool,
    /// 进程级 AUMID 常量（仅回声，不验证是否真正生效）。
    pub aumid: String,
    /// 真正回读进程级 AUMID（GetCurrentProcessExplicitAppUserModelID）。
    /// 空=SetCurrentProcessExplicitAppUserModelID 未生效→窗口不继承 AUMID→任务栏显「未知应用」。
    /// 这是判定「未知应用」真因的决定性字段。
    pub process_aumid: String,
    /// 当前前端上报的激活模块。
    pub active_module: String,
    /// 最近一次推送的音乐标题（空=从未推送/被兜底）。
    pub last_music_title: String,
    /// 最近一次推送的视频标题。
    pub last_video_title: String,
    /// 最近一次 apply 的播放态（true=Playing, false=Paused, None=Stopped/未应用）。
    pub last_status_playing: Option<bool>,
    /// 探针：apply_priority 实际写入的会话 IsEnabled（true 才会在任务栏出现媒体控件）。
    pub is_enabled: bool,
    /// 探针：apply_priority 实际写入的 PlaybackStatus（Playing/Paused/Stopped/Closed）。
    pub playback_status: String,
    /// 探针：顶层窗口（任务栏窗口）真实 AUMID 属性，任务栏据此解析显示名。
    pub actual_top_aumid: String,
    /// 探针：注册表 DisplayName，任务栏应能解析到的应用名。
    pub reg_displayname: String,
    /// 系统里所有活动媒体会话的 AUMID（含 WebView2 的 MSEdge）。用于确认是否出现双卡片。
    pub system_sessions: Vec<String>,
}

/// 精简诊断（同步字段，无需枚举系统会话），事件化暴露到前端日志，
/// 便于在打包版通过 file-logger 观察真实运行状态（终端 [SMTC-DIAG] 在打包版不可见）。
#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct SmtcDiag {
    /// 本进程 SMTC 会话是否已创建（GetForWindow 成功）。false→任务栏只剩 WebView2 的卡。
    pub session_created: bool,
    /// 回读进程级 AUMID。空=SetCurrentProcessExplicitAppUserModelID 未生效→卡片显「未知应用」。
    pub process_aumid: String,
    /// 顶层窗口真实 AUMID 属性（任务栏据此解析显示名）。应为 com.andengyuanhua.desktop。
    pub window_aumid: String,
    /// 注册表 DisplayName，任务栏应能解析到的应用名（应为「岸灯鸢花」）。
    pub reg_displayname: String,
    /// apply_priority 实际写入的 IsEnabled（true 才会在任务栏出现媒体控件）。
    pub is_enabled: bool,
    /// apply_priority 实际写入的 PlaybackStatus。
    pub playback_status: String,
    /// 系统里所有活动媒体会话的 AUMID（含 WebView2 的）。播放时若多出非 ours 的条目，
    /// 说明 WebView2 仍会建「未知应用」卡，需另寻压制手段。
    pub system_sessions: Vec<String>,
}

#[cfg(windows)]
mod imp {
    use super::*;
    use tauri::{Emitter, Manager};
    use windows::{
        core::*,
        Foundation::TypedEventHandler,
        Media::{
            MediaPlaybackStatus, MediaPlaybackType, SystemMediaTransportControls,
            SystemMediaTransportControlsButton, SystemMediaTransportControlsButtonPressedEventArgs,
        },
        Win32::Foundation::{ERROR_SUCCESS, HWND, LPARAM, RPC_E_CHANGED_MODE},
        Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID,
        Win32::System::Com::StructuredStorage::{PROPVARIANT, PROPVARIANT_0_0},
        Win32::System::Com::CoTaskMemFree,
        Win32::System::Registry::*,
        Win32::System::Variant::VT_LPWSTR,
        Win32::System::WinRT::{
            ISystemMediaTransportControlsInterop, RoGetActivationFactory, RoInitialize,
            RO_INIT_SINGLETHREADED,
        },
        Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow},
        Win32::UI::Shell::{GetCurrentProcessExplicitAppUserModelID, SetCurrentProcessExplicitAppUserModelID},
        Win32::UI::WindowsAndMessaging::{EnumChildWindows, GA_ROOT, GetAncestor},
        Storage::Streams::{DataWriter, InMemoryRandomAccessStream, RandomAccessStreamReference},
        core::{PCWSTR, PWSTR},
    };
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager, SessionsChangedEventArgs,
    };

    /// 本进程 AppUserModelID：SMTC 据此在任务栏解析显示名。
    /// 【关键】必须与 NSIS 安装器写到开始菜单/桌面快捷方式上的 AUMID 完全一致，否则
    /// Windows「正在播放」浮窗按【会话 AUMID → 已安装应用（快捷方式）】解析不到应用，
    /// 就会显「未知应用」。Tauri NSIS 用 bundle identifier（tauri.conf.json 的 identifier
    /// = com.rosary.andengyuanhua）作为快捷方式 AUMID，故 release 必须用它。
    /// dev（debug）无安装快捷方式，AUMID 无从解析，任务栏必然显「未知应用」——这是
    /// 开发态固有限制，只有打包安装版才能正确显示「岸灯鸢花」。
    const AUMID: &str = if cfg!(debug_assertions) {
        "com.rosary.andengyuanhua.dev"
    } else {
        "com.rosary.andengyuanhua"
    };
    /// 与 AUMID 对应的注册表显示名（任务栏据此显示应用名）。
    const DISPLAY_NAME: &str = if cfg!(debug_assertions) {
        "岸灯鸢花·测试"
    } else {
        "岸灯鸢花"
    };

    /// 本进程拥有的系统媒体会话（应用生命周期内常驻）。
    static SMTC: OnceLock<SystemMediaTransportControls> = OnceLock::new();
    /// 用于在媒体键回调中向前端 emit 事件。
    static APP: OnceLock<AppHandle> = OnceLock::new();
    static IDENTITY_DONE: OnceLock<()> = OnceLock::new();
    /// 按来源分别缓存最近一次有效元信息（各自维护标题兜底），避免任务栏显示 AUMID/空白。
    static LAST_MUSIC: OnceLock<Mutex<SmtcUpdate>> = OnceLock::new();
    static LAST_VIDEO: OnceLock<Mutex<SmtcUpdate>> = OnceLock::new();
    /// 模块是否已被激活（至少播放过一次）。激活后直到进程退出前保持。
    static MUSIC_ACTIVATED: OnceLock<Mutex<bool>> = OnceLock::new();
    static VIDEO_ACTIVATED: OnceLock<Mutex<bool>> = OnceLock::new();
    /// 当前激活模块（前端经 set_active_module 上报）。视频模块时视频优先，其余音乐优先。
    static ACTIVE_MODULE: OnceLock<Mutex<String>> = OnceLock::new();
    /// 主窗口是否隐藏（最小化/托盘）。隐藏时强制音乐优先。
    static WINDOW_HIDDEN: OnceLock<Mutex<bool>> = OnceLock::new();
    use std::cell::RefCell;

    // 按钮事件处理器需要在线程内保活，否则 WinRT 回调会失效。用 thread_local 存放
    // 非 Sync 的 TypedEventHandler，避免静态需要 Sync 的约束。
    thread_local! {
        static BUTTON_HANDLER: RefCell<Option<TypedEventHandler<SystemMediaTransportControls, SystemMediaTransportControlsButtonPressedEventArgs>>> = RefCell::new(None);
    }
    /// 窗口 HWND 的 AUMID 属性是否成功写入（诊断用）。
    static WINDOW_AUMID_SET: OnceLock<bool> = OnceLock::new();
    /// 顶层窗口 HWND（任务栏按钮所在窗口）的原始指针值，供探针读回 AUMID 属性。
    static TOP_HWND: OnceLock<isize> = OnceLock::new();
    /// 最近一次 apply 的播放态（Playing/Paused/Stopped），用于状态查询。
    static LAST_STATUS_PLAYING: OnceLock<Mutex<Option<bool>>> = OnceLock::new();
    /// 探针用：apply_priority 实际写入的会话 IsEnabled（反映任务栏媒体控件是否会出现）。
    static LAST_IS_ENABLED: OnceLock<Mutex<bool>> = OnceLock::new();
    /// 探针用：apply_priority 实际写入的 PlaybackStatus 文本（Playing/Paused/Stopped/Closed）。
    static LAST_PLAYBACK_STATUS: OnceLock<Mutex<String>> = OnceLock::new();

    /// 确保当前线程已初始化 Windows Runtime，并正确处理公寓模型冲突。
    /// 关键陷阱：tauri/winit 在主线程经 OleInitialize 把线程置于 STA。若此后再调用
    /// RoInitialize(RO_INIT_MULTITHREADED) 会返回 RPC_E_CHANGED_MODE，且【不会】初始化
    /// WinRT——于是 RoGetActivationFactory / GetForWindow 全部失败，媒体会话建不出来，
    /// 任务栏只剩 WebView2 的「未知应用」卡片。故先尝试 STA（与已在 STA 的主线程兼容，
    /// 返回 S_FALSE 视为成功），仅当因模式冲突时才退回 MTA。
    fn ensure_winrt() {
        unsafe {
            if let Err(e) = RoInitialize(RO_INIT_SINGLETHREADED) {
                if e.code() == RPC_E_CHANGED_MODE {
                    ensure_winrt();
                }
            }
        }
    }

    /// 设置进程 AUMID + 注册表显示名。幂等（仅执行一次）。
    pub fn set_app_identity() {
        let _ = IDENTITY_DONE.get_or_init(|| {
            // 注意：此处【不能】调用 CoInitializeEx/RoInitialize 初始化 COM 公寓模型。
            // 本函数在 main() 最开头（早于 tao 创建窗口）就会被 ensure_app_identity() 调用，
            // 若在此把主线程设为 MTA，tao 随后 OleInitialize（要求 STA）会 RPC_E_CHANGED_MODE panic。
            // SetCurrentProcessExplicitAppUserModelID 与注册表写入均为纯 Win32 调用，无需 COM 初始化。
            let aumid_w: Vec<u16> = AUMID.encode_utf16().chain(std::iter::once(0)).collect();
            unsafe {
                let hr = SetCurrentProcessExplicitAppUserModelID(PCWSTR(aumid_w.as_ptr()));
                if hr.is_ok() {
                    log::info!("[SMTC] SetCurrentProcessExplicitAppUserModelID 成功 AUMID={}", AUMID);
                } else {
                    log::warn!("[SMTC] SetCurrentProcessExplicitAppUserModelID 失败 hr={hr:?}（进程 AUMID 未设，任务栏可能显「未知应用」）");
                }
            }
            let sub = format!("Software\\Classes\\AppUserModelId\\{}", AUMID);
            let sub_w: Vec<u16> = sub.encode_utf16().chain(std::iter::once(0)).collect();
            let mut hkey = HKEY::default();
            unsafe {
                if RegCreateKeyW(HKEY_CURRENT_USER, PCWSTR(sub_w.as_ptr()), &mut hkey).is_ok() {
                    set_reg_sz(hkey, "DisplayName", DISPLAY_NAME);
                    if let Ok(exe) = std::env::current_exe() {
                        if let Some(s) = exe.to_str() {
                            set_reg_sz(hkey, "Icon", s);
                        }
                    }
                    let _ = RegCloseKey(hkey);
                }
            }
            log::info!("[SMTC] 已设置进程 AUMID={} 与显示名「岸灯鸢花」", AUMID);
        });
    }

    /// 重新声明本进程 AUMID（幂等：已设置过会返回错误，忽略即可）。
    /// 在 init 中、创建 SMTC 会话之前再次调用，确保会话创建时能读到正确的进程级 AUMID。
    /// 这能兜底 main() 里 ensure_app_identity() 的调用因某种时序/公寓模型原因未粘住的情况——
    /// 进程 AUMID 一旦为空，本会话的「正在播放」卡片会按 exe 默认 AUMID 解析，显「未知应用」。
    fn reassert_process_aumid() {
        let aumid_w: Vec<u16> = AUMID.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let _ = SetCurrentProcessExplicitAppUserModelID(PCWSTR(aumid_w.as_ptr()));
        }
    }

    /// 创建本进程拥有的系统媒体会话，并注册媒体键回调。
    pub fn init(app: &AppHandle) {
        let _ = APP.set(app.clone());
        set_app_identity();
        // 确保当前线程已初始化 WinRT（MTA），后续命令线程也会各自 RoInitialize。
        ensure_winrt();

        let raw = match app.get_webview_window("main").and_then(|w| w.hwnd().ok()) {
            Some(h) => HWND(h.0 as *mut std::ffi::c_void),
            None => {
                eprintln!("[SMTC-DIAG] 无法获取主窗口 HWND，跳过系统媒体会话创建");
                emit_diag(app);
                return;
            }
        };

        // Tauri v2 的 WebviewWindow::hwnd() 返回的是 WebView2 子控件 HWND，而任务栏按钮挂在
        // 【顶层窗口】上。SMTC 会话与 AUMID 属性必须设在顶层窗口，任务栏才能解析出「岸灯鸢花」。
        // 用 GetAncestor(GA_ROOT) 取顶层窗口（对顶层窗口自身调用也返回自身，安全）。
        let hwnd = top_level(raw);
        let _ = TOP_HWND.set(hwnd.0 as isize);
        // 探针：确认 Tauri v2 WebviewWindow::hwnd() 是否返回了 webview 子控件 HWND（根因假设）。
        if (raw.0 as isize) != (hwnd.0 as isize) {
            eprintln!("[SMTC-DIAG] 探针 WebviewWindow::hwnd 实为子控件 HWND，已用顶层窗口替代（raw≠top）");
        } else {
            eprintln!("[SMTC-DIAG] 探针 WebviewWindow::hwnd 即顶层窗口 HWND（raw==top）");
        }
        set_window_aumid(raw); // 顺手写在 webview 子窗口上（无害）
        set_window_aumid(hwnd); // 关键：写在顶层窗口（任务栏窗口）上

        // 探针：读回顶层窗口真实 AUMID 属性 + 注册表 DisplayName，确认任务栏应能解析到的名字。
        match read_window_aumid(hwnd) {
            Some(a) => eprintln!("[SMTC-DIAG] 顶层窗口 AUMID 属性 = {a}"),
            None => eprintln!("[SMTC-DIAG] 顶层窗口未读到 AUMID 属性（任务栏可能显「未知应用」）"),
        }
        match read_reg_displayname() {
            Some(d) => eprintln!("[SMTC-DIAG] 注册表 DisplayName = {d}"),
            None => eprintln!("[SMTC-DIAG] 注册表无 DisplayName（任务栏将显「未知应用」或 AUMID 字符串）"),
        }

        // 在创建 SMTC 会话之前，兜底重新声明一次进程级 AUMID（确保会话能读到，而非 exe 默认 AUMID）。
        reassert_process_aumid();
        // 诊断：回读进程级 AUMID，确认 SetCurrentProcessExplicitAppUserModelID 是否真正生效。
        // 空 → 进程无 AUMID → 本会话卡片必显「未知应用」（任务栏按进程 AUMID 解析显示名）。
        // 这是判定「未知应用」真因的决定性日志，无需再开 DevTools 探针。
        let pa = read_process_aumid();
        if pa.is_empty() {
            eprintln!("[SMTC-DIAG] 进程级 AUMID 回读为空！SetCurrentProcessExplicitAppUserModelID 未生效 → 卡片必显「未知应用」");
        } else {
            eprintln!("[SMTC-DIAG] 进程级 AUMID 回读={}（与窗口属性/注册表一致，卡片应显示「岸灯鸢花」）", pa);
        }

        let interop: ISystemMediaTransportControlsInterop =
            match unsafe { RoGetActivationFactory(&HSTRING::from("Windows.Media.SystemMediaTransportControls")) } {
                Ok(i) => i,
                Err(e) => {
                    eprintln!("[SMTC-DIAG] 获取 ISystemMediaTransportControlsInterop 失败: {e:?}");
                    emit_diag(app);
                    return;
                }
            };

        let smtc: SystemMediaTransportControls =
            match unsafe { interop.GetForWindow::<SystemMediaTransportControls>(hwnd) } {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[SMTC-DIAG] GetForWindow 创建媒体会话失败: {e:?}");
                    emit_diag(app);
                    return;
                }
            };

        // 会话初始为禁用，直到某个模块至少播放过一次后才启用（避免未激活模块导致任务栏占位）
        let _ = smtc.SetIsEnabled(false);
        let _ = smtc.SetPlaybackStatus(MediaPlaybackStatus::Stopped);
        let _ = smtc.SetIsPlayEnabled(true);
        let _ = smtc.SetIsPauseEnabled(true);
        let _ = smtc.SetIsStopEnabled(true);
        let _ = smtc.SetIsNextEnabled(true);
        let _ = smtc.SetIsPreviousEnabled(true);

        // 系统媒体键 → 向前端 emit smtc-control 事件。
        let handler = TypedEventHandler::<SystemMediaTransportControls, SystemMediaTransportControlsButtonPressedEventArgs>::new(|_sender, args| {
            if let (Some(app), Some(args)) = (APP.get(), args.as_ref()) {
                if let Ok(btn) = args.Button() {
                    let name = match btn {
                        SystemMediaTransportControlsButton::Play => "play",
                        SystemMediaTransportControlsButton::Pause => "pause",
                        SystemMediaTransportControlsButton::Stop => "stop",
                        SystemMediaTransportControlsButton::Next => "next",
                        SystemMediaTransportControlsButton::Previous => "previous",
                        SystemMediaTransportControlsButton::FastForward => "seekforward",
                        SystemMediaTransportControlsButton::Rewind => "seekbackward",
                        _ => "unknown",
                    };
                    // 关键：媒体键只投递给"用户当前所在的模块"（ACTIVE_MODULE），而不是 pick_winner
                    // 的展示胜者。否则视频模块里 video_ok 尚未生效（视频元信息未推上/为空）时，胜者
                    // 会回退成 music，导致所有键（含暂停）都控制音乐 —— 即此前 point 4：视频里按
                    // 上/下一个却切了音乐。路由只认"用户在哪个模块"，与任务栏卡片显示哪个来源解耦。
                    // 笔记/其它无明确媒体归属的模块，回退到 pick_winner（谁在播给谁）。
                    let module = ACTIVE_MODULE
                        .get()
                        .map(|m| m.lock().unwrap().clone())
                        .unwrap_or_else(|| "notes".into());
                    let target = match module.as_str() {
                        "video" => "video".to_string(),
                        "music" => "music".to_string(),
                        _ => pick_winner().map(|w| w.media_type).unwrap_or_default(),
                    };
                    // 路由以"用户当前所在模块"为准（ACTIVE_MODULE）：视频/音乐模块里用户明确在
                    // 看视频/听歌，按键一律投递给该模块（前端无媒体时安全 no-op）。仅当模块为
                    // 笔记/其它、且确实没有任何活动会话时才丢弃，避免"没在播放却每按一次打日志"的噪音。
                    let video_ok = LAST_VIDEO
                        .get()
                        .and_then(|m| m.lock().ok())
                        .map_or(false, |v| !v.title.trim().is_empty());
                    let music_ok = LAST_MUSIC
                        .get()
                        .and_then(|m| m.lock().ok())
                        .map_or(false, |m| !m.title.trim().is_empty());
                    let explicit = module == "video" || module == "music";
                    let active = if explicit {
                        true
                    } else {
                        video_ok || music_ok
                    };
                    if active {
                        log::info!("[SMTC] BTN {name} -> target={target} (module={module})");
                        let _ = app.emit(
                            "smtc-control",
                            SmtcControl { action: name.to_string(), target },
                        );
                    } else {
                        log::debug!("[SMTC] BTN {name} 丢弃：target={target} 无活动会话 (module={module})");
                    }
                }
            }
            Ok(())
        });
        // 保存 handler 到线程局部，避免被 drop 导致回调失效。
        BUTTON_HANDLER.with(|b| {
            *b.borrow_mut() = Some(handler);
            let borrow = b.borrow();
            if let Some(h) = borrow.as_ref() {
                if let Err(e) = smtc.ButtonPressed(h) {
                    log::warn!("[SMTC] 注册 ButtonPressed 失败: {e:?}");
                }
            }
        });

        let _ = SMTC.set(smtc);
        eprintln!("[SMTC-DIAG] 已创建系统媒体会话（GetForWindow 成功，AUMID={}）", AUMID);
        // 把主窗口及其后代（含 msedgewebview2.exe 的浏览器窗口）的 AUMID 都写成我们的，
        // 使 WebView2 的媒体会话归入「岸灯鸢花」而非默认的 MSEdge（任务栏显「未知应用」）。
        set_webview_aumid_recursive(hwnd.0 as isize);
        // 枚举并压制 WebView2 等"非本进程"媒体会话，避免任务栏出现「未知应用」卡片。
        diag_and_suppress_other_sessions(hwnd.0 as isize);
        emit_diag(app);
    }

    /// 本进程内复用的 tokio 运行时，用于在同步上下文里 block_on / spawn WinRT 异步调用
    /// （GlobalSystemMediaTransportControlsSessionManager::RequestAsync 返回 IAsyncOperation，
    /// windows-rs 0.62 下只能 .await，没有同步 get()）。
    static SUPPRESS_RT: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();

    fn suppress_rt() -> &'static tokio::runtime::Runtime {
        SUPPRESS_RT.get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("[SMTC] 创建压制用 tokio 运行时失败")
        })
    }

    /// 枚举系统里所有媒体会话并打印诊断，用于确认任务栏「未知应用」卡片到底是不是
    /// msedgewebview2.exe 的音频会话（它无 AUMID → 任务栏显「未知应用」）。每次系统会话
    /// 集合变化（WebView2 开始/停止播放会新建或回收会话）也会重新打印，方便观察。
    fn diag_and_suppress_other_sessions(hwnd: isize) {
        std::thread::spawn(move || {
            suppress_rt().block_on(async {
                ensure_winrt();
                match GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
                    Ok(op) => match op.await {
                        Ok(mgr) => {
                        let handler = TypedEventHandler::<
                            GlobalSystemMediaTransportControlsSessionManager,
                            SessionsChangedEventArgs,
                        >::new(move |_s, _a| {
                            suppress_rt().spawn(async move {
                                ensure_winrt();
                                set_webview_aumid_recursive(hwnd);
                                let _ = dump_sessions().await;
                            });
                            Ok(())
                        });
                        // SessionsChanged 处理器需常驻保活，故泄漏（进程级单例，可接受）。
                        let leaked: &'static TypedEventHandler<
                            GlobalSystemMediaTransportControlsSessionManager,
                            SessionsChangedEventArgs,
                        > = Box::leak(Box::new(handler));
                        if let Err(e) = mgr.SessionsChanged(leaked) {
                            eprintln!("[SMTC-DIAG] 注册 SessionsChanged 失败: {e:?}");
                        }
                        if let Err(e) = dump_sessions().await {
                            eprintln!("[SMTC-DIAG] 初次枚举失败: {e:?}");
                        }
                        // 常驻线程：每 3s 把 WebView2 窗口的 AUMID 写成我们的，作为「flag 万一未
                        // 生效」的兜底——即使 WebView2 仍注册 OS 媒体会话，也会归入「岸灯鸢花」
                        // 而非「未知应用」。WebView2 通常在应用启动后、用户点播放前很久才创建其
                        // 浏览器窗口，此时属性已被写入，后续新建的会话即采用我们的 AUMID；即使
                        // WebView2 中途重建窗口，下一次周期也会补设。进程级常驻，开销极小。
                        suppress_rt().spawn(async move {
                            ensure_winrt();
                            let mut tick = 0u32;
                            loop {
                                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                                set_webview_aumid_recursive(hwnd);
                                tick += 1;
                                if tick % 10 == 0 {
                                    let _ = dump_sessions().await;
                                }
                            }
                        });
                    }
                        Err(e) => eprintln!("[SMTC-DIAG] 会话管理器 RequestAsync.await 失败: {e:?}"),
                    }
                    Err(e) => eprintln!("[SMTC-DIAG] 会话管理器 RequestAsync 失败: {e:?}"),
                }});
        });
    }

    /// 枚举所有系统媒体会话并打印每个会话的 AUMID（ours 标记是否为本进程会话）。
    async fn dump_sessions() -> Result<()> {
        let mgr = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?.await?;
        let sessions = mgr.GetSessions()?;
        let n = sessions.Size()?;
        eprintln!("[SMTC-DIAG] 系统媒体会话数量 = {n}");
        for i in 0..n {
            let s = sessions.GetAt(i)?;
            let aumid = s.SourceAppUserModelId()?;
            let ours = aumid == HSTRING::from(AUMID);
            eprintln!("[SMTC-DIAG] 会话[{i}] AUMID = {aumid} | ours={ours}");
        }
        Ok(())
    }

    /// 取窗口的顶层祖先（任务栏按钮所在窗口）。Tauri v2 的 WebviewWindow::hwnd() 实际返回
    /// WebView2 子控件 HWND，而任务栏按钮挂在顶层窗口上；SMTC 会话与 AUMID 属性必须设在
    /// 顶层窗口才生效。对已经是顶层窗口的 HWND 调用 GetAncestor(GA_ROOT) 返回其自身，安全。
    fn top_level(hwnd: HWND) -> HWND {
        unsafe {
            let root = GetAncestor(hwnd, GA_ROOT);
            if root.0.is_null() { hwnd } else { root }
        }
    }

    /// 探针：读回指定窗口的 PKEY_AppUserModel_ID 属性（任务栏据此解析显示名）。
    fn read_window_aumid(hwnd: HWND) -> Option<String> {
        unsafe {
            let store: IPropertyStore = SHGetPropertyStoreForWindow(hwnd).ok()?;
            let mut pv: PROPVARIANT = store.GetValue(&PKEY_AppUserModel_ID).ok()?;
            let inner = &mut pv as *mut PROPVARIANT as *mut PROPVARIANT_0_0;
            if (*inner).vt == VT_LPWSTR {
                let p = (*inner).Anonymous.pwszVal;
                if !p.0.is_null() {
                    let mut len = 0usize;
                    while *p.0.add(len) != 0 {
                        len += 1;
                    }
                    let slice = std::slice::from_raw_parts(p.0, len);
                    return Some(String::from_utf16_lossy(slice));
                }
            }
            None
        }
    }

    /// 探针：读回注册表 DisplayName（确认任务栏应能解析到的名字）。
    fn read_reg_displayname() -> Option<String> {
        let sub_w: Vec<u16> = format!("Software\\Classes\\AppUserModelId\\{}", AUMID)
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            let mut hkey = HKEY::default();
            if RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(sub_w.as_ptr()), None, KEY_READ, &mut hkey)
                .is_ok()
            {
                let name_w: Vec<u16> =
                    "DisplayName".encode_utf16().chain(std::iter::once(0)).collect();
                let mut cb = 0u32;
                if RegQueryValueExW(
                    hkey,
                    PCWSTR(name_w.as_ptr()),
                    None,
                    None,
                    None,
                    Some(&mut cb as *mut u32),
                )
                .is_ok()
                    && cb > 0
                {
                    let mut buf: Vec<u16> = vec![0u16; (cb as usize / 2) + 1];
                    if RegQueryValueExW(
                        hkey,
                        PCWSTR(name_w.as_ptr()),
                        None,
                        None,
                        Some(buf.as_mut_ptr() as *mut u8),
                        Some(&mut cb as *mut u32),
                    )
                    .is_ok()
                    {
                        let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
                        let _ = RegCloseKey(hkey);
                        return Some(String::from_utf16_lossy(&buf[..n]));
                    }
                }
                let _ = RegCloseKey(hkey);
            }
        }
        None
    }

    /// 诊断：真正回读进程级 AUMID（GetCurrentProcessExplicitAppUserModelID）。
    /// 返回空串表示 SetCurrentProcessExplicitAppUserModelID 未生效——这是「未知应用」的决定性信号：
    /// 进程无 AUMID 时窗口不会继承，媒体卡片按进程 AUMID 解析便落到「未知应用」。
    fn read_process_aumid() -> String {
        unsafe {
            match GetCurrentProcessExplicitAppUserModelID() {
                Ok(p) => {
                    if p.0.is_null() {
                        return String::new();
                    }
                    let mut len = 0usize;
                    while *p.0.add(len) != 0 {
                        len += 1;
                    }
                    let s = String::from_utf16_lossy(std::slice::from_raw_parts(p.0, len));
                    let _ = CoTaskMemFree(Some(p.0 as *mut std::ffi::c_void));
                    s
                }
                Err(_) => String::new(),
            }
        }
    }

    /// 枚举主窗口的所有后代窗口（含 msedgewebview2.exe 的浏览器窗口），逐个写我们的 AUMID。
    /// 这样 WebView2 后续创建/复用的媒体会话会归入「岸灯鸢花」，而不是默认的 MSEdge
    ///（MSEdge 无 DisplayName → 任务栏显「未知应用」）。在 init 主线程调用一次即可覆盖
    /// WebView2 已存在的窗口；播放期间若 WebView2 新建窗口，可再次调用补设。
    extern "system" fn enum_set_aumid(h: HWND, _lparam: LPARAM) -> BOOL {
        let _ = set_window_aumid(h);
        BOOL(1)
    }

    fn set_webview_aumid_recursive(hwnd: isize) {
        let h = HWND(hwnd as *mut std::ffi::c_void);
        let _ = set_window_aumid(h);
        unsafe {
            let _ = EnumChildWindows(Some(h), Some(enum_set_aumid), LPARAM(0));
        }
    }

    /// 把本进程 AUMID 写到指定窗口 HWND 的属性存储（PKEY_AppUserModel_ID，VT_LPWSTR）。
    /// 必须在本进程已 SetCurrentProcessExplicitAppUserModelID 之后调用。该属性使任务栏把
    /// 此窗口（及其 SMTC 会话）识别为 com.andengyuanhua.desktop，并据此从注册表读取
    /// DisplayName=岸灯鸢花，而不是显示「未知应用」或原始 AUMID 字符串。
    ///
    /// 注意：PROPVARIANT 的 pwszVal 指向的宽字符串（wide）必须在 SetValue+Commit 期间保持
    /// 存活，故放在函数作用域内、在 unsafe 块外用其生命周期兜底。
    fn set_window_aumid(hwnd: HWND) {
        // 宽字符串 AUMID，结尾补一个 \0。必须在 SetValue/Commit 期间存活。
        let wide: Vec<u16> = AUMID.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let store: IPropertyStore = match SHGetPropertyStoreForWindow(hwnd) {
                Ok(s) => s,
                Err(e) => {
                    log::warn!("[SMTC] SHGetPropertyStoreForWindow 失败（退回进程级 AUMID）: {e:?}");
                    return;
                }
            };
            let mut pv = PROPVARIANT::default();
            // PROPVARIANT 与 PROPVARIANT_0_0 在偏移 0 处内存布局一致（中间的 ManuallyDrop 是透明包装），
            // 故把 &mut PROPVARIANT 重新解释为 *mut PROPVARIANT_0_0 直接写字段，
            // 避开 ManuallyDrop 不允许自动 DerefMut 的限制。
            let inner = &mut pv as *mut PROPVARIANT as *mut PROPVARIANT_0_0;
            (*inner).vt = VT_LPWSTR;
            (*inner).Anonymous.pwszVal = PWSTR(wide.as_ptr() as *mut u16);
            if let Err(e) = store.SetValue(&PKEY_AppUserModel_ID, &pv) {
                log::warn!("[SMTC] 设置窗口 AUMID 失败: {e:?}");
                let _ = WINDOW_AUMID_SET.set(false);
                return;
            }
            if let Err(e) = store.Commit() {
                log::warn!("[SMTC] 提交窗口 AUMID 属性失败: {e:?}");
                let _ = WINDOW_AUMID_SET.set(false);
                return;
            }
            let _ = WINDOW_AUMID_SET.set(true);
            log::info!("[SMTC] 已将 AUMID 写入主窗口 HWND 属性存储");
            // 关键：PROPVARIANT 的 Drop 会调用 PropVariantClear，对 VT_LPWSTR 它会
            // CoTaskMemFree(pwszVal)。但我们的 pwszVal 指向 Rust 的 Vec<u16>（wide），
            // 不是 COM 分配的，若让其正常 drop 会用错误分配器释放，导致 STATUS_HEAP_CORRUPTION。
            // 故此处 mem::forget 阻止 Drop；wide 由 Rust 正常释放（独立所有权，无双重释放）。
            std::mem::forget(pv);
        }
        // wide 在此函数结束才释放（Rust 正常 drop），晚于 Commit，安全。
    }

    /// 把一次推送按来源写入对应缓存（标题/艺术家/专辑为空时复用本来源上次有效值），
    /// 返回补齐后的有效元信息。
    fn store_source(info: &SmtcUpdate) -> SmtcUpdate {
        let cache = match info.media_type.as_str() {
            "video" => LAST_VIDEO.get_or_init(|| Mutex::new(SmtcUpdate::default())),
            _ => LAST_MUSIC.get_or_init(|| Mutex::new(SmtcUpdate::default())),
        };
        let mut g = cache.lock().unwrap();
        let mut eff = info.clone();
        if eff.title.trim().is_empty() {
            if !g.title.trim().is_empty() {
                eff.title = g.title.clone();
            } else {
                eff.title = "未知曲目".into();
            }
        }
        if eff.artist.trim().is_empty() && !g.artist.trim().is_empty() {
            eff.artist = g.artist.clone();
        }
        if eff.album.trim().is_empty() && !g.album.trim().is_empty() {
            eff.album = g.album.clone();
        }
        // 封面：若本次未提供封面路径（如切到无封面曲目），沿用上次缓存的封面，避免任务栏缩略图闪空。
        if eff.cover_path.as_deref().map(|s| s.trim().is_empty()).unwrap_or(true)
            && g.cover_path.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false)
        {
            eff.cover_path = g.cover_path.clone();
        }
        *g = eff.clone();
        // 若该来源至少处于播放态一次，则标记为已激活（进程生命周期内保持）。
        if info.is_playing {
            match info.media_type.as_str() {
                "video" => {
                    let m = VIDEO_ACTIVATED.get_or_init(|| Mutex::new(false));
                    *m.lock().unwrap() = true;
                }
                _ => {
                    let m = MUSIC_ACTIVATED.get_or_init(|| Mutex::new(false));
                    *m.lock().unwrap() = true;
                }
            }
        }
        eff
    }

    /// 依据优先级选出应显示给任务栏的会话：
    /// 视频模块且窗口可见 → 视频优先；否则（其它模块/最小化/托盘）→ 音乐优先。
    /// 优选来源无有效标题时回退到另一来源；两者皆空则不显示（Stopped）。
    fn pick_winner() -> Option<SmtcUpdate> {
        let hidden = *WINDOW_HIDDEN
            .get_or_init(|| Mutex::new(false))
            .lock()
            .unwrap();
        let module = ACTIVE_MODULE
            .get_or_init(|| Mutex::new("notes".into()))
            .lock()
            .unwrap()
            .clone();
        let music = LAST_MUSIC
            .get()
            .and_then(|m| m.lock().ok())
            .map(|g| g.clone());
        let video = LAST_VIDEO
            .get()
            .and_then(|m| m.lock().ok())
            .map(|g| g.clone());
        // 仅在该模块被激活（至少播放过一次）后，才允许其成为候选显示来源。
        let music_activated = *MUSIC_ACTIVATED.get_or_init(|| Mutex::new(false)).lock().unwrap();
        let video_activated = *VIDEO_ACTIVATED.get_or_init(|| Mutex::new(false)).lock().unwrap();
        let music_ok = music.as_ref().map_or(false, |m| !m.title.trim().is_empty()) && music_activated;
        let video_ok = video.as_ref().map_or(false, |v| !v.title.trim().is_empty()) && video_activated;
        let prefer_video = !hidden && module == "video";
        log::info!(
            "[SMTC] PICK hidden={hidden} module={module} music_ok={music_ok} video_ok={video_ok} prefer_video={prefer_video}"
        );
        if prefer_video {
            if video_ok {
                video
            } else if music_ok {
                music
            } else {
                video.or(music)
            }
        } else if music_ok {
            music
        } else if video_ok {
            video
        } else {
            music.or(video)
        }
    }

    /// 把当前 SMTC 真实运行状态以 `smtc-diag` 事件发给前端（由 host 监听后写 file-logger），
    /// 这是打包版下打破「盲调」的关键：终端 [SMTC-DIAG] 在打包版不可见。
    /// 改为异步：额外枚举系统里所有媒体会话 AUMID（system_sessions），用于确认播放时
    /// WebView2 是否仍会冒出「未知应用」卡（多出的非 ours 条目即证据）。
    fn emit_diag(app: &AppHandle) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let session_created = SMTC.get().is_some();
            let process_aumid = read_process_aumid();
            let mut window_aumid = String::new();
            if let Some(raw) = app
                .get_webview_window("main")
                .and_then(|w| w.hwnd().ok())
            {
                window_aumid =
                    read_window_aumid(top_level(HWND(raw.0 as *mut std::ffi::c_void)))
                        .unwrap_or_default();
            }
            let reg_displayname = read_reg_displayname().unwrap_or_default();
            let is_enabled = *LAST_IS_ENABLED.get_or_init(|| Mutex::new(false)).lock().unwrap();
            let playback_status = LAST_PLAYBACK_STATUS
                .get_or_init(|| Mutex::new(String::new()))
                .lock()
                .unwrap()
                .clone();
            // 枚举系统里所有活动媒体会话（异步），确认 WebView2 是否在播放时抢占任务栏。
            let mut system_sessions: Vec<String> = Vec::new();
            if let Ok(op) = GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
                if let Ok(mgr) = op.await {
                    if let Ok(sessions) = mgr.GetSessions() {
                        let size = sessions.Size().unwrap_or(0);
                        for i in 0..size {
                            if let Ok(s) = sessions.GetAt(i) {
                                if let Ok(a) = s.SourceAppUserModelId() {
                                    system_sessions.push(a.to_string());
                                }
                            }
                        }
                    }
                }
            }
            let diag = SmtcDiag {
                session_created,
                process_aumid,
                window_aumid,
                reg_displayname,
                is_enabled,
                playback_status,
                system_sessions,
            };
            let _ = app.emit("smtc-diag", diag);
        });
    }

    /// 用前端推送的状态刷新会话：写缓存后按优先级重新计算并应用。
    pub fn update(info: SmtcUpdate) {
        if SMTC.get().is_none() {
            log::info!("[SMTC] UPDATE: session not ready, retrying init");
            if let Some(app) = APP.get() {
                init(app);
            }
        }
        if SMTC.get().is_none() {
            log::info!("[SMTC] UPDATE ignored: session still not ready");
            return;
        }
        log::info!(
            "[SMTC] UPDATE type={} title={:?} playing={} can_prev={} can_next={}",
            info.media_type, info.title, info.is_playing, info.can_prev, info.can_next
        );
        ensure_winrt();
        let _ = store_source(&info);
        apply_priority();
        if let Some(app) = APP.get() {
            emit_diag(app);
        }
    }

    /// 把胜出来源应用到系统媒体会话（推送/切换模块/窗口显隐时都会调用）。
    fn apply_priority() {
        let Some(smtc) = SMTC.get() else {
            return;
        };
        ensure_winrt();
        let Some(eff) = pick_winner() else {
            log::info!("[SMTC] APPLY none -> Stopped (并禁用会话，任务栏不再常驻媒体控件)");
            let _ = smtc.SetPlaybackStatus(MediaPlaybackStatus::Stopped);
            // 小修复：空闲（无媒体模块/无播放）时禁用会话，避免任务栏始终显示本应用媒体控件。
            let _ = smtc.SetIsEnabled(false);
            // 探针：记录实际生效状态（此处即“无媒体控件”）。
            *LAST_IS_ENABLED.get_or_init(|| Mutex::new(false)).lock().unwrap() = false;
            *LAST_PLAYBACK_STATUS.get_or_init(|| Mutex::new(String::new())).lock().unwrap() =
                "Stopped".to_string();
            return;
        };
        // 有胜者：确保会话启用（空闲时曾被禁用），任务栏才会显示「正在播放」。
        let _ = smtc.SetIsEnabled(true);

        log::info!(
            "[SMTC] APPLY winner type={} title={:?} playing={} can_prev={} can_next={}",
            eff.media_type, eff.title, eff.is_playing, eff.can_prev, eff.can_next
        );

        let status = if eff.is_playing {
            MediaPlaybackStatus::Playing
        } else {
            MediaPlaybackStatus::Paused
        };
        let _ = smtc.SetPlaybackStatus(status);
        *LAST_STATUS_PLAYING
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap() = Some(eff.is_playing);
        // 探针：记录实际生效状态（任务栏媒体控件是否出现取决于这两项）。
        *LAST_IS_ENABLED.get_or_init(|| Mutex::new(false)).lock().unwrap() = true;
        *LAST_PLAYBACK_STATUS.get_or_init(|| Mutex::new(String::new())).lock().unwrap() =
            if eff.is_playing { "Playing".to_string() } else { "Paused".to_string() };
        let _ = smtc.SetIsPlayEnabled(!eff.is_playing);
        let _ = smtc.SetIsPauseEnabled(eff.is_playing);
        let _ = smtc.SetIsStopEnabled(true);
        let _ = smtc.SetIsNextEnabled(eff.can_next);
        let _ = smtc.SetIsPreviousEnabled(eff.can_prev);

        if let Ok(updater) = smtc.DisplayUpdater() {
            let mt = if eff.media_type == "video" {
                MediaPlaybackType::Video
            } else {
                MediaPlaybackType::Music
            };
            let _ = updater.SetType(mt);
            if let Ok(music) = updater.MusicProperties() {
                let _ = music.SetTitle(&HSTRING::from(&eff.title));
                // 第二行（浮窗“艺术家”行）合并 歌手 + 专辑，让标题/歌手/专辑三者都可见。
                // 同时修正旧 bug：AlbumArtist 之前被错填成专辑名，当 Artist 为空时 Windows
                // 会回退显示 AlbumArtist → 任务栏显成专辑名；现改回真实歌手。
                let mut second_line = String::new();
                if !eff.artist.trim().is_empty() {
                    second_line.push_str(eff.artist.trim());
                }
                if !eff.album.trim().is_empty() {
                    if !second_line.is_empty() {
                        second_line.push_str("  ·  ");
                    }
                    second_line.push_str(eff.album.trim());
                }
                if second_line.is_empty() {
                    second_line.push_str("未知歌手");
                }
                let second_h = HSTRING::from(&second_line);
                let _ = music.SetArtist(&second_h);
                let _ = music.SetAlbumArtist(&HSTRING::from(eff.artist.trim()));
                let _ = music.SetAlbumTitle(&HSTRING::from(&eff.album));
            }
            // 封面：优先用曲目内嵌封面；无封面则按 标题+歌手 哈希生成对角渐变占位图，
            // 保证任务栏始终有图、且不同曲目配色不同、显得高级。
            let cover_bytes: Option<Vec<u8>> = match &eff.cover_path {
                Some(p) if !p.trim().is_empty() => std::fs::read(p.trim()).ok(),
                _ => None,
            };
            let bytes: Vec<u8> = match cover_bytes {
                Some(b) if !b.is_empty() => b,
                _ => generate_gradient_cover(&eff.title, &eff.artist),
            };
            match suppress_rt().block_on(async {
                build_thumbnail_stream(&bytes)
                    .await
                    .and_then(|stream| updater.SetThumbnail(&stream))
            }) {
                Ok(()) => {}
                Err(e) => log::warn!("[SMTC] set thumbnail failed: {e:?}"),
            }
            if let Ok(video) = updater.VideoProperties() {
                let _ = video.SetTitle(&HSTRING::from(&eff.title));
            }
            let _ = updater.Update();
        }
    }

    /// 把图片字节写入一个 RandomAccessStreamReference，供 DisplayUpdater.SetThumbnail 使用。
    /// windows-rs 0.62 下流写入是异步的，故本函数为 async（调用处用 suppress_rt().block_on 驱动）。
    async fn build_thumbnail_stream(bytes: &[u8]) -> windows::core::Result<RandomAccessStreamReference> {
        let stream = InMemoryRandomAccessStream::new()?;
        {
            let writer = DataWriter::CreateDataWriter(&stream)?;
            writer.WriteBytes(bytes)?;
            writer.StoreAsync()?.await?;
        }
        stream.Seek(0)?;
        RandomAccessStreamReference::CreateFromStream(&stream)
    }

    /// 无内嵌封面时，按 标题+歌手 的哈希生成一张对角渐变占位图（PNG），
    /// 不同曲目配色不同、始终有图，任务栏媒体控件更显高级。
    fn generate_gradient_cover(title: &str, artist: &str) -> Vec<u8> {
        use image::{ImageBuffer, ImageFormat, Rgb};

        const W: u32 = 512;
        const H: u32 = 512;
        // 由 标题+歌手 得稳定色相种子
        let mut seed: u32 = 2166136261;
        for b in format!("{}/{}", title, artist).bytes() {
            seed ^= b as u32;
            seed = seed.wrapping_mul(16777619);
        }
        let hue = (seed % 360) as f32;
        let base1 = hsl_to_rgb(hue, 0.58, 0.46);
        let base2 = hsl_to_rgb((hue + 38.0) % 360.0, 0.62, 0.30);
        let hi = hsl_to_rgb((hue + 18.0) % 360.0, 0.45, 0.62); // 中心高光

        let mut img = ImageBuffer::<Rgb<u8>, Vec<u8>>::new(W, H);
        let cx = W as f32 / 2.0;
        let cy = H as f32 / 2.0;
        let max_d = (cx * cx + cy * cy).sqrt();
        for y in 0..H {
            for x in 0..W {
                let t = ((x + y) as f32) / ((W + H) as f32); // 对角渐变
                let mut r = lerp(base1.0, base2.0, t);
                let mut g = lerp(base1.1, base2.1, t);
                let mut b = lerp(base1.2, base2.2, t);
                // 中心径向高光，增加质感
                let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
                let glow = (1.0 - d / max_d).max(0.0).powf(1.6) * 0.35;
                r = (r as f32 + hi.0 as f32 * glow).min(255.0) as u8;
                g = (g as f32 + hi.1 as f32 * glow).min(255.0) as u8;
                b = (b as f32 + hi.2 as f32 * glow).min(255.0) as u8;
                img.put_pixel(x, y, Rgb([r, g, b]));
            }
        }
        let mut buf: Vec<u8> = Vec::new();
        if img.write_to(&mut std::io::Cursor::new(&mut buf), ImageFormat::Png).is_ok() {
            buf
        } else {
            Vec::new()
        }
    }

    fn lerp(a: u8, b: u8, t: f32) -> u8 {
        (a as f32 + (b as f32 - a as f32) * t.clamp(0.0, 1.0)) as u8
    }

    /// HSL(0..360, 0..1, 0..1) → RGB(0..255)
    fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (u8, u8, u8) {
        let h = h / 360.0;
        let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
        let p = 2.0 * l - q;
        let r = hue_to_rgb(p, q, h + 1.0 / 3.0);
        let g = hue_to_rgb(p, q, h);
        let b = hue_to_rgb(p, q, h - 1.0 / 3.0);
        ((r * 255.0) as u8, (g * 255.0) as u8, (b * 255.0) as u8)
    }

    fn hue_to_rgb(p: f32, q: f32, mut t: f32) -> f32 {
        if t < 0.0 {
            t += 1.0;
        }
        if t > 1.0 {
            t -= 1.0;
        }
        if t < 1.0 / 6.0 {
            return p + (q - p) * 6.0 * t;
        }
        if t < 1.0 / 2.0 {
            return q;
        }
        if t < 2.0 / 3.0 {
            return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
        }
        p
    }

    /// 前端上报当前激活模块。视频模块时视频媒体优先；其余模块（笔记/音乐/扩展等）音乐优先。
    pub fn set_active_module(module: String) {
        if SMTC.get().is_none() {
            log::info!("[SMTC] set_active_module: session not ready, retrying init");
            if let Some(app) = APP.get() {
                init(app);
            }
        }
        log::info!("[SMTC] set_active_module {module}");
        *ACTIVE_MODULE
            .get_or_init(|| Mutex::new("notes".into()))
            .lock()
            .unwrap() = module;
        apply_priority();
    }

    /// 主窗口显隐状态变化（最小化/托盘/恢复）。隐藏时强制音乐优先。
    pub fn set_window_hidden(hidden: bool) {
        if SMTC.get().is_none() {
            log::info!("[SMTC] set_window_hidden: session not ready, retrying init");
            if let Some(app) = APP.get() {
                init(app);
            }
        }
        log::info!("[SMTC] set_window_hidden {hidden}");
        *WINDOW_HIDDEN
            .get_or_init(|| Mutex::new(false))
            .lock()
            .unwrap() = hidden;
        apply_priority();
    }

    /// 诊断：返回 Rust 端 SMTC 会话的真实状态，供前端 DevTools 探针调用。
    pub async fn status() -> SmtcStatus {
        ensure_winrt();
        let session_created = SMTC.get().is_some();
        let window_aumid_set = *WINDOW_AUMID_SET.get().unwrap_or(&false);
        let active_module = ACTIVE_MODULE
            .get()
            .map(|m| m.lock().unwrap().clone())
            .unwrap_or_default();
        let last_music_title = LAST_MUSIC
            .get()
            .and_then(|m| m.lock().ok())
            .map(|g| g.title.clone())
            .unwrap_or_default();
        let last_video_title = LAST_VIDEO
            .get()
            .and_then(|m| m.lock().ok())
            .map(|g| g.title.clone())
            .unwrap_or_default();
        let last_status_playing = *LAST_STATUS_PLAYING
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap();
        let is_enabled = *LAST_IS_ENABLED
            .get_or_init(|| Mutex::new(false))
            .lock()
            .unwrap();
        let playback_status = LAST_PLAYBACK_STATUS
            .get_or_init(|| Mutex::new(String::new()))
            .lock()
            .unwrap()
            .clone();
        let actual_top_aumid = TOP_HWND
            .get()
            .map(|h| read_window_aumid(HWND(*h as *mut std::ffi::c_void)))
            .flatten()
            .unwrap_or_default();
        let reg_displayname = read_reg_displayname().unwrap_or_default();

        // 枚举系统里所有活动媒体会话，确认 WebView2(MSEdge) 是否在抢占任务栏（双卡片）。
        let mut system_sessions: Vec<String> = Vec::new();
        if let Ok(op) = GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
            if let Ok(mgr) = op.await {
                if let Ok(sessions) = mgr.GetSessions() {
                    let size = sessions.Size().unwrap_or(0);
                    for i in 0..size {
                        if let Ok(s) = sessions.GetAt(i) {
                            if let Ok(aumid) = s.SourceAppUserModelId() {
                                system_sessions.push(aumid.to_string());
                            }
                        }
                    }
                }
            }
        }

        SmtcStatus {
            session_created,
            window_aumid_set,
            aumid: AUMID.to_string(),
            process_aumid: read_process_aumid(),
            active_module,
            last_music_title,
            last_video_title,
            last_status_playing,
            is_enabled,
            playback_status,
            actual_top_aumid,
            reg_displayname,
            system_sessions,
        }
    }

    fn set_reg_sz(hkey: HKEY, name: &str, value: &str) {
        let name_w: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let val_w: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
        // UTF-16LE 原始字节（含结尾 NUL）作为 REG_SZ 数据
        let val_bytes: &[u8] =
            unsafe { std::slice::from_raw_parts(val_w.as_ptr() as *const u8, val_w.len() * 2) };
        unsafe {
            let rc = RegSetValueExW(hkey, PCWSTR(name_w.as_ptr()), None, REG_SZ, Some(val_bytes));
            if rc == ERROR_SUCCESS {
                log::info!("[SMTC] 注册表已写 {name}={value}");
            } else {
                log::warn!("[SMTC] 写注册表 {name} 失败: {rc:?}");
            }
        }
    }
}

/// 应用启动阶段调用：创建本进程拥有的系统媒体会话（任务栏显示「岸灯鸢花」、可响应媒体键）。
pub fn init_smtc(app: AppHandle) {
    #[cfg(windows)]
    imp::init(&app);
}

/// 在窗口创建前（main 起始处）尽早设置进程 AUMID + 注册表显示名，使随后创建的主窗口
/// 继承该 AUMID，任务栏据此显示「岸灯鸢花」而非「未知应用」。幂等。
pub fn ensure_app_identity() {
    #[cfg(windows)]
    imp::set_app_identity();
}

/// 前端推送当前媒体状态（标题/艺术家/专辑/播放态/可用按钮）。
#[tauri::command]
pub fn smtc_update(info: SmtcUpdate) {
    #[cfg(windows)]
    imp::update(info);
}

/// 前端上报当前激活模块，用于决定任务栏媒体会话优先级（视频模块→视频优先，其余→音乐优先）。
#[tauri::command]
pub fn set_active_module(module: String) {
    #[cfg(windows)]
    imp::set_active_module(module);
}

/// 主窗口显隐变化（最小化/托盘），隐藏时强制音乐优先。
#[tauri::command]
pub fn set_window_hidden(hidden: bool) {
    #[cfg(windows)]
    imp::set_window_hidden(hidden);
}

/// 调试用：前端把关键事件经此命令转发到 Rust 日志（终端 stdout 统一查看）。
#[tauri::command]
pub fn debug_log(msg: String) {
    log::info!("[FE] {msg}");
}

/// 诊断用：返回 Rust 端 SMTC 会话的真实运行状态（DevTools 探针）。
#[tauri::command]
pub async fn smtc_status() -> SmtcStatus {
    #[cfg(windows)]
    {
        imp::status().await
    }
    #[cfg(not(windows))]
    {
        SmtcStatus::default()
    }
}
