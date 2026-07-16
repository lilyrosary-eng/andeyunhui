//! 流量整形与语义混淆（维度二 + 维度三务实降级）
//!
//! 原方案删除/降级：
//! - TCP/IP 栈深度定制（SYN 选项伪造 / SO_TXTIME / 用户态 TCP 拥塞控制）→ 删除
//!     · 需 raw socket + root 权限，桌面场景不可行
//!     · TCP 指纹伪装通过 reqwest header 配置间接实现（User-Agent + TLS 配置）
//! - 域前置（Domain Fronting）多级 CDN 链 → 删除（CDN 厂商已普遍禁用）
//! - DNS 缓存投毒 + NXDOMAIN 强制刷新 → 删除（违法风险 + 桌面无 DNS 服务）
//! - DNS over HTTPS 主动实施 → 删除（由 OS / 系统代理接管，避免与系统冲突）
//! - 端口跳跃 + 隧道嵌套 → 删除（DPI 桌面场景无需求）
//!
//! 务实保留：
//! - Poisson 间隔生成器：模拟人类浏览的"思考停顿"和"突发阅读"
//! - HTTP 头顺序随机化：对齐 Chrome/Firefox 高频头序分布
//! - Payload 边界混淆：JSON 插入无害冗余字段 + 字段顺序随机化
//! - 请求熵监控器：Shannon 熵低于阈值时注入假请求
//! - OS 指纹配置预设：通过 User-Agent + Window Size 等可配置项对齐
//!
//! 设计原则：零额外依赖（gateway = []），使用内置 xorshift PRNG 替代 rand crate

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ============ 内置 xorshift PRNG（零依赖） ============

/// xorshift64* PRNG — 轻量快速，无需 rand crate
/// 周期 2^64-1，统计性质足够用于流量整形场景
pub struct XorShift {
    state: u64,
}

impl XorShift {
    pub fn new(seed: u64) -> Self {
        // 避免全零状态（会导致输出永远为 0）
        Self {
            state: if seed == 0 { 0x9E37_79B9_7F4A_7C15 } else { seed },
        }
    }

    /// 从系统时间 + 内存地址初始化（快速熵源，不追求密码学强度）
    pub fn from_entropy() -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x1234_5678);
        // 混入栈地址增加熵
        let stack_addr = &nanos as *const _ as u64;
        Self::new(nanos ^ stack_addr.rotate_left(17))
    }

    /// 下一个 u64
    pub fn next_u64(&mut self) -> u64 {
        // xorshift64* 算法（Vigna 2014）
        let mut x = self.state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.state = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// [0, 1) 浮点数
    pub fn next_f64(&mut self) -> f64 {
        // 取高 53 位作为尾数，避免精度损失
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// [low, high) 均匀分布整数
    pub fn next_range(&mut self, low: usize, high: usize) -> usize {
        if high <= low {
            return low;
        }
        low + (self.next_u64() as usize % (high - low))
    }

    /// Fisher-Yates 洗牌
    pub fn shuffle<T>(&mut self, slice: &mut [T]) {
        let n = slice.len();
        for i in (1..n).rev() {
            let j = self.next_range(0, i + 1);
            slice.swap(i, j);
        }
    }

    /// 从切片随机选一个
    pub fn pick<'a, T>(&mut self, slice: &'a [T]) -> Option<&'a T> {
        if slice.is_empty() {
            None
        } else {
            Some(&slice[self.next_range(0, slice.len())])
        }
    }
}

// 全局 PRNG 单例（线程安全）
static GLOBAL_RNG: once_cell::sync::Lazy<Mutex<XorShift>> =
    once_cell::sync::Lazy::new(|| Mutex::new(XorShift::from_entropy()));

/// 全局 PRNG 调用便捷函数
fn with_rng<F, T>(f: F) -> T
where
    F: FnOnce(&mut XorShift) -> T,
{
    let mut rng = GLOBAL_RNG.lock();
    f(&mut *rng)
}

// ============ 维度三：请求间隔 Poisson 过程 ============

