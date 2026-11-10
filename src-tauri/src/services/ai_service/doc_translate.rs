//! 文档「格式保留」翻译：docx / pptx **原地回填**。
//!
//! ## 与 `document_parser` 的分工
//! `document_parser` 是**单向**的：docx/pptx/pdf → markdown，用于阅读与 RAG 摄取。
//! 这里要的是另一件事：**保留原文件的一切**（样式、表格、图片、页眉页脚、编号），只替换文字。
//! 所以不复用它的输出，只复用「怎么读 OOXML」的经验。
//!
//! ## ★ 为什么不能「解析成树再序列化回去」
//! OOXML 严重依赖命名空间前缀、属性顺序、`mc:Ignorable` 这类原文细节。
//! 任何「解析 → 重建」都会改掉它们，最轻的结果是样式跑掉，最重的是 Word 打开报
//! 「此文件中的内容有问题」。所以这里做的是**字节区间替换**：
//! 在原始 XML 字符串上，只改 `<w:t>` 与 `</w:t>` **之间**的文本，一个标签都不碰。
//!
//! ## 段落与 run 的关系（决定了译文怎么放回去）
//! 一个 `<w:p>`（段落）里通常有多个 `<w:r>`（run），每个 run 有自己的字体/加粗/颜色。
//! 文字在 run 里的 `<w:t>` 中。整段翻译才是对的（逐 run 翻会把句子切碎，质量和术语都不对），
//! 所以做法是：**整段翻，译文放进段内第一个非空 `<w:t>`，其余 `<w:t>` 清空**。
//!
//! ⚠️ 已知取舍：段内混排（同一段里前几个字加粗、后面正常）会被**合并成首段样式**。
//! 这是业界文档翻译的通行做法（Google Docs / DeepL 文档翻译同样如此），
//! 但必须让用户知道 —— 结果里会带一条 notice 说明，不静默。
//!
//! ## 批量策略为什么这么定
//! `translate_service::SEGMENT_MAX = 450`，且它的 `split_segments` **按 `\n` 切、行数守恒**。
//! 所以只要「一段 = 一行、每行 ≤ 450」，批量送进去就能按行一一取回。
//! 超过 450 的长段单独送（它内部会再切，拼回时会多出换行，所以取回后要把换行压成空格）。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

use super::translate_service::{self, TranslateSettings};

/// 与 `translate_service::SEGMENT_MAX` 保持一致：超过这个长度的段落不能走批量
/// （会被内核二次切分，行数就不守恒了）。
const PARA_MAX_FOR_BATCH: usize = 450;
/// 一批最多几段。8 段 ≈ 一次请求，够摊薄延迟又不至于让单次请求太长。
const BATCH_MAX_PARAS: usize = 8;

// ============================================================================
// 纯文本层面的 XML 扫描（不解析、不重建）
// ============================================================================

/// 一个 `<w:t>` / `<a:t>` 节点：记录**文本区间的字节位置**与解码后的文本。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TextRun {
    /// 开始标签 `>` 之后的位置（文本起点）
    pub open_end: usize,
    /// 结束标签 `</w:t` 之前的位置（文本终点）
    pub close_start: usize,
    /// 已做 XML 反转义的文本
    pub text: String,
}

/// 一个段落（`<w:p>` / `<a:p>`）及其内部的全部文本节点。
#[derive(Debug, Clone)]
pub(crate) struct Paragraph {
    pub runs: Vec<TextRun>,
}

impl Paragraph {
    /// 段落纯文本（把段内所有 run 拼起来 —— 这是要送去翻译的单位）。
    pub fn plain(&self) -> String {
        self.runs.iter().map(|r| r.text.as_str()).collect()
    }
}

/// 找 `<qname` 开始标签，返回 `(标签起始, '>' 之后的位置)`。
///
/// ⚠️ 必须校验标签名边界：`<w:p` 这个前缀会同时匹配 `<w:pPr>`，`<w:t` 会匹配 `<w:tbl>`。
/// 只认下一个字符是 `>` / `/` / 空白的情况，否则继续往后找。
fn find_open_tag(xml: &str, from: usize, qname: &str) -> Option<(usize, usize)> {
    let needle = format!("<{}", qname);
    let mut pos = from;
    while pos < xml.len() {
        let rel = xml[pos..].find(&needle)?;
        let start = pos + rel;
        let after = start + needle.len();
        match xml[after..].chars().next() {
            Some(c) if c == '>' || c == '/' || c.is_whitespace() => {
                let gt = after + xml[after..].find('>')?;
                return Some((start, gt + 1));
            }
            // 前缀撞上了别的标签（如 <w:pPr>），跳过当前这个 '<'
            _ => pos = start + 1,
        }
    }
    None
}

