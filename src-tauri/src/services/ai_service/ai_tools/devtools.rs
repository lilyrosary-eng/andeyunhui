//! ai_tools 子模块 · devtools —— 开发辅助工具：git / lsp / rag_search
//!
//! 由 ai_tools.rs（5245 行）按工具族机械拆分而来，逻辑零改动。
//! 父模块的 use 导入与共享项经 `use super::*` 取得；这里的顶层项统一 pub(crate)，
//! 由 ai_tools.rs 的 `pub(crate) use <mod>::*` 转出，外部引用路径不变。
#![allow(unused_imports)] //  glob 取父模块导入，按族切分后必有剩余，逐个删只会漏
use super::*;

/// Git 工具：封装 git_service（走系统 git CLI，porcelain 解析 + 防注入 + 错误归一已内置）。
/// Agent 不必裸跑 run_command 再自行解析 git 输出，直接用结构化结果（status/diff/stage/commit/log）。
pub(crate) struct GitTool;
#[async_trait::async_trait]
impl AiTool for GitTool {
    fn name(&self) -> &'static str {
        "git"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "执行 Git 源码管理（走系统 git CLI，输出结构化）。action(必填)：status 工作区/暂存区状态 | diff 差异 | stage 暂存文件 | unstage 取消暂存 | commit 提交（需 message） | log 提交历史 | current_branch 当前分支 | branch 分支列表。repo 省略时用项目根。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": { "type": "string", "enum": ["status", "diff", "stage", "unstage", "commit", "log", "current_branch", "branch"] },
                        "repo": { "type": "string", "description": "仓库根路径（默认项目根目录）" },
                        "path": { "type": "string", "description": "diff/stage/unstage 的目标文件路径" },
                        "message": { "type": "string", "description": "commit 提交信息" },
                        "staged": { "type": "boolean", "description": "diff 只看暂存区（默认 false）" },
                        "max": { "type": "integer", "description": "log 最大条数（默认20）" }
                    },
                    "required": ["action"]
                }
            }
        })
    }
    /// 含写操作（stage/commit），独占串行，避免与批次内其他写工具并行产生竞态。
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Exclusive
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if action.is_empty() {
            return Err("git 缺少 action 参数（status/diff/stage/unstage/commit/log/current_branch/branch）".to_string());
        }
        let repo = args.get("repo").and_then(|v| v.as_str()).map(|s| s.to_string())
            .or_else(|| ctx.project_root.as_ref().map(|p| p.to_string_lossy().to_string()))
            .ok_or_else(|| "git 需要 repo（仓库根路径），且未检测到项目根".to_string())?;
        let path = args.get("path").and_then(|v| v.as_str()).map(|s| s.to_string());
        let message = args.get("message").and_then(|v| v.as_str()).map(|s| s.to_string());
        let staged = args.get("staged").and_then(|v| v.as_bool()).unwrap_or(false);
        let max = args.get("max").and_then(|v| v.as_u64()).map(|m| m as usize);

        let repo_show = repo.clone();
        let action_c = action.clone();
        let path_c = path.clone();
        let message_c = message.clone();
        // git_service 为阻塞同步 IO（std::process::Command），放 spawn_blocking，避免卡住 Tokio。
        let (result, repo_show) = tokio::task::spawn_blocking(move || {
            let r: Result<serde_json::Value, String> = (|| {
                match action_c.as_str() {
                    "status" => {
                        let s = git_service::git_status(repo)?;
                        Ok(serde_json::to_value(s).map_err(|e| e.to_string())?)
                    }
                    "diff" => {
                        let d = git_service::git_diff(repo, staged, path_c)?;
                        Ok(serde_json::json!({ "diff": d }))
                    }
                    "stage" => {
                        let p = path_c.ok_or_else(|| "git stage 需要 path".to_string())?;
                        git_service::git_stage(repo, p.clone())?;
                        Ok(serde_json::json!({ "staged": p }))
                    }
                    "unstage" => {
                        let p = path_c.ok_or_else(|| "git unstage 需要 path".to_string())?;
                        git_service::git_unstage(repo, p.clone())?;
                        Ok(serde_json::json!({ "unstaged": p }))
                    }
                    "commit" => {
                        let m = message_c.ok_or_else(|| "git commit 需要 message".to_string())?;
                        let sha = git_service::git_commit(repo, m)?;
                        Ok(serde_json::json!({ "commit": sha }))
                    }
                    "log" => {
                        let l = git_service::git_log(repo, max)?;
                        Ok(serde_json::to_value(l).map_err(|e| e.to_string())?)
                    }
                    "current_branch" => {
                        let b = git_service::git_current_branch(repo)?;
                        Ok(serde_json::json!({ "branch": b }))
                    }
                    "branch" => {
                        let b = git_service::git_branch_list(repo)?;
                        Ok(serde_json::json!({ "branches": b }))
                    }
                    _ => Err(format!("未知 git action: {}", action_c)),
                }
            })();
            (r, repo_show)
        })
        .await
        .map_err(|e| format!("git 执行任务失败: {}", e))?;
        match result {
            Ok(v) => {
                let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                let meta = serde_json::json!({
                    "card": "terminal",
                    "title": format!("git {} ({})", action, repo_show),
                    "output": text,
                });
                Ok(ToolExecResult::with_meta(text, meta))
            }
            Err(e) => Err(e),
        }
    }
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("git");
        serde_json::json!({ "card": "generic", "kind": "other", "title": format!("git {}", action) })
    }
}

