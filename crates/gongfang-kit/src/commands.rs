//! 攻防 Tauri 命令层
//!
//! 命令始终注册（gongfang-kit 骨架始终编译），feature 未启用时返回 stub 错误。
//! 重型依赖（chromiumoxide 等）在 gongfang-kit 的 feature 后，主二进制零污染。
//!
//! 设计原则：所有命令和类型定义始终编译（无 #[cfg(feature)] 标注），
//! 命令内部用 #[cfg(feature)] 块判断逻辑，feature 未启用时返回 Err。
//! 这样 main.rs 可以直接注册所有命令，无需条件编译。

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::AppHandle;

use crate::ai::{load_profiles, resolve_profile};
use crate::kernel::priority::UserCommand;
use crate::kernel::strategy::Strategy;
use crate::kernel::{KernelEngine, KernelHandle};

struct EngineState {
    engine: Arc<KernelEngine>,
    handle: Option<KernelHandle>,
}

static STATE: Lazy<Mutex<Option<EngineState>>> = Lazy::new(|| Mutex::new(None));

#[derive(Serialize)]
pub struct Features {
    pub crawler: bool,
    pub reverse: bool,
    pub pentest: bool,
    pub automation: bool,
    pub gateway: bool,
}

#[derive(Serialize)]
pub struct GongfangStatus {
    pub running: bool,
    pub strategy: Strategy,
    pub reward: i64,
    pub error_rate: f64,
    pub features: Features,
}

fn features() -> Features {
    Features {
        crawler: cfg!(feature = "crawler"),
        reverse: cfg!(feature = "reverse"),
        pentest: cfg!(feature = "pentest"),
        automation: cfg!(feature = "automation"),
        gateway: cfg!(feature = "gateway"),
    }
}

/// 查询攻防内核状态
#[tauri::command]
pub fn gongfang_status() -> Result<GongfangStatus, String> {
    let state = STATE.lock();
    if let Some(s) = state.as_ref() {
        Ok(GongfangStatus {
            running: true,
            strategy: s.engine.snapshot(),
            reward: s.engine.reward.total_reward(),
            error_rate: s.engine.reward.error_rate(),
            features: features(),
        })
    } else {
        Ok(GongfangStatus {
            running: false,
            strategy: Strategy::default(),
            reward: 0,
            error_rate: 0.0,
            features: features(),
        })
    }
}

/// 启动攻防内核（双轨制：AI 控制面 + 数据面执行）
#[tauri::command]
pub async fn gongfang_start(app: AppHandle, profile_id: Option<String>) -> Result<(), String> {
    {
        let state = STATE.lock();
        if state.is_some() {
            return Err("攻防内核已在运行".to_string());
        }
    }
    let profiles = load_profiles(&app);
    let profile = resolve_profile(&profiles, profile_id);
    if profile.api_key.trim().is_empty() {
        return Err("未配置 AI API Key，请先在全局设置 → 模型 中填写".to_string());
    }
    let engine = Arc::new(KernelEngine::new(app, profile));
    let handle = engine.start();
    let mut state = STATE.lock();
    *state = Some(EngineState {
        engine,
        handle: Some(handle),
    });
    log::info!("[gongfang] 双轨制内核启动（控制面 500ms 推理 + 数据面 50ms Tick）");
    Ok(())
}

/// 停止攻防内核
#[tauri::command]
pub async fn gongfang_stop() -> Result<(), String> {
    let handle_opt = {
        let mut state = STATE.lock();
        state.as_mut().and_then(|s| s.handle.take())
    };
    if let Some(h) = handle_opt {
        h.stop().await;
        log::info!("[gongfang] 内核停止");
    }
    *STATE.lock() = None;
    Ok(())
}

/// 注入用户提示词指令（@focus/@bypass/@pause 等）
#[tauri::command]
pub fn gongfang_inject(cmd: UserCommand) -> Result<(), String> {
    let state = STATE.lock();
    let s = state.as_ref().ok_or("攻防内核未启动，请先调用 gongfang_start")?;
    s.engine.inject_command(cmd);
    Ok(())
}

// ============ 渗透框架专属命令 ============

