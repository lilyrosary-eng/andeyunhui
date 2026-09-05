
// 全局 AI 服务 · 子模块：Agent 工具（Tool）
// （由 ai_service.rs 机械拆分而来，逻辑零改动）

use std::io::BufRead;
use std::path::PathBuf;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::mpsc;
use crate::services::ai_service::ai_profile::{load_profiles, resolve_profile, AiProfile};
use crate::services::mcp_service;
use crate::services::{git_service, lsp_service, rag_service, skill_service};
use crate::services::sandbox_service;
use tauri::{AppHandle, Emitter};

// ============ Agent 能力：工具注册表 + 原生 tool_calls 循环（阶段1） ============
// 借鉴 dsh(deepseek-harness, MIT) 的 core/tools 与 core/agent-loop 设计思路，
// 落地为本项目的 OpenAI 兼容端点实现。与 ai_chat（纯对话流式）互补：
// 不用流式检测 tool_calls（流式分段叠加易碎），改用「非流式判断 → 含 tool_calls
// 则执行并按 role:"tool" 回填重发 → 直到纯文本」。Agent 为增量能力，默认前端不调即不启用，
// ai_chat 行为完全不受影响。

/// 工具执行时的上下文（前端/本轮请求相关），随每一次调用传入 execute。
#[derive(Clone)]
pub(crate) struct ToolContext {
    /// 用于发射授权请求等事件（emit ai-agent-approval）。
    pub app: AppHandle,
    /// 本轮请求 id，事件负载中回传，便于前端按请求区分。
    pub request_id: String,
    /// AI 编程面板当前项目根目录（文件工具判“项目内”用）。
    pub project_root: Option<PathBuf>,
    /// 当前使用模型的档案 id（子代理等需要起第二个循环的工具，用它复用同一模型档案）。
    pub profile_id: Option<String>,
}

/// 工具并发执行级别（对齐 dsh executeToolCalls 的 exclusive/parallel 语义）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolConcurrency {
    /// 可并行：只读 / 纯计算，声明周期内不跨 await 共享可变状态，可与此批其他工具并发。
    Parallel,
    /// 独占串行（屏障）：有副作用或共享可变状态，执行时刻不得与其他工具并发，起批次屏障作用。
    Exclusive,
}

/// 工具执行结果：text 为给模型的纯文本视图（回填到 role:"tool" 消息）；
/// meta 为可选的结构化呈现意图（对齐 dsh presentResult → ToolResultView，如 search/terminal/read/diff 卡片）。
/// 前端在 ai-agent-step 事件里可用 meta 渲染专属卡片；能力不足时回退渲染 text。
#[derive(Debug, Clone)]
pub(crate) struct ToolExecResult {
    pub(crate) text: String,
    pub(crate) meta: Option<serde_json::Value>,
}

impl ToolExecResult {
    /// 普通纯文本结果（无结构化卡片 meta）。
    pub(crate) fn plain(text: String) -> Self {
        Self { text, meta: None }
    }
    /// 纯文本 + 结构化呈现 meta。
    pub(crate) fn with_meta(text: String, meta: serde_json::Value) -> Self {
        Self { text, meta: Some(meta) }
    }
}

/// 统一的单工具执行点：先做参数 schema 强制校验（模型可自纠的明确错误），通过后再 execute。
/// 返回 Vec<(ok, ToolExecResult)> 的单个元素，与模型工具调用顺序对齐。
/// 归在工具层：Agent 主循环与子代理循环共用同一执行闸口。
pub(crate) async fn execute_tool_once(
    tool: Option<&dyn AiTool>,
    fname: &str,
    args: &serde_json::Value,
    tc: &ToolContext,
) -> (bool, ToolExecResult) {
    match tool {
        None => (false, ToolExecResult::plain(format!("未知工具: {}", fname))),
        Some(t) => {
            // 参数强制校验（对齐 dsh 工具调用前 schema 校验）：缺参/类型错在 execute 前拦截，
            // 以 Err 文本回填给模型，模型能据此修正参数重发。
            if let Err(ve) = t.validate_args(args) {
                let msg = format!("参数校验失败 [{}]: {}", fname, ve);
                return (false, ToolExecResult::plain(msg));
            }
            // 会话前置拦截（Hook 闸口）：安全敏感操作在落地前给业务侧一次「批准/拒绝/改参」的机会。
            // 仅对可写/有副作用工具拦截，只读工具（get_current_time/calculator/grep/glob 等）放行，
            // 零 guard 注册时 O(1) 放行，不影响既有流程。
            if is_side_effect_tool(fname) {
                let verdict = {
                    let payload = serde_json::json!({
                        "tool": fname,
                        "args": args,
                        "requestId": tc.request_id,
                    });
                    crate::services::hook_service::guard(
                        crate::services::hook_service::HOOK_PRE_TOOL_USE,
                        &payload,
                    )
                };
                match verdict {
                    crate::services::hook_service::Verdict::Deny(reason) => {
                        let msg = format!("执行已拦截 [{}]: {}", fname, reason);
                        return (false, ToolExecResult::plain(msg));
                    }
                    crate::services::hook_service::Verdict::Allow(Some(over)) => {
                        // 授权回调改写参数：若改写了 args 字段则生效，无则维持原参。
                        if over.is_object() {
                            if let Some(a) = over.get("args") {
                                if a.is_object() {
                                    // 用改写后的 args 重新执行（跳过再次拦截，避免死循环）
                                    return match t.execute(a, tc).await {
                                        Ok(r) => (true, r),
                                        Err(e) => (false, ToolExecResult::plain(e)),
                                    };
                                }
                            }
                        }
                        // 允许但无有效改写：正常执行
                    }
                    crate::services::hook_service::Verdict::Allow(None) => {}
                }
            }
            match t.execute(args, tc).await {
                Ok(r) => (true, r),
                Err(e) => (false, ToolExecResult::plain(e)),
            }
        }
    }
}

/// 判断某工具是否属于「有副作用 / 可写」类，值得在其执行前做前置拦截。
/// 只读与纯计算工具直接放行，避免无谓开销。
fn is_side_effect_tool(name: &str) -> bool {
    // command/file(写/删)/mcp/git/subagent/web_fetch 均为可产生外部副作用或不可逆影响的操作；
    // gongfang 为对外网络侦察（也只读 GET，但有外部交互），同样走审批闸；
    // 其余（get_current_time/calculator/grep/glob/web_search/plan/lsp 等）为只读或局部状态，跳过拦截。
    matches!(
        name,
        "command" | "file" | "mcp" | "git" | "subagent" | "web_fetch" | "gongfang"
    )
}

/// 模型可调用的工具。
/// execute 为异步实现：文件写给项目根外需等待用户授权、命令执行需限时，故在 async 中 await。
/// 阻塞 IO（std::fs / 进程等待）内部用 spawn_blocking，避免卡住 Tokio 运行时。
/// 依据 function_schema 的 `.function.parameters` 做子集强制校验（required 缺失 + 类型 + enum + 嵌套）。
/// 在工具 execute 之前统一拦截非法参数，把具体错误回填给模型，模型能据此自纠参数。
pub(crate) fn validate_args_by_schema(schema: &serde_json::Value, value: &serde_json::Value, path: &str) -> Result<(), String> {
    // 类型
    if let Some(t) = schema.get("type").and_then(|t| t.as_str()) {
        let ok = match t {
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "boolean" => value.is_boolean(),
            "number" => value.is_number(),
            "integer" => {
                value.is_i64()
                    || value.is_u64()
                    || value.as_f64().map_or(false, |f| f.fract() == 0.0)
            }
            "null" => value.is_null(),
            _ => true, // 未知类型不过多约束
        };
        if !ok {
            return Err(format!("`{}` 期望类型 {}，实际为 {}", path, t, json_type_name(value)));
        }
    }
    // 枚举
    if let Some(en) = schema.get("enum").and_then(|e| e.as_array()) {
        if !en.contains(value) {
            return Err(format!("`{}` 取值不在允许枚举范围内", path));
        }
    }
    // 对象：required 必填 + 逐属性子级校验
    if let (Some(props), Some(obj)) = (schema.get("properties").and_then(|p| p.as_object()), value.as_object()) {
        if let Some(required) = schema.get("required").and_then(|r| r.as_array()) {
            for req in required {
                if let Some(rn) = req.as_str() {
                    if !obj.contains_key(rn) {
                        return Err(format!("`{}` 缺少必需参数 `{}`", path, rn));
                    }
                }
            }
        }
        for (k, v) in obj {
            if let Some(sub) = props.get(k) {
                validate_args_by_schema(sub, v, &format!("{}.{}", path, k))?;
            }
            // 未在 schema 声明的属性：放行（与默认 additionalProperties 一致）
        }
    }
    // 数组：逐项子级校验
    if let (Some(items), Some(arr)) = (schema.get("items"), value.as_array()) {
        for (i, it) in arr.iter().enumerate() {
            validate_args_by_schema(items, it, &format!("{}[{}]", path, i))?;
        }
    }
    Ok(())
}

/// serde_json 值的类型名（用于错误提示）。
fn json_type_name(v: &serde_json::Value) -> &'static str {
    if v.is_null() {
        "null"
    } else if v.is_boolean() {
        "boolean"
    } else if v.is_number() {
        "number"
    } else if v.is_string() {
        "string"
    } else if v.is_array() {
        "array"
    } else if v.is_object() {
        "object"
    } else {
        "unknown"
    }
}

#[async_trait::async_trait]
pub(crate) trait AiTool: Send + Sync {
    fn name(&self) -> &'static str;
    /// OpenAI functions 格式 schema，供 /chat/completions 的 tools 参数。
    fn function_schema(&self) -> serde_json::Value;
    /// 工具参数强制校验（基于 function_schema 的 parameters 子集，见 validate_args_by_schema）。
    /// 默认实现对所有工具生效；个别工具可覆盖以收紧/放宽。失败返回给模型可自纠的明确错误。
    fn validate_args(&self, args: &serde_json::Value) -> Result<(), String> {
        let params = self
            .function_schema()
            .pointer("/function/parameters")
            .cloned();
        match params {
            Some(p) => validate_args_by_schema(&p, args, self.name()),
            None => Ok(()),
        }
    }
    /// 调用前呈现（对齐 dsh presentCall → ToolCallView）：在工具执行前广播一个“将做什么”的 pending 卡。
    /// 默认按工具名与常见参数（path/url/command/pattern/query/action）生成 generic 卡；个别工具
    /// 覆盖为 terminal / diff 等专属卡。可与 ai-agent-step 的 stage:"tool" 结果事件按 cid 配对。
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let key = ["path", "url", "command", "pattern", "query", "target", "action"]
            .iter()
            .find_map(|k| args.get(*k).and_then(|v| v.as_str()))
            .unwrap_or("");
        let name = self.name();
        let (kind, title): (&str, String) = match name {
            "grep" | "glob" | "web_search" => ("search", format!("搜索 {}", key)),
            "web_fetch" => ("fetch", format!("抓取 {}", key)),
            "command" => ("execute", format!("执行 {}", key)),
            "calculator" => ("other", "计算".to_string()),
            "plan" => ("other", "制定计划".to_string()),
            "file" => {
                let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("");
                let (k, verb) = match action {
                    "read_file" => ("read", "读取".to_string()),
                    "write_file" => ("edit", "写入".to_string()),
                    "edit" => ("edit", "修改".to_string()),
                    "delete" => ("delete", "删除".to_string()),
                    _ => ("other", "处理文件".to_string()),
                };
                (k, format!("{} {}", verb, key))
            }
            _ => ("other", name.to_string()),
        };
        let mut m = serde_json::json!({ "card": "generic", "kind": kind, "title": title });
        if !key.is_empty() && matches!(kind, "read" | "edit" | "delete" | "fetch") {
            m["locations"] = serde_json::json!([{ "path": key }]);
        }
        m
    }
    /// 结果呈现钩子（对齐 dsh presentResult → ToolResultView）：把模型可见的纯文本结果二次结构化为
    /// UI 卡片；返回 None 表示前端直接回退渲染纯文本（generic）。execute 已通过
    /// ToolExecResult::with_meta 自带结构化 meta 的工具无需覆盖本方法；覆盖它适用于
    /// 「execute 只回 plain 文本、但想顺带给前端带结构化卡」的工具（如 calculator）。
    fn present_result(&self, _text: &str, _args: &serde_json::Value) -> Option<serde_json::Value> {
        None
    }
    /// 工具并发执行级别（对齐 dsh executeToolCalls 的 exclusive/parallel）。
    /// 默认 Exclusive（安全默认）：有副作用或共享可变状态的工具需独占串行。
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Exclusive
    }
    /// 执行工具；args 为模型传入的 JSON 对象，ctx 提供本轮上下文。
    /// 错误以 Err(text) 返回，仍作为 tool 结果回填给模型。
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String>;
}

/// 当前本机时间工具：模型借此把「现在几点/今天日期」这类实时问题交给工具答，避免凭空编造。
struct NowTool;
#[async_trait::async_trait]
impl AiTool for NowTool {
    fn name(&self) -> &'static str {
        "get_current_time"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "获取当前时刻（本机时区）。当用户询问『现在几点』『今天几号』『什么时候了』时调用。",
                "parameters": { "type": "object", "properties": {} }
            }
        })
    }
    async fn execute(&self, _args: &serde_json::Value, _ctx: &ToolContext) -> Result<ToolExecResult, String> {
        Ok(ToolExecResult::plain(chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()))
    }
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Parallel
    }
}

/// 安全计算器：仅支持数字与 + - * / ( ) 及一元正负号。递归下降求值，杜绝任意代码执行。
struct CalculatorTool;
#[async_trait::async_trait]
impl AiTool for CalculatorTool {
    fn name(&self) -> &'static str {
        "calculator"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "计算数学表达式。仅支持数字与 + - * / 及括号（如 (12.5+7)*3/2）。需要准确算术时调用。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "expression": { "type": "string", "description": "要计算的数学表达式" }
                    },
                    "required": ["expression"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, _ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let expr = args
            .get("expression")
            .and_then(|v| v.as_str())
            .ok_or("缺少 expression 参数")?;
        let mut p = SafeEval { s: expr, pos: 0 };
        let val = p.parse_expr()?;
        p.skip_ws();
        if p.pos < p.s.len() {
            return Err(format!("表达式存在多余字符: '{}'", &p.s[p.pos..]));
        }
        Ok(ToolExecResult::plain(format!("= {}", val)))
    }
    /// 结果呈现：execute 只回 plain 文本，这里二次结构化为 generic 卡（标题内联防代达式、detail 放结果），
    /// 示范 present_result 独立钩子（对齐 dsh presentResult）：让进度渲染与模型回填文本解耦。
    fn present_result(&self, text: &str, args: &serde_json::Value) -> Option<serde_json::Value> {
        if text.is_empty() {
            return None;
        }
        let expr = args.get("expression").and_then(|v| v.as_str()).unwrap_or("计算");
        Some(serde_json::json!({
            "card": "generic",
            "kind": "other",
            "title": format!("计算 {}", expr),
            "detail": text,
        }))
    }
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Parallel
    }
}

// ========== Plan / Todo 工具（B 增强：让 Agent 有「可见、可更新」的任务清单） ==========
//
// 目标：模型在展开长任务时，先用 create_plan 确立计划，再按步骤 add_todo，
// 每完成一步 mark_done，让前端（IDE · AI 编程）实时渲染出一块「计划/待办」面板。
// 计划状态保存在本进程静态存储中（单份当前计划），供同进程内数次请求延续；
// 工具结果回传「完整计划渲染」，使模型每一轮都能看到（并据此更新）任务全貌。
//
// 关键：execute 为同步函数，内部用 Mutex 瞬时加锁读写——无跨 await、无死锁风险。

/// 单条待办。
#[derive(Clone, serde::Serialize)]
struct PlanTodo {
    id: String,
    content: String,
    done: bool,
}

/// 当前计划。
#[derive(Clone, serde::Serialize)]
pub(crate) struct Plan {
    title: String,
    next_id: u64,
    todos: Vec<PlanTodo>,
}

/// 全局计划存储：单份「当前计划」，跨请求延续，供 plan 工具读写。
static PLAN_STORE: OnceLock<Mutex<Plan>> = OnceLock::new();
pub(crate) fn plan_store() -> &'static Mutex<Plan> {
    PLAN_STORE.get_or_init(|| Mutex::new(Plan { title: String::new(), next_id: 1, todos: vec![] }))
}

/// 把当前计划渲染为模型可见的文本（含 id，便于调用方按 id 勾选/删除）。
fn render_plan(p: &Plan) -> String {
    if p.todos.is_empty() {
        return if p.title.is_empty() {
            "（当前尚未创建计划）".to_string()
        } else {
            format!("📋 计划「{}」\n（还没有任何待办）", p.title)
        };
    }
    let mut s = format!("📋 计划「{}」", p.title);
    for t in &p.todos {
        let mark = if t.done { "[x]" } else { "[ ]" };
        s.push_str(&format!("\n- {} #{} {}", mark, t.id, t.content));
    }
    s
}

