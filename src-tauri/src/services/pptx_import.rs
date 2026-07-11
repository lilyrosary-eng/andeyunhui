//! .pptx → 演示文件 JSON 逆解析（幻灯片 JSON 格式与 pptx_wps 导出对齐）。
//!
//! 覆盖：背景色、文本框（字号/颜色/粗斜体/对齐/多段落）、形状（prstGeom→shape 映射）、
//! 图片（内嵌 data: URL）。跳过注释、Notes、母版、动画等高级元素。

use std::io::{Cursor, Read};
use base64::Engine;
use serde_json::{json, Value, Map};
use zip::read::ZipArchive;

const SLIDE_W: f64 = 12192000.0; // 13.333in EMU
const SLIDE_H: f64 = 6858000.0;   // 7.5in EMU
const EMU: f64 = 12700.0;          // 1pt EMU

// EMU → 逻辑坐标（960×540 画布）
fn eu_to_logical(v: i64) -> f64 {
    (v as f64) * 960.0 / SLIDE_W
}
fn ev_to_logical(v: i64) -> f64 {
    (v as f64) * 540.0 / SLIDE_H
}

// EMU → pt（≈ 逻辑 px），最小 1pt
fn pts_from_emu(v: i64) -> f64 {
    ((v as f64) / EMU).max(1.0)
}

// 颜色格式 "#rrggbb" → "rrggbb"（去掉 #）
fn hex_val(s: &str) -> String {
    s.trim().strip_prefix('#').unwrap_or(s).to_string()
}

// 补齐 # 前缀
fn to_hex(v: &str) -> String {
    let h = hex_val(v);
    if h.len() == 6 { format!("#{}", h) } else { "#000000".into() }
}

// ========= 简单 XML 值提取 =========

/// 从 XML 字符串中取第一个标签 <tag attr="val">...</tag>，提取 attr 值
fn xml_attr(xml: &str, tag: &str, attr: &str) -> Option<String> {
    let open_pat = format!("<{} ", tag);
    let start = xml.find(&open_pat)? + open_pat.len();
    let end = xml[start..].find('>')?;
    let tag_content = &xml[start..start + end];
    let attr_pat = format!("{}=\"", attr);
    let a_start = tag_content.find(&attr_pat)? + attr_pat.len();
    let rest = &tag_content[a_start..];
    Some(rest[..rest.find('"')?].to_string())
}

/// 取 <a:srgbClr val="..."/> 的 val
fn srgb_val(xml: &str) -> Option<String> {
    xml_attr(xml, "a:srgbClr", "val")
}

/// 提取段落文本和样式：从 <a:p>...</a:p> 字符串中解析
fn parse_paragraph(p_str: &str) -> (String, Value) {
    let align = xml_attr(p_str, "a:pPr", "algn")
        .map(|a| match a.as_str() {
            "ctr" => "center",
            "r" => "right",
            _ => "left",
        })
        .unwrap_or("left")
        .to_string();

    let text: String = p_str.split("</a:t>")
        .filter_map(|s| {
            let i = s.rfind("<a:t>")?;
            Some(s[i + 5..].to_string())
        })
        .collect::<Vec<_>>()
        .join("");

    // 取第一个 rPr 的样式
    let rpr_str = {
        let s = p_str.find("<a:rPr").and_then(|i| {
            p_str[i..].find("</a:rPr>").map(|j| &p_str[i..i + j + 8])
        });
        s.unwrap_or("")
    };

    let font_size = xml_attr(rpr_str, "a:rPr", "sz")
        .and_then(|v| v.parse::<i64>().ok())
        .map(|v| pts_from_emu(v * 100))
        .unwrap_or(24.0);
    let color = srgb_val(rpr_str).map(|c| to_hex(&c)).unwrap_or_else(|| "#1f2328".into());
    let bold = rpr_str.contains("b=\"1\"");
    let italic = rpr_str.contains("i=\"1\"");
    let underline = rpr_str.contains("u=\"sng\"");

    let style = json!({
        "fontSize": font_size,
        "color": color,
        "bold": bold,
        "italic": italic,
        "underline": underline,
        "align": align,
    });
    (text, style)
}

