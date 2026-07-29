pub mod commands;
pub mod smtc;
pub mod screenshot;
pub mod transfer;
pub mod dcomp_overlay;
pub mod services;
pub mod device;

// === Android / Windows 平台隔离骨架（T0：Android v1 基建）===
// 各平台专属入口模块：仅对应目标编译，互不污染。
// - android：Tauri-Android 入口骨架（后续 T4 填充 run()）
// - windows：Windows 桌面端专属胶水占位（现有桌面代码仍以顶层 mod 形式存在，此模块为占位骨架）
#[cfg(target_os = "android")]
pub mod android;
#[cfg(target_os = "windows")]
pub mod windows;

// 专业模块「薄荷」工具以内部依赖包形式存在（crates/pro-tools-kit）
// 主 crate 通过 `use pro_tools_kit::*;` 直接引入命令（见 main.rs）

/// 托盘模式状态：Rust 侧全局共享
pub struct TrayModeState {
    pub enabled: bool,
}

/// 托盘图标持有者：防止 TrayIcon 被 drop 导致图标消失
pub struct TrayHolder(pub tauri::tray::TrayIcon);