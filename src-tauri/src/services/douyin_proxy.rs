//! ⚠️ 当前未接入（2026-09-13 实测结论）
//!
//! 抖音的视频详情已改为客户端调用带 `a_bogus` 签名的接口，纯 HTTP 无法获取：
//!   · 分享页 `window._SSR_DATA.data` 为空对象；`_ROUTER_DATA.loaderData` 仅含静态渲染配置，
//!     不含 `videoInfoRes` / `play_addr`（整份 HTML 中这些 token 出现 0 次）
//!   · 各详情接口返回空响应（0 字节）或 403 "blocked"
//!   · 预热 Cookie 只能拿到反爬挑战 `__ac_nonce`
//!
//! 因此前端 `videoPlatforms.ts` 中抖音已降级为 `'unsupported'`，本代理暂无调用方。
//! 保留原因：这是一个**通用且带白名单校验**的 HTTP 转发层，接入签名方案后可直接复用；
//! `douyin_request` 命令仍在 `main.rs` 注册，前端 `douyinApi.ts` 亦保留。
//!
//! ---------------------------------------------------------------------------
//! 抖音 WebAPI / 分享页代理层
//!
//! 与 netease_proxy / kugou_proxy / bilibili_proxy 同构：Rust 仅负责「无 CORS 的 HTTP 转发 +
//! 白名单校验 + header 兜底 + 跟随重定向后的最终 URL 回传」。
//! 解析逻辑（分享短链 → aweme_id → 播放地址）在 TS 端完成，见 plugins/玉兰/src/online/douyinApi.ts。
//!
//! 为什么需要回传 final_url：
//!   抖音分享链接形如 https://v.douyin.com/xxxx/，本身不含视频 id，必须先请求它、跟随 302 到
//!   https://www.douyin.com/video/{aweme_id} 才能拿到 id。reqwest 默认跟随重定向，
//!   resp.url() 即最终地址，这里把它一并回传，省掉 TS 端再发一次请求。

use std::collections::HashMap;

// ========== 白名单（防止插件越权把代理当任意 HTTP 客户端） ==========
// 1) 仅允许这些抖音域名
const ALLOWED_DOUYIN_HOSTS: &[&str] = &[
    "v.douyin.com",       // 分享短链（纯跳转）
    "www.douyin.com",
    "douyin.com",
    "m.douyin.com",
    "www.iesdouyin.com",  // 分享页（HTML 内含 window._ROUTER_DATA）
    "iesdouyin.com",
];

// 2) 仅允许这些路径前缀（只读、低风险）。
//    例外：v.douyin.com 是纯跳转短链服务，路径是随机短码，不做路径校验（仅限该 host）。
const ALLOWED_DOUYIN_PATH_PREFIXES: &[&str] = &[
    // 分享页（视频 / 图集）
    "/share/video/",
    "/share/slides/",
    // 视频详情页 / 短链落地页
    "/video/",
    "/note/",
    // 网页端接口（详情 / 相关推荐）
    "/aweme/v1/web/aweme/detail/",
    "/aweme/v1/web/aweme/related/",
    "/aweme/v1/web/aweme/post/",
    // 发现页（仅用于预热 Cookie）
    "/discover",
];

/// 允许的精确路径（首页，仅用于预热 Cookie；不能写成 "/" 前缀，否则等于放行全部路径）
const ALLOWED_DOUYIN_EXACT_PATHS: &[&str] = &["/"];

// 3) 允许的 HTTP 方法
const ALLOWED_DOUYIN_METHODS: &[&str] = &["GET", "POST"];

// 4) 单请求体上限（防滥用），10 MB
const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;

/// 短链跳转域名：路径为随机短码，跳过路径白名单校验。
const SHORTLINK_HOST: &str = "v.douyin.com";

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
    if !ALLOWED_DOUYIN_METHODS.contains(&method.to_uppercase().as_str()) {
        return Err(format!("Method not allowed by douyin proxy: {method}"));
    }
    let host = host_of(url).ok_or_else(|| "Cannot parse host from url".to_string())?;
    if !ALLOWED_DOUYIN_HOSTS.iter().any(|h| h == &host) {
        return Err(format!("Host not in douyin allowlist: {host}"));
    }
    let path = url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split_once('/')
        .map(|(_, rest)| format!("/{rest}"))
        .unwrap_or_else(|| "/".to_string());
    let path_only = path.split('?').next().unwrap_or("/");
    // 短链服务不做路径校验；其余 host 需命中前缀或精确路径
    let path_ok = host == SHORTLINK_HOST
        || ALLOWED_DOUYIN_EXACT_PATHS.contains(&path_only)
        || ALLOWED_DOUYIN_PATH_PREFIXES
            .iter()
            .any(|p| path_only.starts_with(p));
    if !path_ok {
        return Err(format!("Path not in douyin allowlist: {path_only}"));
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
        let v = reqwest::header::HeaderValue::from_static("text/html,application/json,*/*");
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
pub struct DouyinProxyResponse {
    pub status: u16,
    pub body: String,
    pub cookies: Vec<String>,
    /// 跟随重定向后的最终 URL（短链解析必需）
    pub final_url: String,
}

async fn douyin_request_internal(
    method: &str,
    url: &str,
    body: &str,
    cookie: Option<&str>,
    extra: &HashMap<String, String>,
    referer: Option<&str>,
    user_agent: Option<&str>,
) -> Result<DouyinProxyResponse, String> {
    let _path = validate_request(method, url)?;

    if body.len() > MAX_BODY_BYTES {
        return Err(format!("Body too large: {} bytes", body.len()));
    }

    let headers = build_headers(cookie, extra, referer, user_agent);

    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::limited(10))
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
    let final_url = resp.url().to_string();

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

    Ok(DouyinProxyResponse {
        status,
        body: text,
        cookies,
        final_url,
    })
}

/// 通用抖音请求代理（白名单校验 + 转发 + 回传结构化 JSON 字符串，含 final_url）。
#[tauri::command(rename_all = "snake_case")]
pub async fn douyin_request(
    method: String,
    url: String,
    body: Option<String>,
    cookie: Option<String>,
    headers: Option<HashMap<String, String>>,
    referer: Option<String>,
    user_agent: Option<String>,
) -> Result<String, String> {
    let extra = headers.unwrap_or_default();
    let resp = douyin_request_internal(
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
        "final_url": resp.final_url,
    });
    Ok(serde_json::to_string(&out).unwrap_or_default())
}