/// Poisson 间隔生成器
///
/// 模拟真实用户浏览的"思考停顿"：连续访问后的静默期。
/// 间隔服从指数分布 Exp(λ)，通过逆变换法采样：t = -ln(U) / λ
///
/// - `lambda`: 请求率（次/秒），lambda 越大间隔越短
/// - 返回值：下一次请求应等待的毫秒数
///
/// 突发模拟：用户快速滚动 / 连续点击时，5 秒内发送密集请求（lambda=5），
/// 然后进入长时间静默（lambda=0.2，平均 5 秒一个请求）模拟阅读
pub fn poisson_interval_ms(lambda: f64) -> u64 {
    if lambda <= 0.0 {
        // 极低速率：返回较长静默
        return with_rng(|rng| rng.next_range(3000, 8000)) as u64;
    }
    // 逆变换法：t = -ln(U) / λ，U ~ Uniform(0,1)
    // 避免 U=0 导致 ln(0)=-inf，clamp 到 [1e-10, 1.0)
    let u = with_rng(|rng| rng.next_f64()).max(1e-10);
    let interval_sec = -u.ln() / lambda;
    // 限制在 [50ms, 30s]，避免极端值
    let interval_ms = (interval_sec * 1000.0).round() as i64;
    interval_ms.clamp(50, 30_000) as u64
}

/// 突发-静默模式：5 秒密集请求后进入长静默
///
/// 返回 (本次间隔_ms, 是否处于突发期)
pub fn burst_silence_interval() -> (u64, bool) {
    // 30% 概率进入突发期（lambda=5，平均 200ms 间隔）
    // 70% 概率进入静默期（lambda=0.3，平均 3.3s 间隔）
    let in_burst = with_rng(|rng| rng.next_f64()) < 0.3;
    if in_burst {
        (poisson_interval_ms(5.0), true)
    } else {
        (poisson_interval_ms(0.3), false)
    }
}

// ============ 维度三：HTTP 请求头顺序随机化 ============

/// 浏览器类型（决定头序分布）
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum BrowserFamily {
    Chrome,
    Firefox,
    Safari,
    Edge,
}

impl Default for BrowserFamily {
    fn default() -> Self {
        Self::Chrome
    }
}

/// 浏览器请求头顺序模板（基于真实抓包统计）
///
/// Chrome 系（Chrome/Edge）: Host → Connection → sec-ch-ua* → User-Agent → Accept → ...
/// Firefox: Host → User-Agent → Accept → Accept-Language → Accept-Encoding → ...
/// Safari: Host → Accept → User-Agent → Accept-Language → ...
fn default_header_order(family: BrowserFamily) -> Vec<&'static str> {
    match family {
        BrowserFamily::Chrome | BrowserFamily::Edge => vec![
            "Host",
            "Connection",
            "sec-ch-ua",
            "sec-ch-ua-mobile",
            "sec-ch-ua-platform",
            "Upgrade-Insecure-Requests",
            "User-Agent",
            "Accept",
            "Sec-Fetch-Site",
            "Sec-Fetch-Mode",
            "Sec-Fetch-User",
            "Sec-Fetch-Dest",
            "Accept-Encoding",
            "Accept-Language",
        ],
        BrowserFamily::Firefox => vec![
            "Host",
            "User-Agent",
            "Accept",
            "Accept-Language",
            "Accept-Encoding",
            "Connection",
            "Upgrade-Insecure-Requests",
            "Sec-Fetch-Dest",
            "Sec-Fetch-Mode",
            "Sec-Fetch-Site",
        ],
        BrowserFamily::Safari => vec![
            "Host",
            "Accept",
            "User-Agent",
            "Accept-Language",
            "Accept-Encoding",
            "Connection",
            "Upgrade-Insecure-Requests",
        ],
    }
}

/// 根据浏览器族生成头序（含小幅随机化）
///
/// 策略：
/// 1. 加载该浏览器的高频头序模板
/// 2. 将"无关紧要"的头（Accept-Language / Accept-Encoding）位置轻微扰动
/// 3. 主体顺序保持稳定（避免偏离真实浏览器特征）
pub fn randomize_header_order(family: BrowserFamily) -> Vec<String> {
    let base = default_header_order(family);
    let mut order: Vec<String> = base.iter().map(|s| s.to_string()).collect::<Vec<_>>();

    // 对 Accept-Language 和 Accept-Encoding 进行位置扰动（仅在它们之间互换）
    let positions: Vec<usize> = order
        .iter()
        .enumerate()
        .filter_map(|(i, h)| {
            if h == "Accept-Language" || h == "Accept-Encoding" {
                Some(i)
            } else {
                None
            }
        })
        .collect();

    if positions.len() >= 2 {
        with_rng(|rng| {
            // 50% 概率交换两者顺序
            if rng.next_f64() < 0.5 {
                let (a, b) = (positions[0], positions[1]);
                order.swap(a, b);
            }
        });
    }

    order
}

