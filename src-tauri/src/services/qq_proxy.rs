//! QQ 音乐代理层 —— 无 CORS 的 HTTP 转发 + 域名/路径白名单 + header 兜底
//!
//! 设计对齐 `kugou_proxy.rs` / `netease_proxy.rs`：请求体的构造在 TS 端
//! （`plugins/铃兰/src/qqMusicApi.ts`），Rust 只做转发与白名单校验。
//! QQ 的这几个接口**不需要签名**（见下方实测），所以本模块比网易云那套简单得多。
//!
//! ## 2026-11-04 探针实测结论（独立 node 脚本打真接口，多查询 + 单变量对照）
//!
//! - `POST u.y.qq.com/cgi-bin/musicu.fcg`（`music.search.SearchCgiService` /
//!   `DoSearchForQQMusicDesktop`）：**免签名可用**，UA / Referer 都不必需（三种头组合均返回 10 条）。
//!   给 `time_public`（完整日期，如 `"2003-07-31"`）、`singer` 数组、`index_cd` 碟号；
//!   `genre` 只是数字 id（样本为 `1`），专辑详情也不给流派名 —— 所以 QQ 补不了流派字段。
//! - `GET c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg`：`lyric` 字段是 **base64**，
//!   解出标准 LRC；`g_tk=5381` 是写死的常量、不是签名。**必须带 `Referer: https://y.qq.com`**，
//!   不带则 `retcode=-1310` 且 lyric 为空 —— 所以本模块对歌词请求自动补 Referer。
//! - `y.qq.com/music/photo_new/T002R{300x300|800x800}M000{albumMid}.jpg`：无需 Referer，
//!   支持 `Range`（实测 206），R800 约 183KB。封面走既有的 `music_set_cover_url`（Rust 直接下载并内嵌）。
//! - ★ **搜索有 burst 限流，且失败形态是「HTTP 200 + code=0 + 空列表」**（响应体从 ~50KB
//!   缩到 ~1KB），不返回 4xx、不报错。因此调用方**不能把空结果当「没匹配到」**：
//!   节流与「空即重试」放在 TS 客户端统一处理（那里有 vitest 可锁行为）。

use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;

/// 只允许 QQ 音乐相关主机。`is1-ssl.mzstatic.com` 之类不放进来。
const ALLOWED_QQ_HOSTS: &[&str] = &["u.y.qq.com", "c.y.qq.com", "y.qq.com", "www.y.qq.com"];

/// 只允许这些路径前缀：搜索/详情（musicu.fcg）、歌词（fcg_query_lyric_new）、封面图。
const ALLOWED_QQ_PATH_PREFIXES: &[&str] = &[
    "/cgi-bin/musicu.fcg",
    "/lyric/fcgi-bin/fcg_query_lyric_new.fcg",
    "/music/photo_new/",
];

const ALLOWED_QQ_METHODS: &[&str] = &["GET", "POST"];

/// 请求体上限：musicu.fcg 的 JSON 体是固定结构，几十 KB 足够，防止被当通用 HTTP 客户端。
const MAX_BODY_BYTES: usize = 64 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QqProxyResponse {
    status: u16,
    body: String,
}

fn global_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .http1_only() // 与项目红线一致：不走系统代理、不用 H2
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10))
            .pool_max_idle_per_host(4)
            .build()
            .expect("build qq proxy client")
    })
}

fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let authority = rest.split('/').next().unwrap_or("");
    let name = authority.split('@').last().unwrap_or("").split(':').next().unwrap_or("");
    if name.is_empty() {
        None
    } else {
        Some(name.to_ascii_lowercase())
    }
}

fn path_of(url: &str) -> String {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    match rest.split_once('/') {
        Some((_, tail)) => format!("/{}", tail.split('?').next().unwrap_or("")),
        None => "/".to_string(),
    }
}

/// 校验方法 + 主机 + 路径白名单；同时挡住协议相对写法与非 http(s) 协议。
fn validate_request(method: &str, url: &str) -> Result<(), String> {
    let m = method.to_ascii_uppercase();
    if !ALLOWED_QQ_METHODS.contains(&m.as_str()) {
        return Err(format!("QQ 代理不允该方法: {method}"));
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(format!("QQ 代理只接受绝对 http(s) URL: {url}"));
    }
    let host = host_of(url).ok_or("QQ 代理无法从 url 解析主机")?;
    if !ALLOWED_QQ_HOSTS.iter().any(|h| *h == host) {
        return Err(format!("主机不在 QQ 白名单: {host}"));
    }
    let path = path_of(url);
    if !ALLOWED_QQ_PATH_PREFIXES.iter().any(|p| path.starts_with(p)) {
        return Err(format!("路径不在 QQ 白名单: {path}"));
    }
    Ok(())
}

