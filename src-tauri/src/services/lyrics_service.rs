use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use crate::services::window_manager::per_window_data_dir;
use lofty::read_from_path;
use lofty::file::AudioFile;
use lofty::file::TaggedFileExt;
use lofty::tag::ItemKey;

/// 歌词窗口标签
pub const LYRICS_WINDOW_LABEL: &str = "lyrics-widget";

/// 歌词窗口可见性变化事件。
///
/// 背景：桌面歌词的开关有两个入口——音乐模块播放栏（主窗）与黄金棋盘浮岛（独立 webview）。
/// 两个 webview 的前端 store 互不相通，若各自维护一份「开着/关着」的内存态必然不同步
/// （浮岛开窗后播放栏仍显示关、歌词数据也没人推）。故以「后端窗口真实可见性」为唯一事实源：
/// show/hide/空闲销毁都广播本事件，两端只做监听与收敛，不再自己猜状态。
fn emit_visibility(app: &AppHandle, visible: bool) {
    let _ = app.emit(
        "lyrics-widget-visibility-changed",
        serde_json::json!({ "visible": visible }),
    );
}

/// 歌词窗口配置持久化
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LyricsWidgetConfig {
    pub x: f64,
    pub y: f64,
    pub locked: bool,
}

impl Default for LyricsWidgetConfig {
    fn default() -> Self {
        Self {
            x: 100.0,
            y: 100.0,
            locked: false,
        }
    }
}

fn lyrics_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {}", e))?;
    Ok(dir.join("lyrics_widget_config.json"))
}

fn load_lyrics_config(app: &AppHandle) -> LyricsWidgetConfig {
    let path = match lyrics_config_path(app) {
        Ok(p) => p,
        Err(_) => return LyricsWidgetConfig::default(),
    };
    if !path.exists() {
        return LyricsWidgetConfig::default();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_lyrics_config(app: &AppHandle, config: &LyricsWidgetConfig) {
    if let Ok(path) = lyrics_config_path(app) {
        if let Ok(json) = serde_json::to_string_pretty(config) {
            let _ = fs::write(&path, json);
        }
    }
}

/// 在 setup() 阶段创建悬浮歌词窗口（初始隐藏）
///
/// 桌面专属：使用 `WebviewWindowBuilder` 的桌面专属方法（title/decorations/always_on_top/
/// transparent/shadow/visible/position/resizable 等），这些方法仅在桌面平台(windows/macos/linux)
/// 存在；Android/iOS 上窗口由 Tauri 移动端 Activity 创建，不应手动建桌面窗。故整函数仅在桌面编译
/// （T2 平台隔离收尾）。移动端补同名同签名桩返回 Err 让调用方在移动端不会编译失败（#android-v1）。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn create_lyrics_widget(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let config = load_lyrics_config(app);

    // 带 floating=lyrics 查询参数：让 index.html 预载脚本跳过哥特加载页，
    // 与 floating-note/clipboard/dropzone 同款「即点即用」，毫秒级响应。
    let window = WebviewWindowBuilder::new(app, LYRICS_WINDOW_LABEL, WebviewUrl::App("index.html?floating=lyrics".into()))
        .title("歌词")
        .inner_size(400.0, 80.0)
        .resizable(true)
        .decorations(false)
        .always_on_top(true)
        .visible(true) // 透明(layered)子窗绝不能用 visible:false 创建，否则 WebView2 报 0x8007139F 坏窗
        .position(-4000.0, -4000.0) // 先置于离屏，待 show_lyrics_widget 时再移到配置位置
        .transparent(true)
        .shadow(false)
        .data_directory(per_window_data_dir(app, LYRICS_WINDOW_LABEL))
        // 独立环境不继承主窗 flag：禁用遮挡检测/后台化，保证失焦时歌词持续滚动重绘
        .additional_browser_args(crate::services::window_manager::OVERLAY_BROWSER_ARGS)
        .build()?;

    // 离屏创建后先隐藏（此时 WebView2 已在离屏态完成初始化，hide 不会触发 0x8007139F），
    // 再移动到配置坐标，待用时由 show_lyrics_widget 显示——避免启动瞬间在主屏闪现。
    let _ = window.hide();
    let _ = window.set_position(tauri::PhysicalPosition::new(config.x as i32, config.y as i32));

    eprintln!("[Lyrics] 悬浮歌词窗口已创建（初始隐藏）位置: ({}, {})", config.x, config.y);

    Ok(())
}

/// 移动端(iOS/Android)桩：与桌面版同名同签名。
/// 移动端窗口由系统接管创建，本手动建歌词浮窗命令在移动端不可用，
/// 返回 Err 让调用方（main.rs setup 的 boot 预创建、show_lyrics_widget 内的重建调用）安全降级。
#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn create_lyrics_widget(_app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    Err("窗口管理在移动端由系统接管".into())
}

