//! ai_tools 子模块 · fs_shell —— 文件读写 / 命令执行 / 安全表达式求值（落到真实文件系统与 shell）
//!
//! 由 ai_tools.rs（5245 行）按工具族机械拆分而来，逻辑零改动。
//! 父模块的 use 导入与共享项经 `use super::*` 取得；这里的顶层项统一 pub(crate)，
//! 由 ai_tools.rs 的 `pub(crate) use <mod>::*` 转出，外部引用路径不变。
#![allow(unused_imports)] //  glob 取父模块导入，按族切分后必有剩余，逐个删只会漏
use super::*;

// ========== 文件读写 / 命令执行 工具（C 增强：让 Agent 能落到真实文件系统与 shell） ==========
//
// 安全边界（按用户授权意图）：
// - read_file：任意路径读取（只读、非破坏），无审批。
// - write_file：目标在项目根目录内 → 直接写；在项目根外 → 交互式审批（ai-agent-approval 事件
//   → 前端弹窗 → 回调 ai_agent_approve），超时未决则视为拒绝。
// - run_command：任意命令，限时 15s、非 shell 中文案，走项目根或 cwd 参数。
// 阻塞 IO 一律 spawn_blocking，符合本仓库「阻塞操作不得占用 Tokio 运行时」约定。

/// 待用户审批的挂起操作。
pub(crate) struct PendingApproval {
    _tool: String,
    _operation: String,
    pub(crate) sender: tokio::sync::oneshot::Sender<bool>,
}

/// 全局审批注册表：approval_id → 挂起操作。ai_agent_approve 从这张表取回发送端并 resolve。
pub(crate) static APPROVAL_STORE: OnceLock<Mutex<std::collections::HashMap<String, PendingApproval>>> = OnceLock::new();
pub(crate) fn approval_store() -> &'static Mutex<std::collections::HashMap<String, PendingApproval>> {
    APPROVAL_STORE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// 发起一次审批：注册挂起操作 → 发射 ai-agent-approval → 等待用户决定（默认 120s 超时拒绝）。
pub(crate) async fn request_approval(ctx: &ToolContext, tool: &str, operation: &str) -> Result<bool, String> {
    let approval_id = format!("ap_{}_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis()).unwrap_or(0), rand_short());
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    approval_store()
        .lock()
        .map_err(|_| "审批存储锁获取失败".to_string())?
        .insert(
            approval_id.clone(),
            PendingApproval { _tool: tool.to_string(), _operation: operation.to_string(), sender: tx },
        );
    let _ = ctx.app.emit(
        "ai-agent-approval",
        serde_json::json!({
            "requestId": ctx.request_id,
            "approvalId": approval_id,
            "tool": tool,
            "operation": operation,
        }),
    );
    match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
        Ok(Ok(true)) => Ok(true),
        Ok(Ok(false)) => Err("用户拒绝了该文件操作".to_string()),
        Ok(Err(_)) => Err("授权通道已关闭".to_string()),
        Err(_) => {
            let _ = approval_store().lock().map(|mut m| m.remove(&approval_id));
            Err("授权请求超时（120s 未确认，已拒绝）".to_string())
        }
    }
}

/// 简短随机串（事件/审批 id 后缀，避免多请求冲突）。
pub(crate) fn rand_short() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    format!("{:08x}", t)
}

/// 判断 target 是否落在 root 之下（对已存在路径 canonicalize；未存在的写目标取其最近存在祖先）：
/// 用于「写文件项目根内直接放行 / 项目根外需审批」的判定。
pub(crate) fn is_under_path(target: &std::path::Path, root: &std::path::Path) -> bool {
    let r = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let norm = target
        .canonicalize()
        .unwrap_or_else(|_| {
            target
                .parent()
                .and_then(|p| p.canonicalize().ok().map(|c| c.join(target.file_name().unwrap_or_default())))
                .unwrap_or_else(|| target.to_path_buf())
        });
    norm.starts_with(&r)
}

