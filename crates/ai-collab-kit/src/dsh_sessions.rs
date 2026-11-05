//! DeepSeek Harness 持久会话的只读导入。
//!
//! dsh 把每个会话写成 `<DSH_HOME>/sessions/<workspace>/session-<id>/session.v4.jsonl.zstd`：
//! 第一行是 header（id / cwd / createdAt），之后是 `user/message`、`assistant/message` 等事件。
//! 这里只做两件事：
//! 1. 列出会话摘要（标题 / 工作目录 / 更新时间），让用户看到「那边已有的任务」；
//! 2. 读取一段会话的 user/assistant 文本，灌进协作房间的事件流，作为共享会话的起点。
//!
//! 边界：这里只读、不改动 dsh 文件；不解析工具调用全文，只取对话文本。
//! 「原地恢复并继续」由 `acp_client` 的 `session/resume` 负责；本模块负责发现与快照导入。

use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::runtime::clip_text;

const MAX_SESSIONS: usize = 80;
const MAX_MESSAGES: usize = 300;
const MAX_MESSAGE_CHARS: usize = 4000;
const MAX_TOTAL_CHARS: usize = 120_000;
const PEEK_LINES: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshSessionSummary {
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// v4 | legacy
    pub format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshMessage {
    /// user | assistant
    pub role: String,
    pub text: String,
    pub at: i64,
}

/// `DSH_HOME` 或 `~/.dsh`。
pub fn dsh_home() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("DSH_HOME") {
        if !home.trim().is_empty() {
            return Some(PathBuf::from(home));
        }
    }
    std::env::var("USERPROFILE")
        .ok()
        .map(|home| PathBuf::from(home).join(".dsh"))
}

fn sessions_root() -> Result<PathBuf, String> {
    dsh_home()
        .map(|home| home.join("sessions"))
        .ok_or_else(|| "无法定位 DSH_HOME / USERPROFILE".to_string())
}

/// 一个会话目录内的日志文件：优先 v4，其次历史版本。
fn find_session_file(dir: &Path) -> Option<(PathBuf, String)> {
    let v4 = dir.join("session.v4.jsonl.zstd");
    if v4.exists() {
        return Some((v4, "v4".to_string()));
    }
    let entries = fs::read_dir(dir).ok()?;
    let mut candidates: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with("session") && (name.ends_with(".jsonl.zstd") || name.ends_with(".jsonl")))
                .unwrap_or(false)
        })
        .collect();
    candidates.sort();
    candidates
        .into_iter()
        .next()
        .map(|path| (path, "legacy".to_string()))
}

fn open_lines(path: &Path) -> Result<Box<dyn BufRead>, String> {
    let file = File::open(path).map_err(|e| format!("打开会话日志失败 {}: {e}", path.display()))?;
    if path.extension().and_then(|ext| ext.to_str()) == Some("zstd") {
        let decoder = zstd::stream::read::Decoder::new(file)
            .map_err(|e| format!("解压会话日志失败 {}: {e}", path.display()))?;
        Ok(Box::new(BufReader::new(decoder)))
    } else {
        Ok(Box::new(BufReader::new(file)))
    }
}

fn json_text(value: &Value) -> String {
    let mut out = String::new();
    if let Some(items) = value.as_array() {
        for item in items {
            if item.get("type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(text);
                }
            }
        }
    }
    out
}

fn user_text(data: &Value) -> String {
    // 只收真正的用户输入；system-reminder / runtime-context 也被写成 user/message，必须排除。
    if data
        .get("source")
        .and_then(|source| source.get("kind"))
        .and_then(|kind| kind.as_str())
        != Some("user")
    {
        return String::new();
    }
    data.get("content").map(json_text).unwrap_or_default()
}

fn assistant_text(data: &Value) -> String {
    data.get("message")
        .and_then(|message| message.get("content"))
        .map(json_text)
        .unwrap_or_default()
}

fn parse_message(record: &Value) -> Option<DshMessage> {
    let kind = record.get("type").and_then(|v| v.as_str())?;
    let data = record.get("data")?;
    let (role, text) = match kind {
        "user/message" => ("user", user_text(data)),
        "assistant/message" => ("assistant", assistant_text(data)),
        _ => return None,
    };
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    Some(DshMessage {
        role: role.to_string(),
        text: clip_text(text, MAX_MESSAGE_CHARS),
        at: record.get("time").and_then(|v| v.as_i64()).unwrap_or(0),
    })
}

