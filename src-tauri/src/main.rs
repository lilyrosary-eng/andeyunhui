// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use mimalloc::MiMalloc;
#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

use tauri::Emitter;
use tauri::Manager;
use tauri::http::{Response, StatusCode};
use tauri::tray::TrayIconBuilder;
use tauri::tray::{MouseButton, MouseButtonState};
use std::net::UdpSocket;
use std::time::Duration;
use std::sync::mpsc;
use notify::{Event, EventKind, RecursiveMode, Watcher};
use tauri_plugin_global_shortcut::ShortcutState;

/// 单实例互斥端口：主实例绑定此 UDP 端口并监听聚焦请求，
/// 后续重复启动的实例检测到端口被占用后发送聚焦信号并退出，
/// 从而避免反复启动产生多个托盘图标。
/// dev（debug）与打包（release）使用不同端口，二者可同时运行互不阻塞；
/// 否则用户开着打包版（托盘常驻占用 45991）时，`pnpm tauri dev` 会被误判为重复实例而直接退出。
const INSTANCE_PORT: u16 = if cfg!(debug_assertions) { 45992 } else { 45991 };
use andengyuanhua_lib::commands::*;
// 专业模块「薄荷」工具：从内部依赖包 pro-tools-kit 引入（不再集成于主 crate 源码树）
// Tauri 2 限制：命令不能放在 crate 根（lib.rs），故置于 commands 子模块
use pro_tools_kit::commands::*;
// 攻防模块后端命令（gongfang-kit crate，默认仅骨架，--features gongfang 启用爬虫等）
use gongfang_kit::commands::*;
use andengyuanhua_lib::screenshot::{self, *};
use andengyuanhua_lib::TrayModeState;
use andengyuanhua_lib::TrayHolder;
use andengyuanhua_lib::services::lyrics_service;
use andengyuanhua_lib::services::recording_service;
use andengyuanhua_lib::services::diagnostics;
use andengyuanhua_lib::services::log_service;
use andengyuanhua_lib::services::ai_service;
use andengyuanhua_lib::services::shell_service;
use andengyuanhua_lib::services::lsp_service;
use andengyuanhua_lib::services::mcp_service;
use andengyuanhua_lib::smtc::*;
use std::sync::Mutex;

/// 创建托盘右键菜单窗口（独立 WebView，承载「我们的 UI」样式菜单）。
/// 设计为「创建一次、反复复用」：首次创建后隐藏，右键托盘时 only show。
fn create_tray_menu_window(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::WebviewUrl;
    if app.get_webview_window("tray-menu").is_some() {
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        app,
        "tray-menu",
        WebviewUrl::App("index.html?overlay=tray-menu".into()),
    )
    .title("菜单")
    .inner_size(220.0, 156.0)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .transparent(true)
    .shadow(false)
    .resizable(false)
    .visible(false)
    .build()?;
    Ok(())
}

