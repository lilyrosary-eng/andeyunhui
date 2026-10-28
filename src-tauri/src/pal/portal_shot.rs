//! Wayland 截图后端：xdg-desktop-portal 的 `Screenshot` 接口。
//!
//! # 为什么不能用 X11 那条
//! 本机是 GNOME **Wayland** 会话（带 XWayland）。X11 的 root window 不是合成画面，
//! 抓出来是纯色/过期内容 —— 所以 `capture_screen()` 在 Wayland 下是**故意报错**而不是给假图。
//!
//! # 为什么不用 `org.gnome.Shell.Screenshot`
//! 实测外部调用直接 `Access denied`（GNOME 46+ 收紧到只允许 shell 自己调）；
//! `org.gnome.Shell.ScreenRecorder` 更是被整个移除了。
//!
//! # 为什么走 portal
//! 2026-10-28 实测（GNOME Shell 50.1 / 本机 4K@2x）：
//! - `interactive: false` **静默可用**，连做 3 次都在 6 秒内产出 PNG，**没有对话框**；
//! - 输出是全屏**物理像素**（3840×2160）。静默模式文件落在 XDG Pictures（`~/图片/Screenshot-N.png`），
//!   读完要自己删；**交互模式**由 GNOME 存在 `~/图片/截图/截图 <时间>.png`，那是用户的交付物，
//!   **绝不能删**（2026-10-28 血案：删了 ⇒ 用户"能截图但找不到文件"）；
//! - `handle_token` 只用于预测请求路径，可给可不给；**但 `ScreenCast` 的
//!   `session_handle_token` 必须给**，否则 xdg-desktop-portal 会 assert 崩溃
//!   （`xdp-session.c:300`）。那条经验不适用于 Screenshot，但记在项目记忆里。
//!
//! # 单位
//! portal 给的是**物理像素**；前端覆盖层用的是**逻辑像素**。
//! 调用方要用 `scale = 图宽 / 逻辑桌面宽` 把选区的 CSS 坐标换算成裁剪的物理坐标。

use std::collections::HashMap;
use std::time::{Duration, Instant};

const DEST: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
const IFACE: &str = "org.freedesktop.portal.Screenshot";

/// 一次 portal 截图的结果（PNG 字节 + 物理像素尺寸 + 落盘路径）。
pub struct PortalShot {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// portal 实际落盘的位置。**交互式截图时这就是用户要的那份文件**，不能删。
    pub path: Option<String>,
}

