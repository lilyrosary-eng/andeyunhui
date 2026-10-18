//! ai_tools 子模块 · subagent —— 后台可继续子代理 worker 引擎 + send_message / interrupt / list 控制面
//!
//! 由 ai_tools.rs（5245 行）按工具族机械拆分而来，逻辑零改动。
//! 父模块的 use 导入与共享项经 `use super::*` 取得；这里的顶层项统一 pub(crate)，
//! 由 ai_tools.rs 的 `pub(crate) use <mod>::*` 转出，外部引用路径不变。
#![allow(unused_imports)] //  glob 取父模块导入，按族切分后必有剩余，逐个删只会漏
use super::*;

/// ================= 后台可继续子代理 worker 引擎（对齐 dsh subagent continuable 模型） =================
/// 每个子代理注册为一个长驻后台 worker：
///   - 消息队列(inbox)：父 agent 用 send_message 注入指令，worker 在每轮前 drain 并作为 user 消息续投；
///   - 中断标记 + abort handle：interrupt_agent 协作取消（flag）+ 强制中断在途 await；
///   - settle 通道：worker 产出最终结论时写入全局 settle 队列，父主循环在 turn 边界取走并注入上下文；
///   - 注册表：spawn / send / interrupt / list 四个控制点统一在此维护。
/// 前台（foreground）调用复用同一模型轮次引擎但非 continuable：单次最多 max_rounds 轮、遇结论即返回文本。

/// 子代理 worker 生命周期（AtomicU8）。
pub(crate) const SUBA_ST_RUNNING: u8 = 1;   // 运行中
pub(crate) const SUBA_ST_SETTLED: u8 = 2;   // 已产出结论，闲置等待 send_message 复活
pub(crate) const SUBA_ST_DONE: u8 = 3;      // 已终结（interrupt 清理 / 主动退出）
pub(crate) const SUBA_ST_ERROR: u8 = 4;     // 出错

/// 子代理 settle 记录：worker 产出结论后写入全局队列，供父会话取回并注入上下文。
#[derive(Debug, Clone)]
pub(crate) struct SubSettle {
    pub child_id: String,
    pub parent_request_id: String,
    pub role: String,
    pub conclusion: String,
    pub error: Option<String>,
}

/// 一张子代理 worker 的登记信息。
/// 字段统一 pub(crate)：ai_tools.rs 的测试（settle 队列 / 注册表簿记）要跨模块读 role/task/
/// parent_request_id 并直接构造登记项，拆分子模块后私有字段就看不见了。
pub(crate) struct SubWorker {
    /// 中断在途 await（reqwest / 工具 execute）用。
    pub(crate) abort: tokio::task::AbortHandle,
    /// 协作式取消标记；interrupt_agent 置 true，worker 在检查点/闲置等待中主动退出。
    pub(crate) cancel: Arc<AtomicBool>,
    /// 生命周期状态（SUBA_ST_*）。
    pub(crate) state: Arc<AtomicU8>,
    /// 发往该子代理的指令队列（send_message 投递）。
    pub(crate) inbox: mpsc::Sender<String>,
    /// 已产出结论（settle 后的结果槽），供 list_agents 聚合展示。
    pub(crate) result: Arc<Mutex<Option<SubSettle>>>,
    pub(crate) role: String,
    pub(crate) task: String,
    pub(crate) parent_request_id: String,
}

pub(crate) static SUBAGENTS: OnceLock<Mutex<HashMap<String, SubWorker>>> = OnceLock::new();
pub(crate) fn subagents() -> &'static Mutex<HashMap<String, SubWorker>> {
    SUBAGENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) static SUB_SETTLES: OnceLock<Mutex<VecDeque<SubSettle>>> = OnceLock::new();
pub(crate) fn sub_settles() -> &'static Mutex<VecDeque<SubSettle>> {
    SUB_SETTLES.get_or_init(|| Mutex::new(VecDeque::new()))
}

