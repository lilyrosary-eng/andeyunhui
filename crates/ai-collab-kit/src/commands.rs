//! Tauri 命令层：只做参数校验、房间查找与 runtime 调用，业务状态都在 `runtime` / `store`。
//!
//! 命令全部使用 `collab_` 前缀，避免与宿主既有命令冲突。
//! 宿主只需在 `main.rs` 的 `generate_handler!` 里注册一次。

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::dsh_sessions::{self, DshSessionSummary};
use crate::harness;
use crate::runtime;
use crate::store;
use crate::types::{
    AgentSpec, Assignment, AssignmentStatus, CollabEvent, HarnessInfo, Room, RoomSnapshot,
    RoomSource,
};

fn find_room(app: &AppHandle, room_id: &str) -> Result<Room, String> {
    let base = store::base_dir(app)?;
    store::read_rooms(&base)
        .into_iter()
        .find(|room| room.id == room_id)
        .ok_or_else(|| format!("房间不存在: {room_id}"))
}

fn save_room(app: &AppHandle, room: &Room) -> Result<(), String> {
    let base = store::base_dir(app)?;
    let mut rooms = store::read_rooms(&base);
    match rooms.iter().position(|existing| existing.id == room.id) {
        Some(index) => rooms[index] = room.clone(),
        None => rooms.push(room.clone()),
    }
    store::write_rooms(&base, &rooms)
}

/// 恢复只处理「上一进程」的遗留：插件卸载/重挂载会让前端再次调用，
/// 进程内只允许执行一次，避免把当前正在跑的任务误判为中断。
static RECOVERY_DONE: OnceLock<Mutex<bool>> = OnceLock::new();

#[tauri::command]
pub fn collab_harnesses(app: AppHandle) -> Vec<HarnessInfo> {
    harness::catalog(&app)
}

/// 启动恢复：把上一进程遗留的 running / queued 任务结掉。
/// 外部 harness（MCP）拥有的任务保持原状，由对方继续执行。
#[tauri::command]
pub fn collab_recover(app: AppHandle) -> Result<runtime::RecoverySummary, String> {
    let flag = RECOVERY_DONE.get_or_init(|| Mutex::new(false));
    {
        let mut done = flag.lock().map_err(|_| "恢复状态锁已损坏".to_string())?;
        if *done {
            return Ok(runtime::RecoverySummary::default());
        }
        *done = true;
    }
    let base = store::base_dir(&app)?;
    runtime::recover_stale_assignments(&base)
}

/// 启动事件文件监听：MCP 等外部进程写入后近实时推给前端（线程只启动一次）。
#[tauri::command]
pub fn collab_watch_start(app: AppHandle) -> Result<(), String> {
    crate::watcher::start(app)
}

/// 用户对 ACP 权限请求的选择。`option_id` 为 null 表示拒绝 / 取消。
#[tauri::command]
pub fn collab_permission_reply(
    app: AppHandle,
    permission_id: String,
    option_id: Option<String>,
) -> Result<(), String> {
    let resolved = crate::permission::reply(&permission_id, option_id.as_deref());
    if !resolved {
        return Err("权限请求不存在或已被处理".to_string());
    }
    // 让所有窗口清掉确认条；带上 optionId 便于 UI 回显选择。
    let _ = app.emit(
        "collab-permission",
        json!({
            "permissionId": permission_id,
            "resolved": true,
            "optionId": option_id,
        }),
    );
    Ok(())
}