/// 扫描一个 part 里的所有段落。
///
/// `para_q` / `text_q` 传带命名空间前缀的限定名：docx 是 `w:p` / `w:t`，
/// pptx 是 `a:p` / `a:t`。两者结构一致，所以同一套扫描器通用。
pub(crate) fn scan_paragraphs(xml: &str, para_q: &str, text_q: &str) -> Vec<Paragraph> {
    let mut out: Vec<Paragraph> = Vec::new();
    let close_p = format!("</{}>", para_q);
    let close_t = format!("</{}>", text_q);
    let mut pos = 0usize;

    while let Some((_, p_open_end)) = find_open_tag(xml, pos, para_q) {
        // 自闭合 `<w:p/>` = 空段落，没有文本，直接跳过
        if xml[..p_open_end].ends_with("/>") {
            pos = p_open_end;
            continue;
        }
        let Some(rel_end) = xml[p_open_end..].find(&close_p) else {
            break;
        };
        let p_end = p_open_end + rel_end;

        let mut runs: Vec<TextRun> = Vec::new();
        let mut tpos = p_open_end;
        while tpos < p_end {
            let Some((_, t_open_end)) = find_open_tag(xml, tpos, text_q) else {
                break;
            };
            if t_open_end > p_end {
                break;
            }
            // 自闭合 `<w:t/>`：空文本，但仍要占位（否则段内 run 顺序会错位）
            if xml[..t_open_end].ends_with("/>") {
                runs.push(TextRun {
                    open_end: t_open_end,
                    close_start: t_open_end,
                    text: String::new(),
                });
                tpos = t_open_end;
                continue;
            }
            let Some(rel_c) = xml[t_open_end..p_end].find(&close_t) else {
                break;
            };
            let c = t_open_end + rel_c;
            let raw = &xml[t_open_end..c];
            runs.push(TextRun {
                open_end: t_open_end,
                close_start: c,
                text: unescape_xml(raw),
            });
            tpos = c + close_t.len();
        }

        if !runs.is_empty() {
            out.push(Paragraph { runs });
        }
        pos = p_end + close_p.len();
    }
    out
}

/// XML 文本节点反转义。
///
/// `<w:t>` 里的 `&` `<` `>` 都是以实体形式存的（`&amp;` `&lt;` `&gt;`），
/// 不还原的话送去翻译的就是 `&amp;` 这种字面量，译文里也会带着它。
pub(crate) fn unescape_xml(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    while i < s.len() {
        if s.as_bytes()[i] == b'&' {
            // 实体名不会很长；限制搜索窗口，避免把后面很远的 ';' 误吞
            if let Some(rel) = s[i..].find(';') {
                if rel <= 12 {
                    let ent = &s[i + 1..i + rel];
                    let rep = match ent {
                        "amp" => Some('&'),
                        "lt" => Some('<'),
                        "gt" => Some('>'),
                        "quot" => Some('"'),
                        "apos" => Some('\''),
                        _ => {
                            if let Some(hex) = ent.strip_prefix("#x").or_else(|| ent.strip_prefix("#X")) {
                                u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
                            } else if let Some(dec) = ent.strip_prefix('#') {
                                dec.parse::<u32>().ok().and_then(char::from_u32)
                            } else {
                                None
                            }
                        }
                    };
                    if let Some(c) = rep {
                        out.push(c);
                        i += rel + 1;
                        continue;
                    }
                }
            }
        }
        let c = s[i..].chars().next().unwrap_or('\u{FFFD}');
        out.push(c);
        i += c.len_utf8();
    }
    out
}

/// XML 文本节点转义（回填时用）。引号在文本节点里不需要转义，转了也无害，这里省掉。
pub(crate) fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