/// 会话级「信任项目」集合：首次在某个项目根内执行写操作时弹窗确认，
/// 通过后本会话内该项目内写文件免单次审批。
pub(crate) static TRUSTED_PROJECTS: OnceLock<Mutex<std::collections::HashSet<std::path::PathBuf>>> = OnceLock::new();
pub(crate) fn trusted_projects() -> &'static Mutex<std::collections::HashSet<std::path::PathBuf>> {
    TRUSTED_PROJECTS.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

/// 首次访问未信任项目 → 弹「信任此项目」确认；通过后记录本会话信任。已信任则直接返回。
pub(crate) async fn ensure_project_trusted(ctx: &ToolContext) -> Result<(), String> {
    let Some(root) = &ctx.project_root else { return Ok(()); };
    let canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    if trusted_projects().lock().map_err(|_| "信任存储锁失败".to_string())?.contains(&canon) {
        return Ok(());
    }
    let ok = request_approval(
        ctx,
        "trust",
        &format!("首次在此项目内写文件，是否信任该目录（本会话内经此确认后，项目内写文件免单次确认）？\n{}", root.display()),
    ).await?;
    if !ok {
        return Err("用户未信任该项目，已拒绝写入".to_string());
    }
    trusted_projects().lock().map_err(|_| "信任存储锁失败".to_string())?.insert(canon);
    Ok(())
}

/// 一次待审阅的暂存编辑。write/edit/delete 先落到该结构（不立即写盘），
/// read_file 会叠加这些暂存生成 overlay 视图（模型能读到改后内容），
/// agent-loop 结束后 emit ai-agent-edits 交由前端审阅，用户确认后才真正写盘。
#[derive(Clone)]
pub(crate) struct PendingEdit {
    pub(crate) id: String,
    pub(crate) action: String, // write / edit / delete
    pub(crate) path: String,
    // write: 新全文；edit: 用于精确定位替换信息（old/new）；delete 无
    pub(crate) new_content: Option<String>,
    pub(crate) old_string: Option<String>,
    pub(crate) new_string: Option<String>,
    // diff 载体（对齐 dsh FileDiff：oldText/newText，供前端渲染改动前后差异，不影响落盘）
    //   write: old_text=None(新文件/覆盖写无 before-image)，new_text=新全文
    //   edit:  行级上下文 old_text / 替换后的 new_text（与 ai_agent_apply_edits 落盘替换语义一致）
    //   delete: old_text=磁盘原文(截断)，new_text=None
    pub(crate) old_text: Option<String>,
    pub(crate) new_text: Option<String>,
    pub(crate) order: usize,
}

/// 请求级编辑暂存：request_id → 该请求产出的待审阅编辑（按到达顺序）。
pub(crate) static EDIT_STORE: OnceLock<Mutex<std::collections::HashMap<String, Vec<PendingEdit>>>> = OnceLock::new();
pub(crate) fn edit_store() -> &'static Mutex<std::collections::HashMap<String, Vec<PendingEdit>>> {
    EDIT_STORE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// 记录一次暂存编辑；order 为追加序号，read overlay 与最终落盘都按此顺序重放。
/// 落盘前把「改前内容」备份进本轮快照（2026-10-20）。
///
/// 快照是保险，不是前置条件：备份失败只告警，不阻止写入 —— 否则磁盘满/权限异常时
/// 连正常的写文件都会被一个辅助功能拖死。
fn capture_before_write(ctx: &ToolContext, path: &std::path::Path) {
    if let Some(root) = ctx.project_root.as_ref() {
        if let Err(e) = crate::services::checkpoint::capture(root, path) {
            log::warn!("[checkpoint] 捕获失败（继续写入）: {} - {}", path.display(), e);
        }
    }
}

/// 写入内容（建父目录 + 写盘）。改前快照由调用方先做。
fn write_disk(path: &std::path::Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    std::fs::write(path, content.as_bytes()).map_err(|e| format!("写入失败: {e}"))
}

/// edit 的替换语义（与旧落盘实现保持一致）：出现多次则全替换，否则只替换首个。
fn apply_edit_text(text: &str, old: &str, new: &str) -> Option<String> {
    if old.is_empty() {
        return None;
    }
    let count = text.matches(old).count();
    if count == 0 {
        return None;
    }
    if count > 1 {
        return Some(text.replace(old, new));
    }
    let idx = text.find(old)?;
    let mut out = String::with_capacity(text.len() + new.len().saturating_sub(old.len()));
    out.push_str(&text[..idx]);
    out.push_str(new);
    out.push_str(&text[idx + old.len()..]);
    Some(out)
}