/// 解析 shape spPr 中的视觉属性：fill, stroke, strokeWidth
fn parse_sp_pr(sp_pr: &str) -> (Option<String>, Option<String>, Option<f64>) {
    let fill = srgb_val(sp_pr).map(|c| to_hex(&c));
    let stroke = {
        let ln_start = sp_pr.find("<a:ln").unwrap_or(sp_pr.len());
        let ln_part = &sp_pr[ln_start..];
        srgb_val(ln_part).map(|c| to_hex(&c))
    };
    // 线宽 EMU → pt
    let stroke_w = xml_attr(sp_pr, "a:ln", "w")
        .and_then(|v| v.parse::<i64>().ok())
        .map(|v| pts_from_emu(v));
    (fill, stroke, stroke_w)
}

/// prstGeom prst → 前端 shape 类型
fn map_prst(prst: &str) -> &str {
    match prst {
        "ellipse" => "ellipse",
        "roundRect" => "roundRect",
        "triangle" => "triangle",
        "rightArrow" | "leftArrow" | "upArrow" | "downArrow" => "arrow",
        "line" => "line",
        _ => "rect",
    }
}

// ========= 关联关系 =========

#[derive(Default)]
struct SlideRels {
    images: Vec<(String, String)>, // (Id, media path e.g. "../media/image1.png")
}

fn parse_rels(xml: &str) -> SlideRels {
    let mut rels = SlideRels::default();
    for line in xml.lines() {
        if line.contains("Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\"") {
            let id = xml_attr(line, "Relationship", "Id").unwrap_or_default();
            let target = xml_attr(line, "Relationship", "Target").unwrap_or_default();
            if !id.is_empty() && !target.is_empty() {
                rels.images.push((id, target));
            }
        }
    }
    rels
}

// ========= 主解析 =========

fn parse_slide(xml: &str, rels: &SlideRels, archive: &mut ZipArchive<Cursor<&[u8]>>) -> Result<Value, String> {
    let mut map = Map::new();
    map.insert("id".into(), json!(uuid_id()));
    map.insert("background".into(), json!("#ffffff"));

    // 背景
    if let Some(bg_pr) = extract_tag(xml, "p:bgPr") {
        if let Some(c) = srgb_val(bg_pr) {
            map.insert("background".into(), json!(to_hex(&c)));
        }
    }

    let mut elements: Vec<Value> = Vec::new();

    // spTree 内容
    let sp_tree_start = xml.find("<p:spTree").unwrap_or(0);
    let sp_tree_end = xml.rfind("</p:spTree>").map(|i| i + 12).unwrap_or(xml.len());
    let sp_tree = &xml[sp_tree_start..sp_tree_end];

    // 按标签配对收集 sp 和 pic 元素
    let mut pieces: Vec<(usize, usize, &str)> = Vec::new(); // (start, end, kind: "sp"|"pic")
    let mut search = 0;
    while search < sp_tree.len() {
        let rest = &sp_tree[search..];
        if let Some(rel_start) = rest.find("<p:sp ") {
            let abs_start = search + rel_start;
            if let Some(rel_end) = sp_tree[abs_start..].find("</p:sp>") {
                let abs_end = abs_start + rel_end + 8;
                pieces.push((abs_start, abs_end, "sp"));
                search = abs_end;
                continue;
            }
        }
        if let Some(rel_start) = rest.find("<p:pic ") {
            let abs_start = search + rel_start;
            if let Some(rel_end) = sp_tree[abs_start..].find("</p:pic>") {
                let abs_end = abs_start + rel_end + 9;
                pieces.push((abs_start, abs_end, "pic"));
                search = abs_end;
                continue;
            }
        }
        search += 1;
    }

    for (start, end, kind) in &pieces {
        let raw = &sp_tree[*start..*end];
        if *kind == "sp" {
            if let Ok(el) = parse_sp(raw) {
                elements.push(el);
            }
        } else if *kind == "pic" {
            if let Ok(el) = parse_pic(raw, rels, archive) {
                elements.push(el);
            }
        }
    }

    // 从 1 开始 z
    for (i, el) in elements.iter_mut().enumerate() {
        el.as_object_mut().map(|o| { o.insert("z".into(), json!(i + 1)); });
    }

    map.insert("elements".into(), json!(elements));
    Ok(Value::Object(map))
}

