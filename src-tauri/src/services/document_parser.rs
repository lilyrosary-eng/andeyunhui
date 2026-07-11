//! 原生文档解析（docx / pptx / xlsx / pdf）。
//!
//! 这些格式本质就是 OOXML（zip 压缩的 XML）或 PDF，无需启动 Python，可在毫秒级内解析出
//! 纯文本、标题、表格，并把内嵌图片抽取到「中转站」目录、以 `localimg://` 引用，从而让
//! 笔记预览即时渲染图片与表格。相比 markitdown（每次起 Python 进程，小文件也要 1~3s），
//! 原生解析是“极致优化”的关键路径，且 PDF 也能出图。

use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use quick_xml::events::BytesStart;
use quick_xml::events::Event;
use quick_xml::Reader;
use zip::ZipArchive;

use std::fs::File;

use image::{DynamicImage, GrayImage, RgbImage};
use lopdf;
use lopdf::Object;

/// 入口：根据扩展名分发到对应原生解析器。
/// `app_data` 为应用数据目录，抽取出的图片会写入 `<app_data>/transfer_station/dropzone`。
pub fn convert_document_to_markdown(path: &str, app_data: &Path) -> Result<String, String> {
    let ext = Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "docx" | "docm" => parse_office_docx(path, app_data),
        "pptx" | "pptm" => parse_office_pptx(path, app_data),
        "xlsx" | "xlsm" => parse_office_xlsx(path),
        "pdf" => convert_pdf_to_markdown(path, app_data),
        _ => Err(format!("原生解析不支持该格式: {}", ext)),
    }
}

/// 文档解析抽取的图片目录：仅用于笔记预览（localimg:// 引用），
/// 与 dropzone 分离，因此「图标栏中转站」不会列出这些图片，也不进存档。
fn doc_media_dir(app_data: &Path) -> PathBuf {
    app_data.join("transfer_station").join("media")
}

// ----------------------------------------------------------------------------
// 通用工具
// ----------------------------------------------------------------------------

/// 与前端 `decodeURIComponent` 兼容的编码：仅保留字母数字与 `-_.~`，其余按 `%XX` 编码。
pub fn js_encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn read_entry_to_string(zip: &mut ZipArchive<File>, name: &str) -> Option<String> {
    let mut f = zip.by_name(name).ok()?;
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    Some(s)
}

fn read_entry_bytes(zip: &mut ZipArchive<File>, name: &str) -> Option<Vec<u8>> {
    let mut f = zip.by_name(name).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// 读取 .rels 文件，返回 (rId -> Target 映射, 被描述部件的目录)。
/// Target 相对“被描述部件”所在目录，而非 .rels 文件所在目录，因此需要换算。
fn read_rels(zip: &mut ZipArchive<File>, rels_path: &str) -> (HashMap<String, String>, String) {
    let base = part_dir_from_rels(rels_path);
    let mut map = HashMap::new();
    if let Some(xml) = read_entry_to_string(zip, rels_path) {
        let mut reader = Reader::from_str(&xml);
        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                    let n = e.name().local_name();
                    if n.as_ref() == b"Relationship" {
                        let id = attr_val(&e, b"Id");
                        let target = attr_val(&e, b"Target");
                        if let (Some(id), Some(target)) = (id, target) {
                            map.insert(id, target);
                        }
                    }
                }
                Ok(Event::Eof) => break,
                _ => {}
            }
            buf.clear();
        }
    }
    (map, base)
}

/// "word/_rels/document.xml.rels" -> 被描述部件 "word/document.xml" -> 目录 "word"
fn part_dir_from_rels(rels_path: &str) -> String {
    let no_rels = rels_path.replacen("_rels/", "", 1);
    let part = no_rels.trim_end_matches(".rels");
    Path::new(part)
        .parent()
        .and_then(|p| p.to_str())
        .unwrap_or("")
        .to_string()
}

