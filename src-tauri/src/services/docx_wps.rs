//! wps 文档编辑器专用：TipTap/ProseMirror 文档 JSON → Office Open XML（.docx）。
//!
//! 设计取舍：
//! - 输入用 TipTap 的 `editor.getJSON()` 结构化 JSON（已是带 type/attrs/marks 的树），
//!   比解析 HTML 字符串可靠得多，无需引入 HTML 解析器。
//! - 仅依赖仓库已有的 `zip` + `quick-xml` + `serde_json`，零新增依赖。
//! - 覆盖：标题 / 段落 / 有序·无序列表 / 引用 / 代码块 / 分割线 / 表格 / 文本样式
//!   （粗体·斜体·下划线·删除线·行内代码）/ 超链接。
//! - 已知限制：图片以 `[图片]` 占位（docx 图片需内嵌 media + relationship，留作后续增强）。

use std::io::{Cursor, Write};

use quick_xml::escape::escape;
use serde_json::Value;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

const EMPTY_NODES: &[Value] = &[];
const EMPTY_MARKS: &[Value] = &[];

// ===================== 文档部件模板 =====================

const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>"#;

const ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>"#;

const STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style>
  <w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>
</w:styles>"#;

const CORE: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>安得云荟文档</dc:title>
  <dc:creator>andeyunhui</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">2024-01-01T00:00:00Z</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">2024-01-01T00:00:00Z</dcterms:modified>
</cp:coreProperties>"#;

const APP: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>andeyunhui</Application>
</Properties>"#;

// ===================== 构建状态 =====================

#[derive(Default)]
struct DocxBuilder {
    body: String,
    /// (rId, url) 超链接关系，写入 document.xml.rels
    hyperlinks: Vec<(String, String)>,
    /// 超链接 rId 计数器（从 2 开始，rId1 预留给 styles）
    hl_counter: usize,
}

impl DocxBuilder {
    fn hyperlink(&mut self, url: &str, run: String) -> String {
        let rid = format!("rId{}", self.hl_counter);
        self.hl_counter += 1;
        self.hyperlinks.push((rid.clone(), url.to_string()));
        format!("<w:hyperlink r:id=\"{}\">{}</w:hyperlink>", rid, run)
    }
}

// ===================== 文本转义 =====================

fn xml_escape(s: &str) -> String {
    escape(s).into_owned()
}

fn attr_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('"', "&quot;")
}

// ===================== 行内（run） =====================

fn run_xml(text: &str, bold: bool, italic: bool, underline: bool, strike: bool, code: bool) -> String {
    let mut rpr = String::new();
    if bold {
        rpr.push_str("<w:b/><w:bCs/>");
    }
    if italic {
        rpr.push_str("<w:i/><w:iCs/>");
    }
    if underline {
        rpr.push_str("<w:u w:val=\"single\"/>");
    }
    if strike {
        rpr.push_str("<w:strike/>");
    }
    if code {
        rpr.push_str("<w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\"/><w:color w:val=\"B4361E\"/>");
    }
    let rpr = if rpr.is_empty() {
        String::new()
    } else {
        format!("<w:rPr>{}</w:rPr>", rpr)
    };
    let t = format!("<w:t xml:space=\"preserve\">{}</w:t>", xml_escape(text));
    format!("<w:r>{}{}</w:r>", rpr, t)
}

fn convert_inline(nodes: &[Value], b: &mut DocxBuilder) -> String {
    let mut out = String::new();
    for n in nodes {
        let ty = n.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if ty == "text" {
            let text = n.get("text").and_then(|x| x.as_str()).unwrap_or("");
            let marks = n
                .get("marks")
                .and_then(|x| x.as_array())
                .map(|v| v.as_slice())
                .unwrap_or(EMPTY_MARKS);
            let mut bold = false;
            let mut italic = false;
            let mut underline = false;
            let mut strike = false;
            let mut code = false;
            let mut href: Option<String> = None;
            for m in marks {
                match m.get("type").and_then(|x| x.as_str()) {
                    Some("bold") => bold = true,
                    Some("italic") => italic = true,
                    Some("underline") => underline = true,
                    Some("strike") => strike = true,
                    Some("code") => code = true,
                    Some("link") => {
                        href = m
                            .get("attrs")
                            .and_then(|a| a.get("href"))
                            .and_then(|x| x.as_str())
                            .map(|s| s.to_string())
                    }
                    _ => {}
                }
            }
            let run = run_xml(text, bold, italic, underline, strike, code);
            match href {
                Some(url) => out.push_str(&b.hyperlink(&url, run)),
                None => out.push_str(&run),
            }
        } else if ty == "hardBreak" {
            out.push_str("<w:r><w:br/></w:r>");
        }
    }
    out
}