/// 端口扫描结果（始终编译，与 pentest::scanner::ScanResult 字段对齐）
#[derive(Serialize)]
pub struct ScanResult {
    pub host: String,
    pub open_ports: Vec<ScanPort>,
    pub duration_ms: u64,
    pub error: Option<String>,
    pub naabu_path: Option<String>,
}

#[derive(Serialize)]
pub struct ScanPort {
    pub host: String,
    pub ip: String,
    pub port: u16,
    pub protocol: String,
    pub service: Option<String>,
    pub tls: Option<bool>,
}

/// 端口扫描（调用 naabu 外部进程，MIT 协议）
///
/// 替代 nmap (NPSL) / masscan (AGPL)
#[tauri::command]
pub async fn gongfang_scan(host: String, ports: Option<Vec<u16>>) -> Result<ScanResult, String> {
    if host.trim().is_empty() {
        return Err("host 不能为空".to_string());
    }
    #[cfg(feature = "pentest")]
    {
        let r = if let Some(p) = ports {
            if p.is_empty() {
                crate::pentest::scanner::quick_scan(&host).await
            } else {
                crate::pentest::scanner::scan_ports(&host, &p).await
            }
        } else {
            crate::pentest::scanner::quick_scan(&host).await
        };
        Ok(ScanResult {
            host: r.host,
            open_ports: r.open_ports.into_iter().map(|p| ScanPort {
                host: p.host,
                ip: p.ip,
                port: p.port,
                protocol: p.protocol,
                service: p.service,
                tls: p.tls,
            }).collect(),
            duration_ms: r.duration_ms,
            error: r.error,
            naabu_path: r.naabu_path,
        })
    }
    #[cfg(not(feature = "pentest"))]
    {
        let _ = (host, ports);
        Err("pentest feature 未启用，请用 --features gongfang-pentest 编译".to_string())
    }
}

/// WAF 检测结果
#[derive(Serialize)]
pub struct WafDetectResult {
    pub url: String,
    pub waf_name: Option<String>,
    pub engine: String,
    pub entropy: f64,
    pub status_code: u16,
    pub signals: Vec<String>,
}

/// WAF 指纹检测
#[tauri::command]
pub async fn gongfang_waf_detect(url: String) -> Result<WafDetectResult, String> {
    if url.trim().is_empty() {
        return Err("url 不能为空".to_string());
    }
    #[cfg(feature = "pentest")]
    {
        let resp = crate::pentest::probe::probe_target(&url).await;
        let waf_name = crate::pentest::regex_dfa::detect_waf(&resp.headers);
        let engine = crate::pentest::regex_dfa::detect_engine(&resp.headers);
        let entropy = crate::pentest::probe::shannon_entropy(&resp.body);
        let signals = crate::pentest::probe::extract_waf_signals(&resp);
        Ok(WafDetectResult {
            url,
            waf_name,
            engine: format!("{:?}", engine),
            entropy,
            status_code: resp.status,
            signals,
        })
    }
    #[cfg(not(feature = "pentest"))]
    {
        let _ = url;
        Err("pentest feature 未启用，请用 --features gongfang-pentest 编译".to_string())
    }
}

// ============ 爬虫实际爬取命令 ============

/// 爬取结果（实际 HTTP 请求返回的页面数据）
#[derive(Serialize)]
pub struct FetchResult {
    pub url: String,
    pub status: u16,
    pub content_type: String,
    pub content_length: usize,
    pub title: Option<String>,
    pub body_preview: String,
    pub links: Vec<String>,
    pub duration_ms: u64,
    pub error: Option<String>,
}

