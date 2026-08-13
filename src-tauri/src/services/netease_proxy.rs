//! 网易云音乐 WebAPI 代理层（Phase 3 骨架）
//!
//! 移植自 MusicStorm（MIT License, GitHub @YuiNijika），按项目红线改造：
//! - 原版使用 reqwest::blocking，本项目统一异步 reqwest（rustls-tls + no_proxy），故改为 async。
//! - 原版依赖 reqwest `cookies` feature 管理会话，本项目保持零额外 feature，
//!   改为调用方自行拼接 `Cookie` 头字符串（netease_proxy 仅透传 header）。
//! - 加密在 TS 端完成（weapi/eapi），Rust 仅负责「无 CORS 的 HTTP 转发 + 白名单校验 + header 兜底」。
//!
//! 风控说明（见 research_report_netease_phase3_4.md）：
//! 首发仅暴露游客态只读接口的 POST 通道（搜索/歌单/榜单），登录态（扫码）后续 Phase 再加。

use std::collections::HashMap;

// ========== 四件套白名单（防止插件越权把代理当任意 HTTP 客户端） ==========
// 1) 仅允许这些 netease 域名
const ALLOWED_NETEASE_HOSTS: &[&str] = &[
    "music.163.com",
    "interface.music.163.com",
    "interface3.music.163.com",
    "interfacepc.music.163.com",
    "cat.music.163.com",
    "weapi.music.163.com",
    "apm.music.163.com",
];

// 2) 仅允许这些路径前缀（只读、低风险）
const ALLOWED_NETEASE_PATH_PREFIXES: &[&str] = &[
    "/weapi/cloudsearch/get",
    "/weapi/search/get",
    "/weapi/v1/discovery/recommend/songs",
    "/weapi/v3/playlist/detail",
    "/weapi/playlist/detail",
    "/weapi/album/v3/detail",
    "/weapi/song/enhance/player/url",
    "/weapi/song/enhance/player/url/v1",
    "/weapi/artist/v3/list/event",
    "/weapi/artist/albums",
    "/weapi/artist/top/song",
    // 登录态个人资料/我的歌单（weapi + eapi 双通道，前端登录态走 eapi）
    "/weapi/nuser/account/get",
    "/weapi/user/playlist",
    "/eapi/nuser/account/get",
    "/eapi/user/playlist",
    "/eapi/v6/playlist/detail",
    // 游客态注册（MUSIC_A），eapi
    "/api/gaia/v1/register/client",
    // 游客态匿名注册（deviceId 派生 username，weapi）
    "/weapi/register/anonimous",
    // 游客态匿名注册 eapi 回落通道（interfacepc.music.163.com）
    "/eapi/register/anonimous",
    // 二维码登录（eapi 通道，interfacepc 域名，扫码登录态不受游客态收紧影响）
    "/eapi/login/qrcode/unikey",
    "/eapi/login/qrcode/create",
    "/eapi/login/qrcode/client/login",
    // 业务接口 eapi 通道（interfacepc 域名）
    "/eapi/cloudsearch/pc",
    "/eapi/v6/playlist/detail",
    "/eapi/v3/playlist/detail",
    "/eapi/song/enhance/player/url",
    // 歌词接口（eapi 通道，登录态可见逐字歌词）
    "/eapi/song/lyric",
    // 榜单
    "/weapi/playlist/video/related/rank",
    "/weapi/toplist/artist",
    "/weapi/toplist/detail",
    // 个性化推荐（登录态个性化 / 游客态热门）
    "/weapi/personalized/playlist",
    "/eapi/personalized/playlist",
    "/weapi/recommend/songs",
    "/weapi/v3/discovery/recommend/songs",
];

// 3) 允许的 HTTP 方法（仅 POST，无 GET/PUT/DELETE）
const ALLOWED_NETEASE_METHODS: &[&str] = &["POST"];

// 4) 单请求体上限（防滥用），10 MB
const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;

