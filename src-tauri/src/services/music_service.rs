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
use rusqlite::params;
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

/// 音乐扫描缓存载荷：在原始音轨列表之外附带「源根目录的修改时间」。
/// 前端加载缓存时比对当前根目录 mtime，若目录已变更（如新增了含音乐的子文件夹）
/// 则丢弃旧缓存、重新扫描，避免「子文件夹新增音乐后只识别到母文件夹」的缓存失效问题。
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicCachePayload {
    pub tracks: Vec<Track>,
    pub dir_mtime_ms: u64,
}

/// 取目录最后修改时间（毫秒）。出错返回 0。
pub fn dir_mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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

    // 保存缓存（附带根目录 mtime，供前端判断目录是否变更）
    match app.path().app_data_dir() {
        Ok(app_data) => {
            let payload = MusicCachePayload {
                tracks: all_tracks,
                dir_mtime_ms: dir_mtime_ms(root),
            };
            if let Err(e) = crate::services::cache_service::save_cache(&app_data, "music_scan", root_path, &payload) {
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

    // canonicalize 归一化路径（Windows 上 dialog 可能返回带空格/符号链接的非常规形式），
    // 失败则回退原路径，不影响后续解析。
    let resolved = file_path.canonicalize().unwrap_or_else(|_| file_path.to_path_buf());
    match read_from_path(&resolved) {
        Ok(tagged_file) => {
            let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag());
            let title = tag
                .and_then(|t| t.title())
                .map(|c| c.to_string())
                .unwrap_or_else(|| fallback_title.clone());
            // 优先用「艺人」字段；很多文件只写了「专辑艺人」(album artist) 而无独立艺人，
            // 此时回退到 AlbumArtist，避免任务栏/播放器显示为空歌手。
            let artist = tag
                .and_then(|t| t.artist())
                .or_else(|| {
                    tag.and_then(|t| t.get(lofty::tag::ItemKey::AlbumArtist))
                        .and_then(|item| item.value().text().map(std::borrow::Cow::Borrowed))
                })
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
                        let mut path_hasher = DefaultHasher::new();
                        file_path.hash(&mut path_hasher);
                        let path_hash = format!("{:x}", path_hasher.finish());
                        // 用内嵌封面「内容」哈希参与文件名：替换/更新封面后文件名随之变化，
                        // 从而重新提取并写入新封面，避免一直复用首次扫描写入的缓存图
                        // （原逻辑仅按文件路径哈希命名、且已存在则跳过，导致改封面后封面图不变）。
                        let mut pic_hasher = DefaultHasher::new();
                        pic.data().hash(&mut pic_hasher);
                        let pic_hash = format!("{:x}", pic_hasher.finish());
                        let cover_file = dir.join(format!("{}_{}.{}", path_hash, pic_hash, ext));
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
        Err(e) => {
            eprintln!("[music_service] 元信息读取失败: {} ({})", file_path.display(), e);
            Track {
                id: path_str.clone(),
                file_path: path_str,
                title: fallback_title,
                artist: String::new(),
                album: String::new(),
                duration_secs: 0,
                cover_path: None,
            }
        }
    }
}

// 计算文件路径哈希（与 extract_track_metadata 中保持一致，用于封面文件名前缀）
fn path_hash_of(path: &Path) -> String {
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    format!("{:x}", h.finish())
}

fn cover_dir_of(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| {
            let dir = d.join("music_covers");
            let _ = std::fs::create_dir_all(&dir);
            dir
        })
}

/// 手动设封面：解码 base64 图片，写入 music_covers 目录（文件名含内容哈希，天然去重），
/// 并把该 file_path 的封面固定为覆盖值（持久化到 track_cover_override + playlist_track/favorite）。
/// 返回新封面文件的绝对路径。
pub fn set_cover_from_base64(
    app: &tauri::AppHandle,
    file_path: String,
    data_base64: String,
    mime: Option<String>,
) -> Result<String, String> {
    use base64::Engine;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|e| format!("base64 解码失败: {}", e))?;
    let ext = match mime.as_deref() {
        Some("image/png") => "png",
        Some("image/webp") => "webp",
        _ => "jpg",
    };
    let dir = cover_dir_of(app).ok_or_else(|| "无法获取封面目录".to_string())?;
    let path = Path::new(&file_path);
    let mut hasher = DefaultHasher::new();
    raw.hash(&mut hasher);
    let content_hash = format!("{:x}", hasher.finish());
    let cover_file = dir.join(format!("{}_manual_{}.{}", path_hash_of(path), content_hash, ext));
    std::fs::write(&cover_file, &raw).map_err(|e| format!("封面写入失败: {}", e))?;
    let cover_path = cover_file.to_string_lossy().to_string();
    crate::services::music_db::music_set_cover_override(app.clone(), file_path, cover_path.clone())?;
    Ok(cover_path)
}

