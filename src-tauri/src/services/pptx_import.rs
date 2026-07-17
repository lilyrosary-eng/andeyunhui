//! .pptx → 演示文件 JSON 逆解析（幻灯片 JSON 格式与 pptx_wps 导出对齐）。
//!
//! 覆盖：背景色、文本框（字号/颜色/粗斜体/对齐/多段落）、形状（prstGeom→shape 映射）、
//! 图片（内嵌 data: URL）。跳过注释、Notes、母版、动画等高级元素。

use std::io::{Cursor, Read};
use std::collections::HashMap;
use serde_json::{json, Value, Map};
use zip::read::ZipArchive;

// 逻辑画布尺寸（与前端 PptEditor LOGICAL_W/H = 960×540 对齐）
const LOGICAL_W: f64 = 960.0;
const LOGICAL_H: f64 = 540.0;
const EMU: f64 = 12700.0;          // 1pt EMU

// 幻灯片 → 画布变换：统一缩放（保持比例，letterbox 居中）。
// **关键修复（导入内容挤在左上/错位）**：旧实现按轴分别把 EMU 硬映射到 16:9 画布
// （x/12192000*960、y/6858000*540），非 16:9 幻灯片（4:3、16:10、自定义）会被
// 横向压缩 / 纵向拉伸、整体偏移，表现为「挤在画布左上、重叠」。现改为：读取
// presentation.xml 的真实 `<p:sldSz cx cy>` 作为幻灯片实际尺寸，计算统一缩放比 =
// min(画布宽/幻灯片宽, 画布高/幻灯片高)，再居中 letterbox。任意比例都能等比铺满
// 画布、不再错位、不被拉伸。
struct CanvasXform {
    scale: f64,
}
fn make_xform(slide_w: i64, slide_h: i64) -> CanvasXform {
    let sw = slide_w as f64;
    let sh = slide_h as f64;
    let scale = (LOGICAL_W / sw).min(LOGICAL_H / sh);
    CanvasXform { scale }
}
// EMU 偏移 / 尺寸 → 逻辑坐标（仅等比缩放，不含 letterbox 偏移）。
// **关键修复（表格塌缩在左上角 / 尺寸仅 8px）**：旧实现 `lx = off*scale + off_x`，
// `off_x/off_y` 是 make_xform 为 letterbox 居中加的偏移（16:9 时恒为 0，但逻辑上错位）。
// 表格单元格坐标是 `frame_x + 比例*frame_w`（已是幻灯片绝对 EMU），再经此函数缩放时，
// 若 frame_x/frame_w 来自 PowerPoint 占位 xfrm(0,0,8,8)，乘 scale(≈7.9e-5) 后塌到 0、
// 尺寸只剩裸 EMU 8 → 整张表挤在画布左上角尺寸 8px。改为纯比例缩放后，绝对 EMU 直接等比
// 映射到 960×540 逻辑坐标，表格、形状、图片三者的坐标体系一致，不再塌缩。
// （注：off_x/off_y 对 16:9 幻灯片恒为 0，去掉它不影响形状/图片既有正确结果。）
fn lx(off: i64, xf: &CanvasXform) -> f64 { off as f64 * xf.scale }
fn ly(off: i64, xf: &CanvasXform) -> f64 { off as f64 * xf.scale }
fn lw(ext: i64, xf: &CanvasXform) -> f64 { (ext as f64 * xf.scale).max(8.0) }
fn lh(ext: i64, xf: &CanvasXform) -> f64 { (ext as f64 * xf.scale).max(8.0) }

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

// 颜色片段中解析第一个可用颜色：srgbClr → hex；schemeClr → 主题色表（如 tx1/accent1）；
// prstClr → 预置名。三者都解析不出返回 None（视为透明 / 无描边）。
fn color_in(s: &str, theme: &HashMap<String, String>) -> Option<String> {
    if let Some(v) = srgb_val(s) {
        return Some(to_hex(&v));
    }
    if let Some(at) = s.find("<a:schemeClr") {
        let rest = &s[at..];
        if let Some(val) = xml_attr(rest, "a:schemeClr", "val") {
            if let Some(c) = theme.get(&val) {
                return Some(c.clone());
            }
        }
    }
    if let Some(at) = s.find("<a:prstClr") {
        let rest = &s[at..];
        if let Some(val) = xml_attr(rest, "a:prstClr", "val") {
            return resolve_prst(&val);
        }
    }
    None
}

// 从填充片段提取颜色，支持 solidFill / gradFill（取首个色标）/ pattFill（取前景色）：
// 无 `<a:noFill>` 声明 → None（透明）；否则扫描首个可用颜色（srgbClr / schemeClr / prstClr）。
// **关键修复（渐变/图案填充被丢成透明）**：旧实现只取 `<a:solidFill>`，而学科类 pptx 的
// 土壤剖面、磁感线等大量使用 `<a:gradFill>` / `<a:pattFill>`，解析不到 → 填充变透明（"白底"）。
// 现对 gradFill 取首个 `<a:gs>` 色标、对 pattFill 取 `<a:fgClr>`，近似还原填充色。
fn extract_solid_color(fragment: &str, _tag: &str, theme: &HashMap<String, String>) -> Option<String> {
    if fragment.contains("<a:noFill") {
        return None;
    }
    color_in(fragment, theme)
}

// 形状填充解析：优先取显式 `<a:solidFill>`（纯色，行为与旧版一致，绝不退化）；
// 否则 `<a:gradFill>` 取首个 `<a:gs>` 色标；否则 `<a:pattFill>` 取 `<a:fgClr>`。
// `<a:noFill>` → 透明。这样纯色填充完全保留，渐变/图案填充得到近似还原。
// 对基础颜色（如 "#DCDCDC"）施加 <a:lumMod val="95000"/> / <a:lumOff val="0"/>，
// 返回修改后的 hex 颜色。PowerPoint 学科课件大量用 lumMod 渐变（同色基底、亮度递减）。
fn apply_lum(gs: &str, base: &str) -> String {
    let h = hex_val(base);
    if h.len() != 6 { return base.to_string(); }
    let r = u8::from_str_radix(&h[0..2], 16).unwrap_or(0) as f64;
    let g = u8::from_str_radix(&h[2..4], 16).unwrap_or(0) as f64;
    let b = u8::from_str_radix(&h[4..6], 16).unwrap_or(0) as f64;
    let modv = xml_attr(gs, "a:lumMod", "val")
        .and_then(|v| v.parse::<i64>().ok()).unwrap_or(100000) as f64 / 100000.0;
    let offv = xml_attr(gs, "a:lumOff", "val")
        .and_then(|v| v.parse::<i64>().ok()).unwrap_or(0) as f64 / 100000.0 * 255.0;
    let clamp = |v: f64| (v.round() as u8).clamp(0, 255);
    format!("#{:02X}{:02X}{:02X}",
        clamp((r * modv + offv).min(255.0)),
        clamp((g * modv + offv).min(255.0)),
        clamp((b * modv + offv).min(255.0)))
}

fn resolve_shape_fill(sp_pr: &str, theme: &HashMap<String, String>) -> Option<String> {
    if let Some(sf) = extract_tag(sp_pr, "a:solidFill") {
        if sf.contains("<a:noFill") {
            return None;
        }
        if let Some(c) = color_in(&sf, theme) {
            return Some(c);
        }
    }
    if let Some(gf) = extract_tag(sp_pr, "a:gradFill") {
        // 首个色标：<a:gs> 内含 solidFill/schemeClr
        let first_gs = gf.find("<a:gs");
        if let Some(at) = first_gs {
            let rest = &gf[at..];
            let end = rest.find("</a:gs>").unwrap_or(rest.len());
            if let Some(c) = color_in(&rest[..end], theme) {
                return Some(c);
            }
        }
        // 兜底：任意颜色
        if let Some(c) = color_in(&gf, theme) {
            return Some(c);
        }
    }
    if let Some(pf) = extract_tag(sp_pr, "a:pattFill") {
        if let Some(c) = color_in(&pf, theme) {
            return Some(c);
        }
    }
    None
}

// 解析 `<a:gradFill>` 为前端可直接渲染的渐变 JSON（类型、角度、色标列表）。
// `<a:lin ang="N">` → 线性；`<a:path path="circle">` → 径向。角度 OOXML 60000 分度
// → CSS degrees（270 - ang/60000 mod 360）。色标 pos 归一化到 0..1，颜色经主题解析。
// 返回 None 表示该形状没有渐变填充。
fn resolve_gradient_fill(sp_pr: &str, theme: &HashMap<String, String>) -> Option<Value> {
    let gf = extract_tag(sp_pr, "a:gradFill")?;
    if gf.contains("<a:noFill") {
        return None;
    }
    // 类型：线性 / 径向
    let kind: &str;
    let css_angle: f64;
    if let Some(lin) = extract_tag(&gf, "a:lin") {
        kind = "linear";
        let raw = xml_attr(&lin, "a:lin", "ang")
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);
        css_angle = ((270.0 - (raw as f64) / 60000.0) % 360.0 + 360.0) % 360.0;
    } else {
        kind = "radial";
        css_angle = 0.0;
    }
    // 色标列表
    let mut stops: Vec<Value> = Vec::new();
    let mut search = 0;
    while let Some(at) = gf[search..].find("<a:gs") {
        let abs = search + at;
        let rest = &gf[abs..];
        let end = rest.find("</a:gs>").unwrap_or(rest.len());
        let gs = &rest[..end];
        search = abs + end + "</a:gs>".len();
        // pos: 0..100000 → 0..1
        let pos = xml_attr(gs, "a:gs", "pos")
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0) as f64 / 100000.0;
        if let Some(c) = color_in(gs, theme) {
            // <a:lumMod> / <a:lumOff> 修改颜色亮度（学科 pptx 大量使用，如白→灰的亮度渐降）
            let lum = apply_lum(gs, &c);
            stops.push(json!({"pos": pos, "color": lum}));
        }
    }
    if stops.is_empty() {
        return None;
    }
    Some(json!({"type": kind, "angle": css_angle, "stops": stops}))
}