/// 这一段值不值得翻。
///
/// 跳过的三类：空白 / 太短（单个字符，多为项目符号或分页符残留）/ 没有任何字母
/// （纯数字、纯符号、页码）。注意 `is_alphabetic()` 对中文返回 **true**，
/// 所以中文段落不会被误跳过。
pub(crate) fn should_translate(s: &str) -> bool {
    let t = s.trim();
    if t.chars().count() < 2 {
        return false;
    }
    t.chars().any(|c| c.is_alphabetic())
}

/// 段落文本规范化：段内换行/制表符压成空格。
///
/// `<w:br/>` 在解析时被拼成了 `\n`，但它在原文档里通常只是排版换行，
/// 直接送进翻译内核会被当成「段落分隔」切成两个 segment，行数就不守恒了。
pub(crate) fn normalize_para_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = false;
    for c in s.chars() {
        if c == '\n' || c == '\r' || c == '\t' {
            if !prev_space && !out.is_empty() {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(c);
            prev_space = c == ' ';
        }
    }
    out.trim().to_string()
}

/// 把「段落 → 译文」变成一组**文本区间替换指令** `(起点, 终点, 新文本)`。
///
/// 规则：译文放进段内**第一个非空** run，其余 run 置空。
/// 空 run 保留（`<w:t></w:t>` 仍然合法），这样 run 的数量与顺序都不变，
/// 依赖 run 计数的域代码不会错位。
pub(crate) fn plan_edits(paras: &[Paragraph], translated: &[(usize, String)]) -> Vec<(usize, usize, String)> {
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    for (idx, text) in translated {
        let Some(para) = paras.get(*idx) else { continue };
        let Some(first) = para.runs.iter().position(|r| !r.text.trim().is_empty()) else {
            continue;
        };
        for (i, run) in para.runs.iter().enumerate() {
            let value = if i == first { escape_xml(text) } else { String::new() };
            // 自闭合节点没有文本区间，跳过（它本来就没文字）
            if run.close_start > run.open_end {
                edits.push((run.open_end, run.close_start, value));
            }
        }
    }
    // 顺序交给 `apply_edits` 统一处理 —— 这里排一次、那里假设一次，
    // 就是「降序 + cursor」那个 bug 的来源（见 apply_edits 注释）。
    edits
}

/// 把替换指令应用到原始 XML 上。**只改文本区间，标签一个字节都不动。**
///
/// ## ★ 必须按起点**升序**处理（踩过的坑）
/// `cursor` 的含义是「从原文消费到哪了」。第一版写成**降序** + cursor：
/// 第一个（最靠后的）区间处理后 `cursor` 停在它的末尾，第二个区间的 `start`
/// 反而小于 cursor ⇒ 被当成「异常区间」跳过，**除最后一个之外全部不生效**。
/// 症状很隐蔽：XML 依然良构、标签数不变、甚至看起来"成功"了 —— 只是译文压根没写进去。
/// 是 Python 独立复算真实 pptx 时抓到的（`new_xml` 里找不到译文）。
pub(crate) fn apply_edits(xml: &str, edits: &[(usize, usize, String)]) -> String {
    let mut order: Vec<usize> = (0..edits.len()).collect();
    order.sort_by_key(|&i| edits[i].0);
    let mut out = String::with_capacity(xml.len() + edits.iter().map(|e| e.2.len()).sum::<usize>());
    let mut cursor = 0usize;
    for i in order {
        let (start, end, text) = (&edits[i].0, &edits[i].1, &edits[i].2);
        if *start < cursor || *end > xml.len() || *start > *end {
            continue; // 区间异常：跳过而不是 panic（半坏的文件也要能尽量产出）
        }
        out.push_str(&xml[cursor..*start]);
        out.push_str(text);
        cursor = *end;
    }
    out.push_str(&xml[cursor..]);
    out
}

// ============================================================================
// 打包：复制原 zip，只替换被改过的 part
// ============================================================================

fn read_zip_text(zip: &mut ZipArchive<std::fs::File>, name: &str) -> Option<String> {
    let mut f = zip.by_name(name).ok()?;
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    Some(s)
}

