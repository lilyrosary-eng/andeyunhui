//! .pptx → 演示文件 JSON 逆解析（幻灯片 JSON 格式与 pptx_wps 导出对齐）。
//!
//! 覆盖：背景色、文本框（字号/颜色/粗斜体/对齐/多段落）、形状（prstGeom→shape 映射）、
//! 图片（内嵌 data: URL）。跳过注释、Notes、母版、动画等高级元素。

use std::io::{Cursor, Read};
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
    off_x: f64,
    off_y: f64,
}
fn make_xform(slide_w: i64, slide_h: i64) -> CanvasXform {
    let sw = slide_w as f64;
    let sh = slide_h as f64;
    let scale = (LOGICAL_W / sw).min(LOGICAL_H / sh);
    CanvasXform {
        scale,
        off_x: (LOGICAL_W - sw * scale) / 2.0,
        off_y: (LOGICAL_H - sh * scale) / 2.0,
    }
}
// EMU 偏移 / 尺寸 → 逻辑坐标（含 letterbox 居中偏移）
fn lx(off: i64, xf: &CanvasXform) -> f64 { off as f64 * xf.scale + xf.off_x }
fn ly(off: i64, xf: &CanvasXform) -> f64 { off as f64 * xf.scale + xf.off_y }
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

    // **关键修复（字号错误）**：`<a:rPr sz>` 单位为「百分之一磅」（如 1800 = 18pt），
    // 旧实现当 EMU 处理（`pts_from_emu(v*100)` → v/127 ≈ 0.79×）导致字号偏小错位。
    // 正确换算：sz / 100 = pt。
    let font_size = xml_attr(rpr_str, "a:rPr", "sz")
        .and_then(|v| v.parse::<i64>().ok())
        .map(|v| (v as f64 / 100.0).max(1.0))
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
fn collect_pieces<'a>(node: &'a str, groups: &[GroupXform], out: &mut Vec<Piece<'a>>) {
    let mut search = 0;
    while search < node.len() {
        let rest = &node[search..];
        let sp_at = find_shape_open(rest, "p:sp");
        let pic_at = find_shape_open(rest, "p:pic");
        let gf_at = find_shape_open(rest, "p:graphicFrame");
        let grp_at = find_shape_open(rest, "p:grpSp");
        // 取最早出现的直接子节点
        let chosen: Option<(usize, &str)> = {
            let sp = sp_at.unwrap_or(usize::MAX);
            let pic = pic_at.unwrap_or(usize::MAX);
            let gf = gf_at.unwrap_or(usize::MAX);
            let grp = grp_at.unwrap_or(usize::MAX);
            let mut best = usize::MAX;
            let mut kind: &str = "";
            if sp < best { best = sp; kind = "sp"; }
            if pic < best { best = pic; kind = "pic"; }
            if gf < best { best = gf; kind = "gf"; }
            if grp < best { best = grp; kind = "grp"; }
            if best == usize::MAX { None } else { Some((best, kind)) }
        };
        if let Some((rel_start, kind)) = chosen {
            let abs_start = search + rel_start;
            let close = if kind == "sp" { "</p:sp>" }
                else if kind == "pic" { "</p:pic>" }
                else if kind == "gf" { "</p:graphicFrame>" }
                else { "</p:grpSp>" };
            if let Some(rel_end) = node[abs_start..].find(close) {
                let abs_end = abs_start + rel_end + close.len();
                let raw = &node[abs_start..abs_end];
                if kind == "grp" {
                    if let Some(g) = parse_group_xform(raw) {
                        let mut child_groups = groups.to_vec();
                        child_groups.push(g);
                        let inner = skip_open_tag(raw, "p:grpSp");
                        collect_pieces(inner, &child_groups, out);
                    }
                } else {
                    let rect = apply_chain(groups, local_rect(raw));
                    out.push(Piece { kind, raw, rect });
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
) -> Result<Value, String> {
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

    // 递归收集所有叶子元素（sp/pic/graphicFrame），并应用祖先组合(grpSp)坐标变换，
    // 得到每个元素在幻灯片坐标系下的绝对 EMU 矩形。
    let mut pieces: Vec<Piece> = Vec::new();
    collect_pieces(sp_tree, &[], &mut pieces);

    for p in &pieces {
        let raw = p.raw;
        let rect = p.rect;
        if p.kind == "sp" {
            if let Ok(el) = parse_sp(raw, xf, rect) {
                elements.push(el);
            }
        } else if p.kind == "pic" {
            if let Ok(el) = parse_pic(raw, rels, archive, media_dir, xf, rect) {
                elements.push(el);
            }
        } else if p.kind == "gf" {
            // 表格（graphicFrame）拆解为 shape（单元格底框）+ text（单元格文字），
            // 让导入的表格正确呈现，而非整片丢失/挤成一团。
            let mut tbl_els = parse_graphic_frame(raw, xf, rect);
            elements.append(&mut tbl_els);
        }
    }

    // 从 1 开始 z
    for (i, el) in elements.iter_mut().enumerate() {
        el.as_object_mut().map(|o| { o.insert("z".into(), json!(i + 1)); });
    }

    map.insert("elements".into(), json!(elements));
    Ok(Value::Object(map))
}

fn parse_sp(sp_str: &str, xf: &CanvasXform, rect: (i64, i64, i64, i64)) -> Result<Value, String> {
    let mut el = Map::new();
    el.insert("type".into(), json!("shape"));

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
        // **关键修复（蓝色底框占位）**：旧实现对无显式填充的形状默认 `#dbeafe`（浅蓝），
        // 导致 PPT 中本应透明的文本框/占位符、以及无填充 autoshape 全部变成蓝色方块，
        // 视觉上「丢失的内容变成一片蓝框、挤在一起」。PPT 语义：无填充即透明，故默认 transparent。
        el.insert("fill".into(), json!(fill.unwrap_or_else(|| "transparent".into())));
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

    let (ex, ey, ew, eh) = rect;
    let x = lx(ex, xf).round();
    let y = ly(ey, xf).round();
    let w = lw(ew, xf);
    let h = lh(eh, xf);
    el.insert("x".into(), json!(x));
    el.insert("y".into(), json!(y));
    el.insert("w".into(), json!(w));
    el.insert("h".into(), json!(h));

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
// `rect` 为已应用组合变换的表格整体绝对幻灯片 EMU 矩形（x, y, w, h）；单元格按
// 列宽/行高占比在框内定位，从而分组内的表格也能正确摆放（不再挤在左上）。
fn parse_graphic_frame(gf_str: &str, xf: &CanvasXform, rect: (i64, i64, i64, i64)) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let tbl = match extract_tag(gf_str, "a:tbl") {
        Some(t) => t,
        None => return out,
    };
    let (fx, fy, fw, fh) = rect;

    // 列宽
    let grid = extract_tag(tbl, "a:tblGrid").unwrap_or("");
    let col_w: Vec<i64> = grid
        .split("<a:gridCol")
        .skip(1)
        .filter_map(|s| xml_attr(s, "a:gridCol", "w").and_then(|v| v.parse::<i64>().ok()))
        .collect();
    let total_w = col_w.iter().sum::<i64>().max(1);

    let rows = split_tags(tbl, "a:tr");
    let total_h: i64 = rows
        .iter()
        .map(|r| xml_attr(r, "a:tr", "h").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0))
        .sum::<i64>()
        .max(1);

    // 列宽
    let grid = extract_tag(tbl, "a:tblGrid").unwrap_or("");
    let col_w: Vec<i64> = grid
        .split("<a:gridCol")
        .skip(1)
        .filter_map(|s| xml_attr(s, "a:gridCol", "w").and_then(|v| v.parse::<i64>().ok()))
        .collect();

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

            // 单元格填充（无则透明）
            let tc_pr = extract_tag(cell_str, "a:tcPr").unwrap_or("");
            let fill = srgb_val(tc_pr)
                .map(|c| to_hex(&c))
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
                    let (t, st) = parse_paragraph(p_str);
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
    out
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
    let sld_names = parse_slide_order(&pres_xml)?;

    // 读取真实幻灯片尺寸 `<p:sldSz cx cy>`（EMU），用于等比铺满 960×540 画布。
    // 缺省按 16:9（12192000×6858000 EMU）。
    let slide_w = xml_attr(&pres_xml, "p:sldSz", "cx")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(12192000);
    let slide_h = xml_attr(&pres_xml, "p:sldSz", "cy")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(6858000);
    let xf = make_xform(slide_w, slide_h);

    let mut slides: Vec<Value> = Vec::new();
    for name in &sld_names {
        let slide_xml = read_zip_entry(&mut archive, &format!("ppt/slides/{}.xml", name))?;
        let rels = {
            let rels_path = format!("ppt/slides/_rels/{}.xml.rels", name);
            read_zip_entry(&mut archive, &rels_path)
                .map(|r| parse_rels(&r))
                .unwrap_or_default()
        };
        let slide = parse_slide(&slide_xml, &rels, &mut archive, media_dir, &xf)?;
        slides.push(slide);
    }

    let result = json!({ "slides": slides, "sections": [] });
    Ok(result.to_string())
}
