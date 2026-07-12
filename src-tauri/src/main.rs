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
const INSTANCE_PORT: u16 = 45991;
use andengyuanhua_lib::commands::*;
use andengyuanhua_lib::pro_tools::*;
use andengyuanhua_lib::screenshot::*;
use andengyuanhua_lib::TrayModeState;
use andengyuanhua_lib::TrayHolder;
use andengyuanhua_lib::services::lyrics_service;
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
    if let Some(m) = app.get_webview_window("tray-menu") {
        let _ = m.hide();
    }
}

#[tauri::command]
fn tray_quit(app: tauri::AppHandle) {
    app.exit(0);
}

fn main() {
    // 初始化日志：dev 默认 debug，release 默认 warn（RUST_LOG 可覆盖）
    let level = if cfg!(debug_assertions) { "debug" } else { "warn" };
    let _ = env_logger::Builder::from_env(
        env_logger::Env::default().filter_or("RUST_LOG", level)
    )
    .format_timestamp_secs()
    .try_init();

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
            let app_data = match app_handle.path().app_data_dir() {
                Ok(dir) => dir,
                Err(_) => {
                    return Response::builder()
                        .status(StatusCode::INTERNAL_SERVER_ERROR)
                        .body(Vec::new())
                        .unwrap();
                }
            };
            let file_path_full = app_data.join("extensions").join(plugin_id).join(file_path);

            // 规范化路径后验证仍在扩展目录内
            let canonical = match file_path_full.canonicalize() {
                Ok(p) => p,
                Err(_) => {
                    return Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .body(Vec::new())
                        .unwrap();
                }
            };
            let extensions_root = app_data.join("extensions");
            if !canonical.starts_with(&extensions_root) {
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

            // 确保「中转站」暂存目录存在（打包后运行时自动创建，无需随包附带）
            let dropzone_dir = app_data.join("transfer_station").join("dropzone");
            std::fs::create_dir_all(&dropzone_dir).map_err(|e| e.to_string())?;
            
            // 首次启动或更新后：从资源目录复制插件到 app_data/extensions/
            let extensions_target = app_data.join("extensions");
            let version_marker = app_data.join(".plugin_version");
            let current_version = env!("CARGO_PKG_VERSION");
            let need_extract = !version_marker.exists() 
                || std::fs::read_to_string(&version_marker).unwrap_or_default() != current_version;
            
            if need_extract {
                // 尝试从资源目录提取打包的插件
                if let Ok(resource_dir) = app.path().resource_dir() {
                    eprintln!("[Setup] resource_dir: {:?}", resource_dir);
                    
                    // 1. 提取插件
                    let bundled_plugins = resource_dir.join("bundled-plugins");
                    // 备选：NSIS 安装包可能把资源放在不同层级
                    if !bundled_plugins.exists() {
                        let alt = resource_dir.join("_up_").join("bundled-plugins");
                        if alt.exists() {
                            eprintln!("[Setup] 使用备选路径: {:?}", alt);
                            extract_if_exists(&alt, &extensions_target, "bundled-plugins");
                        }
                    }
                    extract_if_exists(&bundled_plugins, &extensions_target, "bundled-plugins");

                    // 2. 提取外部依赖
                    let bundled_deps = resource_dir.join("external-deps");
                    if !bundled_deps.exists() {
                        let alt = resource_dir.join("_up_").join("external-deps");
                        if alt.exists() {
                            eprintln!("[Setup] 使用备选路径: {:?}", alt);
                            extract_if_exists(&alt, &app_data.join("external-deps"), "external-deps");
                        }
                    }
                    extract_if_exists(&bundled_deps, &app_data.join("external-deps"), "external-deps");

                    let _ = std::fs::write(&version_marker, current_version);
                } else {
                    eprintln!("[Setup] resource_dir() 不可用，跳过资源提取");
                }
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

            // 创建悬浮歌词窗口
            if let Err(e) = lyrics_service::create_lyrics_widget(app.handle()) {
                eprintln!("[Lyrics] 创建歌词窗口失败: {}", e);
            }

            // ============ 文件系统热插拔监听 ============
            // 监听 extensions/ 和 user_plugins/ 目录变化，检测到新增/删除/修改时
            // 向前端派发 `plugin-fs-change` 事件，前端 PluginHost 自动 load/reload/unload。
            {
                let ext_target = app_data.join("extensions");
                let user_target = app_data.join("user_plugins");
                let app_handle = app.handle().clone();
                let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
                match notify::recommended_watcher(move |res| {
                    let _ = tx.send(res);
                }) {
                    Ok(mut watcher) => {
                        if watcher.watch(&ext_target, RecursiveMode::Recursive).is_ok() {
                            eprintln!("[FSWatch] 监听 extensions/");
                        }
                        if user_target.exists() {
                            let _ = watcher.watch(&user_target, RecursiveMode::Recursive);
                            eprintln!("[FSWatch] 监听 user_plugins/");
                        }
                        // 确保 user_plugins 目录存在（便于后续热插拔）
                        let _ = std::fs::create_dir_all(&user_target);
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
                    // 托盘模式下同时隐藏歌词悬浮窗，避免它孤立悬浮
                    if let Some(lw) = app.get_webview_window(lyrics_service::LYRICS_WINDOW_LABEL) {
                        let _ = lw.hide();
                    }
                    eprintln!("[TrayMode] 关闭事件已拦截，窗口已隐藏到托盘");
                } else {
                    // 非托盘模式：销毁所有隐藏的辅助窗口（歌词悬浮窗、截图覆盖窗、托盘菜单窗），
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
                }
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let _ = app.emit("open-screenshot", ());
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
            configure_auto_save,
            get_auto_save_config,
            set_plugin_visibility,
            reload_plugin,
            unload_plugin,
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
            read_text_file,
            list_directory,
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
            read_file_base64,
            // ========== 模块：薄荷（专业工具 16 合 1）==========
            get_env_vars,
            set_env_var,
            scan_ports,
            list_processes,
            clipboard_read,
            clipboard_write,
            convert_image,
            convert_document,
            check_ffmpeg,
            transcode_media,
            // ========== 模块：截图系统（全局热键 / 多屏 / 标注）==========
            capture_screen,
            start_screenshot,
            read_screenshot,
            store_screenshot_note_id,
            get_screenshot_note_id,
            create_overlay_window,
            show_overlay_window,
            hide_overlay_window,
            list_windows,
            get_window_title,
            clipboard_write_image,
            crop_native,
            crop_native_rgba,
            save_screenshot,
            save_cropped,
            capture_window_full,
            get_screenshot_shortcut,
            set_screenshot_shortcut,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 递归复制目录（用于从资源目录提取插件到 app_data_dir）
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), std::io::Error> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dest_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            std::fs::copy(entry.path(), &dest_path)?;
        }
    }
    Ok(())
}

/// 如果 src 存在，清空 dst 并递归复制 src → dst，记录日志
fn extract_if_exists(src: &std::path::Path, dst: &std::path::Path, label: &str) {
    if !src.exists() {
        eprintln!("[Setup] {} 不存在于: {:?}", label, src);
        return;
    }
    eprintln!("[Setup] 从资源目录提取 {}: {:?}", label, src);
    if dst.exists() {
        let _ = std::fs::remove_dir_all(dst);
    }
    if let Err(e) = copy_dir_recursive(src, dst) {
        eprintln!("[Setup] 复制 {} 失败: {}", label, e);
    } else {
        eprintln!("[Setup] {} 复制完成", label);
    }
}