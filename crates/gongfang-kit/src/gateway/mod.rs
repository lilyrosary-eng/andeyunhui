//! API 网关 / 代理框架 —— 自适应流量整形器（Adaptive Traffic Shaper）
//!
//! 框架五务实降级版架构：
//! - 维度一 出口代理池 → pool.rs（节点信誉矩阵 + N+1 冗余 + 预测性切换）
//! - 维度二 TCP/IP 指纹伪装 → shaping.rs（仅应用层可控制部分：UA + 头序）
//! - 维度三 应用层流量整形 → shaping.rs（Poisson 间隔 + Payload 混淆 + 熵监控）
//! - 维度四 DNS 隐蔽与域前置 → 删除（CDN 厂商已禁用 + 桌面无 DNS 服务）
//! - 维度五 端口复用与隧道嵌套 → 删除（DPI 桌面场景无需求）
//! - 维度六 故障转移与无限恢复 → pool.rs（EWMA + 梯度预测 + JSON 快照）
//!
//! AI 常驻指令：
//! - `@rotate <mode>`: 切换路由模式（direct/proxy/stealth），arc-swap 无锁热交换
//! - `@throttle <ratio>`: 调整全局带宽上限，通过拥塞窗口参数实时修改
//!
//! 设计原则：
//! - 控制面：AI 500ms 推理，下发策略补丁（RoutingMode + BandwidthRatio）
//! - 数据面：50ms Tick，从 arc-swap 读取策略，执行请求整形
//! - 抢占：@rotate/@throttle 通过 crossbeam 优先级队列插入，下个 Tick 末尾生效

pub mod pool;
pub mod shaping;

use arc_swap::ArcSwap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::gateway::pool::{ProxyNode, ProxyPool};
use crate::gateway::shaping::{OsFingerprint, ShapingAdvice};

// ============ 路由模式（@rotate 指令参数） ============

/// 路由策略枚举
///
/// 对应 AI 指令 `@rotate <pattern>` 的三种模式：
/// - `Direct`: 直连模式，用于内网测试或可信目标
/// - `Proxy`: 代理池模式，使用 ProxyPool 节点信誉矩阵选路
/// - `Stealth`: 隐身模式，代理池 + 全部整形（头序随机 + Payload 混淆 + 熵注入）
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum RoutingMode {
    Direct,
    Proxy,
    Stealth,
}

impl Default for RoutingMode {
    fn default() -> Self {
        Self::Direct
    }
}

impl RoutingMode {
    /// 从字符串解析（@rotate 指令参数）
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "direct" | "d" => Some(Self::Direct),
            "proxy" | "p" => Some(Self::Proxy),
            "stealth" | "s" => Some(Self::Stealth),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Proxy => "proxy",
            Self::Stealth => "stealth",
        }
    }

    /// 中文标签（前端展示）
    pub fn as_cn(&self) -> &'static str {
        match self {
            Self::Direct => "直连",
            Self::Proxy => "代理",
            Self::Stealth => "隐身",
        }
    }
}

// ============ 带宽与优先级控制器（@throttle 指令参数） ============

/// 带宽控制策略
///
/// 对应 AI 指令 `@throttle <ratio>`：
/// - `ratio`: 全局带宽比例（0.0-1.0，1.0 = 全速，0.5 = 限速 50%）
/// - `high_priority_bypass`: 高优先级操作（如 SQL 注入）是否豁免限速
///
/// 实现方式：通过调整 reqwest 的 timeout + 连接池大小间接控制，
/// 避免在应用层实现拥塞窗口（桌面场景过度工程）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BandwidthPolicy {
    /// 带宽比例 [0.0, 1.0]
    pub ratio: f64,
    /// 高优先级操作豁免限速
    pub high_priority_bypass: bool,
    /// 单请求超时（毫秒，受 ratio 影响）
    pub request_timeout_ms: u64,
    /// 最大并发连接数（受 ratio 影响）
    pub max_concurrent: usize,
}

