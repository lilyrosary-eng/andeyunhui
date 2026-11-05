//! 文件事实源：房间 / 任务 / 事件。
//!
//! 刻意只依赖 std::fs，不引入数据库：P0 的数据量小，纯文件足够，
//! 也方便用户直接备份或迁移 `<app_data>/ai-collab/`。
//! 事件按房间追加为 NDJSON（与 AI 会话事件、OpenMausBot 的 thread log 同构）。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Manager};

use crate::types::{Assignment, CollabEvent, Room};

const DIRNAME: &str = "ai-collab";
const ROOMS_FILE: &str = "rooms.json";
const ASSIGNMENTS_FILE: &str = "assignments.json";
/// 与 `src-tauri/tauri.conf.json` 的 identifier 必须一致，否则 MCP 进程找不到宿主的数据目录。
const APP_IDENTIFIER: &str = "com.rosary.andengyuanhua";

/// 事件序号缓存：房间 -> 当前最大 seq。
/// 重启后首次访问会从 NDJSON 末尾恢复，避免序号重复。
static SEQ_CACHE: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

fn seq_cache() -> &'static Mutex<HashMap<String, u64>> {
    SEQ_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 协作数据根目录：`<app_data>/ai-collab/`。
pub fn base_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {e}"))?
        .join(DIRNAME);
    fs::create_dir_all(&dir).map_err(|e| format!("创建协作目录失败 {}: {e}", dir.display()))?;
    Ok(dir)
}

/// 不依赖 Tauri 的数据根目录：MCP server 是独立进程，拿不到 `AppHandle`。
///
/// 优先级：
/// 1. `ANDY_COLLAB_ROOT`：直接当作数据根目录（即包含 rooms.json 的目录）；
/// 2. 平台默认，与 `base_dir(app)` 完全一致 —— Windows 为
///    `%APPDATA%\com.rosary.andengyuanhua\ai-collab`。
pub fn default_base_dir() -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var("ANDY_COLLAB_ROOT") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    Ok(platform_app_data_dir()?.join(APP_IDENTIFIER).join(DIRNAME))
}

#[cfg(windows)]
fn platform_app_data_dir() -> Result<PathBuf, String> {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "未找到 APPDATA 环境变量".to_string())
}

#[cfg(not(windows))]
fn platform_app_data_dir() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("XDG_DATA_HOME") {
        return Ok(PathBuf::from(value));
    }
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".local").join("share"))
        .ok_or_else(|| "未找到 HOME 环境变量".to_string())
}

/// 默认根目录并确保存在（MCP 进程启动时调用一次）。
pub fn ensure_base() -> Result<PathBuf, String> {
    let dir = default_base_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建协作目录失败 {}: {e}", dir.display()))?;
    Ok(dir)
}

/// 房间 id 会拼进文件名，只接受生成的字符集，杜绝路径穿越。
fn checked_room_id(room_id: &str) -> Result<&str, String> {
    if room_id.is_empty()
        || !room_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("非法房间标识: {room_id:?}"));
    }
    Ok(room_id)
}

fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败 {}: {e}", parent.display()))?;
    }
    let body = serde_json::to_vec_pretty(value).map_err(|e| format!("序列化失败: {e}"))?;
    let tmp = path.with_file_name(format!(
        ".{}.{}.{}.tmp",
        path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("collab"),
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    ));
    fs::write(&tmp, &body).map_err(|e| format!("写临时文件失败 {}: {e}", tmp.display()))?;
    // Windows 的 rename 不覆盖已存在文件，先删再换。
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&tmp, path).map_err(|e| format!("替换文件失败 {}: {e}", path.display()))
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path, default: T) -> T {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<T>(&s).ok())
        .unwrap_or(default)
}

pub fn read_rooms(base: &Path) -> Vec<Room> {
    read_json(&base.join(ROOMS_FILE), Vec::<Room>::new())
}

pub fn write_rooms(base: &Path, rooms: &[Room]) -> Result<(), String> {
    write_json(&base.join(ROOMS_FILE), &rooms.to_vec())
}

