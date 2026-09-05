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
///
/// 字段用 RwLock 内部可变，保证全局单例（Arc<KnowledgeBase>）可在运行时
/// 增删查改条目（gongfang_ai_knowledge_add / remove 命令）。
pub struct KnowledgeBase {
    /// 全量知识条目（id → entry）
    entries: RwLock<HashMap<String, KnowledgeEntry>>,
    /// 关键词倒排索引（keyword → entry_ids）
    inverted_index: RwLock<HashMap<String, Vec<String>>>,
    /// L0 规则缓存（场景签名 → 策略补丁）
    rule_cache: RwLock<RuleCache>,
}

impl KnowledgeBase {
    pub fn new() -> Self {
        let kb = Self {
            entries: RwLock::new(HashMap::new()),
            inverted_index: RwLock::new(HashMap::new()),
            rule_cache: RwLock::new(HashMap::new()),
        };
        kb.seed_default_knowledge();
        kb
    }

    /// 校验分类是否合法
    pub fn category_valid(c: KnowledgeCategory) -> bool {
        matches!(
            c,
            KnowledgeCategory::AntiBot | KnowledgeCategory::Fingerprint | KnowledgeCategory::BanCase
        )
    }

    /// 预置反爬产品知识（对应 03 文档 5.1 反爬产品库）
    fn seed_default_knowledge(&self) {
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

        // ===== 反爬产品库扩充 =====
        self.add(KnowledgeEntry {
            id: "cf-turnstile".to_string(),
            title: "Cloudflare Turnstile 人机验证".to_string(),
            content: "特征：cf-turnstile 篇章、令牌需在 300s 内提交、无感验证者可二次校验。绕过：真实浏览器渲染 + 系数滑动路径；失败重试需换 IP。".to_string(),
            tags: vec!["cloudflare".to_string(), "turnstile".to_string(), "captcha".to_string()],
            category: KnowledgeCategory::AntiBot,
        });
        self.add(KnowledgeEntry {
            id: "cf-waf".to_string(),
            title: "Cloudflare WAF 规则拦截".to_string(),
            content: "特征：403 + cf-mitigated: challenge / manage 段头、1-3s 等待。绕过：URL 编码拆分 / multipart 分段 / 缩短页面请求间隔；命中规则时换 UA 族。".to_string(),
            tags: vec!["cloudflare".to_string(), "waf".to_string(), "403".to_string(), "cf-mitigated".to_string()],
            category: KnowledgeCategory::AntiBot,
        });
        self.add(KnowledgeEntry {
            id: "kasada".to_string(),
            title: "Kasada 动态挑战".to_string(),
            content: "特征：kasada 动态 JS + polyBot、无静态 challenge 页面。绕过：需加载并执行其 polyBot 段，超时 2s 内完成；难以纯静态绕过，必须真浏览器。".to_string(),
            tags: vec!["kasada".to_string(), "polybot".to_string(), "challenge".to_string()],
            category: KnowledgeCategory::AntiBot,
        });
        self.add(KnowledgeEntry {
            id: "akamai-sensor".to_string(),
            title: "Akamai sensor_data 上报".to_string(),
            content: "特征：_abck Cookie 每请求滚动、sensor_data 段带环境样本。绕过：采集真实 WebGL/Canvas/AudioContext 快照 + 鼠标轨迹；指纹一致性比速度更重要。".to_string(),
            tags: vec!["akamai".to_string(), "sensor_data".to_string(), "_abck".to_string()],
            category: KnowledgeCategory::AntiBot,
        });
        self.add(KnowledgeEntry {
            id: "perimeterx".to_string(),
            title: "PerimeterX/人身验证".to_string(),
            content: "特征：px-captcha Cookie、_px3 段。绕过：真实点击序列 + 一致性指纹 + 请求节流；接口被二次校验时同会话内保留 Cookie。".to_string(),
            tags: vec!["perimeterx".to_string(), "px-captcha".to_string(), "_px3".to_string()],
            category: KnowledgeCategory::AntiBot,
        });

        // ===== 指纹模板库扩充 =====
        self.add(KnowledgeEntry {
            id: "fp-chrome-134".to_string(),
            title: "Chrome 134 Windows 指纹模板".to_string(),
            content: "UA: Chrome/134.0.0.0; AudioContext 采样率需与 WebGL 一致; deviceMemory=8 + hardwareConcurrency=8; 无 navigator.webdriver。".to_string(),
            tags: vec!["chrome_134".to_string(), "windows".to_string(), "angle".to_string()],
            category: KnowledgeCategory::Fingerprint,
        });
        self.add(KnowledgeEntry {
            id: "fp-firefox-120".to_string(),
            title: "Firefox 120 指纹模板".to_string(),
            content: "UA 含 Gecko/2020; Canvas 默认噪声算法不同；localStorage 与 IndexedDB 存在差异；需安装 uBlock 类插件时 report 头一致。".to_string(),
            tags: vec!["firefox_120".to_string(), "gecko".to_string(), "canvas".to_string()],
            category: KnowledgeCategory::Fingerprint,
        });
        self.add(KnowledgeEntry {
            id: "fp-macos-safari".to_string(),
            title: "Safari 17 macOS 指纹模板".to_string(),
            content: "UA: Safari/605.1.15 段; WebGL vendor = Apple; 字体渲染存在 retinex 差异; 用 Apple 证书段需 TTS。".to_string(),
            tags: vec!["safari_17".to_string(), "macos".to_string(), "apple".to_string()],
            category: KnowledgeCategory::Fingerprint,
        });
        self.add(KnowledgeEntry {
            id: "fp-headless".to_string(),
            title: "无头浏览器指纹检测规避".to_string(),
            content: "检测点：navigator.webdriver / chrome 运行时段 / headless UA / 缺字体集。规避：patch webdriver、注入字体、开启 GPU。".to_string(),
            tags: vec!["headless".to_string(), "webdriver".to_string(), "canvas".to_string()],
            category: KnowledgeCategory::Fingerprint,
        });

        // ===== 封禁案例库扩充 =====
        self.add(KnowledgeEntry {
            id: "ban-403-cf".to_string(),
            title: "Cloudflare 403 封禁案例".to_string(),
            content: "原因：IP 信誉或行为指纹。解决：切换住宅代理 + 冷启动窗口（前 3 请求低 QPS）+ 完整指纹。".to_string(),
            tags: vec!["403".to_string(), "cloudflare".to_string(), "ip-reputation".to_string()],
            category: KnowledgeCategory::BanCase,
        });
        self.add(KnowledgeEntry {
            id: "ban-session".to_string(),
            title: "会话跟踪封禁案例".to_string(),
            content: "原因：请求间隔分布过均匀（被统计判定机器人）。解决：注入泊松时序抖动 + 随机暂停 + 长尾重试。".to_string(),
            tags: vec!["session".to_string(), "timing".to_string(), "behavior".to_string()],
            category: KnowledgeCategory::BanCase,
        });
        self.add(KnowledgeEntry {
            id: "ban-captcha-loop".to_string(),
            title: "验证码循环封禁案例".to_string(),
            content: "原因：多次验证失败触发硬封禁。解决：验证前先校准指纹，连续 2 次失败即换 IP，避免进入死循环。".to_string(),
            tags: vec!["captcha".to_string(), "loop".to_string(), "ban".to_string()],
            category: KnowledgeCategory::BanCase,
        });
        self.add(KnowledgeEntry {
            id: "ban-behavior".to_string(),
            title: "行为异常封禁案例".to_string(),
            content: "原因：鼠标轨迹直线/零停留/零滚动超出人类阈值。解决：贝塞尔弯曲轨迹 + 随机停留 + 滚动段。".to_string(),
            tags: vec!["behavior".to_string(), "mouse".to_string(), "anomaly".to_string()],
            category: KnowledgeCategory::BanCase,
        });
    }

