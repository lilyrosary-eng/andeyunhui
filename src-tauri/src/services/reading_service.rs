//! 阅读服务 — TXT / EPUB 解析归一化
//!
//! 安全模型：只读解析，不对原始文件做任何修改。
//! 归一化目标：txt 与 epub 最终都产出同一套 ReadingBook 形状，
//! 下游分页/阅读逻辑不需要区分格式来源。
//!
//! content 字段统一为"消毒 HTML"——只允许 <p>/<em>/<strong>/<br>，
//! 剥离 epub 内嵌的字体/颜色/脚本/样式，视觉呈现交给前端字体设置。
//! 内嵌图片 V1 不处理（小说类内容极少依赖插图，刻意简化）。
//!
//! epub 解析使用 epub crate（danigm/epub-rs，GPL-3.0），
//! HTML 消毒使用 ammonia（MIT）。两者均现成生态库，不手搓 OPF/NCX/spine。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::io::BufReader;
use std::sync::atomic::{AtomicU64, Ordering};

use epub::doc::EpubDoc;
use pulldown_cmark::{Parser, html};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

use crate::services::document_parser;
use encoding_rs::{Encoding, GB18030};

const READING_EXTENSIONS: &[&str] = &["txt", "epub", "pdf", "docx"];
const MAX_DEPTH: usize = 12;
const MAX_BOOKS: usize = 50_000;
const READING_CHUNK_SIZE: usize = 50;
/// 单章节内容字符上限：超过则按段落切片成多个小章节，
/// 避免前端把整本大书一次性渲染成巨型 DOM（CSS 多栏排版同步布局）而卡死主线程。
/// 25_000 字节 ≈ 8333 中文字符，会把正常长章节（8000+字）强行拆分，影响阅读体验。
/// 提高到 200_000 字节 ≈ 66600 中文字符，只有超长合并章节才会被拆分。
const MAX_CHAPTER_CHARS: usize = 200_000;

/// 扫描代次计数器（由 cancel_scan 递增）。
/// 每个扫描任务记录启动时的代次，若运行中发现代次不匹配则说明已被取消（或被更新的任务取代）。
/// 用 AtomicU64 替代 AtomicBool 解决"取消标记被新任务重置导致旧任务复活"的竞争 bug。
pub static READING_SCAN_GENERATION: AtomicU64 = AtomicU64::new(0);

/// 打开书籍代次计数器（由 cancel_open_book / cancel_scan 递增）。
/// 同上：每个 open_book 任务记录自己的代次，取消时递增代次使旧任务失效。
pub static OPEN_BOOK_GENERATION: AtomicU64 = AtomicU64::new(0);

/// 流式打开书籍事件载荷 — 书籍元信息（先于章节分块推送，前端据此立即进入阅读视图）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenBookMeta {
    pub file_path: String,
    pub title: String,
    pub author: Option<String>,
    pub format: String,
    pub total_chapters: usize,
    /// true 表示命中书籍缓存（分钟级解析结果直接复用），前端可展示"秒开"
    pub cached: bool,
}

/// open-book-chunk 直接发送 Vec<ReadingChapter>（与 scan-chunk 范式一致，前端帧缓冲直接 flat）

/// 流式打开书籍事件载荷 — 进度（done=true 表示推送完成）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenBookProgress {
    pub sent: usize,
    pub total: usize,
    pub done: bool,
}

fn ext_of(file_path: &str) -> String {
    Path::new(file_path)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default()
}

