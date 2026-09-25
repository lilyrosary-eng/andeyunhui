//! 爬虫框架（务实版）
//!
//! 替代原计划的 6 模块：
//! - 物理层 DPDK/io_uring → reqwest + 代理池
//! - TLS ClientHello 手术 → **curl-impersonate 外部进程**（真实 JA3/JA4 指纹，见 `tls-impersonate` feature
//!   与 `impersonate.rs`）；未启用该 feature 时退回 rustls 默认 + UA 伪装
//! - LD_PRELOAD 字体劫持 → CDP addScriptToEvaluateOnNewDocument JS 注入
//! - netns 重置 → 进程级浏览器实例重建
//! - 双令牌桶 + MPC → tokio::Semaphore 双桶 + EWMA
//! - AI 核 + MMAP + Prompt JIT → 复用 kernel 的 control plane
//!
//! 响应态势矩阵（对应 03 文档增强3）：根据响应特征自动调整策略
//! 指纹一致性校验（对应 03 文档增强2）：UA/WebGL/locale/hardwareConcurrency 多信号一致

pub mod pool;
pub mod queue;
pub mod scheduler;
pub mod stealth;

// 真实 TLS/JA3-JA4 指纹通道（curl-impersonate 外部进程）：
// 仅 `tls-impersonate` feature 下编译；未启用时 fetch 走 rustls 默认通道。
#[cfg(feature = "tls-impersonate")]
pub mod impersonate;

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

        for (k, _v) in headers {
            let key = k.to_lowercase();
            match key.as_str() {
                "cf-ray" => {
                    // 仅标记 CDN 身份：cf-ray 在 Cloudflare 后端的每一次正常响应都会带，
                    // 不代表请求被拦截（真正的拦截由 4xx 状态码 + 挑战页 body 特征判定）
                    is_cloudflare = true;
                }
                "x-datadome" => {
                    is_datadome = true;
                }
                _ => {}
            }
            // _abck 仅为 Akamai 打点 cookie，同样不作为挑战证据
        }

        let body_lower = body_preview.to_lowercase();
        let is_captcha = body_lower.contains("captcha") || body_lower.contains("recaptcha");
        // 空壳判定：只有响应内容近空（<64 字节）才算蜜罐/空页，
        // 避免误伤小型静态页（如 landing page / 单页应用壳）
        let is_empty = body_preview.trim().len() < 64 && status == 200;

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
            // URL 规范化：裸域/无 scheme 的 focus 自动补 https://，避免 reqwest builder error
            let seed = crate::normalize_url(&focus);
            q.enqueue(&seed, 0);
            log::info!("[crawler] 播种 seed 重启队列: {} (QPS={})", seed, s.qps);
            *cur = Some(seed);
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

/// 单次抓取的整形计划（网关建议的落地形态；gateway 未启用时为直连默认值）
struct RequestShaping {
    /// 是否启用浏览器同构隐身头（Proxy/Stealth 模式；等价于「非直连」）
    stealth: bool,
    /// 网关活跃代理 URL（Proxy/Stealth 且网关池有真实节点时）
    gateway_proxy: Option<String>,
    /// 请求前整形间隔（毫秒）
    interval_ms: u64,
    /// 请求超时（毫秒）
    timeout_ms: u64,
    /// 路由模式名（日志/审计）
    routing: &'static str,
    /// 建议请求头顺序（仅 rustls stealth 通道生效）。
    /// impersonate 通道不得使用——`--impersonate` 自带的头序必须与指纹自洽，
    /// 从外部重排会制造「指纹与头序不符」的更强特征。
    header_order: Vec<String>,
    /// 是否处于突发期（Poisson 突发-静默；间隔已体现在 `interval_ms`，此处仅供日志/审计）
    in_burst: bool,
    /// 会话熵值与「是否需要假请求」建议。
    /// ⚠ 仅记录与告警，**不自动向目标注入假请求**：那等于模块自行决定对第三方目标
    /// 追加流量，越过「只提供能力、不做目标决策」的边界，也与「不洪泛」相冲突。
    entropy: f64,
    needs_noise: bool,
}