fn rewrite_zip(
    src: &Path,
    dst: &Path,
    replace: &HashMap<String, Vec<u8>>,
) -> Result<(), String> {
    let file = std::fs::File::open(src).map_err(|e| format!("[打包] 打开源文件失败: {}", e))?;
    let mut zin =
        ZipArchive::new(file).map_err(|e| format!("[打包] 读取源包失败: {}", e))?;
    let out = std::fs::File::create(dst).map_err(|e| format!("[打包] 创建输出失败: {}", e))?;
    let mut zout = ZipWriter::new(out);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    for i in 0..zin.len() {
        let mut entry = zin
            .by_index(i)
            .map_err(|e| format!("[打包] 读取条目 {} 失败: {}", i, e))?;
        let name = entry.name().to_string();
        if entry.is_dir() {
            zout.add_directory(name, opts)
                .map_err(|e| format!("[打包] 写入目录失败: {}", e))?;
            continue;
        }
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("[打包] 读取 {} 失败: {}", name, e))?;
        let data = replace.get(&name).cloned().unwrap_or(buf);
        zout.start_file(name, opts)
            .map_err(|e| format!("[打包] 写入条目失败: {}", e))?;
        zout.write_all(&data)
            .map_err(|e| format!("[打包] 写内容失败: {}", e))?;
    }
    zout.finish().map_err(|e| format!("[打包] 收尾失败: {}", e))?;
    Ok(())
}

// ============================================================================
// 翻译编排
// ============================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocTranslateOutcome {
    /// 输出文件绝对路径（`None` 时是同目录 `<原名>.<目标语言><扩展名>`）
    pub out_path: String,
    /// `docx` / `pptx`
    pub format: String,
    /// 扫描到的段落总数
    pub paragraphs: u32,
    /// 实际翻译的段落数
    pub translated: u32,
    /// 主动跳过（空 / 纯数字 / 太短）
    pub skipped: u32,
    /// 翻译失败、保留原文的段落数
    pub failed: u32,
    /// 所有提示（跳过原因、批量降级、样式合并说明…）—— 前端直接展示，不截断
    pub notices: Vec<String>,
}

pub(crate) fn push_notice(v: &mut Vec<String>, s: impl Into<String>) {
    let s = s.into();
    eprintln!("[doc-translate] {}", s);
    v.push(s);
}

/// 目标语言用于文件名的安全片段（`zh-CN` → `zh-CN`，去掉路径分隔符）。
pub(crate) fn lang_suffix(target: Option<&str>) -> String {
    let t = target.unwrap_or("").trim();
    let cleaned: String = t
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if cleaned.is_empty() {
        "translated".to_string()
    } else {
        cleaned
    }
}

fn default_out_path(src: &Path, target: Option<&str>) -> PathBuf {
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document");
    let ext = src.extension().and_then(|s| s.to_str()).unwrap_or("docx");
    let name = format!("{}.{}.{}", stem, lang_suffix(target), ext);
    src.with_file_name(name)
}

/// 翻译一批短段落。返回与输入**等长**的 `Option<String>`（`None` = 该段失败要留原文）。
///
/// 用 `\n` 连接、按 `\n` 切回：这依赖 `translate_service::split_segments` 的
/// 「按行切、行数守恒」性质（每段单独一行且 ≤ 450 字符时成立）。
/// 行数不符就**整批判失败**，由调用方退化为逐段 —— 宁可慢，不把段落错位。
pub(crate) async fn translate_batch(
    app: &AppHandle,
    texts: &[String],
    source: Option<&str>,
    target: Option<&str>,
    st: &TranslateSettings,
    notices: &mut Vec<String>,
) -> Vec<Option<String>> {
    if texts.is_empty() {
        return Vec::new();
    }
    if texts.len() == 1 {
        return vec![translate_one(app, &texts[0], source, target, st).await];
    }

    let joined = texts.join("\n");
    match translate_service::translate(app, &joined, source, target, st.clone()).await {
        Ok(out) => {
            let parts: Vec<&str> = out.text.split('\n').collect();
            if parts.len() == texts.len() {
                return parts
                    .into_iter()
                    .map(|s| {
                        let t = s.trim();
                        if t.is_empty() {
                            None
                        } else {
                            Some(t.to_string())
                        }
                    })
                    .collect();
            }
            push_notice(
                notices,
                format!(
                    "批量翻译的段落数对不上（送 {} 段、回 {} 段），这批改为逐段重试",
                    texts.len(),
                    parts.len()
                ),
            );
        }
        Err(e) => {
            push_notice(
                notices,
                format!("批量翻译失败（{}），这批改为逐段重试", truncate(&e, 120)),
            );
        }
    }

    // 退化：逐段
    let mut out = Vec::with_capacity(texts.len());
    for t in texts {
        out.push(translate_one(app, t, source, target, st).await);
    }
    out
}