// ============ 数据结构（serde camelCase，与前端 TS 类型对齐）============

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookSummary {
    pub file_path: String,
    pub title: String,
    /// "txt" / "epub" / "pdf" / "docx"
    pub format: String,
    /// 相对于扫描根目录的父目录路径（用于前端构建目录树）
    pub parent_dir: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingChapter {
    pub id: String,
    pub title: String,
    /// 消毒后的 HTML：仅含 <p>/<em>/<strong>/<br>
    pub content: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingBook {
    pub file_path: String,
    pub title: String,
    pub author: Option<String>,
    pub chapters: Vec<ReadingChapter>,
}

// ============ 扫描：流式推送，只列文件，不做完整解析 ============

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub found: usize,
    pub total: usize,
    pub done: bool,
}

fn reading_format(name: &str) -> Option<&'static str> {
    let ext = name.rfind('.').map(|i| &name[i + 1..])?;
    let ext = ext.to_lowercase();
    READING_EXTENSIONS.iter().find(|e| e.eq_ignore_ascii_case(&ext)).map(|s| *s)
}

/// 扫描根目录下所有 txt/epub/pdf/docx 文件，流式推送结果。
///
/// 与图片模块方案一致：
/// - 在 spawn_blocking 中执行同步 WalkDir，避免阻塞异步运行时；
/// - 边遍历边通过 `scan-chunk` 事件分批推送（每批 READING_CHUNK_SIZE 本），
///   前端用帧缓冲合并，扫描时列表即时增长、不卡 UI；
/// - 通过 `scan-progress` 事件上报进度（found/total/done）；
/// - 用 READING_SCAN_GENERATION 代次计数器支持中途取消（扫整个磁盘也不卡死）；
/// - 扫描完成后写入缓存，下次直接命中缓存秒开。
pub fn scan_reading_root_streaming(app: &AppHandle, root_path: &str) -> Result<Vec<BookSummary>, String> {
    let my_gen = READING_SCAN_GENERATION.load(Ordering::SeqCst);

    let root = Path::new(root_path);
    if !root.is_dir() {
        return Err(format!("目录不存在或不是目录: {}", root_path));
    }

    // 阶段 1：遍历收集所有匹配文件（不做完整解析，开销低），期间支持取消
    let mut all: Vec<BookSummary> = Vec::new();
    let mut skipped = 0usize;

    for entry in WalkDir::new(root)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .into_iter()
    {
        if READING_SCAN_GENERATION.load(Ordering::Relaxed) != my_gen {
            app.emit("scan-progress", ScanProgress { found: 0, total: 0, done: true }).ok();
            return Ok(all);
        }
        match entry {
            Ok(e) => {
                if !e.file_type().is_file() {
                    continue;
                }
                let name = e.file_name().to_string_lossy().to_string();
                let format = match reading_format(&name) {
                    Some(f) => f,
                    None => continue,
                };
                let title = Path::new(&name)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or(&name)
                    .to_string();
                let parent_dir = e
                    .path()
                    .parent()
                    .and_then(|p| p.strip_prefix(root).ok())
                    .and_then(|r| r.to_str())
                    .unwrap_or("")
                    .to_string();
                all.push(BookSummary {
                    file_path: e.path().to_string_lossy().to_string(),
                    title,
                    format: format.to_string(),
                    parent_dir,
                });
                if all.len() >= MAX_BOOKS {
                    break;
                }
            }
            Err(e) => {
                skipped += 1;
                if skipped <= 5 {
                    eprintln!(
                        "[reading_service] 跳过: {} ({})",
                        e.path().unwrap_or(Path::new("?")).display(),
                        e
                    );
                }
            }
        }
    }

    if skipped > 5 {
        eprintln!("[reading_service] ... 共跳过 {} 个无权限目录", skipped);
    }

    // 后端做一次基础排序；前端会按本地 locale 再排，这里保证稳定顺序
    all.sort_by(|a, b| a.title.cmp(&b.title));

    let total = all.len();
    let mut found = 0usize;
    let mut chunk: Vec<BookSummary> = Vec::with_capacity(READING_CHUNK_SIZE);

    // 阶段 2：分批推送（同样支持取消）
    for book in all.iter() {
        if READING_SCAN_GENERATION.load(Ordering::Relaxed) != my_gen {
            app.emit("scan-progress", ScanProgress { found, total, done: true }).ok();
            return Ok(all);
        }
        chunk.push(book.clone());
        found += 1;
        if chunk.len() >= READING_CHUNK_SIZE {
            app.emit("scan-chunk", chunk.clone()).ok();
            app.emit("scan-progress", ScanProgress { found, total, done: false }).ok();
            chunk.clear();
        }
    }
    if !chunk.is_empty() {
        app.emit("scan-chunk", chunk).ok();
    }
    app.emit("scan-progress", ScanProgress { found, total, done: true }).ok();

    // 写入缓存，下次直接命中
    if let Ok(app_data) = app.path().app_data_dir() {
        if let Err(e) = crate::services::cache_service::save_cache(&app_data, "reading_scan", root_path, &all) {
            eprintln!("[reading_service] 缓存保存失败: {}", e);
        }
    }

    Ok(all)
}

