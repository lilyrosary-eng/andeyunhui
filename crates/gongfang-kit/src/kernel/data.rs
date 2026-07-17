//! 数据面：执行引擎
//!
//! 职责：50ms Tick 循环，读取当前策略指针，按 Phase 分发执行。
//! 绝不等待 AI：控制面超时不阻塞数据面。
//! 错误率回滚：reward.should_rollback() 触发 strategy.rollback()。
//! 软着陆：Barrier 指令（Pause/Focus）3 Tick 过渡 Idle，连接保持 Active。
//!
//! 事件总线集成：
//! - 每 Tick 推送 KernelEvent::Tick（默认不 emit 前端，仅入缓冲区）
//! - Phase 分发执行后推送 PhaseExecuted（含 focus_url）
//! - 软着陆进度推送 SoftLanding
//! - 错误率回滚推送 Rollback（含 from_gen/to_gen）

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;

use super::events::{self, EventBus};
use super::reward::RewardSignal;
use super::strategy::{Phase, StrategyDelta, StrategyStore};

const TICK: Duration = Duration::from_millis(50);
const SOFT_LANDING_TICKS: u8 = 3;

pub struct DataPlane {
    strategy: Arc<StrategyStore>,
    reward: Arc<RewardSignal>,
    rx: broadcast::Receiver<StrategyDelta>,
    event_bus: Arc<EventBus>,
    barrier_ticks: u8,
}

impl DataPlane {
    pub fn new(
        strategy: Arc<StrategyStore>,
        reward: Arc<RewardSignal>,
        rx: broadcast::Receiver<StrategyDelta>,
        event_bus: Arc<EventBus>,
    ) -> Self {
        Self {
            strategy,
            reward,
            rx,
            event_bus,
            barrier_ticks: 0,
        }
    }

    pub async fn run(mut self) {
        log::info!("[data] 数据面启动，Tick={}ms", TICK.as_millis());
        loop {
            tokio::select! {
                _ = tokio::time::sleep(TICK) => self.tick().await,
                Ok(_delta) = self.rx.recv() => {
                    // 控制面已 commit，数据面无需重复操作，仅记日志
                    log::debug!("[data] 收到策略热交换通知");
                }
            }
        }
    }

    async fn tick(&mut self) {
        let s = self.strategy.load();

        // 推送 Tick 事件（默认不 emit 前端，仅入缓冲区）
        self.event_bus.push(events::KernelEvent::Tick {
            ts: events::now_ts(),
            generation: s.generation,
            phase: s.phase,
        });

        // 软着陆：Barrier 指令触发后 3 Tick 过渡 Idle
        if self.barrier_ticks > 0 {
            self.barrier_ticks -= 1;
            log::info!(
                "[data] 软着陆中，剩余 {} Tick",
                self.barrier_ticks
            );
            events::emit_soft_landing(&self.event_bus, self.barrier_ticks);
            if self.barrier_ticks == 0 {
                self.strategy.commit(&StrategyDelta {
                    phase: Some(Phase::Idle),
                    ..Default::default()
                });
            }
        }

        // 错误率回滚（数据面自动触发，无需 AI 介入）
        if self.reward.should_rollback() {
            let from_gen = s.generation;
            if let Some(rolled) = self.strategy.rollback() {
                log::warn!("[data] 错误率 >50%，已回滚策略");
                events::emit_rollback(&self.event_bus, from_gen, rolled.generation);
            }
        }

        // 按 Phase 分发执行
        match s.phase {
            Phase::Idle => {}
            Phase::Recon => {
                self.execute_recon(&s).await;
                events::emit_phase_executed(&self.event_bus, Phase::Recon, s.focus_url.clone());
            }
            Phase::Exploit => {
                self.execute_exploit(&s).await;
                events::emit_phase_executed(&self.event_bus, Phase::Exploit, s.focus_url.clone());
            }
            Phase::Pivot => {
                self.execute_pivot(&s).await;
                events::emit_phase_executed(&self.event_bus, Phase::Pivot, s.focus_url.clone());
            }
            Phase::Clean => {
                self.execute_clean(&s).await;
                events::emit_phase_executed(&self.event_bus, Phase::Clean, s.focus_url.clone());
            }
        }
    }

    #[cfg(feature = "crawler")]
    async fn execute_recon(&self, s: &super::strategy::Strategy) {
        crate::crawler::execute_recon(s, &self.reward).await;
    }
    #[cfg(not(feature = "crawler"))]
    async fn execute_recon(&self, s: &super::strategy::Strategy) {
        log::debug!(
            "[data] Recon phase (crawler feature 未启用) focus={:?}",
            s.focus_url
        );
    }

    #[cfg(feature = "pentest")]
    async fn execute_exploit(&self, s: &super::strategy::Strategy) {
        crate::pentest::execute_exploit(s, &self.reward).await;
    }
    #[cfg(not(feature = "pentest"))]
    async fn execute_exploit(&self, s: &super::strategy::Strategy) {
        log::debug!(
            "[data] Exploit phase (pentest feature 未启用) focus={:?}",
            s.focus_url
        );
    }

    #[cfg(feature = "automation")]
    async fn execute_pivot(&self, s: &super::strategy::Strategy) {
        crate::automation::execute_pivot(s, &self.reward).await;
    }
    #[cfg(not(feature = "automation"))]
    async fn execute_pivot(&self, _s: &super::strategy::Strategy) {}

    async fn execute_clean(&self, _s: &super::strategy::Strategy) {
        log::info!("[data] Clean phase，清理会话");
    }
}

impl DataPlane {
    /// 标记软着陆（由外部 Barrier 指令触发）
    #[allow(dead_code)]
    pub fn trigger_soft_landing(&mut self) {
        self.barrier_ticks = SOFT_LANDING_TICKS;
    }
}