/// MCP 接入信息：设置页展示，外部 harness 直接复制。
///
/// 随包分发方式：**宿主 exe 自身带 `--mcp` 参数**就进入 stdio 模式，
/// 因此 command 一律指向当前应用可执行文件，args 为 `["--mcp"]`。
/// 这样升级应用即同步升级 MCP，不会出现「应用是新版、MCP 还是旧版」；
/// 独立二进制只作为开发/冒烟测试的备用入口展示。
#[tauri::command]
pub fn collab_mcp_info(app: AppHandle) -> Result<serde_json::Value, String> {
    let base = store::base_dir(&app)?;
    let standalone_name = if cfg!(windows) {
        "ai-collab-mcp.exe"
    } else {
        "ai-collab-mcp"
    };
    let configured = std::env::current_exe()
        .map(|exe| exe.to_string_lossy().to_string())
        .unwrap_or_else(|_| {
            if cfg!(windows) {
                "andeyunhui.exe".to_string()
            } else {
                "andeyunhui".to_string()
            }
        });
    let binary = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(standalone_name)))
        .filter(|path| path.exists())
        .map(|path| path.to_string_lossy().to_string());
    let root = base.to_string_lossy().to_string();
    Ok(json!({
        "root": root,
        "mode": "embedded",
        "command": configured,
        "args": [crate::mcp::ARG],
        "binary": binary,
        "buildCommand": "cargo build -p ai-collab-kit --bin ai-collab-mcp",
        "env": { "ANDY_COLLAB_ROOT": root },
        "serverName": "ai-collab",
        "config": {
            "mcpServers": {
                "ai-collab": {
                    "command": configured,
                    "args": [crate::mcp::ARG],
                    "env": { "ANDY_COLLAB_ROOT": root }
                }
            }
        },
        "tools": [
            "collab_list_rooms",
            "collab_room_info",
            "collab_read_events",
            "collab_post_message",
            "collab_list_tasks",
            "collab_create_task",
            "collab_claim_task",
            "collab_complete_task",
            "collab_fail_task",
            "collab_park_task",
            "collab_cancel_task",
            "collab_delete_task"
        ]
    }))
}

#[tauri::command]
pub fn collab_room_list(app: AppHandle) -> Result<Vec<Room>, String> {
    let base = store::base_dir(&app)?;
    let mut rooms = store::read_rooms(&base);
    rooms.sort_by_key(|room| std::cmp::Reverse(room.updated_at));
    Ok(rooms)
}

#[tauri::command]
pub fn collab_room_create(
    app: AppHandle,
    name: String,
    agents: Option<Vec<AgentSpec>>,
    lead_id: Option<String>,
    token_budget: Option<u64>,
    concurrency: Option<u8>,
) -> Result<Room, String> {
    let base = store::base_dir(&app)?;
    let name = if name.trim().is_empty() {
        "协作房间".to_string()
    } else {
        name.trim().to_string()
    };
    let agents = agents.unwrap_or_else(|| runtime::default_agents_for(harness::ECHO));
    if agents.len() < 2 {
        return Err("协作房间至少需要 2 个成员".to_string());
    }
    let mut seen = HashSet::new();
    for agent in &agents {
        if agent.id.trim().is_empty() || agent.name.trim().is_empty() {
            return Err("成员 id / 名称不能为空".to_string());
        }
        if !seen.insert(agent.id.clone()) {
            return Err(format!("成员 id 重复: {}", agent.id));
        }
    }
    let lead_id = lead_id
        .filter(|id| agents.iter().any(|agent| &agent.id == id))
        .unwrap_or_else(|| agents[0].id.clone());

    let now = runtime::now_ms();
    let room = Room {
        id: runtime::new_id("room"),
        name,
        lead_id,
        agents,
        workspace: None,
        source: None,
        // 0 与 None 同义：不限。
        token_budget: token_budget.filter(|value| *value > 0),
        // 0 = 不限并发，与多数 harness 默认行为一致；只有显式填数字才排队。
        concurrency: runtime::normalize_concurrency(concurrency),
        created_at: now,
        updated_at: now,
    };
    save_room(&app, &room)?;
    runtime::emit_event(
        &app,
        &base,
        &room.id,
        "room.created",
        None,
        None,
        Some(format!("房间「{}」已创建", room.name)),
        None,
        Some(json!({ "role": "system" })),
    )?;
    Ok(room)
}