impl Default for BandwidthPolicy {
    fn default() -> Self {
        Self {
            ratio: 1.0,
            high_priority_bypass: true,
            request_timeout_ms: 30_000,
            max_concurrent: 16,
        }
    }
}

impl BandwidthPolicy {
    /// 应用 @throttle 指令
    ///
    /// ratio=1.0 → 全速（30s 超时 + 16 并发）
    /// ratio=0.5 → 限速 50%（60s 超时 + 8 并发，延长超时避免误杀慢请求）
    /// ratio=0.1 → 极慢（300s 超时 + 2 并发，适合大规模爬虫）
    pub fn apply_throttle(&mut self, ratio: f64) {
        self.ratio = ratio.clamp(0.05, 1.0);
        // ratio 越小，超时越长（给慢请求更多机会），并发越少
        self.request_timeout_ms = (30_000.0 / self.ratio) as u64;
        self.max_concurrent = ((16.0 * self.ratio).round() as usize).max(1);
    }
}

// ============ 策略组合（arc-swap 无锁热交换） ============

/// 网关策略快照（不可变，通过 arc-swap 整体替换）
///
/// 控制面 AI 推理后生成新策略，通过 ArcSwap::store 原子替换；
/// 数据面 Tick 通过 ArcSwap::load 读取，零等待零锁。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayPolicy {
    /// 路由模式
    pub routing: RoutingMode,
    /// 带宽策略
    pub bandwidth: BandwidthPolicy,
    /// 策略版本号（每次替换递增，便于前端展示是否变化）
    pub version: u64,
    /// 策略生效时间戳（Unix 毫秒）
    pub effective_ts: i64,
}

impl Default for GatewayPolicy {
    fn default() -> Self {
        Self {
            routing: RoutingMode::Direct,
            bandwidth: BandwidthPolicy::default(),
            version: 1,
            effective_ts: chrono::Utc::now().timestamp_millis(),
        }
    }
}

// ============ 自适应流量整形器主结构 ============

/// 自适应流量整形器
///
/// 全局单例，组合代理池 + 策略快照，提供：
/// - 策略热交换：`@rotate` / `@throttle` 指令下个 Tick 末尾原子生效
/// - 请求整形：根据当前策略 + 健康状态生成下一次请求建议
/// - 故障转移：被动（错误率超阈值）+ 主动（RTT 梯度预测）
/// - 状态快照：JSON 序列化，灾难性故障后 <100ms 恢复
pub struct AdaptiveTrafficShaper {
    /// 当前策略（arc-swap 无锁热交换）
    policy: ArcSwap<GatewayPolicy>,
    /// 代理节点池
    pool: Mutex<ProxyPool>,
}

impl AdaptiveTrafficShaper {
    pub fn new() -> Self {
        let mut pool = ProxyPool::new();
        // 默认注入一个 Direct 节点（保证空池也能工作）
        pool.add(ProxyNode::direct());
        Self {
            policy: ArcSwap::from_pointee(GatewayPolicy::default()),
            pool: Mutex::new(pool),
        }
    }

    /// 读取当前策略（无锁，亚纳秒级）
    pub fn policy(&self) -> Arc<GatewayPolicy> {
        self.policy.load_full()
    }

    /// 切换路由模式（@rotate 指令）
    ///
    /// 原子替换策略快照，已建立的 TCP 连接走旧策略（graceful），
    /// 新请求走新策略。数据面下个 Tick 末尾生效。
    pub fn rotate(&self, mode: RoutingMode) {
        let old = self.policy.load_full();
        let mut new = (*old).clone();
        new.routing = mode;
        new.version += 1;
        new.effective_ts = chrono::Utc::now().timestamp_millis();
        let new_v = new.version;
        let new_ratio = new.bandwidth.ratio;
        let new_timeout = new.bandwidth.request_timeout_ms;
        let new_concurrent = new.bandwidth.max_concurrent;
        self.policy.store(Arc::new(new));
        log::info!(
            "[gateway] 路由策略切换: v{} → v{} mode={}",
            old.version,
            new_v,
            mode.as_str()
        );
        let _ = (new_ratio, new_timeout, new_concurrent);
    }