/// 实际爬取 URL — 发 HTTP GET 请求，返回页面内容 + 提取的标题和链接
///
/// 这是"对话即攻防"的核心：用户输入 URL，AI 调用 fetch，返回真实数据
#[tauri::command]
pub async fn gongfang_fetch(url: String) -> Result<FetchResult, String> {
    if url.trim().is_empty() {
        return Err("url 不能为空".to_string());
    }
    #[cfg(feature = "crawler")]
    {
        let start = std::time::Instant::now();
        let ua = crate::crawler::stealth::user_agent("chrome_122");
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .map_err(|e| format!("HTTP 客户端构建失败: {}", e))?;

        match client.get(&url).header("User-Agent", ua).send().await {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let content_type = resp
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                let body = resp.text().await.unwrap_or_default();
                let content_length = body.len();

                // 提取 <title>
                let title = extract_title(&body);

                // 提取 <a href="..."> 链接（最多 50 个）
                let links = extract_links(&body, &url);

                let body_preview: String = body.chars().take(2000).collect();
                let duration_ms = start.elapsed().as_millis() as u64;

                Ok(FetchResult {
                    url,
                    status,
                    content_type,
                    content_length,
                    title,
                    body_preview,
                    links,
                    duration_ms,
                    error: None,
                })
            }
            Err(e) => {
                let duration_ms = start.elapsed().as_millis() as u64;
                Ok(FetchResult {
                    url,
                    status: 0,
                    content_type: String::new(),
                    content_length: 0,
                    title: None,
                    body_preview: String::new(),
                    links: vec![],
                    duration_ms,
                    error: Some(e.to_string()),
                })
            }
        }
    }
    #[cfg(not(feature = "crawler"))]
    {
        let _ = url;
        Err("crawler feature 未启用，请用 --features gongfang-crawler 编译".to_string())
    }
}

/// 从 HTML 提取 <title>
fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let start = lower.find("<title")?;
    let content_start = html[start..].find('>')? + start + 1;
    let end = lower[content_start..].find("</title>")? + content_start;
    let title = html[content_start..end].trim();
    if title.is_empty() {
        None
    } else {
        Some(title.to_string())
    }
}

/// 从 HTML 提取 <a href="..."> 链接，转为绝对 URL（纯字符串匹配，无需 regex 依赖）
fn extract_links(html: &str, base_url: &str) -> Vec<String> {
    let mut links = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for part in html.split("href") {
        if part.is_empty() {
            continue;
        }
        let trimmed = part.trim_start();
        if !trimmed.starts_with('=') {
            continue;
        }
        let after_eq = trimmed[1..].trim_start();
        // 找引号
        let (quote, rest) = if after_eq.starts_with('"') {
            ('"', &after_eq[1..])
        } else if after_eq.starts_with('\'') {
            ('\'', &after_eq[1..])
        } else {
            continue;
        };
        // 找结束引号
        if let Some(end) = rest.find(quote) {
            let href = &rest[..end];
            if href.is_empty()
                || href.starts_with('#')
                || href.starts_with("javascript:")
                || href.starts_with("mailto:")
            {
                continue;
            }
            let absolute = resolve_url(href, base_url);
            if seen.insert(absolute.clone()) && links.len() < 50 {
                links.push(absolute);
            }
        }
    }
    links
}

/// 相对 URL 转绝对 URL
fn resolve_url(href: &str, base: &str) -> String {
    if href.starts_with("http://") || href.starts_with("https://") {
        return href.to_string();
    }
    // 提取 base 的 scheme://host
    if let Some(scheme_end) = base.find("://") {
        let after_scheme = &base[scheme_end + 3..];
        if let Some(path_start) = after_scheme.find('/') {
            let origin = &base[..scheme_end + 3 + path_start];
            if href.starts_with('/') {
                return format!("{}{}", origin, href);
            } else {
                // 相对路径
                let base_path = &after_scheme[path_start..];
                if let Some(last_slash) = base_path.rfind('/') {
                    return format!("{}/{}", &base[..scheme_end + 3 + path_start + last_slash], href);
                }
                return format!("{}/{}", origin, href);
            }
        } else {
            // base 无路径（如 https://example.com）
            if href.starts_with('/') {
                return format!("{}{}", base, href);
            } else {
                return format!("{}/{}", base, href);
            }
        }
    }
    href.to_string()
}

// ============ 逆向框架专属命令 ============

/// 加密识别报告
#[derive(Serialize)]
pub struct CryptoReport {
    pub data_len: usize,
    pub block_size: Option<usize>,
    /// 卡方值（>300 = p<0.05 非均匀分布 = 可能加密）
    pub chi_square: f64,
    /// 是否为均匀分布（true = 随机分布，可能加密；false = 非随机，可能编码）
    pub is_uniform: bool,
    pub entropy: f64,
    pub matched_algorithm: Option<String>,
    pub confidence: Option<f64>,
}

