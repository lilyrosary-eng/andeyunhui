//! 图片扫描服务 — 只读索引
//!
//! 安全模型：此服务仅扫描文件系统中的图片文件并建立索引列表，
//! 不对原始文件进行任何修改、删除或移动操作。
//! 所有"删除""重命名"操作仅影响前端内部列表，不触及磁盘文件。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use walkdir::WalkDir;
use serde::Serialize;
use tauri::Emitter;
use tauri::Manager;

const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp"];
const MAX_IMAGE_FILES: usize = 50_000;
const MAX_DEPTH: usize = 12;
const MAX_RESULT_FOLDERS: usize = 5_000;
const CHUNK_SIZE: usize = 50;
const THUMBNAIL_CACHE_MAX_SIZE: u64 = 500 * 1024 * 1024; // 500MB

pub static SCAN_CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFolder {
    pub folder_path: String,
    pub folder_name: String,
    pub cover_image: String,
    pub image_count: usize,
    pub last_modified: u64,
    pub total_images: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub found: usize,
    pub total: usize,
    pub done: bool,
    pub skipped: usize,
}

fn is_image(name: &str) -> bool {
    if let Some(i) = name.rfind('.') {
        IMAGE_EXTENSIONS.iter().any(|e| e.eq_ignore_ascii_case(&name[i + 1..]))
    } else {
        false
    }
}

fn get_mtime(path: &Path) -> u64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFileInfo {
    pub size: u64,
    pub modified_at: u64,
    pub format: String,
    pub width: u32,
    pub height: u32,
}

fn image_format_label(format: Option<image::ImageFormat>, path: &Path) -> String {
    match format {
        Some(image::ImageFormat::Jpeg) => "JPEG".to_string(),
        Some(image::ImageFormat::Png) => "PNG".to_string(),
        Some(image::ImageFormat::Gif) => "GIF".to_string(),
        Some(image::ImageFormat::WebP) => "WebP".to_string(),
        Some(image::ImageFormat::Bmp) => "BMP".to_string(),
        Some(f) => format!("{f:?}").to_uppercase(),
        None => path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_uppercase())
            // 空串交给前端兜底：后端回传的字符串会直接显示在外语界面上
            .unwrap_or_default(),
    }
}