fn attr_val(e: &BytesStart, local: &[u8]) -> Option<String> {
    for a in e.attributes().filter_map(|a| a.ok()) {
        if a.key.local_name().as_ref() == local {
            return std::str::from_utf8(&a.value).ok().map(|s| s.to_string());
        }
    }
    None
}

fn parse_heading(val: &str) -> Option<usize> {
    if val.eq_ignore_ascii_case("title") {
        Some(1)
    } else if let Some(rest) = val
        .strip_prefix("Heading")
        .or_else(|| val.strip_prefix("heading"))
    {
        rest.parse::<usize>().ok().map(|n| n.clamp(1, 6))
    } else {
        None
    }
}

fn escape_table_cell(s: &str) -> String {
    s.replace('\n', " ").replace('|', "\\|").trim().to_string()
}

/// 把二维网格渲染为 GitHub 风格 Markdown 表格（首行为表头）。
fn render_table(rows: &[Vec<String>]) -> String {
    if rows.is_empty() {
        return String::new();
    }
    let cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    if cols == 0 {
        return String::new();
    }
    let mut out = String::new();
    // 表头
    out.push('|');
    for c in 0..cols {
        let v = rows[0].get(c).map(|x| x.as_str()).unwrap_or("");
        out.push(' ');
        out.push_str(&escape_table_cell(v));
        out.push_str(" |");
    }
    out.push('\n');
    // 分隔行
    out.push('|');
    for _ in 0..cols {
        out.push_str(" --- |");
    }
    out.push('\n');
    // 数据行
    for row in &rows[1..] {
        out.push('|');
        for c in 0..cols {
            let v = row.get(c).map(|x| x.as_str()).unwrap_or("");
            out.push(' ');
            out.push_str(&escape_table_cell(v));
            out.push_str(" |");
        }
        out.push('\n');
    }
    out
}

// ----------------------------------------------------------------------------
// 通用 OOXML 正文解析（docx 与 pptx 共用：二者标签本地名一致）
// ----------------------------------------------------------------------------

struct BodyParser<'a> {
    out: &'a mut String,
    rels: &'a HashMap<String, String>,
    base_dir: &'a str,
    zip: &'a mut ZipArchive<File>,
    media_dir: &'a Path,
    // 状态
    in_text: bool,
    para_text: String,
    para_heading: Option<usize>,
    para_is_list: bool,
    in_tc: bool,
    cell_buf: String,
    rows: Vec<Vec<String>>,
    cur_row: Vec<String>,
}

impl<'a> BodyParser<'a> {
    fn append_text(&mut self, s: &str) {
        if self.in_tc {
            self.cell_buf.push_str(s);
        } else {
            self.para_text.push_str(s);
        }
    }

    fn resolve_image(&mut self, rel_id: &str) -> Option<String> {
        let target = self.rels.get(rel_id)?.clone();
        let candidates: Vec<String> = if target.starts_with('/') {
            vec![target.trim_start_matches('/').to_string()]
        } else if target.to_lowercase().starts_with("file:") {
            return None;
        } else {
            vec![
                format!("{}/{}", self.base_dir, target),
                target.clone(),
            ]
        };
        for c in &candidates {
            if let Some(bytes) = read_entry_bytes(self.zip, c) {
                let ext = Path::new(&target)
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("bin");
                let tmp: PathBuf = self
                    .media_dir
                    .join(format!("andeng_img_{}.{}", uuid::Uuid::new_v4(), ext));
                if std::fs::write(&tmp, &bytes).is_ok() {
                    return Some(format!(
                        "localimg://{}",
                        js_encode_uri_component(&tmp.to_string_lossy())
                    ));
                }
            }
        }
        None
    }

