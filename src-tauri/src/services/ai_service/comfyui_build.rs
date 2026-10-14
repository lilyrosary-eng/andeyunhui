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

/// 中间表示 → ComfyUI 原生 API 格式。
///
/// 输入里 `inputs` 的值有两种：
///   - **字面量**（字符串/数字/对象…）→ 原样保留
///   - **连线** `["<节点 key>", <输出序号>]` → 编译成 `["<数字 id>", 序号]`
///
/// 出错**不静默**：key 重复、连线指向不存在的 key、自环、缺必填输入都明确报错。
/// 这些正是模型最容易犯的错，静默放行只会换来一次看不懂的执行失败。
pub fn compile_graph(ir: &IrGraph, object_info: Option<&Value>) -> Result<Value, String> {
    if ir.nodes.is_empty() {
        return Err("图上没有任何节点".to_string());
    }
    // ① key 唯一且非空
    let mut id_of: HashMap<&str, usize> = HashMap::new();
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
    }
    // ② 组装 + 解析连线 + 必填校验
    let mut out = Map::new();
    for (i, n) in ir.nodes.iter().enumerate() {
        let id = i + 1;
        let mut inputs = Map::new();
        for (name, value) in &n.inputs {
            let compiled = match as_link(value) {
                Some((target, idx)) => {
                    let target = target.trim();
                    let tid = id_of.get(target).ok_or_else(|| {
                        format!("节点 {} 的输入 {} 连到了不存在的节点 key：{}", n.key, name, target)
                    })?;
                    if *tid == id {
                        return Err(format!("节点 {} 的输入 {} 连到了自己", n.key, name));
                    }
                    json!([tid.to_string(), idx])
                }
                None => value.clone(),
            };
            inputs.insert(name.clone(), compiled);
        }
        if let Some(schema) = object_info.and_then(|oi| oi.get(n.class_type.trim())) {
            if let Some(missing) = missing_required(schema, &inputs) {
                return Err(format!(
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
}
