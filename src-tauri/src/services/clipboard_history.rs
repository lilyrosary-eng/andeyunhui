//! 剪贴板历史 · 运行期内存单一事实源
//!
//! 为什么把它从各窗口的 localStorage 搬到后端进程内存：
//! 1) 剪贴板浮窗与主窗各自使用独立 WebView2 profile，localStorage 互不相通 ——
//!    浮窗根本看不到主面板的历史，于是两份数据各自为政（浮窗里删掉的，主面板还在）。
//! 2) 需求是「本次运行的所有记录，关掉软件才清空」——进程内存天然满足：不落盘，
//!    也就没有任何持久化 / 过期清理策略要维护，重启即空正是期望行为。
//! 3) 删除 / 多选清理必须作用于同一份数据，否则删除后另一端轮询又把记录"补回来"。
//!
//! 剪贴板变化的「探测」仍留在各窗口前端轮询（谁活着谁上报，与旧行为一致），
//! Rust 侧按内容去重：多个窗口同时轮询同一份剪贴板也只会留下一条记录。

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

/// 历史变化广播事件：各视图收到后重新拉取（数据只有一份，故不做增量同步）
pub const HISTORY_EVENT: &str = "clipboard-history-changed";
/// 文本条数上限：沿用旧的 200 上限，防止长期运行内存无限增长
const MAX_TEXT: usize = 200;
/// 图片条数上限：只存临时文件路径 + 缩略图 data URL，限条数避免缩略图堆积
const MAX_IMAGE: usize = 5;

/// 单条剪贴板记录。字段与前端 `ClipItem` 对齐（含 `type` 命名），避免两端各写一套映射。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipEntry {
    pub id: String,
    /// "text" | "image"（与前端历史命名一致）
    #[serde(rename = "type")]
    pub kind: String,
    /// 文本内容 或 图片临时文件路径
    pub content: String,
    pub preview: String,
    pub timestamp: u64,
    pub pinned: bool,
    #[serde(rename = "charCount", skip_serializing_if = "Option::is_none")]
    pub char_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
}

static HISTORY: Mutex<Vec<ClipEntry>> = Mutex::new(Vec::new());
/// 同毫秒内多次入账时的序号，保证 id 唯一（前端拿 id 做 key 与多选）
static SEQ: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn next_id(tag: &str) -> String {
    format!("{}_{}_{}", now_ms(), tag, SEQ.fetch_add(1, Ordering::SeqCst))
}

/// 文本预览：截前 200 个字符（按字符而非字节，避免中文被切半）
fn preview_of(text: &str) -> String {
    text.chars().take(200).collect()
}

fn lock_history() -> std::sync::MutexGuard<'static, Vec<ClipEntry>> {
    HISTORY.lock().unwrap_or_else(|e| e.into_inner())
}

/// 限量：固定（pinned）项不计入上限，避免"刚置顶就被挤掉"
fn trim(list: &mut Vec<ClipEntry>) {
    let mut text_kept = 0usize;
    let mut image_kept = 0usize;
    list.retain(|e| {
        if e.pinned {
            return true;
        }
        if e.kind == "text" {
            text_kept += 1;
            text_kept <= MAX_TEXT
        } else {
            image_kept += 1;
            image_kept <= MAX_IMAGE
        }
    });
}

fn notify(app: &AppHandle) {
    let count = lock_history().len();
    let _ = app.emit(HISTORY_EVENT, serde_json::json!({ "count": count }));
}

/// 入账一条文本。返回是否真的新增（供调用方决定要不要重置自身的 "上次已知文本"）。
pub fn push_text(app: &AppHandle, text: String) -> bool {
    if text.is_empty() {
        return false;
    }
    let char_count = text.chars().count();
    let mut list = lock_history();
    // 与最新一条相同：视为重复（连续复制同一内容不产生多条），也不打乱顺序
    if let Some(first) = list.first() {
        if first.kind == "text" && first.content == text {
            return false;
        }
    }
    // 历史里已存在同样内容：挪到最前而不是再插一条
    list.retain(|e| !(e.kind == "text" && e.content == text));
    list.insert(
        0,
        ClipEntry {
            id: next_id("txt"),
            kind: "text".to_string(),
            preview: preview_of(&text),
            content: text,
            timestamp: now_ms(),
            pinned: false,
            char_count: Some(char_count),
            thumbnail: None,
        },
    );
    trim(&mut list);
    drop(list);
    notify(app);
    true
}

/// 入账一张图片。`hash` 为后端算出的图片内容哈希：同一张图被多个窗口轮询到也只入账一条
/// （临时文件路径每次可能不同，故不能用路径去重）。
pub fn push_image(app: &AppHandle, hash: String, temp_path: String, thumbnail: String) -> bool {
    if hash.is_empty() || temp_path.is_empty() {
        return false;
    }
    let id = format!("img_{}", hash);
    let mut list = lock_history();
    if let Some(first) = list.first() {
        if first.id == id {
            return false;
        }
    }
    list.retain(|e| e.id != id);
    list.insert(
        0,
        ClipEntry {
            id,
            kind: "image".to_string(),
            content: temp_path,
            // 图片统一显示"图片"，具体文案由各视图本地化覆盖
            preview: "图片".to_string(),
            timestamp: now_ms(),
            pinned: false,
            char_count: None,
            thumbnail: Some(thumbnail),
        },
    );
    trim(&mut list);
    drop(list);
    notify(app);
    true
}

// ============ IPC 命令 ============

/// 读取全部历史（最新在前）。浮窗只渲染最近 3 条，主面板渲染全部。
#[tauri::command]
pub fn clipboard_history_get() -> Result<Vec<ClipEntry>, String> {
    Ok(lock_history().clone())
}

/// 前端探测到新文本后上报
#[tauri::command]
pub fn clipboard_history_add_text(app: AppHandle, text: String) -> Result<bool, String> {
    Ok(push_text(&app, text))
}

/// 前端探测到新图片后上报（hash 由 clipboard_poll_image 返回）
#[tauri::command]
pub fn clipboard_history_add_image(
    app: AppHandle,
    hash: String,
    temp_path: String,
    thumbnail: String,
) -> Result<bool, String> {
    Ok(push_image(&app, hash, temp_path, thumbnail))
}

/// 删除指定记录（多选清理与单条删除共用）
#[tauri::command]
pub fn clipboard_history_delete(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    {
        let mut list = lock_history();
        list.retain(|e| !ids.contains(&e.id));
    }
    notify(&app);
    Ok(())
}

/// 置顶/取消置顶（沿用旧语义：置顶项不受条数上限与"保留固定"的一键清理影响）
#[tauri::command]
pub fn clipboard_history_set_pinned(app: AppHandle, id: String, pinned: bool) -> Result<(), String> {
    {
        let mut list = lock_history();
        if let Some(e) = list.iter_mut().find(|e| e.id == id) {
            e.pinned = pinned;
        } else {
            return Ok(());
        }
    }
    notify(&app);
    Ok(())
}

/// 一键清理。`keep_pinned = true` 时保留固定项（与旧主面板行为一致）
#[tauri::command]
pub fn clipboard_history_clear(app: AppHandle, keep_pinned: bool) -> Result<(), String> {
    {
        let mut list = lock_history();
        if keep_pinned {
            list.retain(|e| e.pinned);
        } else {
            list.clear();
        }
    }
    notify(&app);
    Ok(())
}