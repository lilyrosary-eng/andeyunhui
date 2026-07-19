//! 用户可见日志服务：会话级文件日志 + 自动轮转 + 前端错误捕获。
//!
//! 设计选择（最灵活方案）：**log 文件夹 + 会话轮转**
//! - 每次启动创建新会话日志 `logs/session_YYYYMMDD_HHMMSS.log`
//! - 保留最近 10 个会话日志，自动清理旧文件
//! - Rust 侧通过自定义 `Log` 实现同时写入文件和 stderr（dev 可见，release 静默）
//! - 前端通过 `write_frontend_log` 命令把 `onerror` / `unhandledrejection` / `console.error` 写入同一文件
//! - 用户可通过 `open_log_dir` 命令打开日志文件夹，直接提交 log 文件给开发者排查
//!
//! 优势：
//! 1. 按会话分文件 → 用户可精确定位「某次使用」的日志，无需翻阅海量混合日志
//! 2. 新旧有序 → 文件名含时间戳，自然按时间排序
//! 3. 前后端统一 → Rust 和前端错误写入同一文件，方便关联分析
//! 4. 自动轮转 → 不会无限增长磁盘占用

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::Local;
use chrono::TimeZone;
use log::{Level, Log, Metadata, Record};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

/// 保留的会话日志数量上限
const MAX_SESSION_LOGS: usize = 10;

/// 当前会话日志文件路径（全局，初始化后不变）
static CURRENT_LOG_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 当前会话日志文件句柄（全局，所有写入共用）
static LOG_FILE: Mutex<Option<File>> = Mutex::new(None);

/// 自定义 Logger：实现 `log::Log` trait，同时写入文件和 stderr
struct FileLogger;

impl Log for FileLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= Level::Trace
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let level = record.level();
        let target = record.target();
        let msg = format!(
            "{} [{}] {} - {}",
            Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
            level,
            target,
            record.args()
        );

        // 写入文件
        if let Ok(mut guard) = LOG_FILE.lock() {
            if let Some(file) = guard.as_mut() {
                let _ = writeln!(file, "{}", msg);
                let _ = file.flush();
            }
        }

        // 同时输出到 stderr（dev 可见，release 被 windows_subsystem 隐藏）
        eprintln!("{}", msg);
    }

    fn flush(&self) {
        if let Ok(mut guard) = LOG_FILE.lock() {
            if let Some(file) = guard.as_mut() {
                let _ = file.flush();
            }
        }
    }
}

/// 日志文件信息（返回给前端）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFileInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified: String,
}

/// 获取日志目录路径
fn logs_dir(app_data: &std::path::Path) -> PathBuf {
    app_data.join("logs")
}

/// 初始化会话日志：
/// 1. 确保 logs/ 目录存在
/// 2. 创建新会话日志文件 `session_YYYYMMDD_HHMMSS.log`
/// 3. 清理旧会话日志（保留最近 MAX_SESSION_LOGS 个）
/// 4. 注册自定义 `FileLogger` 为全局日志后端
///
/// 必须在 `tauri::Builder::setup` 之前调用（main 函数开头）。
pub fn init_logger(app_data: &std::path::Path) -> Result<(), String> {
    let dir = logs_dir(app_data);
    fs::create_dir_all(&dir).map_err(|e| format!("创建日志目录失败: {}", e))?;

    // 清理旧会话日志（保留最近 MAX_SESSION_LOGS 个）
    cleanup_old_logs(&dir);

    // 创建新会话日志文件
    let session_name = format!("session_{}.log", Local::now().format("%Y%m%d_%H%M%S"));
    let session_path = dir.join(&session_name);
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .append(true)
        .open(&session_path)
        .map_err(|e| format!("打开日志文件失败: {}", e))?;

    // 写入会话头
    {
        let mut f = file;
        let _ = writeln!(
            f,
            "=== 安得云荟 会话日志 ===\n时间: {}\n版本: {}\n================================\n",
            Local::now().format("%Y-%m-%d %H:%M:%S"),
            env!("CARGO_PKG_VERSION")
        );
        let _ = f.flush();
        // 重新以 append 模式打开（drop 后重开，确保后续写入从末尾开始）
    }

    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .append(true)
        .open(&session_path)
        .map_err(|e| format!("重新打开日志文件失败: {}", e))?;

    // 设置全局状态
    {
        let mut path_guard = CURRENT_LOG_PATH.lock().unwrap();
        *path_guard = Some(session_path.clone());
    }
    {
        let mut file_guard = LOG_FILE.lock().unwrap();
        *file_guard = Some(file);
    }

    // 注册自定义 Logger（替换 env_logger）
    let level = if cfg!(debug_assertions) {
        Level::Debug
    } else {
        Level::Info
    };
    log::set_boxed_logger(Box::new(FileLogger))
        .map_err(|e| format!("注册日志后端失败: {}", e))?;
    log::set_max_level(level.to_level_filter());

    log::info!("日志系统已初始化: {}", session_path.display());
    Ok(())
}

