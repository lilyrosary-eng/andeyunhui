//! ComfyUI「AI 自建工作流」的两个纯逻辑核心：**中间表示编译** + **安全审计**。
//!
//! ## 为什么需要中间表示（IR）
//!
//! ComfyUI 的原生 API 格式用**数字字符串节点 id + 位置式连线**（`"positive": ["6", 0]`）。
//! 这是 LLM 最稳定的失败点：改图时会重排 id、会编造不存在的自定义节点名。
//! 公开的多个实现（ComfyUI Builder MCP / CreativeMCP / Conjurer / comfyui-llm-onboarding-prompt）
//! 结论一致：**不要让模型直接写原生 JSON**。
//!
//! 所以这里让模型按**自己起的 key** 引用节点、按输出名引用连线，
//! 由 [`compile_graph`] 在编译期分配 id、解析连线、校验必填项。
//!
//! ## 为什么需要安全审计
//!
//! ComfyUI 的自定义节点是**可执行任意 Python** 的。用户从磁盘扫进来的工作流风险可控
//! （那是用户自己的文件），但 **AI 自主生成**的图等于把「按模型意愿执行代码」的入口交出去。
//!
//! 审计分两层，判定顺序固定为「先高危、后分类」：
//!   1. **高危名单**命中 → 直接拒绝（不提供放行机会）。
//!      ⚠️ 这是**启发式拒绝名单，不是安全保证**——自定义节点可以随便改名。
//!   2. **非核心节点**（`object_info` 里 `python_module != "nodes"`）→ 需要用户显式放行。
//!      这一条才是可依赖的性质：**未经用户同意的自定义节点不会被执行**。

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

/// 单个节点的中间表示。`key` 由模型自由命名，编译期映射成数字 id。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct IrNode {
    pub key: String,
    pub class_type: String,
    #[serde(default)]
    pub inputs: Map<String, Value>,
}

/// 模型提交的整张图。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct IrGraph {
    pub nodes: Vec<IrNode>,
}

/// 审计结论里的一条「拒绝」。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BlockedNode {
    pub node: String,
    pub class_type: String,
    pub reason: String,
}

/// 审计结论里的一条「需要用户放行」。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ApprovalNode {
    pub node: String,
    pub class_type: String,
    /// 来自哪个自定义模块（`object_info` 的 `python_module`）；空表示无法判定
    pub module: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct GuardVerdict {
    pub blocked: Vec<BlockedNode>,
    pub needs_approval: Vec<ApprovalNode>,
}

impl GuardVerdict {
    /// 既无拒绝、也无需放行 —— 可以直接提交。
    pub fn is_clean(&self) -> bool {
        self.blocked.is_empty() && self.needs_approval.is_empty()
    }
}

/// 高危节点名片段（大小写不敏感的子串匹配）+ 拒绝理由。
///
/// ⚠️ 这是**启发式拒绝名单，不是安全保证**：自定义节点可以随便改名。
/// 真正可依赖的是「非核心节点一律需要用户放行」，见 [`audit_graph`]。
/// 名单的价值在于把**广为人知**的代码/命令执行节点挡在前面，
/// 让用户即便习惯性点「允许」也不会顺手放行它们。
const DANGEROUS_HINTS: &[(&str, &str)] = &[
    ("executepython", "执行任意 Python 代码"),
    ("pythonscript", "执行任意 Python 代码"),
    ("python_script", "执行任意 Python 代码"),
    ("runpython", "执行任意 Python 代码"),
    ("execeval", "动态求值"),
    ("evaluate", "动态求值"),
    ("shellcommand", "执行系统命令"),
    ("executecommand", "执行系统命令"),
    ("runcommand", "执行系统命令"),
    ("systemcommand", "执行系统命令"),
    ("subprocess", "启动子进程"),
    ("loadscript", "从任意路径加载脚本"),
    ("importmodule", "动态导入模块"),
    ("writefile", "向任意路径写文件"),
    ("savefile", "向任意路径写文件"),
    ("downloadfile", "下载文件到磁盘"),
];

/// 命中高危名单则给出拒绝理由。
fn dangerous_reason(class_type: &str) -> Option<&'static str> {
    let t = class_type.to_ascii_lowercase();
    DANGEROUS_HINTS.iter().find(|(pat, _)| t.contains(pat)).map(|(_, why)| *why)
}

/// 从 `object_info` 取该节点的 `python_module`。
/// ComfyUI 核心节点的 `python_module` 是 `"nodes"`；自定义节点是各自的包名。
fn python_module_of(object_info: Option<&Value>, class_type: &str) -> Option<String> {
    let m = object_info?.get(class_type)?.get("python_module")?.as_str()?;
    let m = m.trim();
    if m.is_empty() {
        None
    } else {
        Some(m.to_string())
    }
}

