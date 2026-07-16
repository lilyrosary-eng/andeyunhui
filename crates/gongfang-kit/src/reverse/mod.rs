//! 逆向工程框架（务实降级版）
//!
//! 替代原计划 6 维度（绝大部分 Linux/硬件/内核专属）：
//! - 维度一微架构侧信道（Prime+Probe/rdtscp/FFT）→ 删除（Linux+root+硬件特定，Windows 桌面不可行）
//! - 维度二控制流幽灵重构（Intel PT/mprotect 脏页）→ 降级（删 Intel PT/mprotect，保留图论反混淆）
//! - 维度三白盒加密代数击穿（DFA/Gröbner/SAT）→ 降级（删 DFA/Gröbner，保留卡方检验+特征向量库）
//! - 维度四协议状态机文法归纳（L*算法）→ 保留（纯算法，桌面可行，核心价值）
//! - 维度五幽灵调试（ptrace/eBPF/uprobe）→ 删除（Linux 专属，Windows 用 VEH/frida-gum 后续接入）
//! - 维度六跨指令集IR（自建SSA）→ 降级（删自建IR，用 ghidra_headless P-Code，符号持久化 serde JSON）
//!
//! 务实实现：
//! - protocol.rs：L*算法协议状态机归纳（主动探测+响应聚类+DFA 构造）
//! - crypto.rs：卡方检验检测非标准加密 + 已知算法特征向量库（汉明距离匹配）
//! - cfg.rs：petgraph 控制流图反混淆（介数中心性裁剪 OLLVM 平坦化分发块）
//! - symbols.rs：serde JSON 符号持久化（跨会话复用高价值符号/协议字段/S盒）
//! - static_analysis.rs：ghidra_headless 外部进程接口占位（后续接入）
//! - dynamic.rs：frida-gum 动态插桩接口占位（后续接入）

pub mod crypto;
pub mod protocol;
pub mod symbols;

#[cfg(feature = "reverse")]
pub mod cfg;

#[cfg(feature = "reverse")]
pub mod static_analysis;
#[cfg(feature = "reverse")]
pub mod dynamic;

use std::sync::Arc;
use crate::kernel::reward::RewardSignal;
use crate::kernel::strategy::Strategy;

/// Exploit 阶段执行入口（数据面 Tick 调用）
///
/// 逆向框架在 Exploit Phase 触发：
/// - 协议已归纳 → 构造二进制协议帧（替代 HTML 解析）
/// - 加密已识别 → 实时解密响应
/// - 控制流已反混淆 → 定位关键校验函数
pub async fn execute_exploit(s: &Strategy, reward: &Arc<RewardSignal>) {
    let url = match &s.focus_url {
        Some(u) if !u.is_empty() => u.clone(),
        _ => {
            log::debug!("[reverse] 无 focus_url，跳过 Exploit");
            return;
        }
    };

    log::info!(
        "[reverse] Exploit 阶段 {} (stealth={} tls={})",
        url,
        s.stealth_level,
        s.tls_profile
    );

    // 1. 查询已持久化的协议状态机（如果有）
    let symbols = symbols::SymbolStore::load();
    if let Some(dfa) = symbols.protocol_dfa(&url) {
        log::info!(
            "[reverse] 命中协议状态机 states={} transitions={}",
            dfa.state_count(),
            dfa.transition_count()
        );
        reward.record(crate::kernel::reward::EventKind::Credential);
    } else {
        // 2. 无已知协议，触发 L*算法主动学习
        log::info!("[reverse] 无已知协议状态机，建议启动 protocol::Learner 主动探测");
        reward.record(crate::kernel::reward::EventKind::Success);
    }
}