/// 清理旧会话日志，保留最近 MAX_SESSION_LOGS 个（按文件名时间戳排序）
fn cleanup_old_logs(dir: &std::path::Path) {
    let mut entries: Vec<(String, PathBuf)> = Vec::new();
    if let Ok(read_dir) = fs::read_dir(dir) {
        for entry in read_dir.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("session_") && name.ends_with(".log") {
                entries.push((name.clone(), entry.path()));
            }
        }
    }
    // 按文件名降序排列（最新在前）
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    // 删除超出上限的旧文件
    if entries.len() > MAX_SESSION_LOGS {
        for (_, path) in entries.iter().skip(MAX_SESSION_LOGS) {
            let _ = fs::remove_file(path);
        }
        let removed = entries.len() - MAX_SESSION_LOGS;
        eprintln!("[Log] 清理了 {} 个旧会话日志", removed);
    }
}

/// 获取当前会话日志文件路径（公开 API，供其他模块使用）
pub fn current_log_path() -> Option<PathBuf> {
    CURRENT_LOG_PATH.lock().unwrap().clone()
}

/// ============ Tauri 命令 ============

/// 前端写入日志（捕获 window.onerror / unhandledrejection / console.error）
#[tauri::command]
pub fn write_frontend_log(level: String, message: String, source: Option<String>) {
    let lvl = match level.to_uppercase().as_str() {
        "ERROR" => Level::Error,
        "WARN" => Level::Warn,
        "INFO" => Level::Info,
        "DEBUG" => Level::Debug,
        _ => Level::Info,
    };
    let src = source.unwrap_or_else(|| "frontend".to_string());
    log::log!(
        lvl,
        "[{}] {}",
        src,
        message.chars().take(2000).collect::<String>()
    );
}

/// 打开日志文件夹（用户可直接找到 log 文件提交给开发者）
#[tauri::command]
pub fn open_log_dir(app: AppHandle) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 AppData 失败: {}", e))?;
    let dir = logs_dir(&app_data);
    fs::create_dir_all(&dir).map_err(|e| format!("创建日志目录失败: {}", e))?;

    // 使用 tauri-plugin-opener 打开文件夹（跨平台、安全）
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("打开日志目录失败: {}", e))
}

/// 列出所有会话日志文件（最新在前），供前端 UI 展示
#[tauri::command]
pub fn get_log_files(app: AppHandle) -> Result<Vec<LogFileInfo>, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 AppData 失败: {}", e))?;
    let dir = logs_dir(&app_data);
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries: Vec<LogFileInfo> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("读取日志目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("session_") || !name.ends_with(".log") {
            continue;
        }
        let meta = entry.metadata().map_err(|e| format!("读取元数据失败: {}", e))?;
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| {
                Local
                    .timestamp_opt(d.as_secs() as i64, 0)
                    .single()
                    .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        entries.push(LogFileInfo {
            name: name.clone(),
            path: entry.path().to_string_lossy().to_string(),
            size: meta.len(),
            modified,
        });
    }
    // 按文件名降序（最新在前）
    entries.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(entries)
}

/// 获取当前会话日志文件路径（返回给前端）
#[tauri::command]
pub fn get_current_log_path() -> Option<String> {
    current_log_path().map(|p| p.to_string_lossy().to_string())
}