/// 审计一张**已编译**的（原生格式）工作流。
///
/// `allowed_custom` 是用户已放行的名字集合，元素可以是**自定义包名**或 **class_type**（大小写不敏感）。
///
/// `object_info` 为 `None` 时无法区分核心/自定义节点，此时**一律按需放行**处理
/// （保守方向）。调用方本就不该在拿不到 `object_info` 时执行 AI 自建的图——
/// 那样连必填输入都校验不了。
pub fn audit_graph(graph: &Value, object_info: Option<&Value>, allowed_custom: &[String]) -> GuardVerdict {
    let mut verdict = GuardVerdict::default();
    let Some(nodes) = graph.as_object() else {
        return verdict;
    };
    let allowed: Vec<String> = allowed_custom
        .iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    let is_allowed = |ct: &str, module: &str| {
        let ct = ct.to_ascii_lowercase();
        let module = module.to_ascii_lowercase();
        allowed.iter().any(|a| *a == ct || (!module.is_empty() && *a == module))
    };

    for (id, node) in nodes {
        let ct = node.get("class_type").and_then(|x| x.as_str()).unwrap_or("").trim();
        if ct.is_empty() {
            continue;
        }
        // ① 高危：直接拒绝，不给放行机会
        if let Some(why) = dangerous_reason(ct) {
            verdict.blocked.push(BlockedNode {
                node: id.clone(),
                class_type: ct.to_string(),
                reason: why.to_string(),
            });
            continue;
        }
        // ② 分类：核心节点放行；其余需要用户同意
        match python_module_of(object_info, ct) {
            Some(m) if m.eq_ignore_ascii_case("nodes") => {}
            Some(m) => {
                if !is_allowed(ct, &m) {
                    verdict.needs_approval.push(ApprovalNode {
                        node: id.clone(),
                        class_type: ct.to_string(),
                        module: m,
                    });
                }
            }
            None => {
                if !is_allowed(ct, "") {
                    verdict.needs_approval.push(ApprovalNode {
                        node: id.clone(),
                        class_type: ct.to_string(),
                        module: String::new(),
                    });
                }
            }
        }
    }
    verdict
}

/// 判断一个输入值是否是**连线**：`["<节点 key>", <输出序号>]`。
///
/// 必须要求第二项是整数 —— 原生格式里连线就是这个形状，而字面量列表
/// （如一组字符串）第二项不是数字，因此不会被误判成连线。
fn as_link(v: &Value) -> Option<(&str, u64)> {
    let a = v.as_array()?;
    if a.len() != 2 {
        return None;
    }
    let name = a[0].as_str()?;
    let idx = a[1].as_u64()?;
    Some((name, idx))
}

/// 找出「必填且**没有默认值**」却缺失的输入。
///
/// 一刀切要求全部必填会把合法的图也毙掉——ComfyUI 自己会用 `object_info`
/// 里的 `default` 补上缺失项，所以只有连默认值都没有的才必须显式给。
fn missing_required(schema: &Value, inputs: &Map<String, Value>) -> Option<String> {
    let req = schema.pointer("/input/required")?.as_object()?;
    for (name, spec) in req {
        if inputs.contains_key(name) {
            continue;
        }
        let has_default = spec.get(1).and_then(|m| m.get("default")).is_some();
        if !has_default {
            return Some(name.clone());
        }
    }
    None
}

/// 解析「源节点第 `idx` 个输出」的**声明类型**。
///
/// ComfyUI 是**强类型图**：把某节点第 N 个输出接到「期望另一种类型」的输入，整单会被
/// 拒为 400（`Return type mismatch between linked nodes`）。而 LLM 最容易犯的正是这类
/// 位置式错误 —— 典型是 `CheckpointLoaderSimple` 的 `0=MODEL / 1=CLIP / 2=VAE` 记错一位。
///
/// 返回三态，**判据刻意保守**（宁可漏判也不误拒，误拒会直接堵死 AI 建图）：
///   - `Ok(Some(t))`：明确知道类型 → 参与比较
///   - `Ok(None)`：信息不全 → **放行**。包含三种情况：没有 object_info（调用方没传）、
///     该节点没声明 `output`、`output` 是空数组、某个槽位不是字符串类型
///     （少数自定义节点的声明不规范，一律不判）
///   - `Err`：槽位**越界** —— `output` 数组非空却查不到这一号，这是明确的错误
fn resolve_output_type(schema: Option<&Value>, idx: u64) -> Result<Option<String>, String> {
    let Some(outs) = schema.and_then(|s| s.get("output")).and_then(|v| v.as_array()) else {
        return Ok(None);
    };
    if outs.is_empty() {
        return Ok(None); // 声明不规范（空数组），宁可不判
    }
    match outs.get(idx as usize) {
        Some(Value::String(t)) => Ok(Some(t.clone())),
        Some(_) => Ok(None), // 非字符串声明 → 不判
        None => Err(format!(
            "该节点只声明了 {} 个输出槽，取不到第 {} 个",
            outs.len(),
            idx
        )),
    }
}

/// 解析「目标节点某输入」的**声明类型**。
///
/// ## 声明形状（拉运行中的 ComfyUI 核对过 19909 条输入声明）
///   - `[<类型或候选数组>, <选项对象>]` —— 14567 条
///   - `[<类型或候选数组>]` —— **5341 条**（无选项时就是单元素）
///   - `[<类型>, <选项>, "说明"]` —— 1 条
///
/// ⇒ **判据只看 `spec[0]`**，不要加「必须长度 2 且第 2 项是对象」这类约束 ——
/// 那会白白跳过 5341 条合法声明（其中就有 `CLIP` 这种要判断的类型）。
///
/// - `Some(t)`：第 0 项是字符串 → 可比较
/// - `None`：**不判**。输入名不在声明里（模型自己编的输入名，交给 ComfyUI 去报），
///   或第 0 项是数组 —— 那是 COMBO（下拉框），本来就不接连线
fn resolve_input_type(schema: Option<&Value>, name: &str) -> Option<String> {
    let input = schema?.get("input")?;
    for sec in ["required", "optional"] {
        if let Some(spec) = input.get(sec).and_then(|v| v.get(name)) {
            return match spec.get(0) {
                Some(Value::String(t)) => Some(t.clone()),
                _ => None,
            };
        }
    }
    None
}