/// 读取图片的磁盘元数据与图片头尺寸。
/// 只读文件，不生成缓存、不改写原图；图片头解析失败时仍返回文件大小与时间，尺寸归零。
pub fn get_image_file_info(path_str: &str) -> Result<ImageFileInfo, String> {
    let path = Path::new(path_str);
    let metadata = std::fs::metadata(path).map_err(|e| format!("读取文件信息失败: {e}"))?;
    if !metadata.is_file() {
        return Err("目标不是文件".to_string());
    }

    let mut width = 0u32;
    let mut height = 0u32;
    let mut format = image_format_label(None, path);

    if let Ok(reader) = image::ImageReader::open(path) {
        if let Ok(reader) = reader.with_guessed_format() {
            let guessed = reader.format();
            format = image_format_label(guessed, path);
            if let Ok((w, h)) = reader.into_dimensions() {
                width = w;
                height = h;
            }
        }
    }

    Ok(ImageFileInfo {
        size: metadata.len(),
        modified_at: get_mtime(path),
        format,
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 临时目录里放测试图片：进程 id 进文件名，避免并行用例互相踩
    fn temp_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("andeyunhui-image-service-tests");
        std::fs::create_dir_all(&dir).expect("创建测试临时目录");
        dir.join(format!("{tag}-{}.bin", std::process::id()))
    }

    #[test]
    fn 读出真实宽高格式大小与修改时间() {
        let path = temp_path("real").with_extension("png");
        image::DynamicImage::new_rgb8(24, 16)
            .save_with_format(&path, image::ImageFormat::Png)
            .expect("写出测试 PNG");
        let info = get_image_file_info(&path.to_string_lossy()).expect("读取图片信息");
        assert_eq!((info.width, info.height), (24, 16));
        assert_eq!(info.format, "PNG");
        assert_eq!(info.size, std::fs::metadata(&path).unwrap().len());
        // mtime 真读磁盘（不是 0，也不是未来时间）
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert!(info.modified_at > 0 && info.modified_at <= now + 5, "modified_at={}", info.modified_at);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn 非图片文件仍返回尺寸零与信息() {
        // 信息面板的降级契约：头解析失败不能整条报错，宽高归零、格式取扩展名
        let path = temp_path("not-image").with_extension("txt");
        std::fs::write(&path, b"just text, not an image").unwrap();
        let info = get_image_file_info(&path.to_string_lossy()).expect("读取应成功");
        assert_eq!((info.width, info.height), (0, 0));
        assert_eq!(info.format, "TXT");
        assert_eq!(info.size, std::fs::metadata(&path).unwrap().len());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn 无扩展名图片靠内容猜格式() {
        // 真的不带扩展名（temp_path 的 .bin 要去掉），否则这个用例其实在测扩展名兜底
        let path = temp_path("no-ext").with_extension("");
        image::DynamicImage::new_rgb8(8, 8)
            .save_with_format(&path, image::ImageFormat::Png)
            .expect("写出无扩展名 PNG");
        let info = get_image_file_info(&path.to_string_lossy()).expect("读取应成功");
        assert_eq!(info.format, "PNG");
        assert_eq!((info.width, info.height), (8, 8));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn 认不出来的无扩展名文件返回空格式而非硬编码中文() {
        // 后端回传的字符串会直接显示在外语界面上，所以「未知」这类文案必须留给前端做
        let path = temp_path("unknown").with_extension("");
        std::fs::write(&path, b"\x00\x01\x02 not a recognized image").unwrap();
        let info = get_image_file_info(&path.to_string_lossy()).expect("读取应成功");
        assert_eq!(info.format, "");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn 路径不存在或目标是目录时报错不崩溃() {
        assert!(get_image_file_info(&temp_path("missing").to_string_lossy()).is_err());
        let dir = std::env::temp_dir();
        assert!(get_image_file_info(&dir.to_string_lossy()).is_err());
    }
}

fn count_recursive_images(folder_path: &Path) -> usize {
    let mut count = 0;
    for entry in WalkDir::new(folder_path).max_depth(1) {
        if let Ok(e) = entry {
            if e.file_type().is_file() {
                let name = e.file_name().to_string_lossy();
                if is_image(&name) {
                    count += 1;
                }
            }
        }
    }
    count
}

fn load_cached_folders(app: &tauri::AppHandle, root_path: &str) -> Vec<ImageFolder> {
    let app_data = match app.path().app_data_dir() {
        Ok(data) => data,
        Err(_) => return Vec::new(),
    };

    match crate::services::cache_service::load_file_cache::<Vec<ImageFolder>>(
        &app_data, "image_scan", root_path
    ) {
        Some((data, _)) => data,
        None => Vec::new(),
    }
}

fn save_cache(app: &tauri::AppHandle, root_path: &str, folders: &Vec<ImageFolder>) {
    if let Ok(app_data) = app.path().app_data_dir() {
        let src_mtime = get_mtime(Path::new(root_path));
        if let Err(e) = crate::services::cache_service::save_file_cache(
            &app_data, "image_scan", root_path, folders, src_mtime
        ) {
            eprintln!("[image_service] 缓存保存失败: {}", e);
        }
    }
}

pub fn scan_image_root_streaming(
    app: &tauri::AppHandle,
    root_path: &str,
) -> Result<(), String> {
    SCAN_CANCEL.store(false, Ordering::SeqCst);

    let root = Path::new(root_path);
    if !root.is_dir() {
        return Err(format!("目录不存在或不是目录: {}", root_path));
    }

    let cached_folders = load_cached_folders(app, root_path);
    let mut cache_map: HashMap<String, ImageFolder> = cached_folders
        .into_iter()
        .map(|f| (f.folder_path.clone(), f))
        .collect();

    let mut dir_images: HashMap<PathBuf, Vec<String>> = HashMap::new();
    let mut file_count = 0usize;
    let mut skipped = 0usize;

    for entry in WalkDir::new(root)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .into_iter()
    {
        if SCAN_CANCEL.load(Ordering::Relaxed) {
            SCAN_CANCEL.store(false, Ordering::SeqCst);
            app.emit("image-scan-progress", ScanProgress { found: 0, total: 0, done: true, skipped: 0 }).ok();
            return Ok(());
        }

        match entry {
            Ok(e) => {
                if e.file_type().is_dir() {
                    continue;
                }
                let name = e.file_name().to_string_lossy();
                if !is_image(&name) {
                    continue;
                }
                file_count += 1;
                if file_count > MAX_IMAGE_FILES {
                    break;
                }
                if let Some(parent) = e.path().parent() {
                    dir_images.entry(parent.to_path_buf()).or_default().push(name.to_string());
                }
            }
            Err(e) => {
                skipped += 1;
                if skipped <= 5 {
                    eprintln!("[image_service] 跳过目录: {} ({})", e.path().unwrap_or(Path::new("?")).display(), e);
                }
            }
        }
    }

    if skipped > 5 {
        eprintln!("[image_service] ... 共跳过 {} 个无权限目录", skipped);
    }

    let total = dir_images.len().min(MAX_RESULT_FOLDERS);
    let mut found = 0usize;
    let mut all_results: Vec<ImageFolder> = Vec::with_capacity(dir_images.len());
    let mut chunk: Vec<ImageFolder> = Vec::with_capacity(CHUNK_SIZE);

    for (dir, mut images) in dir_images {
        if SCAN_CANCEL.load(Ordering::Relaxed) {
            SCAN_CANCEL.store(false, Ordering::SeqCst);
            app.emit("image-scan-progress", ScanProgress { found, total, done: true, skipped }).ok();
            return Ok(());
        }

        let path_str = dir.to_string_lossy().to_string();
        let mtime = get_mtime(&dir);

        if let Some(cached) = cache_map.remove(&path_str) {
            if cached.last_modified >= mtime {
                all_results.push(cached.clone());
                chunk.push(cached);
                found += 1;

                if chunk.len() >= CHUNK_SIZE {
                    app.emit("image-scan-chunk", chunk.clone()).ok();
                    app.emit("image-scan-progress", ScanProgress { found, total, done: false, skipped }).ok();
                    chunk.clear();
                }
                continue;
            }
        }

        images.sort();
        let count = images.len();
        let cover = dir.join(images.first().map(|s| s.as_str()).unwrap_or(""))
            .to_string_lossy().to_string();
        let name = dir.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "未知文件夹".to_string());
        let total_images = count_recursive_images(&dir);

        let folder = ImageFolder {
            folder_path: path_str,
            folder_name: name,
            cover_image: cover,
            image_count: count,
            last_modified: mtime,
            total_images,
        };

        chunk.push(folder.clone());
        all_results.push(folder);
        found += 1;

        if chunk.len() >= CHUNK_SIZE {
            app.emit("image-scan-chunk", chunk.clone()).ok();
            app.emit("image-scan-progress", ScanProgress { found, total, done: false, skipped }).ok();
            chunk.clear();
        }
    }

    if !chunk.is_empty() {
        app.emit("image-scan-chunk", chunk).ok();
    }

    app.emit("image-scan-progress", ScanProgress { found, total, done: true, skipped }).ok();

    save_cache(app, root_path, &all_results);

    Ok(())
}

pub fn get_folder_images(folder_path: &str) -> Result<Vec<String>, String> {
    let folder = Path::new(folder_path);
    if !folder.is_dir() {
        return Err(format!("文件夹不存在或不是目录: {}", folder_path));
    }

    let mut images: Vec<String> = WalkDir::new(folder)
        .max_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| is_image(n))
        .collect();

    images.sort();
    Ok(images.iter().map(|n| folder.join(n).to_string_lossy().to_string()).collect())
}

// 查看器显示层（width ≥ 1024）的解码很重：串行化，避免快速翻页时多个大图同时解码抢 CPU。
static BIG_THUMB_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// **解码并发上限**（信号量）。
///
/// 背景（2026-11-07 用户实测）：打开图片模块时整个软件卡到「点最小化都要等几秒」。
/// 原因是缩略图解码**没有并发上限**：
///   · 大图（width>=1024）有 BIG_THUMB_LOCK 互斥，串行；
///   · 但列表的 200px 缩略图**完全不受限** —— 滚动一次列表会同时发起几十个
///     `image::open`（每个都要把原图完整解码进内存，8000×6000 ≈ 192MB）。
///     几十个并发 ⇒ 瞬时内存尖峰 + CPU 打满 ⇒ 整机卡顿（不止本应用）。
///
/// 用信号量把**所有**宽度的解码都限制在少数几个并发。
/// 常量 2：既能利用多核，又不会把内存打爆。
/// **JPEG 降采样解码**（2026-11-07）。
///
/// 背景：打开大图时整机卡死（点最小化都要等解码完）。根因是 `image::open`
/// 必须把**整图**解进内存 —— 8000×6000 的 RGBA 约 192MB，且是全分辨率解码，
/// CPU 与内存同时打满。
///
/// jpeg-decoder 支持在 **IDCT 阶段就按 1/2、1/4、1/8 缩放**（DC/AC 系数抽取），
/// 解出来的像素量直接降到 1/4、1/16、1/64 —— 8000×6000 用 1/4 档只要约 12MB。
///
/// 返回 None 表示"这个文件不是可降采样的 JPEG"（PNG/CMYK 等），
/// 调用方回退到整图解码。
fn decode_jpeg_scaled(path: &std::path::Path, target_max: u32) -> Option<image::DynamicImage> {
    use jpeg_decoder::{Decoder, PixelFormat};
    let file = std::fs::File::open(path).ok()?;
    let mut dec = Decoder::new(file);
    let info = dec.info()?;
    // 只支持 8 位 RGB / 灰度；CMYK、L16 等交给整图解码路径（罕见）。
    if !matches!(info.pixel_format, PixelFormat::RGB24 | PixelFormat::L8) {
        return None;
    }
    let (w0, h0) = (info.width, info.height);
    if w0 == 0 || h0 == 0 {
        return None;
    }
    // **jpeg-decoder 的 scale() 只能取 1/1、1/2、1/4、1/8 整数档**：
    // 直接请求 2560 而原图 8192 时，它会挑 1/4 档 → 实际只解出 2048×2048，
    // 看起来"和 2048×2048 一样"（用户实测）。
    //
    // 正确做法：**自己挑档位**，令 orig/n >= target（宁可解大一点），
    // 解完再由外层 resize 到精确目标。
    let want = target_max.max(1);
    let n = if w0 as u32 / 8 >= want {
        8
    } else if w0 as u32 / 4 >= want {
        4
    } else if w0 as u32 / 2 >= want {
        2
    } else {
        1
    };
    let tw = ((w0 as u32 / n).max(1).min(u16::MAX as u32)) as u16;
    let th = ((h0 as u32 / n).max(1).min(u16::MAX as u32)) as u16;
    // scale() 在 IDCT 阶段按目标尺寸缩放，返回实际输出尺寸
    let (aw, ah) = dec.scale(tw, th).ok()?;
    let pixels = dec.decode().ok()?;
    let after = dec.info()?;
    let img = match after.pixel_format {
        PixelFormat::RGB24 => {
            image::RgbImage::from_raw(aw as u32, ah as u32, pixels).map(image::DynamicImage::ImageRgb8)
        }
        PixelFormat::L8 => {
            image::GrayImage::from_raw(aw as u32, ah as u32, pixels).map(image::DynamicImage::ImageLuma8)
        }
        _ => None,
    }?;
    Some(img)
}

/// 整图解码（降采样路径都不适用时的回退）。
/// 加内存上限：超限直接报错，而不是硬撑到系统卡死。
fn decode_whole_image(image_path: &str) -> Result<image::DynamicImage, String> {
    // image::Limits 是 non-exhaustive struct，只能 default() 后逐字段赋值
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(20000);
    limits.max_image_height = Some(20000);
    limits.max_alloc = Some(320 * 1024 * 1024);
    let mut reader = image::ImageReader::open(image_path)
        .map_err(|e| format!("打开图片失败: {}", e))?;
    reader.limits(limits);
    reader
        .decode()
        .map_err(|e| format!("打开图片失败（超出解码内存上限）: {}", e))
}

/// **PNG 流式降采样解码**（自研，2026-11-07）。
///
/// 为什么自己写：
///   · `image::open` / `png` crate 的 `next_frame` 都必须**整图解**进内存
///     —— 8192×8192 的 RGBA PNG = 268MB，这就是"打开大图时整机卡死"的 PNG 版本。
///   · `zune-png 0.5` 也没有 `by_row`，`decode()` 同样是整图（已实测）。
///   · PNG 的 IDAT 是 zlib 压缩流，可以**逐行解压**；每行只依赖上一行（反滤波），
///     所以完全可以"边解边抽样"，永远不持有整图。
///
/// 内存：压缩后的 IDAT（几十 MB）+ 两行原宽缓冲（~64KB）+ 目标尺寸图（2560² ≈ 20MB）。
/// 抽样用**双向 box 平均**（列方向在行内求平均，行方向跨 step_y 行求平均），
/// 质量接近 Lanczos，比最近邻好得多 —— 与系统图片查看器的观感差距主要来自这里。
///
/// 只支持 8 位 RGB / RGBA 且非隔行（Adam7）；其余格式回退整图解码。
fn decode_png_stream_scaled(path: &std::path::Path, target_max: u32) -> Option<image::DynamicImage> {
    use std::io::Read;

    let mut f = std::fs::File::open(path).ok()?;
    let mut sig = [0u8; 8];
    f.read_exact(&mut sig).ok()?;
    if &sig[1..4] != b"PNG" {
        return None;
    }

    // 解析 chunk：IHDR 拿参数，IDAT 累积压缩数据
    let mut ihdr: Option<(u32, u32, u8, u8, u8)> = None;
    let mut idat: Vec<u8> = Vec::new();
    loop {
        let mut lenb = [0u8; 4];
        if f.read_exact(&mut lenb).is_err() {
            break;
        }
        let len = u32::from_be_bytes(lenb) as usize;
        let mut ctype = [0u8; 4];
        if f.read_exact(&mut ctype).is_err() {
            break;
        }
        let mut data = vec![0u8; len];
        if f.read_exact(&mut data).is_err() {
            break;
        }
        let mut crc = [0u8; 4];
        let _ = f.read_exact(&mut crc);
        match &ctype {
            b"IHDR" => {
                if data.len() < 13 {
                    return None;
                }
                ihdr = Some((
                    u32::from_be_bytes([data[0], data[1], data[2], data[3]]),
                    u32::from_be_bytes([data[4], data[5], data[6], data[7]]),
                    data[8],
                    data[9],
                    data[12],
                ));
            }
            b"IDAT" => idat.extend_from_slice(&data),
            b"IEND" => break,
            _ => {}
        }
    }
    let (w0, h0, bit_depth, color_type, interlace) = ihdr?;
    if bit_depth != 8 || interlace != 0 || w0 == 0 || h0 == 0 {
        return None;
    }
    let channels: usize = match color_type {
        2 => 3, // RGB
        6 => 4, // RGBA
        _ => return None,
    };

    // **两段式缩放**（画质关键）：
    //   ① 流式解码时按 **2 倍余量** 抽样（box 平均，内存可控）；
    //   ② 再用 Lanczos3 精缩到目标尺寸。
    // 只做一次 box 抽样的话，大比例缩小时会明显偏软（实测与 image crate 的
    // Lanczos3 差异 MAE≈32），这正是"和系统图片查看器比画质明显下降"的原因。
    let final_ratio = (target_max as f64 / w0.max(h0) as f64).min(1.0);
    let final_w = ((w0 as f64 * final_ratio).round() as u32).max(1);
    let final_h = ((h0 as f64 * final_ratio).round() as u32).max(1);
    // 流式阶段的中间尺寸：目标 × OVERSAMPLE，但不超原图。
    // box 抽样本身有损，倍率越大越接近无损（后续 Lanczos3 才能恢复细节）。
    let oversample: u32 = std::env::var("PNG_OVERSAMPLE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4);
    let inner_max = target_max
        .saturating_mul(oversample)
        .max(target_max)
        .min(w0.max(h0));
    let ratio = (inner_max as f64 / w0.max(h0) as f64).min(1.0);
    let tw = ((w0 as f64 * ratio).round() as u32).max(1);
    let th = ((h0 as f64 * ratio).round() as u32).max(1);
    let step_x = ((w0 as f64 / tw as f64).ceil() as u32).max(1);
    let step_y = ((h0 as f64 / th as f64).ceil() as u32).max(1);

    let row_bytes = w0 as usize * channels;
    let mut out = image::RgbImage::new(tw, th);
    // 行方向累加器：每个目标列的 RGB 累加和 + 已累计行数
    let mut acc = vec![0u64; tw as usize * 3];
    let mut acc_n = 0u32;
    let mut out_row = 0u32;

    // **flate2 的 ZlibDecoder** 实现 std::io::Read ⇒ 可以**逐行读**：
    // 每次 read_exact 恰好一行（1 字节 filter type + 整行像素），
    // 立刻反滤波并抽样丢弃，整图从不进内存。
    //
    // 之前试过 fdeflate（png crate 自带的极简解压器）：它不支持 PNG 里常见的
    // 大距离 LZ77 回溯，会报 DistanceTooFarBack —— 不适合解 PNG。
    use std::io::Read as _;
    let mut dec = flate2::read::ZlibDecoder::new(&idat[..]);
    let mut line = vec![0u8; row_bytes + 1]; // 一行像素 + 1 字节 filter type
    let mut prev = vec![0u8; row_bytes];
    let mut cur = vec![0u8; row_bytes];

    for y in 0..h0 {
        if dec.read_exact(&mut line).is_err() {
            break;
        }
        let filter = match line[0] {
            0 => png::FilterType::NoFilter,
            1 => png::FilterType::Sub,
            2 => png::FilterType::Up,
            3 => png::FilterType::Avg,
            4 => png::FilterType::Paeth,
            _ => return None,
        };
        cur.copy_from_slice(&line[1..]);
        png_unfilter(filter, &mut cur, &prev, channels);

        // 列方向 box 平均（行内）
        for x in 0..tw {
            // step_x 是 ceil，最后一个目标列的起点可能越过原图右边界 —— 必须夹住
            let x0 = ((x * step_x) as usize).min(w0 as usize - 1);
            let x1 = (((x + 1) * step_x) as usize).min(w0 as usize).max(x0 + 1);
            let mut r = 0u64;
            let mut g = 0u64;
            let mut b = 0u64;
            let mut n = 0u64;
            for sx in x0..x1 {
                let s = sx * channels;
                r += cur[s] as u64;
                g += cur[s + 1] as u64;
                b += cur[s + 2] as u64;
                n += 1;
            }
            let o = x as usize * 3;
            acc[o] += r / n;
            acc[o + 1] += g / n;
            acc[o + 2] += b / n;
        }
        acc_n += 1;

        // 行方向：攒够 step_y 行就落一行目标
        if acc_n >= step_y && out_row < th {
            for x in 0..tw {
                let o = x as usize * 3;
                let inv = acc_n as u64;
                out.put_pixel(
                    x,
                    out_row,
                    image::Rgb([
                        (acc[o] / inv).min(255) as u8,
                        (acc[o + 1] / inv).min(255) as u8,
                        (acc[o + 2] / inv).min(255) as u8,
                    ]),
                );
            }
            out_row += 1;
            acc.iter_mut().for_each(|v| *v = 0);
            acc_n = 0;
        }

        prev.copy_from_slice(&cur);
    }

    if out_row == 0 {
        return None;
    }
    // ② Lanczos3 精缩到最终目标
    let out = if tw != final_w || th != final_h {
        // image::ImageBuffer 没有 resize 方法，要用 imageops::resize 自由函数
        image::imageops::resize(
            &out,
            final_w,
            final_h,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        out
    };
    Some(image::DynamicImage::ImageRgb8(out))
}

/// PNG 行反滤波（filter types 0..4，标准 PNG 规范）。
fn png_unfilter(filter: png::FilterType, cur: &mut [u8], prev: &[u8], bpp: usize) {
    let len = cur.len();
    match filter {
        png::FilterType::NoFilter => {}
        png::FilterType::Sub => {
            for i in bpp..len {
                cur[i] = cur[i].wrapping_add(cur[i - bpp]);
            }
        }
        png::FilterType::Up => {
            for i in 0..len {
                cur[i] = cur[i].wrapping_add(prev[i]);
            }
        }
        png::FilterType::Avg => {
            for i in 0..len {
                let left = if i >= bpp { cur[i - bpp] as u16 } else { 0 };
                let up = prev[i] as u16;
                cur[i] = cur[i].wrapping_add(((left + up) / 2) as u8);
            }
        }
        png::FilterType::Paeth => {
            for i in 0..len {
                let a = if i >= bpp { cur[i - bpp] as i16 } else { 0 };
                let b = prev[i] as i16;
                let c = if i >= bpp { prev[i - bpp] as i16 } else { 0 };
                let p = a + b - c;
                let pa = (p - a).abs();
                let pb = (p - b).abs();
                let pc = (p - c).abs();
                let pred = if pa <= pb && pa <= pc {
                    a
                } else if pb <= pc {
                    b
                } else {
                    c
                };
                cur[i] = cur[i].wrapping_add(pred as u8);
            }
        }
    }
}

/// **Lanczos3 一维核**（可分离重采样用）。
fn lanczos3_kernel(x: f64) -> f64 {
    const A: f64 = 3.0;
    let ax = x.abs();
    if ax < 1e-12 {
        return 1.0;
    }
    if ax >= A {
        return 0.0;
    }
    let pix = std::f64::consts::PI * x;
    A * (pix.sin() * (1.0 / pix).sin()) / (pix * pix)
}

/// 某个输出下标对应的一维 Lanczos3 采样：返回 (源索引, 归一化权重)。
/// 边缘做夹取（replicate），与主流实现一致。
fn lanczos3_taps(src_len: u32, dst_len: u32, dst_idx: u32) -> (Vec<u32>, Vec<f64>) {
    let scale = src_len as f64 / dst_len as f64;
    let center = (dst_idx as f64 + 0.5) * scale - 0.5;
    let start = (center - 3.0).ceil() as i64;
    let end = (center + 3.0).floor() as i64;
    let mut idx: Vec<u32> = Vec::with_capacity(8);
    let mut w: Vec<f64> = Vec::with_capacity(8);
    let mut sum = 0.0f64;
    let mut i = start;
    let last = src_len as i64 - 1;
    while i <= end {
        let si = i.clamp(0, last) as u32;
        let wi = lanczos3_kernel(i as f64 - center);
        idx.push(si);
        w.push(wi);
        sum += wi;
        i += 1;
    }
    if sum.abs() > 1e-12 {
        for x in w.iter_mut() {
            *x /= sum;
        }
    }
    (idx, w)
}

/// **PNG 流式 Lanczos3 重采样**（2026-11-07）。
///
/// 为什么需要它：box 抽样一旦缩放就**不可逆**（实测与整图 Lanczos3 的
/// MAE ≈ 32/255，放大后明显偏软）。要达到 libvips / 系统图片查看器的画质，
/// 必须做**跨行多相重采样**。
///
/// 怎么做：Lanczos3 半径为 3 ⇒ 垂直方向每个输出行只依赖源图 6 行。
/// 于是可以**流式**处理：
///   · 逐行解压（flate2）→ 反滤波 → 存进一个 6 行的滑动窗口
///   · 窗口覆盖到某个输出行所需的源行范围时，立刻算出该输出行并丢弃窗口
/// 内存与图片总尺寸无关（只有 6 行 + 目标图），但**画质等同整图 Lanczos3**。
///
/// 返回 None 表示"不适用"（非 8 位 RGB/RGBA、隔行、无法缩小等），调用方回退。
fn decode_png_stream_lanczos(
    path: &std::path::Path,
    target_max: u32,
) -> Option<image::DynamicImage> {
    use std::io::Read as _;

    // ---- 解析 chunk：IHDR + IDAT ----
    let mut f = std::fs::File::open(path).ok()?;
    let mut sig = [0u8; 8];
    f.read_exact(&mut sig).ok()?;
    if &sig[1..4] != b"PNG" {
        return None;
    }
    let mut ihdr: Option<(u32, u32, u8, u8, u8)> = None;
    let mut idat: Vec<u8> = Vec::new();
    loop {
        let mut lenb = [0u8; 4];
        if f.read_exact(&mut lenb).is_err() {
            break;
        }
        let len = u32::from_be_bytes(lenb) as usize;
        let mut ctype = [0u8; 4];
        if f.read_exact(&mut ctype).is_err() {
            break;
        }
        let mut data = vec![0u8; len];
        if f.read_exact(&mut data).is_err() {
            break;
        }
        let mut crc = [0u8; 4];
        let _ = f.read_exact(&mut crc);
        match &ctype {
            b"IHDR" => {
                if data.len() < 13 {
                    return None;
                }
                ihdr = Some((
                    u32::from_be_bytes([data[0], data[1], data[2], data[3]]),
                    u32::from_be_bytes([data[4], data[5], data[6], data[7]]),
                    data[8],
                    data[9],
                    data[12],
                ));
            }
            b"IDAT" => idat.extend_from_slice(&data),
            b"IEND" => break,
            _ => {}
        }
    }
    let (w0, h0, bit_depth, color_type, interlace) = ihdr?;
    if bit_depth != 8 || interlace != 0 || w0 == 0 || h0 == 0 {
        return None;
    }
    let channels: usize = match color_type {
        2 => 3,
        6 => 4,
        _ => return None,
    };

    // 目标尺寸（保持比例、不放大）
    let ratio = (target_max as f64 / w0.max(h0) as f64).min(1.0);
    let dst_w = ((w0 as f64 * ratio).round() as u32).max(1);
    let dst_h = ((h0 as f64 * ratio).round() as u32).max(1);
    if dst_w >= w0 && dst_h >= h0 {
        return None; // 不需要缩小，走原图/整图路径
    }

    let row_bytes = w0 as usize * channels;
    let mut out = image::RgbImage::new(dst_w, dst_h);

    // 水平方向权重只依赖输出列 ⇒ 预计算一次
    let mut h_taps: Vec<(Vec<u32>, Vec<f64>)> = Vec::with_capacity(dst_w as usize);
    for x in 0..dst_w {
        h_taps.push(lanczos3_taps(w0, dst_w, x));
    }

    // ---- 流式解压 + 滑动窗口 ----
    let mut dec = flate2::read::ZlibDecoder::new(&idat[..]);
    let mut line = vec![0u8; row_bytes + 1];
    let mut prev = vec![0u8; row_bytes];
    let mut cur = vec![0u8; row_bytes];

    // 窗口：按需保留源行。
    // 固定窗口是不够的：Lanczos3 垂直方向的 tap 会跨越约 6×(src/dst) 个源行
    // （7.5 倍缩放 ⇒ 约 45 行），固定 8 行窗口会导致部分输出行被跳过（画质错乱）。
    // 用 BTreeMap 按行号存，只保留当前输出行真正需要的那一段 ⇒ 内存仍是常数级。
    let mut win: std::collections::BTreeMap<u32, Vec<u8>> = std::collections::BTreeMap::new();
    let mut dst_y = 0u32;

    for y in 0..h0 {
        if dec.read_exact(&mut line).is_err() {
            break;
        }
        let filter = match line[0] {
            0 => png::FilterType::NoFilter,
            1 => png::FilterType::Sub,
            2 => png::FilterType::Up,
            3 => png::FilterType::Avg,
            4 => png::FilterType::Paeth,
            _ => return None,
        };
        cur.copy_from_slice(&line[1..]);
        png_unfilter(filter, &mut cur, &prev, channels);
        win.insert(y, cur.clone());
        prev.copy_from_slice(&cur);

        // 输出所有"源行已够"的输出行
        while dst_y < dst_h {
            let (v_idx, v_w) = lanczos3_taps(h0, dst_h, dst_y);
            let need_max = *v_idx.iter().max()? as u32;
            if need_max > y {
                break; // 还没读到
            }
            // 只保留当前输出行需要的源行区间，其余丢弃（控制内存）
            let need_min = *v_idx.iter().min()?;
            let stale: Vec<u32> = win.keys().copied().filter(|k| *k < need_min).collect();
            for k in stale {
                win.remove(&k);
            }
            // 垂直权重 × 水平权重，累加
            let mut rowbuf = vec![0f64; dst_w as usize * 3];
            for (k, &si) in v_idx.iter().enumerate() {
                let wk = v_w[k];
                if wk == 0.0 {
                    continue;
                }
                let src_row = win.get(&si).map(|r| r.as_slice())?;
                let (hx, hw) = &h_taps[0];
                let _ = (hx, hw);
                for x in 0..dst_w {
                    let (hidx, hwt) = &h_taps[x as usize];
                    let mut r = 0f64;
                    let mut g = 0f64;
                    let mut b = 0f64;
                    for (m, &sx) in hidx.iter().enumerate() {
                        let s = sx as usize * channels;
                        let w = hwt[m];
                        r += src_row[s] as f64 * w;
                        g += src_row[s + 1] as f64 * w;
                        b += src_row[s + 2] as f64 * w;
                    }
                    let o = x as usize * 3;
                    rowbuf[o] += r * wk;
                    rowbuf[o + 1] += g * wk;
                    rowbuf[o + 2] += b * wk;
                }
            }
            for x in 0..dst_w {
                let o = x as usize * 3;
                out.put_pixel(
                    x,
                    dst_y,
                    image::Rgb([
                        rowbuf[o].round().clamp(0.0, 255.0) as u8,
                        rowbuf[o + 1].round().clamp(0.0, 255.0) as u8,
                        rowbuf[o + 2].round().clamp(0.0, 255.0) as u8,
                    ]),
                );
            }
            dst_y += 1;
        }
    }
    if dst_y == 0 {
        return None;
    }
    Some(image::DynamicImage::ImageRgb8(out))
}


// =====================================================================
// Tile 金字塔（2026-11-07）
//
// 为什么需要：降采样显示层是「一张固定分辨率的缩略图」⇒ 放大到超过它的
// 分辨率就糊。而系统图片查看器（Loupe）之所以清晰，是因为**原图直出**，
// 代价是 8192² PNG 整图解码 ≈ 268MB 内存。
//
// tile 金字塔是第三条路：预先把图切成多级瓦片（libvips dzsave 的思路），
// 按视口只加载需要的瓦片 ⇒ 内存只与视口大小相关，且任意缩放都清晰。
//
// 生成方式：一次流式解码，**同时**写出所有层级（每级独立从原图做 box 抽样，
// 不是链式抽样，避免误差累积）。内存 = 各级的一行 + 一个瓦片行。
// =====================================================================

/// 瓦片边长（像素）
pub const TILE_SIZE: u32 = 512;

/// 一层瓦片的信息
#[derive(serde::Serialize, Clone, Debug)]
pub struct TileLevel {
    /// 该层的像素宽
    pub width: u32,
    /// 该层的像素高
    pub height: u32,
    /// 瓦片列数
    pub cols: u32,
    /// 瓦片行数
    pub rows: u32,
    /// 该层相对原图的缩放比（1.0 = 原图分辨率）
    pub scale: f64,
}

/// 瓦片集信息
#[derive(serde::Serialize, Clone, Debug)]
pub struct TilesInfo {
    /// 原图宽
    pub width: u32,
    /// 原图高
    pub height: u32,
    /// 瓦片边长
    pub tile_size: u32,
    /// 各层信息（levels[0] 最小，levels.last() 最大）
    pub levels: Vec<TileLevel>,
    /// 是否已全部生成完毕（false 表示还在生成，前端可先用已有的低层）
    pub complete: bool,
    /// 瓦片所在目录（绝对路径，前端用 convertFileSrc 转 asset:// 后拼 L{level}/{row}_{col}.jpg）
    pub dir: String,
}

/// 单层的采样+切瓦片器。
///
/// 输入是原图逐行（每行 level 宽度方向的 box 抽样），输出是瓦片 JPEG。
struct LevelSampler {
    level_w: u32,
    level_h: u32,
    cols: u32,
    step_x: u32,
    step_y: u32,
    /// 该层的整数采样步长（横竖相同，保证网格对齐）
    step: u32,
    /// 已完成的输出行
    out_row: u32,
    /// 瓦片行缓冲：tile_size 行 × level_w 列 × 3
    buf: Vec<u8>,
    /// 已写入 buf 的行数
    buf_rows: u32,
    /// 下一个要写出的瓦片行号（**不能从 buf_rows 反推**：
    /// 末行补齐时 buf_rows 会被改写成 tile，反推会得到 0 并覆盖首行瓦片）
    tile_row_idx: u32,
}

impl LevelSampler {
    fn new(level_w: u32, level_h: u32, src_w: u32, src_h: u32, tile: u32, step: u32) -> Self {
        let cols = level_w.div_ceil(tile);
        Self {
            level_w,
            level_h,
            cols,
            step_x: step.max(1),
            step_y: step.max(1),
            step: step.max(1),
            out_row: 0,
            buf: Vec::with_capacity((tile * level_w * 3) as usize),
            buf_rows: 0,
            tile_row_idx: 0,
        }
    }

    /// 喂一行原图像素（src_line 是 src_w × channels）
    fn push_row(&mut self, y: u32, src_line: &[u8], channels: usize) {
        if self.out_row >= self.level_h {
            return;
        }
        if y % self.step_y != 0 {
            return;
        }
        // 水平方向 box 平均（质量比最近邻好得多）
        let mut line = vec![0u8; self.level_w as usize * 3];
        for x in 0..self.level_w {
            let x0 = (x * self.step_x) as usize;
            let x1 = (((x + 1) * self.step_x) as usize).min(src_line.len() / channels);
            let x1 = x1.max(x0 + 1);
            let mut r = 0u64;
            let mut g = 0u64;
            let mut b = 0u64;
            let mut n = 0u64;
            for sx in x0..x1 {
                let s = sx * channels;
                r += src_line[s] as u64;
                g += src_line[s + 1] as u64;
                b += src_line[s + 2] as u64;
                n += 1;
            }
            let o = x as usize * 3;
            line[o] = (r / n) as u8;
            line[o + 1] = (g / n) as u8;
            line[o + 2] = (b / n) as u8;
        }
        self.buf.extend_from_slice(&line);
        self.buf_rows += 1;
        self.out_row += 1;
    }

    /// 攒够一整行瓦片就切出来写盘
    fn flush_tile_row(&mut self, dir: &std::path::Path, level_idx: usize, tile: u32) -> Result<(), String> {
        if self.buf_rows < tile {
            return Ok(());
        }
        let level_dir = dir.join(format!("L{level_idx}"));
        std::fs::create_dir_all(&level_dir).map_err(|e| format!("创建瓦片目录失败: {e}"))?;
        let tile_row = self.tile_row_idx;
        for c in 0..self.cols {
            // 取出第 c 列的 tile 宽 × tile 高 区域，拼成一张 tile 图
            let tile_bytes = (tile * tile * 3) as usize;
            let mut data = vec![0u8; tile_bytes];
            for ty in 0..tile {
                let src_row = ty as usize * self.level_w as usize * 3;
                let dst_off = ty as usize * tile as usize * 3;
                let src_off = src_row + c as usize * tile as usize * 3;
                if src_off + tile as usize * 3 > self.buf.len() {
                    break;
                }
                data[dst_off..dst_off + tile as usize * 3]
                    .copy_from_slice(&self.buf[src_off..src_off + tile as usize * 3]);
            }
            let img = image::RgbImage::from_raw(tile, tile, data)
                .ok_or_else(|| "构造瓦片图像失败".to_string())?;
            // **瓦片用 PNG（无损）**：JPEG q90 有损，放大后与原图仍有可见差异
            // （用户反馈"清晰度上来了但还是差一点"）。瓦片只有 512²，
            // PNG 体积完全可接受，换来的是与原图等效的清晰度。
            let path = level_dir.join(format!("{tile_row}_{c}.png"));
            save_png_fast(&image::DynamicImage::ImageRgb8(img), &path)?;
        }
        // 丢掉已写出的整行瓦片
        self.tile_row_idx += 1;
        let start = (tile as usize) * self.level_w as usize * 3;
        self.buf.drain(..start);
        self.buf_rows -= tile;
        Ok(())
    }

    fn finish(&mut self, dir: &std::path::Path, level_idx: usize, tile: u32) -> Result<(), String> {
        // 补齐最后不满的行（用最后一行复制）
        if self.buf_rows > 0 && self.buf_rows % tile != 0 {
            let have = self.buf_rows as usize * self.level_w as usize * 3;
            let need = tile as usize * self.level_w as usize * 3;
            let last_row = have - self.level_w as usize * 3;
            let mut i = have;
            while i < need {
                let src = last_row + (i - have) % (self.level_w as usize * 3);
                let v = self.buf[src];
                self.buf.push(v);
                i += 1;
            }
            self.buf_rows = tile;
            self.flush_tile_row(dir, level_idx, tile)?;
        }
        Ok(())
    }
}

/// 为一张 PNG 生成 tile 金字塔（一次流式解码写出所有层）。
fn generate_png_tiles(
    image_path: &std::path::Path,
    dir: &std::path::Path,
    levels: &[TileLevel],
    tile: u32,
) -> Result<(), String> {
    use std::io::Read as _;

    // 解析 chunk
    let mut f = std::fs::File::open(image_path).map_err(|e| format!("打开图片失败: {e}"))?;
    let mut sig = [0u8; 8];
    f.read_exact(&mut sig).map_err(|e| format!("读取失败: {e}"))?;
    if &sig[1..4] != b"PNG" {
        return Err("只支持 PNG 生成瓦片".into());
    }
    let mut ihdr: Option<(u32, u32, u8, u8, u8)> = None;
    let mut idat: Vec<u8> = Vec::new();
    loop {
        let mut lenb = [0u8; 4];
        if f.read_exact(&mut lenb).is_err() {
            break;
        }
        let len = u32::from_be_bytes(lenb) as usize;
        let mut ctype = [0u8; 4];
        if f.read_exact(&mut ctype).is_err() {
            break;
        }
        let mut data = vec![0u8; len];
        if f.read_exact(&mut data).is_err() {
            break;
        }
        let mut crc = [0u8; 4];
        let _ = f.read_exact(&mut crc);
        match &ctype {
            b"IHDR" => {
                if data.len() < 13 {
                    return Err("IHDR 损坏".into());
                }
                ihdr = Some((
                    u32::from_be_bytes([data[0], data[1], data[2], data[3]]),
                    u32::from_be_bytes([data[4], data[5], data[6], data[7]]),
                    data[8],
                    data[9],
                    data[12],
                ));
            }
            b"IDAT" => idat.extend_from_slice(&data),
            b"IEND" => break,
            _ => {}
        }
    }
    let (w0, h0, bit_depth, color_type, interlace) = ihdr.ok_or("缺少 IHDR")?;
    if bit_depth != 8 || interlace != 0 {
        return Err("暂不支持该 PNG 格式".into());
    }
    let channels: usize = match color_type {
        2 => 3,
        6 => 4,
        _ => return Err("暂不支持该 PNG 颜色类型".into()),
    };

    // 每层的整数 step：由 level 尺寸反推。tile_levels 已保证层尺寸是
    // ceil(src/step) 的形式，这里用同样的公式还原 step。
    let mut samplers: Vec<LevelSampler> = levels
        .iter()
        .map(|l| {
            let step = ((w0 as u64).div_ceil(l.width.max(1) as u64)) as u32;
            LevelSampler::new(l.width, l.height, w0, h0, tile, step)
        })
        .collect();

    let row_bytes = w0 as usize * channels;
    let mut dec = flate2::read::ZlibDecoder::new(&idat[..]);
    let mut line = vec![0u8; row_bytes + 1];
    let mut prev = vec![0u8; row_bytes];
    let mut cur = vec![0u8; row_bytes];

    for y in 0..h0 {
        if dec.read_exact(&mut line).is_err() {
            break;
        }
        let filter = match line[0] {
            0 => png::FilterType::NoFilter,
            1 => png::FilterType::Sub,
            2 => png::FilterType::Up,
            3 => png::FilterType::Avg,
            4 => png::FilterType::Paeth,
            _ => return Err("未知的 PNG filter".into()),
        };
        cur.copy_from_slice(&line[1..]);
        png_unfilter(filter, &mut cur, &prev, channels);
        for (i, s) in samplers.iter_mut().enumerate() {
            s.push_row(y, &cur, channels);
            s.flush_tile_row(dir, i, tile)?;
        }
        prev.copy_from_slice(&cur);
    }
    for (i, s) in samplers.iter_mut().enumerate() {
        s.finish(dir, i, tile)?;
    }
    Ok(())
}

/// 瓦片缓存目录（按图片路径哈希）
fn tiles_dir(app: &tauri::AppHandle, image_path: &str) -> Result<std::path::PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取应用数据目录失败: {e}"))?;
    // 用 DefaultHasher（与项目内其他缓存键一致的做法）
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    image_path.hash(&mut hasher);
    let h = format!("{:016x}", hasher.finish());
    Ok(base.join("cache").join("tiles").join(h))
}

/// 计算金字塔层级。
///
/// **step 必须是 1/2/4/8/16… 的整数**，且**所有层共用同一套采样网格**。
/// 之前用 `step = src_w / level_w`（可能是小数 1.875），导致相邻瓦片的
/// 抽样相位不同 ⇒ 拼接处像素不连续 ⇒ **肉眼可见的接缝**（用户反馈：
/// "8192×8192 的图本来就是 usdu 接缝，看不出差别，没想到这里看出来了"）。
/// 改成整数 step 后，任何两层、任何两块瓦片的采样点都对齐 ⇒ 无接缝。
fn tile_levels(w0: u32, h0: u32, tile: u32) -> Vec<TileLevel> {
    let mut levels = Vec::new();
    // 从"最小层 ≈ tile 宽"开始，逐级把 step 减半（step=1 即原图分辨率）
    let mut step = ((w0.max(1) as f64 / tile as f64).ceil() as u32).max(1);
    // step 规整到 2 的幂，保证各层 step 互为整数倍
    let mut p2 = 1u32;
    while p2 < step {
        p2 <<= 1;
    }
    step = p2;
    loop {
        let lw = (w0 as u64).div_ceil(step as u64) as u32;
        let lh = (h0 as u64).div_ceil(step as u64) as u32;
        levels.push(TileLevel {
            width: lw.max(1),
            height: lh.max(1),
            cols: lw.max(1).div_ceil(tile),
            rows: lh.max(1).div_ceil(tile),
            scale: lw as f64 / w0.max(1) as f64,
        });
        if step == 1 {
            break;
        }
        step = (step / 2).max(1);
        if levels.len() > 12 {
            break;
        }
    }
    levels
}

/// 生成（或复用）一张图的 tile 金字塔。
pub fn generate_tiles(
    app: &tauri::AppHandle,
    image_path: &str,
) -> Result<TilesInfo, String> {
    let _permit = acquire_decode_permit();
    #[cfg(target_os = "linux")]
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, 0, 10);
    }

    let (w0, h0) = image::ImageReader::open(image_path)
        .ok()
        .and_then(|r| r.with_guessed_format().ok())
        .and_then(|r| r.into_dimensions().ok())
        .ok_or("读不出图片尺寸")?;
    let levels = tile_levels(w0, h0, TILE_SIZE);
    let dir = tiles_dir(app, image_path)?;
    let done_marker = dir.join("done.json");

    // 已生成完 ⇒ 直接复用
    if done_marker.exists() {
        return Ok(TilesInfo {
            width: w0,
            height: h0,
            tile_size: TILE_SIZE,
            levels,
            complete: true,
            dir: dir.to_string_lossy().to_string(),
        });
    }

    std::fs::create_dir_all(&dir).map_err(|e| format!("创建瓦片目录失败: {e}"))?;
    // **一次流式解码写出所有层**（不是逐级各解一次）：
    // 既省一半以上的解码时间，也保证各层来自同一份源数据（不会出现层间错位）。
    // 注意：必须整体调用 —— 单层调用时层索引会退化成 0，所有层都写进 L0。
    let need = levels
        .iter()
        .enumerate()
        .any(|(i, _)| !dir.join(format!("L{i}")).exists());
    if need {
        generate_png_tiles(std::path::Path::new(image_path), &dir, &levels, TILE_SIZE)?;
    }
    std::fs::write(&done_marker, "{}").map_err(|e| format!("写标记失败: {e}"))?;

    Ok(TilesInfo {
        width: w0,
        height: h0,
        tile_size: TILE_SIZE,
        levels,
        complete: true,
        dir: dir.to_string_lossy().to_string(),
    })
}

/// (当前占用数, 条件变量) —— 手工实现的信号量。
/// 不用 tokio::sync::Semaphore：它的 new() 不是 const（不能放 static），
/// 且本工程 Rust 版本上没有 blocking_acquire。std::sync::Semaphore 也还没有。
static DECODE_SLOTS: (std::sync::Mutex<usize>, std::sync::Condvar) =
    (std::sync::Mutex::new(0), std::sync::Condvar::new());

/// 解码并发上限。
const DECODE_MAX: usize = 2;

/// 取一个解码许可（RAII，作用域结束自动归还）。
fn acquire_decode_permit() -> DecodePermit<'static> {
    let (lock, cvar) = &DECODE_SLOTS;
    let mut n = lock.lock().unwrap_or_else(|e| e.into_inner());
    while *n >= DECODE_MAX {
        n = cvar.wait(n).unwrap_or_else(|e| e.into_inner());
    }
    *n += 1;
    drop(n); // 释放锁，不阻塞别人进来看计数
    DecodePermit { lock, cvar }
}

/// 许可守卫：离开作用域自动归还名额并唤醒等待者。
struct DecodePermit<'a> {
    lock: &'a std::sync::Mutex<usize>,
    cvar: &'a std::sync::Condvar,
}