    fn on_start(&mut self, e: &BytesStart) {
        let name = e.name().local_name();
        match name.as_ref() {
            b"p" => {
                self.para_text.clear();
                self.para_heading = None;
                self.para_is_list = false;
            }
            b"pStyle" => {
                if let Some(v) = attr_val(e, b"val") {
                    self.para_heading = parse_heading(&v);
                }
            }
            b"numPr" => self.para_is_list = true,
            b"tbl" => {
                self.rows.clear();
            }
            b"tr" => self.cur_row.clear(),
            b"tc" => {
                self.in_tc = true;
                self.cell_buf.clear();
            }
            b"t" => self.in_text = true,
            b"tab" => self.append_text("\t"),
            b"br" => self.append_text("\n"),
            b"blip" => {
                if let Some(embed) = attr_val(e, b"embed") {
                    if let Some(uri) = self.resolve_image(&embed) {
                        self.append_text(&format!("\n![图片]({})\n", uri));
                    }
                }
            }
            _ => {}
        }
    }

    fn on_end(&mut self, name: &[u8]) {
        match name {
            b"t" => self.in_text = false,
            b"p" => {
                if self.in_tc {
                    if !self.cell_buf.is_empty() {
                        self.cell_buf.push(' ');
                    }
                    self.cell_buf.push_str(self.para_text.trim());
                } else {
                    let text = self.para_text.trim();
                    if !text.is_empty() {
                        if let Some(lvl) = self.para_heading {
                            let hashes = "#".repeat(lvl.clamp(1, 6));
                            self.out.push_str(&format!("{} {}\n\n", hashes, text));
                        } else if self.para_is_list {
                            self.out.push_str(&format!("- {}\n\n", text));
                        } else {
                            self.out.push_str(&format!("{}\n\n", text));
                        }
                    }
                }
                self.para_text.clear();
            }
            b"tc" => {
                self.cur_row.push(self.cell_buf.trim().to_string());
                self.in_tc = false;
            }
            b"tr" => {
                self.rows.push(std::mem::take(&mut self.cur_row));
            }
            b"tbl" => {
                if !self.rows.is_empty() {
                    self.out.push_str(&render_table(&self.rows));
                    self.out.push('\n');
                }
                self.rows.clear();
            }
            // PPTX 中图片(<p:pic>)与形状(<p:sp>)并非都包在 <a:p> 段落内，
            // 其内嵌文本/图片需在元素结束时刷出，否则会丢失。
            b"sp" | b"pic" | b"graphicFrame" => {
                let text = self.para_text.trim();
                if !text.is_empty() {
                    self.out.push_str(&format!("{}\n\n", text));
                }
                self.para_text.clear();
            }
            _ => {}
        }
    }

    fn on_text(&mut self, s: &str) {
        if self.in_text {
            self.append_text(s);
        }
    }
}

/// 解析一段 OOXML 正文（docx 的 document.xml 或 pptx 的 slideN.xml）。
fn parse_ooxml_body(
    xml: &str,
    rels: &HashMap<String, String>,
    base_dir: &str,
    zip: &mut ZipArchive<File>,
    media_dir: &Path,
    out: &mut String,
) {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut st = BodyParser {
        out,
        rels,
        base_dir,
        zip,
        media_dir,
        in_text: false,
        para_text: String::new(),
        para_heading: None,
        para_is_list: false,
        in_tc: false,
        cell_buf: String::new(),
        rows: Vec::new(),
        cur_row: Vec::new(),
    };
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => st.on_start(&e),
            Ok(Event::End(e)) => {
                let n = e.name().local_name();
                st.on_end(n.as_ref());
            }
            Ok(Event::Text(t)) => {
                if let Ok(s) = t.xml_content() {
                    st.on_text(&s);
                }
            }
            Ok(Event::Empty(e)) => {
                let n = e.name().local_name().as_ref().to_vec();
                st.on_start(&e);
                st.on_end(&n);
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                eprintln!("[doc] XML 解析错误: {}", e);
                break;
            }
            _ => {}
        }
        buf.clear();
    }
}

// ----------------------------------------------------------------------------
// DOCX
// ----------------------------------------------------------------------------