/// 加密算法识别（卡方检验 + 特征向量库匹配）
///
/// 输入 hex 字符串，返回卡方值 + 是否非标准加密 + 匹配的算法 + 置信度
#[tauri::command]
pub fn gongfang_crypto_identify(hex_data: String) -> Result<CryptoReport, String> {
    let hex_data = hex_data.trim();
    if hex_data.is_empty() {
        return Err("hex_data 不能为空".to_string());
    }
    // 解析 hex 字符串
    let bytes: Result<Vec<u8>, _> = (0..hex_data.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex_data[i..i + 2], 16))
        .collect();
    let bytes = bytes.map_err(|e| format!("hex 解析失败: {}", e))?;
    if bytes.is_empty() {
        return Err("解析后数据为空".to_string());
    }

    #[cfg(feature = "reverse")]
    {
        let chi = crate::reverse::crypto::chi_square_test(&bytes);
        let entropy = crate::reverse::crypto::shannon_entropy(&bytes);
        let lib = crate::reverse::crypto::FingerprintLibrary::new();
        let block_size = if bytes.len() % 16 == 0 {
            Some(16usize)
        } else if bytes.len() % 8 == 0 {
            Some(8usize)
        } else {
            None
        };
        let matched = lib.match_fingerprint(block_size, entropy, None);

        Ok(CryptoReport {
            data_len: bytes.len(),
            block_size,
            chi_square: chi.chi_square,
            is_uniform: chi.is_non_uniform,
            entropy,
            matched_algorithm: matched.as_ref().map(|(n, _)| n.clone()),
            confidence: matched.as_ref().map(|(_, c)| *c),
        })
    }
    #[cfg(not(feature = "reverse"))]
    {
        let _ = bytes;
        Err("reverse feature 未启用，请用 --features gongfang-reverse 编译".to_string())
    }
}

/// 符号摘要（前端展示用）
#[derive(Serialize)]
pub struct SymbolSummary {
    pub url: String,
    pub name: String,
    pub address: u64,
    pub kind: String,
    pub meta: std::collections::HashMap<String, String>,
}

/// 查询符号库（已学习的逆向资产）
#[tauri::command]
pub fn gongfang_symbols(url: Option<String>) -> Result<Vec<SymbolSummary>, String> {
    #[cfg(feature = "reverse")]
    {
        let store = crate::reverse::symbols::SymbolStore::load();
        let mut result = Vec::new();
        if let Some(u) = url {
            if let Some(symbols) = store.symbols(&u) {
                for s in symbols {
                    result.push(SymbolSummary {
                        url: u.clone(),
                        name: s.name.clone(),
                        address: s.address,
                        kind: format!("{:?}", s.kind),
                        meta: s.meta.clone(),
                    });
                }
            }
        }
        Ok(result)
    }
    #[cfg(not(feature = "reverse"))]
    {
        let _ = url;
        Err("reverse feature 未启用，请用 --features gongfang-reverse 编译".to_string())
    }
}

// ============ 自动化框架专属命令 ============

/// 适应度报告条目
#[derive(Serialize)]
pub struct FitnessReport {
    pub id: u32,
    pub name: String,
    pub success: u32,
    pub failure: u32,
    pub success_rate: f32,
    pub avg_divergence: f32,
}

/// 设置行为拟人化等级（@humanize 命令）
///
/// level:
/// - 0：机械精度模式（关闭噪声，最大速度，用于压力测试）
/// - 1-3：低拟人化（小噪声，快速）
/// - 4-7：中拟人化（默认）
/// - 8-10：高拟人化（大噪声，慢速，模拟醉酒/疲劳）
#[tauri::command]
pub fn gongfang_humanize(level: u32) -> Result<String, String> {
    if level > 10 {
        return Err("level 必须在 0-10 之间".to_string());
    }
    #[cfg(feature = "automation")]
    {
        crate::automation::profiles::set_humanize_level(level);
        let t = crate::automation::profiles::current_template();
        Ok(t.name.to_string())
    }
    #[cfg(not(feature = "automation"))]
    {
        let _ = level;
        Err("automation feature 未启用，请用 --features gongfang-automation 编译".to_string())
    }
}

