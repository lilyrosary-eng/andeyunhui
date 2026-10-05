// ============ 非 Windows 平台的诊断服务桩 ============
//
// 与 `pal/recording_service.rs` 同理：`services::diagnostics` 依赖 `windows-capture`
// （录屏自检要真的起一次 WGC 捕获），因此在 `services/mod.rs` 里是 `#[cfg(windows)]`。
// 这里提供同名同签名的空实现，让 main.rs 的命令注册表无需平台分支。
//
// 签名核对：`grep -n 'pub fn wps_import_pptx_diagnose\|pub async fn recording_self_test' src/services/diagnostics.rs`
#![allow(dead_code)]

use serde_json::{json, Value};
use tauri::AppHandle;

/// 对应 Windows 版：`pub async fn recording_self_test(app: AppHandle, duration_secs: Option<u32>) -> Value`
///
/// 录屏自检在非 Windows 上无法执行（无 WGC 捕获后端）。返回结构与 Windows 版**同形状**，
/// 只是 `passed=false` 并带上原因 —— 前端按同一套逻辑渲染，用户看到的是
/// 「自检未通过：仅 Windows 可用」而不是脚本报错或页面空着。
#[tauri::command]
pub async fn recording_self_test(_app: AppHandle, _duration_secs: Option<u32>) -> Value {
    json!({
        "passed": false,
        "supported": false,
        "reason": "录屏自检依赖 Windows Graphics Capture，仅在 Windows 上可用",
        "framesCaptured": 0,
        "durationMs": 0,
    })
}

/// 对应 Windows 版：`pub fn wps_import_pptx_diagnose(app: AppHandle, path: String) -> Value`
///
/// WPS 导入诊断本身不依赖 Windows 捕获，但该模块整体被门控了（为了和
/// `recording_self_test` 同处一个模块）。这里返回一份**说明性**结果而不是硬编造诊断数据：
/// 误导性的诊断输出比没有输出更糟。
#[tauri::command]
pub fn wps_import_pptx_diagnose(_app: AppHandle, path: String) -> Value {
    json!({
        "ok": false,
        "supported": false,
        "path": path,
        "reason": "该诊断依赖 Windows 侧实现，Linux 上暂不可用",
        "checks": [],
    })
}
