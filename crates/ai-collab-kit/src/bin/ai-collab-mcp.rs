//! AI 协作 MCP 控制面（stdio JSON-RPC 2.0）。
//!
//! 目的：让 Trae / WorkBuddy / 其它 harness **不需要逐个适配**，只要支持 MCP 就能加入房间：
//! 列出房间、增量读事件、发言、建任务、认领、完成、失败。
//!
//! 约束：
//! - stdout 只写协议（每行一个 JSON），任何日志必须走 stderr；
//! - 与宿主进程共用同一份文件事实源（`<app_data>/ai-collab/` 或 `ANDY_COLLAB_ROOT`）；
//! - 工具调用失败返回 `isError: true` 的文本结果，而不是 JSON-RPC error，方便模型自行修正参数。

use std::io::{self, BufRead, BufReader, Write};
use std::path::Path;

use serde_json::{json, Value};

use ai_collab_kit::runtime;
use ai_collab_kit::store;
use ai_collab_kit::types::{Assignment, AssignmentStatus, Room};

fn main() {
    let base = match store::ensure_base() {
        Ok(base) => base,
        Err(error) => {
            eprintln!("[ai-collab-mcp] 初始化数据目录失败: {error}");
            std::process::exit(1);
        }
    };
    eprintln!("[ai-collab-mcp] 数据根目录: {}", base.display());

    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) => {
                eprintln!("[ai-collab-mcp] 读取 stdin 失败: {error}");
                break;
            }
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("[ai-collab-mcp] 解析请求失败: {error}");
                write_line(&json!({
                    "jsonrpc": "2.0",
                    "id": Value::Null,
                    "error": { "code": -32700, "message": format!("解析失败: {error}") }
                }));
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(|value| value.as_str()).unwrap_or("");
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));

        match method {
            "initialize" => {
                let protocol_version = params
                    .get("protocolVersion")
                    .and_then(|value| value.as_str())
                    .unwrap_or("2024-11-05");
                reply(
                    &id,
                    json!({
                        "protocolVersion": protocol_version,
                        "capabilities": { "tools": {} },
                        "serverInfo": { "name": "ai-collab-mcp", "version": "0.1.0" },
                    }),
                );
            }
            "notifications/initialized" | "initialized" | "notifications/cancelled" => {}
            "ping" => reply(&id, json!({})),
            "tools/list" => reply(&id, json!({ "tools": tool_defs() })),
            "tools/call" => match call_tool(&base, &params) {
                Ok(value) => reply(
                    &id,
                    json!({
                        "content": [{ "type": "text", "text": value.to_string() }],
                        "isError": false,
                    }),
                ),
                Err(error) => reply(
                    &id,
                    json!({
                        "content": [{ "type": "text", "text": format!("工具调用失败: {error}") }],
                        "isError": true,
                    }),
                ),
            },
            "resources/list" => reply(&id, json!({ "resources": [] })),
            "prompts/list" => reply(&id, json!({ "prompts": [] })),
            other => {
                if id.is_null() {
                    // 未知通知按协议忽略，避免打断客户端。
                    eprintln!("[ai-collab-mcp] 忽略未知通知: {other}");
                } else {
                    reply_error(&id, -32601, &format!("不支持的方法: {other}"));
                }
            }
        }
    }
}

fn reply(id: &Value, result: Value) {
    write_line(&json!({ "jsonrpc": "2.0", "id": id, "result": result }));
}

fn reply_error(id: &Value, code: i64, message: &str) {
    write_line(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    }));
}

fn write_line(value: &Value) {
    let stdout = io::stdout();
    let mut lock = stdout.lock();
    if writeln!(lock, "{value}").is_err() {
        eprintln!("[ai-collab-mcp] 写入 stdout 失败");
    }
    let _ = lock.flush();
}

// ========== 工具定义 ==========