/// 默认请求超时（未被网关整形影响时保持既有行为）
const DEFAULT_TIMEOUT_MS: u64 = 15_000;
/// 单次抓取最大尝试次数（失败换代理重试）
const MAX_FETCH_ATTEMPTS: usize = 3;

/// 生成本次抓取的整形计划
///
/// - Direct（默认）→ 完全等价于既有行为：直连、仅 UA、15s 超时、无额外延迟
/// - Proxy/Stealth（`@rotate` 触发）→ 网关选路 + 整形间隔 + 隐身头 + 带宽超时
fn request_shaping(_s: &Strategy) -> RequestShaping {
    #[cfg(feature = "gateway")]
    {
        let advice = crate::gateway::shaper().next_advice();
        let direct = advice.routing == crate::gateway::RoutingMode::Direct;
        // 网关池的 Direct 虚拟节点 url 为 "direct"，不是真代理
        let gateway_proxy = advice.active_node.as_ref().and_then(|n| {
            if n.url.is_empty() || n.url == "direct" { None } else { Some(n.url.clone()) }
        });
        let timeout_ms = if direct && advice.bandwidth_ratio >= 1.0 {
            DEFAULT_TIMEOUT_MS
        } else {
            advice.request_timeout_ms
        };
        RequestShaping {
            stealth: !direct,
            gateway_proxy,
            interval_ms: if direct { 0 } else { advice.shaping.interval_ms },
            timeout_ms,
            routing: advice.routing.as_str(),
            header_order: if direct { Vec::new() } else { advice.shaping.header_order.clone() },
            in_burst: advice.shaping.in_burst,
            entropy: advice.shaping.current_entropy,
            needs_noise: advice.shaping.needs_noise,
        }
    }
    #[cfg(not(feature = "gateway"))]
    {
        RequestShaping {
            stealth: false,
            gateway_proxy: None,
            interval_ms: 0,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            routing: "direct",
            header_order: Vec::new(),
            in_burst: false,
            entropy: 0.0,
            needs_noise: false,
        }
    }
}

/// 解析本次尝试使用的代理
///
/// 顺序：网关选路（Proxy/Stealth 且网关池有真实节点）→ 爬虫自有代理池 → 直连。
/// 重试时重新问网关，避免死守已故障的同一节点。
/// 返回 `(代理, 是否来自网关池)`——决定失败时该在哪个池里标记。
fn next_proxy_for(
    shaping: &RequestShaping,
    attempt: usize,
) -> Option<(crate::crawler::pool::ProxyEntry, bool)> {
    let wrap = |url: String| crate::crawler::pool::ProxyEntry {
        url,
        tag: "gateway".to_string(),
        alive: true,
    };

    #[cfg(feature = "gateway")]
    {
        if shaping.stealth && attempt > 0 {
            let advice = crate::gateway::shaper().next_advice();
            if let Some(n) = advice.active_node {
                if !n.url.is_empty() && n.url != "direct" {
                    return Some((wrap(n.url), true));
                }
            }
        }
    }

    if attempt == 0 {
        if let Some(u) = &shaping.gateway_proxy {
            return Some((wrap(u.clone()), true));
        }
    }

    crate::crawler::pool::pool().next().map(|p| (p, false))
}

/// 单次尝试的结果
enum AttemptOutcome {
    /// 拿到 HTTP 响应
    Response {
        status: u16,
        headers: Vec<(String, String)>,
        body: String,
        rtt_ms: f64,
    },
    /// 传输层失败（可重试）
    Transport(String),
}

