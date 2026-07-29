//! PAL 桩：非 Windows（Android / iOS）下全局设备监听占位。
//!
//! 桌面端用 `rdev` 全局钩子被动监听鼠标 / 键盘输入，供桌宠浮窗实现「光标跟随」「按键显示」。
//! 移动端无原生输入监听后端，本文件通过 `lib.rs` 的 `#[cfg(any(target_os = "android", target_os = "ios"))]`
//! 路径替换接管 `device` 模块，提供与桌面实现「同名」的公共 API，但函数返回空实现。

#![allow(dead_code)]

/// 事件载荷（与桌面实现同名字段，前端按 `t` 分支处理）。
#[derive(Clone, serde::Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum DeviceEvent {
    MouseMove { x: f64, y: f64 },
    MouseDown,
    MouseUp,
    KeyDown { key: String },
    KeyUp { key: String },
}

/// 启动全局设备监听（移动端空实现占位：无 rdev 后端）。
pub fn start_device_listening(_app: tauri::AppHandle) {
    // 移动端无 rdev 后端：空实现占位，T4+ 可接入平台原生输入 API。
}