// ===================== 段落 =====================

fn paragraph(pstyle: &str, runs: &str) -> String {
    if pstyle.is_empty() {
        format!("<w:p>{}</w:p>", runs)
    } else {
        format!(
            "<w:p><w:pPr><w:pStyle w:val=\"{}\"/></w:pPr>{}</w:p>",
            pstyle, runs
        )
    }
}

fn paragraph_indented(prefix: &str, runs: &str, hanging: bool) -> String {
    let ind = if hanging {
        "<w:pPr><w:ind w:left=\"720\" w:hanging=\"360\"/></w:pPr>"
    } else {
        "<w:pPr><w:ind w:left=\"720\"/></w:pPr>"
    };
    let pre = run_xml(prefix, false, false, false, false, false);
    format!("<w:p>{}{}{}</w:p>", ind, pre, runs)
}

fn code_paragraph(text: &str) -> String {
    let ppr = "<w:pPr><w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"F1EFE9\"/></w:pPr>";
    let run = format!(
        "<w:r><w:rPr><w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\"/></w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r>",
        xml_escape(text)
    );
    format!("<w:p>{}{}</w:p>", ppr, run)
}

// ===================== 块级节点 =====================

fn children(node: &Value) -> &[Value] {
    node.get("content")
        .and_then(|c| c.as_array())
        .map(|v| v.as_slice())
        .unwrap_or(EMPTY_NODES)
}

fn convert_block(node: &Value, b: &mut DocxBuilder) {
    let ty = node.get("type").and_then(|x| x.as_str()).unwrap_or("");
    match ty {
        "heading" => {
            let level = node
                .get("attrs")
                .and_then(|a| a.get("level"))
                .and_then(|x| x.as_u64())
                .unwrap_or(1)
                .clamp(1, 6) as u8;
            let pstyle = format!("Heading{}", level);
            let runs = convert_inline(children(node), b);
            b.body.push_str(&paragraph(&pstyle, &runs));
        }
        "paragraph" => {
            let runs = convert_inline(children(node), b);
            b.body.push_str(&paragraph("", &runs));
        }
        "bulletList" | "orderedList" => {
            let ordered = ty == "orderedList";
            let mut n = 1usize;
            for it in children(node) {
                for sub in children(it) {
                    let runs = convert_inline(children(sub), b);
                    let prefix = if ordered {
                        format!("{}.", n)
                    } else {
                        "•".to_string()
                    };
                    b.body.push_str(&paragraph_indented(&prefix, &runs, true));
                }
                n += 1;
            }
        }
        "blockquote" => {
            for p in children(node) {
                let runs = convert_inline(children(p), b);
                // 引用：左缩进 + 左侧竖线
                b.body.push_str(&format!(
                    "<w:p><w:pPr><w:ind w:left=\"720\"/><w:pBdr><w:left w:val=\"single\" w:sz=\"24\" w:space=\"8\" w:color=\"C9C4BA\"/></w:pBdr></w:pPr>{}</w:p>",
                    runs
                ));
            }
        }
        "codeBlock" => {
            let text = children(node)
                .iter()
                .map(|x| x.get("text").and_then(|t| t.as_str()).unwrap_or(""))
                .collect::<Vec<_>>()
                .join("");
            b.body.push_str(&code_paragraph(&text));
        }
        "horizontalRule" => {
            b.body.push_str(
                "<w:p><w:pPr><w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"1\" w:color=\"auto\"/></w:pBdr></w:pPr></w:p>",
            );
        }
        "image" => {
            b.body
                .push_str("<w:p><w:r><w:t xml:space=\"preserve\">[图片]</w:t></w:r></w:p>");
        }
        "table" => {
            let rows = children(node);
            let mut maxcols = 0usize;
            for r in rows {
                maxcols = maxcols.max(children(r).len());
            }
            if maxcols == 0 {
                return;
            }
            let mut tbl = String::from(
                "<w:tbl><w:tblPr><w:tblStyle w:val=\"TableGrid\"/><w:tblW w:w=\"0\" w:type=\"auto\"/>",
            );
            tbl.push_str("<w:tblBorders><w:top w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/><w:left w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/><w:bottom w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/><w:right w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/><w:insideH w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/><w:insideV w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/></w:tblBorders></w:tblPr><w:tblGrid>");
            for _ in 0..maxcols {
                tbl.push_str("<w:gridCol w:w=\"2000\"/>");
            }
            tbl.push_str("</w:tblGrid>");
            for r in rows {
                tbl.push_str("<w:tr>");
                for c in children(r) {
                    tbl.push_str("<w:tc><w:tcPr><w:tcW w:w=\"2000\" w:type=\"dxa\"/></w:tcPr>");
                    for cb in children(c) {
                        let runs = convert_inline(children(cb), b);
                        tbl.push_str(&paragraph("", &runs));
                    }
                    tbl.push_str("</w:tc>");
                }
                tbl.push_str("</w:tr>");
            }
            tbl.push_str("</w:tbl>");
            b.body.push_str(&tbl);
        }
        _ => {
            // 未知块：退化为普通段落
            let runs = convert_inline(children(node), b);
            if !runs.is_empty() {
                b.body.push_str(&paragraph("", &runs));
            }
        }
    }
}