pub(crate) fn record_edit(request_id: &str, mut e: PendingEdit) {
    let mut store = edit_store().lock().unwrap_or_else(|_| {
        // 锁中毒兜底：清空重建，极罕见
        *EDIT_STORE.get_or_init(|| Mutex::new(std::collections::HashMap::new())).lock().expect("edit store lock") = Default::default();
        edit_store().lock().expect("edit store relock")
    });
    let list = store.entry(request_id.to_string()).or_default();
    e.order = list.len();
    list.push(e);
}

/// 把当前磁盘内容叠加该请求所有暂存编辑，重放生成「改后视图」。
/// 返回 (overlay_text, deleted)。若该路径被 <delete> 暂存，deleted=true 且 overlay 为空。
pub(crate) fn apply_pending_overlay(request_id: &str, path: &std::path::Path, base: String) -> Result<(String, bool), String> {
    let store = edit_store().lock().map_err(|_| "编辑存储锁获取失败".to_string())?;
    let Some(list) = store.get(request_id) else {
        return Ok((base, false));
    };
    // 只取作用于同一文件的编辑，按 order 顺序重放
    let mut text = base.clone();
    let mut deleted = false;
    let mut applied = 0usize;
    for e in list {
        if e.path != path.to_string_lossy().as_ref() { continue; }
        match e.action.as_str() {
            "delete" => { deleted = true; text = String::new(); applied += 1; }
            "write" => {
                text = e.new_content.clone().unwrap_or_default();
                deleted = false;
                applied += 1;
            }
            "edit" => {
                let old = e.old_string.clone().unwrap_or_default();
                let new = e.new_string.clone().unwrap_or_default();
                if !old.is_empty() && text.contains(&old) {
                    let all = text.matches(&old).count() > 1;
                    if all {
                        text = text.replace(&old, &new);
                    } else {
                        // 替换首个匹配
                        if let Some(idx) = text.find(&old) {
                            let mut s = String::with_capacity(text.len() + new.len().saturating_sub(old.len()));
                            s.push_str(&text[..idx]);
                            s.push_str(&new);
                            s.push_str(&text[idx + old.len()..]);
                            text = s;
                        }
                    }
                    applied += 1;
                }
            }
            _ => {}
        }
    }
    if deleted {
        Ok((String::new(), true))
    } else if applied > 0 {
        // 追加提示「叠加了 N 条未确认改动」，帮助模型理解这是改后视图
        Ok((format!("{}（已叠加 {} 条待审阅改动，尚未写入磁盘）", text, applied), false))
    } else {
        Ok((text, false))
    }
}

/// 计算一次 edit 的行级 diff 载体（对齐 dsh FileDiff）：定位 old 在 view 中的所在行块，
/// 返回 (found, 旧行, 新行)。行块取 old 前一换行后到其后一换行前；跨行则覆盖首行头→末行尾。
/// 新行替换语义与落盘（ai_agent_apply_edits）一致：多次出现全替换，否则仅首个。
pub(crate) fn extract_edit_diff(view: &str, old: &str, new: &str) -> (bool, String, String) {
    match view.find(old) {
        None => (false, String::new(), String::new()),
        Some(idx) => {
            let ls = view[..idx].rfind('\n').map(|i| i + 1).unwrap_or(0);
            let after = idx + old.len();
            let le = view[after..].find('\n').map(|i| after + i).unwrap_or(view.len());
            let old_line = view[ls..le].to_string();
            let new_line = if old_line.matches(old).count() > 1 {
                old_line.replace(old, new)
            } else {
                old_line.replacen(old, new, 1)
            };
            (true, old_line, new_line)
        }
    }
}