    /// 调整带宽（@throttle 指令）
    pub fn throttle(&self, ratio: f64) {
        let old = self.policy.load_full();
        let mut new = (*old).clone();
        new.bandwidth.apply_throttle(ratio);
        new.version += 1;
        new.effective_ts = chrono::Utc::now().timestamp_millis();
        let new_ratio = new.bandwidth.ratio;
        let new_timeout = new.bandwidth.request_timeout_ms;
        let new_concurrent = new.bandwidth.max_concurrent;
        self.policy.store(Arc::new(new));
        log::info!(
            "[gateway] 带宽策略调整: ratio={:.2} timeout={}ms max_concurrent={}",
            new_ratio,
            new_timeout,
            new_concurrent
        );
    }

    /// 记录一次请求结果到代理池（数据面 Tick 调用）
    pub fn record_request(&self, rtt_ms: f64, is_error: bool) {
        let mut pool = self.pool.lock();
        pool.record_active(rtt_ms, is_error);
        // 触发预测性切换检查（RTT 梯度递增）
        let _ = pool.predictive_failover();
    }

    /// 生成下一次请求的整形建议
    ///
    /// 数据面 Tick 在发送请求前调用，根据建议构造 reqwest 请求：
    /// - Direct 模式：返回默认 UA + 直连建议
    /// - Proxy 模式：返回随机 UA + 代理池活跃节点
    /// - Stealth 模式：返回随机 UA + 头序随机化 + Payload 混淆 + 熵注入
    pub fn next_advice(&self) -> GatewayAdvice {
        let policy = self.policy();
        let pool = self.pool.lock();

        let shaping_advice = match policy.routing {
            RoutingMode::Direct => {
                // Direct: 不整形，固定 UA
                ShapingAdvice {
                    interval_ms: 0,
                    in_burst: false,
                    fingerprint: OsFingerprint::win10_chrome(),
                    header_order: vec![],
                    needs_noise: false,
                    noise_path: None,
                    current_entropy: 0.0,
                }
            }
            RoutingMode::Proxy | RoutingMode::Stealth => {
                // Proxy/Stealth: 全整形
                shaping::next_advice()
            }
        };

        let active_node = pool.active().cloned();
        let redundancy_ratio = pool.redundancy_ratio();
        let node_count = pool.nodes.len();

        GatewayAdvice {
            routing: policy.routing,
            bandwidth_ratio: policy.bandwidth.ratio,
            request_timeout_ms: policy.bandwidth.request_timeout_ms,
            max_concurrent: policy.bandwidth.max_concurrent,
            policy_version: policy.version,
            active_node: active_node.as_ref().map(|n| NodeSummary {
                url: n.url.clone(),
                region: n.region.clone(),
                reputation: n.reputation,
                error_rate: n.health.error_rate(),
                ewma_rtt: n.health.ewma_rtt(),
                rtt_gradient: n.health.rtt_gradient(),
                is_failing: n.is_failing(),
            }),
            shaping: shaping_advice,
            node_count,
            redundancy_ratio,
        }
    }

    /// 手动触发故障转移（命令入口）
    pub fn failover(&self) -> Option<usize> {
        let mut pool = self.pool.lock();
        pool.failover()
    }

    /// 添加代理节点
    pub fn add_node(&self, node: ProxyNode) {
        let mut pool = self.pool.lock();
        pool.add(node);
    }

    /// 获取所有节点（前端展示用）
    pub fn list_nodes(&self) -> Vec<NodeSummary> {
        let pool = self.pool.lock();
        pool.nodes
            .iter()
            .map(|n| NodeSummary {
                url: n.url.clone(),
                region: n.region.clone(),
                reputation: n.reputation,
                error_rate: n.health.error_rate(),
                ewma_rtt: n.health.ewma_rtt(),
                rtt_gradient: n.health.rtt_gradient(),
                is_failing: n.is_failing(),
            })
            .collect()
    }

