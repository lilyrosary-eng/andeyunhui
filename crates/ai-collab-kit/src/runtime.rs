//! 协作任务 runtime（P0 子集）。
//!
//! 设计取舍：事件是事实源，任务表是投影。
//! - 每次状态变化先落 NDJSON 事件，再更新任务表并推给前端；
//! - 任务表只用一把锁做 read-modify-write，避免并发任务互相覆盖；
//! - echo 执行器只依赖 tokio 延时，不拉起外部进程，便于先验证整条链路。
//!
//! P2 已接入 DeepSeek Harness：导入房间优先 ACP `session/resume`，失败回退 headless。
//! 与 echo 共用同一套状态机和事件协议。
//! P3 继续补（对齐 OpenMausBot 的 Assignment runtime）：
//! 预算/深度限制、重启恢复、等待用户输入的 parked 状态。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::store;
use crate::types::{
    AgentSpec, Assignment, AssignmentStatus, CollabEvent, Room, RoomSnapshot,
};

static ID_COUNTER: AtomicU64 = AtomicU64::new(1);
static BOARD_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static CANCELLED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

/// 任务树最大层数（根任务算第 1 层）。模型无限拆子任务会把看板和预算拖垮。
pub const MAX_TASK_DEPTH: usize = 4;
/// 单房间同时未结束（queued / running / waiting）的任务上限。
pub const MAX_ACTIVE_TASKS: usize = 64;

fn board_lock() -> &'static Mutex<()> {
    BOARD_LOCK.get_or_init(|| Mutex::new(()))
}

fn cancelled_set() -> &'static Mutex<HashSet<String>> {
    CANCELLED.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn new_id(prefix: &str) -> String {
    let n = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{}_{}", now_ms(), n)
}

pub fn agent_name(room: &Room, agent_id: &str) -> String {
    room.agents
        .iter()
        .find(|a| a.id == agent_id)
        .map(|a| a.name.clone())
        .unwrap_or_else(|| agent_id.to_string())
}

/// 追加事件（落盘 + 外部镜像），不依赖 `AppHandle`。
/// MCP server 独立进程只用这一层；Tauri 侧再用 `emit_event` 加推送。
#[allow(clippy::too_many_arguments)]
pub fn append_event_core(
    base: &Path,
    room_id: &str,
    kind: &str,
    agent_id: Option<String>,
    assignment_id: Option<String>,
    text: Option<String>,
    assignment: Option<Assignment>,
    data: Option<Value>,
) -> Result<CollabEvent, String> {
    let event = store::append_event(
        base,
        CollabEvent {
            seq: 0,
            at: now_ms(),
            room_id: room_id.to_string(),
            kind: kind.to_string(),
            agent_id,
            assignment_id,
            text,
            assignment,
            data,
        },
    )?;
    // 有 workspace 的房间同时镜像到 `<workspace>/.adyh/collab/rooms/<id>/`，
    // 让其它 harness 用文件系统就能扫描到同一个共享会话（失败不影响主流程）。
    store::mirror_event(base, &event);
    Ok(event)
}

/// 追加事件并推送到前端。事件先落盘：UI 崩溃或重开后可完整回放。
#[allow(clippy::too_many_arguments)]
pub fn emit_event(
    app: &AppHandle,
    base: &Path,
    room_id: &str,
    kind: &str,
    agent_id: Option<String>,
    assignment_id: Option<String>,
    text: Option<String>,
    assignment: Option<Assignment>,
    data: Option<Value>,
) -> Result<CollabEvent, String> {
    let event = append_event_core(
        base, room_id, kind, agent_id, assignment_id, text, assignment, data,
    )?;
    // 没有窗口监听是正常情况（后台任务）；事件已落盘，不能因为推送失败丢状态。
    let _ = app.emit("collab-event", event.clone());
    Ok(event)
}

/// 沿 parentId 向上数层数（父任务自身算 1 层），顺便挡住父子成环。
fn parent_depth(existing: &[Assignment], parent_id: &str) -> Result<usize, String> {
    let mut cursor = Some(parent_id.to_string());
    let mut depth = 0usize;
    let mut seen = HashSet::new();
    while let Some(id) = cursor {
        if !seen.insert(id.clone()) {
            return Err("任务父子关系存在环".to_string());
        }
        let Some(task) = existing.iter().find(|task| task.id == id) else {
            return Err(format!("父任务不存在: {id}"));
        };
        depth += 1;
        // 已经超过上限就没必要继续走，调用方会判定新任务超限。
        if depth >= MAX_TASK_DEPTH {
            return Ok(depth);
        }
        cursor = task.parent_id.clone();
    }
    Ok(depth)
}

fn upsert_assignment(base: &Path, assignment: &Assignment) -> Result<(), String> {
    let _guard = board_lock().lock().map_err(|_| "任务表锁已损坏".to_string())?;
    // 进程内互斥挡不住 MCP 进程，读-改-写必须在跨进程写锁里做，否则会丢任务更新。
    store::with_write_lock(base, || {
        let mut map = store::read_assignments(base);
        let list = map.entry(assignment.room_id.clone()).or_default();
        match list.iter().position(|a| a.id == assignment.id) {
            Some(index) => list[index] = assignment.clone(),
            None => list.push(assignment.clone()),
        }
        store::write_assignments(base, &map)
    })
}

/// 新建任务并落一条 `assignment.created` 事件，返回任务与事件本身。
/// 不自动执行：MCP 端创建的任务由外部 harness 自己 claim，避免抢跑。
pub struct CreatedAssignment {
    pub assignment: Assignment,
    pub event: CollabEvent,
}

pub fn create_assignment_core(
    base: &Path,
    room: &Room,
    parent_id: Option<String>,
    assignee_id: &str,
    brief: &str,
) -> Result<CreatedAssignment, String> {
    // 预算型保护放在 core 里：UI 派单与 MCP 建任务走同一入口，规则不会漂移。
    let existing = store::read_assignments(base)
        .remove(&room.id)
        .unwrap_or_default();
    let active = existing
        .iter()
        .filter(|task| {
            matches!(
                task.status,
                AssignmentStatus::Queued
                    | AssignmentStatus::Running
                    | AssignmentStatus::Waiting
            )
        })
        .count();
    if active >= MAX_ACTIVE_TASKS {
        return Err(format!(
            "房间活跃任务已达上限（{MAX_ACTIVE_TASKS}），请先完成或取消部分任务"
        ));
    }
    let depth = match parent_id.as_deref() {
        Some(parent) => parent_depth(&existing, parent)? + 1,
        None => 1,
    };
    if depth > MAX_TASK_DEPTH {
        return Err(format!("任务层级过深（最多 {MAX_TASK_DEPTH} 层）"));
    }

    let now = now_ms();
    let assignment = Assignment {
        id: new_id("task"),
        room_id: room.id.clone(),
        parent_id,
        assignee_id: assignee_id.to_string(),
        brief: brief.to_string(),
        status: AssignmentStatus::Queued,
        result: None,
        claimed_by: None,
        created_at: now,
        updated_at: now,
    };
    upsert_assignment(base, &assignment)?;
    let event = append_event_core(
        base,
        &room.id,
        "assignment.created",
        Some(assignment.assignee_id.clone()),
        Some(assignment.id.clone()),
        None,
        Some(assignment.clone()),
        None,
    )?;

    // `.Talk` 信箱成员：任务直接投递到绑定的工作目录，等外部 harness 写回结果。
    // 放在 core 里是因为 MCP 建的任务不经过 spawn，也必须能投递。
    if room
        .agents
        .iter()
        .find(|agent| agent.id == assignee_id)
        .map(|agent| agent.harness_id.as_str())
        == Some(crate::harness::MAILBOX)
    {
        store::publish_mailbox_task(room, &assignment);
    }

    Ok(CreatedAssignment { assignment, event })
}

