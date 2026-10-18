//! ai_tools 子模块 · plan —— Plan / Todo 工具：让 Agent 有可见、可更新的任务清单
//!
//! 由 ai_tools.rs（5245 行）按工具族机械拆分而来，逻辑零改动。
//! 父模块的 use 导入与共享项经 `use super::*` 取得；这里的顶层项统一 pub(crate)，
//! 由 ai_tools.rs 的 `pub(crate) use <mod>::*` 转出，外部引用路径不变。
#![allow(unused_imports)] //  glob 取父模块导入，按族切分后必有剩余，逐个删只会漏
use super::*;

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
pub(crate) struct PlanTodo {
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
pub(crate) static PLAN_STORE: OnceLock<Mutex<Plan>> = OnceLock::new();
pub(crate) fn plan_store() -> &'static Mutex<Plan> {
    PLAN_STORE.get_or_init(|| Mutex::new(Plan { title: String::new(), next_id: 1, todos: vec![] }))
}

/// 把当前计划渲染为模型可见的文本（含 id，便于调用方按 id 勾选/删除）。
pub(crate) fn render_plan(p: &Plan) -> String {
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
pub(crate) struct PlanTool;
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
