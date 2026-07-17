//! wps 演示文件编辑器专用：幻灯片 JSON → Office Open XML（.pptx）。
//!
//! 设计取舍：
//! - 输入为自有幻灯片结构的 JSON（`{ slides: Slide[] }`，与前端 `PptSlide` 对齐），
//!   不依赖任何第三方 OOXML 库，仅用仓库已有的 `zip` + `quick-xml` + `serde_json` + `base64`。
//! - 覆盖：文本（字号/颜色/粗体/斜体/下划线/对齐/多行）、图片（仅内嵌 data: URL 的 png/jpeg，
//!   跨域 http(s) 图片无法在 Rust 端抓取，自动跳过）、基本形状（矩形/圆角矩形/椭圆/三角/右箭头/直线，填充+描边）。
//! - 母版/主题采用最小可用模板（theme/slideMaster/slideLayout），保证可被 PowerPoint/WPS 打开；
//!   母版占位符、切换动画等进阶能力后置。
//!
//! 几何单位：OOXML 用 EMU（914400 EMU = 1 英寸）。画布逻辑坐标 960×540（16:9），
//! 映射到标准 13.333in×7.5in 幻灯片：1 逻辑单位 = 12700 EMU。字号（逻辑 px）按 1px≈1pt 处理（1pt=12700 EMU）。

use std::io::{Cursor, Write};

use base64::Engine;
use quick_xml::escape::escape;
use serde_json::Value;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

const NS_A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";

// 幻灯片尺寸（EMU）
const SLIDE_W: i64 = 12192000; // 13.333in
const SLIDE_H: i64 = 6858000;  // 7.5in
const EMU: f64 = 12700.0;       // 1pt

// 逻辑坐标 → EMU
fn eu(v: f64) -> i64 {
    (v / 960.0 * SLIDE_W as f64).round() as i64
}
fn ev(v: f64) -> i64 {
    (v / 540.0 * SLIDE_H as f64).round() as i64
}
// 字号/线宽（逻辑 px）→ EMU，最小 0.75pt
fn pts(v: f64) -> i64 {
    let e = (v * EMU).round() as i64;
    e.max((0.75 * EMU) as i64)
}

fn xml_escape(s: &str) -> String {
    escape(s).into_owned()
}

// 颜色：去掉 '#'，缺省黑
fn hex(v: &str) -> String {
    let s = v.trim();
    if s.len() == 7 && s.starts_with('#') {
        s[1..].to_string()
    } else if s.len() == 6 {
        s.to_string()
    } else {
        "000000".to_string()
    }
}

// ===================== 固定部件模板 =====================

const THEME: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"><a:lumMod val="95000"/><a:satMod val="105000"/><a:tint val="73000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:lumDef val="81000"/><a:lumMod val="72000"/></a:schemeClr></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:round/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:round/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:round/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:lumDef val="95000"/><a:lumMod val="110000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:lumDef val="81000"/><a:lumMod val="72000"/></a:schemeClr></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>"#;

const SLIDE_MASTER: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
 <p:cSld>
  <p:bg><p:bgPr><p:noFill/></p:bgPr></p:bg>
  <p:spTree>
   <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
   <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
  </p:spTree>
 </p:cSld>
 <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
 <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
 <p:txStyles>
  <p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:titleStyle>
  <p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:bodyStyle>
  <p:otherStyle/>
 </p:txStyles>
</p:sldMaster>"#;

const SLIDE_MASTER_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>"#;

const SLIDE_LAYOUT: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
 <p:cSld name="Blank">
  <p:spTree>
   <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
   <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
  </p:spTree>
 </p:cSld>
 <p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>
</p:sldLayout>"#;

const SLIDE_LAYOUT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>"#;

const CORE: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>岸灯鸢花演示文件</dc:title>
  <dc:creator>andengyuanhua</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">2024-01-01T00:00:00Z</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">2024-01-01T00:00:00Z</dcterms:modified>
</cp:coreProperties>"#;

const APP: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>andengyuanhua</Application>
</Properties>"#;