pub fn create_assignment(
    app: &AppHandle,
    base: &Path,
    room: &Room,
    parent_id: Option<String>,
    assignee_id: &str,
    brief: &str,
) -> Result<Assignment, String> {
    let created = create_assignment_core(base, room, parent_id, assignee_id, brief)?;
    let _ = app.emit("collab-event", created.event);
    Ok(created.assignment)
}

/// 外部推进一步任务状态（claim / complete / fail 共用），落对应事件。
pub fn set_assignment_status_core(
    base: &Path,
    room_id: &str,
    assignment_id: &str,
    status: AssignmentStatus,
    result: Option<String>,
    kind: &str,
    text: Option<String>,
) -> Result<Assignment, String> {
    let updated = update_assignment(base, room_id, assignment_id, status, result)?;
    append_event_core(
        base,
        room_id,
        kind,
        Some(updated.assignee_id.clone()),
        Some(updated.id.clone()),
        text,
        Some(updated.clone()),
        None,
    )?;
    Ok(updated)
}

/// 外部写完结果后的收尾（信箱 / 其它无 AppHandle 的通道共用）：
/// 任务置 completed，并补一条 agent 消息让时间线可见。
pub fn complete_assignment_core(
    base: &Path,
    room: &Room,
    assignment: &Assignment,
    text: &str,
    data: Option<Value>,
) -> Result<Assignment, String> {
    let text = clip_text(text.trim(), 8000);
    let done = update_assignment(
        base,
        &room.id,
        &assignment.id,
        AssignmentStatus::Completed,
        Some(text.clone()),
    )?;
    append_event_core(
        base,
        &room.id,
        "assignment.completed",
        Some(done.assignee_id.clone()),
        Some(done.id.clone()),
        Some(text.clone()),
        Some(done.clone()),
        data,
    )?;
    append_event_core(
        base,
        &room.id,
        "message",
        Some(done.assignee_id.clone()),
        Some(done.id.clone()),
        Some(text),
        None,
        Some(json!({ "role": "agent", "external": true })),
    )?;
    Ok(done)
}

/// 外部 harness 认领任务：queued/waiting → running，并记录认领者。
/// 与 `set_assignment_status_core` 分开，是因为认领需要额外写 `claimed_by` 审计字段。
pub fn claim_assignment_core(
    base: &Path,
    room_id: &str,
    assignment_id: &str,
    claimed_by: Option<&str>,
    text: String,
) -> Result<Assignment, String> {
    let _guard = board_lock().lock().map_err(|_| "任务表锁已损坏".to_string())?;
    let updated = store::with_write_lock(base, || -> Result<Assignment, String> {
        let mut map = store::read_assignments(base);
        let list = map
            .get_mut(room_id)
            .ok_or_else(|| "房间任务表不存在".to_string())?;
        let assignment = list
            .iter_mut()
            .find(|a| a.id == assignment_id)
            .ok_or_else(|| format!("任务不存在: {assignment_id}"))?;
        if !matches!(
            assignment.status,
            AssignmentStatus::Queued | AssignmentStatus::Waiting
        ) {
            return Err(format!(
                "任务当前状态为 {}，无法认领",
                assignment.status.as_str()
            ));
        }
        assignment.status = AssignmentStatus::Running;
        // 认领表示重新开工：挂起时写在 result 里的问题不再算结果。
        assignment.result = None;
        assignment.claimed_by = claimed_by.map(|value| value.to_string());
        assignment.updated_at = now_ms();
        let snapshot = assignment.clone();
        store::write_assignments(base, &map)?;
        Ok(snapshot)
    })?;
    append_event_core(
        base,
        room_id,
        "assignment.running",
        Some(updated.assignee_id.clone()),
        Some(updated.id.clone()),
        Some(text),
        Some(updated.clone()),
        Some(json!({ "claimedBy": updated.claimed_by })),
    )?;
    Ok(updated)
}

/// 把任务停在「等待输入」：queued / running → waiting，问题写进 result。
/// 恢复用 `claim_assignment_core`（waiting → running），外部 harness 与宿主共用同一路径。
pub fn park_assignment_core(
    base: &Path,
    room_id: &str,
    assignment_id: &str,
    question: &str,
) -> Result<Assignment, String> {
    let task = store::read_assignments(base)
        .remove(room_id)
        .unwrap_or_default()
        .into_iter()
        .find(|task| task.id == assignment_id)
        .ok_or_else(|| format!("任务不存在: {assignment_id}"))?;
    if matches!(
        task.status,
        AssignmentStatus::Completed
            | AssignmentStatus::Failed
            | AssignmentStatus::Cancelled
    ) {
        return Err(format!(
            "任务当前状态为 {}，无法挂起",
            task.status.as_str()
        ));
    }
    let text = clip_text(question.trim(), 4000);
    if text.is_empty() {
        return Err("等待说明不能为空".to_string());
    }
    set_assignment_status_core(
        base,
        room_id,
        assignment_id,
        AssignmentStatus::Waiting,
        Some(text.clone()),
        "assignment.waiting",
        Some(text),
    )
}

/// 删除任务（只能删未在执行的）：从任务表移除，并在时间线留一条系统消息。
pub fn delete_assignment_core(
    base: &Path,
    room_id: &str,
    assignment_id: &str,
) -> Result<Assignment, String> {
    let _guard = board_lock().lock().map_err(|_| "任务表锁已损坏".to_string())?;
    let removed = store::with_write_lock(base, || -> Result<Assignment, String> {
        let mut map = store::read_assignments(base);
        let list = map
            .get_mut(room_id)
            .ok_or_else(|| "房间任务表不存在".to_string())?;
        let index = list
            .iter()
            .position(|a| a.id == assignment_id)
            .ok_or_else(|| format!("任务不存在: {assignment_id}"))?;
        if list[index].status == AssignmentStatus::Running {
            return Err("任务正在执行，不能删除；请先取消".to_string());
        }
        let removed = list.remove(index);
        store::write_assignments(base, &map)?;
        Ok(removed)
    })?;
    append_event_core(
        base,
        room_id,
        "message",
        None,
        Some(removed.id.clone()),
        Some(format!("已删除任务：{}", removed.brief)),
        None,
        Some(json!({ "role": "system", "deletedTaskId": removed.id })),
    )?;
    Ok(removed)
}

