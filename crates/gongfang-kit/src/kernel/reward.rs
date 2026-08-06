//! 全局奖励信号：滑动窗口错误计数 + 规则加权（非 RL，桌面场景启发式足够）
//!
//! 替代 Rainbow DQN 在线强化学习（桌面无 GPU 推理，规则加权足够）
//! 替代 FFT 错误率频谱分析（滑动窗口计数足够）

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// 单次事件结果
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum EventKind {
    /// 获得有效凭证
    Credential,
    /// 请求成功
    Success,
    /// 请求被拒（403/429）
    Rejected,
    /// 触发 WAF 告警
    WafAlert,
    /// 超时
    Timeout,
    /// 校验失败
    ValidationError,
}

impl EventKind {
    /// 规则加权（替代 RL 奖励函数）
    fn reward(self) -> i32 {
        match self {
            EventKind::Credential => 10,
            EventKind::Success => 1,
            EventKind::Rejected => -5,
            EventKind::WafAlert => -20,
            EventKind::Timeout => -3,
            EventKind::ValidationError => -2,
        }
    }

    /// 是否为错误（计入错误率）
    pub fn is_error(self) -> bool {
        matches!(
            self,
            EventKind::Rejected | EventKind::WafAlert | EventKind::Timeout | EventKind::ValidationError
        )
    }
}

const WINDOW_SIZE: usize = 128;

/// 滑动窗口奖励信号（128 位窗口，替代 128 位 FFT 频谱）
pub struct RewardSignal {
    inner: Mutex<RewardInner>,
}

struct RewardInner {
    window: std::collections::VecDeque<EventKind>,
    total_reward: i64,
}

impl RewardSignal {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(RewardInner {
                window: std::collections::VecDeque::with_capacity(WINDOW_SIZE),
                total_reward: 0,
            }),
        }
    }

    /// 记录一次事件
    pub fn record(&self, kind: EventKind) {
        let mut inner = self.inner.lock();
        if inner.window.len() >= WINDOW_SIZE {
            if let Some(old) = inner.window.pop_front() {
                inner.total_reward -= old.reward() as i64;
            }
        }
        inner.total_reward += kind.reward() as i64;
        inner.window.push_back(kind);
        // 计算快照值并推送事件（避免在锁内调用 try_emit 触发事件总线锁）
        let total = inner.total_reward;
        let err_rate = if inner.window.is_empty() {
            0.0
        } else {
            let errors = inner.window.iter().filter(|e| e.is_error()).count();
            errors as f64 / inner.window.len() as f64
        };
        drop(inner);

        // 通过全局事件总线推送（如果内核已启动，则前端能收到）
        super::events::try_emit(super::events::KernelEvent::RewardRecorded {
            ts: super::events::now_ts(),
            event_kind: kind,
            total_reward: total,
            error_rate: err_rate,
        });
    }

    /// 当前错误率（0.0-1.0），用于数据面回滚判断
    pub fn error_rate(&self) -> f64 {
        let inner = self.inner.lock();
        if inner.window.is_empty() {
            return 0.0;
        }
        let errors = inner.window.iter().filter(|e| e.is_error()).count();
        errors as f64 / inner.window.len() as f64
    }

    /// 累计奖励（供 AI 推理时参考策略效果）
    pub fn total_reward(&self) -> i64 {
        self.inner.lock().total_reward
    }

    /// 错误率是否超过回滚阈值（>50% 则数据面自动回滚策略）
    pub fn should_rollback(&self) -> bool {
        self.error_rate() > 0.5
    }
}

// ================= 零测试治理：现状固化单元测试 =================
// 纪律：期望值一律取当前真实行为；窗口边界含 128 连续错误滑出验证。
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_kind_reward_weights() {
        assert_eq!(EventKind::Credential.reward(), 10);
        assert_eq!(EventKind::Success.reward(), 1);
        assert_eq!(EventKind::Rejected.reward(), -5);
        assert_eq!(EventKind::WafAlert.reward(), -20);
        assert_eq!(EventKind::Timeout.reward(), -3);
        assert_eq!(EventKind::ValidationError.reward(), -2);
    }

    #[test]
    fn test_event_kind_is_error() {
        assert!(EventKind::Rejected.is_error());
        assert!(EventKind::WafAlert.is_error());
        assert!(EventKind::Timeout.is_error());
        assert!(EventKind::ValidationError.is_error());
        assert!(!EventKind::Credential.is_error());
        assert!(!EventKind::Success.is_error());
    }

    #[test]
    fn test_reward_signal_empty() {
        let s = RewardSignal::new();
        assert_eq!(s.error_rate(), 0.0);
        assert_eq!(s.total_reward(), 0);
        assert!(!s.should_rollback());
    }

    #[test]
    fn test_reward_signal_basic() {
        let s = RewardSignal::new();
        s.record(EventKind::Credential);
        assert_eq!(s.total_reward(), 10);
        assert_eq!(s.error_rate(), 0.0);
        s.record(EventKind::Rejected);
        assert_eq!(s.total_reward(), 5);
        assert_eq!(s.error_rate(), 0.5);
        // 恰好 0.5 不触发回滚（阈值是 >0.5）
        assert!(!s.should_rollback());
    }

    #[test]
    fn test_should_rollback_above_half() {
        let s = RewardSignal::new();
        s.record(EventKind::Success);
        s.record(EventKind::Rejected);
        s.record(EventKind::WafAlert);
        assert_eq!(s.error_rate(), 2.0 / 3.0);
        assert!(s.should_rollback());
    }

    #[test]
    fn test_mixed_window_exactly_half() {
        let s = RewardSignal::new();
        for _ in 0..64 {
            s.record(EventKind::Rejected);
        }
        for _ in 0..64 {
            s.record(EventKind::Success);
        }
        assert_eq!(s.error_rate(), 0.5);
        assert!(!s.should_rollback());
    }

    #[test]
    fn test_window_boundary_128_errors_slide_out() {
        let s = RewardSignal::new();
        for _ in 0..128 {
            s.record(EventKind::Rejected);
        }
        assert_eq!(s.error_rate(), 1.0);
        assert!(s.should_rollback());
        assert_eq!(s.total_reward(), -640); // 128 * -5

        // 第 129 条开始：最老的错误被挤出窗口
        for _ in 0..128 {
            s.record(EventKind::Success);
        }
        assert_eq!(s.error_rate(), 0.0, "128 个错误全部滑出窗口");
        assert!(!s.should_rollback());
        // 128 次 Success 全部挤入：每个挤出 -5 错误(+5) 且自身 +1，净 +6*128=+768，-640+768=128
        assert_eq!(s.total_reward(), 128);

        // 窗口长度始终不超过 128
        s.record(EventKind::WafAlert);
        assert_eq!(s.error_rate(), 1.0 / 128.0);
        assert!(!s.should_rollback());
    }

    #[test]
    fn test_window_partial_slide() {
        let s = RewardSignal::new();
        for _ in 0..128 {
            s.record(EventKind::Rejected);
        }
        s.record(EventKind::Success);
        assert_eq!(s.error_rate(), 127.0 / 128.0);
        assert!(s.should_rollback());
        s.record(EventKind::Success);
        assert_eq!(s.error_rate(), 126.0 / 128.0);
        assert!(s.should_rollback());
    }
}