/// Plan / Todo 工具：维护一份「计划 + 待办清单」并实时回传完整状态。
/// 通过 action 参数区分操作；返回完整计划渲染（模型据此继续决策）。
struct PlanTool;
#[async_trait::async_trait]
impl AiTool for PlanTool {
    fn name(&self) -> &'static str {
        "plan"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "管理一份『计划 + 待办清单』。action 取值：create_plan(title) 新建计划；add_todo(content) 追加待办；mark_done(id) 勾选完成；mark_undone(id) 取消勾选；delete_todo(id) 删除待办；list 查看当前计划。每次返回完整计划，便于你据此继续规划。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": { "type": "string", "description": "create_plan / add_todo / mark_done / mark_undone / delete_todo / list" },
                        "title": { "type": "string", "description": "create_plan 时的新计划标题" },
                        "content": { "type": "string", "description": "add_todo 时的待办内容" },
                        "id": { "type": "string", "description": "mark_done / mark_undone / delete_todo 时的待办 id" }
                    },
                    "required": ["action"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, _ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("").trim();
        let mut g = plan_store()
            .lock()
            .map_err(|_| "计划存储锁获取失败".to_string())?;
        match action {
            "create_plan" => {
                g.title = args
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未命名计划")
                    .to_string();
                g.next_id = 1;
                g.todos.clear();
            }
            "add_todo" => {
                let content = args
                    .get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if content.trim().is_empty() {
                    return Err("add_todo 缺少 content 参数".to_string());
                }
                let id = g.next_id.to_string();
                g.next_id += 1;
                g.todos.push(PlanTodo { id, content, done: false });
            }
            "mark_done" | "mark_undone" => {
                let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let done = action == "mark_done";
                let mut hit = false;
                for t in g.todos.iter_mut() {
                    if t.id == id {
                        t.done = done;
                        hit = true;
                        break;
                    }
                }
                if !hit {
                    return Err(format!("找不到待办 #{}", id));
                }
            }
            "delete_todo" => {
                let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let before = g.todos.len();
                g.todos.retain(|t| t.id != id);
                if g.todos.len() == before {
                    return Err(format!("找不到待办 #{}", id));
                }
            }
            "list" => {}
            _ => return Err(format!("未知 action: '{}'（可选 create_plan/add_todo/mark_done/mark_undone/delete_todo/list）", action)),
        }
        Ok(ToolExecResult::plain(render_plan(&g)))
    }
}

// ========== 文件读写 / 命令执行 工具（C 增强：让 Agent 能落到真实文件系统与 shell） ==========
//
// 安全边界（按用户授权意图）：
// - read_file：任意路径读取（只读、非破坏），无审批。
// - write_file：目标在项目根目录内 → 直接写；在项目根外 → 交互式审批（ai-agent-approval 事件
//   → 前端弹窗 → 回调 ai_agent_approve），超时未决则视为拒绝。
// - run_command：任意命令，限时 15s、非 shell 中文案，走项目根或 cwd 参数。
// 阻塞 IO 一律 spawn_blocking，符合本仓库「阻塞操作不得占用 Tokio 运行时」约定。

/// 待用户审批的挂起操作。
pub(crate) struct PendingApproval {
    _tool: String,
    _operation: String,
    pub(crate) sender: tokio::sync::oneshot::Sender<bool>,
}

/// 全局审批注册表：approval_id → 挂起操作。ai_agent_approve 从这张表取回发送端并 resolve。
static APPROVAL_STORE: OnceLock<Mutex<std::collections::HashMap<String, PendingApproval>>> = OnceLock::new();
pub(crate) fn approval_store() -> &'static Mutex<std::collections::HashMap<String, PendingApproval>> {
    APPROVAL_STORE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// 发起一次审批：注册挂起操作 → 发射 ai-agent-approval → 等待用户决定（默认 120s 超时拒绝）。
async fn request_approval(ctx: &ToolContext, tool: &str, operation: &str) -> Result<bool, String> {
    let approval_id = format!("ap_{}_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis()).unwrap_or(0), rand_short());
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    approval_store()
        .lock()
        .map_err(|_| "审批存储锁获取失败".to_string())?
        .insert(
            approval_id.clone(),
            PendingApproval { _tool: tool.to_string(), _operation: operation.to_string(), sender: tx },
        );
    let _ = ctx.app.emit(
        "ai-agent-approval",
        serde_json::json!({
            "requestId": ctx.request_id,
            "approvalId": approval_id,
            "tool": tool,
            "operation": operation,
        }),
    );
    match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
        Ok(Ok(true)) => Ok(true),
        Ok(Ok(false)) => Err("用户拒绝了该文件操作".to_string()),
        Ok(Err(_)) => Err("授权通道已关闭".to_string()),
        Err(_) => {
            let _ = approval_store().lock().map(|mut m| m.remove(&approval_id));
            Err("授权请求超时（120s 未确认，已拒绝）".to_string())
        }
    }
}

/// 简短随机串（事件/审批 id 后缀，避免多请求冲突）。
fn rand_short() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    format!("{:08x}", t)
}

/// 判断 target 是否落在 root 之下（对已存在路径 canonicalize；未存在的写目标取其最近存在祖先）：
/// 用于「写文件项目根内直接放行 / 项目根外需审批」的判定。
fn is_under_path(target: &std::path::Path, root: &std::path::Path) -> bool {
    let r = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let norm = target
        .canonicalize()
        .unwrap_or_else(|_| {
            target
                .parent()
                .and_then(|p| p.canonicalize().ok().map(|c| c.join(target.file_name().unwrap_or_default())))
                .unwrap_or_else(|| target.to_path_buf())
        });
    norm.starts_with(&r)
}

/// 会话级「信任项目」集合：首次在某个项目根内执行写操作时弹窗确认，
/// 通过后本会话内该项目内写文件免单次审批。
static TRUSTED_PROJECTS: OnceLock<Mutex<std::collections::HashSet<std::path::PathBuf>>> = OnceLock::new();
fn trusted_projects() -> &'static Mutex<std::collections::HashSet<std::path::PathBuf>> {
    TRUSTED_PROJECTS.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

/// 首次访问未信任项目 → 弹「信任此项目」确认；通过后记录本会话信任。已信任则直接返回。
async fn ensure_project_trusted(ctx: &ToolContext) -> Result<(), String> {
    let Some(root) = &ctx.project_root else { return Ok(()); };
    let canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    if trusted_projects().lock().map_err(|_| "信任存储锁失败".to_string())?.contains(&canon) {
        return Ok(());
    }
    let ok = request_approval(
        ctx,
        "trust",
        &format!("首次在此项目内写文件，是否信任该目录（本会话内经此确认后，项目内写文件免单次确认）？\n{}", root.display()),
    ).await?;
    if !ok {
        return Err("用户未信任该项目，已拒绝写入".to_string());
    }
    trusted_projects().lock().map_err(|_| "信任存储锁失败".to_string())?.insert(canon);
    Ok(())
}

/// 一次待审阅的暂存编辑。write/edit/delete 先落到该结构（不立即写盘），
/// read_file 会叠加这些暂存生成 overlay 视图（模型能读到改后内容），
/// agent-loop 结束后 emit ai-agent-edits 交由前端审阅，用户确认后才真正写盘。
#[derive(Clone)]
pub(crate) struct PendingEdit {
    pub(crate) id: String,
    pub(crate) action: String, // write / edit / delete
    pub(crate) path: String,
    // write: 新全文；edit: 用于精确定位替换信息（old/new）；delete 无
    pub(crate) new_content: Option<String>,
    pub(crate) old_string: Option<String>,
    pub(crate) new_string: Option<String>,
    // diff 载体（对齐 dsh FileDiff：oldText/newText，供前端渲染改动前后差异，不影响落盘）
    //   write: old_text=None(新文件/覆盖写无 before-image)，new_text=新全文
    //   edit:  行级上下文 old_text / 替换后的 new_text（与 ai_agent_apply_edits 落盘替换语义一致）
    //   delete: old_text=磁盘原文(截断)，new_text=None
    pub(crate) old_text: Option<String>,
    pub(crate) new_text: Option<String>,
    pub(crate) order: usize,
}

/// 请求级编辑暂存：request_id → 该请求产出的待审阅编辑（按到达顺序）。
static EDIT_STORE: OnceLock<Mutex<std::collections::HashMap<String, Vec<PendingEdit>>>> = OnceLock::new();
pub(crate) fn edit_store() -> &'static Mutex<std::collections::HashMap<String, Vec<PendingEdit>>> {
    EDIT_STORE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// 记录一次暂存编辑；order 为追加序号，read overlay 与最终落盘都按此顺序重放。
fn record_edit(request_id: &str, mut e: PendingEdit) {
    let mut store = edit_store().lock().unwrap_or_else(|_| {
        // 锁中毒兜底：清空重建，极罕见
        *EDIT_STORE.get_or_init(|| Mutex::new(std::collections::HashMap::new())).lock().expect("edit store lock") = Default::default();
        edit_store().lock().expect("edit store relock")
    });
    let list = store.entry(request_id.to_string()).or_default();
    e.order = list.len();
    list.push(e);
}

/// 把当前磁盘内容叠加该请求所有暂存编辑，重放生成「改后视图」。
/// 返回 (overlay_text, deleted)。若该路径被 <delete> 暂存，deleted=true 且 overlay 为空。
fn apply_pending_overlay(request_id: &str, path: &std::path::Path, base: String) -> Result<(String, bool), String> {
    let store = edit_store().lock().map_err(|_| "编辑存储锁获取失败".to_string())?;
    let Some(list) = store.get(request_id) else {
        return Ok((base, false));
    };
    // 只取作用于同一文件的编辑，按 order 顺序重放
    let mut text = base.clone();
    let mut deleted = false;
    let mut applied = 0usize;
    for e in list {
        if e.path != path.to_string_lossy().as_ref() { continue; }
        match e.action.as_str() {
            "delete" => { deleted = true; text = String::new(); applied += 1; }
            "write" => {
                text = e.new_content.clone().unwrap_or_default();
                deleted = false;
                applied += 1;
            }
            "edit" => {
                let old = e.old_string.clone().unwrap_or_default();
                let new = e.new_string.clone().unwrap_or_default();
                if !old.is_empty() && text.contains(&old) {
                    let all = text.matches(&old).count() > 1;
                    if all {
                        text = text.replace(&old, &new);
                    } else {
                        // 替换首个匹配
                        if let Some(idx) = text.find(&old) {
                            let mut s = String::with_capacity(text.len() + new.len().saturating_sub(old.len()));
                            s.push_str(&text[..idx]);
                            s.push_str(&new);
                            s.push_str(&text[idx + old.len()..]);
                            text = s;
                        }
                    }
                    applied += 1;
                }
            }
            _ => {}
        }
    }
    if deleted {
        Ok((String::new(), true))
    } else if applied > 0 {
        // 追加提示「叠加了 N 条未确认改动」，帮助模型理解这是改后视图
        Ok((format!("{}（已叠加 {} 条待审阅改动，尚未写入磁盘）", text, applied), false))
    } else {
        Ok((text, false))
    }
}

/// 计算一次 edit 的行级 diff 载体（对齐 dsh FileDiff）：定位 old 在 view 中的所在行块，
/// 返回 (found, 旧行, 新行)。行块取 old 前一换行后到其后一换行前；跨行则覆盖首行头→末行尾。
/// 新行替换语义与落盘（ai_agent_apply_edits）一致：多次出现全替换，否则仅首个。
fn extract_edit_diff(view: &str, old: &str, new: &str) -> (bool, String, String) {
    match view.find(old) {
        None => (false, String::new(), String::new()),
        Some(idx) => {
            let ls = view[..idx].rfind('\n').map(|i| i + 1).unwrap_or(0);
            let after = idx + old.len();
            let le = view[after..].find('\n').map(|i| after + i).unwrap_or(view.len());
            let old_line = view[ls..le].to_string();
            let new_line = if old_line.matches(old).count() > 1 {
                old_line.replace(old, new)
            } else {
                old_line.replacen(old, new, 1)
            };
            (true, old_line, new_line)
        }
    }
}

/// 从文件扩展名推导语法高亮语言提示（对齐 dsh ReadResultView.lang；未知扩展返回 None）。
fn guess_lang(p: &std::path::Path) -> Option<&'static str> {
    let ext = p.extension().and_then(|e| e.to_str()).map(|s| s.to_ascii_lowercase());
    match ext.as_deref() {
        Some("rs") => Some("rust"),
        Some("ts") | Some("tsx") | Some("mts") | Some("cts") => Some("typescript"),
        Some("js") | Some("jsx") | Some("mjs") | Some("cjs") => Some("javascript"),
        Some("py") | Some("pyi") => Some("python"),
        Some("go") => Some("go"),
        Some("java") | Some("kt") | Some("kts") => Some("java"),
        Some("rb") => Some("ruby"),
        Some("php") => Some("php"),
        Some("c") | Some("h") => Some("c"),
        Some("cpp") | Some("cc") | Some("cxx") | Some("hpp") => Some("cpp"),
        Some("cs") => Some("csharp"),
        Some("swift") => Some("swift"),
        Some("sql") => Some("sql"),
        Some("html") | Some("htm") | Some("vue") => Some("html"),
        Some("css") | Some("scss") | Some("less") => Some("css"),
        Some("json") | Some("jsonc") => Some("json"),
        Some("md") | Some("markdown") => Some("markdown"),
        Some("yml") | Some("yaml") => Some("yaml"),
        Some("toml") => Some("toml"),
        Some("sh") | Some("bash") | Some("zsh") => Some("bash"),
        Some("bat") | Some("cmd") => Some("bat"),
        Some("ps1") => Some("powershell"),
        Some("xml") | Some("svg") => Some("xml"),
        Some("dockerfile") | Some("docker") => Some("dockerfile"),
        Some("ini") | Some("cfg") => Some("ini"),
        Some("lua") => Some("lua"),
        Some("r") => Some("r"),
        _ => None,
    }
}

