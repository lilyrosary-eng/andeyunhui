//! PDF 翻译：**提取文本 → 翻译 → 输出 docx**，并在装了 LibreOffice 时再转回 PDF。
//!
//! ## ⚠️ 这一条的定位必须说清楚：我们只做尝试，且**大概率破坏版面**
//! PDF 与 docx/pptx 不是一回事，实测（arXiv 1706.03762，15 页）：
//!
//! | 项 | 实测 | 后果 |
//! |---|---|---|
//! | 文本层 | 24 个文本块，位置/字号 100% 可拿 | 能定位 |
//! | 字体 | 11 个字体**全是子集**（`CYUPTR+CMBX10`…） | **写不进中文**（子集只含出现过的拉丁字形） |
//! | 溢出 | 按原字号重画，**62% 的块超出页面** | 必然重叠/截断 |
//! | 块粒度 | 一个 BT 块里 `draws=118`，跨整节正文 | **PDF 没有段落**，起点只对第一行有效 |
//!
//! 所以「原位覆盖、保留版面」在 PDF 上不成立 —— 不是实现水平问题。
//! 因此这里**不碰原 PDF 的页面结构**，而是：提取文字 → 重新排成 docx。
//! 想要真正的格式保留，正确路径是**先把 PDF 转成 PPT/docx 再翻**（Word/WPS/在线工具都能做）。
//!
//! ## 为什么要多一步 docx
//! docx 里的中文由 Word 自己渲染，**不需要我们嵌字体**；而直接在 PDF 里写字要么嵌字体
//! （Type0/CIDFontType2 + ttf-parser，约 250 行且宽度/基线极易错），要么用巨型库
//! （`printpdf` 0.8 已经把 azul HTML 布局引擎拉进来了，违背"避免庞大抽象"）。
//!
//! ## docx → pdf 是可选的第二步
//! 复用已有的 `commands::wps::find_libreoffice()`（项目里已用它做 PPTX→PNG）。
//! 探测不到就**明确告知并只给 docx**，不假装成功。

use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::AppHandle;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use super::doc_translate::{
    escape_xml, flatten, lang_suffix, push_notice, should_translate, translate_batch,
    translate_one, DocTranslateOutcome,
};
use super::translate_service::TranslateSettings;

/// PDF 里没有段落，只有「行」。把行按**句末标点**合并成句子/短段。
///
/// 为什么按句子而不是按行：行是排版产物（论文每行 ~80 字符，常在单词中间断开），
/// 按行翻会把一句话切成几段，译文质量明显更差；句号是语义边界。
///
/// 处理三种 PDF 常见断行：
/// - 英文连字符断词（`inter-` + `national`）→ 去掉连字符直接接
/// - 中文换行 → 不加空格
/// - 其余 → 补一个空格
pub(crate) fn pdf_lines_to_paragraphs(text: &str) -> Vec<String> {
    fn is_cjk(c: char) -> bool {
        matches!(c as u32,
            0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0x3040..=0x30FF | 0xAC00..=0xD7AF)
    }
    fn ends_sentence(s: &str) -> bool {
        s.chars()
            .rev()
            .find(|c| !c.is_whitespace())
            .map(|c| ".!?。！？".contains(c))
            .unwrap_or(false)
    }

    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            continue;
        }
        if !cur.is_empty() {
            if ends_sentence(&cur) {
                out.push(std::mem::take(&mut cur));
            } else {
                let prev = cur.chars().last();
                let next = line.chars().next();
                match (prev, next) {
                    (Some(a), Some(b)) if is_cjk(a) || is_cjk(b) => {}
                    (Some('-'), _) => {
                        cur.pop();
                    }
                    _ => cur.push(' '),
                }
            }
        }
        cur.push_str(line);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

// ============================================================================
// 最简 docx 生成（不依赖任何 docx 库，四个 part 就够 Word/WPS 打开）
// ============================================================================

const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>"#;

const ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#;

const DOC_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"#;

/// 默认样式：显式给**东亚字体**，否则某些 Word/WPS 版本会把中文回退成难看的字形。
/// `w:sz 21` = 10.5pt（五号）。
const STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体" w:cs="Calibri"/>
<w:sz w:val="21"/><w:szCs w:val="21"/>
</w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
</w:styles>"#;

