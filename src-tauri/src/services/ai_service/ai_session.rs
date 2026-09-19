
// 全局 AI 服务 · 子模块：Agent 事件溯源会话（Session）
// （由 ai_service.rs 机械拆分而来，逻辑零改动）

use std::fs;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use crate::services::ai_service::ai_tools::{estimate_tokens, plan_store};

// ============ 事件溯源会话模型（对齐 dsh 的 append-only Session + surface 派生） ============
// 核心思想：Agent 的交互历史不直接存成「消息数组」，而是维护一份**只追加（append-only）的事件日志**，
// LLM 请求所需的 messages 每次都从日志**派生（derive）**。这样：
//   - 日志只存不回改 → 审计、精确重放每一轮工具调用边界；
//   - 上下文压缩通过追加一条 `Compact` 事件做 **replace 遮蔽**（不删除原始事件），
//     到 high 阈值时用摘要替换被遮蔽段落，短尾保留最新回合；
//   - 会话末尾若出现「assistant 声称调用了工具但缺对应 Tool 事件」（中断），
//     派生时自动补齐 `TOOL_OUTCOME_UNKNOWN` 恢复消息，避免模型盲目重试副作用操作。
// 本阶段（A：循环内事件化）不改前后端契约：前端仍发全量 messages，后端先落日志再改造成事件，
// 值即事件化 + 遮蔽压缩 + 中断修复 + 审计落盘。

/// 会话日志中的一条事件。所有变体都是「发生过的一次事实」，只追加、不原地修改。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) enum SessionEvent {
    /// 用户回合（初始历史中的 user 消息，或后续多轮追加的用户新指令）。
    User {
        seq: u64,
        content: String,
    },
    /// 模型回合（可能携带工具请求）。`tool_calls` 采用 OpenAI 原生形状 `[{id,type,function:{name,arguments}}]`。
    Assistant {
        seq: u64,
        content: String,
        tool_calls: Vec<serde_json::Value>,
    },
    /// 一条工具结果，通过 `call_id` 与之对应的 assistant 请求配对。
    Tool {
        seq: u64,
        call_id: String,
        name: String,
        ok: bool,
        content: String,
        /// 结构化呈现 meta（对齐 dsh presentationMeta：随日志持久化，replay/fork 后仍能恢复 UI 卡片）。
        /// Option + #[serde(default)] 向后兼容旧版日志（缺该字段按 None 读）。
        #[serde(default)]
        meta: Option<serde_json::Value>,
    },
    /// 压缩检查点（replace 遮蔽）：`summary` 是早期回合的摘要求，`shadow_until=<seq>` 表示
    /// seq ≤ 该值的旧事件被遮蔽、不再进入派生（但日志中仍保留，可审计）。
    Compact {
        seq: u64,
        summary: String,
        shadow_until: u64,
    },
    /// 中断修复：assistant 请求了工具但日志里始终没有对应 Tool 结果。
    Interrupted {
        seq: u64,
        call_id: String,
        content: String,
    },
}

/// 一次 Agent 会话的事件日志。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EventSession {
    id: String,
    created_at: String,
    /// 派生来源会话 id（fork 时记录血缘；None 表示根源会话）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent: Option<String>,
    /// 当前事件序号（严格递增；等价于事件数组长度，但显式记录更稳健）。
    seq: u64,
    events: Vec<SessionEvent>,
}

impl EventSession {
    /// 新建空会话，会话 ID = request_id（本阶段后端独有，不改前端契约）。
    pub(crate) fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            created_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            parent: None,
            seq: 0,
            events: Vec::new(),
        }
    }

    pub(crate) fn push(&mut self, mut ev: SessionEvent) {
        // 为事件补齐递增序号（Compact/Interrupted 之外的事件无官方来源，统一在此赋 seq）
        if let Some(s) = ev_seq_mut(&mut ev) {
            *s = self.seq;
            self.seq += 1;
        }
        self.events.push(ev);
    }

    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    /// 已落账的事件条数（fork/replay 返回给前端核对用）。
    pub(crate) fn event_count(&self) -> usize {
        self.events.len()
    }

    /// 血缘：派生来源会话 id（None 为根源会话）。
    pub(crate) fn parent(&self) -> Option<&str> {
        self.parent.as_deref()
    }

    /// 创建时间（前端轨迹面板列表展示用）。
    pub(crate) fn created_at(&self) -> &str {
        &self.created_at
    }

    /// 完整事件日志（只读；供轨迹面板 / 审计渲染）。
    pub(crate) fn events(&self) -> &[SessionEvent] {
        &self.events
    }
}

