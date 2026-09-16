//! 媒体中继：`bimedia` 自定义协议
//!
//! # 为什么需要这一层
//!
//! B 站 / 抖音的 CDN **强制校验 Referer**。实测（2026-09-13）B 站全部 CDN 主机
//! —— 含 `upos-sz-*.bilivideo.com` 与 P2P 边缘节点 —— 的表现完全一致：
//!
//! | Referer | 结果 |
//! | --- | --- |
//! | 不带 Referer | **403** |
//! | `https://www.bilibili.com` | 206 ✅ |
//! | `tauri://localhost`（应用页面来源） | **403** |
//! | `http://localhost:1420`（dev 来源） | **403** |
//!
//! 而 `<video src="https://…">` 由 WebView 自己发请求，Referer 只能是应用页面来源，
//! 前端无法伪造 —— 于是「直连播放」必然 403。这正是「网络视频效果不行」的隐藏原因之一。
//!
//! # 方案
//!
//! 前端把媒体地址包成自定义协议 URL：
//! ```text
//! Windows / Android :  http://bimedia.localhost/<b64u(referer)>/<b64u(媒体URL)>
//! macOS / Linux     :  bimedia://localhost/<b64u(referer)>/<b64u(媒体URL)>
//! ```
//! （URL 形态由 tauri `Builder::register_uri_scheme_protocol` 的文档确定，见 tauri 2.x `app.rs`。）
//!
//! Rust 侧解出目标地址，带上正确的 `Referer` / `UA` 去取，并**原样转发 `Range` 头**，
//! 使 WebView 的拖动、分段加载照常工作。
//!
//! # 安全
//!
//! - 只允许 `http` / `https` 目标（拒绝 `file:`、`data:` 等）。
//! - 该协议仅本机 WebView 可发起，外部页面无法访问。
//! - 客户端未带 `Range` 时，主动只取前 [`NO_RANGE_CHUNK`] 字节并回 206，
//!   避免一次性把整部视频读进内存。

use base64::Engine as _;
use std::sync::Mutex;
use std::time::Duration;
use tauri::http::{header, Response, StatusCode};

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/// 单次响应的最大字节数（16 MiB）。
///
/// ⚠️ 这个上限是**必需**的，不是优化：Chromium 对媒体元素常发 `Range: bytes=0-`
/// （开区间 = 从 0 到结尾 = **整片**）。若原样转发，就会把整个视频读进内存再交给
/// WebView —— 几百 MB 的视频必然卡死或失败（表现为「点了播放没反应 / 一直转圈」）。
///
/// 因此这里把「开区间」或「跨度过大」的请求**收窄成固定块**：
/// 上游返回 206 + Content-Range（带总长），WebView 知道总长后会按需继续请求后续块，
/// 拖动也能正常工作。内存占用因此被限制在 MAX_CHUNK 量级。
const MAX_CHUNK: u64 = 16 * 1024 * 1024;

/// 解析单区间 `bytes=start-end`（end 可省略）。多区间等复杂形式返回 None，交给上游处理。
fn parse_single_range(v: &str) -> Option<(u64, Option<u64>)> {
    let spec = v.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (s, e) = spec.split_once('-')?;
    let start: u64 = s.trim().parse().ok()?;
    let e = e.trim();
    if e.is_empty() {
        Some((start, None))
    } else {
        Some((start, Some(e.parse().ok()?)))
    }
}

/// 内嵌浏览器的嗅探上报路径前缀。
///
/// 外部页面**无法使用 Tauri IPC**，所以注入脚本只能借道本协议把结果送出来：
///   `location.href = "http://bimedia.localhost/__report/<b64u(json)>"`
/// 由 `on_navigation` 截获并取消这次导航（见 embedded_browser.rs）。
/// 之所以用「导航」而不是 fetch/sendBeacon：**外部站点自己的 CSP 管不到导航**，
/// 而 `connect-src` 很可能把 fetch 拦掉。
pub const REPORT_PATH_PREFIX: &str = "/__report/";

/// 嗅探上报缓冲：进程内，前端取走即清空。
static SNIFF_REPORTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// 存一条嗅探上报（上限 32 条，避免异常页面把内存撑爆）
pub fn push_sniff_report(json: String) {
    if let Ok(mut buf) = SNIFF_REPORTS.lock() {
        if buf.len() >= 32 {
            buf.remove(0);
        }
        buf.push(json);
    }
}

/// 取走全部嗅探上报（取走即清空）
pub fn take_sniff_reports() -> Vec<String> {
    SNIFF_REPORTS
        .lock()
        .map(|mut b| std::mem::take(&mut *b))
        .unwrap_or_default()
}

