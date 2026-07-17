//! 双轨制内核：控制面（AI 推理）+ 数据面（执行）+ 热交换 + 抢占
//!
//! 不含 Linux 内核态能力（io_uring/eBPF/Netns），桌面场景用 tokio + arc-swap 足够。

pub mod control;
pub mod data;
pub mod events;
pub mod knowledge;
pub mod priority;
pub mod reward;
pub mod strategy;
pub mod workspace;

use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::broadcast;

use crate::ai::AiProfile;

use events::EventBus;

/// 内核引擎：持有双轨各组件 + 事件总线，统一启停
pub struct KernelEngine {
    pub strategy: Arc<strategy::StrategyStore>,
    pub priority: Arc<priority::PriorityCommandQueue>,
    pub reward: Arc<reward::RewardSignal>,
    pub control_tx: broadcast::Sender<strategy::StrategyDelta>,
    pub event_bus: Arc<EventBus>,
    pub app: AppHandle,
    pub profile: AiProfile,
}

impl KernelEngine {
    pub fn new(app: AppHandle, profile: AiProfile) -> Self {
        let (control_tx, _) = broadcast::channel(64);
        let event_bus = Arc::new(EventBus::new(app.clone()));
        Self {
            strategy: Arc::new(strategy::StrategyStore::new()),
            priority: Arc::new(priority::PriorityCommandQueue::new()),
            reward: Arc::new(reward::RewardSignal::new()),
            control_tx,
            event_bus,
            app,
            profile,
        }
    }

    /// 启动双轨（控制面 + 数据面），返回句柄用于停止
    pub fn start(&self) -> KernelHandle {
        // 安装全局事件总线（供命令层 try_emit 使用）
        events::install(self.event_bus.clone());
        events::emit_kernel_started(&self.event_bus);

        let control = control::ControlPlane::new(
            self.app.clone(),
            self.profile.clone(),
            self.strategy.clone(),
            self.priority.clone(),
            self.reward.clone(),
            self.control_tx.clone(),
            self.event_bus.clone(),
        );
        let data = data::DataPlane::new(
            self.strategy.clone(),
            self.reward.clone(),
            self.control_tx.subscribe(),
            self.event_bus.clone(),
        );

        let control_task = tokio::spawn(async move { control.run().await });
        let data_task = tokio::spawn(async move { data.run().await });

        KernelHandle {
            control_task,
            data_task,
        }
    }

    /// 注入用户提示词指令（@focus/@bypass/@pause 等）
    pub fn inject_command(&self, cmd: priority::UserCommand) {
        events::emit_user_command(&self.event_bus, cmd.clone());
        self.priority.push(cmd);
    }

    /// 当前快照状态（供前端查询）
    pub fn snapshot(&self) -> strategy::Strategy {
        self.strategy.load()
    }
}

pub struct KernelHandle {
    pub control_task: tokio::task::JoinHandle<()>,
    pub data_task: tokio::task::JoinHandle<()>,
}

impl KernelHandle {
    pub async fn stop(self) {
        // 推送内核停止事件
        if let Some(bus) = events::global() {
            events::emit_kernel_stopped(&bus);
            events::uninstall();
        }
        self.control_task.abort();
        self.data_task.abort();
    }
}
