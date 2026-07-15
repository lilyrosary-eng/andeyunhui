pub mod commands;
pub mod screenshot;
pub mod services;
// 专业模块「薄荷」工具以内部依赖包形式存在（crates/pro-tools-kit）
// 主 crate 通过 `use pro_tools_kit::*;` 直接引入命令（见 main.rs）

/// 托盘模式状态：Rust 侧全局共享
pub struct TrayModeState {
    pub enabled: bool,
}

/// 托盘图标持有者：防止 TrayIcon 被 drop 导致图标消失
pub struct TrayHolder(pub tauri::tray::TrayIcon);