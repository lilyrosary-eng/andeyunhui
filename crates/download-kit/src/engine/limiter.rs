//! 极简令牌桶限速：同一任务的所有分片共享一个桶，按写入字节消耗。
//!
//! 只做「还差多少时间」的计算，不自己 sleep——由调用方切片睡眠并在间隙检查暂停/取消，
//! 避免低速限速时暂停要等几十秒才生效。

use std::sync::Mutex;
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
}
