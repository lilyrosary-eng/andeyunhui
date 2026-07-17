// ================= 专业模块「薄荷」后端工具命令 =================
// 作为内部依赖包（pro-tools-kit crate）独立存在，由主程序通过 path dependency 引入。
//
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
// 文本读写：arboard 在 MTA 线程下 OleInitialize 可能静默失败，但纯文本路径会
// 回退到 Win32 OpenClipboard + GetClipboardData(CF_UNICODETEXT)，不依赖 OLE，可靠。
// 图片写入在主 crate screenshot.rs 的 clipboard_write_image 中用 Win32 API 实现。

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

/// 读取剪贴板图片，返回 base64 data URL（PNG）。无图片时返回 None。
/// arboard 的 get_image 使用 GetClipboardData(CF_DIB)，不依赖 OLE，读取可靠。
#[tauri::command]
pub fn clipboard_read_image() -> Result<Option<String>, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| format!("无法访问剪贴板: {}", e))?;
    match cb.get_image() {
        Ok(img) => {
            let w = img.width as u32;
            let h = img.height as u32;
            // arboard 返回 RGBA，用 image crate 编码为 PNG
            let mut buf = Vec::with_capacity(img.bytes.len() / 2 + 4096);
            let encoder = image::codecs::png::PngEncoder::new(&mut buf);
            encoder
                .write_image(&img.bytes, w, h, image::ExtendedColorType::Rgba8)
                .map_err(|e| format!("PNG 编码失败: {}", e))?;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
            Ok(Some(format!("data:image/png;base64,{}", b64)))
        }
        Err(_) => Ok(None), // 剪贴板无图片（不视为错误）
    }
}

/// 清空系统剪贴板
#[tauri::command]
pub fn clipboard_clear() -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| format!("无法访问剪贴板: {}", e))?;
    cb.clear().map_err(|e| format!("清空剪贴板失败: {}", e))
}

// ============ 剪贴板图片高效轮询 ============
// 注意：clipboard_poll_image 已迁移至主 crate screenshot.rs 中实现，
// 使用 Win32 API（不依赖 OLE）+ spawn_blocking，避免 arboard 在 MTA 线程下
// OleInitialize 失败 + 同步命令阻塞主线程的问题。
// 此处仅保留注释说明迁移原因，避免命令名冲突。

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
// ffmpeg 路径解析：优先 external-deps/全局/ffmpeg/ffmpeg.exe（随应用打包），
// 回退到系统 PATH 中的 ffmpeg。
// 与主 crate recording_service::get_ffmpeg_path 逻辑一致，但 pro-tools-kit 是
// 独立 crate，无法调用主 crate 的 get_external_deps_dir，故在此独立实现。
use tauri::Manager;

fn get_ffmpeg_path(app: &tauri::AppHandle) -> String {
    // 1. 打包后：resource_dir/external-deps/全局/ffmpeg/ffmpeg.exe
    if let Ok(resource_dir) = app.path().resource_dir() {
        let ffmpeg = resource_dir
            .join("external-deps")
            .join("全局")
            .join("ffmpeg")
            .join("ffmpeg.exe");
        if ffmpeg.exists() {
            return ffmpeg.to_string_lossy().to_string();
        }
        // Tauri 打包时 external-deps 可能在 _up_ 下
        let ffmpeg_up = resource_dir
            .join("_up_")
            .join("external-deps")
            .join("全局")
            .join("ffmpeg")
            .join("ffmpeg.exe");
        if ffmpeg_up.exists() {
            return ffmpeg_up.to_string_lossy().to_string();
        }
    }
    // 2. 开发模式：CARGO_MANIFEST_DIR/../../external-deps/全局/ffmpeg/ffmpeg.exe
    // CARGO_MANIFEST_DIR = crates/pro-tools-kit/，../../ = 项目根
    let dev_ffmpeg = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("external-deps")
        .join("全局")
        .join("ffmpeg")
        .join("ffmpeg.exe");
    if dev_ffmpeg.exists() {
        return dev_ffmpeg.to_string_lossy().to_string();
    }
    // 3. 回退到系统 PATH
    "ffmpeg".to_string()
}

