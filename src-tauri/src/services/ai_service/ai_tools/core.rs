//! ai_tools 子模块 · core —— 工具执行底座：ToolContext / 媒体配置 / 执行调度 / 参数校验 / AiTool trait
//!
//! 由 ai_tools.rs（5245 行）按工具族机械拆分而来，逻辑零改动。
//! 父模块的 use 导入与共享项经 `use super::*` 取得；这里的顶层项统一 pub(crate)，
//! 由 ai_tools.rs 的 `pub(crate) use <mod>::*` 转出，外部引用路径不变。
#![allow(unused_imports)] //  glob 取父模块导入，按族切分后必有剩余，逐个删只会漏
use super::*;

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
    /// 本轮请求的媒体后端配置（前端每次 agent 请求时解析后传入；Rust 侧读不到
    /// 前端 localStorage，故走参数通道）。按能力分区：image / speech / vision。
    /// 前端已按「只降未配置」规则选定后端，Rust 只执行不降级。
    pub(crate) media: MediaPayload,
    /// 用户**本轮**发来的图片（data URL）。`analyze_image` 工具按序号引用它们，
    /// 避免把数 MB base64 塞进模型上下文。子代理不继承（任务不同）。
    pub(crate) images: Vec<String>,
}

/// 媒体配置集合：能力 → 已选定的后端配置。缺某能力键 = 该能力未配置后端。
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct MediaPayload {
    pub(crate) image: Option<MediaToolCfg>,
    pub(crate) speech: Option<MediaToolCfg>,
    pub(crate) vision: Option<MediaToolCfg>,
    /// 每个能力的**后备站**（不含首选，按链顺序）。
    ///
    /// ## 为什么兜底必须在 Rust 侧做
    /// 前端只负责"选谁"，它在发请求时就退场了 —— **只有 Rust 知道这一站成没成**。
    /// 所以"每站策略"的执行点只能在这里。
    #[serde(default)]
    pub(crate) fallbacks: MediaFallbacks,
}

/// 各能力的后备站列表（`MediaPayload.fallbacks` 的形状）。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct MediaFallbacks {
    pub(crate) image: Vec<MediaToolCfg>,
    pub(crate) speech: Vec<MediaToolCfg>,
    pub(crate) vision: Vec<MediaToolCfg>,
}

/// 提示里指认某站用哪个名字。
pub(crate) fn station_label(cfg: &MediaToolCfg) -> String {
    if !cfg.name.trim().is_empty() {
        return cfg.name.trim().to_string();
    }
    if cfg.base_url.trim().is_empty() {
        format!("{}（档案自带端点）", cfg.backend_kind)
    } else {
        format!("{}·{}", cfg.backend_kind, cfg.base_url.trim())
    }
}

/// 错误文本压成一行短句（提示里塞完整堆栈既难读又浪费 token）。
pub(crate) fn brief_err(e: &str) -> String {
    let one = e.split_whitespace().collect::<Vec<_>>().join(" ");
    let s: String = one.chars().take(140).collect();
    if one.chars().count() > 140 {
        format!("{s}…")
    } else {
        s
    }
}

/// 按链执行一次媒体调用，并把**每一次兜底/放弃都记成提示**。
///
/// 规则（每站策略）：
/// - 成功 → 返回；若不在第一站，记一条"已兜底到 X"
/// - 失败 + 该站 `on_fail == "fallback"` + 还有下一站 → 记一条并继续
/// - 失败 + 否则 → 记一条并返回错误
///
/// ⚠️ **提示必须随结果一起交回**（由工具文本呈现给用户 + 打日志）。
/// 静默兜底是最坏的一种：用户以为走的是他配的第一站，实际在花另一家的钱。
pub(crate) async fn run_media_chain<T, F, Fut>(
    kind_label: &str,
    primary: &MediaToolCfg,
    alts: &[MediaToolCfg],
    mut call: F,
) -> (Result<T, String>, Vec<String>)
where
    F: FnMut(MediaToolCfg) -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let mut stations: Vec<MediaToolCfg> = Vec::with_capacity(1 + alts.len());
    stations.push(primary.clone());
    stations.extend_from_slice(alts);
    let total = stations.len();
    let mut notices: Vec<String> = Vec::new();
    for (i, cfg) in stations.iter().enumerate() {
        let label = station_label(cfg);
        // 配置期降级（"工作流读不出来，退回内置流程"）**必须随结果呈现**，
        // 否则用户会以为用的是他配好的流程 —— 这类误解比报错更难发现。
        for n in &cfg.notes {
            notices.push(format!("{kind_label}：「{label}」{n}"));
        }
        match call(cfg.clone()).await {
            Ok(v) => {
                if i > 0 {
                    notices.push(format!("{kind_label}：已兜底到「{label}」（第 {}/{} 站）", i + 1, total));
                }
                return (Ok(v), notices);
            }
            Err(e) => {
                let policy_fallback = cfg.on_fail.as_deref() == Some("fallback");
                if policy_fallback && i + 1 < total {
                    notices.push(format!(
                        "{kind_label}：「{label}」失败（{}）；按策略转下一站",
                        brief_err(&e)
                    ));
                    continue;
                }
                let why = if policy_fallback { "已是最后一站" } else { "策略为「立刻报错」" };
                notices.push(format!("{kind_label}：「{label}」失败（{}）；{why}", brief_err(&e)));
                return (Err(e), notices);
            }
        }
    }
    (Err(format!("{kind_label}：链里没有任何可用后端")), notices)
}