// ============ 维度三：Payload 边界混淆 ============

/// JSON Payload 混淆器
///
/// 通过两种手段改变字节流，但保持业务语义不变：
/// 1. 插入无害冗余字段（`_ts` / `_nonce` / `_comment`）
/// 2. 调整 JSON 对象字段顺序（JSON 对象本无序，解析后语义相同）
///
/// 效果：每次相同业务请求在网络上呈现不同的字节流，绕过基于哈希指纹的检测
pub fn obfuscate_json_payload(raw: &str) -> String {
    // 尝试解析为 JSON 对象
    let mut value: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => {
            // 非 JSON 或解析失败：原样返回（不破坏业务）
            return raw.to_string();
        }
    };

    let obj = match value.as_object_mut() {
        Some(o) => o,
        None => return raw.to_string(), // 非 object 类型，原样返回
    };

    // 1. 注入无害冗余字段（每次都不同）
    let nonce = with_rng(|rng| rng.next_u64());
    let ts = chrono::Utc::now().timestamp_millis();
    let comments = [
        "user session",
        "client metadata",
        "request context",
        "api version compat",
        "trace breadcrumb",
    ];
    let comment = with_rng(|rng| rng.pick(&comments).copied().unwrap_or("trace"));

    obj.insert("_ts".to_string(), serde_json::Value::from(ts));
    obj.insert("_nonce".to_string(), serde_json::Value::from(nonce.to_string()));
    obj.insert(
        "_comment".to_string(),
        serde_json::Value::from(comment),
    );

    // 2. 字段顺序随机化（serde_json 默认保留插入顺序，通过 HashMap 重排实现）
    //    序列化时通过 BTreeMap / 重新插入实现随机顺序
    let mut keys: Vec<String> = obj.keys().cloned().collect();
    with_rng(|rng| rng.shuffle(&mut keys));

    let mut new_obj = serde_json::Map::new();
    for k in keys {
        if let Some(v) = obj.remove(&k) {
            new_obj.insert(k, v);
        }
    }

    value = serde_json::Value::Object(new_obj);
    serde_json::to_string(&value).unwrap_or_else(|_| raw.to_string())
}

// ============ 维度三：请求熵监控器 ============

/// 请求熵监控器（Shannon 熵）
///
/// 监控最近 N 个请求的模式熵值。熵值低 = 请求模式过于规则 = 易被风控识别。
/// 触发阈值时自动注入假请求（如 /favicon.ico），提高熵值至人类浏览水平。
pub struct EntropyMonitor {
    /// 最近请求的"特征签名"列表（如 "GET /api/users 200"）
    /// 用滑动窗口限制内存：上限 128
    recent_patterns: Vec<String>,
    /// 当前熵值
    current_entropy: f64,
    /// 触发注入的熵阈值（默认 2.0，越低越严格）
    threshold: f64,
}

impl Default for EntropyMonitor {
    fn default() -> Self {
        Self {
            recent_patterns: Vec::with_capacity(128),
            current_entropy: 0.0,
            threshold: 2.0,
        }
    }
}

impl EntropyMonitor {
    pub fn new(threshold: f64) -> Self {
        Self {
            threshold,
            ..Default::default()
        }
    }

    /// 记录一次请求模式
    pub fn record(&mut self, pattern: impl Into<String>) {
        self.recent_patterns.push(pattern.into());
        if self.recent_patterns.len() > 128 {
            self.recent_patterns.remove(0);
        }
        self.recompute_entropy();
    }

    /// 重新计算熵值
    fn recompute_entropy(&mut self) {
        if self.recent_patterns.is_empty() {
            self.current_entropy = 0.0;
            return;
        }
        let mut counts: HashMap<String, u32> = HashMap::new();
        for p in &self.recent_patterns {
            *counts.entry(p.clone()).or_insert(0) += 1;
        }
        let total = self.recent_patterns.len() as f64;
        let entropy: f64 = counts
            .values()
            .map(|&c| {
                let p = c as f64 / total;
                -p * p.log2()
            })
            .sum();
        self.current_entropy = entropy;
    }