/// 文件工具：read_file（只读，叠加暂存视图）/ write_file（暂存）/ edit（暂存）/ delete（暂存）。
/// 所有写操作先进请求级暂存，经 ai-agent-edits 审阅后才真正落盘；项目根外写入仍先交互审批。
struct FileTool;
#[async_trait::async_trait]
impl AiTool for FileTool {
    fn name(&self) -> &'static str {
        "file"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "读写/编辑/删除文件。action：read_file(path, offset?, limit?) 读取文件内容（任意路径，只读；offset 为起始字符偏移、limit 为字符数，用于大文件分段读取）；write_file(path, content) 整写文件；edit(path, old_string, new_string, occurrences?) 精准补丁——在原文中定位并替换（不重写整个文件；occurrences 省略替换首个、填 all 替换全部，旧文本须可唯一定位）；delete(path) 删除文件。写/删操作不会立即落盘：会先进入待审阅状态，由用户逐条确认后才真正写入磁盘；期间你用 read_file 读到的是叠加了你所有未确认改动后的视图。项目根外的写/删会额外触发交互授权。路径请传绝对路径。改代码优先用 edit，避免整写覆盖遗漏。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": { "type": "string", "description": "read_file / write_file / edit / delete" },
                        "path": { "type": "string", "description": "绝对路径" },
                        "content": { "type": "string", "description": "write_file 时写入的完整内容" },
                        "offset": { "type": "integer", "description": "read_file 时的起始字符偏移（从 0 开始，默认 0）" },
                        "limit": { "type": "integer", "description": "read_file 时的最大字符数（默认 60000）" },
                        "old_string": { "type": "string", "description": "edit 时要在原文中查找的旧文本（须唯一或由 occurrences 指定）" },
                        "new_string": { "type": "string", "description": "edit 时替换成的新文本" },
                        "occurrences": { "type": "string", "description": "edit 时替换数量：省略=首个，all=全部（默认首个）" }
                    },
                    "required": ["action", "path"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        use tokio::task::spawn_blocking;
        let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("").trim();
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("").trim();
        if path.is_empty() { return Err("file 工具缺少 path 参数".to_string()); }
        let p = std::path::PathBuf::from(path);
        match action {
            "read_file" => {
                // 偏移读取：offset/limit 按字符计，便于大文件分段（dsh 对齐）
                let offset: usize = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                let limit: usize = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(60_000) as usize;
                let overlay_req = ctx.request_id.clone();
                let (content, view) = spawn_blocking(move || -> Result<(String, serde_json::Value), String> {
                    let data = std::fs::read(&p).map_err(|e| format!("读取失败 {}: {}", p.display(), e))?;
                    let full = String::from_utf8_lossy(&data).to_string();
                    // 叠加该请求先前的未确认改动，生成「改后视图」（未删除时）
                    let (overlaid, deleted) = apply_pending_overlay(&overlay_req, &p, full).map_err(|e| format!("叠加视图失败: {}", e))?;
                    if deleted {
                        return Ok((format!("（文件 {} 已被本请求暂存删除，尚未提交）", p.display()),
                            serde_json::json!({ "card": "read", "path": p.display().to_string(), "offset": 0, "lines": [], "totalLines": 0 })));
                    }
                    let chars = overlaid.chars().collect::<Vec<_>>();
                    // 偏移取自叠加后内容的开头
                    let total = chars.len();
                    let start = offset.min(total);
                    let end = (start + limit).min(total);
                    let window: String = chars[start..end].iter().collect();
                    let head = if offset > 0 {
                        format!("（已从字符 #{} 开始显示，共 {} 字符）\n", start, total)
                    } else if total > limit {
                        format!("（文件较大，显示前 {} 字符,共 {} 字符；可用 offset 继续读取）\n", limit, total)
                    } else {
                        String::new()
                    };
                    // 行号化视图（对齐 dsh ReadResultView）：行号保留文件真实行号，lang 由扩展名推导
                    let full_lines: Vec<&str> = overlaid.split('\n').collect();
                    let total_lines = full_lines.len();
                    let mut starts: Vec<usize> = Vec::with_capacity(full_lines.len());
                    let mut acc_char = 0usize;
                    for l in &full_lines {
                        starts.push(acc_char);
                        acc_char += l.chars().count() + 1; // +1 换行符
                    }
                    let mut first_line = 1usize;
                    for (i, l) in full_lines.iter().enumerate() {
                        if start < starts[i] + l.chars().count() + 1 {
                            first_line = i + 1;
                            break;
                        }
                    }
                    let mut lines: Vec<serde_json::Value> = Vec::new();
                    for (i, l) in full_lines.iter().enumerate().skip(first_line - 1) {
                        if starts[i] >= end {
                            break;
                        }
                        let row_end = starts[i] + l.chars().count();
                        let s = start.max(starts[i]) - starts[i];
                        let e = end.min(row_end).saturating_sub(starts[i]);
                        let text: String = l.chars().skip(s).take(e.saturating_sub(s)).collect();
                        lines.push(serde_json::json!({ "number": i + 1, "text": text }));
                    }
                    let view = serde_json::json!({
                        "card": "read",
                        "path": p.display().to_string(),
                        "offset": first_line,
                        "lines": lines,
                        "totalLines": total_lines,
                        "lang": guess_lang(&p),
                    });
                    Ok((format!("{}{}", head, window), view))
                }).await.map_err(|e| format!("读取任务调度失败: {}", e))??;
                Ok(ToolExecResult::with_meta(content, view))
            }
            "write_file" => {
                let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if sandbox_service::is_protected_path(&p) {
                    return Err(format!("拒绝写入受保护路径（密钥/凭据/VCS/依赖目录）: {}", p.display()));
                }
                let under = ctx.project_root.as_ref().map(|r| is_under_path(&p, r)).unwrap_or(false);
                if under {
                    ensure_project_trusted(ctx).await?;
                } else {
                    request_approval(ctx, "file", &format!("写入外部路径: {}", p.display())).await?;
                }
                let edit_id = format!("e_{}_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis()).unwrap_or(0), rand_short());
                record_edit(&ctx.request_id, PendingEdit {
                    id: edit_id,
                    action: "write".to_string(),
                    path: p.to_string_lossy().to_string(),
                    new_content: Some(content.clone()),
                    old_string: None,
                    new_string: None,
                    // diff：覆盖写/新文件无 before-image → oldText=null（对齐 dsh）
                    old_text: None,
                    new_text: Some(content.clone()),
                    order: 0,
                });
                Ok(ToolExecResult::plain(format!("已暂存写入 {}（内容 {} 字符，等用户审阅确认后落盘；可用 read_file 查看改后视图）", p.display(), content.chars().count())))
            }
            "edit" => {
                let old_string = args.get("old_string").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let new_string = args.get("new_string").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if old_string.is_empty() {
                    return Err("edit 缺少 old_string 参数".to_string());
                }
                if sandbox_service::is_protected_path(&p) {
                    return Err(format!("拒绝编辑受保护路径（密钥/凭据/VCS/依赖目录）: {}", p.display()));
                }
                // 写语义与 write_file 一致：项目根内直写、根外审批；首次需信任项目
                let under = ctx.project_root.as_ref().map(|r| is_under_path(&p, r)).unwrap_or(false);
                if under {
                    ensure_project_trusted(ctx).await?;
                } else {
                    request_approval(ctx, "file", &format!("编辑外部路径: {}", p.display())).await?;
                }
                // 暂存前先本地校验 old_string 在「当前叠加视图」中可定位（避免审阅时才发现替换失败）
                let overlay_req = ctx.request_id.clone();
                let p_for_ov = p.clone();
                let wants = old_string.clone();
                let replacement = new_string.clone();
                // 返回 (是否可定位, 叠加视图, 所在行块 diff oldText, 替换后 diff newText)。
                // diff 用行级上下文（含该 edit 的整行），便于前端行级 diff；替换语义与落盘一致。
                let preview_ok = spawn_blocking(move || -> Result<(bool, String, String), String> {
                    let text = if let Ok(data) = std::fs::read(&p_for_ov) {
                        String::from_utf8_lossy(&data).to_string()
                    } else {
                        String::new()
                    };
                    let (overlaid, _deleted) = apply_pending_overlay(&overlay_req, &p_for_ov, text)?;
                    Ok(extract_edit_diff(&overlaid, &wants, &replacement))
                }).await.map_err(|e| format!("校验任务调度失败: {}", e))??;
                if !preview_ok.0 {
                    return Err(format!("old_string 在当前视图不存在，无法定位：{}", old_string));
                }
                let edit_id = format!("e_{}_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis()).unwrap_or(0), rand_short());
                record_edit(&ctx.request_id, PendingEdit {
                    id: edit_id,
                    action: "edit".to_string(),
                    path: p.to_string_lossy().to_string(),
                    new_content: None,
                    old_string: Some(old_string),
                    new_string: Some(new_string),
                    // diff：行级 old→new（old_text 为完整行、new_text 为替换后行，供前端 diff 渲染）
                    old_text: Some(preview_ok.1),
                    new_text: Some(preview_ok.2),
                    order: 0,
                });
                Ok(ToolExecResult::plain(format!("已暂存编辑 {}（等用户审阅确认后落盘）", p.display())))
            }
            "delete" => {
                let under = ctx.project_root.as_ref().map(|r| is_under_path(&p, r)).unwrap_or(false);
                if sandbox_service::is_protected_path(&p) {
                    return Err(format!("拒绝删除受保护路径（密钥/凭据/VCS/依赖目录）: {}", p.display()));
                }
                if under {
                    ensure_project_trusted(ctx).await?;
                } else {
                    request_approval(ctx, "file", &format!("删除外部路径: {}", p.display())).await?;
                }
                let edit_id = format!("e_{}_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis()).unwrap_or(0), rand_short());
                // diff 载体：读磁盘原文（spawn_blocking，超长截断）作 oldText；newText=None，便于前端确认删的是什么。
                let p_for_del = p.clone();
                let old_content = spawn_blocking(move || {
                    std::fs::read_to_string(&p_for_del).unwrap_or_default()
                }).await.map_err(|e| format!("删除读取任务调度失败: {}", e))?;
                let old_text: Option<String> = {
                    let chars: Vec<char> = old_content.chars().collect();
                    if chars.is_empty() {
                        None
                    } else if chars.len() > 4000 {
                        let head: String = chars[..4000].iter().collect();
                        Some(format!("{}…（其余 {} 字符略）", head, chars.len() - 4000))
                    } else {
                        Some(old_content)
                    }
                };
                record_edit(&ctx.request_id, PendingEdit {
                    id: edit_id,
                    action: "delete".to_string(),
                    path: p.to_string_lossy().to_string(),
                    new_content: None,
                    old_string: None,
                    new_string: None,
                    old_text,
                    new_text: None,
                    order: 0,
                });
                Ok(ToolExecResult::plain(format!("已暂存删除 {}（等用户审阅确认后落盘）", p.display())))
            }
            _ => Err(format!("未知 action: '{}'（可选 read_file/write_file/edit/delete）", action)),
        }
    }
    /// 调用前呈现（对齐 dsh presentCall → DiffCallView / GenericCallView）：
    /// write_file/edit → diff 卡（write 覆盖式 newText=content；edit 读一下盘生成 old/new 片段），
    /// 其余 → generic 卡带 locations。
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("");
        let generic = || {
            let (kind, verb) = match action {
                "read_file" => ("read", "读取".to_string()),
                "write_file" => ("edit", "写入".to_string()),
                "edit" => ("edit", "修改".to_string()),
                "delete" => ("delete", "删除".to_string()),
                _ => ("other", "处理文件".to_string()),
            };
            let mut m = serde_json::json!({ "card": "generic", "kind": kind, "title": format!("{} {}", verb, path) });
            if !path.is_empty() {
                m["locations"] = serde_json::json!([{ "path": path }]);
            }
            m
        };
        match action {
            "write_file" => {
                // 覆盖式写入：oldText 用 null（与 dsh 一致），newText 用请求内容（截断展示）
                let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
                let capped: String = content.chars().take(1200).collect();
                serde_json::json!({
                    "card": "diff",
                    "path": path,
                    "oldText": serde_json::Value::Null,
                    "newText": capped,
                    "truncated": content.chars().count() > 1200,
                })
            }
            "edit" => {
                let old = args.get("old").and_then(|v| v.as_str()).unwrap_or("");
                let new = args.get("new").and_then(|v| v.as_str()).unwrap_or("");
                // 读一下当前盘上文件生成“改前/改后”片段（call-time 轻量；读失败回 generic 卡）
                let diff = std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|view| {
                        let (found, old_line, new_line) = extract_edit_diff(&view, old, new);
                        found.then(|| serde_json::json!({
                            "card": "diff",
                            "path": path,
                            "oldText": old_line,
                            "newText": new_line,
                        }))
                    });
                diff.unwrap_or_else(generic)
            }
            _ => generic(),
        }
    }
}

/// 命令工具：运行 shell 命令，限时 15s、非交互，返回 stdout/stderr（截断）。
struct CommandTool;
#[async_trait::async_trait]
impl AiTool for CommandTool {
    fn name(&self) -> &'static str {
        "run_command"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "执行 shell 命令并返回输出。非交互。参数：command(必填，要执行的命令)；cwd(可选，工作目录，默认项目根)；timeout(可选，超时秒数，默认15，上限120)。用于运行 git/npm/pnpm/node/脚本等。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "要执行的 shell 命令" },
                        "cwd": { "type": "string", "description": "工作目录（默认项目根目录）" },
                        "timeout": { "type": "integer", "description": "超时秒数（默认15，上限120）" }
                    },
                    "required": ["command"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let command = args.get("command").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if command.is_empty() { return Err("run_command 缺少 command 参数".to_string()); }
        if sandbox_service::command_is_dangerous(&command) {
            return Err("该命令命中危险操作黑名单（格式化/磁盘/关机/不可逆删除等），已拒绝执行".to_string());
        }
        // timeout：可选超时秒数，默认 15，封顶 120，最小 1
        let timeout_secs: u64 = args.get("timeout")
            .and_then(|v| v.as_u64())
            .map(|t| t.clamp(1, 120))
            .unwrap_or(15);
        let cwd: Option<std::path::PathBuf> = args.get("cwd")
            .and_then(|v| v.as_str())
            .map(|s| s.trim()).filter(|s| !s.is_empty())
            .map(std::path::PathBuf::from)
            .or_else(|| ctx.project_root.clone());

        // 复用受限 shell 的统一执行器（run_captured）：Windows 走 cmd /C，含 Job Object 防 conhost 悬挂、
        // 按流上限截断、看门狗超时强制终止。策略上仍走本工具的「宽松黑名单兜底」命令，不套受限 shell 的弱白名单。
        let r = crate::services::shell_service::run_captured_async(
            &command,
            cwd.clone(),
            timeout_secs,
            8000,
            Vec::new(),
        )
        .await;
        if r.blocked {
            return Err(r.message);
        }
        if !r.ok {
            return Err(r.message);
        }
        if r.timed_out {
            return Err(format!("命令执行超时（>{}s，已中止）", timeout_secs));
        }
        let mut text = String::new();
        if !r.stdout.is_empty() {
            text.push_str(&r.stdout);
        }
        if !r.stderr.is_empty() {
            if !text.is_empty() { text.push('\n'); }
            text.push_str(&r.stderr);
        }
        const OCAP: usize = 8000;
        let text = if text.chars().count() > OCAP {
            format!("{}（输出过长，已截断）", text.chars().take(OCAP).collect::<String>())
        } else { text };
        // 命令「跑完」即为工具结果（对齐 dsh：退出码是结果的一部分，非工具错误）。
        // 模型从 detail 文本判别成功与否，前端可用 meta.exitCode 渲染退出态 pill。
        let exit_code = r.exit_code;
        let success = exit_code == Some(0);
        let detail = if success {
            if text.trim().is_empty() { "（命令成功，无输出）".to_string() } else { text.clone() }
        } else {
            format!("命令退出码 {}：{}", exit_code.unwrap_or(-1), text.clone())
        };
        // terminal 呈现 meta（对齐 dsh TerminalResultView）：output + exitCode + cwd，供前端渲染终端卡片
        let meta = serde_json::json!({
            "card": "terminal",
            "output": text,
            "exitCode": exit_code,
            "cwd": cwd.as_deref().map(|c| c.to_string_lossy().to_string()),
        });
        Ok(ToolExecResult::with_meta(detail, meta))
    }
    /// 调用前呈现：命令本身就是一辆终端卡（对齐 dsh TerminalCallView），附 cwd/timeout 详情。
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let command = args.get("command").and_then(|v| v.as_str()).unwrap_or("");
        let mut m = serde_json::json!({ "card": "terminal", "title": command });
        if !command.is_empty() {
            m["command"] = serde_json::Value::String(command.to_string());
        }
        if let Some(cwd) = args.get("cwd").and_then(|v| v.as_str()) {
            m["cwd"] = serde_json::Value::String(cwd.to_string());
        }
        if let Some(t) = args.get("timeout") {
            m["timeout"] = t.clone();
        }
        m
    }
}

/// 极简安全表达式求值器（递归下降）。
struct SafeEval<'a> {
    s: &'a str,
    pos: usize,
}

impl<'a> SafeEval<'a> {
    fn peek(&self) -> Option<char> {
        self.s.get(self.pos..)?.chars().next()
    }
    fn skip_ws(&mut self) {
        while let Some(c) = self.peek() {
            if c.is_ascii_whitespace() {
                self.pos += c.len_utf8();
            } else {
                break;
            }
        }
    }
    fn parse_expr(&mut self) -> Result<f64, String> {
        self.parse_add()
    }
    fn parse_add(&mut self) -> Result<f64, String> {
        let mut v = self.parse_mul()?;
        loop {
            self.skip_ws();
            match self.peek() {
                Some('+') => {
                    self.pos += 1;
                    v += self.parse_mul()?;
                }
                Some('-') => {
                    self.pos += 1;
                    v -= self.parse_mul()?;
                }
                _ => return Ok(v),
            }
        }
    }
    fn parse_mul(&mut self) -> Result<f64, String> {
        let mut v = self.parse_atom()?;
        loop {
            self.skip_ws();
            match self.peek() {
                Some('*') => {
                    self.pos += 1;
                    v *= self.parse_atom()?;
                }
                Some('/') => {
                    self.pos += 1;
                    let d = self.parse_atom()?;
                    if d == 0.0 {
                        return Err("除数为 0".into());
                    }
                    v /= d;
                }
                _ => return Ok(v),
            }
        }
    }
    fn parse_atom(&mut self) -> Result<f64, String> {
        self.skip_ws();
        match self.peek() {
            Some('(') => {
                self.pos += 1;
                let v = self.parse_expr()?;
                self.skip_ws();
                if self.peek() != Some(')') {
                    return Err("缺少右括号".into());
                }
                self.pos += 1;
                Ok(v)
            }
            Some('+') | Some('-') => {
                let sign = if self.peek() == Some('-') { -1.0 } else { 1.0 };
                self.pos += 1;
                Ok(sign * self.parse_atom()?)
            }
            _ => self.parse_number(),
        }
    }
    fn parse_number(&mut self) -> Result<f64, String> {
        self.skip_ws();
        let start = self.pos;
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() || c == '.' {
                self.pos += c.len_utf8();
            } else {
                break;
            }
        }
        let tok = &self.s[start..self.pos];
        if tok.is_empty() {
            return Err("表达式为空".into());
        }
        tok.parse::<f64>()
            .map_err(|_| format!("数字无效: '{}'", tok))
    }
}

