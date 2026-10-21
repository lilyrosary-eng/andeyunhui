//! 模型写的 JavaScript 在 QuickJS 里跑，工具调用不进模型上下文（pi-codemode 的落地版）。
//!
//! ## 为什么要有它
//! agent 每调一次工具，参数和结果都要回填进上下文。读 20 个文件 = 20 轮往返 + 20 份正文，
//! 上下文和 token 都被撑爆。codemode 把「循环 / 过滤 / 聚合」放进脚本里跑：模型只写一段 JS，
//! 中间结果留在 VM 里，只有脚本的 `text()` 和 `return` 回到上下文。
//!
//! ## 结构（与 pi 的差异都写在注释里）
//! - VM 跑在**专线程**上：QuickJS 是同步解释器，跑在 tokio 线程上会卡住事件循环。
//! - 工具调用**不阻塞 VM**：prelude 把调用挂成 Promise，通过 bridge 把 `(id, name, args)` 发给宿主；
//!   宿主执行完把 `(id, 结果)` 投回 VM 的 `settle()`。所以 `Promise.all` 是真并发，
//!   并发度由宿主决定（见 ai_tools/codemode.rs 的调度）。
//! - 超时两路：`while(true){}` 靠 QuickJS 的 interrupt handler（闭包里看 deadline）；
//!   等一个永远不会 settle 的 promise 靠 `stalled()` —— VM 里没有 timer / IO，没人能唤醒它。
//! - 内存上限 + QuickJS 栈护栏：防止脚本打满进程内存、或深递归把原生栈冲爆（后者是直接 abort）。
//! - 刻意不做 `store`/`load`/`image`：我们没有跨执行的持久状态，工具也只回文本。
//!
//! ## 报错行号
//! QuickJS 里 prelude 和脚本都是 `eval_script`，行号各自从 1 开始 —— 直接看会串台。
//! 这里给脚本源码前垫 `PRELUDE_LINES + 1` 行空行，于是「脚本第 k 行」在栈里是第
//! `PRELUDE_LINES + 2 + k` 行：小于等于 `PRELUDE_LINES + 2` 的帧全是 prelude / 包装行的，
//! 丢掉；其余减去基数就是模型写的行号。
use rquickjs::{CatchResultExt, Context, Function, Object, Runtime, Value};
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use std::time::{Duration, Instant};

/// 单次脚本默认墙钟上限：够跑几百次本地工具调用，又不至于一次卡死拖住整轮对话。
pub const DEFAULT_TIMEOUT_MS: u64 = 90_000;
/// 脚本最多能申请多少堆内存。超出时脚本内抛 `InternalError: out of memory`（可被 catch）。
const MEMORY_LIMIT_BYTES: usize = 96 * 1024 * 1024;
/// QuickJS 自己的栈护栏：必须小于宿主线程栈，否则递归先冲爆原生栈（那是直接 abort）。
const MAX_STACK_BYTES: usize = 2 * 1024 * 1024;
/// VM 线程的原生栈，给足余量让上面的护栏先响。
const HOST_STACK_BYTES: usize = 16 * 1024 * 1024;
/// 脚本自己能攒多少字符输出（text / console）。这是**进模型上下文**的东西，必须早拦。
const MAX_OUTPUT_CHARS: usize = 200_000;
/// 单个工具调用最多等多久（含人工审批）。超时多半意味着某个工具卡死了。
const TOOL_WAIT_CAP: Duration = Duration::from_secs(600);

#[derive(Debug, Clone)]
pub struct ToolDecl {
    /// 工具真名（bridge 回传、宿主查表用）
    pub name: String,
    /// 脚本里的标识符（非法字符换成 `_`：`my-tool` → `my_tool`）
    pub js_name: String,
}

/// 宿主收到的一次工具调用。
pub struct CallRequest {
    pub id: i64,
    pub name: String,
    /// 脚本传的参数，JSON 文本；空串表示 `undefined`
    pub args: String,
}

pub struct CallReply {
    ok: bool,
    /// 成功：JSON 文本；失败：错误消息（JS 侧变成 `Error(message)`）
    payload: String,
}