/// 在托盘图标附近弹出菜单窗口（默认任务栏在底部 → 置于图标上方）
fn open_tray_menu(app: &tauri::AppHandle, pos: tauri::PhysicalPosition<f64>) {
    let _ = create_tray_menu_window(app);
    if let Some(w) = app.get_webview_window("tray-menu") {
        // 事件 position 已是物理像素，直接用 PhysicalPosition，避免 DPI 二次缩放错位
        let _ = w.set_position(tauri::PhysicalPosition::new(
            (pos.x - 110.0).max(4.0),
            (pos.y - 160.0).max(4.0),
        ));
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn tray_summon_main(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
    // 从托盘恢复：窗口重新可见，恢复按激活模块裁决媒体会话优先级
    set_window_hidden(false);
    if let Some(m) = app.get_webview_window("tray-menu") {
        let _ = m.hide();
    }
}

#[tauri::command]
fn tray_quit(app: tauri::AppHandle) {
    app.exit(0);
}

fn main() {
    // 尽早设置本进程 AUMID + 注册表显示名「岸灯鸢花」，使随后创建的主窗口继承该 AUMID，
    // 任务栏媒体浮窗据此显示「岸灯鸢花」而非「未知应用」。（早于窗口创建，故窗口可继承）
    andengyuanhua_lib::smtc::ensure_app_identity();

    // 禁用 Chromium/WebView2 自带的系统媒体会话（MediaSession 特性），避免它在任务栏注册一个
    // 「未知应用」卡片，与我们在 Rust 进程内创建的 SystemMediaTransportControls 会话重复。
    //
    // 重要机制更正：Tauri/wry 在创建 WebView2 环境时【总会】传入非空的 AdditionalBrowserArguments
    // （create_environment 里 options.SetAdditionalBrowserArguments(...)），而
    // CreateCoreWebView2EnvironmentWithOptions 一旦收到非 null 的 options，就会【忽略】环境变量
    // WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS。因此此前在 main() 里 set_var 该环境变量完全无效，
    // WebView2 的 MediaSession 从未被禁用。正确做法是把 flag 写进 tauri.conf.json 的窗口配置
    // `additionalBrowserArgs`，它会透传到 wry 真正读取的 pl_attrs.additional_browser_args。
    // 见 tauri.conf.json -> app.windows[0].additionalBrowserArgs（含 wry 默认 flag + MediaSession）。

    // 日志系统在 setup 阶段初始化（需要 app_data 路径），此处仅用 eprintln 兜底早期日志。
    // setup 之前的少量 eprintln 输出到 stderr，setup 之后所有 log:: 宏自动写入会话日志文件。

    tauri::Builder::default()
        .manage(Mutex::new(TrayModeState { enabled: false }))
        // 注册 plugin:// 自定义协议，用于前端动态加载插件
        .register_uri_scheme_protocol("plugin", |ctx, request| {
            let uri = request.uri().to_string();
            let path = uri.strip_prefix("plugin://").unwrap_or("");
            let (plugin_id, file_path) = match path.split_once('/') {
                Some((id, fp)) if !id.is_empty() && !fp.is_empty() => (id, fp),
                _ => {
                    return Response::builder()
                        .status(StatusCode::BAD_REQUEST)
                        .body(Vec::new())
                        .unwrap();
                }
            };

            // 安全检查：拒绝路径穿越（../ 等）
            if file_path.contains("..") || file_path.contains('\\') {
                return Response::builder()
                    .status(StatusCode::FORBIDDEN)
                    .body(Vec::new())
                    .unwrap();
            }

            let app_handle = ctx.app_handle();
            // 统一路径解析：先尝试 user_plugins（第三方），再尝试 bundled-plugins（内置）
            // 与 find_plugin_root 的搜索顺序一致，确保第三方插件可覆盖内置插件
            let candidates: Vec<std::path::PathBuf> = [
                get_user_plugins_dir(app_handle),
                get_bundled_plugins_dir(app_handle),
            ].into_iter().flatten().collect();

            let mut found_file: Option<std::path::PathBuf> = None;
            let mut allowed_roots: Vec<std::path::PathBuf> = Vec::new();
            for base in &candidates {
                let full = base.join(plugin_id).join(file_path);
                if full.exists() && found_file.is_none() {
                    found_file = Some(full);
                }
                if let Ok(c) = base.canonicalize() {
                    allowed_roots.push(c);
                }
            }

            let file_path_full = match found_file {
                Some(p) => p,
                None => {
                    return Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .body(Vec::new())
                        .unwrap();
                }
            };

            // 规范化路径后验证仍在允许的根目录内（防穿越）
            let canonical = match file_path_full.canonicalize() {
                Ok(p) => p,
                Err(_) => {
                    return Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .body(Vec::new())
                        .unwrap();
                }
            };
            if !allowed_roots.iter().any(|root| canonical.starts_with(root)) {
                return Response::builder()
                    .status(StatusCode::FORBIDDEN)
                    .body(Vec::new())
                    .unwrap();
            }

            let content = match std::fs::read(&canonical) {
                Ok(data) => data,
                Err(_) => {
                    return Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .body(Vec::new())
                        .unwrap();
                }
            };

            let mime = match file_path.rsplit('.').next() {
                Some("js") => "application/javascript",
                Some("json") => "application/json",
                Some("css") => "text/css",
                Some("html") => "text/html",
                Some("svg") => "image/svg+xml",
                _ => "application/octet-stream",
            };

            Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", mime)
                // plugin:// 是应用私有协议，仅本机 webview 可发起请求，外部网站无法访问。
                // 此处保留 * 是因为 WebView2 将 plugin: 与 tauri://localhost 视为跨 scheme，
                // 收窄为 self 会阻断插件脚本/资源加载。
                .header("Access-Control-Allow-Origin", "*")
                .body(content)
                .unwrap()
        })
        .setup(|app| {
            // ============ Windows 原生 SMTC（任务栏「正在播放」）============
            // 注册本进程媒体会话，显示「岸灯鸢花」+ 元信息，并接管系统媒体键。
            init_smtc(app.handle().clone());

            // ============ 单实例守卫 ============
            // 主实例：绑定 UDP 端口并后台监听聚焦请求；
            // 重复实例：发送聚焦信号后直接退出，避免生成多个托盘图标。
            {
                let app_handle = app.handle().clone();
                match UdpSocket::bind(("127.0.0.1", INSTANCE_PORT)) {
                    Ok(socket) => {
                        std::thread::spawn(move || {
                            let _ = socket.set_read_timeout(Some(Duration::from_millis(500)));
                            let mut buf = [0u8; 16];
                            loop {
                                if socket.recv_from(&mut buf).is_ok() {
                                    if let Some(w) = app_handle.get_webview_window("main") {
                                        let _ = w.show();
                                        let _ = w.set_focus();
                                    }
                                }
                            }
                        });
                        eprintln!("[Instance] 主实例已启动，监听聚焦端口 {}", INSTANCE_PORT);
                    }
                    Err(_) => {
                        if let Ok(s) = UdpSocket::bind(("127.0.0.1", 0)) {
                            let _ = s.send_to(b"focus", ("127.0.0.1", INSTANCE_PORT));
                        }
                        eprintln!("[Instance] 检测到已有实例在运行，退出重复启动");
                        std::process::exit(0);
                    }
                }
            }

            // 加载托盘模式配置
            let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&app_data).map_err(|e| e.to_string())?;

            // 初始化会话日志系统（替换 env_logger）：每次启动创建新会话日志文件，保留最近 10 个
            if let Err(e) = log_service::init_logger(&app_data) {
                eprintln!("[Log] 日志系统初始化失败: {}", e);
            }

            // 确保「中转站」暂存目录存在（打包后运行时自动创建，无需随包附带）
            let dropzone_dir = app_data.join("transfer_station").join("dropzone");
            std::fs::create_dir_all(&dropzone_dir).map_err(|e| e.to_string())?;

            // 插件与依赖直接从 bundled-plugins/ 与 external-deps/ 加载（开发时项目根，打包后 resource_dir）
            // 不再复制到 app_data/extensions/，确保开发与打包路径一致
            // 确保 user_plugins/ 目录存在（第三方插件热插拔目录，始终在 app_data 下）
            if let Some(user_plugins_dir) = get_user_plugins_dir(app.handle()) {
                let _ = std::fs::create_dir_all(&user_plugins_dir);
            }

            // 从 bundled-dlc/ 复制 .mufurong/.mujin 私有格式包到用户目录
            // （仅打包后 resource_dir 含 bundled-dlc/ 时生效；开发时该目录通常不存在）
            // 复制后由既有的 extract_mufurong_plugins / extract_mujin_deps 自动解压
            extract_bundled_dlc(app.handle());

            // 调试日志：打印解析到的插件/依赖目录路径（帮助排查打包后路径问题）
            // 写到 AppData/plugin_paths.log 方便 release 模式下查看（无控制台）
            {
                let mut log_lines: Vec<String> = Vec::new();
                log_lines.push(format!("[{}] 插件路径解析日志", chrono::Utc::now().to_rfc3339()));
                if let Ok(rd) = app.path().resource_dir() {
                    log_lines.push(format!("resource_dir = {}", rd.display()));
                }
                if let Some(bundled) = get_bundled_plugins_dir(app.handle()) {
                    log_lines.push(format!("✓ bundled-plugins = {}", bundled.display()));
                } else {
                    log_lines.push("· bundled-plugins 未找到（打包后改用 bundled-dlc/.mufurong）".into());
                }
                if let Some(deps) = get_external_deps_dir(app.handle()) {
                    log_lines.push(format!("✓ external-deps = {}", deps.display()));
                } else {
                    log_lines.push("· external-deps 未找到（打包后改用 bundled-dlc/.mujin）".into());
                }
                if let Some(dlc) = get_bundled_dlc_dir(app.handle()) {
                    log_lines.push(format!("✓ bundled-dlc = {}", dlc.display()));
                } else {
                    log_lines.push("· bundled-dlc 未找到（开发模式正常，prepare-bundled-dlc.mjs 仅 build 前运行）".into());
                }
                let log_content = log_lines.join("\n") + "\n";
                let log_path = app_data.join("plugin_paths.log");
                let _ = std::fs::write(&log_path, &log_content);
                eprintln!("[Setup] 插件路径日志已写入: {:?}", log_path);
            }

            let tray_config_path = app_data.join("tray_config.json");
            let tray_enabled = if tray_config_path.exists() {
                std::fs::read_to_string(&tray_config_path)
                    .ok()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                    .and_then(|v| v.get("enabled")?.as_bool())
                    .unwrap_or(false)
            } else {
                false
            };
            {
                let state = app.state::<Mutex<TrayModeState>>();
                let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
                guard.enabled = tray_enabled;
            }

            // 构建系统托盘
            // 托盘菜单改为自定义 UI 窗口（tray-menu），不再使用原生菜单。
            // 交互：左键 → 唤出主界面；右键 → 弹出「我们的 UI」菜单（回到主界面 / 关闭软件）。

            // 预创建截图覆盖窗口与托盘菜单窗口（隐藏复用，避免截图/菜单时的卡顿）
            let _ = create_overlay_window(app.handle().clone());
            // 预创建录屏区域选择覆盖窗（隐藏），首次使用时无需等待 WebView2 初始化
            let _ = recording_service::create_recorder_select_window(app.handle());
            // 预创建录屏控制台窗口（隐藏），避免在 sync 命令中 build 导致 WebView2 主线程重入死锁
            let _ = recording_service::create_recorder_widget_window(app.handle());
            // 预创建录屏区域边框窗（隐藏），start_recording 时按录制区域定位并显示
            let _ = recording_service::create_recording_border_window(app.handle());
            let _ = create_tray_menu_window(app.handle());

            // 托盘图标：优先使用默认窗口图标；若极端情况下为 None，则从资源目录
            // 回退到实际图标文件，避免回退成全透明不可见图标导致"无法交互"
            let tray_icon = app.default_window_icon().cloned().unwrap_or_else(|| {
                let candidates: Vec<std::path::PathBuf> = app
                    .path()
                    .resource_dir()
                    .map(|d| {
                        vec![
                            d.join("icons/32x32.png"),
                            d.join("app-icon.png"),
                            d.join("icons/icon.ico"),
                        ]
                    })
                    .unwrap_or_default();
                for c in candidates {
                    if let Ok(img) = tauri::image::Image::from_path(&c) {
                        return img;
                    }
                }
                tauri::image::Image::new(&[0u8; 32 * 32 * 4], 32, 32)
            });
            let tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .tooltip("岸灯鸢花")
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { button, button_state, position, .. } = event {
                        // 仅在「抬起」时响应，避免按下/抬起双重触发
                        if button_state == MouseButtonState::Up {
                            match button {
                                // 左键：始终唤出主界面并聚焦
                                MouseButton::Left => {
                                    if let Some(window) = tray.app_handle().get_webview_window("main") {
                                        let _ = window.show();
                                        let _ = window.set_focus();
                                    }
                                }
                                // 右键：弹出自定义 UI 菜单
                                MouseButton::Right => {
                                    open_tray_menu(tray.app_handle(), position);
                                }
                                _ => {}
                            }
                        }
                    }
                })
                .build(app)?;
            app.manage(TrayHolder(tray));
            app.manage(std::sync::Mutex::new(andengyuanhua_lib::screenshot::ScreenshotData::default()));

            // 注册系统级截图热键（从持久化配置读取，默认 Ctrl+Shift+S；设置面板可改写并即时生效）
            {
                let sc = read_screenshot_shortcut(app.handle());
                if let Err(e) = register_screenshot_shortcut(app.handle(), &sc) {
                    eprintln!("[Shortcut] 注册截图热键失败: {}", e);
                }
                if let Ok(mut s) = app.state::<Mutex<ScreenshotData>>().lock() {
                    s.shortcut = sc;
                }
            }

            // 注册录屏热键（从持久化配置读取，默认 Ctrl+Alt+R；设置面板可改写并即时生效）
            {
                let sc = recording_service::read_recorder_shortcut(app.handle());
                if let Err(e) = recording_service::register_recorder_shortcut(app.handle(), &sc) {
                    eprintln!("[Shortcut] 注册录屏热键失败: {}", e);
                }
                if let Ok(mut state) = recording_service::recorder_shortcut_state().lock() {
                    *state = sc;
                }
            }

            // 注册剪贴板浮窗热键（默认 Ctrl+Alt+C；设置面板可改写并即时生效）
            {
                let sc = read_clipboard_shortcut(app.handle());
                if let Err(e) = register_clipboard_shortcut(app.handle(), &sc) {
                    eprintln!("[Shortcut] 注册剪贴板热键失败: {}", e);
                }
                if let Ok(mut state) = clipboard_shortcut_state().lock() {
                    *state = sc;
                }
            }

            // 注册中转站浮窗热键（默认 Ctrl+Alt+V；设置面板可改写并即时生效）
            {
                let sc = read_dropzone_shortcut(app.handle());
                if let Err(e) = register_dropzone_shortcut(app.handle(), &sc) {
                    eprintln!("[Shortcut] 注册中转站热键失败: {}", e);
                }
                if let Ok(mut state) = dropzone_shortcut_state().lock() {
                    *state = sc;
                }
            }

            // 创建悬浮歌词窗口
            if let Err(e) = lyrics_service::create_lyrics_widget(app.handle()) {
                eprintln!("[Lyrics] 创建歌词窗口失败: {}", e);
            }

            // ============ 文件系统热插拔监听 ============
            // 监听 bundled-plugins/ 和 user_plugins/ 目录变化，检测到新增/删除/修改时
            // 向前端派发 `plugin-fs-change` 事件，前端 PluginHost 自动 load/reload/unload。
            {
                let ext_target = get_bundled_plugins_dir(app.handle());
                let user_target = get_user_plugins_dir(app.handle());
                let app_handle = app.handle().clone();
                let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
                match notify::recommended_watcher(move |res| {
                    let _ = tx.send(res);
                }) {
                    Ok(mut watcher) => {
                        if let Some(ref ext) = ext_target {
                            if watcher.watch(ext, RecursiveMode::Recursive).is_ok() {
                                eprintln!("[FSWatch] 监听 bundled-plugins/");
                            }
                        }
                        if let Some(ref usr) = user_target {
                            // 确保 user_plugins 目录存在（便于后续热插拔）
                            let _ = std::fs::create_dir_all(usr);
                            let _ = watcher.watch(usr, RecursiveMode::Recursive);
                            eprintln!("[FSWatch] 监听 user_plugins/");
                        }
                        std::thread::spawn(move || {
                            let _w = watcher; // keep alive
                            let mut batch: Vec<String> = Vec::new();
                            let mut last_flush = std::time::Instant::now();
                            for item in rx {
                                if let Ok(event) = item {
                                    let kind = match event.kind {
                                        EventKind::Create(_) => "create",
                                        EventKind::Modify(_) => "modify",
                                        EventKind::Remove(_) => "remove",
                                        _ => continue,
                                    };
                                    for p in &event.paths {
                                        let s = p.to_string_lossy().to_string();
                                        // 去重
                                        if !batch.contains(&s) {
                                            batch.push(s);
                                        }
                                    }
                                    // 防抖：距上次 flush 超 200ms，或批量累计达 32 条时立即 flush。
                                    // 旧逻辑仅靠 200ms 间隔判断，事件持续高频到达时永远不触发；
                                    // 加入批量上限保证持续变更也能及时投递。
                                    if last_flush.elapsed() > std::time::Duration::from_millis(200)
                                        || batch.len() >= 32
                                    {
                                        let ev = serde_json::json!({
                                            "kind": kind,
                                            "paths": &batch
                                        });
                                        let _ = app_handle.emit("plugin-fs-change", &ev);
                                        batch.clear();
                                        last_flush = std::time::Instant::now();
                                    }
                                }
                            }
                            // 监听器关闭时冲刷残留批次，避免末尾事件丢失
                            if !batch.is_empty() {
                                let ev = serde_json::json!({
                                    "kind": "modify",
                                    "paths": &batch
                                });
                                let _ = app_handle.emit("plugin-fs-change", &ev);
                            }
                        });
                    }
                    Err(e) => {
                        eprintln!("[FSWatch] 创建文件监听器失败: {}", e);
                    }
                }
            }

            // 不再自动打开 DevTools — 之前自动打开导致 Chrome DevTools
            // 响应式模式在窗口缩放时于右上角显示视口尺寸覆盖层（橙色小字），
            // 用户误以为是应用内调试组件。如需调试手动 F12 打开即可。
            // #[cfg(debug_assertions)]
            // {
            //     if let Some(window) = app.get_webview_window("main") {
            //         window.open_devtools();
            //     }
            // }
            Ok(())
        })
        // 拦截窗口关闭事件：托盘模式启用时隐藏而不是关闭
        .on_window_event(|window, event| {
            // 主窗口最小化/移动时，据 is_minimized 上报显隐，用于任务栏媒体会话优先级
            // （最小化→强制音乐优先）。恢复时 is_minimized 为 false，自动切回按激活模块裁决。
            if window.label() == "main" {
                if matches!(
                    event,
                    tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_)
                ) {
                    let hidden = window.is_minimized().unwrap_or(false);
                    andengyuanhua_lib::smtc::set_window_hidden(hidden);
                }
            }

            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let win_label = window.label();

                // 浮窗笔记等辅助窗口关闭时，不影响歌词悬浮窗和其他辅助窗口。
                // 仅主窗口（label = "main"）关闭时才执行托盘隐藏或辅助窗口销毁逻辑。
                if win_label != "main" {
                    return;
                }

                let tray_enabled = {
                    app.state::<Mutex<TrayModeState>>().lock().unwrap_or_else(|e| e.into_inner()).enabled
                };
                if tray_enabled {
                    api.prevent_close();
                    window.hide().ok();
                    // 窗口隐藏到托盘：强制任务栏媒体会话切回音乐优先
                    andengyuanhua_lib::smtc::set_window_hidden(true);
                    // 托盘模式下同时隐藏歌词悬浮窗，避免它孤立悬浮
                    if let Some(lw) = app.get_webview_window(lyrics_service::LYRICS_WINDOW_LABEL) {
                        let _ = lw.hide();
                    }
                    eprintln!("[TrayMode] 关闭事件已拦截，窗口已隐藏到托盘");
                } else {
                    // 非托盘模式：销毁所有隐藏的辅助窗口（歌词悬浮窗、截图覆盖窗、托盘菜单窗、录屏窗），
                    // 否则这些预创建且一直存在的隐藏窗口会让进程无法退出（表现为「关了窗口却仍在运行」）
                    if let Some(lw) = app.get_webview_window(lyrics_service::LYRICS_WINDOW_LABEL) {
                        let _ = lw.destroy();
                    }
                    if let Some(ow) = app.get_webview_window("screenshot-overlay") {
                        let _ = ow.destroy();
                    }
                    if let Some(tw) = app.get_webview_window("tray-menu") {
                        let _ = tw.destroy();
                    }
                    if let Some(rw) = app.get_webview_window(recording_service::RECORDER_WINDOW_LABEL) {
                        let _ = rw.destroy();
                    }
                    if let Some(rsw) = app.get_webview_window(recording_service::RECORDER_SELECT_LABEL) {
                        let _ = rsw.destroy();
                    }
                    // 录屏区域边框窗（1px 红框，常驻隐藏）也必须销毁，否则进程无法退出
                    if let Some(rbw) = app.get_webview_window(recording_service::RECORDING_BORDER_LABEL) {
                        let _ = rbw.destroy();
                    }
                    // 销毁所有浮窗（剪贴板浮窗 / 中转站浮窗 / 浮窗笔记等，label 均以 floating- 开头），
                    // 避免进程残留或浮窗孤立。「关了主窗却仍在运行」多由这些常驻辅助窗口导致。
                    for (label, w) in app.webview_windows() {
                        if label.starts_with("floating-") {
                            let _ = w.destroy();
                        }
                    }
                }
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        // 从内存态读取当前录屏热键（支持设置面板自定义）
                        let recorder_sc_str = recording_service::recorder_shortcut_state()
                            .lock()
                            .map(|s| s.clone())
                            .unwrap_or_else(|_| recording_service::DEFAULT_RECORDER_SHORTCUT.to_string());
                        let is_recorder = parse_shortcut(&recorder_sc_str)
                            .map(|sc| shortcut == &sc)
                            .unwrap_or(false);

                        if is_recorder {
                            // 录屏流程：先选择区域 → 开始录制 → 显示控制台
                            let is_recording = recording_service::get_recording_status().is_recording;
                            if is_recording {
                                // 正在录制：控制台仍可见 → 停止（toggle）；
                                // 控制台已被自动隐藏 → 仅唤出控制台（不停止），
                                // 让用户能继续查看/操作，再次按热键才停止。
                                if let Some(win) = app.get_webview_window(recording_service::RECORDER_WINDOW_LABEL) {
                                    let visible = win.is_visible().unwrap_or(false);
                                    if visible {
                                        let _ = win.emit("recorder-toggle", ());
                                    } else {
                                        let _ = win.show();
                                        let _ = win.set_focus();
                                        let _ = win.emit("recorder-reveal", ());
                                    }
                                }
                            } else if app
                                .get_webview_window(recording_service::RECORDER_SELECT_LABEL)
                                .map(|w| w.is_visible().unwrap_or(false))
                                .unwrap_or(false)
                            {
                                // 区域选择覆盖窗已显示 → 取消选择
                                if let Some(w) = app.get_webview_window(recording_service::RECORDER_SELECT_LABEL) {
                                    let _ = w.emit("recorder-select-cancel", ());
                                }
                            } else {
                                // 未录制 → 显示区域选择覆盖窗
                                let _ = recording_service::show_recorder_select(app.clone());
                            }
                        } else {
                            // 剪贴板浮窗热键
                            let clip_sc = screenshot::clipboard_shortcut_state()
                                .lock()
                                .map(|s| s.clone())
                                .unwrap_or_else(|_| screenshot::DEFAULT_CLIPBOARD_SHORTCUT.to_string());
                            let is_clip = screenshot::parse_shortcut(&clip_sc)
                                .map(|sc| shortcut == &sc)
                                .unwrap_or(false);
                            if is_clip {
                                let _ = app.emit("open-clipboard-floating", ());
                                return;
                            }
                            // 中转站浮窗热键
                            let dz_sc = screenshot::dropzone_shortcut_state()
                                .lock()
                                .map(|s| s.clone())
                                .unwrap_or_else(|_| screenshot::DEFAULT_DROPZONE_SHORTCUT.to_string());
                            let is_dz = screenshot::parse_shortcut(&dz_sc)
                                .map(|sc| shortcut == &sc)
                                .unwrap_or(false);
                            if is_dz {
                                let _ = app.emit("open-dropzone-floating", ());
                                return;
                            }
                            let _ = app.emit("open-screenshot", ());
                        }
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            // ========== 核心：笔记 CRUD ==========
            get_all_notes,
            search_notes_content,
            get_note_content,
            save_note,
            toggle_pin_note,
            get_note_tags,
            set_note_tags,
            get_all_tags,
            get_all_note_tags_map,
            delete_note,
            duplicate_note,
            // ========== 核心：插件系统（扫描 / 沙箱 / 热插拔 / 分发安装）==========
            get_installed_plugins,
            refresh_plugins,
            read_plugin_file,
            read_external_dep_file,
            read_manifest,
            install_bundled_plugin,
            install_plugin_file,
            install_dep_file,
            install_user_plugin_file,
            configure_auto_save,
            get_auto_save_config,
            set_plugin_visibility,
            reload_plugin,
            unload_plugin,
            delete_plugin,
            open_plugin_folder,
            // ========== 核心：中转站 / 原生拖拽 ==========
            list_transfer_station_files,
            restore_transfer_station_file,
            delete_transfer_station_file,
            clear_transfer_station,
            import_to_dropzone,
            read_dropzone_file,
            read_dropzone_base64,
            prepare_drop_export,
            add_image_to_dropzone,
            add_image_bytes_to_dropzone,
            add_bytes_to_dropzone,
            export_dropzone_file,
            list_dropzone_files,
            start_native_file_drag,
            delete_dropzone_file,
            clear_dropzone,
            // ========== 核心：存档快照 ==========
            archive_snapshot,
            list_archives,
            restore_archive,
            delete_archive,
            clear_archives,
            // ========== 核心：托盘 / 备份 / 黑名单 ==========
            toggle_tray_mode,
            get_tray_mode,
            export_backup,
            get_blacklist,
            get_all_blacklist,
            add_to_blacklist,
            remove_from_blacklist,
            get_blacklist_paths,
            tray_summon_main,
            tray_quit,
            // ========== 核心：通用工具（文件对话框 / 取消扫描）==========
            pick_directory,
            pick_file,
            pick_save_file,
            write_text_file,
            write_file_bytes,
            read_text_file,
            delete_file,
            list_directory,
            ensure_directory,
            check_file_exists,
            cancel_scan,
            // ========== 模块：图片 / 莲花 ==========
            scan_image_root,
            load_image_cache,
            delete_image_cache,
            get_folder_images,
            generate_thumbnail,
            // ========== 模块：音乐 / 铃兰 ==========
            scan_music_root,
            load_music_cache,
            delete_music_cache,
            read_track_metadata,
            // ========== 模块：Windows 原生 SMTC（任务栏「正在播放」）==========
            smtc_update,
            set_active_module,
            set_window_hidden,
            smtc_status,
            debug_log,
            // ========== 模块：视频 / 玉兰 ==========
            scan_video_root,
            load_video_cache,
            delete_video_cache,
            get_folder_videos,
            // ========== 模块：阅读 / 三色堇 ==========
            scan_reading_root,
            load_reading_cache,
            delete_reading_cache,
            open_book,
            cancel_open_book,
            // ========== 模块：歌词 / 铃兰（悬浮窗）==========
            lyrics_service::show_lyrics_widget,
            lyrics_service::hide_lyrics_widget,
            lyrics_service::set_lyrics_widget_locked,
            lyrics_service::get_lyrics_widget_locked,
            lyrics_service::save_lyrics_widget_position,
            lyrics_service::get_lyrics_widget_position,
            lyrics_service::get_lyrics,
            // ========== 模块：WPS 办公（docx / pptx 导入导出）==========
            convert_to_markdown,
            convert_bytes_to_markdown,
            wps_export_docx,
            wps_export_pptx,
            wps_import_pptx,
            diagnostics::wps_import_pptx_diagnose,
            read_file_base64,
            // ========== 模块：薄荷（专业工具 16 合 1）==========
            get_env_vars,
            set_env_var,
            scan_ports,
            list_processes,
            clipboard_read,
            clipboard_write,
            clipboard_read_image,
            clipboard_clear,
            clipboard_poll_image,
            convert_image,
            convert_document,
            check_ffmpeg,
            transcode_media,
            audio_to_midi,
            // ========== 模块：攻防（双轨制内核 + AI 常驻推理）==========
            gongfang_status,
            gongfang_start,
            gongfang_stop,
            gongfang_inject,
            gongfang_scan,
            gongfang_waf_detect,
            gongfang_fetch,
            gongfang_crypto_identify,
            gongfang_symbols,
            gongfang_humanize,
            gongfang_fitness,
            gongfang_fitness_migrate,
            gongfang_fitness_reset,
            gongfang_gateway_status,
            gongfang_gateway_rotate,
            gongfang_gateway_throttle,
            gongfang_gateway_pool,
            // 攻防 P0：通用信息层 + 目标工作区
            gongfang_events_recent,
            gongfang_metrics_history,
            gongfang_ai_reasoning_recent,
            gongfang_set_emit_tick,
            gongfang_target_list,
            gongfang_target_save,
            gongfang_target_delete,
            gongfang_target_activate,
            gongfang_target_get,
            gongfang_target_set_metadata,
            // ========== 模块：截图系统（全局热键 / 多屏 / 标注）==========
            capture_screen,
            start_screenshot,
            read_screenshot,
            peek_screenshot,
            store_screenshot_note_id,
            get_screenshot_note_id,
            create_overlay_window,
            show_overlay_window,
            hide_overlay_window,
            list_windows,
            get_window_title,
            clipboard_write_image,
            clipboard_write_image_from_path,
            clipboard_diagnose,
            recording_service::recording_border_probe,
            crop_native,
            crop_native_rgba,
            save_screenshot,
            save_cropped,
            save_annotated,
            capture_window_full,
            get_screenshot_shortcut,
            set_screenshot_shortcut,
            get_clipboard_shortcut,
            set_clipboard_shortcut,
            get_dropzone_shortcut,
            set_dropzone_shortcut,
            // ========== 模块：录屏系统（全局热键 / WGC 捕获 / ffmpeg 编码）==========
            recording_service::start_recording,
            recording_service::stop_recording,
            recording_service::pause_recording,
            recording_service::resume_recording,
            recording_service::get_recording_status,
            recording_service::list_recording_monitors,
            recording_service::show_recorder_widget,
            recording_service::hide_recorder_widget,
            recording_service::show_recorder_select,
            recording_service::hide_recorder_select,
            recording_service::get_recorder_select_coords,
            recording_service::get_recorder_shortcut,
            recording_service::set_recorder_shortcut,
            recording_service::convert_recording_to_gif,
            recording_service::delete_recording_file,
            diagnostics::recording_self_test,
            // ========== 模块：日志系统（用户可见 log 文件 + 前端错误捕获）==========
            log_service::write_frontend_log,
            log_service::open_log_dir,
            log_service::get_log_files,
            log_service::get_current_log_path,
            // ========== 全局：AI 能力（茑萝 · AI 编程 子插件调用）==========
            ai_service::ai_get_profiles,
            ai_service::ai_set_profiles,
            ai_service::ai_chat,
            ai_service::ai_test_connection,
            ai_service::ai_vision_ocr,
            ai_service::translate_text,
            ai_service::ai_get_conversations,
            ai_service::ai_save_conversations,
            // ========== 全局：IDE 终端（本地 shell 命令执行）==========
            shell_service::run_shell_command,
            // ========== 全局：AI agent 受限 shell（白名单 + Dry-Run 黑名单 + 超时）==========
            shell_service::run_agent_shell,
            // ========== 全局：IDE LSP 诊断（伪 LSP：tsc/cargo check/pyright 一次性命令）==========
            lsp_service::lsp_diagnostics,
            // ========== 全局：IDE MCP 客户端（stdio JSON-RPC，扩展 agent 工具能力）==========
            mcp_service::mcp_list_servers,
            mcp_service::mcp_save_server,
            mcp_service::mcp_remove_server,
            mcp_service::mcp_list_tools,
            mcp_service::mcp_list_all_tools,
            mcp_service::mcp_call_tool,
            // ========== 全局：开发者控制台（关于页面 · 联网/依赖安装）==========
            dev_console_http,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}