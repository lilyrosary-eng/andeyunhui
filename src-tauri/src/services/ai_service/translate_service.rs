// 多节点翻译服务：免费节点 + 可选节点 + 按链兜底 + 全链路显式提示
//
// ## 为什么单独建模块（不塞进 ai_ocr.rs）
// 原来只有 `ai_ocr.rs::translate_text` 一条路：走 AI 的 /chat/completions，
// 没配 API Key 直接报错。翻译与 OCR 是两件事，继续往 OCR 文件里堆会让两边都难改。
//
// ## 设计依据（不是照抄参考项目）
// 参考项目 aboutgame 的强项是「调度内核 + 游戏文本批量处理」，但它只有 8 个协议，
// 百度/有道明确写着「需 token+sign 逆向，暂未做」。本项目要「一样强甚至更强」，
// 所以节点矩阵与签名算法是自己补的，调度/分段/占位符借鉴它的思路但按本应用
// （用户粘贴一段文字翻译）重新定尺度。
//
// ## ★ 端点可用性是 2026-11-04 在本机**真实请求**测出来的，不是看文档
// | 节点 | 实测 | 结论 |
// |---|---|---|
// | Bing 网页版 | GET cn.bing.com/translator 200（630KB）→ 解析 IG/IID/AbusePrevention → POST cn.bing.com/ttranslatev3 200 + 正确译文 | **免 key 可用**，且返回 detectedLanguage |
// | MyMemory | GET 200 + 正确译文；>500 字符时 **HTTP 200 但正文是 `QUERY LENGTH LIMIT EXCEEDED`** | 免 key 可用，但**必须检测正文里的错误文本**，否则会把报错当译文交出去 |
// | Google gtx / clients5 | 全部超时 | 保留节点但明确标注「本机不可达」，不静默装作可用 |
// | edge.microsoft.com/translate/auth | 404 | 旧的免 token 端点已死，不接 |
// | 有道/百度网页版免 key 老接口 | errno 1022 / errorCode 50 | 已失效，不接 |
// | 百度 fanyi-api / 有道 openapi | 端点可达，无 key 时返回明确错误码 | 接官方 API（需 appid/密钥 + 签名） |
// | LibreTranslate 公共实例 | 403 / DNS 失败 | 只支持**自建/自填端点** |
//
// ## Bing 的两个实现要点（都是探针改出来的）
// 1. `www.bing.com/translator` 会 302 到 `cn.bing.com`；POST 到 www 也会 302，
//    若让 HTTP 客户端自动跟随，POST 会被改成 GET 从而拿到 **HTTP 200 + 空 body**。
//    这里直接请求 `cn.bing.com`，两边都不需要重定向。
// 2. **不需要 cookie**：实测无 cookie、无 Referer/Origin 也 200 出译文。
//    所以无需开启 reqwest 的 cookies 特性，也不用手写 Cookie 头。
//
// ## 显式原则（用户 2026-10-17 定的长期规则）
// 所有报错 / 警告 / 兜底 / 降级 / 跳过，**既 `eprintln!` 落日志，也随结果返回给前端**。
// 统一走 `push_notice`，不允许各处自己拼字符串或静默 `catch`。
// 错误文本统一形状 `[节点/阶段] 原始错误`，阶段 ∈ config / token / request / parse / limit。

use futures_util::future::join_all;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;

use super::ai_profile::{load_config, resolve_target};

// ==================== 配置（前端 localStorage → 每次请求随 settings 传入）====================

/// 翻译设置。**刻意不新增 Tauri 命令、不落 Rust 配置文件**：
/// 本项目工作区常有用户未提交的改动，能不碰注册表/配置读写就不碰；
/// 而且这些值本来就由前端设置页管理，随请求下发是最短路径。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TranslateSettings {
    /// 本次要用的节点；"auto" / 空 = 按链兜底
    pub node: Option<String>,
    /// auto 模式的链顺序（缺省用 DEFAULT_CHAIN）
    pub chain: Vec<String>,
    /// 百度翻译（免费额度，需自己去开放平台申请）
    pub baidu_app_id: Option<String>,
    pub baidu_secret: Option<String>,
    /// 有道智云（同上）
    pub youdao_app_key: Option<String>,
    pub youdao_secret: Option<String>,
    /// DeepL auth_key
    pub deepl_key: Option<String>,
    /// LibreTranslate 自建端点 / 可选 key
    pub libre_url: Option<String>,
    pub libre_key: Option<String>,
    /// AI 节点用的模型档案（空 = 当前档案）
    pub profile_id: Option<String>,
    /// 术语表，每行 `原词=译法`。**只对 AI 节点生效**（免费节点无法注入提示词），
    /// 用了但当前节点不支持时会显式提示，不静默忽略。
    pub glossary: Option<String>,
    /// 是否启用进程内缓存（默认开）
    pub cache: Option<bool>,
    /// 测试模式：强制单节点、绕过缓存、返回 via/stage/detail 诊断信息
    pub probe: Option<bool>,
}

/// 一次翻译的结果。`notices` 是给用户看的，也是给日志看的（见 push_notice）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateOutcome {
    pub text: String,
    /// 实际出译文的节点（auto 模式下不等于用户选的 "auto"）
    pub node: String,
    /// 识别出的源语言（Bing 会返回；其它节点由启发式给）
    pub detected_lang: Option<String>,
    /// 所有显式提示：兜底、失败、跳过、降级、缓存命中、占位符未还原…
    pub notices: Vec<String>,
    pub from_cache: bool,
    /// 分段数（长文本会被切开并发翻译）
    pub segments: usize,
    /// 诊断：实际请求的端点
    pub via: Option<String>,
    /// 诊断：ok / config / token / request / parse / limit
    pub stage: Option<String>,
    /// 诊断：原始错误文本（**不做分类改写**，把 502 糊成「网络问题」还是让人猜）
    pub detail: Option<String>,
}

/// 所有提示的唯一出口：**既进结果，也进日志**。
fn push_notice(out: &mut Vec<String>, s: impl Into<String>) {
    let s = s.into();
    eprintln!("[translate] {s}");
    out.push(s);
}

fn log_error(s: &str) {
    eprintln!("[translate][error] {s}");
}

/// 自动模式的默认链。**免 key 的排前面**：用户没配任何 key 也能翻译，
/// 且不会在不知情时花 AI 的钱。顺序可在设置页改。
pub const DEFAULT_CHAIN: &[&str] = &["bing", "mymemory", "ai"];

/// 节点元信息：`(id, 显示名, 是否需要凭证, 备注)`。
/// `needs_key` 为 false 的节点在没任何配置时也能用 —— 这正是「免费翻译节点」。
pub const NODES: &[(&str, &str, bool, &str)] = &[
    ("auto", "自动（按链兜底）", false, "按顺序尝试，每次失败/降级都显式提示"),
    ("bing", "Bing 网页版 · 免费", false, "免 key；实测可用，返回源语言识别"),
    ("mymemory", "MyMemory · 免费", false, "免 key；有日额度，单段上限 500 字符"),
    ("ai", "AI 模型", true, "复用全局 AI 配置；本地 LM Studio 可不填 key"),
    ("baidu", "百度翻译", true, "官方 API，免费额度；需 appid + 密钥（md5 签名）"),
    ("youdao", "有道翻译", true, "官方 API，免费额度；需 appKey + 密钥（sha256 签名）"),
    ("deepl", "DeepL", true, "需 auth_key；国内可能不通"),
    ("libre", "LibreTranslate", false, "公共实例实测不可用，请填自建端点"),
    ("google", "Google gtx", false, "本机实测超时，保留供网络可达时使用"),
];

pub fn node_label(id: &str) -> String {
    NODES.iter()
        .find(|n| n.0 == id)
        .map(|n| n.1.to_string())
        .unwrap_or_else(|| id.to_string())
}