impl CallReply {
    /// 工具成功：`text` 是工具回给模型的纯文本，脚本里拿到的是这个字符串。
    pub fn ok(text: impl Into<String>) -> Self {
        Self { ok: true, payload: serde_json::to_string(&text.into()).unwrap_or_else(|_| "\"\"".into()) }
    }
    pub fn err(message: impl Into<String>) -> Self {
        Self { ok: false, payload: message.into() }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailKind {
    /// 脚本自己抛了 / 语法错
    Script,
    /// 墙钟超时或被强制中断
    Timeout,
    /// 等一个永远不会 settle 的 promise
    Stalled,
    /// VM 创建/驱动失败（不是脚本的错）
    Sandbox,
}

#[derive(Debug, Default)]
pub struct Outcome {
    pub ok: bool,
    /// 脚本 `return` 的值（JSON 文本）
    pub value: Option<String>,
    /// 失败文本（已含栈、已还原行号）
    pub error: Option<String>,
    pub kind: Option<FailKind>,
    /// (kind, text)：kind = `text` | `console`
    pub output: Vec<(String, String)>,
    pub elapsed_ms: u128,
}

/// 一次脚本执行的宿主句柄。
///
/// 用法固定：`while let Some(req) = host.calls.recv().await { … host.answer(req.id, r) }`，
/// 工具调用流关闭后 `host.finish().await` 取结果。
pub struct VmHost {
    calls: tokio::sync::mpsc::UnboundedReceiver<CallRequest>,
    reply: mpsc::Sender<(i64, CallReply)>,
    join: tokio::task::JoinHandle<Outcome>,
}

impl VmHost {
    /// 等下一个工具调用；返回 `None` 表示脚本已收尾（之后应调用 `finish()`）。
    pub async fn next(&mut self) -> Option<CallRequest> {
        self.calls.recv().await
    }

    /// 把某个调用的结果投回 VM。调用方丢了 id 或 VM 已退，静默丢弃（VM 那边会超时兜底）。
    pub fn answer(&self, id: i64, reply: CallReply) {
        let _ = self.reply.send((id, reply));
    }

    pub async fn finish(self) -> Outcome {
        drop(self.calls);
        let join = self.join;
        match join.await {
            Ok(o) => o,
            Err(e) => Outcome {
                ok: false,
                kind: Some(FailKind::Sandbox),
                error: Some(format!("VM 线程异常退出: {e}")),
                ..Default::default()
            },
        }
    }
}

/// 起一个 VM 跑脚本。**不阻塞**：返回后马上就能开始收工具调用。
pub fn spawn(code: String, decls: Vec<ToolDecl>, timeout_ms: u64) -> VmHost {
    let (req_tx, req_rx) = tokio::sync::mpsc::unbounded_channel::<CallRequest>();
    let (reply_tx, reply_rx) = mpsc::channel::<(i64, CallReply)>();
    let decls_json = serde_json::json!(decls
        .iter()
        .map(|d| serde_json::json!({ "name": d.name, "jsName": d.js_name }))
        .collect::<Vec<_>>())
    .to_string();
    let join = tokio::task::spawn_blocking(move || {
        let started = Instant::now();
        let deadline = started + Duration::from_millis(timeout_ms.max(1));
        // spawn_blocking 的线程栈只有默认 2MB，装不下 MAX_STACK_BYTES 的护栏余量 ⇒ 自建线程
        let vm = std::thread::Builder::new()
            .name("codemode-vm".into())
            .stack_size(HOST_STACK_BYTES)
            .spawn(move || run_vm(&code, &decls_json, deadline, req_tx, reply_rx));
        let mut out = match vm {
            Ok(handle) => match handle.join() {
                Ok(Ok(o)) => o,
                Ok(Err(e)) => Outcome {
                    ok: false,
                    kind: Some(FailKind::Sandbox),
                    error: Some(e),
                    ..Default::default()
                },
                Err(_) => Outcome {
                    ok: false,
                    kind: Some(FailKind::Sandbox),
                    error: Some("VM 线程 panic".into()),
                    ..Default::default()
                },
            },
            Err(e) => Outcome {
                ok: false,
                kind: Some(FailKind::Sandbox),
                error: Some(format!("VM 线程起不来: {e}")),
                ..Default::default()
            },
        };
        out.elapsed_ms = started.elapsed().as_millis();
        out
    });

    VmHost { calls: req_rx, reply: reply_tx, join }
}

fn prelude() -> &'static str {
    static SRC: OnceLock<String> = OnceLock::new();
    SRC.get_or_init(|| PRELUDE_TMPL.replace("__MAX_OUTPUT__", &MAX_OUTPUT_CHARS.to_string()))
}

fn prelude_lines() -> usize {
    static LINES: OnceLock<usize> = OnceLock::new();
    *LINES.get_or_init(|| prelude().lines().count())
}

/// 跑 VM。脚本级失败写进 Outcome；只有 VM 本身起不来才返回 Err。
fn run_vm(
    code: &str,
    decls_json: &str,
    deadline: Instant,
    req_tx: tokio::sync::mpsc::UnboundedSender<CallRequest>,
    reply_rx: mpsc::Receiver<(i64, CallReply)>,
) -> Result<Outcome, String> {
    let mut out = Outcome::default();
    let interrupt = Arc::new(AtomicBool::new(false));
    let started = Instant::now();
    // 脚本墙钟预算（微秒，相对 started）。等工具回执的时长会补回来 —— 工具里可能包含
    // 「等用户点批准」，那段不该算脚本超时。
    let budget_us = Arc::new(std::sync::atomic::AtomicU64::new(deadline.saturating_duration_since(started).as_micros() as u64));
    let rt = Runtime::new().map_err(|e| format!("创建 QuickJS 运行时失败: {e}"))?;
    rt.set_memory_limit(MEMORY_LIMIT_BYTES);
    rt.set_max_stack_size(MAX_STACK_BYTES);
    {
        let intr = interrupt.clone();
        let budget = budget_us.clone();
        rt.set_interrupt_handler(Some(Box::new(move || {
            if started.elapsed().as_micros() as u64 >= budget.load(Ordering::Relaxed) {
                intr.store(true, Ordering::SeqCst);
                return true;
            }
            intr.load(Ordering::SeqCst)
        })));
    }
    let ctx = Context::full(&rt).map_err(|e| format!("创建 QuickJS 上下文失败: {e}"))?;

    let texts: Rc<RefCell<Vec<(String, String)>>> = Rc::new(RefCell::new(Vec::new()));
    let completed = Rc::new(Cell::new(false));
    let finished: Rc<RefCell<Option<(bool, String)>>> = Rc::new(RefCell::new(None));
    let prelude_n = prelude_lines();
    // 源码 = (prelude_n+1) 个空行 + 一个换行 + 包装行(含代码第 1 行) ⇒ 代码第 k 行在第 prelude_n+2+k 行
    let offset = prelude_n + 2;
    // 用 Cell 在闭包里汇报「VM 层故障」；闭包只能返回 ()，用外层 Option 兜
    let fatal: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));

    ctx.with(|ctx| {
        let texts_c = texts.clone();
        let completed_c = completed.clone();
        let finished_c = finished.clone();
        let fatal_c = fatal.clone();
        let req_tx_c = req_tx.clone();
        let bridge = match Function::new(
            ctx.clone(),
            move |kind: String, a: String, b: String, c: String| -> rquickjs::Result<()> {
                match kind.as_str() {
                    // a=id, b=工具名, c=参数 JSON
                    "call" => {
                        let id: i64 = a.parse().unwrap_or(0);
                        if req_tx_c.send(CallRequest { id, name: b, args: c }).is_err() {
                            // 宿主已走（整轮被取消等）：让脚本尽快收尾，而不是空等到死
                            *finished_c.borrow_mut() = Some((
                                false,
                                serde_json::json!({ "message": "宿主侧已结束，脚本被终止" }).to_string(),
                            ));
                            completed_c.set(true);
                        }
                    }
                    // a=kind(text/console), b=正文
                    "output" => texts_c.borrow_mut().push((a, b)),
                    // a="1"/"0", b=JSON（返回值或错误对象）
                    "done" => {
                        completed_c.set(true);
                        *finished_c.borrow_mut() = Some((a == "1", b));
                    }
                    _ => {}
                }
                Ok(())
            },
        ) {
            Ok(f) => f,
            Err(e) => {
                *fatal_c.borrow_mut() = Some(format!("安装宿主桥失败: {e}"));
                return;
            }
        };

        let factory: Function = match ctx.eval::<Value, _>(prelude()).catch(&ctx) {
            Ok(v) => match v.into_function() {
                Some(f) => f,
                None => {
                    *fatal_c.borrow_mut() = Some("prelude 不是函数".into());
                    return;
                }
            },
            Err(e) => {
                *fatal_c.borrow_mut() = Some(format!("prelude 求值失败: {e}"));
                return;
            }
        };
        let api: Object = match factory.call((bridge, decls_json.to_string())) {
            Ok(o) => o,
            Err(e) => {
                *fatal_c.borrow_mut() = Some(format!("prelude 初始化失败: {e}"));
                return;
            }
        };
        let (run, settle, stalled) = match (
            api.get::<_, Function>("run"),
            api.get::<_, Function>("settle"),
            api.get::<_, Function>("stalled"),
        ) {
            (Ok(a), Ok(b), Ok(c)) => (a, b, c),
            _ => {
                *fatal_c.borrow_mut() = Some("prelude 导出不全".into());
                return;
            }
        };

        // 垫空行：脚本第 k 行 → eval_script 第 offset+k 行（见文件头注释）
        let src = format!("{}\n(async (tools, console) => {{{}\n}})", "\n".repeat(offset - 1), code);
        let script: Function = match ctx.eval::<Value, _>(src.as_bytes()).catch(&ctx) {
            Ok(v) => match v.into_function() {
                Some(f) => f,
                None => {
                    out.error = Some("脚本编译结果不是函数".into());
                    out.kind = Some(FailKind::Sandbox);
                    completed.set(true);
                    return;
                }
            },
            Err(e) => {
                out.error = Some(format!("语法错误：{}", shift_lines(&e.to_string(), offset)));
                out.kind = Some(FailKind::Script);
                completed.set(true);
                return;
            }
        };
        if let Err(e) = run.call::<_, ()>((script,)) {
            if interrupt.load(Ordering::SeqCst) {
                // 死循环在首次同步执行里就被中断了（还没走到驱动循环）
                out.kind = Some(FailKind::Timeout);
                out.error = Some("脚本超时：已超过时限，被强制中断".into());
            } else {
                out.error = Some(format!("脚本启动失败: {e}"));
                out.kind = Some(FailKind::Sandbox);
            }
            completed.set(true);
            return;
        }

        // 驱动循环：排空 job 队列 → 没结束就等宿主回一个结果 → 投回 VM
        loop {
            // 每个 await 的续体都是一个 job；不排空的话 Promise 永远不前进
            while ctx.execute_pending_job() {}
            if interrupt.load(Ordering::SeqCst) {
                out.kind = Some(FailKind::Timeout);
                out.error = Some("脚本超时：已超过时限，被强制中断".into());
                return;
            }
            if completed.get() {
                return;
            }
            if stalled.call::<_, bool>(()).unwrap_or(false) {
                out.kind = Some(FailKind::Stalled);
                return;
            }
            // 等工具回执：这段不计入脚本墙钟（可能正在等用户审批），但给一个硬上限兜底
            let wait_from = Instant::now();
            match reply_rx.recv_timeout(TOOL_WAIT_CAP) {
                Ok((id, reply)) => {
                    budget_us.fetch_add(wait_from.elapsed().as_micros() as u64, Ordering::Relaxed);
                    // 阻塞是安全的：VM 里没有 timer/IO，不等结果也没别的事可做
                    if settle.call::<_, ()>((id, reply.ok, reply.payload)).is_err() {
                        out.kind = Some(FailKind::Sandbox);
                        out.error = Some("宿主回执投递失败".into());
                        return;
                    }
                }
                // 宿主没了（整轮被取消 / 任务被 abort）：立刻收尾，不要傻等 10 分钟
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    interrupt.store(true, Ordering::SeqCst);
                    out.kind = Some(FailKind::Sandbox);
                    out.error = Some("宿主侧已结束（本轮被取消），脚本终止".into());
                    return;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    interrupt.store(true, Ordering::SeqCst);
                    out.kind = Some(FailKind::Timeout);
                    out.error = Some(format!(
                        "脚本超时：单个工具调用等了超过 {} 分钟没有结果",
                        TOOL_WAIT_CAP.as_secs() / 60
                    ));
                    return;
                }
            }
        }
    });

    out.output = texts.borrow().clone();
    if let Some(f) = fatal.borrow_mut().take() {
        out.kind = Some(FailKind::Sandbox);
        out.error = Some(f);
        return Ok(out);
    }
    match finished.borrow_mut().take() {
        Some((true, payload)) => {
            out.ok = true;
            out.value = if payload.trim().is_empty() { None } else { Some(payload) };
        }
        Some((false, payload)) => {
            // 脚本自己抛的错优先于循环里记的超时（超时那条已带上 kind）
            if out.kind.is_none() {
                out.kind = Some(FailKind::Script);
                out.error = Some(pretty_script_error(&payload, offset));
            }
        }
        None => {
            if out.error.is_none() {
                out.kind = Some(FailKind::Sandbox);
                out.error = Some("脚本既没有正常结束也没有报错（VM 驱动异常）".into());
            }
        }
    }
    Ok(out)
}

