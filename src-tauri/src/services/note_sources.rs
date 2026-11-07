//! 笔记模块「网络」：把常用学术 / 技术站点的**官方开放接口**适配成统一结果。
//!
//! 设计口径（合规章节见对话记录）：
//! - 只调用站点公开文档化的 API，不解析网页、不抓正文、不绕登录/付费墙；
//! - 不内置任何「源清单 / 源市场 / 订阅」概念，源是编译期固定的四个适配器；
//! - 用户点击「收藏为笔记」时，落盘的只有标题 + 摘要 + 原文链接（引用，不是转载）。
//!
//! 四个源：
//! - `arxiv`      : export.arxiv.org Atom 接口（官方要求每次请求间隔 ≥3s）
//! - `huggingface`: huggingface.co/api/models（匿名 500 次 / 5 分钟）
//! - `github`     : api.github.com/search/repositories（匿名 60 次 / 小时，必须带 UA）
//! - `semantic`   : api.semanticscholar.org/graph/v1/paper/search（约 1 RPS，无 key 会 429）
//!
//! 所有失败都以「可读的中文原因」返回，前端直接展示，不做静默降级 —— 用户需要知道
//! 是网络问题、限流问题还是查询无结果。

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

/// 统一结果结构。字段名都是单数单词，serde 无需重命名即可被前端按同名读取。
#[derive(Debug, Clone, Serialize)]
pub struct NoteWebResult {
    /// 源内唯一 id（arXiv 编号 / HF repo / GitHub full_name / S2 paperId）
    pub id: String,
    pub title: String,
    /// 摘要（站点给的原文摘要；没有就给空串，前端据此隐藏区块）
    pub summary: String,
    /// 原文 / 详情页地址
    pub url: String,
    pub authors: String,
    /// 日期（arXiv published / GitHub updated_at / S2 year）
    pub date: String,
    /// 一句话附加信息（星标、下载量、引用数、venue 等）
    pub meta: String,
}

/// 单次搜索结果上限的硬上限：再多也没有阅读价值，且会放大站点配额消耗。
const MAX_LIMIT: usize = 50;
/// 摘要落盘 / 展示前的截断长度（避免把整篇 abstract 塞进笔记）。
const SUMMARY_CAP: usize = 1600;

const UA: &str = "AndeYunHui/2.4 (+https://github.com/) notes-network";

fn clamp_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(12).clamp(1, MAX_LIMIT)
}

fn trim_cap(s: &str) -> String {
    let t = s.trim();
    if t.chars().count() <= SUMMARY_CAP {
        return t.to_string();
    }
    let mut out: String = t.chars().take(SUMMARY_CAP).collect();
    out.push('…');
    out
}

/// 统一构造客户端：超时 20s，带 UA（GitHub 对无 UA 请求直接 403）。
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))
}

/// 出错时把响应体前若干字符带出来，便于用户判断是限流还是参数错。
async fn ensure_ok(resp: reqwest::Response, label: &str) -> Result<reqwest::Response, String> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let body = resp.text().await.unwrap_or_default();
    let snippet: String = body.chars().take(160).collect();
    let hint = match status.as_u16() {
        403 => "（可能是站点限流或需要授权）",
        429 => "（请求过于频繁，已被限流，请稍后再试）",
        404 => "（接口地址或参数不存在）",
        _ => "",
    };
    Err(format!("{label} 返回 HTTP {status}{hint}：{snippet}"))
}

/// arXiv 官方要求相邻请求间隔 ≥3 秒；这里用进程级时间戳做最小间隔。
static ARXIV_LAST_CALL: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

async fn arxiv_throttle() {
    const GAP: Duration = Duration::from_secs(3);
    let lock = ARXIV_LAST_CALL.get_or_init(|| Mutex::new(None));
    let wait = {
        let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        match *guard {
            Some(prev) => GAP.checked_sub(prev.elapsed()).unwrap_or_default(),
            None => Duration::ZERO,
        }
    };
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
    let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(Instant::now());
}

/// 入口：按源分发。`source` 为 "arxiv" / "huggingface" / "github" / "semantic"。
pub async fn search(source: &str, query: &str, limit: Option<usize>) -> Result<Vec<NoteWebResult>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("请输入搜索关键词".to_string());
    }
    let n = clamp_limit(limit);
    match source {
        "arxiv" => search_arxiv(q, n).await,
        "huggingface" => search_huggingface(q, n).await,
        "github" => search_github(q, n).await,
        "semantic" => search_semantic_scholar(q, n).await,
        other => Err(format!("未知的网络源：{other}")),
    }
}