pub fn read_assignments(base: &Path) -> HashMap<String, Vec<Assignment>> {
    read_json(&base.join(ASSIGNMENTS_FILE), HashMap::<String, Vec<Assignment>>::new())
}

pub fn write_assignments(base: &Path, map: &HashMap<String, Vec<Assignment>>) -> Result<(), String> {
    write_json(&base.join(ASSIGNMENTS_FILE), map)
}

pub fn events_path(base: &Path, room_id: &str) -> Result<PathBuf, String> {
    let id = checked_room_id(room_id)?;
    let dir = base.join("events");
    fs::create_dir_all(&dir).map_err(|e| format!("创建事件目录失败 {}: {e}", dir.display()))?;
    Ok(dir.join(format!("{id}.ndjson")))
}

/// 追加一条事件并推进序号缓存。
pub fn append_event(base: &Path, mut event: CollabEvent) -> Result<CollabEvent, String> {
    let path = events_path(base, &event.room_id)?;
    let seq = next_seq(&path, &event.room_id)?;
    event.seq = seq;
    let line = serde_json::to_string(&event).map_err(|e| format!("序列化事件失败: {e}"))?;
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开事件文件失败 {}: {e}", path.display()))?;
    file.write_all(format!("{line}\n").as_bytes())
        .map_err(|e| format!("写入事件失败 {}: {e}", path.display()))?;
    Ok(event)
}

fn next_seq(path: &Path, room_id: &str) -> Result<u64, String> {
    let cache = seq_cache();
    let mut guard = cache.lock().map_err(|_| "事件序号锁已损坏".to_string())?;
    if let Some(seq) = guard.get(room_id) {
        let next = *seq + 1;
        guard.insert(room_id.to_string(), next);
        return Ok(next);
    }
    let last = fs::read_to_string(path)
        .ok()
        .and_then(|s| {
            s.lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .and_then(|line| serde_json::from_str::<CollabEvent>(line).ok())
                .map(|e| e.seq)
        })
        .unwrap_or(0);
    let next = last + 1;
    guard.insert(room_id.to_string(), next);
    Ok(next)
}

/// 读取事件；`after_seq` 为 Some 时只返回更大的序号（增量拉取）。
pub fn read_events(base: &Path, room_id: &str, after_seq: Option<u64>) -> Result<Vec<CollabEvent>, String> {
    let path = events_path(base, room_id)?;
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("读取事件失败 {}: {error}", path.display())),
    };
    let mut out = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(event) = serde_json::from_str::<CollabEvent>(line) {
            if after_seq.map(|seq| event.seq > seq).unwrap_or(true) {
                out.push(event);
            }
        }
    }
    // 并发追加时文件行序可能交错；序号才是事实顺序。
    out.sort_by_key(|event| event.seq);
    Ok(out)
}

// ========== 外部可扫描镜像 ==========
//
// 共享会话不能只活在本应用的 app_data 里，否则别的 harness 无法发现。
// 对绑定了 workspace 的房间，把同一份事件流镜像到：
//   <workspace>/.adyh/collab/rooms/<roomId>/
//     room.json       房间元数据（成员 / 来源 / 工作目录）
//     events.ndjson   完整事件流（追加写，按 seq 消费）
//     inbox/          外部 harness 投递消息的 JSON 文件
//     processed/      已导入的外部消息
//     README.md       扫描与投递约定
// 这是「通用参与层」：任何能读写文件的 harness 都能参加，不需要为它写适配器。

fn mirror_dir(room: &Room) -> Option<PathBuf> {
    let workspace = room.workspace.as_ref()?.trim();
    if workspace.is_empty() {
        return None;
    }
    let path = PathBuf::from(workspace);
    if !path.is_absolute() {
        return None;
    }
    Some(path.join(".adyh").join("collab").join("rooms").join(&room.id))
}

const MIRROR_README: &str = r#"# AI 协作共享会话

本目录由 andeyunhui 的 AI 协作模块生成，是共享会话的**只读事实源 + 外部投递箱**。

## 文件

