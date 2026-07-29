//! PAL 桩：非 Windows 下 DComp 浮窗（透明合成层）占位。
//!
//! DComp（DirectComposition）/ WebView2 COM 透明窗是 Windows 专属能力。非 Windows 目标无该后端，
//! 本文件通过 `lib.rs` 的 `#[cfg(not(windows))]` 路径替换接管 `dcomp_overlay` 模块，提供与真实
//! 实现「同名」的公共 API，但所有函数返回空实现，保证模块在非 Windows 目标下可编译。

#![allow(dead_code)]

/// WebView2 控制器占位类型。
///
/// 真实实现为 `webview2_com_sys` 的 `ICoreWebView2Controller`（Windows COM 类型）。
/// 非 Windows 无该类型，以单元类型占位，保持「同名」签名，供后续 Android 透明窗后端替换。
pub type ICoreWebView2Controller = ();

/// 指定标签的 DComp 透明层当前是否激活（非 Windows 恒为 false）。
pub fn is_active(_label: &str) -> bool {
    false
}

/// 指定标签的 DComp 透明层被销毁时的清理钩子（非 Windows 空实现）。
pub fn on_destroy(_label: &str) {}

/// 尝试为指定 WebView2 控制器启用 DComp 透明合成（非 Windows 恒返回 false）。
pub fn try_enable(_ctrl: ICoreWebView2Controller, _label: &str, _hwnd: Option<isize>) -> bool {
    false
}