/// 若事件带 `seq` 字段，返回其可变引用（Compact/Interrupted 无则 None）。
fn ev_seq_mut(ev: &mut SessionEvent) -> Option<&mut u64> {
    let seq = match ev {
        SessionEvent::User { seq, .. }
        | SessionEvent::Assistant { seq, .. }
        | SessionEvent::Tool { seq, .. } => seq,
        _ => return None,
    };
    Some(seq)
}

/// 派生该会话当前应发送给 LLM 的 messages 数组，前面外挂 system。
/// - 找到最新（且仍生效）的 Compact 事件，得到 `shadow_until`；
/// - 遍历事件：seq ≤ shadow_until 的被遮蔽跳过，并把摘要插到遮蔽段的开头；
/// - 若 assistant 带 tool_calls 但缺对应 Tool 结果，补一条 TOOL_OUTCOME_UNKNOWN 恢复消息。
pub(crate) fn derive_messages(session: &EventSession, system: &str, extra_repairs: Vec<SessionEvent>) -> Vec<serde_json::Value> {
    // 第一遍：定位最新 Compact 的遮蔽边界（append-only 下最新 Compact `shadow_until` 覆盖更早段落）。
    let mut shadow_until = 0u64;
    let mut summary: Option<String> = None;
    for ev in &session.events {
        if let SessionEvent::Compact { shadow_until: su, summary: sm, .. } = ev {
            shadow_until = *su;
            summary = Some(sm.clone());
        }
    }

    // 把待派生的全部事件（原日志 + 额外修复）按 seq 排序合并，Append-only 保证大部分已有序。
    let mut all: Vec<SessionEvent> = session.events.clone();
    all.extend(extra_repairs);

    let mut out = vec![serde_json::json!({ "role": "system", "content": system })];
    let mut inserted_summary = false;
    for ev in all {
        match &ev {
            // 用户回合直接派生为 role:"user"（遮蔽时同样跳过并插入摘要）。
            SessionEvent::User { seq, content } => {
                if *seq <= shadow_until {
                    if !inserted_summary {
                        if let Some(s) = &summary {
                            out.push(serde_json::json!({ "role": "user", "content": s.clone() }));
                        }
                        inserted_summary = true;
                    }
                    continue;
                }
                out.push(serde_json::json!({ "role": "user", "content": content }));
            }
            SessionEvent::Assistant { seq, content, tool_calls } => {
                if *seq <= shadow_until {
                    // 被遮蔽 → 在其开头插入一次摘要（只插一次）
                    if !inserted_summary {
                        if let Some(s) = &summary {
                            out.push(serde_json::json!({ "role": "user", "content": s.clone() }));
                        }
                        inserted_summary = true;
                    }
                    continue;
                }
                let mut m = serde_json::json!({ "role": "assistant", "content": content });
                if !tool_calls.is_empty() {
                    m["tool_calls"] = serde_json::Value::Array(tool_calls.clone());
                }
                out.push(m);
            }
            SessionEvent::Tool { seq, call_id, ok, content, .. } => {
                if *seq <= shadow_until {
                    continue;
                }
                // 失败时前置 "Error: "（对齐 Claude Code 工具错误回填约定）让模型感知失败
                let c = if *ok { content.clone() } else { format!("Error: {}", content) };
                out.push(serde_json::json!({ "role": "tool", "tool_call_id": call_id, "content": c }));
            }
            SessionEvent::Compact { .. } => { /* 压缩检查点本身不产生消息，仅作为遮蔽边界 */ }
            SessionEvent::Interrupted { seq, call_id, content, .. } => {
                if *seq <= shadow_until {
                    continue;
                }
                out.push(serde_json::json!({ "role": "tool", "tool_call_id": call_id, "content": content }));
            }
        }
    }
    out
}

