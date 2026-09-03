//! 爬虫框架（务实版）
//!
//! 替代原计划的 6 模块：
//! - 物理层 DPDK/io_uring → reqwest + 代理池
//! - TLS ClientHello 手术 → rustls 默认 + UA 伪装（后续可接 tls-client crate）
//! - LD_PRELOAD 字体劫持 → CDP addScriptToEvaluateOnNewDocument JS 注入
//! - netns 重置 → 进程级浏览器实例重建
//! - 双令牌桶 + MPC → tokio::Semaphore 双桶 + EWMA
//! - AI 核 + MMAP + Prompt JIT → 复用 kernel 的 control plane
//!
//! 响应态势矩阵（对应 03 文档增强3）：根据响应特征自动调整策略
//! 指纹一致性校验（对应 03 文档增强2）：UA/WebGL/locale/hardwareConcurrency 多信号一致

pub mod immortal;
pub mod pool;
pub mod queue;
pub mod scheduler;
pub mod stealth;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::sync::Arc;

use crate::crawler::queue::queue;
use crate::crawler::scheduler::EwmaRtt;
use crate::kernel::events;
use crate::kernel::reward::{EventKind, RewardSignal};
use crate::kernel::strategy::{Phase, Strategy, StrategyDelta};

/// 响应态势评估（对应 03 文档增强3 实时态势感知）
#[derive(Debug, Clone)]
pub struct ResponseAssessment {
    pub status: u16,
    /// 检测到的挑战类型（cf-ray / x-datadome / _abck / challenge / captcha / empty）
    pub challenge: Option<String>,
    /// 是否为 Cloudflare 拦截
    pub is_cloudflare: bool,
    /// 是否为 DataDome 拦截
    pub is_datadome: bool,
    /// 是否为 CAPTCHA 页面
    pub is_captcha: bool,
    /// 是否为空内容（蜜罐嫌疑）
    pub is_empty: bool,
}

impl ResponseAssessment {
    /// 从 HTTP 响应解析态势
    pub fn from_response(
        status: u16,
        headers: &[(String, String)],
        body_preview: &str,
    ) -> Self {
        let mut is_cloudflare = false;
        let mut is_datadome = false;
        let mut challenge = None;

        for (k, v) in headers {
            let key = k.to_lowercase();
            match key.as_str() {
                "cf-ray" => {
                    is_cloudflare = true;
                    challenge = Some("cf-ray".to_string());
                }
                "x-datadome" => {
                    is_datadome = true;
                    challenge = Some("x-datadome".to_string());
                }
                _ => {}
            }
            if key == "set-cookie" && v.contains("_abck") {
                challenge = Some("akamai-abck".to_string());
            }
        }

        let body_lower = body_preview.to_lowercase();
        let is_captcha = body_lower.contains("captcha") || body_lower.contains("recaptcha");
        let is_empty = body_preview.trim().len() < 200 && status == 200;

        if is_captcha {
            challenge = Some("captcha".to_string());
        } else if body_lower.contains("challenge") || body_lower.contains("just a moment") {
            challenge = Some("challenge".to_string());
        }

        Self {
            status,
            challenge,
            is_cloudflare,
            is_datadome,
            is_captcha,
            is_empty,
        }
    }

    /// 根据态势生成策略补丁（决策矩阵）
    /// 对应 03 文档增强3 的决策矩阵
    pub fn to_delta(&self, current: &Strategy) -> StrategyDelta {
        // 200 + 正常内容 → 继续当前策略（无补丁）
        if self.status == 200 && self.challenge.is_none() && !self.is_empty {
            return StrategyDelta::default();
        }

        // 200 + 挑战页面 → 升级指纹 + 切换代理
        if self.status == 200 && self.challenge.is_some() {
            return StrategyDelta {
                stealth_level: Some((current.stealth_level + 15).min(100)),
                tls_profile: Some(rotate_tls(&current.tls_profile).to_string()),
                ..Default::default()
            };
        }

        // 403 + CF-Ray → Cloudflare 拦截 → 切换到浏览器模式
        if self.status == 403 && self.is_cloudflare {
            return StrategyDelta {
                use_browser: Some(true),
                stealth_level: Some((current.stealth_level + 20).min(100)),
                qps: Some((current.qps / 2).max(1)),
                ..Default::default()
            };
        }

        // 403 → 指纹可能被识别 → 切换指纹模板
        if self.status == 403 {
            return StrategyDelta {
                tls_profile: Some(rotate_tls(&current.tls_profile).to_string()),
                stealth_level: Some((current.stealth_level + 10).min(100)),
                ..Default::default()
            };
        }

        // 429 → 频率过高 → 降低频率
        if self.status == 429 {
            return StrategyDelta {
                qps: Some((current.qps / 2).max(1)),
                per_ip_concurrency: Some(1),
                ..Default::default()
            };
        }

        // 200 + CAPTCHA → 触发验证码处理（升 Phase 到 Exploit 或标记需要人工）
        if self.is_captcha {
            return StrategyDelta {
                phase: Some(Phase::Exploit),
                use_browser: Some(true),
                ..Default::default()
            };
        }

        // 200 + 空内容 → 可能被蜜罐 → 标记可疑 + 换 IP
        if self.is_empty {
            return StrategyDelta {
                proxy_pool_tag: Some("rotated".to_string()),
                ..Default::default()
            };
        }

        // 5xx → 服务异常 → 降速
        if self.status >= 500 {
            return StrategyDelta {
                qps: Some((current.qps / 2).max(1)),
                ..Default::default()
            };
        }

        StrategyDelta::default()
    }