/// 只读摘要：header + title + 文件时间，不逐行统计全文。
fn peek_summary(path: &Path, format: String) -> Option<DshSessionSummary> {
    let lines = open_lines(path).ok()?;
    let mut id = String::new();
    let mut cwd = String::new();
    let mut created_at = 0_i64;
    let mut title = String::new();
    let mut first_user = String::new();

    for line in lines.lines().take(PEEK_LINES).flatten() {
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match record.get("type").and_then(|v| v.as_str()) {
            Some("session") => {
                id = record.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                cwd = record.get("cwd").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                created_at = record.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);
            }
            Some("session/title") => {
                if let Some(value) = record
                    .get("data")
                    .and_then(|data| data.get("title"))
                    .and_then(|v| v.as_str())
                {
                    if !value.trim().is_empty() {
                        title = value.trim().to_string();
                    }
                }
            }
            Some("user/message") => {
                if first_user.is_empty() {
                    if let Some(data) = record.get("data") {
                        let text = user_text(data);
                        if !text.trim().is_empty() {
                            first_user = clip_text(text.trim(), 60);
                        }
                    }
                }
            }
            _ => {}
        }
        if !title.is_empty() && !id.is_empty() {
            break;
        }
    }

    if id.is_empty() {
        // header 缺失/损坏：用目录名兜底。
        id = path
            .parent()
            .and_then(|dir| dir.file_name())
            .and_then(|name| name.to_str())
            .unwrap_or("unknown")
            .to_string();
    }
    let updated_at = fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(created_at);

    Some(DshSessionSummary {
        id,
        title: if title.is_empty() { first_user } else { title },
        cwd,
        created_at,
        updated_at,
        format,
    })
}

pub fn list_sessions() -> Result<Vec<DshSessionSummary>, String> {
    let root = sessions_root()?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for workspace in fs::read_dir(&root).map_err(|e| format!("读取会话目录失败: {e}"))?.flatten() {
        if !workspace.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Ok(entries) = fs::read_dir(workspace.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name();
            if !name.to_string_lossy().starts_with("session-") {
                continue;
            }
            if let Some((path, format)) = find_session_file(&entry.path()) {
                if let Some(summary) = peek_summary(&path, format) {
                    out.push(summary);
                }
            }
        }
    }
    out.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
    out.truncate(MAX_SESSIONS);
    Ok(out)
}

fn find_session_dir(root: &Path, session_id: &str) -> Option<PathBuf> {
    if !session_id.starts_with("session-")
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    for workspace in fs::read_dir(root).ok()?.flatten() {
        if !workspace.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let candidate = workspace.path().join(session_id);
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    None
}

/// 读取完整会话文本。返回摘要 + 消息（user/assistant）。
pub fn read_session(session_id: &str) -> Result<(DshSessionSummary, Vec<DshMessage>), String> {
    let root = sessions_root()?;
    let dir = find_session_dir(&root, session_id)
        .ok_or_else(|| format!("未找到 DeepSeek 会话: {session_id}"))?;
    let (path, format) = find_session_file(&dir)
        .ok_or_else(|| format!("会话目录没有日志文件: {}", dir.display()))?;
    let summary = peek_summary(&path, format)
        .ok_or_else(|| format!("会话 header 解析失败: {}", path.display()))?;

    let mut messages = Vec::new();
    let mut total_chars = 0usize;
    let lines = open_lines(&path)?;
    for line in lines.lines().flatten() {
        if messages.len() >= MAX_MESSAGES || total_chars >= MAX_TOTAL_CHARS {
            break;
        }
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(message) = parse_message(&record) {
            total_chars += message.text.chars().count();
            messages.push(message);
        }
    }
    Ok((summary, messages))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_session(path: &Path) {
        let header = r#"{"type":"session","version":4,"id":"session-test","createdAt":1,"cwd":"D:\\demo","isSeeded":false}"#;
        let title = r#"{"type":"session/title","seq":1,"time":2,"data":{"title":"测试会话"}}"#;
        let user = r#"{"type":"user/message","seq":2,"time":3,"data":{"content":[{"type":"text","text":"你好"}],"source":{"kind":"user"}}}"#;
        let system = r#"{"type":"user/message","seq":3,"time":4,"data":{"content":[{"type":"text","text":"<system-reminder>不要导入</system-reminder>"}],"source":{"kind":"runtime-context"}}}"#;
        let assistant = r#"{"type":"assistant/message","seq":4,"time":5,"data":{"message":{"content":[{"type":"reasoning","text":"思考"},{"type":"text","text":"你好，有什么可以帮你？"}]}}}"#;
        let body = format!("{header}\n{title}\n{user}\n{system}\n{assistant}\n");
        let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), 3).unwrap();
        encoder.write_all(body.as_bytes()).unwrap();
        let compressed = encoder.finish().unwrap();
        fs::write(path, compressed).unwrap();
    }

    #[test]
    fn imports_user_and_assistant_without_system_reminders() {
        let dir = std::env::temp_dir().join(format!(
            "ai-collab-dsh-sessions-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let session_dir = dir.join("workspace").join("session-test");
        fs::create_dir_all(&session_dir).unwrap();
        write_session(&session_dir.join("session.v4.jsonl.zstd"));
        let (summary, messages) = {
            // 直接通过 read_session 的路径逻辑需要 DSH_HOME；这里改成直接解析文件。
            let path = session_dir.join("session.v4.jsonl.zstd");
            let summary = peek_summary(&path, "v4".to_string()).unwrap();
            let mut messages = Vec::new();
            for line in open_lines(&path).unwrap().lines().flatten() {
                if let Ok(record) = serde_json::from_str::<Value>(&line) {
                    if let Some(message) = parse_message(&record) {
                        messages.push(message);
                    }
                }
            }
            (summary, messages)
        };
        assert_eq!(summary.title, "测试会话");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].text, "你好");
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].text, "你好，有什么可以帮你？");
        let _ = fs::remove_dir_all(dir);
    }
}
