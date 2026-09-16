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
use std::path::{Path, PathBuf};
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

impl SymbolKind {
    /// 转为字符串（前端/命令层用）
    pub fn as_str(&self) -> &'static str {
        match self {
            SymbolKind::Function => "function",
            SymbolKind::CryptoFunction => "crypto",
            SymbolKind::CompareFunction => "compare",
            SymbolKind::SBox => "sbox",
            SymbolKind::ProtocolField => "protocol",
            SymbolKind::ChecksumFunction => "checksum",
        }
    }

    /// 从字符串解析（未知默认 CryptoFunction）
    pub fn from_str(s: &str) -> SymbolKind {
        match s.to_lowercase().as_str() {
            "function" => SymbolKind::Function,
            "compare" => SymbolKind::CompareFunction,
            "sbox" => SymbolKind::SBox,
            "protocol" => SymbolKind::ProtocolField,
            "checksum" => SymbolKind::ChecksumFunction,
            _ => SymbolKind::CryptoFunction,
        }
    }
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

    /// 保存到全局单例，并在已设置存储路径时落盘
    pub fn save(&self) {
        *GLOBAL_STORE.write() = self.clone();
        if let Some(p) = STORAGE_PATH.get() {
            let _ = self.persist(p);
        }
    }

    /// 序列化为 JSON 字符串
    pub fn to_json(&self) -> String {
        serde_json::to_string(self)
            .unwrap_or_else(|_| "{\"symbols\":{},\"dfas\":{},\"crypto_algos\":{}}".to_string())
    }

    /// 从 JSON 字符串解析
    pub fn from_json(s: &str) -> Option<Self> {
        serde_json::from_str(s).ok()
    }

    /// 原子写盘（先写 .tmp 再改名，避免半截文件）
    pub fn persist(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建符号库目录失败: {}", e))?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, self.to_json()).map_err(|e| format!("符号库写入失败: {}", e))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("符号库替换失败: {}", e))?;
        Ok(())
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

/// 全局持久化路径（set_storage_path 设置后，save() 自动落盘）
static STORAGE_PATH: once_cell::sync::OnceCell<PathBuf> = once_cell::sync::OnceCell::new();

/// 从文件加载符号库（文件不存在或损坏返回 None）
pub fn load_symbol_file(path: &Path) -> Option<SymbolStore> {
    let s = std::fs::read_to_string(path).ok()?;
    SymbolStore::from_json(&s)
}

/// 设置符号库持久化目录（应用/内核启动时调用一次）；
/// 若该目录下已有 symbols.json 则加载进全局存储，实现跨会话复用。
pub fn set_storage_path(dir: PathBuf) {
    let path = dir.join("symbols.json");
    let _ = STORAGE_PATH.set(path);
    if let Some(p) = STORAGE_PATH.get() {
        if let Some(loaded) = load_symbol_file(p) {
            *GLOBAL_STORE.write() = loaded;
        }
    }
}

/// 当前持久化路径（未设置则为 None）
pub fn storage_path() -> Option<PathBuf> {
    STORAGE_PATH.get().cloned()
}

// ================= 单元测试：序列化 / 落盘往返 =================
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_roundtrip_preserves_symbols() {
        let mut store = SymbolStore::new();
        store.add_symbol(
            "https://example.com/api",
            Symbol {
                name: "decrypt_session".into(),
                address: 0x401000,
                kind: SymbolKind::CryptoFunction,
                meta: HashMap::new(),
            },
        );
        let json = store.to_json();
        let restored = SymbolStore::from_json(&json).expect("应能解析");
        let syms = restored.symbols("https://example.com/api").unwrap();
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "decrypt_session");
        assert_eq!(syms[0].kind, SymbolKind::CryptoFunction);
    }

    #[test]
    fn persist_load_file_roundtrip() {
        let dir = std::env::temp_dir().join(format!("gongfang_symbols_test_{}", std::process::id()));
        let path = dir.join("symbols.json");
        let mut store = SymbolStore::new();
        store.record_crypto("target-a", "AES-256-CBC".to_string());
        store.persist(&path).expect("写盘应成功");

        let loaded = load_symbol_file(&path).expect("应加载成功");
        assert_eq!(loaded.crypto_algo("target-a").map(|s| s.as_str()), Some("AES-256-CBC"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