pub fn is_known_node(id: &str) -> bool {
    id == "auto" || NODES.iter().any(|n| n.0 == id)
}

// ==================== 语言代码（统一映射，避免各节点各写一套）====================

/// 内部语言枚举。前端传的是**中文描述**（「中文」「英语」…），
/// 免费/官方节点要的是互不相同的 ISO 码，所以这里做一张双向表。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Auto,
    Zh,
    ZhHant,
    En,
    Ja,
    Ko,
    Fr,
    De,
    Ru,
    Es,
    Pt,
    It,
    Ar,
    Th,
    Vi,
    Id,
    Hi,
}

/// 宽容解析：既认前端的中文描述，也认常见 ISO 写法（便于以后/插件直接传码）。
pub fn parse_lang(s: Option<&str>) -> Lang {
    let raw = s.unwrap_or("").trim();
    if raw.is_empty() || raw.eq_ignore_ascii_case("auto") || raw == "自动识别" {
        return Lang::Auto;
    }
    let l = raw.to_ascii_lowercase().replace('_', "-");
    if l.contains("hant") || l.contains("tw") || l.contains("hk") || raw.contains("繁") {
        return Lang::ZhHant;
    }
    if l.starts_with("zh") || raw.contains("中") || raw == "汉语" {
        return Lang::Zh;
    }
    let tag = |prefix: &str| l == prefix || l.starts_with(&format!("{prefix}-"));
    if tag("en") || raw.contains("英") { return Lang::En; }
    if tag("ja") || raw.contains("日") { return Lang::Ja; }
    if tag("ko") || raw.contains("韩") { return Lang::Ko; }
    if tag("fr") || raw.contains("法") { return Lang::Fr; }
    if tag("de") || raw.contains("德") { return Lang::De; }
    if tag("ru") || raw.contains("俄") { return Lang::Ru; }
    if tag("es") || raw.contains("西班牙") { return Lang::Es; }
    if tag("pt") || raw.contains("葡萄牙") { return Lang::Pt; }
    if tag("it") || raw.contains("意大利") { return Lang::It; }
    if tag("ar") || raw.contains("阿拉伯") { return Lang::Ar; }
    if tag("th") || raw.contains("泰") { return Lang::Th; }
    if tag("vi") || raw.contains("越南") { return Lang::Vi; }
    if tag("id") || raw.contains("印尼") { return Lang::Id; }
    if tag("hi") || raw.contains("印地") { return Lang::Hi; }
    Lang::Zh // 认不出的一律当中文（前端下拉只有中文描述，不会出现乱值）
}

pub fn lang_tag(l: Lang) -> &'static str {
    match l {
        Lang::Auto => "auto", Lang::Zh => "zh", Lang::ZhHant => "zh-Hant",
        Lang::En => "en", Lang::Ja => "ja", Lang::Ko => "ko", Lang::Fr => "fr",
        Lang::De => "de", Lang::Ru => "ru", Lang::Es => "es", Lang::Pt => "pt",
        Lang::It => "it", Lang::Ar => "ar", Lang::Th => "th", Lang::Vi => "vi",
        Lang::Id => "id", Lang::Hi => "hi",
    }
}

/// AI 节点用的自然语言名（直接进提示词）。
pub fn ai_lang_name(l: Lang) -> &'static str {
    match l {
        Lang::Auto | Lang::Zh => "中文", Lang::ZhHant => "繁体中文", Lang::En => "英语",
        Lang::Ja => "日语", Lang::Ko => "韩语", Lang::Fr => "法语", Lang::De => "德语",
        Lang::Ru => "俄语", Lang::Es => "西班牙语", Lang::Pt => "葡萄牙语",
        Lang::It => "意大利语", Lang::Ar => "阿拉伯语", Lang::Th => "泰语",
        Lang::Vi => "越南语", Lang::Id => "印尼语", Lang::Hi => "印地语",
    }
}

/// 各节点的目标语言码。集中在一处便于单测逐个钉住。
pub fn lang_code(l: Lang, node: &str) -> &'static str {
    match node {
        "bing" => match l {
            Lang::Zh | Lang::Auto => "zh-Hans", Lang::ZhHant => "zh-Hant", Lang::En => "en",
            Lang::Ja => "ja", Lang::Ko => "ko", Lang::Fr => "fr", Lang::De => "de",
            Lang::Ru => "ru", Lang::Es => "es", Lang::Pt => "pt", Lang::It => "it",
            Lang::Ar => "ar", Lang::Th => "th", Lang::Vi => "vi", Lang::Id => "id", Lang::Hi => "hi",
        },
        "mymemory" | "google" => match l {
            Lang::Zh | Lang::Auto => "zh-CN", Lang::ZhHant => "zh-TW", Lang::En => "en",
            Lang::Ja => "ja", Lang::Ko => "ko", Lang::Fr => "fr", Lang::De => "de",
            Lang::Ru => "ru", Lang::Es => "es", Lang::Pt => "pt", Lang::It => "it",
            Lang::Ar => "ar", Lang::Th => "th", Lang::Vi => "vi", Lang::Id => "id", Lang::Hi => "hi",
        },
        "baidu" => match l {
            Lang::Zh | Lang::Auto => "zh", Lang::ZhHant => "cht", Lang::En => "en",
            Lang::Ja => "jp", Lang::Ko => "kor", Lang::Fr => "fra", Lang::De => "de",
            Lang::Ru => "ru", Lang::Es => "spa", Lang::Pt => "pt", Lang::It => "it",
            Lang::Ar => "ara", Lang::Th => "th", Lang::Vi => "vie", Lang::Id => "id", Lang::Hi => "hi",
        },
        "youdao" => match l {
            Lang::Zh | Lang::Auto => "zh-CHS", Lang::ZhHant => "zh-CHT", Lang::En => "en",
            Lang::Ja => "ja", Lang::Ko => "ko", Lang::Fr => "fr", Lang::De => "de",
            Lang::Ru => "ru", Lang::Es => "es", Lang::Pt => "pt", Lang::It => "it",
            Lang::Ar => "ar", Lang::Th => "th", Lang::Vi => "vi", Lang::Id => "id", Lang::Hi => "hi",
        },
        "deepl" => match l {
            Lang::Zh | Lang::Auto => "ZH", Lang::ZhHant => "ZH-HANT", Lang::En => "EN",
            Lang::Ja => "JA", Lang::Ko => "KO", Lang::Fr => "FR", Lang::De => "DE",
            Lang::Ru => "RU", Lang::Es => "ES", Lang::Pt => "PT", Lang::It => "IT",
            Lang::Ar => "AR", Lang::Th => "TH", Lang::Vi => "VI", Lang::Id => "ID", Lang::Hi => "HI",
        },
        // libre / 兜底
        _ => match l {
            Lang::Zh | Lang::Auto => "zh", Lang::ZhHant => "zh", Lang::En => "en",
            Lang::Ja => "ja", Lang::Ko => "ko", Lang::Fr => "fr", Lang::De => "de",
            Lang::Ru => "ru", Lang::Es => "es", Lang::Pt => "pt", Lang::It => "it",
            Lang::Ar => "ar", Lang::Th => "th", Lang::Vi => "vi", Lang::Id => "id", Lang::Hi => "hi",
        },
    }
}