/// 显示歌词窗口
#[tauri::command]
pub async fn show_lyrics_widget(app: AppHandle) -> Result<(), String> {
    // 取消空闲回收计时（本次召唤后窗口可见；即便创建失败也无隐藏窗口可回收）
    LYRICS_HIDDEN_AT.store(0, std::sync::atomic::Ordering::SeqCst);
    // P0-3 懒建：窗口不存在（或被销毁）时 marshal 主线程走统一重试引擎创建；
    // 已存在则直接复用（与旧逻辑一致，仅 show + 重新落位）
    crate::services::window_manager::ensure_transparent_window_on_main(
        &app,
        LYRICS_WINDOW_LABEL,
        {
            let a = app.clone();
            move || create_lyrics_widget(&a).map_err(|e| e.to_string())
        },
    )?;
    let mut shown = false;
    if let Some(window) = app.get_webview_window(LYRICS_WINDOW_LABEL) {
        // 重新定位到配置坐标：创建时窗口先置于离屏 (-4000,-4000)，若 WebView 初始化把
        // set_position 覆盖/未生效，窗口会永久停在离屏坐标，导致「歌词有数据但看不到」。
        // 这里在显示时再次按持久化配置落位，并做合法性兜底（负坐标或异常大值回退到主屏 (100,100)）。
        let config = load_lyrics_config(&app);
        let (tx, ty) = if config.x >= 0.0 && config.y >= 0.0
            && config.x < 100000.0 && config.y < 100000.0
        {
            (config.x, config.y)
        } else {
            (100.0, 100.0)
        };
        let _ = window.set_position(tauri::PhysicalPosition::new(tx as i32, ty as i32));
        // 仅 show，不重复设置 always_on_top（创建时已设置，重复调用会触发 DWM 重组合）
        window.show().map_err(|e| format!("显示歌词窗口失败: {}", e))?;
        shown = true;
        eprintln!("[Lyrics] 歌词窗口已显示，定位到 ({}, {})", tx, ty);
    }
    // 真正显示成功才广播：创建失败时不该让两端误以为已打开
    if shown {
        emit_visibility(&app, true);
    }
    Ok(())
}

// ============ 歌词窗口空闲回收 ============
// 窗口常驻（隐藏保留）换取毫秒级召唤，代价是约 420MB 的 WebView2 进程树常驻。
// 空闲超时（隐藏后超过 LYRICS_IDLE_DESTROY_SECS 未再召唤）自动销毁，兼顾
// 「高频开关毫秒级」与「长期不用释放内存」。
// 注意：销毁必须 marshal 主线程执行（后台线程碰窗句柄是红线，见 window_manager 教训）。
const LYRICS_IDLE_DESTROY_SECS: u64 = 600;
static LYRICS_HIDDEN_AT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static LYRICS_IDLE_REAPER_STARTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 启动空闲回收线程（全进程仅一次）：每 60s 检查一次，隐藏超时即销毁歌词窗口。
fn ensure_idle_reaper(app: &AppHandle) {
    use std::sync::atomic::Ordering;
    if LYRICS_IDLE_REAPER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
        let hidden_at = LYRICS_HIDDEN_AT.load(Ordering::SeqCst);
        if hidden_at == 0 || now_secs().saturating_sub(hidden_at) < LYRICS_IDLE_DESTROY_SECS {
            continue;
        }
        // 到点：marshal 主线程安全销毁（闭包内双重检查，防期间被重新召唤/已可见）
        let app_main = app.clone();
        let _ = app.run_on_main_thread(move || {
            use std::sync::atomic::Ordering;
            if LYRICS_HIDDEN_AT.load(Ordering::SeqCst) == 0 {
                return;
            }
            if let Some(w) = app_main.get_webview_window(LYRICS_WINDOW_LABEL) {
                if !w.is_visible().unwrap_or(true) {
                    let _ = w.destroy();
                    LYRICS_HIDDEN_AT.store(0, Ordering::SeqCst);
                    // 空闲销毁同样要让两端开关归位，否则浮岛按钮会一直亮着（窗其实已没了）
                    emit_visibility(&app_main, false);
                    eprintln!("[Lyrics] 空闲超时，歌词窗口已销毁（释放内存，下次召唤重新懒建）");
                }
            } else {
                LYRICS_HIDDEN_AT.store(0, Ordering::SeqCst);
            }
        });
    });
}

