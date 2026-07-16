//! 协议状态机文法归纳（L*算法简化版）
//!
//! 对应逆向细化维度四：通过主动探测学习未知私有协议的状态机。
//!
//! L*算法（Angluin 1987）核心思想：
//! 1. 维护观察表（前缀 S × 区分序列 E → 响应 T）
//! 2. 通过成员查询（发送探测包）填充观察表
//! 3. 当观察表闭合且一致时，构造假设 DFA
//! 4. 通过等价查询验证假设，反例加入 S 重复
//!
//! 务实简化（桌面场景）：
//! - 字母表：离散化的消息类型（u8），如 0x01=Login, 0x02=Query
//! - 响应：响应类别（u8），如 0x00=Error, 0x01=OK, 0x02=Challenge
//! - 不做完整 L*，做"响应聚类 + 状态推断"：
//!   * 相同响应序列聚类为一个状态
//!   * 不同响应 = 不同状态
//!   * 构造状态转移表
//!
//! 替代原方案：SO_TXTIME 零干扰探测（Linux 专属）→ 普通顺序探测 + 时间侧信道
//! 时间侧信道：某字段变动导致响应延迟增加 → 关键索引/校验种子

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

/// 协议状态机（确定性有限自动机 DFA）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProtocolDfa {
    /// 状态集合（整数索引，0 = 起始状态）
    pub states: Vec<usize>,
    /// 字母表（消息类型集合）
    pub alphabet: Vec<u8>,
    /// 转移函数：(状态, 输入) → 下一状态
    pub transitions: HashMap<(usize, u8), usize>,
    /// 接受状态（成功响应的状态）
    pub accept_states: Vec<usize>,
    /// 起始状态（固定为 0）
    pub initial: usize,
}

impl ProtocolDfa {
    pub fn new() -> Self {
        Self {
            states: vec![0],
            alphabet: Vec::new(),
            transitions: HashMap::new(),
            accept_states: Vec::new(),
            initial: 0,
        }
    }

    pub fn state_count(&self) -> usize {
        self.states.len()
    }

    pub fn transition_count(&self) -> usize {
        self.transitions.len()
    }

    /// 查询转移：(状态, 输入) → 下一状态
    pub fn next_state(&self, state: usize, input: u8) -> Option<usize> {
        self.transitions.get(&(state, input)).copied()
    }

    /// 模拟 DFA 执行输入序列，返回终态
    pub fn run(&self, inputs: &[u8]) -> usize {
        let mut current = self.initial;
        for &input in inputs {
            if let Some(next) = self.next_state(current, input) {
                current = next;
            } else {
                // 无转移：停留当前状态（或可定义为错误状态）
                break;
            }
        }
        current
    }
}

/// 探测结果（单次查询的响应）
#[derive(Debug, Clone)]
pub struct ProbeResult {
    /// 输入序列
    pub input: Vec<u8>,
    /// 响应类别（0x00=Error, 0x01=OK, 0x02=Challenge 等）
    pub response: u8,
    /// 响应延迟（时间侧信道用）
    pub latency: Duration,
}

/// 探测 Oracle trait（由调用方实现，负责实际发包+收包）
///
/// 实现方可以：
/// - 通过 reqwest 发送 HTTP/WebSocket 探测
/// - 通过 raw socket 发送二进制协议探测
/// - 通过 frida-gum Hook 目标函数模拟输入
pub trait ProbeOracle {
    fn probe(&mut self, input: &[u8]) -> ProbeResult;
}

/// L*协议文法归纳器
pub struct Learner<O: ProbeOracle> {
    oracle: O,
    /// 观察表：(前缀, 区分序列) → 响应
    observation: HashMap<(Vec<u8>, Vec<u8>), u8>,
    /// 已发现的状态（用前缀表示，相同响应序列的前缀归为同一状态）
    prefixes: Vec<Vec<u8>>,
    /// 区分序列集合
    distinguishing: Vec<Vec<u8>>,
    /// 字母表
    alphabet: Vec<u8>,
}

