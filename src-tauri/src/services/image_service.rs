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
    let thumb_path = cache_dir.join(format!("{:016x}.jpg", hash));

    if thumb_path.exists() {
        return Ok(thumb_path.to_string_lossy().to_string());
    }

    let img = image::open(&image_path)
        .map_err(|e| format!("打开图片失败: {}", e))?;
    let thumb = img.thumbnail(width, width * 10);
    thumb.save(&thumb_path)
        .map_err(|e| format!("保存缩略图失败: {}", e))?;
    Ok(thumb_path.to_string_lossy().to_string())
}