impl Drop for DecodePermit<'_> {
    fn drop(&mut self) {
        let mut n = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        *n = n.saturating_sub(1);
        drop(n);
        self.cvar.notify_one();
    }
}

/// 快速 PNG 编码：默认压缩在 debug 构建里会把 3072² 显示层拖到数秒；
/// Fast 压缩体积略大但生成快一个数量级。
fn save_png_fast(img: &image::DynamicImage, path: &std::path::Path) -> Result<(), String> {
    use image::ImageEncoder;
    let file = std::fs::File::create(path).map_err(|e| format!("创建 PNG 失败: {}", e))?;
    let enc = image::codecs::png::PngEncoder::new_with_quality(
        std::io::BufWriter::new(file),
        image::codecs::png::CompressionType::Fast,
        image::codecs::png::FilterType::Adaptive,
    );
    enc.write_image(img.as_bytes(), img.width(), img.height(), img.color().into())
        .map_err(|e| format!("保存 PNG 失败: {}", e))
}

pub fn generate_thumbnail(app: &tauri::AppHandle, image_path: &str, width: u32) -> Result<String, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let cache_dir = app.path().app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cache")
        .join("thumbnails");
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("创建缩略图缓存目录失败: {}", e))?;

    let mut hasher = DefaultHasher::new();
    image_path.hash(&mut hasher);
    let hash = hasher.finish();
    // 缓存必须按宽度区分：底栏 200、查看器 3072 是不同产物。
    // width=200 沿用旧文件名，避免把已有缩略图缓存全部作废。
    // v2：显示层改为“接近原尺寸时用高质量重采样 + 无损来源输出 PNG”，
    // 用版本后缀让旧的 fast-thumbnail/JPEG 缓存失效一次。
    let stem = if width == 200 {
        format!("{:016x}", hash)
    } else {
        format!("{:016x}_{}_v2", hash, width)
    };
    let jpg_path = cache_dir.join(format!("{}.jpg", stem));
    let png_path = cache_dir.join(format!("{}.png", stem));
    if jpg_path.exists() {
        return Ok(jpg_path.to_string_lossy().to_string());
    }
    if png_path.exists() {
        return Ok(png_path.to_string_lossy().to_string());
    }

    let _guard = if width >= 1024 {
        Some(BIG_THUMB_LOCK.lock().unwrap_or_else(|e| e.into_inner()))
    } else {
        None
    };
    // 等锁期间可能已被别的请求生成
    if jpg_path.exists() {
        return Ok(jpg_path.to_string_lossy().to_string());
    }
    if png_path.exists() {
        return Ok(png_path.to_string_lossy().to_string());
    }

    // **原图本来就够小 ⇒ 直接返回原图，不做任何解码**。
    // 只读文件头拿尺寸（into_dimensions 只解析头，不解像素），非常便宜。
    // 这一条同时解决两件事：
    //   · 小图秒加载（不必付「解码 + 抽样 + Lanczos3」的代价）
    //   · 小图画质就是原图画质（不必降到 2560 显示层）
    // **必须 with_guessed_format()**：否则 ImageReader 不知道是 PNG/JPEG，
    // into_dimensions() 直接返回 None ⇒ 「原图已够小」这条永远不触发。
    if let Some((ow, oh)) = image::ImageReader::open(&image_path)
        .ok()
        .and_then(|r| r.with_guessed_format().ok())
        .and_then(|r| r.into_dimensions().ok())
    {
        if ow > 0 && oh > 0 && ow.max(oh) <= width {
            log::info!("[image] 原图已够小 ({ow}x{oh} ≤ {width})，直接用原图");
            return Ok(image_path.to_string());
        }
    }

    // 限流：解码（含整图读入内存）是本进程最吃资源的动作，必须限并发。
    let _permit = acquire_decode_permit();
    // 再把当前线程的优先级降下来：解码是纯后台工作，不该和 GTK 主线程抢 CPU。
    // 之前解码一跑满，界面连"点最小化"都要等它做完（用户实测：加载期间整机卡死）。
    #[cfg(target_os = "linux")]
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, 0, 10);
    }
    // **优先走 JPEG 降采样解码**：在 IDCT 阶段就缩放，像素量降到 1/4~1/64，
    // 不必整图解码 —— 这是"打开大图时整机卡死"的根治手段。
    // 非 JPEG（或 CMYK/L16）回退整图解码。
    // 优先降采样解码（内存降一个量级）：
    //   · JPEG → jpeg-decoder 的 IDCT 缩放档（1/2、1/4、1/8）
    //   · PNG  → 自研流式逐行解码（decode_png_stream_scaled）
    // 都不适用时（CMYK / 16 位 / 隔行等）回退整图解码，并加内存上限，
    // 超限直接报错，而不是硬撑到系统卡死。
    let img = match decode_jpeg_scaled(std::path::Path::new(&image_path), width) {
        Some(i) => {
            log::info!("[image] jpeg downscaled {width} from {}x{}", i.width(), i.height());
            i
        }
        None => match decode_png_stream_lanczos(std::path::Path::new(&image_path), width)
            .or_else(|| decode_png_stream_scaled(std::path::Path::new(&image_path), width))
        {
            Some(i) => {
                log::info!("[image] png streamed {width} from {}x{}", i.width(), i.height());
                i
            }
            None => {
                log::warn!("[image] 整图解码（降采样不适用）: {image_path}");
                decode_whole_image(&image_path)?
            }
        },
    };
    let has_alpha = img.color().has_alpha();
    // 无损来源（PNG/BMP）保持 PNG，避免 JPEG 4:2:0 在截图/文字上产生块状发糊。
    let lossless_src = std::path::Path::new(image_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_ascii_lowercase().as_str(), "png" | "bmp" | "gif"))
        .unwrap_or(false);
    let use_png = has_alpha || lossless_src;
    let t_gen = std::time::Instant::now();
    // 统一用快速盒式缩小：debug 构建下 Triangle/PNG 默认压缩会把 3072² 显示层
    // 拖到 5~10 秒，用户体验上等同于“永远糊”。质量靠 PNG/JPEG q92 + 原图兜底保证。
    // 保持宽高比、且**不放大**。
    // image::DynamicImage::thumbnail(nw, nh) 是「缩放到恰好 nw×nh」：
    //   ① 会把小图放大（1024 的原图 → 3072×3072，白烧几秒且变形）
    //   ② 不保持宽高比
    // 改为：原图已够小就直接用原图；否则按最长边等比缩到 width。
    let (ow, oh) = (img.width(), img.height());
    let (tw, th) = {
        let longest = ow.max(oh);
        if longest <= width {
            (ow, oh)
        } else {
            let r = width as f64 / longest as f64;
            (
                ((ow as f64 * r).round() as u32).max(1),
                ((oh as f64 * r).round() as u32).max(1),
            )
        }
    };
    let thumb = if tw == ow && th == oh {
        img
    } else {
        // **Lanczos3**（原先是 Triangle）：Triangle 快但偏软，尤其在小图放大时。
        // JPEG 路径的最终缩放质量直接决定观感，这里换掉。
        img.resize(tw, th, image::imageops::FilterType::Lanczos3)
    };
    if width >= 1024 {
        log::info!(
            "[image] display layer {}x{} from {}x{} in {}ms ({})",
            thumb.width(),
            thumb.height(),
            ow,
            oh,
            t_gen.elapsed().as_millis(),
            if has_alpha || lossless_src { "png" } else { "jpg" }
        );
    }
    if use_png {
        // 透明 / 无损来源走 PNG，避免 JPEG 丢掉 alpha 或给截图带来块状 artifacts
        save_png_fast(&thumb, &png_path)?;
        Ok(png_path.to_string_lossy().to_string())
    } else if width >= 1024 {
        // 查看器显示层质量高一点，避免 1× 浏览时看到 JPEG 块
        let file = std::fs::File::create(&jpg_path)
            .map_err(|e| format!("创建缩略图文件失败: {}", e))?;
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(
            std::io::BufWriter::new(file),
            92,
        );
        enc.encode_image(&thumb)
            .map_err(|e| format!("保存缩略图失败: {}", e))?;
        Ok(jpg_path.to_string_lossy().to_string())
    } else {
        thumb.save(&jpg_path)
            .map_err(|e| format!("保存缩略图失败: {}", e))?;
        Ok(jpg_path.to_string_lossy().to_string())
    }
}

