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

use crate::types::{DownloadTask, EngineConfig, ProbeRequest, ProbeResult};
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
    reqwest::Client::builder()
        // 与既有下载命令一致：不走系统代理，避免本地代理拦截/劫持大文件下载。
        .no_proxy()
        .connect_timeout(Duration::from_secs(config.connect_timeout_secs.max(1)))
        // read_timeout 是「两次读到数据之间」的上限，不是整个请求；大文件不会被总时限掐断。
        .read_timeout(Duration::from_secs(config.read_timeout_secs.max(1)))
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