/// 通配类型：ComfyUI 里 `"*"` 表示「接受任意类型」（`AnyType`）。
/// 另外把 `"any"` 也当通配 —— 少数自定义节点这么写。两侧任一为通配即不做类型比较。
fn is_wildcard_type(t: &str) -> bool {
    let t = t.trim();
    t == "*" || t.eq_ignore_ascii_case("any")
}

/// **只能由连线提供**的类型白名单。
///
/// 用途：判断某个输入拿到了「数组字面量」时，是不是明显的填错（详见 `compile_graph` 里那段）。
///
/// ## 为什么用白名单而不是黑名单
/// 黑名单（"不是 STRING/INT/FLOAT 就当作连线型"）会把**自定义节点自创的类型名**也算进来 ——
/// 而那些类型到底能不能吃字面量，我们并不知道。白名单只覆盖 ComfyUI 标准 link 类型，
/// 不认识的一律放行。**宁可漏判，不可误拒**：误拒会把合法的自定义节点图直接堵死。
const LINK_ONLY_TYPES: &[&str] = &[
    "MODEL", "CLIP", "VAE", "CONDITIONING", "LATENT", "IMAGE", "MASK", "CONTROL_NET",
    "STYLE_MODEL", "CLIP_VISION", "CLIP_VISION_OUTPUT", "GLIGEN", "UPSCALE_MODEL",
    "SAMPLER", "SIGMAS", "GUIDER", "NOISE", "AUDIO", "VIDEO", "IPADAPTER",
];

/// 该类型是否「只能由连线提供」。大小写不敏感（自定义节点写法不一致）。
fn is_link_only_type(t: &str) -> bool {
    let t = t.trim().to_ascii_uppercase();
    LINK_ONLY_TYPES.contains(&t.as_str())
}