// ============ 打开书：完整解析（流式 + 缓存）============

/// 完整解析一本书（纯解析，不做流式/缓存），返回归一化 ReadingBook。
/// 由 open_book_streaming 调用：先尝试命中书籍缓存，未命中则调用本函数解析并落盘缓存。
fn parse_book(app_data: &Path, file_path: &str) -> Result<ReadingBook, String> {
    let path = Path::new(file_path);
    if !path.is_file() {
        return Err(format!("文件不存在: {}", file_path));
    }

    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    let mut book = match ext.as_str() {
        "txt" => open_txt(file_path),
        "epub" => open_epub(file_path),
        // pdf/docx 走原生解析：原生解析 → markdown → pulldown-cmark HTML → 消毒
        "pdf" | "docx" => open_via_markitdown(app_data, file_path),
        other => return Err(format!("不支持的格式: .{}", other)),
    }?;

    // 超长章节切片：避免前端把整本大书一次性渲染成巨型 DOM（CSS 多栏同步布局）而卡死主线程。
    // 对 txt/pdf/docx 这类"整文件单章节"场景尤其关键。
    book.chapters = split_large_chapters(book.chapters);

    Ok(book)
}

/// 流式打开书籍：先推 open-book-meta，再按章分块推 open-book-chunk，
/// 完成推 open-book-progress(done=true)。命中书籍缓存时直接秒开，
/// 解析结果落盘缓存供下次秒开，进一步压低超大书的首开延迟。
///
/// 与扫描同构：spawn_blocking 卸载同步解析，期间支持 OPEN_BOOK_GENERATION 代次取消；
/// 事件在阻塞线程中持续 emit，前端通过 listen 实时接收，不必等待整本序列化一次性回传。
pub fn open_book_streaming(app: &AppHandle, file_path: &str) -> Result<(), String> {
    let my_gen = OPEN_BOOK_GENERATION.load(Ordering::SeqCst);

    // 应用数据目录：PDF/DOCX 原生解析抽取的图片由此写入中转站暂存目录。
    let app_data = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());

    let path = Path::new(file_path);
    if !path.is_file() {
        return Err(format!("文件不存在: {}", file_path));
    }

    // 源文件 mtime，用于缓存失效校验（文件被修改则缓存作废）
    let source_mtime = std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // 1. 尝试命中书籍缓存（整本解析结果落盘，mtime 一致则秒开）
    let cached_book: Option<ReadingBook> = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|app_data| {
            crate::services::cache_service::load_file_cache::<ReadingBook>(&app_data, "open_book", file_path)
                .filter(|(_, mtime)| *mtime == source_mtime)
                .map(|(book, _)| book)
        });

    let from_cache = cached_book.is_some();
    let book = match cached_book {
        Some(b) => b,
        None => parse_book(&app_data, file_path)?,
    };

    // 解析完成后检查代次：若期间被取消（或被更新的任务取代），直接退出不推任何事件。
    // 这避免了"旧任务解析完后继续推送事件，与新任务的事件混杂"的竞争问题。
    if OPEN_BOOK_GENERATION.load(Ordering::SeqCst) != my_gen {
        return Ok(());
    }

    let total = book.chapters.len();
    let format = ext_of(file_path);

    // 2. 先推 meta（前端据此立即进入阅读视图，不必等章节全部解析完）
    app.emit(
        "open-book-meta",
        OpenBookMeta {
            file_path: book.file_path.clone(),
            title: book.title.clone(),
            author: book.author.clone(),
            format,
            total_chapters: total,
            cached: from_cache,
        },
    )
    .ok();

    // 3. 分块推送章节（每批 READING_CHUNK_SIZE 章），前端用帧缓冲合并
    let mut sent = 0usize;
    let mut chunk: Vec<ReadingChapter> = Vec::with_capacity(READING_CHUNK_SIZE);
    for ch in book.chapters.iter() {
        if OPEN_BOOK_GENERATION.load(Ordering::Relaxed) != my_gen {
            app.emit("open-book-progress", OpenBookProgress { sent, total, done: true }).ok();
            return Ok(());
        }
        chunk.push(ch.clone());
        sent += 1;
        if chunk.len() >= READING_CHUNK_SIZE {
            app.emit("open-book-chunk", std::mem::take(&mut chunk)).ok();
            app.emit("open-book-progress", OpenBookProgress { sent, total, done: false }).ok();
        }
    }
    if !chunk.is_empty() {
        app.emit("open-book-chunk", chunk).ok();
    }
    app.emit("open-book-progress", OpenBookProgress { sent, total, done: true }).ok();

    // 4. 解析结果落盘缓存（命中缓存则不重复写）
    if !from_cache {
        if let Ok(app_data) = app.path().app_data_dir() {
            if let Err(e) = crate::services::cache_service::save_file_cache(
                &app_data,
                "open_book",
                file_path,
                &book,
                source_mtime,
            ) {
                eprintln!("[reading_service] 书籍缓存保存失败: {}", e);
            }
        }
    }

    Ok(())
}