// ===================== 数据提取辅助 =====================

fn num(v: &Value, key: &str) -> f64 {
    v.get(key).and_then(|x| x.as_f64()).unwrap_or(0.0)
}
fn str_of(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn parse_data_url(src: &str) -> Option<(String, Vec<u8>)> {
    // 1) data:image/(png|jpeg|jpg);base64,XXXX —— 历史/手动插入的内嵌图片
    if let Some(rest) = src.strip_prefix("data:") {
        let (mime, data) = rest.split_once(',')?;
        let ext = if mime.contains("png") {
            "png"
        } else if mime.contains("jpeg") || mime.contains("jpg") {
            "jpeg"
        } else {
            return None;
        };
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.trim())
            .ok()?;
        return Some((ext.to_string(), bytes));
    }
    // 2) 本地文件路径（导入时落盘到 app_data/pptx_media/ 的图片）——读出字节后内嵌回 pptx
    if !src.is_empty() {
        let bytes = std::fs::read(src).ok()?;
        let ext = guess_image_ext(&bytes);
        return ext.map(|e| (e.to_string(), bytes));
    }
    None
}

/// 根据文件内容魔数判断图片扩展名（png / jpeg），无法识别返回 None。
fn guess_image_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 8 && &bytes[..8] == b"\x89PNG\r\n\x1a\n" {
        Some("png")
    } else if bytes.len() >= 3 && &bytes[..3] == b"\xff\xd8\xff" {
        Some("jpeg")
    } else {
        None
    }
}

// ===================== 元素 → DrawingML =====================

