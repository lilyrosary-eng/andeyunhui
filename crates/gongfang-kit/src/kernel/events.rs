//! 内核事件总线 + 时序指标 + AI 推理日志
//!
//! 三大职责：
//! 1. **事件流**：所有内核行为（Tick/策略热交换/奖励/指令/阶段执行/回滚/软着陆）结构化推送到前端
//!    - 持有 AppHandle，push 时调用 app.emit("gongfang_event", &event) 实时推送
//!    - 内部环形缓冲区保留最近 500 条，供前端拉取历史
//! 2. **时序指标**：每 500ms 采样一次（reward/error_rate/qps/stealth_level），保留 5 分钟 = 600 个点
//!    - 前端 lightweight-charts 拉取 recent(seconds) 渲染 4 曲线时序图
//! 3. **AI 推理日志**：保留最近 50 条推理记录（level/prompt 摘要/响应摘要/delta/耗时/成功与否）
//!    - 前端 AiReasoningPanel 拉取展示，让 AI 推理过程从黑盒变白盒

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

use super::priority::UserCommand;
use super::reward::EventKind;
use super::strategy::{Phase, Strategy, StrategyDelta};

// ============ 事件容量常量 ============

const EVENT_BUFFER_SIZE: usize = 500;
const METRIC_BUFFER_SIZE: usize = 600; // 5 分钟 @ 500ms 采样
const REASONING_BUFFER_SIZE: usize = 50;

// ============ 内核事件枚举（前端订阅 gongfang_event） ============

/// 内核事件类型（前端按 kind 分类着色与过滤）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KernelEvent {
    /// 数据面 Tick（50ms 一次，默认不推送，仅记录缓冲区；前端按需开启）
    Tick {
        ts: i64,
        generation: u64,
        phase: Phase,
    },
    /// 策略热交换（控制面 commit）
    StrategyCommitted {
        ts: i64,
        generation: u64,
        delta: StrategyDelta,
        new_strategy: Strategy,
    },
    /// 奖励事件（数据面 record）
    RewardRecorded {
        ts: i64,
        event_kind: EventKind,
        total_reward: i64,
        error_rate: f64,
    },
    /// AI 推理完成
    AiReasoning {
        ts: i64,
        level: ReasoningLevel,
        latency_ms: u64,
        success: bool,
        error: Option<String>,
        prompt_summary: String,
        response_summary: String,
        delta: StrategyDelta,
    },
    /// 用户指令注入
    UserCommandInjected {
        ts: i64,
        cmd: UserCommand,
        priority: String,
    },
    /// 阶段执行（数据面按 Phase 分发）
    PhaseExecuted {
        ts: i64,
        phase: Phase,
        focus_url: Option<String>,
    },
    /// 软着陆进度
    SoftLanding {
        ts: i64,
        remaining_ticks: u8,
    },
    /// 策略回滚（错误率飙升触发）
    Rollback {
        ts: i64,
        from_gen: u64,
        to_gen: u64,
    },
    /// 内核启动
    KernelStarted { ts: i64 },
    /// 内核停止
    KernelStopped { ts: i64 },
    /// 通用日志（info/warn/error）
    Log {
        ts: i64,
        level: LogLevel,
        target: String,
        msg: String,
    },
}

/// AI 推理级别
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum ReasoningLevel {
    /// 规则缓存命中（<1ms）
    L0,
    /// 轻量 LLM 推理（500ms 超时）
    L1,
    /// 深度 LLM 推理（5s 超时）
    L2,
    /// L0 兜底回退
    L0Fallback,
}

impl ReasoningLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            ReasoningLevel::L0 => "L0",
            ReasoningLevel::L1 => "L1",
            ReasoningLevel::L2 => "L2",
            ReasoningLevel::L0Fallback => "L0'",
        }
    }
}

/// 日志级别
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

// ============ 时序指标样本 ============

/// 单次时序指标采样（500ms 一次，前端时序图数据点）
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct MetricSample {
    /// Unix 毫秒
    pub ts: i64,
    /// 累计奖励
    pub reward: i64,
    /// 错误率 [0, 1]
    pub error_rate: f64,
    /// 当前 QPS
    pub qps: u32,
    /// 隐身等级 [0, 100]
    pub stealth_level: u8,
    /// 当前 generation
    pub generation: u64,
}

// ============ AI 推理日志条目 ============

/// AI 推理日志（与 KernelEvent::AiReasoning 字段一致，独立缓冲区便于查询）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReasoningEntry {
    pub ts: i64,
    pub level: ReasoningLevel,
    pub latency_ms: u64,
    pub success: bool,
    pub error: Option<String>,
    pub prompt_summary: String,
    pub response_summary: String,
    pub delta: StrategyDelta,
}