// ============ 超长章节切片 ============

/// 把超过 `MAX_CHAPTER_CHARS` 的章节按段落边界拆成多个小章节。
/// 拆分对前端分页器（CSS 多栏）友好：每次只渲染一个有界 DOM，不会卡。
fn split_large_chapters(chapters: Vec<ReadingChapter>) -> Vec<ReadingChapter> {
    let mut out: Vec<ReadingChapter> = Vec::with_capacity(chapters.len());
    for ch in chapters {
        if ch.content.len() <= MAX_CHAPTER_CHARS {
            out.push(ch);
            continue;
        }
        let parts = split_html_into_parts(&ch.content, MAX_CHAPTER_CHARS);
        let n = parts.len();
        for (i, part) in parts.into_iter().enumerate() {
            out.push(ReadingChapter {
                id: format!("{}-p{}", ch.id, i),
                title: if n > 1 {
                    format!("{} ({}/{})", ch.title, i + 1, n)
                } else {
                    ch.title.clone()
                },
                content: part,
            });
        }
    }
    out
}

/// 按 `</p>` 边界把 HTML 切成若干段，每段尽量接近但不超过 budget 字符；
/// 单个超长 `<p>` 段落再按字符硬切，保证每段都有合法的 `<p>...</p>` 包裹。
fn split_html_into_parts(html: &str, budget: usize) -> Vec<String> {
    // 1. 以 </p> 为界切成段落片段（每个片段形如 <p>...</p>）
    let mut frags: Vec<String> = Vec::new();
    let mut start = 0usize;
    for (idx, _) in html.match_indices("</p>") {
        let end = idx + 4; // 含 </p>
        frags.push(html[start..end].to_string());
        start = end;
    }
    if start < html.len() {
        frags.push(html[start..].to_string());
    }
    if frags.is_empty() {
        return vec![html.to_string()];
    }

    // 2. 贪婪合并片段到 budget；超长单片段内部再硬切
    let mut parts: Vec<String> = Vec::new();
    let mut cur = String::new();
    for frag in frags {
        if frag.len() > budget {
            if !cur.is_empty() {
                parts.push(std::mem::take(&mut cur));
            }
            for sub in hard_split_fragment(&frag, budget) {
                parts.push(sub);
            }
            continue;
        }
        if !cur.is_empty() && cur.len() + frag.len() > budget {
            parts.push(std::mem::take(&mut cur));
        }
        cur.push_str(&frag);
    }
    if !cur.is_empty() {
        parts.push(cur);
    }
    if parts.is_empty() {
        parts.push(html.to_string());
    }
    parts
}

