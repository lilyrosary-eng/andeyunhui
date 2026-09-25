// gongfang 攻防模块 → AI 统一工具（全量命令分发）
// 复用 gongfang_kit::commands 同一批后端函数；一条工具按 cmd 分发，避免 60+ struct。
// 走既有网关：schema 校验 + 副作用审批(is_side_effect) + Exclusive 并发。
use crate::services::ai_service::ai_tools::{AiTool, ToolContext, ToolExecResult, ToolConcurrency};
use serde_json::Value;

pub(crate) struct GongfangFullTool;

// 容错取参
fn s(v: &Value, keys: &[&str]) -> Result<String, String> {
    for k in keys {
        if let Some(x) = v.get(k).and_then(|x| x.as_str()) {
            if !x.trim().is_empty() {
                return Ok(x.to_string());
            }
        }
    }
    Err(format!("缺少参数 {}", keys[0]))
}
fn fk(v: &Value, keys: &[&str], d: f64) -> f64 {
    for k in keys {
        if let Some(x) = v.get(k).and_then(|x| x.as_f64()) {
            return x;
        }
    }
    d
}
fn arr_str(v: &Value, key: &str) -> Vec<String> {
    v.get(key).and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|e| e.as_str().map(str::to_string)).collect()).unwrap_or_default()
}
fn arr_num<T: From<f64>>(v: &Value, key: &str) -> Vec<T> {
    v.get(key).and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|e| e.as_f64().map(|f| T::from(f))).collect()).unwrap_or_default()
}
fn json(v: &Value, key: &str) -> Option<Value> {
    v.get(key).cloned()
}

fn ok<U: serde::Serialize>(r: Result<U, String>) -> Result<String, String> {
    r.map(|x| serde_json::to_string_pretty(&x).unwrap_or_default())
}