// ========== 代码智能 + 扩展 工具（合并 IDE Agent 长处，参照 dsh tool-fs-search 设计） ==========
//
// 保留 Rust function-call 底座，把 IDE Agent 里最有价值的搜索/扩展能力并入：
// - grep：内容搜索，gitignore 感知，pattern/path/include 参数、按文件分组输出、匹配上限兜底（对齐 dsh）
// - glob：文件名搜索，gitignore 感知，pattern/path 参数、按修改时间排序、路径上限兜底（对齐 dsh）
// - mcp：复用本项目 mcp_service，把已配置的 MCP 工具暴露给 Agent（对齐 IDE 的 server+tool+args 范式）
// 三者只读/非破坏，无需交互审批；阻塞 IO 一律 spawn_blocking。

/// 单次 grep 最多保留的行匹配数（对齐 Claude Code GrepTool 默认 head_limit / dsh GREP_MAX_MATCHES）。
const GREP_MAX_MATCHES: usize = 250;
/// 单条匹配行的最大字符数（超出截断，UTF-8 安全）。
const GREP_MAX_LINE_CHARS: usize = 2000;
/// 单次 glob 最多返回路径数（对齐 dsh GLOB_MAX_RESULTS）。
const GLOB_MAX_RESULTS: usize = 100;
/// glob 遍历时顶层的 VCS 元数据目录（对齐 dsh GLOB_VCS_EXCLUDES）。
const GLOB_VCS_EXCLUDES: &[&str] = &[".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];

/// 判断路径是否命中单一 glob：完整路径或仅文件名命中其一即可（align dsh「无分隔符 pattern 匹配任意深度 basename」）。
fn glob_matches(matcher: &globset::GlobMatcher, path: &std::path::Path) -> bool {
    if matcher.is_match(path.to_string_lossy().as_ref()) {
        return true;
    }
    match path.file_name() {
        Some(n) => matcher.is_match(n.to_string_lossy().as_ref()),
        None => false,
    }
}

/// grep：在项目内用正则搜索文件内容，返回匹配行及行号（按文件分组输出）。
struct GrepTool;
#[async_trait::async_trait]
impl AiTool for GrepTool {
    fn name(&self) -> &'static str {
        "grep"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "在项目内用正则表达式搜索文件内容，返回匹配行及行号、按文件分组。gitignore 感知（自动跳过 node_modules/.git 等）。定位关键词/代码时应使用本工具，而非 run_command 'grep'。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "要搜索的正则表达式（regex 语法，如 'fn .*_tool'）" },
                        "path": { "type": "string", "description": "搜索的目标目录或文件，默认当前项目根；相对路径基于项目根解析" },
                        "include": { "type": "string", "description": "仅搜索匹配该单一 glob 的文件（如 '*.ts'、'*.{js,ts}'），不支持逗号列表或取反" }
                    },
                    "required": ["pattern"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if pattern.is_empty() {
            return Err("grep 缺少 pattern 参数".to_string());
        }
        // 提前校验正则合法性
        regex::Regex::new(&pattern).map_err(|e| format!("正则无效: {}", e))?;
        let root = args
            .get("path").and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .or_else(|| ctx.project_root.clone())
            .ok_or_else(|| "grep 缺少 path，且未提供项目根目录".to_string())?;
        let include = args
            .get("include").and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let matcher = match &include {
            Some(g) => Some(
                globset::GlobBuilder::new(g).literal_separator(false).build()
                    .map_err(|e| format!("include glob 无效: {}", e))?.compile_matcher(),
            ),
            None => None,
        };

        // gitignore 感知遍历 + 逐行正则匹配，全部阻塞 IO → spawn_blocking
        let (matches, truncated) = tokio::task::spawn_blocking(move || -> Result<(Vec<(String, usize, String)>, bool), String> {
            let re = regex::Regex::new(&pattern).map_err(|e| format!("正则无效: {}", e))?;
            let mut out: Vec<(String, usize, String)> = Vec::new();
            let mut truncated = false;
            let mut walk = ignore::WalkBuilder::new(&root);
            walk.standard_filters(true);
            for entry in walk.build().flatten() {
                if out.len() >= GREP_MAX_MATCHES {
                    truncated = true;
                    break;
                }
                if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    continue;
                }
                let fp = entry.path();
                if let Some(m) = &matcher {
                    if !glob_matches(m, fp) {
                        continue;
                    }
                }
                let Ok(file) = std::fs::File::open(fp) else { continue; };
                let mut reader = std::io::BufReader::new(file);
                let mut line_no = 0usize;
                let mut first_read = true;
                let mut tmp: Vec<u8> = Vec::with_capacity(512);
                loop {
                    if out.len() >= GREP_MAX_MATCHES {
                        truncated = true;
                        break;
                    }
                    tmp.clear();
                    let n = reader
                        .read_until(b'\n', &mut tmp)
                        .map_err(|e| format!("读取 {} 失败: {}", fp.display(), e))?;
                    if n == 0 {
                        break;
                    }
                    if first_read {
                        // 二进制探针：首块含 NUL 视为二进制，跳过整文件
                        if tmp.contains(&0) {
                            break;
                        }
                        first_read = false;
                    }
                    line_no += 1;
                    if tmp.last() == Some(&b'\n') {
                        tmp.pop();
                    }
                    if tmp.last() == Some(&b'\r') {
                        tmp.pop();
                    }
                    let line = String::from_utf8_lossy(&tmp);
                    if re.is_match(&line) {
                        let capped: String = line.chars().take(GREP_MAX_LINE_CHARS).collect();
                        out.push((fp.to_string_lossy().to_string(), line_no, capped));
                    }
                }
            }
            if out.len() >= GREP_MAX_MATCHES {
                truncated = true;
            }
            Ok((out, truncated))
        })
        .await
        .map_err(|e| format!("grep 任务调度失败: {}", e))??;

        let count = matches.len();
        if count == 0 {
            return Ok(ToolExecResult::plain("No matches found".to_string()));
        }
        // 按文件分组（对齐 dsh SearchFileMatches：path + 有序匹配行），文本与结构化 meta 复用同一份分组
        let mut files: Vec<(String, Vec<(usize, String)>)> = Vec::new();
        for (p, ln, line) in &matches {
            match files.iter_mut().find(|(k, _)| k == p) {
                Some((_, rows)) => rows.push((*ln, line.clone())),
                None => files.push((p.clone(), vec![(*ln, line.clone())])),
            }
        }
        // 纯文本视图（回填 role:"tool" 消息用，保持既有格式）
        let mut s = format!("Found {} matches", count);
        if truncated {
            s.push_str(&format!("（已达单次上限 {} 条，结果已截断；请用更精确的 pattern/path/include）", GREP_MAX_MATCHES));
        }
        for (p, rows) in &files {
            s.push('\n');
            s.push_str(p);
            s.push('\n');
            s.push_str(&rows.iter().map(|(ln, txt)| format!("Line {}: {}", ln, txt)).collect::<Vec<_>>().join("\n"));
        }
        // search 呈现 meta（对齐 dsh SearchResultView 'matches' 变体：按文件分组的可展开卡片）
        let meta_files: Vec<serde_json::Value> = files.into_iter().map(|(p, rows)| {
            serde_json::json!({
                "path": p,
                "matches": rows.into_iter().map(|(ln, txt)| serde_json::json!({ "line": ln, "text": txt })).collect::<Vec<_>>(),
            })
        }).collect();
        let meta = serde_json::json!({
            "card": "search",
            "shape": "matches",
            "files": meta_files,
            "truncated": truncated,
            "total": count,
        });
        Ok(ToolExecResult::with_meta(s, meta))
    }
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Parallel
    }
}

/// glob：在项目内按文件名模式搜索文件路径（gitignore 感知、跳过 VCS 目录），按修改时间由新到旧排序。
struct GlobTool;
#[async_trait::async_trait]
impl AiTool for GlobTool {
    fn name(&self) -> &'static str {
        "glob"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "按文件名 glob 模式搜索项目内文件路径（如 '**/*.ts'、'src/**/*.test.*'），返回文件路径列表，按修改时间由新到旧。gitignore 感知并跳过 VCS 目录。模式不含 '/' 时按任意深度 basename 匹配。定位文件用本工具而非 shell find/ls。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "匹配文件路径的 glob 模式（如 '**/*.ts'、'*.tsx'、'src/**/*.go'）" },
                        "path": { "type": "string", "description": "搜索的起始目录，默认当前项目根；相对路径基于项目根解析" }
                    },
                    "required": ["pattern"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if pattern.is_empty() {
            return Err("glob 缺少 pattern 参数".to_string());
        }
        let matcher = globset::GlobBuilder::new(&pattern).literal_separator(false).build()
            .map_err(|e| format!("glob 模式无效: {}", e))?.compile_matcher();
        let root = args
            .get("path").and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .or_else(|| ctx.project_root.clone())
            .ok_or_else(|| "glob 缺少 path，且未提供项目根目录".to_string())?;

        // 遍历收集命中文件及其修改时间，最后按 mtime 由新到旧排序、取前 N
        let hit: Vec<(PathBuf, std::time::SystemTime)> = tokio::task::spawn_blocking(move || -> Result<Vec<(PathBuf, std::time::SystemTime)>, String> {
            let mut found: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
            let mut walk = ignore::WalkBuilder::new(&root);
            walk.standard_filters(true);
            walk.filter_entry(|e| {
                if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    let n = e.file_name().to_string_lossy();
                    return !GLOB_VCS_EXCLUDES.contains(&n.as_ref());
                }
                true
            });
            for entry in walk.build().flatten() {
                if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    continue;
                }
                let fp = entry.path();
                if !glob_matches(&matcher, fp) {
                    continue;
                }
                let mtime = std::fs::metadata(fp).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                found.push((fp.to_path_buf(), mtime));
            }
            found.sort_by(|a, b| b.1.cmp(&a.1));
            Ok(found)
        })
        .await
        .map_err(|e| format!("glob 任务调度失败: {}", e))??;

        if hit.is_empty() {
            return Ok(ToolExecResult::plain("No files found".to_string()));
        }
        let total = hit.len();
        let truncated = total > GLOB_MAX_RESULTS;
        let paths: Vec<String> = hit.into_iter().take(GLOB_MAX_RESULTS).map(|(p, _)| p.to_string_lossy().to_string()).collect();
        let mut s = paths.join("\n");
        if truncated {
            s.push('\n');
            s.push_str(&format!("（Showing {} of {} paths；请缩小 pattern 或指定 path 查看更多）", GLOB_MAX_RESULTS, total));
        }
        // search 呈现 meta（对齐 dsh SearchResultView 'paths' 变体：扁平路径列表卡片）
        let meta = serde_json::json!({
            "card": "search",
            "shape": "paths",
            "paths": paths,
            "truncated": truncated,
            "total": total,
        });
        Ok(ToolExecResult::with_meta(s, meta))
    }
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Parallel
    }
}

/// mcp：调用已配置的 MCP 服务器工具。复用 mcp_service::mcp_call_tool（spawn → call → kill）。
/// 服务器 id 见 agent 系统提示注入的 MCP 工具清单；arguments 为该工具输入 schema 对应的 JSON 对象。
struct McpTool;
#[async_trait::async_trait]
impl AiTool for McpTool {
    fn name(&self) -> &'static str {
        "mcp"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "调用已配置的 MCP（Model Context Protocol）服务器工具。server 填服务器 id，tool 填该服务器上的工具原始名，arguments 填工具输入结构对应的 JSON 对象（可省略则传空）。可调用的服务器与工具清单会在本会话系统提示中列出。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "server": { "type": "string", "description": "MCP 服务器 id（系统提示中列出的 id）" },
                        "tool": { "type": "string", "description": "该服务器上的工具原始名" },
                        "arguments": { "type": "object", "description": "工具输入参数 JSON 对象（可选，默认空）" }
                    },
                    "required": ["server", "tool"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let server = args.get("server").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let tool_name = args.get("tool").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if server.is_empty() {
            return Err("mcp 缺少 server 参数".to_string());
        }
        if tool_name.is_empty() {
            return Err("mcp 缺少 tool 参数".to_string());
        }
        let arguments = args.get("arguments").cloned().filter(|v| v.is_object()).unwrap_or(serde_json::json!({}));
        // 挂起/异常服务器不应无限阻塞 Agent：整体限时 30s
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            mcp_service::mcp_call_tool(ctx.app.clone(), server.clone(), tool_name.clone(), arguments),
        )
        .await
        .map_err(|_| format!("MCP 调用超时（>30s，已中止）: {}:{}", server, tool_name))?
        .map_err(|e| format!("MCP 调用失败: {}", e))?;
        if !result.ok {
            let detail = result.error.clone().unwrap_or_else(|| "无错误信息".to_string());
            return Err(format!("MCP 工具 {}:{} 返回错误: {}", server, tool_name, detail));
        }
        // 渲染 content 块：text 拼接、image/audio/resource 占位（对齐 dsh extractText）
        let mut parts: Vec<String> = Vec::new();
        for block in &result.content {
            let t = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match t {
                "text" => {
                    if let Some(txt) = block.get("text").and_then(|v| v.as_str()) {
                        parts.push(txt.to_string());
                    }
                }
                "image" => parts.push(format!("[image: {}, 内容已丢弃]", block.get("mimeType").and_then(|v| v.as_str()).unwrap_or("unknown"))),
                "audio" => parts.push(format!("[audio: {}, 内容已丢弃]", block.get("mimeType").and_then(|v| v.as_str()).unwrap_or("unknown"))),
                "resource" | "resource_link" => parts.push("[resource: 内容已丢弃]".to_string()),
                _ => {}
            }
        }
        if parts.is_empty() {
            let msg = format!("（MCP 工具 {}:{} 返回空内容）", server, tool_name);
            let meta = serde_json::json!({ "card": "generic", "kind": "other", "title": format!("MCP {}:{}", server, tool_name), "detail": msg });
            return Ok(ToolExecResult::with_meta(msg, meta));
        }
        let text = parts.join("\n");
        let meta = serde_json::json!({ "card": "generic", "kind": "other", "title": format!("MCP {}:{}", server, tool_name), "detail": text });
        Ok(ToolExecResult::with_meta(text, meta))
    }
    /// 调用前呈现：MCP 调用无专属卡（对齐 dsh GenericCallView），但补全可识别的 server:tool 标题与 kind。
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let server = args.get("server").and_then(|v| v.as_str()).unwrap_or("");
        let tool_name = args.get("tool").and_then(|v| v.as_str()).unwrap_or("");
        serde_json::json!({
            "card": "generic",
            "kind": "other",
            "title": format!("调用 MCP {}:{}", server, tool_name),
        })
    }
}

/// skill：按名称加载项目技能全文（progressive disclosure）。
/// 技能索引起初只注入名称 + 一句话说明；模型依据触发关键词判断需用到某技能时，
/// 用本工具加载其完整 markdown 说明，获取可执行的具体步骤/规则后再执行。加载后可结合
/// 既有 file/command 等工具落地。此工具为只读，不产生外部副作用。
struct SkillTool;
#[async_trait::async_trait]
impl AiTool for SkillTool {
    fn name(&self) -> &'static str {
        "skill"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "加载项目技能详情。name 填系统提示中「项目可用技能」列出的技能名；返回该技能的完整说明（含操作步骤/规则/参数约定），加载后再按其执行。需要处理某项专属任务（前端/后端/数据/测试等，见技能关键词）时先调用本工具。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "技能名（系统提示「项目可用技能」中列出的 name；也支持 list 查看全部）" }
                    },
                    "required": ["name"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        // list 别名：无最技能目录时报全量索引，方便模型探测可用技能。
        if name.eq_ignore_ascii_case("list") {
            let dir = skill_service::list_skills(ctx.project_root.as_deref());
            if dir.skills.is_empty() {
                return Ok(ToolExecResult::plain("（项目内未配置任何技能，可忽略 skill 工具）".to_string()));
            }
            let list: Vec<String> = dir
                .skills
                .iter()
                .map(|s| {
                    let kws = if s.keywords.is_empty() { String::new() } else { format!(" [{}]", s.keywords.join("/")) };
                    format!("- {}：{}{}", s.name, s.description, kws)
                })
                .collect();
            return Ok(ToolExecResult::plain(format!("项目可用技能（结构见 .agent/skills）：\n{}", list.join("\n"))));
        }
        if name.is_empty() {
            return Err("skill 缺少 name 参数".to_string());
        }
        let content = skill_service::load_skill(ctx.project_root.as_deref(), &name)?;
        Ok(ToolExecResult::plain(format!("技能「{}」说明（来源 {}）：\n{}", content.name, content.source, content.content)))
    }
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Parallel
    }
}

/// 极简 form-url-encoded 百分号编码：保留字母数字与 `-_.~`，其余字节转 `%XX`，空格转 `+`。
/// 仅用于 web_search 的 query 编码（query 通常较短，不值得为它引入 percent-encoding 依赖）。
fn url_escape_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// 块级标签（闭合后补换行），用于粗提纯 HTML 正文。
fn is_block_tag(name: &str) -> bool {
    matches!(name,
        "p" | "div" | "li" | "ul" | "ol" | "br" | "tr" | "section" | "article"
        | "nav" | "header" | "footer" | "main" | "aside" | "blockquote" | "pre"
        | "table" | "form" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "hr")
}