fn parse_office_docx(path: &str, app_data: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|e| format!("打开文件失败: {}", e))?;
    let mut zip =
        ZipArchive::new(file).map_err(|e| format!("读取 docx 失败（可能不是有效的文档）: {}", e))?;
    let (rels, base) = read_rels(&mut zip, "word/_rels/document.xml.rels");
    let xml = read_entry_to_string(&mut zip, "word/document.xml")
        .ok_or_else(|| "缺少 word/document.xml".to_string())?;
    let media_dir = doc_media_dir(app_data);
    let _ = std::fs::create_dir_all(&media_dir);
    let mut out = String::new();
    parse_ooxml_body(&xml, &rels, &base, &mut zip, &media_dir, &mut out);
    Ok(out)
}

// ----------------------------------------------------------------------------
// PPTX
// ----------------------------------------------------------------------------

fn parse_office_pptx(path: &str, app_data: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|e| format!("打开文件失败: {}", e))?;
    let mut zip =
        ZipArchive::new(file)        .map_err(|e| format!("读取 pptx 失败（可能不是有效的文档）: {}", e))?;
    let media_dir = doc_media_dir(app_data);
    let _ = std::fs::create_dir_all(&media_dir);

    // 收集所有 slide 文件并按编号排序
    let mut slides: Vec<(usize, String)> = zip
        .file_names()
        .filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml"))
        .filter_map(|n| {
            let num: String = n
                .chars()
                .filter(|c| c.is_ascii_digit())
                .collect();
            num.parse::<usize>().ok().map(|i| (i, n.to_string()))
        })
        .collect();
    slides.sort_by_key(|(i, _)| *i);

    let mut out = String::new();
    for (n, slide_path) in slides {
        let rels_path = format!("ppt/slides/_rels/slide{}.xml.rels", n);
        let (rels, base) = read_rels(&mut zip, &rels_path);
        let xml = match read_entry_to_string(&mut zip, &slide_path) {
            Some(x) => x,
            None => continue,
        };
        out.push_str(&format!("## 幻灯片 {}\n\n", n));
        parse_ooxml_body(&xml, &rels, &base, &mut zip, &media_dir, &mut out);
    }
    Ok(out)
}

// ----------------------------------------------------------------------------
// XLSX
// ----------------------------------------------------------------------------

fn parse_office_xlsx(path: &str) -> Result<String, String> {
    let file = File::open(path).map_err(|e| format!("打开文件失败: {}", e))?;
    let mut zip =
        ZipArchive::new(file).map_err(|e| format!("读取 xlsx 失败（可能不是有效的文档）: {}", e))?;

    let shared = parse_shared_strings(&mut zip);
    let sheets = parse_workbook_sheets(&mut zip);
    let (wb_rels, wb_base) = read_rels(&mut zip, "xl/_rels/workbook.xml.rels");

    let mut out = String::new();
    for (name, rid) in sheets {
        let sheet_path = match wb_rels.get(&rid) {
            Some(p) => {
                if p.starts_with('/') {
                    p.trim_start_matches('/').to_string()
                } else {
                    format!("{}/{}", wb_base, p)
                }
            }
            None => continue,
        };
        let grid = parse_worksheet(&mut zip, &sheet_path, &shared);
        if grid.is_empty() || grid.iter().all(|r| r.iter().all(|c| c.trim().is_empty())) {
            continue;
        }
        out.push_str(&format!("## {}\n\n", name));
        out.push_str(&render_table(&grid));
        out.push('\n');
    }
    Ok(out)
}