// 预置颜色名 → hex（OOXML 常见 prstClr；PowerPoint 形状极少用，但母版 / 强调偶有）。
fn resolve_prst(name: &str) -> Option<String> {
    let m = match name.to_ascii_lowercase().as_str() {
        "black" => "#000000",
        "white" => "#ffffff",
        "red" => "#ff0000",
        "green" => "#008000",
        "blue" => "#0000ff",
        "yellow" => "#ffff00",
        "cyan" | "aqua" => "#00ffff",
        "magenta" => "#ff00ff",
        "gray" | "grey" => "#808080",
        "darkgray" | "darkgrey" => "#a9a9a9",
        "lightgray" | "lightgrey" => "#d3d3d3",
        "orange" => "#ffa500",
        "purple" => "#800080",
        "brown" => "#a52a2a",
        "navy" => "#000080",
        "teal" => "#008080",
        "olive" => "#808000",
        "lime" => "#00ff00",
        "maroon" => "#800000",
        "fuchsia" => "#ff00ff",
        "silver" => "#c0c0c0",
        _ => return None,
    };
    Some(m.into())
}

// `<a:sysClr ... lastClr="RRGGBB"/>` 的 lastClr（系统色兜底值）。
fn sysclr_last(node: &str) -> Option<String> {
    xml_attr(node, "a:sysClr", "lastClr").map(|c| to_hex(&c))
}

// 读取 ppt/theme/themeN.xml 的 `<a:clrScheme>`，建立「主题色名 → hex」映射，供 schemeClr 解析。
// 同时补 tx1/bg1/tx2/bg2 别名（分别指向 dk1/lt1/dk2/lt2），因为 schemeClr 常写 tx1/bg1。
fn build_theme_colors(archive: &mut ZipArchive<Cursor<&[u8]>>) -> HashMap<String, String> {
    let mut m: HashMap<String, String> = HashMap::new();
    let mut theme_path: Option<String> = None;
    for i in 0..archive.len() {
        if let Ok(f) = archive.by_index(i) {
            let n = f.name().to_string();
            if n.starts_with("ppt/theme/theme") && n.ends_with(".xml") {
                theme_path = Some(n);
                break;
            }
        }
    }
    if let Some(p) = theme_path {
        if let Ok(s) = read_zip_entry(archive, &p) {
            for name in [
                "dk1", "lt1", "dk2", "lt2",
                "accent1", "accent2", "accent3", "accent4", "accent5", "accent6",
                "hlink", "folHlink",
            ] {
                let open = format!("<a:{}", name);
                if let Some(at) = s.find(&open) {
                    let close = format!("</a:{}>", name);
                    if let Some(ce) = s[at..].find(&close) {
                        let node = &s[at..at + ce + close.len()];
                        if let Some(v) = srgb_val(node) {
                            m.insert(name.into(), to_hex(&v));
                        } else if let Some(v) = sysclr_last(node) {
                            m.insert(name.into(), v);
                        }
                    }
                }
            }
        }
    }
    if let (Some(dk), Some(lt)) = (m.get("dk1").cloned(), m.get("lt1").cloned()) {
        m.entry("tx1".into()).or_insert(dk);
        m.entry("bg1".into()).or_insert(lt);
    }
    if let (Some(dk), Some(lt)) = (m.get("dk2").cloned(), m.get("lt2").cloned()) {
        m.entry("tx2".into()).or_insert(dk);
        m.entry("bg2".into()).or_insert(lt);
    }
    m
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
/// **关键修复（文字颜色失真）**：旧实现只取 `<a:srgbClr>`，主题色文字（tx1/accent 等 schemeClr）
/// 被兜底成深灰，与原稿不一致。现经 `color_in` 解析主题色。
fn parse_paragraph(p_str: &str, theme: &HashMap<String, String>) -> (String, Value) {
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

    // **关键修复（字号错误）**：`<a:rPr sz>` 单位为「百分之一磅」（如 1800 = 18pt），
    // 旧实现当 EMU 处理（`pts_from_emu(v*100)` → v/127 ≈ 0.79×）导致字号偏小错位。
    // 正确换算：sz / 100 = pt。
    let font_size = xml_attr(rpr_str, "a:rPr", "sz")
        .and_then(|v| v.parse::<i64>().ok())
        .map(|v| (v as f64 / 100.0).max(1.0))
        .unwrap_or(24.0);
    let color = color_in(rpr_str, theme).unwrap_or_else(|| "#1f2328".into());
    let bold = rpr_str.contains("b=\"1\"");
    let italic = rpr_str.contains("i=\"1\"");
    let underline = rpr_str.contains("u=\"sng\"");

    // 行距与段落间距（<a:lnSpc> / <a:spcBef> / <a:spcAft>）
    let ppr = extract_tag(p_str, "a:pPr").unwrap_or("");
    let line_height: Option<f64> = if let Some(ln) = extract_tag(&ppr, "a:lnSpc") {
        if let Some(pct) = xml_attr(&ln, "a:spcPct", "val")
            .and_then(|v| v.parse::<i64>().ok()) {
            Some(pct as f64 / 100000.0)
        } else if let Some(pts) = xml_attr(&ln, "a:spcPts", "val")
            .and_then(|v| v.parse::<i64>().ok()) {
            Some(pts as f64 / 100.0 / font_size) // convert to ratio
        } else { None }
    } else { None };
    let space_before: Option<f64> = extract_tag(&ppr, "a:spcBef")
        .and_then(|s| xml_attr(&s, "a:spcPts", "val"))
        .and_then(|v| v.parse::<i64>().ok())
        .map(|v| v as f64 / 100.0);
    let space_after: Option<f64> = extract_tag(&ppr, "a:spcAft")
        .and_then(|s| xml_attr(&s, "a:spcPts", "val"))
        .and_then(|v| v.parse::<i64>().ok())
        .map(|v| v as f64 / 100.0);

    let mut style = json!({
        "fontSize": font_size,
        "color": color,
        "bold": bold,
        "italic": italic,
        "underline": underline,
        "align": align,
    });
    if let Some(lh) = line_height {
        style["lineHeight"] = json!(lh);
    }
    if let Some(sb) = space_before {
        style["marginTop"] = json!(sb);
    }
    if let Some(sa) = space_after {
        style["marginBottom"] = json!(sa);
    }
    (text, style)
}

/// 解析 shape spPr 中的视觉属性：fill, stroke, strokeWidth
/// **关键修复（白底蓝框 / 主题色丢失）**：旧实现只取 `<a:srgbClr>`，而 PowerPoint 绝大多数
/// 形状 / 线条的颜色是 `<a:schemeClr>`（主题色，如 tx1/accent1），导致主题填充被丢成透明（"白底"）、
/// 主题描边 / 无描边被兜底成蓝色（"蓝框"）。现：
///  - 用 `color_in` 同时解析 srgbClr / schemeClr（经主题色表映射）/ prstClr；
///  - 填充优先取 `<a:solidFill>` 内颜色；`<a:noFill>` 视为透明；
///  - 描边优先取 `<a:ln>` 内颜色；`<a:ln>` 含 `<a:noFill>` 或根本无 `<a:ln>` 视为无描边（不再默认蓝色）。
fn parse_sp_pr(sp_pr: &str, theme: &HashMap<String, String>) -> (Option<String>, Option<String>, Option<f64>) {
    let fill = resolve_shape_fill(sp_pr, theme);
    let stroke = {
        let ln = extract_tag(sp_pr, "a:ln").unwrap_or("");
        if ln.contains("<a:noFill") {
            None
        } else {
            color_in(ln, theme)
        }
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
        // 连接线（流程图 / 示意图常见，旧实现未解析 → 丢失）
        "straightConnector1" | "bentConnector2" | "bentConnector3"
        | "curvedConnector2" | "curvedConnector3" => "line",
        _ => "rect",
    }
}

// ========= 关联关系 =========

#[derive(Default)]
struct SlideRels {
    images: Vec<(String, String)>, // (Id, media path e.g. "../media/image1.png")
    layout: Option<String>,        // 版式路径 e.g. "../slideLayouts/slideLayout1.xml"
}

fn parse_rels(xml: &str) -> SlideRels {
    let mut rels = SlideRels::default();
    // **关键修复（导入图片全部丢失 / 图片=0）**：旧实现按 `xml.lines()` 遍历，
    // 但 .rels 文件通常是一整行包含多个 `<Relationship .../>`，`lines()` 只得到「一行」，
    // 导致只解析到第一个 Relationship（往往是 slideLayout），所有图片关系（rId→media）
    // 被漏掉 → parse_pic 按 r:embed 找不到映射 → src 未设置 → 整张图片被丢弃。
    // 现改为逐个切出 `<Relationship .../>` 元素再解析，每个图片关系都纳入。
    for rel in split_rels(xml) {
        let ty = xml_attr(rel, "Relationship", "Type").unwrap_or_default();
        if ty.contains("/image") {
            let id = xml_attr(rel, "Relationship", "Id").unwrap_or_default();
            let target = xml_attr(rel, "Relationship", "Target").unwrap_or_default();
            if !id.is_empty() && !target.is_empty() {
                rels.images.push((id, target));
            }
        } else if ty.contains("/slideLayout") {
            let target = xml_attr(rel, "Relationship", "Target").unwrap_or_default();
            if !target.is_empty() {
                rels.layout = Some(target);
            }
        }
    }
    rels
}

// 切出每一个 `<Relationship .../>`（兼容单行多元素 / 多行写法）。
// 注意排除 `<Relationships>` 容器标签本身（其前缀也是 "<Relationship"）。
fn split_rels(xml: &str) -> Vec<&str> {
    let mut v = Vec::new();
    let pat = "<Relationship";
    let mut from = 0;
    while let Some(at) = xml[from..].find(pat) {
        let abs = from + at;
        let after_idx = abs + pat.len();
        let after = xml[after_idx..].chars().next();
        if after != Some(' ') && after != Some('>') {
            // 是 "<Relationships" 容器，跳过后继续
            from = after_idx;
            continue;
        }
        if let Some(rel) = xml[abs..].find("/>") {
            let end = abs + rel + 2;
            v.push(&xml[abs..end]);
            from = end;
        } else {
            break;
        }
    }
    v
}

// ========= 阴影效果（<a:outerShdw> / <a:innerShdw>）=========
// PPTX 中绝大多数形状都带阴影；缺失则形状扁平无层次感。转换为 CSS box-shadow 字符串。

/// 从 spPr 中提取 `<a:outerShdw>` / `<a:innerShdw>`，返回 CSS box-shadow 字符串。
fn parse_shadow(sp_pr: &str, theme: &HashMap<String, String>) -> Option<String> {
    let eff = extract_tag(sp_pr, "a:effectLst")?;
    let is_outer = eff.contains("<a:outerShdw");
    let is_inner = eff.contains("<a:innerShdw");
    if !is_outer && !is_inner { return None; }

    let tag = if is_outer { "a:outerShdw" } else { "a:innerShdw" };
    let node = extract_tag(&eff, tag)?;

    let blur = xml_attr(&node, tag, "blurRad")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0) as f64 / 12700.0; // EMU → pt
    let dist = xml_attr(&node, tag, "dist")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0) as f64 / 12700.0;
    let dir = xml_attr(&node, tag, "dir")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0) as f64 / 60000.0_f64.to_radians(); // 60000ths → radians

    let ox = (dist * dir.cos() * 0.75).round(); // EMU→pt, approximate
    let oy = (-dist * dir.sin() * 0.75).round(); // Y inverted for CSS

    let color = color_in(&node, theme).unwrap_or_else(|| "#000000".into());
    // 透明度：<a:alpha val="40000"/> → 40%
    let alpha = xml_attr(&node, "a:alpha", "val")
        .and_then(|v| v.parse::<f64>().ok())
        .map(|v| (v / 100000.0 * 100.0).round())
        .unwrap_or(70.0);

    let inset = if is_inner { "inset " } else { "" };
    Some(format!("{} {}px {}px {}px rgba({},{},{},{:.0}%)",
        inset,
        ox, oy,
        blur.max(1.0),
        u8::from_str_radix(&color[1..3], 16).unwrap_or(0),
        u8::from_str_radix(&color[3..5], 16).unwrap_or(0),
        u8::from_str_radix(&color[5..7], 16).unwrap_or(0),
        alpha))
}