#[tauri::command]
pub fn check_ffmpeg(app: tauri::AppHandle) -> bool {
    let path = get_ffmpeg_path(&app);
    std::process::Command::new(&path)
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[tauri::command]
pub fn transcode_media(
    app: tauri::AppHandle,
    input_path: String,
    output_format: String,
) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path(&app);
    // 检查 ffmpeg 是否可用（用解析出的路径，不回退系统 PATH）
    let ok = std::process::Command::new(&ffmpeg_path)
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        return Err(
            "未检测到 ffmpeg，无法转码。请确保 external-deps/全局/ffmpeg/ffmpeg.exe 存在。"
                .to_string(),
        );
    }
    let path = std::path::Path::new(&input_path);
    if !path.exists() {
        return Err(format!("输入文件不存在: {}", input_path));
    }
    let ext = output_format.to_lowercase();
    let out_path = path.with_extension(&ext);
    let out_str = out_path.to_string_lossy().to_string();
    let status = std::process::Command::new(&ffmpeg_path)
        .arg("-y")
        .arg("-i")
        .arg(&input_path)
        .arg(&out_str)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| format!("启动 ffmpeg 失败: {}", e))?;
    if !status.success() {
        return Err("ffmpeg 转码失败，请检查输入文件格式或安装完整的 ffmpeg。".to_string());
    }
    Ok(out_str)
}

// ============ t4 音频 → MIDI 转写（basic-pitch，MIT） ============
// ffmpeg 只能做格式封装互转，无法把音频「转写」成 MIDI；
// MIDI 转写需专门的音频转写库，这里用 MIT 协议的 basic-pitch（Python + TensorFlow）。
// 流程：先用 bundled ffmpeg 把输入统一转成单声道 44.1k wav，再起 Python 子进程跑 basic-pitch 转写。
#[tauri::command]
pub async fn audio_to_midi(app: tauri::AppHandle, input_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let ffmpeg_path = get_ffmpeg_path(&app);
        if !std::process::Command::new(&ffmpeg_path)
            .arg("-version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            return Err("未检测到 ffmpeg，无法预处理音频。".to_string());
        }
        let input = std::path::Path::new(&input_path);
        if !input.exists() {
            return Err(format!("输入文件不存在: {}", input_path));
        }
        // 归一化到单声道 44.1k wav（basic-pitch 推荐输入）
        let wav = input.with_extension("midi_tmp.wav");
        let wav_str = wav.to_string_lossy().to_string();
        let st = std::process::Command::new(&ffmpeg_path)
            .args(["-y", "-i", &input_path, "-ar", "44100", "-ac", "1", &wav_str])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|e| format!("ffmpeg 预处理失败: {}", e))?;
        if !st.success() {
            let _ = std::fs::remove_file(&wav);
            return Err("ffmpeg 预处理音频失败，请检查输入格式。".to_string());
        }
        // 查找 python 可执行文件（优先 python3）
        let py = if std::process::Command::new("python3")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            "python3"
        } else {
            "python"
        };
        // 查找 basic-pitch 转写脚本（与 ffmpeg 同目录推导）
        let mut roots: Vec<std::path::PathBuf> = Vec::new();
        if let Ok(resource_dir) = app.path().resource_dir() {
            roots.push(resource_dir.join("external-deps").join("全局").join("basic-pitch"));
            roots.push(
                resource_dir
                    .join("_up_")
                    .join("external-deps")
                    .join("全局")
                    .join("basic-pitch"),
            );
        }
        roots.push(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("..")
                .join("external-deps")
                .join("全局")
                .join("basic-pitch"),
        );
        let script = roots.iter().map(|r| r.join("transcribe.py")).find(|p| p.exists());
        let script = match script {
            Some(s) => s,
            None => {
                let _ = std::fs::remove_file(&wav);
                return Err(
                    "未找到 basic-pitch 转写脚本（external-deps/全局/basic-pitch/transcribe.py）。\n请先安装：pip install basic-pitch（MIT 协议，需 Python 3.10+）。"
                        .to_string(),
                );
            }
        };
        let out = input.with_extension("mid");
        let out_str = out.to_string_lossy().to_string();
        let res = std::process::Command::new(py)
            .arg(&script)
            .arg(&wav_str)
            .arg(&out_str)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .output()
            .map_err(|e| {
                let _ = std::fs::remove_file(&wav);
                format!(
                    "启动 Python 失败：{}（请确认已安装 Python 3.10+ 与 basic-pitch）",
                    e
                )
            })?;
        let _ = std::fs::remove_file(&wav);
        if !res.status.success() {
            let msg = String::from_utf8_lossy(&res.stderr);
            return Err(format!(
                "MIDI 转写失败：{}\n请确认已 `pip install basic-pitch`（MIT 协议）。",
                msg.lines().last().unwrap_or("未知错误")
            ));
        }
        if !out.exists() {
            return Err("MIDI 转写完成但未生成 .mid 文件。".to_string());
        }
        Ok(out_str)
    })
    .await
    .map_err(|e| format!("MIDI 转写任务失败: {}", e))?
}