/// 查询模板适应度报告
#[tauri::command]
pub fn gongfang_fitness() -> Result<Vec<FitnessReport>, String> {
    #[cfg(feature = "automation")]
    {
        let report = crate::automation::profiles::fitness_report();
        Ok(report
            .into_iter()
            .map(|(id, name, success, failure, rate, avg_div)| FitnessReport {
                id,
                name: name.to_string(),
                success,
                failure,
                success_rate: rate,
                avg_divergence: avg_div,
            })
            .collect())
    }
    #[cfg(not(feature = "automation"))]
    {
        Err("automation feature 未启用，请用 --features gongfang-automation 编译".to_string())
    }
}

/// 手动触发热迁移（切换到适应度最高的模板）
#[tauri::command]
pub fn gongfang_fitness_migrate() -> Result<String, String> {
    #[cfg(feature = "automation")]
    {
        crate::automation::profiles::switch_to_best_template();
        let t = crate::automation::profiles::current_template();
        Ok(format!("已迁移到: {}", t.name))
    }
    #[cfg(not(feature = "automation"))]
    {
        Err("automation feature 未启用".to_string())
    }
}

/// 重置适应度统计
#[tauri::command]
pub fn gongfang_fitness_reset() -> Result<(), String> {
    #[cfg(feature = "automation")]
    {
        crate::automation::profiles::reset_fitness();
        Ok(())
    }
    #[cfg(not(feature = "automation"))]
    {
        Err("automation feature 未启用".to_string())
    }
}

// ============ 网关框架专属命令 ============

/// 网关节点摘要（命令层类型，始终编译）
#[derive(Serialize)]
pub struct GatewayNodeSummary {
    pub url: String,
    pub region: String,
    pub reputation: f64,
    pub error_rate: f64,
    pub ewma_rtt: f64,
    pub rtt_gradient: f64,
    pub is_failing: bool,
}

/// 网关状态（命令层类型，始终编译）
#[derive(Serialize)]
pub struct GatewayStatusResult {
    pub policy_version: u64,
    pub routing: String,
    pub routing_cn: String,
    pub bandwidth_ratio: f64,
    pub request_timeout_ms: u64,
    pub max_concurrent: usize,
    pub effective_ts: i64,
    pub node_count: usize,
    pub redundancy_ratio: f64,
    pub current_entropy: f64,
    pub active_node: Option<GatewayNodeSummary>,
}

/// 查询网关状态（@gateway_status / 前端面板）
#[tauri::command]
pub fn gongfang_gateway_status() -> Result<GatewayStatusResult, String> {
    #[cfg(feature = "gateway")]
    {
        let s = crate::gateway::status();
        Ok(GatewayStatusResult {
            policy_version: s.policy_version,
            routing: s.routing.as_str().to_string(),
            routing_cn: s.routing.as_cn().to_string(),
            bandwidth_ratio: s.bandwidth_ratio,
            request_timeout_ms: s.request_timeout_ms,
            max_concurrent: s.max_concurrent,
            effective_ts: s.effective_ts,
            node_count: s.node_count,
            redundancy_ratio: s.redundancy_ratio,
            current_entropy: s.current_entropy,
            active_node: s.active_node.as_ref().map(|n| GatewayNodeSummary {
                url: n.url.clone(),
                region: n.region.clone(),
                reputation: n.reputation,
                error_rate: n.error_rate,
                ewma_rtt: n.ewma_rtt,
                rtt_gradient: n.rtt_gradient,
                is_failing: n.is_failing,
            }),
        })
    }
    #[cfg(not(feature = "gateway"))]
    {
        Err("gateway feature 未启用，请用 --features gongfang-gateway 编译".to_string())
    }
}

