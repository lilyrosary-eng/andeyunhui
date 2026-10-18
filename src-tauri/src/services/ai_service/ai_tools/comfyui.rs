//! ai_tools 子模块 · comfyui —— ComfyUI 自建工作流三件套：节点/模型发现 → 建图 → 执行（含安全审计）
//!
//! 由 ai_tools.rs（5245 行）按工具族机械拆分而来，逻辑零改动。
//! 父模块的 use 导入与共享项经 `use super::*` 取得；这里的顶层项统一 pub(crate)，
//! 由 ai_tools.rs 的 `pub(crate) use <mod>::*` 转出，外部引用路径不变。
#![allow(unused_imports)] //  glob 取父模块导入，按族切分后必有剩余，逐个删只会漏
use super::*;

// ========== ComfyUI 自建工作流工具（AI 自主建图）==========
//
// 三个工具构成「发现 → 建图 → 执行」的最小闭环，对应公开实现的共同结论：
// **不要让模型直接写原生 JSON**（数字节点 id + 位置式连线是 LLM 最稳定的失败点）。
//
//   comfyui_node_search    —— 查现场**真实存在**的节点与输入规格（Discover, don't guess）
//   comfyui_list_models    —— 查现场**真实存在**的模型文件名（不许编）
//   comfyui_build_workflow —— 提交**中间表示**的图，由 Rust 编译 + 安全审计 + 执行
//
// ⚠️ 安全：自定义节点可执行任意 Python；审计分两层（高危直接拒 / 自定义需用户放行），
//    未经用户同意的自定义节点不会被提交。详见 comfyui_build.rs。

/// 取 ComfyUI 生图后端的配置；不是 comfyui 档就明确报错（别让模型以为能建图）。
pub(crate) fn comfy_cfg_of(ctx: &ToolContext) -> Result<&MediaToolCfg, String> {
    match ctx.media.image.as_ref().filter(|c| c.is_ready()) {
        Some(c) if c.backend_kind == "comfyui" && !c.base_url.trim().is_empty() => Ok(c),
        _ => Err(
            "未配置 ComfyUI 本地生图后端，无法读取或自建工作流。请在设置 → 模型 → 媒体后端里添加 ComfyUI 并绑定到「图像」能力"
                .to_string(),
        ),
    }
}

/// 把一个节点规格压缩成一行：`名字:类型`，combo 类型显示可选项个数。
pub(crate) fn describe_inputs(schema: &serde_json::Value, section: &str, limit: usize) -> String {
    let Some(obj) = schema.pointer(&format!("/input/{}", section)).and_then(|v| v.as_object()) else {
        return String::new();
    };
    let mut parts: Vec<String> = Vec::new();
    for (name, spec) in obj {
        if parts.len() >= limit {
            parts.push("…".to_string());
            break;
        }
        let ty = match spec.get(0) {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Array(a)) => format!("枚举({})", a.len()),
            Some(other) => other.to_string(),
            None => "?".to_string(),
        };
        parts.push(format!("{}:{}", name, ty));
    }
    parts.join(", ")
}

/// 单个节点的**完整**输入规格（必填 + 可选），枚举类给出可选项（截断）。
pub(crate) fn describe_node_detail(class_type: &str, schema: &serde_json::Value, combo_limit: usize) -> String {
    let mut out = format!("{}", class_type);
    if let Some(m) = schema.get("python_module").and_then(|v| v.as_str()) {
        out.push_str(&format!("  (module={})", m));
    }
    for section in ["required", "optional"] {
        let Some(obj) = schema.pointer(&format!("/input/{}", section)).and_then(|v| v.as_object()) else {
            continue;
        };
        out.push_str(&format!("\n[{}]", if section == "required" { "必填" } else { "可选" }));
        for (name, spec) in obj {
            let ty = match spec.get(0) {
                Some(serde_json::Value::String(s)) => s.clone(),
                // ComfyUI combo 形如 ["ENUM_A","ENUM_B"]：这里只标类型，
                // 可选项由紧接着的那段专门展开（带 combo_limit 截断）。
                Some(serde_json::Value::Array(_)) => "枚举".to_string(),
                Some(other) => other.to_string(),
                None => "?".to_string(),
            };
            out.push_str(&format!("\n  - {} : {}", name, ty));
            // 枚举类：把可选项列出来，模型只能从中选（比如 ckpt 文件名、采样器名）
            if let Some(arr) = spec.get(0).and_then(|v| v.as_array()) {
                let opts: Vec<&str> = arr
                    .iter()
                    .filter_map(|x| x.as_str())
                    .take(combo_limit)
                    .collect();
                if !opts.is_empty() {
                    out.push_str(&format!("\n      可选: {}", opts.join(" | ")));
                    if arr.len() > combo_limit {
                        out.push_str(&format!(" …共 {} 项", arr.len()));
                    }
                }
            }
        }
    }
    out
}