fn tool_defs() -> Value {
    json!([
        {
            "name": "collab_list_rooms",
            "description": "列出所有 AI 协作房间（id、名称、成员、绑定的工作目录）。先在结果里挑一个 roomId。",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "collab_room_info",
            "description": "读取单个房间的成员、来源、工作目录与全部任务。",
            "inputSchema": {
                "type": "object",
                "properties": { "roomId": { "type": "string", "description": "房间 id" } },
                "required": ["roomId"],
                "additionalProperties": false
            }
        },
        {
            "name": "collab_read_events",
            "description": "增量读取房间事件流。传上次返回的 lastSeq 作为 afterSeq，只拿到新事件；只把 kind=message 的 text 当对话内容。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "roomId": { "type": "string" },
                    "afterSeq": { "type": "integer", "description": "只返回 seq 大于该值的事件；默认 0 表示从头读" },
                    "limit": { "type": "integer", "description": "单次最多返回多少条（按 seq 顺序取，超量时可继续用 lastSeq 翻页），默认 100，上限 500" },
                    "kind": { "type": "string", "description": "只保留某类事件：message / assignment（匹配 assignment.*）/ room.updated 等" }
                },
                "required": ["roomId"],
                "additionalProperties": false
            }
        },
        {
            "name": "collab_post_message",
            "description": "在房间里发言（写入共享事件流，其它 harness 与宿主 UI 都能看到）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "roomId": { "type": "string" },
                    "text": { "type": "string" },
                    "from": { "type": "string", "description": "发言者标识，例如 trae / workbuddy；默认 mcp" }
                },
                "required": ["roomId", "text"],
                "additionalProperties": false
            }
        },
        {
            "name": "collab_list_tasks",
            "description": "列出任务（可按 roomId 过滤）。status: queued / running / waiting / completed / failed / cancelled。",
            "inputSchema": {
                "type": "object",
                "properties": { "roomId": { "type": "string", "description": "可选，缺省返回全部房间的任务" } },
                "additionalProperties": false
            }
        },
        {
            "name": "collab_create_task",
            "description": "在房间里建任务（入队，不自动执行）。外部 harness 后续用 collab_claim_task 认领，再 collab_complete_task 交结果。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "roomId": { "type": "string" },
                    "assigneeId": { "type": "string", "description": "成员 id，见 collab_room_info" },
                    "brief": { "type": "string", "description": "任务说明" },
                    "parentId": { "type": "string", "description": "可选父任务 id" }
                },
                "required": ["roomId", "assigneeId", "brief"],
                "additionalProperties": false
            }
        },
        {
            "name": "collab_claim_task",
            "description": "认领任务：queued → running，并记录认领者（from）。认领后由调用方执行并回报结果。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "roomId": { "type": "string" },
                    "taskId": { "type": "string" },
                    "from": { "type": "string", "description": "认领者标识，例如 trae；默认 mcp" }
                },
                "required": ["roomId", "taskId"],
                "additionalProperties": false
            }
        },
        {
            "name": "collab_complete_task",
            "description": "完成任务：写入结果并把结果作为一条 agent 消息发到房间。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "roomId": { "type": "string" },
                    "taskId": { "type": "string" },
                    "result": { "type": "string", "description": "任务结果正文" }
                },
                "required": ["roomId", "taskId", "result"],
                "additionalProperties": false
            }
        },
        {
            "name": "collab_fail_task",
            "description": "标记任务失败并记录原因。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "roomId": { "type": "string" },
                    "taskId": { "type": "string" },
                    "error": { "type": "string" }
                },
                "required": ["roomId", "taskId", "error"],
                "additionalProperties": false
            }
        },
        {
            "name": "collab_cancel_task",
            "description": "取消任务（queued / running / waiting → cancelled），用于外部 harness 放弃或中止。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "roomId": { "type": "string" },
                    "taskId": { "type": "string" },
                    "reason": { "type": "string", "description": "取消原因，默认「外部 harness 取消任务」" }
                },
                "required": ["roomId", "taskId"],
                "additionalProperties": false
            }
        },
        {
            "name": "collab_delete_task",
            "description": "从任务表删除任务（执行中的任务需先取消）。删除会在时间线留一条系统消息。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "roomId": { "type": "string" },
                    "taskId": { "type": "string" }
                },
                "required": ["roomId", "taskId"],
                "additionalProperties": false
            }
        }
    ])
}

// ========== 工具执行 ==========

