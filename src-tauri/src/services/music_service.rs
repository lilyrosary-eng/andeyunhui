//! 音乐扫描与标签服务
//!
//! 扫描阶段（`scan_music_root` / `extract_track_metadata`）只读：遍历目录、用 lofty 提取
//! 元数据、把内嵌封面导出到 app_data 的缓存目录，不改动原始文件。
//!
//! 写回是**显式**操作，只在用户点了「保存标签」之后发生：`edit_track_tags`（文本项）、
//! `embed_cover_into_file`（封面内嵌）。两者都会 `save_to_path` 覆盖原文件。
//! 换封面不可逆，所以覆盖前把旧内嵌封面留底到 `app_data/cover_backups`，同一文件最多
//! `COVER_BACKUP_KEEP`(3) 份滚动；留底失败直接中止这次换封面。
//! 文本字段的写前快照与整批撤销还没接（下一轮），批量刮库上线前必须先补上。
//! 播放列表管理只动 SQLite（music_db），不触及磁盘文件。

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
use lofty::picture::{MimeType, Picture, PictureType};
use serde::Serialize;
use tauri::Emitter;
use tauri::Manager;

// 扫描收录的扩展名 = lofty 能打标签 ∩ webview 能解码。
// ape/wv/mpc/aiff 虽然 lofty 支持标签，但 WebView2/WebKitGTK 没有可靠解码器，
// 收录进来会在曲库里生成"看得见、点不开"的条目，故不加入扫描；
// 用户手动添加单曲时不走这张表（直接交给 lofty），仍可读写。
// wma 保留（历史行为，Linux 侧 media_http 可流式播放），但 lofty 无 ASF 支持，
// 读不到标签时以 tagTypes=[] + properties=null 如实回报，不伪装成"标签为空"。
const AUDIO_EXTENSIONS: &[&str] = &["mp3", "flac", "wav", "ogg", "m4a", "aac", "wma", "opus"];
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
    // 以下字段由 lofty 直接读出，旧扫描缓存里没有这些键 → 反序列化为 None/空，
    // 因此不需要作废缓存；重新扫描（或单曲 rescan）后即可填充。
    pub album_artist: Option<String>,
    pub composer: Option<String>,
    pub lyricist: Option<String>,
    pub genre: Option<String>,
    pub comment: Option<String>,
    /// 年份/日期原始字符串（TYER/TDRC/date/\xa9day 等），可能是 "2003" 或 "2003-05-01"
    pub year: Option<String>,
    pub track_number: Option<u32>,
    pub track_total: Option<u32>,
    pub disc_number: Option<u32>,
    pub disc_total: Option<u32>,
    /// 文件内实际存在的标签族，如 ["ID3v2"]；空数组表示无标签或格式不被 lofty 识别
    #[serde(default)]
    pub tag_types: Vec<String>,
    pub has_picture: bool,
    pub properties: Option<AudioProperties>,
}

/// 音频流属性（lofty `FileProperties`，替代 MusicTag 的 MediaInfo.dll —— 不引入原生依赖）
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioProperties {
    /// 采样率 Hz
    pub sample_rate: Option<u32>,
    /// 位深（16/24/32）
    pub bit_depth: Option<u8>,
    /// 声道数
    pub channels: Option<u8>,
    /// 音频码率 kbps
    pub audio_bitrate: Option<u32>,
    /// 整体码率 kbps（含容器开销）
    pub overall_bitrate: Option<u32>,
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

            // 扩展字段：年份/流派/碟号/作曲/作词/注释 —— lofty 原生支持，不需 MediaInfo
            let non_empty = |s: Option<String>| s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
            let album_artist = non_empty(tag_item_str(tag, lofty::tag::ItemKey::AlbumArtist));
            let composer = non_empty(tag_item_str(tag, lofty::tag::ItemKey::Composer));
            let lyricist = non_empty(tag_item_str(tag, lofty::tag::ItemKey::Lyricist));
            let genre = non_empty(tag.and_then(|t| t.genre()).map(|c| c.to_string()));
            let comment = non_empty(tag.and_then(|t| t.comment()).map(|c| c.to_string()));
            // RecordingDate 优先（TDRC/\xa9day），只有裸年份时回退 ItemKey::Year
            let year = tag_item_str(tag, lofty::tag::ItemKey::RecordingDate)
                .or_else(|| tag_item_str(tag, lofty::tag::ItemKey::Year))
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty());
            let track_number = tag.and_then(|t| t.track());
            let track_total = tag.and_then(|t| t.track_total());
            let disc_number = tag.and_then(|t| t.disk());
            let disc_total = tag.and_then(|t| t.disk_total());

            let props = tagged_file.properties();
            let properties = AudioProperties {
                sample_rate: props.sample_rate(),
                bit_depth: props.bit_depth(),
                channels: props.channels(),
                audio_bitrate: props.audio_bitrate(),
                overall_bitrate: props.overall_bitrate(),
            };
            let tag_types: Vec<String> = tagged_file
                .tags()
                .iter()
                .map(|t| tag_type_label(t.tag_type()))
                .collect();
            let has_picture = tag.map_or(false, |t| !t.pictures().is_empty());

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
                album_artist,
                composer,
                lyricist,
                genre,
                comment,
                year,
                track_number,
                track_total,
                disc_number,
                disc_total,
                tag_types,
                has_picture,
                properties: Some(properties),
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
                album_artist: None,
                composer: None,
                lyricist: None,
                genre: None,
                comment: None,
                year: None,
                track_number: None,
                track_total: None,
                disc_number: None,
                disc_total: None,
                // 走到这里说明 lofty 不认识该容器（如 .wma/.dsf/.tak），或文件损坏。
                // 空 tagTypes + properties=null 就是给前端的诚实信号：不要显示成"标签为空"，
                // 而要显示成"此格式不支持标签读写"。
                tag_types: Vec::new(),
                has_picture: false,
                properties: None,
            }
        }
    }
}

/// 读取单个文本型标签项（可能不存在）
fn tag_item_str(tag: Option<&lofty::tag::Tag>, key: lofty::tag::ItemKey) -> Option<String> {
    tag.and_then(|t| t.get_string(key)).map(|s| s.to_string())
}

/// 标签族的展示名（对齐 MusicTag 列表里的 tagtypes 列语义）
fn tag_type_label(tag_type: lofty::tag::TagType) -> String {
    use lofty::tag::TagType;
    let name = match tag_type {
        TagType::Id3v1 => "ID3v1",
        TagType::Id3v2 => "ID3v2",
        TagType::Ape => "APE",
        TagType::Mp4Ilst => "MP4",
        TagType::VorbisComments => "Vorbis",
        TagType::RiffInfo => "RIFF INFO",
        TagType::AiffText => "AIFF Text",
        // TagType 是 #[non_exhaustive]，lofty 升级新增族时落到兜底名而不是编译失败
        other => return format!("{:?}", other),
    };
    name.to_string()
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

/// 每次换封面对该文件最多留几份旧封面，超出滚动淘汰最旧的。
/// 沿用本项目既定范式（`rag_backup_db` 保留最近 3 份、checkpoint 滚动淘汰）。
const COVER_BACKUP_KEEP: usize = 3;

/// 旧封面留底目录。**必须与 `music_covers` 缓存分开**：
/// `music_clean_cover_cache(keep)` 会把缓存目录里不在 keep 集的文件一律删除，
/// 留底放进去会被前端的缓存清理吃掉。
fn cover_backup_dir_of(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| {
            let dir = d.join("cover_backups");
            let _ = std::fs::create_dir_all(&dir);
            dir
        })
}

