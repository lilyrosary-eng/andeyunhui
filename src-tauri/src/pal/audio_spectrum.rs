//! 频谱分析 PAL 桩 — 非 Windows 平台空实现

pub fn start_spectrum_capture(_app: tauri::AppHandle) -> Result<(), String> {
    Err("频谱分析仅在 Windows 上可用".into())
}

pub fn stop_spectrum_capture() {}

pub fn get_spectrum() -> Vec<u8> {
    vec![0u8; 64]
}
