//! 视频扫描服务 — 只读索引
//!
//! 安全模型：此服务仅扫描文件系统中的视频文件并建立索引列表，
//! 不对原始文件进行任何修改、删除或移动操作。
//! 不做缩略图/封面提取，不引入 ffmpeg 或任何视频解码依赖。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use walkdir::WalkDir;
use serde::Serialize;
use tauri::Emitter;
use tauri::Manager;

const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mkv", "avi", "mov", "webm", "flv"];
const MAX_VIDEO_FILES: usize = 50_000;
const MAX_DEPTH: usize = 12;
const MAX_RESULT_FOLDERS: usize = 5_000;
const CHUNK_SIZE: usize = 50;

pub static VIDEO_SCAN_CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoFolder {
    pub folder_path: String,
    pub folder_name: String,
    pub video_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoFile {
    pub file_path: String,
    pub file_name: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoScanProgress {
    pub found: usize,
    pub total: usize,
    pub done: bool,
}

fn is_video(name: &str) -> bool {
    if let Some(i) = name.rfind('.') {
        VIDEO_EXTENSIONS.iter().any(|e| e.eq_ignore_ascii_case(&name[i + 1..]))
    } else {
        false
    }
}

/// 扫描视频根目录，通过 Tauri 事件流式推送结果
pub fn scan_video_root_streaming(
    app: &tauri::AppHandle,
    root_path: &str,
) -> Result<(), String> {
    VIDEO_SCAN_CANCEL.store(false, Ordering::SeqCst);

    let root = Path::new(root_path);
    if !root.is_dir() {
        return Err(format!("目录不存在或不是目录: {}", root_path));
    }

    // 阶段 1：walkdir 迭代收集视频文件，按父目录分组
    let mut dir_videos: HashMap<PathBuf, Vec<String>> = HashMap::new();
    let mut has_subdir: HashSet<PathBuf> = HashSet::new();
    let mut file_count = 0usize;
    let mut skipped = 0usize;

    for entry in WalkDir::new(root)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .into_iter()
    {
        if VIDEO_SCAN_CANCEL.load(Ordering::Relaxed) {
            VIDEO_SCAN_CANCEL.store(false, Ordering::SeqCst);
            app.emit("video-scan-progress", VideoScanProgress { found: 0, total: 0, done: true }).ok();
            return Ok(());
        }

        match entry {
            Ok(e) => {
                if e.file_type().is_dir() {
                    continue;
                }
                let name = e.file_name().to_string_lossy();
                if !is_video(&name) {
                    continue;
                }
                file_count += 1;
                if file_count > MAX_VIDEO_FILES {
                    break;
                }
                if let Some(parent) = e.path().parent() {
                    dir_videos.entry(parent.to_path_buf()).or_default().push(name.to_string());
                    // 标记祖先目录：这些目录有子目录包含视频
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
                    eprintln!("[video_service] 跳过目录: {} ({})", e.path().unwrap_or(Path::new("?")).display(), e);
                }
            }
        }
    }

    if skipped > 5 {
        eprintln!("[video_service] ... 共跳过 {} 个无权限目录", skipped);
    }

    // 阶段 2：过滤最内层文件夹（目录不在 has_subdir 中 = 叶子节点）
    let total = dir_videos.len().min(MAX_RESULT_FOLDERS);
    let mut found = 0usize;

    let mut leaf_dirs: Vec<(PathBuf, Vec<String>)> = dir_videos
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

    let mut chunk: Vec<VideoFolder> = Vec::with_capacity(CHUNK_SIZE);
    let mut all_results: Vec<VideoFolder> = Vec::with_capacity(leaf_dirs.len());

    for (dir, mut videos) in leaf_dirs {
        if VIDEO_SCAN_CANCEL.load(Ordering::Relaxed) {
            VIDEO_SCAN_CANCEL.store(false, Ordering::SeqCst);
            app.emit("video-scan-progress", VideoScanProgress { found, total, done: true }).ok();
            return Ok(());
        }

        videos.sort();
        let count = videos.len();
        let name = dir.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "未知文件夹".to_string());

        chunk.push(VideoFolder {
            folder_path: dir.to_string_lossy().to_string(),
            folder_name: name.clone(),
            video_count: count,
        });
        all_results.push(VideoFolder {
            folder_path: dir.to_string_lossy().to_string(),
            folder_name: name,
            video_count: count,
        });

        found += 1;

        if chunk.len() >= CHUNK_SIZE {
            app.emit("video-scan-chunk", chunk.clone()).ok();
            app.emit("video-scan-progress", VideoScanProgress { found, total, done: false }).ok();
            chunk.clear();
        }
    }

    if !chunk.is_empty() {
        app.emit("video-scan-chunk", chunk).ok();
    }

    app.emit("video-scan-progress", VideoScanProgress { found, total, done: true }).ok();

    // 保存缓存
    match app.path().app_data_dir() {
        Ok(app_data) => {
            if let Err(e) = crate::services::cache_service::save_cache(&app_data, "video_scan", root_path, &all_results) {
                eprintln!("[video_service] 缓存保存失败: {}", e);
            }
        }
        Err(e) => eprintln!("[video_service] 获取 app_data 目录失败: {}", e),
    }

    Ok(())
}

/// 获取指定文件夹下所有视频文件信息
pub fn get_folder_videos(folder_path: &str) -> Result<Vec<VideoFile>, String> {
    let folder = Path::new(folder_path);
    if !folder.is_dir() {
        return Err(format!("文件夹不存在或不是目录: {}", folder_path));
    }

    let mut videos: Vec<VideoFile> = WalkDir::new(folder)
        .max_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| is_video(&e.file_name().to_string_lossy()))
        .map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let size = std::fs::metadata(e.path())
                .map(|m| m.len())
                .unwrap_or(0);
            VideoFile {
                file_path: e.path().to_string_lossy().to_string(),
                file_name: name,
                size_bytes: size,
            }
        })
        .collect();

    videos.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    Ok(videos)
}