/// 同一音频文件只保留最近 `keep` 份留底，其余删除，返回删除数量。
///
/// 文件名形如 `{pathHash}_{10位时间戳}_{内容哈希}.{ext}`：同一文件的分组前缀相同，
/// 时间戳定宽 ⇒ 按文件名字典序即按时间序。
fn prune_cover_backups(dir: &Path, path_hash: &str, keep: usize) -> Result<usize, String> {
    let prefix = format!("{}_", path_hash);
    let mut names: Vec<String> = Vec::new();
    let entries = std::fs::read_dir(dir).map_err(|e| format!("读取留底目录失败: {}", e))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(&prefix) && entry.path().is_file() {
            names.push(name);
        }
    }
    if names.len() <= keep {
        return Ok(0);
    }
    names.sort_by(|a, b| b.cmp(a)); // 新 → 旧
    let mut removed = 0usize;
    for stale in names.iter().skip(keep) {
        if std::fs::remove_file(dir.join(stale)).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// 把当前内嵌封面写入留底目录，返回留底文件路径。
fn write_cover_backup(dir: &Path, audio: &Path, bytes: &[u8], ext: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建留底目录失败: {}", e))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    let content_hash = format!("{:x}", hasher.finish());
    let path = dir.join(format!("{}_{:010}_{}.{}", path_hash_of(audio), ts, content_hash, ext));
    std::fs::write(&path, bytes).map_err(|e| format!("写旧封面留底失败: {}", e))?;
    // 先写后淘汰：淘汰中途失败不影响本轮已经留住的这份
    prune_cover_backups(dir, &path_hash_of(audio), COVER_BACKUP_KEEP)?;
    Ok(path)
}

/// 留底文件的扩展名（按内嵌图片的 mime 推断，认不出的一律当 jpg）
fn picture_ext(mime: Option<&str>) -> &'static str {
    match mime {
        Some("image/png") => "png",
        Some("image/gif") => "gif",
        Some("image/webp") => "webp",
        Some("image/bmp") => "bmp",
        Some("image/tiff") => "tif",
        _ => "jpg",
    }
}

/// 将 image_bytes 作为封面写入音频文件内嵌标签（ID3v2 APIC / FLAC 图块 / MP4 covr），
/// 覆盖原有全部内嵌图片。失败返回错误信息，供上层回退到「缓存式 override」兜底。
///
/// `backup_dir` 为 Some 时，覆盖前把当前内嵌封面留底一份（同文件最多 `COVER_BACKUP_KEEP`
/// 份滚动）；留底失败**直接中止本次换封面**，不做无退路的覆盖。传 None 表示这次不需要留底。
///
/// 成功时返回本次写下的留底文件路径（没留底则为 None），供调用方记进标签历史以支持撤销。
fn embed_cover_into_file(
    resolved: &Path,
    image_bytes: &[u8],
    mime: Option<&str>,
    backup_dir: Option<&Path>,
) -> Result<Option<PathBuf>, String> {
    let mut tagged_file = read_from_path(resolved).map_err(|e| format!("读取音频失败: {}", e))?;
    // mime 缺失时按字节头推断，作为 Content-Type fallback
    let mime_type = match mime.and_then(|m| {
        let mt = MimeType::from_str(m);
        (!matches!(mt, MimeType::Unknown(_))).then_some(mt)
    }) {
        Some(mt) => mt,
        None => {
            if image_bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                MimeType::Png
            } else if image_bytes.starts_with(b"GIF8") {
                MimeType::Gif
            } else if image_bytes.starts_with(b"BM") {
                MimeType::Bmp
            } else if image_bytes.starts_with(b"II*\x00") || image_bytes.starts_with(b"MM\x00*") {
                MimeType::Tiff
            } else {
                MimeType::Jpeg
            }
        }
    };
    let picture = Picture::unchecked(image_bytes.to_vec())
        .pic_type(PictureType::CoverFront)
        .mime_type(mime_type)
        .description("cover")
        .build();
    let mut backup_path: Option<PathBuf> = None;
    {
        let tag = if let Some(t) = tagged_file.primary_tag_mut() {
            t
        } else {
            tagged_file
                .first_tag_mut()
                .ok_or_else(|| "文件不含可写标签".to_string())?
        };
        // 覆盖前先留底当前内嵌封面（bytes 先 clone 出来，避免与后面的可变操作抢借用）
        if let Some(dir) = backup_dir {
            let old = tag
                .pictures()
                .first()
                .map(|p| (p.data().to_vec(), picture_ext(p.mime_type().map(|m| m.as_str()))));
            if let Some((bytes, ext)) = old {
                backup_path = Some(write_cover_backup(dir, resolved, &bytes, ext)?);
            }
        }
        // 移除旧封面后写入固定索引 0（set_picture 索引越界时自动 push）
        while tag.picture_count() > 0 {
            tag.remove_picture(0);
        }
        tag.set_picture(0, picture);
    }
    tagged_file
        .save_to_path(resolved, lofty::config::WriteOptions::default())
        .map_err(|e| format!("内嵌封面写回失败: {}", e))?;
    Ok(backup_path)
}

/// 取 file_path 对应的 canonicalize 后路径（与 extract_track_metadata 一致）。
fn canonical_path_of(file_path: &str) -> PathBuf {
    let path = Path::new(file_path);
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// 封面已成功写入内嵌标签后，重新提取内嵌封面缓存并同步数据库，
/// 使所有歌单/收藏即时使用新封面。返回新封面缓存文件的绝对路径。
fn sync_cover_after_embed(app: &tauri::AppHandle, file_path: &str) -> Result<String, String> {
    let track = extract_track_metadata(Path::new(file_path), cover_dir_of(app).as_deref());
    let cover_path = track.cover_path.unwrap_or_default();
    crate::services::music_db::music_set_cover_override(app.clone(), file_path.to_string(), cover_path.clone())?;
    Ok(cover_path)
}

/// 手动设封面：解码 base64 图片，
/// 1) 优先写入音频文件内嵌标签（真正持久化到文件，迁移/分享也带封面）；
/// 2) 任一步失败时回退为旧逻辑——封面写入 music_covers 目录并固定为 override。
/// 返回新封面文件的绝对路径。
/// 换封面成功后补一条批次历史（改前字段快照 + 本次产生的封面留底路径），
/// 让「整批撤销」能把封面一起退回去。
///
/// 读不到改前快照时**不记历史**：宁可撤销时这批不含封面，也不能记一份残缺快照
/// 让撤销把字段全部清空。留底文件本身已经在盘上，用户仍可用「恢复某份留底」单独退回。
fn record_cover_history(
    app: &tauri::AppHandle,
    file_path: &str,
    batch_id: Option<&str>,
    cover_backup: Option<&Path>,
) {
    let Some(batch_id) = batch_id else { return };
    let resolved = canonical_path_of(file_path);
    let Some(snapshot) = lofty::read_from_path(&resolved)
        .ok()
        .and_then(|tf| tf.primary_tag().or_else(|| tf.first_tag()).map(snapshot_of_tagged))
    else {
        eprintln!("[music_service] 读不到改前快照，本次换封面不进批次历史: {}", file_path);
        return;
    };
    let Ok(snapshot_json) = serde_json::to_string(&snapshot) else { return };
    let backup_str = cover_backup.map(|p| p.to_string_lossy().into_owned());
    if let Err(e) = crate::services::music_db::music_record_tag_snapshot(
        app,
        batch_id,
        file_path,
        &snapshot_json,
        backup_str.as_deref(),
    ) {
        eprintln!("[music_service] 封面批次历史写入失败（留底仍在盘上，可单独恢复）: {}", e);
    }
}

pub fn set_cover_from_base64(
    app: &tauri::AppHandle,
    file_path: String,
    data_base64: String,
    mime: Option<String>,
    batch_id: Option<String>,
) -> Result<String, String> {
    use base64::Engine;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|e| format!("base64 解码失败: {}", e))?;
    // 优先写内嵌封面；失败则回退为缓存式 override（不改原文件，兼容不支持写入的格式）。
    let resolved = canonical_path_of(&file_path);
    let backup_dir = cover_backup_dir_of(app);
    match embed_cover_into_file(&resolved, &raw, mime.as_deref(), backup_dir.as_deref()) {
        Ok(backup_path) => {
            record_cover_history(app, &file_path, batch_id.as_deref(), backup_path.as_deref());
            return sync_cover_after_embed(app, &file_path);
        }
        Err(embed_err) => eprintln!("[music_service] 内嵌封面写入失败，回退缓存 override: {} ({})", file_path, embed_err),
    }
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

/// 按远程 URL 下载封面并写为音频文件内嵌封面（用于「一键/分项自动获取」）。
/// reqwest 需在 async 上下文调用；fallback 到缓存 override 时同样下载到本地。
pub async fn set_cover_from_url(
    app: &tauri::AppHandle,
    file_path: String,
    url: String,
    batch_id: Option<String>,
) -> Result<String, String> {
    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("封面下载请求失败: {}", e))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("封面下载读取失败: {}", e))?;
    let image_bytes = bytes.to_vec();
    // 从 URL / Content-Type 推断 mime（仅用于写入标签，缺省时按字节头推断）
    let mime = url.rsplit('.').next().map(str::to_lowercase).and_then(|ext| {
        match ext.as_str() {
            "png" => Some("image/png".to_string()),
            "gif" => Some("image/gif".to_string()),
            "webp" => Some("image/webp".to_string()),
            "bmp" => Some("image/bmp".to_string()),
            "tif" | "tiff" => Some("image/tiff".to_string()),
            _ => None,
        }
    });
    let app2 = app.clone();
    let fp = file_path.clone();
    // 阻塞文件写盘放到线程池，避免占用 async worker
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = canonical_path_of(&fp);
        let mime_str = mime.as_deref();
        let backup_dir = cover_backup_dir_of(&app2);
        match embed_cover_into_file(&resolved, &image_bytes, mime_str, backup_dir.as_deref()) {
            Ok(backup_path) => {
                record_cover_history(&app2, &fp, batch_id.as_deref(), backup_path.as_deref());
                sync_cover_after_embed(&app2, &fp).map_err(|e| format!("封面同步失败: {}", e))
            }
            Err(embed_err) => {
                eprintln!("[music_service] 内嵌封面写入失败，回退缓存 override: {} ({})", fp, embed_err);
                let dir = cover_dir_of(&app2).ok_or_else(|| "无法获取封面目录".to_string())?;
                let ext = match mime_str {
                    Some("image/png") => "png",
                    Some("image/webp") => "webp",
                    _ => "jpg",
                };
                let mut hasher = DefaultHasher::new();
                image_bytes.hash(&mut hasher);
                let content_hash = format!("{:x}", hasher.finish());
                let cover_file = dir.join(format!("{}_manual_{}.{}", path_hash_of(Path::new(&fp)), content_hash, ext));
                std::fs::write(&cover_file, &image_bytes).map_err(|e| format!("封面写入失败: {}", e))?;
                let cover_path = cover_file.to_string_lossy().to_string();
                crate::services::music_db::music_set_cover_override(app2.clone(), fp, cover_path.clone())?;
                Ok(cover_path)
            }
        }
    })
    .await
    .map_err(|e| format!("封面写入任务失败: {}", e))?
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

