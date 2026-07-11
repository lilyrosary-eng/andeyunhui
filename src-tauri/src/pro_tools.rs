// ================= 专业模块「薄荷」后端工具命令 =================
// 提供纯前端无法完成的系统 / 转码类能力：环境变量、端口扫描、
// 进程枚举、剪贴板读写、图片格式转换、文档(MD<->HTML)转换、
// 以及调用系统 ffmpeg 进行音视频转码。
use serde::Serialize;

// ============ t15 环境变量 ============
#[tauri::command]
pub fn get_env_vars(filter: Option<String>) -> Result<Vec<(String, String)>, String> {
    let mut vars: Vec<(String, String)> = std::env::vars_os()
        .filter_map(|(k, v)| {
            let k = k.to_str()?.to_string();
            let v = v.to_str()?.to_string();
            Some((k, v))
        })
        .collect();
    vars.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    if let Some(f) = filter {
        let f = f.to_lowercase();
        if !f.is_empty() {
            vars.retain(|(k, _)| k.to_lowercase().contains(&f));
        }
    }
    Ok(vars)
}

#[tauri::command]
pub fn set_env_var(name: String, value: String) -> Result<(), String> {
    if name.is_empty() {
        return Err("环境变量名不能为空".to_string());
    }
    // 仅影响当前进程，不会持久化到系统（Windows 需 setx / 注册表）
    unsafe {
        std::env::set_var(&name, &value);
    }
    Ok(())
}

// ============ t13 端口扫描 ============
#[tauri::command]
pub fn scan_ports(host: String, start: u16, end: u16) -> Result<Vec<u16>, String> {
    let ip: std::net::IpAddr = host
        .parse()
        .map_err(|e| format!("无效的 host「{}」: {}", host, e))?;
    let end = end.max(start);
    let count = (end - start + 1) as usize;
    if count > 2000 {
        return Err("单次扫描端口数过多（最多 2000 个）".to_string());
    }
    let mut open = Vec::new();
    for port in start..=end {
        let addr = std::net::SocketAddr::new(ip, port);
        if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(250)).is_ok() {
            open.push(port);
        }
    }
    Ok(open)
}

// ============ t14 进程管理 ============
#[derive(Serialize)]
pub struct ProcessInfo {
    pid: u32,
    name: String,
    cpu: f32,
    mem_kb: u64,
}

#[tauri::command]
pub fn list_processes() -> Result<Vec<ProcessInfo>, String> {
    use sysinfo::System;
    let sys = System::new_all();
    let mut list: Vec<ProcessInfo> = sys
        .processes()
        .iter()
        .map(|(pid, p)| ProcessInfo {
            pid: pid.as_u32(),
            name: p.name().to_string(),
            cpu: p.cpu_usage(),
            mem_kb: p.memory(),
        })
        .collect();
    list.sort_by(|a, b| b.mem_kb.cmp(&a.mem_kb));
    Ok(list)
}

// ============ t16 剪贴板 ============
#[tauri::command]
pub fn clipboard_read() -> Result<String, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| format!("无法访问剪贴板: {}", e))?;
    cb.get_text().map_err(|e| format!("读取剪贴板失败: {}", e))
}

#[tauri::command]
pub fn clipboard_write(text: String) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| format!("无法访问剪贴板: {}", e))?;
    cb.set_text(text)
        .map_err(|e| format!("写入剪贴板失败: {}", e))
}

// ============ t1 图片格式转换 ============
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use image::{GenericImageView, ImageEncoder, ImageFormat};

fn img_format_from_ext(ext: &str) -> Option<ImageFormat> {
    match ext.to_lowercase().as_str() {
        "png" => Some(ImageFormat::Png),
        "jpg" | "jpeg" => Some(ImageFormat::Jpeg),
        "bmp" => Some(ImageFormat::Bmp),
        "gif" => Some(ImageFormat::Gif),
        "tiff" | "tif" => Some(ImageFormat::Tiff),
        _ => None,
    }
}

#[tauri::command]
pub fn convert_image(
    data_base64: String,
    from_ext: String,
    to_ext: String,
    quality: Option<u8>,
) -> Result<String, String> {
    let from_fmt = img_format_from_ext(&from_ext)
        .ok_or_else(|| format!("不支持的源格式: {}", from_ext))?;
    let to_fmt =
        img_format_from_ext(&to_ext).ok_or_else(|| format!("不支持的目标格式: {}", to_ext))?;
    let bytes = B64
        .decode(data_base64.trim())
        .map_err(|e| format!("Base64 解码失败: {}", e))?;
    let img = image::load_from_memory_with_format(&bytes, from_fmt)
        .map_err(|e| format!("图片解码失败: {}", e))?;
    let mut cursor = std::io::Cursor::new(Vec::new());
    let q = quality.unwrap_or(90).clamp(1, 100) as u8;
    match to_fmt {
        ImageFormat::Jpeg => {
            let (w, h) = img.dimensions();
            let ct = img.color();
            let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, q);
            enc.write_image(img.as_bytes(), w, h, ct.into())
                .map_err(|e| format!("JPEG 编码失败: {}", e))?;
        }
        other => {
            img.write_to(&mut cursor, other)
                .map_err(|e| format!("图片编码失败: {}", e))?;
        }
    }
    let bytes_out = cursor.into_inner();
    Ok(B64.encode(bytes_out))
}