fn text_shape(id: u32, x: i64, y: i64, w: i64, h: i64, el: &Value) -> String {
    let style = el.get("style").cloned().unwrap_or(Value::Null);
    let font_size = style.get("fontSize").and_then(|v| v.as_f64()).unwrap_or(24.0);
    let color = hex(&style
        .get("color")
        .and_then(|v| v.as_str())
        .unwrap_or("#1f2328")
        .to_string());
    let bold = style.get("bold").and_then(|v| v.as_bool()).unwrap_or(false);
    let italic = style.get("italic").and_then(|v| v.as_bool()).unwrap_or(false);
    let underline = style.get("underline").and_then(|v| v.as_bool()).unwrap_or(false);
    let align = style
        .get("align")
        .and_then(|v| v.as_str())
        .unwrap_or("left");
    let algn = match align {
        "center" => "ctr",
        "right" => "r",
        _ => "l",
    };

    let sz = pts(font_size);
    let mut rpr = format!(r#" lang="zh-CN" sz="{}""#, sz);
    if bold {
        rpr.push_str(r#" b="1""#);
    }
    if italic {
        rpr.push_str(r#" i="1""#);
    }
    if underline {
        rpr.push_str(r#" u="sng""#);
    }

    let text = str_of(el, "text");
    let paragraphs: Vec<&str> = if text.is_empty() {
        vec![""]
    } else {
        text.split('\n').collect()
    };
    let mut body = String::new();
    for para in paragraphs {
        body.push_str(&format!(
            r#"<a:p><a:pPr algn="{}"/><a:r><a:rPr{}><a:solidFill><a:srgbClr val="{}"/></a:solidFill></a:rPr><a:t>{}</a:t></a:r></a:p>"#,
            algn, rpr, color, xml_escape(para)
        ));
    }

    format!(
        r#"<p:sp><p:nvSpPr><p:cNvPr id="{}" name="TextBox {}"/><p:cNvSpPr><a:spLocks noTextEdit="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="{}" y="{}"/><a:ext cx="{}" cy="{}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"/><a:lstStyle/>{}</p:txBody></p:sp>"#,
        id, id, x, y, w, h, body
    )
}

fn shape_shape(id: u32, x: i64, y: i64, w: i64, h: i64, el: &Value) -> String {
    let shape = str_of(el, "shape");
    let fill = hex(&str_of(el, "fill"));
    let stroke = hex(&str_of(el, "stroke"));
    let sw = pts(num(el, "strokeWidth"));
    let off = format!(r#"<a:off x="{}" y="{}"/><a:ext cx="{}" cy="{}"/>"#, x, y, w, h);

    if shape == "line" {
        return format!(
            r#"<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="{}" name="Line {}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm>{}</a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="{}"><a:solidFill><a:srgbClr val="{}"/></a:solidFill></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:cxnSp>"#,
            id, id, off, sw, stroke
        );
    }

    let prst = match shape.as_str() {
        "ellipse" => "ellipse",
        "roundRect" => "roundRect",
        "triangle" => "triangle",
        "arrow" => "rightArrow",
        _ => "rect",
    };
    format!(
        r#"<p:sp><p:nvSpPr><p:cNvPr id="{}" name="Shape {}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm>{}</a:xfrm><a:prstGeom prst="{}"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="{}"/></a:solidFill><a:ln w="{}"><a:solidFill><a:srgbClr val="{}"/></a:solidFill></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>"#,
        id, id, off, prst, fill, sw, stroke
    )
}

// ===================== 组装 =====================

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

fn write_media(
    zw: &mut ZipWriter<Cursor<Vec<u8>>>,
    opts: SimpleFileOptions,
    name: &str,
    bytes: &[u8],
) -> Result<(), String> {
    zw.start_file(name, opts)
        .map_err(|e| format!("写入 {} 失败: {}", name, e))?;
    zw.write_all(bytes)
        .map_err(|e| format!("写入 {} 内容失败: {}", name, e))?;
    Ok(())
}

/// 将幻灯片 JSON 转换为 .pptx 的字节内容。
pub fn json_to_pptx(json: &str) -> Result<Vec<u8>, String> {
    let v: Value = serde_json::from_str(json).map_err(|e| format!("JSON 解析失败: {}", e))?;
    let slides = if let Some(arr) = v.get("slides").and_then(|s| s.as_array()) {
        arr
    } else if let Some(arr) = v.as_array() {
        arr
    } else {
        return Err("缺少 slides 数组".to_string());
    };

    let mut slide_xmls: Vec<String> = Vec::new();
    let mut slide_rels: Vec<String> = Vec::new();
    let mut media: Vec<(String, Vec<u8>)> = Vec::new(); // (part_name, bytes)
    let mut media_counter = 0u32;

    for s in slides {
        let bg = hex(&str_of(s, "background"));
        let elements = s.get("elements").and_then(|e| e.as_array()).cloned().unwrap_or_default();

        let mut sp_tree = String::new();
        let mut rels = String::from(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>"#,
        );

        let mut id_counter: u32 = 2; // 1 = 组
        for el in &elements {
            let etype = str_of(el, "type");
            let x = eu(num(el, "x"));
            let y = ev(num(el, "y"));
            let w = eu(num(el, "w")).max(1);
            let h = ev(num(el, "h")).max(1);

            if etype == "text" {
                sp_tree.push_str(&text_shape(id_counter, x, y, w, h, el));
                id_counter += 1;
            } else if etype == "shape" {
                sp_tree.push_str(&shape_shape(id_counter, x, y, w, h, el));
                id_counter += 1;
            } else if etype == "image" {
                let src = str_of(el, "src");
                if let Some((ext, bytes)) = parse_data_url(&src) {
                    media_counter += 1;
                    let part = format!("media/image{}.{}", media_counter, ext);
                    media.push((part.clone(), bytes));
                    let rid = format!("rId{}", media_counter + 1); // rId1 已给 slideLayout
                    rels.push_str(&format!(
                        "\n  <Relationship Id=\"{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"../media/image{}.{}\"/>",
                        rid, media_counter, ext
                    ));
                    sp_tree.push_str(&format!(
                        r#"<p:pic><p:nvPicPr><p:cNvPr id="{}" name="Picture {}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="{}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="{}" y="{}"/><a:ext cx="{}" cy="{}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>"#,
                        id_counter, id_counter, rid, x, y, w, h
                    ));
                    id_counter += 1;
                }
                // 跨域/不支持图片：跳过（保证文件合法，不渲染破损引用）
            }
        }
        rels.push_str("\n</Relationships>");

        let slide_xml = format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="{a}" xmlns:r="{r}" xmlns:p="{p}">
 <p:cSld>
  <p:bg><p:bgPr><a:solidFill><a:srgbClr val="{bg}"/></a:solidFill></p:bgPr></p:bg>
  <p:spTree>
   <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
   <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
   {tree}
  </p:spTree>
 </p:cSld>
 <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>"#,
            a = NS_A,
            r = NS_R,
            p = NS_P,
            bg = bg,
            tree = sp_tree
        );
        slide_xmls.push(slide_xml);
        slide_rels.push(rels);
    }

    // presentation.xml 与 rels
    let mut sld_id_lst = String::new();
    let mut pres_rels = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>"#,
    );
    let mut slide_overrides = String::new();
    for (i, _) in slide_xmls.iter().enumerate() {
        let n = i + 1;
        let rid = format!("rId{}", n + 1); // rId1 = slideMaster
        sld_id_lst.push_str(&format!(
            r#"  <p:sldId id="{}" r:id="{}"/>"#,
            256 + i as u32,
            rid
        ));
        pres_rels.push_str(&format!(
            "\n  <Relationship Id=\"{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide{}.xml\"/>",
            rid, n
        ));
        slide_overrides.push_str(&format!(
            r#"
  <Override PartName="/ppt/slides/slide{}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>"#,
            n
        ));
    }
    pres_rels.push_str("\n</Relationships>");

    let presentation = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="{a}" xmlns:r="{r}" xmlns:p="{p}" saveSubsetFonts="1">
 <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
 <p:sldIdLst>
{sld_id_lst}
 </p:sldIdLst>
 <p:sldSz cx="{w}" cy="{h}" type="screen16x9"/>
 <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>"#,
        a = NS_A,
        r = NS_R,
        p = NS_P,
        sld_id_lst = sld_id_lst,
        w = SLIDE_W,
        h = SLIDE_H,
    );

    let content_types = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>{slide_overrides}
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>"#,
        slide_overrides = slide_overrides
    );

    let root_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>"#;

    // ---- 写入 zip ----
    let mut zw = ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    write_part(&mut zw, opts, "[Content_Types].xml", &content_types)?;
    write_part(&mut zw, opts, "_rels/.rels", root_rels)?;
    write_part(&mut zw, opts, "docProps/core.xml", CORE)?;
    write_part(&mut zw, opts, "docProps/app.xml", APP)?;

    write_part(&mut zw, opts, "ppt/presentation.xml", &presentation)?;
    write_part(&mut zw, opts, "ppt/_rels/presentation.xml.rels", &pres_rels)?;

    write_part(&mut zw, opts, "ppt/slideMasters/slideMaster1.xml", SLIDE_MASTER)?;
    write_part(&mut zw, opts, "ppt/slideMasters/_rels/slideMaster1.xml.rels", SLIDE_MASTER_RELS)?;
    write_part(&mut zw, opts, "ppt/slideLayouts/slideLayout1.xml", SLIDE_LAYOUT)?;
    write_part(&mut zw, opts, "ppt/slideLayouts/_rels/slideLayout1.xml.rels", SLIDE_LAYOUT_RELS)?;
    write_part(&mut zw, opts, "ppt/theme/theme1.xml", THEME)?;

    for (i, xml) in slide_xmls.iter().enumerate() {
        let n = i + 1;
        write_part(&mut zw, opts, &format!("ppt/slides/slide{}.xml", n), xml)?;
        write_part(
            &mut zw,
            opts,
            &format!("ppt/slides/_rels/slide{}.xml.rels", n),
            &slide_rels[i],
        )?;
    }

    for (part, bytes) in &media {
        write_media(&mut zw, opts, &format!("ppt/{}", part), bytes)?;
    }

    let buf = zw.finish().map_err(|e| e.to_string())?.into_inner();
    Ok(buf)
}