/// 标签写回的字段集合。`None` = 保持文件原值不动；文本项传空串 = 清除该字段。
///
/// 字段集对齐 MusicTag 的列表列（title/artist/album/albumartist/year/track/disc/genre/
/// composer/lyricist/comment），全部走 lofty 的 `ItemKey`，由 lofty 按容器映射到
/// ID3v2 / Vorbis / MP4 ilst / APEv2 等对应帧。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagEditDraft {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub track_number: Option<u32>,
    pub track_total: Option<u32>,
    pub disc_number: Option<u32>,
    pub disc_total: Option<u32>,
    pub year: Option<String>,
    pub genre: Option<String>,
    pub composer: Option<String>,
    pub lyricist: Option<String>,
    pub comment: Option<String>,
}

/// 文本项写回：None 不动，空串清除，其余 trim 后写入。
///
/// 返回 `false` 表示该 `TagType` 没有这个键的帧映射 —— lofty 的 `Tag::insert` 会先
/// `re_map` 校验，校验不过就**静默丢弃**。调用方收集这些字段并打日志，不能假装写成功了。
/// 实测的例子是 WAV：RIFF INFO 没有专辑艺人 / 作词 / 碟号的位置
/// （哪些字段会掉，用 `field_support_for` 查，别凭容器名猜）。
fn apply_text_item(
    tag: &mut lofty::tag::Tag,
    key: lofty::tag::ItemKey,
    value: Option<&str>,
) -> bool {
    let Some(raw) = value else { return true };
    let v = raw.trim().to_string();
    if v.is_empty() {
        tag.remove_key(key);
        return true;
    }
    tag.insert_text(key, v)
}

/// 序号项写回（音轨/碟号）：None 不动，Some 写入。返回值语义同 `apply_text_item`
fn apply_number_item(
    tag: &mut lofty::tag::Tag,
    key: lofty::tag::ItemKey,
    value: Option<u32>,
) -> bool {
    match value {
        None => true,
        Some(n) => tag.insert_text(key, n.to_string()),
    }
}

/// 年份写回：一律落到 `RecordingDate`。
///
/// `ItemKey::Year` 在 ID3v2 下**没有帧映射**，`insert_text(Year, ..)` 会被 lofty 静默丢弃
/// （单测实测：写进去后 get_string 两个键都拿不到值）。lofty 自己的文档也建议用
/// `RecordingDate` 换取更广的应用支持；写 ID3v2.3 时由 lofty 拆出 TYER 帧。
/// 空串表示清除。
fn apply_year_item(tag: &mut lofty::tag::Tag, raw: &str) -> bool {
    use lofty::tag::ItemKey;
    let v = raw.trim();
    if v.is_empty() {
        tag.remove_key(ItemKey::Year);
        tag.remove_key(ItemKey::RecordingDate);
        return true;
    }
    tag.remove_key(ItemKey::Year);
    tag.insert_text(ItemKey::RecordingDate, v.to_string())
}

/// 写回**之前**的字段快照，落库用（`music_db::tag_edit_history.old_json`）。
///
/// 与 `TagEditDraft` 的区别在于每个字段都是必填的字符串：空串表示"这个字段当时没有值"，
/// 撤销时要把标签项删掉。若沿用 Draft 的 `None`，撤销就无法区分"别动"和"清空"，
/// 批量新写入的流派/年份会撤不掉。
#[derive(Debug, Clone, Default, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSnapshot {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub track_number: String,
    pub track_total: String,
    pub disc_number: String,
    pub disc_total: String,
    pub year: String,
    pub genre: String,
    pub composer: String,
    pub lyricist: String,
    pub comment: String,
}

/// 读出文件当前的字段快照（读不到的字段留空串 = 撤销时清除）。
fn snapshot_of_tagged(tagged: &lofty::tag::Tag) -> TagSnapshot {
    use lofty::tag::ItemKey;
    let s = |k: ItemKey| tag_item_str(Some(tagged), k).unwrap_or_default();
    let n = |v: Option<u32>| v.map(|x| x.to_string()).unwrap_or_default();
    TagSnapshot {
        title: s(ItemKey::TrackTitle),
        artist: s(ItemKey::TrackArtist),
        album: s(ItemKey::AlbumTitle),
        album_artist: s(ItemKey::AlbumArtist),
        track_number: n(tagged.track()),
        track_total: n(tagged.track_total()),
        disc_number: n(tagged.disk()),
        disc_total: n(tagged.disk_total()),
        year: {
            let dated = s(ItemKey::RecordingDate);
            if dated.is_empty() { s(ItemKey::Year) } else { dated }
        },
        genre: tagged.genre().map(|c| c.to_string()).unwrap_or_default(),
        composer: s(ItemKey::Composer),
        lyricist: s(ItemKey::Lyricist),
        comment: tagged.comment().map(|c| c.to_string()).unwrap_or_default(),
    }
}

/// 把快照写回文件（撤销用）。返回该容器没有帧位而被跳过的字段名。
fn apply_snapshot_to_tag(tag: &mut lofty::tag::Tag, snap: &TagSnapshot) -> Vec<&'static str> {
    use lofty::tag::ItemKey;
    let mut dropped: Vec<&'static str> = Vec::new();
    let mut one = |label: &'static str, key: ItemKey, val: &str| {
        if !apply_text_item(tag, key, Some(val)) {
            dropped.push(label);
        }
    };
    one("标题", ItemKey::TrackTitle, &snap.title);
    one("歌手", ItemKey::TrackArtist, &snap.artist);
    one("专辑", ItemKey::AlbumTitle, &snap.album);
    one("专辑艺人", ItemKey::AlbumArtist, &snap.album_artist);
    one("流派", ItemKey::Genre, &snap.genre);
    one("作曲", ItemKey::Composer, &snap.composer);
    one("作词", ItemKey::Lyricist, &snap.lyricist);
    one("注释", ItemKey::Comment, &snap.comment);
    one("音轨号", ItemKey::TrackNumber, &snap.track_number);
    one("音轨总数", ItemKey::TrackTotal, &snap.track_total);
    one("碟号", ItemKey::DiscNumber, &snap.disc_number);
    one("碟总数", ItemKey::DiscTotal, &snap.disc_total);
    if !apply_year_item(tag, &snap.year) {
        dropped.push("年份");
    }
    dropped
}