fn host_of(url: &str) -> Option<String> {
    let u = url.trim();
    let without_scheme = u
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let host = without_scheme.split('/').next().unwrap_or("");
    // 去掉端口
    let host = host.split(':').next().unwrap_or("").to_string();
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

/// 四件套校验：返回 Ok(规范 path) 或 Err(原因)
fn validate_request(method: &str, url: &str) -> Result<String, String> {
    if !ALLOWED_NETEASE_METHODS.contains(&method.to_uppercase().as_str()) {
        return Err(format!("Method not allowed by netease proxy: {method}"));
    }
    let host = host_of(url).ok_or_else(|| "Cannot parse host from url".to_string())?;
    if !ALLOWED_NETEASE_HOSTS.iter().any(|h| h == &host) {
        return Err(format!("Host not in netease allowlist: {host}"));
    }
    // 提取 path（含 query）
    let path = url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split_once('/')
        .map(|(_, rest)| format!("/{rest}"))
        .unwrap_or_else(|| "/".to_string());
    let path_only = path.split('?').next().unwrap_or("/");
    if !ALLOWED_NETEASE_PATH_PREFIXES
        .iter()
        .any(|p| path_only.starts_with(p))
    {
        return Err(format!("Path not in netease allowlist: {path_only}"));
    }
    Ok(path)
}

/// 构建通用 header（参考 MusicStorm，UA 由调用方按接口传入以贴合官方请求结构，绕过风控）。
/// referer/origin/real_ip 由调用方传入（TS 端按接口需求填）。
/// user_agent 由调用方传入（weapi 用 Mac Edge UA、eapi 用 iPhone UA），为空则回落中性 UA。
fn build_headers(
    cookie: Option<&str>,
    extra: &HashMap<String, String>,
    referer: Option<&str>,
    origin: Option<&str>,
    real_ip: Option<&str>,
    user_agent: Option<&str>,
) -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    // User-Agent：优先调用方传入（贴合官方请求），为空则中性回落
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
        // 声明接受任意响应类型，避免服务端因 Accept 不匹配返回异常
        let v = reqwest::header::HeaderValue::from_static("*/*");
        headers.insert(reqwest::header::ACCEPT, v);
    }
    {
        // 显式声明支持 gzip/deflate（配合 reqwest gzip feature 自动解压）
        let v = reqwest::header::HeaderValue::from_static("gzip, deflate");
        headers.insert(reqwest::header::ACCEPT_ENCODING, v);
    }
    // 反爬常用 header（参考 MusicStorm）：伪造国内出口 IP，避免非 CN 出口被拦
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

/// 游客态注册（MUSIC_A）。
/// 该接口走 weapi，加密已在 TS 端完成，这里仅做 HTTP 转发并返回结构化 JSON 字符串。
#[tauri::command(rename_all = "snake_case")]
pub async fn netease_register_guest(
    url: String,
    body: String,
    cookie: Option<String>,
    referer: Option<String>,
    origin: Option<String>,
    real_ip: Option<String>,
    user_agent: Option<String>,
) -> Result<String, String> {
    let mut extra = HashMap::new();
    extra.insert("__noop".to_string(), "1".to_string());
    let resp = proxy_post_internal(
        "POST",
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

/// 通用网易云 POST 代理（四件套校验 + 转发 + 回传结构化 JSON 字符串）
/// - url: 完整 https URL（如 https://music.163.com/weapi/cloudsearch/get）
/// - body: 已加密的 form body（application/x-www-form-urlencoded 文本）
/// - cookie: 可选会话 Cookie（游客态可空）
#[tauri::command(rename_all = "snake_case")]
pub async fn netease_http_post(
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
    let resp = proxy_post_internal(
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

#[derive(serde::Serialize, Clone)]
pub struct NeteaseProxyResponse {
    pub status: u16,
    pub body: String,
    pub cookies: Vec<String>,
}

async fn proxy_post_internal(
    method: &str,
    url: &str,
    body: &str,
    cookie: Option<&str>,
    extra: &HashMap<String, String>,
    referer: Option<&str>,
    origin: Option<&str>,
    real_ip: Option<&str>,
    user_agent: Option<&str>,
) -> Result<NeteaseProxyResponse, String> {
    // 四件套校验
    let _path = validate_request(method, url)?;

    if body.len() > MAX_BODY_BYTES {
        return Err(format!("Body too large: {} bytes", body.len()));
    }

    let headers = build_headers(cookie, extra, referer, origin, real_ip, user_agent);

    // 本项目 reqwest 客户端：rustls-tls + no_proxy，禁用系统代理避免被拦截
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|e| format!("build client: {e}"))?;

    let resp = client
        .post(url)
        .headers(headers)
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status().as_u16();

    // 先取 Set-Cookie，再消费响应体
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

    Ok(NeteaseProxyResponse { status, body: text, cookies })
}