/// 执行一次抓取尝试：构造 client（可选代理）+ 应用整形头 + 单次请求
///
/// 通道优先级（`tls-impersonate` feature 开启且二进制可定位时）：
/// curl-impersonate 真实 TLS 指纹通道 → rustls/reqwest 通道。
/// 前者由 curl-impersonate 自行决定**全套请求头**，故不再叠加 stealth 头；
/// 后者维持既有行为（stealth 头集合 或 Direct 仅 UA）。
async fn fetch_once(
    url: &str,
    shaping: &RequestShaping,
    proxy: Option<&crate::crawler::pool::ProxyEntry>,
    tls_profile: &str,
) -> AttemptOutcome {
    #[cfg(feature = "tls-impersonate")]
    {
        if impersonate::is_available() {
            let proxy_url = proxy.map(|p| p.url.as_str());
            return match impersonate::fetch(url, proxy_url, shaping.timeout_ms, tls_profile).await {
                Ok(r) => AttemptOutcome::Response {
                    status: r.status,
                    headers: r.headers,
                    body: r.body,
                    rtt_ms: r.rtt_ms,
                },
                Err(e) => AttemptOutcome::Transport(e),
            };
        }
        // 二进制缺失（未打包/未导入 .mujin）：如实降级，不阻塞抓取
        log::debug!("[crawler] tls-impersonate 通道不可用（缺 curl-impersonate 二进制），降级 rustls");
    }

    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(shaping.timeout_ms.max(1_000)));

    if let Some(p) = proxy {
        match reqwest::Proxy::all(&p.url) {
            Ok(pr) => builder = builder.proxy(pr),
            Err(e) => log::warn!("[crawler] 代理 URL 无效，回退直连: {} ({})", p.url, e),
        }
    }

    let client = match builder.build() {
        Ok(c) => c,
        Err(e) => return AttemptOutcome::Transport(format!("客户端构建失败: {}", e)),
    };

    let mut req = client.get(url);
    if shaping.stealth {
        // Proxy/Stealth：浏览器同构头集合（UA/Accept/Language/Encoding/Client Hints 自洽）
        // 头序按网关建议重排（实测 reqwest/hyper 按插入顺序发送，故该整形真实生效；
        // Host/Content-Length 等由 hyper 自行追加到最后，属正常行为）
        let ordered = order_headers(stealth::headers_for(tls_profile).pairs(), &shaping.header_order);
        for (k, v) in ordered {
            req = req.header(k, v);
        }
        // 无 Referer 时补搜索引擎来源，贴近自然流量分布
        req = req.header("Referer", stealth::DEFAULT_REFERER);
    } else {
        // Direct：保持既有行为（仅 UA）
        req = req.header("User-Agent", stealth::user_agent(tls_profile));
    }

    let started = std::time::Instant::now();
    match req.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let headers: Vec<(String, String)> = resp
                .headers()
                .iter()
                .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
                .collect();
            let rtt_ms = started.elapsed().as_millis() as f64;
            let body = resp.text().await.unwrap_or_default();
            AttemptOutcome::Response { status, headers, body, rtt_ms }
        }
        Err(e) => AttemptOutcome::Transport(e.to_string()),
    }
}

/// 按网关建议的头序重排请求头
///
/// 建议中未出现的头按原有相对顺序追加到末尾（保证不丢头）；
/// `header_order` 为空表示不整形（Direct 模式）。
fn order_headers(
    pairs: Vec<(&'static str, &'static str)>,
    order: &[String],
) -> Vec<(&'static str, &'static str)> {
    if order.is_empty() {
        return pairs;
    }
    let mut out: Vec<(&'static str, &'static str)> = Vec::with_capacity(pairs.len());
    for want in order {
        for p in &pairs {
            if p.0.eq_ignore_ascii_case(want.as_str()) {
                out.push(*p);
            }
        }
    }
    for p in pairs {
        if !out.iter().any(|x| x.0.eq_ignore_ascii_case(p.0)) {
            out.push(p);
        }
    }
    out
}

/// 把 URL 归一成「请求模式」喂给网关熵监控器
///
/// 目的：让会话熵反映真实的路径分布，而不是恒为 0（此前爬虫从不记录，
/// 导致 `needs_noise` 永远不可能由真实流量触发）。
/// 归一：去 query/fragment → 取前 3 段路径 → 数字段折叠为 `#`（`/user/123` 与 `/user/456` 视为同模式）。
#[cfg(feature = "gateway")]
fn request_pattern(u: &url::Url) -> String {
    let mut segs: Vec<String> = Vec::new();
    for seg in u.path().split('/').filter(|s| !s.is_empty()).take(3) {
        if seg.chars().all(|c| c.is_ascii_digit()) {
            segs.push("#".to_string());
        } else {
            segs.push(seg.to_ascii_lowercase());
        }
    }
    format!("/{}", segs.join("/"))
}

