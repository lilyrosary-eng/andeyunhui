//! Android 平台入口骨架（T0：Android v1 基建）
//!
//! 仅搭建最小可用骨架，不实现任何 PAL 能力或业务模块（那是 T2 / T4 / T5 的工作）。
//! 当前为占位入口，后续 T4 将在此填充 Tauri-Android 的 `run()`（创建 `Builder`、
//! 注册本地-only 模块命令与 PAL 抽象、调用 `generate_context!().run()`）。
//!
//! 全部 Android 专属代码均通过 `#[cfg(target_os = "android")]` 隔离，Windows 构建不受影响。

/// Tauri-Android 应用入口占位。
///
/// 后续 T4 将在此调用 `tauri::Builder::default()` 并 `.run(tauri::generate_context!())`，
/// 注册本地-only 模块（笔记 / 音乐 / 视频 / 图片 / 传输）的命令与 PAL 抽象（T2 落地）。
///
/// 当前阶段不调用、不链接任何 Android 专属逻辑，仅作为骨架占位，确保：
/// 1. `cargo build --target aarch64-linux-android` 在补齐 NDK 且完成 T2 模块门控后可解析到入口；
/// 2. Windows 构建完全不受影响（本模块在 Windows 目标下不编译）。
#[allow(dead_code)]
pub fn run() {
    // TODO(T4): 实现 Tauri-Android 入口：Builder + 插件/命令注册 + generate_context!().run()
    // 本期（T0+T1）仅占位，不引入任何运行时行为。
}