pub(crate) async fn translate_one(
    app: &AppHandle,
    text: &str,
    source: Option<&str>,
    target: Option<&str>,
    st: &TranslateSettings,
) -> Option<String> {
    match translate_service::translate(app, text, source, target, st.clone()).await {
        Ok(out) => {
            let t = out.text.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        }
        Err(e) => {
            eprintln!("[doc-translate] 单段翻译失败（保留原文）: {}", e);
            None
        }
    }
}

pub(crate) fn truncate(s: &str, n: usize) -> String {
    let mut out: String = s.chars().take(n).collect();
    if s.chars().count() > n {
        out.push('…');
    }
    out
}

/// 把一段（可能超长）译文规范成单行：内核二次切分后会带 `\n`，压回空格。
pub(crate) fn flatten(text: String) -> String {
    let mut out = String::with_capacity(text.len());
    let mut prev_space = false;
    for c in text.chars() {
        if c == '\n' || c == '\r' {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(c);
            prev_space = c == ' ';
        }
    }
    out.trim().to_string()
}

/// 翻译一个 XML part：扫描 → 分批翻 → 生成替换指令 → 返回新 XML。
///
/// 抽成独立函数是为了 docx（`word/document.xml`）与 pptx（`ppt/slides/*.xml`）共用。
async fn translate_part(
    app: &AppHandle,
    xml: &str,
    para_q: &str,
    text_q: &str,
    source: Option<&str>,
    target: Option<&str>,
    st: &TranslateSettings,
    notices: &mut Vec<String>,
    stat: &mut (u32, u32, u32, u32), // (段落总数, 已翻, 跳过, 失败)
) -> String {
    let paras = scan_paragraphs(xml, para_q, text_q);
    stat.0 += paras.len() as u32;

    // 选出要翻的段落
    let mut targets: Vec<(usize, String)> = Vec::new();
    for (i, p) in paras.iter().enumerate() {
        let raw = p.plain();
        if !should_translate(&raw) {
            stat.2 += 1;
            continue;
        }
        let norm = normalize_para_text(&raw);
        if norm.is_empty() || !should_translate(&norm) {
            stat.2 += 1;
            continue;
        }
        targets.push((i, norm));
    }
    if targets.is_empty() {
        return xml.to_string();
    }

    // 长段单独送（>450 会被内核二次切分，行数不守恒）
    let (long, short): (Vec<_>, Vec<_>) = targets
        .into_iter()
        .partition(|(_, t)| t.chars().count() > PARA_MAX_FOR_BATCH);
    let mut translated: Vec<(usize, String)> = Vec::new();
    let mut failed = 0u32;

    for (idx, text) in long {
        match translate_one(app, &text, source, target, st).await {
            Some(t) => translated.push((idx, flatten(t))),
            None => failed += 1,
        }
    }

    for chunk in short.chunks(BATCH_MAX_PARAS) {
        let texts: Vec<String> = chunk.iter().map(|(_, t)| t.clone()).collect();
        let results = translate_batch(app, &texts, source, target, st, notices).await;
        for ((idx, _), res) in chunk.iter().zip(results.into_iter()) {
            match res {
                Some(t) => translated.push((*idx, flatten(t))),
                None => failed += 1,
            }
        }
    }

    stat.1 += translated.len() as u32;
    stat.3 += failed;

    let edits = plan_edits(&paras, &translated);
    apply_edits(xml, &edits)
}

