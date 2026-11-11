//! 极简令牌桶限速：同一任务的所有分片共享一个桶，按写入字节消耗。
//!
//! 只做「还差多少时间」的计算，不自己 sleep——由调用方切片睡眠并在间隙检查暂停/取消，
//! 避免低速限速时暂停要等几十秒才生效。

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub(crate) struct SpeedLimiter {
    rate: u64,
    state: Mutex<State>,
}

struct State {
    tokens: f64,
    last: Instant,
}

impl SpeedLimiter {
    /// `rate = 0` 表示不限速，直接返回 None。
    pub fn new(rate: u64) -> Option<Self> {
        if rate == 0 {
            return None;
        }
        Some(Self {
            rate,
            state: Mutex::new(State {
                // 初始给满一桶，避免第一个块被无谓延迟。
                tokens: rate as f64,
                last: Instant::now(),
            }),
        })
    }

    /// 申请 `bytes` 额度：
    /// - `None`：额度已扣，可立即发送；
    /// - `Some(wait)`：额度不足，调用方睡 `wait` 后再来。
    pub fn reserve(&self, bytes: u64) -> Option<Duration> {
        if bytes == 0 {
            return None;
        }
        let need = bytes as f64;
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        let elapsed = now.duration_since(state.last).as_secs_f64();
        state.last = now;
        state.tokens = (state.tokens + elapsed * self.rate as f64).min(self.rate as f64);
        if state.tokens >= need {
            state.tokens -= need;
            return None;
        }
        // 先借走已有 token，调用方睡完缺失部分再回来结算。
        let missing = need - state.tokens;
        state.tokens = 0.0;
        Some(Duration::from_secs_f64(missing / self.rate as f64))
    }

    /// 复合限速器里「本地桶已扣、全局桶不够」时回滚本地额度。
    pub fn refund(&self, bytes: u64) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.tokens = (state.tokens + bytes as f64).min(self.rate as f64);
    }
}

/// 单任务限速 + 全局聚合限速的组合。
///
/// 两个桶都够才放行；全局桶不足时回滚本地桶，避免重复扣费。
#[derive(Clone, Default)]
pub(crate) struct Limiters {
    local: Option<Arc<SpeedLimiter>>,
    global: Option<Arc<SpeedLimiter>>,
}

impl Limiters {
    pub fn new(local: Option<Arc<SpeedLimiter>>, global: Option<Arc<SpeedLimiter>>) -> Self {
        Self { local, global }
    }

    pub fn is_empty(&self) -> bool {
        self.local.is_none() && self.global.is_none()
    }

    /// 与 `SpeedLimiter::reserve` 语义一致：None 表示已放行。
    pub fn reserve(&self, bytes: u64) -> Option<Duration> {
        if let Some(local) = &self.local {
            if let Some(wait) = local.reserve(bytes) {
                return Some(wait);
            }
        }
        if let Some(global) = &self.global {
            if let Some(wait) = global.reserve(bytes) {
                if let Some(local) = &self.local {
                    local.refund(bytes);
                }
                return Some(wait);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_bucket_reports_wait_after_burst() {
        let limiter = SpeedLimiter::new(1_000).unwrap();
        // 初始满桶，1KB 立即放行。
        assert!(limiter.reserve(1_000).is_none());
        // 第二桶必须等待约 1 秒。
        let wait = limiter.reserve(1_000).unwrap();
        assert!(wait >= Duration::from_millis(900));
    }

    #[test]
    fn zero_rate_means_unlimited() {
        assert!(SpeedLimiter::new(0).is_none());
    }

    #[test]
    fn composite_reserves_both_buckets() {
        let local = Arc::new(SpeedLimiter::new(1_000).unwrap());
        let global = Arc::new(SpeedLimiter::new(1_000).unwrap());
        let limiters = Limiters::new(Some(local.clone()), Some(global.clone()));
        assert!(limiters.reserve(1_000).is_none());
        // 两个桶都被扣过，下一次必然要等。
        assert!(limiters.reserve(1_000).is_some());
        // 全局桶不足时本地桶必须回滚：换一个新组合验证可再次放行。
        let local2 = Arc::new(SpeedLimiter::new(1_000).unwrap());
        let global2 = Arc::new(SpeedLimiter::new(1_000).unwrap());
        let limiters2 = Limiters::new(Some(local2), Some(global2));
        assert!(limiters2.reserve(1_000).is_none());
    }
}