/// 改房间成员 / 主导 / 名称，保留既有事件与任务历史。
///
/// 三条规则，都是为了不让「编辑」把正在跑的房间弄坏：
/// - 至少 2 个成员、id 唯一、主导必须在成员里；
/// - 有未结束任务的成员不能删，否则任务失去归属；
/// - harness 或模型改了就清空 `native_session_id`：旧原生会话绑定的是旧模型，
///   resume 过去会得到「配置看起来对、实际跑的是旧模型」的假象。
pub(crate) fn update_room_agents_core(
    base: &std::path::Path,
    room_id: &str,
    name: Option<String>,
    agents: Vec<AgentSpec>,
    lead_id: Option<String>,
    token_budget: Option<u64>,
    concurrency: Option<u8>,
) -> Result<Room, String> {
    let mut rooms = store::read_rooms(base);
    let index = rooms
        .iter()
        .position(|room| room.id == room_id)
        .ok_or_else(|| format!("房间不存在: {room_id}"))?;

    if agents.len() < 2 {
        return Err("协作房间至少需要 2 个成员".to_string());
    }
    let mut seen = HashSet::new();
    for agent in &agents {
        if agent.id.trim().is_empty() || agent.name.trim().is_empty() {
            return Err("成员 id / 名称不能为空".to_string());
        }
        if !seen.insert(agent.id.clone()) {
            return Err(format!("成员 id 重复: {}", agent.id));
        }
    }

    let active: Vec<Assignment> = store::read_assignments(base)
        .remove(room_id)
        .unwrap_or_default()
        .into_iter()
        .filter(|task| {
            matches!(
                task.status,
                AssignmentStatus::Queued | AssignmentStatus::Running | AssignmentStatus::Waiting
            )
        })
        .collect();
    for task in &active {
        if !agents.iter().any(|agent| agent.id == task.assignee_id) {
            return Err(format!(
                "成员「{}」还有未结束的任务，请先完成或取消后再移除",
                task.assignee_id
            ));
        }
    }

    let previous = rooms[index].agents.clone();
    let merged: Vec<AgentSpec> = agents
        .into_iter()
        .map(|mut agent| {
            let old = previous.iter().find(|item| item.id == agent.id);
            let reusable = old
                .map(|old| old.harness_id == agent.harness_id && old.model == agent.model)
                .unwrap_or(false);
            agent.native_session_id = if reusable {
                old.and_then(|old| old.native_session_id.clone())
            } else {
                None
            };
            agent
        })
        .collect();

    let lead_id = lead_id
        .filter(|id| merged.iter().any(|agent| &agent.id == id))
        .unwrap_or_else(|| merged[0].id.clone());
    let mut room = rooms[index].clone();
    room.name = name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or(room.name);
    room.agents = merged;
    room.lead_id = lead_id;
    // None = 不改；Some(0) = 清除上限。
    if let Some(budget) = token_budget {
        room.token_budget = if budget == 0 { None } else { Some(budget) };
    }
    // None = 不改；Some(0) = 改为不限并发。
    if let Some(value) = concurrency {
        room.concurrency = runtime::normalize_concurrency(Some(value));
    }
    room.updated_at = runtime::now_ms();
    rooms[index] = room.clone();
    store::write_rooms(base, &rooms)?;
    Ok(room)
}

#[tauri::command]
pub fn collab_room_update(
    app: AppHandle,
    room_id: String,
    name: Option<String>,
    agents: Vec<AgentSpec>,
    lead_id: Option<String>,
    token_budget: Option<u64>,
    concurrency: Option<u8>,
) -> Result<Room, String> {
    let base = store::base_dir(&app)?;
    let room = update_room_agents_core(
        &base,
        &room_id,
        name,
        agents,
        lead_id,
        token_budget,
        concurrency,
    )?;
    runtime::emit_event(
        &app,
        &base,
        &room.id,
        "room.updated",
        None,
        None,
        Some("房间成员已更新".to_string()),
        None,
        Some(json!({ "room": &room })),
    )?;
    // 并发改大后，队列里本来被挡住的房间可以立刻开工。
    runtime::pump_queue(&base);
    Ok(room)
}