/// 外部 harness 在房间里的发言。
pub fn post_message_core(
    base: &Path,
    room_id: &str,
    from: Option<&str>,
    text: &str,
    external: bool,
) -> Result<CollabEvent, String> {
    let data = json!({
        "role": "agent",
        "external": external,
    });
    append_event_core(
        base,
        room_id,
        "message",
        from.map(|value| value.to_string()),
        None,
        Some(clip_text(text, 4000)),
        None,
        Some(data),
    )
}

fn update_assignment(
    base: &Path,
    room_id: &str,
    assignment_id: &str,
    status: AssignmentStatus,
    result: Option<String>,
) -> Result<Assignment, String> {
    let _guard = board_lock().lock().map_err(|_| "任务表锁已损坏".to_string())?;
    store::with_write_lock(base, || {
        let mut map = store::read_assignments(base);
        let list = map
            .get_mut(room_id)
            .ok_or_else(|| "房间任务表不存在".to_string())?;
        let assignment = list
            .iter_mut()
            .find(|a| a.id == assignment_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        assignment.status = status;
        assignment.result = result;
        assignment.updated_at = now_ms();
        let updated = assignment.clone();
        store::write_assignments(base, &map)?;
        Ok(updated)
    })
}

fn mark_cancelled(assignment_id: &str) {
    if let Ok(mut set) = cancelled_set().lock() {
        set.insert(assignment_id.to_string());
    }
}

pub(crate) fn is_cancelled(assignment_id: &str) -> bool {
    cancelled_set()
        .lock()
        .map(|set| set.contains(assignment_id))
        .unwrap_or(false)
}

/// 截断诊断文本，避免把整段 stderr / stdout 塞进事件与任务结果。
/// 对 MCP 独立进程同样公开：任务结果与消息走同一套截断规则。
pub fn clip_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let clipped: String = text.chars().take(max_chars).collect();
    format!("{clipped}…")
}

fn emit_status(
    app: &AppHandle,
    base: &Path,
    room: &Room,
    assignment: &Assignment,
    status: AssignmentStatus,
    kind: &str,
    text: Option<String>,
) -> Result<(), String> {
    let updated = update_assignment(base, &room.id, &assignment.id, status, assignment.result.clone())?;
    emit_event(
        app,
        base,
        &room.id,
        kind,
        Some(updated.assignee_id.clone()),
        Some(updated.id.clone()),
        text,
        Some(updated),
        None,
    )?;
    Ok(())
}

/// stream-json 执行器：通用 CLI，一次任务一个进程，stdout 按行解析 JSON 文本。
async fn run_stream_json_assignment(
    app: AppHandle,
    base: PathBuf,
    room: Room,
    assignment: Assignment,
    config: crate::harness::StreamJsonConfig,
) {
    if is_cancelled(&assignment.id) {
        return;
    }
    let name = agent_name(&room, &assignment.assignee_id);
    let _ = emit_status(
        &app,
        &base,
        &room,
        &assignment,
        AssignmentStatus::Running,
        "assignment.running",
        Some(format!(
            "{name} 正在调用 stream-json harness（{}）",
            config.command
        )),
    );
    let _ = emit_event(
        &app,
        &base,
        &room.id,
        "assignment.progress",
        Some(assignment.assignee_id.clone()),
        Some(assignment.id.clone()),
        Some("等待 harness 输出…".to_string()),
        None,
        None,
    );

    let workspace = room
        .workspace
        .as_ref()
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.exists())
        .unwrap_or_else(|| base.join("workspaces").join(&room.id));
    let prompt = build_prompt(&base, &room, &assignment, true);

    let app_cb = app.clone();
    let base_cb = base.clone();
    let room_cb = room.clone();
    let assignment_cb = assignment.clone();
    let mut last_progress = std::time::Instant::now();
    let on_text = move |text: &str| {
        // 与 ACP 一样的节流：CLI 可能按字符流式输出，事件太密会拖慢镜像写入。
        if last_progress.elapsed() < Duration::from_millis(300) {
            return;
        }
        last_progress = std::time::Instant::now();
        let clipped = clip_text(text.trim(), 300);
        if clipped.is_empty() {
            return;
        }
        let _ = emit_event(
            &app_cb,
            &base_cb,
            &room_cb.id,
            "assignment.progress",
            Some(assignment_cb.assignee_id.clone()),
            Some(assignment_cb.id.clone()),
            Some(clipped),
            None,
            None,
        );
    };

    let outcome = crate::harness::run_stream_json_turn(
        &config,
        &workspace,
        &prompt,
        &assignment.id,
        on_text,
    )
    .await;

    // 取消事件已由 cancel_assignment 发过，这里不要再补 failed/completed。
    if is_cancelled(&assignment.id) {
        return;
    }
    match outcome {
        Ok(outcome) if outcome.cancelled => {}
        Ok(outcome) => {
            if outcome.exit_code != Some(0) {
                let reason = if outcome.text.trim().is_empty() {
                    outcome.stderr.clone()
                } else {
                    outcome.text.clone()
                };
                fail_assignment(
                    &app,
                    &base,
                    &room,
                    &assignment,
                    &format!(
                        "stream-json 退出码 {:?}: {}",
                        outcome.exit_code,
                        clip_text(&reason, 600)
                    ),
                );
                return;
            }
            let text = if outcome.text.trim().is_empty() {
                format!(
                    "（stream-json 未返回文本）\n{}",
                    clip_text(&outcome.stderr, 400)
                )
            } else {
                outcome.text
            };
            complete_assignment(
                &app,
                &base,
                &room,
                &assignment,
                &text,
                Some(json!({
                    "transport": "stream-json",
                    "exitCode": outcome.exit_code,
                    "stderr": clip_text(&outcome.stderr, 300),
                })),
            );
        }
        Err(error) => fail_assignment(&app, &base, &room, &assignment, &error),
    }
}