/// 对一条 append-only 会话做 **replace 遮蔽式压缩**：估算超阈值时，把「保留尾部之外」的历史事件
/// 压成一条摘要 `Compact` 事件追加进日志；其 `shadow_until` 遮蔽被压缩段落。
/// 注意：**不从日志删除**任何事件 —— 之所以能达到省 token 的目的，是因为派生（derive）只发送
/// 未被遮蔽的事件给 LLM；真正要控制的成本是「发送过去的 token」，而不是内存条数。
/// 而日志保持 append-only，正好满足审计与精确重放。返回是否发生了压缩。
pub(crate) fn maybe_compress_session(session: &mut EventSession, high: usize, keep_tail: usize) -> bool {
    let msg_est = estimate_tokens(&derive_messages(session, "", Vec::new()));
    if msg_est < high {
        return false;
    }
    let n = session.events.len();
    if n <= keep_tail + 2 {
        return false; // 事件太少，无需压缩
    }
    let end = n - keep_tail;
    let mut sum = String::from("【早期上下文已压缩为以下已完成工具回合的摘要，供你在此基础上延续任务】");
    let mut shadow_until = 0u64;
    for ev in &session.events[..end] {
        match ev {
            SessionEvent::User { seq, content } => {
                shadow_until = shadow_until.max(*seq);
                let cont: String = content.chars().take(60).collect();
                if !cont.is_empty() {
                    sum.push_str(&format!("\n  · 用户指令：{}", cont));
                }
            }
            SessionEvent::Assistant { seq, content, tool_calls } => {
                shadow_until = shadow_until.max(*seq);
                let names: Vec<String> = tool_calls
                    .iter()
                    .filter_map(|c| c["function"]["name"].as_str().map(String::from))
                    .collect();
                let cont: String = content.chars().take(60).collect();
                if !names.is_empty() {
                    sum.push_str(&format!("\n  · 调用工具：[{}] {}", names.join(", "), cont));
                } else if !cont.is_empty() {
                    sum.push_str(&format!("\n  · 内容：{}", cont));
                }
            }
            SessionEvent::Tool { seq, content, name, .. } => {
                shadow_until = shadow_until.max(*seq);
                let len = content.chars().count();
                let head: String = content.chars().take(90).collect();
                sum.push_str(&format!("\n  · 工具 `{}` 返回（{} 字）：{}", name, len, head));
            }
            SessionEvent::Compact { seq, .. } | SessionEvent::Interrupted { seq, .. } => {
                shadow_until = shadow_until.max(*seq);
            }
        }
    }
    session.push(SessionEvent::Compact {
        seq: session.seq, // push() 会覆盖 seq，此处字段仍以 push 赋值为准
        summary: sum,
        shadow_until,
    });
    true
}

/// 检查会话：对「assistant 带了 tool_calls 但缺对应 Tool 结果」的调用补齐恢复消息。
/// 返回需并入派生的 Interrupted 事件（不改写日志，仅在本次派生时补充）。
pub(crate) fn collect_interrupted_tools(session: &EventSession) -> Vec<SessionEvent> {
    let mut requested: Vec<(u64, String)> = Vec::new();
    let mut have_results: std::collections::HashSet<String> = std::collections::HashSet::new();
    for ev in &session.events {
        match ev {
            SessionEvent::Assistant { seq, tool_calls, .. } => {
                for c in tool_calls {
                    if let Some(id) = c["id"].as_str() {
                        requested.push((*seq, id.to_string()));
                    }
                }
            }
            SessionEvent::Tool { call_id, .. } => {
                have_results.insert(call_id.clone());
            }
            _ => {}
        }
    }
    let mut repairs = Vec::new();
    for (owner_seq, cid) in requested {
        if !have_results.contains(&cid) {
            repairs.push(SessionEvent::Interrupted {
                seq: owner_seq,
                call_id: cid.clone(),
                content: "The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.".to_string(),
            });
        }
    }
    repairs
}