/// worker 产出结论 → 写入全局 settle 队列（供父循环 turn 边界取走注入）。
pub(crate) fn notify_subagent_settle(s: SubSettle) {
    sub_settles().lock().unwrap().push_back(s);
}

/// 取走指定父会话的所有 settle 记录（其余父会话的记录保留在原队）。
pub(crate) fn take_subagent_settles(parent_request_id: &str) -> Vec<SubSettle> {
    let mut q = sub_settles().lock().unwrap();
    let mut out = Vec::new();
    let mut kept = VecDeque::new();
    for s in q.drain(..) {
        if s.parent_request_id == parent_request_id {
            out.push(s);
        } else {
            kept.push_back(s);
        }
    }
    *q = kept;
    out
}

/// 并行子会话唯一 id 计数器：多个子代理并发时各自持有独立 child_id/request_id，避免互抢审批/事件标识。
pub(crate) static SUB_SEQ: AtomicU64 = AtomicU64::new(1);

/// 子代理单轮结果：结论文本 / 已执行工具待续跑 / 空回合。
pub(crate) enum SubRound {
    /// 模型直接产出的纯文本（可能为空，调用方决定是否作为结论）。
    Confirmed(String),
    /// 本轮有 tool_calls，已执行并回填进 messages，需继续下一轮。
    ToolCalls,
}

/// 子代理模型轮次：非流式请求（带只读工具），若含 tool_calls 则执行并把结果回填进 messages。
/// 供前台（单轮）与后台（长驻）两条路径复用，维护同一执行语义。
pub(crate) async fn subagent_model_round(
    client: &reqwest::Client,
    url: &str,
    cfg: &ResolvedTarget,
    messages: &mut Vec<serde_json::Value>,
    tools: &[serde_json::Value],
    sub_ctx: &ToolContext,
) -> Result<SubRound, String> {
    if cfg.api_key.trim().is_empty() {
        return Err("子代理：未配置 API Key".to_string());
    }
    let mut body = serde_json::json!({
        "model": cfg.model,
        "messages": messages,
        "stream": false,
        "tools": tools,
        "tool_choice": "auto",
    });
    if let Some(mt) = cfg.max_tokens {
        body["max_tokens"] = serde_json::json!(mt);
    }
    let resp = client
        .post(url)
        .header("Authorization", format!("Bearer {}", cfg.api_key.trim()))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("子代理请求失败: {}", e))?;
    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("子代理响应解析失败: {}", e))?;
    let msg = &data["choices"][0]["message"];
    let calls = msg.get("tool_calls").and_then(|c| c.as_array()).cloned().unwrap_or_default();
    if calls.is_empty() {
        let text = msg.get("content").and_then(|c| c.as_str()).unwrap_or("").trim().to_string();
        return Ok(SubRound::Confirmed(text));
    }
    // 记录本轮 assistant（带原生 tool_calls 形状），再逐条执行工具并回填。
    let mut am = serde_json::json!({ "role": "assistant", "content": serde_json::Value::Null });
    am["tool_calls"] = msg.get("tool_calls").cloned().unwrap_or(serde_json::json!([]));
    messages.push(am);
    let reg = registered_tools();
    for call in &calls {
        let fname = call.get("function").and_then(|f| f.get("name")).and_then(|n| n.as_str()).unwrap_or("");
        let fargs = call.get("function").and_then(|f| f.get("arguments")).and_then(|a| a.as_str())
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(serde_json::json!({}));
        let tool = reg.iter().find(|t| t.name() == fname).map(|b| b.as_ref() as &dyn AiTool);
        let (_ok, res) = execute_tool_once(tool, fname, &fargs, sub_ctx).await;
        messages.push(serde_json::json!({
            "role": "tool",
            "tool_call_id": call.get("id").cloned().unwrap_or(serde_json::Value::Null),
            "content": res.text,
        }));
    }
    Ok(SubRound::ToolCalls)
}

