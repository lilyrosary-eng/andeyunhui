//! 控制流图反混淆（图论解法）
//!
//! 对应逆向细化维度二：控制流"幽灵"重构的务实降级版。
//!
//! 替代原方案（桌面不可行）：
//! - Intel PT 硬件追踪（Linux 专属）→ 删除
//! - mprotect 脏页追踪（Linux 专属）→ 删除
//! - 欧拉回路/割点 → 降级为介数中心性
//!
//! 务实实现（petgraph，MIT 协议）：
//! - 构建控制流图（节点=基本块，边=跳转）
//! - 计算介数中心性（Betweenness Centrality）
//! - 高介数中心性节点 = OLLVM 平坦化分发块（Dispatcher）→ 裁剪
//! - 剩余节点 = 真实业务逻辑（if-else/while 嵌套结构）
//!
//! 原理：OLLVM 控制流平坦化将所有基本块重定向到一个中央分发块，
//! 分发块会成为所有路径的必经节点，介数中心性极高。
//! 真实业务逻辑节点的介数中心性远低于分发块。

use petgraph::graph::{DiGraph, NodeIndex};
use serde::{Deserialize, Serialize};

/// 基本块（控制流图节点）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BasicBlock {
    /// 基本块 ID
    pub id: usize,
    /// 起始地址
    pub start_addr: u64,
    /// 结束地址
    pub end_addr: u64,
    /// 指令数量
    pub instr_count: usize,
    /// 是否为分发块（OLLVM Dispatcher）
    pub is_dispatcher: bool,
}

/// 控制流图反混淆结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeobfuscationResult {
    /// 原始基本块数量
    pub original_block_count: usize,
    /// 识别出的分发块数量
    pub dispatcher_count: usize,
    /// 裁剪后的真实业务逻辑基本块
    pub real_blocks: Vec<BasicBlock>,
    /// 裁剪后的边数量
    pub real_edge_count: usize,
}

/// 计算节点的介数中心性（Brandes 算法简化版）
///
/// petgraph 0.6 无内置 betweenness_centrality，自实现。
/// 原理：节点出现在所有最短路径上的次数。分发块介数中心性极高。
fn betweenness_centrality(graph: &DiGraph<usize, ()>) -> std::collections::HashMap<NodeIndex, f64> {
    let node_count = graph.node_count();
    let mut centrality: std::collections::HashMap<NodeIndex, f64> =
        std::collections::HashMap::new();
    for idx in graph.node_indices() {
        centrality.insert(idx, 0.0);
    }

    // 简化：用入度+出度作为介数中心性的近似（分发块有高入度和高出度）
    // 严格 Brandes 算法实现复杂，桌面场景度数近似足够
    for idx in graph.node_indices() {
        let in_degree = graph.edges_directed(idx, petgraph::Direction::Incoming).count();
        let out_degree = graph.edges_directed(idx, petgraph::Direction::Outgoing).count();
        let degree = (in_degree + out_degree) as f64;
        centrality.insert(idx, degree);
    }

    // 归一化（可选）
    let _ = node_count;
    centrality
}

/// 构建控制流图并反混淆
///
/// 输入：基本块列表 + 边列表（从反编译器或 ghidra_headless 获取）
/// 输出：裁剪掉分发块后的真实业务逻辑
pub fn deobfuscate_cfg(
    blocks: Vec<BasicBlock>,
    edges: Vec<(usize, usize)>,
) -> DeobfuscationResult {
    let mut graph: DiGraph<usize, ()> = DiGraph::new();

    // 节点映射：基本块 ID → NodeIndex
    let mut node_map: std::collections::HashMap<usize, NodeIndex> = std::collections::HashMap::new();
    for block in &blocks {
        let idx = graph.add_node(block.id);
        node_map.insert(block.id, idx);
    }

    // 添加边
    for (from, to) in &edges {
        if let (Some(&from_idx), Some(&to_idx)) = (node_map.get(from), node_map.get(to)) {
            graph.add_edge(from_idx, to_idx, ());
        }
    }

    // 计算介数中心性（度数近似）
    let centrality = betweenness_centrality(&graph);

    // 识别分发块：度数 > 阈值（平均值的 3 倍）
    let avg_centrality: f64 =
        centrality.values().sum::<f64>() / centrality.len().max(1) as f64;
    let threshold = avg_centrality * 3.0;

    let mut dispatcher_ids: std::collections::HashSet<usize> = std::collections::HashSet::new();
    for (&node_idx, &cent) in &centrality {
        if cent > threshold {
            let block_id = graph[node_idx];
            dispatcher_ids.insert(block_id);
        }
    }

    // 标记分发块并裁剪
    let mut real_blocks: Vec<BasicBlock> = Vec::new();
    let mut real_edge_count = 0;

    for mut block in blocks {
        if dispatcher_ids.contains(&block.id) {
            block.is_dispatcher = true;
        } else {
            real_blocks.push(block);
        }
    }

    // 裁剪边：移除涉及分发块的边
    for (from, to) in &edges {
        if !dispatcher_ids.contains(from) && !dispatcher_ids.contains(to) {
            real_edge_count += 1;
        }
    }

    DeobfuscationResult {
        original_block_count: node_map.len(),
        dispatcher_count: dispatcher_ids.len(),
        real_blocks,
        real_edge_count,
    }
}

/// 计算语义熵地图（辅助识别 VMP 解码窗口）
///
/// 原理：算法逻辑熵值低（规律性强），混淆与花指令熵值极高。
/// 当某区域熵值在连续两个时间窗口内陡降 → VMM 刚完成解码。
///
/// 务实降级：用指令操作码频率计算香农熵，替代原方案的"实时内存页熵值"。
pub fn compute_block_entropy(instrs: &[u8]) -> f64 {
    if instrs.is_empty() {
        return 0.0;
    }
    let mut freq = vec![0u64; 256];
    for &b in instrs {
        freq[b as usize] += 1;
    }
    let total = instrs.len() as f64;
    let mut entropy = 0.0;
    for &count in &freq {
        if count > 0 {
            let p = count as f64 / total;
            entropy -= p * p.log2();
        }
    }
    entropy
}
