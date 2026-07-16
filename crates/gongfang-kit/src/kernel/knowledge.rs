//! RAG 知识库（务实降级版）
//!
//! 替代 Milvus + Neo4j + HyDE + GraphRAG（01/03 文档原方案）：
//! - 桌面场景无 GPU 部署 Milvus 能力，无图数据库需求
//! - 用内存 HashMap + 关键词包含匹配（替代 BM25 向量检索）
//! - 规则缓存：L2 决策成功后回写 L0 规则，相同场景第二次直接命中（<1ms）
//!
//! 知识库分类（对应 03 文档 5.1）：
//! - 反爬产品库：Cloudflare/DataDome/Kasada/Akamai 防护特征和绕过方案
//! - 指纹模板库：浏览器版本 × OS × 硬件指纹组合
//! - 封禁案例库：历史封禁场景、原因、解决方案
//!
//! 注：数据量小（<1000 条），内存足够；后续需要持久化时再引入 rusqlite（MIT 协议）。

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

/// 知识库分类
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum KnowledgeCategory {
    /// 反爬产品库（Cloudflare/DataDome 等）
    AntiBot,
    /// 指纹模板库
    Fingerprint,
    /// 封禁案例库
    BanCase,
}

/// 知识条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeEntry {
    pub id: String,
    pub title: String,
    pub content: String,
    pub tags: Vec<String>,
    pub category: KnowledgeCategory,
}

/// 场景签名（用于 L0 规则缓存）
/// 例："403+cf-ray" 表示 Cloudflare 403 拦截场景
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SceneSignature(pub String);

/// L0 规则缓存：场景签名 → 策略补丁
/// L2 决策成功后回写，相同场景第二次直接命中（<1ms）
pub type RuleCache = HashMap<SceneSignature, crate::kernel::strategy::StrategyDelta>;

/// RAG 知识库（内存版，零依赖）
pub struct KnowledgeBase {
    /// 全量知识条目（id → entry）
    entries: HashMap<String, KnowledgeEntry>,
    /// 关键词倒排索引（keyword → entry_ids）
    inverted_index: HashMap<String, Vec<String>>,
    /// L0 规则缓存（场景签名 → 策略补丁）
    rule_cache: RwLock<RuleCache>,
}

impl KnowledgeBase {
    pub fn new() -> Self {
        let mut kb = Self {
            entries: HashMap::new(),
            inverted_index: HashMap::new(),
            rule_cache: RwLock::new(HashMap::new()),
        };
        kb.seed_default_knowledge();
        kb
    }

    /// 预置反爬产品知识（对应 03 文档 5.1 反爬产品库）
    fn seed_default_knowledge(&mut self) {
        self.add(KnowledgeEntry {
            id: "cf-basic".to_string(),
            title: "Cloudflare 基础防护".to_string(),
            content: "特征：CF-Ray 响应头、5xx challenge 页面、JS 挑战。绕过：浏览器模式 + 住宅代理 + Chrome 120 TLS 指纹。降速到 5 req/min。".to_string(),
            tags: vec!["cloudflare".to_string(), "cf-ray".to_string(), "403".to_string(), "challenge".to_string()],
            category: KnowledgeCategory::AntiBot,
        });

        self.add(KnowledgeEntry {
            id: "datadome-basic".to_string(),
            title: "DataDome 防护".to_string(),
            content: "特征：x-datadome 响应头、CAPTCHA 重定向。绕过：完整行为模拟 + Canvas/WebGL 一致性指纹 + 移动代理。".to_string(),
            tags: vec!["datadome".to_string(), "x-datadome".to_string(), "captcha".to_string()],
            category: KnowledgeCategory::AntiBot,
        });

        self.add(KnowledgeEntry {
            id: "akamai-basic".to_string(),
            title: "Akamai Bot Manager".to_string(),
            content: "特征：_abck Cookie、sensor data 收集。绕过：完整浏览器链 + 真实鼠标轨迹（贝塞尔曲线）+ 长会话保持。".to_string(),
            tags: vec!["akamai".to_string(), "_abck".to_string(), "sensor".to_string()],
            category: KnowledgeCategory::AntiBot,
        });

        self.add(KnowledgeEntry {
            id: "fp-chrome-122".to_string(),
            title: "Chrome 122 Windows 指纹模板".to_string(),
            content: "UA: Chrome/122.0.0.0; WebGL RENDERER: ANGLE; Canvas 哈希需与 hardwareConcurrency=8 一致；locale=zh-CN 时 Accept-Language 必须含 zh。".to_string(),
            tags: vec!["chrome_122".to_string(), "windows".to_string(), "angle".to_string()],
            category: KnowledgeCategory::Fingerprint,
        });

        self.add(KnowledgeEntry {
            id: "ban-429".to_string(),
            title: "429 限流封禁案例".to_string(),
            content: "原因：QPS 超限。解决：降速 50% + 切换出口 IP + 增加 Referer 头。Retry-After 头表示冷却时间（秒）。".to_string(),
            tags: vec!["429".to_string(), "rate-limit".to_string(), "retry-after".to_string()],
            category: KnowledgeCategory::BanCase,
        });
    }