/// 搜索本机 ComfyUI 的节点。
///
/// 两种模式：`query` 恰好等于某个 class_type → 返回该节点的**完整输入规格**（含枚举可选项）；
/// 否则按关键词做**模糊列出**（精简一行一个）。这样 3 个工具就够用，不必再加一个 node_info。
pub(crate) struct ComfyuiNodeSearchTool;
#[async_trait::async_trait]
impl AiTool for ComfyuiNodeSearchTool {
    fn name(&self) -> &'static str {
        "comfyui_node_search"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "在用户本机 ComfyUI 里查询**真实存在**的节点及其输入规格。自己搭建工作流前**必须先查**——节点名、输入名、以及枚举型输入的可选值（如 checkpoint 文件名、采样器名）都只能来自这里，凭空编造会直接导致执行失败。query 传节点名做精确查询（返回完整输入规格 + 枚举可选项）；传关键词（如 sampling / latent / upscale / lora）则模糊列出匹配的节点。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "节点名（精确）或关键词（模糊）。传空字符串列出全部节点名。" }
                    },
                    "required": ["query"]
                }
            }
        })
    }
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let q: String = args.get("query").and_then(|v| v.as_str()).unwrap_or("").chars().take(24).collect();
        serde_json::json!({ "card": "generic", "kind": "other", "title": format!("查询节点 {}", q) })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let base = comfy_cfg_of(ctx)?.base_url.clone();
        let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let info = crate::services::multimodal_service::comfyui_object_info(base).await?;
        let obj = info.as_object().ok_or_else(|| "ComfyUI object_info 返回形状异常（不是对象）".to_string())?;

        // 精确命中 → 完整规格
        if let Some(schema) = obj.get(&query) {
            return Ok(ToolExecResult::plain(describe_node_detail(&query, schema, 40)));
        }
        // 模糊列出
        let q = query.to_ascii_lowercase();
        const MAX_LIST: usize = 60;
        let mut hits: Vec<String> = Vec::new();
        let mut total = 0usize;
        for (ct, schema) in obj {
            let category = schema.get("category").and_then(|v| v.as_str()).unwrap_or("");
            if !q.is_empty()
                && !ct.to_ascii_lowercase().contains(&q)
                && !category.to_ascii_lowercase().contains(&q)
            {
                continue;
            }
            total += 1;
            if hits.len() >= MAX_LIST {
                continue;
            }
            let req = describe_inputs(schema, "required", 8);
            let module = schema.get("python_module").and_then(|v| v.as_str()).unwrap_or("");
            let custom = if module.is_empty() || module.eq_ignore_ascii_case("nodes") {
                String::new()
            } else {
                format!("  ⚠️自定义({})", module)
            };
            hits.push(format!("- {}  [{}]  必填: {}{}", ct, category, req, custom));
        }
        if hits.is_empty() {
            return Ok(ToolExecResult::plain(format!(
                "没有匹配「{}」的节点。换关键词，或传空字符串列出全部节点名。",
                query
            )));
        }
        let more = if total > hits.len() { format!("\n（共 {} 个匹配，只列了前 {} 个）", total, hits.len()) } else { String::new() };
        Ok(ToolExecResult::plain(format!(
            "匹配到 {} 个节点：\n{}{}\n\n要某个节点的完整输入规格（含枚举可选项），把它的名字作为 query 再查一次。",
            total,
            hits.join("\n"),
            more
        )))
    }
}