/// 隐藏歌词窗口（窗口常驻保留，召唤走毫秒级 show）
///
/// 生命周期取舍演进：曾为「关闭=销毁」（回收 ~420MB WebView2 进程树），但代价是每次
/// 重开都要懒建冷启动（数秒 + 概率失败，用户实测「召唤很久 / 偶尔召唤不出来」），
/// 与高频开关的实际用法（播放时随手开关歌词）严重不匹配。现改为隐藏保留：
/// - 召唤 = `show_lyrics_widget` 的 show() + 落位，毫秒级；
/// - 进程退出（非托盘路径）与托盘模式收起歌词窗时仍销毁，内存不会泄漏到退出后；
/// - 位置/锁定/字体全部持久化，隐藏不丢状态；首次召唤仍走一次懒建（仅一次）。
#[tauri::command]
pub fn hide_lyrics_widget(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LYRICS_WINDOW_LABEL) {
        window.hide().map_err(|e| format!("隐藏歌词窗口失败: {}", e))?;
        // 记账空闲起点 + 启动回收线程（常驻是毫秒级的前提，但不能永久占内存）
        LYRICS_HIDDEN_AT.store(now_secs(), std::sync::atomic::Ordering::SeqCst);
        ensure_idle_reaper(&app);
        eprintln!("[Lyrics] 歌词窗口已隐藏（常驻保留；10 分钟未召唤将自动销毁释放内存）");
    }
    // 无论窗口是否存在都广播 false：让浮岛/播放栏两端的开关状态收敛（幂等）
    emit_visibility(&app, false);
    Ok(())
}

/// 查询歌词窗口当前是否可见：浮岛按钮与播放栏开关共用的初始状态来源。
#[tauri::command]
pub fn get_lyrics_widget_visible(app: AppHandle) -> Result<bool, String> {
    Ok(app
        .get_webview_window(LYRICS_WINDOW_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false))
}

/// 设置歌词窗口锁定状态（true = 窗口级鼠标穿透：整个浮窗不接收鼠标，像桌宠一样）
///
/// 穿透由浮窗前端对自身窗口调用 setIgnoreCursorEvents 应用（见 LyricsWidget.tsx 的 locked effect），
/// 本命令只负责持久化 + 广播同步；解锁入口仅剩主面板 PlayerBar 的锁按钮（浮窗锁图标已移除）。
#[tauri::command]
pub fn set_lyrics_widget_locked(app: AppHandle, locked: bool) -> Result<(), String> {
    // 始终持久化锁定状态（无论悬浮窗口当前是否存在）
    let mut config = load_lyrics_config(&app);
    config.locked = locked;
    save_lyrics_config(&app, &config);
    // 广播锁定状态变化，使主面板（PlayerBar）与悬浮歌词窗口的锁定/解锁按钮保持同步
    let _ = app.emit("lyrics-lock-changed", serde_json::json!({ "locked": locked }));
    eprintln!("[Lyrics] 锁定状态: {}", locked);
    Ok(())
}

/// 获取当前锁定状态
#[tauri::command]
pub fn get_lyrics_widget_locked(app: AppHandle) -> Result<bool, String> {
    let config = load_lyrics_config(&app);
    Ok(config.locked)
}

/// 保存歌词窗口位置（由前端拖拽后调用）
#[tauri::command]
pub fn save_lyrics_widget_position(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
    let mut config = load_lyrics_config(&app);
    config.x = x;
    config.y = y;
    save_lyrics_config(&app, &config);
    eprintln!("[Lyrics] 位置已保存: ({}, {})", x, y);
    Ok(())
}

/// 获取上次保存的歌词窗口位置
#[tauri::command]
pub fn get_lyrics_widget_position(app: AppHandle) -> Result<(f64, f64), String> {
    let config = load_lyrics_config(&app);
    Ok((config.x, config.y))
}