// ============ 事件总线主结构 ============

/// 内核事件总线（全局单例，每个 KernelEngine 持有 Arc 引用）
///
/// 三大职责集成：
/// 1. 事件流（VecDeque<KernelEvent>，容量 500）
/// 2. 时序指标（VecDeque<MetricSample>，容量 600 = 5 分钟）
/// 3. AI 推理日志（VecDeque<ReasoningEntry>，容量 50）
///
/// 推送策略：
/// - 重要事件（StrategyCommitted/RewardRecorded/AiReasoning/UserCommandInjected/PhaseExecuted/SoftLanding/Rollback/KernelStarted/KernelStopped/Log）
///   实时 app.emit("gongfang_event", &event) 推送前端
/// - Tick 事件默认不推送（50ms 一次太频繁），仅入缓冲区供前端按需拉取
pub struct EventBus {
    app: AppHandle,
    inner: Mutex<EventBusInner>,
    /// 是否推送 Tick 事件到前端（默认 false，避免 50ms 一次的洪水）
    emit_tick: std::sync::atomic::AtomicBool,
}

struct EventBusInner {
    events: VecDeque<KernelEvent>,
    metrics: VecDeque<MetricSample>,
    reasoning: VecDeque<ReasoningEntry>,
}

impl EventBus {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            inner: Mutex::new(EventBusInner {
                events: VecDeque::with_capacity(EVENT_BUFFER_SIZE),
                metrics: VecDeque::with_capacity(METRIC_BUFFER_SIZE),
                reasoning: VecDeque::with_capacity(REASONING_BUFFER_SIZE),
            }),
            emit_tick: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// 推送事件（写入缓冲区 + 实时 emit 到前端）
    pub fn push(&self, event: KernelEvent) {
        // Tick 事件特殊处理：默认不 emit，仅入缓冲区
        let is_tick = matches!(event, KernelEvent::Tick { .. });
        let should_emit = if is_tick {
            self.emit_tick.load(std::sync::atomic::Ordering::Relaxed)
        } else {
            true
        };

        let mut inner = self.inner.lock();
        if inner.events.len() >= EVENT_BUFFER_SIZE {
            inner.events.pop_front();
        }
        inner.events.push_back(event.clone());
        drop(inner);

        if should_emit {
            let _ = self.app.emit("gongfang_event", &event);
        }

        // 推理日志同步写入独立缓冲区
        if let KernelEvent::AiReasoning {
            ts,
            level,
            latency_ms,
            success,
            error,
            prompt_summary,
            response_summary,
            delta,
        } = event
        {
            let entry = ReasoningEntry {
                ts,
                level,
                latency_ms,
                success,
                error,
                prompt_summary,
                response_summary,
                delta,
            };
            let mut inner = self.inner.lock();
            if inner.reasoning.len() >= REASONING_BUFFER_SIZE {
                inner.reasoning.pop_front();
            }
            inner.reasoning.push_back(entry);
        }
    }

    /// 采样时序指标（500ms 一次，由控制面调用）
    pub fn sample_metrics(&self, strategy: &Strategy, reward: i64, error_rate: f64) {
        let sample = MetricSample {
            ts: chrono::Utc::now().timestamp_millis(),
            reward,
            error_rate,
            qps: strategy.qps,
            stealth_level: strategy.stealth_level,
            generation: strategy.generation,
        };
        let mut inner = self.inner.lock();
        if inner.metrics.len() >= METRIC_BUFFER_SIZE {
            inner.metrics.pop_front();
        }
        inner.metrics.push_back(sample);
    }

    /// 拉取最近 N 条事件（前端 gongfang_events_recent 命令调用）
    pub fn recent_events(&self, n: usize) -> Vec<KernelEvent> {
        let inner = self.inner.lock();
        let total = inner.events.len();
        let start = total.saturating_sub(n);
        inner.events.iter().skip(start).cloned().collect()
    }

    /// 拉取最近 N 秒的时序指标（前端 gongfang_metrics_history 命令调用）
    pub fn recent_metrics(&self, seconds: u32) -> Vec<MetricSample> {
        let cutoff = chrono::Utc::now().timestamp_millis() - (seconds as i64) * 1000;
        let inner = self.inner.lock();
        inner
            .metrics
            .iter()
            .filter(|m| m.ts >= cutoff)
            .copied()
            .collect()
    }

    /// 拉取最近 N 条 AI 推理日志（前端 gongfang_ai_reasoning_recent 命令调用）
    pub fn recent_reasoning(&self, n: usize) -> Vec<ReasoningEntry> {
        let inner = self.inner.lock();
        let total = inner.reasoning.len();
        let start = total.saturating_sub(n);
        inner.reasoning.iter().skip(start).cloned().collect()
    }