/// 把 `eval_script:L:C` 里的行号还原成脚本行号；prelude 的帧直接丢掉。
fn shift_lines(text: &str, offset: usize) -> String {
    let mut kept: Vec<String> = Vec::new();
    for line in text.lines() {
        match rewrite_frame(line, offset) {
            Frame::Keep(s) => kept.push(s),
            Frame::Drop => {}
            Frame::Plain(s) => kept.push(s),
        }
    }
    kept.join("\n")
}

enum Frame {
    Keep(String),
    Drop,
    Plain(String),
}

/// 重写单行里的所有 `eval_script:L:C` 引用。
fn rewrite_frame(line: &str, offset: usize) -> Frame {
    const TAG: &str = "eval_script:";
    if !line.contains(TAG) {
        return Frame::Plain(line.to_string());
    }
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    let mut dropped = false;
    while let Some(pos) = rest.find(TAG) {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + TAG.len()..];
        let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        let line_no: usize = digits.parse().unwrap_or(0);
        if line_no == 0 || line_no <= offset {
            // prelude 里的帧（或解析不出来）：整行丢掉
            dropped = true;
            break;
        }
        out.push_str(&format!("脚本第 {} 行", line_no - offset));
        rest = &after[digits.len()..];
    }
    if dropped {
        return Frame::Drop;
    }
    out.push_str(rest);
    Frame::Keep(out)
}