/// 轻量 HTML→纯文本（单遍状态机）：丢弃 script/style/head 等容器，剥标签、块级补换行、
/// 解码常见实体、压缩空白。用于 web_fetch 的正文提取（够用且不引入解析依赖）。
fn html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let bytes = html.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'<' {
            let closing = i + 1 < bytes.len() && bytes[i + 1] == b'/';
            let name_start = if closing { i + 2 } else { i + 1 };
            let mut j = name_start;
            while j < bytes.len() && !matches!(bytes[j], b'>' | b' ' | b'\t' | b'\n' | b'\r' | b'/') {
                j += 1;
            }
            let name = html[name_start.min(html.len())..j.min(html.len())].to_ascii_lowercase();
            // 容器级标签（含子内容）整体跳过
            if !closing
                && matches!(name.as_str(), "script" | "style" | "head" | "noscript" | "svg" | "template")
            {
                let close_tag = format!("</{}>", name);
                match html[i + 1..].find(close_tag.as_str()) {
                    Some(rel) => {
                        i += 1 + rel + close_tag.len();
                        continue;
                    }
                    None => break,
                }
            }
            // 闭合块级标签 → 补换行
            if closing && is_block_tag(&name) && !out.ends_with('\n') && !out.is_empty() {
                out.push('\n');
            }
            // 跳过整个标签
            let mut k = i + 1;
            while k < bytes.len() && bytes[k] != b'>' {
                k += 1;
            }
            i = if k < bytes.len() { k + 1 } else { bytes.len() };
        } else if b == b'&' {
            // 实体解码
            if let Some(rel) = html[i + 1..].find(';') {
                let ent = &html[i + 1..i + 1 + rel];
                // 用字符串保存解码结果，避免借用 leak
                let owned: Option<String> = match ent.to_ascii_lowercase().as_str() {
                    "amp" => Some("&".into()),
                    "lt" => Some("<".into()),
                    "gt" => Some(">".into()),
                    "quot" => Some("\"".into()),
                    "apos" => Some("'".into()),
                    "nbsp" => Some(" ".into()),
                    _ => ent
                        .strip_prefix("#x")
                        .or_else(|| ent.strip_prefix("0x"))
                        .and_then(|h| u32::from_str_radix(h, 16).ok().and_then(char::from_u32))
                        .map(|c| c.to_string())
                        .or_else(|| {
                            ent.strip_prefix('#')
                                .and_then(|d| d.parse::<u32>().ok().and_then(char::from_u32))
                                .map(|c| c.to_string())
                        }),
                };
                match owned {
                    Some(v) => out.push_str(&v),
                    None => out.push('&'),
                }
                i += 1 + rel + 1; // ';' 位置之后
            } else {
                out.push(b as char);
                i += 1;
            }
        } else {
            // 普通文本：ASCII 直接 push；多字节 UTF-8 按完整字符推进（避免把中文拆成 mojibake）
            if b & 0b1000_0000 != 0 {
                match html[i..].chars().next() {
                    Some(c) => {
                        out.push(c);
                        i += c.len_utf8();
                    }
                    None => break,
                }
            } else {
                out.push(b as char);
                i += 1;
            }
        }
    }
    // 压缩空白：行内连续空白缩为一个空格，逐行 trim，去空行
    out.split('\n')
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// web_search：通过 DuckDuckGo Instant Answer API 检索网页（免 key、无配置），返回结构化来源。
/// 来源对齐 dsh WebSearchResultView：sources（url/title/snippet）+ truncated + 可选 answer。
/// 结果做纯文本 + 结构化 meta 双视图；网络请求整体限时 15s 防挂起。
struct WebSearchTool;
#[async_trait::async_trait]
impl AiTool for WebSearchTool {
    fn name(&self) -> &'static str {
        "web_search"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "联网搜索网页，返回相关来源列表（标题/摘要/URL）。查询会实时检索（DuckDuckGo Instant Answer），无法联网时返回空结果。用于获取外部实时信息、文档、最新动态。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "要搜索的查询词，应具体（如 'Tauri v2 listen event 官方文档'）" },
                        "max_results": { "type": "integer", "description": "返回结果数上限（默认5，范围1-10）" }
                    },
                    "required": ["query"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, _ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if query.is_empty() {
            return Err("web_search 缺少 query 参数".to_string());
        }
        let max_results: usize = args.get("max_results").and_then(|v| v.as_u64()).map(|n| (n as usize).clamp(1, 10)).unwrap_or(5);
        let url = format!(
            "https://api.duckduckgo.com/?q={}&format=json&no_html=1&skip_disambig=1",
            url_escape_component(&query)
        );
        // 限时 15s；沙箱/断网环境静默降级为空结果，不让 Agent 卡死
        let resp = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            reqwest::Client::new().get(&url).header("User-Agent", "Mozilla/5.0").send(),
        )
        .await
        .map_err(|_| "web_search 超时（>15s，已中止）".to_string())?
        .map_err(|e| format!("web_search 请求失败: {}", e))?;
        if !resp.status().is_success() {
            return Ok(ToolExecResult::plain(format!("web_search 返回状态 {}", resp.status().as_u16())));
        }
        let json: serde_json::Value = resp.json().await.map_err(|e| format!("web_search 响应解析失败: {}", e))?;

        // 结构化来源：递归把 RelatedTopics 拍成叶节点 {FirstURL, Text}
        let mut leaves: Vec<(String, String)> = Vec::new();
        if let Some(topics) = json.get("RelatedTopics").and_then(|v| v.as_array()) {
            fn walk(v: &serde_json::Value, out: &mut Vec<(String, String)>) {
                if let Some(url) = v.get("FirstURL").and_then(|u| u.as_str()) {
                    let text = v.get("Text").and_then(|t| t.as_str()).unwrap_or("").to_string();
                    if !url.is_empty() {
                        out.push((url.to_string(), text));
                    }
                } else if let Some(sub) = v.get("Topics").and_then(|t| t.as_array()) {
                    for s in sub {
                        walk(s, out);
                    }
                }
            }
            for t in topics {
                walk(t, &mut leaves);
            }
        }
        let answer = json.get("AbstractText").and_then(|a| a.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());

        let total = leaves.len();
        let truncated = total > max_results;
        let sliced: Vec<(String, String)> = leaves.into_iter().take(max_results).collect();
        if sliced.is_empty() {
            return Ok(ToolExecResult::plain(format!("web_search 无结果（query: {}）", query)));
        }
        // 纯文本视图（回填 role:"tool" 消息用）
        let mut lines: Vec<String> = Vec::new();
        if let Some(a) = &answer {
            lines.push(format!("摘要：{}", a));
        }
        for (i, (url, text)) in sliced.iter().enumerate() {
            // Text 通常形如「Title - description」，拆出标题与摘要
            let (title, snippet) = match text.split_once(" - ") {
                Some((t, s)) => (t.trim().to_string(), Some(s.trim().to_string())),
                None => (text.clone(), None),
            };
            let mut entry = format!("{}. {}", i + 1, title);
            if let Some(s) = &snippet {
                entry.push_str(&format!(" — {}", s));
            }
            entry.push_str(&format!("\n   {}", url));
            lines.push(entry);
        }
        let mut s = format!("Web results for \"{}\"", query);
        if truncated {
            s.push_str(&format!("（{} 条中显示前 {} 条）", total, max_results));
        }
        s.push('\n');
        s.push_str(&lines.join("\n"));
        // web_search 呈现 meta（对齐 dsh WebSearchResultView 'search' 变体：可引用的来源列表卡片）
        let sources: Vec<serde_json::Value> = sliced.into_iter().map(|(url, text)| {
            let (title, snippet) = match text.split_once(" - ") {
                Some((t, sn)) => (t.trim().to_string(), Some(sn.trim().to_string())),
                None => (text, None),
            };
            let mut src = serde_json::json!({ "url": url, "title": title });
            if let Some(sn) = snippet {
                src["snippet"] = serde_json::Value::String(sn);
            }
            src
        }).collect();
        let meta = serde_json::json!({
            "card": "web",
            "kind": "search",
            "sources": sources,
            "answer": answer,
            "truncated": truncated,
        });
        Ok(ToolExecResult::with_meta(s, meta))
    }
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Parallel
    }
}

/// web_fetch：抓取指定 URL 的正文（HTML→纯文本），返回可读 markdown/文本 + 检索摘要。
/// 结果对齐 dsh WebFetchResultView：url（重定向后最终地址）+ statusCode + truncated。
/// 正文即模型可见的纯文本（在 ai-agent-step 的 detail）；卡片仅带抓取摘要。限时 20s、跟随重定向。
struct WebFetchTool;
#[async_trait::async_trait]
impl AiTool for WebFetchTool {
    fn name(&self) -> &'static str {
        "web_fetch"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "抓取指定网页 URL，返回转成纯文本的正文内容（含抓取状态）。用于 web_search 找到来源后深入读取页面具体细节。仅支持 http/https。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": { "type": "string", "description": "要抓取的完整网址（http/https）" },
                        "max_chars": { "type": "integer", "description": "正文最大字符数（默认8000，范围100-20000）" }
                    },
                    "required": ["url"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, _ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if url.is_empty() {
            return Err("web_fetch 缺少 url 参数".to_string());
        }
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err("web_fetch 仅支持 http/https 网址".to_string());
        }
        let max_chars: usize = args.get("max_chars").and_then(|v| v.as_u64()).map(|n| (n as usize).clamp(100, 20_000)).unwrap_or(8000);
        // 限时 20s、跟随最多 5 次重定向；断网/超时视为结果（带状态），不抛工具错误
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .map_err(|e| format!("web_fetch 客户端构建失败: {}", e))?;
        let resp = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            client.get(&url).header("User-Agent", "Mozilla/5.0").send(),
        )
        .await
        .map_err(|_| "web_fetch 超时（>20s，已中止）".to_string())?
        .map_err(|e| format!("web_fetch 请求失败: {}", e))?;
        let status_code = resp.status().as_u16();
        let final_url = resp.url().to_string();
        let body = resp.text().await.map_err(|e| format!("web_fetch 读取正文失败: {}", e))?;

        let mut text = body.trim().to_string();
        // 若已是文本性内容（非 HTML 特征）则原样使用，否则走 HTML→纯文本
        if text.trim_start().starts_with('<') {
            text = html_to_text(&text);
        }
        let truncated = text.chars().count() > max_chars;
        let capped: String = text.chars().take(max_chars).collect();
        let meta = serde_json::json!({
            "card": "web",
            "kind": "fetch",
            "url": final_url,
            "statusCode": status_code,
            "truncated": truncated,
        });
        if !(200..300).contains(&status_code) {
            return Ok(ToolExecResult::with_meta(
                format!("web_fetch 返回状态 {}（{}）", status_code, final_url),
                meta,
            ));
        }
        let message = if capped.trim().is_empty() {
            "（页面无可见文本）".to_string()
        } else {
            capped
        };
        Ok(ToolExecResult::with_meta(message, meta))
    }
}

/// ================= 后台可继续子代理 worker 引擎（对齐 dsh subagent continuable 模型） =================
/// 每个子代理注册为一个长驻后台 worker：
///   - 消息队列(inbox)：父 agent 用 send_message 注入指令，worker 在每轮前 drain 并作为 user 消息续投；
///   - 中断标记 + abort handle：interrupt_agent 协作取消（flag）+ 强制中断在途 await；
///   - settle 通道：worker 产出最终结论时写入全局 settle 队列，父主循环在 turn 边界取走并注入上下文；
///   - 注册表：spawn / send / interrupt / list 四个控制点统一在此维护。
/// 前台（foreground）调用复用同一模型轮次引擎但非 continuable：单次最多 max_rounds 轮、遇结论即返回文本。

/// 子代理 worker 生命周期（AtomicU8）。
const SUBA_ST_RUNNING: u8 = 1;   // 运行中
const SUBA_ST_SETTLED: u8 = 2;   // 已产出结论，闲置等待 send_message 复活
const SUBA_ST_DONE: u8 = 3;      // 已终结（interrupt 清理 / 主动退出）
const SUBA_ST_ERROR: u8 = 4;     // 出错

/// 子代理 settle 记录：worker 产出结论后写入全局队列，供父会话取回并注入上下文。
#[derive(Debug, Clone)]
pub(crate) struct SubSettle {
    pub child_id: String,
    pub parent_request_id: String,
    pub role: String,
    pub conclusion: String,
    pub error: Option<String>,
}

/// 一张子代理 worker 的登记信息。
struct SubWorker {
    /// 中断在途 await（reqwest / 工具 execute）用。
    abort: tokio::task::AbortHandle,
    /// 协作式取消标记；interrupt_agent 置 true，worker 在检查点/闲置等待中主动退出。
    cancel: Arc<AtomicBool>,
    /// 生命周期状态（SUBA_ST_*）。
    state: Arc<AtomicU8>,
    /// 发往该子代理的指令队列（send_message 投递）。
    inbox: mpsc::Sender<String>,
    /// 已产出结论（settle 后的结果槽），供 list_agents 聚合展示。
    result: Arc<Mutex<Option<SubSettle>>>,
    role: String,
    task: String,
    parent_request_id: String,
}

static SUBAGENTS: OnceLock<Mutex<HashMap<String, SubWorker>>> = OnceLock::new();
fn subagents() -> &'static Mutex<HashMap<String, SubWorker>> {
    SUBAGENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

static SUB_SETTLES: OnceLock<Mutex<VecDeque<SubSettle>>> = OnceLock::new();
fn sub_settles() -> &'static Mutex<VecDeque<SubSettle>> {
    SUB_SETTLES.get_or_init(|| Mutex::new(VecDeque::new()))
}

/// worker 产出结论 → 写入全局 settle 队列（供父循环 turn 边界取走注入）。
pub(crate) fn notify_subagent_settle(s: SubSettle) {
    sub_settles().lock().unwrap().push_back(s);
}

/// 取走指定父会话的所有 settle 记录（其余父会话的记录保留在原队）。
pub(crate) fn take_subagent_settles(parent_request_id: &str) -> Vec<SubSettle> {
    let mut q = sub_settles().lock().unwrap();
    let mut out = Vec::new();
    let mut kept = VecDeque::new();
    for s in q.drain(..) {
        if s.parent_request_id == parent_request_id {
            out.push(s);
        } else {
            kept.push_back(s);
        }
    }
    *q = kept;
    out
}

/// 并行子会话唯一 id 计数器：多个子代理并发时各自持有独立 child_id/request_id，避免互抢审批/事件标识。
static SUB_SEQ: AtomicU64 = AtomicU64::new(1);

/// 子代理单轮结果：结论文本 / 已执行工具待续跑 / 空回合。
enum SubRound {
    /// 模型直接产出的纯文本（可能为空，调用方决定是否作为结论）。
    Confirmed(String),
    /// 本轮有 tool_calls，已执行并回填进 messages，需继续下一轮。
    ToolCalls,
}

/// 子代理模型轮次：非流式请求（带只读工具），若含 tool_calls 则执行并把结果回填进 messages。
/// 供前台（单轮）与后台（长驻）两条路径复用，维护同一执行语义。
async fn subagent_model_round(
    client: &reqwest::Client,
    url: &str,
    cfg: &AiProfile,
    messages: &mut Vec<serde_json::Value>,
    tools: &[serde_json::Value],
    sub_ctx: &ToolContext,
) -> Result<SubRound, String> {
    if cfg.api_key.trim().is_empty() {
        return Err("子代理：未配置 API Key".to_string());
    }
    let mut body = serde_json::json!({
        "model": cfg.model,
        "messages": messages,
        "stream": false,
        "tools": tools,
        "tool_choice": "auto",
    });
    if let Some(mt) = cfg.max_tokens {
        body["max_tokens"] = serde_json::json!(mt);
    }
    let resp = client
        .post(url)
        .header("Authorization", format!("Bearer {}", cfg.api_key.trim()))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("子代理请求失败: {}", e))?;
    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("子代理响应解析失败: {}", e))?;
    let msg = &data["choices"][0]["message"];
    let calls = msg.get("tool_calls").and_then(|c| c.as_array()).cloned().unwrap_or_default();
    if calls.is_empty() {
        let text = msg.get("content").and_then(|c| c.as_str()).unwrap_or("").trim().to_string();
        return Ok(SubRound::Confirmed(text));
    }
    // 记录本轮 assistant（带原生 tool_calls 形状），再逐条执行工具并回填。
    let mut am = serde_json::json!({ "role": "assistant", "content": serde_json::Value::Null });
    am["tool_calls"] = msg.get("tool_calls").cloned().unwrap_or(serde_json::json!([]));
    messages.push(am);
    let reg = registered_tools();
    for call in &calls {
        let fname = call.get("function").and_then(|f| f.get("name")).and_then(|n| n.as_str()).unwrap_or("");
        let fargs = call.get("function").and_then(|f| f.get("arguments")).and_then(|a| a.as_str())
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(serde_json::json!({}));
        let tool = reg.iter().find(|t| t.name() == fname).map(|b| b.as_ref() as &dyn AiTool);
        let (_ok, res) = execute_tool_once(tool, fname, &fargs, sub_ctx).await;
        messages.push(serde_json::json!({
            "role": "tool",
            "tool_call_id": call.get("id").cloned().unwrap_or(serde_json::Value::Null),
            "content": res.text,
        }));
    }
    Ok(SubRound::ToolCalls)
}

