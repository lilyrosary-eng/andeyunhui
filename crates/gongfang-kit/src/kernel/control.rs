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
//! 替代 LLM 多卡分片+PagedAttention（桌面无多 GPU，HTTP API 调用外部 LLM 即可）
//! 替代 Prompt JIT 字节码（JSON 策略足够，不自造 VM）
//! 替代 OPA/Rego 规则引擎（场景签名 HashMap 足够，零依赖）

use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;
use tokio::sync::broadcast;

use crate::ai::{self, AiProfile, ChatMessage};

use super::knowledge::{self, KnowledgeBase, SceneSignature};
use super::priority::{PriorityCommandQueue, UserCommand};
use super::reward::RewardSignal;
use super::strategy::{Phase, StrategyDelta, StrategyStore};

const REASONING_INTERVAL: Duration = Duration::from_millis(500);
const L1_TIMEOUT: Duration = Duration::from_millis(500);
const L2_TIMEOUT: Duration = Duration::from_millis(5000);

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
    kb: Arc<KnowledgeBase>,
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
    ) -> Self {
        Self {
            app,
            profile,
            strategy,
            priority,
            reward,
            tx,
            kb: knowledge::global(),
        }
    }

    pub async fn run(self) {
        loop {
            tokio::time::sleep(REASONING_INTERVAL).await;

            // 优先处理用户指令（抢占自主推理）
            if let Some(cmd) = self.priority.pop() {
                if let Some(delta) = self.handle_user_command(&cmd).await {
                    self.commit(delta);
                }
                continue;
            }

            // 自主推理（L0 → L1 → L2 级联）
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
        if let Some(delta) = self.kb.lookup_rule(&sig) {
            log::debug!("[control] L0 规则命中 sig={}", sig.0);
            return delta;
        }

        // L1：轻量 LLM 推理（500ms 超时挂起）
        let prompt = format!(
            "当前观测：{}\n输出策略补丁 JSON（仅变更项）。",
            obs
        );
        match tokio::time::timeout(L1_TIMEOUT, self.l1_reason(&prompt)).await {
            Ok(Ok(delta)) => {
                // L1 成功，回写 L0 规则缓存（自加速）
                self.kb.record_rule(sig, delta.clone());
                delta
            }
            Ok(Err(e)) => {
                log::warn!("[control] L1 推理失败，回退 L0 规则: {}", e);
                self.l0_fallback()
            }
            Err(_) => {
                log::warn!("[control] L1 推理超时 500ms，保持当前策略（数据面继续执行）");
                StrategyDelta::default()
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
        match tokio::time::timeout(L2_TIMEOUT, self.ai_reason(&prompt_with_kb)).await {
            Ok(Ok(delta)) => Ok(delta),
            Ok(Err(e)) => Err(format!("L2 推理失败: {}", e)),
            Err(_) => Err("L2 推理超时 5s".to_string()),
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
        self.strategy.commit(&delta);
        let _ = self.tx.send(delta);
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