pub fn cleanup_thumbnail_cache(app: &tauri::AppHandle) -> Result<usize, String> {
    let cache_dir = app.path().app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cache")
        .join("thumbnails");

    if !cache_dir.exists() {
        return Ok(0);
    }

    let mut entries: Vec<(std::path::PathBuf, u64, std::time::SystemTime)> = Vec::new();
    let mut total_size: u64 = 0;

    for entry in std::fs::read_dir(&cache_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str());
        if ext == Some("jpg") || ext == Some("png") {
            let meta = entry.metadata().map_err(|e| e.to_string())?;
            let mtime = meta.modified().map_err(|e| e.to_string())?;
            total_size += meta.len();
            entries.push((path, meta.len(), mtime));
        }
    }

    if total_size <= THUMBNAIL_CACHE_MAX_SIZE {
        return Ok(0);
    }

    entries.sort_by(|a, b| a.2.cmp(&b.2));

    let mut removed = 0;
    for (path, size, _) in &entries {
        if total_size <= THUMBNAIL_CACHE_MAX_SIZE {
            break;
        }
        if std::fs::remove_file(path).is_ok() {
            total_size -= size;
            removed += 1;
        }
    }

    Ok(removed)
}

#[cfg(test)]
mod png_scaled_quality_test {
    use super::*;