#[tauri::command]
pub fn collab_room_delete(app: AppHandle, room_id: String) -> Result<(), String> {
    let base = store::base_dir(&app)?;
    let mut rooms = store::read_rooms(&base);
    rooms.retain(|room| room.id != room_id);
    store::write_rooms(&base, &rooms)?;
    let mut assignments = store::read_assignments(&base);
    assignments.remove(&room_id);
    store::write_assignments(&base, &assignments)?;
    // 排队中的任务随房间一起作废；已在跑的由执行器自己收尾。
    runtime::discard_room_queue(&room_id);
    store::remove_room_files(&base, &room_id)
}

#[tauri::command]
pub fn collab_room_snapshot(app: AppHandle, room_id: String) -> Result<RoomSnapshot, String> {
    let base = store::base_dir(&app)?;
    let room = find_room(&app, &room_id)?;
    sync_external_room(&app, &base, &room);
    let room = find_room(&app, &room_id)?;
    runtime::snapshot(&base, room)
}

/// 绑定 / 解绑房间的工作目录。
/// 绑定后事件流会镜像到 `<workspace>/.adyh/collab/rooms/<id>/`，
/// 其它 harness 无需适配器即可扫描（读 events.ndjson）与发言（写 inbox/*.json）。
#[tauri::command]
pub fn collab_set_room_workspace(
    app: AppHandle,
    room_id: String,
    workspace: Option<String>,
) -> Result<Room, String> {
    let base = store::base_dir(&app)?;
    let mut rooms = store::read_rooms(&base);
    let Some(index) = rooms.iter().position(|room| room.id == room_id) else {
        return Err(format!("房间不存在: {room_id}"));
    };
    let workspace = workspace
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(path) = workspace.as_ref() {
        let target = std::path::Path::new(path);
        if !target.is_absolute() {
            return Err(format!("工作目录必须是绝对路径: {path}"));
        }
        if !target.is_dir() {
            return Err(format!("工作目录不存在或不是目录: {path}"));
        }
    }
    rooms[index].workspace = workspace.clone();
    rooms[index].updated_at = runtime::now_ms();
    store::write_rooms(&base, &rooms)?;
    let room = rooms[index].clone();

    if workspace.is_some() {
        store::mirror_rebuild(&base, &room);
        // 绑定目录后补投递：之前没有目录时创建的 `.Talk` 信箱任务现在能落地了。
        for task in store::read_assignments(&base)
            .remove(&room.id)
            .unwrap_or_default()
        {
            if !matches!(
                task.status,
                AssignmentStatus::Queued | AssignmentStatus::Waiting
            ) {
                continue;
            }
            let is_mailbox = room
                .agents
                .iter()
                .find(|agent| agent.id == task.assignee_id)
                .map(|agent| agent.harness_id.as_str())
                == Some(harness::MAILBOX);
            if is_mailbox {
                store::publish_mailbox_task(&room, &task);
            }
        }
    }
    runtime::emit_event(
        &app,
        &base,
        &room.id,
        "room.updated",
        None,
        None,
        Some(match workspace {
            Some(path) => format!("已绑定工作目录：{path}"),
            None => "已解绑工作目录".to_string(),
        }),
        None,
        Some(json!({ "room": room })),
    )?;
    Ok(room)
}

/// 列出 DeepSeek Harness 的持久会话（那边已有的任务/对话）。
#[tauri::command]
pub fn collab_dsh_sessions() -> Result<Vec<DshSessionSummary>, String> {
    dsh_sessions::list_sessions()
}