/// 闲置等待一个子代理的复活：阻塞直到收到 inbox 指令或中断；收到指令返回 Some，被中断返回 None。
pub(crate) async fn idle_wait_for_input(inbox: &mut mpsc::Receiver<String>, cancel: &Arc<AtomicBool>) -> Option<String> {
    loop {
        if cancel.load(Ordering::SeqCst) {
            return None;
        }
        let got = tokio::select! {
            m = inbox.recv() => m,
            _ = tokio::time::sleep(Duration::from_millis(150)) => None,
        };
        if let Some(m) = got {
            return Some(m);
        }
        // 超时：继续循环以复查中断标记（轻量轮询，避免忙等待独占）。
    }
}

/// 前台子代理执行循环：单次最多 6 轮，遇非空结论即返回。
/// 仅调只读工具（file/grep/glob），不触发审批；复用 execute_tool_once 同一执行闸口。
pub(crate) async fn run_subagent_once(
    app: &AppHandle,
    request_id: &str,
    cfg: &ResolvedTarget,
    role: &str,
    task: &str,
    project_root: Option<PathBuf>,
) -> Result<String, String> {
    if cfg.api_key.trim().is_empty() {
        return Err("子代理：未配置 API Key".to_string());
    }
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let reg = registered_tools();
    let tools: Vec<serde_json::Value> = reg
        .iter()
        .filter(|t| matches!(t.name(), "file" | "grep" | "glob"))
        .map(|t| t.function_schema())
        .collect();
    let root_hint = project_root.as_ref().map(|p| p.display().to_string()).unwrap_or_default();
    let system = format!(
        "你是「{}」。只专注完成以下委派任务并直接给出最终结论（不得再向外界委派子任务）：\n{}\n\n当前项目根目录：{}",
        role, task, root_hint
    );
    let mut messages: Vec<serde_json::Value> =
        vec![serde_json::json!({ "role": "system", "content": system })];
    let client = reqwest::Client::new();
    let seq = SUB_SEQ.fetch_add(1, Ordering::Relaxed);
    let sub_ctx = ToolContext {
        app: app.clone(),
        request_id: format!("{}:sub{}", request_id, seq),
        project_root,
        profile_id: None,
        // ⚠️ 子代理的工具白名单只有 file/grep/glob（见各构造点上方的 filter），
        //    所以这里 media/images 为空是**安全**的，analyze_image / generate_* 根本不会被调用。
        //    若日后放开子代理的工具白名单，必须同时把本轮的 media 与 images 传进来，
        //    否则 analyze_image 会报出**误导性**的「本轮对话没有附带图片」（用户明明发了图）。
        media: Default::default(),
        images: Vec::new(),
    };
    for _ in 0..6usize {
        match subagent_model_round(&client, &url, cfg, &mut messages, &tools, &sub_ctx).await? {
            SubRound::Confirmed(text) => {
                if text.is_empty() {
                    return Err("子代理：模型未产出结论".to_string());
                }
                return Ok(text);
            }
            SubRound::ToolCalls => continue,
        }
    }
    Err("子代理：轮次耗尽未取得结论".to_string())
}