pub(crate) fn decode_b64u(s: &str) -> Option<String> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(s)
        .ok()?;
    String::from_utf8(bytes).ok()
}

fn plain(status: StatusCode, msg: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(msg.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// 解析 `/<referer_b64u>/<url_b64u>`，返回 `(referer, target_url)`。
///
/// 兼容两种写法：
/// - `/<referer_b64u>/<url_b64u>`：常规（前端总是这样生成）
/// - `/<url_b64u>`：省略 referer 段，按「无 Referer」请求
///
/// （`//<url_b64u>` 即空 referer 段 + 斜杠，也归入第二种。）
pub fn parse_path(path: &str) -> Option<(String, String)> {
    let rest = path.trim_start_matches('/');
    match rest.split_once('/') {
        Some((r, u)) => {
            let referer = if r.is_empty() { String::new() } else { decode_b64u(r)? };
            Some((referer, decode_b64u(u)?))
        }
        // 没有第二个 segment：整段就是 URL，referer 视为空
        None if !rest.is_empty() => Some((String::new(), decode_b64u(rest)?)),
        None => None,
    }
}

/// 中继一次媒体请求。
pub async fn handle(uri: &tauri::http::Uri, range: Option<String>) -> Response<Vec<u8>> {
    // 嗅探上报通道：不走中继逻辑（见 REPORT_PATH_PREFIX 的注释）
    if let Some(rest) = uri.path().strip_prefix(REPORT_PATH_PREFIX) {
        if let Some(json) = decode_b64u(rest) {
            push_sniff_report(json);
        }
        // 正常情况下 on_navigation 会把这次导航取消掉；这里返回「自动返回上一页」的兜底页面，
        // 万一取消没生效，用户也不会卡在一个空白响应上。
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .body(b"<script>if(history.length>1)history.back()</script>".to_vec())
            .unwrap_or_else(|_| Response::new(Vec::new()));
    }

    let (referer, target) = match parse_path(uri.path()) {
        Some(v) => v,
        None => return plain(StatusCode::BAD_REQUEST, "bimedia: 路径格式应为 /<b64u(referer)>/<b64u(url)>"),
    };

    if !(target.starts_with("https://") || target.starts_with("http://")) {
        return plain(StatusCode::BAD_REQUEST, "bimedia: 只允许 http(s) 目标");
    }

    let client = match reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(20))
        .build()
    {
        Ok(c) => c,
        Err(e) => return plain(StatusCode::INTERNAL_SERVER_ERROR, &format!("bimedia: 构建客户端失败: {e}")),
    };

    // 把客户端 Range 收窄成「最多 MAX_CHUNK 字节」的块，避免整片读进内存。
    // capped = Some(实际请求的字节数)，用于在上游忽略 Range 时自行截断。
    let (range_header, capped) = match range.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(r) => match parse_single_range(r) {
            Some((start, end)) => {
                let span = match end {
                    Some(e) if e >= start => e - start + 1,
                    _ => u64::MAX, // 开区间（bytes=N-）或非法 end
                };
                if span > MAX_CHUNK {
                    (format!("bytes={}-{}", start, start + MAX_CHUNK - 1), Some(MAX_CHUNK))
                } else {
                    (r.to_string(), None) // 跨度已经够小，原样转发
                }
            }
            None => (r.to_string(), None), // 多区间等复杂形式：原样交给上游
        },
        None => (format!("bytes=0-{}", MAX_CHUNK - 1), Some(MAX_CHUNK)),
    };

    let mut req = client
        .get(&target)
        .header(header::USER_AGENT, UA)
        .header(header::ACCEPT, "*/*")
        // 明确不要压缩：否则 reqwest 解压后 Content-Length 与实际字节数不一致，
        // WebView 会因长度不符而中断播放。
        .header(header::ACCEPT_ENCODING, "identity")
        .header(header::RANGE, range_header);
    if !referer.is_empty() {
        req = req.header(header::REFERER, &referer);
    }

    let upstream = match req.send().await {
        Ok(r) => r,
        Err(e) => return plain(StatusCode::BAD_GATEWAY, &format!("bimedia: 上游请求失败: {e}")),
    };

    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let mut body = match upstream.bytes().await {
        Ok(b) => b,
        Err(e) => return plain(StatusCode::BAD_GATEWAY, &format!("bimedia: 读取上游响应失败: {e}")),
    };

    // 上游 4xx/5xx（如 403 防盗链未过）直接透传，便于前端/日志定位
    if !status.is_success() {
        return plain(
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            &format!("bimedia: 上游返回 {}", status.as_u16()),
        );
    }

    let upstream_total = upstream_headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok());

    // 我们主动限了块长（capped），但上游无视 Range 直接回了 200 整片：
    // 必须自行截断并声明 206 + Content-Range，否则 WebView 会认为整片就这么短，
    // 或者干脆把整部视频读进内存。
    let mut self_truncated = false;
    if let Some(cap) = capped {
        if status.as_u16() == 200 {
            if body.len() as u64 > cap {
                body.truncate(cap as usize);
            }
            self_truncated = true;
        }
    }

    let mut builder = Response::builder().status(if self_truncated {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::OK)
    });

    // 透传对播放/拖动有意义的头
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_RANGE,
        header::ETAG,
        header::LAST_MODIFIED,
    ] {
        if let Some(v) = upstream_headers.get(&name) {
            builder = builder.header(name, v);
        }
    }
    // 自行截断且上游没给 Content-Range 时补一个，让 WebView 知道总长（才能继续请求后续块）
    if self_truncated && upstream_headers.get(header::CONTENT_RANGE).is_none() {
        if let Some(total) = upstream_total {
            let end = (body.len() as u64).saturating_sub(1);
            builder = builder.header(header::CONTENT_RANGE, format!("bytes 0-{end}/{total}"));
        }
    }
    builder = builder
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CONTENT_LENGTH, body.len().to_string());

    builder
        .body(body.to_vec())
        .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "bimedia: 构造响应失败"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64u(s: &str) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(s.as_bytes())
    }

    #[test]
    fn parse_path_roundtrip() {
        let referer = "https://www.bilibili.com";
        let target = "https://upos-sz-estgoss.bilivideo.com/upgcxcode/x.mp4?deadline=1&upsig=ab";
        let path = format!("/{}/{}", b64u(referer), b64u(target));
        let (r, u) = parse_path(&path).expect("应能解析");
        assert_eq!(r, referer);
        assert_eq!(u, target);
    }

    #[test]
    fn parse_path_empty_referer() {
        let target = "https://example.com/a.mp4";
        // 省略 referer 段
        let (r, u) = parse_path(&format!("/{}", b64u(target))).expect("省略 referer 段也应能解析");
        assert!(r.is_empty());
        assert_eq!(u, target);
        // 空 referer 段 + 斜杠
        let (r2, u2) = parse_path(&format!("//{}", b64u(target))).expect("空 referer 段也应能解析");
        assert!(r2.is_empty());
        assert_eq!(u2, target);
    }

    #[test]
    fn parse_path_rejects_garbage() {
        assert!(parse_path("/not-base64!/also-bad!").is_none());
        assert!(parse_path("/onlyonesegment").is_none());
    }
}