// ========== arXiv ==========

async fn search_arxiv(query: &str, limit: usize) -> Result<Vec<NoteWebResult>, String> {
    arxiv_throttle().await;
    let resp = client()?
        .get("https://export.arxiv.org/api/query")
        // all: 覆盖标题/摘要/作者；按相关度排序更符合「搜索」语义
        .query(&[
            ("search_query", format!("all:{query}")),
            ("start", "0".to_string()),
            ("max_results", limit.to_string()),
            ("sortBy", "relevance".to_string()),
        ])
        .send()
        .await
        .map_err(|e| format!("请求 arXiv 失败（网络/代理可能拦截）：{e}"))?;
    let resp = ensure_ok(resp, "arXiv").await?;
    let xml = resp.text().await.map_err(|e| format!("读取 arXiv 响应失败：{e}"))?;
    Ok(parse_arxiv_atom(&xml, limit))
}

/// 解析 Atom：`<entry>` 下的 id/title/summary/published/author/name。
/// 事件流而非正则，避免摘要里出现换行与转义字符时切错。
fn parse_arxiv_atom(xml: &str, max: usize) -> Vec<NoteWebResult> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    // 不开 trim_text：quick-xml 0.39 会把 `A &amp; B` 拆成 Text("A ") / GeneralRef(amp) / Text(" B")，
    // 逐段 trim 会把空格吃掉（实测得到 "AB"）。改为保留原文，最后统一折叠空白。
    let mut buf = Vec::new();
    let mut out: Vec<NoteWebResult> = Vec::new();

    let mut in_entry = false;
    let mut in_author = false;
    let mut cur_tag: Option<String> = None;
    let mut id = String::new();
    let mut title = String::new();
    let mut summary = String::new();
    let mut published = String::new();
    let mut authors: Vec<String> = Vec::new();
    let mut current_author = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                match name.as_str() {
                    "entry" => {
                        in_entry = true;
                        id.clear();
                        title.clear();
                        summary.clear();
                        published.clear();
                        authors.clear();
                    }
                    "author" if in_entry => {
                        in_author = true;
                        current_author.clear();
                    }
                    _ if in_entry => cur_tag = Some(name),
                    _ => {}
                }
            }
            Ok(Event::Text(t)) if in_entry => {
                let txt = t.decode().unwrap_or_default().into_owned();
                match cur_tag.as_deref() {
                    Some("id") => id.push_str(txt.trim()),
                    Some("title") => title.push_str(&txt),
                    Some("summary") => summary.push_str(&txt),
                    Some("published") => published.push_str(txt.trim()),
                    // 名字可能被实体引用拆成多段 Text，统一累积到 current_author
                    Some("name") if in_author => current_author.push_str(&txt),
                    _ => {}
                }
            }
            // 实体引用：`&amp;` 等预定义实体或 `&#x...;` 数字引用（0.39 起单独成事件）
            Ok(Event::GeneralRef(r)) if in_entry => {
                let ch = match r.resolve_char_ref() {
                    Ok(Some(c)) => Some(c),
                    _ => match r.decode().unwrap_or_default().as_ref() {
                        "amp" => Some('&'),
                        "lt" => Some('<'),
                        "gt" => Some('>'),
                        "quot" => Some('"'),
                        "apos" => Some('\''),
                        _ => None,
                    },
                };
                if let Some(c) = ch {
                    match cur_tag.as_deref() {
                        Some("title") => title.push(c),
                        Some("summary") => summary.push(c),
                        Some("name") if in_author => current_author.push(c),
                        _ => {}
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name == "author" {
                    in_author = false;
                    let trimmed = current_author.trim();
                    if !trimmed.is_empty() {
                        authors.push(trimmed.to_string());
                    }
                    current_author.clear();
                } else if name == "entry" {
                    in_entry = false;
                    if !id.is_empty() {
                        // arXiv 的 id 形如 https://arxiv.org/abs/2401.xxxxx 或带 v2 版本号
                        let date = published.get(0..10).unwrap_or("").to_string();
                        let norm_summary = summary.split_whitespace().collect::<Vec<_>>().join(" ");
                        out.push(NoteWebResult {
                            id: id.rsplit('/').next().unwrap_or(&id).to_string(),
                            title: title.split_whitespace().collect::<Vec<_>>().join(" "),
                            summary: trim_cap(&norm_summary),
                            url: id.clone(),
                            authors: authors
                                .iter()
                                .map(|a| a.trim())
                                .filter(|a| !a.is_empty())
                                .collect::<Vec<_>>()
                                .join(", "),
                            date,
                            meta: "arXiv 论文".to_string(),
                        });
                    }
                    if out.len() >= max {
                        break;
                    }
                }
                cur_tag = None;
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

// ========== HuggingFace ==========

#[derive(serde::Deserialize)]
struct HfModel {
    #[serde(default)]
    id: String,
    #[serde(default)]
    likes: u64,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    pipeline_tag: Option<String>,
    #[serde(default)]
    last_modified: Option<String>,
}

async fn search_huggingface(query: &str, limit: usize) -> Result<Vec<NoteWebResult>, String> {
    let resp = client()?
        .get("https://huggingface.co/api/models")
        .query(&[
            ("search", query.to_string()),
            ("limit", limit.to_string()),
            ("sort", "downloads".to_string()),
            ("direction", "-1".to_string()),
        ])
        .send()
        .await
        .map_err(|e| format!("请求 HuggingFace 失败（网络/代理可能拦截）：{e}"))?;
    let resp = ensure_ok(resp, "HuggingFace").await?;
    let models: Vec<HfModel> = resp
        .json()
        .await
        .map_err(|e| format!("解析 HuggingFace 响应失败：{e}"))?;

    Ok(models
        .into_iter()
        .filter(|m| !m.id.is_empty())
        .map(|m| {
            let owner = m.id.split('/').next().unwrap_or("").to_string();
            let mut meta_parts: Vec<String> = Vec::new();
            if let Some(p) = m.pipeline_tag.as_deref().filter(|s| !s.is_empty()) {
                meta_parts.push(p.to_string());
            }
            meta_parts.push(format!("♥ {}", m.likes));
            meta_parts.push(format!("⬇ {}", m.downloads));
            NoteWebResult {
                url: format!("https://huggingface.co/{}", m.id),
                id: m.id.clone(),
                title: m.id,
                // 模型接口不返回简介（README 需要额外抓取，不做），摘要留空让前端隐藏
                summary: String::new(),
                authors: owner,
                date: m
                    .last_modified
                    .as_deref()
                    .and_then(|s| s.get(0..10))
                    .unwrap_or("")
                    .to_string(),
                meta: meta_parts.join(" · "),
            }
        })
        .collect())
}

// ========== GitHub ==========

#[derive(serde::Deserialize)]
struct GhSearch {
    #[serde(default)]
    items: Vec<GhRepo>,
}
#[derive(serde::Deserialize)]
struct GhRepo {
    #[serde(default)]
    full_name: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    stargazers_count: u64,
    #[serde(default)]
    owner: Option<GhOwner>,
    #[serde(default)]
    updated_at: Option<String>,
}
#[derive(serde::Deserialize)]
struct GhOwner {
    #[serde(default)]
    login: String,
}

async fn search_github(query: &str, limit: usize) -> Result<Vec<NoteWebResult>, String> {
    let resp = client()?
        .get("https://api.github.com/search/repositories")
        .query(&[
            ("q", query.to_string()),
            ("sort", "stars".to_string()),
            ("order", "desc".to_string()),
            ("per_page", limit.to_string()),
        ])
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("请求 GitHub 失败（网络/代理可能拦截）：{e}"))?;
    let resp = ensure_ok(resp, "GitHub").await?;
    let parsed: GhSearch = resp
        .json()
        .await
        .map_err(|e| format!("解析 GitHub 响应失败：{e}"))?;

    Ok(parsed
        .items
        .into_iter()
        .filter(|r| !r.full_name.is_empty())
        .map(|r| {
            let mut meta_parts = vec![format!("★ {}", r.stargazers_count)];
            if let Some(l) = r.language.as_deref().filter(|s| !s.is_empty()) {
                meta_parts.push(l.to_string());
            }
            NoteWebResult {
                id: r.full_name.clone(),
                title: r.full_name,
                summary: trim_cap(r.description.as_deref().unwrap_or("")),
                url: r.html_url,
                authors: r.owner.map(|o| o.login).unwrap_or_default(),
                date: r
                    .updated_at
                    .as_deref()
                    .and_then(|s| s.get(0..10))
                    .unwrap_or("")
                    .to_string(),
                meta: meta_parts.join(" · "),
            }
        })
        .collect())
}

// ========== Semantic Scholar ==========

#[derive(serde::Deserialize)]
struct S2Search {
    #[serde(default)]
    data: Vec<S2Paper>,
}
#[derive(serde::Deserialize)]
#[allow(non_snake_case)] // 与 Semantic Scholar 的 JSON 字段名（paperId / citationCount）保持一致
struct S2Paper {
    #[serde(default)]
    paperId: String,
    #[serde(default)]
    title: String,
    #[serde(default, rename = "abstract")]
    abstract_: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    year: Option<i64>,
    #[serde(default)]
    venue: Option<String>,
    #[serde(default)]
    citationCount: Option<i64>,
    #[serde(default)]
    authors: Vec<S2Author>,
}
#[derive(serde::Deserialize)]
struct S2Author {
    #[serde(default)]
    name: String,
}

async fn search_semantic_scholar(query: &str, limit: usize) -> Result<Vec<NoteWebResult>, String> {
    let resp = client()?
        .get("https://api.semanticscholar.org/graph/v1/paper/search")
        .query(&[
            (
                "fields",
                "title,abstract,url,year,venue,citationCount,authors".to_string(),
            ),
            ("query", query.to_string()),
            ("limit", limit.to_string()),
        ])
        .send()
        .await
        .map_err(|e| format!("请求 Semantic Scholar 失败（网络/代理可能拦截）：{e}"))?;
    let resp = ensure_ok(resp, "Semantic Scholar").await?;
    let parsed: S2Search = resp
        .json()
        .await
        .map_err(|e| format!("解析 Semantic Scholar 响应失败：{e}"))?;

    Ok(parsed
        .data
        .into_iter()
        .filter(|p| !p.title.is_empty())
        .map(|p| {
            let authors = p
                .authors
                .iter()
                .map(|a| a.name.clone())
                .filter(|n| !n.is_empty())
                .collect::<Vec<_>>()
                .join(", ");
            let mut meta_parts: Vec<String> = Vec::new();
            if let Some(v) = p.venue.as_deref().filter(|s| !s.is_empty()) {
                meta_parts.push(v.to_string());
            }
            if let Some(c) = p.citationCount {
                meta_parts.push(format!("引用 {c}"));
            }
            let fallback_url = format!("https://www.semanticscholar.org/paper/{}", p.paperId);
            NoteWebResult {
                id: p.paperId,
                title: p.title,
                summary: trim_cap(p.abstract_.as_deref().unwrap_or("")),
                url: p.url.filter(|u| !u.is_empty()).unwrap_or(fallback_url),
                authors,
                date: p.year.map(|y| y.to_string()).unwrap_or_default(),
                meta: meta_parts.join(" · "),
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arxiv_atom_parses_basic_entry() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <title>Attention Is All You Need</title>
    <summary>We propose a new simple network architecture.</summary>
    <published>2024-01-22T18:00:00Z</published>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
  </entry>
</feed>"#;
        let items = parse_arxiv_atom(xml, 5);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "2401.12345v1");
        assert_eq!(items[0].authors, "Ashish Vaswani, Noam Shazeer");
        assert_eq!(items[0].date, "2024-01-22");
        assert!(items[0].summary.contains("network architecture"));
    }

    #[test]
    fn arxiv_entities_are_unescaped() {
        let xml = r#"<feed xmlns="http://www.w3.org/2005/Atom"><entry>
            <id>http://arxiv.org/abs/1</id><title>A &amp; B</title>
            <summary>x &lt; y</summary><published>2024-01-01T00:00:00Z</published>
            <author><name>Z</name></author></entry></feed>"#;
        let items = parse_arxiv_atom(xml, 5);
        assert_eq!(items[0].title, "A & B");
        assert!(items[0].summary.contains("x < y"));
    }

    #[test]
    fn limit_is_clamped() {
        assert_eq!(clamp_limit(None), 12);
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(999)), MAX_LIMIT);
    }
}
