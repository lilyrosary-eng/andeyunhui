//! 爬虫框架（务实版）
//!
//! 替代原计划的 6 模块：
//! - 物理层 DPDK/io_uring → reqwest + 代理池
//! - TLS ClientHello 手术 → rustls 默认 + UA 伪装（后续可接 tls-client crate）
//! - LD_PRELOAD 字体劫持 → CDP addScriptToEvaluateOnNewDocument JS 注入
//! - netns 重置 → 进程级浏览器实例重建
//! - 双令牌桶 + MPC → tokio::Semaphore 双桶 + EWMA
//! - AI 核 + MMAP + Prompt JIT → 复用 kernel 的 control plane
//!
//! 响应态势矩阵（对应 03 文档增强3）：根据响应特征自动调整策略
//! 指纹一致性校验（对应 03 文档增强2）：UA/WebGL/locale/hardwareConcurrency 多信号一致

pub mod immortal;
pub mod pool;
pub mod scheduler;
pub mod stealth;

use std::sync::Arc;

use crate::kernel::reward::{EventKind, RewardSignal};
use crate::kernel::strategy::{Phase, Strategy, StrategyDelta};

/// 响应态势评估（对应 03 文档增强3 实时态势感知）
#[derive(Debug, Clone)]
pub struct ResponseAssessment {
    pub status: u16,
    /// 检测到的挑战类型（cf-ray / x-datadome / _abck / challenge / captcha / empty）
    pub challenge: Option<String>,
    /// 是否为 Cloudflare 拦截
    pub is_cloudflare: bool,
    /// 是否为 DataDome 拦截
    pub is_datadome: bool,
    /// 是否为 CAPTCHA 页面
    pub is_captcha: bool,
    /// 是否为空内容（蜜罐嫌疑）
    pub is_empty: bool,
}

impl ResponseAssessment {
    /// 从 HTTP 响应解析态势
    pub fn from_response(
        status: u16,
        headers: &[(String, String)],
        body_preview: &str,
    ) -> Self {
        let mut is_cloudflare = false;
        let mut is_datadome = false;
        let mut challenge = None;

        for (k, v) in headers {
            let key = k.to_lowercase();
            match key.as_str() {
                "cf-ray" => {
                    is_cloudflare = true;
                    challenge = Some("cf-ray".to_string());
                }
                "x-datadome" => {
                    is_datadome = true;
                    challenge = Some("x-datadome".to_string());
                }
                _ => {}
            }
            if key == "set-cookie" && v.contains("_abck") {
                challenge = Some("akamai-abck".to_string());
            }
        }

        let body_lower = body_preview.to_lowercase();
        let is_captcha = body_lower.contains("captcha") || body_lower.contains("recaptcha");
        let is_empty = body_preview.trim().len() < 200 && status == 200;

        if is_captcha {
            challenge = Some("captcha".to_string());
        } else if body_lower.contains("challenge") || body_lower.contains("just a moment") {
            challenge = Some("challenge".to_string());
        }

        Self {
            status,
            challenge,
            is_cloudflare,
            is_datadome,
            is_captcha,
            is_empty,
        }
    }

    /// 根据态势生成策略补丁（决策矩阵）
    /// 对应 03 文档增强3 的决策矩阵
    pub fn to_delta(&self, current: &Strategy) -> StrategyDelta {
        // 200 + 正常内容 → 继续当前策略（无补丁）
        if self.status == 200 && self.challenge.is_none() && !self.is_empty {
            return StrategyDelta::default();
        }

        // 200 + 挑战页面 → 升级指纹 + 切换代理
        if self.status == 200 && self.challenge.is_some() {
            return StrategyDelta {
                stealth_level: Some((current.stealth_level + 15).min(100)),
                tls_profile: Some(rotate_tls(&current.tls_profile).to_string()),
                ..Default::default()
            };
        }

        // 403 + CF-Ray → Cloudflare 拦截 → 切换到浏览器模式
        if self.status == 403 && self.is_cloudflare {
            return StrategyDelta {
                use_browser: Some(true),
                stealth_level: Some((current.stealth_level + 20).min(100)),
                qps: Some((current.qps / 2).max(1)),
                ..Default::default()
            };
        }

        // 403 → 指纹可能被识别 → 切换指纹模板
        if self.status == 403 {
            return StrategyDelta {
                tls_profile: Some(rotate_tls(&current.tls_profile).to_string()),
                stealth_level: Some((current.stealth_level + 10).min(100)),
                ..Default::default()
            };
        }

        // 429 → 频率过高 → 降低频率
        if self.status == 429 {
            return StrategyDelta {
                qps: Some((current.qps / 2).max(1)),
                per_ip_concurrency: Some(1),
                ..Default::default()
            };
        }

        // 200 + CAPTCHA → 触发验证码处理（升 Phase 到 Exploit 或标记需要人工）
        if self.is_captcha {
            return StrategyDelta {
                phase: Some(Phase::Exploit),
                use_browser: Some(true),
                ..Default::default()
            };
        }

        // 200 + 空内容 → 可能被蜜罐 → 标记可疑 + 换 IP
        if self.is_empty {
            return StrategyDelta {
                proxy_pool_tag: Some("rotated".to_string()),
                ..Default::default()
            };
        }

        // 5xx → 服务异常 → 降速
        if self.status >= 500 {
            return StrategyDelta {
                qps: Some((current.qps / 2).max(1)),
                ..Default::default()
            };
        }

        StrategyDelta::default()
    }

