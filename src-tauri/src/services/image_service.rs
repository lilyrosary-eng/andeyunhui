//! 图片扫描服务 — 只读索引
//!
//! 安全模型：此服务仅扫描文件系统中的图片文件并建立索引列表，
//! 不对原始文件进行任何修改、删除或移动操作。
//! 所有"删除""重命名"操作仅影响前端内部列表，不触及磁盘文件。

use std::collections::{HashMap, HashSet};
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
const CHUNK_SIZE: usize = 50; // 每批推送 50 个文件夹

pub static SCAN_CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFolder {
    pub folder_path: String,
    pub folder_name: String,
    pub cover_image: String,
    pub image_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub found: usize,
    pub total: usize,
    pub done: bool,
}

fn is_image(name: &str) -> bool {
    if let Some(i) = name.rfind('.') {
        IMAGE_EXTENSIONS.iter().any(|e| e.eq_ignore_ascii_case(&name[i + 1..]))
    } else {
        false
    }
}

/// 扫描图片根目录，通过 Tauri 事件流式推送结果
pub fn scan_image_root_streaming(
    app: &tauri::AppHandle,
    root_path: &str,
) -> Result<(), String> {
    SCAN_CANCEL.store(false, Ordering::SeqCst);

    let root = Path::new(root_path);
    if !root.is_dir() {
        return Err(format!("目录不存在或不是目录: {}", root_path));
    }

    // 阶段 1：walkdir 迭代收集图片文件，按父目录分组 (O(n))
    let mut dir_images: HashMap<PathBuf, Vec<String>> = HashMap::new();
    let mut has_subdir: HashSet<PathBuf> = HashSet::new();
    let mut file_count = 0usize;
    let mut skipped = 0usize;

    for entry in WalkDir::new(root)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .into_iter()
    {
        // 取消检查
        if SCAN_CANCEL.load(Ordering::Relaxed) {
            SCAN_CANCEL.store(false, Ordering::SeqCst);
            app.emit("scan-progress", ScanProgress { found: 0, total: 0, done: true }).ok();
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
                    // 标记祖先目录：这些目录有子目录包含图片
                    let mut ancestor = parent.parent();
                    while let Some(a) = ancestor {
                        if a.starts_with(root) {
                            has_subdir.insert(a.to_path_buf());
                        }
                        ancestor = a.parent();
                    }
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

    // 阶段 2：过滤最内层文件夹（目录不在 has_subdir 中 = 叶子节点）
    let total = dir_images.len().min(MAX_RESULT_FOLDERS);
    let mut found = 0usize;

    // 收集叶子目录，排序后分批推送
    let mut leaf_dirs: Vec<(PathBuf, Vec<String>)> = dir_images
        .into_iter()
        .filter(|(dir, _)| !has_subdir.contains(dir))
        .collect();

    leaf_dirs.sort_by(|a, b| {
        let na = a.0.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let nb = b.0.file_name().and_then(|n| n.to_str()).unwrap_or("");
        na.cmp(nb)
    });

    if leaf_dirs.len() > MAX_RESULT_FOLDERS {
        leaf_dirs.truncate(MAX_RESULT_FOLDERS);
    }

    let mut chunk: Vec<ImageFolder> = Vec::with_capacity(CHUNK_SIZE);
    let mut all_results: Vec<ImageFolder> = Vec::with_capacity(leaf_dirs.len());

    for (dir, mut images) in leaf_dirs {
        if SCAN_CANCEL.load(Ordering::Relaxed) {
            SCAN_CANCEL.store(false, Ordering::SeqCst);
            app.emit("scan-progress", ScanProgress { found, total, done: true }).ok();
            return Ok(());
        }

        images.sort();
        let count = images.len();
        let cover = dir.join(images.first().map(|s| s.as_str()).unwrap_or(""))
            .to_string_lossy().to_string();
        let name = dir.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "未知文件夹".to_string());

        chunk.push(ImageFolder {
            folder_path: dir.to_string_lossy().to_string(),
            folder_name: name.clone(),
            cover_image: cover.clone(),
            image_count: count,
        });
        all_results.push(ImageFolder {
            folder_path: dir.to_string_lossy().to_string(),
            folder_name: name,
            cover_image: cover,
            image_count: count,
        });

        found += 1;

        if chunk.len() >= CHUNK_SIZE {
            app.emit("scan-chunk", chunk.clone()).ok();
            app.emit("scan-progress", ScanProgress { found, total, done: false }).ok();
            chunk.clear();
        }
    }

    // 推送最后一批
    if !chunk.is_empty() {
        app.emit("scan-chunk", chunk).ok();
    }

    app.emit("scan-progress", ScanProgress { found, total, done: true }).ok();

    // 保存缓存（附带源目录 mtime，增量检测用）
    match app.path().app_data_dir() {
        Ok(app_data) => {
            let src_mtime = std::fs::metadata(root_path)
                .ok().and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            if let Err(e) = crate::services::cache_service::save_file_cache(
                &app_data, "image_scan", root_path, &all_results, src_mtime
            ) {
                eprintln!("[image_service] 缓存保存失败: {}", e);
            }
        }
        Err(e) => eprintln!("[image_service] 获取 app_data 目录失败: {}", e),
    }

    Ok(())
}

/// 获取指定文件夹下所有图片的完整路径列表
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

/// 生成缩略图（200px 宽 JPEG），存入 `app_data/cache/thumbnails/` 子目录。
/// 返回缩略图文件路径，首次生成后缓存复用（按源文件路径 hash 命名）。
/// 注意：GIF 只取首帧，避免缩略图静态展示不匹配。
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

    // 缓存命中：直接返回已有缩略图路径
    if thumb_path.exists() {
        return Ok(thumb_path.to_string_lossy().to_string());
    }

    let img = image::open(&image_path)
        .map_err(|e| format!("打开图片失败: {}", e))?;
    let thumb = img.thumbnail(width, width * 10); // 等比缩放，高度按比例
    thumb.save(&thumb_path)
        .map_err(|e| format!("保存缩略图失败: {}", e))?;
    Ok(thumb_path.to_string_lossy().to_string())
}