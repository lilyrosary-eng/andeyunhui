//! 代理池：轮换分配 + 故障标记 + 代理故障分类
//!
//! 替代 Netns 网络命名空间（Windows 不可用，进程级 SOCKS5/HTTP 代理足够）
//!
//! 设计借鉴 Scrapling（BSD 3-Clause, © Karim shoair）的 ProxyRotator：
//! - 可插拔轮换策略（Cyclic / Random）
//! - O(1) 键索引，避免 mark_dead 线性扫描
//! - `is_proxy_error` 区分「代理链路故障」与「目标拒绝」，避免误杀健康代理

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyEntry {
    /// 代理 URL：socks5://host:port 或 http://host:port
    pub url: String,
    pub tag: String,
    pub alive: bool,
}

/// 轮换策略
///
/// 借鉴 Scrapling 的 RotationStrategy：默认顺序轮换，可切换随机。
/// 顺序轮换对「多代理均摊配额」更友好；随机轮换对「规避固定指纹规律」更友好。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RotationStrategy {
    /// 顺序轮换（默认）：均摊各代理使用次数
    Cyclic,
    /// 随机轮换：打散使用顺序，避免周期性特征
    Random,
}

impl Default for RotationStrategy {
    fn default() -> Self {
        Self::Cyclic
    }
}

impl RotationStrategy {
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "cyclic" | "round_robin" | "rr" => Some(Self::Cyclic),
            "random" | "rand" => Some(Self::Random),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Cyclic => "cyclic",
            Self::Random => "random",
        }
    }

    fn to_u8(self) -> u8 {
        match self {
            Self::Cyclic => 0,
            Self::Random => 1,
        }
    }

    fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::Random,
            _ => Self::Cyclic,
        }
    }
}

// ============ 代理故障分类（借鉴 Scrapling proxy_rotation._PROXY_ERROR_INDICATORS） ============

/// 代理链路故障特征
///
/// 语义：当请求经过代理时，出现这些错误多半是「代理链路」而非「目标服务」的问题，
/// 应轮换到下一个代理重试，而不是把目标判定为不可达。
///
/// 注意 `connection refused/reset/timed out` 本身是传输层通用错误：
/// 直连场景下代表目标端口不可达；经代理场景下则优先归因于代理。
/// 故调用方应仅在「确实用了代理」时才据此轮换。
const PROXY_ERROR_INDICATORS: &[&str] = &[
    "net::err_proxy",
    "net::err_tunnel",
    "err_proxy",
    "err_tunnel",
    "could not resolve proxy",
    "proxy connect",
    "proxy connection",
    "socks",
    "connection refused",
    "connection reset",
    "connection timed out",
    "failed to connect",
    "tunnel connection failed",
];

/// 判断错误信息是否属于「代理链路故障」
///
/// 与「目标拒绝」（403/429/挑战页）区分：后者不应导致代理被标记死亡。
pub fn is_proxy_error(err: &str) -> bool {
    let lower = err.to_lowercase();
    PROXY_ERROR_INDICATORS.iter().any(|k| lower.contains(k))
}

/// 判断 HTTP 状态码是否属于「目标侧风控/异常」（应轮换代理，但不代表代理坏了）
pub fn is_target_rejection(status: u16) -> bool {
    matches!(status, 403 | 429) || status >= 500
}

// ============ 代理池 ============

pub struct ProxyPool {
    inner: Mutex<Vec<ProxyEntry>>,
    /// url → 下标，避免 mark_dead 线性扫描（借鉴 Scrapling 的 proxy_to_index）
    index: Mutex<HashMap<String, usize>>,
    cursor: Mutex<usize>,
    strategy: AtomicU8,
}

impl ProxyPool {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Vec::new()),
            index: Mutex::new(HashMap::new()),
            cursor: Mutex::new(0),
            strategy: AtomicU8::new(RotationStrategy::Cyclic.to_u8()),
        }
    }

    /// 设置轮换策略
    pub fn set_strategy(&self, s: RotationStrategy) {
        self.strategy.store(s.to_u8(), Ordering::Relaxed);
    }

    /// 当前轮换策略
    pub fn strategy(&self) -> RotationStrategy {
        RotationStrategy::from_u8(self.strategy.load(Ordering::Relaxed))
    }

    /// 添加代理（同 url 重复添加时更新 tag/存活态，不产生重复条目）
    pub fn add(&self, entry: ProxyEntry) {
        let mut idx = self.index.lock();
        if let Some(&i) = idx.get(&entry.url) {
            let mut inner = self.inner.lock();
            if let Some(p) = inner.get_mut(i) {
                p.tag = entry.tag;
                p.alive = entry.alive;
            }
            return;
        }
        let mut inner = self.inner.lock();
        idx.insert(entry.url.clone(), inner.len());
        inner.push(entry);
    }

    /// 按当前策略获取下一个存活代理
    pub fn next(&self) -> Option<ProxyEntry> {
        let inner = self.inner.lock();
        let alive: Vec<&ProxyEntry> = inner.iter().filter(|p| p.alive).collect();
        if alive.is_empty() {
            return None;
        }
        let pick = match self.strategy() {
            RotationStrategy::Cyclic => {
                let mut cursor = self.cursor.lock();
                let e = alive[*cursor % alive.len()];
                *cursor = (*cursor + 1) % alive.len();
                e
            }
            RotationStrategy::Random => alive[(rand_u64() as usize) % alive.len()],
        };
        Some(pick.clone())
    }

    /// 标记代理死亡（O(1) 定位）
    pub fn mark_dead(&self, url: &str) {
        let idx = self.index.lock();
        if let Some(&i) = idx.get(url) {
            let mut inner = self.inner.lock();
            if let Some(p) = inner.get_mut(i) {
                if p.alive {
                    p.alive = false;
                    log::warn!("[pool] 代理死亡: {}", url);
                }
            }
        }
    }

    /// 按请求错误信息标记代理：仅当错误属于代理链路故障时才标记死亡。
    /// 返回是否标记了死亡（便于调用方决定是否换代理重试）。
    pub fn mark_dead_if_proxy_error(&self, url: &str, err: &str) -> bool {
        if is_proxy_error(err) {
            self.mark_dead(url);
            true
        } else {
            false
        }
    }

    /// 存活代理数
    pub fn count(&self) -> usize {
        self.inner.lock().iter().filter(|p| p.alive).count()
    }

    /// 列出全部代理（含死亡标记）
    pub fn list(&self) -> Vec<ProxyEntry> {
        self.inner.lock().clone()
    }

    /// 将所有代理重置为存活（换一轮/手动恢复时调用）
    pub fn reset(&self) {
        for p in self.inner.lock().iter_mut() {
            p.alive = true;
        }
    }
}

