//! 导轨读者标记的跨窗口存储。
//!
//! 主窗口与浮岛是两个独立 webview，localStorage 互相隔离；如果只写 localStorage，
//! 同一会话在两个窗口里的标记会各存一份。这里把标记落到数据根下的一个共享 JSON：
//! - 后端是跨窗口/跨重启的事实源；
//! - 前端每次改动同时发 Tauri 事件，其它窗口实时应用；
//! - 文件小、结构简单，不值得为它开 SQLite。
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::AppHandle;

static LOCK: Mutex<()> = Mutex::new(());

fn file_path(app: &AppHandle) -> PathBuf {
    crate::data_location::resolve_data_root(app)
        .join("adyh")
        .join("turn_marks.json")
}

fn empty_doc() -> Value {
    serde_json::json!({ "version": 1, "scopes": {} })
}

fn read_doc(app: &AppHandle) -> Value {
    std::fs::read_to_string(file_path(app))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(Value::is_object)
        .unwrap_or_else(empty_doc)
}

fn write_doc(app: &AppHandle, doc: &Value) -> Result<(), String> {
    let path = file_path(app);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建标记目录失败: {e}"))?;
    }
    let tmp = path.with_file_name(format!(
        ".turn_marks.{}.tmp",
        std::process::id()
    ));
    let body = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| format!("写标记临时文件失败: {e}"))?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("替换标记文件失败: {e}"))?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换标记文件失败: {e}"))
}

fn scopes_mut(doc: &mut Value) -> &mut Map<String, Value> {
    if !doc.get("scopes").map(Value::is_object).unwrap_or(false) {
        doc["scopes"] = serde_json::json!({});
    }
    doc["scopes"].as_object_mut().expect("scopes 已确保为对象")
}

/// 读取一个 scope 的全部标记：`{ messageId: "mark" | "star" }`。
pub fn get(app: &AppHandle, scope: &str) -> Value {
    let doc = read_doc(app);
    doc.get("scopes")
        .and_then(|s| s.get(scope))
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}))
}

/// 设置或清除一条标记。`mark = None` 表示取消。
pub fn put(app: &AppHandle, scope: &str, id: &str, mark: Option<&str>) -> Result<(), String> {
    if scope.is_empty() || scope.len() > 240 {
        return Err("非法标记作用域".to_string());
    }
    if id.is_empty() || id.len() > 240 {
        return Err("非法标记 id".to_string());
    }
    if let Some(m) = mark {
        if m != "mark" && m != "star" {
            return Err(format!("非法标记类型: {m}"));
        }
    }
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut doc = read_doc(app);
    let scopes = scopes_mut(&mut doc);
    let entry = scopes
        .entry(scope.to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !entry.is_object() {
        *entry = serde_json::json!({});
    }
    let marks = entry.as_object_mut().expect("scope 已确保为对象");
    match mark {
        Some(m) => {
            marks.insert(id.to_string(), Value::String(m.to_string()));
        }
        None => {
            marks.remove(id);
        }
    }
    write_doc(app, &doc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_object_is_created_and_mark_validated() {
        let mut doc = empty_doc();
        let scopes = scopes_mut(&mut doc);
        let entry = scopes
            .entry("chat:abc".to_string())
            .or_insert_with(|| serde_json::json!({}));
        entry.as_object_mut().unwrap().insert("m1".into(), Value::String("star".into()));
        assert_eq!(doc["scopes"]["chat:abc"]["m1"], "star");
    }
}