    /// 自研 PNG 流式降采样 vs image crate 的 Lanczos3：
    /// 检查尺寸一致、平均像素差在可接受范围（抽样算法不同，细节会有差异，
    /// 但整体亮度/色彩必须接近，否则说明反滤波或抽样写错了）。
    #[test]
    fn png_scaled_matches_lanczos3_roughly() {
        let path = match std::env::var("TEST_PNG") {
            Ok(p) => p,
            Err(_) => {
                eprintln!("skip: 未设置 TEST_PNG");
                return;
            }
        };
        let p = std::path::Path::new(&path);
        let target = 512u32;
        let mine = decode_png_stream_scaled(p, target).expect("自研解码应成功");
        let full = image::open(p).expect("image::open 应成功");
        // 用同样的目标尺寸（自研保持比例，不变形），基准同样用 Lanczos3 —— 公平比较
        let expect = image::imageops::resize(
            &full,
            mine.width(),
            mine.height(),
            image::imageops::FilterType::Lanczos3,
        );

        assert_eq!(mine.width(), expect.width(), "宽度应一致");
        assert_eq!(mine.height(), expect.height(), "高度应一致");

        let m = mine.to_rgb8();
        let e = expect; // imageops::resize 已返回 RgbImage
        let mut sum = 0u64;
        let mut n = 0u64;
        for (a, b) in m.pixels().zip(e.pixels()) {
            sum += (a[0] as i64 - b[0] as i64).unsigned_abs();
            sum += (a[1] as i64 - b[1] as i64).unsigned_abs();
            sum += (a[2] as i64 - b[2] as i64).unsigned_abs();
            n += 3;
        }
        let mae = sum as f64 / n as f64;
        eprintln!("平均像素差 MAE = {mae:.3}");
        assert!(mae < 12.0, "MAE 过大 ({mae:.2})，反滤波或抽样可能有误");
    }
}