    /// 映射到奖励信号 EventKind
    pub fn to_event_kind(&self) -> EventKind {
        match self.status {
            200 if self.challenge.is_none() && !self.is_empty => EventKind::Success,
            403 | 429 => EventKind::Rejected,
            s if s >= 500 => EventKind::Timeout,
            _ => EventKind::ValidationError,
        }
    }
}

/// 轮转 TLS 指纹（避免被同一指纹持续追踪）
fn rotate_tls(current: &str) -> &'static str {
    match current {
        "chrome_122" => "firefox_120",
        "firefox_120" => "safari_17",
        _ => "chrome_122",
    }
}

/// 指纹一致性校验（对应 03 文档增强2）
///
/// 规则示例：
/// - UA="Chrome/120 Windows" → WebGL RENDERER 必须含 "ANGLE"
/// - locale="zh-CN" → Accept-Language 必须含 "zh"
/// - hardwareConcurrency=8 → deviceMemory 必须 ∈ {4,8,16}
///
/// 不一致 → 返回修正建议（StrategyDelta）
pub fn validate_fingerprint_consistency(
    tls_profile: &str,
    locale: &str,
    hardware_concurrency: u8,
    device_memory: u8,
    accept_language: &str,
) -> Result<(), StrategyDelta> {
    // Chrome on Windows → WebGL RENDERER 应含 ANGLE（由 stealth.rs 注入保证）
    if tls_profile == "chrome_122" && !accept_language.contains("zh") && locale == "zh-CN" {
        return Err(StrategyDelta {
            // 提示：Accept-Language 与 locale 不一致，需修正
            ..Default::default()
        });
    }

    // hardwareConcurrency=8 → deviceMemory 必须是 4/8/16
    if hardware_concurrency == 8 && !matches!(device_memory, 4 | 8 | 16) {
        return Err(StrategyDelta {
            ..Default::default()
        });
    }

    Ok(())
}

/// 当前已播种的 seed（避免每 Tick 重复入队同一 focus_url）
static CURRENT_SEED: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

/// 当前正在抓取的 seed（前端展示用）
pub fn current_seed() -> Option<String> {
    CURRENT_SEED.lock().clone()
}

/// Recon 阶段执行入口（数据面 50ms Tick 调用）
///
/// 从全局 URL 队列 FIFO 出队一个 URL，按策略 QPS 节流后抓取。
/// focus_url 变化时作为 seed 重启一轮（避免对同一 URL 每 50ms 重复连打）。
pub async fn execute_recon(s: &Strategy, reward: &Arc<RewardSignal>) {
    // 播种：focus_url 变化 → 清空并重启队列，seed = depth0
    {
        let focus = s.focus_url.clone().unwrap_or_default();
        let mut cur = CURRENT_SEED.lock();
        if !focus.is_empty() && cur.as_deref() != Some(focus.as_str()) {
            let mut q = queue();
            q.clear();
            q.enqueue(&focus, 0);
            log::info!("[crawler] 播种 seed 重启队列: {} (QPS={})", focus, s.qps);
            *cur = Some(focus);
        }
    }

    // 出队一个 URL
    let next = {
        let mut q = queue();
        if q.is_empty() {
            return;
        }
        q.pop()
    };
    let Some((url, depth)) = next else { return };

    // QPS 限速：请求前等待到最小间隔，避免 50ms tick 连打
    let interval = EwmaRtt::min_interval(s.qps);
    if !interval.is_zero() {
        tokio::time::sleep(interval).await;
    }

    log::info!(
        "[crawler] 抓取 {} (depth={} qps={} stealth={} tls={})",
        url,
        depth,
        s.qps,
        s.stealth_level,
        s.tls_profile
    );

    crawl_fetch(&url, depth, s, reward).await;
}