// ========= 组合（grpSp）坐标变换 =========
// 组合把「子坐标空间」(a:chOff/a:chExt) 映射到「组合自身坐标空间」(a:off/a:ext)。
// 多个嵌套组合按 [外→内] 排列，应用时从内到外映射，最终落到幻灯片坐标。
// **关键修复（分组内图片/形状挤在左上、错位）**：PPT 形状/图片的 a:off/a:ext 是相对于
// 其直接父组合的子坐标系的；旧实现直接当幻灯片坐标用，未做组合变换，导致分组内的元素
// 全部被压到幻灯片原点附近（"挤在左上方/压缩"）。现递归进入每个 grpSp 并应用变换。
#[derive(Clone)]
struct GroupXform {
    grp_x: i64, grp_y: i64, grp_cx: i64, grp_cy: i64,
    ch_x: i64, ch_y: i64, ch_cx: i64, ch_cy: i64,
}
impl GroupXform {
    fn apply(&self, x: i64, y: i64, w: i64, h: i64) -> (i64, i64, i64, i64) {
        let sx = self.grp_cx as f64 / self.ch_cx.max(1) as f64;
        let sy = self.grp_cy as f64 / self.ch_cy.max(1) as f64;
        let ax = (self.grp_x as f64 + (x - self.ch_x) as f64 * sx).round() as i64;
        let ay = (self.grp_y as f64 + (y - self.ch_y) as f64 * sy).round() as i64;
        let aw = (w as f64 * sx).round() as i64;
        let ah = (h as f64 * sy).round() as i64;
        (ax, ay, aw, ah)
    }
}

// 收集片段：kind + 原始 XML 切片 + 已应用祖先组合变换后的绝对幻灯片 EMU 矩形。
struct Piece<'a> {
    kind: &'static str,
    raw: &'a str,
    rect: (i64, i64, i64, i64), // (x, y, w, h) in slide EMU
    rotation: f64,              // degrees (OXO XML rot / 60000)
    flip_h: bool,
    flip_v: bool,
}

/// 从元素的 `<a:xfrm rot="...">` 标签中提取旋转角（度）和翻转标志。
fn xfrm_rotation(raw: &str) -> (f64, bool, bool) {
    let xfrm = extract_tag(raw, "a:xfrm").unwrap_or("");
    let start = xfrm.find("<a:xfrm").unwrap_or(0);
    let end = xfrm[start..].find('>').unwrap_or(xfrm.len() - start);
    let tag = &xfrm[start..start + end];
    let get = |attr: &str| -> Option<String> {
        let pat = format!("{}=\"", attr);
        let p = tag.find(&pat)?;
        let vs = p + pat.len();
        let ve = tag[vs..].find('"')?;
        Some(tag[vs..vs + ve].to_string())
    };
    let rot = get("rot")
        .and_then(|v| v.parse::<i64>().ok())
        .map(|v| v as f64 / 60000.0)
        .unwrap_or(0.0);
    let flip_h = get("flipH").and_then(|v| v.parse::<i64>().ok()).map(|v| v != 0).unwrap_or(false);
    let flip_v = get("flipV").and_then(|v| v.parse::<i64>().ok()).map(|v| v != 0).unwrap_or(false);
    (rot, flip_h, flip_v)
}

// 解析 <p:grpSp> 的 grpSpPr 变换（grp=组合自身位置/尺寸，ch=子坐标原点/范围）。
fn parse_group_xform(grp: &str) -> Option<GroupXform> {
    let xfrm = extract_tag(grp, "a:xfrm")?;
    let grp_x = xml_attr(xfrm, "a:off", "x").and_then(|v| v.parse().ok())?;
    let grp_y = xml_attr(xfrm, "a:off", "y").and_then(|v| v.parse().ok())?;
    let grp_cx = xml_attr(xfrm, "a:ext", "cx").and_then(|v| v.parse().ok())?;
    let grp_cy = xml_attr(xfrm, "a:ext", "cy").and_then(|v| v.parse().ok())?;
    let ch_x = xml_attr(xfrm, "a:chOff", "x").and_then(|v| v.parse().ok()).unwrap_or(0);
    let ch_y = xml_attr(xfrm, "a:chOff", "y").and_then(|v| v.parse().ok()).unwrap_or(0);
    let ch_cx = xml_attr(xfrm, "a:chExt", "cx").and_then(|v| v.parse().ok()).unwrap_or(grp_cx);
    let ch_cy = xml_attr(xfrm, "a:chExt", "cy").and_then(|v| v.parse().ok()).unwrap_or(grp_cy);
    Some(GroupXform { grp_x, grp_y, grp_cx, grp_cy, ch_x, ch_y, ch_cx, ch_cy })
}

// 叶子元素的自身 a:xfrm 矩形（在其父组合的子坐标空间内）。
fn local_rect(raw: &str) -> (i64, i64, i64, i64) {
    let xfrm = extract_tag(raw, "a:xfrm").unwrap_or("");
    let x = xml_attr(xfrm, "a:off", "x").and_then(|v| v.parse().ok()).unwrap_or(0);
    let y = xml_attr(xfrm, "a:off", "y").and_then(|v| v.parse().ok()).unwrap_or(0);
    let w = xml_attr(xfrm, "a:ext", "cx").and_then(|v| v.parse().ok()).unwrap_or(0);
    let h = xml_attr(xfrm, "a:ext", "cy").and_then(|v| v.parse().ok()).unwrap_or(0);
    (x, y, w, h)
}

// 按 [外→内] 的祖先组合链，把子坐标矩形映射到幻灯片坐标（从内到外应用）。
fn apply_chain(groups: &[GroupXform], r: (i64, i64, i64, i64)) -> (i64, i64, i64, i64) {
    let mut cur = r;
    for g in groups.iter().rev() {
        cur = g.apply(cur.0, cur.1, cur.2, cur.3);
    }
    cur
}

// ========= 占位符坐标继承（slideLayout / slideMaster） =========
// **关键修复（文本/占位符压缩在左上角）**：PPT 的占位符（标题/正文/副标题等）在 slide XML
// 中往往不带 `a:xfrm`，其位置由 `<p:ph idx/type>` 引用「幻灯片版式(slideLayout)」乃至
// 「母版(slideMaster)」中同名占位符的 `a:xfrm` 决定。旧实现忽略版式、直接把缺 xfrm 的
// 占位符当作 (0,0,0,0) → 所有文本被压到画布左上角原点、尺寸塌缩成 8px（"蓝色底框"即缺填充
// 占位符的默认蓝描边，也跟着塌到左上）。现读取版式(回退母版)的占位符坐标来还原正确位置。
fn resolve_rel(base: &str, rel: &str) -> String {
    let mut parts: Vec<&str> = base.trim_end_matches('/').split('/').collect();
    parts.pop();
    for seg in rel.split('/') {
        if seg == ".." {
            parts.pop();
        } else if seg == "." || seg.is_empty() {
            // 跳过
        } else {
            parts.push(seg);
        }
    }
    parts.join("/")
}