/// 后台可继续子代理 worker 主体：长驻循环，drain inbox 投递指令、调用模型/工具，
/// 产出结论即 settle（写入结果槽 + 全局 settle 队列），随后进入闲置等待，可被 send_message 复活。
/// 由 spawn_subagent_background 包成 tokio 后台任务；被 interrupt_agent 置 cancel 后主动退出。
pub(crate) async fn run_subagent_worker(
    app: AppHandle,
    child_id: String,
    cfg: ResolvedTarget,
    role: String,
    task: String,
    project_root: Option<PathBuf>,
    parent_request_id: String,
    cancel: Arc<AtomicBool>,
    mut inbox: mpsc::Receiver<String>,
    state: Arc<AtomicU8>,
    result: Arc<Mutex<Option<SubSettle>>>,
) {
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let reg = registered_tools();
    let tools: Vec<serde_json::Value> = reg
        .iter()
        .filter(|t| matches!(t.name(), "file" | "grep" | "glob"))
        .map(|t| t.function_schema())
        .collect();
    let root_hint = project_root.as_ref().map(|p| p.display().to_string()).unwrap_or_default();
    let system = format!(
        "你是「{}」。只专注完成以下委派任务并直接给出最终结论（不得再向外界委派子任务）：\n{}\n\n当前项目根目录：{}",
        role, task, root_hint
    );
    let mut messages: Vec<serde_json::Value> =
        vec![serde_json::json!({ "role": "system", "content": system })];
    let client = reqwest::Client::new();
    let sub_ctx = ToolContext {
        app: app.clone(),
        request_id: child_id.clone(),
        project_root,
        profile_id: None,
        // ⚠️ 子代理的工具白名单只有 file/grep/glob（见各构造点上方的 filter），
        //    所以这里 media/images 为空是**安全**的，analyze_image / generate_* 根本不会被调用。
        //    若日后放开子代理的工具白名单，必须同时把本轮的 media 与 images 传进来，
        //    否则 analyze_image 会报出**误导性**的「本轮对话没有附带图片」（用户明明发了图）。
        media: Default::default(),
        images: Vec::new(),
    };
    let mut total_rounds = 0usize;
    const MAX_ROUNDS: usize = 20;

    loop {
        // 1) 中断检查点。
        if cancel.load(Ordering::SeqCst) {
            state.store(SUBA_ST_DONE, Ordering::SeqCst);
            return;
        }
        // 2) drain inbox —— 父 agent 用 send_message 投递的补充指令。
        let mut injected: Vec<String> = Vec::new();
        loop {
            match inbox.try_recv() {
                Ok(m) => injected.push(m),
                Err(_) => break,
            }
        }
        // 3) 若已 settle 且无新指令 → 闲置等待复活（被 send_message 复活 或 被中断退出）。
        if state.load(Ordering::SeqCst) == SUBA_ST_SETTLED && injected.is_empty() {
            match idle_wait_for_input(&mut inbox, &cancel).await {
                None => {
                    state.store(SUBA_ST_DONE, Ordering::SeqCst);
                    return;
                }
                Some(m) => {
                    state.store(SUBA_ST_RUNNING, Ordering::SeqCst);
                    messages.push(serde_json::json!({
                        "role": "user",
                        "content": format!("[父代理补充指令] {}", m),
                    }));
                    continue; // 复活后重新进入循环顶部，走模型调用
                }
            }
        }
        // 4) 续投非空的 injected 指令。
        for m in &injected {
            messages.push(serde_json::json!({
                "role": "user",
                "content": format!("[来自父代理的补充指令] {}", m),
            }));
        }
        // 5) 轮次上限保护。
        if total_rounds >= MAX_ROUNDS {
            let s = SubSettle {
                child_id: child_id.clone(),
                parent_request_id: parent_request_id.clone(),
                role: role.clone(),
                conclusion: "（后台子代理已达最大往返轮次，未产出最终结论）".to_string(),
                error: Some("max_rounds".to_string()),
            };
            *result.lock().unwrap() = Some(s.clone());
            state.store(SUBA_ST_DONE, Ordering::SeqCst);
            notify_subagent_settle(s);
            return;
        }
        total_rounds += 1;
        // 6) 模型轮次。
        match subagent_model_round(&client, &url, &cfg, &mut messages, &tools, &sub_ctx).await {
            Ok(SubRound::Confirmed(text)) => {
                if text.is_empty() {
                    // 空壳：标记 settled（占位），进入闲置等待更多父指令。
                    let s = SubSettle {
                        child_id: child_id.clone(),
                        parent_request_id: parent_request_id.clone(),
                        role: role.clone(),
                        conclusion: String::new(),
                        error: None,
                    };
                    *result.lock().unwrap() = Some(s.clone());
                    state.store(SUBA_ST_SETTLED, Ordering::SeqCst);
                    notify_subagent_settle(s);
                    continue;
                }
                // 最终结论 → settle 并闲置，可被 send_message 复活追问。
                let s = SubSettle {
                    child_id: child_id.clone(),
                    parent_request_id: parent_request_id.clone(),
                    role: role.clone(),
                    conclusion: text,
                    error: None,
                };
                *result.lock().unwrap() = Some(s.clone());
                state.store(SUBA_ST_SETTLED, Ordering::SeqCst);
                notify_subagent_settle(s);
                continue;
            }
            Ok(SubRound::ToolCalls) => continue, // 已回填 messages，继续下一轮
            Err(e) => {
                let s = SubSettle {
                    child_id: child_id.clone(),
                    parent_request_id: parent_request_id.clone(),
                    role: role.clone(),
                    conclusion: String::new(),
                    error: Some(e.clone()),
                };
                *result.lock().unwrap() = Some(s.clone());
                state.store(SUBA_ST_ERROR, Ordering::SeqCst);
                notify_subagent_settle(s);
                return;
            }
        }
    }
}

