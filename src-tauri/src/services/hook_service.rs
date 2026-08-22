//! 通用 Hook 引擎（进程内回调注册 / 触发）。
//!
//! 用途：在既定生命周期节点（对话结束、Agent 每轮结束等）预留回调管线，
//! 供后续功能（指标采集、审计、联动、插件扩展）在不侵入核心流程的前提下挂载逻辑。
//!
//! 设计要点：
//! - 以「钩点字符串」为键，每个钩点可注册多个处理函数（按注册顺序触发）。
//! - 处理函数 `HookFn = Box<dyn Fn(&serde_json::Value) + Send + Sync>`，
//!   接收结构化 payload，返回 ()。由触发方决定调用时机，调用方与处理方解耦。
//! - 注册以 (point, id) 幂等：同 id 重复注册会覆盖旧实现，避免重复挂载；支持按 id 注销。
//! - 触发时逐个捕获 panic（hook 内部出错不得污染主流程），全部触发完成后返回。
//! - 无钩点时 trigger 是 O(1) 空操作，挂在热路径上几乎零成本。
//!
//! 注意：钩子不承载返回数据，仅做"烧一手"副作用。若需要返回值/改造流程，请显式改造业务逻辑，
//! 不要用 Hook 模拟中间件（违反本引擎「副作用管线」定位，也难维护）。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

/// 钩子处理函数：接收结构化 payload，做副作用侧写。
pub type HookFn = Box<dyn Fn(&Value) + Send + Sync>;

/// 内置钩点常量。接入方在对应生命周期节点调用 [trigger]。
/// - `chat.done`：对话流结束（成功/失败后均触发），payload 见 ai_chat.rs。
/// - `agent.step`：Agent 每轮工具执行完成后触发，payload 含工具名/请求 id。
pub const HOOK_CHAT_DONE: &str = "chat.done";
pub const HOOK_AGENT_STEP: &str = "agent.step";

/// 单个钩点：id → 处理函数（HashMap 保证同 id 覆盖）。
type Point = HashMap<String, HookFn>;
static REGISTRY: OnceLock<Mutex<HashMap<String, Point>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, Point>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 注册钩子。(point, id) 已存在则覆盖旧实现。返回是否首次为该 id 注册。
pub fn register_hook(point: &str, id: &str, f: HookFn) -> bool {
    match registry().lock() {
        Ok(mut g) => {
            let existed = g
                .entry(point.to_string())
                .or_default()
                .insert(id.to_string(), f)
                .is_some();
            !existed
        }
        Err(_) => false,
    }
}

/// 注销钩子。不存在则静默。
pub fn unregister_hook(point: &str, id: &str) {
    if let Ok(mut g) = registry().lock() {
        if let Some(p) = g.get_mut(point) {
            p.remove(id);
        }
    }
}

/// 触发某个钩点：按注册顺序执行所有处理函数。单个 handler panic 会被吞掉，不污染调用方。
///
/// 为避免 `Box<dyn Fn> : Clone` 约束，也避免回调内再触发/注册导致同线程死锁，
/// 采取「换出空表 → 释放锁再逐执行 → 原样放回」的两段式：执行期间绝不持有全局锁。
pub fn trigger(point: &str, payload: &Value) {
    let key = point.to_string();
    let callbacks: Point = {
        let mut g = match registry().lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        std::mem::take(g.entry(key.clone()).or_default())
    };
    for (_, f) in callbacks.iter() {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(payload))).unwrap_or_else(|_| {
            eprintln!("[hooks] hook '{}' handler panic", point);
        });
    }
    if let Ok(mut g) = registry().lock() {
        g.insert(key, callbacks);
    }
}

/// Hook 判定结果（供 [guard] 使用）：返回「允许 / 拒绝 / 允许并改写」三类语义。
///
/// - `Allow(None)`：放行，参数不变。
/// - `Allow(Some(args))`：放行，但把 payload 中的参数改写为给定 JSON（用于授权回调改写指令）。
/// - `Deny(reason)`：拦截，调用方应中止该操作并向用户/模型说明原因。
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    Allow(Option<serde_json::Value>),
    Deny(String),
}

/// 会话前置拦截钩点：在每个安全敏感工具（command / file 写 / 子代理等）执行前触发，
/// 供业务侧挂载「批准 / 拒绝 / 改参」的判定函数。与副作用型的 [trigger] 不同，
/// 本钩点返回 [Verdict]，由调用方决策，属于「流程拦截」而非「烧一手」。
pub const HOOK_PRE_TOOL_USE: &str = "pre.tool_use";

/// 拦截型钩子函数：接收 ``(部点, payload)``，返回 [Verdict]。
/// 允许多个判定函数并存：按注册顺序执行，任一返回 `Deny` 立即短路拒绝；
/// 否则取最后返回 `Allow(Some(args))` 的改写结果。
pub type GuardFn = Box<dyn Fn(&str, &Value) -> Verdict + Send + Sync>;

