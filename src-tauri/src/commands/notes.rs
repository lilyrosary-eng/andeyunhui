//! 笔记 CRUD、标签、收藏、AI 工作台产物、工作流
//!
//! 本文件由 commands.rs 拆分而来（2026-10-18，P1-5 拆 god file）。
//! 约定：用 `use super::*;` 取父模块的 use 与同级 item，不要在子模块里重复 import
//! 父模块已有的依赖；确需额外 import 时写显式路径（显式优先于 glob，不会冲突）。

#![allow(dead_code)] // 部分命令仅在特定平台/配置下被 invoke_handler 引用

use super::*;
#[tauri::command]
pub fn get_all_notes(app: AppHandle) -> Result<Vec<note_service::NoteInfo>, String> {
    let root_dir = notes_root_dir(&app)?;
    let notes_dir = root_dir.join("notes");
    let pins_dir = root_dir.join("pins");
    note_service::get_all_notes(notes_dir, pins_dir)
}

#[tauri::command]
pub fn search_notes_content(app: AppHandle, query: String) -> Result<Vec<String>, String> {
    let root_dir = notes_root_dir(&app)?;
    let notes_dir = root_dir.join("notes");
    note_service::search_notes_content(notes_dir, &query)
}

#[tauri::command]
pub fn get_note_content(app: AppHandle, note_id: &str) -> Result<Value, String> {
    let root_dir = notes_root_dir(&app)?;
    let notes_dir = root_dir.join("notes");
    note_service::get_note_content(notes_dir, note_id)
}

#[tauri::command]
pub fn save_note(app: AppHandle, note_id: &str, title: &str, content: &str) -> Result<(), String> {
    let root_dir = notes_root_dir(&app)?;
    let notes_dir = root_dir.join("notes");
    let note_path = crate::services::safe_join_ext(&notes_dir, note_id, "md")?;

    // 中转站自动备份：首次保存时备份原文件
    let config = transfer_station::load_config(&root_dir);
    if config.enabled {
        log::debug!(
            "[SaveNote] 自动保存已启用: note_id={}, title={}, content_len={}",
            note_id, title, content.len()
        );
        if note_path.exists() {
            let original = fs::read_to_string(&note_path).unwrap_or_default();
            match transfer_station::backup_original(&root_dir, note_id, &original) {
                Ok(Some(name)) => {
                    log::debug!("[SaveNote] 首次备份成功: backup={}", name);
                }
                Ok(None) => {
                    log::debug!("[SaveNote] 已有备份，跳过备份步骤");
                }
                Err(e) => {
                    log::warn!("[SaveNote] 备份失败（不影响主流程）: {}", e);
                }
            }
        } else {
            log::debug!("[SaveNote] 新文件首次保存: note_id={}, 无原文件可备份", note_id);
        }
        match transfer_station::save_to_transfer_station(&root_dir, note_id, content) {
            Ok(()) => {
                log::debug!("[SaveNote] 中转站同步完成: note_id={}", note_id);
            }
            Err(e) => {
                log::warn!("[SaveNote] 中转站同步失败（不影响主流程）: {}", e);
            }
        }
    } else {
        log::debug!(
            "[SaveNote] 自动保存已禁用，跳过中转站备份: note_id={}",
            note_id
        );
    }

    note_service::save_note(notes_dir, note_id, title, content)
}

// ========== 一期 AIWork / AIWorkflow 后端编排命令 ==========

/// AIWork 成果物落地：原子新建一篇笔记（后端生成 note_id），返回新笔记的 id 与标题。
/// 前端无需自行计算安全 id，一次调用即可把 AI 产出物沉淀进笔记库，形成「对话→文档→存档」闭环。
#[tauri::command]
pub fn aiwork_create_note(app: AppHandle, title: String, content: String) -> Result<Value, String> {
    let root_dir = notes_root_dir(&app)?;
    let notes_dir = root_dir.join("notes");
    let note_id = format!("note_{}", chrono::Utc::now().timestamp_millis());
    note_service::save_note(notes_dir, &note_id, &title, &content)?;
    Ok(serde_json::json!({ "noteId": note_id, "title": title }))
}

// ========== AIWork 产物文件落地（导出 / 删除 / 移动到收藏·待决） ==========
// 产物保存目录 / 收藏目录 / 待决目录由前端在模块设置里配置并传绝对路径；
// 产物命名为 {name}.md，文件操作走 spawn_blocking 避免阻塞 IPC 线程。