/// 轻量源语言检测（纯字符范围，无外部依赖）。
/// 用途：MyMemory / LibreTranslate 不接受 `auto`，得先给一个码；
/// 参考项目没有独立语言检测，这里补上。Bing 有服务端检测，优先用它返回的。
pub fn detect_lang(text: &str) -> Lang {
    let mut has_kana = false;
    let mut has_hangul = false;
    let mut has_cyr = false;
    let mut has_arabic = false;
    let mut has_thai = false;
    let mut has_cjk = false;
    for c in text.chars().take(400) {
        let u = c as u32;
        if (0x3040..=0x30FF).contains(&u) { has_kana = true; }
        else if (0xAC00..=0xD7AF).contains(&u) { has_hangul = true; }
        else if (0x0400..=0x04FF).contains(&u) { has_cyr = true; }
        else if (0x0600..=0x06FF).contains(&u) { has_arabic = true; }
        else if (0x0E00..=0x0E7F).contains(&u) { has_thai = true; }
        else if (0x4E00..=0x9FFF).contains(&u) { has_cjk = true; }
    }
    if has_kana { return Lang::Ja; }
    if has_hangul { return Lang::Ko; }
    if has_cyr { return Lang::Ru; }
    if has_arabic { return Lang::Ar; }
    if has_thai { return Lang::Th; }
    if has_cjk { return Lang::Zh; }
    Lang::En
}

// ==================== 长文本分段（换行保真）====================

/// 单个请求的最大字符数。**MyMemory 官方硬限 500**（实测超时返回 200 + 错误文本），
/// 所以取 450；Bing 实测 1200 字符也正常，但统一按 450 切可以让链里任何节点都能接。
pub const SEGMENT_MAX: usize = 450;

/// 按换行切成段；单行过长再按句子边界切。返回**不含换行符**的段，
/// 拼回时用 `\n` 连接 —— 换行是用户文本的一部分，不能被翻译吃掉。
pub fn split_segments(text: &str, max: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.split('\n') {
        if line.chars().count() <= max {
            out.push(line.to_string());
            continue;
        }
        let mut buf = String::new();
        let mut last_break = 0usize;
        for (i, c) in line.char_indices() {
            buf.push(c);
            if ".!?;。！？；，, ".contains(c) && buf.chars().count() >= max / 2 {
                last_break = i + c.len_utf8();
            }
            if buf.chars().count() >= max {
                let cut = if last_break > 0 && last_break < buf.len() { last_break } else { buf.len() };
                let tail = buf.split_off(cut);
                if !buf.is_empty() { out.push(std::mem::take(&mut buf)); }
                buf = tail;
                last_break = 0;
            }
        }
        if !buf.is_empty() { out.push(buf); }
    }
    if out.is_empty() { out.push(String::new()); }
    out
}

// ==================== 占位符保护（确定性前后处理）====================

static PROTECT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"https?://[^\s<>"'`]+|`[^`\n]+`|\{\{[^}]+\}\}|\{[A-Za-z_][A-Za-z0-9_]*\}|%[0-9]*\$?[a-zA-Z]|\\[A-Za-z]+\[[^\]]*\]"#)
        .expect("占位符正则必须合法")
});
static RESTORE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\[\[\s*[Tt]([0-9]+)\s*\]\]").expect("还原正则必须合法")
});

/// 把 URL / 变量 / 控制码换成 `[[T<n>]]`，返回替换后的文本与原始片段表。
pub fn protect(text: &str) -> (String, Vec<String>) {
    let mut slots: Vec<String> = Vec::new();
    let out = PROTECT_RE
        .replace_all(text, |caps: &regex::Captures| {
            let i = slots.len();
            slots.push(caps[0].to_string());
            format!("[[T{i}]]")
        })
        .to_string();
    (out, slots)
}

/// 还原占位符，并**报出没还原成功的槽位编号**（静默丢失是最坏的一种）。
pub fn restore(text: &str, slots: &[String]) -> (String, Vec<usize>) {
    let mut missing: Vec<bool> = vec![true; slots.len()];
    let out = RESTORE_RE
        .replace_all(text, |caps: &regex::Captures| {
            let i: usize = caps[1].parse().unwrap_or(usize::MAX);
            if i < slots.len() {
                missing[i] = false;
                slots[i].clone()
            } else {
                caps[0].to_string()
            }
        })
        .to_string();
    let miss = missing.iter().enumerate().filter(|(_, m)| **m).map(|(i, _)| i).collect();
    (out, miss)
}

// ==================== 缓存（进程内，避免重复花额度）====================

struct CacheEntry {
    outcome: TranslateOutcome,
    at: Instant,
}

static CACHE: Lazy<Mutex<HashMap<String, CacheEntry>>> = Lazy::new(|| Mutex::new(HashMap::new()));
const CACHE_MAX: usize = 300;
const CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);

fn cache_key(node: &str, src: Lang, tgt: Lang, text: &str) -> String {
    let raw = format!("{}|{}|{}|{}", node, lang_tag(src), lang_tag(tgt), text);
    format!("{:x}", Sha256::digest(raw.as_bytes()))
}

fn cache_get(k: &str) -> Option<TranslateOutcome> {
    let mut g = CACHE.lock().ok()?;
    if let Some(e) = g.get(k) {
        if e.at.elapsed() < CACHE_TTL {
            return Some(e.outcome.clone());
        }
    }
    g.remove(k);
    None
}

fn cache_put(k: String, outcome: TranslateOutcome) {
    let Ok(mut g) = CACHE.lock() else { return };
    // 满了就整表清空：可预测、无 LRU 复杂度，300 条足够覆盖一次会话里的反复重译
    if g.len() >= CACHE_MAX { g.clear(); }
    g.retain(|_, e| e.at.elapsed() < CACHE_TTL);
    g.insert(k, CacheEntry { outcome, at: Instant::now() });
}

// ==================== 节点返回 / 错误形状 ====================

#[derive(Debug, Clone)]
struct NodeResult {
    text: String,
    via: String,
    detected: Option<String>,
}

/// 统一错误形状：`[节点/阶段] 原始错误`。阶段让测试按钮能直接显示，
/// 原始错误**不做分类改写**（用户明确要求「别让用户猜」）。
fn nerr(node: &str, stage: &str, detail: impl Into<String>) -> String {
    let s = format!("[{node}/{stage}] {}", detail.into());
    log_error(&s);
    s
}

fn nonblank(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

// ==================== 各节点实现 ====================

struct BingSession {
    ig: String,
    iid: String,
    key: String,
    token: String,
    fetched: Instant,
}

impl Clone for BingSession {
    fn clone(&self) -> Self {
        Self {
            ig: self.ig.clone(), iid: self.iid.clone(), key: self.key.clone(),
            token: self.token.clone(), fetched: self.fetched,
        }
    }
}

static BING_SESSION: Lazy<Mutex<Option<BingSession>>> = Lazy::new(|| Mutex::new(None));
const BING_TTL: Duration = Duration::from_secs(50 * 60);
const BING_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
static BING_ABUSE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"params_AbusePreventionHelper\s*=\s*\[([^\]]+)\]").expect("Bing 参数正则必须合法")
});

fn between<'a>(s: &'a str, a: &str, b: &str) -> Option<&'a str> {
    let i = s.find(a)? + a.len();
    let j = s[i..].find(b)? + i;
    Some(&s[i..j])
}

/// 抓 `cn.bing.com/translator` 页面里的 IG / IID / AbusePrevention(key, token)。
/// 页面结构一旦变动，必须**显式报出缺哪个字段**，而不是默默返回空 token。
async fn fetch_bing_session(client: &reqwest::Client) -> Result<BingSession, String> {
    let resp = client
        .get("https://cn.bing.com/translator")
        .header("User-Agent", BING_UA)
        .header("Accept-Language", "zh-CN,zh;q=0.9")
        .send()
        .await
        .map_err(|e| nerr("bing", "token", format!("取翻译页失败: {e}")))?;
    let status = resp.status();
    let html = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(nerr("bing", "token", format!("翻译页 HTTP {status}，正文 {} 字节", html.len())));
    }
    let ig = between(&html, "IG:\"", "\"")
        .ok_or_else(|| nerr("bing", "token", "页面缺 IG（Bing 改版？）"))?
        .to_string();
    let iid = between(&html, "data-iid=\"translator.", "\"")
        .ok_or_else(|| nerr("bing", "token", "页面缺 data-iid（Bing 改版？）"))?
        .to_string();
    let caps = BING_ABUSE_RE.captures(&html).ok_or_else(|| {
        nerr("bing", "token", "页面缺 params_AbusePreventionHelper（Bing 改版？）")
    })?;
    let inner = &caps[1];
    let key = inner.split(',').next().unwrap_or("").trim().trim_matches('"').to_string();
    let token = between(inner, "\"", "\"")
        .ok_or_else(|| nerr("bing", "token", "AbusePrevention 里缺 token 字符串"))?
        .to_string();
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_digit()) || token.is_empty() {
        return Err(nerr("bing", "token", format!("AbusePrevention 参数格式异常: {inner}")));
    }
    Ok(BingSession { ig, iid, key, token, fetched: Instant::now() })
}

