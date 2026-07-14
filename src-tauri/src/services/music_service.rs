//! 音乐扫描服务 — 只读索引
//!
//! 安全模型：此服务仅扫描文件系统中的音频文件并提取元数据，
//! 不对原始文件进行任何修改、删除或移动操作。
//! 所有播放列表管理操作仅影响前端 localStorage 数据，不触及磁盘文件。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::hash::{Hash, Hasher};
use std::collections::hash_map::DefaultHasher;
use walkdir::WalkDir;
use rayon::prelude::*;
use lofty::read_from_path;
use lofty::file::TaggedFileExt;
use lofty::file::AudioFile;
use lofty::tag::Accessor;
use serde::Serialize;
use tauri::Emitter;
use tauri::Manager;

const AUDIO_EXTENSIONS: &[&str] = &["mp3", "flac", "wav", "ogg", "m4a", "aac", "wma"];
const MAX_AUDIO_FILES: usize = 10_000;
const MAX_DEPTH: usize = 12;
const CHUNK_SIZE: usize = 50;

pub static MUSIC_SCAN_CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub file_path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_secs: u64,
    pub cover_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicScanProgress {
    pub found: usize,
    pub total: usize,
    pub done: bool,
}

fn is_audio(name: &str) -> bool {
    if let Some(i) = name.rfind('.') {
        AUDIO_EXTENSIONS.iter().any(|e| e.eq_ignore_ascii_case(&name[i + 1..]))
    } else {
        false
    }
}

/// 扫描音乐根目录，通过 Tauri 事件流式推送结果
pub fn scan_music_root_streaming(
    app: &tauri::AppHandle,
    root_path: &str,
) -> Result<(), String> {
    MUSIC_SCAN_CANCEL.store(false, Ordering::SeqCst);

    let root = Path::new(root_path);
    if !root.is_dir() {
        return Err(format!("目录不存在或不是目录: {}", root_path));
    }

    // 阶段 1：walkdir 迭代收集音频文件路径
    let mut audio_paths: Vec<PathBuf> = Vec::with_capacity(1024);
    let mut skipped = 0usize;

    for entry in WalkDir::new(root)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .into_iter()
    {
        if MUSIC_SCAN_CANCEL.load(Ordering::Relaxed) {
            MUSIC_SCAN_CANCEL.store(false, Ordering::SeqCst);
            app.emit("music-scan-progress", MusicScanProgress { found: 0, total: 0, done: true }).ok();
            return Ok(());
        }

        match entry {
            Ok(e) => {
                if !e.file_type().is_file() {
                    continue;
                }
                if !is_audio(&e.file_name().to_string_lossy()) {
                    continue;
                }
                audio_paths.push(e.path().to_path_buf());
                if audio_paths.len() >= MAX_AUDIO_FILES {
                    break;
                }
            }
            Err(e) => {
                skipped += 1;
                if skipped <= 5 {
                    eprintln!("[music_service] 跳过目录: {} ({})", e.path().unwrap_or(Path::new("?")).display(), e);
                }
            }
        }
    }

    if skipped > 5 {
        eprintln!("[music_service] ... 共跳过 {} 个无权限目录", skipped);
    }

    let total = audio_paths.len();
    let mut found = 0usize;
    let mut all_tracks: Vec<Track> = Vec::with_capacity(total);

    // 阶段 2：并行提取元数据，分批推送
    let cover_dir = app.path().app_data_dir().ok().map(|d| d.join("music_covers"));
    if let Some(ref dir) = cover_dir {
        std::fs::create_dir_all(dir).ok();
    }

    for chunk_paths in audio_paths.chunks(CHUNK_SIZE) {
        if MUSIC_SCAN_CANCEL.load(Ordering::Relaxed) {
            MUSIC_SCAN_CANCEL.store(false, Ordering::SeqCst);
            app.emit("music-scan-progress", MusicScanProgress { found, total, done: true }).ok();
            return Ok(());
        }

        let tracks: Vec<Track> = chunk_paths
            .par_iter()
            .map(|path| extract_track_metadata(path, cover_dir.as_deref()))
            .collect();

        found += tracks.len();
        all_tracks.extend(tracks.clone());
        app.emit("music-scan-chunk", tracks).ok();
        app.emit("music-scan-progress", MusicScanProgress { found, total, done: false }).ok();
    }

    app.emit("music-scan-progress", MusicScanProgress { found, total, done: true }).ok();

    // 保存缓存
    match app.path().app_data_dir() {
        Ok(app_data) => {
            if let Err(e) = crate::services::cache_service::save_cache(&app_data, "music_scan", root_path, &all_tracks) {
                eprintln!("[music_service] 缓存保存失败: {}", e);
            }
        }
        Err(e) => eprintln!("[music_service] 获取 app_data 目录失败: {}", e),
    }

    Ok(())
}

pub fn extract_track_metadata(file_path: &Path, cover_dir: Option<&Path>) -> Track {
    let path_str = file_path.to_string_lossy().to_string();
    let fallback_title = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("未知曲目")
        .to_string();

    match read_from_path(file_path) {
        Ok(tagged_file) => {
            let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag());
            let title = tag
                .and_then(|t| t.title())
                .map(|c| c.to_string())
                .unwrap_or_else(|| fallback_title.clone());
            let artist = tag
                .and_then(|t| t.artist())
                .map(|c| c.to_string())
                .unwrap_or_default();
            let album = tag
                .and_then(|t| t.album())
                .map(|c| c.to_string())
                .unwrap_or_default();
            let duration_secs = tagged_file.properties().duration().as_secs();

            // 提取内嵌封面图片
            let cover_path = cover_dir.and_then(|dir| {
                tag.and_then(|t| {
                    t.pictures().first().and_then(|pic| {
                        let ext = match pic.mime_type().map(|m| m.as_str()) {
                            Some("image/png") => "png",
                            _ => "jpg",
                        };
                        let mut hasher = DefaultHasher::new();
                        file_path.hash(&mut hasher);
                        let hash = format!("{:x}", hasher.finish());
                        let cover_file = dir.join(format!("{}.{}", hash, ext));
                        if !cover_file.exists() {
                            if let Err(e) = std::fs::write(&cover_file, pic.data()) {
                                eprintln!("[music_service] 封面写入失败: {} ({})", cover_file.display(), e);
                                return None;
                            }
                        }
                        Some(cover_file.to_string_lossy().to_string())
                    })
                })
            });

            Track {
                id: path_str.clone(),
                file_path: path_str,
                title,
                artist,
                album,
                duration_secs,
                cover_path,
            }
        }
        Err(_) => Track {
            id: path_str.clone(),
            file_path: path_str,
            title: fallback_title,
            artist: String::new(),
            album: String::new(),
            duration_secs: 0,
            cover_path: None,
        },
    }
}