/// 中间表示 → ComfyUI 原生 API 格式。
///
/// 输入里 `inputs` 的值有两种：
///   - **字面量**（字符串/数字/对象…）→ 原样保留
///   - **连线** `["<节点 key>", <输出序号>]` → 编译成 `["<数字 id>", 序号]`
///
/// 出错**不静默**：key 重复、连线指向不存在的 key、自环、缺必填输入、**连线类型不匹配**
/// 都明确报错。这些正是模型最容易犯的错，静默放行只会换来一次看不懂的执行失败。
///
/// `object_info` 传 `Some` 时会多做一项**软校验**：把「源节点第 N 个输出声明的类型」
/// 与「目标输入的声明类型」比一比，明确不匹配就报错并指出是第几个输出
/// （判据保守，信息不全一律放行 —— 见 `resolve_output_type` / `resolve_input_type`）。
pub fn compile_graph(ir: &IrGraph, object_info: Option<&Value>) -> Result<Value, String> {
    if ir.nodes.is_empty() {
        return Err("图上没有任何节点".to_string());
    }
    // ① key 唯一且非空
    let mut id_of: HashMap<&str, usize> = HashMap::new();
    // key → class_type：连线类型校验要用它查「源节点声明的输出槽」
    let mut class_of: HashMap<&str, &str> = HashMap::new();
    for (i, n) in ir.nodes.iter().enumerate() {
        let key = n.key.trim();
        if key.is_empty() {
            return Err(format!("第 {} 个节点缺少 key", i + 1));
        }
        if n.class_type.trim().is_empty() {
            return Err(format!("节点 {} 缺少 class_type", key));
        }
        if id_of.insert(key, i + 1).is_some() {
            return Err(format!("节点 key 重复：{}（key 必须唯一）", key));
        }
        class_of.insert(key, n.class_type.trim());
    }
    // ② 组装 + 解析连线 + 必填校验
    //
    // ★ 错误**一次报全**，不在第一处就返回。
    //
    // 为什么：弱模型每轮通常只改一处。若第一处错误就中止，一个 3 处错的图要吃掉它 3 轮
    // （前端给 agent 的轮次预算是 8，还要分给 node_search / list_models 这些查询）。
    // 实测（2026-10-16，本地 9B）它正是这样在一轮里塞进 3~5 个工具调用的 —— 轮次很紧。
    // 所以这里把本节点的每处问题都收进 errs，最后一次性列出。
    //
    // 只有「无法继续」的错误才立即返回：空图、key 缺失/重复、class_type 缺失
    // （上面 ① 已经处理）——那些情况下连节点身份都不成立，继续收集没有意义。
    let mut errs: Vec<String> = Vec::new();
    let mut out = Map::new();
    for (i, n) in ir.nodes.iter().enumerate() {
        let id = i + 1;
        let mut inputs = Map::new();
        for (name, value) in &n.inputs {
            // None = 这个输入有问题（已记进 errs），留空占位即可。
            // ⚠️ 占位必须插入：否则下面的 `missing_required` 会因为"没这个输入"**再报一次**，
            //    同一处错误被报两遍反而更难读。
            let mut compiled: Option<Value> = None;
            match as_link(value) {
                Some((target, idx)) => {
                    let target = target.trim();
                    match id_of.get(target) {
                        None => errs.push(format!(
                            "节点 {} 的输入 {} 连到了不存在的节点 key：{}",
                            n.key, name, target
                        )),
                        Some(tid) if *tid == id => {
                            errs.push(format!("节点 {} 的输入 {} 连到了自己", n.key, name))
                        }
                        Some(tid) => {
                            // ★ 连线**类型**校验（软校验，见两个 resolve_* 的文档）。
                            //
                            // 为什么必须在提交前做：类型不匹配时 ComfyUI 只回一句
                            // `Return type mismatch between linked nodes: <输入名>, received_type(A)
                            // mismatch input_type(B)`，而 `node_errors` 里**没有槽位序号**信息 ——
                            // 模型很难从这句话反推"该把第几个输出改掉"，于是反复试错。
                            // 在这里挡下并直接给出「第几个输出 / 是什么类型 / 需要什么类型」，一次就能改对。
                            //
                            // 判据刻意保守：任一侧信息不全（无 object_info、没声明 output、
                            // 输入名不在声明里、COMBO 下拉）就**放行**。宁可漏判，不可误拒 ——
                            // 误拒会把合法的自定义节点图直接堵死，比漏判糟得多。
                            let mut link_ok = true;
                            if let Some(oi) = object_info {
                                let src_schema = class_of.get(target).and_then(|c| oi.get(*c));
                                let dst_schema = oi.get(n.class_type.trim());
                                match resolve_output_type(src_schema, idx) {
                                    Err(why) => {
                                        link_ok = false;
                                        errs.push(format!(
                                            "节点 {}（{}）的输入 {} 连到了节点 {}（{}）的第 {} 个输出，但{}",
                                            n.key, n.class_type, name, target,
                                            class_of.get(target).copied().unwrap_or("?"), idx, why
                                        ));
                                    }
                                    Ok(actual) => {
                                        let expected = resolve_input_type(dst_schema, name);
                                        if let (Some(actual), Some(expected)) = (actual, expected) {
                                            if !is_wildcard_type(&actual)
                                                && !is_wildcard_type(&expected)
                                                && actual != expected
                                            {
                                                link_ok = false;
                                                errs.push(format!(
                                                    "连线类型不匹配：节点 {}（{}）的输入 {} 需要 {}，\
                                                     但它接到了节点 {}（{}）的第 {} 个输出，那个输出是 {}。\
                                                     请改接该节点提供 {} 的那个输出（槽位序号见 comfyui_node_info 的 output）",
                                                    n.key, n.class_type, name, expected, target,
                                                    class_of.get(target).copied().unwrap_or("?"),
                                                    idx, actual, expected
                                                ));
                                            }
                                        }
                                    }
                                }
                            }
                            if link_ok {
                                compiled = Some(json!([tid.to_string(), idx]));
                            }
                        }
                    }
                }
                None => {
                    // ★ 形状校验：声明为「只能连线提供」的输入，拿到了**数组字面量**，但它
                    //   不是合法的两元素连线（长度 ≠ 2，`as_link` 已经排除了合法连线）。
                    //   这类值**必然无效** —— ComfyUI 的 MODEL/CONDITIONING/LATENT 这些类型
                    //   只有“由某个节点的输出经连线送进来”这一种来源，不存在字面量数组写法。
                    //
                    //   实测来源（2026-10-16）：本地 9B 模型把 `KSampler.positive` / `negative`
                    //   写成了 `[]`（空数组）。它一路通过了编译，直到 ComfyUI 抛一句
                    //   “Prompt outputs failed validation” —— 模型完全无从知道错在哪。
                    //   在这里挡下并把「要连线、长什么样」说清楚，模型一次就能改对。
                    //
                    //   判据保守（三重）：
                    //     ① 值确实是数组且长度 ≠ 2（长度 2 的由 as_link 处理；长度 2 但首项
                    //        不是字符串的会落到这里 → 也确实是错的，一并报）
                    //     ② 有 object_info 且能解析出该输入的声明类型
                    //     ③ 该类型在白名单 [`LINK_ONLY_TYPES`] 里（不认识的一律放行）
                    let mut bad_shape = false;
                    if let (Some(arr), Some(oi)) = (value.as_array(), object_info) {
                        if arr.len() != 2 {
                            if let Some(t) = resolve_input_type(oi.get(n.class_type.trim()), name) {
                                if is_link_only_type(&t) {
                                    bad_shape = true;
                                    errs.push(format!(
                                        "节点 {}（{}）的输入 {} 需要**连线**（类型 {}），\
                                         但收到的是一个 {} 元素的数组 —— 这不是合法连线。\
                                         连线必须写成 [\"对方节点的 key\", 输出序号]，\
                                         例如 {{\"clip\": [\"ckpt\", 1]}}（输出序号从 0 开始）。",
                                        n.key, n.class_type, name, t, arr.len()
                                    ));
                                }
                            }
                        }
                    }
                    if !bad_shape {
                        compiled = Some(value.clone());
                    }
                }
            }
            inputs.insert(name.clone(), compiled.unwrap_or(Value::Null));
        }
        if let Some(schema) = object_info.and_then(|oi| oi.get(n.class_type.trim())) {
            if let Some(missing) = missing_required(schema, &inputs) {
                errs.push(format!(
                    "节点 {}（{}）缺少必填输入：{}（可从 comfyui_node_info 查该节点的输入规格）",
                    n.key, n.class_type, missing
                ));
            }
        }
        out.insert(
            id.to_string(),
            json!({ "class_type": n.class_type.trim(), "inputs": inputs }),
        );
    }
    if !errs.is_empty() {
        let head = if errs.len() == 1 {
            "工作流有 1 处问题：".to_string()
        } else {
            format!("工作流有 {} 处问题（一次全部列出，请一并修正后重新调用本工具）：", errs.len())
        };
        let body = errs
            .iter()
            .enumerate()
            .map(|(k, e)| format!("{}. {}", k + 1, e))
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!("{head}\n{body}"));
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ir(v: Value) -> IrGraph {
        serde_json::from_value(v).expect("IR 应能反序列化")
    }

    // ===== 编译：连线与 id 分配 =====

    #[test]
    fn 编译_按key分配数字id并把连线解析成位置式() {
        let g = ir(json!({
            "nodes": [
                { "key": "ckpt", "class_type": "CheckpointLoaderSimple",
                  "inputs": { "ckpt_name": "sd_xl_base_1.0.safetensors" } },
                { "key": "pos", "class_type": "CLIPTextEncode",
                  "inputs": { "text": "a cat", "clip": ["ckpt", 1] } }
            ]
        }));
        let native = compile_graph(&g, None).unwrap();
        // ckpt → "1"，pos → "2"
        assert_eq!(native["2"]["inputs"]["clip"], json!(["1", 1]));
        // 字面量原样保留
        assert_eq!(native["2"]["inputs"]["text"], json!("a cat"));
        assert_eq!(native["1"]["inputs"]["ckpt_name"], json!("sd_xl_base_1.0.safetensors"));
    }

    #[test]
    fn 编译_字面量数组不会被误判成连线() {
        // 第二项不是数字 → 是字面量列表，必须原样保留
        let g = ir(json!({
            "nodes": [{ "key": "a", "class_type": "X", "inputs": { "tags": ["cat", "dog"] } }]
        }));
        let native = compile_graph(&g, None).unwrap();
        assert_eq!(native["1"]["inputs"]["tags"], json!(["cat", "dog"]));
    }

    #[test]
    fn 编译_连线指向不存在的key要报错() {
        let g = ir(json!({
            "nodes": [{ "key": "a", "class_type": "X", "inputs": { "clip": ["nope", 0] } }]
        }));
        let e = compile_graph(&g, None).unwrap_err();
        assert!(e.contains("不存在的节点 key"), "err={}", e);
    }

    #[test]
    fn 编译_key重复要报错() {
        let g = ir(json!({
            "nodes": [
                { "key": "a", "class_type": "X" },
                { "key": "a", "class_type": "Y" }
            ]
        }));
        assert!(compile_graph(&g, None).unwrap_err().contains("key 重复"));
    }

    #[test]
    fn 编译_自环要报错() {
        let g = ir(json!({
            "nodes": [{ "key": "a", "class_type": "X", "inputs": { "clip": ["a", 0] } }]
        }));
        assert!(compile_graph(&g, None).unwrap_err().contains("连到了自己"));
    }

    #[test]
    fn 编译_空图要报错() {
        let g = ir(json!({ "nodes": [] }));
        assert!(compile_graph(&g, None).unwrap_err().contains("没有任何节点"));
    }

    #[test]
    fn 编译_缺必填且无默认值要报错() {
        let oi = json!({
            "KSampler": { "input": { "required": {
                "seed": ["INT", { "default": 0 }],
                "steps": ["INT", { "default": 20 }],
                "model": ["MODEL"]
            } } }
        });
        // 缺 model（无 default）→ 报错
        let g = ir(json!({
            "nodes": [{ "key": "k", "class_type": "KSampler", "inputs": { "seed": 1 } }]
        }));
        let e = compile_graph(&g, Some(&oi)).unwrap_err();
        assert!(e.contains("缺少必填输入：model"), "err={}", e);
    }

    #[test]
    fn 编译_必填但有默认值可省略() {
        // 只给无 default 的 model，seed/steps 让 ComfyUI 自己补默认值
        let oi = json!({
            "KSampler": { "input": { "required": {
                "seed": ["INT", { "default": 0 }],
                "steps": ["INT", { "default": 20 }],
                "model": ["MODEL"]
            } } }
        });
        let g = ir(json!({
            "nodes": [{ "key": "k", "class_type": "KSampler", "inputs": { "model": ["c", 0] } },
                      { "key": "c", "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "x" } }]
        }));
        assert!(compile_graph(&g, Some(&oi)).is_ok(), "有默认值的必填项不该被拦");
    }

    // ===== 审计：高危节点 =====

    #[test]
    fn 审计_高危节点直接拒绝() {
        let graph = json!({
            "1": { "class_type": "CheckpointLoaderSimple", "inputs": {} },
            "2": { "class_type": "ExecutePython", "inputs": {} }
        });
        let v = audit_graph(&graph, None, &[]);
        assert_eq!(v.blocked.len(), 1);
        assert_eq!(v.blocked[0].class_type, "ExecutePython");
        assert!(v.blocked[0].reason.contains("Python"));
    }

    #[test]
    fn 审计_高危节点不给放行机会() {
        // 即便用户把 ExecutePython 加进 allowed，也必须仍然被拒
        let graph = json!({ "1": { "class_type": "ExecutePython", "inputs": {} } });
        let v = audit_graph(&graph, None, &["ExecutePython".to_string(), "executepython".to_string()]);
        assert_eq!(v.blocked.len(), 1, "高危名单优先于放行");
    }

    #[test]
    fn 审计_高危匹配大小写不敏感且覆盖多个家族() {
        for ct in ["ShellCommand", "RunPython", "Subprocess", "WriteFile", "EVALUATE"] {
            let graph = json!({ "1": { "class_type": ct, "inputs": {} } });
            assert_eq!(audit_graph(&graph, None, &[]).blocked.len(), 1, "{} 应被拒", ct);
        }
    }

    // ===== 审计：核心 vs 自定义 =====

    #[test]
    fn 审计_核心节点免放行() {
        let oi = json!({
            "CheckpointLoaderSimple": { "python_module": "nodes" },
            "CLIPTextEncode": { "python_module": "nodes" }
        });
        let graph = json!({
            "1": { "class_type": "CheckpointLoaderSimple", "inputs": {} },
            "2": { "class_type": "CLIPTextEncode", "inputs": {} }
        });
        assert!(audit_graph(&graph, Some(&oi), &[]).is_clean());
    }

    #[test]
    fn 审计_自定义节点需要放行() {
        let oi = json!({
            "CheckpointLoaderSimple": { "python_module": "nodes" },
            "IPAdapterApply": { "python_module": "custom_nodes.ComfyUI_IPAdapter_plus" }
        });
        let graph = json!({
            "1": { "class_type": "CheckpointLoaderSimple", "inputs": {} },
            "2": { "class_type": "IPAdapterApply", "inputs": {} }
        });
        let v = audit_graph(&graph, Some(&oi), &[]);
        assert!(v.blocked.is_empty());
        assert_eq!(v.needs_approval.len(), 1);
        assert!(v.needs_approval[0].module.contains("IPAdapter"));
    }

    #[test]
    fn 审计_按包名放行后即通过() {
        let oi = json!({ "IPAdapterApply": { "python_module": "custom_nodes.ComfyUI_IPAdapter_plus" } });
        let graph = json!({ "2": { "class_type": "IPAdapterApply", "inputs": {} } });
        // 按 class_type 放行
        assert!(audit_graph(&graph, Some(&oi), &["ipadapterapply".into()]).is_clean());
        // 按包名放行（大小写不敏感）
        assert!(audit_graph(&graph, Some(&oi), &["custom_nodes.comfyui_ipadapter_plus".into()]).is_clean());
    }

    #[test]
    fn 审计_拿不到节点定义时按需放行() {
        // 无法证明是核心节点 → 保守处理（调用方本就不该在无 object_info 时执行 AI 建的图）
        let graph = json!({ "1": { "class_type": "SomeNode", "inputs": {} } });
        let v = audit_graph(&graph, None, &[]);
        assert_eq!(v.needs_approval.len(), 1);
        assert!(v.needs_approval[0].module.is_empty());
    }

    // ===== 编译：连线**类型**软校验 =====

    /// 最小 object_info：只声明本组用例需要的几个节点。
    ///
    /// ⚠️ **声明形状按真实服务逐条核对过**（拉了运行中 ComfyUI 的 19909 条输入声明）：
    ///   - `[<类型或候选数组>, <选项对象>]` —— 14567 条，如 `["CLIP", {"tooltip": …}]`
    ///   - `[<类型或候选数组>]` —— 5341 条，**单元素**（无选项时 ComfyUI 就这么序列化），
    ///     如 `CLIPSetLastLayer.clip = ["CLIP"]`
    ///   - `[<类型>, <选项>, "说明"]` —— 1 条
    /// 三种形状的第 0 项都是「类型或候选数组」，所以判据只看 `spec[0]`。
    /// 本夹具**同时覆盖这两种主要形状**，避免"只按一种写"导致实现悄悄失配。
    fn oi() -> Value {
        json!({
            "CheckpointLoaderSimple": {
                "input": { "required": { "ckpt_name": [["a.safetensors"], {"tooltip": "t"}] } },
                "output": ["MODEL", "CLIP", "VAE"]
            },
            "CLIPTextEncode": {
                // clip 用**单元素**形状（真实服务里 5341 条是这种）
                "input": { "required": { "text": ["STRING", {"multiline": true}], "clip": ["CLIP"] } },
                "output": ["CONDITIONING"]
            },
            "KSampler": {
                "input": { "required": {
                    "model": ["MODEL", {}], "positive": ["CONDITIONING"], "negative": ["CONDITIONING"],
                    "sampler_name": [["euler", "ddim"], {}]
                } },
                "output": ["LATENT"]
            },
            "AnyNode": { "input": { "required": { "anything": ["*", {}] } }, "output": ["*"] },
            // 声明不规范：完全没有 output 字段 → 必须"不判"
            "LooseNode": { "input": { "required": { "x": ["STRING"] } } },
            // 自创类型名（白名单不认识）→ 数组字面量也必须放行，不能误拒
            "CustomNode": { "input": { "required": { "weird": ["MY_CUSTOM_TYPE", {}] } },
                            "output": ["MY_OUT"] }
        })
    }

    fn ckpt_node() -> Value {
        json!({ "key": "ckpt", "class_type": "CheckpointLoaderSimple",
                "inputs": { "ckpt_name": "a.safetensors" } })
    }

    /// 把 MODEL 接进 CLIPTextEncode.clip —— 这正是本地生图曾经"每次都 400"的那处错法
    /// （`CheckpointLoaderSimple` 的 0=MODEL / 1=CLIP 记错一位）。
    /// 要求报错**指明是第几个输出**、源类型、目标类型 —— 否则模型没法据此改对。
    #[test]
    fn 编译_连线类型不匹配要报错并指出第几个输出() {
        let g = ir(json!({ "nodes": [
            ckpt_node(),
            { "key": "pos", "class_type": "CLIPTextEncode",
              "inputs": { "text": "a cat", "clip": ["ckpt", 0] } }
        ]}));
        let e = compile_graph(&g, Some(&oi())).unwrap_err();
        assert!(e.contains("类型不匹配"), "err={}", e);
        assert!(e.contains("第 0 个输出"), "必须指明是第几个输出：{}", e);
        assert!(e.contains("MODEL"), "必须给出源输出类型：{}", e);
        assert!(e.contains("CLIP"), "必须给出目标需要的类型：{}", e);
    }

    #[test]
    fn 编译_槽位正确时放行() {
        let g = ir(json!({ "nodes": [
            ckpt_node(),
            { "key": "pos", "class_type": "CLIPTextEncode",
              "inputs": { "text": "a cat", "clip": ["ckpt", 1] } }
        ]}));
        let out = compile_graph(&g, Some(&oi())).expect("槽 1 = CLIP，应通过");
        assert_eq!(out["2"]["inputs"]["clip"], json!(["1", 1]));
    }

    /// 软校验的**保守边界**：任一环节信息不全就必须放行。
    /// 这条比正例更重要 —— 误拒会把合法的自定义节点图直接堵死。
    #[test]
    fn 编译_类型信息不全时一律放行() {
        let mismatched = json!([
            ckpt_node(),
            { "key": "pos", "class_type": "CLIPTextEncode",
              "inputs": { "text": "x", "clip": ["ckpt", 0] } }
        ]);

        // ① 调用方没传 object_info → 不判
        assert!(compile_graph(&ir(json!({ "nodes": mismatched })), None).is_ok());

        // ② 源节点没有 output 声明（自定义节点常见）→ 不判
        let g = ir(json!({ "nodes": [
            { "key": "loose", "class_type": "LooseNode", "inputs": { "x": "v" } },
            { "key": "pos", "class_type": "CLIPTextEncode",
              "inputs": { "text": "x", "clip": ["loose", 0] } }
        ]}));
        assert!(compile_graph(&g, Some(&oi())).is_ok(), "源没有 output 声明应放行");

        // ③ 源输出是通配 "*"（AnyType）→ 不判
        let g = ir(json!({ "nodes": [
            { "key": "any", "class_type": "AnyNode", "inputs": { "anything": "v" } },
            { "key": "pos", "class_type": "CLIPTextEncode",
              "inputs": { "text": "x", "clip": ["any", 0] } }
        ]}));
        assert!(compile_graph(&g, Some(&oi())).is_ok(), "通配输出应放行");

        // ④ 目标输入声明是数组（COMBO 下拉框，本来就不该接连线）→ 不判
        let g = ir(json!({ "nodes": [
            ckpt_node(),
            { "key": "ks", "class_type": "KSampler", "inputs": {
                "model": ["ckpt", 0], "positive": "p", "negative": "n",
                "sampler_name": ["ckpt", 0] } }
        ]}));
        assert!(compile_graph(&g, Some(&oi())).is_ok(), "COMBO 输入应放行");

        // ⑤ 输入名不在声明里（模型自己编的）→ 不判，交给 ComfyUI 去报
        let g = ir(json!({ "nodes": [
            ckpt_node(),
            { "key": "pos", "class_type": "CLIPTextEncode",
              "inputs": { "text": "x", "clip": ["ckpt", 1], "编造的输入": ["ckpt", 0] } }
        ]}));
        assert!(compile_graph(&g, Some(&oi())).is_ok(), "未知输入名应放行");
    }

    /// 槽位越界是**明确**错误（object_info 里 output 数组非空却查不到这一号），
    /// 与"信息不全"不同 —— 后者放行，前者报错。
    #[test]
    fn 编译_输出槽位越界要报错() {
        let g = ir(json!({ "nodes": [
            ckpt_node(),
            { "key": "pos", "class_type": "CLIPTextEncode",
              "inputs": { "text": "x", "clip": ["ckpt", 9] } }
        ]}));
        let e = compile_graph(&g, Some(&oi())).unwrap_err();
        assert!(e.contains("3 个输出槽"), "err={}", e);
    }

    #[test]
    fn 类型解析三态() {
        let oi = oi();
        let ckpt = &oi["CheckpointLoaderSimple"];
        assert_eq!(resolve_output_type(Some(ckpt), 1).unwrap(), Some("CLIP".to_string()));
        assert!(resolve_output_type(Some(ckpt), 9).is_err(), "越界应报错而不是静默 None");
        assert_eq!(resolve_output_type(None, 0).unwrap(), None, "没传 object_info → 不判");
        assert_eq!(resolve_output_type(Some(&oi["LooseNode"]), 0).unwrap(), None, "没声明 output → 不判");

        assert_eq!(resolve_input_type(Some(&oi["CLIPTextEncode"]), "clip"), Some("CLIP".to_string()));
        assert_eq!(resolve_input_type(Some(&oi["KSampler"]), "sampler_name"), None, "COMBO 不判");
        assert_eq!(resolve_input_type(Some(&oi["CLIPTextEncode"]), "不存在"), None);

        assert!(is_wildcard_type("*"));
        assert!(is_wildcard_type(" ANY "));
        assert!(!is_wildcard_type("MODEL"));
    }

    /// ★ 形状校验：声明为「只能连线提供」的输入拿到了**数组字面量**（长度 ≠ 2）。
    ///
    /// 实测来源（2026-10-16）：本地 9B 模型把 `KSampler.positive` / `negative` 写成 `[]`。
    /// 这类值**必然无效**，却能耗到 ComfyUI 才报错，而那句报错里**没有节点名也没有输入名** ——
    /// 模型完全无从知道错在哪。这里提前挡下并把"要连线、长什么样"说清楚。
    #[test]
    fn 编译_连线型输入给了数组字面量要报错() {
        for bad in [serde_json::json!([]), serde_json::json!(["a", "b", "c"]), serde_json::json!(["ckpt"])] {
            let g = ir(json!({ "nodes": [
                ckpt_node(),
                { "key": "ks", "class_type": "KSampler", "inputs": {
                    "model": ["ckpt", 0], "positive": bad, "negative": "n",
                    "sampler_name": "euler" } }
            ]}));
            let e = compile_graph(&g, Some(&oi())).unwrap_err();
            assert!(e.contains("需要**连线**"), "bad={bad} err={e}");
            assert!(e.contains("positive"), "必须指明是哪个输入：{e}");
            assert!(e.contains("CONDITIONING"), "必须指明需要什么类型：{e}");
        }
    }

    /// 保守边界：**不是**连线型输入时，数组字面量照旧放行。
    /// 这条比正例更要紧 —— 白名单认不出来的一律不能拒，否则会堵死自定义节点图。
    #[test]
    fn 编译_非连线型输入给数组字面量仍放行() {
        // ① COMBO（枚举）输入拿到数组字面量：声明第 0 项是数组 → 本来就不判
        //    （注意这里必须用**合法**的 conditioning 来源，否则会被上面那条**类型**校验先拦下 ——
        //      实测这份用例第一版就是被它拦的，说明类型校验确实在工作）
        let g = ir(json!({ "nodes": [
            ckpt_node(),
            { "key": "pos", "class_type": "CLIPTextEncode",
              "inputs": { "text": "x", "clip": ["ckpt", 1] } },
            { "key": "ks", "class_type": "KSampler", "inputs": {
                "model": ["ckpt", 0], "positive": ["pos", 0], "negative": ["pos", 0],
                "sampler_name": ["euler", "ddim"] } }
        ]}));
        assert!(compile_graph(&g, Some(&oi())).is_ok(), "COMBO 输入应放行");

        // ② 自创类型名（白名单不认识）→ 放行
        let g = ir(json!({ "nodes": [
            { "key": "c", "class_type": "CustomNode", "inputs": { "weird": ["x", "y", "z"] } }
        ]}));
        assert!(compile_graph(&g, Some(&oi())).is_ok(), "未知类型应放行");

        // ③ 通配 "*" → 放行
        let g = ir(json!({ "nodes": [
            { "key": "a", "class_type": "AnyNode", "inputs": { "anything": ["x", "y", "z"] } }
        ]}));
        assert!(compile_graph(&g, Some(&oi())).is_ok(), "通配类型应放行");

        // ④ 没有 object_info → 什么都不判
        let g = ir(json!({ "nodes": [
            ckpt_node(),
            { "key": "ks", "class_type": "KSampler", "inputs": {
                "model": ["ckpt", 0], "positive": [], "negative": [], "sampler_name": "euler" } }
        ]}));
        assert!(compile_graph(&g, None).is_ok(), "无 object_info 应放行");
    }

    #[test]
    fn 白名单判据() {
        assert!(is_link_only_type("CONDITIONING"));
        assert!(is_link_only_type(" conditioning "), "应去空白且大小写不敏感");
        assert!(is_link_only_type("LATENT"));
        assert!(!is_link_only_type("STRING"));
        assert!(!is_link_only_type("INT"));
        assert!(!is_link_only_type("*"));
        assert!(!is_link_only_type("MY_CUSTOM_TYPE"), "认不出来的一律不算，避免误拒");
    }

    /// ★ 错误**一次报全**：弱模型每轮通常只改一处，逐处报会白吃它的轮次预算
    /// （前端给 agent 共 8 轮，还要分给 node_search / list_models 这些查询）。
    #[test]
    fn 编译_多处错误一次全部列出() {
        let g = ir(json!({ "nodes": [
            ckpt_node(),
            // ① 连线指向不存在的 key
            { "key": "a", "class_type": "CLIPTextEncode",
              "inputs": { "text": "x", "clip": ["nope", 1] } },
            // ② 类型不匹配（MODEL 接进需要 CLIP 的位置）
            { "key": "b", "class_type": "CLIPTextEncode",
              "inputs": { "text": "x", "clip": ["ckpt", 0] } },
            // ③ 连线型输入给了数组字面量
            { "key": "c", "class_type": "CLIPTextEncode",
              "inputs": { "text": "x", "clip": [] } }
        ]}));
        let e = compile_graph(&g, Some(&oi())).unwrap_err();
        assert!(e.contains("3 处问题"), "应报出总数：{e}");
        assert!(e.contains("不存在的节点 key"), "① 应出现：{e}");
        assert!(e.contains("类型不匹配"), "② 应出现：{e}");
        assert!(e.contains("需要**连线**"), "③ 应出现：{e}");
        // 带序号，便于模型逐条回应
        assert!(e.contains("1. ") && e.contains("2. ") && e.contains("3. "), "应有编号：{e}");
    }

    /// 同一处错误**不能报两遍**。
    /// 坏连线若被留成"没这个输入"，`missing_required` 会跟着再报一条同义的 ——
    /// 那不是"更全"，只是更吵。所以出错的输入要留占位。
    #[test]
    fn 编译_同一处错误不重复报() {
        let g = ir(json!({ "nodes": [
            ckpt_node(),
            { "key": "pos", "class_type": "CLIPTextEncode",
              "inputs": { "text": "x", "clip": ["nope", 1] } }
        ]}));
        let e = compile_graph(&g, Some(&oi())).unwrap_err();
        assert_eq!(e.matches("不存在的节点 key").count(), 1, "不该重复：{e}");
        assert!(!e.contains("缺少必填输入"), "坏连线不该再被报成缺必填：{e}");
        assert!(e.contains("1 处问题"), "只应算一处：{e}");
    }
}