impl<O: ProbeOracle> Learner<O> {
    pub fn new(oracle: O, alphabet: Vec<u8>) -> Self {
        Self {
            oracle,
            observation: HashMap::new(),
            prefixes: vec![vec![]], // 空前缀 = 起始状态
            distinguishing: vec![vec![]], // 空区分序列
            alphabet,
        }
    }

    /// 执行成员查询：发送 input + suffix，观察响应
    fn membership_query(&mut self, prefix: &[u8], suffix: &[u8]) -> u8 {
        let key = (prefix.to_vec(), suffix.to_vec());
        if let Some(&resp) = self.observation.get(&key) {
            return resp; // 缓存命中
        }
        let mut full_input = prefix.to_vec();
        full_input.extend_from_slice(suffix);
        let result = self.oracle.probe(&full_input);
        self.observation.insert(key, result.response);
        result.response
    }

    /// 检查观察表闭合性：每个 (prefix, a) 的响应行是否与某现有 prefix 相同
    fn is_closed(&self) -> bool {
        for prefix in &self.prefixes {
            for &a in &self.alphabet {
                let mut sa = prefix.clone();
                sa.push(a);
                let row_sa = self.row(&sa);
                if !self.prefixes.iter().any(|p| self.row(p) == row_sa) {
                    return false;
                }
            }
        }
        true
    }

    /// 获取某前缀的响应行（对所有区分序列的响应）
    fn row(&self, prefix: &[u8]) -> Vec<u8> {
        self.distinguishing
            .iter()
            .map(|d| self.observation.get(&(prefix.to_vec(), d.clone())).copied().unwrap_or(0))
            .collect()
    }

