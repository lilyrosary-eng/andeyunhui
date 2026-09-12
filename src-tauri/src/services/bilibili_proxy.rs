//! 哔哩哔哩 WebAPI 代理层
//!
//! 与 netease_proxy / kugou_proxy / qishui_proxy 同构：Rust 仅负责「无 CORS 的 HTTP 转发 +
//! 白名单校验 + header 兜底」，加解密 / wbi 签名在 TS 端完成（见 plugins/玉兰/src/online/bilibiliApi.ts）。
//!
//! B 站绝大多数读接口是 GET（带 wbi 签名的 query），少部分（如投币、收藏写操作）是 POST。
//! 故本代理同时支持 GET / POST，method 透传。

use std::collections::HashMap;

// ========== 白名单（防止插件越权把代理当任意 HTTP 客户端） ==========
// 1) 仅允许这些 bilibili 域名
const ALLOWED_BILIBILI_HOSTS: &[&str] = &[
    "api.bilibili.com",
    "www.bilibili.com",
    "bilibili.com",
    "app.bilibili.com",
    "live.bilibili.com",
    "interface.bilibili.com",
    "cm.bilibili.com",
    "data.bilibili.com",
    "passport.bilibili.com",
    "s1.hdslb.com",
];

// 2) 仅允许这些路径前缀（只读、低风险；wbi 接口优先）
const ALLOWED_BILIBILI_PATH_PREFIXES: &[&str] = &[
    // 搜索（wbi）
    "/x/web-interface/wbi/search/all/v2",
    "/x/web-interface/search/all/v2",
    "/x/web-interface/search/default",
    // 视频信息 / 播放地址（wbi）
    "/x/wbi/view",
    "/x/web-interface/view",
    "/x/v2/view",
    "/x/player/wbi/playurl",
    "/x/player/playurl",
    "/x/player/wbi/v2",
    // 分区 / 热门 / 推荐
    "/x/web-interface/index/top/feed/rcmd",
    "/x/web-interface/popular",
    "/x/web-interface/ranking/v2",
    "/x/web-interface/dynamic/region",
    // 用户空间投稿
    "/x/space/wbi/arc/search",
    "/x/space/arc/search",
    // 收藏夹
    "/x/v3/fav/folder/created/list",
    "/x/v3/fav/resource/list",
];

// 3) 允许的 HTTP 方法
const ALLOWED_BILIBILI_METHODS: &[&str] = &["GET", "POST"];

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

fn validate_request(method: &str, url: &str) -> Result<String, String> {
    if !ALLOWED_BILIBILI_METHODS.contains(&method.to_uppercase().as_str()) {
        return Err(format!("Method not allowed by bilibili proxy: {method}"));
    }
    let host = host_of(url).ok_or_else(|| "Cannot parse host from url".to_string())?;
    if !ALLOWED_BILIBILI_HOSTS.iter().any(|h| h == &host) {
        return Err(format!("Host not in bilibili allowlist: {host}"));
    }
    let path = url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split_once('/')
        .map(|(_, rest)| format!("/{rest}"))
        .unwrap_or_else(|| "/".to_string());
    let path_only = path.split('?').next().unwrap_or("/");
    if !ALLOWED_BILIBILI_PATH_PREFIXES
        .iter()
        .any(|p| path_only.starts_with(p))
    {
        return Err(format!("Path not in bilibili allowlist: {path_only}"));
    }
    Ok(path)
}

/// 构建通用 header（UA 由调用方传入以贴合官方请求，绕过风控）。
fn build_headers(
    cookie: Option<&str>,
    extra: &HashMap<String, String>,
    referer: Option<&str>,
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
        let v = reqwest::header::HeaderValue::from_static("*/*");
        headers.insert(reqwest::header::ACCEPT, v);
    }
    {
        let v = reqwest::header::HeaderValue::from_static("gzip, deflate");
        headers.insert(reqwest::header::ACCEPT_ENCODING, v);
    }
    if let Some(r) = referer {
        if !r.is_empty() {
            if let Ok(v) = reqwest::header::HeaderValue::from_str(r) {
                headers.insert(reqwest::header::REFERER, v);
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
pub struct BilibiliProxyResponse {
    pub status: u16,
    pub body: String,
    pub cookies: Vec<String>,
}

async fn bilibili_request_internal(
    method: &str,
    url: &str,
    body: &str,
    cookie: Option<&str>,
    extra: &HashMap<String, String>,
    referer: Option<&str>,
    user_agent: Option<&str>,
) -> Result<BilibiliProxyResponse, String> {
    let _path = validate_request(method, url)?;

    if body.len() > MAX_BODY_BYTES {
        return Err(format!("Body too large: {} bytes", body.len()));
    }

    let headers = build_headers(cookie, extra, referer, user_agent);

    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|e| format!("build client: {e}"))?;

    let method_upper = method.to_uppercase();
    let req = if method_upper == "POST" {
        client.post(url).body(body.to_string())
    } else {
        client.get(url)
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

    Ok(BilibiliProxyResponse {
        status,
        body: text,
        cookies,
    })
}

/// 通用哔哩哔哩请求代理（四件套校验 + 转发 + 回传结构化 JSON 字符串）。
#[tauri::command(rename_all = "snake_case")]
pub async fn bilibili_request(
    method: String,
    url: String,
    body: Option<String>,
    cookie: Option<String>,
    headers: Option<HashMap<String, String>>,
    referer: Option<String>,
    user_agent: Option<String>,
) -> Result<String, String> {
    let extra = headers.unwrap_or_default();
    let resp = bilibili_request_internal(
        &method,
        &url,
        &body.unwrap_or_default(),
        cookie.as_deref(),
        &extra,
        referer.as_deref(),
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
