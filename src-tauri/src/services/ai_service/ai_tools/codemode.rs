//! ai_tools 子模块 · codemode —— 让模型写一小段 JS，在 QuickJS 沙箱里循环调用其它工具。
//!
//! ## 它解决什么
//! 「读 20 个文件 / 换 6 种模式 grep / 逐个抓链接」这类活儿，逐个工具调 = 20 轮往返、
//! 20 份正文全进上下文。换成一段脚本跑，中间结果留在 VM，回来只有 `text()` 和 `return`。
//!
//! ## 边界（刻意如此）
//! - 脚本里**只能**调工具 + `text`/`console`/`exit`。没有 fetch / require / setTimeout。
//! - 沙箱可以调工具，所以**工具自己的闸口照旧生效**：所有嵌套调用都走
//!   [`execute_tool_once`]，参数校验、审批 hook、写入即落盘、快照备份一条不少。
//! - 不递归：脚本里拿不到 `codemode` 自己（否则就是无限套娃）。
//! - 脚本的墙钟只管「脚本自己算」，等工具回执（可能正在等用户点批准）的时间会补回去。
use super::*;
use crate::services::ai_service::codemode::{self, CallReply, FailKind, ToolDecl};
use std::time::Instant;

/// 回到模型的文本上限。脚本输出本身已限 20 万字符（VM 里拦），这里再收一道 ——
/// 真正进上下文的是这份文本，超过就是白烧 token。
const MAX_RESULT_CHARS: usize = 24_000;

pub(crate) struct CodemodeTool;

/// 工具名 → 脚本里的标识符（`my-tool` → `my_tool`）。
/// 与 prelude 里的规则必须一致，否则脚本里拿到的名字和清单对不上。
fn js_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for (i, ch) in name.chars().enumerate() {
        let ok = if i == 0 {
            ch.is_ascii_alphabetic() || ch == '_' || ch == '$'
        } else {
            ch.is_ascii_alphanumeric() || ch == '_' || ch == '$'
        };
        out.push(if ok { ch } else { '_' });
    }
    if out.is_empty() {
        out.push('_');
    }
    out
}

/// JSON Schema 的 `type` → TS 类型（浅层，够模型看懂参数形状）。
fn schema_type(schema: &serde_json::Value) -> String {
    if let Some(list) = schema.get("enum").and_then(|e| e.as_array()) {
        let mut parts: Vec<String> = Vec::new();
        for v in list {
            let s = match v {
                serde_json::Value::String(s) => format!("\"{s}\""),
                other => other.to_string(),
            };
            if !parts.contains(&s) {
                parts.push(s);
            }
        }
        if !parts.is_empty() {
            return parts.join(" | ");
        }
    }
    match schema.get("type").and_then(|t| t.as_str()) {
        Some("string") => "string".into(),
        Some("number") | Some("integer") => "number".into(),
        Some("boolean") => "boolean".into(),
        Some("array") => {
            let inner = schema.get("items").map(schema_type).unwrap_or_else(|| "unknown".into());
            format!("{inner}[]")
        }
        Some("object") => "object".into(),
        _ => "unknown".into(),
    }
}

