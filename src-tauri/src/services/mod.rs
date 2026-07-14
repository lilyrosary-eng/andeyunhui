pub mod note_service;
pub mod transfer_station;
pub mod image_service;
pub mod music_service;
pub mod video_service;
pub mod cache_service;
pub mod document_parser;
pub mod docx_wps;
pub mod pptx_wps;
pub mod pptx_import;
pub mod lyrics_service;
pub mod reading_service;
pub mod recording_service;
pub mod log_service;

use std::path::{Path, PathBuf};

/// 安全地把用户输入的 id 拼接到 base 目录上，防止路径遍历。
///
/// 校验链：
/// 1. id 不能为空、不能含路径分隔符（`/` `\`）或 `..`；
/// 2. join 后 canonicalize，确保规范路径仍位于 base 之内。
///
/// 用于 note_id、plugin_id 等会被拼接进文件路径的不可信输入。
/// `base` 通常是已存在的应用数据目录。
pub fn safe_join(base: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty()
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
        || id.chars().any(|c| c.is_control())
    {
        return Err(format!("非法标识符: {id:?}"));
    }
    let joined = base.join(id);
    // base 可能尚未存在（首次写入）；若已存在则做 canonicalize 校验
    if let Ok(base_canon) = base.canonicalize() {
        if let Ok(joined_canon) = joined.canonicalize() {
            if !joined_canon.starts_with(&base_canon) {
                return Err(format!("路径越界: {}", joined_canon.display()));
            }
            return Ok(joined_canon);
        }
    }
    // base 或 joined 尚不存在：依赖前面的字符校验保证安全性
    Ok(joined)
}

/// 用安全方式拼接 `{id}.{ext}` 到 base，用于 `.md` / `.pin` 等扩展名文件。
pub fn safe_join_ext(base: &Path, id: &str, ext: &str) -> Result<PathBuf, String> {
    let safe_id = if id.is_empty()
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
        || id.chars().any(|c| c.is_control())
    {
        return Err(format!("非法标识符: {id:?}"));
    } else {
        id
    };
    let fname = format!("{safe_id}.{ext}");
    let joined = base.join(fname);
    if let Ok(base_canon) = base.canonicalize() {
        if let Ok(joined_canon) = joined.canonicalize() {
            if !joined_canon.starts_with(&base_canon) {
                return Err(format!("路径越界: {}", joined_canon.display()));
            }
            return Ok(joined_canon);
        }
    }
    Ok(joined)
}