fn parse_sp(sp_str: &str) -> Result<Value, String> {
    let mut el = Map::new();
    el.insert("type".into(), json!("shape"));

    // spPr
    let _sp_pr = extract_tag(sp_str, "a:xfrm").or_else(|| extract_tag(sp_str, "p:spPr")).unwrap_or("");
    let xfrm = extract_tag(sp_str, "a:xfrm").unwrap_or("");
    let x = xml_attr(xfrm, "a:off", "x").and_then(|v| v.parse::<i64>().ok()).map(|v| eu_to_logical(v).round() as f64).unwrap_or(0.0);
    let y = xml_attr(xfrm, "a:off", "y").and_then(|v| v.parse::<i64>().ok()).map(|v| ev_to_logical(v).round() as f64).unwrap_or(0.0);
    let w = xml_attr(xfrm, "a:ext", "cx").and_then(|v| v.parse::<i64>().ok()).map(|v| eu_to_logical(v).max(10.0)).unwrap_or(100.0);
    let h = xml_attr(xfrm, "a:ext", "cy").and_then(|v| v.parse::<i64>().ok()).map(|v| ev_to_logical(v).max(10.0)).unwrap_or(100.0);

    el.insert("x".into(), json!(x));
    el.insert("y".into(), json!(y));
    el.insert("w".into(), json!(w));
    el.insert("h".into(), json!(h));

    // prstGeom shape type
    let prst = extract_tag(sp_str, "a:prstGeom")
        .and_then(|g| xml_attr(g, "a:prstGeom", "prst"));
    let shape = prst.as_deref().map(map_prst).unwrap_or("rect");
    el.insert("shape".into(), json!(shape));

    // 视觉属性
    let full_sp_pr = extract_tag(sp_str, "p:spPr").unwrap_or("");
    let (fill, stroke, stroke_w) = parse_sp_pr(full_sp_pr);
    if shape == "line" {
        el.insert("fill".into(), json!("transparent"));
        el.insert("stroke".into(), json!(stroke.unwrap_or_else(|| "#000000".into())));
        el.insert("strokeWidth".into(), json!(stroke_w.unwrap_or(2.0)));
    } else {
        el.insert("fill".into(), json!(fill.unwrap_or_else(|| "#dbeafe".into())));
        el.insert("stroke".into(), json!(stroke.unwrap_or_else(|| "#3b82f6".into())));
        el.insert("strokeWidth".into(), json!(stroke_w.unwrap_or(2.0)));
    }

    // 文本
    let tx_body = extract_tag(sp_str, "p:txBody").unwrap_or("");
    if !tx_body.is_empty() {
        // 检查是否有文字（<a:t> 标签）
        let has_text = tx_body.contains("<a:t>");
        if has_text {
            el.insert("type".into(), json!("text"));
            let mut all_text = String::new();
            let mut style: Option<Value> = None;
            let p_strs: Vec<&str> = tx_body.split("</a:p>").filter(|s| s.contains("<a:p")).collect();
            for p_str in &p_strs {
                let (t, st) = parse_paragraph(p_str);
                if !t.is_empty() {
                    if !all_text.is_empty() { all_text.push('\n'); }
                    all_text.push_str(&t);
                }
                if style.is_none() { style = Some(st); }
            }
            el.insert("text".into(), json!(all_text));
            if let Some(st) = style {
                el.insert("style".into(), st);
            }
        }
    }

    Ok(Value::Object(el))
}

fn parse_pic(pic_str: &str, rels: &SlideRels, archive: &mut ZipArchive<Cursor<&[u8]>>) -> Result<Value, String> {
    let mut el = Map::new();
    el.insert("type".into(), json!("image"));

    let xfrm = extract_tag(pic_str, "a:xfrm").unwrap_or("");
    let x = xml_attr(xfrm, "a:off", "x").and_then(|v| v.parse::<i64>().ok()).map(|v| eu_to_logical(v).round() as f64).unwrap_or(0.0);
    let y = xml_attr(xfrm, "a:off", "y").and_then(|v| v.parse::<i64>().ok()).map(|v| ev_to_logical(v).round() as f64).unwrap_or(0.0);
    let w = xml_attr(xfrm, "a:ext", "cx").and_then(|v| v.parse::<i64>().ok()).map(|v| eu_to_logical(v).max(10.0)).unwrap_or(100.0);
    let h = xml_attr(xfrm, "a:ext", "cy").and_then(|v| v.parse::<i64>().ok()).map(|v| ev_to_logical(v).max(10.0)).unwrap_or(100.0);
    el.insert("x".into(), json!(x));
    el.insert("y".into(), json!(y));
    el.insert("w".into(), json!(w));
    el.insert("h".into(), json!(h));

    // 通过 r:embed → rels → media 提取图片
    if let Some(embed) = xml_attr(pic_str, "a:blip", "r:embed") {
        if let Some((_, target_path)) = rels.images.iter().find(|(id, _)| id == &embed) {
            // target_path 如 "../media/image1.png"
            let media_name = target_path.trim_start_matches("../");
            let entry_path = format!("ppt/{}", media_name);
            match archive.by_name(&entry_path) {
                Ok(mut file) => {
                    let mut buf = Vec::new();
                    if file.read_to_end(&mut buf).is_ok() {
                        let mime = if entry_path.ends_with(".png") { "image/png" }
                            else if entry_path.ends_with(".jpg") || entry_path.ends_with(".jpeg") { "image/jpeg" }
                            else { "image/png" };
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
                        el.insert("src".into(), json!(format!("data:{};base64,{}", mime, b64)));
                    }
                }
                Err(_) => {}
            }
        }
    }

    if !el.contains_key("src") {
        return Err("无内嵌图片数据".into());
    }

    Ok(Value::Object(el))
}