/// 写回标签：用 lofty 修改文件的文本标签项并落盘，
/// 同步更新 playlist_track/favorite 中的 title/artist/album（其余字段无对应列，
/// 由调用方在写回后重扫单曲 `rescan_track_metadata` 取回真值）。
pub fn edit_track_tags(
    app: &tauri::AppHandle,
    file_path: String,
    draft: &TagEditDraft,
    batch_id: &str,
) -> Result<Vec<String>, String> {
    let TagEditDraft { title, artist, album, .. } = draft;
    let path = Path::new(&file_path);
    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut tagged_file = read_from_path(&resolved).map_err(|e| format!("读取音频失败: {}", e))?;

    // 改前快照先落库，落不进去就不写文件 —— 覆盖原文件是不可逆的，
    // 「有历史表但没写进去」比「这次没改成」严重得多。
    let snapshot = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag())
        .map(snapshot_of_tagged)
        .unwrap_or_default();
    let snapshot_json =
        serde_json::to_string(&snapshot).map_err(|e| format!("快照序列化失败: {}", e))?;
    crate::services::music_db::music_record_tag_snapshot(
        app,
        batch_id,
        &file_path,
        &snapshot_json,
        None,
    )?;
    let mut dropped: Vec<&'static str> = Vec::new();
    {
        use lofty::tag::ItemKey;
        let tag = if let Some(t) = tagged_file.primary_tag_mut() {
            t
        } else {
            tagged_file
                .first_tag_mut()
                .ok_or_else(|| "文件不含可写标签".to_string())?
        };
        let mut record = |label: &'static str, ok: bool| {
            if !ok {
                dropped.push(label);
            }
        };
        record("标题", apply_text_item(tag, ItemKey::TrackTitle, title.as_deref()));
        record("歌手", apply_text_item(tag, ItemKey::TrackArtist, artist.as_deref()));
        record("专辑", apply_text_item(tag, ItemKey::AlbumTitle, album.as_deref()));
        record("专辑艺人", apply_text_item(tag, ItemKey::AlbumArtist, draft.album_artist.as_deref()));
        record("流派", apply_text_item(tag, ItemKey::Genre, draft.genre.as_deref()));
        record("作曲", apply_text_item(tag, ItemKey::Composer, draft.composer.as_deref()));
        record("作词", apply_text_item(tag, ItemKey::Lyricist, draft.lyricist.as_deref()));
        record("注释", apply_text_item(tag, ItemKey::Comment, draft.comment.as_deref()));
        record("年份", draft.year.as_deref().map_or(true, |raw| apply_year_item(tag, raw)));
        record("音轨号", apply_number_item(tag, ItemKey::TrackNumber, draft.track_number));
        record("音轨总数", apply_number_item(tag, ItemKey::TrackTotal, draft.track_total));
        record("碟号", apply_number_item(tag, ItemKey::DiscNumber, draft.disc_number));
        record("碟总数", apply_number_item(tag, ItemKey::DiscTotal, draft.disc_total));
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
    Ok(dropped.into_iter().map(String::from).collect())
}

// ============ 写回历史：整批撤销 / 封面留底恢复 / 批量写回 ============

/// 一次写回的回报：撤销用的批次号 + 被该容器跳过的字段名。
///
/// 单曲编辑也会拿到一个批次号 —— 这样「撤销刚才这次修改」和「撤销整批刮库」
/// 用的是同一条通路，前端不用区分两种撤销。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditOutcome {
    pub batch_id: String,
    pub dropped: Vec<String>,
}

/// 为一次非批量写回生成批次号（前端拿到它就能给出「撤销这次修改」）。
pub fn new_batch_id(kind: &str) -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{}_{}", kind, ms)
}

/// 批量写回的一项：文件 + 要写的字段。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchTagItem {
    pub file_path: String,
    pub draft: TagEditDraft,
}

/// 批量写回的单项目结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchItemResult {
    pub file_path: String,
    pub ok: bool,
    pub error: Option<String>,
    pub dropped: Vec<String>,
}

/// 一批标签写回的全部改前快照（撤销时逐条写回）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackReport {
    pub files: usize,
    pub covers_restored: usize,
    /// 形如 `路径: 原因`；非空时这批历史**不会**被删除，用户还能再撤剩下的
    pub failed: Vec<String>,
    /// 真正被退回的文件路径。前端拿它逐个重扫，界面才会显示退回后的值 ——
    /// 只给个数字的话，撤销完列表还停在撤销前，看着就像「按钮没生效」
    pub restored_paths: Vec<String>,
}

/// 批量写回。顺序执行、逐项回报，一项失败不影响其余项。
///
/// 刻意不并发：每项都要开 SQLite 连接写历史，且改的是用户磁盘上的原件，
/// 顺序做才拿得到确定的「谁成功了、谁没成功」清单。
pub fn batch_edit_tracks(
    app: &tauri::AppHandle,
    items: Vec<BatchTagItem>,
    batch_id: &str,
) -> Vec<BatchItemResult> {
    items
        .into_iter()
        .map(|item| match edit_track_tags(app, item.file_path.clone(), &item.draft, batch_id) {
            Ok(dropped) => BatchItemResult { file_path: item.file_path, ok: true, error: None, dropped },
            Err(e) => BatchItemResult {
                file_path: item.file_path,
                ok: false,
                error: Some(e),
                dropped: Vec::new(),
            },
        })
        .collect()
}

/// 撤销一批写回：按批次号取出每个文件的改前快照逐条写回；该批若换过封面，
/// 再用对应留底把封面装回去。
///
/// 全部成功才删历史 —— 撤销是一次性的，留着成功部分的历史会让第二次点击
/// 变成"把已经改回去的文件再改回旧快照"（那是重放，不是撤销）。
///
/// **只允许退最近一批**。每一行存的都是「那次写入之前」的状态，退更早的一批会把
/// 之后其它写入的成果一起盖掉；而一旦把历史列成面板给人点，这种点法几乎一定会发生。
/// 所以判据放在这里（后端），不是放在按钮的显示条件上（前端能绕）。
pub fn rollback_tag_batch(app: &tauri::AppHandle, batch_id: &str) -> Result<RollbackReport, String> {
    let rows = crate::services::music_db::music_tag_history_rows(app, batch_id)?;
    if rows.is_empty() {
        return Err("这一批没有可撤销的写回记录".to_string());
    }
    if let Some(newest) = crate::services::music_db::music_tag_batches(app, 1)?.first() {
        if newest.batch_id != batch_id {
            return Err(format!(
                "只能撤销最近一次写回（{}）；这批之后又写过别的内容，退它会把之后的改动一起盖掉",
                newest.batch_id
            ));
        }
    }
    let mut report = RollbackReport { files: 0, covers_restored: 0, failed: Vec::new(), restored_paths: Vec::new() };
    for row in rows {
        match restore_one(app, &row) {
            Ok(cover_restored) => {
                report.files += 1;
                report.restored_paths.push(row.file_path.clone());
                if cover_restored {
                    report.covers_restored += 1;
                }
            }
            Err(e) => report.failed.push(format!("{}: {}", row.file_path, e)),
        }
    }
    if report.failed.is_empty() {
        crate::services::music_db::music_drop_tag_history_batch(app, batch_id)?;
    } else {
        eprintln!("[music_service] 批次 {} 有 {} 项撤销失败，历史保留", batch_id, report.failed.len());
    }
    Ok(report)
}