/// 单个钩点的判定函数集合：id → GuardFn（同 id 覆盖，保证幂等可更新）。
type GuardPoint = HashMap<String, GuardFn>;
static GUARDS: OnceLock<Mutex<HashMap<String, GuardPoint>>> = OnceLock::new();

fn guards() -> &'static Mutex<HashMap<String, GuardPoint>> {
    GUARDS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 注册一个拦截判定函数。同 (point, id) 重复注册覆盖旧实现。返回是否首次为该 id 注册。
pub fn register_guard(point: &str, id: &str, f: GuardFn) -> bool {
    match guards().lock() {
        Ok(mut g) => {
            let existed = g
                .entry(point.to_string())
                .or_default()
                .insert(id.to_string(), f)
                .is_some();
            !existed
        }
        Err(_) => false,
    }
}

/// 注销拦截判定函数。不存在则静默。
pub fn unregister_guard(point: &str) {
    if let Ok(mut g) = guards().lock() {
        g.remove(point);
    }
}

/// 触发拦截判定（前置闸口）：按注册序执行，任一 Deny 短路拒绝；
/// 均 Allow 时取最后一项 Allow(Some(args)) 的改写作为放行结果。
///
/// 「换出-执行-放回」与 [trigger] 一致：回调执行期间不持有全局锁，避免在回调内再注册导致死锁。
/// 无任何 guard 注册时本函数 O(1) 返回 `Verdict::Allow(None)`（放行，零额外开销）。
pub fn guard(point: &str, payload: &Value) -> Verdict {
    let key = point.to_string();
    let funcs: GuardPoint = {
        let mut g = match guards().lock() {
            Ok(g) => g,
            Err(_) => return Verdict::Allow(None),
        };
        std::mem::take(g.entry(key.clone()).or_default())
    };
    let mut outcome = Verdict::Allow(None);
    // 遍历副本，不持全局锁
    for (_, f) in funcs.iter() {
        let v = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&key, payload)))
            .unwrap_or(Verdict::Deny("hook 判定函数执行异常（panic 已捕获）".to_string()));
        match v {
            Verdict::Deny(_) => {
                outcome = v;
                break;
            }
            Verdict::Allow(a) => {
                if a.is_some() {
                    outcome = Verdict::Allow(a);
                }
            }
        }
    }
    if let Ok(mut g) = guards().lock() {
        g.insert(key, funcs);
    }
    outcome
}

/// 列出已注册的所有钩点（用于诊断 / 前端展示）。
pub fn hook_points() -> Vec<String> {
    match registry().lock() {
        Ok(g) => {
            let mut pts: Vec<String> = g.iter().filter(|(_, p)| !p.is_empty()).map(|(k, _)| k.clone()).collect();
            pts.sort();
            pts
        }
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn register_trigger_lifecycle() {
        let count = std::sync::Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        register_hook("t.point", "h1", Box::new(move |_| {
            c.fetch_add(1, Ordering::SeqCst);
        }));
        // 同 id 覆盖，重复注册不叠加
        let c2 = count.clone();
        register_hook("t.point", "h1", Box::new(move |_| {
            c2.fetch_add(10, Ordering::SeqCst);
        }));
        trigger("t.point", &Value::Null);
        assert_eq!(count.load(Ordering::SeqCst), 10);
        unregister_hook("t.point", "h1");
        trigger("t.point", &Value::Null);
        assert_eq!(count.load(Ordering::SeqCst), 10);
    }

    #[test]
    fn panic_isolated() {
        register_hook("p.boom", "boom", Box::new(|_| panic!("kaboom")));
        register_hook("p.boom", "ok", Box::new(|_| {}));
        trigger("p.boom", &Value::Null); // 不应 panic 冒泡
    }

    #[test]
    fn guard_deny_short_circuits() {
        register_guard("pre.g1", "deny-all", Box::new(|_, _| Verdict::Deny("blocked".into())));
        register_guard("pre.g1", "allow", Box::new(|_, _| Verdict::Allow(None)));
        // 任一 Deny 立即短路拒绝
        assert_eq!(guard("pre.g1", &Value::Null), Verdict::Deny("blocked".into()));
        unregister_guard("pre.g1");
        // 注销后放行
        assert_eq!(guard("pre.g1", &Value::Null), Verdict::Allow(None));
    }

    #[test]
    fn guard_rewrite_args() {
        register_guard("pre.g2", "rewrite", Box::new(|_, _| {
            Verdict::Allow(Some(serde_json::json!({ "args": { "command": "echo safe" } })))
        }));
        let payload = serde_json::json!({ "command": "rm -rf /" });
        match guard("pre.g2", &payload) {
            Verdict::Allow(Some(over)) => {
                assert_eq!(over["args"]["command"], "echo safe");
            }
            other => panic!("期望 Allow(Some)，实际 {:?}", other),
        }
        unregister_guard("pre.g2");
    }
}