/// 把一个超长的单 `<p>` 片段切成多个 `<p>...</p>` 片段（按字符数硬切）。
fn hard_split_fragment(frag: &str, budget: usize) -> Vec<String> {
    let inner = frag
        .strip_prefix("<p>")
        .map(|s| s.strip_suffix("</p>").unwrap_or(s))
        .unwrap_or(frag);
    let chars: Vec<char> = inner.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let end = std::cmp::min(i + budget, chars.len());
        let piece: String = chars[i..end].iter().collect();
        out.push(format!("<p>{}</p>", piece));
        i = end;
    }
    out
}

// ---- TXT：整文件作单一 chapter，段落归一化为 <p> ----

/// 文本解码（编码兼容）：按优先级尝试，避免 ANSI/GBK 等非 UTF-8 文本乱码。
/// 1) BOM（UTF-8/UTF-16/UTF-32）→ 用 BOM 声明编码解码；
/// 2) 严格 UTF-8（含纯 ASCII）→ 直接按 UTF-8；
/// 3) chardetng 探测（CED 算法）；仅当探测明确为东亚多字节编码时才采用，
///    否则（单字节误判，如把 GBK 误判为 windows-1252，单字节 decode 不报错但结果错）
///    优先用 GB18030 兜底——中文 Windows "ANSI"(cp936) 是本项目最常见场景；
/// 4) GB18030 兜底（GBK 超集，覆盖 cp936），lossy 收尾。
/// 最终统一剥离可能残留的 UTF-8 BOM 字符（U+FEFF）。
fn decode_text(bytes: &[u8]) -> String {
    let decoded = if let Some((enc, _)) = Encoding::for_bom(bytes) {
        enc.decode(bytes).0.into_owned()
    } else if std::str::from_utf8(bytes).is_ok() {
        String::from_utf8_lossy(bytes).into_owned()
    } else {
        let mut detector = chardetng::EncodingDetector::new();
        let probe = bytes.len().min(8192);
        // 以样本作为最终输入做探测（CED 对 8KB 样本已足够准确）
        detector.feed(&bytes[..probe], true);
        let enc = detector.guess(None, false);
        // 单字节编码（windows-1252/iso-8859-1 等）几乎不会解码报错，但中文 GBK 会被静默误判；
        // 仅在探测明确为多字节东亚编码时才采用，否则偏置 GB18030 兜底。
        if is_east_asian_multibyte(enc) {
            let (cow, _, had_errors) = enc.decode(bytes);
            if !had_errors {
                cow.into_owned()
            } else {
                GB18030.decode(bytes).0.into_owned()
            }
        } else {
            GB18030.decode(bytes).0.into_owned()
        }
    };

    let mut s = decoded;
    if s.starts_with('\u{feff}') {
        s.remove(0);
    }
    s
}

/// 判断编码是否为东亚多字节编码（探测命中时可直接采用，避免被单字节编码误替）。
fn is_east_asian_multibyte(enc: &'static Encoding) -> bool {
    matches!(
        enc.name(),
        "gb18030" | "gbk" | "big5" | "shift_jis" | "euc-jp" | "euc-kr"
            | "iso-2022-jp" | "iso-2022-kr" | "utf-16be" | "utf-16le"
    )
}

