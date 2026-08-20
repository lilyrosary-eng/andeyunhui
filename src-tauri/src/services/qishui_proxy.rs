//! 汽水音乐（字节跳动 luna/helium）WebAPI 代理层
//!
//! 设计对齐 `kugou_proxy.rs` / `netease_proxy.rs`：加密/签名在 TS 端完成（汽水为字节系
//! JSVMP 签名 x-helios/x-argus，TS 端生成或走第三方兜底），Rust 仅负责「无 CORS 的 HTTP
//! 转发 + 域名/路径白名单 + header 兜底」。reqwest 统一 rustls-tls + no_proxy。
//!
//! 风控说明：汽水官方接口对国内出口、签名头、UA 有基础校验，但游客态只读接口
//! （搜索/榜单/歌单/歌曲信息/歌词/播放地址）可打；登录态（扫码）后续 Phase 再加。

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

// ========== 白名单 ==========
const ALLOWED_QISHUI_HOSTS: &[&str] = &[
    "api3-lq.qishui.com",
    "api3-normal-lq.qishui.com",
    "api.qishui.com",
    "music.douyin.com",
    "www.douyin.com",     // passport 登录走 www.douyin.com/passport/web/*
    "passport.douyin.com",
    "sso.douyin.com",
    // 音频 CDN 域名（加密流直链）——精确匹配
    "p3-luna.douyinpic.com",
    "p6-luna.douyinpic.com",
    "p9-luna.douyinpic.com",
    "p26-luna.douyinpic.com",
    "p3-pc.douyinpic.com",
    "p6-pc.douyinpic.com",
    "p9-pc.douyinpic.com",
    "lf3-music-tos.douyinpic.com",
    "lf6-music-tos.douyinpic.com",
    "lf9-music-tos.douyinpic.com",
    "v3-lq.douyinpic.com",
    "v6-lq.douyinpic.com",
    "v9-lq.douyinpic.com",
];

// 后缀匹配白名单：CDN 域名动态子域名（如 v95-se-zjwztc-luna.douyinvod.com）
// 这些域名的子域名前缀不固定，只能按后缀放行。
const ALLOWED_QISHUI_HOST_SUFFIXES: &[&str] = &[
    ".douyinvod.com",    // 汽水音频加密流 CDN（动态子域名）
    ".douyinpic.com",    // 图片/封面 CDN
    ".byteimg.com",      // 字节系图片 CDN
    ".bytednsdoc.com",   // 字节系静态资源
    ".bytecdntp.com",    // 字节系 CDN
];

// 汽水真实接口路径（按 api3-lq.qishui.com 移动端网关抓包 + 开源实现修正）。
// 游客态只读接口优先放行；登录相关路径（如 /luna/passport/）后续 Phase 再加。
const ALLOWED_QISHUI_PATH_PREFIXES: &[&str] = &[
    "/luna/search",
    "/luna/discover",
    "/luna/playlist/detail",
    "/luna/media-player",
    "/luna/h5/seo_track",
    "/luna/feed",
    "/luna/comments",
    "/luna/pc/search",
    "/luna/pc/track_v2",
    "/luna/pc/playlist/detail",
    "/luna/album",
    "/luna/artist",
    // 登录/扫码相关
    "/passport/qrcode/create",
    "/passport/qrcode/check",
    "/passport/qrcode/heartbeat",
    "/passport/user_info",
    "/passport/web/qrcode/create",
    "/passport/web/qrcode/check",
    "/passport/web/qrcode/heartbeat",
    "/passport/web/get_qrcode",
    "/passport/web/check_qrconnect",
    "/passport/web/expire_qrcode",
    "/passport/web/account/logout",
    "/passport/web/account/info",
    "/passport/account/info",
    "/passport/account/_logout",
];

const ALLOWED_QISHUI_METHODS: &[&str] = &["POST", "GET"];
const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;

fn host_of(url: &str) -> Option<String> {
    let without_scheme = url
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let host = without_scheme.split('/').next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("").to_string();
    if host.is_empty() { None } else { Some(host) }
}