/// 切换路由模式（@rotate 指令）
///
/// mode: "direct" / "proxy" / "stealth"
#[tauri::command]
pub fn gongfang_gateway_rotate(mode: String) -> Result<String, String> {
    #[cfg(feature = "gateway")]
    {
        let m = crate::gateway::RoutingMode::from_str(&mode)
            .ok_or_else(|| format!("未知路由模式: {}（可选: direct/proxy/stealth）", mode))?;
        crate::gateway::shaper().rotate(m);
        Ok(format!("已切换到 {} 模式", m.as_cn()))
    }
    #[cfg(not(feature = "gateway"))]
    {
        let _ = mode;
        Err("gateway feature 未启用".to_string())
    }
}

/// 调整带宽（@throttle 指令）
///
/// ratio: 0.05 - 1.0（1.0 = 全速，0.5 = 限速 50%）
#[tauri::command]
pub fn gongfang_gateway_throttle(ratio: f64) -> Result<String, String> {
    if !(0.05..=1.0).contains(&ratio) {
        return Err("ratio 必须在 [0.05, 1.0] 范围内".to_string());
    }
    #[cfg(feature = "gateway")]
    {
        crate::gateway::shaper().throttle(ratio);
        Ok(format!("带宽调整到 {:.0}%", ratio * 100.0))
    }
    #[cfg(not(feature = "gateway"))]
    {
        let _ = ratio;
        Err("gateway feature 未启用".to_string())
    }
}

/// 查询代理节点池（@gateway_pool / 前端面板）
#[tauri::command]
pub fn gongfang_gateway_pool() -> Result<Vec<GatewayNodeSummary>, String> {
    #[cfg(feature = "gateway")]
    {
        let nodes = crate::gateway::shaper().list_nodes();
        Ok(nodes
            .into_iter()
            .map(|n| GatewayNodeSummary {
                url: n.url,
                region: n.region,
                reputation: n.reputation,
                error_rate: n.error_rate,
                ewma_rtt: n.ewma_rtt,
                rtt_gradient: n.rtt_gradient,
                is_failing: n.is_failing,
            })
            .collect())
    }
    #[cfg(not(feature = "gateway"))]
    {
        Err("gateway feature 未启用".to_string())
    }
}

// ============ P0 通用信息层命令 ============

/// 拉取最近 N 条内核事件（前端 EventStream 初始化时调用，之后靠订阅 gongfang_event 实时推送）
#[tauri::command]
pub fn gongfang_events_recent(n: Option<usize>) -> Result<Vec<crate::kernel::events::KernelEvent>, String> {
    let n = n.unwrap_or(100).min(500);
    match crate::kernel::events::global() {
        Some(bus) => Ok(bus.recent_events(n)),
        None => Ok(Vec::new()),
    }
}

/// 拉取最近 N 秒的时序指标（前端 MetricsChart 渲染 4 曲线）
#[tauri::command]
pub fn gongfang_metrics_history(seconds: Option<u32>) -> Result<Vec<crate::kernel::events::MetricSample>, String> {
    let seconds = seconds.unwrap_or(300).min(3600);
    match crate::kernel::events::global() {
        Some(bus) => Ok(bus.recent_metrics(seconds)),
        None => Ok(Vec::new()),
    }
}

/// 拉取最近 N 条 AI 推理日志（前端 AiReasoningPanel 展示推理过程）
#[tauri::command]
pub fn gongfang_ai_reasoning_recent(n: Option<usize>) -> Result<Vec<crate::kernel::events::ReasoningEntry>, String> {
    let n = n.unwrap_or(20).min(50);
    match crate::kernel::events::global() {
        Some(bus) => Ok(bus.recent_reasoning(n)),
        None => Ok(Vec::new()),
    }
}

/// 设置是否推送 Tick 事件到前端（默认不推送，避免 50ms 一次的洪水；前端按需开启）
#[tauri::command]
pub fn gongfang_set_emit_tick(enabled: bool) -> Result<(), String> {
    match crate::kernel::events::global() {
        Some(bus) => {
            bus.set_emit_tick(enabled);
            Ok(())
        }
        None => Err("攻防内核未启动".to_string()),
    }
}

// ============ 目标工作区命令族 ============

use crate::kernel::workspace::{Target, TargetKind};