// ============ 章节自动识别（按"第X章"等标题行切分）============
//
// 面向 TXT 与 markitdown 兜底（pdf/docx）这类"整文件单章节"来源：
// 扫描文本行，把形如"第X章 / 第X回 / 卷X / Chapter X / 序章 / 番外"
// 的行作为章节标题，其后的内容归入该章，从而自动分章。必须命中任意标题
// 才分章；否则回退到单一"正文"章节（旧行为），保证无章节标记的书籍不变。
// 命中后"点进小说的目录，子目录就是每一章"——前端目录抽屉直接复用章节列表。

/// 判断字符串是否为中文/阿拉伯数字序号（含 〇/两 等常见写法）
fn is_cn_numeral(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    s.chars().all(|c| {
        c.is_ascii_digit()
            || matches!(
                c,
                '零' | '一' | '二' | '三' | '四' | '五' | '六' | '七' | '八' | '九'
                    | '十' | '百' | '千' | '两' | '〇'
            )
    })
}

/// 判断一行是否为章节标题行
fn is_chapter_heading(line: &str) -> bool {
    let l = line.trim();
    if l.is_empty() || l.chars().count() > 30 {
        return false;
    }
    let lower = l.to_lowercase();
    // 英文：Chapter 12
    if lower.starts_with("chapter ") {
        if let Some(c) = lower["chapter ".len()..].chars().next() {
            if c.is_ascii_digit() {
                return true;
            }
        }
    }
    // 特殊固定词（序章/番外/尾声等），允许尾部标点
    const SPECIAL: &[&str] = &[
        "序章", "序言", "前言", "引子", "楔子", "后记", "后序", "尾声", "附录", "番外", "外传",
    ];
    for s in SPECIAL {
        if l == *s {
            return true;
        }
        if l.starts_with(s) {
            let tail = &l[s.len()..];
            if tail.chars().all(|c| c.is_whitespace() || c.is_ascii_punctuation()) {
                return true;
            }
        }
    }
    // 第X章 / 第X回 / 卷X ...
    if let Some(stripped) = l.strip_prefix('第') {
        for (i, c) in stripped.char_indices() {
            if matches!(c, '章' | '回' | '卷' | '节' | '部' | '篇' | '集') {
                return is_cn_numeral(&stripped[..i]);
            }
        }
    }
    false
}

/// 识别章节：返回 (标题, 正文原文) 列表。未识别到任何标题则 None（调用方回退单章节）。
fn detect_chapters(raw: &str) -> Option<Vec<(String, String)>> {
    let lines: Vec<&str> = raw.split('\n').collect();
    let mut out: Vec<(String, String)> = Vec::new();
    let mut found = false;
    let mut cur_title: String = String::new();
    let mut cur_body: Vec<String> = Vec::new();
    let mut preface: Vec<String> = Vec::new();

    for line in lines {
        let trimmed = line.trim();
        if is_chapter_heading(trimmed) {
            found = true;
            // 标题前的零散内容作为"前言"（仅当有实质内容，避免把单独的书名行算作一章）
            if !preface.is_empty() {
                let joined = preface.join("\n");
                if joined.trim().chars().count() > 20 {
                    out.push(("前言".to_string(), joined));
                }
                preface = Vec::new();
            }
            // 收掉上一章
            if !cur_title.is_empty() || !cur_body.is_empty() {
                out.push((std::mem::take(&mut cur_title), std::mem::take(&mut cur_body).join("\n")));
            }
            cur_title = trimmed.to_string();
        } else if found {
            cur_body.push(line.to_string());
        } else {
            preface.push(line.to_string());
        }
    }
    if found {
        if !cur_title.is_empty() || !cur_body.is_empty() {
            out.push((cur_title, cur_body.join("\n")));
        }
        Some(out)
    } else {
        None
    }
}

/// 把识别出的章节转成 ReadingChapter（按来源用对应 HTML 化函数）
fn chapters_from_detected(
    detected: &[(String, String)],
    to_html: impl Fn(&str) -> String,
) -> Vec<ReadingChapter> {
    detected
        .iter()
        .enumerate()
        .map(|(i, (title, body))| ReadingChapter {
            id: format!("ch-{}", i),
            title: title.clone(),
            content: to_html(body),
        })
        .collect()
}