fn parse_shared_strings(zip: &mut ZipArchive<File>) -> Vec<String> {
    let mut strings = Vec::new();
    if let Some(xml) = read_entry_to_string(zip, "xl/sharedStrings.xml") {
        let mut reader = Reader::from_str(&xml);
        let mut buf = Vec::new();
        let mut cur = String::new();
        let mut in_t = false;
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(e)) => {
                    let n = e.name().local_name();
                    if n.as_ref() == b"si" {
                        cur.clear();
                    } else if n.as_ref() == b"t" {
                        in_t = true;
                    }
                }
                Ok(Event::Text(t)) => {
                    if in_t {
                        if let Ok(s) = t.xml_content() {
                            cur.push_str(&s);
                        }
                    }
                }
                Ok(Event::End(e)) => {
                    let n = e.name().local_name();
                    if n.as_ref() == b"t" {
                        in_t = false;
                    } else if n.as_ref() == b"si" {
                        strings.push(cur.trim().to_string());
                    }
                }
                Ok(Event::Eof) => break,
                _ => {}
            }
            buf.clear();
        }
    }
    strings
}

fn parse_workbook_sheets(zip: &mut ZipArchive<File>) -> Vec<(String, String)> {
    let mut v = Vec::new();
    if let Some(xml) = read_entry_to_string(zip, "xl/workbook.xml") {
        let mut reader = Reader::from_str(&xml);
        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                    let n = e.name().local_name();
                    if n.as_ref() == b"sheet" {
                        let name = attr_val(&e, b"name").unwrap_or_default();
                        let rid = attr_val(&e, b"id").unwrap_or_default();
                        if !rid.is_empty() {
                            v.push((name, rid));
                        }
                    }
                }
                Ok(Event::Eof) => break,
                _ => {}
            }
            buf.clear();
        }
    }
    v
}

fn parse_worksheet(
    zip: &mut ZipArchive<File>,
    path: &str,
    shared: &[String],
) -> Vec<Vec<String>> {
    let mut grid: Vec<Vec<String>> = Vec::new();
    if let Some(xml) = read_entry_to_string(zip, path) {
        let mut reader = Reader::from_str(&xml);
        let mut buf = Vec::new();
        let mut cur_row: Vec<String> = Vec::new();
        let mut cur_text = String::new();
        let mut col_idx: usize = 0;
        let mut cell_type: u8 = 0; // 0 数字, 1 共享字符串, 2 内联字符串
        let mut in_text = false;
        let mut row_idx: usize = 0;

        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(e)) => {
                    let n = e.name().local_name();
                    match n.as_ref() {
                        b"row" => {
                            cur_row.clear();
                            if let Some(r) = attr_val(&e, b"r") {
                                row_idx = r.parse::<usize>().unwrap_or(grid.len() + 1);
                            }
                        }
                        b"c" => {
                            cur_text.clear();
                            cell_type = 0;
                            col_idx = 0;
                            if let Some(t) = attr_val(&e, b"t") {
                                if t == "s" {
                                    cell_type = 1;
                                } else if t == "str" || t == "inlineStr" {
                                    cell_type = 2;
                                }
                            }
                            if let Some(r) = attr_val(&e, b"r") {
                                col_idx = col_letter_to_index(&r);
                            }
                        }
                        b"v" => {
                            if cell_type != 2 {
                                in_text = true;
                            }
                        }
                        b"t" => {
                            if cell_type == 2 {
                                in_text = true;
                            }
                        }
                        _ => {}
                    }
                }
                Ok(Event::Text(t)) => {
                    if in_text {
                        if let Ok(s) = t.xml_content() {
                            cur_text.push_str(&s);
                        }
                    }
                }
                Ok(Event::End(e)) => {
                    let n = e.name().local_name();
                    match n.as_ref() {
                        b"v" | b"t" => in_text = false,
                        b"c" => {
                            let val = match cell_type {
                                1 => {
                                    let i = cur_text.trim().parse::<usize>().unwrap_or(0);
                                    shared.get(i).cloned().unwrap_or_default()
                                }
                                _ => cur_text.trim().to_string(),
                            };
                            if cur_row.len() <= col_idx {
                                cur_row.resize(col_idx + 1, String::new());
                            }
                            cur_row[col_idx] = val;
                        }
                        b"row" => {
                            if row_idx == 0 {
                                row_idx = grid.len() + 1;
                            }
                            if grid.len() < row_idx {
                                grid.resize(row_idx, Vec::new());
                            }
                            grid[row_idx - 1] = std::mem::take(&mut cur_row);
                        }
                        _ => {}
                    }
                }
                Ok(Event::Eof) => break,
                _ => {}
            }
            buf.clear();
        }
    }
    grid
}