/// 从文件扩展名推导语法高亮语言提示（对齐 dsh ReadResultView.lang；未知扩展返回 None）。
pub(crate) fn guess_lang(p: &std::path::Path) -> Option<&'static str> {
    let ext = p.extension().and_then(|e| e.to_str()).map(|s| s.to_ascii_lowercase());
    match ext.as_deref() {
        Some("rs") => Some("rust"),
        Some("ts") | Some("tsx") | Some("mts") | Some("cts") => Some("typescript"),
        Some("js") | Some("jsx") | Some("mjs") | Some("cjs") => Some("javascript"),
        Some("py") | Some("pyi") => Some("python"),
        Some("go") => Some("go"),
        Some("java") | Some("kt") | Some("kts") => Some("java"),
        Some("rb") => Some("ruby"),
        Some("php") => Some("php"),
        Some("c") | Some("h") => Some("c"),
        Some("cpp") | Some("cc") | Some("cxx") | Some("hpp") => Some("cpp"),
        Some("cs") => Some("csharp"),
        Some("swift") => Some("swift"),
        Some("sql") => Some("sql"),
        Some("html") | Some("htm") | Some("vue") => Some("html"),
        Some("css") | Some("scss") | Some("less") => Some("css"),
        Some("json") | Some("jsonc") => Some("json"),
        Some("md") | Some("markdown") => Some("markdown"),
        Some("yml") | Some("yaml") => Some("yaml"),
        Some("toml") => Some("toml"),
        Some("sh") | Some("bash") | Some("zsh") => Some("bash"),
        Some("bat") | Some("cmd") => Some("bat"),
        Some("ps1") => Some("powershell"),
        Some("xml") | Some("svg") => Some("xml"),
        Some("dockerfile") | Some("docker") => Some("dockerfile"),
        Some("ini") | Some("cfg") => Some("ini"),
        Some("lua") => Some("lua"),
        Some("r") => Some("r"),
        _ => None,
    }
}