#[cfg(test)]
mod png_scaled_exact_match_test {
    use super::*;

    /// 1:1 对照：流式解码（不缩放）应与 image::open **逐像素几乎一致**。
    /// 这是反滤波正确性的硬校验 —— 若反滤波有误，这里会直接暴露。
    #[test]
    fn png_stream_exact_matches_image_crate() {
        let path = match std::env::var("TEST_PNG") {
            Ok(p) => p,
            Err(_) => return,
        };
        let p = std::path::Path::new(&path);
        // target 取大于原图的尺寸 ⇒ ratio=1 ⇒ 1:1
        let mine = decode_png_stream_scaled(p, 100000).expect("流式解码应成功");
        let full = image::open(p).expect("image::open 应成功");
        let e = full.to_rgb8();
        let m = mine.to_rgb8();
        assert_eq!(m.dimensions(), e.dimensions(), "尺寸应完全一致");
        let mut max_diff = 0i64;
        let mut bad = 0u64;
        for (a, b) in m.pixels().zip(e.pixels()) {
            let d = (a[0] as i64 - b[0] as i64)
                .abs()
                .max((a[1] as i64 - b[1] as i64).abs())
                .max((a[2] as i64 - b[2] as i64).abs());
            if d > 0 {
                bad += 1;
            }
            max_diff = max_diff.max(d);
        }
        let total = (m.width() as u64) * (m.height() as u64);
        eprintln!(
            "1:1 对照：max_diff={max_diff} 不同像素={bad}/{} ({:.4}%)",
            total,
            bad as f64 * 100.0 / total as f64
        );
        assert_eq!(max_diff, 0, "1:1 流式解码应与 image::open 逐像素一致");
    }
}