/// 段落列表 → 最小 docx 字节。
///
/// 只写四个 part：`[Content_Types].xml` / `_rels/.rels` /
/// `word/document.xml` / `word/styles.xml`（+ `word/_rels/document.xml.rels`）。
/// 多余的东西一律不写 —— 越简单越不会被 Word 判成"内容有问题"。
pub(crate) fn build_minimal_docx(paras: &[String]) -> Result<Vec<u8>, String> {
    let mut body = String::with_capacity(paras.len() * 128);
    for p in paras {
        body.push_str(r#"<w:p><w:r><w:t xml:space="preserve">"#);
        body.push_str(&escape_xml(p));
        body.push_str("</w:t></w:r></w:p>");
    }
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>"#,
        body
    );

    let mut z = ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut put = |name: &str, data: &[u8]| -> Result<(), String> {
        z.start_file(name, opts)
            .map_err(|e| format!("[docx] 写入 {} 失败: {}", name, e))?;
        z.write_all(data)
            .map_err(|e| format!("[docx] 写 {} 内容失败: {}", name, e))
    };
    put("[Content_Types].xml", CONTENT_TYPES.as_bytes())?;
    put("_rels/.rels", ROOT_RELS.as_bytes())?;
    put("word/_rels/document.xml.rels", DOC_RELS.as_bytes())?;
    put("word/document.xml", document.as_bytes())?;
    put("word/styles.xml", STYLES.as_bytes())?;
    let cur = z.finish().map_err(|e| format!("[docx] 收尾失败: {}", e))?;
    Ok(cur.into_inner())
}

// ============================================================================
// 可选第二步：docx → pdf（复用已有的 LibreOffice 探测）
// ============================================================================