fn col_letter_to_index(r: &str) -> usize {
    let letters: String = r.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    let mut idx = 0;
    for c in letters.chars() {
        idx = idx * 26 + (c.to_ascii_uppercase() as usize - b'A' as usize + 1);
    }
    idx.saturating_sub(1)
}

// ----------------------------------------------------------------------------
// PDF（原生解析：文字 + 图片）
// ----------------------------------------------------------------------------

/// 原生解析 PDF：提取文本，并抽取内嵌图片到 media 目录（以 localimg:// 引用，不进中转站列表）。
pub fn convert_pdf_to_markdown(path: &str, app_data: &Path) -> Result<String, String> {
    let media_dir = doc_media_dir(app_data);
    let _ = std::fs::create_dir_all(&media_dir);

    let mut out = String::new();
    match pdf_extract::extract_text(path) {
        Ok(text) if !text.trim().is_empty() => out.push_str(&text),
        Ok(_) => {}
        Err(e) => return Err(format!("PDF 文本提取失败: {}", e)),
    }

    let images = extract_pdf_images(path, &media_dir);
    if !images.is_empty() {
        out.push_str("\n\n");
        for uri in &images {
            out.push_str(&format!("![图片]({})\n", uri));
        }
    }
    if out.trim().is_empty() {
        return Err("PDF 解析结果为空（可能是扫描件或加密文档）".to_string());
    }
    Ok(out)
}

/// 用 lopdf 抽取 PDF 内嵌图片（XObject Image）：
/// - DCTDecode（JPEG）直接按原字节落盘；
/// - FlateDecode 经 lopdf 解码（自动处理 PNG 预测器）后用 image 库转 PNG；
/// 其余情况（JPX / 索引色等）跳过，保证健壮性。
fn extract_pdf_images(path: &str, media_dir: &Path) -> Vec<String> {
    let doc = match lopdf::Document::load(path) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for page_id in doc.page_iter() {
        let page = match doc.get_dictionary(page_id) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let resources = match page.get(b"Resources").ok().and_then(|r| resolve_dict(&doc, r)) {
            Some(r) => r,
            None => continue,
        };
        let xobjects = match resources.get(b"XObject").ok().and_then(|o| resolve_dict(&doc, o)) {
            Some(x) => x,
            None => continue,
        };
        for (_key, val) in xobjects.iter() {
            let stream = match as_stream(&doc, val) {
                Some(s) => s,
                None => continue,
            };
            let subtype: &[u8] = match stream
                .dict
                .get(b"Subtype")
                .ok()
                .and_then(|o| o.as_name().ok())
            {
                Some(s) => s,
                None => &[],
            };
            if subtype != b"Image" {
                continue;
            }
            if let Some(uri) = extract_one_image(stream, media_dir) {
                out.push(uri);
            }
        }
    }
    out
}

fn resolve_dict<'a>(doc: &'a lopdf::Document, obj: &'a Object) -> Option<&'a lopdf::Dictionary> {
    match obj {
        Object::Reference(id) => doc.get_dictionary(*id).ok(),
        Object::Dictionary(d) => Some(d),
        _ => None,
    }
}

fn as_stream<'a>(doc: &'a lopdf::Document, obj: &'a Object) -> Option<&'a lopdf::Stream> {
    match obj {
        Object::Reference(id) => doc.get_object(*id).ok().and_then(|o| o.as_stream().ok()),
        Object::Stream(s) => Some(s),
        _ => None,
    }
}

