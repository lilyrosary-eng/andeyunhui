
// 全局 AI 服务 · 子模块：Agent 主流程（Agent）
// （由 ai_service.rs 机械拆分而来，逻辑零改动）

use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use crate::services::ai_service::ai_profile::{load_profiles, resolve_profile, compose_persona_system};
use crate::services::ai_service::ai_chat::{ChatMessage, is_deepseek_provider, truncate_messages_for_safety};
use crate::services::ai_service::ai_tools::{ToolContext, PendingEdit, registered_tools, mcp_tools_guide, agent_memory_context, estimate_tokens, estimate_tools_tokens, edit_store, approval_store};
use crate::services::ai_service::ai_session::{SessionEvent, EventSession, derive_messages, maybe_compress_session, collect_interrupted_tools, load_agent_session, persist_agent_session, emit_agent_error, trim_tool_result, split_deltas, plan_snapshot_json};

/// Agent 对话：原生 tool_calls + 循环。
/// 流程：非流式请求（带 tools）→ 若返回 message.tool_calls →
///   顺序执行工具 → 追加 assistant(含 tool_calls) + 若干 role:"tool" 消息 → 重发 → 重复
///   → 直到返回纯文本内容，将其作为 ai-delta 分块推给前端，ai-done 收尾。
/// 事件（payload 含 requestId 便于前端多请求区分）：
///   - ai-agent-step { requestId, stage:"tool", name, ok, detail }  工具调用/结果（供前端透传展示）
///   - ai-delta / ai-done / ai-error   与 ai_chat 一致
#[tauri::command]
pub async fn ai_chat_agent(
    app: AppHandle,
    request_id: String,
    messages: Vec<ChatMessage>,
    profile_id: Option<String>,
    system: Option<String>,
    max_rounds: Option<u32>,
    project_root: Option<String>,
) -> Result<(), String> {
    let max_rounds = max_rounds.unwrap_or(4).clamp(1u32, 12u32);
    let profiles = load_profiles(&app);
    let cfg = resolve_profile(&profiles, profile_id);
    if cfg.api_key.trim().is_empty() {
        let msg = "未配置 API Key，请先在全局设置 → 模型 中填写".to_string();
        emit_agent_error(&app, &request_id, &msg);
        return Err(msg);
    }

    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let (messages, _truncated) = truncate_messages_for_safety(messages);

    // system：人设 + 前端 per-call（与 ai_chat 同规则），并追加 agent 工具使用提示。
    let persona = compose_persona_system(&cfg);
    let effective_system = match (&system, persona.is_empty()) {
        (Some(s), true) => s.clone(),
        (Some(s), false) => format!("{}\n\n{}", s, persona),
        (None, false) => persona,
        (None, true) => String::new(),
    };
    let agent_hint = "你被允许并且应当在合适时调用下方提供的工具来获取实时信息或完成计算。需要时先调用工具，拿到结果后再组织最终回答；不要编造工具返回的数据。";
    // 注入已启用 MCP 服务器的工具清单，让模型的 mcp 工具可正确填写 server/tool
    let mcp_guide = mcp_tools_guide(&app).await;
    // 注入项目级记忆/原则/工程契约（对齐 IDE 约定），仅读、限长
    let project_root_pb = project_root.filter(|s| !s.trim().is_empty()).map(PathBuf::from);
    let mem_ctx = agent_memory_context(project_root_pb.as_deref()).await;
    let base_system = if effective_system.trim().is_empty() {
        agent_hint.to_string()
    } else {
        format!("{}\n\n{}", effective_system, agent_hint)
    };
    let system_final = format!("{}{}{}", base_system, mcp_guide, mem_ctx);

    let tools: Vec<serde_json::Value> = registered_tools().iter().map(|t| t.function_schema()).collect();
    let client = reqwest::Client::new();
    // 本轮工具上下文：文件工具靠 project_root 判“项目内”，命令默认 cwd、审批事件靠 app/request_id 回发
    let tool_ctx = ToolContext {
        app: app.clone(),
        request_id: request_id.clone(),
        project_root: project_root_pb,
    };
    let mut final_text = String::new();
    let mut tool_calls_occurred = false;

    // 事件溯源会话：request_id 即会话 id。
    //   - 若磁盘已有同名日志（崩溃恢复 / 上一轮续聊）→ 加载为续接基础，仅把本轮新消息（不含 system）追加；
    //   - 否则全新会话 → 把前端传入的环境之外历史（user/assistant 文本）作为初始事件灌入。
    // 此后每一轮模型回合 / 工具结果都以事件追加，LLM 消息每次由 derive 派生。
    let mut session = match load_agent_session(&app, &request_id) {
        Some(mut old) => {
            // 续接：追加新 user 指令即可；旧历史已在日志里，无需也不可能重复灌入。
            for m in &messages {
                if m.role == "system" {
                    continue;
                }
                if m.role == "user" {
                    old.push(SessionEvent::User {
                        seq: 0, // push() 会覆写
                        content: m.content.clone(),
                    });
                }
            }
            old
        }
        None => {
            let mut fresh = EventSession::new(&request_id);
            for m in &messages {
                if m.role == "system" {
                    continue;
                }
                // 严格按角色分流：user 落 User 事件、assistant 落 Assistant 事件，杜绝角色混淆。
                match m.role.as_str() {
                    "user" => fresh.push(SessionEvent::User {
                        seq: 0, // push() 会覆写
                        content: m.content.clone(),
                    }),
                    _ => fresh.push(SessionEvent::Assistant {
                        seq: 0, // push() 会覆写
                        content: m.content.clone(),
                        tool_calls: Vec::new(),
                    }),
                }
            }
            fresh
        }
    };

    for _round in 0..max_rounds {
        // 熔断阈值随模型档案可配置：未配置则沿用旧默认（high=36k / hard=96k）。
        // 对 1M/128k 等大上下文模型调高 profile.max_context_tokens 即可放宽，不再一刀切。
        // 统一按档案换算、不按模型类别分档：因为我们 AI 路由统一且 profile 已足够完备。
        let cap = cfg.context_cap();
        let token_high = (cap / 5).max(8_000);       // 估算 token 达到即压缩
        let token_hard = (cap / 2).min(cap).max(16_000); // 压缩后仍超 → 熔断终止

        // 上下文压缩：replace 遮蔽式（append-only，不删事件），早期回合压成摘要。
        let compressed = maybe_compress_session(&mut session, token_high, 8);
        if compressed {
            let _ = app.emit("ai-agent-step", serde_json::json!({
                "requestId": request_id, "stage": "compress", "name": "context", "ok": true,
                "detail": "早期工具回合已压缩为摘要，历史保持可用",
            }));
        }
        // 派生当次请求的 messages（含中断工具恢复；纯文本系统已并入 system_final）。
        let derived = derive_messages(&session, &system_final, collect_interrupted_tools(&session));
        // 真实发送量 = 派生消息 + 工具定义固定开销（tools 每请求都携带，必须计入，
        // 否则工具增多时会低估实际上下文、逼近上游硬限制）。
        let fixed_overhead = estimate_tools_tokens(&tools);
        if estimate_tokens(&derived) > token_hard || estimate_tokens(&derived) + fixed_overhead > cap {
            let msg = format!("上下文超限（估算 >{} token，尝试压缩后仍超出），已终止本轮", token_hard);
            emit_agent_error(&app, &request_id, &msg);
            return Err(msg);
        }
        let mut body = serde_json::json!({
            "model": cfg.model,
            "messages": derived,
            "stream": false,
            "tools": tools,
            "tool_choice": "auto",
        });
        let thinking = cfg.thinking.unwrap_or(false);
        if thinking {
            body["reasoning_effort"] = serde_json::json!("high");
            if is_deepseek_provider(&cfg) {
                body["thinking"] = serde_json::json!({ "type": "enabled" });
            }
        } else {
            body["temperature"] = serde_json::json!(cfg.temperature);
            if let Some(mt) = cfg.max_tokens {
                body["max_tokens"] = serde_json::json!(mt);
            }
        }

        let resp = match client
            .post(&url)
            .header("Authorization", format!("Bearer {}", cfg.api_key.trim()))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                let msg = format!("请求失败: {}", e);
                emit_agent_error(&app, &request_id, &msg);
                return Err(msg);
            }
        };
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            let msg = format!("HTTP {}: {}", status, text);
            emit_agent_error(&app, &request_id, &msg);
            return Err(msg);
        }
        let payload: serde_json::Value = resp.json().await.map_err(|e| format!("解析响应失败: {}", e))?;
        if let Some(err) = payload.get("error") {
            let msg = format!("上游报错: {}", err);
            emit_agent_error(&app, &request_id, &msg);
            return Err(msg);
        }
        let msg_obj = payload["choices"][0]["message"].clone();
        let content = msg_obj
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();

        // 含工具调用 → 执行并回填，进入下一轮。
        if let Some(calls) = msg_obj.get("tool_calls").and_then(|c| c.as_array()) {
            if calls.is_empty() {
                if !content.is_empty() {
                    final_text.push_str(&content);
                }
                break;
            }
            tool_calls_occurred = true;
            // 模型回合：记录 assistant 事件（含原生 tool_calls 形状）。
            session.push(SessionEvent::Assistant {
                seq: 0, // push() 会覆写
                content: content.clone(),
                tool_calls: msg_obj["tool_calls"].as_array().cloned().unwrap_or_default(),
            });

            for call in calls {
                let cid = call.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let fname = call["function"]["name"].as_str().unwrap_or("").to_string();
                let arguments = call["function"]["arguments"].as_str().unwrap_or("");
                let found = registered_tools().into_iter().find(|t| t.name() == fname);
                let (ok, detail) = match found {
                    None => (false, format!("未知工具: {}", fname)),
                    Some(tool) => {
                        // 宽松解析参数：部分模型返回非标准/截断 JSON → 降级为 error 回填给模型。
                        let args: serde_json::Value =
                            serde_json::from_str(arguments).unwrap_or_else(|_| serde_json::json!({}));
                        match tool.execute(&args, &tool_ctx).await {
                            Ok(r) => (true, r),
                            Err(e) => (false, e),
                        }
                    }
                };
                let _ = app.emit(
                    "ai-agent-step",
                    serde_json::json!({
                        "requestId": request_id,
                        "stage": "tool",
                        "name": fname,
                        "ok": ok,
                        "detail": detail,
                        // plan 工具执行后附带当前计划结构化快照，供前端渲染计划/待办面板
                        "plan": if fname == "plan" { plan_snapshot_json() } else { serde_json::Value::Null },
                    }),
                );
                // 工具结果：记录 Tool 事件（仅日志事实，不携带角色字段——由 derive 统一派生成 role:"tool"）。
                // 入日志前经过修剪器控制上下文成本；前端展示仍用完整 detail。
                session.push(SessionEvent::Tool {
                    seq: 0, // push() 会覆写
                    call_id: cid.clone(),
                    name: fname.clone(),
                    ok,
                    content: trim_tool_result(&detail),
                });
            }
            // 崩溃恢复：每轮工具结果落地即持久化一次，进程在中途被杀也能从那轮续拉。
            persist_agent_session(&app, &session);
            continue;
        }

        // 纯文本 → 最终回答。
        final_text.push_str(&content);
        break;
    }

    // 达到最大轮数仍停在工具调用且无最终内容 → 给出收敛提示而非静默。
    if final_text.trim().is_empty() {
        final_text = if tool_calls_occurred {
            format!("（已达单次请求最大工具轮数 {}，我暂停以避免失控。你可以继续让我往下做。）", max_rounds)
        } else {
            "[Agent 未返回内容]".to_string()
        };
    }

    for chunk in split_deltas(&final_text) {
        let _ = app.emit("ai-delta", serde_json::json!({ "requestId": request_id, "delta": chunk }));
    }
    // agent-loop 结束后，把该请求所有暂存编辑发往前端审阅（前端逐个保留/撤销，经 ai_agent_apply_edits 落盘）
    let staged = {
        let store = edit_store().lock().map_err(|_| "编辑存储锁获取失败".to_string())?;
        store.get(&request_id).cloned().unwrap_or_default()
    };
    if !staged.is_empty() {
        let _ = app.emit("ai-agent-edits", serde_json::json!({
            "requestId": request_id,
            "edits": staged.iter().map(|e| serde_json::json!({
                "id": e.id,
                "action": e.action,
                "path": e.path,
                // 暴露摘要便于前端展示：write 记新内容前若干字；edit 记 old→new 前若干字
                "summary": match e.action.as_str() {
                    "write" => format!("写入 {} 字符", e.new_content.clone().unwrap_or_default().chars().count()),
                    "edit" => format!("{} → {}", e.old_string.clone().unwrap_or_default(), e.new_string.clone().unwrap_or_default()),
                    _ => "删除".to_string(),
                }
            })).collect::<Vec<_>>(),
        }));
    }
    // 事件日志落盘（审计 + 精确重放；append-only 快照）。
    persist_agent_session(&app, &session);
    let _ = app.emit("ai-done", serde_json::json!({ "requestId": request_id }));
    Ok(())
}