fn call_tool(base: &Path, params: &Value) -> Result<Value, String> {
    let name = params
        .get("name")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "缺少工具名".to_string())?;
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    match name {
        "collab_list_rooms" => {
            let mut rooms = store::read_rooms(base);
            rooms.sort_by_key(|room| std::cmp::Reverse(room.updated_at));
            Ok(json!({ "root": base.to_string_lossy(), "rooms": rooms }))
        }
        "collab_room_info" => {
            let room_id = require_str(&args, "roomId")?;
            let room = find_room(base, &room_id)?;
            let tasks = store::read_assignments(base)
                .remove(&room.id)
                .unwrap_or_default();
            Ok(json!({ "room": room, "tasks": tasks }))
        }
        "collab_read_events" => {
            let room_id = require_str(&args, "roomId")?;
            find_room(base, &room_id)?;
            let after_seq = optional_u64(&args, "afterSeq").unwrap_or(0);
            let limit = optional_u64(&args, "limit").unwrap_or(100).min(500) as usize;
            let kind_filter = optional_str(&args, "kind");
            let mut events = store::read_events(base, &room_id, Some(after_seq))?;
            if let Some(filter) = kind_filter.as_deref() {
                // "assignment" 匹配 assignment.*，"message" 只匹配 message 本身。
                let prefix = format!("{filter}.");
                events.retain(|event| event.kind == filter || event.kind.starts_with(&prefix));
            }
            let truncated = events.len() > limit;
            if truncated {
                // 从最早的一批开始返回；调用方用 lastSeq 继续翻页，不会跳过中间事件。
                events.truncate(limit);
            }
            let last_seq = events.last().map(|event| event.seq).unwrap_or(after_seq);
            Ok(json!({
                "roomId": room_id,
                "events": events,
                "lastSeq": last_seq,
                "truncated": truncated,
            }))
        }
        "collab_post_message" => {
            let room_id = require_str(&args, "roomId")?;
            find_room(base, &room_id)?;
            let text = require_str(&args, "text")?;
            if text.trim().is_empty() {
                return Err("消息不能为空".to_string());
            }
            let from = optional_str(&args, "from").unwrap_or_else(|| "mcp".to_string());
            let event = runtime::post_message_core(base, &room_id, Some(&from), &text, true)?;
            Ok(json!({ "event": event }))
        }
        "collab_list_tasks" => {
            let map = store::read_assignments(base);
            let tasks: Vec<Assignment> = match optional_str(&args, "roomId") {
                Some(room_id) => map.get(&room_id).cloned().unwrap_or_default(),
                None => map.into_values().flatten().collect(),
            };
            Ok(json!({ "tasks": tasks }))
        }
        "collab_create_task" => {
            let room_id = require_str(&args, "roomId")?;
            let room = find_room(base, &room_id)?;
            let assignee_id = require_str(&args, "assigneeId")?;
            if !room.agents.iter().any(|agent| agent.id == assignee_id) {
                return Err(format!("成员不存在: {assignee_id}"));
            }
            let brief = require_str(&args, "brief")?;
            if brief.trim().is_empty() {
                return Err("任务描述不能为空".to_string());
            }
            let parent_id = optional_str(&args, "parentId");
            let created =
                runtime::create_assignment_core(base, &room, parent_id, &assignee_id, brief.trim())?;
            Ok(json!({ "task": created.assignment, "event": created.event }))
        }
        "collab_claim_task" => {
            let room_id = require_str(&args, "roomId")?;
            let room = find_room(base, &room_id)?;
            let task_id = require_str(&args, "taskId")?;
            let task = find_task(base, &room_id, &task_id)?;
            let from = optional_str(&args, "from").unwrap_or_else(|| "mcp".to_string());
            let text = format!(
                "{} 已认领任务（{}）",
                runtime::agent_name(&room, &task.assignee_id),
                from
            );
            // 状态校验与 claimed_by 写入都在 core 内完成，避免两处规则漂移。
            let updated = runtime::claim_assignment_core(
                base,
                &room_id,
                &task_id,
                Some(&from),
                text,
            )?;
            Ok(json!({ "task": updated }))
        }
        "collab_complete_task" => {
            let room_id = require_str(&args, "roomId")?;
            find_room(base, &room_id)?;
            let task_id = require_str(&args, "taskId")?;
            let task = find_task(base, &room_id, &task_id)?;
            if matches!(
                task.status,
                AssignmentStatus::Completed
                    | AssignmentStatus::Failed
                    | AssignmentStatus::Cancelled
            ) {
                return Err(format!(
                    "任务当前状态为 {}，无法完成",
                    task.status.as_str()
                ));
            }
            let result = require_str(&args, "result")?;
            let text = runtime::clip_text(result.trim(), 8000);
            let updated = runtime::set_assignment_status_core(
                base,
                &room_id,
                &task_id,
                AssignmentStatus::Completed,
                Some(text.clone()),
                "assignment.completed",
                Some(text.clone()),
            )?;
            // 与宿主一模一样：结果同时作为一条 agent 消息，UI 时间线才看得到。
            let _ = runtime::append_event_core(
                base,
                &room_id,
                "message",
                Some(task.assignee_id.clone()),
                Some(task_id.clone()),
                Some(text),
                None,
                Some(json!({ "role": "agent", "external": true })),
            );
            Ok(json!({ "task": updated }))
        }
        "collab_fail_task" => {
            let room_id = require_str(&args, "roomId")?;
            find_room(base, &room_id)?;
            let task_id = require_str(&args, "taskId")?;
            let task = find_task(base, &room_id, &task_id)?;
            if matches!(
                task.status,
                AssignmentStatus::Completed
                    | AssignmentStatus::Failed
                    | AssignmentStatus::Cancelled
            ) {
                return Err(format!(
                    "任务当前状态为 {}，无法标记失败",
                    task.status.as_str()
                ));
            }
            let error = require_str(&args, "error")?;
            let detail = runtime::clip_text(error.trim(), 800);
            let updated = runtime::set_assignment_status_core(
                base,
                &room_id,
                &task_id,
                AssignmentStatus::Failed,
                Some(detail.clone()),
                "assignment.failed",
                Some(detail),
            )?;
            Ok(json!({ "task": updated }))
        }
        "collab_cancel_task" => {
            let room_id = require_str(&args, "roomId")?;
            find_room(base, &room_id)?;
            let task_id = require_str(&args, "taskId")?;
            let task = find_task(base, &room_id, &task_id)?;
            if matches!(
                task.status,
                AssignmentStatus::Completed
                    | AssignmentStatus::Failed
                    | AssignmentStatus::Cancelled
            ) {
                return Err(format!(
                    "任务当前状态为 {}，无需取消",
                    task.status.as_str()
                ));
            }
            let reason =
                optional_str(&args, "reason").unwrap_or_else(|| "外部 harness 取消任务".to_string());
            let detail = runtime::clip_text(reason.trim(), 800);
            let updated = runtime::set_assignment_status_core(
                base,
                &room_id,
                &task_id,
                AssignmentStatus::Cancelled,
                Some(detail.clone()),
                "assignment.cancelled",
                Some(detail),
            )?;
            Ok(json!({ "task": updated }))
        }
        "collab_delete_task" => {
            let room_id = require_str(&args, "roomId")?;
            find_room(base, &room_id)?;
            let task_id = require_str(&args, "taskId")?;
            let removed = runtime::delete_assignment_core(base, &room_id, &task_id)?;
            Ok(json!({ "deleted": removed }))
        }
        other => Err(format!("未知工具: {other}")),
    }
}

fn find_room(base: &Path, room_id: &str) -> Result<Room, String> {
    store::read_rooms(base)
        .into_iter()
        .find(|room| room.id == room_id)
        .ok_or_else(|| format!("房间不存在: {room_id}"))
}

fn find_task(base: &Path, room_id: &str, task_id: &str) -> Result<Assignment, String> {
    store::read_assignments(base)
        .remove(room_id)
        .unwrap_or_default()
        .into_iter()
        .find(|task| task.id == task_id)
        .ok_or_else(|| format!("任务不存在: {task_id}"))
}

// ========== 参数读取 ==========

fn require_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("缺少参数 {key}"))
}

fn optional_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn optional_u64(args: &Value, key: &str) -> Option<u64> {
    args.get(key).and_then(|value| value.as_u64())
}