/// echo 执行器：把一次任务从 running 走到 completed。
/// P1 的 ACP / CLI 适配器会替换这个函数体，但事件与状态语义保持不变。
pub async fn run_echo_assignment(app: AppHandle, base: PathBuf, room: Room, assignment: Assignment) {
    if is_cancelled(&assignment.id) {
        let _ = emit_cancelled(&app, &base, &room, &assignment);
        return;
    }
    tokio::time::sleep(Duration::from_millis(350)).await;
    if is_cancelled(&assignment.id) {
        let _ = emit_cancelled(&app, &base, &room, &assignment);
        return;
    }

    let _ = emit_status(
        &app,
        &base,
        &room,
        &assignment,
        AssignmentStatus::Running,
        "assignment.running",
        Some(format!("{} 已接单", agent_name(&room, &assignment.assignee_id))),
    );

    let _ = emit_event(
        &app,
        &base,
        &room.id,
        "assignment.progress",
        Some(assignment.assignee_id.clone()),
        Some(assignment.id.clone()),
        Some("正在处理任务…".to_string()),
        None,
        None,
    );

    tokio::time::sleep(Duration::from_millis(900)).await;
    if is_cancelled(&assignment.id) {
        let _ = emit_cancelled(&app, &base, &room, &assignment);
        return;
    }

    let name = agent_name(&room, &assignment.assignee_id);
    let result = format!("【演示】{name} 已完成：{}", assignment.brief);
    match update_assignment(
        &base,
        &room.id,
        &assignment.id,
        AssignmentStatus::Completed,
        Some(result.clone()),
    ) {
        Ok(done) => {
            let _ = emit_event(
                &app,
                &base,
                &room.id,
                "assignment.completed",
                Some(done.assignee_id.clone()),
                Some(done.id.clone()),
                Some(result.clone()),
                Some(done),
                None,
            );
            let _ = emit_event(
                &app,
                &base,
                &room.id,
                "message",
                Some(assignment.assignee_id.clone()),
                Some(assignment.id.clone()),
                Some(result),
                None,
                Some(json!({ "role": "agent" })),
            );
        }
        Err(error) => {
            let _ = emit_event(
                &app,
                &base,
                &room.id,
                "assignment.failed",
                Some(assignment.assignee_id.clone()),
                Some(assignment.id.clone()),
                Some(error),
                None,
                None,
            );
        }
    }
}

fn emit_cancelled(app: &AppHandle, base: &Path, room: &Room, assignment: &Assignment) -> Result<(), String> {
    let updated = update_assignment(
        base,
        &room.id,
        &assignment.id,
        AssignmentStatus::Cancelled,
        None,
    )?;
    emit_event(
        app,
        base,
        &room.id,
        "assignment.cancelled",
        Some(updated.assignee_id.clone()),
        Some(updated.id.clone()),
        Some("任务已取消".to_string()),
        Some(updated),
        None,
    )?;
    Ok(())
}

/// 把任务交给成员对应的 harness。
/// 目前支持 Echo（进程内模拟）与 DeepSeek Harness（headless 子进程）；
/// 未知 harness 退回 Echo，避免房间因一个成员不可用而整体停摆。
async fn run_assignment(app: AppHandle, base: PathBuf, room: Room, assignment: Assignment) {
    let harness_id = room
        .agents
        .iter()
        .find(|agent| agent.id == assignment.assignee_id)
        .map(|agent| agent.harness_id.as_str())
        .unwrap_or(crate::harness::ECHO);

    // 外部 harness 走 MCP 自己认领：宿主一旦自动执行就会抢跑，
    // 所以只留一条提示事件，任务保持 queued 等外部 claim。
    if harness_id == crate::harness::MCP {
        let _ = emit_event(
            &app,
            &base,
            &room.id,
            "assignment.progress",
            Some(assignment.assignee_id.clone()),
            Some(assignment.id.clone()),
            Some("任务已入队，等待外部 harness 通过 MCP 认领".to_string()),
            None,
            None,
        );
        return;
    }

    // `.Talk` 信箱：宿主只负责把任务写进工作目录，执行交给外部 harness。
    if harness_id == crate::harness::MAILBOX {
        let delivered = store::publish_mailbox_task(&room, &assignment);
        let _ = emit_event(
            &app,
            &base,
            &room.id,
            "assignment.progress",
            Some(assignment.assignee_id.clone()),
            Some(assignment.id.clone()),
            Some(if delivered {
                "任务已投递到 .Talk 信箱（.adyh/collab/.../tasks/），等待外部写回 results/".to_string()
            } else {
                "未绑定工作目录，无法投递到 .Talk 信箱；请先在房间绑定目录".to_string()
            }),
            None,
            None,
        );
        return;
    }

    if harness_id == crate::harness::STREAM_JSON {
        match crate::harness::resolve_stream_json(&base) {
            Ok(config) => run_stream_json_assignment(app, base, room, assignment, config).await,
            Err(error) => {
                if is_cancelled(&assignment.id) {
                    return;
                }
                fail_assignment(&app, &base, &room, &assignment, &error);
            }
        }
        return;
    }

    if harness_id != crate::harness::DSH {
        run_echo_assignment(app, base, room, assignment).await;
        return;
    }

    match crate::harness::resolve_dsh(&app) {
        Ok(config) => run_dsh_assignment(app, base, room, assignment, config).await,
        Err(error) => {
            if is_cancelled(&assignment.id) {
                return;
            }
            fail_assignment(&app, &base, &room, &assignment, &error);
        }
    }
}

fn fail_assignment(app: &AppHandle, base: &Path, room: &Room, assignment: &Assignment, error: &str) {
    let detail = clip_text(error, 800);
    if let Ok(failed) = update_assignment(
        base,
        &room.id,
        &assignment.id,
        AssignmentStatus::Failed,
        Some(detail.clone()),
    ) {
        let _ = emit_event(
            app,
            base,
            &room.id,
            "assignment.failed",
            Some(failed.assignee_id.clone()),
            Some(failed.id.clone()),
            Some(detail),
            Some(failed),
            None,
        );
    }
}