fn open_txt(file_path: &str) -> Result<ReadingBook, String> {
    let path = Path::new(file_path);
    let title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("未命名")
        .to_string();

    let bytes = std::fs::read(path).map_err(|e| format!("读取文件失败: {}", e))?;
    // 超大文件防护：纯文本一次性读入内存并 split 成海量切片易 OOM / 卡死
    if bytes.len() > 200 * 1024 * 1024 {
        return Err("文件过大（>200MB），纯文本解析暂不支持，请拆分后打开".into());
    }
    // 编码兼容：BOM → UTF-8 严格 → chardetng 探测（GBK/Shift-JIS/Big5 等）→ GB18030 兜底
    // 解决中文 Windows "ANSI"(GBK/cp936) 等本地编码 txt 读成乱码的问题
    let content = decode_text(&bytes);

    let chapters = match detect_chapters(&content) {
        Some(d) => chapters_from_detected(&d, plain_text_to_html),
        None => vec![ReadingChapter {
            id: "ch-0".to_string(),
            title: "正文".to_string(),
            content: plain_text_to_html(&content),
        }],
    };

    Ok(ReadingBook {
        file_path: file_path.to_string(),
        title,
        author: None,
        chapters,
    })
}

/// 纯文本归一化为消毒 HTML：
/// - 按空行分段（\n\n）；段内单换行转 <br>
/// - HTML 转义 < > &，保证安全
fn plain_text_to_html(text: &str) -> String {
    let escaped = html_escape(text);
    let mut out = String::with_capacity(escaped.len() + 64);
    // 统一换行符
    let normalized = escaped.replace("\r\n", "\n").replace('\r', "\n");
    for para in normalized.split("\n\n") {
        let trimmed = para.trim();
        if trimmed.is_empty() {
            continue;
        }
        // 段内换行转 <br>，保留视觉换行
        let with_br = trimmed.replace('\n', "<br>");
        out.push_str("<p>");
        out.push_str(&with_br);
        out.push_str("</p>");
    }
    out
}

fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
    out
}

// ---- EPUB：epub crate 解析 + ammonia 消毒 ----