// ========== 歌词数据获取 ==========

/// 歌词行
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LyricLine {
    pub time_ms: u32,
    pub text: String,
}

/// 歌词获取结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LyricsResult {
    pub lines: Vec<LyricLine>,
    pub source: String, // "embedded" | "local" | "online" | ""
}

/// 获取歌词（三层策略，可通过参数调整顺序和跳过联网）
#[tauri::command]
pub async fn get_lyrics(
    track_path: String,
    title: String,
    artist: String,
    skip_online: Option<bool>,
    local_first: Option<bool>,
) -> Result<LyricsResult, String> {
    let skip_online = skip_online.unwrap_or(false);
    let local_first = local_first.unwrap_or(false);

    let path = std::path::Path::new(&track_path);
    let dir = path.parent();

    // 根据 local_first 决定前两层的顺序
    if local_first {
        // 第 1 层：同目录同名 .lrc 文件
        if let Some(dir) = dir {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                let lrc_path = dir.join(format!("{}.lrc", stem));
                if lrc_path.exists() {
                    if let Ok(content) = fs::read_to_string(&lrc_path) {
                        let lines = parse_lrc_timestamp(&content);
                        if !lines.is_empty() {
                            eprintln!("[Lyrics] 本地 LRC 命中: {}", lrc_path.display());
                            return Ok(LyricsResult { lines, source: "local".into() });
                        }
                    }
                }
            }
        }
        // local_first order: local → embedded → online

        // 第 2 层：读取音频文件内嵌歌词
        if let Ok(tagged_file) = read_from_path(path) {
            if let Some(tag) = tagged_file.primary_tag().or_else(|| tagged_file.first_tag()) {
                if let Some(result) = try_embedded_lyrics(tag, track_path.as_str()) {
                    return Ok(result);
                }
            }
        }
    } else {
        // 默认顺序：第 1 层内嵌歌词
        if let Ok(tagged_file) = read_from_path(path) {
            if let Some(tag) = tagged_file.primary_tag().or_else(|| tagged_file.first_tag()) {
                if let Some(result) = try_embedded_lyrics(tag, track_path.as_str()) {
                    return Ok(result);
                }
            }
        }
        // default order: embedded → local → online

        // 第 2 层：同目录同名 .lrc 文件
        if let Some(dir) = dir {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                let lrc_path = dir.join(format!("{}.lrc", stem));
                if lrc_path.exists() {
                    if let Ok(content) = fs::read_to_string(&lrc_path) {
                        let lines = parse_lrc_timestamp(&content);
                        if !lines.is_empty() {
                            eprintln!("[Lyrics] 本地 LRC 命中: {}", lrc_path.display());
                            return Ok(LyricsResult { lines, source: "local".into() });
                        }
                    }
                }
            }
        }
    }

    // 第 3 层：联网获取 LRCLIB（可跳过）
    if skip_online {
        eprintln!("[Lyrics] 已禁用联网获取，未找到歌词: {} - {}", artist, title);
        return Ok(LyricsResult {
            lines: vec![],
            source: "".into(),
        });
    }

    let duration_secs = if let Ok(tagged_file) = read_from_path(path) {
        tagged_file.properties().duration().as_secs()
    } else {
        0
    };

    match fetch_lyrics_online(&title, &artist, duration_secs).await {
        Ok((synced_lyrics, _source)) => {
            let lines = parse_lrc_timestamp(&synced_lyrics);
            if !lines.is_empty() {
                // 保存为本地 .lrc 文件，下次直接命中本地层
                if let Some(dir) = dir {
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        let lrc_path = dir.join(format!("{}.lrc", stem));
                        if let Err(e) = fs::write(&lrc_path, &synced_lyrics) {
                            eprintln!("[Lyrics] 保存 LRC 文件失败: {} ({})", lrc_path.display(), e);
                        } else {
                            eprintln!("[Lyrics] LRC 文件已保存: {}", lrc_path.display());
                        }
                    }
                }
                eprintln!("[Lyrics] 在线歌词命中: {} - {}", artist, title);
                return Ok(LyricsResult { lines, source: "online".into() });
            }
        }
        Err(e) => {
            eprintln!("[Lyrics] 在线获取失败: {}", e);
        }
    }

    // 三种来源都没有歌词
    eprintln!("[Lyrics] 未找到歌词: {} - {}", artist, title);
    Ok(LyricsResult {
        lines: vec![],
        source: "".into(),
    })
}