fn build_prompt(base: &Path, room: &Room, assignment: &Assignment, include_history: bool) -> String {
    let agent = room
        .agents
        .iter()
        .find(|agent| agent.id == assignment.assignee_id);
    let name = agent.map(|a| a.name.as_str()).unwrap_or("成员");
    let persona = agent.map(|a| a.persona.trim()).unwrap_or("");
    let mut prompt = String::new();
    if !persona.is_empty() {
        prompt.push_str(&format!("你是「{name}」，角色：{persona}。\n\n"));
    }

    // 导入房间把已有会话的最近上下文带给模型。headless 每次是新进程，
    // 不注入就会出现「导入了历史但模型看不见」的割裂感。
    if include_history
        && room
            .source
            .as_ref()
            .map(|source| source.kind.as_str())
            .unwrap_or("") == "dsh-import"
    {
        if let Ok(events) = store::read_events(base, &room.id, None) {
            let mut lines: Vec<String> = Vec::new();
            let mut skipped_current = false;
            for event in events.iter().rev() {
                if lines.len() >= 12 {
                    break;
                }
                if event.kind != "message" {
                    continue;
                }
                let Some(text) = event.text.as_deref() else {
                    continue;
                };
                if !skipped_current && text == assignment.brief {
                    skipped_current = true;
                    continue;
                }
                let role = event
                    .data
                    .as_ref()
                    .and_then(|data| data.get("role"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("agent");
                let who = if role == "user" { "用户" } else { "助手" };
                lines.push(format!("{who}：{}", clip_text(text, 500)));
            }
            if !lines.is_empty() {
                lines.reverse();
                prompt.push_str("这个共享会话已有的上下文：\n");
                prompt.push_str(&lines.join("\n"));
                prompt.push_str("\n\n");
            }
        }
    }

    prompt.push_str(&format!(
        "协作任务：{}\n\n请直接给出结果，不要只描述你打算怎么做。",
        assignment.brief
    ));
    prompt
}

fn complete_assignment(
    app: &AppHandle,
    base: &Path,
    room: &Room,
    assignment: &Assignment,
    text: &str,
    data: Option<Value>,
) {
    let text = clip_text(text.trim(), 8000);
    match update_assignment(
        base,
        &room.id,
        &assignment.id,
        AssignmentStatus::Completed,
        Some(text.clone()),
    ) {
        Ok(done) => {
            let _ = emit_event(
                app,
                base,
                &room.id,
                "assignment.completed",
                Some(done.assignee_id.clone()),
                Some(done.id.clone()),
                Some(text.clone()),
                Some(done),
                data,
            );
            let _ = emit_event(
                app,
                base,
                &room.id,
                "message",
                Some(assignment.assignee_id.clone()),
                Some(assignment.id.clone()),
                Some(text),
                None,
                Some(json!({ "role": "agent" })),
            );
        }
        Err(error) => fail_assignment(app, base, room, assignment, &error),
    }
}

/// 把 ACP 会话 id 写回**具体成员**。多 agent 房间里每个成员必须有独立会话，
/// 不能把 room.source 当共享会话用，否则两个成员会 resume 同一个 dsh 会话。
fn persist_agent_session(
    app: &AppHandle,
    room: &mut Room,
    agent_id: &str,
    session_id: &str,
) -> Result<Room, String> {
    let base = store::base_dir(app)?;
    let mut rooms = store::read_rooms(&base);
    let Some(index) = rooms.iter().position(|item| item.id == room.id) else {
        return Err("房间不存在".to_string());
    };
    let Some(agent) = rooms[index]
        .agents
        .iter_mut()
        .find(|agent| agent.id == agent_id)
    else {
        return Err(format!("成员不存在: {agent_id}"));
    };
    agent.native_session_id = Some(session_id.to_string());
    let now = now_ms();
    rooms[index].updated_at = now;
    store::write_rooms(&base, &rooms)?;
    room.agents = rooms[index].agents.clone();
    room.updated_at = now;
    Ok(rooms[index].clone())
}

/// DeepSeek Harness 执行器（P2）：
/// - 所有 dsh 房间优先走 ACP；首次创建会话后把 sessionId 落盘，后续 resume；
/// - ACP 失败（会话被占用 / 模型不可用 / 超时）回退 headless。
///
/// 两条路径共用状态机与事件协议，区别只在于「答案从哪里来」。
async fn run_dsh_assignment(
    app: AppHandle,
    base: PathBuf,
    mut room: Room,
    assignment: Assignment,
    config: crate::harness::DshConfig,
) {
    if is_cancelled(&assignment.id) {
        return;
    }
    let name = agent_name(&room, &assignment.assignee_id);
    let _ = emit_status(
        &app,
        &base,
        &room,
        &assignment,
        AssignmentStatus::Running,
        "assignment.running",
        Some(format!("{name} 正在调用 DeepSeek Harness（{}）", config.model)),
    );
    let _ = emit_event(
        &app,
        &base,
        &room.id,
        "assignment.progress",
        Some(assignment.assignee_id.clone()),
        Some(assignment.id.clone()),
        Some("本地模型生成中…".to_string()),
        None,
        None,
    );

    // 导入房间沿用原会话的项目目录；原生房间用隔离工作目录，避免模型在 app_data 里乱写。
    let workspace = room
        .workspace
        .as_ref()
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_absolute() && path.exists())
        .unwrap_or_else(|| base.join("workspaces").join(&room.id));

    let prompt_with_history = build_prompt(&base, &room, &assignment, true);
    let prompt_task = build_prompt(&base, &room, &assignment, false);

    // P2：所有 dsh 房间优先走 ACP。
    // - 导入房间 / 已绑定的原生房间：session/resume 原位续接；
    // - 首次原生房间：session/new，成功后把 sessionId 写回该成员，后续继续 resume。
    let agent_session = room
        .agents
        .iter()
        .find(|agent| agent.id == assignment.assignee_id)
        .and_then(|agent| agent.native_session_id.clone());
    // 兼容旧导入房间：早期版本把 sessionId 存在 room.source 上。
    let resume_session = agent_session
        .or_else(|| room.source.as_ref().and_then(|source| source.session_id.clone()));
    {
        let _ = emit_event(
            &app,
            &base,
            &room.id,
            "assignment.progress",
            Some(assignment.assignee_id.clone()),
            Some(assignment.id.clone()),
            Some(if resume_session.is_some() {
                "正在通过 ACP 恢复原会话…".to_string()
            } else {
                "正在通过 ACP 新建本地会话…".to_string()
            }),
            None,
            None,
        );

        let app_cb = app.clone();
        let base_cb = base.clone();
        let room_cb = room.clone();
        let assignment_cb = assignment.clone();
        let mut last_progress = std::time::Instant::now();
        let on_update = move |update: crate::acp_client::AcpUpdate| {
            use crate::acp_client::AcpUpdateKind;
            let is_tool = matches!(update.kind, AcpUpdateKind::Tool);
            if !is_tool && last_progress.elapsed() < Duration::from_millis(300) {
                return;
            }
            last_progress = std::time::Instant::now();
            let text = match update.kind {
                AcpUpdateKind::Text => clip_text(update.text.trim(), 300),
                AcpUpdateKind::Thought => "思考中…".to_string(),
                AcpUpdateKind::Tool => clip_text(update.text.trim(), 200),
            };
            if text.is_empty() {
                return;
            }
            let _ = emit_event(
                &app_cb,
                &base_cb,
                &room_cb.id,
                "assignment.progress",
                Some(assignment_cb.assignee_id.clone()),
                Some(assignment_cb.id.clone()),
                Some(text),
                None,
                None,
            );
        };

        match crate::acp_client::run_turn(
            &config,
            &crate::harness::acp_patch_path(&base),
            &workspace,
            &prompt_task,
            &assignment.id,
            resume_session.as_deref(),
            &config.provider,
            &config.model,
            on_update,
        )
        .await
        {
            Ok(result) => {
                if is_cancelled(&assignment.id) {
                    return;
                }
                // 首次原生会话 / 旧导入房间首次 resume：把 sessionId 绑到具体成员，
                // 后续消息直接 resume，不再新建。
                let agent_has_session = room
                    .agents
                    .iter()
                    .find(|agent| agent.id == assignment.assignee_id)
                    .and_then(|agent| agent.native_session_id.as_ref())
                    .is_some();
                if result.created || !agent_has_session {
                    match persist_agent_session(
                        &app,
                        &mut room,
                        &assignment.assignee_id,
                        &result.session_id,
                    ) {
                        Ok(updated) => {
                            let _ = emit_event(
                                &app,
                                &base,
                                &room.id,
                                "room.updated",
                                None,
                                None,
                                Some("已绑定 ACP 会话，后续消息将原位续接".to_string()),
                                None,
                                Some(json!({ "room": updated })),
                            );
                        }
                        Err(error) => eprintln!("[ai-collab] 保存 ACP sessionId 失败: {error}"),
                    }
                }
                let text = if result.text.trim().is_empty() {
                    format!("（ACP 未返回文本，stop={}）", result.stop_reason)
                } else {
                    result.text.trim().to_string()
                };
                complete_assignment(
                    &app,
                    &base,
                    &room,
                    &assignment,
                    &text,
                    Some(json!({
                        "transport": "acp",
                        "sessionId": result.session_id,
                        "created": result.created,
                        "stopReason": result.stop_reason,
                    })),
                );
                return;
            }
            Err(error) => {
                // cancel_assignment 已经发过 cancelled 事件；这里不要再用 failed 覆盖。
                if is_cancelled(&assignment.id) {
                    return;
                }
                let _ = emit_event(
                    &app,
                    &base,
                    &room.id,
                    "assignment.progress",
                    Some(assignment.assignee_id.clone()),
                    Some(assignment.id.clone()),
                    Some(format!("ACP 接管失败，回退 headless：{}", clip_text(&error, 300))),
                    None,
                    None,
                );
            }
        }
    }

    let patch = crate::harness::patch_path(&base);
    let outcome = crate::harness::dsh_run_turn(
        &config,
        &patch,
        &workspace,
        &prompt_with_history,
        &assignment.id,
    )
    .await;

    // cancel_assignment 已经发过 cancelled 事件；这里不要再用 failed 覆盖。
    if is_cancelled(&assignment.id) {
        return;
    }

    match outcome {
        Ok(output) => {
            let text = if output.stdout.trim().is_empty() {
                format!(
                    "（Harness 未返回文本）\n{}",
                    clip_text(&output.stderr, 400)
                )
            } else {
                output.stdout.trim().to_string()
            };
            complete_assignment(
                &app,
                &base,
                &room,
                &assignment,
                &text,
                Some(json!({
                    "transport": "headless",
                    "exitCode": output.exit_code,
                })),
            );
        }
        Err(error) => fail_assignment(&app, &base, &room, &assignment, &error),
    }
}

pub fn spawn_assignment(app: AppHandle, base: PathBuf, room: Room, assignment: Assignment) {
    tauri::async_runtime::spawn(run_assignment(app, base, room, assignment));
}

/// 一条完整的协作演示：主导拆解 → 分派给执行成员 → 执行完成 → 主导汇总。
/// P0 用它验证「任务树 + 事件流 + 前端回显」；P1 会由真实模型/ACP 驱动替换。
pub fn spawn_demo(app: AppHandle, base: PathBuf, room: Room) {
    tauri::async_runtime::spawn(async move {
        let lead_id = room.lead_id.clone();
        let worker_id = room
            .agents
            .iter()
            .find(|a| a.id != lead_id)
            .map(|a| a.id.clone())
            .unwrap_or_else(|| lead_id.clone());

        let root = match create_assignment(
            &app,
            &base,
            &room,
            None,
            &lead_id,
            "请把本轮任务分派给成员，并汇总结果",
        ) {
            Ok(assignment) => assignment,
            Err(error) => {
                eprintln!("[ai-collab] 创建演示根任务失败: {error}");
                return;
            }
        };

        let _ = emit_status(
            &app,
            &base,
            &room,
            &root,
            AssignmentStatus::Running,
            "assignment.running",
            Some("正在拆解任务…".to_string()),
        );
        let _ = emit_event(
            &app,
            &base,
            &room.id,
            "message",
            Some(lead_id.clone()),
            Some(root.id.clone()),
            Some("收到任务，正在拆解并分派给成员。".to_string()),
            None,
            Some(json!({ "role": "agent" })),
        );

        tokio::time::sleep(Duration::from_millis(500)).await;

        let child_brief = format!("整理一份关于「{}」的协作演示说明", room.name);
        let child = match create_assignment(
            &app,
            &base,
            &room,
            Some(root.id.clone()),
            &worker_id,
            &child_brief,
        ) {
            Ok(assignment) => assignment,
            Err(error) => {
                eprintln!("[ai-collab] 创建演示子任务失败: {error}");
                return;
            }
        };

        let _ = emit_event(
            &app,
            &base,
            &room.id,
            "message",
            Some(lead_id.clone()),
            Some(root.id.clone()),
            Some(format!(
                "@{} 这个子任务交给你：{}",
                agent_name(&room, &worker_id),
                child_brief
            )),
            None,
            Some(json!({ "role": "agent" })),
        );

        run_assignment(app.clone(), base.clone(), room.clone(), child.clone()).await;

        // 子任务结束后，主导读取回执并汇总（P1 的收件箱 resume 语义在这里先手动模拟）。
        let child_result = store::read_assignments(&base)
            .get(&room.id)
            .and_then(|list| list.iter().find(|a| a.id == child.id))
            .and_then(|a| a.result.clone())
            .unwrap_or_else(|| "（子任务未返回结果）".to_string());

        let summary = format!("汇总完成。\n子任务结果：{child_result}");
        if let Ok(done) = update_assignment(
            &base,
            &room.id,
            &root.id,
            AssignmentStatus::Completed,
            Some(summary.clone()),
        ) {
            let _ = emit_event(
                &app,
                &base,
                &room.id,
                "assignment.completed",
                Some(done.assignee_id.clone()),
                Some(done.id.clone()),
                Some(summary.clone()),
                Some(done),
                None,
            );
            let _ = emit_event(
                &app,
                &base,
                &room.id,
                "message",
                Some(lead_id),
                Some(root.id),
                Some(summary),
                None,
                Some(json!({ "role": "agent" })),
            );
        }
    });
}

pub fn cancel_assignment(
    app: &AppHandle,
    base: &Path,
    room: &Room,
    assignment: &Assignment,
) -> Result<(), String> {
    mark_cancelled(&assignment.id);
    emit_cancelled(app, base, room, assignment)
}

/// 启动恢复的统计。前端拿它决定是否提示用户。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySummary {
    pub failed_running: usize,
    pub failed_queued: usize,
    pub kept_external: usize,
}

