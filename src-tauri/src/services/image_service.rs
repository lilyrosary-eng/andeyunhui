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

    // 限流：解码（含整图读入内存）是本进程最吃资源的动作，必须限并发。
    let _permit = acquire_decode_permit();
    // 再把当前线程的优先级降下来：解码是纯后台工作，不该和 GTK 主线程抢 CPU。
    // 之前解码一跑满，界面连"点最小化"都要等它做完（用户实测：加载期间整机卡死）。
    #[cfg(target_os = "linux")]
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, 0, 10);
    }
    let img = image::open(&image_path)
        .map_err(|e| format!("打开图片失败: {}", e))?;
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
        img.resize(tw, th, image::imageops::FilterType::Triangle)
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