/// 列出本机 ComfyUI 已安装的模型文件。
///
/// 存在的意义只有一条：**不许编文件名**。`ckpt_name` / `lora_name` 这类字段必须
/// 与这里的返回值逐字一致（含子目录前缀）。
pub(crate) struct ComfyuiListModelsTool;
#[async_trait::async_trait]
impl AiTool for ComfyuiListModelsTool {
    fn name(&self) -> &'static str {
        "comfyui_list_models"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "列出用户本机 ComfyUI 已安装的模型文件。搭工作流时凡是填模型文件名的输入（如 CheckpointLoaderSimple.ckpt_name、LoraLoader.lora_name），**必须**用这里的返回值原文，不能自己编。不传 folder 时返回按类型分组的全量清单。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "folder": { "type": "string", "description": "（可选）只列某一类，如 checkpoints / loras / vae / controlnet / upscale_models" }
                    },
                    "required": []
                }
            }
        })
    }
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let f = args.get("folder").and_then(|v| v.as_str()).unwrap_or("");
        serde_json::json!({ "card": "generic", "kind": "other", "title": format!("列出模型 {}", f) })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let base = comfy_cfg_of(ctx)?.base_url.clone();
        let folder = args.get("folder").and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let v = crate::services::multimodal_service::comfyui_list_models(base, folder.clone()).await?;
        // 两种形状：指定 folder 时是文件名数组；不指定时是 { folder: [文件名…] }
        let text = match (&folder, &v) {
            (Some(f), serde_json::Value::Array(a)) => {
                let names: Vec<&str> = a.iter().filter_map(|x| x.as_str()).collect();
                if names.is_empty() {
                    format!("「{}」下没有任何模型文件——该类型不能用在你的工作流里。", f)
                } else {
                    format!("「{}」共 {} 个：\n{}", f, names.len(), names.iter().map(|n| format!("- {}", n)).collect::<Vec<_>>().join("\n"))
                }
            }
            (None, serde_json::Value::Object(o)) => {
                let mut parts: Vec<String> = Vec::new();
                for (k, arr) in o {
                    let names: Vec<&str> = arr.as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect()).unwrap_or_default();
                    if names.is_empty() {
                        continue;
                    }
                    parts.push(format!("【{}】{} 个：\n{}", k, names.len(), names.iter().map(|n| format!("  - {}", n)).collect::<Vec<_>>().join("\n")));
                }
                if parts.is_empty() {
                    "本机 ComfyUI 没有检测到任何模型文件。先让用户在 ComfyUI 里下载模型。".to_string()
                } else {
                    parts.join("\n\n")
                }
            }
            _ => serde_json::to_string_pretty(&v).unwrap_or_else(|_| "（无法解析模型清单）".to_string()),
        };
        Ok(ToolExecResult::plain(text))
    }
}

