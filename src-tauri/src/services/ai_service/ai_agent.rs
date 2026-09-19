
// 全局 AI 服务 · 子模块：Agent 主流程（Agent）
// （由 ai_service.rs 机械拆分而来，逻辑零改动）

use std::path::PathBuf;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};
use futures_util::StreamExt;
use crate::services::ai_service::ai_profile::{load_profiles, resolve_profile, compose_persona_system, compose_effective_system, ensure_api_key};
use crate::services::ai_service::ai_chat::{ChatMessage, is_deepseek_provider, truncate_messages_for_safety};
use crate::services::ai_service::ai_tools::{ToolContext, ToolConcurrency, ToolExecResult, execute_tool_once, PendingEdit, registered_tools, mcp_tools_guide, skills_guide, agent_memory_context, estimate_tokens, estimate_tools_tokens, edit_store, approval_store, take_subagent_settles};
use crate::services::ai_service::ai_session::{SessionEvent, EventSession, derive_messages, maybe_compress_session, collect_interrupted_tools, load_agent_session, persist_agent_session, emit_agent_error, trim_tool_result, split_deltas, plan_snapshot_json, fork_session, replay_derived_messages, fork_err_text};

/// Agent 对话：原生 tool_calls + 循环。
/// 流程：非流式请求（带 tools）→ 若返回 message.tool_calls →
///   顺序执行工具 → 追加 assistant(含 tool_calls) + 若干 role:"tool" 消息 → 重发 → 重复
///   → 直到返回纯文本内容，将其作为 ai-delta 分块推给前端，ai-done 收尾。
/// 事件（payload 含 requestId 便于前端多请求区分）：
///   - ai-agent-step { requestId, stage:"tool", name, ok, detail }  工具调用/结果（供前端透传展示）
///   - ai-delta / ai-done / ai-error   与 ai_chat 一致
///
/// 本函数为【后台 worker】执行的会话循环：`ai_chat_agent` 命令只负责把本任务注册进 worker 表并
/// 立即返回；本函数在 tokio::spawn 的后台任务里运行，期间通过事件把增量推给前端。cancel 为协作式
/// 取消标记（用户在协作点主动退出），与注册表的 abort handle 共用一线（cancel 落 flag + abort 强制
/// 中断在途 await）。
async fn run_agent(
    app: AppHandle,
    request_id: String,
    messages: Vec<ChatMessage>,
    profile_id: Option<String>,
    system: Option<String>,
    max_rounds: Option<u32>,
    project_root: Option<String>,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let max_rounds = max_rounds.unwrap_or(4).clamp(1u32, 12u32);
    let profiles = load_profiles(&app);
    let cfg = resolve_profile(&profiles, profile_id.clone());
    ensure_api_key(&app, &request_id, &cfg)?;

    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let (messages, _truncated) = truncate_messages_for_safety(messages);

    // system：人设 + 前端 per-call（与 ai_chat 同规则），并追加 agent 工具使用提示。
    let persona = compose_persona_system(&cfg);
    let effective_system = compose_effective_system(&system, &persona);
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
    // 注入项目技能索引（progressive disclosure）：只带名称+关键词，详情用 skill 工具按需加载
    let skill_guide = skills_guide(project_root_pb.as_deref());
    let system_final = format!("{}{}{}{}", base_system, mcp_guide, skill_guide, mem_ctx);

    let tools: Vec<serde_json::Value> = registered_tools().iter().map(|t| t.function_schema()).collect();
    let client = reqwest::Client::new();
    // 本轮工具上下文：文件工具靠 project_root 判“项目内”，命令默认 cwd、审批事件靠 app/request_id 回发
    let tool_ctx = ToolContext {
        app: app.clone(),
        request_id: request_id.clone(),
        project_root: project_root_pb,
        profile_id: profile_id.clone(),
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
        // 协作式取消检查点一：每轮开跑前。
        if cancel.load(Ordering::SeqCst) {
            let _ = app.emit("ai-done", serde_json::json!({
                "requestId": request_id, "cancelled": true,
                "text": "已收到取消请求，agent 已停止",
            }));
            return Ok(());
        }
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
        // M3：在 turn 边界取走后台并行子代理的 settle 结论，拼进当轮 system，
        //     让主 agent 能感知/汇总先前委派子代理的最新最终结论。
        let settles = take_subagent_settles(&request_id);
        let turn_system = if settles.is_empty() {
            system_final.clone()
        } else {
            let mut block = String::from("\n\n以下是你先前委派的并行子代理已返回的最终结论，请结合汇总或给出后续行动：\n");
            for s in &settles {
                block.push_str(&format!("- [{}]（{}）", s.role, s.child_id));
                if let Some(e) = &s.error {
                    block.push_str(&format!("：失败 - {}\n", e));
                } else {
                    block.push_str(&format!("：{}\n", if s.conclusion.is_empty() { "（未产出结论）" } else { &s.conclusion }));
                }
            }
            block.push_str("\n如需继续追问某个子代理，可用 send_message 向它投递新指令。");
            format!("{}{}", system_final, block)
        };
        let derived = derive_messages(&session, &turn_system, collect_interrupted_tools(&session));
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

            // ---- 工具并发调度（对齐 dsh executeToolCalls）----
            // 只读/纯计算工具（Parallel）带界并发执行；有副作用/共享可变状态的工具（Exclusive）
            // 以单元素窗口串行，起批次屏障；结果一律按模型顺序 commit 回填。
            const PARALLEL_LIMIT: usize = 4; // dsh 默认 maxParallelToolCalls 上限，带界池
            let tools = registered_tools();
            // 整批调用解析为可调度单元（保留模型顺序）：(cid, fname, 工具下标或None, args)
            let mut prepared: Vec<(String, String, Option<usize>, serde_json::Value)> = Vec::with_capacity(calls.len());
            for call in calls {
                let cid = call.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let fname = call["function"]["name"].as_str().unwrap_or("").to_string();
                let arguments = call["function"]["arguments"].as_str().unwrap_or("");
                // 宽松解析参数：部分模型返回非标准/截断 JSON → 降级为 error 回填给模型。
                let args: serde_json::Value =
                    serde_json::from_str(arguments).unwrap_or_else(|_| serde_json::json!({}));
                let idx = tools.iter().position(|t| t.name() == fname);
                prepared.push((cid, fname, idx, args));
            }
            let is_exclusive = |i: usize| match prepared[i].2 {
                Some(idx) => tools[idx].concurrency() == ToolConcurrency::Exclusive,
                None => true, // 未知工具按独占处理，避免误并发
            };
            // 协作式取消检查点二：每批工具执行前。
            if cancel.load(Ordering::SeqCst) {
                let _ = app.emit("ai-done", serde_json::json!({
                    "requestId": request_id, "cancelled": true,
                    "text": "已收到取消请求，agent 已停止",
                }));
                return Ok(());
            }
            let mut active = 0;
            while active < prepared.len() {
                // 段边界：连续 Parallel 组成一段；Exclusive 单独成段（长 1），起批次屏障。
                // 段内用有界滚动缓冲（buffer_unordered）执行：任一卷位完成即补充下一个，对齐 dsh 的
                // 「有界滚动池」——而非静态 join_all 那种「锁死整窗、等最快者也等最慢者」的批等待。
                let mut seg_end = active + 1;
                if !is_exclusive(active) {
                    while seg_end < prepared.len() && !is_exclusive(seg_end) {
                        seg_end += 1;
                    }
                }
                // 执行段前先广播 call-time 呈现（对齐 dsh presentCall）：对段内每个工具按模型顺序发
                // 一个「将做什么」的 pending 卡，供前端在结果落地前渲染；与 stage:"tool" 结果事件用 cid 配对。
                for p in active..seg_end {
                    let cid = prepared[p].0.clone();
                    let fname = prepared[p].1.clone();
                    let args = &prepared[p].3;
                    let call_meta = prepared[p]
                        .2
                        .map(|i| tools[i].present_call(args))
                        .unwrap_or_else(|| serde_json::json!({ "card": "generic", "kind": "other", "title": fname }));
                    let _ = app.emit("ai-agent-step", serde_json::json!({
                        "requestId": request_id,
                        "stage": "tool-start",
                        "cid": cid,
                        "name": fname,
                        "meta": call_meta,
                    }));
                }
                // 滚动执行：带界并发（PARALLEL_LIMIT），完成即补下一个；结果按下标回填保持模型顺序。
                let mut slots: Vec<Option<(bool, ToolExecResult)>> = (active..seg_end).map(|_| None).collect();
                let mut buffered = futures_util::stream::iter(active..seg_end)
                    .map(|p| {
                        // 在闭包外提取自有数据与工具引用，避免捕获遍历变量/整体移动 Vec。
                        let fname = prepared[p].1.clone();
                        let args = prepared[p].3.clone();
                        let tool = prepared[p].2.map(|i| tools[i].as_ref()); // Option<&dyn AiTool>
                        let tc = &tool_ctx;
                        async move { (p, execute_tool_once(tool, &fname, &args, tc).await) }
                    })
                    .buffer_unordered(PARALLEL_LIMIT);
                while let Some((p, r)) = buffered.next().await {
                    slots[p - active] = Some(r);
                }
                // 结果按模型顺序 commit：发射 step 事件 + 记录 Tool 事件。
                for (k, p) in (active..seg_end).enumerate() {
                    let cid = prepared[p].0.clone();
                    let fname = prepared[p].1.clone();
                    let (ok, res) = slots[k].as_ref().expect("滚动缓冲 slot 必有结果");
                    let detail = &res.text;
                    // 结构化呈现 meta（对齐 dsh presentResult → ToolResultView）：优先用 execute 自带 meta，
                    // 缺省再尝试工具的 present_result 二次结构化；都不提供则前端回退渲染 detail。
                    let meta = res.meta.clone().or_else(|| {
                        prepared[p]
                            .2
                            .and_then(|i| tools[i].present_result(detail, &prepared[p].3))
                    });
                    let _ = app.emit(
                        "ai-agent-step",
                        serde_json::json!({
                            "requestId": request_id,
                            "stage": "tool",
                            // 携带 cid 与同段 tool-start pending 卡配对，供前端结果落地时更新对应卡片
                            "cid": cid,
                            "name": fname,
                            "ok": ok,
                            "detail": detail,
                            "meta": meta.as_ref(),
                            // plan 工具执行后附带当前计划结构化快照，供前端渲染计划/待办面板
                            "plan": if fname == "plan" { plan_snapshot_json() } else { serde_json::Value::Null },
                        }),
                    );
                    // 通用 Hook：每单步工具执行完成后触发（副作用管线，无钩时 O(1) 空操作）。
                    // 放在 session.push 之前：cid/fname 在 push 里被 move，此处仍需借用。
                    crate::services::hook_service::trigger(
                        crate::services::hook_service::HOOK_AGENT_STEP,
                        &serde_json::json!({
                            "requestId": request_id,
                            "cid": &cid,
                            "name": &fname,
                            "ok": *ok,
                        }),
                    );
                    // 工具结果：记录 Tool 事件（仅日志事实，不携带角色字段——由 derive 统一派生成 role:"tool"）。
                    // 入日志前经过修剪器控制上下文成本；前端展示仍用完整 detail。
                    session.push(SessionEvent::Tool {
                        seq: 0, // push() 会覆写
                        call_id: cid,
                        name: fname,
                        ok: *ok,
                        content: trim_tool_result(detail),
                        // 呈现 meta 随日志落盘（对齐 dsh presentationMeta）：来自 res.meta / present_result，
                        // 供 replay/fork 后前端恢复 UI 卡片；不参与派生（derive 的 tool 消息只带 content）。
                        meta: meta.clone(),
                    });
                }
                active = seg_end;
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
            // 每条编辑携带 dsh 风格 FileDiff（oldText/newText），供前端 diff 库渲染改动前后差异：
            //   write:  oldText=null（新文件/覆盖写无 before-image），newText=新全文
            //   edit:   行级 oldText/newText
            //   delete: oldText=磁盘原文(截断)，newText=null
            "edits": staged.iter().map(|e| serde_json::json!({
                "id": e.id,
                "action": e.action,
                "path": e.path,
                "oldText": e.old_text,
                "newText": e.new_text,
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

/// 事件溯源 **fork**（对齐 dsh SessionStore.fork）：源会话 = 磁盘上已持久化的 ai_sessions/<source_id>.json。
/// 以源日志合法前缀 events[0..=boundary] 为种子派生一个 child_id 子会话（血缘 parent=source_id），
/// 立即落盘可被 ai_chat_agent(child_id) 续接成另一条探索分支。源日志不改。
/// boundary 省略 → 取源最后一条事件；边界落在未闭合工具回合（OPEN_TURN）会拒绝。
#[tauri::command]
pub async fn ai_agent_fork(
    app: AppHandle,
    source_id: String,
    child_id: String,
    boundary: Option<usize>,
) -> Result<String, String> {
    let source = load_agent_session(&app, &source_id)
        .ok_or_else(|| format!("源会话 {source_id} 不存在（尚未持久化）"))?;
    let child = fork_session(&source, &child_id, boundary).map_err(|e| fork_err_text(&e))?;
    persist_agent_session(&app, &child);
    Ok(serde_json::to_string(&serde_json::json!({
        "childId": child.id(),
        "parentId": child.parent(),
        "events": child.event_count(),
    }))
    .map_err(|e| e.to_string())?)
}

/// 事件溯源 **replay**：不调用 LLM、不改写任何日志，仅把磁盘上 ai_sessions/<source_id>.json
/// 的事件日志（可选截至 boundary 的前缀）重新派生成当前会发给模型的 messages 快照返回，
/// 供前端回放概览 / 审计 / 校验。boundary 语义与 ai_agent_fork 一致。
#[tauri::command]
pub async fn ai_agent_replay(
    app: AppHandle,
    source_id: String,
    boundary: Option<usize>,
) -> Result<String, String> {
    let source = load_agent_session(&app, &source_id)
        .ok_or_else(|| format!("会话 {source_id} 不存在（尚未持久化）"))?;
    let msgs = replay_derived_messages(&source, boundary, "")
        .map_err(|e| fork_err_text(&e))?;
    serde_json::to_string(&msgs).map_err(|e| e.to_string())
}

// ============ worker 隔离（对齐 dsh 的 agent 后台任务 / AbortSignal） ============
// dsh 把每个 agent 放进独立 worker（cordis 容器 + AbortSignal + 可取消的后台任务）。落地到本项目
// Tauri 架构即：`ai_chat_agent` 命令只负责把 run_agent 注册进一张全局 worker 表（tokio::spawn +
// abort handle）并立即返回；事件经 emit 推送维持既有前端契约。并发多 agent、按 request_id 查状态、
// 协作式取消（协作点检查 flag）+ 强制中断（abort 在途 await）双保险。

/// worker 运行状态（AtomicU8）取值。
const ST_RUNNING: u8 = 1;
const ST_DONE: u8 = 2;
const ST_CANCELLED: u8 = 3;

/// 一张 worker 的登记信息。
struct WorkerEntry {
    /// 中断在途 await（reqwest / 工具 execute）用。
    abort: tokio::task::AbortHandle,
    /// 协作式取消标记；用户取消时置 true，run_agent 在检查点主动退出。
    cancel: Arc<AtomicBool>,
    /// 生命周期：RUNNING →（自然结束）DONE /（取消）CANCELLED。
    state: Arc<AtomicU8>,
}

static AGENT_WORKERS: OnceLock<Mutex<HashMap<String, WorkerEntry>>> = OnceLock::new();
fn workers() -> &'static Mutex<HashMap<String, WorkerEntry>> {
    AGENT_WORKERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Agent 入口：把会话循环注册为后台 worker 后立即返回（事件驱动，对齐原契约）。
/// request_id 即会话/任务 id；若同 id 已有运行中任务，先取消旧的再起新的，防续聊叠跑。
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
    // 同步预检：无 API Key 直接拒绝（对齐原契约），无需开后台任务。
    let profiles = load_profiles(&app);
    let cfg = resolve_profile(&profiles, profile_id.clone());
    ensure_api_key(&app, &request_id, &cfg)?;

    // 同 id 已有运行中任务 → 先取消（防重复续聊叠跑）。
    cancel_worker(&request_id);

    let state = Arc::new(AtomicU8::new(ST_RUNNING));
    let cancel = Arc::new(AtomicBool::new(false));
    // 给后台闭包与 worker 注册表各备一份所有权，避免 async move 把外部变量整体移走。
    let cancel_cl = cancel.clone();
    let req_id = request_id.clone();
    let app_worker = app.clone();
    let task = tokio::spawn(async move {
        let _ = run_agent(
            app_worker,
            req_id.clone(),
            messages,
            profile_id,
            system,
            max_rounds,
            project_root,
            cancel_cl,
        )
        .await;
        // 自然结束（非取消）→ 登记 DONE 后从注册表移除；取消走 cancel_worker 的 abort 路径。
        let mut m = workers().lock().unwrap();
        if let Some(w) = m.get(&req_id) {
            let _ = w.state.compare_exchange(ST_RUNNING, ST_DONE, Ordering::SeqCst, Ordering::SeqCst);
            m.remove(&req_id);
        }
    });

    workers().lock().unwrap().insert(
        request_id.clone(),
        WorkerEntry { abort: task.abort_handle(), cancel: cancel.clone(), state },
    );
    Ok(())
}

fn cancel_worker(request_id: &str) {
    let mut m = workers().lock().unwrap();
    if let Some(w) = m.remove(request_id) {
        w.cancel.store(true, Ordering::SeqCst);
        let _ = w.state.compare_exchange(ST_RUNNING, ST_CANCELLED, Ordering::SeqCst, Ordering::SeqCst);
        let _ = w.abort.abort();
    }
}

/// 取消运行中的 agent（按 request_id）。主动置取消标记 + 强制 abort 中断在途 await。
#[tauri::command]
pub async fn ai_agent_cancel(_app: AppHandle, request_id: String) -> Result<(), String> {
    let mut m = workers().lock().unwrap();
    let Some(w) = m.remove(&request_id) else {
        return Err(format!("未找到运行中的 agent：{request_id}"));
    };
    w.cancel.store(true, Ordering::SeqCst);
    let _ = w.state.compare_exchange(ST_RUNNING, ST_CANCELLED, Ordering::SeqCst, Ordering::SeqCst);
    let _ = w.abort.abort();
    Ok(())
}

/// 查询指定 agent 的是否在运行（running=true 时附 state / 是否已请求取消）。
#[tauri::command]
pub async fn ai_agent_status(_app: AppHandle, request_id: String) -> Result<String, String> {
    let m = workers().lock().unwrap();
    match m.get(&request_id) {
        Some(w) => Ok(serde_json::json!({
            "running": w.state.load(Ordering::SeqCst) == ST_RUNNING,
            "state": w.state.load(Ordering::SeqCst),
            "cancelled": w.cancel.load(Ordering::SeqCst),
        })
        .to_string()),
        None => Ok(serde_json::json!({ "running": false }).to_string()),
    }
}

// ============ 会话历史检索（前端「执行轨迹」面板 / 审计 UI） ============

/// 列出磁盘上已持久化的 agent 会话元数据，按创建时间倒序：
/// `[{ id, createdAt, parent, eventCount, userPreview, toolCount }]`
#[tauri::command]
pub async fn ai_agent_sessions(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("ai_sessions");
    let mut out: Vec<serde_json::Value> = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok("[]".to_string()); // 目录不存在 = 尚无 agent 会话
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = p.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(text) = std::fs::read_to_string(&p) else {
            continue;
        };
        let Ok(session) = serde_json::from_str::<EventSession>(&text) else {
            continue;
        };
        let mut user_preview = String::new();
        let mut tool_count = 0usize;
        for ev in session.events() {
            match ev {
                SessionEvent::User { content, .. } if user_preview.is_empty() => {
                    user_preview = content.chars().take(80).collect();
                }
                SessionEvent::Tool { .. } => tool_count += 1,
                _ => {}
            }
        }
        out.push(serde_json::json!({
            "id": id,
            "createdAt": session.created_at(),
            "parent": session.parent(),
            "eventCount": session.event_count(),
            "userPreview": user_preview,
            "toolCount": tool_count,
        }));
    }
    out.sort_by(|a, b| {
        b["createdAt"]
            .as_str()
            .unwrap_or("")
            .cmp(a["createdAt"].as_str().unwrap_or(""))
    });
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

/// 读取单个 agent 会话的完整事件日志（append-only 原始事件，供轨迹面板 / 审计渲染）。
#[tauri::command]
pub async fn ai_agent_events(app: AppHandle, source_id: String) -> Result<String, String> {
    let session = load_agent_session(&app, &source_id)
        .ok_or_else(|| format!("会话 {source_id} 不存在（尚未持久化）"))?;
    serde_json::to_string(&session).map_err(|e| e.to_string())
}

// ============ 单元测试：worker 注册 / 取消状态机 ============
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    use std::time::Duration;

    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);
    fn uniq(prefix: &str) -> String {
        let n = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        format!("{prefix}-{n}")
    }

    fn test_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    /// 造一个永远 sleep 的后台任务，从中取出 abort handle。
    fn looping_abort(rt: &tokio::runtime::Runtime) -> tokio::task::AbortHandle {
        let _guard = rt.enter();
        let join = tokio::spawn(async {
            loop {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        });
        join.abort_handle()
    }

    #[test]
    fn cancel_worker_removes_entry_and_marks_cancelled() {
        let rt = test_runtime();
        let id = uniq("t-cancel");
        let abort = looping_abort(&rt);
        let state = Arc::new(AtomicU8::new(ST_RUNNING));
        let cancel = Arc::new(AtomicBool::new(false));
        // 模拟 ai_chat_agent 的注册。
        workers().lock().unwrap().insert(
            id.clone(),
            WorkerEntry { abort, cancel: cancel.clone(), state: state.clone() },
        );
        assert!(workers().lock().unwrap().contains_key(&id));

        // 取消：应移除注册，并把共享状态置为 CANCELLED、置取消标记。
        cancel_worker(&id);
        rt.block_on(async { tokio::time::sleep(Duration::from_millis(30)).await; }); // 让 abort 落地
        assert!(!workers().lock().unwrap().contains_key(&id), "取消后应从注册表移除");
        assert_eq!(state.load(Ordering::SeqCst), ST_CANCELLED, "共享状态应转为 CANCELLED");
        assert!(cancel.load(Ordering::SeqCst), "应置协作式取消标记");
    }

    #[test]
    fn cancel_state_only_transitions_from_running() {
        // compare_exchange 语义：已非 RUNNING 时取消不应改写为 CANCELLED。
        let rt = test_runtime();
        let id = uniq("t-cas");
        let abort = looping_abort(&rt);
        let done_state = Arc::new(AtomicU8::new(ST_DONE));
        let cancel = Arc::new(AtomicBool::new(false));
        workers().lock().unwrap().insert(
            id.clone(),
            WorkerEntry { abort, cancel: cancel.clone(), state: done_state.clone() },
        );
        cancel_worker(&id);
        assert!(!workers().lock().unwrap().contains_key(&id));
        // 虽然调用了 cancel_worker，但由于状态已是 DONE，compare_exchange 失败 → 保持 DONE。
        assert_eq!(done_state.load(Ordering::SeqCst), ST_DONE);
        // 取消标记仍会被置位（abort 无碍，仅状态机不再变动）。
        assert!(cancel.load(Ordering::SeqCst));
    }

    #[test]
    fn status_reports_running_then_idle_after_removal() {
        let rt = test_runtime();
        let id = uniq("t-status");
        let abort = looping_abort(&rt);
        let state = Arc::new(AtomicU8::new(ST_RUNNING));
        let cancel = Arc::new(AtomicBool::new(false));
        workers().lock().unwrap().insert(
            id.clone(),
            WorkerEntry { abort, cancel: cancel.clone(), state: state.clone() },
        );
        // running=true 时 status 附 state / cancelled。
        let m = workers().lock().unwrap();
        let w = m.get(&id).unwrap();
        let running = w.state.load(Ordering::SeqCst) == ST_RUNNING;
        drop(m);
        assert!(running, "注册在表内且状态 RUNNING 应视为运行中");
        // 移除后（如 run_agent 自然结束/取消）→ idle。
        cancel_worker(&id);
        assert!(!workers().lock().unwrap().contains_key(&id));
    }
}