/// 闲置等待一个子代理的复活：阻塞直到收到 inbox 指令或中断；收到指令返回 Some，被中断返回 None。
async fn idle_wait_for_input(inbox: &mut mpsc::Receiver<String>, cancel: &Arc<AtomicBool>) -> Option<String> {
    loop {
        if cancel.load(Ordering::SeqCst) {
            return None;
        }
        let got = tokio::select! {
            m = inbox.recv() => m,
            _ = tokio::time::sleep(Duration::from_millis(150)) => None,
        };
        if let Some(m) = got {
            return Some(m);
        }
        // 超时：继续循环以复查中断标记（轻量轮询，避免忙等待独占）。
    }
}

/// 前台子代理执行循环：单次最多 6 轮，遇非空结论即返回。
/// 仅调只读工具（file/grep/glob），不触发审批；复用 execute_tool_once 同一执行闸口。
async fn run_subagent_once(
    app: &AppHandle,
    request_id: &str,
    cfg: &AiProfile,
    role: &str,
    task: &str,
    project_root: Option<PathBuf>,
) -> Result<String, String> {
    if cfg.api_key.trim().is_empty() {
        return Err("子代理：未配置 API Key".to_string());
    }
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let reg = registered_tools();
    let tools: Vec<serde_json::Value> = reg
        .iter()
        .filter(|t| matches!(t.name(), "file" | "grep" | "glob"))
        .map(|t| t.function_schema())
        .collect();
    let root_hint = project_root.as_ref().map(|p| p.display().to_string()).unwrap_or_default();
    let system = format!(
        "你是「{}」。只专注完成以下委派任务并直接给出最终结论（不得再向外界委派子任务）：\n{}\n\n当前项目根目录：{}",
        role, task, root_hint
    );
    let mut messages: Vec<serde_json::Value> =
        vec![serde_json::json!({ "role": "system", "content": system })];
    let client = reqwest::Client::new();
    let seq = SUB_SEQ.fetch_add(1, Ordering::Relaxed);
    let sub_ctx = ToolContext {
        app: app.clone(),
        request_id: format!("{}:sub{}", request_id, seq),
        project_root,
        profile_id: None,
    };
    for _ in 0..6usize {
        match subagent_model_round(&client, &url, cfg, &mut messages, &tools, &sub_ctx).await? {
            SubRound::Confirmed(text) => {
                if text.is_empty() {
                    return Err("子代理：模型未产出结论".to_string());
                }
                return Ok(text);
            }
            SubRound::ToolCalls => continue,
        }
    }
    Err("子代理：轮次耗尽未取得结论".to_string())
}

/// 后台可继续子代理 worker 主体：长驻循环，drain inbox 投递指令、调用模型/工具，
/// 产出结论即 settle（写入结果槽 + 全局 settle 队列），随后进入闲置等待，可被 send_message 复活。
/// 由 spawn_subagent_background 包成 tokio 后台任务；被 interrupt_agent 置 cancel 后主动退出。
async fn run_subagent_worker(
    app: AppHandle,
    child_id: String,
    cfg: AiProfile,
    role: String,
    task: String,
    project_root: Option<PathBuf>,
    parent_request_id: String,
    cancel: Arc<AtomicBool>,
    mut inbox: mpsc::Receiver<String>,
    state: Arc<AtomicU8>,
    result: Arc<Mutex<Option<SubSettle>>>,
) {
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let reg = registered_tools();
    let tools: Vec<serde_json::Value> = reg
        .iter()
        .filter(|t| matches!(t.name(), "file" | "grep" | "glob"))
        .map(|t| t.function_schema())
        .collect();
    let root_hint = project_root.as_ref().map(|p| p.display().to_string()).unwrap_or_default();
    let system = format!(
        "你是「{}」。只专注完成以下委派任务并直接给出最终结论（不得再向外界委派子任务）：\n{}\n\n当前项目根目录：{}",
        role, task, root_hint
    );
    let mut messages: Vec<serde_json::Value> =
        vec![serde_json::json!({ "role": "system", "content": system })];
    let client = reqwest::Client::new();
    let sub_ctx = ToolContext {
        app: app.clone(),
        request_id: child_id.clone(),
        project_root,
        profile_id: None,
    };
    let mut total_rounds = 0usize;
    const MAX_ROUNDS: usize = 20;

    loop {
        // 1) 中断检查点。
        if cancel.load(Ordering::SeqCst) {
            state.store(SUBA_ST_DONE, Ordering::SeqCst);
            return;
        }
        // 2) drain inbox —— 父 agent 用 send_message 投递的补充指令。
        let mut injected: Vec<String> = Vec::new();
        loop {
            match inbox.try_recv() {
                Ok(m) => injected.push(m),
                Err(_) => break,
            }
        }
        // 3) 若已 settle 且无新指令 → 闲置等待复活（被 send_message 复活 或 被中断退出）。
        if state.load(Ordering::SeqCst) == SUBA_ST_SETTLED && injected.is_empty() {
            match idle_wait_for_input(&mut inbox, &cancel).await {
                None => {
                    state.store(SUBA_ST_DONE, Ordering::SeqCst);
                    return;
                }
                Some(m) => {
                    state.store(SUBA_ST_RUNNING, Ordering::SeqCst);
                    messages.push(serde_json::json!({
                        "role": "user",
                        "content": format!("[父代理补充指令] {}", m),
                    }));
                    continue; // 复活后重新进入循环顶部，走模型调用
                }
            }
        }
        // 4) 续投非空的 injected 指令。
        for m in &injected {
            messages.push(serde_json::json!({
                "role": "user",
                "content": format!("[来自父代理的补充指令] {}", m),
            }));
        }
        // 5) 轮次上限保护。
        if total_rounds >= MAX_ROUNDS {
            let s = SubSettle {
                child_id: child_id.clone(),
                parent_request_id: parent_request_id.clone(),
                role: role.clone(),
                conclusion: "（后台子代理已达最大往返轮次，未产出最终结论）".to_string(),
                error: Some("max_rounds".to_string()),
            };
            *result.lock().unwrap() = Some(s.clone());
            state.store(SUBA_ST_DONE, Ordering::SeqCst);
            notify_subagent_settle(s);
            return;
        }
        total_rounds += 1;
        // 6) 模型轮次。
        match subagent_model_round(&client, &url, &cfg, &mut messages, &tools, &sub_ctx).await {
            Ok(SubRound::Confirmed(text)) => {
                if text.is_empty() {
                    // 空壳：标记 settled（占位），进入闲置等待更多父指令。
                    let s = SubSettle {
                        child_id: child_id.clone(),
                        parent_request_id: parent_request_id.clone(),
                        role: role.clone(),
                        conclusion: String::new(),
                        error: None,
                    };
                    *result.lock().unwrap() = Some(s.clone());
                    state.store(SUBA_ST_SETTLED, Ordering::SeqCst);
                    notify_subagent_settle(s);
                    continue;
                }
                // 最终结论 → settle 并闲置，可被 send_message 复活追问。
                let s = SubSettle {
                    child_id: child_id.clone(),
                    parent_request_id: parent_request_id.clone(),
                    role: role.clone(),
                    conclusion: text,
                    error: None,
                };
                *result.lock().unwrap() = Some(s.clone());
                state.store(SUBA_ST_SETTLED, Ordering::SeqCst);
                notify_subagent_settle(s);
                continue;
            }
            Ok(SubRound::ToolCalls) => continue, // 已回填 messages，继续下一轮
            Err(e) => {
                let s = SubSettle {
                    child_id: child_id.clone(),
                    parent_request_id: parent_request_id.clone(),
                    role: role.clone(),
                    conclusion: String::new(),
                    error: Some(e.clone()),
                };
                *result.lock().unwrap() = Some(s.clone());
                state.store(SUBA_ST_ERROR, Ordering::SeqCst);
                notify_subagent_settle(s);
                return;
            }
        }
    }
}

/// 后台 spawn 一个可继续的子代理 worker，返回 child_id（父 agent 可据此 send_message / interrupt_agent）。
fn spawn_subagent_background(
    app: &AppHandle,
    parent_request_id: &str,
    cfg: &AiProfile,
    role: &str,
    task: &str,
    project_root: Option<PathBuf>,
) -> Result<String, String> {
    if cfg.api_key.trim().is_empty() {
        return Err("子代理：未配置 API Key".to_string());
    }
    let seq = SUB_SEQ.fetch_add(1, Ordering::Relaxed);
    let child_id = format!("{}:sub{}", parent_request_id, seq);
    let (tx, rx) = mpsc::channel(32);
    let cancel = Arc::new(AtomicBool::new(false));
    let state = Arc::new(AtomicU8::new(SUBA_ST_RUNNING));
    let result: Arc<Mutex<Option<SubSettle>>> = Arc::new(Mutex::new(None));

    let app_worker = app.clone();
    let cid = child_id.clone();
    let cfg_worker = cfg.clone();
    let role_worker = role.to_string();
    let task_worker = task.to_string();
    let parent_worker = parent_request_id.to_string();
    let cancel_worker = cancel.clone();
    let state_worker = state.clone();
    let result_worker = result.clone();
    let handle = tokio::spawn(async move {
        run_subagent_worker(
            app_worker,
            cid,
            cfg_worker,
            role_worker,
            task_worker,
            project_root,
            parent_worker,
            cancel_worker,
            rx,
            state_worker,
            result_worker,
        )
        .await;
    });

    subagents().lock().unwrap().insert(
        child_id.clone(),
        SubWorker {
            abort: handle.abort_handle(),
            cancel,
            state,
            inbox: tx,
            result,
            role: role.to_string(),
            task: task.to_string(),
            parent_request_id: parent_request_id.to_string(),
        },
    );
    Ok(child_id)
}

/// 向一个（运行中或已 settle 的）后台子代理投递补充指令，使其继续/复活。
async fn send_subagent_message(child_id: &str, message: &str) -> Result<String, String> {
    let tx = {
        let m = subagents().lock().unwrap();
        let w = m.get(child_id).ok_or_else(|| format!("未找到子代理 {}（可能已被中断/清理）", child_id))?;
        let st = w.state.load(Ordering::SeqCst);
        if st == SUBA_ST_DONE || st == SUBA_ST_ERROR {
            return Err(format!("子代理 {} 已终结（state={}），不可再投递", child_id, st));
        }
        w.inbox.clone()
    };
    // 锁已释放再 await，避免在 .await 上跨场景持锁。
    tx.send(message.to_string())
        .await
        .map_err(|_| "子代理消息通道已关闭".to_string())?;
    Ok(format!("已投递指令给子代理 {}", child_id))
}

/// 中断并清理一个后台子代理：协作取消（flag）+ 强制 abort 在途 await，并从注册表移除。
fn interrupt_subagent(child_id: &str) -> Result<String, String> {
    let w = {
        let mut m = subagents().lock().unwrap();
        m.remove(child_id).ok_or_else(|| format!("未找到子代理 {}", child_id))?
    };
    w.cancel.store(true, Ordering::SeqCst);
    let _ = w.state.compare_exchange(SUBA_ST_RUNNING, SUBA_ST_DONE, Ordering::SeqCst, Ordering::SeqCst);
    let _ = w.state.compare_exchange(SUBA_ST_SETTLED, SUBA_ST_DONE, Ordering::SeqCst, Ordering::SeqCst);
    let _ = w.abort.abort();
    notify_subagent_settle(SubSettle {
        child_id: child_id.to_string(),
        parent_request_id: w.parent_request_id,
        role: w.role,
        conclusion: String::new(),
        error: Some("已由父代理中断".to_string()),
    });
    Ok(format!("已中断子代理 {}", child_id))
}

/// 聚合当前父会话名下所有子代理的展示信息（用于 list_agents / 结果聚合卡）。
fn list_subagents(parent_request_id: &str) -> Vec<serde_json::Value> {
    let m = subagents().lock().unwrap();
    let mut out: Vec<serde_json::Value> = m
        .iter()
        .filter(|(_, w)| w.parent_request_id == parent_request_id)
        .map(|(id, w)| {
            let st = w.state.load(Ordering::SeqCst);
            let conclusion = w
                .result
                .lock()
                .unwrap()
                .as_ref()
                .map(|r| r.conclusion.clone())
                .unwrap_or_default();
            serde_json::json!({
                "id": id,
                "role": w.role,
                "state": st_string(st),
                "task": w.task,
                "conclusion": conclusion,
            })
        })
        .collect();
    out.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    out
}

/// 状态码 → 可读字符串（供 list_agents / 聚合卡展示）。
fn st_string(st: u8) -> &'static str {
    match st {
        SUBA_ST_RUNNING => "running",
        SUBA_ST_SETTLED => "settled",
        SUBA_ST_DONE => "done",
        SUBA_ST_ERROR => "error",
        _ => "unknown",
    }
}

/// 子代理工具：是把一段独立子任务委派给一个独立子助手执行并回收结论的工具（对齐 dsh subagent）。
/// 支持前台同步（默认，直接返回结论）/ 后台可继续（run_in_background=true，返回 child_id，
/// 之后可用 send_message/interrupt_agent/list_agents 控制面工具交互）。并行 sibling 委派仍成立：
/// 外层有界池对每个 subagent 工具调用并发执行，各自以唯一 child_id 独立闭环、互不干扰。
struct SubagentTool;

#[async_trait::async_trait]
impl AiTool for SubagentTool {
    fn name(&self) -> &'static str {
        "subagent"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "function": {
                "name": "subagent",
                "description": "把一段独立子任务委派给一个独立的子助手执行并回收其最终结论。适合代码调研、读文件、搜索等可独立完成的小步骤。子助手有独立目标，不继承当前对话上下文。用 task 写清要它做什么并请直接给结论；role 可选，指明其身份定位（如 代码审阅员 / 调研员）。设 run_in_background=true 时子助手将后台持续运行并返回 child_id，你可用 send_message 追问、interrupt_agent 中断、list_agents 聚合查看其状态。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "task": { "type": "string", "description": "给子助手的目标指令，要求返回最终结论" },
                        "role": { "type": "string", "description": "（可选）子助手身份定位，如 代码审阅员 / 调研员" },
                        "run_in_background": { "type": "boolean", "description": "（可选，默认 false）true 则后台持续运行并返回 child_id 供控制面交互，false 则同步等待并直接返回结论" }
                    },
                    "required": ["task"]
                }
            }
        })
    }
    fn concurrency(&self) -> ToolConcurrency {
        // 并行子代理：可与其他工具/其他子代理并发，由外层有界池（PARALLEL_LIMIT）限制并发上限；
        // 内部以唯一 request_id 独立闭环，无需独占屏障。
        ToolConcurrency::Parallel
    }
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let task = args.get("task").and_then(|v| v.as_str()).unwrap_or("");
        serde_json::json!({ "card": "generic", "kind": "other", "title": "委派子助手", "detail": task })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let task = args.get("task").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if task.is_empty() {
            return Err("subagent：缺少有效的 task 描述".to_string());
        }
        let role = args.get("role").and_then(|v| v.as_str()).unwrap_or("子助手").to_string();
        let bg = args.get("run_in_background").and_then(|v| v.as_bool()).unwrap_or(false);
        let profiles = load_profiles(&ctx.app);
        let cfg = resolve_profile(&profiles, ctx.profile_id.clone());

        if bg {
            // 后台可继续：spawn worker 返回 child_id，控制面/settle 依赖注册表与全局队列。
            let child_id =
                spawn_subagent_background(&ctx.app, &ctx.request_id, &cfg, &role, &task, ctx.project_root.clone())?;
            let text = format!("已后台启动子助手「{}」，child_id={}。可用 send_message 追问 / interrupt_agent 中断 / list_agents 查看状态，结论将在后续自动注入。", role, child_id);
            let meta = serde_json::json!({
                "card": "subagents",
                "kind": "group",
                "title": format!("已并行委派·子助手 {}", role),
                "detail": text,
                "agents": serde_json::json!([{ "id": child_id, "role": role, "state": "running" }]),
            });
            return Ok(ToolExecResult::with_meta(text, meta));
        }

        // 前台同步：直接返回结论。
        let text = run_subagent_once(&ctx.app, &ctx.request_id, &cfg, &role, &task, ctx.project_root.clone()).await?;
        let capped: String = text.chars().take(4000).collect();
        let meta = serde_json::json!({
            "card": "generic",
            "kind": "other",
            "title": format!("子助手·{} 结论", role),
            "detail": capped,
            "truncated": text.chars().count() > 4000,
        });
        Ok(ToolExecResult::with_meta(text, meta))
    }
}