fn rels_path_of(part: &str) -> String {
    if let Some(i) = part.rfind('/') {
        let (dir, file) = part.split_at(i + 1);
        format!("{}rels/{}.rels", dir, file)
    } else {
        format!("_rels/{}.rels", part)
    }
}

fn ph_key(sp: &str) -> Option<String> {
    let ph = extract_tag(sp, "p:ph")?;
    let idx = xml_attr(ph, "p:ph", "idx");
    let ty = xml_attr(ph, "p:ph", "type").unwrap_or_else(|| "body".to_string());
    Some(match idx {
        Some(i) => format!("idx:{}", i),
        None => format!("type:{}", ty),
    })
}

fn placeholder_rects_from_xml(xml: &str) -> HashMap<String, (i64, i64, i64, i64)> {
    let mut m: HashMap<String, (i64, i64, i64, i64)> = HashMap::new();
    let mut search = 0;
    while search < xml.len() {
        let rest = &xml[search..];
        let at = match find_shape_open(rest, "p:sp") {
            Some(a) => a,
            None => break,
        };
        let abs = search + at;
        let close = "</p:sp>";
        if let Some(rel_end) = rest[at..].find(close) {
            let sp = &xml[abs..abs + rel_end + close.len()];
            if sp.contains("<p:ph") {
                if let Some(key) = ph_key(sp) {
                    let r = local_rect(sp);
                    if r != (0, 0, 0, 0) {
                        m.insert(key, r);
                    }
                }
            }
            search = abs + rel_end + close.len();
        } else {
            search += 1;
        }
    }
    m
}

fn default_ph_rect(raw: &str, sw: i64, sh: i64) -> (i64, i64, i64, i64) {
    let ty = extract_tag(raw, "p:ph")
        .and_then(|ph| xml_attr(ph, "p:ph", "type"))
        .unwrap_or_default();
    match ty.as_str() {
        "title" | "ctrTitle" => ((sw * 10 / 100), (sh * 5 / 100), (sw * 80 / 100), (sh * 15 / 100)),
        "subTitle" | "body" | "bodyText" => ((sw * 10 / 100), (sh * 25 / 100), (sw * 80 / 100), (sh * 60 / 100)),
        "ftr" | "dt" | "sldNum" => ((sw * 80 / 100), (sh * 92 / 100), (sw * 15 / 100), (sh * 6 / 100)),
        _ => ((sw * 10 / 100), (sh * 10 / 100), (sw * 80 / 100), (sh * 30 / 100)),
    }
}

