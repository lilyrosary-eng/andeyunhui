//! 无 UI 的 Agent 工具循环（协作 native 成员专用）。
//!
//! 复用 `agent_turn` 的协议层与 `ai_tools` 的工具/审批底座，不向前端发 `ai-*` 事件；
//! 取消由调用方 drop future（协作 runtime 的 select!）完成，这里不引入第二套取消标记。
//!
//! 审批策略固定 `AutoDeny`：协作任务没有审批条可点，需要确认的操作立即拒绝，
//! 而不是挂 120 秒等一个不会到来的确认。房间工作区会在开始前预信任，
//! 工作区内的文件读写照常放行；工作区之外的操作会被拒绝并作为工具结果回给模型。

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::services::ai_service::agent_turn::{build_agent_body, parse_agent_message};
use crate::services::ai_service::ai_profile::{
    compose_effective_system, compose_persona_system, ensure_api_key, load_config, resolve_target,
};
use crate::services::ai_service::ai_session::trim_tool_result;
use crate::services::ai_service::ai_tools::{
    execute_tool_once, registered_tools, tool_schemas_for_api, trust_project, ApprovalMode,
    MediaPayload, ToolContext,
};

/// 单次协作任务的最大工具轮数。比对话默认值略高，但仍有硬上限防止失控。
const MAX_ROUNDS: u32 = 12;

pub struct CollectRequest {
    pub prompt: String,
    pub system: Option<String>,
    /// 成员级模型 id；None = 跟随当前选中模型。
    pub profile_id: Option<String>,
    /// 房间绑定的工作目录：作为项目根，并预信任。
    pub workspace: Option<String>,
    /// 任务 id 用作 ToolContext.request_id（审批/编辑存储的键）。
    pub request_id: String,
    /// 计划作用域（房间 id），避免多个房间互相覆盖 plan。
    pub plan_scope: String,
}

/// 跑一轮完整的「模型 → 工具 → 模型」循环，返回最终文本。
pub async fn run_collect(app: AppHandle, request: CollectRequest) -> Result<String, String> {
    let config = load_config(&app);
    let cfg = resolve_target(&config, request.profile_id.as_deref());
    ensure_api_key(&app, &request.request_id, &cfg)?;
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));

    let project_root = request
        .workspace
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_dir());
    // 房间没有审批 UI：先信任工作区，让「项目内读写」直接放行。
    if let Some(root) = &project_root {
        trust_project(root);
    }

    let persona = compose_persona_system(&cfg);
    let system = compose_effective_system(&request.system, &persona);
    let mut messages: Vec<Value> = Vec::new();
    if !system.trim().is_empty() {
        messages.push(json!({ "role": "system", "content": system }));
    }
    messages.push(json!({ "role": "user", "content": request.prompt }));

    let ctx = ToolContext {
        app: app.clone(),
        request_id: request.request_id.clone(),
        project_root,
        profile_id: request.profile_id.clone(),
        media: MediaPayload::default(),
        images: Vec::new(),
        plan_scope: request.plan_scope.clone(),
        approval_mode: ApprovalMode::AutoDeny,
    };

    let client = reqwest::Client::new();
    let mut final_text = String::new();
    for _ in 0..MAX_ROUNDS {
        let tools = registered_tools();
        let (body, _thinking) = build_agent_body(&cfg, messages.clone(), tool_schemas_for_api(), None);

        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", cfg.api_key.trim()))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("请求失败: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            let brief: String = text.chars().take(300).collect();
            return Err(format!("HTTP {status}: {brief}"));
        }
        let payload: Value = resp.json().await.map_err(|e| format!("解析响应失败: {e}"))?;
        let turn = parse_agent_message(&payload)?;

        if turn.tool_calls.is_empty() {
            final_text.push_str(&turn.content);
            break;
        }

        // 模型回合：原样回填 assistant(tool_calls)，工具结果按工具协议顺序追加。
        final_text.push_str(&turn.content);
        messages.push(json!({
            "role": "assistant",
            "content": turn.content,
            "tool_calls": turn.tool_calls.clone(),
        }));

        let mut executed = 0usize;
        for call in &turn.tool_calls {
            let call_id = call.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            let name = call["function"]["name"].as_str().unwrap_or("").to_string();
            if name.is_empty() {
                continue;
            }
            // 宽松解析：部分模型会返回截断 JSON，按空参数执行让工具自己报缺参。
            let args: Value = call["function"]["arguments"]
                .as_str()
                .and_then(|raw| serde_json::from_str(raw).ok())
                .unwrap_or_else(|| json!({}));
            let tool = tools.iter().find(|item| item.name() == name).map(|item| item.as_ref());
            let (ok, result) = execute_tool_once(tool, &name, &args, &ctx).await;
            // 与对话 Agent 同口径：工具结果入上下文前先修剪，避免一次大输出把窗口撑爆。
            let content = if ok {
                trim_tool_result(&result.text)
            } else {
                format!("工具执行失败：{}", trim_tool_result(&result.text))
            };
            messages.push(json!({
                "role": "tool",
                "tool_call_id": call_id,
                "content": content,
            }));
            executed += 1;
        }
        if executed == 0 {
            break;
        }
    }

    let text = final_text.trim();
    if text.is_empty() {
        return Err(format!("Agent 在 {MAX_ROUNDS} 轮内未返回文本"));
    }
    Ok(text.to_string())
}