/// token 缓存 50 分钟（页面里给的是 3600000ms ≈ 1 小时）。
/// ⚠️ 不能把 MutexGuard 带过 await：先在同步块里 clone 出来再释放锁。
async fn ensure_bing(client: &reqwest::Client, force: bool) -> Result<BingSession, String> {
    if !force {
        let cached = { BING_SESSION.lock().ok().and_then(|g| g.as_ref().cloned()) };
        if let Some(s) = cached {
            if s.fetched.elapsed() < BING_TTL { return Ok(s); }
        }
    }
    let s = fetch_bing_session(client).await?;
    if let Ok(mut g) = BING_SESSION.lock() { *g = Some(s.clone()); }
    Ok(s)
}

async fn bing_post(
    client: &reqwest::Client,
    sess: &BingSession,
    src: Lang,
    tgt: Lang,
    text: &str,
) -> Result<NodeResult, String> {
    let from = if src == Lang::Auto { "auto-detect".to_string() } else { lang_code(src, "bing").to_string() };
    let to = lang_code(tgt, "bing");
    let url = format!(
        "https://cn.bing.com/ttranslatev3?isVertical=1&IG={}&IID=translator.{}.1",
        sess.ig, sess.iid
    );
    let form = [
        ("fromLang", from.as_str()),
        ("to", to),
        ("text", text),
        ("token", sess.token.as_str()),
        ("key", sess.key.as_str()),
    ];
    let resp = client
        .post(&url)
        .header("User-Agent", BING_UA)
        .header("Referer", "https://cn.bing.com/translator")
        .header("Origin", "https://cn.bing.com")
        .form(&form)
        .send()
        .await
        .map_err(|e| nerr("bing", "request", format!("请求失败: {e}")))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if status.as_u16() == 429 {
        return Err(nerr("bing", "limit", "HTTP 429：Bing 限流，请稍后或换节点"));
    }
    if !status.is_success() {
        return Err(nerr("bing", "request", format!("HTTP {status}: {}", body.chars().take(300).collect::<String>())));
    }
    if body.trim().is_empty() {
        return Err(nerr("bing", "request", "HTTP 200 但响应为空（常见于 POST 被 302 改成 GET；本实现直连 cn.bing.com 不该发生）"));
    }
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| nerr("bing", "parse", format!("响应不是 JSON: {e}｜正文 {body:?}")))?;
    let first = v.get(0).unwrap_or(&Value::Null);
    if let Some(code) = first.get("statusCode").and_then(|x| x.as_i64()) {
        if code != 200 {
            let msg = first.get("errorMessage").and_then(|x| x.as_str()).unwrap_or("");
            return Err(nerr("bing", "token", format!("statusCode={code} errorMessage={msg}")));
        }
    }
    let translated = first.pointer("/translations/0/text").and_then(|x| x.as_str())
        .ok_or_else(|| nerr("bing", "parse", format!("响应缺 translations[0].text：{body}")))?
        .to_string();
    let detected = first.pointer("/detectedLanguage/language").and_then(|x| x.as_str()).map(str::to_string);
    Ok(NodeResult { text: translated, via: "https://cn.bing.com/ttranslatev3".into(), detected })
}

async fn call_bing(
    client: &reqwest::Client,
    src: Lang,
    tgt: Lang,
    text: &str,
) -> Result<NodeResult, String> {
    let sess = ensure_bing(client, false).await?;
    match bing_post(client, &sess, src, tgt, text).await {
        Ok(r) => Ok(r),
        Err(e) if e.contains("/token]") => {
            // token 失效只强制刷新**一次**，并把这次刷新显式报出来
            eprintln!("[translate] bing token 可能失效，刷新后重试一次：{e}");
            let fresh = ensure_bing(client, true).await?;
            bing_post(client, &fresh, src, tgt, text).await
        }
        Err(e) => Err(e),
    }
}

/// MyMemory **失败也返回 HTTP 200**，错误写在 `translatedText` 里。
/// 不检测就会把 `QUERY LENGTH LIMIT EXCEEDED...` 当成译文交给用户。
/// 抽成纯函数是为了能单测这条防线（真实请求里很难稳定触发额度错误）。
fn looks_like_mymemory_error(s: &str) -> bool {
    let u = s.to_ascii_uppercase();
    u.contains("QUERY LENGTH LIMIT")
        || u.contains("MYMEMORY WARNING")
        || u.contains("QUOTA")
        || u.contains("INVALID")
}

/// ★ MyMemory 最大的坑：**失败也返回 HTTP 200**，正文里塞错误文本。
/// 不检测就会把 `QUERY LENGTH LIMIT EXCEEDED...` 当译文交给用户。
async fn call_mymemory(
    client: &reqwest::Client,
    src: Lang,
    tgt: Lang,
    text: &str,
) -> Result<NodeResult, String> {
    if text.chars().count() > 500 {
        return Err(nerr("mymemory", "limit", format!("单段 {} 字符 > 500 上限（应由分段器切开）", text.chars().count())));
    }
    let s = if src == Lang::Auto { detect_lang(text) } else { src };
    let langpair = format!("{}|{}", lang_code(s, "mymemory"), lang_code(tgt, "mymemory"));
    let resp = client
        .get("https://api.mymemory.translated.net/get")
        .query(&[("q", text), ("langpair", langpair.as_str())])
        .send()
        .await
        .map_err(|e| nerr("mymemory", "request", format!("请求失败: {e}")))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(nerr("mymemory", "request", format!("HTTP {status}: {}", body.chars().take(300).collect::<String>())));
    }
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| nerr("mymemory", "parse", format!("响应不是 JSON: {e}｜正文 {body:?}")))?;
    if v.get("quotaFinished").and_then(|x| x.as_bool()) == Some(true) {
        return Err(nerr("mymemory", "limit", format!("日额度用尽：{body}")));
    }
    let out = v.pointer("/responseData/translatedText").and_then(|x| x.as_str())
        .ok_or_else(|| nerr("mymemory", "parse", format!("响应缺 translatedText：{body}")))?
        .to_string();
    if looks_like_mymemory_error(&out) {
        return Err(nerr("mymemory", "limit", format!("服务端在 200 响应里返回了错误文本：{out}")));
    }
    Ok(NodeResult {
        text: out,
        via: "https://api.mymemory.translated.net/get".into(),
        detected: if src == Lang::Auto { Some(lang_tag(s).to_string()) } else { None },
    })
}

/// Google gtx：本机实测超时，保留节点但让失败信息如实呈现。
async fn call_google(
    client: &reqwest::Client,
    src: Lang,
    tgt: Lang,
    text: &str,
) -> Result<NodeResult, String> {
    let s = if src == Lang::Auto { detect_lang(text) } else { src };
    let resp = client
        .get("https://translate.googleapis.com/translate_a/single")
        .query(&[
            ("client", "gtx"), ("sl", lang_code(s, "google")),
            ("tl", lang_code(tgt, "google")), ("dt", "t"), ("q", text),
        ])
        .send()
        .await
        .map_err(|e| nerr("google", "request", format!("请求失败（本机实测常为超时）: {e}")))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(nerr("google", "request", format!("HTTP {status}: {}", body.chars().take(200).collect::<String>())));
    }
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| nerr("google", "parse", format!("响应不是 JSON: {e}｜正文 {body:?}")))?;
    let mut out = String::new();
    if let Some(parts) = v.get(0).and_then(|x| x.as_array()) {
        for p in parts {
            if let Some(s) = p.get(0).and_then(|x| x.as_str()) { out.push_str(s); }
        }
    }
    if out.is_empty() {
        return Err(nerr("google", "parse", format!("响应里没有译文：{body}")));
    }
    Ok(NodeResult { text: out, via: "https://translate.googleapis.com/translate_a/single".into(), detected: None })
}