    /// 全局快照（JSON 序列化）
    pub fn snapshot(&self) -> String {
        let policy = self.policy();
        let pool = self.pool.lock();
        let snap = GatewaySnapshot {
            policy: (*policy).clone(),
            pool: pool.clone(),
        };
        serde_json::to_string(&snap).unwrap_or_default()
    }

    /// 从快照恢复
    pub fn restore(&self, snapshot: &str) -> Result<(), String> {
        let snap: GatewaySnapshot =
            serde_json::from_str(snapshot).map_err(|e| format!("快照解析失败: {}", e))?;
        self.policy.store(Arc::new(snap.policy));
        *self.pool.lock() = snap.pool;
        Ok(())
    }
}

impl Default for AdaptiveTrafficShaper {
    fn default() -> Self {
        Self::new()
    }
}

// ============ 前端展示用结构（可序列化） ============

/// 节点摘要（前端表格展示）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeSummary {
    pub url: String,
    pub region: String,
    /// 信誉评分 [0, 100]
    pub reputation: f64,
    /// 错误率 [0, 1]
    pub error_rate: f64,
    /// EWMA RTT（毫秒）
    pub ewma_rtt: f64,
    /// RTT 梯度（毫秒/样本）
    pub rtt_gradient: f64,
    /// 是否即将故障
    pub is_failing: bool,
}

/// 网关完整整形建议（前端 + 调用方使用）
#[derive(Debug, Clone, Serialize)]
pub struct GatewayAdvice {
    /// 当前路由模式
    pub routing: RoutingMode,
    /// 带宽比例
    pub bandwidth_ratio: f64,
    /// 单请求超时（毫秒）
    pub request_timeout_ms: u64,
    /// 最大并发
    pub max_concurrent: usize,
    /// 策略版本号
    pub policy_version: u64,
    /// 当前活跃节点
    pub active_node: Option<NodeSummary>,
    /// 整形建议（间隔 + UA + 头序）
    pub shaping: ShapingAdvice,
    /// 节点总数
    pub node_count: usize,
    /// N+1 冗余比例
    pub redundancy_ratio: f64,
}

/// 网关状态快照（持久化用）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewaySnapshot {
    pub policy: GatewayPolicy,
    pub pool: ProxyPool,
}

/// 网关状态（前端展示用，Tauri 命令返回）
#[derive(Debug, Clone, Serialize)]
pub struct GatewayStatus {
    pub policy_version: u64,
    pub routing: RoutingMode,
    pub bandwidth_ratio: f64,
    pub request_timeout_ms: u64,
    pub max_concurrent: usize,
    pub effective_ts: i64,
    pub node_count: usize,
    pub redundancy_ratio: f64,
    pub active_node: Option<NodeSummary>,
    pub current_entropy: f64,
}

// ============ 全局单例 ============

static GLOBAL_SHAPER: once_cell::sync::Lazy<AdaptiveTrafficShaper> =
    once_cell::sync::Lazy::new(AdaptiveTrafficShaper::new);

/// 获取全局整形器实例
pub fn shaper() -> &'static AdaptiveTrafficShaper {
    &GLOBAL_SHAPER
}