/// 把一个已存在的 DeepSeek 会话导入成协作房间。
/// 导入后房间的 workspace 指向原会话 cwd，事件流会镜像到该项目的 `.adyh/collab/`。
#[tauri::command]
pub fn collab_import_dsh_session(
    app: AppHandle,
    session_id: String,
    name: Option<String>,
) -> Result<Room, String> {
    let base = store::base_dir(&app)?;
    let (summary, messages) = dsh_sessions::read_session(&session_id)?;
    if messages.is_empty() {
        return Err("该会话没有可导入的对话文本".to_string());
    }
    let now = runtime::now_ms();
    let room = Room {
        id: runtime::new_id("room"),
        name: name
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| {
                if summary.title.trim().is_empty() {
                    "导入的 DeepSeek 会话".to_string()
                } else {
                    summary.title.clone()
                }
            }),
        lead_id: "lead".to_string(),
        agents: vec![AgentSpec {
            id: "lead".to_string(),
            name: "主导".to_string(),
            harness_id: harness::DSH.to_string(),
            persona: "承接这个已存在的 DeepSeek 会话，继续与用户协作".to_string(),
            model: String::new(),
            native_session_id: Some(summary.id.clone()),
        }],
        workspace: if summary.cwd.trim().is_empty() {
            None
        } else {
            Some(summary.cwd.clone())
        },
        source: Some(RoomSource {
            kind: "dsh-import".to_string(),
            session_id: Some(summary.id.clone()),
        }),
        token_budget: None,
        concurrency: 0,
        created_at: now,
        updated_at: now,
    };
    save_room(&app, &room)?;

    runtime::emit_event(
        &app,
        &base,
        &room.id,
        "room.created",
        None,
        None,
        Some(format!(
            "从 DeepSeek Harness 导入会话「{}」（{} 条消息）",
            room.name,
            messages.len()
        )),
        None,
        Some(json!({ "role": "system", "source": "dsh-import" })),
    )?;

    for message in &messages {
        let agent_id = if message.role == "assistant" {
            Some("lead".to_string())
        } else {
            None
        };
        runtime::emit_event(
            &app,
            &base,
            &room.id,
            "message",
            agent_id,
            None,
            Some(message.text.clone()),
            None,
            Some(json!({
                "role": if message.role == "assistant" { "agent" } else { "user" },
                "imported": true,
                "at": message.at,
            })),
        )?;
    }
    Ok(room)
}

/// 导入外部 harness 写到 `inbox/` 的消息。
#[tauri::command]
pub fn collab_sync_external(app: AppHandle, room_id: String) -> Result<usize, String> {
    let base = store::base_dir(&app)?;
    let room = find_room(&app, &room_id)?;
    Ok(sync_external_room(&app, &base, &room))
}

fn sync_external_room(app: &AppHandle, base: &std::path::Path, room: &Room) -> usize {
    let messages = store::take_external_messages(base, room);
    let mut count = messages.len();
    for message in messages {
        let _ = runtime::emit_event(
            app,
            base,
            &room.id,
            "message",
            message.from.clone(),
            None,
            Some(message.text),
            None,
            Some(json!({ "role": "agent", "external": true })),
        );
    }

    // `.Talk` 信箱结果：外部写回 results/*.json 后，完成任务并回到会话时间线。
    let tasks = store::read_assignments(base)
        .remove(&room.id)
        .unwrap_or_default();
    for result in store::take_mailbox_results(room) {
        let Some(task) = tasks.iter().find(|task| task.id == result.task_id) else {
            continue;
        };
        if matches!(
            task.status,
            AssignmentStatus::Completed
                | AssignmentStatus::Failed
                | AssignmentStatus::Cancelled
        ) {
            continue;
        }
        if result.failed {
            let _ = runtime::set_assignment_status_core(
                base,
                &room.id,
                &task.id,
                AssignmentStatus::Failed,
                Some(result.text.clone()),
                "assignment.failed",
                Some(result.text),
            );
        } else {
            let _ = runtime::complete_assignment_core(
                base,
                room,
                task,
                &result.text,
                Some(json!({ "transport": "mailbox" })),
            );
        }
        count += 1;
    }
    count
}

