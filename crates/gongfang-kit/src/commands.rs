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
use tauri::{AppHandle, Manager};

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
    /// 真实 TLS/JA3-JA4 指纹伪装通道是否可用。
    ///
    /// 判据：`tls-impersonate` feature 已编译 **且** curl-impersonate 二进制可定位。
    /// 为 false 时前端把「TLS 指纹」显示为「UA 档案」（只换 UA 不改 ClientHello），
    /// 避免把「只换 UA」宣传成 TLS 指纹伪装。
    pub tls_impersonate: bool,
}

/// 真实 TLS/JA3-JA4 指纹通道是否**当前可用**。
///
/// 判据 = feature 已编译 **且** curl-impersonate 二进制可定位：
/// 只报 feature 会出现「编译里有、运行时却没有 → 抓取仍裸露 rustls 指纹」
/// 的不实状态，而前端正是据此把「TLS 指纹」如实降级显示为「UA 档案」。
#[cfg(feature = "tls-impersonate")]
fn tls_impersonate_available() -> bool {
    crate::crawler::impersonate::is_available()
}

#[cfg(not(feature = "tls-impersonate"))]
fn tls_impersonate_available() -> bool {
    false
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
        tls_impersonate: tls_impersonate_available(),
    }
}

/// 当前策略使用的 TLS 档案（内核未启动时用默认档案）。
///
/// 侦察类命令（WAF/技术栈探测、手动 fetch）据此与爬虫保持**同一档案**：
/// 内核运行时跟随策略轮转，未运行时退回 Chrome 默认，避免各处硬编码不同档案。
fn current_tls_profile() -> String {
    let state = STATE.lock();
    state
        .as_ref()
        .map(|s| s.engine.snapshot().tls_profile)
        .unwrap_or_else(|| crate::http_channel::DEFAULT_TLS_PROFILE.to_string())
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
    // 符号库持久化：内核启动时挂到 <app_data>/gongfang/symbols.json（跨会话复用）
    #[cfg(feature = "reverse")]
    if let Ok(dir) = app.path().app_data_dir() {
        crate::reverse::symbols::set_storage_path(dir.join("gongfang"));
    }
    // AI 知识库持久化：<app_data>/gongfang/knowledge.json（同目录，栈叠加层落盘）
    if let Ok(dir) = app.path().app_data_dir() {
        crate::kernel::knowledge::set_storage_path(dir.join("gongfang"));
    }
    let profile = resolve_profile(&profiles, profile_id);
    if profile.api_key.trim().is_empty() {
        log::warn!(
            "[gongfang] 未配置 AI API Key：L1/L2 大模型推理不可用，内核将以启发式 L0 兜底启动"
        );
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
    let url = crate::normalize_url(&url);
    if url.trim().is_empty() {
        return Err("url 不能为空".to_string());
    }
    #[cfg(feature = "pentest")]
    {
        let resp = crate::pentest::probe::probe_target(&url, &current_tls_profile()).await;
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

/// 技术栈指纹识别（服务器/语言/框架/CMS/CDN + 安全响应头审计）
#[tauri::command]
pub async fn gongfang_tech_fingerprint(url: String) -> Result<TechFpOut, String> {
    let url = crate::normalize_url(&url);
    if url.trim().is_empty() {
        return Err("url 不能为空".to_string());
    }
    #[cfg(feature = "pentest")]
    {
        let resp = crate::pentest::probe::probe_target(&url, &current_tls_profile()).await;
        let headers: Vec<(String, String)> = resp.headers.into_iter().collect();
        Ok(crate::pentest::fingerprint::fingerprint(&headers, &resp.body))
    }
    #[cfg(not(feature = "pentest"))]
    {
        let _ = url;
        Err("pentest feature 未启用，请用 --features gongfang-pentest 编译".to_string())
    }
}

/// HTTP 方法枚举（OPTIONS→Allow 头解析；无 Allow 则常见方法探测）+ 风险标记
#[tauri::command]
pub async fn gongfang_http_methods(url: String) -> Result<MethodReportOut, String> {
    let url = crate::normalize_url(&url);
    if url.trim().is_empty() {
        return Err("url 不能为空".to_string());
    }
    #[cfg(feature = "pentest")]
    {
        use crate::pentest::recon::{discover_from_allow, method_allowed, COMMON_METHODS, MethodReport};
        let client = reqwest::Client::new();
        let mut report = MethodReport::default();
        if let Ok(r) = client.request(reqwest::Method::OPTIONS, &url).send().await {
            let allow = r
                .headers()
                .get("allow")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            report = discover_from_allow(allow.as_deref());
        }
        if report.allowed.is_empty() {
            let base = url.trim_end_matches('/').to_string();
            for m in COMMON_METHODS {
                let Ok(method) = reqwest::Method::from_bytes(m.as_bytes()) else { continue };
                if let Ok(resp) = client.request(method, &base).send().await {
                    if method_allowed(resp.status().as_u16())
                        && !report.allowed.iter().any(|x| x == m)
                    {
                        report.allowed.push(m.to_string());
                    }
                }
            }
        }
        report.risky = report
            .allowed
            .iter()
            .filter(|m| matches!(m.as_str(), "PUT" | "DELETE" | "TRACE" | "CONNECT"))
            .cloned()
            .collect();
        Ok(report)
    }
    #[cfg(not(feature = "pentest"))]
    {
        let _ = url;
        Err("pentest feature 未启用，请用 --features gongfang-pentest 编译".to_string())
    }
}

/// 常见敏感路径探测
#[tauri::command]
pub async fn gongfang_path_probe(url: String) -> Result<PathProbeOut, String> {
    let url = crate::normalize_url(&url);
    if url.trim().is_empty() {
        return Err("url 不能为空".to_string());
    }
    #[cfg(feature = "pentest")]
    {
        use crate::pentest::recon::{classify_path_status, COMMON_PATHS, PathResult};
        let base = url.trim().trim_end_matches('/');
        let client = reqwest::Client::new();
        let mut out = Vec::new();
        for p in COMMON_PATHS.iter().take(30) {
            let full = format!("{}/{}", base, p);
            let status = match client
                .get(&full)
                .timeout(std::time::Duration::from_secs(8))
                .send()
                .await
            {
                Ok(r) => r.status().as_u16(),
                Err(_) => 0,
            };
            if status == 404 {
                continue; // 过滤不存在，减少噪音
            }
            out.push(PathResult {
                path: (*p).to_string(),
                status,
                note: classify_path_status(status).to_string(),
            });
        }
        Ok(out)
    }
    #[cfg(not(feature = "pentest"))]
    {
        let _ = url;
        Err("pentest feature 未启用，请用 --features gongfang-pentest 编译".to_string())
    }
}

/// RFC 8615 `/.well-known/` 端点发现（security.txt / openid-config / jwks 等）
#[tauri::command]
pub async fn gongfang_wellknown_probe(url: String) -> Result<PathProbeOut, String> {
    let url = crate::normalize_url(&url);
    if url.trim().is_empty() {
        return Err("url 不能为空".to_string());
    }
    #[cfg(feature = "pentest")]
    {
        use crate::pentest::recon::{classify_path_status, WELL_KNOWN_PATHS, PathResult};
        let base = url.trim().trim_end_matches('/');
        let client = reqwest::Client::new();
        let mut out = Vec::new();
        for p in WELL_KNOWN_PATHS {
            let full = format!("{}/{}", base, p);
            let status = match client
                .get(&full)
                .timeout(std::time::Duration::from_secs(8))
                .send()
                .await
            {
                Ok(r) => r.status().as_u16(),
                Err(_) => 0,
            };
            if status == 404 || status == 0 {
                continue;
            }
            out.push(PathResult {
                path: (*p).to_string(),
                status,
                note: classify_path_status(status).to_string(),
            });
        }
        Ok(out)
    }
    #[cfg(not(feature = "pentest"))]
    {
        let _ = url;
        Err("pentest feature 未启用，请用 --features gongfang-pentest 编译".to_string())
    }
}

/// 错误页指纹：请求一个低碰撞路径触发 404/500，从错误页特征识别服务器/框架
#[tauri::command]
pub async fn gongfang_error_page(url: String) -> Result<ErrorPageOut, String> {
    let url = crate::normalize_url(&url);
    if url.trim().is_empty() {
        return Err("url 不能为空".to_string());
    }
    #[cfg(feature = "pentest")]
    {
        use crate::pentest::recon::{fingerprint_error_page, ErrorPageReport};
        let base = url.trim().trim_end_matches('/');
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let probe_path = format!("{}/__gf_err_{}", base, nonce);
        let client = reqwest::Client::new();
        let (status, body) = match client.get(&probe_path).send().await {
            Ok(r) => {
                let s = r.status().as_u16();
                let b = r.text().await.unwrap_or_default();
                (s, b)
            }
            Err(_) => (0, String::new()),
        };
        let fingerprints = fingerprint_error_page(&body);
        Ok(ErrorPageReport {
            probe_path,
            status,
            fingerprints,
        })
    }
    #[cfg(not(feature = "pentest"))]
    {
        let _ = url;
        Err("pentest feature 未启用，请用 --features gongfang-pentest 编译".to_string())
    }
}

// ============ WAF 编码变异模拟 ============

/// WAF 编码变异模拟：对载荷施加多种编码，评估对常见规则的绕过效果
#[tauri::command]
pub fn gongfang_simulate_waf(payload: String) -> Result<SimOut, String> {
    let payload = payload.trim();
    if payload.is_empty() {
        return Err("payload 不能为空".to_string());
    }
    #[cfg(feature = "pentest")]
    {
        Ok(crate::pentest::sim::simulate(payload))
    }
    #[cfg(not(feature = "pentest"))]
    {
        let _ = payload;
        Err("pentest feature 未启用，请用 --features gongfang-pentest 编译".to_string())
    }
}

// ============ 载荷库 & HPP ============

/// 载荷库：按分类返回载荷列表（ssti/sqli/xss/cmd/path/error/time）
#[tauri::command]
pub fn gongfang_payloads(category: String) -> Result<Vec<String>, String> {
    let category = category.trim();
    if category.is_empty() {
        return Err("category 不能为空（ssti/sqli/xss/cmd/path/error/time）".to_string());
    }
    #[cfg(feature = "pentest")]
    {
        Ok(crate::pentest::payload::payloads(category))
    }
    #[cfg(not(feature = "pentest"))]
    {
        let _ = category;
        Err("pentest feature 未启用，请用 --features gongfang-pentest 编译".to_string())
    }
}

/// HPP 探针响应推断：根据响应体归纳后端参数聚合策略 + 给出 HPP 载荷
#[tauri::command]
pub fn gongfang_hpp_analyze(response: String) -> Result<serde_json::Value, String> {
    if response.trim().is_empty() {
        return Err("response 不能为空".to_string());
    }
    #[cfg(feature = "pentest")]
    {
        use crate::pentest::encoder::{hpp_infer_aggregate, HppAggregate, hpp_payload};
        let agg = hpp_infer_aggregate(&response);
        let description = match agg {
            HppAggregate::First => "取首个参数（PHP / Tomcat）",
            HppAggregate::Last => "取末个参数（ASP.NET）",
            HppAggregate::All => "全部拼接（ASP）",
            HppAggregate::Dedup => "去重保留首个（Spring）",
            HppAggregate::Unknown => "未能推断（请确认探针响应含 id=1 / id=3 / 1,2,3）",
        };
        let payload = hpp_payload("id", &["union", "select", "1,2,3"], agg);
        Ok(serde_json::json!({
            "probe": "id=1&id=2&id=3&id=1",
            "aggregate": agg.as_str(),
            "description": description,
            "payload": payload,
        }))
    }
    #[cfg(not(feature = "pentest"))]
    {
        let _ = response;
        Err("pentest feature 未启用，请用 --features gongfang-pentest 编译".to_string())
    }
}

/// 数据库识别 + payload 联动：输入错误消息或数据库名 → 识别库 → 推荐时间盲注/报错注入载荷
#[tauri::command]
pub fn gongfang_db_payloads(input: String) -> Result<serde_json::Value, String> {
    if input.trim().is_empty() {
        return Err("input 不能为空（数据库名或错误消息）".to_string());
    }
    #[cfg(feature = "pentest")]
    {
        use crate::pentest::payload::{db_from_input, payloads_for_db, Database};
        let db = db_from_input(&input);
        let payloads = payloads_for_db(db);
        Ok(serde_json::json!({
            "input": input.trim(),
            "database": db.as_str(),
            "confidence": if matches!(db, Database::Unknown) { "low（未能识别）" } else { "high（识别到）" },
            "payloads": payloads,
        }))
    }
    #[cfg(not(feature = "pentest"))]
    {
        let _ = input;
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
/// 这是"对话即攻防"的核心：用户输入 URL，AI 调用 fetch，返回真实数据。
/// 走统一通道：`tls-impersonate` 可用时呈现真实浏览器 TLS 指纹，否则退 rustls + UA。
#[tauri::command]
pub async fn gongfang_fetch(url: String) -> Result<FetchResult, String> {
    let url = crate::normalize_url(&url);
    if url.trim().is_empty() {
        return Err("url 不能为空".to_string());
    }
    #[cfg(feature = "crawler")]
    {
        let start = std::time::Instant::now();
        let fail = |err: String| FetchResult {
            url: url.clone(),
            status: 0,
            content_type: String::new(),
            content_length: 0,
            title: None,
            body_preview: String::new(),
            links: vec![],
            duration_ms: start.elapsed().as_millis() as u64,
            error: Some(err),
        };

        match crate::http_channel::get(
            &url,
            crate::http_channel::DEFAULT_TIMEOUT_MS,
            &current_tls_profile(),
        )
        .await
        {
            Ok(r) => {
                log::info!("[fetch] {} channel={} status={}", url, r.channel, r.status);
                // 先取派生结果再消费 url，避免字段初始化顺序造成的借用冲突
                let content_type = r.header("content-type").unwrap_or("").to_string();
                let content_length = r.body.len();
                let title = extract_title(&r.body); // <title>
                let links = extract_links(&r.body, &url); // <a href="...">（最多 50 个）
                let body_preview: String = r.body.chars().take(2000).collect();
                Ok(FetchResult {
                    url,
                    status: r.status,
                    content_type,
                    content_length,
                    title,
                    links,
                    body_preview,
                    duration_ms: start.elapsed().as_millis() as u64,
                    error: None,
                })
            }
            Err(e) => Ok(fail(e)),
        }
    }
    #[cfg(not(feature = "crawler"))]
    {
        let _ = url;
        Err("crawler feature 未启用，请用 --features gongfang-crawler 编译".to_string())
    }
}

// ============ 爬虫队列统计 ============

/// 爬虫队列统计快照（前端 URL 队列控制台展示）
#[derive(Serialize)]
pub struct CrawlerStats {
    pub pending: usize,
    pub visited: usize,
    pub total: usize,
    pub seed: Option<String>,
}

/// 查询爬虫 URL 队列统计
#[tauri::command]
pub fn gongfang_crawler_stats() -> Result<CrawlerStats, String> {
    #[cfg(feature = "crawler")]
    {
        let q = crate::crawler::queue::queue();
        let s = q.stats();
        Ok(CrawlerStats {
            pending: s.pending,
            visited: s.visited,
            total: s.total,
            seed: crate::crawler::current_seed(),
        })
    }
    #[cfg(not(feature = "crawler"))]
    {
        Err("crawler feature 未启用，请用 --features gongfang-crawler 编译".to_string())
    }
}

// ============ 爬虫代理池管理 ============

/// 爬虫代理池单条（前端展示）
#[derive(Serialize)]
pub struct CrawlerProxyEntry {
    pub url: String,
    pub tag: String,
    pub alive: bool,
}

/// 添加代理（socks5://host:port 或 http://host:port）
#[tauri::command]
pub fn gongfang_proxy_add(url: String, tag: Option<String>) -> Result<(), String> {
    if url.trim().is_empty() {
        return Err("url 不能为空".to_string());
    }
    #[cfg(feature = "crawler")]
    {
        crate::crawler::pool::pool().add(crate::crawler::pool::ProxyEntry {
            url: url.trim().to_string(),
            tag: tag.unwrap_or_else(|| "default".to_string()),
            alive: true,
        });
        Ok(())
    }
    #[cfg(not(feature = "crawler"))]
    {
        let _ = (url, tag);
        Err("crawler feature 未启用，请用 --features gongfang-crawler 编译".to_string())
    }
}

/// 列出候选代理（含死亡标记）
#[tauri::command]
pub fn gongfang_proxy_list() -> Result<Vec<CrawlerProxyEntry>, String> {
    #[cfg(feature = "crawler")]
    {
        Ok(crate::crawler::pool::pool()
            .list()
            .into_iter()
            .map(|p| CrawlerProxyEntry { url: p.url, tag: p.tag, alive: p.alive })
            .collect())
    }
    #[cfg(not(feature = "crawler"))]
    {
        Err("crawler feature 未启用，请用 --features gongfang-crawler 编译".to_string())
    }
}

/// 重置代理池（全部恢复存活）
#[tauri::command]
pub fn gongfang_proxy_reset() -> Result<(), String> {
    #[cfg(feature = "crawler")]
    {
        crate::crawler::pool::pool().reset();
        Ok(())
    }
    #[cfg(not(feature = "crawler"))]
    {
        Err("crawler feature 未启用，请用 --features gongfang-crawler 编译".to_string())
    }
}

/// 从 HTML 提取 <title>
#[allow(dead_code)]
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
#[allow(dead_code)]
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
#[allow(dead_code)]
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

/// 编码/哈希/明文分类识别
///
/// 输入任意字符串，自动识别 hex/base64/base32/url/明文/哈希，并尝试解码。
///
/// 返回类型用 cfg 门控别名：reverse feature 启用时为 `reverse::detect::EncodeAnalysis`；
/// 默认构建（不启用 feature）时退化为 `serde_json::Value` 占位并返回明确错误。
/// 修复：签名层引用 feature-gated 类型（crate::reverse::detect）此前导致默认构建 E0433
/// （cannot find `reverse` in `crate`），因为在函数体内 `#[cfg]` 分支无法保护签名类型解析。
#[cfg(feature = "reverse")]
type EncodeAnalysisOut = crate::reverse::detect::EncodeAnalysis;
#[cfg(not(feature = "reverse"))]
type EncodeAnalysisOut = serde_json::Value;

#[cfg(feature = "reverse")]
type EncodeChainOut = crate::reverse::detect::EncodeAnalysis;
#[cfg(not(feature = "reverse"))]
type EncodeChainOut = serde_json::Value;

#[cfg(feature = "reverse")]
type DfaGraphOut = crate::reverse::protocol::DfaGraph;
#[cfg(not(feature = "reverse"))]
type DfaGraphOut = serde_json::Value;

#[cfg(feature = "reverse")]
type BinaryAnalysisOut = crate::reverse::disasm::BinaryAnalysis;
#[cfg(not(feature = "reverse"))]
type BinaryAnalysisOut = serde_json::Value;

/// 二进制静态分析（**内置轨**：object 解析 PE/ELF/Mach-O + iced-x86 反汇编）
///
/// 产出：段表 / 符号与导入导出 / 基本块与 CFG / 常量池（字符串）/ 控制流反混淆结果。
/// 纯 Rust、MIT、进程内、无外部依赖（实测 4.2MB PE：79.7 万指令 / 22.3 万基本块 / 约 1.7s）。
///
/// 边界（如实说明）：
/// - 只覆盖 x86/x64；ARM 等架构仅输出段/符号/常量池，并给出明确 warning
/// - 线性扫描 + 领导者切块，不做「函数边界精确重建」的承诺；函数名在 strip 过的
///   二进制上是 `sub_<addr>`（调用目标推断）
/// - 深度轨（Ghidra headless：P-Code IR / 跨指令集）见 `static_analysis.rs`，尚未接入
/// - 只读单个本地文件，不做目录遍历；超大文件直接拒绝，避免吃满内存
///
/// `include_graph`：是否回传基本块/边明细（默认 **false**）。真实二进制基本块达 20 万级，
/// 默认只回计数以免 IPC 载荷拖垮前端；需要图数据（如后续做可视化）时显式传 true。
#[tauri::command]
pub async fn gongfang_binary_analyze(
    path: String,
    include_graph: Option<bool>,
) -> Result<BinaryAnalysisOut, String> {
    #[cfg(feature = "reverse")]
    {
        let p = path.trim();
        if p.is_empty() {
            return Err("path 不能为空".to_string());
        }
        let pb = std::path::PathBuf::from(p);
        let meta = tokio::fs::metadata(&pb)
            .await
            .map_err(|e| format!("读取文件信息失败（{}）: {}", p, e))?;
        if !meta.is_file() {
            return Err("目标不是普通文件".to_string());
        }
        const MAX_BYTES: u64 = 200 * 1024 * 1024;
        if meta.len() > MAX_BYTES {
            return Err(format!(
                "文件过大（{} MB）：内置轨上限 {} MB，请先裁剪或用 Ghidra 深度轨",
                meta.len() / 1024 / 1024,
                MAX_BYTES / 1024 / 1024
            ));
        }
        let with_graph = include_graph.unwrap_or(false);
        // 解析 + 反汇编是 CPU/IO 阻塞操作：必须 spawn_blocking，不能占住 tokio worker
        tokio::task::spawn_blocking(move || crate::reverse::disasm::analyze_file(&pb, with_graph))
            .await
            .map_err(|e| format!("分析任务异常: {}", e))?
    }
    #[cfg(not(feature = "reverse"))]
    {
        let _ = (path, include_graph);
        Err("reverse feature 未启用，请用 --features gongfang-reverse 编译".to_string())
    }
}

#[cfg(feature = "pentest")]
type TechFpOut = crate::pentest::fingerprint::TechFingerprint;
#[cfg(not(feature = "pentest"))]
type TechFpOut = serde_json::Value;

#[cfg(feature = "pentest")]
type OpenApiReportOut = crate::pentest::openapi::OpenApiReport;
#[cfg(not(feature = "pentest"))]
type OpenApiReportOut = serde_json::Value;

#[cfg(feature = "pentest")]
type MutationSelectionOut = crate::pentest::mutation::MutationSelection;
#[cfg(not(feature = "pentest"))]
type MutationSelectionOut = serde_json::Value;

/// 自适应变异选臂（多臂老虎机 UCB1）：替代原计划里的 PPO 强化学习
///
/// `ctx` = 学习隔离键（建议用 WAF 规则名或目标主机），`input` = 待变异载荷。
/// 返回：选中的编码家族 + **该家族变异后的载荷**（可直接用于探测）+ 当前各臂统计。
/// 机制说明与边界（不自行发起任何探测）见 `pentest::mutation` 模块文档。
#[tauri::command]
pub fn gongfang_mutation_select(ctx: String, input: String) -> Result<MutationSelectionOut, String> {
    #[cfg(feature = "pentest")]
    {
        if ctx.trim().is_empty() {
            return Err("ctx 不能为空（建议用 WAF 规则名或目标主机）".to_string());
        }
        if input.trim().is_empty() {
            return Err("input 不能为空".to_string());
        }
        Ok(crate::pentest::mutation::select(ctx.trim(), &input))
    }
    #[cfg(not(feature = "pentest"))]
    {
        let _ = (ctx, input);
        Err("pentest feature 未启用，请用 --features gongfang-pentest 编译".to_string())
    }
}

/// 回填一次真实结果（探测后：该臂是否真的绕过），驱动后续选臂
///
/// 二选一给奖励：`reward`（0.0..1.0 分级，优先）或 `success`（布尔，等价 1.0/0.0）。
/// 分级奖励能区分「多绕过 1 条」与「多绕过 4 条」，学习效果明显更好。
#[tauri::command]
pub fn gongfang_mutation_reward(
    ctx: String,
    arm: usize,
    success: Option<bool>,
    reward: Option<f64>,
) -> Result<serde_json::Value, String> {
    #[cfg(feature = "pentest")]
    {
        let value = match (reward, success) {
            (Some(r), _) => r,
            (None, Some(s)) => {
                if s {
                    1.0
                } else {
                    0.0
                }
            }
            (None, None) => return Err("需提供 reward（0.0..1.0）或 success（bool）".to_string()),
        };
        let arms = crate::pentest::mutation::record_value(ctx.trim(), arm, value)?;
        Ok(serde_json::json!({ "ctx": ctx.trim(), "arm": arm, "reward": value.clamp(0.0, 1.0), "arms": arms }))
    }
    #[cfg(not(feature = "pentest"))]
    {
        let _ = (ctx, arm, success, reward);
        Err("pentest feature 未启用，请用 --features gongfang-pentest 编译".to_string())
    }
}

/// 变异臂统计（`reset=true` 清空；`ctx` 省略则返回全部上下文）
#[tauri::command]
pub fn gongfang_mutation_stats(
    ctx: Option<String>,
    reset: Option<bool>,
) -> Result<serde_json::Value, String> {
    #[cfg(feature = "pentest")]
    {
        let reset = reset.unwrap_or(false);
        let map = crate::pentest::mutation::stats(ctx.as_deref(), reset);
        Ok(serde_json::json!({
            "reset": reset,
            "arms": crate::pentest::mutation::ARMS,
            "contexts": map,
        }))
    }
    #[cfg(not(feature = "pentest"))]
    {
        let _ = (ctx, reset);
        Err("pentest feature 未启用，请用 --features gongfang-pentest 编译".to_string())
    }
}

/// OpenAPI / Swagger 参数边界推演
///
/// 输入二选一：`url`（spec 地址，自动抓取，走统一 GET 通道=真实 TLS 指纹优先）
/// 或 `spec`（直接给 spec JSON 文本，便于离线/已下载的 spec）。
///
/// 产出：端点 → 参数 → 每个参数的边界候选值（类型边界 / 枚举 / 必填缺失 / 注入基线）。
/// **只解析、不发任何探测请求**：是否真发、发多少由调用方（人工或 AI 显式指令）决定，
/// 避免模块自行对目标做「参数 fuzz」这类越权动作。
/// 仅支持 JSON spec；YAML 形态请先转 JSON（不为此引入 YAML 依赖）。
#[tauri::command]
pub async fn gongfang_openapi_analyze(
    url: Option<String>,
    spec: Option<String>,
) -> Result<OpenApiReportOut, String> {
    #[cfg(feature = "pentest")]
    {
        let text = if let Some(s) = spec.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            s.to_string()
        } else {
            let u = url
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "需提供 spec 的 url 或 spec 文本".to_string())?;
            let u = crate::normalize_url(u);
            log::info!("[openapi] 拉取 spec: {}", u);
            let r = crate::http_channel::get(&u, crate::http_channel::DEFAULT_TIMEOUT_MS, "chrome_122")
                .await
                .map_err(|e| format!("拉取 spec 失败: {}", e))?;
            if !(200..300).contains(&r.status) {
                return Err(format!(
                    "拉取 spec 失败：HTTP {}（channel={}）；若目标需鉴权请改用 spec 文本入参",
                    r.status, r.channel
                ));
            }
            r.body
        };
        crate::pentest::openapi::analyze_spec(&text)
    }
    #[cfg(not(feature = "pentest"))]
    {
        let _ = (url, spec);
        Err("pentest feature 未启用，请用 --features gongfang-pentest 编译".to_string())
    }
}

#[cfg(feature = "pentest")]
type MethodReportOut = crate::pentest::recon::MethodReport;
#[cfg(not(feature = "pentest"))]
type MethodReportOut = serde_json::Value;

#[cfg(feature = "pentest")]
type PathProbeOut = Vec<crate::pentest::recon::PathResult>;
#[cfg(not(feature = "pentest"))]
type PathProbeOut = Vec<serde_json::Value>;

#[cfg(feature = "pentest")]
type ErrorPageOut = crate::pentest::recon::ErrorPageReport;
#[cfg(not(feature = "pentest"))]
type ErrorPageOut = serde_json::Value;

#[cfg(feature = "pentest")]
type SimOut = Vec<crate::pentest::sim::MutationResult>;
#[cfg(not(feature = "pentest"))]
type SimOut = Vec<serde_json::Value>;

#[cfg(feature = "gateway")]
type ScoreOut = crate::gateway::pool::ReputationBreakdown;
#[cfg(not(feature = "gateway"))]
type ScoreOut = serde_json::Value;

#[tauri::command]
pub fn gongfang_encode_analyze(input: String) -> Result<EncodeAnalysisOut, String> {
    if input.trim().is_empty() {
        return Err("input 不能为空".to_string());
    }
    #[cfg(feature = "reverse")]
    {
        Ok(crate::reverse::detect::analyze(&input))
    }
    #[cfg(not(feature = "reverse"))]
    {
        let _ = input;
        Err("reverse feature 未启用，请用 --features gongfang-reverse 编译".to_string())
    }
}

/// 多层/递归解码链：反复解码（base64(hex(base64(…))) 剥洋葱）直到明文或上限
#[tauri::command]
pub fn gongfang_encode_chain(
    input: String,
    max_layers: Option<u8>,
) -> Result<Vec<EncodeChainOut>, String> {
    if input.trim().is_empty() {
        return Err("input 不能为空".to_string());
    }
    #[cfg(feature = "reverse")]
    {
        Ok(crate::reverse::detect::analyze_chain(&input, max_layers.unwrap_or(8)))
    }
    #[cfg(not(feature = "reverse"))]
    {
        let _ = (input, max_layers);
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

/// 保存符号请求
#[derive(Deserialize)]
pub struct SaveSymbolRequest {
    pub url: String,
    pub name: String,
    pub kind: Option<String>,
    pub address: Option<u64>,
}

/// 把识别结果/关键字符串一键存为符号（写入持久化符号库，跨会话复用）
#[tauri::command]
pub fn gongfang_symbol_add(req: SaveSymbolRequest) -> Result<(), String> {
    if req.url.trim().is_empty() {
        return Err("url 不能为空".to_string());
    }
    if req.name.trim().is_empty() {
        return Err("name 不能为空".to_string());
    }
    #[cfg(feature = "reverse")]
    {
        use crate::reverse::symbols::SymbolKind;
        let kind = match req.kind.as_deref() {
            Some(k) => SymbolKind::from_str(k),
            None => SymbolKind::CryptoFunction,
        };
        let symbol = crate::reverse::symbols::Symbol {
            name: req.name.trim().to_string(),
            address: req.address.unwrap_or(0),
            kind,
            meta: std::collections::HashMap::new(),
        };
        // load 返回全局克隆（无锁占用），add_symbol 内部 save() 会写回全局 + 落盘
        let mut store = crate::reverse::symbols::SymbolStore::load().as_ref().clone();
        store.add_symbol(req.url.trim(), symbol);
        Ok(())
    }
    #[cfg(not(feature = "reverse"))]
    {
        let _ = req;
        Err("reverse feature 未启用，请用 --features gongfang-reverse 编译".to_string())
    }
}

/// 协议状态机可视化：仅导出**目标已学习**的真实 DFA。
///
/// 无目标或目标未学习时**不返回任何演示/示例状态机**——状态机是对目标的断言，
/// 用示例数据填充会让调用方（含 AI）把演示图当成真实分析结果。
#[tauri::command]
pub fn gongfang_protocol_graph(url: Option<String>) -> Result<DfaGraphOut, String> {
    #[cfg(feature = "reverse")]
    {
        use crate::reverse::protocol::empty_graph;
        let u = url.as_deref().unwrap_or("").trim();
        if u.is_empty() {
            return Err("请先指定目标 URL（无目标时不返回示例状态机）".to_string());
        }
        let store = crate::reverse::symbols::SymbolStore::load();
        match store.protocol_dfa(u) {
            Some(dfa) => Ok(dfa.to_graph()),
            None => Ok(empty_graph()), // 该目标尚未学习：返回空图（state_count=0）
        }
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

/// 自动化：列出行为模板库 + 各模板适应度 + 当前模板
#[tauri::command]
pub fn gongfang_automation_templates() -> Result<serde_json::Value, String> {
    #[cfg(feature = "automation")]
    {
        use crate::automation::profiles::{current_template, fitness_report, BehaviorTemplate};
        let presets = BehaviorTemplate::presets();
        let report = fitness_report();
        let cur = current_template();
        let list: Vec<serde_json::Value> = presets
            .iter()
            .map(|p| {
                serde_json::json!({
                    "id": p.id, "name": p.name,
                    "speed_factor": p.speed_factor, "overshoot": p.overshoot,
                    "noise_amplitude": p.noise_amplitude,
                    "tremor_frequency": p.tremor_frequency,
                    "poll_interval_ms": p.poll_interval_ms, "weight": p.weight,
                })
            })
            .collect();
        let fitness: Vec<serde_json::Value> = report
            .iter()
            .map(|(id, name, success, failure, rate, avg_div)| {
                serde_json::json!({
                    "id": id, "name": name, "success": success, "failure": failure,
                    "success_rate": rate, "avg_divergence": avg_div,
                })
            })
            .collect();
        Ok(serde_json::json!({
            "templates": list,
            "fitness": fitness,
            "current": cur.name,
        }))
    }
    #[cfg(not(feature = "automation"))]
    {
        Err("automation feature 未启用，请用 --features gongfang-automation 编译".to_string())
    }
}

/// 自动化：轨迹生成演示（贝塞尔 + 生理噪声），按模板参数
#[tauri::command]
pub fn gongfang_automation_trajectory(
    start_x: f32,
    start_y: f32,
    target_x: f32,
    target_y: f32,
    template_id: Option<u32>,
) -> Result<serde_json::Value, String> {
    #[cfg(feature = "automation")]
    {
        use crate::automation::bezier::generate_trajectory;
        use crate::automation::noise::apply_physiological_noise;
        use crate::automation::profiles::BehaviorTemplate;
        let tid = template_id.unwrap_or(0);
        let presets = BehaviorTemplate::presets();
        let template = presets.iter().find(|p| p.id == tid).unwrap_or(&presets[0]).clone();
        let raw = generate_trajectory((start_x, start_y), (target_x, target_y), template.speed_factor, template.overshoot);
        let noisy = apply_physiological_noise(&raw, template.noise_amplitude, template.tremor_frequency);
        let duration_ms = noisy.last().map(|p| p.t_ms).unwrap_or(0);
        let step = noisy.len().saturating_div(20).max(1);
        let sample: Vec<serde_json::Value> = noisy
            .iter()
            .step_by(step)
            .take(20)
            .map(|p| serde_json::json!({ "x": p.x, "y": p.y, "t_ms": p.t_ms }))
            .collect();
        Ok(serde_json::json!({
            "template": template.name, "template_id": template.id,
            "point_count": noisy.len(), "raw_point_count": raw.len(),
            "duration_ms": duration_ms, "overshoot": template.overshoot,
            "noise_amplitude": template.noise_amplitude, "tremor_frequency": template.tremor_frequency,
            "start": [start_x, start_y], "target": [target_x, target_y],
            "sample": sample,
        }))
    }
    #[cfg(not(feature = "automation"))]
    {
        let _ = (start_x, start_y, target_x, target_y, template_id);
        Err("automation feature 未启用，请用 --features gongfang-automation 编译".to_string())
    }
}

/// 自动化：行为散度对比——给定一段轨迹 → 与模板基线算 JS 散度，判人类相似度
#[tauri::command]
pub fn gongfang_automation_divergence(
    points: Vec<serde_json::Value>,
    template_id: Option<u32>,
) -> Result<serde_json::Value, String> {
    let points: Vec<serde_json::Value> = points
        .into_iter()
        .filter(|p| p.get("x").is_some() && p.get("y").is_some())
        .collect();
    if points.len() < 3 {
        return Err("points 至少需要 3 个轨迹点 {x, y[, t_ms]}".to_string());
    }
    #[cfg(feature = "automation")]
    {
        use crate::automation::baseline::BehaviorBaseline;
        use crate::automation::bezier::TrajectoryPoint;
        use crate::automation::profiles::BehaviorTemplate;
        let tid = template_id.unwrap_or(0);
        let presets = BehaviorTemplate::presets();
        let template = presets.iter().find(|p| p.id == tid).unwrap_or(&presets[0]).clone();
        let traj: Vec<TrajectoryPoint> = points
            .iter()
            .map(|p| TrajectoryPoint {
                x: p.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32,
                y: p.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32,
                t_ms: p.get("t_ms").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            })
            .collect();
        let mut baseline = BehaviorBaseline::new();
        baseline.add_observation(&traj);
        let multidim = baseline.js_divergence_multidim(&template);
        let single = baseline.js_divergence_from_template(&template);
        // 数据充分性：单条/过短轨迹分布稀疏，统计不可靠 → 不武断判"异常"
        let span_ms = traj.last().map(|p| p.t_ms).unwrap_or(0);
        let sufficient = traj.len() >= 40 && span_ms > 300;
        let verdict = if !sufficient {
            "样本不足（需 ≥40 点且时间跨度 >300ms，或多段轨迹）"
        } else if multidim < 0.15 {
            "人类相似"
        } else if multidim <= 0.4 {
            "可疑"
        } else {
            "异常（自动化特征明显）"
        };
        Ok(serde_json::json!({
            "template": template.name,
            "multidim": (multidim * 1000.0).round() / 1000.0,
            "single": (single * 1000.0).round() / 1000.0,
            "samples": traj.len(),
            "span_ms": span_ms,
            "sufficient": sufficient,
            "verdict": verdict,
        }))
    }
    #[cfg(not(feature = "automation"))]
    {
        let _ = (points, template_id);
        Err("automation feature 未启用，请用 --features gongfang-automation 编译".to_string())
    }
}

/// 自动化：探针调整器实验——模拟噪声幅度自适应试探（成功加压制/失败回退细化）
///
/// success 序列为 bool 数组：true=未触发风控(成功)，false=触发(失败/回退)。
/// 观察幅度如何自动爬升试探边界，命中失败后回退上次成功值并减小步长。
#[tauri::command]
pub fn gongfang_automation_probe(successes: Vec<bool>) -> Result<serde_json::Value, String> {
    let successes: Vec<bool> = successes;
    if successes.is_empty() {
        return Err("successes 不能为空（true=成功/false=失败回退）".to_string());
    }
    #[cfg(feature = "automation")]
    {
        use crate::automation::baseline::ProbeAdjuster;
        let mut ap = ProbeAdjuster::new(0.5, 3.0, 0.2);
        let mut steps: Vec<serde_json::Value> = Vec::with_capacity(successes.len());
        let mut rollbacks = 0u32;
        for ok in &successes {
            let before = ap.current();
            ap.feedback(*ok);
            if !ok {
                rollbacks += 1;
            }
            steps.push(serde_json::json!({
                "ok": ok,
                "amplitude_before": (before * 100.0).round() / 100.0,
                "amplitude_after": (ap.current() * 100.0).round() / 100.0,
            }));
        }
        let final_amp = (ap.current() * 100.0).round() / 100.0;
        Ok(serde_json::json!({
            "min": 0.5, "max": 3.0, "initial_step": 0.2,
            "steps": steps,
            "rollbacks": rollbacks,
            "final_amplitude": final_amp,
            "note": format!(
                "{} 步内回退 {} 次 → 最终噪声幅度 {:.2}。命中风控自动回退并细化步长，未命中则试探性加压制。",
                successes.len(), rollbacks, final_amp
            ),
        }))
    }
    #[cfg(not(feature = "automation"))]
    {
        let _ = successes;
        Err("automation feature 未启用，请用 --features gongfang-automation 编译".to_string())
    }
}

/// 设置 Pivot 真实注入目标（绝对屏幕坐标，px）。
/// 未设置时数据面 Pivot 跳过真实 SendInput（避免假坐标），设置后注入真实轨迹到该点。
#[tauri::command]
pub fn gongfang_automation_target(x: f32, y: f32) -> Result<serde_json::Value, String> {
    #[cfg(feature = "automation")]
    {
        crate::automation::set_target(x, y);
        Ok(serde_json::json!({ "x": x, "y": y, "set": true }))
    }
    #[cfg(not(feature = "automation"))]
    {
        let _ = (x, y);
        Err("automation feature 未启用，请用 --features gongfang-automation 编译".to_string())
    }
}

/// 清除 Pivot 注入目标（回到"不注入"状态）
#[tauri::command]
pub fn gongfang_automation_target_clear() -> Result<serde_json::Value, String> {
    #[cfg(feature = "automation")]
    {
        crate::automation::clear_target();
        Ok(serde_json::json!({ "cleared": true }))
    }
    #[cfg(not(feature = "automation"))]
    {
        Err("automation feature 未启用，请用 --features gongfang-automation 编译".to_string())
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

/// 节点信誉评分分解：输入节点指标 → 信誉 + 各惩罚项 + 故障判定（离线可仿真）
#[tauri::command]
pub fn gongfang_gateway_score(
    error_rate: f64,
    ewma_rtt: f64,
    rtt_gradient: f64,
) -> Result<ScoreOut, String> {
    if !(0.0..=1.0).contains(&error_rate) {
        return Err("error_rate 须在 [0,1] 区间".to_string());
    }
    if ewma_rtt < 0.0 {
        return Err("ewma_rtt 不能为负".to_string());
    }
    #[cfg(feature = "gateway")]
    {
        Ok(crate::gateway::pool::score_node(error_rate, ewma_rtt, rtt_gradient))
    }
    #[cfg(not(feature = "gateway"))]
    {
        Err("gateway feature 未启用，请用 --features gongfang-gateway 编译".to_string())
    }
}

/// 流量时序仿真：以 Poisson 过程按 lambda(次/秒) 生成 count 个请求间隔并统计
#[tauri::command]
pub fn gongfang_gateway_traffic(lambda: f64, count: Option<usize>) -> Result<serde_json::Value, String> {
    #[cfg(feature = "gateway")]
    {
        use crate::gateway::shaping::poisson_interval_ms;
        let n = count.unwrap_or(20).clamp(1, 100);
        let mut intervals = Vec::with_capacity(n);
        for _ in 0..n {
            intervals.push(poisson_interval_ms(lambda));
        }
        let sum: u64 = intervals.iter().sum();
        let avg_ms = sum as f64 / n as f64;
        Ok(serde_json::json!({
            "lambda_req_per_sec": lambda,
            "expected_interval_ms": if lambda > 0.0 { serde_json::Value::from((1000.0 / lambda).round() as u64) } else { serde_json::Value::Null },
            "count": n,
            "avg_ms": avg_ms.round(),
            "min_ms": intervals.iter().min().copied().unwrap_or(0),
            "max_ms": intervals.iter().max().copied().unwrap_or(0),
            "intervals_ms": intervals,
        }))
    }
    #[cfg(not(feature = "gateway"))]
    {
        let _ = (lambda, count);
        Err("gateway feature 未启用，请用 --features gongfang-gateway 编译".to_string())
    }
}

/// 路由决策仿真：输入一组假想节点指标，评分并选出最优节点 + 冗余比例
#[tauri::command]
pub fn gongfang_gateway_route_sim(nodes: Vec<serde_json::Value>) -> Result<serde_json::Value, String> {
    #[cfg(feature = "gateway")]
    {
        use crate::gateway::pool::{score_node, ReputationBreakdown};
        let mut scored: Vec<(String, String, ReputationBreakdown)> = Vec::new();
        for node in nodes {
            let url = node.get("url").and_then(|v| v.as_str()).unwrap_or("?").to_string();
            let region = node.get("region").and_then(|v| v.as_str()).unwrap_or("?").to_string();
            let err = node.get("error_rate").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let rtt = node.get("ewma_rtt").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let grad = node.get("rtt_gradient").and_then(|v| v.as_f64()).unwrap_or(0.0);
            scored.push((url, region, score_node(err, rtt, grad)));
        }
        let selected = scored
            .iter()
            .filter(|(_, _, b)| !b.is_failing)
            .max_by(|a, c| a.2.reputation.partial_cmp(&c.2.reputation).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(u, _, _)| u.clone());
        let active = scored.iter().filter(|(_, _, b)| !b.is_failing).count();
        let standby = scored.len().saturating_sub(active);
        let redundancy_ratio = if active > 0 { standby as f64 / active as f64 } else { 0.0 };
        let list: Vec<serde_json::Value> = scored
            .into_iter()
            .map(|(url, region, b)| {
                serde_json::json!({
                    "url": url, "region": region,
                    "reputation": b.reputation,
                    "error_penalty": b.error_penalty,
                    "rtt_penalty": b.rtt_penalty,
                    "gradient_penalty": b.gradient_penalty,
                    "is_failing": b.is_failing,
                })
            })
            .collect();
        Ok(serde_json::json!({
            "nodes": list,
            "selected": selected,
            "active": active,
            "standby": standby,
            "redundancy_ratio": redundancy_ratio,
        }))
    }
    #[cfg(not(feature = "gateway"))]
    {
        let _ = nodes;
        Err("gateway feature 未启用，请用 --features gongfang-gateway 编译".to_string())
    }
}

/// 策略仿真：@rotate/@throttle → 期望的带宽策略与请求节奏
#[tauri::command]
pub fn gongfang_gateway_strategy_sim(routing: String, ratio: f64) -> Result<serde_json::Value, String> {
    #[cfg(feature = "gateway")]
    {
        use crate::gateway::{BandwidthPolicy, RoutingMode};
        let mode = RoutingMode::from_str(&routing).unwrap_or(RoutingMode::Direct);
        let mut bp = BandwidthPolicy::default();
        bp.apply_throttle(ratio);
        Ok(serde_json::json!({
            "routing": mode.as_str(),
            "routing_cn": mode.as_cn(),
            "ratio": bp.ratio,
            "request_timeout_ms": bp.request_timeout_ms,
            "max_concurrent": bp.max_concurrent,
            "high_priority_bypass": bp.high_priority_bypass,
            "est_interval_silent_ms": 3300,
            "est_interval_burst_ms": 200,
        }))
    }
    #[cfg(not(feature = "gateway"))]
    {
        let _ = (routing, ratio);
        Err("gateway feature 未启用，请用 --features gongfang-gateway 编译".to_string())
    }
}

/// 隐身请求整形演示：返回一次完整的整形建议（间隔/突发/指纹/头序/熵/噪声）
#[tauri::command]
pub fn gongfang_gateway_shaping_demo() -> Result<serde_json::Value, String> {
    #[cfg(feature = "gateway")]
    {
        let advice = crate::gateway::shaping::next_advice();
        serde_json::to_value(&advice).map_err(|e| format!("序列化失败: {}", e))
    }
    #[cfg(not(feature = "gateway"))]
    {
        Err("gateway feature 未启用，请用 --features gongfang-gateway 编译".to_string())
    }
}

/// Payload 混淆演示：对一个 JSON 对象做无害冗余注入 + 字段顺序随机化
#[tauri::command]
pub fn gongfang_gateway_obfuscate(raw: String) -> Result<serde_json::Value, String> {
    let raw = raw.trim().to_string();
    if raw.is_empty() {
        return Err("raw 不能为空（一个 JSON 对象）".to_string());
    }
    #[cfg(feature = "gateway")]
    {
        use crate::gateway::shaping::obfuscate_json_payload;
        let obfuscated = obfuscate_json_payload(&raw);
        Ok(serde_json::json!({ "original": raw, "obfuscated": obfuscated }))
    }
    #[cfg(not(feature = "gateway"))]
    {
        let _ = raw;
        Err("gateway feature 未启用，请用 --features gongfang-gateway 编译".to_string())
    }
}

/// 请求熵监控实验：给定一批请求模式 → 计算 Shannon 熵 + 是否需要注入假请求
#[tauri::command]
pub fn gongfang_gateway_entropy_demo(patterns: Vec<String>) -> Result<serde_json::Value, String> {
    let patterns: Vec<String> = patterns.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if patterns.is_empty() {
        return Err("patterns 不能为空".to_string());
    }
    #[cfg(feature = "gateway")]
    {
        use crate::gateway::shaping::EntropyMonitor;
        let mut m = EntropyMonitor::new(2.0);
        for p in &patterns {
            m.record(p.clone());
        }
        let needs_noise = m.needs_noise();
        let entropy = (m.entropy() * 100.0).round() / 100.0;
        Ok(serde_json::json!({
            "threshold": 2.0,
            "entropy": entropy,
            "needs_noise": needs_noise,
            "count": patterns.len(),
            "noise_path": if needs_noise { serde_json::Value::from(EntropyMonitor::noise_path()) } else { serde_json::Value::Null },
            "verdict": if needs_noise { "模式过于规则，建议注入假请求提升熵" } else { "模式多样化充分" },
        }))
    }
    #[cfg(not(feature = "gateway"))]
    {
        let _ = patterns;
        Err("gateway feature 未启用，请用 --features gongfang-gateway 编译".to_string())
    }
}

/// 隐身请求生成：把整形建议落地成可直接复制的 curl（指纹 UA + 建议头序 + 可选 Payload 混淆）
#[tauri::command]
pub fn gongfang_gateway_curl(
    url: String,
    raw: Option<String>,
    mode: Option<String>,
) -> Result<serde_json::Value, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("url 不能为空".to_string());
    }
    #[cfg(feature = "gateway")]
    {
        use crate::gateway::shaping::next_advice;
        let advice = next_advice();
        let fp = &advice.fingerprint;
        let mut headers: Vec<(String, String)> = Vec::new();
        let mut have: std::collections::HashSet<String> = std::collections::HashSet::new();
        for h in &advice.header_order {
            let lh = h.to_lowercase();
            if have.contains(&lh) {
                continue;
            }
            let val = match h.as_str() {
                "User-Agent" => fp.user_agent.clone(),
                "Accept" => fp.accept.clone(),
                "Accept-Language" => fp.accept_language.clone(),
                "Accept-Encoding" => "gzip, deflate, br".to_string(),
                "Connection" => "keep-alive".to_string(),
                _ => String::new(), // Host 等由 curl 推导，其余占位
            };
            headers.push((h.clone(), val));
            have.insert(lh);
        }
        if !have.contains("user-agent") {
            headers.push(("User-Agent".to_string(), fp.user_agent.clone()));
        }
        if !have.contains("accept") {
            headers.push(("Accept".to_string(), fp.accept.clone()));
        }

        let mut cmd = format!("curl -sS '{}' \\\n", url);
        for (k, v) in &headers {
            if v.is_empty() {
                cmd.push_str(&format!("  -H '{}:' \\\n", k));
            } else {
                cmd.push_str(&format!("  -H '{}: {}' \\\n", k, v));
            }
        }
        let mut note = String::new();
        if let Some(r) = raw {
            let r = r.trim().to_string();
            let obf = crate::gateway::shaping::obfuscate_json_payload(&r);
            if obf != r {
                note = "（已对 JSON 做 Payload 混淆，注入冗余字段）".to_string();
            }
            cmd.push_str(&format!("  --data-raw '{}' \\\n", obf));
        }
        cmd.push_str("  --compressed\n");

        Ok(serde_json::json!({
            "command": cmd,
            "interval_ms": advice.interval_ms,
            "in_burst": advice.in_burst,
            "fingerprint": fp.os,
            "header_order": advice.header_order,
            "mode": mode.unwrap_or_else(|| "auto".to_string()),
            "note": note,
        }))
    }
    #[cfg(not(feature = "gateway"))]
    {
        let _ = (url, raw, mode);
        Err("gateway feature 未启用，请用 --features gongfang-gateway 编译".to_string())
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

/// AI 知识库检索：模拟 L2 深度推理的 RAG 注入（返回 top-K 匹配条目）
#[tauri::command]
pub fn gongfang_ai_knowledge_search(query: String) -> Result<serde_json::Value, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("query 不能为空".to_string());
    }
    let kb = crate::kernel::knowledge::global();
    let hits = kb.search(&query, 5);
    let entries: Vec<serde_json::Value> = hits
        .iter()
        .map(|e| {
            serde_json::json!({
                "id": e.id, "title": e.title, "content": e.content,
                "tags": e.tags, "category": format!("{:?}", e.category),
            })
        })
        .collect();
    Ok(serde_json::json!({ "query": query, "count": entries.len(), "entries": entries }))
}

/// AI 知识库统计：全部条目 + 分类计数 + L0 规则缓存大小
#[tauri::command]
pub fn gongfang_ai_knowledge_stats() -> Result<serde_json::Value, String> {
    use crate::kernel::knowledge::KnowledgeCategory;
    let kb = crate::kernel::knowledge::global();
    let all = kb.all_entries();
    let mut anti = 0usize;
    let mut fp = 0usize;
    let mut ban = 0usize;
    for e in &all {
        match e.category {
            KnowledgeCategory::AntiBot => anti += 1,
            KnowledgeCategory::Fingerprint => fp += 1,
            KnowledgeCategory::BanCase => ban += 1,
        }
    }
    let entries: Vec<serde_json::Value> = all
        .iter()
        .map(|e| {
            serde_json::json!({
                "id": e.id, "title": e.title, "content": e.content, "tags": e.tags,
                "category": match e.category {
                    KnowledgeCategory::AntiBot => "反爬",
                    KnowledgeCategory::Fingerprint => "指纹",
                    KnowledgeCategory::BanCase => "封禁",
                },
            })
        })
        .collect();
    Ok(serde_json::json!({
        "total": all.len(),
        "rule_cache": kb.rule_cache_len(),
        "counts": { "antibots": anti, "fingerprint": fp, "bancase": ban },
        "entries": entries,
    }))
}

/// AI 知识库新增条目：类别 + 标题 + 内容 + 标签（运行时写入全局知识库，充实 RAG）
#[tauri::command]
pub async fn gongfang_ai_knowledge_add(
    title: String,
    content: String,
    tags: Option<Vec<String>>,
    category: String,
) -> Result<serde_json::Value, String> {
    use crate::kernel::knowledge::{KnowledgeCategory, KnowledgeEntry};
    let title = title.trim().to_string();
    let content = content.trim().to_string();
    if title.is_empty() {
        return Err("title 不能为空".to_string());
    }
    if content.is_empty() {
        return Err("content 不能为空".to_string());
    }
    let category = match category.trim().to_lowercase().as_str() {
        "antibots" | "antibot" | "反爬" => KnowledgeCategory::AntiBot,
        "fingerprint" | "指纹" => KnowledgeCategory::Fingerprint,
        "bancase" | "ban" | "封禁" => KnowledgeCategory::BanCase,
        other => return Err(format!("未知分类：{}（可用 antibot / fingerprint / bancase）", other)),
    };
    let tags: Vec<String> = tags
        .unwrap_or_default()
        .into_iter()
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    // id：基于时间戳 + 标题 slug，保证唯一可稳定删除
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut slug = String::new();
    for c in title.chars() {
        if c.is_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        }
    }
    if slug.is_empty() {
        slug = "kb".to_string();
    }
    let id = format!("{}-{}", slug, ts);
    let entry = KnowledgeEntry { id: id.clone(), title, content, tags, category };
    let kb = crate::kernel::knowledge::global();
    // 落盘(JSON 写)是阻塞 I/O，放入 spawn_blocking 避免占用 async 线程
    tokio::task::spawn_blocking(move || kb.add(entry))
        .await
        .map_err(|e| format!("知识库写入任务失败: {}", e))?;
    // 返回"分类中文名 + 当前规模"，供前端确认并刷新
    let cat_label = match crate::kernel::knowledge::global().get(&id).map(|e| e.category) {
        Some(KnowledgeCategory::AntiBot) => "反爬",
        Some(KnowledgeCategory::Fingerprint) => "指纹",
        _ => "封禁",
    };
    Ok(serde_json::json!({
        "id": id,
        "category": cat_label,
        "added": true,
    }))
}

/// AI 知识库删除条目：按 id 移除（含索引重建 + 落盘）
#[tauri::command]
pub async fn gongfang_ai_knowledge_remove(id: String) -> Result<serde_json::Value, String> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("id 不能为空".to_string());
    }
    let kb = crate::kernel::knowledge::global();
    let target = id.clone();
    // 删除含索引重建 + JSON 落盘（阻塞 I/O），放入 spawn_blocking
    let removed = tokio::task::spawn_blocking(move || kb.remove(&target))
        .await
        .map_err(|e| format!("知识库删除任务失败: {}", e))?;
    Ok(serde_json::json!({ "removed": removed, "id": id }))
}

/// AI 推理路由仿真：给定场景 → 走 L0 规则缓存 / L1/L2（含 RAG 注入预览）
#[tauri::command]
pub fn gongfang_ai_router_sim(
    status: Option<u16>,
    error_rate: f64,
    tls: String,
) -> Result<serde_json::Value, String> {
    let tls = tls.trim().to_string();
    if tls.is_empty() {
        return Err("tls 不能为空（如 chrome_122 / a_bogus）".to_string());
    }
    let kb = crate::kernel::knowledge::global();
    let sig = crate::kernel::knowledge::KnowledgeBase::signature_from_observation(
        crate::kernel::strategy::Phase::default(),
        error_rate as f32,
        &tls,
        status,
        None,
    );
    let l0_hit = kb.lookup_rule(&sig);
    let rag_hits = kb.search(&sig.0, 3);
    let rag: Vec<serde_json::Value> = rag_hits
        .iter()
        .map(|e| serde_json::json!({ "id": e.id, "title": e.title }))
        .collect();
    Ok(serde_json::json!({
        "signature": sig.0,
        "l0_hit": l0_hit.is_some(),
        "recommended_level": if l0_hit.is_some() { "L0（规则缓存命中 <1ms）" } else { "L1（需 LLM；L2 深度推理注入 RAG）" },
        "rag_count": rag.len(),
        "rag": rag,
    }))
}

/// AI 推理统计：聚合推理日志 → 各级命中数 / 平均时延 / 成功率
#[tauri::command]
pub fn gongfang_ai_reasoning_stats() -> Result<serde_json::Value, String> {
    use crate::kernel::events::ReasoningLevel;
    match crate::kernel::events::global() {
        Some(bus) => {
            let rec = bus.recent_reasoning(100);
            let mut counts = [0u32; 4]; // L0, L1, L2, L0Fallback
            let mut latencies: Vec<f64> = Vec::new();
            let mut ok: u32 = 0;
            for r in &rec {
                match r.level {
                    ReasoningLevel::L0 => counts[0] += 1,
                    ReasoningLevel::L1 => counts[1] += 1,
                    ReasoningLevel::L2 => counts[2] += 1,
                    ReasoningLevel::L0Fallback => counts[3] += 1,
                }
                latencies.push(r.latency_ms as f64);
                if r.success {
                    ok += 1;
                }
            }
            let total = rec.len() as u32;
            let avg_latency = if latencies.is_empty() {
                0.0
            } else {
                latencies.iter().sum::<f64>() / latencies.len() as f64
            };
            let success_rate = if total > 0 { ok as f64 / total as f64 } else { 0.0 };
            Ok(serde_json::json!({
                "total": total,
                "levels": { "L0": counts[0], "L1": counts[1], "L2": counts[2], "L0Fallback": counts[3] },
                "avg_latency_ms": (avg_latency * 100.0).round() / 100.0,
                "success_rate": (success_rate * 100.0).round() / 100.0,
            }))
        }
        None => Ok(serde_json::json!({
            "total": 0,
            "levels": { "L0": 0, "L1": 0, "L2": 0, "L0Fallback": 0 },
            "avg_latency_ms": 0,
            "success_rate": 0,
        })),
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