    /// 添加知识条目（自动构建倒排索引；内部可变，可在运行时经 Arc 调用）
    pub fn add(&self, entry: KnowledgeEntry) {
        for tag in &entry.tags {
            self.inverted_index
                .write()
                .entry(tag.clone())
                .or_default()
                .push(entry.id.clone());
        }
        // title/content 分词也加入索引（简单按非字母数字分割）
        for word in entry.title.split(|c: char| !c.is_alphanumeric()) {
            if word.len() > 1 {
                self.inverted_index
                    .write()
                    .entry(word.to_lowercase())
                    .or_default()
                    .push(entry.id.clone());
            }
        }
        self.entries.write().insert(entry.id.clone(), entry);
    }

    /// 删除知识条目（同时重建倒排索引，保证索引一致）
    pub fn remove(&self, id: &str) -> bool {
        let mut entries = self.entries.write();
        if entries.remove(id).is_none() {
            return false;
        }
        drop(entries);
        // 重建倒排索引（条目少，重建成本可忽略）
        let mut idx = self.inverted_index.write();
        idx.clear();
        for e in self.entries.read().values() {
            for tag in &e.tags {
                idx.entry(tag.clone()).or_default().push(e.id.clone());
            }
            for word in e.title.split(|c: char| !c.is_alphanumeric()) {
                if word.len() > 1 {
                    idx.entry(word.to_lowercase())
                        .or_default()
                        .push(e.id.clone());
                }
            }
        }
        true
    }

    /// 按 id 获取单条（供管理）
    pub fn get(&self, id: &str) -> Option<KnowledgeEntry> {
        self.entries.read().get(id).cloned()
    }

    /// 关键词检索（替代 BM25，简单包含匹配）
    /// 返回匹配的知识条目（按匹配数降序）
    pub fn search(&self, query: &str, limit: usize) -> Vec<KnowledgeEntry> {
        let keywords: Vec<String> = query
            .split(|c: char| !c.is_alphanumeric())
            .filter(|s| s.len() > 1)
            .map(|s| s.to_lowercase())
            .collect();

        let idx = self.inverted_index.read();
        let mut scores: HashMap<String, usize> = HashMap::new();
        for kw in &keywords {
            if let Some(ids) = idx.get(kw) {
                for id in ids {
                    *scores.entry(id.clone()).or_default() += 1;
                }
            }
        }
        drop(idx);

        let entries = self.entries.read();
        let mut hits: Vec<(String, usize)> = scores.into_iter().collect();
        hits.sort_by(|a, b| b.1.cmp(&a.1));

        hits.into_iter()
            .take(limit)
            .filter_map(|(id, _)| entries.get(&id).cloned())
            .collect()
    }

    /// L0 规则缓存命中（<1ms，跳过 LLM）
    /// 替代 01 文档 OPA 规则引擎：场景签名匹配
    pub fn lookup_rule(&self, sig: &SceneSignature) -> Option<crate::kernel::strategy::StrategyDelta> {
        self.rule_cache.read().get(sig).cloned()
    }

    /// 列出全部知识条目（前端知识库展示）
    pub fn all_entries(&self) -> Vec<KnowledgeEntry> {
        self.entries.read().values().cloned().collect()
    }

    /// L0 规则缓存大小（已学习规则数）
    pub fn rule_cache_len(&self) -> usize {
        self.rule_cache.read().len()
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