#[tauri::command]
pub fn collab_assignments(app: AppHandle, room_id: String) -> Result<Vec<Assignment>, String> {
    let base = store::base_dir(&app)?;
    Ok(store::read_assignments(&base)
        .remove(&room_id)
        .unwrap_or_default())
}

#[tauri::command]
pub fn collab_events(
    app: AppHandle,
    room_id: String,
    after_seq: Option<u64>,
) -> Result<Vec<CollabEvent>, String> {
    let base = store::base_dir(&app)?;
    store::read_events(&base, &room_id, after_seq)
}

/// 发一条消息并派单。
/// `assignee_id` 为空时交给房间主导（lead）；指定时派给该成员 ——
/// 混编房间靠它把任务交给「执行」而不是永远交给主导。
#[tauri::command]
pub fn collab_room_send(
    app: AppHandle,
    room_id: String,
    text: String,
    assignee_id: Option<String>,
    priority: Option<u8>,
) -> Result<CollabEvent, String> {
    let base = store::base_dir(&app)?;
    let room = find_room(&app, &room_id)?;
    let text = text.trim();
    if text.is_empty() {
        return Err("消息不能为空".to_string());
    }
    let target = assignee_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| room.lead_id.clone());
    if !room.agents.iter().any(|agent| agent.id == target) {
        return Err(format!("成员不存在: {target}"));
    }

    let user_event = runtime::emit_event(
        &app,
        &base,
        &room.id,
        "message",
        None,
        None,
        Some(text.to_string()),
        None,
        Some(json!({ "role": "user", "target": target })),
    )?;

    let assignment = runtime::create_assignment_with_priority(
        &app,
        &base,
        &room,
        None,
        &target,
        text,
        runtime::normalize_priority(priority),
    )?;
    runtime::spawn_assignment(app.clone(), base, room, assignment);
    Ok(user_event)
}

#[tauri::command]
pub fn collab_assign(
    app: AppHandle,
    room_id: String,
    assignee_id: String,
    brief: String,
    parent_id: Option<String>,
    priority: Option<u8>,
) -> Result<Assignment, String> {
    let base = store::base_dir(&app)?;
    let room = find_room(&app, &room_id)?;
    if !room.agents.iter().any(|agent| agent.id == assignee_id) {
        return Err(format!("成员不存在: {assignee_id}"));
    }
    if brief.trim().is_empty() {
        return Err("任务描述不能为空".to_string());
    }
    let assignment = runtime::create_assignment_with_priority(
        &app,
        &base,
        &room,
        parent_id,
        &assignee_id,
        brief.trim(),
        runtime::normalize_priority(priority),
    )?;
    runtime::spawn_assignment(app.clone(), base, room, assignment.clone());
    Ok(assignment)
}

#[tauri::command]
pub fn collab_demo(app: AppHandle, room_id: String) -> Result<(), String> {
    let base = store::base_dir(&app)?;
    let room = find_room(&app, &room_id)?;
    runtime::emit_event(
        &app,
        &base,
        &room.id,
        "message",
        None,
        None,
        Some("运行协作演示：主导拆解 → 分派 → 执行 → 汇总".to_string()),
        None,
        Some(json!({ "role": "system" })),
    )?;
    runtime::spawn_demo(app, base, room);
    Ok(())
}