/// 抓取单个 URL：记录奖励/态势，提取标题与同域链接并递归入队，推送 CrawlResult 事件。
///
/// 请求链路（P0 网关接线 + C 阶段整形下沉）：
/// 1. 取网关建议 → 决定路由模式 / 整形间隔 / 隐身头 / 请求头序 / 超时
/// 2. 选路：网关活跃节点 → 爬虫自有代理池 → 直连
/// 3. 失败换代理重试（仅代理链路故障才标记该代理死亡，目标拒绝不牵连代理）
/// 4. 结果回写网关健康度，驱动故障转移；请求模式喂给熵监控器
async fn crawl_fetch(raw_url: &str, depth: u32, s: &Strategy, reward: &Arc<RewardSignal>) -> bool {
    // URL 规范化兜底：队列中可能混入裸域/相对链接，统一补 scheme 后再请求
    let url = crate::normalize_url(raw_url);

    let shaping = request_shaping(s);

    // 整形间隔：Proxy/Stealth 下平滑请求时序（Direct 为 0，不引入额外延迟）
    // 该间隔由网关的 Poisson 突发-静默模型给出（突发期 ~200ms，静默期数秒）
    if shaping.interval_ms > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(shaping.interval_ms)).await;
    }

    // 熵监控：把本次请求模式计入会话分布。
    // needs_noise 只记日志告警，**不自动注入假请求**（见 RequestShaping 字段说明）。
    #[cfg(feature = "gateway")]
    if let Ok(u) = url::Url::parse(&url) {
        crate::gateway::shaping::record_request_pattern(&request_pattern(&u));
    }
    log::debug!(
        "[crawler] 整形落地: routing={} interval={}ms burst={} entropy={:.2} needs_noise={} 头序={}项",
        shaping.routing,
        shaping.interval_ms,
        shaping.in_burst,
        shaping.entropy,
        shaping.needs_noise,
        shaping.header_order.len()
    );

    let mut last_err: Option<String> = None;

    for attempt in 0..MAX_FETCH_ATTEMPTS {
        let proxy = next_proxy_for(&shaping, attempt);
        let proxy_desc = proxy.as_ref().map(|(p, _)| p.url.as_str());

        match fetch_once(&url, &shaping, proxy.as_ref().map(|(p, _)| p), &s.tls_profile).await {
            AttemptOutcome::Transport(err) => {
                // 仅「代理链路故障」才标记代理死亡；目标侧错误不牵连代理
                if let Some((p, from_gateway)) = &proxy {
                    if *from_gateway {
                        #[cfg(feature = "gateway")]
                        crate::gateway::shaper().record_request(0.0, true);
                    } else {
                        crate::crawler::pool::pool().mark_dead_if_proxy_error(&p.url, &err);
                    }
                }
                log::warn!(
                    "[crawler] {} 第 {}/{} 次尝试失败（routing={} proxy={:?}）: {}",
                    url,
                    attempt + 1,
                    MAX_FETCH_ATTEMPTS,
                    shaping.routing,
                    proxy_desc,
                    err
                );
                last_err = Some(err);

                // 若不是最后一次，短暂退避后换代理重试
                if attempt + 1 < MAX_FETCH_ATTEMPTS {
                    tokio::time::sleep(std::time::Duration::from_millis(250 * (attempt as u64 + 1)))
                        .await;
                }
                continue;
            }

            AttemptOutcome::Response { status, headers, body, rtt_ms } => {
                // 健康度回写：驱动网关故障转移（Direct 模式下作用于虚拟直连节点，无副作用）
                #[cfg(feature = "gateway")]
                crate::gateway::shaper().record_request(rtt_ms, status == 0 || status >= 400);

                // 目标侧风控/异常 → 换掉当前代理（沿用既有语义，仅爬虫池）
                if crate::crawler::pool::is_target_rejection(status) {
                    if let Some((p, from_gateway)) = &proxy {
                        if !*from_gateway {
                            crate::crawler::pool::pool().mark_dead(&p.url);
                        }
                    }
                }

                let body_preview: String = body.chars().take(4096).collect();
                let assessment = ResponseAssessment::from_response(status, &headers, &body_preview);
                reward.record(assessment.to_event_kind());

                log::info!(
                    "[crawler] {} -> {} challenge={:?} cf={} dd={} captcha={} empty={} routing={} proxy={:?} rtt={}ms",
                    url,
                    status,
                    assessment.challenge,
                    assessment.is_cloudflare,
                    assessment.is_datadome,
                    assessment.is_captcha,
                    assessment.is_empty,
                    shaping.routing,
                    proxy_desc,
                    rtt_ms as u64
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
                let links = extract_same_domain_links(&body, &url);
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

                emit_result(&url, status, title, links.len(), true, None);
                return true;
            }
        }
    }

    // 全部尝试失败
    reward.record(EventKind::Timeout);
    emit_result(&url, 0, None, 0, false, last_err.clone());
    log::warn!("[crawler] {} 经 {} 次尝试仍失败: {:?}", url, MAX_FETCH_ATTEMPTS, last_err);
    false
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
///
/// 用 `to_ascii_lowercase` 而非 `to_lowercase`：后者对部分非 ASCII 字符会改变字节长度，
/// 导致用小写串里找到的下标去切原串时错位（panic 或截断）。
fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let content_start = html[start..].find('>')? + start + 1;
    let end = lower[content_start..].find("</title>")? + content_start;
    let t = html[content_start..end].trim();
    if t.is_empty() { None } else { Some(t.to_string()) }
}