/// 控制面工具：向后台子代理投递补充指令（可复活已 settle 的子代理，也能追加给运行中的）。
struct SendMessageTool;
#[async_trait::async_trait]
impl AiTool for SendMessageTool {
    fn name(&self) -> &'static str {
        "send_message"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "function": {
                "name": "send_message",
                "description": "向指定的后台子代理（subagent run_in_background=true 返回的 child_id）投递一条补充指令，使其继续处理或唤醒已暂存的子代理。child_id 来自 subagent 调用的返回。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "child_id": { "type": "string", "description": "后台子代理的 child_id" },
                        "message": { "type": "string", "description": "补充指令内容" }
                    },
                    "required": ["child_id", "message"]
                }
            }
        })
    }
    fn concurrency(&self) -> ToolConcurrency {
        // 有副作用（改 worker 状态/队列），独占串行。
        ToolConcurrency::Exclusive
    }
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let child = args.get("child_id").and_then(|v| v.as_str()).unwrap_or("");
        serde_json::json!({ "card": "generic", "kind": "other", "title": "向子代理投递指令", "detail": child })
    }
    async fn execute(&self, args: &serde_json::Value, _ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let child = args.get("child_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let msg = args.get("message").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if child.is_empty() || msg.is_empty() {
            return Err("send_message：缺少 child_id 或 message".to_string());
        }
        let text = send_subagent_message(&child, &msg).await?;
        Ok(ToolExecResult::plain(text))
    }
}

/// 控制面工具：中断并清理一个后台子代理。
struct InterruptAgentTool;
#[async_trait::async_trait]
impl AiTool for InterruptAgentTool {
    fn name(&self) -> &'static str {
        "interrupt_agent"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "function": {
                "name": "interrupt_agent",
                "description": "中断并清理一个后台子代理（subagent run_in_background=true 返回的 child_id）。其已产出结论会作为中断原因回填给主 agent。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "child_id": { "type": "string", "description": "后台子代理的 child_id" }
                    },
                    "required": ["child_id"]
                }
            }
        })
    }
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Exclusive
    }
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let child = args.get("child_id").and_then(|v| v.as_str()).unwrap_or("");
        serde_json::json!({ "card": "generic", "kind": "other", "title": "中断子代理", "detail": child })
    }
    async fn execute(&self, args: &serde_json::Value, _ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let child = args.get("child_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if child.is_empty() {
            return Err("interrupt_agent：缺少 child_id".to_string());
        }
        let text = interrupt_subagent(&child)?;
        Ok(ToolExecResult::plain(text))
    }
}

/// 控制面工具：聚合展示当前父会话名下所有后台子代理的状态与结论。
struct ListAgentsTool;
#[async_trait::async_trait]
impl AiTool for ListAgentsTool {
    fn name(&self) -> &'static str {
        "list_agents"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "function": {
                "name": "list_agents",
                "description": "列出当前会话名下所有后台子代理（subagent run_in_background=true）的 id、角色、运行状态与已产出结论，便于你汇总并行 sibling 的最新进展。",
                "parameters": {
                    "type": "object",
                    "properties": {}
                }
            }
        })
    }
    fn concurrency(&self) -> ToolConcurrency {
        // 只读聚合展示，但读取全局注册表；为避免与其他 worker 操作交错，按独占处理。
        ToolConcurrency::Exclusive
    }
    fn present_call(&self, _args: &serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "card": "subagents", "kind": "group", "title": "聚合查看后台子代理" })
    }
    async fn execute(&self, _args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let agents = list_subagents(&ctx.request_id);
        let running = agents.iter().filter(|a| a["state"] == "running").count();
        let settled = agents.iter().filter(|a| a["state"] == "settled").count();
        // 汇总文本（模型可见）+ 结构化聚合卡（前端渲染）。
        let text = if agents.is_empty() {
            "当前没有运行中的后台子代理。如需并行委派，可用 subagent 并设 run_in_background=true。".to_string()
        } else {
            let mut s = format!("当前共有 {} 个后台子代理（运行中 {} / 已产出结论 {}）：\n", agents.len(), running, settled);
            for a in &agents {
                let c = a["conclusion"].as_str().unwrap_or("");
                let cap = if c.is_empty() { "（暂无结论）".to_string() } else {
                    let cc: String = c.chars().take(300).collect();
                    if c.chars().count() > 300 { format!("{}…", cc) } else { cc }
                };
                s.push_str(&format!("- [{}] role={} state={} task={}\n  结论: {}\n", a["id"], a["role"], a["state"], a["task"], cap));
            }
            s
        };
        let meta = serde_json::json!({
            "card": "subagents",
            "kind": "group",
            "title": format!("并行子代理聚合（{} 运行 / {} 结论）", running, settled),
            "detail": text,
            "agents": agents,
        });
        Ok(ToolExecResult::with_meta(text, meta))
    }
}

/// Git 工具：封装 git_service（走系统 git CLI，porcelain 解析 + 防注入 + 错误归一已内置）。
/// Agent 不必裸跑 run_command 再自行解析 git 输出，直接用结构化结果（status/diff/stage/commit/log）。
struct GitTool;
#[async_trait::async_trait]
impl AiTool for GitTool {
    fn name(&self) -> &'static str {
        "git"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "执行 Git 源码管理（走系统 git CLI，输出结构化）。action(必填)：status 工作区/暂存区状态 | diff 差异 | stage 暂存文件 | unstage 取消暂存 | commit 提交（需 message） | log 提交历史 | current_branch 当前分支 | branch 分支列表。repo 省略时用项目根。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": { "type": "string", "enum": ["status", "diff", "stage", "unstage", "commit", "log", "current_branch", "branch"] },
                        "repo": { "type": "string", "description": "仓库根路径（默认项目根目录）" },
                        "path": { "type": "string", "description": "diff/stage/unstage 的目标文件路径" },
                        "message": { "type": "string", "description": "commit 提交信息" },
                        "staged": { "type": "boolean", "description": "diff 只看暂存区（默认 false）" },
                        "max": { "type": "integer", "description": "log 最大条数（默认20）" }
                    },
                    "required": ["action"]
                }
            }
        })
    }
    /// 含写操作（stage/commit），独占串行，避免与批次内其他写工具并行产生竞态。
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Exclusive
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if action.is_empty() {
            return Err("git 缺少 action 参数（status/diff/stage/unstage/commit/log/current_branch/branch）".to_string());
        }
        let repo = args.get("repo").and_then(|v| v.as_str()).map(|s| s.to_string())
            .or_else(|| ctx.project_root.as_ref().map(|p| p.to_string_lossy().to_string()))
            .ok_or_else(|| "git 需要 repo（仓库根路径），且未检测到项目根".to_string())?;
        let path = args.get("path").and_then(|v| v.as_str()).map(|s| s.to_string());
        let message = args.get("message").and_then(|v| v.as_str()).map(|s| s.to_string());
        let staged = args.get("staged").and_then(|v| v.as_bool()).unwrap_or(false);
        let max = args.get("max").and_then(|v| v.as_u64()).map(|m| m as usize);

        let repo_show = repo.clone();
        let action_c = action.clone();
        let path_c = path.clone();
        let message_c = message.clone();
        // git_service 为阻塞同步 IO（std::process::Command），放 spawn_blocking，避免卡住 Tokio。
        let (result, repo_show) = tokio::task::spawn_blocking(move || {
            let r: Result<serde_json::Value, String> = (|| {
                match action_c.as_str() {
                    "status" => {
                        let s = git_service::git_status(repo)?;
                        Ok(serde_json::to_value(s).map_err(|e| e.to_string())?)
                    }
                    "diff" => {
                        let d = git_service::git_diff(repo, staged, path_c)?;
                        Ok(serde_json::json!({ "diff": d }))
                    }
                    "stage" => {
                        let p = path_c.ok_or_else(|| "git stage 需要 path".to_string())?;
                        git_service::git_stage(repo, p.clone())?;
                        Ok(serde_json::json!({ "staged": p }))
                    }
                    "unstage" => {
                        let p = path_c.ok_or_else(|| "git unstage 需要 path".to_string())?;
                        git_service::git_unstage(repo, p.clone())?;
                        Ok(serde_json::json!({ "unstaged": p }))
                    }
                    "commit" => {
                        let m = message_c.ok_or_else(|| "git commit 需要 message".to_string())?;
                        let sha = git_service::git_commit(repo, m)?;
                        Ok(serde_json::json!({ "commit": sha }))
                    }
                    "log" => {
                        let l = git_service::git_log(repo, max)?;
                        Ok(serde_json::to_value(l).map_err(|e| e.to_string())?)
                    }
                    "current_branch" => {
                        let b = git_service::git_current_branch(repo)?;
                        Ok(serde_json::json!({ "branch": b }))
                    }
                    "branch" => {
                        let b = git_service::git_branch_list(repo)?;
                        Ok(serde_json::json!({ "branches": b }))
                    }
                    _ => Err(format!("未知 git action: {}", action_c)),
                }
            })();
            (r, repo_show)
        })
        .await
        .map_err(|e| format!("git 执行任务失败: {}", e))?;
        match result {
            Ok(v) => {
                let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                let meta = serde_json::json!({
                    "card": "terminal",
                    "title": format!("git {} ({})", action, repo_show),
                    "output": text,
                });
                Ok(ToolExecResult::with_meta(text, meta))
            }
            Err(e) => Err(e),
        }
    }
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("git");
        serde_json::json!({ "card": "generic", "kind": "other", "title": format!("git {}", action) })
    }
}

/// 诊断工具：封装 lsp_service::lsp_diagnostics（tsc --noEmit / cargo check / pyright 一次性运行 + 解析）。
/// 让 Agent 在改完代码后自查编译/类型错误，形成「改 → 诊断 → 修」闭环。
struct LspTool;
#[async_trait::async_trait]
impl AiTool for LspTool {
    fn name(&self) -> &'static str {
        "diagnose"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "对项目运行编译器/类型检查诊断（tsc --noEmit / cargo check / pyright）。参数 path(必填，要诊断的文件绝对路径，据此选择诊断源)；project_root(可选，项目根，默认自动探测)。返回 error/warning 诊断列表，供修改代码后自查，形成改→查→修闭环。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "要诊断的文件绝对路径" },
                        "project_root": { "type": "string", "description": "项目根目录（默认自动探测）" }
                    },
                    "required": ["path"]
                }
            }
        })
    }
    /// 触发 tsc/cargo check 重量级子进程，独占串行，避免批次内同时起多个编译器进程。
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Exclusive
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if path.is_empty() {
            return Err("diagnose 缺少 path 参数".to_string());
        }
        let project_root = args.get("project_root").and_then(|v| v.as_str()).map(|s| s.to_string())
            .or_else(|| ctx.project_root.as_ref().map(|p| p.to_string_lossy().to_string()));
        // lsp_diagnostics 自身 async（内部 spawn 子进程并等待），直接 await。
        let res = lsp_service::lsp_diagnostics(path.clone(), project_root).await?;
        let err_count = res.diagnostics.iter().filter(|d| d.severity == "error").count();
        let text = if res.diagnostics.is_empty() {
            format!("诊断通过（{}，{:.2}s）：无错误/警告", res.source, res.elapsed_ms as f64 / 1000.0)
        } else {
            let mut s = format!("{}（{}ms）：{} 个 error / 共 {} 条诊断\n", res.source, res.elapsed_ms, err_count, res.diagnostics.len());
            for d in &res.diagnostics {
                s.push_str(&format!(
                    "  [{}] {}:{}:{} · {}{}\n",
                    d.severity, d.path, d.line, d.character, d.message,
                    d.code.as_ref().map(|c| format!(" ({})", c)).unwrap_or_default()
                ));
            }
            s
        };
        let meta = serde_json::json!({
            "card": "diagnostics",
            "source": res.source,
            "elapsedMs": res.elapsed_ms,
            "errorCount": err_count,
            "total": res.diagnostics.len(),
        });
        Ok(ToolExecResult::with_meta(text, meta))
    }
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        serde_json::json!({ "card": "generic", "kind": "other", "title": format!("诊断 {}", path) })
    }
}

/// RAG 检索工具：封装 rag_service（text → 嵌入向量 → 向量 top-k 检索）。
/// 默认与本机 Ollama(nomic-embed-text) 或已配置端点配合；未就绪时返回明确错误，Agent 可感知并改用其他工具。
struct RagSearchTool;
#[async_trait::async_trait]
impl AiTool for RagSearchTool {
    fn name(&self) -> &'static str {
        "rag_search"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "向量语义检索项目知识库/记忆（RAG）。query(必填，自然语言检索词)；top_k(可选，返回条数，默认5)；namespace(可选，general 通用知识库 / ai-ide 编程记忆 / ai-chat 对话记忆，默认 general)。适合找文档/知识库里的历史结论，不适合查代码符号（用 grep/glob）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "检索词" },
                        "top_k": { "type": "integer", "description": "返回条数（默认5）" },
                        "namespace": { "type": "string", "description": "检索空间（默认 general）" }
                    },
                    "required": ["query"]
                }
            }
        })
    }
    /// 只读检索，无副作用，可与同批只读工具并发。
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Parallel
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if query.is_empty() {
            return Err("rag_search 缺少 query 参数".to_string());
        }
        let top_k = args.get("top_k").and_then(|v| v.as_u64()).map(|k| k as usize);
        let namespace = args.get("namespace").and_then(|v| v.as_str()).map(|s| s.to_string())
            .unwrap_or_else(|| rag_service::RAG_NS_DEFAULT.to_string());
        let app = ctx.app.clone();
        // 1) 文本 → 向量（rag_embed_api 默认本机 Ollama / OpenAI 兼容端点；走 reqwest）
        let emb = rag_service::rag_embed_api(rag_service::RagEmbedRequest {
            texts: vec![query.clone()],
            endpoint: None,
            api_key: None,
            model: None,
        })
        .await?;
        let query_vec = emb.embeddings.into_iter().next().ok_or_else(|| "嵌入结果为空".to_string())?;
        // 2) 向量 → SQLite top-k 检索（同步 IO，spawn_blocking）
        let ns_disp = namespace.clone();
        let (result, ns) = tokio::task::spawn_blocking(move || {
            let r = rag_service::rag_query(&app, query_vec, top_k, Some(namespace));
            (r, ns_disp)
        })
        .await
        .map_err(|e| format!("rag 检索任务失败: {}", e))?;
        let res = result.map_err(|e| {
            format!("RAG 检索失败：{}（是否已用知识库面板导入内容、且本机嵌入服务已就绪？）", e)
        })?;
        if res.results.is_empty() {
            return Ok(ToolExecResult::plain(format!("RAG（{}）无匹配结果。", ns)));
        }
        let mut s = format!("RAG 检索 [{}] {} 条命中：\n", ns, res.total);
        for (i, h) in res.results.iter().enumerate() {
            s.push_str(&format!("{}. [来源 {} · 分 {:.3}]\n{}\n", i + 1, h.source_title, h.score, h.text));
        }
        let meta = serde_json::json!({
            "card": "search",
            "kind": "rag",
            "title": format!("RAG 检索：{}", query),
            "detail": s,
        });
        Ok(ToolExecResult::with_meta(s, meta))
    }
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let q = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
        serde_json::json!({ "card": "generic", "kind": "search", "title": format!("RAG 检索 {}", q) })
    }
}

pub(crate) fn registered_tools() -> Vec<Box<dyn AiTool>> {
    vec![
        Box::new(NowTool),
        Box::new(CalculatorTool),
        Box::new(PlanTool),
        Box::new(FileTool),
        Box::new(CommandTool),
        Box::new(GrepTool),
        Box::new(GlobTool),
        Box::new(McpTool),
        Box::new(SkillTool),
        Box::new(WebSearchTool),
        Box::new(WebFetchTool),
        Box::new(SubagentTool),
        Box::new(SendMessageTool),
        Box::new(InterruptAgentTool),
        Box::new(ListAgentsTool),
        Box::new(GitTool),
        Box::new(LspTool),
        Box::new(RagSearchTool),
        Box::new(GongfangTool),
    ]
}

