use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use lofty::read_from_path;
use lofty::file::AudioFile;
use lofty::file::TaggedFileExt;
use lofty::tag::ItemKey;

/// 歌词窗口标签
pub const LYRICS_WINDOW_LABEL: &str = "lyrics-widget";

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
pub fn create_lyrics_widget(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let config = load_lyrics_config(app);

    let window = WebviewWindowBuilder::new(app, LYRICS_WINDOW_LABEL, WebviewUrl::App("index.html".into()))
        .title("歌词")
        .inner_size(400.0, 80.0)
        .resizable(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .transparent(true)
        .shadow(false)
        .build()?;

    // 设置初始位置
    let _ = window.set_position(tauri::PhysicalPosition::new(config.x as i32, config.y as i32));

    eprintln!("[Lyrics] 悬浮歌词窗口已创建（初始隐藏）位置: ({}, {})", config.x, config.y);

    Ok(())
}

/// 显示歌词窗口
#[tauri::command]
pub fn show_lyrics_widget(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LYRICS_WINDOW_LABEL) {
        window.show().map_err(|e| format!("显示歌词窗口失败: {}", e))?;
        // 总是置顶
        window.set_always_on_top(true).ok();
        eprintln!("[Lyrics] 歌词窗口已显示");
    } else {
        eprintln!("[Lyrics] 歌词窗口不存在，尝试重新创建");
        create_lyrics_widget(&app).map_err(|e| format!("创建歌词窗口失败: {}", e))?;
        if let Some(window) = app.get_webview_window(LYRICS_WINDOW_LABEL) {
            window.show().map_err(|e| format!("显示歌词窗口失败: {}", e))?;
        }
    }
    Ok(())
}

/// 隐藏歌词窗口
#[tauri::command]
pub fn hide_lyrics_widget(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LYRICS_WINDOW_LABEL) {
        window.hide().map_err(|e| format!("隐藏歌词窗口失败: {}", e))?;
        eprintln!("[Lyrics] 歌词窗口已隐藏");
    }
    Ok(())
}

/// 设置歌词窗口锁定状态（true = 鼠标穿透：歌词区点击穿过到背后窗口，仅解锁按钮可点）
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
        .user_agent("岸灯鸢花/1.0")
        .timeout(std::time::Duration::from_secs(5))
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