/// plan 工具执行后，返回当前计划的结构化快照（供前端渲染计划/待办面板）。
pub(crate) fn plan_snapshot_json() -> serde_json::Value {
    if let Ok(g) = plan_store().lock() {
        serde_json::to_value(&*g).unwrap_or_default()
    } else {
        serde_json::Value::Null
    }
}

/// 统一发送 ai-error 事件 + 返回错误消息。
pub(crate) fn emit_agent_error(app: &AppHandle, request_id: &str, msg: &str) {
    let _ = app.emit("ai-error", serde_json::json!({ "requestId": request_id, "error": msg }));
}

/// 工具结果修剪器：超大工具输出（如 grep 命中大量内容、read 大文件）全量写入日志会拉升
/// 后续每轮真实发送量。入事件前按长度截断，保留头尾 + 长度标注，控制上下文成本。
/// 仅作用于入日志的 Tool.content；前端展示仍用完整 detail（emit 未走此函数）。
const TOOL_RESULT_HEAD: usize = 4_000; // 保留前 4k 字符
const TOOL_RESULT_TAIL: usize = 1_000; // 保留尾 1k 字符
pub(crate) fn trim_tool_result(content: &str) -> String {
    let total = content.chars().count();
    if total <= TOOL_RESULT_HEAD + TOOL_RESULT_TAIL {
        return content.to_string();
    }
    let head: String = content.chars().take(TOOL_RESULT_HEAD).collect();
    let tail: String = content.chars().skip(total - TOOL_RESULT_TAIL).collect();
    format!("{}…[中间 {} 字已省略以实现上下文控制]…{}", head, total - TOOL_RESULT_HEAD - TOOL_RESULT_TAIL, tail)
}

/// 把一次 Agent 会话的事件日志落盘到 app_data_dir/ai_sessions/<request_id>.json。
/// append-only 快照：既做审计、也供 crash-resume 精确重放。
pub(crate) fn persist_agent_session(app: &AppHandle, session: &EventSession) {
    let dir = app.path().app_data_dir();
    let Ok(dir) = dir else { return };
    let sessions_dir = dir.join("ai_sessions");
    let _ = fs::create_dir_all(&sessions_dir);
    let file = sessions_dir.join(format!("{}.json", session.id));
    if let Ok(json) = serde_json::to_string_pretty(session) {
        let _ = fs::write(file, json);
    }
}

/// 若磁盘上已有同名 request_id 的事件日志（此前崩溃或上一轮正常结束），加载它作为续接基础；
/// 否则返回一个全新的空会话。这样前端只需沿用同一会话 id 再次请求，即可自动“续聊”。
pub(crate) fn load_agent_session(app: &AppHandle, id: &str) -> Option<EventSession> {
    let dir = app.path().app_data_dir().ok()?;
    let file = dir.join("ai_sessions").join(format!("{}.json", id));
    let Ok(text) = fs::read_to_string(file) else { return None };
    serde_json::from_str(&text).ok()
}

// ============ 事件溯源 replay / fork（对齐 dsh SessionStore.fork 语义） ============
// dsh 的 fork(source, boundary?, childId?)：取源事件日志的合法前缀 events[0..=boundary] 作为
// 子会话种子，header 记录 parentSession 与 seedLength；边界不得落在「未闭合回合」上（OPEN_TURN）。
// 本实现用**事件索引**（0 起）充当 boundary（dsh 的 seq 即索引；我们的 seq 因压缩标记而不严格连续，
// 索引才唯一且可作前缀切点）。fork 不改变源日志（append-only）；子会话以新 id 落盘，可被
// ai_chat_agent(child_id) 续接成另一条探索分支。

/// fork/replay 边界校验错误码（对应 dsh 的 INVALID_BOUNDARY / OPEN_TURN）。
#[derive(Debug)]
pub(crate) enum ForkError {
    /// 边界越界 / 源无可 fork 内容。
    InvalidBoundary(String),
    /// 边界落在「assistant 已声明工具调用但结果未落账」的未闭合回合上，拒绝派生残缺回合。
    OpenTurn(String),
}

pub(crate) fn fork_err_text(e: &ForkError) -> String {
    match e {
        ForkError::InvalidBoundary(m) | ForkError::OpenTurn(m) => m.clone(),
    }
}

