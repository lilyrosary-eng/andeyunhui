//! Android 平台入口（T2：PAL 隔离 + Tauri-Android 骨架；T4 将充实为「一张网宿主」）。
//!
//! 本模块仅在 `target_os = "android"` 下编译（见 lib.rs 的 `#[cfg(target_os = "android")]`）。
//! 不引入任何 Windows 专属逻辑；仅搭建最小可用 Tauri-Android 入口：
//! - 创建 `tauri::Builder`；
//! - 在 `setup` 中挂接云就绪句柄（T3 的 local-only 默认实现）与 PAL 占位；
//! - 暂不注册任何 Windows 专属命令（截图/SMTC/录屏/DComp 等），留待 T4。
//!
//! 全部 Android 专属代码通过 `#[cfg(target_os = "android")]` 隔离，Windows 构建不受影响。

/// Tauri-Android 应用入口。
///
/// 通过 `#[tauri::mobile_entry_point]` 在 Android 上生成 JNI/C FFI 入口，由 Java 侧调用。
/// 当前阶段（T2）仅搭建骨架：Builder + 云就绪占位；具体命令与 PAL 业务能力在 T4 充实。
#[tauri::mobile_entry_point]
pub fn run() {
    // 云就绪句柄（T3 local-only 默认实现）：当前仅占位，T4 将作为 `app.manage(...)` 状态注入。
    let _cloud = crate::cloud::local::LocalCloudContext::default();

    let builder = tauri::Builder::default();

    builder
        .setup(|app| {
            // PAL / 云就绪句柄占位：T4 将在此注册 Android 平台抽象与本地-only 业务命令，
            // 例如：
            //   app.manage(crate::cloud::local::LocalCloudContext::new(
            //       app.path().app_data_dir().unwrap_or_default(),
            //   ));
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running 安得云荟 on Android");
}