/// 扫描文档里涉及文本的 part（按格式）。
fn text_parts(zip: &mut ZipArchive<std::fs::File>, format: &str) -> Vec<String> {
    match format {
        "docx" => {
            // 正文 + 页眉页脚 + 脚注尾注（这些也常要翻，且都是独立 part）
            let mut v = vec!["word/document.xml".to_string()];
            for i in 1..=8 {
                for prefix in ["word/header", "word/footer"] {
                    let name = format!("{}{}.xml", prefix, i);
                    if zip.by_name(&name).is_ok() {
                        v.push(name);
                    }
                }
            }
            for name in ["word/footnotes.xml", "word/endnotes.xml"] {
                if zip.by_name(name).is_ok() {
                    v.push(name.to_string());
                }
            }
            v
        }
        "pptx" => zip
            .file_names()
            .filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml"))
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn detect_format(path: &Path) -> Result<&'static str, String> {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("docx") | Some("docm") => Ok("docx"),
        Some("pptx") | Some("pptm") => Ok("pptx"),
        other => Err(format!(
            "[格式] 暂不支持 `{}`：当前只做 docx / pptx（PDF 需要另一条路，见模块注释）",
            other.unwrap_or("(无扩展名)")
        )),
    }
}

/// 文档格式保留翻译（docx / pptx）。
///
/// 输出**不覆盖原文件**：默认写到同目录 `<原名>.<目标语言>.<扩展名>`，
/// 也可以由 `out_path` 指定。原文件一个字节都不动。
#[tauri::command]
pub async fn translate_document(
    app: AppHandle,
    path: String,
    target_lang: Option<String>,
    source_lang: Option<String>,
    settings: Option<TranslateSettings>,
    out_path: Option<String>,
) -> Result<DocTranslateOutcome, String> {
    let src = PathBuf::from(&path);
    if !src.is_file() {
        return Err(format!("[输入] 文件不存在: {}", path));
    }
    let format = detect_format(&src)?;
    let dst = match out_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => default_out_path(&src, target_lang.as_deref()),
    };

    let st = settings.unwrap_or_default();
    let src_l = source_lang.as_deref().filter(|s| !s.trim().is_empty());
    let tgt_l = target_lang.as_deref().filter(|s| !s.trim().is_empty());

    // ① 读 + 扫描（同步 IO 放 spawn_blocking，避免占住 tokio 工作线程）
    let src_c = src.clone();
    let (parts, originals) = tokio::task::spawn_blocking(move || -> Result<(Vec<String>, Vec<String>), String> {
        let file = std::fs::File::open(&src_c).map_err(|e| format!("[读取] 打开文件失败: {}", e))?;
        let mut zip = ZipArchive::new(file).map_err(|e| format!("[读取] 不是有效的 {}: {}", src_c.display(), e))?;
        let fmt = detect_format(&src_c)?;
        let names = text_parts(&mut zip, fmt);
        if names.is_empty() {
            return Err(format!("[读取] 包内没有可翻译的文本 part（{}）", src_c.display()));
        }
        let mut texts = Vec::with_capacity(names.len());
        for n in &names {
            match read_zip_text(&mut zip, n) {
                Some(t) => texts.push(t),
                None => texts.push(String::new()),
            }
        }
        Ok((names, texts))
    })
    .await
    .map_err(|e| format!("[读取] 任务失败: {}", e))??;

    // ② 逐 part 翻译
    let mut notices: Vec<String> = Vec::new();
    let mut stat = (0u32, 0u32, 0u32, 0u32);
    let (para_q, text_q) = ("w:p", "w:t");
    let (para_q, text_q) = if format == "pptx" { ("a:p", "a:t") } else { (para_q, text_q) };

    let mut replaced: HashMap<String, Vec<u8>> = HashMap::new();
    for (name, xml) in parts.iter().zip(originals.iter()) {
        if xml.is_empty() {
            push_notice(&mut notices, format!("{} 读不出来，已跳过", name));
            continue;
        }
        let new_xml = translate_part(
            &app, xml, para_q, text_q, src_l, tgt_l, &st, &mut notices, &mut stat,
        )
        .await;
        replaced.insert(name.clone(), new_xml.into_bytes());
    }

    // ③ 打包（同样放 spawn_blocking）
    let src_c = src.clone();
    let dst_c = dst.clone();
    tokio::task::spawn_blocking(move || rewrite_zip(&src_c, &dst_c, &replaced))
        .await
        .map_err(|e| format!("[打包] 任务失败: {}", e))??;

    // ④ 把已知取舍说清楚，不静默
    if stat.1 > 0 {
        push_notice(
            &mut notices,
            "段内若原本有局部加粗/变色，译文会统一成该段首个文字块的样式（文档翻译的通行取舍）",
        );
    }
    if stat.3 > 0 {
        push_notice(
            &mut notices,
            format!("有 {} 段翻译失败，已保留原文", stat.3),
        );
    }

    Ok(DocTranslateOutcome {
        out_path: dst.to_string_lossy().to_string(),
        format: format.to_string(),
        paragraphs: stat.0,
        translated: stat.1,
        skipped: stat.2,
        failed: stat.3,
        notices,
    })
}