/// 端到端集成测试：起一个本地「假 CDN」，断言中继真的把 Referer / Range 转发到位、
/// 并在需要时补上 Accept-Ranges 与 Content-Range。
///
/// 全部走 127.0.0.1，**不依赖外网**，因此可以稳定地跑在 CI 里。
#[cfg(test)]
mod integration_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn b64u(s: &str) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(s.as_bytes())
    }

    /// 起一个只处理一次请求的假 CDN。
    /// 返回 (端口, 线程句柄 → 该线程收到的完整请求头文本)，便于断言上游实际收到了什么。
    fn spawn_fake_cdn(
        status_line: &'static str,
        extra_headers: &'static str,
        body: &'static str,
    ) -> (u16, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("绑定本地端口失败");
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().expect("accept 失败");
            let mut raw = Vec::new();
            let mut buf = [0u8; 4096];
            // 读到请求头结束（\r\n\r\n）为止，避免一次 read 拿不全
            loop {
                let n = sock.read(&mut buf).expect("read 失败");
                if n == 0 {
                    break;
                }
                raw.extend_from_slice(&buf[..n]);
                if raw.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let req = String::from_utf8_lossy(&raw).to_string();
            let resp = format!(
                "{status_line}\r\nContent-Type: video/mp4\r\n{extra_headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(resp.as_bytes());
            let _ = sock.flush();
            req
        });
        (port, handle)
    }

    fn relay_uri(referer: &str, target: &str) -> tauri::http::Uri {
        format!("http://bimedia.localhost/{}/{}", b64u(referer), b64u(target))
            .parse()
            .expect("构造协议 URI 失败")
    }

    #[tokio::test]
    async fn forwards_referer_and_caps_when_no_range() {
        const BODY: &str = "0123456789";
        let (port, server) = spawn_fake_cdn("HTTP/1.1 200 OK", "", BODY);
        let target = format!("http://127.0.0.1:{port}/v.mp4");
        let uri = relay_uri("https://www.bilibili.com", &target);

        let resp = handle(&uri, None).await;

        let req = server.join().expect("假 CDN 线程 panic");
        let lower = req.to_lowercase();
        assert!(
            lower.contains("referer: https://www.bilibili.com"),
            "上游应收到正确 Referer（这正是本模块存在的理由）。实际请求：\n{req}"
        );
        assert!(
            lower.contains(&format!("range: bytes=0-{}", MAX_CHUNK - 1)),
            "客户端没带 Range 时应主动截取，避免整片进内存。实际请求：\n{req}"
        );

        assert_eq!(resp.status(), StatusCode::PARTIAL_CONTENT, "截取后必须回 206");
        assert_eq!(
            resp.headers().get(header::ACCEPT_RANGES).map(|v| v.to_str().unwrap()),
            Some("bytes"),
            "必须补 Accept-Ranges，否则 WebView 无法拖动（上游 CDN 实测不返回它）"
        );
        let expected_cr = format!("bytes 0-{}/{}", BODY.len() - 1, BODY.len());
        assert_eq!(
            resp.headers().get(header::CONTENT_RANGE).map(|v| v.to_str().unwrap()),
            Some(expected_cr.as_str()),
            "应补出 Content-Range 让 WebView 知道总长"
        );
        assert_eq!(resp.body().as_slice(), BODY.as_bytes());
    }

    #[tokio::test]
    async fn forwards_range_verbatim() {
        const BODY: &str = "abc";
        let (port, server) = spawn_fake_cdn(
            "HTTP/1.1 206 Partial Content",
            "Content-Range: bytes 100-102/1000\r\n",
            BODY,
        );
        let target = format!("http://127.0.0.1:{port}/v.mp4");
        let uri = relay_uri("https://www.bilibili.com", &target);

        let resp = handle(&uri, Some("bytes=100-102".to_string())).await;

        let req = server.join().expect("假 CDN 线程 panic").to_lowercase();
        assert!(req.contains("range: bytes=100-102"), "应原样转发客户端的 Range。实际请求：\n{req}");
        assert_eq!(resp.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            resp.headers().get(header::CONTENT_RANGE).map(|v| v.to_str().unwrap()),
            Some("bytes 100-102/1000"),
            "上游的 Content-Range 应透传"
        );
        assert_eq!(resp.body().as_slice(), BODY.as_bytes());
    }

    /// 关键回归：Chromium 对媒体元素常发开区间 `bytes=N-`（= 从 N 到结尾 = 整片）。
    /// 若原样转发就会把整部视频读进内存，导致播放卡死 —— 必须收窄成固定块。
    #[tokio::test]
    async fn caps_open_ended_range() {
        const BODY: &str = "abc";
        let capped_end = MAX_CHUNK - 1; // 从 1000 起算，仍是 MAX_CHUNK 字节
        let content_range = format!("Content-Range: bytes 1000-{}/999999999\r\n", 1000 + capped_end);
        let (port, server) = spawn_fake_cdn(
            "HTTP/1.1 206 Partial Content",
            Box::leak(content_range.into_boxed_str()),
            BODY,
        );
        let target = format!("http://127.0.0.1:{port}/v.mp4");
        let uri = relay_uri("https://www.bilibili.com", &target);

        let resp = handle(&uri, Some("bytes=1000-".to_string())).await;

        let req = server.join().expect("假 CDN 线程 panic").to_lowercase();
        assert!(
            !req.contains("range: bytes=1000-\r\n"),
            "开区间必须被收窄，不能原样转发（否则整片进内存）。实际请求：\n{req}"
        );
        assert!(
            req.contains(&format!("range: bytes=1000-{}", 1000 + capped_end)),
            "应被收窄为 1000..{} 的固定块。实际请求：\n{req}",
            1000 + capped_end
        );
        assert_eq!(resp.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(resp.body().as_slice(), BODY.as_bytes());
    }

    #[tokio::test]
    async fn rejects_non_http_target() {
        let uri = relay_uri("https://www.bilibili.com", "file:///etc/passwd");
        let resp = handle(&uri, None).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "只允许 http(s) 目标");
    }

    #[tokio::test]
    async fn rejects_malformed_path() {
        let uri: tauri::http::Uri = "http://bimedia.localhost////".parse().unwrap();
        let resp = handle(&uri, None).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn relays_upstream_error_status() {
        let (port, server) = spawn_fake_cdn("HTTP/1.1 403 Forbidden", "", "blocked");
        let target = format!("http://127.0.0.1:{port}/v.mp4");
        let uri = relay_uri("https://www.bilibili.com", &target);

        let resp = handle(&uri, None).await;
        let _ = server.join();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN, "上游 4xx 应透传，便于定位防盗链问题");
    }
}