/// 把一段 AI 产出写成 .md 文件落到任意目录，返回最终绝对路径（供产物记录保存 path）。
#[tauri::command]
pub async fn ai_work_save_product_file(
    dir: String,
    name: String,
    content: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = std::path::Path::new(&dir);
        // create_dir_all 后目录存在，safe_join_ext 即可正常 canonicalize 越界校验
        std::fs::create_dir_all(base).map_err(|e| format!("创建目录失败: {e}"))?;
        let path = crate::services::safe_join_ext(base, &name, "md")?;
        std::fs::write(&path, content).map_err(|e| format!("写入产物失败: {e}"))?;
        Ok::<String, String>(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除一个产物文件（不存在则视为已删除，幂等）。
#[tauri::command]
pub async fn ai_work_delete_product_file(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        if p.exists() {
            std::fs::remove_file(p).map_err(|e| format!("删除产物失败: {e}"))?;
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 把产物文件移动到另一目录（收藏 / 待决）；返回移动后的绝对路径。
#[tauri::command]
pub async fn ai_work_move_product_file(from: String, to_dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = std::path::Path::new(&to_dir);
        std::fs::create_dir_all(base).map_err(|e| format!("创建目录失败: {e}"))?;
        let src = std::path::Path::new(&from);
        let fname = src
            .file_name()
            .and_then(|f| f.to_str())
            .ok_or_else(|| "路径缺少文件名".to_string())?;
        let dst = base.join(fname);
        if dst.exists() {
            std::fs::remove_file(&dst).map_err(|e| format!("移除旧文件失败: {e}"))?;
        }
        // rename 跨盘会失败，回退为 copy + remove
        if std::fs::rename(src, &dst).is_err() {
            std::fs::copy(src, &dst).map_err(|e| format!("移动产物失败: {e}"))?;
            std::fs::remove_file(src).map_err(|e| format!("清理原文件失败: {e}"))?;
        }
        Ok::<String, String>(dst.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// AIWork 成果物上下文聚合：一次拉取多篇笔记的内容摘要，供 LLM 做周报 / 总结 / 大纲。
/// 三选一：
///   - 传 `note_ids`：只读指定笔记；
///   - 传 `query`：走内容检索后读取匹配笔记；
///   - 都不传：取最近 `limit` 篇（默认 10）。
/// 每篇返回 `{ id, title, excerpt }`（excerpt 截断，避免全量塞入模型上下文）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiworkNoteContext {
    pub id: String,
    pub title: String,
    pub excerpt: String,
}

pub(crate) const AIWORK_EXCERPT_CAP: usize = 1200;

pub(crate) fn note_excerpt(content: &str) -> (String, String) {
    // 首行以 "# " 开头视为标题；excerpt 跳过标题行，截断到上限。
    let mut lines = content.lines();
    let first = lines.next().unwrap_or_default();
    let title = first.trim_start().strip_prefix("# ").map(|t| t.trim().to_string())
        .unwrap_or_else(|| "无标题笔记".to_string());
    let body: String = lines.collect::<Vec<_>>().join("\n");
    let mut excerpt: String = body.trim().chars().take(AIWORK_EXCERPT_CAP).collect();
    if body.trim().chars().count() > AIWORK_EXCERPT_CAP {
        excerpt.push_str("\n…（过长已截断）");
    }
    (title, excerpt)
}

#[tauri::command]
pub fn aiwork_context_aggregate(
    app: AppHandle,
    note_ids: Option<Vec<String>>,
    query: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<AiworkNoteContext>, String> {
    let root_dir = notes_root_dir(&app)?;
    let notes_dir = root_dir.join("notes");
    let pins_dir = root_dir.join("pins");
    let cap = limit.unwrap_or(10).max(1);

    // 1. 确定要读取的 id 列表
    let ids: Vec<String> = if let Some(ids) = note_ids.filter(|v| !v.is_empty()) {
        ids.into_iter().filter(|s| !s.is_empty()).collect()
    } else if let Some(q) = query.filter(|s| !s.trim().is_empty()) {
        note_service::search_notes_content(notes_dir.clone(), &q)?
    } else {
        // 按最近优先取前 cap 篇
        note_service::get_all_notes(notes_dir.clone(), pins_dir)?
            .into_iter()
            .map(|n| n.id)
            .take(cap)
            .collect()
    };

    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<AiworkNoteContext> = Vec::new();
    for id in ids {
        if !seen.insert(id.clone()) {
            continue;
        }
        match note_service::get_note_content(notes_dir.clone(), &id) {
            Ok(v) => {
                let content = v.get("content").and_then(|c| c.as_str()).unwrap_or_default();
                let (title, excerpt) = note_excerpt(content);
                out.push(AiworkNoteContext { id, title, excerpt });
            }
            Err(_) => continue, // 单篇失败不阻断整体
        }
        if out.len() >= cap {
            break;
        }
    }
    Ok(out)
}

// ============= AIWorkflow：蓝图持久化 + 执行日志 =============

/// 工作流原始目录（app_data_dir 下，供 workflow_service 使用）。
pub(crate) fn workflow_root(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    notes_root_dir(app)
}

#[tauri::command]
pub fn workflow_save(app: AppHandle, flow_id: String, name: String, json: Value) -> Result<(), String> {
    let root = workflow_root(&app)?;
    workflow_service::save_workflow(&root, &flow_id, &name, &json)
}

#[tauri::command]
pub fn workflow_get(app: AppHandle, flow_id: String) -> Result<Value, String> {
    let root = workflow_root(&app)?;
    workflow_service::get_workflow(&root, &flow_id)
}

#[tauri::command]
pub fn workflow_list(app: AppHandle) -> Result<Vec<workflow_service::WorkflowMeta>, String> {
    let root = workflow_root(&app)?;
    workflow_service::list_workflows(&root)
}

#[tauri::command]
pub fn workflow_delete(app: AppHandle, flow_id: String) -> Result<(), String> {
    let root = workflow_root(&app)?;
    workflow_service::delete_workflow(&root, &flow_id)
}

#[tauri::command]
pub fn workflow_log_append(app: AppHandle, run_id: String, node_label: String, status: String, detail: String) -> Result<(), String> {
    let root = workflow_root(&app)?;
    workflow_service::append_run_log(&root, &run_id, &node_label, &status, &detail)
}

#[tauri::command]
pub fn workflow_log_list(app: AppHandle, run_id: String) -> Result<Vec<Value>, String> {
    let root = workflow_root(&app)?;
    workflow_service::list_run_logs(&root, &run_id)
}

#[tauri::command]
pub fn toggle_pin_note(app: AppHandle, note_id: String) -> Result<String, String> {
    let root_dir = notes_root_dir(&app)?;
    let pins_dir = root_dir.join("pins");
    let pin_path = crate::services::safe_join_ext(&pins_dir, &note_id, "pin")?;
    if pin_path.exists() {
        std::fs::remove_file(&pin_path).map_err(|e| format!("取消置顶失败: {}", e))?;
        Ok("unpinned".to_string())
    } else {
        std::fs::create_dir_all(&pins_dir).map_err(|e| format!("创建置顶目录失败: {}", e))?;
        std::fs::write(&pin_path, chrono::Utc::now().to_rfc3339()).map_err(|e| format!("置顶失败: {}", e))?;
        Ok("pinned".to_string())
    }
}

#[tauri::command]
pub fn delete_note(app: AppHandle, note_id: String) -> Result<(), String> {
    let root_dir = notes_root_dir(&app)?;
    let notes_dir = root_dir.join("notes");
    let trash_dir = root_dir.join("trash_notes");
    let result = note_service::delete_note(notes_dir, trash_dir, &note_id);
    // 清理对应的 pin 文件
    if let Ok(pin_path) = crate::services::safe_join_ext(&root_dir.join("pins"), &note_id, "pin") {
        if pin_path.exists() {
            let _ = std::fs::remove_file(&pin_path);
        }
    }
    result
}

#[tauri::command]
pub fn get_note_tags(app: AppHandle, note_id: String) -> Result<Vec<String>, String> {
    let root_dir = notes_root_dir(&app)?;
    let tags_path = root_dir.join("tags.json");
    note_service::get_note_tags(tags_path, &note_id)
}

#[tauri::command]
pub fn set_note_tags(app: AppHandle, note_id: String, tags: Vec<String>) -> Result<(), String> {
    let root_dir = notes_root_dir(&app)?;
    let tags_path = root_dir.join("tags.json");
    note_service::set_note_tags(tags_path, &note_id, tags)
}

#[tauri::command]
pub fn get_all_tags(app: AppHandle) -> Result<Vec<String>, String> {
    let root_dir = notes_root_dir(&app)?;
    let tags_path = root_dir.join("tags.json");
    note_service::get_all_tags(tags_path)
}

#[tauri::command]
pub fn get_all_note_tags_map(app: AppHandle) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    let root_dir = notes_root_dir(&app)?;
    let tags_path = root_dir.join("tags.json");
    note_service::get_all_note_tags_map(tags_path)
}

/// 创建浮窗笔记子窗口（已迁移到前端 WebviewWindow API，见 src/lib/api.ts）
/// Windows 上若用命令内 run_on_main_thread 同步 build()，会因 WebView2 创建
/// 完成回调需被同一消息循环派发而该闭包正占用消息循环，导致主线程重入死锁、
/// 整个应用卡死。故浮窗改由前端创建，此处不再保留该命令。
#[tauri::command]
pub fn duplicate_note(app: AppHandle, note_id: String) -> Result<String, String> {
    let root_dir = notes_root_dir(&app)?;
    let notes_dir = root_dir.join("notes");
    note_service::duplicate_note(notes_dir, &note_id)
}

#[tauri::command]
pub fn toggle_favorite_note(app: AppHandle, note_id: String) -> Result<bool, String> {
    let root_dir = notes_root_dir(&app)?;
    let notes_dir = root_dir.join("notes");
    note_service::toggle_favorite_note(notes_dir, &note_id)
}

#[tauri::command]
pub fn get_all_favorites(app: AppHandle) -> Result<Vec<String>, String> {
    let root_dir = notes_root_dir(&app)?;
    let notes_dir = root_dir.join("notes");
    Ok(note_service::get_all_favorites(&notes_dir))
}

#[tauri::command]
pub fn get_next_favorite(app: AppHandle) -> Result<Option<String>, String> {
    let root_dir = notes_root_dir(&app)?;
    let notes_dir = root_dir.join("notes");
    let favorites = note_service::get_all_favorites(&notes_dir);
    if favorites.is_empty() {
        return Ok(None);
    }
    // 返回第一个（按最后修改时间排序）
    Ok(favorites.into_iter().next())
}