fn validate_request(method: &str, url: &str) -> Result<String, String> {
    if !ALLOWED_QISHUI_METHODS.contains(&method.to_uppercase().as_str()) {
        return Err(format!("Method not allowed by qishui proxy: {method}"));
    }
    let host = host_of(url).ok_or_else(|| "Cannot parse host from url".to_string())?;
    if !is_host_allowed(&host) {
        return Err(format!("Host not in qishui allowlist: {host}"));
    }
    let path = url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split_once('/')
        .map(|(_, rest)| format!("/{rest}"))
        .unwrap_or_else(|| "/".to_string());
    let path_only = path.split('?').next().unwrap_or("/");
    if !ALLOWED_QISHUI_PATH_PREFIXES
        .iter()
        .any(|p| path_only.starts_with(p))
    {
        return Err(format!("Path not in qishui allowlist: {path_only}"));
    }
    Ok(path)
}

fn build_headers(
    cookie: Option<&str>,
    extra: &HashMap<String, String>,
    referer: Option<&str>,
    origin: Option<&str>,
    real_ip: Option<&str>,
    user_agent: Option<&str>,
) -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    let ua = user_agent
        .filter(|s| !s.is_empty())
        .unwrap_or("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36");
    if let Ok(v) = reqwest::header::HeaderValue::from_str(ua) {
        headers.insert(reqwest::header::USER_AGENT, v);
    }
    headers.insert(reqwest::header::ACCEPT, reqwest::header::HeaderValue::from_static("*/*"));
    headers.insert(
        reqwest::header::ACCEPT_ENCODING,
        reqwest::header::HeaderValue::from_static("gzip, deflate"),
    );
    if let Some(ip) = real_ip {
        if !ip.is_empty() {
            if let Ok(v) = reqwest::header::HeaderValue::from_str(ip) {
                headers.insert(reqwest::header::HeaderName::from_static("x-real-ip"), v.clone());
                headers.insert(reqwest::header::HeaderName::from_static("x-forwarded-for"), v.clone());
            }
        }
    }
    if let Some(r) = referer {
        if !r.is_empty() {
            if let Ok(v) = reqwest::header::HeaderValue::from_str(r) {
                headers.insert(reqwest::header::REFERER, v);
            }
        }
    }
    if let Some(o) = origin {
        if !o.is_empty() {
            if let Ok(v) = reqwest::header::HeaderValue::from_str(o) {
                headers.insert(reqwest::header::HeaderName::from_static("origin"), v);
            }
        }
    }
    if let Some(c) = cookie {
        if !c.is_empty() {
            if let Ok(v) = reqwest::header::HeaderValue::from_str(c) {
                headers.insert(reqwest::header::COOKIE, v);
            }
        }
    }
    for (k, v) in extra {
        if let (Ok(name), Ok(val)) = (
            reqwest::header::HeaderName::from_bytes(k.as_bytes()),
            reqwest::header::HeaderValue::from_str(v),
        ) {
            headers.insert(name, val);
        }
    }
    headers
}

#[derive(serde::Serialize, Clone)]
pub struct QishuiProxyResponse {
    pub status: u16,
    pub body: String,
    pub cookies: Vec<String>,
}

fn global_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10))
            .pool_max_idle_per_host(6)
            .build()
            .expect("build qishui proxy client")
    })
}

async fn proxy_internal(
    method: &str,
    url: &str,
    body: &str,
    cookie: Option<&str>,
    extra: &HashMap<String, String>,
    referer: Option<&str>,
    origin: Option<&str>,
    real_ip: Option<&str>,
    user_agent: Option<&str>,
    content_type: Option<&str>,
) -> Result<QishuiProxyResponse, String> {
    let _path = validate_request(method, url)?;
    if body.len() > MAX_BODY_BYTES {
        return Err(format!("Body too large: {} bytes", body.len()));
    }
    let headers = build_headers(cookie, extra, referer, origin, real_ip, user_agent);
    let client = global_client();
    let mut final_url = url.to_string();
    let req = if method.eq_ignore_ascii_case("GET") {
        // 如果调用方仍传了 body（form 编码的 query），兜底拼到 URL
        if !body.is_empty() && !url.contains('?') {
            final_url = format!("{url}?{body}");
        } else if !body.is_empty() {
            final_url = format!("{url}&{body}");
        }
        client.get(&final_url)
    } else {
        let ct = content_type.unwrap_or("application/json");
        client
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, ct)
            .body(body.to_string())
    };
    let resp = req
        .headers(headers)
        .send()
        .await
        .map_err(|e| {
            let is_connect = e.is_connect();
            let is_timeout = e.is_timeout();
            let is_request = e.is_request();
            let kind = if is_timeout { "timeout" } else if is_connect { "connect" } else if is_request { "request" } else { "unknown" };
            eprintln!("[qishui_proxy] {} {} error: kind={} msg={}", method, &url[..url.len().min(80)], kind, e);
            format!("request failed ({kind}): {e}")
        })?;
    let status = resp.status().as_u16();
    let cookies: Vec<String> = resp
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok().map(|s| s.to_string()))
        .collect();
    let text = resp.text().await.map_err(|e| format!("read body: {e}"))?;
    Ok(QishuiProxyResponse { status, body: text, cookies })
}

