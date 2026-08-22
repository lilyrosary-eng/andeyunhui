
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