/// 尝试从内嵌标签读取歌词
fn try_embedded_lyrics(tag: &lofty::tag::Tag, track_path: &str) -> Option<LyricsResult> {
    let lyrics_keys = [
        ItemKey::UnsyncLyrics,
        ItemKey::Lyrics,
    ];
    for key in &lyrics_keys {
        if let Some(lyrics) = tag.get_string(*key) {
            if lyrics.trim().is_empty() { continue; }
            let lines = parse_lrc_timestamp(lyrics);
            if !lines.is_empty() {
                eprintln!("[Lyrics] 内嵌歌词命中 ({:?}, LRC格式): {}", key, track_path);
                return Some(LyricsResult { lines, source: "embedded".into() });
            }
            let lines: Vec<LyricLine> = lyrics
                .lines()
                .filter(|l| !l.trim().is_empty())
                .enumerate()
                .map(|(i, line)| LyricLine {
                    time_ms: i as u32 * 3000,
                    text: line.trim().to_string(),
                })
                .collect();
            if !lines.is_empty() {
                eprintln!("[Lyrics] 内嵌歌词命中 ({:?}, 纯文本): {}", key, track_path);
                return Some(LyricsResult { lines, source: "embedded".into() });
            }
        }
    }
    None
}

/// 解析 LRC 时间戳，兼容以下格式：
///   [mm:ss]           无毫秒（常见于部分文件 / 纯文本歌词）
///   [mm:ss.xx]        [mm:ss.xxx]   标准带毫秒
///   [h:mm:ss]         [h:mm:ss.xx] 带小时（长曲 / 影视 OST）
/// 同时支持「一行多时间戳」如 [00:10.00][00:40.00]歌词
fn parse_lrc_timestamp(input: &str) -> Vec<LyricLine> {
    use regex::Regex;
    // 仅匹配一个时间戳片段（不含文本），循环提取一行中的所有时间戳
    let ts_re = Regex::new(r"\[(\d{1,3}):(\d{1,2})(?::(\d{2}))?(?:\.(\d{1,3}))?\]").unwrap();
    let mut lines: Vec<LyricLine> = Vec::new();

    for line in input.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // 提取该行所有时间戳
        let stamps: Vec<u32> = ts_re
            .captures_iter(line)
            .filter_map(|caps| {
                let first = caps.get(1)?.as_str().parse::<u32>().unwrap_or(0); // 可能是小时或分钟
                let second = caps.get(2)?.as_str().parse::<u32>().unwrap_or(0); // 可能是分钟或秒
                let secs = caps.get(3).map(|c| c.as_str().parse::<u32>().unwrap_or(0));
                let millis_str = caps.get(4).map(|c| c.as_str()).unwrap_or("");
                // 区分 [h:mm:ss] 与 [mm:ss.xx]：若第 3 组（秒）存在 → 时:分:秒；否则 → 分:秒
                let (minutes, seconds, hours) = match secs {
                    Some(s) => (second, s, first),
                    None => (first, second, 0u32),
                };
                let millis: u32 = if millis_str.len() == 2 {
                    millis_str.parse::<u32>().unwrap_or(0) * 10
                } else if millis_str.len() == 3 {
                    millis_str.parse().unwrap_or(0)
                } else {
                    0
                };
                let time_ms = (hours * 3600 + minutes * 60 + seconds) * 1000 + millis;
                Some(time_ms)
            })
            .collect();
        if stamps.is_empty() {
            continue;
        }
        // 文本 = 最后一个 ']' 之后的内容
        let text = match line.rfind(']') {
            Some(idx) => line[idx + 1..].trim().to_string(),
            None => continue,
        };
        if text.is_empty() {
            continue;
        }
        // 一行多时间戳：同一句歌词在多个时间点出现
        for t in stamps {
            lines.push(LyricLine { time_ms: t, text: text.clone() });
        }
    }

    lines.sort_by_key(|l| l.time_ms);
    lines
}