    /// 设置是否推送 Tick 事件到前端（前端按需开启）
    pub fn set_emit_tick(&self, enabled: bool) {
        self.emit_tick
            .store(enabled, std::sync::atomic::Ordering::Relaxed);
    }

    /// 清空所有缓冲区（内核重启时调用）
    pub fn clear(&self) {
        let mut inner = self.inner.lock();
        inner.events.clear();
        inner.metrics.clear();
        inner.reasoning.clear();
    }
}

// ============ 便捷推送函数（避免每次构造完整 KernelEvent） ============

/// 当前时间戳（Unix 毫秒）
pub fn now_ts() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 推送策略热交换事件
pub fn emit_strategy_committed(bus: &EventBus, delta: StrategyDelta, new_strategy: Strategy) {
    bus.push(KernelEvent::StrategyCommitted {
        ts: now_ts(),
        generation: new_strategy.generation,
        delta,
        new_strategy,
    });
}

/// 推送奖励事件
pub fn emit_reward_recorded(bus: &EventBus, kind: EventKind, total: i64, error_rate: f64) {
    bus.push(KernelEvent::RewardRecorded {
        ts: now_ts(),
        event_kind: kind,
        total_reward: total,
        error_rate,
    });
}

/// 推送 AI 推理事件
#[allow(clippy::too_many_arguments)]
pub fn emit_ai_reasoning(
    bus: &EventBus,
    level: ReasoningLevel,
    latency_ms: u64,
    success: bool,
    error: Option<String>,
    prompt: &str,
    response: &str,
    delta: StrategyDelta,
) {
    // 摘要：截断到 200 字符，避免事件过大
    let prompt_summary = truncate(prompt, 200);
    let response_summary = truncate(response, 200);
    bus.push(KernelEvent::AiReasoning {
        ts: now_ts(),
        level,
        latency_ms,
        success,
        error,
        prompt_summary,
        response_summary,
        delta,
    });
}

/// 推送用户指令注入事件
pub fn emit_user_command(bus: &EventBus, cmd: UserCommand) {
    let priority = format!("{:?}", cmd.priority());
    bus.push(KernelEvent::UserCommandInjected {
        ts: now_ts(),
        cmd,
        priority,
    });
}

/// 推送阶段执行事件
pub fn emit_phase_executed(bus: &EventBus, phase: Phase, focus_url: Option<String>) {
    bus.push(KernelEvent::PhaseExecuted {
        ts: now_ts(),
        phase,
        focus_url,
    });
}

/// 推送软着陆进度
pub fn emit_soft_landing(bus: &EventBus, remaining_ticks: u8) {
    bus.push(KernelEvent::SoftLanding {
        ts: now_ts(),
        remaining_ticks,
    });
}

/// 推送策略回滚事件
pub fn emit_rollback(bus: &EventBus, from_gen: u64, to_gen: u64) {
    bus.push(KernelEvent::Rollback {
        ts: now_ts(),
        from_gen,
        to_gen,
    });
}

/// 推送内核启动事件
pub fn emit_kernel_started(bus: &EventBus) {
    bus.push(KernelEvent::KernelStarted { ts: now_ts() });
}

/// 推送内核停止事件
pub fn emit_kernel_stopped(bus: &EventBus) {
    bus.push(KernelEvent::KernelStopped { ts: now_ts() });
}

/// 推送通用日志事件
pub fn emit_log(bus: &EventBus, level: LogLevel, target: &str, msg: String) {
    bus.push(KernelEvent::Log {
        ts: now_ts(),
        level,
        target: target.to_string(),
        msg,
    });
}

/// 截断字符串到 max_chars 字符（Unicode 安全）
fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max_chars).collect();
    format!("{}…", truncated)
}

// ============ 全局事件总线访问（供 KernelEngine 使用） ============

/// 全局事件总线存储（与 STATE 配合使用）
pub static GLOBAL_BUS: once_cell::sync::Lazy<Mutex<Option<Arc<EventBus>>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

/// 安装全局事件总线（gongfang_start 时调用）
pub fn install(bus: Arc<EventBus>) {
    *GLOBAL_BUS.lock() = Some(bus);
}

/// 卸载全局事件总线（gongfang_stop 时调用）
pub fn uninstall() {
    *GLOBAL_BUS.lock() = None;
}

/// 获取全局事件总线（命令层调用）
pub fn global() -> Option<Arc<EventBus>> {
    GLOBAL_BUS.lock().clone()
}

/// 便捷推送函数（不需要持有 bus 引用，通过全局单例推送）
/// 适用于命令层（如 gongfang_inject）需要推送事件但未持有 bus 的场景
pub fn try_emit(event: KernelEvent) {
    if let Some(bus) = global() {
        bus.push(event);
    }
}