/// prelude 的 done(false) 给的是 `{name,message,stack}` JSON，转成给人（模型）看的文本。
fn pretty_script_error(payload: &str, offset: usize) -> String {
    let v: serde_json::Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(_) => return payload.to_string(),
    };
    let message = v.get("message").and_then(|m| m.as_str()).unwrap_or("脚本错误");
    let name = v.get("name").and_then(|m| m.as_str()).unwrap_or("Error");
    let stack = v.get("stack").and_then(|m| m.as_str()).unwrap_or("");
    let body = shift_lines(stack, offset);
    // 栈的第一行通常就是 "Name: message"，与 head 重复
    let head = format!("{name}: {message}");
    let rest: Vec<&str> = body
        .lines()
        .filter(|l| l.trim() != head.trim())
        .filter(|l| !l.trim().is_empty())
        .collect();
    if rest.is_empty() {
        head
    } else {
        format!("{head}\n{}", rest.join("\n"))
    }
}

const PRELUDE_TMPL: &str = r#"
(function (bridge, toolsJson) {
"use strict";
// ---- 冻结我们自己的引用：脚本即使改了内建对象，也不能影响我们回报给宿主的东西 ----
const stringify = JSON.stringify;
const parse = JSON.parse;
const then = Promise.prototype.then;
const ErrorCtor = Error;
const TypeErrorCtor = TypeError;
const RangeErrorCtor = RangeError;
const pending = new Map();
let nextId = 1;
let finished = false;
const EXIT = Object.freeze({});

function done(ok, payload) {
  if (finished) return;
  finished = true;
  bridge("done", ok ? "1" : "0", payload || "", "");
}
function serialize(v) { return v === undefined ? "" : stringify(v); }
function errorText(e) {
  const head = (e && e.message) ? ((e.name || "Error") + ": " + e.message) : String(e && e.name ? e.name : e);
  const frames = (e && typeof e.stack === "string")
    ? e.stack.split("\n").filter(function (l) { return l.trim(); })
    : [];
  return [head].concat(frames).join("\n");
}
function format(v) {
  if (typeof v === "string") return v;
  if (v instanceof ErrorCtor) return errorText(v);
  try { const j = stringify(v); return j === undefined ? String(v) : j; } catch (e) { return String(v); }
}
function describeError(e) {
  try {
    if (e instanceof ErrorCtor) return stringify({ name: String(e.name), message: String(e.message), stack: errorText(e) });
    return stringify({ message: String(format(e)) });
  } catch (x) { return stringify({ message: "脚本抛出了一个无法描述的值" }); }
}

// 工具：调用挂成 Promise，id 由 VM 分配，宿主按 id 回投结果
function caller(name) {
  return function () {
    const args = arguments;
    return new Promise(function (resolve, reject) {
      let json;
      try { json = serialize(args[0]); } catch (e) { reject(e); return; }
      const id = nextId++;
      pending.set(id, { resolve: resolve, reject: reject });
      bridge("call", String(id), name, json);
    });
  };
}
const tools = Object.create(null);
const all = [];
const decls = parse(toolsJson);
for (let i = 0; i < decls.length; i++) {
  const d = decls[i];
  const fn = caller(d.name);
  if (!(d.jsName in tools)) { tools[d.jsName] = fn; all.push(Object.freeze({ name: d.jsName })); }
  if (!(d.name in tools)) tools[d.name] = fn;
}
Object.freeze(tools);
Object.freeze(all);
// 拼错工具名时直接说「你是不是想用 X」，省掉一轮「不是函数」的瞎猜。
// 归一化后比编辑距离（阈值 2）—— 模型最常犯的是字母换位（alpah / alpha），
// 光靠包含关系抓不到这种。
function comparable(s) { return s.toLowerCase().replace(/[^a-z0-9]/g, ""); }
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = [];
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
function guard(target, label, names) {
  return new Proxy(target, {
    get: function (o, p, r) {
      if (typeof p !== "string" || p in o || p in Object.prototype || p === "then" || p === "toJSON") {
        return Reflect.get(o, p, r);
      }
      const want = comparable(p);
      let fuzzy = names.filter(function (n) { return comparable(n) === want; });
      if (!fuzzy.length) {
        fuzzy = names
          .map(function (n) { return [n, editDistance(want, comparable(n))]; })
          .filter(function (pair) { return pair[1] <= 2; })
          .sort(function (x, y) { return x[1] - y[1]; })
          .map(function (pair) { return pair[0]; });
      }
      if (!fuzzy.length) {
        fuzzy = names.filter(function (n) {
          return want && (comparable(n).indexOf(want) !== -1 || want.indexOf(comparable(n)) !== -1);
        });
      }
      let msg = label + "." + p + " 不存在。";
      if (fuzzy.length) msg += "你是不是想用 " + fuzzy.slice(0, 5).map(function (n) { return label + "." + n; }).join(" / ") + "？";
      else if (names.length <= 20) msg += "可用：" + names.join(", ") + "。";
      msg += " ALL_TOOLS 里有全部工具名。";
      throw new TypeErrorCtor(msg);
    }
  });
}
const toolsProxy = guard(tools, "tools", all.map(function (t) { return t.name; }));

// 输出：直接回给宿主（宿主收集顺序），字符数早拦
let outChars = 0;
function output(kind, textValue) {
  if (finished) return;
  outChars += textValue.length;
  if (outChars > __MAX_OUTPUT__) {
    const err = new RangeErrorCtor("脚本输出超过 __MAX_OUTPUT__ 字符上限；请只输出摘要，正文留给工具或返回值");
    done(false, describeError(err));
    throw err;
  }
  bridge("output", kind, textValue, "");
}
function outputText(v) {
  if (v === undefined || v === null || (typeof v !== "object" && typeof v !== "function")) return String(v);
  const j = stringify(v);
  return j === undefined ? String(v) : j;
}
function text(v) { output("text", outputText(v)); }
const consoleObj = {};
["log", "info", "warn", "error", "debug"].forEach(function (lvl) {
  consoleObj[lvl] = function () {
    output("console", Array.prototype.map.call(arguments, format).join(" "));
  };
});
function exit() { done(true, ""); throw EXIT; }

Object.defineProperty(globalThis, "tools", { value: toolsProxy, enumerable: true });
Object.defineProperty(globalThis, "ALL_TOOLS", { value: all, enumerable: true });
Object.defineProperty(globalThis, "console", { value: Object.freeze(consoleObj), enumerable: true });
Object.defineProperty(globalThis, "text", { value: text, enumerable: true });
Object.defineProperty(globalThis, "exit", { value: exit, enumerable: true });

return {
  settle: function (id, ok, payload) {
    const e = pending.get(id);
    if (!e) return;
    pending.delete(id);
    if (!ok) { e.reject(new ErrorCtor(payload)); return; }
    let v;
    try { v = payload === "" ? undefined : parse(payload); } catch (err) { e.reject(err); return; }
    e.resolve(v);
  },
  run: function (fn) {
    let p;
    try { p = fn(toolsProxy, consoleObj); } catch (e) { done(false, describeError(e)); return; }
    then.call(p, function (v) {
      let json;
      try { json = serialize(v); } catch (e) { done(false, describeError(e)); return; }
      done(true, json);
    }, function (e) { done(false, describeError(e)); });
  },
  stalled: function () {
    if (finished || pending.size > 0) return false;
    done(false, stringify({ name: "Error", message: "脚本在等一个永远不会结束的 Promise：没有待完成的工具调用，这里也没有 timer。" }));
    return true;
  }
};
})
"#;

