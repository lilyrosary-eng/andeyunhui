//! 频谱分析 PAL 桩 — 非 Windows 平台空实现

pub fn start_spectrum_capture(_app: tauri::AppHandle) -> Result<(), String> {
    Err("频谱分析仅在 Windows 上可用".into())
}

pub fn stop_spectrum_capture() {}

pub fn get_spectrum() -> Vec<u8> {
    vec![0u8; 64]
}

/// 对应 Windows 版 `pub fn set_listener(active: bool)`（`src/audio_spectrum.rs:47`）。
/// 该模块是 WASAPI Loopback 频谱分析（Windows 专属），非 Windows 走本桩。
///
/// ⚠ **刻意不加 `#[tauri::command]`**：Windows 版这个函数是普通函数，
///   命令包装在 main.rs 的 `spectrum_set_listener` 里。两边必须一致 ——
///   多加属性会额外生成 `__cmd__set_listener` 宏，虽不报错但与 Windows 侧行为不符。
pub fn set_listener(_active: bool) {}
