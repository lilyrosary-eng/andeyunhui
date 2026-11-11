//! 目标探测：拿最终地址、总大小、是否支持 Range、文件名。
//!
//! 探测顺序：
//! 1. HEAD：便宜，先看 `Content-Length` / `Accept-Ranges`；
//! 2. 不可信或缺失时用 `GET Range: bytes=0-0` 复核（206 说明确实支持分段）。
//!
//! 所有请求统一带 `Accept-Encoding: identity`：Range 偏移必须与服务端文件字节一一对应，
//! 一旦传输层压缩，分段写入就会错位。

use std::collections::BTreeMap;
use std::time::Duration;

use reqwest::header::{
    HeaderMap, ACCEPT, ACCEPT_ENCODING, ACCEPT_RANGES, CONTENT_DISPOSITION, CONTENT_LENGTH,
    CONTENT_RANGE, CONTENT_TYPE, COOKIE, RANGE, REFERER, USER_AGENT,
};
use reqwest::RequestBuilder;

use crate::types::{DownloadTask, EngineConfig, HlsVariant, ProbeRequest, ProbeResult};
use crate::util::{filename_from_url, percent_decode, DEFAULT_UA};

/// 与任务解耦的请求上下文（命令层探测也复用）。
#[derive(Debug, Clone, Default)]
pub struct HttpMeta {
    pub user_agent: Option<String>,
    pub referer: Option<String>,
    pub cookie: Option<String>,
    pub headers: BTreeMap<String, String>,
}

impl HttpMeta {
    pub fn from_task(task: &DownloadTask) -> Self {
        Self {
            user_agent: task.user_agent.clone(),
            referer: task.referer.clone(),
            cookie: task.cookie.clone(),
            headers: task.headers.clone(),
        }
    }

    pub fn from_request(request: &ProbeRequest) -> Self {
        Self {
            user_agent: request.user_agent.clone(),
            referer: request.referer.clone(),
            cookie: request.cookie.clone(),
            headers: request.headers.clone(),
        }
    }
}

pub fn build_client(config: &EngineConfig) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(config.connect_timeout_secs.max(1)))
        // read_timeout 是「两次读到数据之间」的上限，不是整个请求；大文件不会被总时限掐断。
        .read_timeout(Duration::from_secs(config.read_timeout_secs.max(1)));
    builder = match config
        .proxy
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(proxy) => builder.proxy(
            reqwest::Proxy::all(proxy).map_err(|e| format!("代理配置无效（{proxy}）: {e}"))?,
        ),
        // 未显式配置代理时保持既有行为：不走系统代理，避免本地代理劫持大文件下载。
        None => builder.no_proxy(),
    };
    builder
        .build()
        .map_err(|e| format!("创建下载客户端失败: {e}"))
}

pub fn apply_headers(
    request: RequestBuilder,
    meta: &HttpMeta,
    default_ua: &str,
) -> RequestBuilder {
    let ua = meta
        .user_agent
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(default_ua);
    let mut request = request
        .header(USER_AGENT, ua)
        .header(ACCEPT, "*/*")
        .header(ACCEPT_ENCODING, "identity");
    if let Some(referer) = meta.referer.as_deref().filter(|s| !s.is_empty()) {
        request = request.header(REFERER, referer);
    }
    if let Some(cookie) = meta.cookie.as_deref().filter(|s| !s.is_empty()) {
        request = request.header(COOKIE, cookie);
    }
    for (name, value) in &meta.headers {
        request = request.header(name, value);
    }
    request
}

/// 主地址探测失败时按顺序尝试镜像；返回第一个可用源。
/// 只做「启动时源切换」，不在下载中途切源（分片偏移可能与另一源不一致）。
pub async fn select_source(
    client: &reqwest::Client,
    primary: &str,
    mirrors: &[String],
    meta: &HttpMeta,
) -> (String, ProbeResult) {
    if let Ok(result) = probe(client, primary, meta).await {
        return (primary.to_string(), result);
    }
    for mirror in mirrors {
        if let Ok(result) = probe(client, mirror, meta).await {
            return (mirror.clone(), result);
        }
    }
    (primary.to_string(), ProbeResult::default())
}