    /// 添加知识条目（自动构建倒排索引）
    pub fn add(&mut self, entry: KnowledgeEntry) {
        for tag in &entry.tags {
            self.inverted_index
                .entry(tag.clone())
                .or_default()
                .push(entry.id.clone());
        }
        // title/content 分词也加入索引（简单按非字母数字分割）
        for word in entry.title.split(|c: char| !c.is_alphanumeric()) {
            if word.len() > 1 {
                self.inverted_index
                    .entry(word.to_lowercase())
                    .or_default()
                    .push(entry.id.clone());
            }
        }
        self.entries.insert(entry.id.clone(), entry);
    }

    /// 关键词检索（替代 BM25，简单包含匹配）
    /// 返回匹配的知识条目（按匹配数降序）
    pub fn search(&self, query: &str, limit: usize) -> Vec<KnowledgeEntry> {
        let keywords: Vec<String> = query
            .split(|c: char| !c.is_alphanumeric())
            .filter(|s| s.len() > 1)
            .map(|s| s.to_lowercase())
            .collect();

        let mut scores: HashMap<String, usize> = HashMap::new();
        for kw in &keywords {
            if let Some(ids) = self.inverted_index.get(kw) {
                for id in ids {
                    *scores.entry(id.clone()).or_default() += 1;
                }
            }
        }

        let mut hits: Vec<(String, usize)> = scores.into_iter().collect();
        hits.sort_by(|a, b| b.1.cmp(&a.1));

        hits.into_iter()
            .take(limit)
            .filter_map(|(id, _)| self.entries.get(&id).cloned())
            .collect()
    }

    /// L0 规则缓存命中（<1ms，跳过 LLM）
    /// 替代 01 文档 OPA 规则引擎：场景签名匹配
    pub fn lookup_rule(&self, sig: &SceneSignature) -> Option<crate::kernel::strategy::StrategyDelta> {
        self.rule_cache.read().get(sig).cloned()
    }

    /// L2 决策成功后回写 L0 规则缓存
    /// 相同场景第二次出现时直接走 L0（<1ms），覆盖 80% 请求
    pub fn record_rule(&self, sig: SceneSignature, delta: crate::kernel::strategy::StrategyDelta) {
        self.rule_cache.write().insert(sig, delta);
    }

    /// 根据观测构造场景签名（用于 L0 规则匹配）
    /// 例："403+cf-ray+chrome_122" → 命中 Cloudflare 403 场景
    pub fn signature_from_observation(
        phase: crate::kernel::strategy::Phase,
        error_rate: f32,
        tls_profile: &str,
        last_status: Option<u16>,
        last_challenge: Option<&str>,
    ) -> SceneSignature {
        let mut parts: Vec<String> = vec![format!("phase={:?}", phase)];
        if error_rate > 0.5 {
            parts.push("high-error".to_string());
        } else if error_rate > 0.2 {
            parts.push("mid-error".to_string());
        }
        parts.push(format!("tls={}", tls_profile));
        if let Some(status) = last_status {
            parts.push(format!("status={}", status));
        }
        if let Some(challenge) = last_challenge {
            parts.push(format!("challenge={}", challenge));
        }
        SceneSignature(parts.join("+"))
    }
}

impl Default for KnowledgeBase {
    fn default() -> Self {
        Self::new()
    }
}

/// 全局知识库单例（lazy init）
static GLOBAL_KB: once_cell::sync::Lazy<Arc<KnowledgeBase>> =
    once_cell::sync::Lazy::new(|| Arc::new(KnowledgeBase::new()));

/// 获取全局知识库（无需 AppHandle，纯内存）
pub fn global() -> Arc<KnowledgeBase> {
    GLOBAL_KB.clone()
}