/// 取源会话的合法前缀，重建一个会话视图：仅保留对话承载事件（User/Assistant/Tool），
/// 压缩标记 Compact / 中断修复 Interrupted 为一次性元数据，不随前缀继承（它们遮蔽的是更长历史
/// 或本就不在对话流里，fork 新血缘无需携带）。子日志 seq 由 push 重新连续赋号。
fn prefix_session(source: &EventSession, boundary: usize) -> Result<EventSession, ForkError> {
    let events = &source.events;
    if boundary >= events.len() {
        let last = events.len().saturating_sub(1);
        return Err(ForkError::InvalidBoundary(format!(
            "fork 边界索引 {boundary} 超出源会话（最后索引: {last}）"
        )));
    }
    // OPEN_TURN：边界事件若是携带 tool_calls 的 assistant 回合，其工具结果必然在其后
    // （前缀被截断 → 该回合未闭合），拒绝 fork，避免派生出不完整回合。
    if let SessionEvent::Assistant { tool_calls, .. } = &events[boundary] {
        if !tool_calls.is_empty() {
            return Err(ForkError::OpenTurn(format!(
                "fork 边界索引 {boundary} 落在未闭合的工具调用回合上，请改以该回合的工具结果或其后的稳定点作为边界"
            )));
        }
    }
    let mut view = EventSession::new(source.id.clone());
    for ev in &events[..=boundary] {
        match ev {
            SessionEvent::User { content, .. } => {
                view.push(SessionEvent::User { seq: 0, content: content.clone() });
            }
            SessionEvent::Assistant { content, tool_calls, .. } => {
                view.push(SessionEvent::Assistant { seq: 0, content: content.clone(), tool_calls: tool_calls.clone() });
            }
            SessionEvent::Tool { call_id, name, ok, content, meta, .. } => {
                view.push(SessionEvent::Tool { seq: 0, call_id: call_id.clone(), name: name.clone(), ok: *ok, content: content.clone(), meta: meta.clone() });
            }
            _ => {} // Compact / Interrupted 不随前缀继承
        }
    }
    Ok(view)
}

/// 从源会话派生一个**子会话**（fork，对齐 dsh SessionStore.fork）：
/// 取合法前缀 events[0..=boundary] 为种子，child_id 为子会话 id，血缘 parent 记录为源 id。
/// boundary 省略 → 取源当前最后一条事件；空源 → 允许 fork 空子。
pub(crate) fn fork_session(
    source: &EventSession,
    child_id: &str,
    boundary: Option<usize>,
) -> Result<EventSession, ForkError> {
    if source.events.is_empty() {
        return Ok(EventSession { id: child_id.to_string(), parent: Some(source.id.clone()), ..EventSession::new(child_id) });
    }
    let b = boundary.unwrap_or_else(|| source.events.len() - 1);
    let mut child = prefix_session(source, b)?;
    child.id = child_id.to_string();
    child.parent = Some(source.id.clone());
    Ok(child)
}

/// replay：不解入 LLM、不落盘，仅把源会话（可选截至 boundary 的前缀）重新派生成当前会发给模型的
/// messages 快照，供审计 / 校验 / 前端回放概览使用。
pub(crate) fn replay_derived_messages(
    source: &EventSession,
    boundary: Option<usize>,
    system: &str,
) -> Result<Vec<serde_json::Value>, ForkError> {
    if source.events.is_empty() {
        return Err(ForkError::InvalidBoundary("空会话无可重放的事件".into()));
    }
    let b = boundary.unwrap_or_else(|| source.events.len() - 1);
    let view = prefix_session(source, b)?;
    Ok(derive_messages(&view, system, Vec::new()))
}

/// 把最终文本按「换行 / 最长 ~96 字符」切成增量块，推给前端保持近似逐字流式观感。字符级安全（不切 UTF-8）。
pub(crate) fn split_deltas(text: &str) -> Vec<String> {
    const MAX: usize = 96;
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    for c in text.chars() {
        cur.push(c);
        if c == '\n' || cur.chars().count() >= MAX {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}
