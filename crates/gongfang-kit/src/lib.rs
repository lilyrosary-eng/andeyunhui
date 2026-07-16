//! 攻防模块后端内核
//!
//! 架构：双轨制事件溯源（Dual-Track Event Sourcing）
//! - 控制面（AI 常驻推理核）：tokio::broadcast 下发策略补丁，绝不等待 I/O
//! - 数据面（执行引擎）：50ms Tick 循环，tokio::process 编排，绝不等待 AI
//! - 热交换：arc-swap 无锁 CAS 替换策略指针，亚毫秒级切换，零暂停
//! - 抢占：crossbeam 优先级队列接收 @focus/@bypass，软着陆过渡
//!
//! 隔离：重型依赖在 feature flag 后（crawler/reverse/pentest/automation/gateway），
//! 默认构建仅含 kernel 骨架 + commands stub，主二进制零污染。

pub mod ai;
pub mod kernel;
pub mod commands;

#[cfg(feature = "crawler")]
pub mod crawler;
#[cfg(feature = "reverse")]
pub mod reverse;
#[cfg(feature = "pentest")]
pub mod pentest;
#[cfg(feature = "automation")]
pub mod automation;
#[cfg(feature = "gateway")]
pub mod gateway;

pub use kernel::KernelEngine;