    /// 映射到奖励信号 EventKind
    pub fn to_event_kind(&self) -> EventKind {
        match self.status {
            200 if self.challenge.is_none() && !self.is_empty => EventKind::Success,
            403 | 429 => EventKind::Rejected,
            s if s >= 500 => EventKind::Timeout,
            _ => EventKind::ValidationError,
        }
    }
}

/// 轮转 TLS 指纹（避免被同一指纹持续追踪）
fn rotate_tls(current: &str) -> &'static str {
    match current {
        "chrome_122" => "firefox_120",
        "firefox_120" => "safari_17",
        _ => "chrome_122",
    }
}

/// 指纹一致性校验（对应 03 文档增强2）
///
/// 规则示例：
/// - UA="Chrome/120 Windows" → WebGL RENDERER 必须含 "ANGLE"
/// - locale="zh-CN" → Accept-Language 必须含 "zh"
/// - hardwareConcurrency=8 → deviceMemory 必须 ∈ {4,8,16}
///
/// 不一致 → 返回修正建议（StrategyDelta）
pub fn validate_fingerprint_consistency(
    tls_profile: &str,
    locale: &str,
    hardware_concurrency: u8,
    device_memory: u8,
    accept_language: &str,
) -> Result<(), StrategyDelta> {
    // Chrome on Windows → WebGL RENDERER 应含 ANGLE（由 stealth.rs 注入保证）
    if tls_profile == "chrome_122" && !accept_language.contains("zh") && locale == "zh-CN" {
        return Err(StrategyDelta {
            // 提示：Accept-Language 与 locale 不一致，需修正
            ..Default::default()
        });
    }

    // hardwareConcurrency=8 → deviceMemory 必须是 4/8/16
    if hardware_concurrency == 8 && !matches!(device_memory, 4 | 8 | 16) {
        return Err(StrategyDelta {
            ..Default::default()
        });
    }

    Ok(())
}

/// Recon 阶段执行入口（数据面 Tick 调用）
pub async fn execute_recon(s: &Strategy, reward: &Arc<RewardSignal>) {
    let url = match &s.focus_url {
        Some(u) if !u.is_empty() => u.clone(),
        _ => {
            log::debug!("[crawler] 无 focus_url，跳过 Recon");
            return;
        }
    };

    log::info!(
        "[crawler] Recon 抓取 {} (qps={} stealth={} tls={})",
        url,
        s.qps,
        s.stealth_level,
        s.tls_profile
    );

    let ua = stealth::user_agent(&s.tls_profile);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap();

    match client.get(&url).header("User-Agent", ua).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            // 收集响应头
            let headers: Vec<(String, String)> = resp
                .headers()
                .iter()
                .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
                .collect();
            // 读取前 4KB 作为预览（用于检测挑战/CAPTCHA）
            let body = resp.text().await.unwrap_or_default();
            let body_preview: String = body.chars().take(4096).collect();

            let assessment = ResponseAssessment::from_response(status, &headers, &body_preview);
            reward.record(assessment.to_event_kind());

            log::info!(
                "[crawler] {} -> {} challenge={:?} cf={} dd={} captcha={} empty={}",
                url,
                status,
                assessment.challenge,
                assessment.is_cloudflare,
                assessment.is_datadome,
                assessment.is_captcha,
                assessment.is_empty
            );

            // 根据态势生成策略补丁（此处仅记录日志，实际 commit 由数据面或控制面处理）
            let delta = assessment.to_delta(s);
            if delta.qps.is_some() || delta.tls_profile.is_some() || delta.use_browser.is_some() {
                log::info!(
                    "[crawler] 响应态势触发策略调整 qps={:?} tls={:?} browser={:?} stealth={:?}",
                    delta.qps,
                    delta.tls_profile,
                    delta.use_browser,
                    delta.stealth_level
                );
            }
        }
        Err(e) => {
            reward.record(EventKind::Timeout);
            log::warn!("[crawler] {} 失败: {}", url, e);
        }
    }
}
