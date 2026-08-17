//! 酷狗音乐 WebAPI 代理层
//!
//! 设计对齐 `netease_proxy.rs`：签名/加密在 TS 端完成（酷狗为简单 MD5 盐签名，见
//! `plugins/铃兰/src/kugouCrypto.ts`），Rust 仅负责「无 CORS 的 HTTP 转发 + 域名/路径白名单
//! + header 兜底」。reqwest 统一 rustls-tls + no_proxy（见项目红线：禁用系统代理避免被拦截）。
//!
//! 风控说明：酷狗官方接口对国内出口、Referer（y.qq.com 同款思维，酷狗用 kugou.com）、UA 有基础
//! 校验，但无网易系强加密与行为风控。本项目默认游客态（无需登录即可搜索/试听/歌词），仅透传
//! 调用方传入的 Cookie（用户后续若做扫码登录可带会员 Cookie）。

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

// ========== 白名单（防止插件把代理当任意 HTTP 客户端） ==========
// 1) 仅允许这些酷狗域名
const ALLOWED_KUGOU_HOSTS: &[&str] = &[
    "gateway.kugou.com",
    "www.kugou.com",
    "m.kugou.com",
    "complexsearch.kugou.com",
    "wwwapi.kugou.com",
    "lyrics.kugou.com",
    "songsearch.kugou.com",
    // 登录 / 账号相关
    // 网页端扫码登录走 login-user.kugou.com/v2/*（非 /kmobile），明文返回 userid+token，免 AES/RSA 解密
    "login-user.kugou.com",
    "kugou.com",
    "passport.kugou.com",
    "usercenter.kugou.com",
    // 直连后端 CDN（绕过 gateway 的 x-router 路由层，免签名、稳定）
    "mobilecdnbj.kugou.com",
    "msearchcdnbj.kugou.com",
    // 实测可直连的旧移动端接口（搜索/榜单免签名可用）
    "mobilecdn.kugou.com",
];

// 2) 仅允许这些路径前缀（只读、低风险；登录类仅放通扫码登录相关路径）
const ALLOWED_KUGOU_PATH_PREFIXES: &[&str] = &[
    "/api/v3/search",
    "/api/v3/url",
    "/api/v3/lyric",
    "/api/v3/album",
    "/api/v3/singer",
    "/api/v3/playlist",
    "/api/v3/rank",
    "/api/v3/tag",
    "/api/v3/category",
    "/yy/index.php",
    "/music/social/api",
    // m.kugou.com 老式歌单详情
    "/plist/list",
    // 扫码登录（网页端 login-user.kugou.com/v2/*，明文返回 userid+token，无需解密 secu_params）
    "/v2/qrcode",
    "/v2/get_userinfo_qrcode",
    // 登录后用户信息/收藏/歌单（kugou.com/up/index.php）
    "/up/index.php",
    "/user_favorites/index.php",
    "/user_favorites/playlist.php",
    // Android 登录态私有接口：我的歌单 / 歌单详情
    "/v7/get_all_list",
    "/v3/get_list_info",
    // 当前 Android API 体系（对齐社区 kugou_api）：
    // 搜索 / 榜单 / 播放 / 歌单歌曲 / 歌词
    "/v3/search",
    "/ocean/v6/rank",
    "/v5/url",
    "/pubsongs/v2",
    "/v1/search",
    "/download",
];

// 3) 允许的 HTTP 方法（仅 POST/GET）
const ALLOWED_KUGOU_METHODS: &[&str] = &["POST", "GET"];

// 4) 单请求体上限（防滥用），10 MB
const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;

fn host_of(url: &str) -> Option<String> {
    let u = url.trim();
    let without_scheme = u
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let host = without_scheme.split('/').next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("").to_string();
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

/// 四件套校验：返回 Ok(规范 path) 或 Err(原因)
fn validate_request(method: &str, url: &str) -> Result<String, String> {
    if !ALLOWED_KUGOU_METHODS.contains(&method.to_uppercase().as_str()) {
        return Err(format!("Method not allowed by kugou proxy: {method}"));
    }
    let host = host_of(url).ok_or_else(|| "Cannot parse host from url".to_string())?;
    if !ALLOWED_KUGOU_HOSTS.iter().any(|h| h == &host) {
        return Err(format!("Host not in kugou allowlist: {host}"));
    }
    let path = url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split_once('/')
        .map(|(_, rest)| format!("/{rest}"))
        .unwrap_or_else(|| "/".to_string());
    let path_only = path.split('?').next().unwrap_or("/");
    if !ALLOWED_KUGOU_PATH_PREFIXES
        .iter()
        .any(|p| path_only.starts_with(p))
    {
        return Err(format!("Path not in kugou allowlist: {path_only}"));
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
    {
        let v = reqwest::header::HeaderValue::from_static("application/x-www-form-urlencoded");
        headers.insert(reqwest::header::CONTENT_TYPE, v);
    }
    {
        let v = reqwest::header::HeaderValue::from_static("*/*");
        headers.insert(reqwest::header::ACCEPT, v);
    }
    {
        let v = reqwest::header::HeaderValue::from_static("gzip, deflate");
        headers.insert(reqwest::header::ACCEPT_ENCODING, v);
    }
    // 伪造国内出口 IP，避免非 CN 出口被拦
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
pub struct KugouProxyResponse {
    pub status: u16,
    pub body: String,
    pub cookies: Vec<String>,
}

// 全局单例 reqwest Client：带超时 + 连接池复用，避免 IPv6 出口不通时无限卡死/连接风暴。
fn global_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10))
            .pool_max_idle_per_host(6)
            .build()
            .expect("build kugou proxy client")
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
) -> Result<KugouProxyResponse, String> {
    let _path = validate_request(method, url)?;

    if body.len() > MAX_BODY_BYTES {
        return Err(format!("Body too large: {} bytes", body.len()));
    }

    let headers = build_headers(cookie, extra, referer, origin, real_ip, user_agent);

    // 复用全局单例 Client：每次请求 new Client 会导致连接池无法复用、idle 连接堆积，
    // 在 gateway 解析到 IPv6 且本机无真 IPv6 出口时形成连接风暴。统一超时避免无限卡死。
    let client = global_client();

    let req = if method.eq_ignore_ascii_case("GET") {
        client.get(url)
    } else {
        client.post(url).body(body.to_string())
    };

    let resp = req
        .headers(headers)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status().as_u16();

    let cookies: Vec<String> = resp
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok().map(|s| s.to_string()))
        .collect();

    let text = resp
        .text()
        .await
        .map_err(|e| format!("read body: {e}"))?;

    Ok(KugouProxyResponse { status, body: text, cookies })
}

/// 通用酷狗 POST/GET 代理（白名单校验 + 转发 + 回传结构化 JSON 字符串）
/// 与 `netease_http_post` 完全同构，仅域名/路径白名单不同。
#[tauri::command(rename_all = "snake_case")]
pub async fn kugou_http_post(
    method: String,
    url: String,
    body: String,
    cookie: Option<String>,
    headers: Option<HashMap<String, String>>,
    referer: Option<String>,
    origin: Option<String>,
    real_ip: Option<String>,
    user_agent: Option<String>,
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
    )
    .await?;
    let out = serde_json::json!({
        "status": resp.status,
        "cookies": resp.cookies,
        "body": resp.body,
    });
    Ok(serde_json::to_string(&out).unwrap_or_default())
}