/// 目标摘要（前端展示用）
#[derive(Serialize)]
pub struct TargetSummary {
    pub id: String,
    pub name: String,
    pub address: String,
    pub kind: String,
    pub created_at: i64,
    pub last_active_at: i64,
    pub note: String,
    pub tags: Vec<String>,
    pub is_active: bool,
}

/// 保存目标请求
#[derive(Deserialize)]
pub struct SaveTargetRequest {
    pub name: String,
    pub address: String,
    pub kind: Option<String>,
    pub note: Option<String>,
    pub tags: Option<Vec<String>>,
}

/// 列出所有目标（按 last_active_at 倒序）
#[tauri::command]
pub fn gongfang_target_list(app: AppHandle) -> Result<Vec<TargetSummary>, String> {
    let ws = crate::kernel::workspace::load(&app);
    let active_id = ws.active_id.clone();
    let summary: Vec<TargetSummary> = ws
        .list_sorted()
        .into_iter()
        .map(|t| TargetSummary {
            id: t.id.clone(),
            name: t.name.clone(),
            address: t.address.clone(),
            kind: t.kind.as_str().to_string(),
            created_at: t.created_at,
            last_active_at: t.last_active_at,
            note: t.note.clone(),
            tags: t.tags.clone(),
            is_active: Some(t.id.clone()) == active_id,
        })
        .collect();
    Ok(summary)
}

/// 保存（新建或更新）目标
#[tauri::command]
pub fn gongfang_target_save(app: AppHandle, req: SaveTargetRequest) -> Result<TargetSummary, String> {
    if req.name.trim().is_empty() {
        return Err("name 不能为空".to_string());
    }
    if req.address.trim().is_empty() {
        return Err("address 不能为空".to_string());
    }
    let mut ws = crate::kernel::workspace::load(&app);
    let kind = req
        .kind
        .as_deref()
        .and_then(TargetKind::from_str)
        .unwrap_or_default();
    let name_clone = req.name.clone();
    let address_clone = req.address.clone();
    let mut target = Target::new(req.name, req.address, kind);
    let target_id = target.id.clone();
    let target_created_at = target.created_at;
    let target_kind = target.kind.as_str().to_string();
    // 应用可选字段
    if let Some(note) = req.note {
        target.note = note;
    }
    if let Some(tags) = req.tags {
        target.tags = tags;
    }
    ws.add(target);
    crate::kernel::workspace::save(&app, &ws)?;
    Ok(TargetSummary {
        id: target_id,
        name: name_clone,
        address: address_clone,
        kind: target_kind,
        created_at: target_created_at,
        last_active_at: target_created_at,
        note: String::new(),
        tags: Vec::new(),
        is_active: true,
    })
}

/// 删除目标
#[tauri::command]
pub fn gongfang_target_delete(app: AppHandle, id: String) -> Result<(), String> {
    let mut ws = crate::kernel::workspace::load(&app);
    if !ws.remove(&id) {
        return Err("目标不存在".to_string());
    }
    crate::kernel::workspace::save(&app, &ws)
}

/// 激活目标
#[tauri::command]
pub fn gongfang_target_activate(app: AppHandle, id: String) -> Result<(), String> {
    let mut ws = crate::kernel::workspace::load(&app);
    if !ws.activate(&id) {
        return Err("目标不存在".to_string());
    }
    crate::kernel::workspace::save(&app, &ws)
}

/// 获取目标详情（含 metadata）
#[tauri::command]
pub fn gongfang_target_get(app: AppHandle, id: String) -> Result<serde_json::Value, String> {
    let ws = crate::kernel::workspace::load(&app);
    let t = ws.get(&id).ok_or("目标不存在".to_string())?;
    serde_json::to_value(t).map_err(|e| format!("序列化失败: {}", e))
}

/// 设置目标元数据字段（各框架可挂载自己的状态：扫描结果/符号表/策略等）
#[tauri::command]
pub fn gongfang_target_set_metadata(
    app: AppHandle,
    id: String,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let mut ws = crate::kernel::workspace::load(&app);
    if !ws.set_metadata(&id, &key, value) {
        return Err("目标不存在".to_string());
    }
    crate::kernel::workspace::save(&app, &ws)
}