    /// 当前熵值
    pub fn entropy(&self) -> f64 {
        self.current_entropy
    }

    /// 是否需要注入假请求提高熵值
    pub fn needs_noise(&self) -> bool {
        self.current_entropy < self.threshold && self.recent_patterns.len() >= 8
    }

    /// 生成一个假请求路径（用于熵注入）
    pub fn noise_path() -> &'static str {
        with_rng(|rng| {
            rng.pick(&[
                "/favicon.ico",
                "/robots.txt",
                "/sitemap.xml",
                "/manifest.json",
                "/static/logo.png",
            ])
            .copied()
            .unwrap_or("/favicon.ico")
        })
    }
}

// ============ 维度二：OS 指纹配置预设 ============

/// 操作系统指纹配置（应用层可控制部分）
///
/// 注：TCP/IP 内核层指纹（SYN 选项 / Window Scale / TTL）需 raw socket，
/// 桌面场景不可行。这里仅配置应用层可控制部分（User-Agent + Accept 头），
/// 通过 reqwest builder 应用到实际请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OsFingerprint {
    /// 操作系统标识
    pub os: String,
    /// User-Agent 字符串
    pub user_agent: String,
    /// Accept-Language 偏好
    pub accept_language: String,
    /// 默认 Accept 头
    pub accept: String,
    /// 浏览器族（决定头序）
    pub browser: BrowserFamily,
}

impl OsFingerprint {
    /// Windows 10 + Chrome（最常见组合）
    pub fn win10_chrome() -> Self {
        Self {
            os: "Windows 10".into(),
            user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36".into(),
            accept_language: "zh-CN,zh;q=0.9,en;q=0.8".into(),
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8".into(),
            browser: BrowserFamily::Chrome,
        }
    }

    /// macOS + Safari
    pub fn macos_safari() -> Self {
        Self {
            os: "macOS".into(),
            user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15".into(),
            accept_language: "zh-CN,zh;q=0.9".into(),
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8".into(),
            browser: BrowserFamily::Safari,
        }
    }

    /// Linux + Firefox
    pub fn linux_firefox() -> Self {
        Self {
            os: "Linux".into(),
            user_agent: "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0".into(),
            accept_language: "en-US,en;q=0.5".into(),
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8".into(),
            browser: BrowserFamily::Firefox,
        }
    }

    /// Android + Chrome Mobile
    pub fn android_chrome() -> Self {
        Self {
            os: "Android".into(),
            user_agent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36".into(),
            accept_language: "zh-CN,zh;q=0.9,en-US;q=0.8".into(),
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8".into(),
            browser: BrowserFamily::Chrome,
        }
    }

    /// 随机选择一个指纹（加权分布对齐真实用户群）
    pub fn random_weighted() -> Self {
        // 真实分布参考：Win+Chrome 65% / macOS+Safari 15% / Linux+Firefox 8% / Android+Chrome 12%
        let r = with_rng(|rng| rng.next_f64());
        if r < 0.65 {
            Self::win10_chrome()
        } else if r < 0.80 {
            Self::macos_safari()
        } else if r < 0.88 {
            Self::linux_firefox()
        } else {
            Self::android_chrome()
        }
    }

    /// 所有可用预设
    pub fn all_presets() -> Vec<Self> {
        vec![
            Self::win10_chrome(),
            Self::macos_safari(),
            Self::linux_firefox(),
            Self::android_chrome(),
        ]
    }
}

// ============ 整形器：组装一次请求的所有混淆参数 ============

/// 单次请求整形建议（前端 / 调用方根据这些参数构造 reqwest 请求）
#[derive(Debug, Clone, Serialize)]
pub struct ShapingAdvice {
    /// 推荐的下一次请求间隔（毫秒）
    pub interval_ms: u64,
    /// 是否处于突发期
    pub in_burst: bool,
    /// 推荐的 OS 指纹
    pub fingerprint: OsFingerprint,
    /// 推荐的请求头顺序
    pub header_order: Vec<String>,
    /// 是否需要注入假请求（熵值过低）
    pub needs_noise: bool,
    /// 假请求路径（needs_noise=true 时有效）
    pub noise_path: Option<String>,
    /// 当前会话熵值
    pub current_entropy: f64,
}

