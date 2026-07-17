//! 控制面：AI 常驻推理核（三级级联 L0/L1/L2）
//!
//! 职责：每 500ms 推理一次，生成策略补丁 StrategyDelta，commit 到 strategy store 并 broadcast。
//! 绝不等待 I/O：500ms 超时挂起，数据面继续执行旧策略。
//! 用户指令抢占：priority queue 有指令时压制自主推理，直接生成对应补丁。
//!
//! 三级级联（对应 01/02 文档 L0/L1/L2）：
//! - L0 规则引擎（<1ms）：场景签名命中 RuleCache → 直接返回策略补丁，跳过 LLM
//! - L1 轻量 LLM（<500ms）：当前 HTTP API 调用，500ms 超时挂起
//! - L2 深度 LLM（<5s）：复杂推理，超时后回退 L0 规则
//!
//! 降级链：L0 命中 → 跳过 LLM；L1 超时 → 保持当前策略；L2 失败 → 回退 L0
//! 自加速：L2 成功后回写 L0 RuleCache，相同场景第二次 <1ms 命中
//!
//! 事件总线集成：
//! - 每次推理（无论 L0/L1/L2/失败）都推送 AiReasoning 事件，让前端看到 AI 在想什么
//! - 每 500ms 采样一次时序指标（reward/error_rate/qps/stealth），供前端时序图
//! - 每次 commit 推送 StrategyCommitted 事件，含 delta + new_strategy

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tokio::sync::broadcast;

use crate::ai::{self, AiProfile, ChatMessage};

use super::events::{self, EventBus, ReasoningLevel};
use super::knowledge::{self, KnowledgeBase, SceneSignature};
use super::priority::{PriorityCommandQueue, UserCommand};
use super::reward::RewardSignal;
use super::strategy::{Phase, StrategyDelta, StrategyStore};

const REASONING_INTERVAL: Duration = Duration::from_millis(500);
const L1_TIMEOUT: Duration = Duration::from_millis(500);
const L2_TIMEOUT: Duration = Duration::from_millis(5000);
/// 连续失败多少次后进入熔断（仅用 L0 规则，跳过 LLM）
const CIRCUIT_BREAKER_THRESHOLD: u32 = 5;
/// 退避上限
const MAX_BACKOFF: Duration = Duration::from_secs(30);

const SYSTEM_PROMPT: &str = r#"你是攻防模块的策略生成器。根据当前观测与用户指令，输出策略补丁 JSON。
仅输出 JSON，不要解释。字段均可选，仅包含需要变更的项：
{
  "phase": "Idle|Recon|Exploit|Pivot|Clean",
  "qps": 数字,
  "per_ip_concurrency": 数字,
  "tls_profile": "chrome_122|firefox_120|safari_17",
  "stealth_level": 0-100,
  "focus_url": "url 或 null",
  "use_browser": true|false,
  "proxy_pool_tag": "标签"
}
原则：错误率高则降速/切指纹；获得凭证则升 Phase；WAF 告警则升隐身等级。"#;

pub struct ControlPlane {
    #[allow(dead_code)]
    app: AppHandle,
    profile: AiProfile,
    strategy: Arc<StrategyStore>,
    priority: Arc<PriorityCommandQueue>,
    reward: Arc<RewardSignal>,
    tx: broadcast::Sender<StrategyDelta>,
    event_bus: Arc<EventBus>,
    kb: Arc<KnowledgeBase>,
    /// L1 连续失败计数（用于指数退避 + 熔断）
    failures: Arc<AtomicU32>,
}

