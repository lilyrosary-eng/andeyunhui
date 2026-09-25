//! 统一 HTTP GET 通道：能用真实 TLS 指纹就用，否则退回 rustls/reqwest
//!
//! 为什么单独成模块：「指纹通道是否可用」是**运行时**事实（二进制可能未随包分发），
//! 而调用方分散在不同 feature 组合下（crawler / pentest / 两者皆无）。
//! 把「走哪条通道 + 如何降级」收敛到一处，调用方只关心拿到响应，
//! 避免每个调用点各写一遍 `#[cfg]` 与降级分支（写漏一处就是「宣称伪装、实则裸奔」）。
//!
//! 本模块始终编译：`tls-impersonate` 未启用或二进制缺失时，等价于既有的 reqwest 行为。

use std::time::{Duration, Instant};

/// 通道标识：curl-impersonate 真实指纹
pub const CH_IMPERSONATE: &str = "impersonate";
/// 通道标识：rustls/reqwest 默认指纹
pub const CH_RUSTLS: &str = "rustls";

/// 默认 TLS 档案（内核未启动 / 调用方无策略上下文时使用，与模块其余部分一致）
pub const DEFAULT_TLS_PROFILE: &str = "chrome_122";

/// 默认超时（与既有 gongfang_fetch 的 15s 对齐）
pub const DEFAULT_TIMEOUT_MS: u64 = 15_000;

/// 一次 GET 的归一化结果（字段口径与爬虫 `AttemptOutcome::Response` 一致）
#[derive(Debug, Clone)]
pub struct GetResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
    /// 全链路耗时（ms）
    pub rtt_ms: f64,
    /// 实际生效的通道（`impersonate` / `rustls`），供日志与审计
    pub channel: &'static str,
}

impl GetResponse {
    /// 按大小写不敏感取响应头（多值取第一个）
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// 发一次 GET：优先真实 TLS 指纹通道，不可用时静默降级 rustls
///
/// - `tls_profile`：策略档案名（chrome_122 / firefox_120 / safari_17），
///   仅在启用 `crawler` 时用于 rustls 通道的 UA 伪装；指纹通道由自身决定全套头。
pub async fn get(url: &str, timeout_ms: u64, tls_profile: &str) -> Result<GetResponse, String> {
    #[cfg(feature = "tls-impersonate")]
    {
        if crate::crawler::impersonate::is_available() {
            let r = crate::crawler::impersonate::fetch(url, None, timeout_ms, tls_profile).await?;
            return Ok(GetResponse {
                status: r.status,
                headers: r.headers,
                body: r.body,
                rtt_ms: r.rtt_ms,
                channel: CH_IMPERSONATE,
            });
        }
        log::debug!("[http] tls-impersonate 不可用（缺二进制），本请求走 rustls 通道");
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms.max(1_000)))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("HTTP 客户端构建失败: {}", e))?;

    let mut req = client.get(url);
    #[cfg(feature = "crawler")]
    {
        // UA 伪装（等价于既有 gongfang_fetch 行为：只换 UA，不改 ClientHello）
        req = req.header("User-Agent", crate::crawler::stealth::user_agent(tls_profile));
    }
    #[cfg(not(feature = "crawler"))]
    {
        let _ = tls_profile;
    }

    let started = Instant::now();
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let rtt_ms = started.elapsed().as_millis() as f64;
    let body = resp.text().await.unwrap_or_default();

    Ok(GetResponse {
        status,
        headers,
        body,
        rtt_ms,
        channel: CH_RUSTLS,
    })
}