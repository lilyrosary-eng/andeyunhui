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
