//! 策略热交换：arc-swap 无锁 CAS，亚毫秒级切换 + 双缓冲错误率回滚
//!
//! 替代 Cryo-Snapshot COW（桌面无 COW 收益，arc-swap generation 足够）

use arc_swap::ArcSwap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// 攻防状态机
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Phase {
    Idle,
    Recon,
    Exploit,
    Pivot,
    Clean,
}

impl Default for Phase {
    fn default() -> Self {
        Phase::Idle
    }
}

/// 当前生效策略（数据面每 50ms Tick 读取一次）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Strategy {
    pub phase: Phase,
    /// 全局 QPS 上限
    pub qps: u32,
    /// 每出口 IP 最大并发
    pub per_ip_concurrency: u32,
    /// 当前 TLS 指纹档案（如 "chrome_122"）
    pub tls_profile: String,
    /// 隐身等级 0-100
    pub stealth_level: u8,
    /// 目标 URL（@focus 指定）
    pub focus_url: Option<String>,
    /// 是否启用浏览器模式（true）或纯 HTTP（false）
    pub use_browser: bool,
    /// 代理池标签
    pub proxy_pool_tag: String,
    /// generation 号（每次热交换递增）
    pub generation: u64,
}

/// 策略增量补丁（控制面下发，仅含变更项）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StrategyDelta {
    pub qps: Option<u32>,
    pub per_ip_concurrency: Option<u32>,
    pub tls_profile: Option<String>,
    pub stealth_level: Option<u8>,
    pub focus_url: Option<Option<String>>,
    pub use_browser: Option<bool>,
    pub proxy_pool_tag: Option<String>,
    pub phase: Option<Phase>,
}

impl StrategyDelta {
    /// 将增量应用到当前策略，生成新 generation
    pub fn apply_to(&self, base: &Strategy) -> Strategy {
        Strategy {
            generation: base.generation.wrapping_add(1),
            qps: self.qps.unwrap_or(base.qps),
            per_ip_concurrency: self.per_ip_concurrency.unwrap_or(base.per_ip_concurrency),
            tls_profile: self.tls_profile.clone().unwrap_or_else(|| base.tls_profile.clone()),
            stealth_level: self.stealth_level.unwrap_or(base.stealth_level),
            focus_url: self.focus_url.clone().unwrap_or_else(|| base.focus_url.clone()),
            use_browser: self.use_browser.unwrap_or(base.use_browser),
            proxy_pool_tag: self.proxy_pool_tag.clone().unwrap_or_else(|| base.proxy_pool_tag.clone()),
            phase: self.phase.unwrap_or(base.phase),
        }
    }
}

/// 策略存储：arc-swap 无锁热交换 + 上一代回滚缓冲
pub struct StrategyStore {
    current: ArcSwap<Strategy>,
    /// 上一代策略（错误率飙升时自动回滚）
    prev: parking_lot::Mutex<Option<Arc<Strategy>>>,
}

impl StrategyStore {
    pub fn new() -> Self {
        let initial = Strategy {
            qps: 5,
            per_ip_concurrency: 2,
            tls_profile: "chrome_122".to_string(),
            stealth_level: 50,
            ..Default::default()
        };
        Self {
            current: ArcSwap::from_pointee(initial),
            prev: parking_lot::Mutex::new(None),
        }
    }

    /// 无锁读取当前策略（数据面 Tick 调用，亚毫秒级）
    pub fn load(&self) -> Strategy {
        (**self.current.load()).clone()
    }

    /// 热交换：保存旧策略到 prev，原子替换当前策略
    pub fn commit(&self, delta: &StrategyDelta) -> Strategy {
        let old = self.current.load_full();
        let new = delta.apply_to(&old);
        *self.prev.lock() = Some(old);
        self.current.store(Arc::new(new.clone()));
        log::info!(
            "[kernel] 策略热交换 gen={} phase={:?} qps={}",
            new.generation,
            new.phase,
            new.qps
        );
        new
    }

    /// 错误率飙升时回滚到上一代（数据面自动触发，无需 AI 介入）
    pub fn rollback(&self) -> Option<Strategy> {
        let prev = self.prev.lock().take()?;
        self.current.store(prev);
        let rolled = self.load();
        log::warn!("[kernel] 策略回滚到 gen={}", rolled.generation);
        Some(rolled)
    }
}