/// 百度官方：sign = md5(appid + q + salt + 密钥)
pub fn baidu_sign(appid: &str, q: &str, salt: &str, secret: &str) -> String {
    format!("{:x}", md5::compute(format!("{appid}{q}{salt}{secret}").as_bytes()))
}

async fn call_baidu(
    client: &reqwest::Client,
    src: Lang,
    tgt: Lang,
    text: &str,
    st: &TranslateSettings,
) -> Result<NodeResult, String> {
    let appid = nonblank(&st.baidu_app_id)
        .ok_or_else(|| nerr("baidu", "config", "未填 appid（百度翻译开放平台，有免费额度）"))?;
    let secret = nonblank(&st.baidu_secret)
        .ok_or_else(|| nerr("baidu", "config", "未填密钥"))?;
    let salt = chrono::Utc::now().timestamp_millis().to_string();
    let sign = baidu_sign(appid, text, &salt, secret);
    let s = if src == Lang::Auto { "auto" } else { lang_code(src, "baidu") };
    let resp = client
        .post("https://fanyi-api.baidu.com/api/trans/vip/translate")
        .form(&[
            ("q", text), ("from", s), ("to", lang_code(tgt, "baidu")),
            ("appid", appid), ("salt", salt.as_str()), ("sign", sign.as_str()),
        ])
        .send()
        .await
        .map_err(|e| nerr("baidu", "request", format!("请求失败: {e}")))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| nerr("baidu", "parse", format!("HTTP {status} 响应不是 JSON: {e}｜正文 {body:?}")))?;
    if let Some(code) = v.get("error_code") {
        let msg = v.get("error_msg").and_then(|x| x.as_str()).unwrap_or("");
        return Err(nerr("baidu", "request", format!("error_code={code} error_msg={msg}（完整响应 {body}）")));
    }
    let mut out = String::new();
    if let Some(items) = v.pointer("/trans_result").and_then(|x| x.as_array()) {
        for (i, it) in items.iter().enumerate() {
            if i > 0 { out.push('\n'); }
            out.push_str(it.get("dst").and_then(|x| x.as_str()).unwrap_or(""));
        }
    }
    if out.is_empty() {
        return Err(nerr("baidu", "parse", format!("响应缺 trans_result[].dst：{body}")));
    }
    Ok(NodeResult { text: out, via: "https://fanyi-api.baidu.com/api/trans/vip/translate".into(), detected: None })
}

/// 有道官方：input 超 20 字符时取 前10 + 长度 + 后10；sign = sha256(appKey+input+salt+curtime+密钥)
pub fn youdao_input(q: &str) -> String {
    let chars: Vec<char> = q.chars().collect();
    if chars.len() <= 20 { return q.to_string(); }
    let head: String = chars[..10].iter().collect();
    let tail: String = chars[chars.len() - 10..].iter().collect();
    format!("{head}{}{tail}", chars.len())
}

pub fn youdao_sign(app_key: &str, input: &str, salt: &str, curtime: &str, secret: &str) -> String {
    format!("{:x}", Sha256::digest(format!("{app_key}{input}{salt}{curtime}{secret}").as_bytes()))
}

async fn call_youdao(
    client: &reqwest::Client,
    src: Lang,
    tgt: Lang,
    text: &str,
    st: &TranslateSettings,
) -> Result<NodeResult, String> {
    let app_key = nonblank(&st.youdao_app_key)
        .ok_or_else(|| nerr("youdao", "config", "未填 appKey（有道智云，有免费额度）"))?;
    let secret = nonblank(&st.youdao_secret)
        .ok_or_else(|| nerr("youdao", "config", "未填密钥"))?;
    let curtime = chrono::Utc::now().timestamp().to_string();
    let salt = format!("{}", chrono::Utc::now().timestamp_millis());
    let input = youdao_input(text);
    let sign = youdao_sign(app_key, &input, &salt, &curtime, secret);
    let s = if src == Lang::Auto { "auto" } else { lang_code(src, "youdao") };
    let resp = client
        .post("https://openapi.youdao.com/api")
        .form(&[
            ("q", text), ("from", s), ("to", lang_code(tgt, "youdao")),
            ("appKey", app_key), ("salt", salt.as_str()), ("sign", sign.as_str()),
            ("signType", "v3"), ("curtime", curtime.as_str()),
        ])
        .send()
        .await
        .map_err(|e| nerr("youdao", "request", format!("请求失败: {e}")))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| nerr("youdao", "parse", format!("HTTP {status} 响应不是 JSON: {e}｜正文 {body:?}")))?;
    let code = v.get("errorCode").and_then(|x| x.as_str()).unwrap_or("");
    if !code.is_empty() && code != "0" {
        return Err(nerr("youdao", "request", format!("errorCode={code}（完整响应 {body}）")));
    }
    let mut out = String::new();
    if let Some(items) = v.get("translation").and_then(|x| x.as_array()) {
        for (i, it) in items.iter().enumerate() {
            if i > 0 { out.push('\n'); }
            out.push_str(it.as_str().unwrap_or(""));
        }
    }
    if out.is_empty() {
        return Err(nerr("youdao", "parse", format!("响应缺 translation[]：{body}")));
    }
    Ok(NodeResult {
        text: out,
        via: "https://openapi.youdao.com/api".into(),
        detected: v.get("l").and_then(|x| x.as_str()).map(str::to_string),
    })
}

async fn call_deepl(
    client: &reqwest::Client,
    src: Lang,
    tgt: Lang,
    text: &str,
    st: &TranslateSettings,
) -> Result<NodeResult, String> {
    let key = nonblank(&st.deepl_key)
        .ok_or_else(|| nerr("deepl", "config", "未填 auth_key"))?;
    let url = if key.contains(":fx") {
        "https://api-free.deepl.com/v2/translate"
    } else {
        "https://api.deepl.com/v2/translate"
    };
    let mut form = vec![
        ("auth_key", key.to_string()),
        ("text", text.to_string()),
        ("target_lang", lang_code(tgt, "deepl").to_string()),
    ];
    if src != Lang::Auto { form.push(("source_lang", lang_code(src, "deepl").to_string())); }
    let resp = client.post(url).form(&form).send().await
        .map_err(|e| nerr("deepl", "request", format!("请求失败: {e}")))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(nerr("deepl", "request", format!("HTTP {status}: {}", body.chars().take(300).collect::<String>())));
    }
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| nerr("deepl", "parse", format!("响应不是 JSON: {e}｜正文 {body:?}")))?;
    let out = v.pointer("/translations/0/text").and_then(|x| x.as_str())
        .ok_or_else(|| nerr("deepl", "parse", format!("响应缺 translations[0].text：{body}")))?
        .to_string();
    let detected = v.pointer("/translations/0/detected_source_language").and_then(|x| x.as_str()).map(str::to_string);
    Ok(NodeResult { text: out, via: url.into(), detected })
}

