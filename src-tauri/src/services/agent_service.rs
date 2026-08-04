// Agent 工具执行（agent_service.rs）—— 「人机恋」Agent 功能（阶段 1，默认关闭）。
//
// 设计：
// - 用户在设置里手动开启「Agent 能力」后才生效（默认关闭）。
// - 开启后，前端把工具说明注入 system prompt，引导 AI 在回答末尾输出一个 JSON 工具调用块：
//   ```json
//   {"tool":"create_calendar","args":{"title":"…","time":"2026-08-05 20:00","note":"…"}}
//   ```
//   前端解析该 JSON，调用本服务的对应命令执行，并把执行结果回显到对话里。
// - 本服务只负责「执行」：日历事件 / 待办 / 提醒（阶段 1）。数据 JSON 持久化到
//   <app_data>/agent_tools.json。
//
// 命令：
//   agent_tools_get           读取全部工具数据（日历/待办/提醒）
//   agent_tool_create         创建一条工具记录（kind: calendar/todo/reminder）
//   agent_tool_delete         删除一条记录
//   agent_tool_list           列出某类记录

use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AgentData {
    #[serde(default)]
    pub calendar: Vec<AgentRecord>,
    #[serde(default)]
    pub todos: Vec<AgentRecord>,
    #[serde(default)]
    pub reminders: Vec<AgentRecord>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AgentRecord {
    #[serde(default)]
    pub id: String,
    /// 标题
    #[serde(default)]
    pub title: String,
    /// 时间（ISO 文本，如 "2026-08-05 20:00"）
    #[serde(default)]
    pub time: String,
    /// 备注
    #[serde(default)]
    pub note: String,
    /// 创建时间戳（秒）
    #[serde(default)]
    pub created_at: u64,
}

fn agent_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {}", e))?;
    Ok(dir.join("agent_tools.json"))
}

fn load(app: &tauri::AppHandle) -> AgentData {
    let path = match agent_path(app) {
        Ok(p) => p,
        Err(_) => return AgentData::default(),
    };
    if !path.exists() {
        return AgentData::default();
    }
    match fs::read_to_string(&path) {
        Ok(t) => serde_json::from_str(&t).unwrap_or_default(),
        Err(_) => AgentData::default(),
    }
}

fn save(app: &tauri::AppHandle, d: &AgentData) -> Result<(), String> {
    let path = agent_path(app)?;
    let json = serde_json::to_string_pretty(d).map_err(|e| format!("序列化失败: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("写入失败: {}", e))?;
    Ok(())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 读取全部工具数据。
#[tauri::command]
pub fn agent_tools_get(app: tauri::AppHandle) -> AgentData {
    load(&app)
}

/// 创建一条记录。kind: calendar / todo / reminder。
#[tauri::command]
pub fn agent_tool_create(
    app: tauri::AppHandle,
    kind: String,
    title: String,
    time: String,
    note: String,
) -> Result<AgentData, String> {
    let mut d = load(&app);
    let rec = AgentRecord {
        id: format!("a_{}", now_secs()),
        title,
        time,
        note,
        created_at: now_secs(),
    };
    match kind.as_str() {
        "calendar" => d.calendar.push(rec),
        "todo" => d.todos.push(rec),
        "reminder" => d.reminders.push(rec),
        _ => return Err(format!("未知工具类型: {}", kind)),
    }
    save(&app, &d)?;
    Ok(d)
}

/// 删除一条记录。
#[tauri::command]
pub fn agent_tool_delete(app: tauri::AppHandle, kind: String, id: String) -> Result<AgentData, String> {
    let mut d = load(&app);
    match kind.as_str() {
        "calendar" => d.calendar.retain(|x| x.id != id),
        "todo" => d.todos.retain(|x| x.id != id),
        "reminder" => d.reminders.retain(|x| x.id != id),
        _ => return Err(format!("未知工具类型: {}", kind)),
    }
    save(&app, &d)?;
    Ok(d)
}

/// 列出某类记录（返回 Vec，按创建倒序）。
#[tauri::command]
pub fn agent_tool_list(app: tauri::AppHandle, kind: String) -> Result<Vec<AgentRecord>, String> {
    let d = load(&app);
    let list: &Vec<AgentRecord> = match kind.as_str() {
        "calendar" => &d.calendar,
        "todo" => &d.todos,
        "reminder" => &d.reminders,
        _ => return Err(format!("未知工具类型: {}", kind)),
    };
    let mut out = list.clone();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}
