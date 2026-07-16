//! 符号持久化存储（跨会话复用）
//!
//! 对应逆向细化维度六：跨指令集IR与认知快照的务实降级版。
//!
//! 替代原方案：
//! - 自建SSA IR（违背取巧原则）→ 删除，用 ghidra_headless P-Code（外部进程）
//! - 增量式重编译（复杂）→ 删除
//! - MMAP 全局上下文（Linux 优化）→ 删除，用内存 HashMap
//! - 符号持久化存储 → 保留精神，用 serde JSON
//!
//! 务实实现：
//! - 内存 HashMap 存储高价值符号（函数名/地址/协议字段/S盒/DFA）
//! - 跨会话复用：相同目标的逆向结果不重复分析
//! - @reset 仅清除断点，保留符号（"悬置"语义）
//! - 后续需要文件持久化时：serde_json 序列化到 app_data/gongfang/symbols.json

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

use super::protocol::ProtocolDfa;

/// 高价值符号（逆向分析的核心资产）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Symbol {
    /// 符号名（如 SSL_read / memcmp / decrypt_session_key）
    pub name: String,
    /// 地址（运行时基址 + 偏移，或静态地址）
    pub address: u64,
    /// 符号类型
    pub kind: SymbolKind,
    /// 关联的元信息（如函数签名、S盒大小、协议字段索引）
    pub meta: HashMap<String, String>,
}

/// 符号类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum SymbolKind {
    /// 函数入口
    Function,
    /// 加密函数（SSL_read/encrypt/decrypt）
    CryptoFunction,
    /// 比较函数（memcmp/strcmp）
    CompareFunction,
    /// 已识别的 S 盒
    SBox,
    /// 协议字段定义
    ProtocolField,
    /// 校验函数
    ChecksumFunction,
}

/// 符号存储（按目标 URL 分组）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SymbolStore {
    /// 目标 URL → 符号列表
    symbols: HashMap<String, Vec<Symbol>>,
    /// 目标 URL → 协议状态机
    dfas: HashMap<String, ProtocolDfa>,
    /// 目标 URL → 已识别的加密算法
    crypto_algos: HashMap<String, String>,
}

impl SymbolStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// 从全局单例加载（内存版，未持久化到文件）
    pub fn load() -> Arc<Self> {
        GLOBAL_STORE.read().clone().into()
    }

    /// 保存到全局单例
    pub fn save(&self) {
        *GLOBAL_STORE.write() = self.clone();
    }

    /// 查询目标的协议状态机
    pub fn protocol_dfa(&self, url: &str) -> Option<ProtocolDfa> {
        self.dfas.get(url).cloned()
    }

    /// 记录协议状态机
    pub fn record_dfa(&mut self, url: &str, dfa: ProtocolDfa) {
        self.dfas.insert(url.to_string(), dfa);
        self.save();
    }

    /// 查询目标的加密算法
    pub fn crypto_algo(&self, url: &str) -> Option<&String> {
        self.crypto_algos.get(url)
    }

    /// 记录加密算法
    pub fn record_crypto(&mut self, url: &str, algo: String) {
        self.crypto_algos.insert(url.to_string(), algo);
        self.save();
    }

    /// 查询目标的符号列表
    pub fn symbols(&self, url: &str) -> Option<&Vec<Symbol>> {
        self.symbols.get(url)
    }

    /// 添加符号
    pub fn add_symbol(&mut self, url: &str, symbol: Symbol) {
        self.symbols.entry(url.to_string()).or_default().push(symbol);
        self.save();
    }

    /// 按类型查询符号
    pub fn symbols_by_kind(&self, url: &str, kind: SymbolKind) -> Vec<&Symbol> {
        self.symbols
            .get(url)
            .map(|v| v.iter().filter(|s| s.kind == kind).collect())
            .unwrap_or_default()
    }

    /// @reset 语义：仅清除断点（符号保留）
    ///
    /// 对应维度六"悬置（Suspend）"：符号不随会话结束而消失，
    /// 24小时内的协议字段、S盒、状态机转移表跨会话复用。
    pub fn reset_session(&mut self, url: &str) {
        // 仅清除运行时地址（断点），保留符号名和元信息
        if let Some(symbols) = self.symbols.get_mut(url) {
            for s in symbols.iter_mut() {
                s.address = 0; // 清除地址，保留 name/kind/meta
            }
        }
        self.save();
    }
}

/// 全局符号存储单例（lazy init，内存版）
static GLOBAL_STORE: once_cell::sync::Lazy<RwLock<SymbolStore>> =
    once_cell::sync::Lazy::new(|| RwLock::new(SymbolStore::new()));