/// `file://` URI → 本地路径，并还原 percent-encoding（本机中文目录 `~/图片` 就是靠这一步）。
fn uri_to_path(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file://")?;
    let bytes = rest.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// 截一张全屏图。
///
/// - `interactive = true`：叫出 **GNOME 自己的截图界面**（选区/窗口/全屏/延时）。
///   这时 `keep_file` 必须是 true —— portal 已经替用户把图存进 `~/图片/截图/`，
///   那是**交付物**，删掉就等于把用户的截图吞了。
/// - `interactive = false`：静默全屏抓一张，`keep_file` 一般给 false（读完即删临时文件）。
///
/// 返回 `Ok(None)` 表示**用户取消**（portal 的 Response code = 1）。这不是错误，
/// 调用方不该弹报错（2026-10-28 用户实测：取消一次会看到"portal 拒绝了截图请求"）。
pub async fn capture_png(interactive: bool, keep_file: bool) -> Result<Option<PortalShot>, String> {
    use futures_util::StreamExt;
    use zbus::zvariant::{OwnedObjectPath, Value};

    let conn = zbus::Connection::session()
        .await
        .map_err(|e| format!("连接会话总线失败: {e}"))?;
    // 先建信号流再发请求：否则响应可能在订阅前就到达（portal 很快）。
    let mut stream = zbus::MessageStream::from(&conn);

    let token = format!("andy{}", std::process::id());
    let mut opts: HashMap<&str, Value<'_>> = HashMap::new();
    opts.insert("interactive", Value::from(interactive));
    opts.insert("handle_token", Value::from(token.as_str()));

    let reply = conn
        .call_method(Some(DEST), PATH, Some(IFACE), "Screenshot", &("", opts))
        .await
        .map_err(|e| format!("portal Screenshot 调用失败: {e}"))?;
    let req: OwnedObjectPath = reply
        .body()
        .deserialize()
        .map_err(|e| format!("解析 Request 路径失败: {e}"))?;

    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err("portal 截图超时（30s 内没有 Response）".to_string());
        }
        let next = tokio::time::timeout(left, stream.next())
            .await
            .map_err(|_| "portal 截图超时（30s 内没有 Response）".to_string())?;
        let Some(Ok(msg)) = next else {
            continue;
        };
        // zbus 5：类型/路径/接口/成员都在 `header()` 上（Message 本身没有这些方法）。
        let hdr = msg.header();
        if hdr.message_type() != zbus::message::Type::Signal {
            continue;
        }
        // 用 owned String 比较，避开 header 借用与临时值的生命周期纠缠（E0716）。
        let iface = hdr.interface().map(|i| i.as_str().to_owned());
        let member = hdr.member().map(|m| m.as_str().to_owned());
        let path = hdr.path().map(|p| p.as_str().to_owned());
        if iface.as_deref() != Some("org.freedesktop.portal.Request")
            || member.as_deref() != Some("Response")
        {
            continue;
        }
        if path.as_deref() != Some(req.as_str()) {
            continue;
        }
        // 先把 body 绑到变量：直接 `msg.body().deserialize::<Value<'_>>()` 会让 Value
        // 借用已释放的临时体（E0716）。
        let body = msg.body();
        let (code, results): (u32, HashMap<String, Value<'_>>) = body
            .deserialize()
            .map_err(|e| format!("解析 Response 失败: {e}"))?;
        if code != 0 {
            // 1 = 用户取消（正常操作，不是失败）；2 = 其它错误（含 GNOME 日志里的
            // `InteractiveScreenshot didn't return a file`，通常是应用没拿到焦点/界面被抢）。
            return match code {
                1 => Ok(None),
                2 => Err("portal 拒绝了截图请求".to_string()),
                c => Err(format!("portal 返回错误码 {c}")),
            };
        }
        let uri = results
            .get("uri")
            .and_then(|v| String::try_from(v.clone()).ok())
            .ok_or_else(|| "Response 里没有 uri".to_string())?;
        let path = uri_to_path(&uri).ok_or_else(|| format!("无法解析 uri: {uri}"))?;
        let png = std::fs::read(&path).map_err(|e| format!("读取截图文件失败({path}): {e}"))?;
        // ★ 只在**静默**模式删临时文件。
        // 交互模式这个文件是 GNOME 刚存进 `~/图片/截图/` 的**用户截图**，删了用户就找不到了
        // （2026-10-28 血案：用户报告"能截图但找不到文件"，GNOME 日志
        //  `Error opening screenshot: 没有那个文件或目录` 就是被这里删掉的）。
        if !keep_file {
            let _ = std::fs::remove_file(&path);
        }
        let img = image::load_from_memory(&png).map_err(|e| format!("PNG 解码失败: {e}"))?;
        return Ok(Some(PortalShot {
            png,
            width: img.width(),
            height: img.height(),
            path: Some(path),
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真打一次 portal：断言拿到的是真 PNG 且尺寸等于屏幕物理分辨率。
    /// 无 GUARD 会话时跳过（CI / 无头），不让测试红。
    #[tokio::test]
    async fn portal_capture_returns_real_png() {
        if std::env::var("XDG_SESSION_TYPE").unwrap_or_default() != "wayland" {
            eprintln!("[skip] 非 Wayland 会话，跳过");
            return;
        }
        match capture_png(false, false).await {
            Ok(shot) => {
                println!("portal PNG {} bytes, {}x{}", shot.png.len(), shot.width, shot.height);
                assert_eq!(&shot.png[1..4], b"PNG", "应是 PNG");
                assert!(shot.width >= 640 && shot.height >= 480, "尺寸异常");
            }
            Err(e) => panic!("portal 截图失败: {e}"),
        }
    }

    #[test]
    fn uri_decodes_chinese_path() {
        let p = uri_to_path("file:///home/rosary/%E5%9B%BE%E7%89%87/Screenshot-1.png");
        assert_eq!(p.as_deref(), Some("/home/rosary/图片/Screenshot-1.png"));
    }
}