/// 拉取 HLS 主播放列表并解析清晰度变体；媒体播放列表或非 m3u8 返回空列表。
pub async fn hls_variants(
    client: &reqwest::Client,
    url: &str,
    meta: &HttpMeta,
    default_ua: &str,
) -> Result<Vec<HlsVariant>, String> {
    let resp = apply_headers(client.get(url), meta, default_ua)
        .send()
        .await
        .map_err(|e| format!("获取 HLS 播放列表失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("获取 HLS 播放列表失败: HTTP {}", resp.status()));
    }
    let final_url = resp.url().clone();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取 HLS 播放列表失败: {e}"))?;
    if text.len() > 4 * 1024 * 1024 {
        return Err("HLS 播放列表过大，已跳过清晰度解析".to_string());
    }
    Ok(parse_master_playlist(&text, &final_url))
}

/// 解析 `#EXT-X-STREAM-INF` 变体。相对地址按清单最终 URL 解析，
/// 并在变体自身没有 query 时继承主清单的 query（签名参数通常在主清单上）。
fn parse_master_playlist(text: &str, base: &reqwest::Url) -> Vec<HlsVariant> {
    let mut variants = Vec::new();
    let mut pending: Option<&str> = None;
    for raw in text.lines() {
        let line = raw.trim();
        if let Some(attrs) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            pending = Some(attrs);
            continue;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(attrs) = pending.take() else {
            continue;
        };
        let Ok(mut resolved) = base.join(line) else {
            continue;
        };
        if resolved.query().is_none() {
            if let Some(query) = base.query() {
                resolved.set_query(Some(query));
            }
        }
        let attrs = parse_attrs(attrs);
        let bandwidth = attrs
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("BANDWIDTH"))
            .and_then(|(_, value)| value.parse::<u64>().ok())
            .unwrap_or(0);
        let resolution = attrs
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("RESOLUTION"))
            .map(|(_, value)| (*value).to_string());
        let codecs = attrs
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("CODECS"))
            .map(|(_, value)| (*value).to_string());
        let name = resolution.clone().unwrap_or_else(|| {
            if bandwidth > 0 {
                format!("{} kbps", bandwidth / 1000)
            } else {
                "默认".to_string()
            }
        });
        variants.push(HlsVariant {
            url: resolved.to_string(),
            bandwidth,
            resolution,
            codecs,
            name,
        });
    }
    variants.sort_by(|a, b| b.bandwidth.cmp(&a.bandwidth));
    let mut seen = std::collections::HashSet::new();
    variants.retain(|variant| seen.insert(variant.url.clone()));
    variants
}