/// 全局熵监控器（会话级单例）
static GLOBAL_ENTROPY: once_cell::sync::Lazy<Mutex<EntropyMonitor>> =
    once_cell::sync::Lazy::new(|| Mutex::new(EntropyMonitor::default()));

/// 记录一次请求模式到全局监控器
pub fn record_request_pattern(pattern: &str) {
    GLOBAL_ENTROPY.lock().record(pattern);
}

/// 生成下一次请求的整形建议
pub fn next_advice() -> ShapingAdvice {
    let (interval_ms, in_burst) = burst_silence_interval();
    let fingerprint = OsFingerprint::random_weighted();
    let header_order = randomize_header_order(fingerprint.browser);

    let (needs_noise, current_entropy, noise_path) = {
        let monitor = GLOBAL_ENTROPY.lock();
        (
            monitor.needs_noise(),
            monitor.entropy(),
            if monitor.needs_noise() {
                Some(EntropyMonitor::noise_path().to_string())
            } else {
                None
            },
        )
    };

    ShapingAdvice {
        interval_ms,
        in_burst,
        fingerprint,
        header_order,
        needs_noise,
        noise_path,
        current_entropy,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_xorshift_distribution() {
        let mut rng = XorShift::new(42);
        // 用 f64 累加避免 u64 溢出（统计性质检查）
        let mut sum = 0f64;
        let n = 10000;
        for _ in 0..n {
            sum += rng.next_u64() as f64;
        }
        // 平均值应在 u64 范围中部附近
        let avg = sum / n as f64;
        let mid = u64::MAX as f64 / 2.0;
        assert!(avg > u64::MAX as f64 / 4.0 && avg < mid * 1.5);
    }

    #[test]
    fn test_poisson_interval() {
        let interval = poisson_interval_ms(1.0);
        // 间隔应在 [50ms, 30s] 范围内
        assert!(interval >= 50 && interval <= 30_000);
    }

    #[test]
    fn test_header_order_chrome() {
        let order = randomize_header_order(BrowserFamily::Chrome);
        assert!(!order.is_empty());
        // Host 应在最前面（Chrome 高频头序）
        assert_eq!(order[0], "Host");
    }

    #[test]
    fn test_json_obfuscation() {
        let raw = r#"{"username":"alice","password":"secret"}"#;
        let obfuscated = obfuscate_json_payload(raw);
        // 应能解析回 JSON 对象
        let v: serde_json::Value = serde_json::from_str(&obfuscated).unwrap();
        assert!(v.is_object());
        // 业务字段保留
        assert_eq!(v["username"], "alice");
        assert_eq!(v["password"], "secret");
        // 冗余字段存在
        assert!(v.get("_ts").is_some());
        assert!(v.get("_nonce").is_some());
        assert!(v.get("_comment").is_some());
    }

    #[test]
    fn test_json_obfuscation_non_json() {
        let raw = "not a json";
        let obfuscated = obfuscate_json_payload(raw);
        assert_eq!(obfuscated, raw);
    }

    #[test]
    fn test_entropy_monitor() {
        let mut monitor = EntropyMonitor::new(2.0);
        // 单一模式 → 熵为 0
        for _ in 0..20 {
            monitor.record("GET /api/users 200");
        }
        assert_eq!(monitor.entropy(), 0.0);
        assert!(monitor.needs_noise());

        // 新 monitor 验证多样化模式（避免单一模式的残留影响）
        let mut monitor2 = EntropyMonitor::new(2.0);
        let patterns = ["GET /a 200", "GET /b 200", "POST /c 201", "GET /d 404"];
        for i in 0..40 {
            monitor2.record(patterns[i % patterns.len()]);
        }
        // 4 个均匀分布的模式 → 熵 = log2(4) = 2.0
        assert!((monitor2.entropy() - 2.0).abs() < 0.01);
    }

    #[test]
    fn test_os_fingerprint_random() {
        let fp = OsFingerprint::random_weighted();
        assert!(!fp.user_agent.is_empty());
        assert!(!fp.os.is_empty());
    }

    #[test]
    fn test_next_advice() {
        let advice = next_advice();
        assert!(advice.interval_ms >= 50 && advice.interval_ms <= 30_000);
        assert!(!advice.header_order.is_empty());
        assert!(!advice.fingerprint.user_agent.is_empty());
    }
}