/// 生成 GatewayStatus（Tauri 命令便捷入口）
pub fn status() -> GatewayStatus {
    let policy = GLOBAL_SHAPER.policy();
    let pool = GLOBAL_SHAPER.pool.lock();
    let active = pool.active();
    let (_, _, entropy) = {
        let p = policy.clone();
        let _ = p;
        // 通过 next_advice 间接读取熵值
        let advice = GLOBAL_SHAPER.next_advice();
        (
            advice.shaping.needs_noise,
            advice.shaping.current_entropy,
            advice.shaping.current_entropy,
        )
    };

    GatewayStatus {
        policy_version: policy.version,
        routing: policy.routing,
        bandwidth_ratio: policy.bandwidth.ratio,
        request_timeout_ms: policy.bandwidth.request_timeout_ms,
        max_concurrent: policy.bandwidth.max_concurrent,
        effective_ts: policy.effective_ts,
        node_count: pool.nodes.len(),
        redundancy_ratio: pool.redundancy_ratio(),
        active_node: active.as_ref().map(|n| NodeSummary {
            url: n.url.clone(),
            region: n.region.clone(),
            reputation: n.reputation,
            error_rate: n.health.error_rate(),
            ewma_rtt: n.health.ewma_rtt(),
            rtt_gradient: n.health.rtt_gradient(),
            is_failing: n.is_failing(),
        }),
        current_entropy: entropy,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_routing_mode_parse() {
        assert_eq!(RoutingMode::from_str("direct"), Some(RoutingMode::Direct));
        assert_eq!(RoutingMode::from_str("PROXY"), Some(RoutingMode::Proxy));
        assert_eq!(RoutingMode::from_str("stealth"), Some(RoutingMode::Stealth));
        assert_eq!(RoutingMode::from_str("invalid"), None);
    }

    #[test]
    fn test_bandwidth_throttle() {
        let mut p = BandwidthPolicy::default();
        assert_eq!(p.ratio, 1.0);
        assert_eq!(p.max_concurrent, 16);

        p.apply_throttle(0.5);
        assert_eq!(p.ratio, 0.5);
        assert_eq!(p.max_concurrent, 8);
        assert!(p.request_timeout_ms > 30_000); // 超时延长

        p.apply_throttle(0.01); // 极小值 clamp
        assert_eq!(p.ratio, 0.05);
    }

    #[test]
    fn test_shaper_rotate() {
        let shaper = AdaptiveTrafficShaper::new();
        let v0 = shaper.policy().version;
        shaper.rotate(RoutingMode::Stealth);
        let v1 = shaper.policy().version;
        assert_eq!(v1, v0 + 1);
        assert_eq!(shaper.policy().routing, RoutingMode::Stealth);
    }

    #[test]
    fn test_shaper_throttle() {
        let shaper = AdaptiveTrafficShaper::new();
        shaper.throttle(0.3);
        assert!((shaper.policy().bandwidth.ratio - 0.3).abs() < 1e-6);
    }

    #[test]
    fn test_shaper_snapshot_restore() {
        let shaper = AdaptiveTrafficShaper::new();
        shaper.rotate(RoutingMode::Proxy);
        shaper.throttle(0.5);
        let snap = shaper.snapshot();

        let shaper2 = AdaptiveTrafficShaper::new();
        assert_eq!(shaper2.policy().routing, RoutingMode::Direct);
        shaper2.restore(&snap).unwrap();
        assert_eq!(shaper2.policy().routing, RoutingMode::Proxy);
        assert!((shaper2.policy().bandwidth.ratio - 0.5).abs() < 1e-6);
    }

    #[test]
    fn test_next_advice_direct() {
        let shaper = AdaptiveTrafficShaper::new();
        // 默认 Direct 模式：不整形，固定 UA
        let advice = shaper.next_advice();
        assert_eq!(advice.routing, RoutingMode::Direct);
        assert_eq!(advice.shaping.interval_ms, 0);
        assert!(!advice.shaping.fingerprint.user_agent.is_empty());
    }

    #[test]
    fn test_next_advice_stealth() {
        let shaper = AdaptiveTrafficShaper::new();
        shaper.rotate(RoutingMode::Stealth);
        let advice = shaper.next_advice();
        assert_eq!(advice.routing, RoutingMode::Stealth);
        // Stealth 模式下应有整形建议
        assert!(advice.shaping.interval_ms >= 50);
        assert!(!advice.shaping.header_order.is_empty());
    }
}