/// 诊断工具：封装 lsp_service::lsp_diagnostics（tsc --noEmit / cargo check / pyright 一次性运行 + 解析）。
/// 让 Agent 在改完代码后自查编译/类型错误，形成「改 → 诊断 → 修」闭环。
pub(crate) struct LspTool;
#[async_trait::async_trait]
impl AiTool for LspTool {
    fn name(&self) -> &'static str {
        "diagnose"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "对项目运行编译器/类型检查诊断（tsc --noEmit / cargo check / pyright）。参数 path(必填，要诊断的文件绝对路径，据此选择诊断源)；project_root(可选，项目根，默认自动探测)。返回 error/warning 诊断列表，供修改代码后自查，形成改→查→修闭环。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "要诊断的文件绝对路径" },
                        "project_root": { "type": "string", "description": "项目根目录（默认自动探测）" }
                    },
                    "required": ["path"]
                }
            }
        })
    }
    /// 触发 tsc/cargo check 重量级子进程，独占串行，避免批次内同时起多个编译器进程。
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Exclusive
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if path.is_empty() {
            return Err("diagnose 缺少 path 参数".to_string());
        }
        let project_root = args.get("project_root").and_then(|v| v.as_str()).map(|s| s.to_string())
            .or_else(|| ctx.project_root.as_ref().map(|p| p.to_string_lossy().to_string()));
        // lsp_diagnostics 自身 async（内部 spawn 子进程并等待），直接 await。
        let res = lsp_service::lsp_diagnostics(path.clone(), project_root).await?;
        let err_count = res.diagnostics.iter().filter(|d| d.severity == "error").count();
        let text = if res.diagnostics.is_empty() {
            format!("诊断通过（{}，{:.2}s）：无错误/警告", res.source, res.elapsed_ms as f64 / 1000.0)
        } else {
            let mut s = format!("{}（{}ms）：{} 个 error / 共 {} 条诊断\n", res.source, res.elapsed_ms, err_count, res.diagnostics.len());
            for d in &res.diagnostics {
                s.push_str(&format!(
                    "  [{}] {}:{}:{} · {}{}\n",
                    d.severity, d.path, d.line, d.character, d.message,
                    d.code.as_ref().map(|c| format!(" ({})", c)).unwrap_or_default()
                ));
            }
            s
        };
        let meta = serde_json::json!({
            "card": "diagnostics",
            "source": res.source,
            "elapsedMs": res.elapsed_ms,
            "errorCount": err_count,
            "total": res.diagnostics.len(),
        });
        Ok(ToolExecResult::with_meta(text, meta))
    }
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        serde_json::json!({ "card": "generic", "kind": "other", "title": format!("诊断 {}", path) })
    }
}