fn build_layout_rects(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    layout_target: &Option<String>,
) -> HashMap<String, (i64, i64, i64, i64)> {
    let mut map: HashMap<String, (i64, i64, i64, i64)> = HashMap::new();
    if let Some(t) = layout_target {
        let path = resolve_rel("ppt/slides/", t);
        if let Ok(s) = read_zip_entry(archive, &path) {
            map = placeholder_rects_from_xml(&s);
            // 母版回退：版式里没有的占位符，用母版同名占位符补上
            let mrels = rels_path_of(&path);
            if let Ok(mr) = read_zip_entry(archive, &mrels) {
                for rel in split_rels(&mr) {
                    let ty = xml_attr(rel, "Relationship", "Type").unwrap_or_default();
                    if ty.contains("/slideMaster") {
                        if let Some(mt) = xml_attr(rel, "Relationship", "Target") {
                            let mpath = resolve_rel("ppt/slideLayouts/", &mt);
                            if let Ok(ms) = read_zip_entry(archive, &mpath) {
                                for (k, v) in placeholder_rects_from_xml(&ms) {
                                    map.entry(k).or_insert(v);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    map
}

fn element_rect(
    raw: &str,
    groups: &[GroupXform],
    ph_rects: &HashMap<String, (i64, i64, i64, i64)>,
    sw: i64,
    sh: i64,
) -> (i64, i64, i64, i64) {
    let local = local_rect(raw);
    if local == (0, 0, 0, 0) && raw.contains("<p:ph") {
        // 占位符：继承版式/母版坐标（已是幻灯片绝对 EMU，不再叠加组合变换）
        if let Some(key) = ph_key(raw) {
            if let Some(r) = ph_rects.get(&key) {
                return *r;
            }
        }
        return default_ph_rect(raw, sw, sh);
    }
    apply_chain(groups, local)
}

// 跳过 node 自身的开标签 <tag ...>，返回其后内容（用于递归扫描直接子节点，
// 避免把 grpSp 自己的开标签误当成其第一个子节点导致无限递归）。
fn skip_open_tag<'a>(node: &'a str, tag: &str) -> &'a str {
    let pat = format!("<{}", tag);
    if let Some(at) = node.find(&pat) {
        let after = &node[at + pat.len()..];
        if let Some(gt) = after.find('>') {
            return &node[at + pat.len() + gt + 1..];
        }
    }
    node
}

// 递归收集 spTree / grpSp 的「直接子节点」。遇到 grpSp 解析变换后递归其内部，
// 使分组内的图片/形状/表格都参与坐标映射。
fn collect_pieces<'a>(
    node: &'a str,
    groups: &[GroupXform],
    ph_rects: &HashMap<String, (i64, i64, i64, i64)>,
    sw: i64,
    sh: i64,
    out: &mut Vec<Piece<'a>>,
) {
    let mut search = 0;
    while search < node.len() {
        let rest = &node[search..];
        let sp_at = find_shape_open(rest, "p:sp");
        let pic_at = find_shape_open(rest, "p:pic");
        let gf_at = find_shape_open(rest, "p:graphicFrame");
        let grp_at = find_shape_open(rest, "p:grpSp");
        let cxn_at = find_shape_open(rest, "p:cxnSp");
        // 取最早出现的直接子节点
        let chosen: Option<(usize, &str)> = {
            let sp = sp_at.unwrap_or(usize::MAX);
            let pic = pic_at.unwrap_or(usize::MAX);
            let gf = gf_at.unwrap_or(usize::MAX);
            let grp = grp_at.unwrap_or(usize::MAX);
            let cxn = cxn_at.unwrap_or(usize::MAX);
            let mut best = usize::MAX;
            let mut kind: &str = "";
            if sp < best { best = sp; kind = "sp"; }
            if pic < best { best = pic; kind = "pic"; }
            if gf < best { best = gf; kind = "gf"; }
            if grp < best { best = grp; kind = "grp"; }
            if cxn < best { best = cxn; kind = "cxn"; }
            if best == usize::MAX { None } else { Some((best, kind)) }
        };
        if let Some((rel_start, kind)) = chosen {
            let abs_start = search + rel_start;
            let close = if kind == "sp" { "</p:sp>" }
                else if kind == "pic" { "</p:pic>" }
                else if kind == "gf" { "</p:graphicFrame>" }
                else if kind == "cxn" { "</p:cxnSp>" }
                else { "</p:grpSp>" };
            if let Some(rel_end) = node[abs_start..].find(close) {
                let abs_end = abs_start + rel_end + close.len();
                let raw = &node[abs_start..abs_end];
                if kind == "grp" {
                    if let Some(g) = parse_group_xform(raw) {
                        let mut child_groups = groups.to_vec();
                        child_groups.push(g);
                        let inner = skip_open_tag(raw, "p:grpSp");
                        collect_pieces(inner, &child_groups, ph_rects, sw, sh, out);
                    }
                } else {
                    let rect = element_rect(raw, groups, ph_rects, sw, sh);
                    let (rot, fh, fv) = xfrm_rotation(raw);
                    out.push(Piece { kind, raw, rect, rotation: rot, flip_h: fh, flip_v: fv });
                }
                search = abs_end;
                continue;
            }
        }
        search += node[search..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
    }
}

// ========= 主解析 =========

fn parse_slide(
    xml: &str,
    rels: &SlideRels,
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    media_dir: &std::path::Path,
    xf: &CanvasXform,
    slide_w: i64,
    slide_h: i64,
    theme: &HashMap<String, String>,
) -> Result<Value, String> {
    let mut map = Map::new();
    map.insert("id".into(), json!(uuid_id()));
    map.insert("background".into(), json!("#ffffff"));
    // 本幻灯片的逻辑画布尺寸（EMU × scale 取整）。前端据此渲染真实比例的画布，
    // 避免非 16:9 / 非 13.33" 幻灯片（如 10" 宽 → 720×540）被按 960×540 渲染导致横向错位/留白。
    let cw = (slide_w as f64 * xf.scale).round() as i64;
    let ch = (slide_h as f64 * xf.scale).round() as i64;
    map.insert("width".into(), json!(cw));
    map.insert("height".into(), json!(ch));

    // 切换动画：解析 `<p:transition>`（PowerPoint 幻灯片切换效果），映射到编辑器支持的
    // fade / slide / none。这样「放映」时能按原作者设置的切换方式播放，而非永远淡入。
    let transition = parse_transition(xml);
    map.insert("transition".into(), json!(transition));

    // 背景
    if let Some(bg_pr) = extract_tag(xml, "p:bgPr") {
        if let Some(c) = extract_solid_color(bg_pr, "a:solidFill", theme) {
            map.insert("background".into(), json!(c));
        }
    }


    let mut elements: Vec<Value> = Vec::new();

    // spTree 内容
    let sp_tree_start = xml.find("<p:spTree").unwrap_or(0);
    let sp_tree_end = xml.rfind("</p:spTree>").map(|i| i + 12).unwrap_or(xml.len());
    let sp_tree = &xml[sp_tree_start..sp_tree_end];

    // 递归收集所有叶子元素（sp/pic/graphicFrame），并应用祖先组合(grpSp)坐标变换，
    // 得到每个元素在幻灯片坐标系下的绝对 EMU 矩形。
    // 占位符（标题/正文等）在 slide 中常不带 a:xfrm，需从版式/母版继承坐标。
    let ph_rects = build_layout_rects(archive, &rels.layout);
    let mut pieces: Vec<Piece> = Vec::new();
    collect_pieces(sp_tree, &[], &ph_rects, slide_w, slide_h, &mut pieces);

    for p in &pieces {
        let raw = p.raw;
        let rect = p.rect;
        if p.kind == "sp" || p.kind == "cxn" {
            if let Ok(el) = parse_sp(raw, xf, rect, theme) {
                elements.push(el);
            }
        } else if p.kind == "pic" {
            if let Ok(el) = parse_pic(raw, rels, archive, media_dir, xf, rect) {
                elements.push(el);
            }
        } else if p.kind == "gf" {
            // 表格（graphicFrame）拆解为 shape（单元格底框）+ text（单元格文字），
            // 让导入的表格正确呈现，而非整片丢失/挤成一团。图表 / SmartArt 等非表格 graphicFrame
            // 退化为浅色占位矩形，避免内容凭空消失（"丢东西"）。
            let mut tbl_els = parse_graphic_frame(raw, xf, theme);
            elements.append(&mut tbl_els);
        }
    }

    // 给每个元素分配稳定 id + z（从 1 开始），并建立「原始 spid → 生成的元素 id 列表」映射。
    // 表格一个 spid 会对应多个单元格元素，故用 Vec 收集，动画时整表一起播放。
    let mut spid_to_ids: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for (i, el) in elements.iter_mut().enumerate() {
        if let Some(o) = el.as_object_mut() {
            let elid = uuid_id();
            if let Some(spid) = o.get("spid").and_then(|v| v.as_str()) {
                spid_to_ids.entry(spid.to_string()).or_default().push(elid.clone());
            }
            o.insert("id".into(), json!(elid));
            o.insert("z".into(), json!(i + 1));
        }
    }

    // 元素级动画：解析 `<p:timing>`（进场/强调/退场 + 单击/伴随/其后触发），按 spid 关联到元素，
    // 生成有序的 animations 列表，供放映时逐次「单击构建」播放。
    let animations = parse_timing(xml, &spid_to_ids);
    map.insert("animations".into(), json!(animations));

    map.insert("elements".into(), json!(elements));
    Ok(Value::Object(map))
}

fn parse_sp(
    sp_str: &str,
    xf: &CanvasXform,
    rect: (i64, i64, i64, i64),
    theme: &HashMap<String, String>,
) -> Result<Value, String> {
    let mut el = Map::new();
    el.insert("type".into(), json!("shape"));

    // 原始形状 id（`<p:cNvPr id="N">`）—— 供 `<p:timing>` 元素级动画按 spid 关联到本元素。
    if let Some(spid) = xml_attr(sp_str, "p:cNvPr", "id") {
        el.insert("spid".into(), json!(spid));
    }

    // 坐标来自已应用组合变换的绝对幻灯片 EMU 矩形（顶层时即自身 xfrm）。
    let (ex, ey, ew, eh) = rect;
    let x = lx(ex, xf).round();
    let y = ly(ey, xf).round();
    let w = lw(ew, xf);
    let h = lh(eh, xf);

    el.insert("x".into(), json!(x));
    el.insert("y".into(), json!(y));
    el.insert("w".into(), json!(w));
    el.insert("h".into(), json!(h));
    // 旋转（度）+ 翻转：PowerPoint 常见旋转形状，缺失时方向完全错误。
    let (rot, fh, fv) = xfrm_rotation(sp_str);
    if rot != 0.0 {
        el.insert("rotation".into(), json!(rot));
    }
    if fh {
        el.insert("flipH".into(), json!(true));
    }
    if fv {
        el.insert("flipV".into(), json!(true));
    }

    // prstGeom shape type
    let prst = extract_tag(sp_str, "a:prstGeom")
        .and_then(|g| xml_attr(g, "a:prstGeom", "prst"));
    let shape = prst.as_deref().map(map_prst).unwrap_or("rect");
    el.insert("shape".into(), json!(shape));

    // 视觉属性
    let full_sp_pr = extract_tag(sp_str, "p:spPr").unwrap_or("");
    let (fill, stroke, stroke_w) = parse_sp_pr(full_sp_pr, theme);
    if shape == "line" {
        el.insert("fill".into(), json!("transparent"));
        el.insert("stroke".into(), json!(stroke.unwrap_or_else(|| "#000000".into())));
        el.insert("strokeWidth".into(), json!(stroke_w.unwrap_or(2.0)));
    } else {
        // **关键修复（蓝色底框 / 白底）**：无填充即透明（不再兜底浅蓝）；无描边即无描边
        // （不再兜底蓝色 #3b82f6）。主题色（schemeClr）已在 parse_sp_pr 中解析为真实颜色。
        el.insert("fill".into(), json!(fill.unwrap_or_else(|| "transparent".into())));
        el.insert("stroke".into(), json!(stroke.unwrap_or_else(|| "none".into())));
        el.insert("strokeWidth".into(), json!(stroke_w.unwrap_or(2.0)));
    }

    // 渐变填充：若形状使用 <a:gradFill>，输出完整渐变数据供前端渲染 CSS/SVG 渐变，
    // 取代之前的首色近似，让学科类 pptx 的土壤剖面/磁感线等渐变图形正确还原。
    if let Some(grad) = resolve_gradient_fill(full_sp_pr, theme) {
        el.insert("fillGradient".into(), grad);
    }

    // 阴影：outerShdw / innerShdw → CSS box-shadow 字符串
    if let Some(shadow) = parse_shadow(full_sp_pr, theme) {
        el.insert("shadow".into(), json!(shadow));
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
                let (t, st) = parse_paragraph(p_str, theme);
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

fn parse_pic(
    pic_str: &str,
    rels: &SlideRels,
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    media_dir: &std::path::Path,
    xf: &CanvasXform,
    rect: (i64, i64, i64, i64),
) -> Result<Value, String> {
    let mut el = Map::new();
    el.insert("type".into(), json!("image"));

    // 原始图片 id（`<p:cNvPr id="N">`）—— 供元素级动画按 spid 关联。
    if let Some(spid) = xml_attr(pic_str, "p:cNvPr", "id") {
        el.insert("spid".into(), json!(spid));
    }

    let (ex, ey, ew, eh) = rect;
    let x = lx(ex, xf).round();
    let y = ly(ey, xf).round();
    let w = lw(ew, xf);
    let h = lh(eh, xf);
    el.insert("x".into(), json!(x));
    el.insert("y".into(), json!(y));
    el.insert("w".into(), json!(w));
    el.insert("h".into(), json!(h));
    // 图片旋转/翻转
    let (rot, fh, fv) = xfrm_rotation(pic_str);
    if rot != 0.0 { el.insert("rotation".into(), json!(rot)); }
    if fh { el.insert("flipH".into(), json!(true)); }
    if fv { el.insert("flipV".into(), json!(true)); }

    // 通过 r:embed → rels → media 提取图片。
    // **关键修复（导入大文件卡死/闪退）**：旧实现把每张图片 base64 内联进 JSON 字符串，
    // 多图/大图的 pptx 会生成数十~上百 MB 的 JSON，经 IPC 回传 + JSON.parse + 存进 React
    // 状态 + 写 localStorage（5MB 上限）→ WebView 内存暴涨 → 整个应用卡死并闪退。
    // 改为把图片字节**落盘到 app_data/pptx_media/**，src 仅存本地路径；前端用 asset: 协议
    // 加载（convertFileSrc），内存与 IPC 体积都降到极低，彻底消除卡死/闪退。
    if let Some(embed) = xml_attr(pic_str, "a:blip", "r:embed") {
        if let Some((_, target_path)) = rels.images.iter().find(|(id, _)| id == &embed) {
            // target_path 如 "../media/image1.png"
            let media_name = target_path.trim_start_matches("../");
            let entry_path = format!("ppt/{}", media_name);
            match archive.by_name(&entry_path) {
                Ok(mut file) => {
                    let mut buf = Vec::new();
                    if file.read_to_end(&mut buf).is_ok() {
                        let ext = if entry_path.ends_with(".png") { "png" }
                            else if entry_path.ends_with(".jpg") || entry_path.ends_with(".jpeg") { "jpeg" }
                            else { "png" };
                        let fname = format!("{}.{}", uuid_id(), ext);
                        let fpath = media_dir.join(&fname);
                        if std::fs::write(&fpath, &buf).is_ok() {
                            el.insert("src".into(), json!(fpath.to_string_lossy().to_string()));
                        }
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

// ========= 表格解析（graphicFrame → a:tbl）========
// 把 `<tag ...>...</tag>` 的每段出现切分出来（兼容有/无属性写法）。
fn split_tags<'a>(s: &'a str, tag: &str) -> Vec<&'a str> {
    let mut v = Vec::new();
    let open = format!("<{}", tag);
    let close = format!("</{}>", tag);
    let mut search = 0;
    while search < s.len() {
        let rest = &s[search..];
        let at = match rest.find(&open) {
            Some(a) => a,
            None => break,
        };
        let after = s[search + at + open.len()..].chars().next();
        if after != Some(' ') && after != Some('>') {
            search = search + at + open.len();
            continue;
        }
        let abs = search + at;
        if let Some(rel_end) = s[abs..].find(&close) {
            let abs_end = abs + rel_end + close.len();
            v.push(&s[abs..abs_end]);
            search = abs_end;
        } else {
            search = abs + open.len();
        }
    }
    v
}

// 解析 graphicFrame 内的 `<a:tbl>`：将每个单元格拆为「shape 底框 + text 文字」两个元素，
// 让前端（只有 shape / text / image 三种元素）能正确呈现表格网格与内容。
// 支持 gridSpan（横向合并跨列）；vMerge（纵向合并）近似处理：续格跳过，锚格按单行高渲染。
// `gf_str` 为原始 graphicFrame 片段；**关键修复（表格塌缩在左上角）**：PowerPoint 的
// graphicFrame 常把 xfrm 写成占位值(0,0,8,8)，真实尺寸藏在 `a:tblGrid` 列宽与 `a:tr` 行高里。
// 故优先从表格网格反推 frame 宽高（fx/fy 取 xfrm 偏移），占位 xfrm 时也能摆对位置与尺寸。
// **关键修复（图表 / SmartArt 整段丢失）**：非表格 graphicFrame（图表 c:chart、图示 diagram 等）
// 旧实现直接 return 空 → "丢东西"。现退化为一个浅色占位矩形，占用原图框区域，
// 让内容至少可见（图表精确重绘属大功能，后续单独做）。
fn parse_graphic_frame(gf_str: &str, xf: &CanvasXform, theme: &HashMap<String, String>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    // 表格在幻灯片中的偏移：取 graphicFrame 的 a:xfrm（缺省 0,0）
    let gf_xfrm = extract_tag(gf_str, "p:xfrm").unwrap_or("");
    let gf_off = extract_tag(gf_xfrm, "a:off").unwrap_or("");
    let fx = xml_attr(gf_off, "a:off", "x").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    let fy = xml_attr(gf_off, "a:off", "y").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    let gf_ext = extract_tag(gf_xfrm, "a:ext").unwrap_or("");
    let xfrm_w = xml_attr(gf_ext, "a:ext", "cx").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    let xfrm_h = xml_attr(gf_ext, "a:ext", "cy").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);

    let tbl = extract_tag(gf_str, "a:tbl");
    if tbl.is_none() {
        // 非表格：图表 / SmartArt / 图示 → 浅色占位矩形，避免内容凭空消失。
        let fw = if xfrm_w > 50 { xfrm_w } else { 0 };
        let fh = if xfrm_h > 50 { xfrm_h } else { 0 };
        let lxv = lx(fx, xf);
        let lyv = ly(fy, xf);
        let lwv = lw(fw, xf);
        let lhv = lh(fh, xf);
        let mut ph = Map::new();
        ph.insert("type".into(), json!("shape"));
        ph.insert("shape".into(), json!("rect"));
        ph.insert("x".into(), json!(lxv.round()));
        ph.insert("y".into(), json!(lyv.round()));
        ph.insert("w".into(), json!(lwv));
        ph.insert("h".into(), json!(lhv));
        ph.insert("fill".into(), json!("#eef2f7"));
        ph.insert("stroke".into(), json!("#9aa7b4"));
        ph.insert("strokeWidth".into(), json!(1.0));
        out.push(Value::Object(ph));
        return out;
    }
    let tbl = tbl.unwrap();
    // 真实尺寸：优先 a:tblGrid 列宽之和 × a:tr 行高之和；占位 xfrm 时即得到正确大小
    let grid = extract_tag(tbl, "a:tblGrid").unwrap_or("");
    let grid_cols = split_tags(grid, "a:gridCol");
    let col_w_all: Vec<i64> = grid_cols
        .iter()
        .filter_map(|s| xml_attr(s, "a:gridCol", "w").and_then(|v| v.parse::<i64>().ok()))
        .collect();
    let grid_w: i64 = col_w_all.iter().sum::<i64>();
    let rows_all = split_tags(tbl, "a:tr");
    let grid_h: i64 = rows_all
        .iter()
        .map(|r| xml_attr(r, "a:tr", "h").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0))
        .sum();
    // 兜底：若网格尺寸异常（≤0 或极小），退回占位 xfrm 的 ext（极少出现）
    let fw = if grid_w > 50 { grid_w } else { xfrm_w };
    let fh = if grid_h > 50 { grid_h } else { xfrm_h };

    // 列宽
    let grid = extract_tag(tbl, "a:tblGrid").unwrap_or("");
    let col_w: Vec<i64> = split_tags(grid, "a:gridCol")
        .iter()
        .filter_map(|s| xml_attr(s, "a:gridCol", "w").and_then(|v| v.parse::<i64>().ok()))
        .collect();
    let total_w = col_w.iter().sum::<i64>().max(1);

    let rows = split_tags(tbl, "a:tr");
    let total_h: i64 = rows
        .iter()
        .map(|r| xml_attr(r, "a:tr", "h").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0))
        .sum::<i64>()
        .max(1);

    let rows = split_tags(tbl, "a:tr");
    let mut row_y = 0i64;
    // 每列是否处于纵向合并态（续格需跳过）
    let mut col_vmerge: Vec<bool> = vec![false; col_w.len().max(1)];
    for row_str in rows {
        let row_h = xml_attr(row_str, "a:tr", "h")
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);
        let cells = split_tags(row_str, "a:tc");
        let mut col_cursor = 0usize;
        for cell_str in cells {
            // 纵向合并续格：跳过（其区域已由锚格渲染）
            if col_cursor < col_vmerge.len() && col_vmerge[col_cursor] {
                let gs = xml_attr(cell_str, "a:tc", "gridSpan")
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(1);
                col_cursor += gs.max(1);
                continue;
            }
            let gs = xml_attr(cell_str, "a:tc", "gridSpan")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(1);
            let span = gs.max(1);
            let mut cell_w = 0i64;
            for c in 0..span {
                if let Some(w) = col_w.get(col_cursor + c) {
                    cell_w += *w;
                }
            }
            let vmerge = xml_attr(cell_str, "a:tc", "vMerge").is_some();
            if vmerge {
                for c in 0..span {
                    if col_cursor + c < col_vmerge.len() {
                        col_vmerge[col_cursor + c] = true;
                    }
                }
            }
            // 单元格在表格框内的比例定位（避免直接读 xfrm 受组坐标影响）
            let col_offset_emu = col_w.iter().take(col_cursor).sum::<i64>();
            let abs_x = fx + (col_offset_emu as f64 / total_w as f64 * fw as f64).round() as i64;
            let abs_y = fy + (row_y as f64 / total_h as f64 * fh as f64).round() as i64;
            let cw = (cell_w as f64 / total_w as f64 * fw as f64).round() as i64;
            let ch = (row_h as f64 / total_h as f64 * fh as f64).round() as i64;
            let lxv = lx(abs_x, xf);
            let lyv = ly(abs_y, xf);
            let lwv = lw(cw, xf);
            let lhv = lh(ch, xf);

            // 单元格填充（无则透明；支持主题色 schemeClr）
            let tc_pr = extract_tag(cell_str, "a:tcPr").unwrap_or("");
            let fill = extract_solid_color(tc_pr, "a:solidFill", theme)
                .unwrap_or_else(|| "transparent".into());

            let mut shape = Map::new();
            shape.insert("type".into(), json!("shape"));
            shape.insert("shape".into(), json!("rect"));
            shape.insert("x".into(), json!(lxv.round()));
            shape.insert("y".into(), json!(lyv.round()));
            shape.insert("w".into(), json!(lwv));
            shape.insert("h".into(), json!(lhv));
            shape.insert("fill".into(), json!(fill));
            shape.insert("stroke".into(), json!("#b0b0b0"));
            shape.insert("strokeWidth".into(), json!(1.0));
            out.push(Value::Object(shape));

            let tx_body = extract_tag(cell_str, "a:txBody").unwrap_or("");
            if tx_body.contains("<a:t>") {
                let mut all_text = String::new();
                let mut style: Option<Value> = None;
                let p_strs: Vec<&str> = tx_body.split("</a:p>").filter(|s| s.contains("<a:p")).collect();
                for p_str in &p_strs {
                    let (t, st) = parse_paragraph(p_str, theme);
                    if !t.is_empty() {
                        if !all_text.is_empty() {
                            all_text.push('\n');
                        }
                        all_text.push_str(&t);
                    }
                    if style.is_none() {
                        style = Some(st);
                    }
                }
                let mut tel = Map::new();
                tel.insert("type".into(), json!("text"));
                tel.insert("x".into(), json!(lxv.round()));
                tel.insert("y".into(), json!(lyv.round()));
                tel.insert("w".into(), json!(lwv));
                tel.insert("h".into(), json!(lhv));
                tel.insert("text".into(), json!(all_text));
                if let Some(st) = style {
                    tel.insert("style".into(), st);
                }
                out.push(Value::Object(tel));
            }

            col_cursor += span;
        }
        row_y += row_h;
    }

    // 整表作为一个动画目标：给所有单元格元素打上 graphicFrame 的原始 id（`<p:cNvPr id>`），
    // 这样 `<p:timing>` 若对该表设置进/退场动画，整张表能一起播放。
    if let Some(gf_nv) = extract_tag(gf_str, "p:nvGraphicFramePr") {
        if let Some(spid) = xml_attr(gf_nv, "p:cNvPr", "id") {
            for v in out.iter_mut() {
                if let Some(o) = v.as_object_mut() {
                    o.insert("spid".into(), json!(spid));
                }
            }
        }
    }

    out
}

// ========= 切换动画解析 =========
// 解析 `<p:transition>` 的 type 属性，映射到编辑器支持的切换效果：
//   fade（淡出/溶解等）→ "fade"
//   push / wipe / cover / uncover / comb / erase / split /flip / zoom /fadeOver ... 等方向/位移类 → "slide"
//   reveal / none / 未识别 → "none"
// 保留原作者设置的切换方式，放映时按此播放（而非永远淡入）。
fn parse_transition(slide_xml: &str) -> &'static str {
    let tr = match extract_tag(slide_xml, "p:transition") {
        Some(t) => t,
        None => return "none",
    };
    let ty = xml_attr(tr, "p:transition", "type").unwrap_or_default();
    if ty.is_empty() {
        return "fade"; // 有 <p:transition> 但无 type，PPT 默认即淡出
    }
    let lower = ty.to_ascii_lowercase();
    if lower.contains("fade") || lower.contains("dissolve") {
        "fade"
    } else if is_motion_transition(&lower) {
        "slide"
    } else {
        "none"
    }
}

// 判断是否为「位移/方向类」切换（推入/擦除/翻页/缩放/飞入等），映射到 slide
fn is_motion_transition(ty: &str) -> bool {
    ty.contains("push") || ty.contains("wipe") || ty.contains("cover") || ty.contains("uncover")
        || ty.contains("comb") || ty.contains("erase") || ty.contains("split") || ty.contains("flip")
        || ty.contains("zoom") || ty.contains("fly") || ty.contains("fall") || ty.contains("cursor")
        || ty.contains("glitter") || ty.contains("honeycomb") || ty.contains("shred") || ty.contains("wheel")
        || ty.contains("pan") || ty.contains("origami") || ty.contains("ripple") || ty.contains("swivel")
        || ty.contains("conveyor") || ty.contains("rotate") || ty.contains("orbit") || ty.contains("window")
        || ty.contains("checkerboard") || ty.contains("blinds") || ty.contains("box") || ty.contains("diamond")
}

// ========= 元素级动画解析（<p:timing>）=========
// PowerPoint 的元素动画（进场 entr / 强调 emph / 退场 exit）写在 slide 的 `<p:timing>` 里，
// 结构是深层嵌套的 par/seq/cTn 时间树。这里采用「文档顺序 + nodeType」启发式做轻量解析（与多数
// 轻量 PPTX 解析器一致，覆盖绝大多数真实课件）：
//   1) 顺序扫描所有带 `presetClass` 的效果 `<p:cTn>`（真正的效果时间节点）；
//   2) 每个效果读取 presetClass / presetID / presetSubtype / nodeType / 时长 dur，并在其区段内
//      （到下一个效果节点之前）取 `<p:spTgt spid="...">` 目标；
//   3) nodeType 决定触发方式：clickEffect→单击(onClick，新建构建组)，withEffect→伴随(withPrev)，
//      afterEffect→其后(afterPrev)；构建组仅在遇到 onClick 时递增。
// 输出有序的动画条目（elId/type/preset/dir/trigger/duration/group），放映时逐组「单击构建」。
fn parse_timing(
    slide_xml: &str,
    spid_to_ids: &std::collections::HashMap<String, Vec<String>>,
) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let timing = match extract_tag(slide_xml, "p:timing") {
        Some(t) => t,
        None => return out,
    };

    // 收集所有「效果 cTn」（开标签含 presetClass=）的起始字节位置
    let mut effects: Vec<usize> = Vec::new();
    let mut i = 0usize;
    while let Some(rel) = timing[i..].find("<p:cTn") {
        let p = i + rel;
        let tag_end = timing[p..].find('>').map(|e| p + e + 1).unwrap_or(timing.len());
        if timing[p..tag_end].contains("presetClass=") {
            effects.push(p);
        }
        i = p + 6;
    }
    if effects.is_empty() {
        return out;
    }

    let mut group = 0i64;
    for k in 0..effects.len() {
        let start = effects[k];
        let end = if k + 1 < effects.len() { effects[k + 1] } else { timing.len() };
        let region = &timing[start..end];
        let tag_end = region.find('>').map(|e| e + 1).unwrap_or(region.len());
        let open = &region[..tag_end];

        let class = attr_in(open, "presetClass").unwrap_or_default();
        let preset_id = attr_in(open, "presetID").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
        let subtype = attr_in(open, "presetSubtype").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
        let node_type = attr_in(open, "nodeType").unwrap_or_default();

        let trigger = anim_trigger(&node_type);
        if trigger == "onClick" {
            group += 1;
        }
        let dur = find_dur(region);

        // 区段内所有 spTgt spid（去重）：一个效果常含 `<p:set>`(瞬时显隐) + `<p:animEffect>` 两处
        // 相同 spTgt，若不去重会导致同一元素同一动画被重复登记多次。
        let mut spids: Vec<String> = Vec::new();
        let mut j = 0usize;
        while let Some(rel) = region[j..].find("spid=\"") {
            let s = j + rel + 6;
            match region[s..].find('"') {
                Some(e) => {
                    let id = region[s..s + e].to_string();
                    if !spids.contains(&id) {
                        spids.push(id);
                    }
                    j = s + e;
                }
                None => break,
            }
        }

        let ty = anim_type(&class);
        let preset = anim_preset(&class, preset_id);
        let dir = anim_dir(subtype);
        for spid in &spids {
            if let Some(ids) = spid_to_ids.get(spid) {
                for elid in ids {
                    out.push(json!({
                        "elId": elid,
                        "type": ty,
                        "preset": preset,
                        "dir": dir,
                        "trigger": trigger,
                        "duration": dur,
                        "group": group,
                    }));
                }
            }
        }
    }
    out
}

// 从一段开标签字符串里读取属性值（不依赖标签名）
fn attr_in(open_tag: &str, attr: &str) -> Option<String> {
    let pat = format!("{}=\"", attr);
    let s = open_tag.find(&pat)? + pat.len();
    let rest = &open_tag[s..];
    Some(rest[..rest.find('"')?].to_string())
}

// 效果区段内的动效时长（毫秒）：取区段内所有数值型 dur 的**最大值**。
// 原因：进场效果常写成 `<p:set dur="1">`(瞬时置为可见) + `<p:animEffect>` 里的 `<p:cTn dur="500">`
// （真正的淡入时长）。取第一个会误取到 set 的 1ms，故取最大值得到真实动效时长。
// 全部缺省 / 仅有极短的 set → 回退 500ms。
fn find_dur(region: &str) -> i64 {
    let mut max_dur = 0i64;
    let mut j = 0usize;
    while let Some(rel) = region[j..].find("dur=\"") {
        let s = j + rel + 5;
        match region[s..].find('"') {
            Some(e) => {
                if let Ok(n) = region[s..s + e].parse::<i64>() {
                    if n > max_dur {
                        max_dur = n;
                    }
                }
                j = s + e;
            }
            None => break,
        }
    }
    if max_dur > 1 {
        max_dur.min(6000)
    } else {
        500
    }
}

// presetClass → 动画大类
fn anim_type(class: &str) -> &'static str {
    match class {
        "entr" => "entrance",
        "exit" => "exit",
        "emph" => "emphasis",
        _ => "entrance",
    }
}

// presetID → 前端支持的效果名（进/退场共用同一组 id；强调另算）
fn anim_preset(class: &str, preset_id: i64) -> &'static str {
    if class == "emph" {
        return match preset_id {
            8 => "spin",       // 陀螺旋
            1 | 5 | 6 => "grow", // 放大/缩小
            _ => "pulse",      // 脉冲/其它强调统一近似
        };
    }
    match preset_id {
        1 => "appear",                 // 出现（无动效，仅显隐）
        2 | 26 => "fly",               // 飞入 / 上升
        3 | 5 | 17 | 19 | 20 => "wipe", // 百叶窗/棋盘/阶梯/轮子/擦除
        4 | 6 | 8 | 21 => "zoom",      // 缩放类
        9 | 10 | 22 => "fade",         // 溶解/淡入/随机
        16 => "split",                 // 劈裂
        23 => "grow",                  // 缩放旋转
        37 => "float",                 // 浮入
        38 => "bounce",                // 弹跳
        _ => "fade",
    }
}

// presetSubtype → 方向（用于飞入/擦除）。取源边：left/right/top/bottom。
fn anim_dir(subtype: i64) -> &'static str {
    match subtype {
        8 | 9 | 10 => "left",
        2 | 6 | 12 => "right",
        1 => "top",
        4 | 5 | 3 => "bottom",
        _ => "bottom",
    }
}

// nodeType → 触发方式
fn anim_trigger(node_type: &str) -> &'static str {
    match node_type {
        "afterEffect" => "afterPrev",
        "withEffect" => "withPrev",
        // clickEffect / clickPar / 缺省 → 单击（教学放映最直观）
        _ => "onClick",
    }
}

// ========= 辅助 =========

fn extract_tag<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let start_tag = format!("<{}", tag);
    let close_tag = format!("</{}>", tag);
    let start = xml.find(&start_tag)?;
    let after = &xml[start..];
    // 判断是否为自闭合标签：取第一个 '>'，若其前一个字符是 '/' 才是真正的 <tag .../>
    // 注意：属性值里常含 '/'（如 URL / 路径），不能用"是否出现过 '/' "判断，否则会误判为自闭合，
    // 导致后面 `&xml[start..xml.len()+2]` 越界 panic（导入崩溃根因之一）。
    let self_close = after
        .find('>')
        .map(|gi| gi >= 1 && after.as_bytes()[gi - 1] == b'/')
        .unwrap_or(false);
    if self_close {
        // 自闭合：定位 "/>"，取 [start, 紧跟 '>' 之后]
        if let Some(i) = after.find("/>") {
            return Some(&xml[start..start + i + 2]);
        }
        // 极端情况：被判定自闭合却找不到 "/>" → 退回按配对标签处理
    }
    let end = after
        .find(&close_tag)
        .map(|i| start + i + close_tag.len())
        .unwrap_or(xml.len());
    Some(&xml[start..end])
}

/// 在 `s` 中查找 `<tag` 的起始位置，要求其后紧跟空格或 `>`（即一个完整的开标签起点），
/// 从而排除 `<tagTree` / `<tagX` 等前缀误匹配（如 `<p:spTree` 不能误判为 `<p:sp`）。
///
/// 用于 `parse_slide` 收集 `<p:sp>` / `<p:pic>`：PowerPoint 生成的形状常写成 `<p:sp>`
/// （无属性），单靠 `find("<p:sp ")`（带空格）会漏掉它们 → 导入内容空白。本函数对
/// 带属性（`<p:sp id=...>`）与无属性（`<p:sp>`）两种写法都能正确定位。
fn find_shape_open(s: &str, tag: &str) -> Option<usize> {
    let pat = format!("<{}", tag);
    let mut from = 0;
    while let Some(rel) = s[from..].find(&pat) {
        let abs = from + rel;
        let after_idx = abs + pat.len();
        let after = s[after_idx..].chars().next();
        if after == Some(' ') || after == Some('>') {
            return Some(abs);
        }
        from = after_idx;
    }
    None
}

fn read_zip_entry(archive: &mut ZipArchive<Cursor<&[u8]>>, name: &str) -> Result<String, String> {
    let mut file = archive.by_name(name).map_err(|e| format!("zip 中缺少 {}: {}", name, e))?;
    let mut buf = String::new();
    file.read_to_string(&mut buf).map_err(|e| format!("读取 {} 失败: {}", name, e))?;
    Ok(buf)
}

/// 从 Relationship Target（如 "slides/slide1.xml"、"/ppt/slides/slide12.xml"）取文件名 stem "slide1"
fn slide_stem(target: &str) -> String {
    let file = target.rsplit('/').next().unwrap_or(target);
    file.strip_suffix(".xml").unwrap_or(file).to_string()
}

/// presentation.xml + presentation.xml.rels → 有序幻灯片文件 stem 列表 ["slide1", "slide2", ...]
///
/// **关键修复（"未找到任何幻灯片" / 幻灯片顺序错乱）**：
/// 旧实现用 sldId 的 `id` 属性反推文件名（n = id-256+1），但真实 PPT 经增删/重排后，
/// sldId 的 `id` 与顺序号毫无关系（实测样本常见 id=465、677 等，远大于幻灯片张数），
/// 导致算出的编号远超张数、触发 `n > names+20` 容错 break 使列表变空（→ "未找到任何幻灯片"），
/// 或映射到不存在的 slideN.xml。
/// 正确做法：按 sldIdLst 顺序取每个 sldId 的 `r:id`，经 presentation.xml.rels
/// 的 Relationship（Type 以 /slide 结尾，排除 slideLayout/slideMaster/notesSlide 等）
/// 映射到真实 slide 文件名。
fn parse_slide_order(pres_xml: &str, pres_rels_xml: &str) -> Vec<String> {
    // rId -> slide stem（如 "rId3" -> "slide1"）
    let mut rid_map: HashMap<String, String> = HashMap::new();
    for rel in split_rels(pres_rels_xml) {
        let ty = xml_attr(rel, "Relationship", "Type").unwrap_or_default();
        // 精确匹配幻灯片关系：Type 以 "/slide" 结尾（slideLayout/slideMaster/notesSlide/slideShow 均不满足）
        if ty.ends_with("/slide") {
            let id = xml_attr(rel, "Relationship", "Id").unwrap_or_default();
            let target = xml_attr(rel, "Relationship", "Target").unwrap_or_default();
            if !id.is_empty() && !target.is_empty() {
                let stem = slide_stem(&target);
                if !stem.is_empty() {
                    rid_map.insert(id, stem);
                }
            }
        }
    }

    let mut names = Vec::new();
    let mut pos = 0;
    // 带尾随空格精确匹配 <p:sldId ...>，排除 <p:sldIdLst>
    while let Some(start) = pres_xml[pos..].find("<p:sldId ") {
        let abs_start = pos + start;
        let tag_end = pres_xml[abs_start..].find("/>")
            .or_else(|| pres_xml[abs_start..].find('>'))
            .map(|i| abs_start + i + 2).unwrap_or(pres_xml.len());
        let tag = &pres_xml[abs_start..tag_end.min(pres_xml.len())];
        if let Some(rid) = xml_attr(tag, "p:sldId", "r:id") {
            if let Some(stem) = rid_map.get(&rid) {
                names.push(stem.clone());
            }
        }
        pos = abs_start + 1;
    }
    names
}

fn uuid_id() -> String {
    format!("d{}", uuid::Uuid::new_v4().to_string().replace('-', ""))
}

// ========= 测试（实证，不猜）========
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diag_pptx_images() {
        // 用仓库内真实样例 pptx 实证图片提取，避免"猜测根因"。
        // 默认用 markitdown 自带的 multiple_images 样例（2 张顶层图片）；
        // 也可用环境变量 PPTX_TEST 指向任意 pptx（如含 <p:grpSp> 分组的真实文件）。
        let path = std::env::var("PPTX_TEST").unwrap_or_else(|_| {
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../external-deps/全局/markitdown/packages/markitdown-ocr/tests/ocr_test_data/pptx_multiple_images.pptx"
            )
            .into()
        });
        let bytes = std::fs::read(&path).expect("read pptx");
        let dir = std::env::temp_dir().join("pptx_media_test");
        let _ = std::fs::create_dir_all(&dir);
        let json = pptx_to_json(&bytes, &dir).expect("parse");
        let v: Value = serde_json::from_str(&json).unwrap();
        let mut elements = 0;
        let mut images = 0;
        if let Some(arr) = v.get("slides").and_then(|s| s.as_array()) {
            for s in arr {
                if let Some(els) = s.get("elements").and_then(|e| e.as_array()) {
                    elements += els.len();
                    for el in els {
                        if el.get("type").and_then(|t| t.as_str()) == Some("image") {
                            images += 1;
                        }
                    }
                }
            }
        }
        eprintln!("[TEST] slides_ok path={} elements={} images={}", path, elements, images);
        // 把生成的 JSON 落盘，便于肉眼核对缺了什么
        let _ = std::fs::write(std::env::temp_dir().join("pptx_test_out.json"), &json);
        // 打印每个图片元素的坐标，核对分组内图片是否落在合理范围（非 0,0）
        if let Some(arr) = v.get("slides").and_then(|s| s.as_array()) {
            for (i, s) in arr.iter().enumerate() {
                if let Some(els) = s.get("elements").and_then(|e| e.as_array()) {
                    for el in els {
                        if el.get("type").and_then(|t| t.as_str()) == Some("image") {
                            let x = el.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            let y = el.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            let w = el.get("w").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            let h = el.get("h").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            eprintln!("[TEST]   slide {} image x={:.1} y={:.1} w={:.1} h={:.1}", i, x, y, w, h);
                        }
                    }
                }
            }
        }
        if let Some(arr) = v.get("slides").and_then(|s| s.as_array()) {
            for (i, s) in arr.iter().enumerate() {
                if let Some(els) = s.get("elements").and_then(|e| e.as_array()) {
                    let kinds: Vec<&str> = els.iter().filter_map(|e| e.get("type").and_then(|t| t.as_str())).collect();
                    eprintln!("[TEST] slide {} kinds={:?}", i, kinds);
                }
            }
        }
        assert!(images > 0, "应至少提取到 1 张图片，实际 {}", images);
    }
}