// ========= 辅助 =========

fn extract_tag<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let start_tag = format!("<{}", tag);
    let close_tag = format!("</{}>", tag);
    let start = xml.find(&start_tag)?;
    // 找闭合：可能自闭合 <tag .../> 或配对 <tag>...</tag>
    let self_close = xml[start..].chars().take_while(|c| *c != '>').any(|c| c == '/');
    if self_close {
        let end = xml[start..].find("/>").map(|i| start + i).unwrap_or(xml.len());
        return Some(&xml[start..end + 2]);
    }
    let end = xml[start..].find(&close_tag).map(|i| start + i + close_tag.len()).unwrap_or(xml.len());
    Some(&xml[start..end])
}

fn read_zip_entry(archive: &mut ZipArchive<Cursor<&[u8]>>, name: &str) -> Result<String, String> {
    let mut file = archive.by_name(name).map_err(|e| format!("zip 中缺少 {}: {}", name, e))?;
    let mut buf = String::new();
    file.read_to_string(&mut buf).map_err(|e| format!("读取 {} 失败: {}", name, e))?;
    Ok(buf)
}

/// presentation.xml → 幻灯片文件名列表 ["slide1", "slide2", ...]
fn parse_slide_order(xml: &str) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    let mut pos = 0;
    while let Some(start) = xml[pos..].find("<p:sldId ") {
        let abs_start = pos + start;
        let tag_end = xml[abs_start..].find("/>")
            .or_else(|| xml[abs_start..].find('>'))
            .map(|i| abs_start + i + 2).unwrap_or(xml.len());
        let tag = &xml[abs_start..tag_end.min(xml.len())];
        if let Some(id_str) = xml_attr(tag, "p:sldId", "id") {
            if let Ok(id) = id_str.parse::<u32>() {
                // sldId id 256+ 映射到 slide1, slide2...
                let n = if id >= 256 { (id - 256) as usize + 1 } else { 1 };
                if n > names.len() + 20 { break; } // 容错
                names.push(format!("slide{}", n));
            }
        }
        pos = abs_start + 1;
    }
    if names.is_empty() {
        return Err("未找到任何幻灯片".into());
    }
    Ok(names)
}

fn uuid_id() -> String {
    format!("d{}", uuid::Uuid::new_v4().to_string().replace('-', ""))
}

// ========= 公开入口 =========

pub fn pptx_to_json(bytes: &[u8]) -> Result<String, String> {
    let cursor = Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor)
        .map_err(|e| format!("无法打开 pptx 文件（可能非 zip 格式）: {}", e))?;

    let pres_xml = read_zip_entry(&mut archive, "ppt/presentation.xml")?;
    let sld_names = parse_slide_order(&pres_xml)?;

    let mut slides: Vec<Value> = Vec::new();
    for name in &sld_names {
        let slide_xml = read_zip_entry(&mut archive, &format!("ppt/slides/{}.xml", name))?;
        let rels = {
            let rels_path = format!("ppt/slides/_rels/{}.xml.rels", name);
            read_zip_entry(&mut archive, &rels_path)
                .map(|r| parse_rels(&r))
                .unwrap_or_default()
        };
        let slide = parse_slide(&slide_xml, &rels, &mut archive)?;
        slides.push(slide);
    }

    let result = json!({ "slides": slides, "sections": [] });
    Ok(result.to_string())
}