#[async_trait::async_trait]
impl AiTool for GongfangFullTool {
    fn name(&self) -> &'static str {
        "gongfang"
    }
    fn function_schema(&self) -> Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "gongfang",
                "description": "攻防模块统一工具（用户明确授权目标时使用）。cmd 指定操作，args 为操作参数。只读侦察(recon)、抓取(fetch)、爬虫统计与代理池(crawler_stats/proxy_add/proxy_list/proxy_reset)、事件与指标(events_recent/metrics_history)、载荷(payloads)、编码识别(crypto/encode)、符号(symbols)、协议图(protocol_graph，需 url)、自动化(automation_*)、网关(gateway_*)、知识库(ai_knowledge_*)、目标工作区(target_*)、引擎(status/start/stop/inject)。不越权、不洪泛。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "cmd": { "type": "string", "description": "要执行的 gongfang 命令名(见枚举注释)" },
                        "url": { "type": "string" },
                        "args": { "type": "object", "description": "其它参数(按命令)：" }
                    },
                    "required": ["cmd"]
                }
            }
        })
    }
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Exclusive
    }
    async fn execute(&self, args: &Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let cmd = s(args, &["cmd"])?;
        let k = |keys: &[&str]| s(args, keys);
        // 便于后端需要 app 的命令
        let app = ctx.app.clone();
        #[cfg(feature = "gongfang")]
        {
            use gongfang_kit::commands::*;
            let out = match cmd.as_str() {
                // —— 侦察 ——
                "waf" => ok(gongfang_waf_detect(k(&["url"])?).await),
                "tech" => ok(gongfang_tech_fingerprint(k(&["url"])?).await),
                "methods" => ok(gongfang_http_methods(k(&["url"])?).await),
                "paths" => ok(gongfang_path_probe(k(&["url"])?).await),
                "wellknown" => ok(gongfang_wellknown_probe(k(&["url"])?).await),
                "error_page" => ok(gongfang_error_page(k(&["url"])?).await),
                "fetch" => ok(gongfang_fetch(k(&["url"])?).await),
                // —— 爬虫（统计 + 代理池管理）——
                "crawler_stats" => ok(gongfang_crawler_stats()),
                "proxy_add" => ok(gongfang_proxy_add(k(&["url"])?, json(args, "tag").and_then(|x| x.as_str().map(str::to_string)))),
                "proxy_list" => ok(gongfang_proxy_list()),
                "proxy_reset" => ok(gongfang_proxy_reset()),
                // —— 事件 / 指标（内核自省）——
                "events_recent" => ok(gongfang_events_recent(json(args, "n").and_then(|x| x.as_u64().map(|u| u as usize)))),
                "metrics_history" => ok(gongfang_metrics_history(json(args, "seconds").and_then(|x| x.as_u64().map(|u| u as u32)))),
                // —— 引擎 ——
                "status" => ok(gongfang_status()),
                "start" => ok(gongfang_start(app, json(args, "profile_id").and_then(|x| x.as_str().map(str::to_string))).await),
                "stop" => ok(gongfang_stop().await),
                "inject" => {
                    let c: gongfang_kit::kernel::priority::UserCommand =
                        serde_json::from_value(json(args, "cmd").unwrap_or(Value::Null))
                        .map_err(|e| format!("inject cmd 解析失败: {e}"))?;
                    ok(gongfang_inject(c))
                }
                "set_emit_tick" => ok(gongfang_set_emit_tick(json(args, "enabled").and_then(|x| x.as_bool()).unwrap_or(false))),
                "scan" => ok(gongfang_scan(
                    k(&["host"])?,
                    serde_json::from_value(json(args, "ports").unwrap_or(Value::Null)).map_err(|e| format!("ports 解析失败: {e}"))?,
                ).await),
                "simulate_waf" => ok(gongfang_simulate_waf(k(&["payload"])?)),
                "payloads" => ok(gongfang_payloads(k(&["category"])?)),
                "db_payloads" => ok(gongfang_db_payloads(k(&["input"])?)),
                "hpp" => ok(gongfang_hpp_analyze(k(&["response"])?)),
                // —— 编码/加密 ——
                "crypto" => ok(gongfang_crypto_identify(k(&["hex_data"])?)),
                "encode_analyze" => ok(gongfang_encode_analyze(k(&["input"])?)),
                "encode_chain" => ok(gongfang_encode_chain(k(&["input"])?, json(args, "max_layers").and_then(|x| x.as_u64().map(|u| u as u8)))),
                // —— 符号 / 协议 ——
                "symbols" => ok(gongfang_symbols(json(args, "url").and_then(|x| x.as_str().map(str::to_string)))),
                // 无 url 时后端明确报错（不再返回示例状态机）
                "protocol_graph" => ok(gongfang_protocol_graph(json(args, "url").and_then(|x| x.as_str().map(str::to_string)))),
                "symbol_add" => {
                    let req: gongfang_kit::commands::SaveSymbolRequest = serde_json::from_value(json(args, "req").unwrap_or(Value::Null))
                        .map_err(|e| format!("symbol_add req 解析失败: {e}"))?;
                    ok(gongfang_symbol_add(req))
                }
                // —— 自动化 ——
                "humanize" => ok(gongfang_humanize(json(args, "level").and_then(|x| x.as_u64()).unwrap_or(0) as u32)),
                "automation_templates" => ok(gongfang_automation_templates()),
                "automation_trajectory" => ok(gongfang_automation_trajectory(fk(args, &["startX", "start_x"], 0.0) as f32, fk(args, &["startY", "start_y"], 0.0) as f32, fk(args, &["targetX", "target_x"], 800.0) as f32, fk(args, &["targetY", "target_y"], 600.0) as f32, json(args, "template_id").and_then(|x| x.as_u64().map(|u| u as u32)))),
                "automation_divergence" => ok(gongfang_automation_divergence(arr_json(args, "points"), json(args, "template_id").and_then(|x| x.as_u64().map(|u| u as u32)))),
                "automation_probe" => ok(gongfang_automation_probe(arr_bool(args, "successes"))),
                "automation_target" => ok(gongfang_automation_target(fk(args, &["x"], 0.0) as f32, fk(args, &["y"], 0.0) as f32)),
                "automation_target_clear" => ok(gongfang_automation_target_clear()),
                "fitness" => ok(gongfang_fitness()),
                "fitness_migrate" => ok(gongfang_fitness_migrate()),
                "fitness_reset" => ok(gongfang_fitness_reset()),
                // —— 网关 ——
                "gateway_status" => ok(gongfang_gateway_status()),
                "gateway_rotate" => ok(gongfang_gateway_rotate(k(&["mode"])?)),
                "gateway_throttle" => ok(gongfang_gateway_throttle(fk(args, &["ratio"], 0.5))),
                "gateway_pool" => ok(gongfang_gateway_pool()),
                "gateway_score" => ok(gongfang_gateway_score(fk(args, &["errorRate", "error_rate"], 0.0), fk(args, &["ewmaRtt", "ewma_rtt"], 100.0), fk(args, &["rttGradient", "rtt_gradient"], 0.0))),
                "gateway_traffic" => ok(gongfang_gateway_traffic(fk(args, &["lambda"], 1.0), json(args, "count").and_then(|x| x.as_u64().map(|u| u as usize)))),
                "gateway_route_sim" => ok(gongfang_gateway_route_sim(arr_json(args, "nodes"))),
                "gateway_strategy_sim" => ok(gongfang_gateway_strategy_sim(k(&["routing"])?, fk(args, &["ratio"], 0.5))),
                "gateway_shaping_demo" => ok(gongfang_gateway_shaping_demo()),
                "gateway_obfuscate" => ok(gongfang_gateway_obfuscate(k(&["raw"])?)),
                "gateway_entropy_demo" => ok(gongfang_gateway_entropy_demo(arr_str(args, "patterns"))),
                // —— AI 知识库/推理 ——
                "ai_stats" => ok(gongfang_ai_knowledge_stats()),
                "ai_search" => ok(gongfang_ai_knowledge_search(k(&["query"])?)),
                "ai_add" => ok(gongfang_ai_knowledge_add(k(&["title"])?, k(&["content"])?, json(args, "tags").map(|v| serde_json::from_value(v)).transpose().map_err(|e| format!("tags 解析失败: {e}"))?, k(&["category"])?).await),
                "ai_remove" => ok(gongfang_ai_knowledge_remove(k(&["id"])?).await),
                "ai_router_sim" => ok(gongfang_ai_router_sim(json(args, "status").and_then(|x| x.as_u64().map(|u| u as u16)), fk(args, &["errorRate", "error_rate"], 0.0), k(&["tls"])?)),
                "ai_reasoning_stats" => ok(gongfang_ai_reasoning_stats()),
                "ai_reasoning_recent" => ok(gongfang_ai_reasoning_recent(json(args, "n").and_then(|x| x.as_u64().map(|u| u as usize)))),
                // —— 目标工作区 ——
                "target_list" => ok(gongfang_target_list(app)),
                "target_save" => {
                    let req: gongfang_kit::commands::SaveTargetRequest = serde_json::from_value(json(args, "req").unwrap_or(Value::Null))
                        .map_err(|e| format!("target_save req 解析失败: {e}"))?;
                    ok(gongfang_target_save(app, req))
                }
                "target_delete" => ok(gongfang_target_delete(app, k(&["id"])?)),
                "target_activate" => ok(gongfang_target_activate(app, k(&["id"])?)),
                "target_get" => ok(gongfang_target_get(app, k(&["id"])?)),
                "target_set_metadata" => ok(gongfang_target_set_metadata(app, k(&["id"])?, k(&["key"])?, json(args, "value").unwrap_or(Value::Null))),
                _ => return Err(format!("未知 gongfang cmd: {cmd}")),
            };
            let meta = serde_json::json!({ "card": "generic", "kind": "gongfang", "title": format!("gongfang::{cmd}") });
            Ok(ToolExecResult::with_meta(out?, meta))
        }
        #[cfg(not(feature = "gongfang"))]
        {
            let _ = (cmd, app);
            Err("gongfang feature 未启用：请用 --features gongfang 构建".to_string())
        }
    }
}

// 辅助：数组对象 / bool
fn arr_json(v: &Value, key: &str) -> Vec<Value> {
    v.get(key).and_then(|x| x.as_array()).cloned().unwrap_or_default()
}
fn arr_bool(v: &Value, key: &str) -> Vec<bool> {
    v.get(key).and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|e| e.as_bool()).collect()).unwrap_or_default()
}