// ============ t2 文档格式转换 (Markdown <-> HTML) ============

/// 轻量 HTML -> Markdown 转换（覆盖常见标签，非完整解析器）
// HTML→MD 正则预编译一次（原先每次调用都重新编译 11 个正则，
// 大 HTML 下成为 O(n×正则数) 的分配/扫描瓶颈）
static RE_H: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r"(?i)<h([1-6])[^>]*>(.*?)</h[1-6]>").unwrap());
static RE_STRONG: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r"(?i)<(strong|b)[^>]*>(.*?)</(strong|b)>").unwrap());
static RE_EM: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r"(?i)<(em|i)[^>]*>(.*?)</(em|i)>").unwrap());
static RE_CODE: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r"(?i)<code[^>]*>(.*?)</code>").unwrap());
static RE_A: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
    regex::Regex::new(r#"(?i)<a[^>]*href="([^"]*)"[^>]*>(.*?)</a>"#).unwrap()
});
static RE_LI: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r"(?i)<li[^>]*>(.*?)</li>").unwrap());
static RE_LIST: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r"(?i)</?(ul|ol)[^>]*>").unwrap());
static RE_END_P: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r"(?i)</p>").unwrap());
static RE_START_P: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r"(?i)<p[^>]*>").unwrap());
static RE_BR: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r"(?i)<br\s*/?>").unwrap());
static RE_TAG: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r"<[^>]+>").unwrap());
static RE_BLANK: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r"\n{3,}").unwrap());

fn html_to_md(html: &str) -> String {
    let mut s = html.to_string();
    s = RE_H
        .replace_all(&s, |caps: &regex::Captures| {
            let lvl: usize = caps[1].parse().unwrap_or(1);
            format!("\n\n{} {}\n\n", "#".repeat(lvl), &caps[2])
        })
        .to_string();
    s = RE_STRONG.replace_all(&s, "**$2**").to_string();
    s = RE_EM.replace_all(&s, "*$2*").to_string();
    s = RE_CODE.replace_all(&s, "`$1`").to_string();
    s = RE_A.replace_all(&s, "[$2]($1)").to_string();
    s = RE_LI.replace_all(&s, "- $1\n").to_string();
    s = RE_LIST.replace_all(&s, "\n").to_string();
    s = RE_END_P.replace_all(&s, "\n\n").to_string();
    s = RE_START_P.replace_all(&s, "").to_string();
    s = RE_BR.replace_all(&s, "\n").to_string();
    s = RE_TAG.replace_all(&s, "").to_string();
    s = s
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&nbsp;", " ");
    RE_BLANK
        .replace_all(&s, "\n\n")
        .to_string()
        .trim()
        .to_string()
}

#[tauri::command]
pub fn convert_document(text: String, from: String, to: String) -> Result<String, String> {
    let from = from.to_lowercase();
    let to = to.to_lowercase();
    if from == to {
        return Ok(text);
    }
    match (from.as_str(), to.as_str()) {
        ("md", "html") => {
            let parser = pulldown_cmark::Parser::new_ext(&text, pulldown_cmark::Options::all());
            let mut out = String::new();
            pulldown_cmark::html::push_html(&mut out, parser);
            Ok(out)
        }
        ("html", "md") => Ok(html_to_md(&text)),
        _ => Err(format!("不支持的转换: {} -> {}", from, to)),
    }
}

// ============ t3 / t4 音视频转码 (ffmpeg) ============
#[tauri::command]
pub fn check_ffmpeg() -> bool {
    std::process::Command::new("ffmpeg")
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[tauri::command]
pub fn transcode_media(input_path: String, output_format: String) -> Result<String, String> {
    if !check_ffmpeg() {
        return Err("未检测到 ffmpeg，无法转码。请在系统中安装 ffmpeg 后重试。".to_string());
    }
    let path = std::path::Path::new(&input_path);
    if !path.exists() {
        return Err(format!("输入文件不存在: {}", input_path));
    }
    let ext = output_format.to_lowercase();
    let out_path = path.with_extension(&ext);
    let out_str = out_path.to_string_lossy().to_string();
    let status = std::process::Command::new("ffmpeg")
        .arg("-y")
        .arg("-i")
        .arg(&input_path)
        .arg(&out_str)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .status()
        .map_err(|e| format!("启动 ffmpeg 失败: {}", e))?;
    if !status.success() {
        return Err("ffmpeg 转码失败，请检查输入文件格式或安装完整的 ffmpeg。".to_string());
    }
    Ok(out_str)
}