/// 后台 spawn 一个可继续的子代理 worker，返回 child_id（父 agent 可据此 send_message / interrupt_agent）。
pub(crate) fn spawn_subagent_background(
    app: &AppHandle,
    parent_request_id: &str,
    cfg: &ResolvedTarget,
    role: &str,
    task: &str,
    project_root: Option<PathBuf>,
) -> Result<String, String> {
    if cfg.api_key.trim().is_empty() {
        return Err("子代理：未配置 API Key".to_string());
    }
    let seq = SUB_SEQ.fetch_add(1, Ordering::Relaxed);
    let child_id = format!("{}:sub{}", parent_request_id, seq);
    let (tx, rx) = mpsc::channel(32);
    let cancel = Arc::new(AtomicBool::new(false));
    let state = Arc::new(AtomicU8::new(SUBA_ST_RUNNING));
    let result: Arc<Mutex<Option<SubSettle>>> = Arc::new(Mutex::new(None));

    let app_worker = app.clone();
    let cid = child_id.clone();
    let cfg_worker = cfg.clone();
    let role_worker = role.to_string();
    let task_worker = task.to_string();
    let parent_worker = parent_request_id.to_string();
    let cancel_worker = cancel.clone();
    let state_worker = state.clone();
    let result_worker = result.clone();
    let handle = tokio::spawn(async move {
        run_subagent_worker(
            app_worker,
            cid,
            cfg_worker,
            role_worker,
            task_worker,
            project_root,
            parent_worker,
            cancel_worker,
            rx,
            state_worker,
            result_worker,
        )
        .await;
    });

    subagents().lock().unwrap().insert(
        child_id.clone(),
        SubWorker {
            abort: handle.abort_handle(),
            cancel,
            state,
            inbox: tx,
            result,
            role: role.to_string(),
            task: task.to_string(),
            parent_request_id: parent_request_id.to_string(),
        },
    );
    Ok(child_id)
}

/// 向一个（运行中或已 settle 的）后台子代理投递补充指令，使其继续/复活。
pub(crate) async fn send_subagent_message(child_id: &str, message: &str) -> Result<String, String> {
    let tx = {
        let m = subagents().lock().unwrap();
        let w = m.get(child_id).ok_or_else(|| format!("未找到子代理 {}（可能已被中断/清理）", child_id))?;
        let st = w.state.load(Ordering::SeqCst);
        if st == SUBA_ST_DONE || st == SUBA_ST_ERROR {
            return Err(format!("子代理 {} 已终结（state={}），不可再投递", child_id, st));
        }
        w.inbox.clone()
    };
    // 锁已释放再 await，避免在 .await 上跨场景持锁。
    tx.send(message.to_string())
        .await
        .map_err(|_| "子代理消息通道已关闭".to_string())?;
    Ok(format!("已投递指令给子代理 {}", child_id))
}