/// 把一行历史恢复回文件。返回是否同时恢复了封面。
fn restore_one(app: &tauri::AppHandle, row: &crate::services::music_db::TagHistoryRow) -> Result<bool, String> {
    // 快照字段是必填的：解析不进来就说明这条历史不完整，宁可失败也不能按默认值
    // （全空串）写回 —— 那等于把用户文件的标签清空。
    let snap: TagSnapshot =
        serde_json::from_str(&row.old_json).map_err(|e| format!("改前快照不完整，拒绝写回: {}", e))?;
    let resolved = canonical_path_of(&row.file_path);
    let mut tagged_file = read_from_path(&resolved).map_err(|e| format!("读取音频失败: {}", e))?;
    {
        let tag = if let Some(t) = tagged_file.primary_tag_mut() {
            t
        } else {
            tagged_file
                .first_tag_mut()
                .ok_or_else(|| "文件不含可写标签".to_string())?
        };
        let dropped = apply_snapshot_to_tag(tag, &snap);
        if !dropped.is_empty() {
            eprintln!(
                "[music_service] 撤销时有字段该格式没有位置、未能恢复: {} ({})",
                dropped.join("、"),
                row.file_path
            );
        }
    }
    tagged_file
        .save_to_path(&resolved, lofty::config::WriteOptions::default())
        .map_err(|e| format!("写回失败: {}", e))?;
    // 顺带刷新曲库缓存里显示的那份标题/歌手/专辑（与手动编辑同一套同步逻辑）
    let _ = rescan_track_metadata(app, row.file_path.clone());
    let mut cover_restored = false;
    if let Some(backup) = &row.cover_backup {
        restore_cover_from_backup(app, &row.file_path, backup)?;
        cover_restored = true;
    }
    Ok(cover_restored)
}

/// 留底文件的 mime（按扩展名反推，认不出当 jpeg）
fn mime_from_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        _ => "image/jpeg",
    }
}

/// 列出某文件换封面时留下的旧封面，新 → 旧。
pub fn list_cover_backups(app: &tauri::AppHandle, file_path: String) -> Result<Vec<String>, String> {
    let dir = cover_backup_dir_of(app).ok_or_else(|| "无法获取留底目录".to_string())?;
    let resolved = canonical_path_of(&file_path);
    let prefix = format!("{}_", path_hash_of(&resolved));
    let mut names: Vec<String> = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("读取留底目录失败: {}", e))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(&prefix) && entry.path().is_file() {
            names.push(name);
        }
    }
    // 文件名里是定宽秒级时间戳，字典序倒排即时间倒序
    names.sort_by(|a, b| b.cmp(a));
    Ok(names.into_iter().map(|n| dir.join(n).to_string_lossy().to_string()).collect())
}

/// 用某个留底文件覆盖当前内嵌封面（单独撤销一次换封面）。
pub fn restore_cover_from_backup(
    app: &tauri::AppHandle,
    file_path: &str,
    backup_path: &str,
) -> Result<String, String> {
    let dir = cover_backup_dir_of(app).ok_or_else(|| "无法获取留底目录".to_string())?;
    let candidate = Path::new(backup_path)
        .canonicalize()
        .map_err(|e| format!("留底文件不存在: {}", e))?;
    let root = dir.canonicalize().map_err(|e| format!("留底目录不可用: {}", e))?;
    // 路径由前端传入，必须钉在留底目录内，否则等于给了一个任意文件读取的口子
    if !candidate.starts_with(&root) {
        return Err("留底路径不在封面留底目录内，已拒绝".to_string());
    }
    let bytes = std::fs::read(&candidate).map_err(|e| format!("读取留底失败: {}", e))?;
    let ext = candidate
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();
    let mime = mime_from_ext(&ext);
    let resolved = canonical_path_of(file_path);
    // backup_dir 传 None：恢复本身就是撤销动作，不该再吃掉一份留底名额
    embed_cover_into_file(&resolved, &bytes, Some(mime), None)?;
    sync_cover_after_embed(app, file_path)
}

// ============ 字段 × 容器支持矩阵（前端置灰的唯一依据）============

/// 某容器能写哪些标签字段。
///
/// 判据用 lofty 自己的 `ItemKey::map_key(tag_type)`：映射不到就是**没有帧位**，
/// 写了会被静默丢弃（`Tag::insert` 的 `re_map` 校验不过）。这把"哪些格子该灰"
/// 留在知道信息的那一层，而不是让前端照经验猜容器。
/// 与实测一致：WAV(RIFF INFO) 有 ICRD(作曲)、没有专辑艺人/作词/碟号。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagFieldSupport {
    /// 文件里已有的标签族；空数组 = lofty 认不出该容器（如 .wma）
    pub tag_types: Vec<String>,
    /// 本次会写进哪个标签族（已有 primary 就用它，否则按容器推断）
    pub target_tag_type: String,
    /// 该容器有没有可写标签位（ADTS .aac 为 false：容器能读但没有标签结构）
    pub writable: bool,
    pub supported: Vec<String>,
    pub unsupported: Vec<String>,
}

/// 参与矩阵的字段名（camelCase，与 `music_edit_track` 的参数名一一对应）
const SUPPORT_PROBE_FIELDS: &[(&str, lofty::tag::ItemKey)] = &[
    ("title", lofty::tag::ItemKey::TrackTitle),
    ("artist", lofty::tag::ItemKey::TrackArtist),
    ("album", lofty::tag::ItemKey::AlbumTitle),
    ("albumArtist", lofty::tag::ItemKey::AlbumArtist),
    ("year", lofty::tag::ItemKey::RecordingDate),
    ("trackNumber", lofty::tag::ItemKey::TrackNumber),
    ("trackTotal", lofty::tag::ItemKey::TrackTotal),
    ("discNumber", lofty::tag::ItemKey::DiscNumber),
    ("discTotal", lofty::tag::ItemKey::DiscTotal),
    ("genre", lofty::tag::ItemKey::Genre),
    ("composer", lofty::tag::ItemKey::Composer),
    ("lyricist", lofty::tag::ItemKey::Lyricist),
    ("comment", lofty::tag::ItemKey::Comment),
];

/// 给定标签族，算出哪些字段有帧位、哪些没有（纯函数，便于单测交叉验证）
pub fn field_support_for(
    target_type: lofty::tag::TagType,
) -> (Vec<String>, Vec<String>) {
    let (mut supported, mut unsupported) = (Vec::new(), Vec::new());
    for (label, key) in SUPPORT_PROBE_FIELDS {
        if key.map_key(target_type).is_some() {
            supported.push((*label).to_string());
        } else {
            unsupported.push((*label).to_string());
        }
    }
    (supported, unsupported)
}

pub fn tag_field_support(file_path: &str) -> Result<TagFieldSupport, String> {
    let resolved = canonical_path_of(file_path);
    let tagged_file = read_from_path(&resolved).map_err(|e| format!("读取音频失败: {}", e))?;
    let tag_types: Vec<String> = tagged_file
        .tags()
        .iter()
        .map(|t| tag_type_label(t.tag_type()))
        .collect();
    // 已有标签就写回它；没有则按容器推断（此时 lofty 会新建对应族）
    let file_type = tagged_file.file_type();
    let target_type = match tagged_file.primary_tag().or_else(|| tagged_file.first_tag()) {
        Some(t) => t.tag_type(),
        None => file_type.primary_tag_type(),
    };
    // 读得进来 ≠ 写得回去：如 ID3v2 能从 FLAC 读出但写不回（lofty 标成 ReadOnly）
    let writable = file_type.tag_support(target_type).is_writable();
    let (supported, unsupported) = field_support_for(target_type);
    Ok(TagFieldSupport {
        tag_types,
        target_tag_type: tag_type_label(target_type),
        writable,
        supported,
        unsupported,
    })
}

// ============ 在线候选打分（批量自动匹配的选优环节） ============

/// 本地文件的匹配依据（三个字段可以有空，空字符串按「缺该维度」处理）。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMeta {
    pub title: String,
    pub artist: String,
    pub album: String,
}

/// 在线候选参与打分的字段。
///
/// 只收这三项：打分引擎不该关心封面 URL 之类的富字段，
/// 排序结果回吐**下标**，前端仍然拿自己那条完整对象。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateMeta {
    pub name: String,
    pub artist: String,
    pub album: String,
}

/// 打分结果：候选在原数组中的下标 + 得分。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankedCandidate {
    pub index: usize,
    pub score: i32,
}