/// 重扫单文件元数据（忽略手动封面覆盖，按内嵌封面重新提取）。
/// 更新 playlist_track/favorite 的 title/artist/album/cover_path（若 override 存在，调用方负责保留）。
/// 返回重抽后的 Track（cover_path 为内嵌封面，不含 override）。
pub fn rescan_track_metadata(app: &tauri::AppHandle, file_path: String) -> Result<Track, String> {
    let track = extract_track_metadata(Path::new(&file_path), cover_dir_of(app).as_deref());
    let conn = crate::services::music_db::open_db(app).map_err(|e| e)?;
    // 仅更新自建歌单与收藏中的该曲目（file_path 维度）
    conn.execute(
        "UPDATE playlist_track SET title=?2, artist=?3, album=?4, duration_ms=?5, cover_path=?6 WHERE file_path=?1",
        params![
            file_path,
            track.title,
            track.artist,
            track.album,
            track.duration_secs as i64 * 1000,
            track.cover_path.clone().unwrap_or_default()
        ],
    )
    .map_err(|e| format!("更新歌单元数据失败: {}", e))?;
    conn.execute(
        "UPDATE favorite SET title=?2, artist=?3, album=?4, duration_ms=?5, cover_path=?6 WHERE file_path=?1",
        params![
            file_path,
            track.title,
            track.artist,
            track.album,
            track.duration_secs as i64 * 1000,
            track.cover_path.clone().unwrap_or_default()
        ],
    )
    .map_err(|e| format!("更新收藏元数据失败: {}", e))?;
    Ok(track)
}

/// 写回标签：用 lofty 修改文件的 title/artist/album/track_number 并落盘，
/// 同步更新 playlist_track/favorite 中的对应字段。
pub fn edit_track_tags(
    app: &tauri::AppHandle,
    file_path: String,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    track_number: Option<u32>,
) -> Result<(), String> {
    let path = Path::new(&file_path);
    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut tagged_file = read_from_path(&resolved).map_err(|e| format!("读取音频失败: {}", e))?;
    {
        let tag = if let Some(t) = tagged_file.primary_tag_mut() {
            t
        } else {
            tagged_file
                .first_tag_mut()
                .ok_or_else(|| "文件不含可写标签".to_string())?
        };
        if let Some(v) = &title {
            tag.set_title(v.clone());
        }
        if let Some(v) = &artist {
            tag.set_artist(v.clone());
        }
        if let Some(v) = &album {
            tag.set_album(v.clone());
        }
        if let Some(n) = track_number {
            tag.set_track(n);
        }
    }
    tagged_file
        .save_to_path(&resolved, lofty::config::WriteOptions::default())
        .map_err(|e| format!("标签写回失败: {}", e))?;
    // 同步内存库字段
    let conn = crate::services::music_db::open_db(app).map_err(|e| e)?;
    if let Some(v) = &title {
        conn.execute("UPDATE playlist_track SET title=?2 WHERE file_path=?1", params![file_path, v])
            .map_err(|e| format!("更新歌单标题失败: {}", e))?;
        conn.execute("UPDATE favorite SET title=?2 WHERE file_path=?1", params![file_path, v])
            .map_err(|e| format!("更新收藏标题失败: {}", e))?;
    }
    if let Some(v) = &artist {
        conn.execute("UPDATE playlist_track SET artist=?2 WHERE file_path=?1", params![file_path, v])
            .map_err(|e| format!("更新歌单歌手失败: {}", e))?;
        conn.execute("UPDATE favorite SET artist=?2 WHERE file_path=?1", params![file_path, v])
            .map_err(|e| format!("更新收藏歌手失败: {}", e))?;
    }
    if let Some(v) = &album {
        conn.execute("UPDATE playlist_track SET album=?2 WHERE file_path=?1", params![file_path, v])
            .map_err(|e| format!("更新歌单专辑失败: {}", e))?;
        conn.execute("UPDATE favorite SET album=?2 WHERE file_path=?1", params![file_path, v])
            .map_err(|e| format!("更新收藏专辑失败: {}", e))?;
    }
    Ok(())
}