- `room.json`：房间元数据（成员、主导、来源、工作目录）
- `events.ndjson`：完整事件流，每行一个 JSON，`seq` 单调递增
- `inbox/`：外部 harness 往这里写消息
- `processed/`：已导入的外部消息

## 扫描（任何 harness 都能做）

1. 读 `room.json` 确认成员与来源；
2. 从 `events.ndjson` 末尾向前读，按 `seq` 增量消费；
3. 只把 `kind == "message"` 的 `text` 当作对话内容；`assignment.*` 是任务状态。

## 发言（写文件即可，不需要适配器）

在 `inbox/` 新建一个 `.json` 文件：

```json
{ "from": "trae", "text": "我看到了任务，这部分我来做。" }
```

主程序下次同步房间时导入，并把文件移到 `processed/`。
"#;

fn write_if_missing(path: &Path, body: &[u8]) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    write_atomic(path, body)
}

fn write_atomic(path: &Path, body: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败 {}: {e}", parent.display()))?;
    }
    let tmp = path.with_file_name(format!(
        ".{}.{}.{}.tmp",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("mirror"),
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    ));
    fs::write(&tmp, body).map_err(|e| format!("写临时文件失败 {}: {e}", tmp.display()))?;
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&tmp, path).map_err(|e| format!("替换文件失败 {}: {e}", path.display()))
}

/// 事件追加到外部镜像。任何失败都不阻断主流程：镜像只是「可被发现」，不是事实源。
pub fn mirror_event(base: &Path, event: &CollabEvent) {
    let rooms = read_rooms(base);
    let Some(room) = rooms.iter().find(|room| room.id == event.room_id) else {
        return;
    };
    let Some(dir) = mirror_dir(room) else {
        return;
    };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let _ = fs::create_dir_all(dir.join("inbox"));
    let _ = fs::create_dir_all(dir.join("processed"));
    let _ = write_if_missing(&dir.join("README.md"), MIRROR_README.as_bytes());
    let _ = write_if_missing(
        &dir.join("room.json"),
        &serde_json::to_vec_pretty(room).unwrap_or_default(),
    );
    let line = match serde_json::to_string(event) {
        Ok(line) => line,
        Err(_) => return,
    };
    use std::io::Write;
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("events.ndjson"))
    {
        let _ = file.write_all(format!("{line}\n").as_bytes());
    }
}

/// 房间首次绑定工作目录 / 换绑时，把已有事件全量重建到镜像目录。
/// 与 `mirror_event` 不同：这里用覆盖写，保证新绑定的目录拿到完整历史而不是空文件。
pub fn mirror_rebuild(base: &Path, room: &Room) {
    let Some(dir) = mirror_dir(room) else {
        return;
    };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let _ = fs::create_dir_all(dir.join("inbox"));
    let _ = fs::create_dir_all(dir.join("processed"));
    let _ = write_if_missing(&dir.join("README.md"), MIRROR_README.as_bytes());
    if let Ok(body) = serde_json::to_vec_pretty(room) {
        let _ = write_atomic(&dir.join("room.json"), &body);
    }
    let events = read_events(base, &room.id, None).unwrap_or_default();
    let mut body = String::new();
    for event in events {
        if let Ok(line) = serde_json::to_string(&event) {
            body.push_str(&line);
            body.push('\n');
        }
    }
    let _ = write_atomic(&dir.join("events.ndjson"), body.as_bytes());
}

/// 外部 harness 通过 `inbox/*.json` 投递的消息。
#[derive(Debug, Clone)]
pub struct ExternalMessage {
    pub from: Option<String>,
    pub text: String,
}

/// 取出并归档外部投递文件。格式：`{ "from": "...", "text": "..." }`。
pub fn take_external_messages(_base: &Path, room: &Room) -> Vec<ExternalMessage> {
    let Some(dir) = mirror_dir(room) else {
        return Vec::new();
    };
    let inbox = dir.join("inbox");
    let processed = dir.join("processed");
    let Ok(entries) = fs::read_dir(&inbox) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let body = value
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if body.is_empty() {
            continue;
        }
        let from = value
            .get("from")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        out.push(ExternalMessage {
            from,
            text: crate::runtime::clip_text(body, 4000),
        });
        let _ = fs::create_dir_all(&processed);
        let stem = path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("external");
        let target = processed.join(format!(
            "{stem}.{}.{}.json",
            chrono::Utc::now().timestamp_millis(),
            std::process::id()
        ));
        let _ = fs::rename(&path, target);
    }
    out
}