/// 应用启动时清理上一进程遗留的任务。
///
/// 为什么必须做：任务表只落盘状态，进程一退出执行器就不存在了；
/// 不清理的话 `running` 会永远转圈，`queued` 也没人认领。
///
/// 归属规则：
/// - 本应用执行的成员（echo / dsh / 未知）→ 状态一律置 failed，写明「应用重启」；
/// - `mcp` 成员由**外部进程**执行，应用重启不会中断它 → 保留原状态，交给对方继续处理。
pub fn recover_stale_assignments(base: &Path) -> Result<RecoverySummary, String> {
    let rooms = store::read_rooms(base);
    let mut summary = RecoverySummary::default();
    for (room_id, tasks) in store::read_assignments(base) {
        let Some(room) = rooms.iter().find(|room| room.id == room_id) else {
            continue;
        };
        for task in tasks {
            let harness = room
                .agents
                .iter()
                .find(|agent| agent.id == task.assignee_id)
                .map(|agent| agent.harness_id.as_str())
                .unwrap_or(crate::harness::ECHO);
            // 只处理未结束的任务。
            if !matches!(task.status, AssignmentStatus::Running | AssignmentStatus::Queued) {
                continue;
            }
            if harness == crate::harness::MCP {
                summary.kept_external += 1;
                continue;
            }
            let reason = if task.status == AssignmentStatus::Running {
                summary.failed_running += 1;
                "应用重启，任务执行中断"
            } else {
                summary.failed_queued += 1;
                "应用重启，任务未开始执行"
            };
            set_assignment_status_core(
                base,
                &room_id,
                &task.id,
                AssignmentStatus::Failed,
                Some(reason.to_string()),
                "assignment.failed",
                Some(reason.to_string()),
            )?;
        }
    }
    Ok(summary)
}