// ============================================================================
// 测试：只测纯函数（不碰网络、不碰真实 docx）
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn xml_doc() -> &'static str {
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Hello</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve"> world</w:t></w:r></w:p>
<w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:p>
<w:p><w:r><w:t>12345</w:t></w:r></w:p>
</w:body></w:document>"#
    }

    #[test]
    fn 扫描_段落与run边界正确_且不被pPr和tbl误匹配() {
        let paras = scan_paragraphs(xml_doc(), "w:p", "w:t");
        // 3 个含文本的段落：正文段、表格单元格段、纯数字段
        assert_eq!(paras.len(), 3, "应扫出 3 段");
        assert_eq!(paras[0].plain(), "Hello world", "段内多 run 应拼成整段");
        assert_eq!(paras[0].runs.len(), 2);
        assert_eq!(paras[1].plain(), "Cell A", "表格里的段落也要扫到");
        assert_eq!(paras[2].plain(), "12345");
    }

    #[test]
    fn 反转义与转义_往返一致() {
        for raw in ["a & b", "x < y", "判断 p > q", "含 &amp; 已转义"] {
            let e = escape_xml(raw);
            assert_eq!(unescape_xml(&e), raw, "往返失败: {raw}");
        }
        assert_eq!(unescape_xml("&#65;&#x42;"), "AB");
        assert_eq!(unescape_xml("&unknown;"), "&unknown;", "未知实体原样保留");
    }

    #[test]
    fn 跳过规则_中文不误杀_纯数字要跳过() {
        assert!(should_translate("Hello"));
        assert!(should_translate("你好，世界"), "is_alphabetic 对中文为 true");
        assert!(should_translate("  spaced  "));
        assert!(!should_translate("12345"));
        assert!(!should_translate("   "));
        assert!(!should_translate("A"), "单字符不翻");
        assert!(!should_translate("—— ·"), "纯符号不翻");
    }

    #[test]
    fn 规范化_段内换行压成空格() {
        assert_eq!(normalize_para_text("a\nb\tc"), "a b c");
        assert_eq!(normalize_para_text("  a  \n b "), "a b");
    }

    #[test]
    fn 回填_译文进首个非空run_其余清空_且标签原样保留() {
        let xml = xml_doc();
        let paras = scan_paragraphs(xml, "w:p", "w:t");
        let edits = plan_edits(&paras, &[(0, "你好 世界".to_string())]);
        let out = apply_edits(xml, &edits);

        assert!(out.contains("<w:t>你好 世界</w:t>"), "译文应落到首个 run");
        assert!(out.contains("<w:t xml:space=\"preserve\"></w:t>"), "第二个 run 清空但保留标签与属性");
        // 结构零改动
        assert!(out.contains("<w:pStyle w:val=\"Heading1\"/>"), "pPr 必须原样");
        assert!(out.contains("<w:b/>"), "run 属性必须原样");
        assert!(out.contains("Cell A"), "未提供的段落不能被改动");
        assert_eq!(out.matches("<w:p>").count(), xml.matches("<w:p>").count());
    }

    #[test]
    fn 回填_特殊字符必须转义_否则文档会坏() {
        let xml = xml_doc();
        let paras = scan_paragraphs(xml, "w:p", "w:t");
        let out = apply_edits(xml, &plan_edits(&paras, &[(0, "a & b < c".to_string())]));
        assert!(out.contains("a &amp; b &lt; c"), "必须转义: {}", &out[..200.min(out.len())]);
        assert!(!out.contains("<w:t>a & b"), "未转义的裸 & 会破坏 XML");
    }

    /// ★ 回归：**多个区间必须都生效**。
    /// 第一版 `apply_edits` 用「降序 + cursor」，导致只有最后一个区间被替换 ——
    /// 而 XML 仍然良构、标签数也不变，看起来像是成功了。这条用例就是钉死它。
    #[test]
    fn 回填_多段译文都要生效_不能只改最后一段() {
        let xml = xml_doc();
        let paras = scan_paragraphs(xml, "w:p", "w:t");
        let out = apply_edits(
            xml,
            &plan_edits(&paras, &[(0, "第一段".to_string()), (1, "第二段".to_string())]),
        );
        assert!(out.contains("<w:t>第一段</w:t>"), "第 1 段没被替换");
        assert!(out.contains("<w:t>第二段</w:t>"), "第 2 段没被替换");
        assert!(!out.contains("Hello"), "旧文本应全部消失");
        assert!(!out.contains("Cell A"), "旧文本应全部消失");
        // 未提供译文的段落保持原样
        assert!(out.contains("12345"));
    }

    #[test]
    fn 回填_区间异常不panic() {
        // 起点倒挂 / 越界 都应被跳过而不是崩
        let out = apply_edits("abc", &[(5, 9, "x".into()), (2, 1, "y".into())]);
        assert_eq!(out, "abc");
    }

    #[test]
    fn 默认输出路径不覆盖原文件() {
        let p = Path::new("D:/tmp/论文.docx");
        let out = default_out_path(p, Some("zh-CN"));
        assert_eq!(out.file_name().unwrap().to_str().unwrap(), "论文.zh-CN.docx");
        assert_ne!(out, p, "绝不能写回原文件");
        // 非法语言码要退化成安全名
        let out2 = default_out_path(p, Some("../../evil"));
        assert!(!out2.to_string_lossy().contains(".."), "不能引入路径穿越");
    }

    #[test]
    fn 只认docx与pptx() {
        assert_eq!(detect_format(Path::new("a.docx")).unwrap(), "docx");
        assert_eq!(detect_format(Path::new("a.PPTX")).unwrap(), "pptx");
        assert!(detect_format(Path::new("a.pdf")).is_err());
        assert!(detect_format(Path::new("a.txt")).is_err());
    }

    #[test]
    fn pptx用a命名空间也能扫() {
        let xml = r#"<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><a:p><a:r><a:t>Slide text</a:t></a:r></a:p></p:cSld></p:sld>"#;
        let paras = scan_paragraphs(xml, "a:p", "a:t");
        assert_eq!(paras.len(), 1);
        assert_eq!(paras[0].plain(), "Slide text");
    }

    #[test]
    fn 打包_复制所有条目且只替换目标() {
        let dir = std::env::temp_dir().join(format!("adyh_dt_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let src = dir.join("in.docx");
        let dst = dir.join("out.docx");
        // 造一个最小 zip（模拟 docx 的多条目结构）
        {
            let f = std::fs::File::create(&src).unwrap();
            let mut z = ZipWriter::new(f);
            let o = SimpleFileOptions::default();
            z.start_file("word/document.xml", o).unwrap();
            z.write_all(b"<w:document><w:p><w:r><w:t>old</w:t></w:r></w:p></w:document>").unwrap();
            z.start_file("[Content_Types].xml", o).unwrap();
            z.write_all(b"<Types/>").unwrap();
            z.finish().unwrap();
        }
        let mut rep = HashMap::new();
        rep.insert("word/document.xml".to_string(), b"<w:document>NEW</w:document>".to_vec());
        rewrite_zip(&src, &dst, &rep).unwrap();

        let mut z = ZipArchive::new(std::fs::File::open(&dst).unwrap()).unwrap();
        assert_eq!(z.len(), 2, "条目数必须保持（[Content_Types].xml 不能丢）");
        let mut s = String::new();
        z.by_name("word/document.xml").unwrap().read_to_string(&mut s).unwrap();
        assert_eq!(s, "<w:document>NEW</w:document>");
        let mut t = String::new();
        z.by_name("[Content_Types].xml").unwrap().read_to_string(&mut t).unwrap();
        assert_eq!(t, "<Types/>", "未替换的条目要原样复制");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