impl Default for ProxyPool {
    fn default() -> Self {
        Self::new()
    }
}

/// 轻量随机数（xorshift64，单次取值）。
///
/// 用途仅为「打散代理选取顺序」，非密码学场景；避免为一次取值引入 rand 依赖。
fn rand_u64() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut x = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9E37_79B9_7F4A_7C15);
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    x
}

// ================= 全局代理池（供数据面 / 命令层共享） =================
// 与 EventBus / UrlQueue 的全局单例一致，无需穿过构造函数层层传递。

pub static POOL: once_cell::sync::Lazy<parking_lot::Mutex<ProxyPool>> =
    once_cell::sync::Lazy::new(|| parking_lot::Mutex::new(ProxyPool::new()));

/// 获取全局代理池句柄
pub fn pool() -> parking_lot::MutexGuard<'static, ProxyPool> {
    POOL.lock()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_proxy_error() {
        assert!(is_proxy_error("error sending request: net::ERR_PROXY_CONNECTION_FAILED"));
        assert!(is_proxy_error("could not resolve proxy: 127.0.0.1"));
        assert!(is_proxy_error("SOCKS handshake failed"));
        assert!(is_proxy_error("connection refused"));
        // 目标侧拒绝不应归为代理故障
        assert!(!is_proxy_error("HTTP 403 Forbidden"));
        assert!(!is_proxy_error("body decode error"));
    }

    #[test]
    fn test_target_rejection() {
        assert!(is_target_rejection(403));
        assert!(is_target_rejection(429));
        assert!(is_target_rejection(503));
        assert!(!is_target_rejection(404));
        assert!(!is_target_rejection(200));
    }

    #[test]
    fn test_pool_dedup_and_mark_dead() {
        let p = ProxyPool::new();
        p.add(ProxyEntry { url: "http://a:1".into(), tag: "t".into(), alive: true });
        p.add(ProxyEntry { url: "http://a:1".into(), tag: "t2".into(), alive: true });
        assert_eq!(p.list().len(), 1, "同 url 重复添加应去重");
        assert_eq!(p.list()[0].tag, "t2", "重复添加应更新 tag");

        p.add(ProxyEntry { url: "http://b:2".into(), tag: "t".into(), alive: true });
        assert_eq!(p.count(), 2);

        p.mark_dead("http://a:1");
        assert_eq!(p.count(), 1);
        assert!(p.next().map(|e| e.url == "http://b:2").unwrap_or(false));
    }

    #[test]
    fn test_mark_dead_only_on_proxy_error() {
        let p = ProxyPool::new();
        p.add(ProxyEntry { url: "http://a:1".into(), tag: "t".into(), alive: true });
        assert!(!p.mark_dead_if_proxy_error("http://a:1", "HTTP 403"));
        assert_eq!(p.count(), 1, "目标拒绝不应标记代理死亡");
        assert!(p.mark_dead_if_proxy_error("http://a:1", "connection refused"));
        assert_eq!(p.count(), 0);
    }

    #[test]
    fn test_strategy_parse() {
        assert_eq!(RotationStrategy::from_str("random"), Some(RotationStrategy::Random));
        assert_eq!(RotationStrategy::from_str("CYCLIC"), Some(RotationStrategy::Cyclic));
        assert_eq!(RotationStrategy::from_str("nope"), None);
    }

    #[test]
    fn test_random_strategy_returns_alive() {
        let p = ProxyPool::new();
        p.set_strategy(RotationStrategy::Random);
        p.add(ProxyEntry { url: "http://a:1".into(), tag: "t".into(), alive: true });
        p.add(ProxyEntry { url: "http://b:2".into(), tag: "t".into(), alive: true });
        for _ in 0..20 {
            assert!(p.next().is_some(), "随机策略应始终返回存活代理");
        }
    }
}