pub fn snapshot(base: &Path, room: Room) -> Result<RoomSnapshot, String> {
    let assignments = store::read_assignments(base)
        .remove(&room.id)
        .unwrap_or_default();
    let events = store::read_events(base, &room.id, None)?;
    Ok(RoomSnapshot {
        room,
        assignments,
        events,
    })
}

/// 默认房间成员：一个主导 + 一个执行，都使用指定 harness。
pub fn default_agents_for(harness_id: &str) -> Vec<AgentSpec> {
    vec![
        AgentSpec {
            id: "lead".to_string(),
            name: "主导".to_string(),
            harness_id: harness_id.to_string(),
            persona: "负责拆解任务、分派成员、汇总结果".to_string(),
            model: String::new(),
            native_session_id: None,
        },
        AgentSpec {
            id: "worker".to_string(),
            name: "执行".to_string(),
            harness_id: harness_id.to_string(),
            persona: "负责执行被分派的子任务".to_string(),
            model: String::new(),
            native_session_id: None,
        },
    ]
}

pub fn default_agents() -> Vec<AgentSpec> {
    default_agents_for(crate::harness::ECHO)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::AgentSpec;

    fn temp_base(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ai-collab-runtime-{tag}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn test_room(room_id: &str) -> Room {
        Room {
            id: room_id.to_string(),
            name: "MCP 测试房间".to_string(),
            lead_id: "lead".to_string(),
            agents: vec![
                AgentSpec {
                    id: "worker".to_string(),
                    name: "执行".to_string(),
                    harness_id: crate::harness::ECHO.to_string(),
                    persona: String::new(),
                    model: String::new(),
                    native_session_id: None,
                },
                AgentSpec {
                    id: "trae".to_string(),
                    name: "外部".to_string(),
                    harness_id: crate::harness::MCP.to_string(),
                    persona: String::new(),
                    model: String::new(),
                    native_session_id: None,
                },
            ],
            workspace: None,
            source: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    /// MCP 进程用的正是这几个 core 函数：没有 AppHandle 也要能走完整状态机。
    #[test]
    fn mcp_core_flow_creates_claims_and_completes() {
        let base = temp_base("mcp-core");
        let room = test_room("room_test");

        let created = create_assignment_core(&base, &room, None, "worker", "写一段说明").unwrap();
        assert_eq!(created.assignment.status, AssignmentStatus::Queued);
        assert_eq!(created.event.seq, 1);

        let claimed = set_assignment_status_core(
            &base,
            &room.id,
            &created.assignment.id,
            AssignmentStatus::Running,
            None,
            "assignment.running",
            Some("执行 已认领任务".to_string()),
        )
        .unwrap();
        assert_eq!(claimed.status, AssignmentStatus::Running);

        let done = set_assignment_status_core(
            &base,
            &room.id,
            &created.assignment.id,
            AssignmentStatus::Completed,
            Some("结果".to_string()),
            "assignment.completed",
            Some("结果".to_string()),
        )
        .unwrap();
        assert_eq!(done.status, AssignmentStatus::Completed);

        let message = post_message_core(&base, &room.id, Some("trae"), "外部发言", true).unwrap();
        assert_eq!(message.seq, 4);
        assert_eq!(message.agent_id.as_deref(), Some("trae"));

        let events = store::read_events(&base, &room.id, Some(0)).unwrap();
        assert_eq!(
            events.iter().map(|event| event.seq).collect::<Vec<_>>(),
            vec![1, 2, 3, 4]
        );
        let _ = std::fs::remove_dir_all(base);
    }

    /// 重启恢复只碰本应用执行的任务；外部 harness 的 running/queued 必须原样保留，
    /// 否则用户重启宿主会把对方正在干的活误判为失败。
    #[test]
    fn recovery_fails_local_stale_tasks_and_keeps_external() {
        let base = temp_base("recovery");
        // 恢复按 rooms.json 判定成员归属，测试里必须先把房间落盘。
        let room = test_room("room_recovery");
        store::write_rooms(&base, &[room.clone()]).unwrap();

        let queued_local = create_assignment_core(&base, &room, None, "worker", "未开始")
            .unwrap()
            .assignment;
        let running_local = create_assignment_core(&base, &room, None, "worker", "执行中")
            .unwrap()
            .assignment;
        set_assignment_status_core(
            &base,
            &room.id,
            &running_local.id,
            AssignmentStatus::Running,
            None,
            "assignment.running",
            None,
        )
        .unwrap();

        let queued_mcp = create_assignment_core(&base, &room, None, "trae", "等认领")
            .unwrap()
            .assignment;
        let running_mcp = create_assignment_core(&base, &room, None, "trae", "外部执行中")
            .unwrap()
            .assignment;
        set_assignment_status_core(
            &base,
            &room.id,
            &running_mcp.id,
            AssignmentStatus::Running,
            None,
            "assignment.running",
            None,
        )
        .unwrap();

        let summary = recover_stale_assignments(&base).unwrap();
        assert_eq!(summary.failed_running, 1);
        assert_eq!(summary.failed_queued, 1);
        assert_eq!(summary.kept_external, 2);

        let tasks = store::read_assignments(&base).remove(&room.id).unwrap();
        let find = |id: &str| tasks.iter().find(|task| task.id == id).cloned().unwrap();
        assert_eq!(find(&queued_local.id).status, AssignmentStatus::Failed);
        assert_eq!(find(&running_local.id).status, AssignmentStatus::Failed);
        assert!(find(&running_local.id)
            .result
            .unwrap_or_default()
            .contains("应用重启"));
        assert_eq!(find(&queued_mcp.id).status, AssignmentStatus::Queued);
        assert_eq!(find(&running_mcp.id).status, AssignmentStatus::Running);

        let events = store::read_events(&base, &room.id, None).unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "assignment.failed")
                .count(),
            2
        );
        let _ = std::fs::remove_dir_all(base);
    }

    /// 认领要写认领者（审计），删除只允许删未执行的任务。
    #[test]
    fn claim_records_claimer_and_delete_guards_running() {
        let base = temp_base("claim");
        let room = test_room("room_claim");

        let created =
            create_assignment_core(&base, &room, None, "worker", "待认领").unwrap().assignment;
        let claimed =
            claim_assignment_core(&base, &room.id, &created.id, Some("trae"), "已认领".to_string())
                .unwrap();
        assert_eq!(claimed.status, AssignmentStatus::Running);
        assert_eq!(claimed.claimed_by.as_deref(), Some("trae"));

        let events = store::read_events(&base, &room.id, None).unwrap();
        let running_event = events
            .iter()
            .find(|event| event.kind == "assignment.running")
            .unwrap();
        assert_eq!(
            running_event
                .data
                .as_ref()
                .and_then(|data| data.get("claimedBy"))
                .and_then(|value| value.as_str()),
            Some("trae")
        );

        // 执行中不允许删除，必须先取消。
        assert!(delete_assignment_core(&base, &room.id, &created.id).is_err());
        set_assignment_status_core(
            &base,
            &room.id,
            &created.id,
            AssignmentStatus::Cancelled,
            Some("外部取消".to_string()),
            "assignment.cancelled",
            Some("外部取消".to_string()),
        )
        .unwrap();
        let removed = delete_assignment_core(&base, &room.id, &created.id).unwrap();
        assert_eq!(removed.id, created.id);
        assert!(store::read_assignments(&base)
            .get(&room.id)
            .map(|list| list.is_empty())
            .unwrap_or(true));
        let events = store::read_events(&base, &room.id, None).unwrap();
        assert!(events
            .iter()
            .any(|event| event.text.as_deref().unwrap_or("").contains("已删除任务")));
        let _ = std::fs::remove_dir_all(base);
    }

    /// P3 预算保护：层数上限、活跃任务上限、父任务不存在都要在建任务时就拒绝。
    #[test]
    fn task_depth_and_active_limits_are_enforced() {
        let base = temp_base("limits");
        let room = test_room("room_limits");

        let mut parent: Option<String> = None;
        for level in 1..=MAX_TASK_DEPTH {
            let created = create_assignment_core(
                &base,
                &room,
                parent.clone(),
                "worker",
                &format!("第{level}层"),
            )
            .unwrap();
            parent = Some(created.assignment.id);
        }
        assert!(create_assignment_core(&base, &room, parent, "worker", "第5层").is_err());
        assert!(create_assignment_core(
            &base,
            &room,
            Some("task_missing".to_string()),
            "worker",
            "父任务不存在"
        )
        .is_err());

        // 换一个房间测活跃上限，避免被上面的层级任务占额度。
        let base2 = temp_base("limits-active");
        let room2 = test_room("room_limits_active");
        for _ in 0..MAX_ACTIVE_TASKS {
            create_assignment_core(&base2, &room2, None, "worker", "批量任务").unwrap();
        }
        assert!(create_assignment_core(&base2, &room2, None, "worker", "超出上限").is_err());

        let _ = std::fs::remove_dir_all(base);
        let _ = std::fs::remove_dir_all(base2);
    }

    /// `.Talk` 信箱成员：建任务即投递到工作目录，结果回传时走 complete_assignment_core。
    #[test]
    fn mailbox_member_publishes_task_and_completes() {
        let base = temp_base("mailbox-runtime");
        let workspace = temp_base("mailbox-runtime-ws");
        let mut room = test_room("room_mailbox_runtime");
        room.workspace = Some(workspace.to_string_lossy().to_string());
        room.agents.push(AgentSpec {
            id: "ide".to_string(),
            name: "IDE".to_string(),
            harness_id: crate::harness::MAILBOX.to_string(),
            persona: String::new(),
            model: String::new(),
            native_session_id: None,
        });

        let created = create_assignment_core(&base, &room, None, "ide", "在 IDE 里完成")
            .unwrap()
            .assignment;
        let dir = workspace
            .join(".adyh")
            .join("collab")
            .join("rooms")
            .join(&room.id);
        assert!(dir
            .join("tasks")
            .join(format!("{}.json", created.id))
            .exists());

        complete_assignment_core(
            &base,
            &room,
            &created,
            "已写完",
            Some(json!({ "transport": "mailbox" })),
        )
        .unwrap();
        let tasks = store::read_assignments(&base).remove(&room.id).unwrap();
        assert_eq!(
            tasks.iter().find(|task| task.id == created.id).unwrap().status,
            AssignmentStatus::Completed
        );
        let events = store::read_events(&base, &room.id, None).unwrap();
        assert!(events
            .iter()
            .any(|event| event.kind == "message" && event.text.as_deref() == Some("已写完")));

        let _ = std::fs::remove_dir_all(base);
        let _ = std::fs::remove_dir_all(workspace);
    }

    /// P3：挂起写 waiting + 问题；恢复（认领）回到 running 并清掉旧问题。
    #[test]
    fn park_then_resume_task() {
        let base = temp_base("park");
        let room = test_room("room_park");
        let created =
            create_assignment_core(&base, &room, None, "worker", "需要补充信息").unwrap().assignment;

        let parked = park_assignment_core(&base, &room.id, &created.id, "请提供 API Key").unwrap();
        assert_eq!(parked.status, AssignmentStatus::Waiting);
        assert_eq!(parked.result.as_deref(), Some("请提供 API Key"));
        assert!(store::read_events(&base, &room.id, None)
            .unwrap()
            .iter()
            .any(|event| event.kind == "assignment.waiting"));

        let resumed =
            claim_assignment_core(&base, &room.id, &created.id, Some("trae"), "恢复执行".to_string())
                .unwrap();
        assert_eq!(resumed.status, AssignmentStatus::Running);
        assert!(resumed.result.is_none());
        let _ = std::fs::remove_dir_all(base);
    }
}