/// 按逗号切分属性，引号内的逗号不切（`CODECS="avc1.4d401f,mp4a.40.2"`）。
fn parse_attrs(attrs: &str) -> Vec<(&str, &str)> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    for (index, ch) in attrs.char_indices() {
        match ch {
            '"' => quoted = !quoted,
            ',' if !quoted => {
                parts.push(&attrs[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    parts.push(&attrs[start..]);
    parts
        .into_iter()
        .filter_map(|part| part.split_once('='))
        .map(|(key, value)| (key.trim(), value.trim().trim_matches('"')))
        .collect()
}

/// 探测 URL。先 HEAD，再用 Range 复核（部分服务器 HEAD 不给全信息）。
pub async fn probe(
    client: &reqwest::Client,
    url: &str,
    meta: &HttpMeta,
) -> Result<ProbeResult, String> {
    let head = apply_headers(client.head(url), meta, DEFAULT_UA)
        .send()
        .await
        .ok()
        .filter(|resp| resp.status().is_success())
        .map(|resp| result_from_headers(resp.url().as_str(), resp.headers(), false));

    if let Some(info) = &head {
        if info.accept_ranges && info.total_bytes > 0 {
            return Ok(info.clone());
        }
    }

    let resp = apply_headers(
        client.get(url).header(RANGE, "bytes=0-0"),
        meta,
        DEFAULT_UA,
    )
    .send()
    .await
    .map_err(|e| format!("探测下载地址失败: {e}"))?;

    if !resp.status().is_success() {
        if let Some(info) = head {
            return Ok(info);
        }
        return Err(format!("探测返回状态 {}", resp.status()));
    }

    let partial = resp.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    let mut info = result_from_headers(resp.url().as_str(), resp.headers(), partial);
    if let Some(head_info) = head {
        if info.content_type.is_none() {
            info.content_type = head_info.content_type;
        }
        if info.filename.is_none() {
            info.filename = head_info.filename;
        }
        if info.etag.is_none() {
            info.etag = head_info.etag;
        }
        if info.last_modified.is_none() {
            info.last_modified = head_info.last_modified;
        }
        if info.total_bytes == 0 {
            info.total_bytes = head_info.total_bytes;
        }
        info.accept_ranges |= head_info.accept_ranges;
    }
    // 206 + Content-Range 是最可信的 Range 证据。
    info.accept_ranges |= partial;
    Ok(info)
}

fn result_from_headers(url: &str, headers: &HeaderMap, partial: bool) -> ProbeResult {
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let etag = headers
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let last_modified = headers
        .get(reqwest::header::LAST_MODIFIED)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let total_bytes = content_length(headers)
        .or_else(|| content_range_total(headers))
        .unwrap_or(0);

    let accept_ranges = partial
        || headers
            .get(ACCEPT_RANGES)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.to_ascii_lowercase().contains("bytes"))
            .unwrap_or(false);

    let filename = content_disposition_filename(headers).or_else(|| filename_from_url(url));

    ProbeResult {
        final_url: url.to_string(),
        total_bytes,
        accept_ranges,
        content_type,
        filename,
        etag,
        last_modified,
    }
}

fn content_length(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
}

/// `Content-Range: bytes 0-0/12345` → 12345。
fn content_range_total(headers: &HeaderMap) -> Option<u64> {
    let raw = headers.get(CONTENT_RANGE)?.to_str().ok()?;
    let total = raw.rsplit('/').next()?.trim();
    if total == "*" {
        return None;
    }
    total.parse::<u64>().ok()
}

fn content_disposition_filename(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(CONTENT_DISPOSITION)?.to_str().ok()?;
    let lower = raw.to_ascii_lowercase();

    if let Some(index) = lower.find("filename*=") {
        let rest = &raw[index + "filename*=".len()..];
        let value = rest.split(';').next().unwrap_or(rest).trim();
        // RFC 5987: charset''percent-encoded
        let value = value
            .split_once("''")
            .map(|(_, tail)| tail)
            .unwrap_or(value)
            .trim_matches('"');
        let decoded = percent_decode(value);
        let decoded = decoded.trim();
        if !decoded.is_empty() {
            return Some(decoded.to_string());
        }
    }

    if let Some(index) = lower.find("filename=") {
        let rest = &raw[index + "filename=".len()..];
        let value = rest.split(';').next().unwrap_or(rest).trim().trim_matches('"');
        if !value.is_empty() {
            return Some(percent_decode(value));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_client_builds_without_proxy() {
        assert!(build_client(&EngineConfig::default()).is_ok());
    }

    #[test]
    fn invalid_proxy_is_rejected() {
        let config = EngineConfig {
            proxy: Some("http://[::bad".to_string()),
            ..Default::default()
        };
        assert!(build_client(&config).is_err());
    }

    #[test]
    fn parses_hls_master_variants() {
        let base =
            reqwest::Url::parse("https://cdn.test/hls/master.m3u8?token=abc").unwrap();
        let text = concat!(
            "#EXTM3U\n",
            "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,",
            "CODECS=\"avc1.4d401e,mp4a.40.2\"\n",
            "low/index.m3u8\n",
            "#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\n",
            "high.m3u8\n",
        );
        let list = parse_master_playlist(text, &base);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "1920x1080");
        assert_eq!(list[0].url, "https://cdn.test/hls/high.m3u8?token=abc");
        assert_eq!(list[1].url, "https://cdn.test/hls/low/index.m3u8?token=abc");
        assert_eq!(list[1].codecs.as_deref(), Some("avc1.4d401e,mp4a.40.2"));
    }

    #[test]
    fn media_playlist_has_no_variants() {
        let base = reqwest::Url::parse("https://cdn.test/a.m3u8").unwrap();
        let text = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg1.ts\n";
        assert!(parse_master_playlist(text, &base).is_empty());
    }
}