/// 单项相似度：规范化后相等 2 分，互相包含 1 分，否则 0 分。
///
/// 规范化复用 `music_db::normalize_meta`（多歌手分隔符 `/ & ，、；` 与全角、
/// 连续空白、大小写都归一，且刻意不拆词以保住 `AC/DC` 这类乐队名）。
/// 繁简体归一**没有**做：本项目现成的繁简表只覆盖 227 字，抽查 28 个繁体常用
/// 歌名用字缺 15 个（聲/聽/藝/夢/韻…），拿它匹配会大面积漏判，宁缺毋滥。
fn meta_similarity(a: &str, b: &str) -> i32 {
    let x = crate::services::music_db::normalize_meta(a);
    let y = crate::services::music_db::normalize_meta(b);
    if x.is_empty() || y.is_empty() {
        return 0;
    }
    if x == y {
        return 2;
    }
    if x.contains(&y) || y.contains(&x) {
        return 1;
    }
    0
}

/// 对候选列表打分并按得分降序返回。
///
/// 公式对齐「音乐标签」Web 版（GPL-3.0）的实现，逐条重写而非搬运：
/// - 标题分为 0 的候选直接淘汰（标题都对不上，别的字段再像也是误匹配）
/// - 本地有歌手而歌手完全不像 → 记 -2，把「同名不同人」压到队尾
/// - 本地没有歌手（文件名是「歌手 - 歌名」式）而歌手/标题都像 → 标题分提到 2
/// - 歌手/专辑缺失时退回用标题比对，避免空字段直接判 0
fn score_candidates(local: &LocalMeta, candidates: &[CandidateMeta]) -> Vec<RankedCandidate> {
    let fallback_title = local.title.as_str();
    let mut scored: Vec<RankedCandidate> = Vec::with_capacity(candidates.len());
    for (index, c) in candidates.iter().enumerate() {
        let title_score = meta_similarity(fallback_title, &c.name);
        if title_score == 0 {
            continue;
        }
        let artist_query = if local.artist.trim().is_empty() { fallback_title } else { local.artist.as_str() };
        let album_query = if local.album.trim().is_empty() { fallback_title } else { local.album.as_str() };
        let mut artist_score = meta_similarity(artist_query, &c.artist);
        let album_score = meta_similarity(album_query, &c.album);

        if !local.artist.trim().is_empty() && artist_score == 0 {
            artist_score = -2;
        }
        // 本地没有独立歌手字段（文件名是「歌手 - 歌名」式）时，候选的歌手与标题双双命中
        // 说明标题串本身就带着歌手信息 → 标题按满分算，否则这类文件永远排在纯标题命中之后
        let title_final = if local.artist.trim().is_empty() && artist_score >= 1 && title_score >= 1 {
            2
        } else {
            title_score
        };
        scored.push(RankedCandidate { index, score: title_final + artist_score + album_score });
    }
    scored.sort_by(|a, b| b.score.cmp(&a.score).then(a.index.cmp(&b.index)));
    scored
}

/// 打分并截断到前 `limit` 条（默认 15，与「音乐标签」Web 版一致）。
pub fn rank_tag_candidates(local: LocalMeta, candidates: Vec<CandidateMeta>, limit: Option<usize>) -> Vec<RankedCandidate> {
    let keep = limit.unwrap_or(15);
    let mut ranked = score_candidates(&local, &candidates);
    ranked.truncate(keep);
    ranked
}

#[cfg(test)]
mod tests {
    use super::*;
    use lofty::tag::{ItemKey, Tag, TagType};

    fn id3() -> Tag {
        Tag::new(TagType::Id3v2)
    }

    #[test]
    fn id3v2_不认year键_这是统一写recordingdate的原因() {
        // lofty 的 Tag::insert 会先校验该 TagType 有没有这个键的帧映射，
        // 校验不过直接静默丢弃并返回 false。ID3v2 没有 Year 的位置。
        let mut tag = id3();
        assert!(
            !tag.insert_text(ItemKey::Year, "2003".to_string()),
            "ID3v2 若开始支持 ItemKey::Year，本用例与 apply_year_item 的注释需要一起复核"
        );
        assert_eq!(tag.get_string(ItemKey::Year), None);
    }

    #[test]
    fn 年份_四位数字落recordingdate且覆盖旧日期() {
        let mut tag = id3();
        tag.insert_text(ItemKey::RecordingDate, "2001-02-03".to_string());
        assert!(apply_year_item(&mut tag, "2003"));
        assert_eq!(tag.get_string(ItemKey::RecordingDate), Some("2003"));
    }

    #[test]
    fn 年份_完整日期原样保留() {
        let mut tag = id3();
        assert!(apply_year_item(&mut tag, "2003-05-01"));
        assert_eq!(tag.get_string(ItemKey::RecordingDate), Some("2003-05-01"));
    }

    #[test]
    fn 年份_空串清除() {
        let mut tag = id3();
        apply_year_item(&mut tag, "2003-05-01");
        assert!(apply_year_item(&mut tag, "  "));
        assert_eq!(tag.get_string(ItemKey::RecordingDate), None);
    }

    #[test]
    fn 文本项_none保持不动_空串清除() {
        let mut tag = id3();
        tag.insert_text(ItemKey::TrackTitle, "原名".to_string());
        // None → 不动
        apply_text_item(&mut tag, ItemKey::TrackTitle, None);
        assert_eq!(tag.get_string(ItemKey::TrackTitle), Some("原名"));
        // Some("") → 清除
        apply_text_item(&mut tag, ItemKey::TrackTitle, Some(""));
        assert_eq!(tag.get_string(ItemKey::TrackTitle), None);
    }

    #[test]
    fn 碟号写discnumber并可读回() {
        let mut tag = id3();
        apply_number_item(&mut tag, ItemKey::DiscNumber, Some(2));
        assert_eq!(tag.disk(), Some(2));
        // None → 不改动已写好的值
        apply_number_item(&mut tag, ItemKey::DiscNumber, None);
        assert_eq!(tag.disk(), Some(2));
    }

    #[test]
    fn 标签族展示名可读() {
        assert_eq!(tag_type_label(TagType::Id3v2), "ID3v2");
        assert_eq!(tag_type_label(TagType::VorbisComments), "Vorbis");
    }