#[cfg(test)]
mod tests {
    use super::*;

    /// 行号还原：prelude 帧丢掉，脚本帧换成「脚本第 N 行」。
    #[test]
    fn rewrite_frame_shifts_script_lines_and_drops_prelude() {
        let offset = 100;
        match rewrite_frame("    at <anonymous> (eval_script:105:3)", offset) {
            Frame::Keep(s) => assert_eq!(s, "    at <anonymous> (脚本第 5 行:3)"),
            _ => panic!("脚本帧应保留"),
        }
        assert!(matches!(
            rewrite_frame("    at run (eval_script:98:18)", offset),
            Frame::Drop
        ));
        assert!(matches!(rewrite_frame("ReferenceError: x is not defined", offset), Frame::Plain(_)));
    }

    /// 错误对象 → 人读文本：head 不重复、栈保留。
    #[test]
    fn pretty_error_keeps_stack_without_duplicating_head() {
        let payload = serde_json::json!({
            "name": "TypeError",
            "message": "boom",
            "stack": "TypeError: boom\n    at <anonymous> (eval_script:103:1)"
        })
        .to_string();
        let text = pretty_script_error(&payload, 100);
        assert!(text.starts_with("TypeError: boom"), "{text}");
        assert_eq!(text.matches("TypeError: boom").count(), 1, "head 不应重复：{text}");
        assert!(text.contains("脚本第 3 行"), "{text}");
    }