/// 中断并清理一个后台子代理：协作取消（flag）+ 强制 abort 在途 await，并从注册表移除。
pub(crate) fn interrupt_subagent(child_id: &str) -> Result<String, String> {
    let w = {
        let mut m = subagents().lock().unwrap();
        m.remove(child_id).ok_or_else(|| format!("未找到子代理 {}", child_id))?
    };
    w.cancel.store(true, Ordering::SeqCst);
    // ★ 只有「把子代理从**运行中**终结」的那一次才推中断 settle。
    //
    // 为什么必须看 CAS 的返回值：worker 自己在产出结论时（store(SETTLED) + notify）
    // 已经推过一条 settle 了。原先这里两次 CAS 的结果都用 `let _ =` 丢掉、然后无条件
    // notify —— 于是「worker 先跑完、父代理再中断」这条路径会推出**两条**同一子代理的
    // settle（worker 的真实结论 + 「已由父代理中断」）。
    //
    // 影响不止测试：take_subagent_settles 是按父会话**全取且不去重**的，父代理会把
    // 同一子代理的两条结论一起注入上下文。
    //
    // 反方向也要覆盖：worker 卡在模型请求中时被 cancel，它走的是循环顶部的
    // `cancel → store(DONE) → return`（不推 settle），所以那一条必须由这里补上。
    let was_running = w
        .state
        .compare_exchange(SUBA_ST_RUNNING, SUBA_ST_DONE, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok();
    // SETTLED → DONE：仅终结状态（不可再被 send_message 复活），**不重复推 settle**。
    let _ = w.state.compare_exchange(SUBA_ST_SETTLED, SUBA_ST_DONE, Ordering::SeqCst, Ordering::SeqCst);
    let _ = w.abort.abort();
    if was_running {
        notify_subagent_settle(SubSettle {
            child_id: child_id.to_string(),
            parent_request_id: w.parent_request_id,
            role: w.role,
            conclusion: String::new(),
            error: Some("已由父代理中断".to_string()),
        });
    }
    Ok(format!("已中断子代理 {}", child_id))
}

/// 聚合当前父会话名下所有子代理的展示信息（用于 list_agents / 结果聚合卡）。
pub(crate) fn list_subagents(parent_request_id: &str) -> Vec<serde_json::Value> {
    let m = subagents().lock().unwrap();
    let mut out: Vec<serde_json::Value> = m
        .iter()
        .filter(|(_, w)| w.parent_request_id == parent_request_id)
        .map(|(id, w)| {
            let st = w.state.load(Ordering::SeqCst);
            let conclusion = w
                .result
                .lock()
                .unwrap()
                .as_ref()
                .map(|r| r.conclusion.clone())
                .unwrap_or_default();
            serde_json::json!({
                "id": id,
                "role": w.role,
                "state": st_string(st),
                "task": w.task,
                "conclusion": conclusion,
            })
        })
        .collect();
    out.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    out
}

/// 状态码 → 可读字符串（供 list_agents / 聚合卡展示）。
pub(crate) fn st_string(st: u8) -> &'static str {
    match st {
        SUBA_ST_RUNNING => "running",
        SUBA_ST_SETTLED => "settled",
        SUBA_ST_DONE => "done",
        SUBA_ST_ERROR => "error",
        _ => "unknown",
    }
}

/// 子代理工具：是把一段独立子任务委派给一个独立子助手执行并回收结论的工具（对齐 dsh subagent）。
/// 支持前台同步（默认，直接返回结论）/ 后台可继续（run_in_background=true，返回 child_id，
/// 之后可用 send_message/interrupt_agent/list_agents 控制面工具交互）。并行 sibling 委派仍成立：
/// 外层有界池对每个 subagent 工具调用并发执行，各自以唯一 child_id 独立闭环、互不干扰。
pub(crate) struct SubagentTool;