/// 删除房间时一并清理事件与任务记录。
pub fn remove_room_files(base: &Path, room_id: &str) -> Result<(), String> {
    if let Ok(path) = events_path(base, room_id) {
        let _ = fs::remove_file(path);
    }
    seq_cache()
        .lock()
        .map_err(|_| "事件序号锁已损坏".to_string())?
        .remove(room_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AssignmentStatus, Room};

    fn temp_base(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ai-collab-test-{tag}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn event(room_id: &str, kind: &str) -> CollabEvent {
        CollabEvent {
            seq: 0,
            at: 0,
            room_id: room_id.to_string(),
            kind: kind.to_string(),
            agent_id: None,
            assignment_id: None,
            text: None,
            assignment: None,
            data: None,
        }
    }

    #[test]
    fn events_append_and_incremental_read() {
        let base = temp_base("events");
        let room = "room_1";
        for kind in ["a", "b", "c"] {
            append_event(&base, event(room, kind)).unwrap();
        }
        let all = read_events(&base, room, None).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![1, 2, 3]);
        let tail = read_events(&base, room, Some(1)).unwrap();
        assert_eq!(tail.len(), 2);
        assert_eq!(tail[0].kind, "b");
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn rooms_and_assignments_roundtrip() {
        let base = temp_base("rooms");
        let room = Room {
            id: "room_1".to_string(),
            name: "测试房间".to_string(),
            lead_id: "lead".to_string(),
            agents: vec![],
            workspace: None,
            source: None,
            created_at: 0,
            updated_at: 0,
        };
        write_rooms(&base, &[room.clone()]).unwrap();
        assert_eq!(read_rooms(&base).len(), 1);
        assert_eq!(read_rooms(&base)[0].name, "测试房间");

        let mut map = HashMap::new();
        map.insert(
            room.id.clone(),
            vec![Assignment {
                id: "task_1".to_string(),
                room_id: room.id.clone(),
                parent_id: None,
                assignee_id: "lead".to_string(),
                brief: "演示".to_string(),
                status: AssignmentStatus::Queued,
                result: None,
                created_at: 0,
                updated_at: 0,
            }],
        );
        write_assignments(&base, &map).unwrap();
        assert_eq!(read_assignments(&base).get("room_1").unwrap().len(), 1);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn mirror_rebuild_writes_scan_surface() {
        let base = temp_base("mirror");
        let workspace = temp_base("mirror-ws");
        let room = Room {
            id: "room_mirror".to_string(),
            name: "镜像房间".to_string(),
            lead_id: "lead".to_string(),
            agents: vec![],
            workspace: Some(workspace.to_string_lossy().to_string()),
            source: None,
            created_at: 0,
            updated_at: 0,
        };
        let mut message = event(&room.id, "message");
        message.text = Some("外部可见的消息".to_string());
        append_event(&base, message).unwrap();
        mirror_rebuild(&base, &room);

        let dir = workspace.join(".adyh").join("collab").join("rooms").join(&room.id);
        assert!(dir.join("README.md").exists());
        assert!(dir.join("room.json").exists());
        assert!(dir.join("inbox").is_dir());
        let events = fs::read_to_string(dir.join("events.ndjson")).unwrap();
        assert!(events.contains("外部可见的消息"));
        let meta = fs::read_to_string(dir.join("room.json")).unwrap();
        assert!(meta.contains("镜像房间"));
        let _ = fs::remove_dir_all(base);
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn rejects_path_traversal_room_id() {
        let base = temp_base("traversal");
        assert!(events_path(&base, "../escape").is_err());
        assert!(events_path(&base, "room_1").is_ok());
        let _ = fs::remove_dir_all(base);
    }
}