// ========= 公开入口 =========

/// `media_dir`：导入图片的落盘目录（通常 app_data/pptx_media）。图片以本地文件形式存储，
/// src 仅记录路径，前端用 asset: 协议加载，避免 base64 内联造成内存/JSON 体积爆炸。
pub fn pptx_to_json(bytes: &[u8], media_dir: &std::path::Path) -> Result<String, String> {
    let cursor = Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor)
        .map_err(|e| format!("无法打开 pptx 文件（可能非 zip 格式）: {}", e))?;

    let pres_xml = read_zip_entry(&mut archive, "ppt/presentation.xml")?;
    let pres_rels_xml = read_zip_entry(&mut archive, "ppt/_rels/presentation.xml.rels")
        .unwrap_or_default();
    let mut sld_names = parse_slide_order(&pres_xml, &pres_rels_xml);

    // 兜底：若按 rels 未映射出任何幻灯片（rels 缺失/异常），扫描 zip 内实际存在的
    // slideN.xml，按编号排序作为顺序，确保仍能导入而非直接失败。
    if sld_names.is_empty() {
        let mut nums: Vec<usize> = Vec::new();
        for i in 0..archive.len() {
            if let Ok(f) = archive.by_index(i) {
                let n = f.name();
                if let Some(rest) = n.strip_prefix("ppt/slides/slide") {
                    if let Some(num) = rest.strip_suffix(".xml") {
                        if let Ok(v) = num.parse::<usize>() {
                            nums.push(v);
                        }
                    }
                }
            }
        }
        nums.sort_unstable();
        sld_names = nums.into_iter().map(|n| format!("slide{}", n)).collect();
    }

    if sld_names.is_empty() {
        return Err("未找到任何幻灯片".into());
    }

    // 读取真实幻灯片尺寸 `<p:sldSz cx cy>`（EMU），用于等比铺满 960×540 画布。
    // 缺省按 16:9（12192000×6858000 EMU）。
    let slide_w = xml_attr(&pres_xml, "p:sldSz", "cx")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(12192000);
    let slide_h = xml_attr(&pres_xml, "p:sldSz", "cy")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(6858000);
    let xf = make_xform(slide_w, slide_h);

    // 主题色表（schemeClr → hex），供形状/线条/背景/单元格填充的主题色解析。
    let theme = build_theme_colors(&mut archive);

    let mut slides: Vec<Value> = Vec::new();
    for name in &sld_names {
        let slide_xml = read_zip_entry(&mut archive, &format!("ppt/slides/{}.xml", name))?;
        let rels = {
            let rels_path = format!("ppt/slides/_rels/{}.xml.rels", name);
            read_zip_entry(&mut archive, &rels_path)
                .map(|r| parse_rels(&r))
                .unwrap_or_default()
        };
        let slide = parse_slide(&slide_xml, &rels, &mut archive, media_dir, &xf, slide_w, slide_h, &theme)?;
        slides.push(slide);
    }

    let result = json!({ "slides": slides, "sections": [] });
    Ok(result.to_string())
}
