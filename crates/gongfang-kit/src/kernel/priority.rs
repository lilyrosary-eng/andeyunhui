//! 用户提示词抢占：crossbeam 无锁队列，@focus/@bypass/@pause 软着陆
//!
//! 用户指令写入对应优先级槽，控制面下一推理周期按 P0→P1→P2 顺序读取。
//!
//! 替代 Redis Sorted Set（02 文档原方案）：3 个 SegQueue 多级反馈队列，
//! 桌面场景足够，无需 Redis 原子操作。

use crossbeam_queue::SegQueue;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// 指令优先级（对应 02 文档 P0/P1/P2 分类）
///
/// - P0 IMMEDIATE：立即切换，软着陆过渡（Pause/Resume/Focus）
/// - P1 NEXT_STEP：下一推理周期注入（Bypass/Hook/Inject/Solve）
/// - P2 APPEND：排队等待（Raw 自然语言）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Priority {
    P0,
    P1,
    P2,
}

/// 用户指令（由前端 @focus/@bypass/@pause 等解析而来）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum UserCommand {
    /// 聚焦目标（切换攻击面）— P0
    Focus { url: String },
    /// 绕过指定挑战（cloudflare/waf/captcha）— P1
    Bypass { challenge: String },
    /// 暂停（软着陆：3 Tick 过渡 Idle，连接保持 Active）— P0
    Pause,
    /// 恢复 — P0
    Resume,
    /// 注入 Hook（逆向用）— P1
    Hook { func_name: String },
    /// 注入载荷（渗透用）— P1
    Inject { payload_type: String },
    /// 求解验证码（自动化用）— P1
    Solve { captcha_type: String },
    /// 自定义自然语言指令（AI 自行解析）— P2
    Raw { text: String },
}

impl UserCommand {
    /// 是否为 Barrier 指令（需软着陆过渡）
    pub fn is_barrier(&self) -> bool {
        matches!(self, UserCommand::Pause | UserCommand::Focus { .. })
    }

    /// 指令优先级（对应 02 文档 P0/P1/P2 分类）
    pub fn priority(&self) -> Priority {
        match self {
            UserCommand::Pause
            | UserCommand::Resume
            | UserCommand::Focus { .. } => Priority::P0,
            UserCommand::Bypass { .. }
            | UserCommand::Hook { .. }
            | UserCommand::Inject { .. }
            | UserCommand::Solve { .. } => Priority::P1,
            UserCommand::Raw { .. } => Priority::P2,
        }
    }
}

/// 无锁多级反馈优先级队列（MPMC，控制面与数据面共享读取）
///
/// 替代 Redis Sorted Set：3 个 SegQueue 分别对应 P0/P1/P2，
/// pop 时按 P0→P1→P2 顺序尝试，保证高优先级指令抢占。
pub struct PriorityCommandQueue {
    p0: Arc<SegQueue<UserCommand>>,
    p1: Arc<SegQueue<UserCommand>>,
    p2: Arc<SegQueue<UserCommand>>,
}

impl PriorityCommandQueue {
    pub fn new() -> Self {
        Self {
            p0: Arc::new(SegQueue::new()),
            p1: Arc::new(SegQueue::new()),
            p2: Arc::new(SegQueue::new()),
        }
    }

    /// 推入指令（前端 inject_command 调用，按 priority 分发到对应队列）
    pub fn push(&self, cmd: UserCommand) {
        match cmd.priority() {
            Priority::P0 => self.p0.push(cmd),
            Priority::P1 => self.p1.push(cmd),
            Priority::P2 => self.p2.push(cmd),
        }
    }

    /// 弹出指令（控制面每推理周期调用，按 P0→P1→P2 顺序）
    pub fn pop(&self) -> Option<UserCommand> {
        if let Some(cmd) = self.p0.pop() {
            return Some(cmd);
        }
        if let Some(cmd) = self.p1.pop() {
            return Some(cmd);
        }
        self.p2.pop()
    }

    /// 是否有待处理指令（数据面 Tick 末尾检查，决定是否触发抢占）
    pub fn has_pending(&self) -> bool {
        !self.p0.is_empty() || !self.p1.is_empty() || !self.p2.is_empty()
    }

    /// 是否有 P0 立即指令（数据面执行前检查点，对应 02 文档 IMMEDIATE）
    pub fn has_immediate(&self) -> bool {
        !self.p0.is_empty()
    }
}

impl Default for PriorityCommandQueue {
    fn default() -> Self {
        Self::new()
    }
}