fn open_epub(file_path: &str) -> Result<ReadingBook, String> {
    let mut doc = EpubDoc::new(file_path)
        .map_err(|e| format!("EPUB 解析失败: {}", e))?;

    // 元数据
    let title = doc.get_title().unwrap_or_else(|| {
        Path::new(file_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("未命名")
            .to_string()
    });
    let author = doc
        .mdata("creator")
        .map(|m| m.value.clone())
        .or_else(|| {
            // EPUB2 常用 <dc:creator>，部分用 OPF meta；epub crate 已收纳到 metadata
            doc.metadata
                .iter()
                .find(|m| m.property == "creator")
                .map(|m| m.value.clone())
        });

    // 章节标题：从 toc (NCX NavPoint) 建立 spine 索引 → 标题 映射
    // 嵌套 toc 递归收集；href 去掉 #fragment 后用 resource_uri_to_chapter 转 spine 索引
    let mut title_map: std::collections::HashMap<usize, String> = std::collections::HashMap::new();
    collect_chapter_titles(&doc.toc.clone(), &doc, &mut title_map);

    let num = doc.get_num_chapters();
    let mut chapters = Vec::with_capacity(num);

    for i in 0..num {
        if !doc.set_current_chapter(i) {
            break;
        }
        let chapter_title = title_map
            .get(&i)
            .cloned()
            .unwrap_or_else(|| format!("第 {} 章", i + 1));

        let content = match doc.get_current_str() {
            Some((xhtml, _mime)) => sanitize_xhtml(&xhtml),
            None => String::new(),
        };

        chapters.push(ReadingChapter {
            id: format!("ch-{}", i),
            title: chapter_title,
            content,
        });
    }

    // 极端情况：spine 为空（破损 epub）
    if chapters.is_empty() {
        return Err("EPUB 无可读章节（spine 为空）".to_string());
    }

    Ok(ReadingBook {
        file_path: file_path.to_string(),
        title,
        author,
        chapters,
    })
}

// ---- PDF / DOCX：markitdown 兜底，归一化为同一 HTML 形状 ----
//
// 设计：markitdown 输出 Markdown，pulldown-cmark 转 HTML，再走同一套 ammonia 消毒。
// 这样下游分页/阅读逻辑完全不区分来源（txt/epub/pdf/docx 都是消毒 HTML）。
// markitdown 不稳定给出章节结构，V1 整文件作单一 chapter（与 txt 一致）。

fn open_via_markitdown(app_data: &Path, file_path: &str) -> Result<ReadingBook, String> {
    let path = Path::new(file_path);
    let title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("未命名")
        .to_string();

    // 1. 原生解析（docx/pdf）→ markdown，毫秒级、无需 Python
    let markdown = document_parser::convert_document_to_markdown(file_path, app_data)?;

    // 2. 章节自动识别：markitdown 输出的 markdown 同样按行检测"第X章"等标题，
    //    命中则逐章 markdown→HTML→消毒；否则整文件作单一"正文"章节。
    let chapters = match detect_chapters(&markdown) {
        Some(d) => chapters_from_detected(&d, |b| sanitize_xhtml(&markdown_to_html(b))),
        None => {
            // 整文件单章节：markdown → HTML → 消毒（heading/table 等被剥离保持视觉统一）
            let content = sanitize_xhtml(&markdown_to_html(&markdown));
            vec![ReadingChapter {
                id: "ch-0".to_string(),
                title: "正文".to_string(),
                content,
            }]
        }
    };

    Ok(ReadingBook {
        file_path: file_path.to_string(),
        title,
        author: None,
        chapters,
    })
}

/// Markdown → HTML（pulldown-cmark）。输出再交给 sanitize_xhtml 消毒。
fn markdown_to_html(markdown: &str) -> String {
    let parser = Parser::new(markdown);
    let mut html_output = String::with_capacity(markdown.len());
    html::push_html(&mut html_output, parser);
    html_output
}

/// 递归收集 toc → spine 索引 的标题映射。
/// 同一 spine 索引被多个 NavPoint 引用时，保留首个（toc 顺序通常即章节顺序）。
fn collect_chapter_titles(
    toc: &[epub::doc::NavPoint],
    doc: &EpubDoc<BufReader<std::fs::File>>,
    map: &mut std::collections::HashMap<usize, String>,
) {
    for np in toc {
        // 去掉 href 中的 #fragment，避免路径匹配失败
        let href = np.content.to_string_lossy();
        let clean = href.split('#').next().unwrap_or(&href);
        if let Some(idx) = doc.resource_uri_to_chapter(&PathBuf::from(clean)) {
            map.entry(idx).or_insert_with(|| np.label.clone());
        }
        collect_chapter_titles(&np.children, doc, map);
    }
}

/// 消毒 XHTML：只保留 <p>/<em>/<strong>/<br>，剥离其余一切。
/// - head/title/style/script/meta/link 连同内容一并移除（rm_tags）
/// - 其余非白名单标签（div/span/a/img/h1-6 等）解包：标签移除但保留子文本
/// - 所有属性（class/style/href/src 等）一律剥离
/// 输出可直接用于前端 dangerouslySetInnerHTML（已无脚本/样式）。
fn sanitize_xhtml(xhtml: &str) -> String {
    let mut builder = ammonia::Builder::new();
    let tags: HashSet<&str> = ["p", "em", "strong", "br"].into_iter().collect();
    let rm_tags: HashSet<&str> = [
        "script",
        "style",
        "head",
        "title",
        "meta",
        "link",
        "template",
        "noscript",
    ]
    .into_iter()
    .collect();
    builder.tags(tags);
    builder.rm_tags(rm_tags);
    builder.generic_attributes(HashSet::new());
    builder.clean(xhtml).to_string()
}