/// 把运行期提示拼进工具文本 —— **有就呈现，同时打日志**。
///
/// 这是"所有兜底/降级/警告都必须显式"的统一出口（用户 2026-10-17 明确要求）。
/// 不要在各处自己拼字符串：拼法一散，就会有人漏。
/// 失败时把提示一并塞进错误文本 —— 兜底过程本身也是信息（"试过哪两站、各自为什么失败"）。
pub(crate) fn err_with_notices(e: String, notices: &[String]) -> String {
    if notices.is_empty() {
        return e;
    }
    for n in notices {
        eprintln!("[media] {n}");
    }
    format!(
        "{}\n\n{}",
        e,
        notices.iter().map(|n| format!("⚠️ {n}")).collect::<Vec<_>>().join("\n")
    )
}

pub(crate) fn with_notices(text: String, notices: &[String]) -> String {
    if notices.is_empty() {
        return text;
    }
    for n in notices {
        eprintln!("[media] {n}");
    }
    format!(
        "{}\n\n{}",
        text,
        notices.iter().map(|n| format!("⚠️ {n}")).collect::<Vec<_>>().join("\n")
    )
}

/// 工作流里一个「输入端」的定位（node_id + input_key）。
///
/// 提示词位与**图片位**共用此结构，故名字取通用的 Slot。由前端
/// `analyzeWorkflowParameters` 解析产出（前端有 /object_info，能准确判 upload 类型），
/// 避免 Rust 侧重复实现节点类型启发式。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComfyuiSlot {
    pub(crate) node_id: String,
    pub(crate) input_key: String,
}

