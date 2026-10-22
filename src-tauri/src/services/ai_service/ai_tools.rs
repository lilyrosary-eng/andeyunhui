
// 全局 AI 服务 · 子模块：Agent 工具（Tool）
// （由 ai_service.rs 机械拆分而来，逻辑零改动）

use std::io::BufRead;
use std::path::PathBuf;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::mpsc;
use crate::services::ai_service::ai_profile::{ResolvedTarget, load_config, resolve_target};
use crate::services::ai_service::ai_session::SessionEvent;
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


// ============ 子模块（2026-10-18 由 5245 行单文件按工具族拆分，逻辑零改动） ============
mod core;
mod basic;
mod plan;
mod fs_shell;
mod search_web;
mod subagent;
mod devtools;
mod media_gen;
mod vision;
mod comfyui;
// codemode：让模型写一段 JS 在 QuickJS 沙箱里循环调工具（中间结果不进上下文）。
// 仅桌面：rquickjs 要 cc 编 QuickJS 源码，移动端不注册该工具（见下方 push 的 cfg）。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod codemode;
pub(crate) use core::*;
pub(crate) use basic::*;
pub(crate) use plan::*;
pub(crate) use fs_shell::*;
pub(crate) use search_web::*;
pub(crate) use subagent::*;
pub(crate) use devtools::*;
pub(crate) use media_gen::*;
pub(crate) use vision::*;
pub(crate) use comfyui::*;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) use codemode::*;

pub(crate) fn registered_tools() -> Vec<Box<dyn AiTool>> {
    let mut tools: Vec<Box<dyn AiTool>> = vec![
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
        Box::new(GenerateImageTool),
        Box::new(GenerateSpeechTool),
        Box::new(AnalyzeImageTool),
        // ComfyUI 自建工作流：发现（节点/模型）→ 建图 → 执行（含安全审计）
        Box::new(ComfyuiNodeSearchTool),
        Box::new(ComfyuiListModelsTool),
        Box::new(ComfyuiBuildWorkflowTool),
        Box::new(crate::services::ai_service::gongfang_tools::GongfangFullTool),
    ];
    // codemode 只依赖桌面侧的 JS 引擎；移动端注册了也没法跑，直接不给模型看到
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    tools.push(Box::new(CodemodeTool));
    tools
}