async fn call_libre(
    client: &reqwest::Client,
    src: Lang,
    tgt: Lang,
    text: &str,
    st: &TranslateSettings,
) -> Result<NodeResult, String> {
    let base = nonblank(&st.libre_url)
        .ok_or_else(|| nerr("libre", "config", "未填 LibreTranslate 端点（公共实例实测 403/DNS 失败，请填自建地址）"))?;
    let url = format!("{}/translate", base.trim_end_matches('/'));
    let s = if src == Lang::Auto { detect_lang(text) } else { src };
    let mut body = json!({
        "q": text,
        "source": lang_code(s, "libre"),
        "target": lang_code(tgt, "libre"),
        "format": "text",
    });
    if let Some(k) = nonblank(&st.libre_key) { body["api_key"] = json!(k); }
    let resp = client.post(&url).json(&body).send().await
        .map_err(|e| nerr("libre", "request", format!("请求失败: {e}")))?;
    let status = resp.status();
    let raw = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(nerr("libre", "request", format!("HTTP {status}: {}", raw.chars().take(300).collect::<String>())));
    }
    let v: Value = serde_json::from_str(&raw)
        .map_err(|e| nerr("libre", "parse", format!("响应不是 JSON: {e}｜正文 {raw:?}")))?;
    let out = v.get("translatedText").and_then(|x| x.as_str())
        .or_else(|| v.get("error").and_then(|x| x.as_str()))
        .ok_or_else(|| nerr("libre", "parse", format!("响应缺 translatedText：{raw}")))?
        .to_string();
    if v.get("error").is_some() {
        return Err(nerr("libre", "request", format!("服务端返回 error：{raw}")));
    }
    Ok(NodeResult { text: out, via: url, detected: None })
}

/// AI 节点：复用全局 AI 配置（OpenAI 兼容 /chat/completions），
/// 但**提示词里注入术语表**（免费节点做不到，会显式提示）。
async fn call_ai(
    app: &AppHandle,
    client: &reqwest::Client,
    src: Lang,
    tgt: Lang,
    text: &str,
    st: &TranslateSettings,
) -> Result<NodeResult, String> {
    let config = load_config(app);
    let cfg = resolve_target(&config, st.profile_id.as_deref());
    if cfg.base_url.trim().is_empty() || cfg.model.trim().is_empty() {
        return Err(nerr("ai", "config", "全局设置 → 模型里没有可用的模型档案"));
    }
    // 本地 OpenAI 兼容服务（LM Studio / Ollama）允许空 key；其余必须有 key
    let key = cfg.api_key.trim();
    if key.is_empty() && !cfg.base_url.contains("127.0.0.1") && !cfg.base_url.contains("localhost") {
        return Err(nerr("ai", "config", "未配置 API Key（本地服务可留空）"));
    }
    let src_name = if src == Lang::Auto { None } else { Some(ai_lang_name(src)) };
    let mut system = match src_name {
        Some(s) => format!("你是专业翻译助手。将用户输入的{s}文本翻译为{}，仅输出译文，不加注释、不加引号、不保留原文。如果原文已是目标语言则原样返回。", ai_lang_name(tgt)),
        None => format!("你是专业翻译助手。将用户输入的文本翻译为{}，仅输出译文，不加注释、不加引号、不保留原文。如果原文已是目标语言则原样返回。", ai_lang_name(tgt)),
    };
    if let Some(g) = nonblank(&st.glossary) {
        system.push_str("\n\n# 术语表（这些词请严格按「=」后的译法保持一致）\n");
        system.push_str(g);
    }
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let body = json!({
        "model": cfg.model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": text }
        ],
        "temperature": 0.1,
        "max_tokens": cfg.max_tokens.unwrap_or(4096),
        "stream": false,
    });
    let mut req = client.post(&url).header("Content-Type", "application/json");
    if !key.is_empty() { req = req.header("Authorization", format!("Bearer {key}")); }
    let resp = req.json(&body).send().await
        .map_err(|e| nerr("ai", "request", format!("请求失败: {e}")))?;
    let status = resp.status();
    let raw = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(nerr("ai", "request", format!("HTTP {status}: {}", raw.chars().take(300).collect::<String>())));
    }
    let v: Value = serde_json::from_str(&raw)
        .map_err(|e| nerr("ai", "parse", format!("响应不是 JSON: {e}｜正文 {raw:?}")))?;
    let out = v.pointer("/choices/0/message/content").and_then(|x| x.as_str())
        .ok_or_else(|| nerr("ai", "parse", format!("响应缺 choices[0].message.content：{raw}")))?
        .trim()
        .to_string();
    Ok(NodeResult { text: out, via: url, detected: None })
}

/// 单个节点的统一入口。
/// `app` 只有 **AI 节点**需要（读全局模型配置）。做成 `Option` 是为了让
/// 「免费节点 + 链兜底」能在测试里**真发请求**验证，而不必构造 Tauri AppHandle。
async fn call_node(
    app: Option<&AppHandle>,
    client: &reqwest::Client,
    node: &str,
    src: Lang,
    tgt: Lang,
    text: &str,
    st: &TranslateSettings,
) -> Result<NodeResult, String> {
    match node {
        "bing" => call_bing(client, src, tgt, text).await,
        "mymemory" => call_mymemory(client, src, tgt, text).await,
        "google" => call_google(client, src, tgt, text).await,
        "baidu" => call_baidu(client, src, tgt, text, st).await,
        "youdao" => call_youdao(client, src, tgt, text, st).await,
        "deepl" => call_deepl(client, src, tgt, text, st).await,
        "libre" => call_libre(client, src, tgt, text, st).await,
        "ai" => {
            let app = app.ok_or_else(|| nerr("ai", "config", "AI 节点需要应用句柄"))?;
            call_ai(app, client, src, tgt, text, st).await
        }
        other => Err(nerr(other, "config", format!("未知翻译节点「{other}」"))),
    }
}

// ==================== 调度：按链兜底 + 全链路显式提示 ====================

/// 一**段**文本按链尝试。返回 `(结果, 用了哪个节点, 本段提示)`。
async fn run_chain_for_segment(
    app: Option<&AppHandle>,
    client: &reqwest::Client,
    chain: &[String],
    src: Lang,
    tgt: Lang,
    text: &str,
    st: &TranslateSettings,
    notices: &mut Vec<String>,
) -> Result<(NodeResult, String), String> {
    let mut last_err = String::new();
    for (i, node) in chain.iter().enumerate() {
        match call_node(app, client, node, src, tgt, text, st).await {
            Ok(r) => {
                if i > 0 {
                    push_notice(
                        notices,
                        format!("已兜底到「{}」（第 {}/{} 站）：前一站失败", node_label(node), i + 1, chain.len()),
                    );
                }
                return Ok((r, node.clone()));
            }
            Err(e) => {
                push_notice(notices, format!("「{}」失败：{}", node_label(node), e));
                last_err = e;
                if i + 1 < chain.len() {
                    push_notice(notices, format!("按链转下一站「{}」", node_label(&chain[i + 1])));
                }
            }
        }
    }
    Err(last_err)
}

