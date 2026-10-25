//! 调试开关（Linux 排障用，正式版可通过删配置文件恢复默认行为）。
//!
//! 背景：音乐模块会让 WebKitWebProcess 以 `corrupted double-linked list`（glibc 堆损坏）abort，
//! 而 release 是 panic="abort" 且 WebKit 无符号 ⇒ 只能靠**二分**定位。
//! 用户不是从终端启动的，环境变量不方便传，所以约定一个配置文件：
//!   `~/.config/andeyunhui/debug.json`，例：`{ "noMediasession": true }`
//! 文件不存在 = 全 false（正常行为）。

use serde::Deserialize;
use std::sync::OnceLock;
use tauri::Manager;

#[derive(Debug, Clone, Copy, Default, Deserialize, serde::Serialize)]
pub struct DebugFlags {
    /// 不注册 navigator.mediaSession 动作（用于判断 MediaSession 是否与 WebKit 崩溃有关）
    #[serde(default)]
    pub no_mediasession: bool,
}

static FLAGS: OnceLock<DebugFlags> = OnceLock::new();
/// AppHandle 由 setup 阶段注入（config_dir 需要它）。
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// 在 setup 里调用一次，让 get() 能解析 config_dir。
pub fn init(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

pub fn get() -> &'static DebugFlags {
    FLAGS.get_or_init(|| {
        let Some(dir) = APP.get().and_then(|a| a.path().config_dir().ok()) else {
            return DebugFlags::default();
        };
        let path = dir.join("andeyunhui").join("debug.json");
        match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(_) => DebugFlags::default(),
        }
    })
}

/// 给前端的查询命令。
#[tauri::command]
pub fn debug_flags() -> DebugFlags {
    *get()
}