// ===================== 组装 =====================

fn build_document_xml(b: &DocxBuilder) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>{body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/></w:sectPr></w:body>
</w:document>"#,
        body = b.body
    )
}

fn build_rels(b: &DocxBuilder) -> String {
    let mut s = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>"#,
    );
    for (rid, url) in &b.hyperlinks {
        s.push_str(&format!(
            "<Relationship Id=\"{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink\" Target=\"{}\" TargetMode=\"External\"/>",
            rid,
            attr_escape(url)
        ));
    }
    s.push_str("</Relationships>");
    s
}

fn write_part(
    zw: &mut ZipWriter<Cursor<Vec<u8>>>,
    opts: SimpleFileOptions,
    name: &str,
    content: &str,
) -> Result<(), String> {
    zw.start_file(name, opts)
        .map_err(|e| format!("写入 {} 失败: {}", name, e))?;
    zw.write_all(content.as_bytes())
        .map_err(|e| format!("写入 {} 内容失败: {}", name, e))?;
    Ok(())
}

/// 将 TipTap 文档 JSON 转换为 .docx 的字节内容。
pub fn json_to_docx(json: &str) -> Result<Vec<u8>, String> {
    let v: Value = serde_json::from_str(json).map_err(|e| format!("JSON 解析失败: {}", e))?;
    let mut b = DocxBuilder::default();
    for node in children(&v) {
        convert_block(node, &mut b);
    }
    let doc_xml = build_document_xml(&b);
    let rels_xml = build_rels(&b);

    let mut zw = ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    write_part(&mut zw, opts, "[Content_Types].xml", CONTENT_TYPES)?;
    write_part(&mut zw, opts, "_rels/.rels", ROOT_RELS)?;
    write_part(&mut zw, opts, "word/document.xml", &doc_xml)?;
    write_part(&mut zw, opts, "word/_rels/document.xml.rels", &rels_xml)?;
    write_part(&mut zw, opts, "word/styles.xml", STYLES)?;
    write_part(&mut zw, opts, "docProps/core.xml", CORE)?;
    write_part(&mut zw, opts, "docProps/app.xml", APP)?;
    let buf = zw.finish().map_err(|e| e.to_string())?.into_inner();
    Ok(buf)
}