/// 视为「非页面资源」的扩展名：爬虫预算应优先给可解析页面，而非图片/脚本/媒体等
const ASSET_EXTENSIONS: &[&str] = &[
    // 图片 / 样式 / 脚本
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif", "tiff",
    "css", "js", "mjs", "map",
    // 字体
    "woff", "woff2", "ttf", "otf", "eot",
    // 媒体
    "mp4", "webm", "mkv", "mov", "avi", "mp3", "wav", "ogg", "flac", "m4a", "aac",
    // 归档 / 文档 / 安装包
    "zip", "gz", "tar", "rar", "7z", "bz2", "xz",
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "apk", "exe", "dmg", "msi", "bin", "iso",
];

/// 判断 URL 是否指向非页面资源（按末段扩展名）
fn is_asset_url(u: &url::Url) -> bool {
    let last = u.path().rsplit('/').next().unwrap_or("");
    match last.rsplit_once('.') {
        Some((_, ext)) => ASSET_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()),
        None => false,
    }
}

/// 提取与 base 同域的绝对页面链接
///
/// 处理：属性名大小写不敏感（`<A HREF=` 也能命中）+ 相对转绝对 + 同域过滤
/// + 去锚点 + 过滤非页面资源 + 去重。
fn extract_same_domain_links(html: &str, base: &str) -> Vec<String> {
    let base_url = match url::Url::parse(base) {
        Ok(u) => u,
        Err(_) => return Vec::new(),
    };
    let base_host = base_url
        .host_str()
        .map(|h| h.to_ascii_lowercase())
        .unwrap_or_default();

    // 用 ASCII 小写副本定位属性名：字节长度与原串一致，故下标可直接用于原串切片
    let lower = html.to_ascii_lowercase();
    let mut links = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut from = 0usize;

    while let Some(rel) = lower[from..].find("href") {
        let pos = from + rel;
        from = pos + 4;

        let rest = html[pos + 4..].trim_start();
        let Some(after_eq) = rest.strip_prefix('=') else { continue };
        let after_eq = after_eq.trim_start();
        let (quote, inner) = if let Some(r) = after_eq.strip_prefix('"') {
            ('"', r)
        } else if let Some(r) = after_eq.strip_prefix('\'') {
            ('\'', r)
        } else {
            continue;
        };
        let Some(end) = inner.find(quote) else { continue };
        let href = inner[..end].trim();
        if href.is_empty() || href.starts_with('#') {
            continue;
        }
        let hl = href.to_ascii_lowercase();
        if hl.starts_with("javascript:")
            || hl.starts_with("mailto:")
            || hl.starts_with("tel:")
            || hl.starts_with("data:")
            || hl.starts_with("blob:")
        {
            continue;
        }

        let mut abs = match base_url.join(href) {
            Ok(u) if u.scheme() == "http" || u.scheme() == "https" => u,
            _ => continue,
        };
        // 仅同域，避免爬出目标站
        if abs.host_str().map(|h| h.to_ascii_lowercase()).unwrap_or_default() != base_host {
            continue;
        }
        // 去锚点：`/page#a` 与 `/page#b` 是同一页面，避免重复入队
        abs.set_fragment(None);
        if is_asset_url(&abs) {
            continue;
        }
        let s = abs.to_string();
        if seen.insert(s.clone()) {
            links.push(s);
        }
    }
    links
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_title_basic() {
        let html = "<html><head><TITLE> 安得云荟 </TITLE></head></html>";
        assert_eq!(extract_title(html).as_deref(), Some("安得云荟"));
    }

    #[test]
    fn test_extract_title_non_ascii_no_panic() {
        // to_ascii_lowercase 保证字节长度不变，含非 ASCII 时切片不应错位
        let html = "<title>İstanbul 大标题</title>";
        assert_eq!(extract_title(html).as_deref(), Some("İstanbul 大标题"));
    }

    #[test]
    fn test_is_asset_url() {
        let u = |s: &str| url::Url::parse(s).unwrap();
        assert!(is_asset_url(&u("https://a.com/logo.png")));
        assert!(is_asset_url(&u("https://a.com/app.js")));
        assert!(is_asset_url(&u("https://a.com/style.CSS"))); // 扩展名大小写不敏感
        assert!(!is_asset_url(&u("https://a.com/docs")));     // 无扩展名
        assert!(!is_asset_url(&u("https://a.com/page.html")));
        assert!(!is_asset_url(&u("https://a.com/v1.2/list"))); // 目录名含点但末段无扩展名
    }

    #[test]
    fn test_links_relative_absolute_and_dedupe() {
        let html = r#"
            <a href="/about">about</a>
            <a href='/about'>dup</a>
            <a href="https://other.com/x">external</a>
            <a href="contact">relative</a>
        "#;
        let links = extract_same_domain_links(html, "https://a.com/base/");
        assert!(links.contains(&"https://a.com/about".to_string()));
        // 同域去重
        assert_eq!(links.iter().filter(|l| l.as_str() == "https://a.com/about").count(), 1);
        // 跨域被过滤
        assert!(!links.iter().any(|l| l.contains("other.com")));
        // 相对路径转绝对
        assert!(links.contains(&"https://a.com/base/contact".to_string()));
    }

    #[test]
    fn test_links_uppercase_href_and_fragment_and_assets() {
        let html = r#"
            <A HREF="https://a.com/p1#sec">upper</A>
            <a href="https://a.com/p1#other">same page different anchor</a>
            <a href="https://a.com/logo.png">img</a>
            <a href="javascript:void(0)">js</a>
            <a href="mailto:a@b.com">mail</a>
        "#;
        let links = extract_same_domain_links(html, "https://a.com/");
        // 大写属性名可命中
        assert!(links.contains(&"https://a.com/p1".to_string()));
        // 锚点被去掉，同页只留一条
        assert_eq!(links.iter().filter(|l| l.starts_with("https://a.com/p1")).count(), 1);
        // 资源与伪协议被过滤
        assert!(!links.iter().any(|l| l.ends_with(".png")));
        assert!(!links.iter().any(|l| l.starts_with("javascript:")));
        assert!(!links.iter().any(|l| l.starts_with("mailto:")));
    }
}