/// 抓取单个 URL：记录奖励/态势，提取标题与同域链接并递归入队，推送 CrawlResult 事件。
/// 若代理池有存活代理则经由代理请求；403/429/5xx/网络错误会将该代理标记为死亡。
async fn crawl_fetch(url: &str, depth: u32, s: &Strategy, reward: &Arc<RewardSignal>) -> bool {
    let ua = stealth::user_agent(&s.tls_profile);

    // 代理池轮转：有存活代理则走代理，否则直连
    let proxy = crate::crawler::pool::pool().next();
    let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15));
    if let Some(p) = &proxy {
        if let Ok(pr) = reqwest::Proxy::all(&p.url) {
            builder = builder.proxy(pr);
        } else {
            log::warn!("[crawler] 代理 URL 无效，回退直连: {}", p.url);
        }
    }
    let client = match builder.build() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[crawler] 客户端构建失败: {}", e);
            return false;
        }
    };

    let resp = match client.get(url).header("User-Agent", ua).send().await {
        Ok(r) => r,
        Err(e) => {
            if proxy.is_some() {
                crate::crawler::pool::pool().mark_dead(&proxy.as_ref().unwrap().url);
            }
            reward.record(EventKind::Timeout);
            emit_result(url, 0, None, 0, false, Some(e.to_string()));
            log::warn!("[crawler] {} via {:?} 失败: {}", url, proxy.as_ref().map(|p| p.url.as_str()), e);
            return false;
        }
    };

    let status = resp.status().as_u16();

    // 风控/服务异常 → 标记当前代理死亡并回退
    if proxy.is_some() && (status == 403 || status == 429 || status >= 500) {
        crate::crawler::pool::pool().mark_dead(&proxy.as_ref().unwrap().url);
    }
    let headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let body = resp.text().await.unwrap_or_default();
    let body_preview: String = body.chars().take(4096).collect();

    let assessment = ResponseAssessment::from_response(status, &headers, &body_preview);
    reward.record(assessment.to_event_kind());

    log::info!(
        "[crawler] {} -> {} challenge={:?} cf={} dd={} captcha={} empty={}",
        url,
        status,
        assessment.challenge,
        assessment.is_cloudflare,
        assessment.is_datadome,
        assessment.is_captcha,
        assessment.is_empty
    );

    let delta = assessment.to_delta(s);
    if delta.qps.is_some() || delta.tls_profile.is_some() || delta.use_browser.is_some() {
        log::info!(
            "[crawler] 响应态势触发策略调整 qps={:?} tls={:?} browser={:?} stealth={:?}",
            delta.qps,
            delta.tls_profile,
            delta.use_browser,
            delta.stealth_level
        );
    }

    // 提取标题 + 同域链接，深度内递归入队
    let title = extract_title(&body);
    let links = extract_same_domain_links(&body, url);
    if !links.is_empty() {
        let mut q = queue();
        for link in &links {
            q.enqueue(link, depth + 1);
        }
        log::info!(
            "[crawler] {} 提取 {} 个同域链接，入队 depth={}",
            url,
            links.len(),
            depth + 1
        );
    }

    emit_result(url, status, title, links.len(), true, None);
    true
}

/// 推送 CrawlResult 事件到前端（经全局事件总线，无总线时静默）
fn emit_result(
    url: &str,
    status: u16,
    title: Option<String>,
    link_count: usize,
    success: bool,
    error: Option<String>,
) {
    events::try_emit(events::KernelEvent::CrawlResult {
        ts: events::now_ts(),
        url: url.to_string(),
        status,
        title,
        link_count,
        success,
        error,
    });
}

/// 从 HTML 提取 `<title>`（纯字符串匹配，零依赖）
fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let start = lower.find("<title")?;
    let content_start = html[start..].find('>')? + start + 1;
    let end = lower[content_start..].find("</title>")? + content_start;
    let t = html[content_start..end].trim();
    if t.is_empty() { None } else { Some(t.to_string()) }
}

/// 提取与 base 同域的绝对 `<a href>` 链接（相对转绝对 + 同域过滤 + 去重）
fn extract_same_domain_links(html: &str, base: &str) -> Vec<String> {
    let base_url = match url::Url::parse(base) {
        Ok(u) => u,
        Err(_) => return Vec::new(),
    };
    let base_host = base_url
        .host_str()
        .map(|h| h.to_lowercase())
        .unwrap_or_default();

    let mut links = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for chunk in html.split("href") {
        let trimmed = chunk.trim_start();
        if !trimmed.starts_with('=') {
            continue;
        }
        let after_eq = trimmed[1..].trim_start();
        let (quote, rest) = if let Some(r) = after_eq.strip_prefix('"') {
            ('"', r)
        } else if let Some(r) = after_eq.strip_prefix('\'') {
            ('\'', r)
        } else {
            continue;
        };
        let Some(end) = rest.find(quote) else { continue };
        let href = &rest[..end];
        if href.is_empty() || href.starts_with('#') || href.starts_with("javascript:") || href.starts_with("mailto:") {
            continue;
        }
        // 解析绝对链接
        let abs = match base_url.join(href) {
            Ok(u) if u.scheme() == "http" || u.scheme() == "https" => u,
            _ => continue,
        };
        let host = abs.host_str().map(|h| h.to_lowercase()).unwrap_or_default();
        if host != base_host {
            continue; // 仅同域，避免爬出目标站
        }
        let s = abs.as_str().to_string();
        if seen.insert(s.clone()) {
            links.push(s);
        }
    }
    links
}