/// generate_image / generate_speech 工具的媒体配置（前端 resolve.ts 解析结果的 Rust 侧镜像）。
///
/// 关键约定（与用户对齐）：**路由决策在前端完成**——前端按「后端清单 + 路由表」及
/// 「只降未配置、失败不转」的规则选定一个后端，Rust 只执行、不做任何降级决策。
/// 因此本结构是「已选定的一个后端」的最小描述，含 backend_kind 以便走对应实现分支。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct MediaToolCfg {
    /// 能力类别（image / speech），仅作日志与提示用。
    pub(crate) kind: String,
    /// 后端类型：comfyui / openai。
    pub(crate) backend_kind: String,
    /// 端点：comfyui 为 http://127.0.0.1:8188；openai 档通常为空（走档案凭证）。
    pub(crate) base_url: String,
    /// openai 档的直接 api key（前端一般不传，改走 profile_id 由 Rust 解析）。
    pub(crate) api_key: String,
    /// 后端的**显示名**（前端条目的 name）。只用于运行期提示里指认是哪一站 ——
    /// 报"本地 ComfyUI 失败"比报"comfyui·http://127.0.0.1:8188 失败"有用得多。
    #[serde(default)]
    pub(crate) name: String,
    /// **配置期**的降级说明（前端在发请求之前就已经降级了，如"蓝图工作流读不出来，
    /// 退回内置流程"）。前端没有面向用户的通道，所以带过来由这里并进运行期提示 ——
    /// 否则用户会以为画出来的是他配好的工作流。
    #[serde(default)]
    pub(crate) notes: Vec<String>,
    /// 链里执行失败后怎么办：`"stop"` = 立刻报错（默认给本地后端），
    /// `"fallback"` = 转下一站（默认给云端）。兜底决策只能在 Rust 侧做 ——
    /// 前端在发请求时就退场了，它不知道这一站到底成没成。
    pub(crate) on_fail: Option<String>,
    /// ComfyUI：checkpoint 模型文件名。**空串是正常值** = 让后端自动挑一个
    /// （见 `multimodal_service::resolve_checkpoint_choice`）。
    pub(crate) ckpt: String,
    /// 「生成后自动自检」开关（设置页那一处；`None` = 用默认，**默认开**）。
    ///
    /// 为什么挂在 cfg 上：Rust 读不到前端 localStorage，媒体配置本来就走参数通道下发。
    /// 挂在 image 档是因为自检只发生在**出图之后**，两条出图路径（`generate_image` /
    /// `comfyui_build_workflow`）读的都是 `ctx.media.image`。
    pub(crate) selfcheck: Option<bool>,
    /// ComfyUI 内置流程的采样参数（采样器/调度器/步数/CFG/尺寸）。
    /// 来源是「本地生图」面板那一处配置，与面板上手动「生成」用的是同一套 ——
    /// 否则同一个内建流程会出现"面板里选 dpmpp、让 AI 画却还是 euler"的错位。
    pub(crate) txt2img: Option<crate::services::multimodal_service::Txt2imgOptions>,
    /// ComfyUI：蓝图工作流文件路径（解析用，传给 Rust 后已转成 workflow）。
    pub(crate) workflow_path: String,
    /// ComfyUI：蓝图指定的 API 工作流（完整节点图）。
    pub(crate) workflow: Option<serde_json::Value>,
    /// ComfyUI：提示词写入位（workflow 存在时）。
    pub(crate) prompt_at: Option<ComfyuiSlot>,
    /// ComfyUI：**图片输入位**（图生图/重绘/ControlNet 用）。缺省则可回落到
    /// `comfyui_image_slot` 的名字启发式；两者都没有说明该工作流不吃图片输入。
    pub(crate) image_at: Option<ComfyuiSlot>,
    /// ComfyUI：用户**已放行**的自定义节点模块名（`object_info` 的 `python_module` 原文）。
    ///
    /// 只在 AI 自建工作流的安全审计里消费。⚠️ 必须来自用户设置——
    /// 若改成模型的工具参数，模型就能自行放行，审计形同虚设。
    #[serde(default)]
    pub(crate) allowed_custom: Vec<String>,
    /// 蓝图工作流的技能包 slug（备注键）。失败时随错误上报，前端写回备注。
    pub(crate) skill_slug: Option<String>,
    /// openai 档：该能力的模型名（image → 图片模型，speech → TTS 模型）。
    pub(crate) model: Option<String>,
    /// openai 档：引用哪个档案取凭证（Rust 据此解析，避免前端传 key）。
    pub(crate) profile_id: Option<String>,
}

impl MediaToolCfg {
    /// 最终就绪判定（防御性兜底）：前端已按路由表选好后端，此处只需确认本次调用
    /// 有可用的执行路径——comfyui 要端点、openai 要能被识别。
    pub(crate) fn is_ready(&self) -> bool {
        match self.backend_kind.as_str() {
            "comfyui" => !self.base_url.trim().is_empty(),
            "openai" => true,
            _ => false,
        }
    }
}

/// 失败原因里携带技能包 slug 的机器可读前缀（前端解析后写回备注）。
/// 形如 `[comfyui-skill:krea-afterlight-json] ComfyUI 执行失败: ...`。
pub(crate) const SKILL_FAIL_PREFIX: &str = "[comfyui-skill:";

/// 若本轮配置带了技能包 slug，给失败原因加上前缀（供前端写回备注）。
/// 无 slug 时原样返回——写回是增强，不该影响错误文本的可读性。
pub(crate) fn tag_skill_fail(cfg: Option<&MediaToolCfg>, err: String) -> String {
    match cfg.and_then(|c| c.skill_slug.as_deref()).filter(|s| !s.trim().is_empty()) {
        Some(slug) => format!("{}{}] {}", SKILL_FAIL_PREFIX, slug.trim(), err),
        None => err,
    }
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
pub(crate) fn is_side_effect_tool(name: &str) -> bool {
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
pub(crate) fn json_type_name(v: &serde_json::Value) -> &'static str {
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