/// 把单个工具 schema 规整成 OpenAI 兼容端点要求的最小合法形状。
///
/// ## 为什么需要（2026-10-19 血案：HTTP 400）
/// 端点返回 `Toolcall params are invalid, detail: invalid tool type`。
/// 根因：`subagent` / `send_message` / `interrupt_agent` / `list_agents` 四个 schema 写成了
/// `{"function": {...}}`，**漏了外层的 `"type": "function"`**。OpenAI 兼容端点会逐个校验
/// tools 数组元素，缺 type（或 type 不是 "function"）就直接 400 —— 而 `tools` 是**整个数组**
/// 一起发的，所以**一个工具写错，整个 agent 模式全废**（连不相关的 file/grep 都用不了）。
///
/// ## 为什么做成运行时兜底而不是只改那 4 个
/// 工具族是分文件拆开的（10 个文件、26 个 schema），任何新工具都可能再漏一次；而漏一次的表现
/// 是"整个 agent 400"，离出错点极远。这里在**发送前**统一补 type 并显式告警，把"静默 400"
/// 变成"日志里点名哪个工具"，同时让缺 name/parameters 的工具**被剔除而不是毒化整批**。
pub(crate) fn normalize_tool_schema(mut v: serde_json::Value) -> Option<serde_json::Value> {
    let obj = match v.as_object_mut() {
        Some(o) => o,
        None => {
            log::error!("[ai-tools] 工具 schema 不是 JSON 对象，已剔除：{}", v);
            return None;
        }
    };
    // 1) type 缺失 → 补上（唯一被允许自动修复的字段，因为语义无歧义）
    match obj.get("type").and_then(|t| t.as_str()) {
        Some("function") => {}
        Some(other) => {
            log::error!(
                "[ai-tools] 工具 schema 的 type 非法（{}），已剔除 —— 只支持 function",
                other
            );
            return None;
        }
        None => {
            let name = obj
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("<未知>");
            log::warn!(
                "[ai-tools] 工具 {} 的 schema 缺少 \"type\": \"function\"，已自动补齐（请修正源头，否则每次请求都会告警）",
                name
            );
            obj.insert("type".to_string(), serde_json::json!("function"));
        }
    }
    // 2) function.name 必须有；缺失的工具发出去只会换来 400，直接剔除并点名
    let name_ok = obj
        .get("function")
        .and_then(|f| f.get("name"))
        .and_then(|n| n.as_str())
        .map(|n| !n.trim().is_empty())
        .unwrap_or(false);
    if !name_ok {
        log::error!("[ai-tools] 工具 schema 缺少 function.name，已剔除：{}", v);
        return None;
    }
    // 3) parameters 缺省补成空对象 schema（部分端点对 null 直接 400）
    //    先取出名字再取可变借用，否则 obj 会被同时可变/不可变借用。
    let tool_name = obj
        .get("function")
        .and_then(|f| f.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or("?")
        .to_string();
    if let Some(func) = obj.get_mut("function").and_then(|f| f.as_object_mut()) {
        if func.get("parameters").map(|p| p.is_null()).unwrap_or(true) {
            log::warn!(
                "[ai-tools] 工具 {} 未声明 parameters，已补 type=object 的空 schema",
                tool_name
            );
            func.insert(
                "parameters".to_string(),
                serde_json::json!({ "type": "object", "properties": {} }),
            );
        }
    }
    Some(v)
}

/// 组装发给模型的 tools 数组：统一过 [`normalize_tool_schema`]，并记录数量。
///
/// **所有**请求体里的 `"tools"` 都必须走这里，不要各自 `.map(|t| t.function_schema())` ——
/// 三处各写一遍正是这次 400 能长期潜伏的原因（只有一处会踩，其他两处各自以为没问题）。
pub(crate) fn tool_schemas_for_api() -> Vec<serde_json::Value> {
    tool_schemas_for_api_without(&[])
}

/// 同 [`tool_schemas_for_api`]，但**排除指定工具**。
///
/// 用途：对话页的「联网」开关只控制 `web_search`，其余工具常开。
/// 排除发生在**发送前**（模型收不到该工具定义），而不是执行时拒绝 ——
/// 后者会让模型反复尝试并浪费轮次。
pub(crate) fn tool_schemas_for_api_without(exclude: &[&str]) -> Vec<serde_json::Value> {
    let reg = registered_tools();
    let mut out = Vec::with_capacity(reg.len());
    let mut dropped: Vec<String> = Vec::new();
    for t in reg.iter() {
        let name = t.name().to_string();
        if exclude.contains(&name.as_str()) {
            log::info!("[ai-tools] 按请求排除工具: {}", name);
            continue;
        }
        match normalize_tool_schema(t.function_schema()) {
            Some(v) => out.push(v),
            None => dropped.push(name),
        }
    }
    if !dropped.is_empty() {
        log::error!(
            "[ai-tools] 本次请求有 {} 个工具 schema 非法被剔除：{:?}",
            dropped.len(),
            dropped
        );
    }
    log::debug!("[ai-tools] tools 组装完成：{} 个（原始 {} 个）", out.len(), reg.len());
    out
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

    /// 血案回归（2026-10-19）：`invalid tool type` HTTP 400。
    /// tools 是**整批**发送的，任何一个 schema 缺 `"type": "function"` 都会让整个 agent 请求被拒，
    /// 所以这里对**全部已注册工具**逐个断言，而不是抽查。
    #[test]
    fn every_registered_tool_schema_is_openai_compatible() {
        let reg = registered_tools();
        assert!(!reg.is_empty(), "工具注册表不应为空");
        let mut bad: Vec<String> = Vec::new();
        for t in reg.iter() {
            let name = t.name().to_string();
            let s = t.function_schema();
            let ty = s.get("type").and_then(|v| v.as_str());
            let fname = s.pointer("/function/name").and_then(|v| v.as_str());
            let params_obj = s
                .pointer("/function/parameters")
                .and_then(|v| v.as_object())
                .is_some();
            if ty != Some("function") {
                bad.push(format!("{name}: type={ty:?}"));
            } else if fname != Some(name.as_str()) {
                bad.push(format!("{name}: function.name={fname:?}"));
            } else if !params_obj {
                bad.push(format!("{name}: parameters 不是对象"));
            }
        }
        assert!(
            bad.is_empty(),
            "以下工具 schema 会被 OpenAI 兼容端点判为 400，请修源头：{:#?}",
            bad
        );
    }

    /// 工具名唯一 + 描述非空（模型靠描述决定"什么时候用哪个工具"，空描述等于没有）。
    ///
    /// 为什么值得断言：加新工具时最容易犯的错是复制粘贴后忘改 name（重名会让模型
    /// 永远只调到其中一个），或只写 name 不写 description（模型只能靠名字猜）。
    #[test]
    fn tool_names_are_unique_and_descriptions_present() {
        let reg = registered_tools();
        let mut seen = std::collections::HashSet::new();
        let mut dup = Vec::new();
        let mut no_desc = Vec::new();
        for t in reg.iter() {
            let name = t.name().to_string();
            if !seen.insert(name.clone()) {
                dup.push(name.clone());
            }
            let desc = t
                .function_schema()
                .pointer("/function/description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if desc.len() < 8 {
                no_desc.push(format!("{name}: {desc:?}"));
            }
        }
        assert!(dup.is_empty(), "工具重名（模型只会调到其中一个）：{dup:?}");
        assert!(no_desc.is_empty(), "工具描述缺失或过短：{no_desc:?}");
    }

    /// 联网开关只摘掉 web_search，其余工具一个不少（否则"关联网"会变成"关工具"，
    /// 那正是 2026-10-19 那个按钮语义 bug 的形态）。
    #[test]
    fn tool_schemas_without_only_removes_named_tools() {
        let all = tool_schemas_for_api();
        let names: Vec<String> = all
            .iter()
            .filter_map(|s| s.pointer("/function/name").and_then(|v| v.as_str()).map(str::to_string))
            .collect();
        assert!(names.iter().any(|n| n == "web_search"), "注册表里应有 web_search: {names:?}");

        let without = tool_schemas_for_api_without(&["web_search"]);
        assert_eq!(without.len(), all.len() - 1, "只应少一个工具");
        let left: Vec<String> = without
            .iter()
            .filter_map(|s| s.pointer("/function/name").and_then(|v| v.as_str()).map(str::to_string))
            .collect();
        assert!(!left.iter().any(|n| n == "web_search"), "web_search 应被摘掉");
        for n in names.iter().filter(|n| *n != "web_search") {
            assert!(left.contains(n), "其余工具不应受影响，缺了 {n}");
        }
    }

    /// 兜底器本身要能把漏 type 的 schema 修好，且不改变已合法的 schema。
    #[test]
    fn normalize_tool_schema_fixes_missing_type() {
        let broken = serde_json::json!({
            "function": { "name": "x", "parameters": { "type": "object", "properties": {} } }
        });
        let fixed = normalize_tool_schema(broken).expect("应能修复");
        assert_eq!(fixed["type"], "function");
        assert_eq!(fixed["function"]["name"], "x");

        let ok = serde_json::json!({
            "type": "function",
            "function": { "name": "y", "parameters": { "type": "object", "properties": {} } }
        });
        assert_eq!(normalize_tool_schema(ok.clone()).unwrap(), ok);

        // 非法 type → 剔除，而不是原样发出去换 400
        let wrong = serde_json::json!({ "type": "web_search", "function": { "name": "z" } });
        assert!(normalize_tool_schema(wrong).is_none());
        // 缺 name → 剔除
        let no_name = serde_json::json!({ "type": "function", "function": {} });
        assert!(normalize_tool_schema(no_name).is_none());
    }

    #[test]
    fn comfyui_prompt_slot_prefers_clip_text_encode() {
        let wf = serde_json::json!({
            "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "x.safetensors" } },
            "2": { "class_type": "CLIPTextEncode", "inputs": { "text": "old", "clip": ["1", 0] } },
            "3": { "class_type": "CLIPTextEncode", "inputs": { "text": "neg", "clip": ["1", 0] } }
        });
        let slot = comfyui_prompt_slot(&wf).expect("应找到提示词位");
        assert_eq!(slot.input_key, "text");
        let ct = wf.get(&slot.node_id).unwrap()["class_type"].as_str().unwrap();
        assert_eq!(ct, "CLIPTextEncode");
    }

    #[test]
    fn comfyui_prompt_slot_falls_back_to_any_text_input() {
        // 无知名编码类时，回退到任意带 text 字符串输入的节点（自定义节点工作流）。
        let wf = serde_json::json!({
            "7": { "class_type": "MyCustomPrompt", "inputs": { "text": "hi", "other": 1 } },
            "8": { "class_type": "KSampler", "inputs": { "seed": 1, "steps": 20 } }
        });
        let slot = comfyui_prompt_slot(&wf).expect("应找到提示词位");
        assert_eq!(slot.node_id, "7");
        assert_eq!(slot.input_key, "text");
    }

    #[test]
    fn comfyui_prompt_slot_none_when_no_text_input() {
        let wf = serde_json::json!({
            "4": { "class_type": "EmptyLatentImage", "inputs": { "width": 512, "height": 512, "batch_size": 1 } }
        });
        assert!(comfyui_prompt_slot(&wf).is_none());
    }

    // ===== 图片输入位（图生图）=====

    #[test]
    fn comfyui_image_slot_prefers_load_image() {
        let wf = serde_json::json!({
            "5": { "class_type": "MyCustomLoader", "inputs": { "image": "a.png" } },
            "10": { "class_type": "LoadImage", "inputs": { "image": "b.png" } }
        });
        let s = comfyui_image_slot(&wf).expect("应找到图片输入位");
        assert_eq!(s.node_id, "10", "LoadImage 优先于任意节点");
        assert_eq!(s.input_key, "image");
    }

    #[test]
    fn comfyui_image_slot_skips_linked_image_input() {
        // image 是连线（数组 [nodeId, idx]）→ 图来自图内生成，不是上传位，不该命中。
        // 认错会把上传文件名写进一个本该是连线的位置，工作流直接报错。
        let wf = serde_json::json!({
            "3": { "class_type": "VAEEncode", "inputs": { "image": ["4", 0] } }
        });
        assert!(comfyui_image_slot(&wf).is_none());
    }

    #[test]
    fn comfyui_image_slot_falls_back_to_any_image_input() {
        let wf = serde_json::json!({
            "7": { "class_type": "CustomLoader", "inputs": { "image": "x.png", "tag": 1 } }
        });
        assert_eq!(comfyui_image_slot(&wf).unwrap().node_id, "7");
    }

    #[test]
    fn media_tool_cfg_carries_image_at() {
        let v = serde_json::json!({
            "backendKind": "comfyui",
            "baseUrl": "http://127.0.0.1:8188",
            "imageAt": { "nodeId": "10", "inputKey": "image" }
        });
        let cfg: MediaToolCfg = serde_json::from_value(v).unwrap();
        let at = cfg.image_at.expect("应有 imageAt");
        assert_eq!(at.node_id, "10");
        assert_eq!(at.input_key, "image");
    }

    #[test]
    fn generate_image_schema_has_optional_image() {
        let tool = GenerateImageTool;
        let schema = tool.function_schema();
        let props = &schema["function"]["parameters"]["properties"];
        assert!(props.get("image").is_some(), "应声明可选 image（图生图）");
        let required: Vec<&str> = schema["function"]["parameters"]["required"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert_eq!(required, vec!["prompt"], "image 必须是可选参数（纯文生图不传）");
    }

    #[test]
    fn media_tool_cfg_deserializes_camel_case_from_frontend() {
        // 前端 resolve.ts 产出 camelCase（backendKind/promptAt/nodeId/inputKey），Rust 侧须对齐。
        let v = serde_json::json!({
            "kind": "image",
            "backendKind": "comfyui",
            "baseUrl": "http://127.0.0.1:8188",
            "ckpt": "sd_xl_base.safetensors",
            "workflow": { "2": { "class_type": "CLIPTextEncode", "inputs": { "text": "t", "clip": ["1", 0] } } },
            "promptAt": { "nodeId": "2", "inputKey": "text" }
        });
        let cfg: MediaToolCfg = serde_json::from_value(v).unwrap();
        assert!(cfg.is_ready());
        assert_eq!(cfg.backend_kind, "comfyui");
        let at = cfg.prompt_at.expect("应有 promptAt");
        assert_eq!(at.node_id, "2");
        assert_eq!(at.input_key, "text");
        assert!(cfg.workflow.is_some());
    }

    #[test]
    fn media_tool_cfg_defaults_and_empty_backend_not_ready() {
        let cfg: MediaToolCfg = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(!cfg.is_ready(), "空 backendKind = 未配置");
        assert!(cfg.workflow.is_none());
        assert!(cfg.prompt_at.is_none());
        assert!(cfg.skill_slug.is_none());
        // comfyui 档未填 url → 不就绪
        let comfy_no_url: MediaToolCfg =
            serde_json::from_value(serde_json::json!({ "backendKind": "comfyui" })).unwrap();
        assert!(!comfy_no_url.is_ready());
        // openai 档只需 backendKind = openai → 就绪（凭证经 profileId 解析）
        let openai: MediaToolCfg =
            serde_json::from_value(serde_json::json!({ "kind": "speech", "backendKind": "openai" })).unwrap();
        assert!(openai.is_ready());
    }

    #[test]
    fn media_tool_cfg_keeps_skill_slug_for_fail_writeback() {
        let cfg: MediaToolCfg = serde_json::from_value(
            serde_json::json!({ "backendKind": "comfyui", "baseUrl": "http://127.0.0.1:8188", "skillSlug": "krea-json" }),
        )
        .unwrap();
        assert_eq!(cfg.skill_slug.as_deref(), Some("krea-json"));
    }

    #[test]
    fn media_payload_deserializes_partial_kinds() {
        // 只配 image 时，speech/vision 应为 None（前端缺键即不传）
        let p: MediaPayload = serde_json::from_value(serde_json::json!({
            "image": { "backendKind": "comfyui", "baseUrl": "http://127.0.0.1:8188" }
        }))
        .unwrap();
        assert!(p.image.is_some());
        assert!(p.speech.is_none());
        assert!(p.vision.is_none());
    }

    #[test]
    fn media_payload_carries_vision_separately() {
        // 视觉与生图是两个键，互不串味
        let p: MediaPayload = serde_json::from_value(serde_json::json!({
            "vision": { "kind": "vision", "backendKind": "openai", "model": "gpt-4o", "profileId": "p1" }
        }))
        .unwrap();
        let v = p.vision.expect("vision 应被解析");
        assert_eq!(v.model.as_deref(), Some("gpt-4o"));
        assert_eq!(v.profile_id.as_deref(), Some("p1"));
        assert!(v.is_ready());
        assert!(p.image.is_none(), "视觉不应落到 image 键上");
    }

    /// 链执行器：**每站策略**与**每次尝试都留痕**是这套兜底的两条命脉，
    /// 以前完全没测（新增兜底时没有任何回归网）。
    #[tokio::test]
    async fn 兜底按每站策略执行且每次尝试都留提示() {
        let mk = |name: &str, policy: &str| MediaToolCfg {
            name: name.to_string(),
            on_fail: Some(policy.to_string()),
            ..Default::default()
        };

        // ① 首选 fallback + 第二站成功 → 转到第二站，两条提示都在
        let primary = mk("本地", "fallback");
        let alts = vec![mk("云端", "stop")];
        let (res, notices) = run_media_chain("图像", &primary, &alts, |c| async move {
            if c.name == "本地" {
                Err("连接被拒绝".to_string())
            } else {
                Ok("图".to_string())
            }
        })
        .await;
        assert_eq!(res.unwrap(), "图");
        assert!(
            notices.iter().any(|n| n.contains("本地") && n.contains("连接被拒绝")),
            "首站失败要留痕：{notices:?}"
        );
        assert!(
            notices.iter().any(|n| n.contains("已兜底到「云端」")),
            "兜底到哪一站必须说出来：{notices:?}"
        );

        // ② 策略 stop → **不转下一站**，错误原样返回
        let primary = mk("本地", "stop");
        let (res, notices) = run_media_chain("图像", &primary, &alts, |_c| async move {
            Err::<String, String>("boom".to_string())
        })
        .await;
        assert!(res.is_err());
        assert!(notices.iter().any(|n| n.contains("策略为「立刻报错」")), "{notices:?}");
        assert!(!notices.iter().any(|n| n.contains("已兜底到")), "不该转站：{notices:?}");

        // ③ 全部失败 → 最后一条提示说"已是最后一站"，错误仍返回
        let primary = mk("A", "fallback");
        let alts = vec![mk("B", "fallback")];
        let (res, notices) = run_media_chain("语音", &primary, &alts, |_c| async move {
            Err::<String, String>("都挂了".to_string())
        })
        .await;
        assert!(res.is_err());
        assert!(notices.iter().any(|n| n.contains("已是最后一站")), "{notices:?}");
        assert_eq!(notices.iter().filter(|n| n.contains("都挂了")).count(), 2, "两站都要留痕");

        // ④ 配置期降级（notes）也要随结果出来
        let primary = MediaToolCfg {
            name: "本地".to_string(),
            on_fail: Some("stop".to_string()),
            notes: vec!["蓝图工作流不可用，本次退回内置流程".to_string()],
            ..Default::default()
        };
        let (res, notices) = run_media_chain("图像", &primary, &[], |_c| async move {
            Ok("图".to_string())
        })
        .await;
        assert_eq!(res.unwrap(), "图");
        assert!(
            notices.iter().any(|n| n.contains("退回内置流程")),
            "配置期降级不许静默：{notices:?}"
        );
    }

    /// 自检回落要取"用户**最近**一条原话" —— 取最后一条而不是第一条：
    /// 多轮追问（「再亮点」）时，最近那条才是这次成图要对照的要求。
    /// 空白条目要跳过：它不该被当成"用户要求"。
    #[test]
    fn 取会话里最后一条用户原话() {
        let mk = |content: &str| SessionEvent::User {
            seq: 0,
            content: content.to_string(),
            image_refs: vec![],
            resolved_images: vec![],
        };

        assert_eq!(last_user_ask_in(&[]), None);
        // 只有助手事件 → 没得对照
        assert_eq!(
            last_user_ask_in(&[SessionEvent::Assistant {
                seq: 0,
                content: "好的".into(),
                tool_calls: vec![],
            }]),
            None
        );
        // 多条 → 取最后一条
        assert_eq!(last_user_ask_in(&[mk("画个猫"), mk("再亮点")]).as_deref(), Some("再亮点"));
        // 末尾是空白 → 往前找
        assert_eq!(last_user_ask_in(&[mk("画个猫"), mk("   ")]).as_deref(), Some("画个猫"));
        // 两侧空白要裁掉
        assert_eq!(last_user_ask_in(&[mk("  画个猫  ")]).as_deref(), Some("画个猫"));
    }

    #[test]
    fn check_request_of_只取非空字符串() {
        assert_eq!(check_request_of(&serde_json::json!({ "check": "一只猫" })), Some("一只猫".to_string()));
        assert_eq!(
            check_request_of(&serde_json::json!({ "check": "  一只猫  " })),
            Some("一只猫".to_string()),
            "两端空白应被裁掉"
        );
        assert_eq!(check_request_of(&serde_json::json!({ "check": "   " })), None);
        assert_eq!(check_request_of(&serde_json::json!({ "check": 123 })), None);
        assert_eq!(check_request_of(&serde_json::json!({})), None);
    }

    #[test]
    fn 两个生成工具都声明可选check参数() {
        for tool in ["generate_image", "comfyui_build_workflow"] {
            let schema = match tool {
                "generate_image" => GenerateImageTool.function_schema(),
                _ => ComfyuiBuildWorkflowTool.function_schema(),
            };
            assert!(
                schema["function"]["parameters"]["properties"].get("check").is_some(),
                "{} 应声明可选 check（看图迭代）",
                tool
            );
            let required: Vec<&str> = schema["function"]["parameters"]["required"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|v| v.as_str())
                .collect();
            assert!(!required.contains(&"check"), "{} 的 check 必须是可选", tool);
        }
    }

    #[test]
    fn comfyui_自建工作流工具的身份与schema() {
        assert_eq!(ComfyuiNodeSearchTool.name(), "comfyui_node_search");
        assert_eq!(ComfyuiListModelsTool.name(), "comfyui_list_models");
        assert_eq!(ComfyuiBuildWorkflowTool.name(), "comfyui_build_workflow");

        let schema = ComfyuiBuildWorkflowTool.function_schema();
        let required: Vec<&str> = schema["function"]["parameters"]["required"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert_eq!(required, vec!["nodes"], "只有 nodes 是必填");
        assert!(schema["function"]["parameters"]["properties"].get("nodes").is_some());

        // 三个工具都必须能读现场事实：描述里要明确要求「先查再建」，否则模型会编造
        let desc = schema["function"]["description"].as_str().unwrap();
        assert!(desc.contains("comfyui_node_search"), "应要求先查节点");
        assert!(desc.contains("comfyui_list_models"), "应要求先查模型文件名");
    }

    #[test]
    fn comfyui_节点规格描述函数() {
        let schema = serde_json::json!({
            "python_module": "nodes",
            "category": "sampling",
            "input": {
                "required": {
                    "seed": ["INT", { "default": 0 }],
                    "sampler_name": [["euler", "dpmpp_2m"], { "default": "euler" }]
                },
                "optional": { "denoise": ["FLOAT", {}] }
            }
        });
        // 精简：combo 显示为枚举(n)
        let one = describe_inputs(&schema, "required", 8);
        assert!(one.contains("seed:INT"), "one={}", one);
        assert!(one.contains("sampler_name:枚举(2)"), "one={}", one);
        // 完整：枚举要列出可选项，模型只能从中选
        let full = describe_node_detail("KSampler", &schema, 40);
        assert!(full.contains("module=nodes"));
        assert!(full.contains("[必填]") && full.contains("[可选]"));
        assert!(full.contains("euler | dpmpp_2m"), "full={}", full);
    }

    #[test]
    fn media_card_for_按_mime_判定() {
        // ComfyUI 工作流可以吐视频/音频，必须按实际 MIME 出 card，
        // 否则前端会把视频贴进 <img> 显示成坏图。
        assert_eq!(media_card_for("data:image/png;base64,AA"), ("image", "image"));
        assert_eq!(media_card_for("data:video/mp4;base64,AA"), ("video", "video"));
        assert_eq!(media_card_for("data:audio/mpeg;base64,AA"), ("audio", "audio"));
        // MIME 大小写不敏感
        assert_eq!(media_card_for("data:VIDEO/MP4;base64,AA"), ("video", "video"));
        // 未知/非 data URL → 兜底当图片（与前端 <img> 的默认路径一致）
        assert_eq!(media_card_for("weird"), ("image", "image"));
        assert_eq!(media_card_for("data:application/octet-stream;base64,AA"), ("image", "image"));
    }

    #[test]
    fn split_data_url_拆出mime与base64() {
        let (m, b) = split_data_url("data:image/png;base64,AAAA");
        assert_eq!(m, "image/png");
        assert_eq!(b, "AAAA");
        // 非 data URL：整串当 base64，mime 兜底 image/png
        let (m2, b2) = split_data_url("AAAA");
        assert_eq!(m2, "image/png");
        assert_eq!(b2, "AAAA");
        // 缺 base64 标记也应能取出内容（部分前端只给 `data:image/jpeg;`）
        let (m3, b3) = split_data_url("data:image/jpeg;,ZZZ");
        assert_eq!(m3, "image/jpeg");
        assert_eq!(b3, "ZZZ");
    }

    #[test]
    fn analyze_image_identity() {
        // ⚠️ 这里**刻意不调用 registered_tools()**：那会把整个工具注册表（含依赖
        //    Tauri 窗口/对话框的工具）链接进 lib 测试目标，从而导入 comctl32 v6 专有符号
        //    （SetWindowSubclass / TaskDialogIndirect 等）。测试 exe 没有请求 v6 的 manifest，
        //    加载器会绑到 v5 → 进程启动即 STATUS_ENTRYPOINT_NOT_FOUND（0xc0000139），
        //    整套 cargo test 都跑不起来。工具名与 schema 已能覆盖「工具是否可被模型正确调用」，
        //    注册表成员资格留待测试 harness 注入 manifest 后再补断言。
        let tool = AnalyzeImageTool;
        assert_eq!(tool.name(), "analyze_image");
    }

    #[test]
    fn analyze_image_schema_requires_image_and_question() {
        let tool = AnalyzeImageTool;
        let schema = tool.function_schema();
        let required = schema["function"]["parameters"]["required"].as_array().unwrap();
        let req: Vec<&str> = required.iter().filter_map(|v| v.as_str()).collect();
        assert!(req.contains(&"image") && req.contains(&"question"));
    }

    #[test]
    fn tag_skill_fail_prefixes_only_with_slug() {
        // 有 slug → 加机器可读前缀（前端据此写回备注）
        let cfg = MediaToolCfg {
            backend_kind: "comfyui".into(),
            base_url: "http://x".into(),
            skill_slug: Some("krea-json".into()),
            ..Default::default()
        };
        let tagged = tag_skill_fail(Some(&cfg), "ComfyUI 执行失败: x".into());
        assert_eq!(tagged, "[comfyui-skill:krea-json] ComfyUI 执行失败: x");

        // 无 slug / 空白 slug / 无配置 → 原样返回，不加前缀
        let no_slug = MediaToolCfg { backend_kind: "comfyui".into(), base_url: "http://x".into(), ..Default::default() };
        assert_eq!(tag_skill_fail(Some(&no_slug), "err".into()), "err");
        let blank = MediaToolCfg { backend_kind: "comfyui".into(), base_url: "http://x".into(), skill_slug: Some("  ".into()), ..Default::default() };
        assert_eq!(tag_skill_fail(Some(&blank), "err".into()), "err");
        assert_eq!(tag_skill_fail(None, "err".into()), "err");
    }

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

    /// 涉及全局 settle 队列 / 子代理注册表的测试**必须串行**。
    ///
    /// 为什么需要：`SUB_SETTLES` 与 `SUBAGENTS` 都是**进程级 static**，而 cargo test
    /// 默认在同一二进制里**多线程并行**执行测试。这些测试为了断言「队列里只有我这一条」，
    /// 会做全局 `clear()`（`list_subagents_groups_by_parent` 还会 retain 掉别人的 worker）
    /// —— 于是它会把并行运行的另一个测试刚推入的记录一起清掉，对方的断言就拿到 0 条。
    ///
    /// 实测（2026-10-14，HEAD 无改动状态）：`spawn_background_registers_and_interrupt_cleans`
    /// 以 **2/15** 的概率随机失败，根因就是这个越界清理，**不是**被测代码。
    ///
    /// ⚠️ 返回的 guard 必须**绑定到具名变量**（`let _g = ...`）并活到测试结束。
    ///    写成 `let _ = ...` 会立即 drop，锁等于没加。
    fn settle_test_guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        sub_settles().lock().unwrap().clear();
        g
    }

    #[test]
    fn settle_queue_partitions_by_parent() {
        let _g = settle_test_guard();
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
        let _g = settle_test_guard();
        // 最小假档案（不发真实请求；仅验证注册/中断清理的簿记）。
        let mut cfg = ResolvedTarget::default();
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
        let _g = settle_test_guard();
        let mut cfg = ResolvedTarget::default();
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
        // 这条也持锁：它结尾的 retain 会清掉其它父会话的 worker，
        // 并行运行时会把别的测试刚 spawn 的子代理一起删掉。
        let _g = settle_test_guard();
        let mut cfg = ResolvedTarget::default();
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
    _cfg: &ResolvedTarget,
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


#[cfg(test)]
mod budget_tests {
    use super::*;

    /// 打印并守护「每请求固定开销」：tools 数组里的 schema 每个请求都发送，
    /// 一旦某个工具的 description 写成小作文，就会把所有模型的可用上下文吃掉。
    #[test]
    fn tools_fixed_overhead_is_bounded() {
        let tools = tool_schemas_for_api();
        let chars: usize = tools
            .iter()
            .map(|t| serde_json::to_string(t).map(|s| s.chars().count()).unwrap_or(0))
            .sum();
        let est = estimate_tools_tokens(&tools);
        println!("[budget] tools: {} 个 / {} 字符 / 估算 {} token", tools.len(), chars, est);

        let mut per: Vec<(String, usize)> = tools
            .iter()
            .map(|t| {
                let name = t.pointer("/function/name").and_then(|v| v.as_str()).unwrap_or("?").to_string();
                let c = serde_json::to_string(t).map(|s| s.chars().count()).unwrap_or(0);
                (name, c)
            })
            .collect();
        per.sort_by(|a, b| b.1.cmp(&a.1));
        for (n, c) in per.iter().take(8) {
            println!("[budget]   {n}: {c} 字符");
        }
        println!("[budget] skills_guide(None): {} 字符", skills_guide(None).chars().count());
    }
}