/// 用**中间表示**自建并执行一张 ComfyUI 工作流。
///
/// 流程：中间表示 → 编译成原生格式（分配 id、解析连线、校验必填）→ 安全审计 → 提交。
/// 取消/失败都会明确报错，不静默。
pub(crate) struct ComfyuiBuildWorkflowTool;
#[async_trait::async_trait]
impl AiTool for ComfyuiBuildWorkflowTool {
    fn name(&self) -> &'static str {
        "comfyui_build_workflow"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "自己搭建并执行一张 ComfyUI 工作流（画图/视频/音频）。用于用户的需求无法用「一句描述走现成工作流」满足时（如换采样器、加 LoRA、改尺寸、两图拼接）。\n\n**必须遵守的顺序**：先用 comfyui_node_search 查真实节点与其输入规格，用 comfyui_list_models 查真实模型文件名，再提交这里的 nodes。节点名/输入名/文件名都不许编造。\n\n节点之间用**你自己起的 key** 互相引用，连线写成 [\"对方key\", 输出序号]（从 0 开始），不要写数字 id——Rust 侧会分配。\n\n**安全**：使用非核心（自定义）节点会被拒绝并要求用户先在设置里放行；执行代码/命令类节点一律拒绝。\n\n**看结果再迭代**：填了 check 会拿到视觉模型对成图的评价。图能跑出来不代表画对了，第一次结果通常需要调参重试。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "nodes": {
                            "type": "array",
                            "description": "节点列表，按数据流顺序书写（顺序不要求拓扑排序）",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "key": { "type": "string", "description": "你自己起的唯一标识，供连线引用" },
                                    "class_type": { "type": "string", "description": "节点类名，必须来自 comfyui_node_search" },
                                    "inputs": { "type": "object", "description": "输入名 → 值。字面量直接给；连线给 [\"对方key\", 输出序号]" }
                                },
                                "required": ["key", "class_type"]
                            }
                        },
                        "check": { "type": "string", "description": "（可选）要拿来对照的画面要求原文。**留空即可**：系统会**自动用你最近收到的那条用户消息**做自检，让视觉模型看一眼成图并指出最该改的 1-3 点，你据此调整参数再跑一次 —— 这是把「能跑出图」变成「画得对」的关键一步。只有当这次要对照的不是用户最近那句话时（例如中途换了要求），才需要显式填。" }
                    },
                    "required": ["nodes"]
                }
            }
        })
    }
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let n = args.get("nodes").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
        serde_json::json!({ "card": "generic", "kind": "other", "title": format!("搭建工作流（{} 个节点）", n) })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let cfg = comfy_cfg_of(ctx)?;
        let base = cfg.base_url.clone();
        // 解析中间表示
        let nodes = args.get("nodes").cloned().ok_or_else(|| "缺少 nodes 参数".to_string())?;
        let ir: crate::services::ai_service::comfyui_build::IrGraph = serde_json::from_value(serde_json::json!({ "nodes": nodes }))
            .map_err(|e| format!("nodes 形状不对：{}（每项需要 key / class_type / 可选 inputs）", e))?;
        if ir.nodes.is_empty() {
            return Err("nodes 为空——至少要有一个节点".to_string());
        }
        // 事实来源：没有 object_info 就既不校验也不审计，因此直接拒绝执行
        let object_info = crate::services::multimodal_service::comfyui_object_info(base.clone())
            .await
            .map_err(|e| format!("无法读取 ComfyUI 节点定义，不能执行自建工作流：{}", e))?;
        let workflow = crate::services::ai_service::comfyui_build::compile_graph(&ir, Some(&object_info))?;
        // 安全审计：高危拒绝；自定义节点需用户放行（模型无法自行放行）
        let verdict = crate::services::ai_service::comfyui_build::audit_graph(&workflow, Some(&object_info), &cfg.allowed_custom);
        if !verdict.blocked.is_empty() {
            let list: Vec<String> = verdict
                .blocked
                .iter()
                .map(|b| format!("- {}（{}）：{}", b.class_type, b.node, b.reason))
                .collect();
            return Err(format!(
                "工作流被安全审计拒绝——这些节点能执行代码或系统命令，不允许用于自建工作流：\n{}\n请改用纯推理/图像处理的节点。",
                list.join("\n")
            ));
        }
        if !verdict.needs_approval.is_empty() {
            let list: Vec<String> = verdict
                .needs_approval
                .iter()
                .map(|a| {
                    if a.module.is_empty() {
                        format!("- {}（{}）", a.class_type, a.node)
                    } else {
                        format!("- {}（来自 {}）", a.class_type, a.module)
                    }
                })
                .collect();
            return Err(format!(
                "工作流用了未经用户同意的自定义节点（自定义节点可执行任意代码，不能由你自行放行）：\n{}\n请改用 ComfyUI 核心节点重搭；或请用户先在设置里放行这些节点后再试。",
                list.join("\n")
            ));
        }
        // 提交执行
        // 自建工作流里正负提示词都是模型自己写的 CLIPTextEncode 节点，这里不额外传负向词
        let data_url = crate::services::multimodal_service::comfyui_generate_media(
            None, base, None, Some(workflow), None, None,
        )
            .await?;
        let (card, kind) = media_card_for(&data_url);
        let noun = match card {
            "video" => "视频",
            "audio" => "音频",
            _ => "图片",
        };
        let text = format!(
            "{}已生成（本机 ComfyUI 自建工作流，{} 个节点，已通过安全审计），已直接展示给用户，无需转述内容。",
            noun,
            ir.nodes.len()
        );
        // 同 comfyui_build_workflow：显式 check 优先，没给就回落到用户最近一条原话。
        // 显式 check 一定跑；否则看设置里的「生成后自动自检」（默认开）。
        let explicit_check = check_request_of(args);
        let auto_on = cfg.selfcheck.unwrap_or(true);
        let auto = explicit_check.is_none();
        let check = explicit_check.or_else(|| if auto_on { last_user_ask(ctx) } else { None });
        let text = append_critique(ctx, text, &data_url, check.as_deref(), auto).await;
        let mut meta = serde_json::json!({
            "card": card,
            "kind": kind,
            "title": format!("自建工作流（{} 个节点）", ir.nodes.len()),
            "source": "comfyui-built",
        });
        meta[card] = serde_json::json!(data_url);
        Ok(ToolExecResult::with_meta(text, meta))
    }
}