#[async_trait::async_trait]
impl AiTool for SubagentTool {
    fn name(&self) -> &'static str {
        "subagent"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "function": {
                "name": "subagent",
                "description": "把一段独立子任务委派给一个独立的子助手执行并回收其最终结论。适合代码调研、读文件、搜索等可独立完成的小步骤。子助手有独立目标，不继承当前对话上下文。用 task 写清要它做什么并请直接给结论；role 可选，指明其身份定位（如 代码审阅员 / 调研员）。设 run_in_background=true 时子助手将后台持续运行并返回 child_id，你可用 send_message 追问、interrupt_agent 中断、list_agents 聚合查看其状态。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "task": { "type": "string", "description": "给子助手的目标指令，要求返回最终结论" },
                        "role": { "type": "string", "description": "（可选）子助手身份定位，如 代码审阅员 / 调研员" },
                        "run_in_background": { "type": "boolean", "description": "（可选，默认 false）true 则后台持续运行并返回 child_id 供控制面交互，false 则同步等待并直接返回结论" }
                    },
                    "required": ["task"]
                }
            }
        })
    }
    fn concurrency(&self) -> ToolConcurrency {
        // 并行子代理：可与其他工具/其他子代理并发，由外层有界池（PARALLEL_LIMIT）限制并发上限；
        // 内部以唯一 request_id 独立闭环，无需独占屏障。
        ToolConcurrency::Parallel
    }
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let task = args.get("task").and_then(|v| v.as_str()).unwrap_or("");
        serde_json::json!({ "card": "generic", "kind": "other", "title": "委派子助手", "detail": task })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let task = args.get("task").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if task.is_empty() {
            return Err("subagent：缺少有效的 task 描述".to_string());
        }
        let role = args.get("role").and_then(|v| v.as_str()).unwrap_or("子助手").to_string();
        let bg = args.get("run_in_background").and_then(|v| v.as_bool()).unwrap_or(false);
        let config = load_config(&ctx.app);
        let cfg = resolve_target(&config, ctx.profile_id.as_deref());

        if bg {
            // 后台可继续：spawn worker 返回 child_id，控制面/settle 依赖注册表与全局队列。
            let child_id =
                spawn_subagent_background(&ctx.app, &ctx.request_id, &cfg, &role, &task, ctx.project_root.clone())?;
            let text = format!("已后台启动子助手「{}」，child_id={}。可用 send_message 追问 / interrupt_agent 中断 / list_agents 查看状态，结论将在后续自动注入。", role, child_id);
            let meta = serde_json::json!({
                "card": "subagents",
                "kind": "group",
                "title": format!("已并行委派·子助手 {}", role),
                "detail": text,
                "agents": serde_json::json!([{ "id": child_id, "role": role, "state": "running" }]),
            });
            return Ok(ToolExecResult::with_meta(text, meta));
        }

        // 前台同步：直接返回结论。
        let text = run_subagent_once(&ctx.app, &ctx.request_id, &cfg, &role, &task, ctx.project_root.clone()).await?;
        let capped: String = text.chars().take(4000).collect();
        let meta = serde_json::json!({
            "card": "generic",
            "kind": "other",
            "title": format!("子助手·{} 结论", role),
            "detail": capped,
            "truncated": text.chars().count() > 4000,
        });
        Ok(ToolExecResult::with_meta(text, meta))
    }
}

/// 控制面工具：向后台子代理投递补充指令（可复活已 settle 的子代理，也能追加给运行中的）。
pub(crate) struct SendMessageTool;
#[async_trait::async_trait]
impl AiTool for SendMessageTool {
    fn name(&self) -> &'static str {
        "send_message"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "function": {
                "name": "send_message",
                "description": "向指定的后台子代理（subagent run_in_background=true 返回的 child_id）投递一条补充指令，使其继续处理或唤醒已暂存的子代理。child_id 来自 subagent 调用的返回。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "child_id": { "type": "string", "description": "后台子代理的 child_id" },
                        "message": { "type": "string", "description": "补充指令内容" }
                    },
                    "required": ["child_id", "message"]
                }
            }
        })
    }
    fn concurrency(&self) -> ToolConcurrency {
        // 有副作用（改 worker 状态/队列），独占串行。
        ToolConcurrency::Exclusive
    }
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let child = args.get("child_id").and_then(|v| v.as_str()).unwrap_or("");
        serde_json::json!({ "card": "generic", "kind": "other", "title": "向子代理投递指令", "detail": child })
    }
    async fn execute(&self, args: &serde_json::Value, _ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let child = args.get("child_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let msg = args.get("message").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if child.is_empty() || msg.is_empty() {
            return Err("send_message：缺少 child_id 或 message".to_string());
        }
        let text = send_subagent_message(&child, &msg).await?;
        Ok(ToolExecResult::plain(text))
    }
}