    #[test]
    fn output_cap_is_interpolated() {
        assert!(prelude().contains(&format!("> {MAX_OUTPUT_CHARS}")));
        assert!(!prelude().contains("__MAX_OUTPUT__"));
    }

    // ---- 真跑 VM：用假工具表验证「调用—回投—输出」整条链路 ----

    fn decls(names: &[&str]) -> Vec<ToolDecl> {
        names
            .iter()
            .map(|n| ToolDecl { name: n.to_string(), js_name: n.to_string() })
            .collect()
    }

    /// 驱动一次执行；`handler` 决定每个工具调用怎么回。
    async fn drive(
        code: &str,
        names: &[&str],
        timeout_ms: u64,
        handler: impl Fn(&str, &str) -> CallReply,
    ) -> Outcome {
        let mut host = spawn(code.to_string(), decls(names), timeout_ms);
        while let Some(req) = host.next().await {
            let reply = handler(&req.name, &req.args);
            host.answer(req.id, reply);
        }
        host.finish().await
    }

    /// 主链路：await 工具 → text() → return。三者都要回到宿主。
    #[tokio::test]
    async fn runs_script_and_collects_output_and_return() {
        let out = drive(
            r#"
const a = await tools.alpha({ q: 1 });
text("got " + a);
console.log("n", 2);
return { ok: true };
"#,
            &["alpha"],
            5_000,
            |name, args| {
                assert_eq!(name, "alpha");
                assert!(args.contains("\"q\""), "参数应原样到达：{args}");
                CallReply::ok("A")
            },
        )
        .await;
        assert!(out.ok, "{:?}", out.error);
        assert_eq!(out.value.as_deref(), Some("{\"ok\":true}"));
        let texts: Vec<&str> = out.output.iter().map(|(_, t)| t.as_str()).collect();
        assert_eq!(texts, vec!["got A", "n 2"]);
        assert_eq!(out.kind, None);
    }