#[tauri::command]
pub fn collab_cancel(
    app: AppHandle,
    room_id: String,
    assignment_id: String,
) -> Result<(), String> {
    let base = store::base_dir(&app)?;
    let room = find_room(&app, &room_id)?;
    let assignment = store::read_assignments(&base)
        .get(&room_id)
        .and_then(|list| list.iter().find(|a| a.id == assignment_id).cloned())
        .ok_or_else(|| format!("任务不存在: {assignment_id}"))?;
    if matches!(
        assignment.status,
        crate::types::AssignmentStatus::Completed
            | crate::types::AssignmentStatus::Failed
            | crate::types::AssignmentStatus::Cancelled
    ) {
        return Err("任务已结束，无法取消".to_string());
    }
    runtime::cancel_assignment(&app, &base, &room, &assignment)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ai-collab-commands-{tag}-{}-{}",
            std::process::id(),
            runtime::now_ms()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn agent(id: &str, harness_id: &str, model: &str, session: Option<&str>) -> AgentSpec {
        AgentSpec {
            id: id.to_string(),
            name: id.to_string(),
            harness_id: harness_id.to_string(),
            persona: String::new(),
            model: model.to_string(),
            native_session_id: session.map(|value| value.to_string()),
        }
    }

    fn room_with(agents: Vec<AgentSpec>) -> Room {
        Room {
            id: "room_update".to_string(),
            name: "编辑测试".to_string(),
            lead_id: "lead".to_string(),
            agents,
            workspace: None,
            source: None,
            token_budget: None,
            concurrency: 0,
            created_at: 1,
            updated_at: 1,
        }
    }

    /// 编辑成员：模型没变才保留原生会话；改模型/改 harness 都必须清空，避免 resume 到旧模型。
    #[test]
    fn room_update_keeps_session_only_when_model_unchanged() {
        let base = temp_base("room-update");
        let room = room_with(vec![
            agent("lead", harness::DSH, "m1", Some("session-1")),
            agent("worker", harness::DSH, "", None),
        ]);
        store::write_rooms(&base, &vec![room.clone()]).unwrap();

        let unchanged = update_room_agents_core(
            &base,
            &room.id,
            None,
            vec![
                agent("lead", harness::DSH, "m1", None),
                agent("worker", harness::NATIVE, "", None),
            ],
            Some("worker".to_string()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(unchanged.lead_id, "worker");
        // 没传并发 = 不改；旧房间保持「不限」。
        assert_eq!(unchanged.concurrency, 0);
        assert_eq!(
            unchanged
                .agents
                .iter()
                .find(|item| item.id == "lead")
                .unwrap()
                .native_session_id
                .as_deref(),
            Some("session-1")
        );

        let changed = update_room_agents_core(
            &base,
            &room.id,
            Some("改名".to_string()),
            vec![
                agent("lead", harness::DSH, "m2", Some("session-1")),
                agent("worker", harness::DSH, "", None),
            ],
            None,
            Some(50_000),
            Some(4),
        )
        .unwrap();
        assert_eq!(changed.name, "改名");
        assert_eq!(changed.agents[0].native_session_id, None);
        assert_eq!(changed.token_budget, Some(50_000));
        assert_eq!(changed.concurrency, 4);

        let _ = std::fs::remove_dir_all(base);
    }

    /// 有未结束任务的成员不能被移除，否则任务失去归属。
    #[test]
    fn room_update_refuses_removing_member_with_active_task() {
        let base = temp_base("room-update-active");
        let room = room_with(vec![
            agent("lead", harness::ECHO, "", None),
            agent("worker", harness::ECHO, "", None),
        ]);
        store::write_rooms(&base, &vec![room.clone()]).unwrap();
        let created =
            runtime::create_assignment_core(&base, &room, None, "worker", "还在跑").unwrap();
        runtime::claim_assignment_core(
            &base,
            &room.id,
            &created.assignment.id,
            Some("test"),
            "开始".to_string(),
        )
        .unwrap();

        let error = update_room_agents_core(
            &base,
            &room.id,
            None,
            vec![
                agent("lead", harness::ECHO, "", None),
                agent("extra", harness::ECHO, "", None),
            ],
            None,
            None,
            None,
        )
        .unwrap_err();
        assert!(error.contains("未结束的任务"), "{error}");

        let _ = std::fs::remove_dir_all(base);
    }
}