/// 控制面工具：中断并清理一个后台子代理。
pub(crate) struct InterruptAgentTool;
#[async_trait::async_trait]
impl AiTool for InterruptAgentTool {
    fn name(&self) -> &'static str {
        "interrupt_agent"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "function": {
                "name": "interrupt_agent",
                "description": "中断并清理一个后台子代理（subagent run_in_background=true 返回的 child_id）。其已产出结论会作为中断原因回填给主 agent。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "child_id": { "type": "string", "description": "后台子代理的 child_id" }
                    },
                    "required": ["child_id"]
                }
            }
        })
    }
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Exclusive
    }
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let child = args.get("child_id").and_then(|v| v.as_str()).unwrap_or("");
        serde_json::json!({ "card": "generic", "kind": "other", "title": "中断子代理", "detail": child })
    }
    async fn execute(&self, args: &serde_json::Value, _ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let child = args.get("child_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if child.is_empty() {
            return Err("interrupt_agent：缺少 child_id".to_string());
        }
        let text = interrupt_subagent(&child)?;
        Ok(ToolExecResult::plain(text))
    }
}

/// 控制面工具：聚合展示当前父会话名下所有后台子代理的状态与结论。
pub(crate) struct ListAgentsTool;
#[async_trait::async_trait]
impl AiTool for ListAgentsTool {
    fn name(&self) -> &'static str {
        "list_agents"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "function": {
                "name": "list_agents",
                "description": "列出当前会话名下所有后台子代理（subagent run_in_background=true）的 id、角色、运行状态与已产出结论，便于你汇总并行 sibling 的最新进展。",
                "parameters": {
                    "type": "object",
                    "properties": {}
                }
            }
        })
    }
    fn concurrency(&self) -> ToolConcurrency {
        // 只读聚合展示，但读取全局注册表；为避免与其他 worker 操作交错，按独占处理。
        ToolConcurrency::Exclusive
    }
    fn present_call(&self, _args: &serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "card": "subagents", "kind": "group", "title": "聚合查看后台子代理" })
    }
    async fn execute(&self, _args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let agents = list_subagents(&ctx.request_id);
        let running = agents.iter().filter(|a| a["state"] == "running").count();
        let settled = agents.iter().filter(|a| a["state"] == "settled").count();
        // 汇总文本（模型可见）+ 结构化聚合卡（前端渲染）。
        let text = if agents.is_empty() {
            "当前没有运行中的后台子代理。如需并行委派，可用 subagent 并设 run_in_background=true。".to_string()
        } else {
            let mut s = format!("当前共有 {} 个后台子代理（运行中 {} / 已产出结论 {}）：\n", agents.len(), running, settled);
            for a in &agents {
                let c = a["conclusion"].as_str().unwrap_or("");
                let cap = if c.is_empty() { "（暂无结论）".to_string() } else {
                    let cc: String = c.chars().take(300).collect();
                    if c.chars().count() > 300 { format!("{}…", cc) } else { cc }
                };
                s.push_str(&format!("- [{}] role={} state={} task={}\n  结论: {}\n", a["id"], a["role"], a["state"], a["task"], cap));
            }
            s
        };
        let meta = serde_json::json!({
            "card": "subagents",
            "kind": "group",
            "title": format!("并行子代理聚合（{} 运行 / {} 结论）", running, settled),
            "detail": text,
            "agents": agents,
        });
        Ok(ToolExecResult::with_meta(text, meta))
    }
}

