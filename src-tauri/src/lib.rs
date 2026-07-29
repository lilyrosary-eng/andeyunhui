//! 安得云荟核心库入口（Android v1 平台隔离骨架，T0–T3）。
//!
//! 平台隔离策略（详见各模块头部注释与 T2 任务报告）：
//! - Windows 专属重模块（截图 / SMTC / DComp 浮窗 / 桌面设备监听）通过 `#[cfg(windows)]`
//!   指向各自真实实现文件；非 Windows（Android / Linux / macOS）通过 `#[cfg(not(windows))]`
//!   指向 `pal/` 下的同名 PAL 桩（返回 Unsupported / 空实现），保证模块在任意非 Windows
//!   目标下可编译且零行为变化。
//! - 仅桌面（非移动）才编译的命令模块 `commands` 与二进制入口 `main.rs`（见 Cargo.toml 的
//!   `[[bin]] target` 配置）在 Android/iOS 下不纳入构建。
//! - `services` 业务模块（笔记/音乐/视频/图片/传输等）保持跨平台；其中 Windows 专属子模块
//!   （录屏捕获、诊断）在 `services/mod.rs` 中按 `#[cfg(windows)]` 隔离。

// === 平台隔离：命令模块仅桌面编译（移动端由 android/ios 入口驱动，命令注册见 T4） ===
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod commands;

// === Windows 专属重模块：windows 走真实实现，非 windows 走 PAL 桩 ===
#[cfg(windows)]
#[path = "screenshot.rs"]
pub mod screenshot;
#[cfg(not(windows))]
#[path = "pal/screenshot.rs"]
pub mod screenshot;

#[cfg(windows)]
#[path = "smtc.rs"]
pub mod smtc;
#[cfg(not(windows))]
#[path = "pal/smtc.rs"]
pub mod smtc;

#[cfg(windows)]
#[path = "dcomp_overlay.rs"]
pub mod dcomp_overlay;
#[cfg(not(windows))]
#[path = "pal/dcomp_overlay.rs"]
pub mod dcomp_overlay;

// 桌面全局设备监听：rdev 在 Windows/Linux/macOS 可用，Android/iOS 无后端 → 移动走 PAL 桩。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[path = "device.rs"]
pub mod device;
#[cfg(any(target_os = "android", target_os = "ios"))]
#[path = "pal/device.rs"]
pub mod device;

// 传输模块：已为跨平台（LocalSend v2 兼容），无需隔离。
pub mod transfer;

// 业务服务：跨平台，内部 Windows 专属子模块在 services/mod.rs 隔离。
pub mod services;

// === 云就绪 stub（T3）：Account / RemoteStorage / CloudSync，跨平台（Windows 与 Android 共管） ===
pub mod cloud;

// === 平台专属入口 ===
#[cfg(target_os = "android")]
pub mod android;
#[cfg(target_os = "windows")]
pub mod windows;

// 专业模块「薄荷」工具以内部依赖包形式存在（crates/pro-tools-kit）
// 主 crate 通过 `use pro_tools_kit::*;` 直接引入命令（见 main.rs）

/// 托盘模式状态：Rust 侧全局共享（仅桌面有意义的类型，移动端不使用）。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub struct TrayModeState {
    pub enabled: bool,
}

/// 托盘图标持有者：防止 TrayIcon 被 drop 导致图标消失（仅桌面）。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub struct TrayHolder(pub tauri::tray::TrayIcon);