/// 用 LibreOffice headless 把 docx 转成 pdf。
///
/// 返回 `(pdf 路径, 原始输出)`；LibreOffice 的报错经常只出现在 stdout/stderr 里，
/// 所以把原始输出一并带出来，失败时**原样给用户看**，不糊成"转换失败"。
pub(crate) fn convert_docx_to_pdf(docx: &Path) -> Result<PathBuf, String> {
    let Some(bin) = crate::commands::wps::find_libreoffice() else {
        return Err("未检测到 LibreOffice".to_string());
    };
    let outdir = docx.parent().unwrap_or_else(|| Path::new("."));
    let output = Command::new(&bin)
        .args(["--headless", "--norestore", "--convert-to", "pdf", "--outdir"])
        .arg(outdir)
        .arg(docx)
        .output()
        .map_err(|e| format!("[转PDF] 调用 {} 失败: {}", bin.display(), e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let pdf = docx.with_extension("pdf");
    if pdf.exists() {
        eprintln!(
            "[pdf-translate] LibreOffice 转换成功: {} → {} ({})",
            docx.display(),
            pdf.display(),
            stdout
        );
        Ok(pdf)
    } else {
        Err(format!(
            "[转PDF] {} 未生成。stdout={} stderr={}",
            pdf.display(),
            if stdout.is_empty() { "(空)" } else { &stdout },
            if stderr.is_empty() { "(空)" } else { &stderr }
        ))
    }
}

// ============================================================================
// 命令
// ============================================================================

/// PDF 翻译：提取文本 → 翻译 → 输出 docx（→ 可选转回 PDF）。
///
/// ⚠️ **只做尝试**：不保留原版面，输出是重排过的新文档。原 PDF 不会被修改。
#[tauri::command]
pub async fn translate_pdf(
    app: AppHandle,
    path: String,
    target_lang: Option<String>,
    source_lang: Option<String>,
    settings: Option<TranslateSettings>,
    out_path: Option<String>,
    // 是否在装了 LibreOffice 时把 docx 再转成 PDF（用 // 而非 ///：参数上不允许 doc 注释）
    to_pdf: Option<bool>,
) -> Result<DocTranslateOutcome, String> {
    let src = PathBuf::from(&path);
    if !src.is_file() {
        return Err(format!("[输入] 文件不存在: {}", path));
    }
    let st = settings.unwrap_or_default();
    let src_l = source_lang.as_deref().filter(|s| !s.trim().is_empty());
    let tgt_l = target_lang.as_deref().filter(|s| !s.trim().is_empty());
    let mut notices: Vec<String> = Vec::new();

    // ① 提取文本（pdf-extract 会处理字体 ToUnicode，比直接读 content stream 的编码可靠）
    let src_c = src.clone();
    let text = tokio::task::spawn_blocking(move || -> Result<String, String> {
        pdf_extract::extract_text(&src_c)
            .map_err(|e| format!("[提取] PDF 文本提取失败: {}", e))
    })
    .await
    .map_err(|e| format!("[提取] 任务失败: {}", e))??;

    if text.trim().is_empty() {
        return Err(
            "[提取] 这个 PDF 里没有可提取的文字（大概率是扫描件或加密文档）。\
             扫描件请先用「OCR」工作区识别，或先把 PDF 转成 PPT/docx 再翻译。"
                .to_string(),
        );
    }

    // ② 切段 + 过滤
    let all = pdf_lines_to_paragraphs(&text);
    let total = all.len() as u32;
    let mut targets: Vec<(usize, String)> = Vec::new();
    let mut skipped = 0u32;
    for (i, p) in all.iter().enumerate() {
        if should_translate(p) {
            targets.push((i, p.clone()));
        } else {
            skipped += 1;
        }
    }
    push_notice(
        &mut notices,
        format!(
            "PDF 没有段落结构，已按句末标点切成 {} 段（原文 {} 行）；版面**不会保留**，输出是重排后的文档",
            total,
            text.lines().count()
        ),
    );

    // ③ 翻译（长段单独送，短段批量 —— 与 docx 同策略）
    let (long, short): (Vec<_>, Vec<_>) = targets
        .into_iter()
        .partition(|(_, t)| t.chars().count() > 450);
    let mut translated: Vec<(usize, String)> = Vec::new();
    let mut failed = 0u32;

    for (idx, t) in long {
        match translate_one(&app, &t, src_l, tgt_l, &st).await {
            Some(v) => translated.push((idx, flatten(v))),
            None => failed += 1,
        }
    }
    const BATCH: usize = 8;
    for chunk in short.chunks(BATCH) {
        let texts: Vec<String> = chunk.iter().map(|(_, t)| t.clone()).collect();
        let results = translate_batch(&app, &texts, src_l, tgt_l, &st, &mut notices).await;
        for ((idx, _), res) in chunk.iter().zip(results.into_iter()) {
            match res {
                Some(v) => translated.push((*idx, flatten(v))),
                None => failed += 1,
            }
        }
    }

    // ④ 组装：译文就位，失败段保留原文（不许出现空段落）
    let mut map: std::collections::HashMap<usize, String> = translated.into_iter().collect();
    let out_paras: Vec<String> = all
        .iter()
        .enumerate()
        .map(|(i, orig)| map.remove(&i).unwrap_or_else(|| orig.clone()))
        .collect();

    // ⑤ 落盘：docx 先写（这一步不依赖任何外部程序）
    let docx_path = match out_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => {
            let p = PathBuf::from(p);
            if p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("pdf")) == Some(true) {
                p.with_extension("docx")
            } else if p.extension().is_some() {
                p
            } else {
                p.with_extension("docx")
            }
        }
        None => {
            let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("document");
            src.with_file_name(format!("{}.{}.docx", stem, lang_suffix(tgt_l)))
        }
    };
    let bytes = build_minimal_docx(&out_paras)?;
    let docx_c = docx_path.clone();
    tokio::task::spawn_blocking(move || {
        std::fs::write(&docx_c, &bytes)
            .map_err(|e| format!("[写出] 保存 docx 失败: {}", e))
    })
    .await
    .map_err(|e| format!("[写出] 任务失败: {}", e))??;
    eprintln!("[pdf-translate] docx 已写入 {}", docx_path.display());

    // ⑥ 可选：docx → pdf
    let mut final_path = docx_path.clone();
    let format = "pdf".to_string();
    if to_pdf.unwrap_or(false) {
        let docx_for_pdf = docx_path.clone();
        match tokio::task::spawn_blocking(move || convert_docx_to_pdf(&docx_for_pdf))
            .await
            .map_err(|e| format!("[转PDF] 任务失败: {}", e))?
        {
            Ok(pdf) => {
                final_path = pdf;
                push_notice(
                    &mut notices,
                    format!(
                        "已用 LibreOffice 转成 PDF：{}（docx 也保留着，方便你继续调整排版）",
                        final_path.display()
                    ),
                );
            }
            Err(e) => push_notice(
                &mut notices,
                format!(
                    "没能转成 PDF：{}。已输出 docx，用 Word/WPS 打开后「另存为 PDF」即可",
                    e
                ),
            ),
        }
    } else {
        push_notice(
            &mut notices,
            "已输出 docx。需要 PDF 的话：用 Word/WPS 打开后另存为 PDF，或在设置里开启「输出 PDF」",
        );
    }

    if failed > 0 {
        push_notice(&mut notices, format!("有 {} 段翻译失败，已保留原文", failed));
    }
    push_notice(
        &mut notices,
        "⚠️ 我们只做尝试，且**大概率会破坏版面**。建议先把 PDF 转成 PPT（或 docx）再翻译，效果更好",
    );

    Ok(DocTranslateOutcome {
        out_path: final_path.to_string_lossy().to_string(),
        format,
        paragraphs: total,
        translated: (total - skipped - failed).min(total),
        skipped,
        failed,
        notices,
    })
}
