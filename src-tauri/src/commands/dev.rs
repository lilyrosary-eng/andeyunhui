//! 开发期控制台 HTTP 调试入口
//!
//! 本文件由 commands.rs 拆分而来（2026-10-18，P1-5 拆 god file）。
//! 约定：用 `use super::*;` 取父模块的 use 与同级 item，不要在子模块里重复 import
//! 父模块已有的依赖；确需额外 import 时写显式路径（显式优先于 glob，不会冲突）。

#![allow(dead_code)] // 部分命令仅在特定平台/配置下被 invoke_handler 引用

// 本模块只用 std/reqwest，不需要父模块的 use（避免 unused import 告警）

/// 开发者控制台 HTTP 联网命令。
/// 仅支持 http/https 协议；GET/POST 方法；可选 body 与 headers。
/// 超时 30s；返回 "HTTP <status>\n\n<response_body>"。
/// 用于开发者控制台中的 `http GET <url>` / `http POST <url> <body>` 热指令。
#[tauri::command]
pub async fn dev_console_http(
    method: String,
    url: String,
    body: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
) -> Result<String, String> {
    // 协议白名单：仅 http/https
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("仅支持 http/https 协议".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("构建 client 失败: {}", e))?;

    let method_upper = method.to_uppercase();
    let mut req = match method_upper.as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        _ => return Err(format!("不支持的方法: {}", method)),
    };

    if let Some(h) = headers {
        for (k, v) in h {
            req = req.header(k, v);
        }
    }
    if let Some(b) = body {
        req = req.body(b);
    }

    let resp = req.send().await.map_err(|e| format!("请求失败: {}", e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
    Ok(format!("HTTP {} {}\n\n{}", status.as_u16(), status.canonical_reason().unwrap_or_default(), text))
}

/// 实验用：把显示缩放交给 **webview 本身**（WebView2 `SetZoomFactor` / WebKitGTK `set_zoom_level`），
/// 用来验证能否取代宿主的 CSS `zoom` 包裹层。
///
/// 为什么值得试：CSS zoom 包在文档内部，于是 `getBoundingClientRect()`（视觉像素）与
/// `clientWidth/offsetLeft/scrollTop`（布局像素）分属两个坐标系 —— 全仓已审出 15+ 处混用，
/// 表现为落笔偏移、浮层错位、画布欠采样、多层平铺底纹出接缝。webview 级缩放让两者回到同一坐标系。
///
/// 平台事实（读 wry 源码确认，非推测）：
/// - Windows / Linux / macOS 均为真实实现；
/// - **Android 是空实现**（`fn zoom(&self, _) -> Ok(())`），所以移动端仍需保留 CSS zoom 方案。
#[tauri::command]
pub fn set_window_zoom(
    app: tauri::AppHandle,
    factor: f64,
    label: Option<String>,
) -> Result<(), String> {
    use tauri::Manager;
    let name = label.unwrap_or_else(|| "main".to_string());
    let window = app
        .get_webview_window(&name)
        .ok_or_else(|| format!("找不到窗口：{name}"))?;
    window.set_zoom(factor).map_err(|e| format!("set_zoom 失败：{e}"))
}