/// 联网获取歌词（LRCLIB）
async fn fetch_lyrics_online(
    title: &str,
    artist: &str,
    duration_secs: u64,
) -> Result<(String, String), String> {
    let client = reqwest::Client::builder()
        .user_agent("安得云荟/1.0")
        .timeout(std::time::Duration::from_secs(5))
        .no_proxy()
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let url = format!(
        "https://lrclib.net/api/get?track_name={}&artist_name={}&duration={}",
        urlencoding(&title),
        urlencoding(&artist),
        duration_secs
    );

    let response = client.get(&url).send().await.map_err(|e| {
        if e.is_timeout() {
            "请求超时".to_string()
        } else {
            format!("网络请求失败: {}", e)
        }
    })?;

    let status = response.status();
    if status == 404 {
        // 精确匹配失败，尝试搜索
        return search_lyrics_online(&client, title, artist).await;
    }
    if status == 429 {
        return Err("LRCLIB 限流 (429)".to_string());
    }
    if !status.is_success() {
        return Err(format!("LRCLIB 返回 HTTP {}", status));
    }

    let json: serde_json::Value = response.json().await.map_err(|e| format!("JSON 解析失败: {}", e))?;
    let synced = json["syncedLyrics"].as_str().unwrap_or("").to_string();

    if synced.is_empty() {
        return Err("无同步歌词".to_string());
    }

    Ok((synced, "online".into()))
}

/// 搜索歌词（LRCLIB /api/search 降级方案）
async fn search_lyrics_online(
    client: &reqwest::Client,
    title: &str,
    artist: &str,
) -> Result<(String, String), String> {
    let url = format!(
        "https://lrclib.net/api/search?track_name={}&artist_name={}",
        urlencoding(title),
        urlencoding(artist)
    );

    let response = client.get(&url).send().await.map_err(|e| {
        if e.is_timeout() {
            "搜索超时".to_string()
        } else {
            format!("搜索请求失败: {}", e)
        }
    })?;

    let status = response.status();
    if status == 429 {
        return Err("LRCLIB 搜索限流 (429)".to_string());
    }
    if !status.is_success() {
        return Err(format!("LRCLIB 搜索返回 HTTP {}", status));
    }

    let results: Vec<serde_json::Value> = response.json().await.map_err(|e| format!("JSON 解析失败: {}", e))?;

    if results.is_empty() {
        return Err("搜索结果为空".to_string());
    }

    let result = &results[0];
    let synced = result["syncedLyrics"].as_str().unwrap_or("").to_string();

    if synced.is_empty() {
        return Err("搜索结果的歌词为空".to_string());
    }

    Ok((synced, "online".into()))
}

/// 简单的 URL 编码（仅编码中文和特殊字符）
fn urlencoding(s: &str) -> String {
    let mut encoded = String::new();
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            b' ' => {
                encoded.push('+');
            }
            _ => {
                encoded.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    encoded
}

/// 歌词文本结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsTextResult {
    pub text: String,
    pub source: String,
}

/// 获取曲目原始歌词文本（优先同目录同名 .lrc 文件，其次内嵌歌词）。
#[tauri::command]
pub async fn get_lyrics_text(track_path: String) -> Result<LyricsTextResult, String> {
    let path = PathBuf::from(&track_path);

    // 1. 优先读取 .lrc
    if let Some(parent) = path.parent() {
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            let lrc_path = parent.join(format!("{}.lrc", stem));
            if lrc_path.exists() {
                let text = fs::read_to_string(&lrc_path)
                    .map_err(|e| format!("读取 LRC 文件失败: {}", e))?;
                return Ok(LyricsTextResult {
                    text,
                    source: "lrc".into(),
                });
            }
        }
    }

    // 2. 回退内嵌歌词原始文本
    let tagged_file = read_from_path(&path)
        .map_err(|e| format!("读取音频文件失败: {}", e))?;
    let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag());
    if let Some(tag) = tag {
        for key in [ItemKey::UnsyncLyrics, ItemKey::Lyrics] {
            if let Some(text) = tag.get_string(key) {
                if !text.trim().is_empty() {
                    return Ok(LyricsTextResult {
                        text: text.to_string(),
                        source: "embedded".into(),
                    });
                }
            }
        }
    }

    Ok(LyricsTextResult {
        text: String::new(),
        source: "none".into(),
    })
}