    /// 工具抛错 → 脚本 catch 得到 Error；脚本仍能正常结束。
    #[tokio::test]
    async fn tool_error_is_catchable_in_script() {
        let out = drive(
            "try { await tools.alpha({}); return 'no'; } catch (e) { return e.message; }",
            &["alpha"],
            5_000,
            |_, _| CallReply::err("炸了"),
        )
        .await;
        assert!(out.ok, "{:?}", out.error);
        assert_eq!(out.value.as_deref(), Some("\"炸了\""));
    }

    /// 死循环必须被中断（不能把宿主线程钉死）。
    #[tokio::test]
    async fn infinite_loop_is_interrupted() {
        let out = drive("while (true) {}", &["alpha"], 200, |_, _| CallReply::ok("")).await;
        assert_eq!(out.kind, Some(FailKind::Timeout), "{out:?}");
    }

    /// 空等一个永远不会 settle 的 Promise → 立刻判定卡住（VM 里没有 timer，没人能唤醒它）。
    #[tokio::test]
    async fn awaiting_forever_is_reported_as_stalled() {
        let out = drive("await new Promise(() => {})", &["alpha"], 5_000, |_, _| CallReply::ok("")).await;
        assert_eq!(out.kind, Some(FailKind::Stalled), "{out:?}");
    }

    /// 拼错工具名要给出「你是不是想用 X」，而不是抛一个空泛的 not a function。
    #[tokio::test]
    async fn unknown_tool_suggests_close_match() {
        let out = drive("await tools.alpah({})", &["alpha"], 5_000, |_, _| CallReply::ok("")).await;
        let err = out.error.unwrap_or_default();
        assert!(err.contains("你是不是想用 tools.alpha"), "{err}");
    }

    /// 报错行号要能还原到脚本自己的行（不是 prelude 的行）。
    #[tokio::test]
    async fn error_line_maps_to_script_line() {
        let out = drive("\nconst a = 1;\nnull.foo;", &["alpha"], 5_000, |_, _| CallReply::ok("")).await;
        let err = out.error.unwrap_or_default();
        assert!(err.contains("脚本第 3 行"), "应指到第 3 行：{err}");
    }
}