/// 主入口：分段 → 占位符保护 → 按链翻译（段间有限并发）→ 还原 → 显式提示。
pub async fn translate(
    app: &AppHandle,
    text: &str,
    source_lang: Option<&str>,
    target_lang: Option<&str>,
    mut st: TranslateSettings,
) -> Result<TranslateOutcome, String> {
    if text.trim().is_empty() {
        let e = "[translate/config] 待翻译文本为空".to_string();
        log_error(&e);
        return Err(e);
    }

    let probe = st.probe.unwrap_or(false);
    if st.node.is_none() { st.node = Some("auto".to_string()); }
    let selected = st.node.clone().unwrap_or_else(|| "auto".into());
    if !is_known_node(&selected) {
        let e = format!("[translate/config] 未知翻译节点「{selected}」");
        log_error(&e);
        return Err(e);
    }

    let src = parse_lang(source_lang);
    let tgt = parse_lang(target_lang);
    let cache_on = st.cache.unwrap_or(true) && !probe;
    let key = cache_key(&selected, src, tgt, text);
    if cache_on {
        if let Some(mut hit) = cache_get(&key) {
            push_notice(&mut hit.notices, "命中翻译缓存（未发起网络请求；可在设置里关闭缓存）".to_string());
            hit.from_cache = true;
            return Ok(hit);
        }
    }

    // 测试模式：强制单节点、单段、绕过缓存，让诊断信息干净可归因
    let mut chain: Vec<String> = if selected == "auto" {
        let c = if st.chain.is_empty() {
            DEFAULT_CHAIN.iter().map(|s| s.to_string()).collect::<Vec<_>>()
        } else {
            st.chain.iter().filter(|s| is_known_node(s) && s.as_str() != "auto").cloned().collect()
        };
        if c.is_empty() {
            let e = "[translate/config] 自动链为空，且没有可用的兜底节点".to_string();
            log_error(&e);
            return Err(e);
        }
        c
    } else {
        vec![selected.clone()]
    };
    if probe { chain.truncate(1); }

    let segments = if probe { vec![text.to_string()] } else { split_segments(text, SEGMENT_MAX) };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .user_agent(BING_UA)
        .build()
        .map_err(|e| {
            let s = format!("[translate/config] 创建 HTTP 客户端失败: {e}");
            log_error(&s);
            s
        })?;

    let mut notices: Vec<String> = Vec::new();
    if segments.len() > 1 {
        push_notice(&mut notices, format!("长文本已切成 {} 段并发翻译（每段 ≤ {} 字符，换行保真）", segments.len(), SEGMENT_MAX));
    }
    if nonblank(&st.glossary).is_some() && chain.iter().any(|n| n != "ai") {
        push_notice(
            &mut notices,
            "已配置术语表，但它只对 AI 节点生效；本次若走免费节点，术语表不会被使用（免费节点无法注入提示词）".to_string(),
        );
    }

    let sem = Arc::new(tokio::sync::Semaphore::new(3));
    let shared_st = Arc::new(st.clone());
    let results = join_all(segments.iter().enumerate().map(|(idx, seg)| {
        let app = app.clone();
        let client = client.clone();
        let chain = chain.clone();
        let st = shared_st.clone();
        let sem = sem.clone();
        let (protected, slots) = protect(seg);
        async move {
            let _permit = sem.acquire().await;
            // 段内提示**不能丢**：先收进局部 Vec，回主流程统一合并。
            // 并发写同一个 Vec 不安全，所以每段一份。
            let mut seg_notices = Vec::new();
            let res = run_chain_for_segment(
                Some(&app), &client, &chain, src, tgt,
                if protected.trim().is_empty() { seg.as_str() } else { protected.as_str() },
                &st,
                &mut seg_notices,
            ).await;
            (idx, res, slots, seg_notices)
        }
    })).await;

    let mut pieces: Vec<Option<String>> = vec![None; segments.len()];
    let mut used_node = String::new();
    let mut via: Option<String> = None;
    let mut detected: Option<String> = None;
    let mut stage = Some("ok".to_string());
    let mut detail: Option<String> = None;
    let mut errors: Vec<String> = Vec::new();

    for (idx, res, slots, seg_notices) in results {
        // 段内每一次尝试 / 失败 / 兜底都要留痕（用户原则：不允许静默）
        for n in seg_notices { push_notice(&mut notices, n); }
        match res {
            Ok((r, node_used)) => {
                let (restored, missing) = restore(&r.text, &slots);
                if !missing.is_empty() {
                    push_notice(
                        &mut notices,
                        format!("⚠️ 第 {} 段有 {} 个占位符未还原（节点可能改写了 [[T<n>]]）：建议改用 AI 节点或缩短文本", idx + 1, missing.len()),
                    );
                }
                if used_node.is_empty() { used_node = node_used; }
                if via.is_none() { via = Some(r.via.clone()); }
                if detected.is_none() { detected = r.detected.clone(); }
                pieces[idx] = Some(restored);
            }
            Err(e) => {
                errors.push(format!("第 {} 段：{}", idx + 1, e));
                stage = Some(e.split('/').nth(1).and_then(|s| s.split(']').next()).unwrap_or("request").to_string());
                detail = Some(e.clone());
            }
        }
    }

    if !errors.is_empty() {
        // 段内每一次尝试的提示已在上面合并进 notices；这里再把每段的最终错误列全，
        // 失败路径不做静默吞掉。
        for e in &errors { push_notice(&mut notices, format!("失败：{e}")); }
        let full = errors.join("\n");
        let err = format!("[translate/{}] {}", stage.clone().unwrap_or_else(|| "request".into()), full);
        log_error(&err);
        return Err(format!("{}\n\n{}", err, notices.iter().map(|n| format!("⚠️ {n}")).collect::<Vec<_>>().join("\n")));
    }

    let text_out = pieces.into_iter().map(|p| p.unwrap_or_default()).collect::<Vec<_>>().join("\n");
    if text_out.trim().is_empty() {
        let e = "[translate/parse] 所有节点都返回了空译文".to_string();
        log_error(&e);
        return Err(e);
    }
    // 实际使用的节点：从成功段里挑（auto 链下不同段落可能落到不同站，取第一个成功段）
    if used_node.is_empty() { used_node = chain[0].clone(); }
    if chain.len() > 1 && !notices.iter().any(|n| n.contains("已兜底到")) {
        // 首站就成功也要说清楚"链确实生效、没花到后面的站"，别让人猜有没有走兜底
        push_notice(
            &mut notices,
            format!("自动链共 {} 站，首站「{}」即成功，未发生兜底", chain.len(), node_label(&used_node)),
        );
    }
    if detail.is_none() {
        // 测试按钮要看到"通了"的证据，而不只是看到译文
        detail = Some(format!("HTTP 200｜{}", via.clone().unwrap_or_else(|| "未知端点".into())));
    }

    let outcome = TranslateOutcome {
        text: text_out,
        node: used_node,
        detected_lang: detected,
        notices,
        from_cache: false,
        segments: segments.len(),
        via,
        stage,
        detail,
    };
    if cache_on { cache_put(key, outcome.clone()); }
    Ok(outcome)
}