/// 保存歌词：写入内嵌标签，并可选择同时写入同目录同名 .lrc 文件。
#[tauri::command]
pub async fn save_track_lyrics(
    track_path: String,
    lyrics: String,
    save_to_lrc: bool,
) -> Result<(), String> {
    let path = PathBuf::from(&track_path);

    // 写入 .lrc 文件
    if save_to_lrc {
        let parent = path.parent().ok_or("无法获取音频文件目录")?;
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or("无法获取文件名")?;
        let lrc_path = parent.join(format!("{}.lrc", stem));
        fs::write(&lrc_path, &lyrics)
            .map_err(|e| format!("写入 LRC 文件失败: {}", e))?;
    }

    // 写入内嵌标签
    let mut tagged_file = read_from_path(&path)
        .map_err(|e| format!("读取音频文件失败: {}", e))?;
    {
        let tag = if let Some(t) = tagged_file.primary_tag_mut() {
            t
        } else {
            tagged_file
                .first_tag_mut()
                .ok_or("音频文件没有可写入的标签")?
        };
        tag.insert_text(ItemKey::UnsyncLyrics, lyrics);
    }
    tagged_file
        .save_to_path(&path, lofty::config::WriteOptions::default())
        .map_err(|e| format!("保存音频标签失败: {}", e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lrc_standard_mmss_xx() {
        let lines = parse_lrc_timestamp("[00:10.00]第一句\n[00:20.50]第二句");
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].time_ms, 10_000);
        assert_eq!(lines[0].text, "第一句");
        assert_eq!(lines[1].time_ms, 20_500);
        assert_eq!(lines[1].text, "第二句");
    }

    #[test]
    fn lrc_millis_variants() {
        assert_eq!(parse_lrc_timestamp("[00:10.123]x")[0].time_ms, 10_123);
        // 两位毫秒 → ×10
        assert_eq!(parse_lrc_timestamp("[00:10.12]x")[0].time_ms, 10_120);
        // 一位毫秒 → 0（现状行为）
        assert_eq!(parse_lrc_timestamp("[00:10.1]x")[0].time_ms, 10_000);
        // 无毫秒
        assert_eq!(parse_lrc_timestamp("[00:10]x")[0].time_ms, 10_000);
    }

    #[test]
    fn lrc_hour_minute_second() {
        let lines = parse_lrc_timestamp("[1:02:03.456]x");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].time_ms, 3_723_456);
    }

    #[test]
    fn lrc_multiple_timestamps_one_line() {
        let lines = parse_lrc_timestamp("[00:10.00][00:40.00]副歌");
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].time_ms, 10_000);
        assert_eq!(lines[1].time_ms, 40_000);
        assert_eq!(lines[0].text, "副歌");
        assert_eq!(lines[1].text, "副歌");
    }

    #[test]
    fn lrc_lines_without_timestamp_skipped() {
        let lines = parse_lrc_timestamp("纯文本行\n[00:10.00]ok\n\n");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "ok");
    }

    #[test]
    fn lrc_metadata_tags_skipped() {
        // [ti:...]/[ar:...] 等元数据行无数字时间戳 → 跳过
        let lines = parse_lrc_timestamp("[ti:歌名]\n[ar:歌手]\n[00:10.00]start");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "start");
    }

    #[test]
    fn lrc_timestamp_without_text_skipped() {
        assert!(parse_lrc_timestamp("[00:10.00]").is_empty());
    }

    #[test]
    fn lrc_output_sorted_by_time() {
        let lines = parse_lrc_timestamp("[00:30.00]later\n[00:10.00]earlier");
        assert_eq!(lines[0].time_ms, 10_000);
        assert_eq!(lines[1].time_ms, 30_000);
    }

    #[test]
    fn lrc_trailing_bracket_quirk() {
        // 现状行为：text 取最后一个 ']' 之后 → "[00:10.00]a]b" 的 text 是 "b"
        let lines = parse_lrc_timestamp("[00:10.00]a]b");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "b");
        // 以 ']' 结尾导致 text 为空 → 整行被丢弃
        assert!(parse_lrc_timestamp("[00:10.00]some [text]").is_empty());
    }

    #[test]
    fn lrc_garbage_input_no_panic() {
        assert!(parse_lrc_timestamp("").is_empty());
        assert!(parse_lrc_timestamp("]").is_empty());
        // "[bad]" 不是时间戳，不影响 "[00:10.00]" 的解析，text = 最后一个 ']' 之后
        let lines = parse_lrc_timestamp("[00:10.00][bad]x");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "x");
    }
}