    /// 真实音频文件的完整往返（手动跑，不进 CI）。
    /// 用法：把待测文件**复制**到临时目录后，用环境变量指向副本：
    ///   MUSICTAG_FIXTURE=/tmp/x.flac cargo test --lib --features test-manifest \
    ///     真实文件往返 -- --ignored --nocapture
    /// 原件只读：本用例只接受副本路径，写操作全部发生在该路径上。
    #[test]
    #[ignore = "需要本机音频文件副本，手动用 MUSICTAG_FIXTURE 指定"]
    fn 真实文件往返_全部新字段可读回() {
        let src = std::env::var("MUSICTAG_FIXTURE").expect("需要 MUSICTAG_FIXTURE 指向一个副本文件");
        let mut tagged = lofty::read_from_path(&src).expect("lofty 读不了该副本");
        {
            let tag = if let Some(t) = tagged.primary_tag_mut() {
                t
            } else {
                tagged.first_tag_mut().expect("无可写标签")
            };
            use lofty::tag::ItemKey;
            // 各容器没有相同的字段位（如 WAV 的 RIFF INFO 没有专辑艺人），
            // 这里逐项记录而不是撞到第一个就 panic，用来产出「字段 × 容器」支持矩阵。
            let mut attempts: Vec<(&'static str, bool)> = Vec::new();
            attempts.push(("title", apply_text_item(tag, ItemKey::TrackTitle, Some("标题X"))));
            attempts.push(("albumArtist", apply_text_item(tag, ItemKey::AlbumArtist, Some("艺人Y"))));
            attempts.push(("genre", apply_text_item(tag, ItemKey::Genre, Some("流行"))));
            attempts.push(("composer", apply_text_item(tag, ItemKey::Composer, Some("作曲Z"))));
            attempts.push(("lyricist", apply_text_item(tag, ItemKey::Lyricist, Some("作词W"))));
            attempts.push(("comment", apply_text_item(tag, ItemKey::Comment, Some("备注V"))));
            attempts.push(("year", apply_year_item(tag, "2003")));
            attempts.push(("track", apply_number_item(tag, ItemKey::TrackNumber, Some(3))));
            attempts.push(("trackTotal", apply_number_item(tag, ItemKey::TrackTotal, Some(12))));
            attempts.push(("disc", apply_number_item(tag, ItemKey::DiscNumber, Some(2))));
            println!(
                "写入被丢弃: {}",
                if attempts.iter().any(|(_, ok)| !*ok) {
                    attempts
                        .iter()
                        .filter(|(_, ok)| !*ok)
                        .map(|(n, _)| *n)
                        .collect::<Vec<_>>()
                        .join("、")
                } else {
                    "无".to_string()
                }
            );
        }
        tagged
            .save_to_path(&src, lofty::config::WriteOptions::default())
            .expect("保存失败");

        let reread = lofty::read_from_path(&src).expect("回读失败");
        let tag = reread.primary_tag().or_else(|| reread.first_tag()).expect("回读无标签");
        use lofty::tag::ItemKey;
        let get = |k: ItemKey| tag.get_string(k).map(|s| s.to_string());
        println!("--- 副本 {} 往返结果 ---", src);
        println!("title        = {:?}", get(ItemKey::TrackTitle));
        println!("albumArtist  = {:?}", get(ItemKey::AlbumArtist));
        println!("genre        = {:?}", get(ItemKey::Genre));
        println!("composer     = {:?}", get(ItemKey::Composer));
        println!("lyricist     = {:?}", get(ItemKey::Lyricist));
        println!("comment      = {:?}", get(ItemKey::Comment));
        println!("date()       = {:?}", tag.date().map(|d| d.to_string()));
        println!("track        = {:?}/{:?}", tag.track(), tag.track_total());
        println!("disc         = {:?}/{:?}", tag.disk(), tag.disk_total());
        println!("tagTypes     = {:?}", reread.tags().iter().map(|t| tag_type_label(t.tag_type())).collect::<Vec<_>>());
        let p = reread.properties();
        println!(
            "props        = sr={:?} bit={:?} ch={:?} kbps={:?}",
            p.sample_rate(), p.bit_depth(), p.channels(), p.audio_bitrate()
        );
        // 只对「所有容器都应成立」的核心字段断言；albumArtist/lyricist/disc
        // 在 RIFF INFO 里没有位置，属于格式本身的限制，由上面的「写入被丢弃」行如实记录。
        assert_eq!(get(ItemKey::TrackTitle).as_deref(), Some("标题X"));
        assert_eq!(get(ItemKey::Genre).as_deref(), Some("流行"));
        assert_eq!(tag.track(), Some(3));
        assert_eq!(tag.track_total(), Some(12));
        assert_eq!(tag.date().map(|d| d.year), Some(2003));
    }

    fn seed_backups(dir: &Path, hash: &str, stamps: &[&str]) {
        for ts in stamps {
            std::fs::write(dir.join(format!("{}_{}_x.jpg", hash, ts)), b"x").expect("建测试文件失败");
        }
    }

    fn names_with(dir: &Path, prefix: &str) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(prefix))
            .collect();
        v.sort();
        v
    }

    #[test]
    fn 封面留底_同文件只留最近三份且不动别的文件() {
        let dir = std::env::temp_dir().join("adyh_cover_prune_keep3");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        seed_backups(&dir, "aaa", &["0000000001", "0000000002", "0000000003", "0000000004", "0000000005"]);
        seed_backups(&dir, "bbb", &["0000000009"]);

        assert_eq!(prune_cover_backups(&dir, "aaa", COVER_BACKUP_KEEP).unwrap(), 2);

        let left = names_with(&dir, "aaa_");
        assert_eq!(left.len(), 3, "只应留最近 3 份，实际: {:?}", left);
        assert!(left.iter().any(|n| n.contains("0000000005")));
        assert!(left.iter().any(|n| n.contains("0000000004")));
        assert!(left.iter().any(|n| n.contains("0000000003")));
        assert!(!left.iter().any(|n| n.contains("0000000001")));
        assert_eq!(names_with(&dir, "bbb_").len(), 1, "别的文件的留底不该被牵连");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 封面留底_未超上限时一份都不删() {
        let dir = std::env::temp_dir().join("adyh_cover_prune_below");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        seed_backups(&dir, "ccc", &["0000000001", "0000000002", "0000000003"]);
        assert_eq!(prune_cover_backups(&dir, "ccc", COVER_BACKUP_KEEP).unwrap(), 0);
        assert_eq!(names_with(&dir, "ccc_").len(), COVER_BACKUP_KEEP);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 真文件端到端验证换封面留底（手动跑，需要 MUSICTAG_FIXTURE 指向副本）。
    /// 连换 4 次封面 ⇒ 留底目录应只剩最近 3 份，且最新一份是"刚被覆盖掉的那张"。
    #[test]
    #[ignore = "需要本机音频文件副本，手动用 MUSICTAG_FIXTURE 指定"]
    fn 封面留底_真文件连换六次只留三份() {
        let src = std::env::var("MUSICTAG_FIXTURE").expect("需要 MUSICTAG_FIXTURE");
        let resolved = canonical_path_of(&src);
        let backup = std::env::temp_dir().join("adyh_cover_real_backup");
        let _ = std::fs::remove_dir_all(&backup);
        std::fs::create_dir_all(&backup).unwrap();

        // 6 张可区分的假封面（JPEG 头 + 尾字节做标识），逐张写进同一个文件。
        // 换 6 次 ⇒ 至少产生 5 份留底（第一次换时原文件可能没有内嵌封面，就不留底），
        // 无论原始有没有封面，最后留下的最新一份都应该是刚被覆盖掉的第 5 张。
        for marker in 1..=6u8 {
            let mut jpeg = vec![0xFFu8, 0xD8, 0xFF, 0xE0];
            jpeg.extend_from_slice(&[marker; 32]);
            jpeg.extend_from_slice(&[0xFF, 0xD9]);
            embed_cover_into_file(&resolved, &jpeg, Some("image/jpeg"), Some(&backup))
                .expect("换封面失败");
            std::thread::sleep(std::time::Duration::from_millis(1100)); // 时间戳按秒，隔开才可排序
        }

        let hash = path_hash_of(&resolved);
        let left = names_with(&backup, &format!("{}_", hash));
        assert_eq!(left.len(), COVER_BACKUP_KEEP, "4 次换封面后应只留 3 份，实际: {:?}", left);
        // 最新一份留底 = 第 3 张（marker=3），因为它被第 4 张覆盖掉
        let newest = backup.join(left.last().unwrap());
        let bytes = std::fs::read(&newest).unwrap();
        assert!(bytes[4..36].iter().all(|b| *b == 5u8), "最新留底应是刚被覆盖的第 5 张封面");
        let _ = std::fs::remove_dir_all(&backup);
    }

    #[test]
    fn 留底扩展名按mime推断且认不出时按jpg() {
        assert_eq!(picture_ext(Some("image/png")), "png");
        assert_eq!(picture_ext(Some("image/webp")), "webp");
        assert_eq!(picture_ext(Some("application/octet-stream")), "jpg");
        assert_eq!(picture_ext(None), "jpg");
    }

    #[test]
    fn 快照能把批量新写入的字段撤销掉() {
        let mut tag = id3();
        tag.insert_text(ItemKey::TrackTitle, "原名".to_string());
        let snap = snapshot_of_tagged(&tag);
        assert_eq!(snap.title, "原名");
        assert_eq!(snap.genre, "", "当时没有流派 → 记成空串");

        // 模拟这一批写入了流派与年份
        assert!(apply_text_item(&mut tag, ItemKey::Genre, Some("流行")));
        assert!(apply_year_item(&mut tag, "2003"));

        let dropped = apply_snapshot_to_tag(&mut tag, &snap);
        assert!(dropped.is_empty(), "ID3v2 这些字段都有位置: {:?}", dropped);
        assert_eq!(tag.get_string(ItemKey::TrackTitle), Some("原名"));
        assert_eq!(tag.get_string(ItemKey::Genre), None, "批量新加的流派必须被撤掉");
        assert_eq!(tag.get_string(ItemKey::RecordingDate), None, "批量新加的年份必须被撤掉");
    }

    #[test]
    fn 撤销时被格式没有位置的字段要点名报出() {
        // RIFF INFO 没有专辑艺人的帧位，恢复这类字段只能如实报跳过
        let mut tag = lofty::tag::Tag::new(lofty::tag::TagType::RiffInfo);
        let snap = TagSnapshot {
            album_artist: "艺人".to_string(),
            title: "歌名".to_string(),
            ..Default::default()
        };
        let dropped = apply_snapshot_to_tag(&mut tag, &snap);
        assert!(dropped.contains(&"专辑艺人"), "应报出专辑艺人: {:?}", dropped);
        // 有位置的字段照常恢复
        assert_eq!(tag.get_string(ItemKey::TrackTitle), Some("歌名"));
    }

    #[test]
    fn 快照序列化能读回_坏数据不会被当成空标签() {
        let snap = TagSnapshot { title: "T".into(), year: "2003".into(), ..Default::default() };
        let json = serde_json::to_string(&snap).unwrap();
        let back: TagSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(back.title, "T");
        assert_eq!(back.year, "2003");
        // 残缺的历史行（比如只存了半个对象）必须解析失败，
        // 不能退化成"全空串快照"——那等于撤销时把用户标签清空
        assert!(serde_json::from_str::<TagSnapshot>(r#"{"title":"T"}"#).is_err());
        assert!(serde_json::from_str::<TagSnapshot>("{}").is_err());
    }

    #[test]
    fn 批次号带来源前缀且按毫秒区分() {
        let a = new_batch_id("single");
        let b = new_batch_id("batch");
        assert!(a.starts_with("single_"));
        assert!(b.starts_with("batch_"));
        assert_ne!(a, b);
    }

    /// 规则挂载点：写文件之前必须先落改前快照。
    ///
    /// 顺序一旦被人调回去，覆盖原文件就没有退路了，所以把「快照先于写盘」钉成测试
    /// （对齐本项目 agentContract.test.ts 用源码内容守住规则的做法），不靠注释自觉。
    #[test]
    fn 闸门_落快照必须排在写盘之前() {
        let src = include_str!("music_service.rs");
        let body = src
            .split("pub fn edit_track_tags(")
            .nth(1)
            .expect("edit_track_tags 应存在")
            .split("
}
")
            .next()
            .expect("函数体");
        let record = body
            .find("music_record_tag_snapshot")
            .expect("edit_track_tags 必须落改前快照");
        let save = body.find("save_to_path").expect("edit_track_tags 必须写盘");
        assert!(
            record < save,
            "改前快照必须在 save_to_path 之前落库，否则覆盖原文件没有退路"
        );

        // 批量入口必须走同一条带闸门的通路，不能自己另开一次裸写
        let batch = src
            .split("pub fn batch_edit_tracks(")
            .nth(1)
            .expect("batch_edit_tracks 应存在")
            .split("
}
")
            .next()
            .unwrap();
        assert!(batch.contains("edit_track_tags("), "批量写回必须复用带快照闸门的 edit_track_tags");
        assert!(!batch.contains("save_to_path"), "批量入口不该绕过闸门直接写盘");
    }


    fn cand(name: &str, artist: &str, album: &str) -> CandidateMeta {
        CandidateMeta { name: name.to_string(), artist: artist.to_string(), album: album.to_string() }
    }

    fn local(title: &str, artist: &str, album: &str) -> LocalMeta {
        LocalMeta { title: title.to_string(), artist: artist.to_string(), album: album.to_string() }
    }

    #[test]
    fn 三个维度全等的候选排在最前() {
        let ranked = rank_tag_candidates(
            local("稻香", "周杰伦", "魔杰座"),
            vec![cand("稻香 (Live)", "周杰伦", "爱的四季"), cand("稻香", "周杰伦", "魔杰座")],
            None,
        );
        assert_eq!(ranked[0].index, 1, "全等的那条应排第一: {:?}", ranked);
        assert_eq!(ranked[0].score, 6, "标题2+歌手2+专辑2");
    }

    #[test]
    fn 同名不同人的候选被负分压到队尾() {
        let ranked = rank_tag_candidates(
            local("晴天", "周杰伦", "叶惠美"),
            vec![cand("晴天", "张三", "某精选集"), cand("晴天", "周杰伦", "叶惠美")],
            None,
        );
        assert_eq!(ranked[0].index, 1);
        let loser = ranked.iter().find(|r| r.index == 0).expect("不该被淘汰");
        assert!(loser.score <= 0, "歌手完全不对应该吃到 -2 惩罚: {:?}", ranked);
    }

    #[test]
    fn 多歌手分隔符写法不同不扣分() {
        let ranked = rank_tag_candidates(
            local("珊瑚海", "周杰伦/Lara", "七里香"),
            vec![cand("珊瑚海", "周杰伦 & Lara", "七里香")],
            None,
        );
        assert_eq!(ranked[0].score, 6, "分隔符差异不该影响得分: {:?}", ranked);
    }

    #[test]
    fn 标题带现场后缀仍算部分命中() {
        let ranked = rank_tag_candidates(local("稻香", "周杰伦", ""), vec![cand("稻香 (Live)", "周杰伦", "")], None);
        // 标题互含 1 分 + 歌手全等 2 分 + 专辑（本地无专辑 → 拿标题比，候选专辑为空算 0）
        assert_eq!(ranked[0].score, 3, "互含按 1 分算: {:?}", ranked);
    }

    #[test]
    fn 标题完全对不上的候选直接淘汰() {
        let ranked = rank_tag_candidates(
            local("稻香", "周杰伦", "魔杰座"),
            vec![cand("青花瓷", "周杰伦", "依然范特西"), cand("稻香", "周杰伦", "魔杰座")],
            None,
        );
        assert_eq!(ranked.len(), 1, "青花瓷那条标题 0 分应被淘汰: {:?}", ranked);
        assert_eq!(ranked[0].index, 1);
    }

    #[test]
    fn 文件名式标题带歌手时标题按满分算() {
        // 本地没有独立歌手字段：标题是「周杰伦 - 晴天」这种串，候选歌手/标题都能对上
        let ranked = rank_tag_candidates(
            local("周杰伦 - 晴天", "", ""),
            vec![cand("晴天", "周杰伦", "叶惠美"), cand("晴天 (翻唱版)", "某人", "")],
            None,
        );
        assert_eq!(ranked[0].index, 0, "带歌手的标题串应让真正对应的候选胜出: {:?}", ranked);
    }

    #[test]
    fn 同分按原始顺序稳定排列且limit生效() {
        let many: Vec<CandidateMeta> = (0..20).map(|_| cand("稻香", "周杰伦", "魔杰座")).collect();
        let ranked = rank_tag_candidates(local("稻香", "周杰伦", "魔杰座"), many, Some(3));
        assert_eq!(ranked.len(), 3);
        assert_eq!(ranked.iter().map(|r| r.index).collect::<Vec<_>>(), vec![0, 1, 2], "同分要保持先来后到");
    }

    #[test]
    fn 默认取前十五条() {
        let many: Vec<CandidateMeta> = (0..30).map(|_| cand("稻香", "周杰伦", "魔杰座")).collect();
        assert_eq!(rank_tag_candidates(local("稻香", "周杰伦", "魔杰座"), many, None).len(), 15);
    }

    #[test]
    fn 字段支持矩阵与真文件实测一致() {
        use lofty::tag::TagType;
        let (sup, unsup) = field_support_for(TagType::Id3v2);
        assert!(unsup.is_empty(), "ID3v2 应支持全部字段，实际缺: {:?}", unsup);
        assert_eq!(sup.len(), 13);

        // 与 WAV 副本实测对齐：RIFF INFO 有 ICRD(作曲)，没有专辑艺人/作词/碟号
        let (sup_r, unsup_r) = field_support_for(TagType::RiffInfo);
        for k in ["albumArtist", "lyricist", "discNumber"] {
            assert!(unsup_r.contains(&k.to_string()), "RIFF INFO 不该有 {}", k);
        }
        for k in ["title", "artist", "album", "composer", "genre", "year"] {
            assert!(sup_r.contains(&k.to_string()), "RIFF INFO 应有 {}", k);
        }

        // MP4 也应放得下专辑艺人（aART），这是中文曲库常用的归并字段
        let (sup_m, unsup_m) = field_support_for(TagType::Mp4Ilst);
        assert!(sup_m.contains(&"title".to_string()));
        assert!(sup_m.contains(&"albumArtist".to_string()), "MP4 该有 aART，实际缺: {:?}", unsup_m);

        // APEv2 反过来：它比想象中完整，13 个字段全有位置。
        // 原先我在注释里写过「APEv2 无作曲/作词」，那条是猜的、且是错的，已改掉。
        let (_, unsup_a) = field_support_for(TagType::Ape);
        assert!(unsup_a.is_empty(), "APEv2 实测应支持全部字段，实际缺: {:?}", unsup_a);
    }

}