// ============ gongfang 攻防侦察工具（AI 统一网关接入） ============
// 目的：让 AI/Agent 通过既有统一执行闸（execute_tool_once：schema 校验 + 副作用审批 +
// 并发协调）调用 gongfang 后端，而不是绕过闸口直连 Tauri 通道（那是"AI 驱动卡死"的根因）。
// 复用 gongfang_kit 同一批后端函数，无重复实现。仅对用户显式给的 url 做侦察级 GET。
struct GongfangTool;
#[async_trait::async_trait]
impl AiTool for GongfangTool {
    fn name(&self) -> &'static str {
        "gongfang"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "gongfang",
                "description": "对用户显式给出的目标 URL 做侦察级分析（只读 GET，非入侵）。action 可选：waf(WAF检测)/tech(技术栈指纹)/methods(HTTP方法)/paths(常见路径)/wellknown(.well-known端点)/error(错误页指纹)/crawl(抓取首页正文)。仅在目标经受权时使用。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": { "type": "string", "enum": ["waf","tech","methods","paths","wellknown","error","crawl"], "description": "要执行的侦察动作" },
                        "url": { "type": "string", "description": "目标 URL（绝对地址，需显式给出）" }
                    },
                    "required": ["action", "url"]
                }
            }
        })
    }
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Exclusive // 网络副作用工具：独占串行，避免并发打爆
    }
    async fn execute(&self, args: &serde_json::Value, _ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if url.is_empty() {
            return Err("gongfang 缺少 url 参数（目标必须显式给出）".to_string());
        }
        let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("recon").to_string();
        #[cfg(feature = "gongfang")]
        {
            let text = match action.as_str() {
                "waf" => serialize_pretty(gongfang_kit::commands::gongfang_waf_detect(url.clone()).await)?,
                "tech" => serialize_pretty(gongfang_kit::commands::gongfang_tech_fingerprint(url.clone()).await)?,
                "methods" => serialize_pretty(gongfang_kit::commands::gongfang_http_methods(url.clone()).await)?,
                "paths" => serialize_pretty(gongfang_kit::commands::gongfang_path_probe(url.clone()).await)?,
                "wellknown" => serialize_pretty(gongfang_kit::commands::gongfang_wellknown_probe(url.clone()).await)?,
                "error" => serialize_pretty(gongfang_kit::commands::gongfang_error_page(url.clone()).await)?,
                "crawl" => serialize_pretty(gongfang_kit::commands::gongfang_fetch(url.clone()).await)?,
                other => return Err(format!("未知 gongfang action: {other}")),
            };
            let meta = serde_json::json!({ "card": "generic", "kind": "recon", "title": format!("gongfang[{action}] {url}"), "locations": [{ "path": url }] });
            Ok(ToolExecResult::with_meta(text, meta))
        }
        #[cfg(not(feature = "gongfang"))]
        {
            let _ = action;
            Err("gongfang feature 未启用：请用 --features gongfang 构建后再调用本工具".to_string())
        }
    }
}

// 通用 JSON 序列化（对 gongfang_* 的 Result<T,String> 定值做 pretty 文本给模型）
#[cfg(feature = "gongfang")]
fn serialize_pretty<T: serde::Serialize>(r: Result<T, String>) -> Result<String, String> {
    match r {
        Ok(v) => serde_json::to_string_pretty(&v).map_err(|e| format!("序列化失败: {e}")),
        Err(e) => Err(e),
    }
}

/// 聚合已启用 MCP 服务器的工具清单，作为 guide 注入 agent 系统提示，让模型知道 mcp 工具可调用什么。
/// 任一个服务器 list_tools 失败都静默降级（mcp_list_all_tools 内部已捕获）；整体限时 5s 防挂起。
pub(crate) async fn mcp_tools_guide(app: &AppHandle) -> String {
    let list = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        mcp_service::mcp_list_all_tools(app.clone()),
    )
    .await
    .unwrap_or_else(|_| Ok(Vec::new()))
    .unwrap_or_default();
    if list.is_empty() {
        return String::new();
    }
    let mut s = String::from("\n\n可用 MCP 工具（用 mcp 工具调用，server 填服务器 id；arguments 按工具输入结构传 JSON）：");
    for (id, name, tools) in list {
        let names: Vec<String> = tools.iter().map(|t| t.name.clone()).collect();
        s.push_str(&format!("\n- [{}] {}：{}", id, name, names.join(", ")));
    }
    s
}

/// 技能索引注入（progressive disclosure）：只注入项目技能的名称 + 一句话说明 + 触发关键词，
/// 完整技能说明在模型需要时用 skill 工具按名加载，避免上下文膨胀（对齐 agent-skills 的按需加载）。
/// 无技能目录时返回空串，agent 上下文不受影响。
pub(crate) fn skills_guide(project_root: Option<&std::path::Path>) -> String {
    let dir = skill_service::list_skills(project_root);
    if dir.skills.is_empty() {
        return String::new();
    }
    let mut s = String::from(
        "\n\n项目可用技能（用 skill 工具按 name 加载完整说明后再执行相应任务；按触发关键词判断是否用到）：",
    );
    for sk in &dir.skills {
        let kws: Vec<String> = sk.keywords.clone();
        let kws_txt = if kws.is_empty() {
            String::new()
        } else {
            format!(" 关键词: {}", kws.join("/"))
        };
        s.push_str(&format!("\n- {}：{}{}", sk.name, sk.description, kws_txt));
    }
    s
}

/// 读取项目级「记忆/原则/工程契约」注入 Agent 上下文（对齐 IDE runAgent 的约定）：
/// - 记忆/当日.md（今日不存在则取 记忆/ 目录下按文件名字典序最近一份 .md）
/// - 原则/原则.md
/// - 工程契约：AGENTS.md / CLAUDE.md / .cursorrules / GEMINI.md（取首个存在者）
/// 仅读、仅在项目根内、各段有长度裁剪，避免上下文膨胀。
pub(crate) async fn agent_memory_context(project_root: Option<&std::path::Path>) -> String {
    use std::path::Path;
    let Some(root) = project_root else { return String::new(); };
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let root_c = root.to_path_buf();
    let (mem, prin, contract) = tokio::task::spawn_blocking(move || {
        let read_top = |p: &Path, cap: usize| -> Option<String> {
            std::fs::read_to_string(p).ok().map(|s| truncate_str(s, cap))
        };
        // 今日记忆；不存在则取目录下最近一份 .md（文件名升序取末个）
        let mem = read_top(&root_c.join("记忆").join(format!("{}.md", today)), 9000).or_else(|| {
            let mem_dir = root_c.join("记忆");
            let mut names: Vec<String> = Vec::new();
            if let Ok(rd) = std::fs::read_dir(&mem_dir) {
                for e in rd.flatten() {
                    let p = e.path();
                    if p.extension().map(|x| x == "md").unwrap_or(false) {
                        if let Some(n) = p.file_name().map(|n| n.to_string_lossy().to_string()) {
                            names.push(n);
                        }
                    }
                }
            }
            names.sort();
            names.last().and_then(|n| read_top(&mem_dir.join(n), 9000))
        });
        let prin = read_top(&root_c.join("原则").join("原则.md"), 6000);
        let contract = ["AGENTS.md", "CLAUDE.md", ".cursorrules", "GEMINI.md"]
            .iter()
            .find_map(|c| read_top(&root_c.join(c), 8000));
        (mem, prin, contract)
    })
    .await
    .unwrap_or_default();
    let mut s = String::new();
    if let Some(m) = mem {
        s.push_str(&format!("\n\n【今日/最近项目记忆】\n{}\n", m));
    }
    if let Some(p) = prin {
        s.push_str(&format!("\n【项目原则】\n{}\n", p));
    }
    if let Some(c) = contract {
        s.push_str(&format!("\n【项目工程契约】\n{}\n", c));
    }
    s
}

/// 按字符数截断到上限（UTF-8 安全），过长加省略标记。
pub(crate) fn truncate_str(s: String, cap: usize) -> String {
    if s.chars().count() <= cap {
        s
    } else {
        let t: String = s.chars().take(cap).collect();
        format!("{}…（过长已截断）", t)
    }
}

/// 粗估一组消息的 token 用量（启发式：字符数/2 + 每条消息固定开销）。仅用于触发/熔断阈值，无需精确。
pub(crate) fn estimate_tokens(msgs: &[serde_json::Value]) -> usize {
    let mut chars = 0usize;
    let mut count = 0usize;
    for m in msgs {
        count += 1;
        if let Some(c) = m.get("content").and_then(|c| c.as_str()) {
            chars += c.chars().count();
        }
    }
    chars / 2 + count * 3
}

/// 估算工具定义（tools 数组）的固定开销 token —— 它对每个请求都会发送，
/// 不计入会低估真实发送量，进而在工具增多时逼近上游硬限制。
pub(crate) fn estimate_tools_tokens(tools: &[serde_json::Value]) -> usize {
    let mut chars = 0usize;
    for t in tools {
        if let Some(s) = serde_json::to_string(t).ok() {
            chars += s.chars().count();
        }
    }
    chars / 2 + tools.len() * 4
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_html_to_text_strips_tags_and_decodes() {
        let html = "<html><head><title>t</title></head><body><script>var x=1</script><p>你好 &amp; <b>世界</b></p><p>第二行</p></body></html>";
        let out = html_to_text(html);
        assert!(out.contains("你好 & 世界"), "out={:?}", out);
        assert!(out.contains("第二行"));
        assert!(!out.contains("var x=1"));
    }

    #[test]
    fn web_url_escape_component_encodes_query() {
        assert_eq!(url_escape_component("你好 world"), "%E4%BD%A0%E5%A5%BD+world");
    }

    #[test]
    fn validate_schema_rejects_missing_required_and_wrong_type() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" },
                "max_results": { "type": "integer" }
            },
            "required": ["query"]
        });
        // 缺 required
        assert!(validate_args_by_schema(&schema, &serde_json::json!({}), "web_search").is_err());
        // 类型不符
        assert!(validate_args_by_schema(&schema, &serde_json::json!({ "query": 123 }), "web_search").is_err());
        // 合法 + 可选缺省
        assert!(validate_args_by_schema(&schema, &serde_json::json!({ "query": "ok" }), "web_search").is_ok());
        // integer 接受整数浮点
        assert!(validate_args_by_schema(&schema, &serde_json::json!({ "query": "ok", "max_results": 3.0 }), "web_search").is_ok());
    }

    #[test]
    fn validate_schema_walks_nested() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "files": { "type": "array", "items": { "type": "string" } }
            },
            "required": ["files"]
        });
        assert!(validate_args_by_schema(&schema, &serde_json::json!({ "files": ["a", 1] }), "x").is_err());
        assert!(validate_args_by_schema(&schema, &serde_json::json!({ "files": ["a", "b"] }), "x").is_ok());
    }

    #[test]
    fn edit_diff_single_line_replace() {
        let (found, old, new) = extract_edit_diff("line1\nhello world\nline3", "world", "WORLD");
        assert!(found);
        assert_eq!(old, "hello world");
        assert_eq!(new, "hello WORLD");
    }

    #[test]
    fn edit_diff_last_line_no_newline() {
        let (found, old, new) = extract_edit_diff("aa\nbb", "bb", "BB");
        assert!(found);
        assert_eq!(old, "bb");
        assert_eq!(new, "BB");
    }

    #[test]
    fn edit_diff_multi_occurrence_replaces_all_in_line() {
        // 行内 old 出现多次 → 与落盘一致全替换
        let (found, old, new) = extract_edit_diff("x foo y foo\nz", "foo", "BAR");
        assert!(found);
        assert_eq!(old, "x foo y foo");
        assert_eq!(new, "x BAR y BAR");
    }

    #[test]
    fn edit_diff_not_found_returns_empty() {
        let (found, old, new) = extract_edit_diff("a\nb", "zz", "Q");
        assert!(!found);
        assert!(old.is_empty());
        assert!(new.is_empty());
    }

    #[test]
    fn edit_diff_crosses_lines_uses_first_to_last_hunk() {
        // old 跨行 → 行块覆盖首行头→末行尾
        let (found, old, new) = extract_edit_diff("aa\nbb\ncc", "bb", "B2");
        assert!(found);
        assert_eq!(old, "bb");
        assert_eq!(new, "B2");
    }

    // ============ 后台子代理控制面（M1/M2）测试 ============
    // 仅覆盖与网络无关的注册表 / 队列 / 状态机簿记；worker 的模型轮次依赖网络，不在此测。

    #[test]
    fn settle_queue_partitions_by_parent() {
        sub_settles().lock().unwrap().clear();
        notify_subagent_settle(SubSettle {
            child_id: "p1:sub1".into(),
            parent_request_id: "p1".into(),
            role: "调研员".into(),
            conclusion: "结论A".into(),
            error: None,
        });
        notify_subagent_settle(SubSettle {
            child_id: "p2:sub1".into(),
            parent_request_id: "p2".into(),
            role: "审阅员".into(),
            conclusion: "结论B".into(),
            error: None,
        });
        // p1 只取走自己的，p2 的保留。
        let p1 = take_subagent_settles("p1");
        assert_eq!(p1.len(), 1);
        assert_eq!(p1[0].child_id, "p1:sub1");
        assert!(take_subagent_settles("p1").is_empty());
        // p2 的记录仍在。
        let p2 = take_subagent_settles("p2");
        assert_eq!(p2.len(), 1);
        assert_eq!(p2[0].child_id, "p2:sub1");
        sub_settles().lock().unwrap().clear();
    }

    #[test]
    fn interrupt_missing_child_errors() {
        assert!(interrupt_subagent("no-such-child").is_err());
    }

    #[test]
    fn spawn_background_registers_and_interrupt_cleans() {
        // 最小假档案（不发真实请求；仅验证注册/中断清理的簿记）。
        let mut cfg = AiProfile::default();
        cfg.base_url = "http://127.0.0.1:1/v1".into();
        cfg.api_key = "x".into();
        cfg.model = "dummy".into();
        let child = spawn_test_worker("parent-test", &cfg, "测试助手", "只验证簿记")
            .expect("spawn 应成功");
        assert!(subagents().lock().unwrap().contains_key(&child), "spawn 后应登记 {}", child);
        // 中断并清理。
        assert!(interrupt_subagent(&child).is_ok());
        assert!(!subagents().lock().unwrap().contains_key(&child), "中断后应移除 {}", child);
        // 中断 settle 进入父会话队列。
        let s = take_subagent_settles("parent-test");
        assert!(s.len() == 1 && s[0].child_id == child, "应产生中断 settle");
        sub_settles().lock().unwrap().clear();
    }

    #[test]
    fn send_message_to_done_child_is_rejected() {
        let mut cfg = AiProfile::default();
        cfg.base_url = "http://127.0.0.1:1/v1".into();
        cfg.api_key = "x".into();
        cfg.model = "dummy".into();
        let child = spawn_test_worker("parent-send", &cfg, "测试", "簿记").unwrap();
        interrupt_subagent(&child).ok();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let r = rt.block_on(send_subagent_message(&child, "新指令"));
        assert!(r.is_err(), "已终结的子代理不可再投递");
        sub_settles().lock().unwrap().clear();
    }

    #[test]
    fn list_subagents_groups_by_parent() {
        let mut cfg = AiProfile::default();
        cfg.base_url = "http://127.0.0.1:1/v1".into();
        cfg.api_key = "x".into();
        cfg.model = "dummy".into();
        spawn_test_worker("parent-list", &cfg, "甲", "任务一").unwrap();
        spawn_test_worker("parent-list", &cfg, "乙", "任务二").unwrap();
        spawn_test_worker("other-parent", &cfg, "丙", "无关").unwrap();
        let agents = list_subagents("parent-list");
        assert_eq!(agents.len(), 2);
        assert!(agents.iter().all(|a| a["state"] == "running"));
        // 清理其它父会话遗留，避免相互影响。
        subagents().lock().unwrap().retain(|_, w| {
            w.parent_request_id != "parent-list" && w.parent_request_id != "other-parent"
        });
    }
}

/// 测试辅助：模拟 spawn 一个驻留子代理的注册簿记（不发真实模型请求）。
/// 与真实 spawn_subagent_background 的注册逻辑保持一致，只是后台任务改为空休眠。
#[cfg(test)]
fn spawn_test_worker(
    parent: &str,
    _cfg: &AiProfile,
    role: &str,
    task: &str,
) -> Result<String, String> {
    let seq = SUB_SEQ.fetch_add(1, Ordering::Relaxed);
    let child_id = format!("{}:sub{}", parent, seq);
    let (tx, _rx) = mpsc::channel(32);
    let cancel = Arc::new(AtomicBool::new(false));
    let state = Arc::new(AtomicU8::new(SUBA_ST_RUNNING));
    let result: Arc<Mutex<Option<SubSettle>>> = Arc::new(Mutex::new(None));
    // 在单独 runtime 里起一个空休眠任务以拿到合法的 abort handle；interrupt 的 abort 会将其取消，
    // 但簿记测试不依赖任务本身存活。
    let cancel_w = cancel.clone();
    let abort = {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            tokio::spawn(async move {
                loop {
                    if cancel_w.load(Ordering::SeqCst) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            })
            .abort_handle()
        })
    };
    subagents().lock().unwrap().insert(
        child_id.clone(),
        SubWorker {
            abort,
            cancel,
            state,
            inbox: tx,
            result,
            role: role.to_string(),
            task: task.to_string(),
            parent_request_id: parent.to_string(),
        },
    );
    Ok(child_id)
}