impl ControlPlane {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        app: AppHandle,
        profile: AiProfile,
        strategy: Arc<StrategyStore>,
        priority: Arc<PriorityCommandQueue>,
        reward: Arc<RewardSignal>,
        tx: broadcast::Sender<StrategyDelta>,
        event_bus: Arc<EventBus>,
    ) -> Self {
        Self {
            app,
            profile,
            strategy,
            priority,
            reward,
            tx,
            event_bus,
            kb: knowledge::global(),
            failures: Arc::new(AtomicU32::new(0)),
        }
    }

    /// 当前连续失败次数
    fn failure_count(&self) -> u32 {
        self.failures.load(Ordering::Relaxed)
    }

    /// 记录失败（fetch_add）
    fn record_failure(&self) {
        self.failures.fetch_add(1, Ordering::Relaxed);
    }

    /// 重置失败计数（L1 成功时调用）
    fn reset_failures(&self) {
        self.failures.store(0, Ordering::Relaxed);
    }

    /// 根据连续失败次数计算退避间隔（指数退避：500ms → 1s → 2s → 4s → 8s → 16s → 30s）
    fn backoff_interval(&self) -> Duration {
        let n = self.failure_count();
        if n == 0 {
            REASONING_INTERVAL
        } else {
            let multiplier = 2u64.saturating_pow(n.min(6));
            REASONING_INTERVAL
                .checked_mul(multiplier as u32)
                .unwrap_or(MAX_BACKOFF)
                .min(MAX_BACKOFF)
        }
    }

    /// 是否处于熔断状态（连续失败 ≥ 阈值）
    fn circuit_open(&self) -> bool {
        self.failure_count() >= CIRCUIT_BREAKER_THRESHOLD
    }

    pub async fn run(self) {
        let mut last_observation: String = String::new();

        loop {
            // 动态退避间隔：连续失败时指数退避（500ms → 1s → 2s → ... → 30s）
            let interval = self.backoff_interval();
            tokio::time::sleep(interval).await;

            // 采样时序指标（每次循环都采样，保证时序图连续）
            let s = self.strategy.load();
            let reward = self.reward.total_reward();
            let err_rate = self.reward.error_rate();
            self.event_bus.sample_metrics(&s, reward, err_rate);

            // 优先处理用户指令（抢占自主推理）
            if let Some(cmd) = self.priority.pop() {
                if let Some(delta) = self.handle_user_command(&cmd).await {
                    self.commit(delta);
                }
                // 用户指令处理后重置失败计数（用户介入相当于"心跳")
                self.reset_failures();
                continue;
            }

            // Idle 时跳过自主推理（无任务不需要 AI 调整策略）
            if s.phase == Phase::Idle {
                continue;
            }

            // 熔断状态：连续失败 ≥ 5 次，仅用 L0 规则，跳过 LLM 调用
            // 冷却恢复：每轮把失败计数减 1，降到阈值以下后自动恢复 L1
            if self.circuit_open() {
                let delta = self.l0_fallback();
                let fails = self.failure_count();
                events::emit_ai_reasoning(
                    &self.event_bus,
                    ReasoningLevel::L0Fallback,
                    0,
                    true,
                    None,
                    &format!(
                        "熔断模式（连续失败 {} 次，退避 {:?}），仅用 L0 规则",
                        fails, interval
                    ),
                    "(L0 规则兜底，跳过 LLM 调用避免请求堆积)",
                    delta.clone(),
                );
                if !delta_is_empty(&delta) {
                    self.commit(delta);
                }
                // 冷却：失败计数减 1（降到 0 时自动退出熔断，恢复 L1 尝试）
                self.failures.fetch_sub(1, Ordering::Relaxed);
                continue;
            }

            // 观测去重：上次观测与本次相同 + 上次失败了 → 跳过（避免无意义重试）
            let obs = self.build_observation();
            if obs == last_observation && self.failure_count() > 0 {
                continue;
            }
            last_observation = obs;

            // 正常自主推理（L0 → L1 → L2 级联）
            let delta = self.autonomous_reasoning().await;
            self.commit(delta);
        }
    }

    /// 用户指令 → AI 解析 → 策略补丁
    async fn handle_user_command(&self, cmd: &UserCommand) -> Option<StrategyDelta> {
        match cmd {
            UserCommand::Pause => {
                return Some(StrategyDelta {
                    phase: Some(Phase::Idle),
                    ..Default::default()
                });
            }
            UserCommand::Resume => {
                return Some(StrategyDelta {
                    phase: Some(Phase::Recon),
                    ..Default::default()
                });
            }
            UserCommand::Focus { url } => {
                return Some(StrategyDelta {
                    phase: Some(Phase::Recon),
                    focus_url: Some(Some(url.clone())),
                    ..Default::default()
                });
            }
            _ => {}
        }

        // 复杂指令交 AI 解析（降低门槛：用户自然语言，AI 转策略）
        let prompt = match cmd {
            UserCommand::Bypass { challenge } => {
                format!("用户要求绕过「{}」。生成策略补丁：提升隐身、切换指纹、降速。", challenge)
            }
            UserCommand::Hook { func_name } => {
                format!("用户要求 Hook 函数「{}」。生成逆向策略补丁。", func_name)
            }
            UserCommand::Inject { payload_type } => {
                format!("用户要求注入「{}」载荷。生成渗透策略补丁，phase=Exploit。", payload_type)
            }
            UserCommand::Solve { captcha_type } => {
                format!("用户要求求解「{}」验证码。生成自动化策略补丁。", captcha_type)
            }
            UserCommand::Raw { text } => format!("用户指令：{}。解析为策略补丁。", text),
            _ => return None,
        };

        // 用户指令走 L2 深度推理（5s 超时）
        self.l2_reason(&prompt).await.ok()
    }

    /// 自主推理：L0 → L1 → L2 级联
    async fn autonomous_reasoning(&self) -> StrategyDelta {
        let obs = self.build_observation();
        let sig = self.build_signature();

        // L0：规则缓存命中（<1ms，跳过 LLM）
        let l0_start = Instant::now();
        if let Some(delta) = self.kb.lookup_rule(&sig) {
            let latency = l0_start.elapsed().as_millis() as u64;
            events::emit_ai_reasoning(
                &self.event_bus,
                ReasoningLevel::L0,
                latency,
                true,
                None,
                &format!("sig={:?} obs={}", sig.0, obs),
                "(规则缓存命中，跳过 LLM)",
                delta.clone(),
            );
            return delta;
        }

        // L1：轻量 LLM 推理（500ms 超时挂起）
        let prompt = format!(
            "当前观测：{}\n输出策略补丁 JSON（仅变更项）。",
            obs
        );
        let l1_start = Instant::now();
        match tokio::time::timeout(L1_TIMEOUT, self.l1_reason(&prompt)).await {
            Ok(Ok(delta)) => {
                let latency = l1_start.elapsed().as_millis() as u64;
                // L1 成功：重置失败计数 + 回写 L0 规则缓存（自加速）
                self.reset_failures();
                self.kb.record_rule(sig, delta.clone());
                events::emit_ai_reasoning(
                    &self.event_bus,
                    ReasoningLevel::L1,
                    latency,
                    true,
                    None,
                    &prompt,
                    "(L1 LLM 推理成功)",
                    delta.clone(),
                );
                delta
            }
            Ok(Err(e)) => {
                let latency = l1_start.elapsed().as_millis() as u64;
                log::warn!("[control] L1 推理失败（第 {} 次），回退 L0 规则: {}", self.failure_count() + 1, e);
                self.record_failure();
                let delta = self.l0_fallback();
                events::emit_ai_reasoning(
                    &self.event_bus,
                    ReasoningLevel::L1,
                    latency,
                    false,
                    Some(e.clone()),
                    &prompt,
                    "",
                    delta.clone(),
                );
                events::emit_ai_reasoning(
                    &self.event_bus,
                    ReasoningLevel::L0Fallback,
                    0,
                    true,
                    None,
                    "L0 fallback (L1 失败后)",
                    "(启发式规则兜底)",
                    delta.clone(),
                );
                delta
            }
            Err(_) => {
                let latency = l1_start.elapsed().as_millis() as u64;
                log::warn!(
                    "[control] L1 推理超时 500ms（第 {} 次），保持当前策略（数据面继续执行）",
                    self.failure_count() + 1
                );
                self.record_failure();
                let delta = StrategyDelta::default();
                events::emit_ai_reasoning(
                    &self.event_bus,
                    ReasoningLevel::L1,
                    latency,
                    false,
                    Some("L1 推理超时 500ms".to_string()),
                    &prompt,
                    "",
                    delta.clone(),
                );
                delta
            }
        }
    }

    /// L1 轻量 LLM 推理（500ms 超时，覆盖 15% 请求）
    async fn l1_reason(&self, prompt: &str) -> Result<StrategyDelta, String> {
        self.ai_reason(prompt).await
    }

    /// L2 深度 LLM 推理（5s 超时，覆盖 5% 复杂请求）
    /// 当前与 L1 共用同一 LLM（桌面单配置），后续可扩展多 profile 路由
    async fn l2_reason(&self, prompt: &str) -> Result<StrategyDelta, String> {
        // 注入 RAG 知识库检索结果（替代 Milvus 向量检索）
        let kb_hits = self.kb.search(prompt, 3);
        let kb_context = if kb_hits.is_empty() {
            String::new()
        } else {
            let mut ctx = String::from("\n[知识库参考]\n");
            for h in &kb_hits {
                ctx.push_str(&format!("- {}: {}\n", h.title, h.content));
            }
            ctx
        };

        let prompt_with_kb = format!("{}{}", prompt, kb_context);
        let l2_start = Instant::now();
        let result = tokio::time::timeout(L2_TIMEOUT, self.ai_reason(&prompt_with_kb)).await;
        let latency = l2_start.elapsed().as_millis() as u64;

        match result {
            Ok(Ok(delta)) => {
                events::emit_ai_reasoning(
                    &self.event_bus,
                    ReasoningLevel::L2,
                    latency,
                    true,
                    None,
                    prompt,
                    "(L2 深度推理成功)",
                    delta.clone(),
                );
                Ok(delta)
            }
            Ok(Err(e)) => {
                let err = format!("L2 推理失败: {}", e);
                events::emit_ai_reasoning(
                    &self.event_bus,
                    ReasoningLevel::L2,
                    latency,
                    false,
                    Some(err.clone()),
                    prompt,
                    "",
                    StrategyDelta::default(),
                );
                Err(err)
            }
            Err(_) => {
                let err = "L2 推理超时 5s".to_string();
                events::emit_ai_reasoning(
                    &self.event_bus,
                    ReasoningLevel::L2,
                    latency,
                    false,
                    Some(err.clone()),
                    prompt,
                    "",
                    StrategyDelta::default(),
                );
                Err(err)
            }
        }
    }

    /// L0 规则回退（LLM 失败时的兜底，<1ms）
    /// 基于观测的启发式规则，替代 OPA/Rego
    fn l0_fallback(&self) -> StrategyDelta {
        let s = self.strategy.load();
        let err_rate = self.reward.error_rate();

        if err_rate > 0.5 {
            // 错误率 >50%：降速 50% + 升隐身
            return StrategyDelta {
                qps: Some((s.qps / 2).max(1)),
                stealth_level: Some((s.stealth_level + 20).min(100)),
                ..Default::default()
            };
        }

        if err_rate > 0.2 {
            // 错误率 20-50%：切 TLS 指纹
            let new_tls = match s.tls_profile.as_str() {
                "chrome_122" => "firefox_120",
                "firefox_120" => "safari_17",
                _ => "chrome_122",
            };
            return StrategyDelta {
                tls_profile: Some(new_tls.to_string()),
                ..Default::default()
            };
        }

        StrategyDelta::default()
    }

    async fn ai_reason(&self, prompt: &str) -> Result<StrategyDelta, String> {
        let messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: SYSTEM_PROMPT.to_string(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: prompt.to_string(),
            },
        ];
        let text = ai::chat(&self.profile, messages).await?;
        let json_str = extract_json(&text);
        let delta: StrategyDelta =
            serde_json::from_str(json_str).map_err(|e| format!("策略 JSON 解析失败: {}", e))?;
        Ok(delta)
    }

    /// 构造观测摘要（供 AI 推理）
    fn build_observation(&self) -> String {
        let s = self.strategy.load();
        let err_rate = self.reward.error_rate();
        let reward = self.reward.total_reward();
        format!(
            "phase={:?} qps={} stealth={} tls={} gen={} error_rate={:.2} reward={}",
            s.phase, s.qps, s.stealth_level, s.tls_profile, s.generation, err_rate, reward
        )
    }

    /// 构造场景签名（供 L0 规则匹配）
    fn build_signature(&self) -> SceneSignature {
        let s = self.strategy.load();
        let err_rate = self.reward.error_rate() as f32;
        KnowledgeBase::signature_from_observation(
            s.phase,
            err_rate,
            &s.tls_profile,
            None,
            None,
        )
    }

    fn commit(&self, delta: StrategyDelta) {
        if delta_is_empty(&delta) {
            return;
        }
        let new_strategy = self.strategy.commit(&delta);
        let _ = self.tx.send(delta.clone());
        events::emit_strategy_committed(&self.event_bus, delta, new_strategy);
    }
}

fn delta_is_empty(d: &StrategyDelta) -> bool {
    d.qps.is_none()
        && d.per_ip_concurrency.is_none()
        && d.tls_profile.is_none()
        && d.stealth_level.is_none()
        && d.focus_url.is_none()
        && d.use_browser.is_none()
        && d.proxy_pool_tag.is_none()
        && d.phase.is_none()
}

/// 从 AI 返回文本中提取 JSON（兼容 markdown ```json ... ``` 包裹）
fn extract_json(text: &str) -> &str {
    let trimmed = text.trim();
    if let Some(start) = trimmed.find('{') {
        if let Some(end) = trimmed.rfind('}') {
            return &trimmed[start..=end];
        }
    }
    trimmed
}