/// 文件工具：read_file（只读，叠加暂存视图）/ write_file（暂存）/ edit（暂存）/ delete（暂存）。
/// 所有写操作先进请求级暂存，经 ai-agent-edits 审阅后才真正落盘；项目根外写入仍先交互审批。
pub(crate) struct FileTool;
#[async_trait::async_trait]
impl AiTool for FileTool {
    fn name(&self) -> &'static str {
        "file"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "读写/编辑/删除文件。action：read_file(path, offset?, limit?) 读取文件内容（任意路径，只读；offset 为起始字符偏移、limit 为字符数，用于大文件分段读取）；write_file(path, content) 整写文件；edit(path, old_string, new_string, occurrences?) 精准补丁——在原文中定位并替换（不重写整个文件；occurrences 省略替换首个、填 all 替换全部，旧文本须可唯一定位）；delete(path) 删除文件。写/删操作不会立即落盘：会先进入待审阅状态，由用户逐条确认后才真正写入磁盘；期间你用 read_file 读到的是叠加了你所有未确认改动后的视图。项目根外的写/删会额外触发交互授权。路径请传绝对路径。改代码优先用 edit，避免整写覆盖遗漏。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": { "type": "string", "description": "read_file / write_file / edit / delete" },
                        "path": { "type": "string", "description": "绝对路径" },
                        "content": { "type": "string", "description": "write_file 时写入的完整内容" },
                        "offset": { "type": "integer", "description": "read_file 时的起始字符偏移（从 0 开始，默认 0）" },
                        "limit": { "type": "integer", "description": "read_file 时的最大字符数（默认 60000）" },
                        "old_string": { "type": "string", "description": "edit 时要在原文中查找的旧文本（须唯一或由 occurrences 指定）" },
                        "new_string": { "type": "string", "description": "edit 时替换成的新文本" },
                        "occurrences": { "type": "string", "description": "edit 时替换数量：省略=首个，all=全部（默认首个）" }
                    },
                    "required": ["action", "path"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        use tokio::task::spawn_blocking;
        let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("").trim();
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("").trim();
        if path.is_empty() { return Err("file 工具缺少 path 参数".to_string()); }
        let p = std::path::PathBuf::from(path);
        match action {
            "read_file" => {
                // 偏移读取：offset/limit 按字符计，便于大文件分段（dsh 对齐）
                let offset: usize = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                let limit: usize = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(60_000) as usize;
                let overlay_req = ctx.request_id.clone();
                let (content, view) = spawn_blocking(move || -> Result<(String, serde_json::Value), String> {
                    let data = std::fs::read(&p).map_err(|e| format!("读取失败 {}: {}", p.display(), e))?;
                    let full = String::from_utf8_lossy(&data).to_string();
                    // 叠加该请求先前的未确认改动，生成「改后视图」（未删除时）
                    let (overlaid, deleted) = apply_pending_overlay(&overlay_req, &p, full).map_err(|e| format!("叠加视图失败: {}", e))?;
                    if deleted {
                        return Ok((format!("（文件 {} 已被本请求暂存删除，尚未提交）", p.display()),
                            serde_json::json!({ "card": "read", "path": p.display().to_string(), "offset": 0, "lines": [], "totalLines": 0 })));
                    }
                    let chars = overlaid.chars().collect::<Vec<_>>();
                    // 偏移取自叠加后内容的开头
                    let total = chars.len();
                    let start = offset.min(total);
                    let end = (start + limit).min(total);
                    let window: String = chars[start..end].iter().collect();
                    let head = if offset > 0 {
                        format!("（已从字符 #{} 开始显示，共 {} 字符）\n", start, total)
                    } else if total > limit {
                        format!("（文件较大，显示前 {} 字符,共 {} 字符；可用 offset 继续读取）\n", limit, total)
                    } else {
                        String::new()
                    };
                    // 行号化视图（对齐 dsh ReadResultView）：行号保留文件真实行号，lang 由扩展名推导
                    let full_lines: Vec<&str> = overlaid.split('\n').collect();
                    let total_lines = full_lines.len();
                    let mut starts: Vec<usize> = Vec::with_capacity(full_lines.len());
                    let mut acc_char = 0usize;
                    for l in &full_lines {
                        starts.push(acc_char);
                        acc_char += l.chars().count() + 1; // +1 换行符
                    }
                    let mut first_line = 1usize;
                    for (i, l) in full_lines.iter().enumerate() {
                        if start < starts[i] + l.chars().count() + 1 {
                            first_line = i + 1;
                            break;
                        }
                    }
                    let mut lines: Vec<serde_json::Value> = Vec::new();
                    for (i, l) in full_lines.iter().enumerate().skip(first_line - 1) {
                        if starts[i] >= end {
                            break;
                        }
                        let row_end = starts[i] + l.chars().count();
                        let s = start.max(starts[i]) - starts[i];
                        let e = end.min(row_end).saturating_sub(starts[i]);
                        let text: String = l.chars().skip(s).take(e.saturating_sub(s)).collect();
                        lines.push(serde_json::json!({ "number": i + 1, "text": text }));
                    }
                    let view = serde_json::json!({
                        "card": "read",
                        "path": p.display().to_string(),
                        "offset": first_line,
                        "lines": lines,
                        "totalLines": total_lines,
                        "lang": guess_lang(&p),
                    });
                    Ok((format!("{}{}", head, window), view))
                }).await.map_err(|e| format!("读取任务调度失败: {}", e))??;
                Ok(ToolExecResult::with_meta(content, view))
            }
            "write_file" => {
                let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if sandbox_service::is_protected_path(&p) {
                    return Err(format!("拒绝写入受保护路径（密钥/凭据/VCS/依赖目录）: {}", p.display()));
                }
                let under = ctx.project_root.as_ref().map(|r| is_under_path(&p, r)).unwrap_or(false);
                if under {
                    ensure_project_trusted(ctx).await?;
                } else {
                    request_approval(ctx, "file", &format!("写入外部路径: {}", p.display())).await?;
                }
                let edit_id = format!("e_{}_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis()).unwrap_or(0), rand_short());
                record_edit(&ctx.request_id, PendingEdit {
                    id: edit_id,
                    action: "write".to_string(),
                    path: p.to_string_lossy().to_string(),
                    new_content: Some(content.clone()),
                    old_string: None,
                    new_string: None,
                    // diff：覆盖写/新文件无 before-image → oldText=null（对齐 dsh）
                    old_text: None,
                    new_text: Some(content.clone()),
                    order: 0,
                });
                // 2026-10-20：**写入即落盘**。
                // 旧流程是 record_edit 暂存 → 前端审阅面板逐个确认 → ai_agent_apply_edits 落盘；
                // 审阅面板随 IDE AI 列一起删除后，没有任何代码再调落盘命令，
                // 工具却仍回「已暂存，等用户审阅」—— 文件其实一个字节没变（真实 P0）。
                // 现在改为：改前快照 → 立即写盘。用户随时可用快照回滚。
                capture_before_write(ctx, &p);
                write_disk(&p, &content)?;
                Ok(ToolExecResult::plain(format!(
                    "已写入 {}（{} 字符；本轮已自动快照，可用「历史快照」回滚）",
                    p.display(), content.chars().count()
                )))
            }
            "edit" => {
                let old_string = args.get("old_string").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let new_string = args.get("new_string").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if old_string.is_empty() {
                    return Err("edit 缺少 old_string 参数".to_string());
                }
                if sandbox_service::is_protected_path(&p) {
                    return Err(format!("拒绝编辑受保护路径（密钥/凭据/VCS/依赖目录）: {}", p.display()));
                }
                // 写语义与 write_file 一致：项目根内直写、根外审批；首次需信任项目
                let under = ctx.project_root.as_ref().map(|r| is_under_path(&p, r)).unwrap_or(false);
                if under {
                    ensure_project_trusted(ctx).await?;
                } else {
                    request_approval(ctx, "file", &format!("编辑外部路径: {}", p.display())).await?;
                }
                // 暂存前先本地校验 old_string 在「当前叠加视图」中可定位（避免审阅时才发现替换失败）
                let overlay_req = ctx.request_id.clone();
                let p_for_ov = p.clone();
                let wants = old_string.clone();
                let replacement = new_string.clone();
                // 返回 (是否可定位, 叠加视图, 所在行块 diff oldText, 替换后 diff newText)。
                // diff 用行级上下文（含该 edit 的整行），便于前端行级 diff；替换语义与落盘一致。
                let preview_ok = spawn_blocking(move || -> Result<(bool, String, String), String> {
                    let text = if let Ok(data) = std::fs::read(&p_for_ov) {
                        String::from_utf8_lossy(&data).to_string()
                    } else {
                        String::new()
                    };
                    let (overlaid, _deleted) = apply_pending_overlay(&overlay_req, &p_for_ov, text)?;
                    Ok(extract_edit_diff(&overlaid, &wants, &replacement))
                }).await.map_err(|e| format!("校验任务调度失败: {}", e))??;
                if !preview_ok.0 {
                    return Err(format!("old_string 在当前视图不存在，无法定位：{}", old_string));
                }
                let edit_id = format!("e_{}_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis()).unwrap_or(0), rand_short());
                record_edit(&ctx.request_id, PendingEdit {
                    id: edit_id,
                    action: "edit".to_string(),
                    path: p.to_string_lossy().to_string(),
                    new_content: None,
                    // clone：下面落盘还要用（record_edit 会 move 走）
                    old_string: Some(old_string.clone()),
                    new_string: Some(new_string.clone()),
                    // diff：行级 old→new（old_text 为完整行、new_text 为替换后行，供前端 diff 渲染）
                    old_text: Some(preview_ok.1),
                    new_text: Some(preview_ok.2),
                    order: 0,
                });
                // 同 write_file：改为即时落盘 + 改前快照。
                // 替换基于**磁盘当前内容**（不是 pending overlay）—— 前一次 edit 已经写盘了，
                // 再用叠加视图会把同一处改动算两遍。
                let p_edit = p.clone();
                let cur = std::fs::read_to_string(&p_edit).unwrap_or_default();
                let next = apply_edit_text(&cur, &old_string, &new_string).ok_or_else(|| {
                    format!("old_string 在当前文件不存在，无法定位：{old_string}")
                })?;
                capture_before_write(ctx, &p_edit);
                write_disk(&p_edit, &next)?;
                Ok(ToolExecResult::plain(format!(
                    "已修改 {}（本轮已自动快照，可用「历史快照」回滚）", p.display()
                )))
            }
            "delete" => {
                let under = ctx.project_root.as_ref().map(|r| is_under_path(&p, r)).unwrap_or(false);
                if sandbox_service::is_protected_path(&p) {
                    return Err(format!("拒绝删除受保护路径（密钥/凭据/VCS/依赖目录）: {}", p.display()));
                }
                if under {
                    ensure_project_trusted(ctx).await?;
                } else {
                    request_approval(ctx, "file", &format!("删除外部路径: {}", p.display())).await?;
                }
                let edit_id = format!("e_{}_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis()).unwrap_or(0), rand_short());
                // diff 载体：读磁盘原文（spawn_blocking，超长截断）作 oldText；newText=None，便于前端确认删的是什么。
                let p_for_del = p.clone();
                let old_content = spawn_blocking(move || {
                    std::fs::read_to_string(&p_for_del).unwrap_or_default()
                }).await.map_err(|e| format!("删除读取任务调度失败: {}", e))?;
                let old_text: Option<String> = {
                    let chars: Vec<char> = old_content.chars().collect();
                    if chars.is_empty() {
                        None
                    } else if chars.len() > 4000 {
                        let head: String = chars[..4000].iter().collect();
                        Some(format!("{}…（其余 {} 字符略）", head, chars.len() - 4000))
                    } else {
                        Some(old_content)
                    }
                };
                record_edit(&ctx.request_id, PendingEdit {
                    id: edit_id,
                    action: "delete".to_string(),
                    path: p.to_string_lossy().to_string(),
                    new_content: None,
                    old_string: None,
                    new_string: None,
                    old_text,
                    new_text: None,
                    order: 0,
                });
                // 同 write_file：即时删除 + 改前快照（回滚会把内容写回来）
                capture_before_write(ctx, &p);
                match std::fs::remove_file(&p) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(format!("删除失败: {e}")),
                }
                Ok(ToolExecResult::plain(format!(
                    "已删除 {}（本轮已自动快照，可用「历史快照」回滚）", p.display()
                )))
            }
            _ => Err(format!("未知 action: '{}'（可选 read_file/write_file/edit/delete）", action)),
        }
    }
    /// 调用前呈现（对齐 dsh presentCall → DiffCallView / GenericCallView）：
    /// write_file/edit → diff 卡（write 覆盖式 newText=content；edit 读一下盘生成 old/new 片段），
    /// 其余 → generic 卡带 locations。
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("");
        let generic = || {
            let (kind, verb) = match action {
                "read_file" => ("read", "读取".to_string()),
                "write_file" => ("edit", "写入".to_string()),
                "edit" => ("edit", "修改".to_string()),
                "delete" => ("delete", "删除".to_string()),
                _ => ("other", "处理文件".to_string()),
            };
            let mut m = serde_json::json!({ "card": "generic", "kind": kind, "title": format!("{} {}", verb, path) });
            if !path.is_empty() {
                m["locations"] = serde_json::json!([{ "path": path }]);
            }
            m
        };
        match action {
            "write_file" => {
                // 覆盖式写入：oldText 用 null（与 dsh 一致），newText 用请求内容（截断展示）
                let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
                let capped: String = content.chars().take(1200).collect();
                serde_json::json!({
                    "card": "diff",
                    "path": path,
                    "oldText": serde_json::Value::Null,
                    "newText": capped,
                    "truncated": content.chars().count() > 1200,
                })
            }
            "edit" => {
                let old = args.get("old").and_then(|v| v.as_str()).unwrap_or("");
                let new = args.get("new").and_then(|v| v.as_str()).unwrap_or("");
                // 读一下当前盘上文件生成“改前/改后”片段（call-time 轻量；读失败回 generic 卡）
                let diff = std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|view| {
                        let (found, old_line, new_line) = extract_edit_diff(&view, old, new);
                        found.then(|| serde_json::json!({
                            "card": "diff",
                            "path": path,
                            "oldText": old_line,
                            "newText": new_line,
                        }))
                    });
                diff.unwrap_or_else(generic)
            }
            _ => generic(),
        }
    }
}