/// RAG 检索工具：封装 rag_service（text → 嵌入向量 → 向量 top-k 检索）。
/// 默认与本机 Ollama(nomic-embed-text) 或已配置端点配合；未就绪时返回明确错误，Agent 可感知并改用其他工具。
pub(crate) struct RagSearchTool;
#[async_trait::async_trait]
impl AiTool for RagSearchTool {
    fn name(&self) -> &'static str {
        "rag_search"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "向量语义检索项目知识库/记忆（RAG）。query(必填，自然语言检索词)；top_k(可选，返回条数，默认5)；namespace(可选，general 通用知识库 / ai-ide 编程记忆 / ai-chat 对话记忆，默认 general)。适合找文档/知识库里的历史结论，不适合查代码符号（用 grep/glob）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "检索词" },
                        "top_k": { "type": "integer", "description": "返回条数（默认5）" },
                        "namespace": { "type": "string", "description": "检索空间（默认 general）" }
                    },
                    "required": ["query"]
                }
            }
        })
    }
    /// 只读检索，无副作用，可与同批只读工具并发。
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Parallel
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if query.is_empty() {
            return Err("rag_search 缺少 query 参数".to_string());
        }
        let top_k = args.get("top_k").and_then(|v| v.as_u64()).map(|k| k as usize);
        let namespace = args.get("namespace").and_then(|v| v.as_str()).map(|s| s.to_string())
            .unwrap_or_else(|| "general".to_string());
        let app = ctx.app.clone();

        // 0) 嵌入端点解析（2026-10-18 修）：此前 endpoint/api_key/model 全传 None，
        //    rag_embed_api 于是回落到本机 Ollama（localhost:11434）——没装 Ollama 时
        //    这个工具必然报「嵌入请求失败」，而工具描述却写「检索知识库」，误导 agent。
        //    这里改为复用「当前算力来源」（与前端 embed-config 的三级回落一致）：
        //    ai_get_profiles 的 active profile → base_url + api_key + /v1/embeddings。
        let embed_src: Option<(String, String, String)> = {
            let app2 = app.clone();
            tokio::task::spawn_blocking(move || -> Option<(String, String, String)> {
                let cfg = crate::services::ai_service::ai_profile::load_config(&app2);
                let legacy = crate::services::ai_service::legacy_compat::to_legacy_profiles(&cfg);
                // 优先挑「名字像嵌入模型」的档案：用户当前选中的往往是对话模型
                // （例如 LM Studio 里是 hy-mt2-1.8b），拿去打 /v1/embeddings 会 404。
                // 同一个 provider 下通常另挂着一个真正的嵌入模型（如 nomic-embed-text-v1.5）。
                let looks_like_embed = |m: &str| {
                    let m = m.to_lowercase();
                    m.contains("embed")
                        || m.contains("bge")
                        || m.contains("gte")
                        || m.contains("m3e")
                        || m.contains("nomic")
                };
                let embed_pick = legacy.profiles.iter().find(|p| {
                    !p.base_url.trim().is_empty() && looks_like_embed(&p.model)
                });
                let picked = embed_pick
                    .or_else(|| {
                        legacy.active.as_ref().and_then(|a| {
                            legacy
                                .profiles
                                .iter()
                                .find(|p| &p.id == a && !p.base_url.trim().is_empty())
                        })
                    })
                    .or_else(|| {
                        legacy
                            .profiles
                            .iter()
                            .find(|p| !p.base_url.trim().is_empty())
                    })?;
                let base = picked.base_url.trim().trim_end_matches('/');
                let endpoint = if base.ends_with("/v1") || base.contains("/v1/") {
                    format!("{base}/embeddings")
                } else {
                    format!("{base}/v1/embeddings")
                };
                let model = if looks_like_embed(&picked.model) {
                    picked.model.clone()
                } else {
                    log::warn!(
                        "[rag_search] 没找到名字像嵌入模型的档案，退回 active 端点 + text-embedding-3-small（可能不被该端点支持）"
                    );
                    "text-embedding-3-small".to_string()
                };
                Some((endpoint, picked.api_key.clone(), model))
            })
            .await
            .unwrap_or(None)
        };
        if embed_src.is_none() {
            log::warn!(
                "[rag_search] 没有可用的 AI 算力来源，嵌入回落到本机 Ollama 默认端点（很可能不可用）"
            );
        }

        // 1) 文本 → 向量（rag_embed_api：OpenAI 兼容 /v1/embeddings，走 reqwest）
        let emb = rag_service::rag_embed_api(rag_service::RagEmbedRequest {
            texts: vec![query.clone()],
            endpoint: embed_src.as_ref().map(|t| t.0.clone()),
            api_key: embed_src.as_ref().map(|t| t.1.clone()).filter(|k| !k.is_empty()),
            model: embed_src.as_ref().map(|t| t.2.clone()),
        })
        .await?;
        let query_vec = emb.embeddings.into_iter().next().ok_or_else(|| "嵌入结果为空".to_string())?;
        // 2) 向量 → SQLite top-k 检索（同步 IO，spawn_blocking）。
        //    阈值 0.2：与知识库面板一致，避免把无关块当"命中"喂给 agent。
        let ns_disp = namespace.clone();
        let (result, ns) = tokio::task::spawn_blocking(move || {
            let r = rag_service::rag_query(&app, query_vec, top_k, Some(namespace), Some(0.2), None);
            (r, ns_disp)
        })
        .await
        .map_err(|e| format!("rag 检索任务失败: {}", e))?;
        let res = result.map_err(|e| {
            format!("RAG 检索失败：{}（是否已用知识库面板导入内容、且本机嵌入服务已就绪？）", e)
        })?;
        if res.results.is_empty() {
            return Ok(ToolExecResult::plain(format!("RAG（{}）无匹配结果。", ns)));
        }
        let mut s = format!("RAG 检索 [{}] {} 条命中：\n", ns, res.total);
        for (i, h) in res.results.iter().enumerate() {
            s.push_str(&format!("{}. [来源 {} · 分 {:.3}]\n{}\n", i + 1, h.source_title, h.score, h.text));
        }
        let meta = serde_json::json!({
            "card": "search",
            "kind": "rag",
            "title": format!("RAG 检索：{}", query),
            "detail": s,
        });
        Ok(ToolExecResult::with_meta(s, meta))
    }
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let q = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
        serde_json::json!({ "card": "generic", "kind": "search", "title": format!("RAG 检索 {}", q) })
    }
}