/// 一行签名：`grep(pattern: string, path?: string)` —— 必填在前，可选带 `?`。
fn tool_signature(name: &str, params: &serde_json::Value) -> String {
    let props = params.get("properties").and_then(|p| p.as_object());
    let required: Vec<String> = params
        .get("required")
        .and_then(|r| r.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let Some(props) = props else {
        return format!("{}(args?)", js_name(name));
    };
    let (mut req, mut opt): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
    for (k, v) in props {
        let t = schema_type(v);
        if required.iter().any(|r| r == k) {
            req.push(format!("{k}: {t}"));
        } else {
            opt.push(format!("{k}?: {t}"));
        }
    }
    req.append(&mut opt);
    format!("{}({})", js_name(name), req.join(", "))
}

/// 工具描述：讲清「什么时候用」「怎么写」「有哪些工具」。每次请求都发，控制在 ~2KB。
fn tool_description() -> String {
    let mut list = String::new();
    for t in registered_tools() {
        let name = t.name();
        if name == "codemode" {
            continue;
        }
        let schema = t.function_schema();
        let params = schema.pointer("/function/parameters").cloned().unwrap_or_default();
        list.push_str("- ");
        list.push_str(&tool_signature(name, &params));
        list.push('\n');
    }
    format!(
        "用一段 JavaScript 一次完成多次工具调用。\n\
         \n\
         【什么时候用】需要**连续调用**同一批工具时：批量读/搜多个文件、对一份结果做过滤聚合、按数组循环处理。\n\
         逐个调用这些工具会把每份中间结果都塞进对话（几万 token）；写成脚本，中间结果留在沙箱，\n\
         只有 text() 的输出和 return 的值回来。只调一次工具时**不要**用它，直接调那个工具。\n\
         \n\
         【怎么写】code 是 async 函数体：可以直接 await、可以 return。\n\
         - `await tools.<名字>({{参数}})` → 返回该工具的文本结果（字符串）；工具失败时抛 Error，可 try/catch。\n\
           `Promise.all([...])` 可以并发。参数结构与它自己的工具定义完全一致。\n\
         - `text(v)` / `console.log(v)` → 放进返回给模型的输出（非字符串自动 JSON 化）。\n\
         - `return v` → 返回值也会给模型。\n\
         - `ALL_TOOLS` → 全部工具名；`exit()` → 立即结束（保留已输出内容）。\n\
         \n\
         【限制】没有 fetch / require / import / setTimeout / 文件系统直连（要文件就用 file 工具）；\n\
         默认 90 秒墙钟（等工具的时间不算）；输出超过 20 万字符会被拦。\n\
         \n\
         【可用工具】\n{list}\
         \n\
         【例子】\n\
         ```js\n\
         const hits = [];\n\
         for (const p of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {{\n\
           const s = await tools.file({{ action: 'read_file', path: p }});\n\
           if (s.includes('TODO')) hits.push(p);\n\
         }}\n\
         return hits;\n\
         ```"
    )
}

#[async_trait::async_trait]
impl AiTool for CodemodeTool {
    fn name(&self) -> &'static str {
        "codemode"
    }

    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": tool_description(),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "code": {
                            "type": "string",
                            "description": "async 函数体。用 await tools.<名字>({...}) 调工具，text() 输出，return 返回。"
                        },
                        "timeout_ms": {
                            "type": "integer",
                            "description": "脚本墙钟上限（毫秒），默认 90000。等工具的时间不计入。"
                        }
                    },
                    "required": ["code"]
                }
            }
        })
    }

    /// 独占：脚本内部可能连续写文件，和同批其它工具并发没有意义，还会让审批弹窗互相打架。
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Exclusive
    }

    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let code = args.get("code").and_then(|v| v.as_str()).unwrap_or("");
        let lines = code.lines().count();
        serde_json::json!({
            "card": "generic",
            "kind": "execute",
            "title": format!("运行脚本（{lines} 行）"),
            // 前端 generic 卡支持 detail/locations 就显示，不支持就忽略
            "detail": code.lines().take(3).collect::<Vec<_>>().join("\n"),
        })
    }

    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let code = args
            .get("code")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "codemode 缺少 code 参数".to_string())?
            .to_string();
        if code.trim().is_empty() {
            return Err("codemode 的 code 是空的".to_string());
        }
        let timeout_ms = args
            .get("timeout_ms")
            .and_then(|v| v.as_u64())
            .map(|v| v.clamp(1_000, 600_000))
            .unwrap_or(codemode::DEFAULT_TIMEOUT_MS);

        // 嵌套可调用的工具集：除自己以外的全部。
        let tools: Vec<Box<dyn AiTool>> = registered_tools()
            .into_iter()
            .filter(|t| t.name() != self.name())
            .collect();
        let decls: Vec<ToolDecl> = tools
            .iter()
            .map(|t| ToolDecl { name: t.name().to_string(), js_name: js_name(t.name()) })
            .collect();

        let mut host = codemode::spawn(code, decls, timeout_ms);
        let mut log: Vec<(String, bool, u128)> = Vec::new();
        while let Some(req) = host.next().await {
            let started = Instant::now();
            let parsed: serde_json::Value = if req.args.trim().is_empty() {
                serde_json::json!({})
            } else {
                // 脚本传了非法 JSON（被改过的 toJSON 之类）→ 当成参数错回给脚本
                match serde_json::from_str(&req.args) {
                    Ok(v) => v,
                    Err(e) => {
                        let msg = format!("参数不是合法 JSON: {e}");
                        log.push((req.name.clone(), false, started.elapsed().as_millis()));
                        host.answer(req.id, CallReply::err(msg));
                        continue;
                    }
                }
            };
            let idx = tools.iter().position(|t| t.name() == req.name);
            let (ok, res) = match idx {
                Some(i) => execute_tool_once(Some(tools[i].as_ref()), &req.name, &parsed, ctx).await,
                None => (
                    false,
                    ToolExecResult::plain(format!("未知工具 {}（脚本里只能用 ALL_TOOLS 里列出的工具）", req.name)),
                ),
            };
            log.push((req.name.clone(), ok, started.elapsed().as_millis()));
            host.answer(
                req.id,
                if ok { CallReply::ok(res.text) } else { CallReply::err(res.text) },
            );
        }
        let out = host.finish().await;

        // ── 组装给模型的文本 ──
        let mut text = String::new();
        if !out.ok {
            let kind = match out.kind {
                Some(FailKind::Timeout) => "超时",
                Some(FailKind::Stalled) => "脚本卡住",
                Some(FailKind::Sandbox) => "沙箱错误",
                _ => "脚本报错",
            };
            text.push_str(&format!("脚本执行失败（{kind}）：\n{}\n", out.error.unwrap_or_default()));
        }
        let printed: String = out
            .output
            .iter()
            .map(|(k, v)| if k == "console" { format!("[log] {v}") } else { v.clone() })
            .collect::<Vec<_>>()
            .join("\n");
        if !printed.trim().is_empty() {
            text.push_str(&format!("【脚本输出】\n{}\n", printed.trim_end()));
        }
        if let Some(v) = out.value.as_deref() {
            if v.trim() != "null" {
                text.push_str(&format!("【返回值】\n{v}\n"));
            }
        }
        if out.ok && printed.trim().is_empty() && out.value.is_none() {
            text.push_str("（脚本正常结束，但没有 text() 输出也没有 return 值）\n");
        }
        let n = log.len();
        let failed = log.iter().filter(|(_, ok, _)| !ok).count();
        if n > 0 {
            text.push_str(&format!(
                "【工具调用 {n} 次{}，共 {} ms】\n",
                if failed > 0 { format!("，其中 {failed} 次失败") } else { String::new() },
                out.elapsed_ms
            ));
            for (name, ok, ms) in &log {
                text.push_str(&format!("- {name} {} {ms}ms\n", if *ok { "ok" } else { "失败" }));
            }
        } else {
            text.push_str(&format!("【无工具调用，脚本耗时 {} ms】\n", out.elapsed_ms));
        }

        if text.chars().count() > MAX_RESULT_CHARS {
            let kept: String = text.chars().take(MAX_RESULT_CHARS).collect();
            text = format!("{kept}\n…（结果过长已截断，只保留前 {MAX_RESULT_CHARS} 字符）");
        }
        if out.ok {
            Ok(ToolExecResult::plain(text))
        } else {
            // 失败也用 Err 回填：agent 侧会标成 ok=false，前端能看到红色卡片
            Err(text)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_name_matches_prelude_rule() {
        assert_eq!(js_name("grep"), "grep");
        assert_eq!(js_name("my-tool"), "my_tool");
        assert_eq!(js_name("a.b"), "a_b");
        assert_eq!(js_name("1st"), "_st");
    }

    #[test]
    fn signature_lists_required_first() {
        let params = serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "pattern": { "type": "string" },
                "include": { "type": "string" },
                "limit": { "type": "integer" },
                "mode": { "enum": ["a", "b"] }
            },
            "required": ["pattern"]
        });
        let sig = tool_signature("grep", &params);
        assert!(sig.starts_with("grep(pattern: string, "), "{sig}");
        assert!(sig.contains("path?: string"), "{sig}");
        assert!(sig.contains("limit?: number"), "{sig}");
        assert!(sig.contains("\"a\" | \"b\""), "{sig}");
    }

    /// 描述每次请求都要发，不能失控（超了就说明工具变多但摘要没收敛）。
    #[test]
    fn description_stays_small() {
        let d = tool_description();
        let n = d.chars().count();
        assert!(n < 6000, "工具描述 {n} 字符，太大（每次请求都要发）：
{d}");
        println!("[codemode] 描述 {n} 字符");
    }

    /// 描述里必须列出除自己以外的全部工具 —— 否则模型不知道脚本能调什么。
    #[test]
    fn description_lists_every_other_tool() {
        let d = tool_description();
        let names: Vec<String> = registered_tools()
            .iter()
            .map(|t| t.name().to_string())
            .filter(|n| n != "codemode")
            .collect();
        assert!(names.len() > 5, "工具注册表异常: {names:?}");
        for n in names {
            assert!(d.contains(&format!("- {}(", js_name(&n))), "描述里缺工具 {n}");
        }
        assert!(!d.contains("- codemode("), "不应把自己列进去（会套娃）");
    }
}