/// 命令工具：运行 shell 命令，限时 15s、非交互，返回 stdout/stderr（截断）。
pub(crate) struct CommandTool;
#[async_trait::async_trait]
impl AiTool for CommandTool {
    fn name(&self) -> &'static str {
        "run_command"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "执行 shell 命令并返回输出。非交互。参数：command(必填，要执行的命令)；cwd(可选，工作目录，默认项目根)；timeout(可选，超时秒数，默认15，上限120)。用于运行 git/npm/pnpm/node/脚本等。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "要执行的 shell 命令" },
                        "cwd": { "type": "string", "description": "工作目录（默认项目根目录）" },
                        "timeout": { "type": "integer", "description": "超时秒数（默认15，上限120）" }
                    },
                    "required": ["command"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let command = args.get("command").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if command.is_empty() { return Err("run_command 缺少 command 参数".to_string()); }
        if sandbox_service::command_is_dangerous(&command) {
            return Err("该命令命中危险操作黑名单（格式化/磁盘/关机/不可逆删除等），已拒绝执行".to_string());
        }
        // timeout：可选超时秒数，默认 15，封顶 120，最小 1
        let timeout_secs: u64 = args.get("timeout")
            .and_then(|v| v.as_u64())
            .map(|t| t.clamp(1, 120))
            .unwrap_or(15);
        let cwd: Option<std::path::PathBuf> = args.get("cwd")
            .and_then(|v| v.as_str())
            .map(|s| s.trim()).filter(|s| !s.is_empty())
            .map(std::path::PathBuf::from)
            .or_else(|| ctx.project_root.clone());

        // 复用受限 shell 的统一执行器（run_captured）：Windows 走 cmd /C，含 Job Object 防 conhost 悬挂、
        // 按流上限截断、看门狗超时强制终止。策略上仍走本工具的「宽松黑名单兜底」命令，不套受限 shell 的弱白名单。
        let r = crate::services::shell_service::run_captured_async(
            &command,
            cwd.clone(),
            timeout_secs,
            8000,
            Vec::new(),
        )
        .await;
        if r.blocked {
            return Err(r.message);
        }
        if !r.ok {
            return Err(r.message);
        }
        if r.timed_out {
            return Err(format!("命令执行超时（>{}s，已中止）", timeout_secs));
        }
        let mut text = String::new();
        if !r.stdout.is_empty() {
            text.push_str(&r.stdout);
        }
        if !r.stderr.is_empty() {
            if !text.is_empty() { text.push('\n'); }
            text.push_str(&r.stderr);
        }
        const OCAP: usize = 8000;
        let text = if text.chars().count() > OCAP {
            format!("{}（输出过长，已截断）", text.chars().take(OCAP).collect::<String>())
        } else { text };
        // 命令「跑完」即为工具结果（对齐 dsh：退出码是结果的一部分，非工具错误）。
        // 模型从 detail 文本判别成功与否，前端可用 meta.exitCode 渲染退出态 pill。
        let exit_code = r.exit_code;
        let success = exit_code == Some(0);
        let detail = if success {
            if text.trim().is_empty() { "（命令成功，无输出）".to_string() } else { text.clone() }
        } else {
            format!("命令退出码 {}：{}", exit_code.unwrap_or(-1), text.clone())
        };
        // terminal 呈现 meta（对齐 dsh TerminalResultView）：output + exitCode + cwd，供前端渲染终端卡片
        let meta = serde_json::json!({
            "card": "terminal",
            "output": text,
            "exitCode": exit_code,
            "cwd": cwd.as_deref().map(|c| c.to_string_lossy().to_string()),
        });
        Ok(ToolExecResult::with_meta(detail, meta))
    }
    /// 调用前呈现：命令本身就是一辆终端卡（对齐 dsh TerminalCallView），附 cwd/timeout 详情。
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let command = args.get("command").and_then(|v| v.as_str()).unwrap_or("");
        let mut m = serde_json::json!({ "card": "terminal", "title": command });
        if !command.is_empty() {
            m["command"] = serde_json::Value::String(command.to_string());
        }
        if let Some(cwd) = args.get("cwd").and_then(|v| v.as_str()) {
            m["cwd"] = serde_json::Value::String(cwd.to_string());
        }
        if let Some(t) = args.get("timeout") {
            m["timeout"] = t.clone();
        }
        m
    }
}
