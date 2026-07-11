pub mod commands;
pub mod pro_tools;
pub mod screenshot;
pub mod services;

/// 托盘模式状态：Rust 侧全局共享
pub struct TrayModeState {
    pub enabled: bool,
}

/// 托盘图标持有者：防止 TrayIcon 被 drop 导致图标消失
pub struct TrayHolder(pub tauri::tray::TrayIcon);