// ==================== 单元测试 ====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 语言映射_各节点互不混淆() {
        // 前端传中文描述，免费/官方节点要的是各自不同的码
        assert_eq!(parse_lang(Some("中文")), Lang::Zh);
        assert_eq!(parse_lang(Some("英语")), Lang::En);
        assert_eq!(parse_lang(Some("日语")), Lang::Ja);
        assert_eq!(parse_lang(Some("auto")), Lang::Auto);
        assert_eq!(parse_lang(None), Lang::Auto);
        assert_eq!(parse_lang(Some("zh-TW")), Lang::ZhHant);
        assert_eq!(parse_lang(Some("en-US")), Lang::En);

        assert_eq!(lang_code(Lang::Zh, "bing"), "zh-Hans");
        assert_eq!(lang_code(Lang::Zh, "mymemory"), "zh-CN");
        assert_eq!(lang_code(Lang::Zh, "baidu"), "zh");
        assert_eq!(lang_code(Lang::Zh, "youdao"), "zh-CHS");
        assert_eq!(lang_code(Lang::Zh, "deepl"), "ZH");
        assert_eq!(lang_code(Lang::Ja, "baidu"), "jp");     // 百度是 jp 不是 ja
        assert_eq!(lang_code(Lang::Ko, "baidu"), "kor");    // 百度是 kor 不是 ko
        assert_eq!(lang_code(Lang::Fr, "baidu"), "fra");    // 百度是 fra 不是 fr
        assert_eq!(lang_code(Lang::ZhHant, "bing"), "zh-Hant");
        assert_eq!(lang_code(Lang::ZhHant, "mymemory"), "zh-TW");
    }

    #[test]
    fn 源语言检测_按字符范围() {
        assert_eq!(detect_lang("こんにちは、世界。"), Lang::Ja);
        assert_eq!(detect_lang("안녕하세요 세계"), Lang::Ko);
        assert_eq!(detect_lang("Привет мир"), Lang::Ru);
        assert_eq!(detect_lang("你好，世界"), Lang::Zh);
        assert_eq!(detect_lang("Hello, world!"), Lang::En);
        assert_eq!(detect_lang("مرحبا بالعالم"), Lang::Ar);
    }

    #[test]
    fn 分段_换行保真且不超过上限() {
        let s = "第一行\n\n第二行\n第三行";
        let segs = split_segments(s, 450);
        assert_eq!(segs.join("\n"), s, "拼回必须逐字等于原文");

        let long = "This is a sentence about translation. ".repeat(40);
        let segs = split_segments(&long, 450);
        assert!(segs.len() > 1, "长文本必须切开");
        assert!(segs.iter().all(|x| x.chars().count() <= 460), "每段不能远超上限");
        assert_eq!(segs.join(""), long, "硬切时拼回不能丢字符");
    }

    #[test]
    fn 占位符保护与还原() {
        let s = "打开 https://example.com/a?x=1 然后设置 {count} 与 %s，见 `code here`。";
        let (p, slots) = protect(s);
        assert!(!slots.is_empty());
        assert!(p.contains("[[T0]]"));
        assert!(!p.contains("https://"), "URL 必须从待译文本里移除");
        let (back, missing) = restore(&p, &slots);
        assert_eq!(back, s);
        assert!(missing.is_empty());

        // 节点把占位符改坏 → 必须显式报 missing
        let (bad, missing) = restore("译文里什么都没有", &slots);
        assert_eq!(bad, "译文里什么都没有");
        assert_eq!(missing.len(), slots.len());
        // 大小写 / 空格变体也要能还原
        let (v, _) = restore("前 [[ t0 ]] 后", &slots[..1]);
        assert!(v.starts_with("前 ") && v.ends_with(" 后"));
    }

    /// ★ 百度官方文档的示例向量：appid=2015063000000001, q=apple,
    /// salt=1435660288, 密钥=12345678 → sign=f89f9594663708c1605f3d736d01d2d4。
    /// 用官方真值钉住算法，比"自洽"强得多：拼串顺序少一个字段就会立刻红。
    #[test]
    fn 百度签名_对得上官方示例向量() {
        assert_eq!(
            baidu_sign("2015063000000001", "apple", "1435660288", "12345678"),
            "f89f9594663708c1605f3d736d01d2d4"
        );
    }

    #[test]
    fn 有道签名_对得上独立算出的sha256() {
        // 对照值由 Python hashlib 独立算出，避免"自己验自己"
        assert_eq!(
            youdao_sign("appKey", "hello", "1", "2", "secret"),
            "867ae73923ff1b6c7dab32abcd08045b7b12af510159ed5bc00a3dac5dbd0fbb"
        );
    }

    #[test]
    fn 签名算法_形状与稳定性() {
        let a = baidu_sign("appid", "hello", "123", "secret");
        assert_eq!(a.len(), 32, "md5 必须是 32 位小写十六进制");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_eq!(a, baidu_sign("appid", "hello", "123", "secret"), "同输入必须同签名");
        assert_ne!(a, baidu_sign("appid", "hello", "124", "secret"), "salt 必须参与");

        let y = youdao_sign("appKey", "hello", "1", "2", "secret");
        assert_eq!(y.len(), 64, "sha256 必须是 64 位小写十六进制");
        assert_eq!(y, youdao_sign("appKey", "hello", "1", "2", "secret"));
        assert_ne!(y, youdao_sign("appKey", "hello", "1", "3", "secret"), "curtime 必须参与");

        assert_eq!(youdao_input("hello"), "hello");
        let q = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        assert_eq!(youdao_input(q), "012345678936QRSTUVWXYZ");
    }

    #[test]
    fn 节点表与默认链() {
        assert!(is_known_node("bing"));
        assert!(is_known_node("baidu"));
        assert!(is_known_node("youdao"));
        assert!(!is_known_node("不存在的节点"));
        assert_eq!(DEFAULT_CHAIN, &["bing", "mymemory", "ai"]);
        let free: Vec<&str> = NODES.iter().filter(|n| !n.2).map(|n| n.0).collect();
        assert!(free.contains(&"bing") && free.contains(&"mymemory"), "必须至少有两个真免 key 节点");
    }

    #[test]
    fn mymemory_的200错误文本必须被识别() {
        assert!(looks_like_mymemory_error("QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS"));
        assert!(looks_like_mymemory_error("MYMEMORY WARNING: USAGE EXCEEDED"));
        assert!(looks_like_mymemory_error("QUOTA EXCEEDED"));
        assert!(!looks_like_mymemory_error("你好，世界！"));
        assert!(!looks_like_mymemory_error("This is a normal translation."));
    }

    /// ★ 真实端点回归：用**产品同一份 Rust 代码**发请求，不是 Python 探针。
    ///
    /// 默认是 `#[ignore]`（CI 不该依赖外网）；本机验证用：
    /// `cargo test --lib ai_service::translate_service -- --ignored --nocapture`
    /// 若 cargo 挑中的 test exe 起不来（本机偶发 0xc0000139），手动跑
    /// `target/debug/deps/andeyunhui_lib-*.exe` 里其它那个。
    #[tokio::test]
    #[ignore = "真实网络请求，手动跑"]
    async fn 实测_免费节点与链兜底() {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(25))
            .user_agent(BING_UA)
            .build()
            .unwrap();
        let st = TranslateSettings::default();

        // ① Bing 免 key：必须出中文译文，且带回源语言识别
        let b = call_node(None, &client, "bing", Lang::En, Lang::Zh, "Hello, world!", &st).await;
        assert!(b.is_ok(), "Bing 免 key 失败：{b:?}");
        let b = b.unwrap();
        eprintln!("[实测] bing => {:?} via={} detected={:?}", b.text, b.via, b.detected);
        assert!(b.text.contains("你好") || b.text.contains("世界"), "译文应是中文：{}", b.text);
        assert_eq!(b.detected.as_deref(), Some("en"), "Bing 应返回 detectedLanguage");

        // ② MyMemory 免 key
        let m = call_node(None, &client, "mymemory", Lang::En, Lang::Zh, "Hello, world!", &st).await;
        assert!(m.is_ok(), "MyMemory 免 key 失败：{m:?}");
        let m = m.unwrap();
        eprintln!("[实测] mymemory => {:?}", m.text);
        assert!(!m.text.trim().is_empty());
        assert!(!looks_like_mymemory_error(&m.text));

        // ③ 超长文本必须被 length 防线挡下，不能把服务端错误文本当译文
        let long = "This is a sentence about translation. ".repeat(25);
        let bad = call_node(None, &client, "mymemory", Lang::En, Lang::Zh, &long, &st).await;
        assert!(bad.is_err(), "超长文本不该被当译文返回");
        assert!(bad.unwrap_err().contains("/limit]"), "应归到 limit 阶段");

        // ④ 链兜底：百度没配 key → config 阶段显式失败 → 转第二站 Bing。
        //    同时验证「每次失败/兜底都留显式提示」这条原则在真实链上成立。
        let mut notes = Vec::new();
        let chain = vec!["baidu".to_string(), "bing".to_string()];
        let r = run_chain_for_segment(
            None, &client, &chain, Lang::En, Lang::Zh, "Hello again!", &st, &mut notes,
        )
        .await;
        assert!(r.is_ok(), "第二站应成功：{r:?}");
        let (r, used) = r.unwrap();
        assert_eq!(used, "bing");
        eprintln!("[实测] chain notices = {notes:?}");
        assert!(notes.iter().any(|n| n.contains("百度") && n.contains("失败")), "首站失败要留痕：{notes:?}");
        assert!(notes.iter().any(|n| n.contains("已兜底到")), "兜底到哪一站必须说出来：{notes:?}");
        assert!(!r.text.trim().is_empty());
    }
}