/// 转发请求。`is_lyric` 为 true 时补上 `Referer: https://y.qq.com`
/// —— 实测缺它歌词接口返回 `retcode=-1310` 空结果。
async fn forward(
    method: &str,
    url: &str,
    body: &str,
    referer_required: bool,
) -> Result<QqProxyResponse, String> {
    validate_request(method, url)?;
    if body.len() > MAX_BODY_BYTES {
        return Err(format!("请求体超出上限: {} 字节", body.len()));
    }

    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::USER_AGENT,
        reqwest::header::HeaderValue::from_static(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
        ),
    );
    if referer_required {
        headers.insert(
            reqwest::header::REFERER,
            reqwest::header::HeaderValue::from_static("https://y.qq.com"),
        );
    }
    if method.eq_ignore_ascii_case("POST") {
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            reqwest::header::HeaderValue::from_static("application/json;charset=utf-8"),
        );
    }

    let req = if method.eq_ignore_ascii_case("GET") {
        global_client().get(url)
    } else {
        global_client().post(url).body(body.to_string())
    };

    let resp = req
        .headers(headers)
        .send()
        .await
        .map_err(|e| format!("QQ 代理请求失败: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| format!("QQ 代理读取响应失败: {e}"))?;
    Ok(QqProxyResponse { status, body: text })
}

/// 转发 `musicu.fcg` 的 POST（搜索、歌曲/专辑详情）。
///
/// 返回值是 `{"status":..,"body":".."}` 的 JSON 字符串，`body` 为上游原文，
/// 由 TS 侧解析（保持与其它代理层一致的契约）。
#[tauri::command]
pub async fn qq_http_post(url: String, body: String) -> Result<String, String> {
    let resp = forward("POST", &url, &body, false).await?;
    serde_json::to_string(&resp).map_err(|e| format!("序列化 QQ 响应失败: {e}"))
}

/// 转发歌词等 GET 接口，自动补 QQ 音乐站 Referer。
#[tauri::command]
pub async fn qq_http_get(url: String) -> Result<String, String> {
    let need_referer = host_of(&url).map(|h| h == "c.y.qq.com").unwrap_or(false);
    let resp = forward("GET", &url, "", need_referer).await?;
    serde_json::to_string(&resp).map_err(|e| format!("序列化 QQ 响应失败: {e}"))
}

#[cfg(test)]
mod qq_proxy_tests {
    use super::*;

    #[test]
    fn 白名单放行音乐搜索与歌词() {
        assert!(validate_request("POST", "https://u.y.qq.com/cgi-bin/musicu.fcg").is_ok());
        assert!(validate_request(
            "GET",
            "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=X&g_tk=5381"
        )
        .is_ok());
        assert!(validate_request("GET", "https://y.qq.com/music/photo_new/T002R800x800M000ABC.jpg").is_ok());
    }

    #[test]
    fn 白名单挡住其它主机与其它路径() {
        // 不能变成任意 HTTP 客户端
        assert!(validate_request("GET", "https://example.com/cgi-bin/musicu.fcg").is_err());
        assert!(validate_request("GET", "https://u.y.qq.com/portal/login").is_err());
        assert!(validate_request("POST", "https://c.y.qq.com/qqmusic/fcgi-bin/lyric_download.fcg").is_err());
        // 其它方法
        assert!(validate_request("DELETE", "https://u.y.qq.com/cgi-bin/musicu.fcg").is_err());
    }

    #[test]
    fn 非常规协议与非绝对地址被拒() {
        assert!(validate_request("GET", "file:///etc/passwd").is_err());
        assert!(validate_request("GET", "//u.y.qq.com/cgi-bin/musicu.fcg").is_err());
        // 前缀伪装：把白名单路径塞进 query 里不该被当成放行
        assert!(validate_request("GET", "https://u.y.qq.com/@evil/cgi-bin/musicu.fcg").is_err());
    }

    #[test]
    fn 主机解析覆盖端口与用户信息形态() {
        assert_eq!(
            host_of("https://u.y.qq.com:443/cgi-bin/x").as_deref(),
            Some("u.y.qq.com")
        );
        assert_eq!(
            host_of("https://EVIL.example.com/cgi-bin/musicu.fcg").as_deref(),
            Some("evil.example.com")
        );
        assert_eq!(host_of("https://u.y.qq.com").as_deref(), Some("u.y.qq.com"));
        // 没有 scheme 的写法由 validate_request 的协议检查挡掉，不靠 host_of 兜底
        assert!(validate_request("GET", "u.y.qq.com/cgi-bin/musicu.fcg").is_err());
    }

    #[test]
    fn 路径解析剥掉查询串() {
        assert_eq!(path_of("https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=A"), "/lyric/fcgi-bin/fcg_query_lyric_new.fcg");
        assert_eq!(path_of("https://u.y.qq.com"), "/");
    }
}