    /// 闭合观察表：将新行加入 prefixes
    fn close(&mut self) {
        loop {
            let mut new_prefix = None;
            'outer: for prefix in &self.prefixes {
                for &a in &self.alphabet {
                    let mut sa = prefix.clone();
                    sa.push(a);
                    let row_sa = self.row(&sa);
                    if !self.prefixes.iter().any(|p| self.row(p) == row_sa) {
                        new_prefix = Some(sa);
                        break 'outer;
                    }
                }
            }
            if let Some(sa) = new_prefix {
                // 填充新行的观察值（clone distinguishing 避免借用冲突）
                let distinguishing = self.distinguishing.clone();
                for d in &distinguishing {
                    self.membership_query(&sa, d);
                }
                self.prefixes.push(sa);
            } else {
                break;
            }
        }
    }

    /// 归纳 DFA（假设观察表已闭合且一致）
    pub fn learn(mut self, max_rounds: usize) -> ProtocolDfa {
        // 初始填充观察表
        for prefix in &self.prefixes.clone() {
            for d in &self.distinguishing.clone() {
                self.membership_query(prefix, d);
            }
        }

        // 迭代闭合 + 扩展区分序列
        for _ in 0..max_rounds {
            self.close();

            // 检查一致性：相同行的 prefix，扩展后也应相同
            // 若不一致，添加新区分序列
            let mut new_d = None;
            'consistency: for i in 0..self.prefixes.len() {
                for j in (i + 1)..self.prefixes.len() {
                    let p1 = &self.prefixes[i];
                    let p2 = &self.prefixes[j];
                    if self.row(p1) == self.row(p2) {
                        // 行相同，检查扩展后是否仍相同
                        for &a in &self.alphabet {
                            let mut sa1 = p1.clone();
                            sa1.push(a);
                            let mut sa2 = p2.clone();
                            sa2.push(a);
                            let row_sa1 = self.row(&sa1);
                            let row_sa2 = self.row(&sa2);
                            if row_sa1 != row_sa2 {
                                // 找到不一致，添加区分序列 a + 找到差异的区分序列
                                for (idx, (r1, r2)) in row_sa1.iter().zip(row_sa2.iter()).enumerate() {
                                    if r1 != r2 {
                                        let mut new_seq = vec![a];
                                        new_seq.extend_from_slice(&self.distinguishing[idx]);
                                        new_d = Some(new_seq);
                                        break 'consistency;
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if let Some(d) = new_d {
                // 新区分序列：填充所有 prefix 的观察值（clone prefixes 避免借用冲突）
                let prefixes = self.prefixes.clone();
                for prefix in &prefixes {
                    self.membership_query(prefix, &d);
                }
                self.distinguishing.push(d);
            } else {
                // 一致且闭合，构造 DFA
                break;
            }
        }

        self.build_dfa()
    }

    /// 从观察表构造 DFA
    fn build_dfa(&self) -> ProtocolDfa {
        let mut dfa = ProtocolDfa::new();
        dfa.alphabet = self.alphabet.clone();

        // 状态 = prefixes（相同行的 prefix 合并）
        let mut state_map: HashMap<Vec<u8>, usize> = HashMap::new();
        let mut states: Vec<usize> = Vec::new();

        for (idx, prefix) in self.prefixes.iter().enumerate() {
            let row = self.row(prefix);
            // 检查是否有相同行的状态
            let existing = state_map.iter().find(|(p, _)| self.row(p) == row);
            let state_id = match existing {
                Some((_, &id)) => id,
                None => {
                    let id = states.len();
                    states.push(id);
                    state_map.insert(prefix.clone(), id);
                    id
                }
            };
            if idx == 0 {
                dfa.initial = state_id;
            }
        }

        // 接受状态：响应行最后一个元素（空区分序列的响应）为非零的状态
        for prefix in &self.prefixes {
            if let Some(&resp) = self.observation.get(&(prefix.clone(), vec![])) {
                if resp != 0 {
                    if let Some(&state_id) = state_map.get(prefix) {
                        if !dfa.accept_states.contains(&state_id) {
                            dfa.accept_states.push(state_id);
                        }
                    }
                }
            }
        }

        // 转移函数
        for prefix in &self.prefixes {
            for &a in &self.alphabet {
                let mut sa = prefix.clone();
                sa.push(a);
                let row_sa = self.row(&sa);
                let from_state = state_map.get(prefix).copied().unwrap_or(0);
                let to_state = state_map
                    .iter()
                    .find(|(p, _)| self.row(p) == row_sa)
                    .map(|(_, &id)| id)
                    .unwrap_or(0);
                dfa.transitions.insert((from_state, a), to_state);
            }
        }

        dfa.states = states;
        dfa
    }
}

/// 时间侧信道字段识别
///
/// 对某字段进行 0x00-0xFF 爆破，检测响应延迟差异：
/// - 延迟显著增加 → 关键索引/校验种子
/// - 延迟稳定 → 普通字段
pub fn identify_timing_sensitive_field<O: ProbeOracle>(
    oracle: &mut O,
    base_input: &[u8],
    field_offset: usize,
) -> Option<TimingSideChannel> {
    let mut latencies: Vec<(u8, Duration)> = Vec::with_capacity(256);

    for v in 0u8..=255 {
        let mut input = base_input.to_vec();
        if field_offset < input.len() {
            input[field_offset] = v;
        } else {
            input.push(v);
        }
        let result = oracle.probe(&input);
        latencies.push((v, result.latency));
    }

    // 计算平均延迟
    let avg_ns: u128 = latencies.iter().map(|(_, d)| d.as_nanos()).sum::<u128>() / 256;

    // 找出延迟显著高于平均的值（>150% 平均延迟）
    let outliers: Vec<u8> = latencies
        .iter()
        .filter(|(_, d)| d.as_nanos() as f64 > avg_ns as f64 * 1.5)
        .map(|(v, _)| *v)
        .collect();

    if outliers.is_empty() {
        None
    } else {
        Some(TimingSideChannel {
            field_offset,
            avg_latency_ns: avg_ns as u64,
            sensitive_values: outliers,
        })
    }
}

/// 时间侧信道识别结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimingSideChannel {
    pub field_offset: usize,
    pub avg_latency_ns: u64,
    /// 延迟显著高于平均的字段值（关键索引/校验种子）
    pub sensitive_values: Vec<u8>,
}