/// 前端回调用以决定一次待审批的 Agent 操作：approved=true 放行，false 拒绝。
/// approval_id 来自 ai-agent-approval 事件。
#[tauri::command]
pub async fn ai_agent_approve(approval_id: String, approved: bool) -> Result<(), String> {
    let pending = approval_store()
        .lock()
        .map_err(|_| "审批存储锁获取失败".to_string())?
        .remove(&approval_id);
    match pending {
        Some(p) => {
            let _ = p.sender.send(approved);
            Ok(())
        }
        None => Err("授权请求不存在或已过期".to_string()),
    }
}

/// 把某请求暂存的编辑审阅后真正落盘。keep_ids 为空时全部落盘；
/// 否则仅落盘 keep_ids 中通过审阅的编辑，其余丢弃。
/// 按暂存顺序重放 write/edit/delete，保证与模型所见视图一致。
#[tauri::command]
pub async fn ai_agent_apply_edits(request_id: String, keep_ids: Option<Vec<String>>) -> Result<usize, String> {
    let store = edit_store()
        .lock()
        .map_err(|_| "编辑存储锁获取失败".to_string())?;
    let edits = store.get(&request_id).cloned().unwrap_or_default();
    drop(store);
    if edits.is_empty() {
        return Ok(0);
    }
    let keep_all = keep_ids.as_ref().map(|v| v.is_empty()).unwrap_or(true);
    let mut written = 0usize;
    // 先串行重放 write/edit，最后处理 delete，避免碰撞。
    // edits 按 record_edit 的 order 升序保存，直接按此顺序重放即可。
    let mut deletions: Vec<&PendingEdit> = Vec::new();
    for e in &edits {
        if !keep_all && !keep_ids.as_ref().map(|k| k.contains(&e.id)).unwrap_or(false) {
            continue;
        }
        let p = std::path::PathBuf::from(&e.path);
        match e.action.as_str() {
            "delete" => { deletions.push(e); }
            "write" => {
                if let Some(parent) = p.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|err| format!("创建目录失败 {}: {}", parent.display(), err))?;
                }
                let content = e.new_content.clone().unwrap_or_default();
                std::fs::write(&p, content.as_bytes())
                    .map_err(|err| format!("写入失败 {}: {}", p.display(), err))?;
                written += 1;
            }
            "edit" => {
                let old = e.old_string.clone().unwrap_or_default();
                let new = e.new_string.clone().unwrap_or_default();
                let text = std::fs::read_to_string(&p)
                    .map_err(|err| format!("编辑前读取失败 {}: {}", p.display(), err))?;
                if !text.contains(&old) {
                    return Err(format!("落盘失败 {}：old_string 已不在文件中（可能被其它改动覆盖），{}", p.display(), old));
                }
                let new_text = if text.matches(&old).count() > 1 {
                    text.replace(&old, &new)
                } else {
                    text.replacen(&old, &new, 1)
                };
                std::fs::write(&p, new_text.as_bytes())
                    .map_err(|err| format!("编辑写入失败 {}: {}", p.display(), err))?;
                written += 1;
            }
            _ => {}
        }
    }
    for e in deletions {
        if !keep_all && !keep_ids.as_ref().map(|k| k.contains(&e.id)).unwrap_or(false) {
            continue;
        }
        let p = std::path::PathBuf::from(&e.path);
        std::fs::remove_file(&p).map_err(|err| format!("删除失败 {}: {}", p.display(), err))?;
        written += 1;
    }
    // 清理该请求的暂存
    let store = edit_store()
        .lock()
        .map_err(|_| "编辑存储锁获取失败".to_string())?;
    let mut s = store;
    s.remove(&request_id);
    Ok(written)
}
