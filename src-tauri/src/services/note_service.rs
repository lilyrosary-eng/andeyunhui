use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use serde::Serialize;
use serde_json::Value;
use chrono::DateTime;
use crate::services::safe_join_ext;

// 从 Markdown 内容中提取标题（首行 # 开头的内容）
fn extract_title(content: &str) -> String {
    content
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("# "))
        .map(|t| t.trim().to_string())
        .unwrap_or_else(|| "无标题笔记".to_string())
}

/// 仅读取文件首行用于提取标题，避免大文件全量 read_to_string。
/// 返回 (首行字符串, 是否成功)；失败时返回空串。
fn read_first_line(path: &std::path::Path) -> String {
    let Ok(file) = fs::File::open(path) else { return String::new(); };
    let mut reader = BufReader::new(file);
    let mut first = String::new();
    // 忽略读取错误，返回已读部分
    let _ = reader.read_line(&mut first);
    first
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteInfo {
    pub id: String,
    pub title: String,
    pub date: String,
    pub pinned: bool,
}

// 读笔记列表（置顶笔记排前，其余按日期降序）
pub fn get_all_notes(notes_dir: PathBuf, pins_dir: PathBuf) -> Result<Vec<NoteInfo>, String> {
    if !notes_dir.exists() {
        fs::create_dir(&notes_dir).map_err(|e| format!("创建 notes 目录失败: {}", e))?;
    }

    let entries = fs::read_dir(&notes_dir).map_err(|e| format!("读取 notes 目录失败: {}", e))?;
    let mut notes = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("md") {
            let id = path.file_stem().and_then(|s| s.to_str()).ok_or("无法提取文件名")?.to_string();
            // 仅读首行提取标题，避免大笔记全量读取
            let first_line = read_first_line(&path);
            let title = extract_title(&first_line);
            let metadata = fs::metadata(&path).map_err(|e| format!("获取文件元数据失败: {}", e))?;
            let date = metadata.modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| {
                    let datetime = DateTime::from_timestamp(d.as_secs() as i64, 0)
                        .unwrap_or(DateTime::UNIX_EPOCH);
                    datetime.format("%Y-%m-%d").to_string()
                })
                .unwrap_or_else(|| "未知日期".to_string());
            let pinned = pins_dir.join(format!("{}.pin", id)).exists();
            notes.push(NoteInfo { id, title, date, pinned });
        }
    }
    // 置顶笔记排前，其余按日期降序
    notes.sort_by(|a, b| {
        if a.pinned && !b.pinned {
            std::cmp::Ordering::Less
        } else if !a.pinned && b.pinned {
            std::cmp::Ordering::Greater
        } else {
            b.date.cmp(&a.date)
        }
    });
    Ok(notes)
}

/// 批量搜索笔记内容，返回匹配的笔记 ID 列表
pub fn search_notes_content(notes_dir: PathBuf, query: &str) -> Result<Vec<String>, String> {
    if !notes_dir.exists() {
        return Ok(Vec::new());
    }
    let q = query.to_lowercase();
    let mut matched = Vec::new();
    let entries = fs::read_dir(&notes_dir).map_err(|e| format!("读取 notes 目录失败: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(id) => id.to_string(),
            None => continue,
        };
        if let Ok(content) = fs::read_to_string(&path) {
            if content.to_lowercase().contains(&q) {
                matched.push(id);
            }
        }
    }
    Ok(matched)
}

// 读单个笔记
pub fn get_note_content(notes_dir: PathBuf, note_id: &str) -> Result<Value, String> {
    let note_path = safe_join_ext(&notes_dir, note_id, "md")?;
    if !note_path.exists() {
        return Err(format!("笔记 {} 不存在", note_id));
    }
    let content = fs::read_to_string(&note_path).map_err(|e| format!("读取笔记文件失败: {}", e))?;
    let title = extract_title(&content);
    Ok(serde_json::json!({ "title": title, "content": content }))
}

// 保存笔记
pub fn save_note(notes_dir: PathBuf, note_id: &str, title: &str, content: &str) -> Result<(), String> {
    if !notes_dir.exists() {
        fs::create_dir(&notes_dir).map_err(|e| format!("创建 notes 目录失败: {}", e))?;
    }
    let note_path = safe_join_ext(&notes_dir, note_id, "md")?;
    let final_content = if content.lines().next().map(|s| s.starts_with("# ")).unwrap_or(false) {
        content.to_string()
    } else {
        format!("# {}\n\n{}", title, content)
    };
    fs::write(&note_path, final_content).map_err(|e| format!("写入笔记文件失败: {}", e))?;
    Ok(())
}

// 删除（移入回收站）
pub fn delete_note(notes_dir: PathBuf, trash_dir: PathBuf, note_id: &str) -> Result<(), String> {
    let note_path = safe_join_ext(&notes_dir, note_id, "md")?;
    if !note_path.exists() {
        return Ok(());
    }
    fs::create_dir_all(&trash_dir).map_err(|e| format!("无法创建回收站目录: {}", e))?;
    let trash_path = safe_join_ext(&trash_dir, note_id, "md")?;
    fs::rename(&note_path, &trash_path).map_err(|e| format!("移动文件到回收站失败: {}", e))?;
    Ok(())
}

// ========== 标签系统 ==========

/// 加载标签数据
fn load_tags(tags_path: &PathBuf) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    if !tags_path.exists() {
        return Ok(std::collections::HashMap::new());
    }
    let content = fs::read_to_string(tags_path).map_err(|e| format!("读取标签文件失败: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("解析标签文件失败: {}", e))
}

/// 获取单篇笔记的标签
pub fn get_note_tags(tags_path: PathBuf, note_id: &str) -> Result<Vec<String>, String> {
    let tags = load_tags(&tags_path)?;
    Ok(tags.get(note_id).cloned().unwrap_or_default())
}

/// 设置单篇笔记的标签
pub fn set_note_tags(tags_path: PathBuf, note_id: &str, new_tags: Vec<String>) -> Result<(), String> {
    let mut tags = load_tags(&tags_path)?;
    if new_tags.is_empty() {
        tags.remove(note_id);
    } else {
        tags.insert(note_id.to_string(), new_tags);
    }
    if let Some(parent) = tags_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建标签目录失败: {}", e))?;
    }
    let content = serde_json::to_string_pretty(&tags).map_err(|e| format!("序列化标签数据失败: {}", e))?;
    fs::write(&tags_path, content).map_err(|e| format!("写入标签文件失败: {}", e))?;
    Ok(())
}

/// 获取所有标签对应的笔记 ID 映射
pub fn get_all_note_tags_map(tags_path: PathBuf) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    load_tags(&tags_path)
}

/// 获取所有标签
pub fn get_all_tags(tags_path: PathBuf) -> Result<Vec<String>, String> {
    let tags = load_tags(&tags_path)?;
    let mut all: Vec<String> = tags.values()
        .flat_map(|v| v.iter().cloned())
        .collect();
    all.sort();
    all.dedup();
    Ok(all)
}

// 复制笔记
pub fn duplicate_note(notes_dir: PathBuf, note_id: &str) -> Result<String, String> {
    let source_path = safe_join_ext(&notes_dir, note_id, "md")?;
    if !source_path.exists() {
        return Err("原笔记不存在".to_string());
    }
    let new_id = format!("copy_{}", chrono::Utc::now().timestamp_millis());
    let new_path = safe_join_ext(&notes_dir, &new_id, "md")?;
    fs::copy(&source_path, &new_path).map_err(|e| format!("复制失败: {}", e))?;
    Ok(new_id)
}