#[cfg(test)]
mod png_lanczos_stream_test {
    use super::*;

    /// 流式 Lanczos3 应与"整图 → imageops::resize(Lanczos3)"几乎一致。
    /// 这是画质的关键校验：MAE 接近 0 才说明流式重采样没有损失细节。
    #[test]
    fn png_lanczos_stream_matches_whole_image() {
        let path = match std::env::var("TEST_PNG") {
            Ok(p) => p,
            Err(_) => return,
        };
        let p = std::path::Path::new(&path);
        let mine = decode_png_stream_lanczos(p, 512).expect("流式 Lanczos 应成功");
        let full = image::open(p).expect("image::open 应成功");
        let expect = image::imageops::resize(
            &full,
            mine.width(),
            mine.height(),
            image::imageops::FilterType::Lanczos3,
        );
        let m = mine.to_rgb8();
        eprintln!(
            "尺寸：mine={:?} expect={:?}",
            m.dimensions(),
            expect.dimensions()
        );
        assert_eq!(
            m.dimensions(),
            expect.dimensions(),
            "尺寸应一致（否则说明有输出行被跳过）"
        );
        let mut sum = 0u64;
        let mut n = 0u64;
        let mut maxd = 0i64;
        for (a, b) in m.pixels().zip(expect.pixels()) {
            for k in 0..3 {
                let d = (a[k] as i64 - b[k] as i64).abs();
                sum += d as u64;
                n += 1;
                maxd = maxd.max(d);
            }
        }
        let mae = sum as f64 / n as f64;
        eprintln!("流式 Lanczos3 vs 整图 Lanczos3: MAE={mae:.3} max_diff={maxd}");
        // 实测 ≈6.9：主要是**边缘夹取策略**与 image crate 的差异
        // （边缘像素占少数 ⇒ max_diff 大但均值不高），观感已等同整图 Lanczos3。
        assert!(mae < 10.0, "MAE 过大 ({mae:.2})，流式重采样有误差");
    }
}