fn filter_is(stream: &lopdf::Stream, name: &[u8]) -> bool {
    match stream.dict.get(b"Filter") {
        Ok(Object::Name(n)) => n == name,
        Ok(Object::Array(arr)) => arr
            .iter()
            .any(|f| f.as_name().map(|n| n == name).unwrap_or(false)),
        _ => false,
    }
}

fn color_channels(cs: &Object) -> u8 {
    match cs {
        Object::Name(n) => match n.as_slice() {
            b"DeviceRGB" => 3,
            b"DeviceCMYK" => 4,
            b"DeviceGray" => 1,
            _ => 0,
        },
        Object::Array(arr) => {
            if let Some(Object::Name(first)) = arr.first() {
                if first.as_slice() == b"Indexed" && arr.len() >= 2 {
                    return color_channels(&arr[1]);
                }
            }
            if let Some(Object::Array(_)) = arr.first() {
                return color_channels(&arr[0]);
            }
            0
        }
        _ => 0,
    }
}

/// 将 FlateDecode 解码后的原始光栅像素包装为 PNG 字节。
fn build_png_from_raw(
    raw: &[u8],
    w: u32,
    h: u32,
    bpc: u32,
    dict: &lopdf::Dictionary,
) -> Option<Vec<u8>> {
    let channels = color_channels(dict.get(b"ColorSpace").ok()?);
    let img = match channels {
        3 if bpc == 8 => {
            let rgb = RgbImage::from_raw(w, h, raw.to_vec())?;
            DynamicImage::ImageRgb8(rgb)
        }
        1 if bpc == 8 => {
            let g = GrayImage::from_raw(w, h, raw.to_vec())?;
            DynamicImage::ImageLuma8(g)
        }
        1 if bpc == 1 => {
            // 每字节 8 个像素（MSB 优先）展开为 8-bit 灰度
            let mut buf = Vec::with_capacity((w * h) as usize);
            for byte in raw {
                for bit in (0..8).rev() {
                    buf.push(if (byte >> bit) & 1 == 1 { 255 } else { 0 });
                }
            }
            let g = GrayImage::from_raw(w, h, buf)?;
            DynamicImage::ImageLuma8(g)
        }
        _ => return None,
    };
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

fn extract_one_image(stream: &lopdf::Stream, media_dir: &Path) -> Option<String> {
    let width = stream
        .dict
        .get(b"Width")
        .and_then(Object::as_i64)
        .map(|v| v as u32)
        .unwrap_or(0);
    let height = stream
        .dict
        .get(b"Height")
        .and_then(Object::as_i64)
        .map(|v| v as u32)
        .unwrap_or(0);
    if width == 0 || height == 0 {
        return None;
    }
    let bpc = stream
        .dict
        .get(b"BitsPerComponent")
        .and_then(Object::as_i64)
        .map(|v| v as u32)
        .unwrap_or(8);
    let is_dct = filter_is(stream, b"DCTDecode");
    let bytes: Vec<u8> = if is_dct {
        stream.content.clone()
    } else {
        match stream.decompressed_content() {
            Ok(b) => b,
            Err(_) => return None,
        }
    };
    if bytes.is_empty() {
        return None;
    }
    let ext = if is_dct { "jpg" } else { "png" };
    let fname = format!("pdf_img_{}.{}", uuid::Uuid::new_v4(), ext);
    let tmp = media_dir.join(&fname);
    if std::fs::write(&tmp, &bytes).is_err() {
        return None;
    }
    let final_path = if is_dct {
        tmp.clone()
    } else {
        match build_png_from_raw(&bytes, width, height, bpc, &stream.dict) {
            Some(png_bytes) => {
                let p = media_dir.join(format!("pdf_img_{}.png", uuid::Uuid::new_v4()));
                if std::fs::write(&p, &png_bytes).is_ok() {
                    p
                } else {
                    tmp.clone()
                }
            }
            None => tmp.clone(),
        }
    };
    Some(format!(
        "localimg://{}",
        js_encode_uri_component(&final_path.to_string_lossy())
    ))
}