/// 通用汽水 POST/GET 代理（白名单校验 + 转发 + 回传结构化 JSON 字符串）
#[tauri::command(rename_all = "snake_case")]
pub async fn qishui_http_post(
    method: String,
    url: String,
    body: String,
    cookie: Option<String>,
    headers: Option<HashMap<String, String>>,
    referer: Option<String>,
    origin: Option<String>,
    real_ip: Option<String>,
    user_agent: Option<String>,
    content_type: Option<String>,
) -> Result<String, String> {
    let extra = headers.unwrap_or_default();
    let resp = proxy_internal(
        &method,
        &url,
        &body,
        cookie.as_deref(),
        &extra,
        referer.as_deref(),
        origin.as_deref(),
        real_ip.as_deref(),
        user_agent.as_deref(),
        content_type.as_deref(),
    )
    .await?;
    let out = serde_json::json!({
        "status": resp.status,
        "cookies": resp.cookies,
        "body": resp.body,
    });
    Ok(serde_json::to_string(&out).unwrap_or_default())
}

/// 判断域名是否在白名单中：精确匹配 + 后缀匹配
fn is_host_allowed(host: &str) -> bool {
    if ALLOWED_QISHUI_HOSTS.iter().any(|h| h == &host) {
        return true;
    }
    ALLOWED_QISHUI_HOST_SUFFIXES.iter().any(|s| host.ends_with(s))
}

/// 下载汽水音乐加密音频流（二进制），返回 base64 编码。
/// 前端收到后解码为 ArrayBuffer 交给 qishuiDecrypt 解密。
#[tauri::command(rename_all = "snake_case")]
pub async fn qishui_download_audio(
url: String,
user_agent: Option<String>,
referer: Option<String>,
) -> Result<String, String> {
use base64::Engine;
// 域名白名单校验（精确 + 后缀匹配）
let host = host_of(&url).ok_or("Cannot parse host from url")?;
if !is_host_allowed(&host) {
return Err(format!("Host not in qishui allowlist: {host}"));
}
    let client = global_client();
    let ua = user_agent
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36 com.luna.music/100197030");
    let mut headers = reqwest::header::HeaderMap::new();
    if let Ok(v) = reqwest::header::HeaderValue::from_str(&ua) {
        headers.insert(reqwest::header::USER_AGENT, v);
    }
    headers.insert(reqwest::header::ACCEPT, reqwest::header::HeaderValue::from_static("*/*"));
    if let Some(r) = referer.filter(|s| !s.is_empty()) {
        if let Ok(v) = reqwest::header::HeaderValue::from_str(&r) {
            headers.insert(reqwest::header::REFERER, v);
        }
    }
    let resp = client
        .get(&url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| format!("audio download failed: {e}"))?;
    let status = resp.status();
    // 记录 Content-Length 用于诊断
    let content_length = resp
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0);
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("audio download HTTP {}: {}", status.as_u16(), &text[..text.len().min(200)]));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("read audio body: {e}"))?;
    // 诊断日志：下载大小 vs Content-Length
    eprintln!(
        "[qishui_download_audio] url={} status={} content_len={} actual={} first_bytes={}",
        &url[..url.len().min(80)],
        status.as_u16(),
        content_length,
        bytes.len(),
        if bytes.len() >= 4 { format!("{:02x?}", &bytes[..4]) } else { format!("{:02x?}", bytes.as_ref()) }
    );
    // 如果实际下载的数据远小于 Content-Length，说明下载不完整
    if content_length > 0 && bytes.len() < content_length / 2 {
        return Err(format!(
            "audio download incomplete: got {} bytes but Content-Length is {}",
            bytes.len(),
            content_length
        ));
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}