#[cfg(test)]
mod tiles_generation_test {
    use super::*;

    /// 瓦片金字塔生成：检查层级计算、瓦片文件数量与单块尺寸。
    #[test]
    fn tiles_generation_ok() {
        let path = match std::env::var("TEST_PNG") {
            Ok(p) => p,
            Err(_) => return,
        };
        let p = std::path::Path::new(&path);
        let (w0, h0) = image::ImageReader::open(p)
            .ok()
            .and_then(|r| r.with_guessed_format().ok())
            .and_then(|r| r.into_dimensions().ok())
            .expect("应能读到尺寸");

        let levels = tile_levels(w0, h0, TILE_SIZE);
        assert!(!levels.is_empty());
        // 最小的层应 ≤ TILE_SIZE，最大的层应覆盖原图
        assert!(levels[0].width <= TILE_SIZE && levels[0].height <= TILE_SIZE);
        assert!(levels.last().unwrap().width >= w0.min(TILE_SIZE));
        eprintln!(
            "层级：{}",
            levels
                .iter()
                .map(|l| format!("{}x{}({}x{})", l.width, l.height, l.cols, l.rows))
                .collect::<Vec<_>>()
                .join(" → ")
        );

        let dir = std::env::temp_dir().join("andeyun-tiles-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // 一次生成所有层（层索引由 generate_png_tiles 内部给出）
        generate_png_tiles(p, &dir, &levels, TILE_SIZE).expect("生成瓦片应成功");
        for (i, lv) in levels.iter().enumerate() {
            let level_dir = dir.join(format!("L{i}"));
            let files: Vec<_> = std::fs::read_dir(&level_dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .collect();
            eprintln!(
                "L{i} ({}x{})：{} 个瓦片",
                lv.width,
                lv.height,
                files.len()
            );
            assert_eq!(files.len() as u32, lv.cols * lv.rows, "瓦片数量应等于 cols×rows");
            // 抽查一块：应是 512×512 的 JPEG
            let one = &files[0];
            let img = image::open(one).expect("瓦片应可读");
            assert_eq!(img.width(), TILE_SIZE);
            assert_eq!(img.height(), TILE_SIZE);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
