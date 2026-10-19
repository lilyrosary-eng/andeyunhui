//! ai_tools 子模块 · search_web —— 代码智能 + 联网：grep / glob / mcp / skill / web_search / web_fetch
//!
//! 由 ai_tools.rs（5245 行）按工具族机械拆分而来，逻辑零改动。
//! 父模块的 use 导入与共享项经 `use super::*` 取得；这里的顶层项统一 pub(crate)，
//! 由 ai_tools.rs 的 `pub(crate) use <mod>::*` 转出，外部引用路径不变。
#![allow(unused_imports)] //  glob 取父模块导入，按族切分后必有剩余，逐个删只会漏
use super::*;

// ========== 代码智能 + 扩展 工具（合并 IDE Agent 长处，参照 dsh tool-fs-search 设计） ==========
//
// 保留 Rust function-call 底座，把 IDE Agent 里最有价值的搜索/扩展能力并入：
// - grep：内容搜索，gitignore 感知，pattern/path/include 参数、按文件分组输出、匹配上限兜底（对齐 dsh）
// - glob：文件名搜索，gitignore 感知，pattern/path 参数、按修改时间排序、路径上限兜底（对齐 dsh）
// - mcp：复用本项目 mcp_service，把已配置的 MCP 工具暴露给 Agent（对齐 IDE 的 server+tool+args 范式）
// 三者只读/非破坏，无需交互审批；阻塞 IO 一律 spawn_blocking。

/// 单次 grep 最多保留的行匹配数（对齐 Claude Code GrepTool 默认 head_limit / dsh GREP_MAX_MATCHES）。
pub(crate) const GREP_MAX_MATCHES: usize = 250;
/// 单条匹配行的最大字符数（超出截断，UTF-8 安全）。
pub(crate) const GREP_MAX_LINE_CHARS: usize = 2000;
/// 单次 glob 最多返回路径数（对齐 dsh GLOB_MAX_RESULTS）。
pub(crate) const GLOB_MAX_RESULTS: usize = 100;
/// glob 遍历时顶层的 VCS 元数据目录（对齐 dsh GLOB_VCS_EXCLUDES）。
pub(crate) const GLOB_VCS_EXCLUDES: &[&str] = &[".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];

/// 判断路径是否命中单一 glob：完整路径或仅文件名命中其一即可（align dsh「无分隔符 pattern 匹配任意深度 basename」）。
pub(crate) fn glob_matches(matcher: &globset::GlobMatcher, path: &std::path::Path) -> bool {
    if matcher.is_match(path.to_string_lossy().as_ref()) {
        return true;
    }
    match path.file_name() {
        Some(n) => matcher.is_match(n.to_string_lossy().as_ref()),
        None => false,
    }
}

/// grep：在项目内用正则搜索文件内容，返回匹配行及行号（按文件分组输出）。
pub(crate) struct GrepTool;
#[async_trait::async_trait]
impl AiTool for GrepTool {
    fn name(&self) -> &'static str {
        "grep"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "在项目内用正则表达式搜索文件内容，返回匹配行及行号、按文件分组。gitignore 感知（自动跳过 node_modules/.git 等）。定位关键词/代码时应使用本工具，而非 run_command 'grep'。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "要搜索的正则表达式（regex 语法，如 'fn .*_tool'）" },
                        "path": { "type": "string", "description": "搜索的目标目录或文件，默认当前项目根；相对路径基于项目根解析" },
                        "include": { "type": "string", "description": "仅搜索匹配该单一 glob 的文件（如 '*.ts'、'*.{js,ts}'），不支持逗号列表或取反" }
                    },
                    "required": ["pattern"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if pattern.is_empty() {
            return Err("grep 缺少 pattern 参数".to_string());
        }
        // 提前校验正则合法性
        regex::Regex::new(&pattern).map_err(|e| format!("正则无效: {}", e))?;
        let root = args
            .get("path").and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .or_else(|| ctx.project_root.clone())
            .ok_or_else(|| "grep 缺少 path，且未提供项目根目录".to_string())?;
        let include = args
            .get("include").and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let matcher = match &include {
            Some(g) => Some(
                globset::GlobBuilder::new(g).literal_separator(false).build()
                    .map_err(|e| format!("include glob 无效: {}", e))?.compile_matcher(),
            ),
            None => None,
        };

        // gitignore 感知遍历 + 逐行正则匹配，全部阻塞 IO → spawn_blocking
        let (matches, truncated) = tokio::task::spawn_blocking(move || -> Result<(Vec<(String, usize, String)>, bool), String> {
            let re = regex::Regex::new(&pattern).map_err(|e| format!("正则无效: {}", e))?;
            let mut out: Vec<(String, usize, String)> = Vec::new();
            let mut truncated = false;
            let mut walk = ignore::WalkBuilder::new(&root);
            walk.standard_filters(true);
            for entry in walk.build().flatten() {
                if out.len() >= GREP_MAX_MATCHES {
                    truncated = true;
                    break;
                }
                if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    continue;
                }
                let fp = entry.path();
                if let Some(m) = &matcher {
                    if !glob_matches(m, fp) {
                        continue;
                    }
                }
                let Ok(file) = std::fs::File::open(fp) else { continue; };
                let mut reader = std::io::BufReader::new(file);
                let mut line_no = 0usize;
                let mut first_read = true;
                let mut tmp: Vec<u8> = Vec::with_capacity(512);
                loop {
                    if out.len() >= GREP_MAX_MATCHES {
                        truncated = true;
                        break;
                    }
                    tmp.clear();
                    let n = reader
                        .read_until(b'\n', &mut tmp)
                        .map_err(|e| format!("读取 {} 失败: {}", fp.display(), e))?;
                    if n == 0 {
                        break;
                    }
                    if first_read {
                        // 二进制探针：首块含 NUL 视为二进制，跳过整文件
                        if tmp.contains(&0) {
                            break;
                        }
                        first_read = false;
                    }
                    line_no += 1;
                    if tmp.last() == Some(&b'\n') {
                        tmp.pop();
                    }
                    if tmp.last() == Some(&b'\r') {
                        tmp.pop();
                    }
                    let line = String::from_utf8_lossy(&tmp);
                    if re.is_match(&line) {
                        let capped: String = line.chars().take(GREP_MAX_LINE_CHARS).collect();
                        out.push((fp.to_string_lossy().to_string(), line_no, capped));
                    }
                }
            }
            if out.len() >= GREP_MAX_MATCHES {
                truncated = true;
            }
            Ok((out, truncated))
        })
        .await
        .map_err(|e| format!("grep 任务调度失败: {}", e))??;

        let count = matches.len();
        if count == 0 {
            return Ok(ToolExecResult::plain("No matches found".to_string()));
        }
        // 按文件分组（对齐 dsh SearchFileMatches：path + 有序匹配行），文本与结构化 meta 复用同一份分组
        let mut files: Vec<(String, Vec<(usize, String)>)> = Vec::new();
        for (p, ln, line) in &matches {
            match files.iter_mut().find(|(k, _)| k == p) {
                Some((_, rows)) => rows.push((*ln, line.clone())),
                None => files.push((p.clone(), vec![(*ln, line.clone())])),
            }
        }
        // 纯文本视图（回填 role:"tool" 消息用，保持既有格式）
        let mut s = format!("Found {} matches", count);
        if truncated {
            s.push_str(&format!("（已达单次上限 {} 条，结果已截断；请用更精确的 pattern/path/include）", GREP_MAX_MATCHES));
        }
        for (p, rows) in &files {
            s.push('\n');
            s.push_str(p);
            s.push('\n');
            s.push_str(&rows.iter().map(|(ln, txt)| format!("Line {}: {}", ln, txt)).collect::<Vec<_>>().join("\n"));
        }
        // search 呈现 meta（对齐 dsh SearchResultView 'matches' 变体：按文件分组的可展开卡片）
        let meta_files: Vec<serde_json::Value> = files.into_iter().map(|(p, rows)| {
            serde_json::json!({
                "path": p,
                "matches": rows.into_iter().map(|(ln, txt)| serde_json::json!({ "line": ln, "text": txt })).collect::<Vec<_>>(),
            })
        }).collect();
        let meta = serde_json::json!({
            "card": "search",
            "shape": "matches",
            "files": meta_files,
            "truncated": truncated,
            "total": count,
        });
        Ok(ToolExecResult::with_meta(s, meta))
    }
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Parallel
    }
}

/// glob：在项目内按文件名模式搜索文件路径（gitignore 感知、跳过 VCS 目录），按修改时间由新到旧排序。
pub(crate) struct GlobTool;
#[async_trait::async_trait]
impl AiTool for GlobTool {
    fn name(&self) -> &'static str {
        "glob"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "按文件名 glob 模式搜索项目内文件路径（如 '**/*.ts'、'src/**/*.test.*'），返回文件路径列表，按修改时间由新到旧。gitignore 感知并跳过 VCS 目录。模式不含 '/' 时按任意深度 basename 匹配。定位文件用本工具而非 shell find/ls。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "匹配文件路径的 glob 模式（如 '**/*.ts'、'*.tsx'、'src/**/*.go'）" },
                        "path": { "type": "string", "description": "搜索的起始目录，默认当前项目根；相对路径基于项目根解析" }
                    },
                    "required": ["pattern"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if pattern.is_empty() {
            return Err("glob 缺少 pattern 参数".to_string());
        }
        let matcher = globset::GlobBuilder::new(&pattern).literal_separator(false).build()
            .map_err(|e| format!("glob 模式无效: {}", e))?.compile_matcher();
        let root = args
            .get("path").and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .or_else(|| ctx.project_root.clone())
            .ok_or_else(|| "glob 缺少 path，且未提供项目根目录".to_string())?;

        // 遍历收集命中文件及其修改时间，最后按 mtime 由新到旧排序、取前 N
        let hit: Vec<(PathBuf, std::time::SystemTime)> = tokio::task::spawn_blocking(move || -> Result<Vec<(PathBuf, std::time::SystemTime)>, String> {
            let mut found: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
            let mut walk = ignore::WalkBuilder::new(&root);
            walk.standard_filters(true);
            walk.filter_entry(|e| {
                if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    let n = e.file_name().to_string_lossy();
                    return !GLOB_VCS_EXCLUDES.contains(&n.as_ref());
                }
                true
            });
            for entry in walk.build().flatten() {
                if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    continue;
                }
                let fp = entry.path();
                if !glob_matches(&matcher, fp) {
                    continue;
                }
                let mtime = std::fs::metadata(fp).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                found.push((fp.to_path_buf(), mtime));
            }
            found.sort_by(|a, b| b.1.cmp(&a.1));
            Ok(found)
        })
        .await
        .map_err(|e| format!("glob 任务调度失败: {}", e))??;

        if hit.is_empty() {
            return Ok(ToolExecResult::plain("No files found".to_string()));
        }
        let total = hit.len();
        let truncated = total > GLOB_MAX_RESULTS;
        let paths: Vec<String> = hit.into_iter().take(GLOB_MAX_RESULTS).map(|(p, _)| p.to_string_lossy().to_string()).collect();
        let mut s = paths.join("\n");
        if truncated {
            s.push('\n');
            s.push_str(&format!("（Showing {} of {} paths；请缩小 pattern 或指定 path 查看更多）", GLOB_MAX_RESULTS, total));
        }
        // search 呈现 meta（对齐 dsh SearchResultView 'paths' 变体：扁平路径列表卡片）
        let meta = serde_json::json!({
            "card": "search",
            "shape": "paths",
            "paths": paths,
            "truncated": truncated,
            "total": total,
        });
        Ok(ToolExecResult::with_meta(s, meta))
    }
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Parallel
    }
}

/// mcp：调用已配置的 MCP 服务器工具。复用 mcp_service::mcp_call_tool（spawn → call → kill）。
/// 服务器 id 见 agent 系统提示注入的 MCP 工具清单；arguments 为该工具输入 schema 对应的 JSON 对象。
pub(crate) struct McpTool;
#[async_trait::async_trait]
impl AiTool for McpTool {
    fn name(&self) -> &'static str {
        "mcp"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "调用已配置的 MCP（Model Context Protocol）服务器工具。server 填服务器 id，tool 填该服务器上的工具原始名，arguments 填工具输入结构对应的 JSON 对象（可省略则传空）。可调用的服务器与工具清单会在本会话系统提示中列出。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "server": { "type": "string", "description": "MCP 服务器 id（系统提示中列出的 id）" },
                        "tool": { "type": "string", "description": "该服务器上的工具原始名" },
                        "arguments": { "type": "object", "description": "工具输入参数 JSON 对象（可选，默认空）" }
                    },
                    "required": ["server", "tool"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let server = args.get("server").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let tool_name = args.get("tool").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if server.is_empty() {
            return Err("mcp 缺少 server 参数".to_string());
        }
        if tool_name.is_empty() {
            return Err("mcp 缺少 tool 参数".to_string());
        }
        let arguments = args.get("arguments").cloned().filter(|v| v.is_object()).unwrap_or(serde_json::json!({}));
        // 挂起/异常服务器不应无限阻塞 Agent：整体限时 30s
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            mcp_service::mcp_call_tool(ctx.app.clone(), server.clone(), tool_name.clone(), arguments),
        )
        .await
        .map_err(|_| format!("MCP 调用超时（>30s，已中止）: {}:{}", server, tool_name))?
        .map_err(|e| format!("MCP 调用失败: {}", e))?;
        if !result.ok {
            let detail = result.error.clone().unwrap_or_else(|| "无错误信息".to_string());
            return Err(format!("MCP 工具 {}:{} 返回错误: {}", server, tool_name, detail));
        }
        // 渲染 content 块：text 拼接、image/audio/resource 占位（对齐 dsh extractText）
        let mut parts: Vec<String> = Vec::new();
        for block in &result.content {
            let t = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match t {
                "text" => {
                    if let Some(txt) = block.get("text").and_then(|v| v.as_str()) {
                        parts.push(txt.to_string());
                    }
                }
                "image" => parts.push(format!("[image: {}, 内容已丢弃]", block.get("mimeType").and_then(|v| v.as_str()).unwrap_or("unknown"))),
                "audio" => parts.push(format!("[audio: {}, 内容已丢弃]", block.get("mimeType").and_then(|v| v.as_str()).unwrap_or("unknown"))),
                "resource" | "resource_link" => parts.push("[resource: 内容已丢弃]".to_string()),
                _ => {}
            }
        }
        if parts.is_empty() {
            let msg = format!("（MCP 工具 {}:{} 返回空内容）", server, tool_name);
            let meta = serde_json::json!({ "card": "generic", "kind": "other", "title": format!("MCP {}:{}", server, tool_name), "detail": msg });
            return Ok(ToolExecResult::with_meta(msg, meta));
        }
        let text = parts.join("\n");
        let meta = serde_json::json!({ "card": "generic", "kind": "other", "title": format!("MCP {}:{}", server, tool_name), "detail": text });
        Ok(ToolExecResult::with_meta(text, meta))
    }
    /// 调用前呈现：MCP 调用无专属卡（对齐 dsh GenericCallView），但补全可识别的 server:tool 标题与 kind。
    fn present_call(&self, args: &serde_json::Value) -> serde_json::Value {
        let server = args.get("server").and_then(|v| v.as_str()).unwrap_or("");
        let tool_name = args.get("tool").and_then(|v| v.as_str()).unwrap_or("");
        serde_json::json!({
            "card": "generic",
            "kind": "other",
            "title": format!("调用 MCP {}:{}", server, tool_name),
        })
    }
}

/// skill：按名称加载项目技能全文（progressive disclosure）。
/// 技能索引起初只注入名称 + 一句话说明；模型依据触发关键词判断需用到某技能时，
/// 用本工具加载其完整 markdown 说明，获取可执行的具体步骤/规则后再执行。加载后可结合
/// 既有 file/command 等工具落地。此工具为只读，不产生外部副作用。
pub(crate) struct SkillTool;
#[async_trait::async_trait]
impl AiTool for SkillTool {
    fn name(&self) -> &'static str {
        "skill"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "加载项目技能详情。name 填系统提示中「项目可用技能」列出的技能名；返回该技能的完整说明（含操作步骤/规则/参数约定），加载后再按其执行。需要处理某项专属任务（前端/后端/数据/测试等，见技能关键词）时先调用本工具。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "技能名（系统提示「项目可用技能」中列出的 name；也支持 list 查看全部）" }
                    },
                    "required": ["name"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        // list 别名：无最技能目录时报全量索引，方便模型探测可用技能。
        if name.eq_ignore_ascii_case("list") {
            let dir = skill_service::list_skills(ctx.project_root.as_deref());
            if dir.skills.is_empty() {
                return Ok(ToolExecResult::plain("（项目内未配置任何技能，可忽略 skill 工具）".to_string()));
            }
            let list: Vec<String> = dir
                .skills
                .iter()
                .map(|s| {
                    let kws = if s.keywords.is_empty() { String::new() } else { format!(" [{}]", s.keywords.join("/")) };
                    format!("- {}：{}{}", s.name, s.description, kws)
                })
                .collect();
            return Ok(ToolExecResult::plain(format!("项目可用技能（结构见 .agent/skills）：\n{}", list.join("\n"))));
        }
        if name.is_empty() {
            return Err("skill 缺少 name 参数".to_string());
        }
        let content = skill_service::load_skill(ctx.project_root.as_deref(), &name)?;
        Ok(ToolExecResult::plain(format!("技能「{}」说明（来源 {}）：\n{}", content.name, content.source, content.content)))
    }
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Parallel
    }
}

/// 极简 form-url-encoded 百分号编码：保留字母数字与 `-_.~`，其余字节转 `%XX`，空格转 `+`。
/// 仅用于 web_search 的 query 编码（query 通常较短，不值得为它引入 percent-encoding 依赖）。
pub(crate) fn url_escape_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// 块级标签（闭合后补换行），用于粗提纯 HTML 正文。
pub(crate) fn is_block_tag(name: &str) -> bool {
    matches!(name,
        "p" | "div" | "li" | "ul" | "ol" | "br" | "tr" | "section" | "article"
        | "nav" | "header" | "footer" | "main" | "aside" | "blockquote" | "pre"
        | "table" | "form" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "hr")
}

/// 轻量 HTML→纯文本（单遍状态机）：丢弃 script/style/head 等容器，剥标签、块级补换行、
/// 解码常见实体、压缩空白。用于 web_fetch 的正文提取（够用且不引入解析依赖）。
pub(crate) fn html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let bytes = html.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'<' {
            let closing = i + 1 < bytes.len() && bytes[i + 1] == b'/';
            let name_start = if closing { i + 2 } else { i + 1 };
            let mut j = name_start;
            while j < bytes.len() && !matches!(bytes[j], b'>' | b' ' | b'\t' | b'\n' | b'\r' | b'/') {
                j += 1;
            }
            let name = html[name_start.min(html.len())..j.min(html.len())].to_ascii_lowercase();
            // 容器级标签（含子内容）整体跳过
            if !closing
                && matches!(name.as_str(), "script" | "style" | "head" | "noscript" | "svg" | "template")
            {
                let close_tag = format!("</{}>", name);
                match html[i + 1..].find(close_tag.as_str()) {
                    Some(rel) => {
                        i += 1 + rel + close_tag.len();
                        continue;
                    }
                    None => break,
                }
            }
            // 闭合块级标签 → 补换行
            if closing && is_block_tag(&name) && !out.ends_with('\n') && !out.is_empty() {
                out.push('\n');
            }
            // 跳过整个标签
            let mut k = i + 1;
            while k < bytes.len() && bytes[k] != b'>' {
                k += 1;
            }
            i = if k < bytes.len() { k + 1 } else { bytes.len() };
        } else if b == b'&' {
            // 实体解码
            if let Some(rel) = html[i + 1..].find(';') {
                let ent = &html[i + 1..i + 1 + rel];
                // 用字符串保存解码结果，避免借用 leak
                let owned: Option<String> = match ent.to_ascii_lowercase().as_str() {
                    "amp" => Some("&".into()),
                    "lt" => Some("<".into()),
                    "gt" => Some(">".into()),
                    "quot" => Some("\"".into()),
                    "apos" => Some("'".into()),
                    "nbsp" => Some(" ".into()),
                    _ => ent
                        .strip_prefix("#x")
                        .or_else(|| ent.strip_prefix("0x"))
                        .and_then(|h| u32::from_str_radix(h, 16).ok().and_then(char::from_u32))
                        .map(|c| c.to_string())
                        .or_else(|| {
                            ent.strip_prefix('#')
                                .and_then(|d| d.parse::<u32>().ok().and_then(char::from_u32))
                                .map(|c| c.to_string())
                        }),
                };
                match owned {
                    Some(v) => out.push_str(&v),
                    None => out.push('&'),
                }
                i += 1 + rel + 1; // ';' 位置之后
            } else {
                out.push(b as char);
                i += 1;
            }
        } else {
            // 普通文本：ASCII 直接 push；多字节 UTF-8 按完整字符推进（避免把中文拆成 mojibake）
            if b & 0b1000_0000 != 0 {
                match html[i..].chars().next() {
                    Some(c) => {
                        out.push(c);
                        i += c.len_utf8();
                    }
                    None => break,
                }
            } else {
                out.push(b as char);
                i += 1;
            }
        }
    }
    // 压缩空白：行内连续空白缩为一个空格，逐行 trim，去空行
    out.split('\n')
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// web_search：联网检索（Bing RSS 优先，DDG 兜底）。
///
/// ## 为什么不再只用 DuckDuckGo Instant Answer（2026-10-19 实测）
/// 老实现打的是 DDG 的 **Instant Answer** 接口 —— 它不是搜索引擎，只对"实体/名词"
/// 返回一段 `AbstractText` + 相关词条；对「Tauri v2 listen event 官方文档」这类真实查询，
/// `RelatedTopics` 直接为空，等于**逻辑上永远搜不到**。
/// 更糟的是本机实测 **DDG 两个端点全部 15s 超时**（api.duckduckgo.com 与 html.duckduckgo.com
/// 都是 HTTP 000），所以它同时具备"搜不到内容"和"连不上"两个毛病。
///
/// 现在：首选 `cn.bing.com/search?...&format=rss` —— 免 key、返回干净 XML、不用解析 HTML，
/// 本机实测 HTTP 200 / 10 条真实结果（标题 + 链接 + 描述）。DDG 仅作兜底。
///
/// 为什么用 RSS 而不是抓网页：Bing/百度的结果页都有反爬与 A/B 结构，正则解析极其脆弱；
/// RSS 是它自己给的稳定接口，字段固定。项目已有 quick-xml 依赖，不新增任何东西。
pub(crate) struct WebSearchTool;

/// 一条检索结果（url, title, snippet）。
type SearchHit = (String, String, String);

/// 去掉描述里的 HTML 标签并压缩空白（Bing RSS 的 description 常含 `<b>` 高亮）。
fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 解一层 XML 实体（不引入额外依赖：RSS 里出现的基本就这几个）。
fn decode_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// 解析 RSS 里的 `<item>`（title / link / description）。用事件流而非正则，
/// 避免描述里出现换行或嵌套标签时切错。
fn parse_rss_items(xml: &str, max: usize) -> Vec<SearchHit> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut out: Vec<SearchHit> = Vec::new();
    let mut in_item = false;
    let mut cur: SearchHit = (String::new(), String::new(), String::new());
    let mut cur_tag: Option<String> = None;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name == "item" {
                    in_item = true;
                    cur = (String::new(), String::new(), String::new());
                } else if in_item {
                    cur_tag = Some(name);
                }
            }
            Ok(Event::Text(t)) => {
                if let (true, Some(tag)) = (in_item, cur_tag.clone()) {
                    let txt = t.decode().map(|c| c.into_owned()).unwrap_or_default();
                    match tag.as_str() {
                        "title" => cur.0.push_str(&txt),
                        "link" => cur.1.push_str(txt.trim()),
                        "description" => cur.2.push_str(&txt),
                        _ => {}
                    }
                }
            }
            Ok(Event::CData(c)) => {
                if let (true, Some(tag)) = (in_item, cur_tag.clone()) {
                    let txt = String::from_utf8_lossy(c.as_ref()).to_string();
                    match tag.as_str() {
                        "title" => cur.0.push_str(&txt),
                        "description" => cur.2.push_str(&txt),
                        _ => {}
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name == "item" {
                    in_item = false;
                    let url = cur.1.trim().to_string();
                    if !url.is_empty() {
                        out.push((
                            url,
                            decode_entities(cur.0.trim()),
                            strip_html(&decode_entities(cur.2.trim())),
                        ));
                    }
                    if out.len() >= max {
                        break;
                    }
                } else if cur_tag.as_deref() == Some(name.as_str()) {
                    cur_tag = None;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                log::warn!("[web_search] RSS 解析中断（已取到 {} 条）: {}", out.len(), e);
                break;
            }
            _ => {}
        }
        buf.clear();
    }
    out
}

/// Bing RSS 检索。失败/空结果都由调用方决定是否回落。
async fn fetch_bing_rss(
    client: &reqwest::Client,
    query: &str,
    max: usize,
) -> Result<Vec<SearchHit>, String> {
    let url = format!(
        "https://cn.bing.com/search?q={}&format=rss&count={}",
        url_escape_component(query),
        max
    );
    let resp = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    let body = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
    let items = parse_rss_items(&body, max);
    log::info!(
        "[web_search] Bing RSS: query={:?} 命中 {} 条（响应 {} 字节）",
        query,
        items.len(),
        body.len()
    );
    Ok(items)
}

/// DuckDuckGo Instant Answer 兜底（只对实体类查询有效，保留是为了别把老路径一次性删掉）。
async fn fetch_ddg_instant(
    client: &reqwest::Client,
    query: &str,
    max: usize,
) -> Result<(Vec<SearchHit>, Option<String>), String> {
    let url = format!(
        "https://api.duckduckgo.com/?q={}&format=json&no_html=1&skip_disambig=1",
        url_escape_component(query)
    );
    let resp = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0")
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| format!("解析失败: {e}"))?;
    let mut leaves: Vec<SearchHit> = Vec::new();
    if let Some(topics) = json.get("RelatedTopics").and_then(|v| v.as_array()) {
        fn walk(v: &serde_json::Value, out: &mut Vec<SearchHit>) {
            if let Some(url) = v.get("FirstURL").and_then(|u| u.as_str()) {
                let text = v.get("Text").and_then(|t| t.as_str()).unwrap_or("");
                if !url.is_empty() {
                    let (title, snippet) = match text.split_once(" - ") {
                        Some((t, sn)) => (t.trim().to_string(), sn.trim().to_string()),
                        None => (text.to_string(), String::new()),
                    };
                    out.push((url.to_string(), title, snippet));
                }
            } else if let Some(sub) = v.get("Topics").and_then(|t| t.as_array()) {
                for s in sub {
                    walk(s, out);
                }
            }
        }
        for t in topics {
            walk(t, &mut leaves);
        }
    }
    leaves.truncate(max);
    let answer = json
        .get("AbstractText")
        .and_then(|a| a.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    Ok((leaves, answer))
}

#[async_trait::async_trait]
impl AiTool for WebSearchTool {
    fn name(&self) -> &'static str {
        "web_search"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "联网搜索网页，返回真实来源列表（标题/摘要/URL）。用 Bing RSS 检索（免 key，国内可达），失败时回落到 DuckDuckGo。用于获取外部实时信息、官方文档、最新动态。搜到链接后可用 web_fetch 读正文。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "要搜索的查询词，应具体（如 'Tauri v2 listen event 官方文档'）" },
                        "max_results": { "type": "integer", "description": "返回结果数上限（默认5，范围1-10）" }
                    },
                    "required": ["query"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, _ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if query.is_empty() {
            return Err("web_search 缺少 query 参数".to_string());
        }
        let max_results: usize = args
            .get("max_results")
            .and_then(|v| v.as_u64())
            .map(|n| (n as usize).clamp(1, 10))
            .unwrap_or(5);

        // 整体 15s 上限：断网/被墙时不让 Agent 卡死
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|e| format!("web_search 构造 HTTP 客户端失败: {e}"))?;

        let mut hits: Vec<SearchHit> = Vec::new();
        let mut answer: Option<String> = None;
        match fetch_bing_rss(&client, &query, max_results).await {
            Ok(v) if !v.is_empty() => hits = v,
            Ok(_) => log::warn!("[web_search] Bing RSS 返回 0 条，回落 DDG 兜底"),
            Err(e) => log::warn!("[web_search] Bing RSS 失败（{}），回落 DDG 兜底", e),
        }
        if hits.is_empty() {
            match fetch_ddg_instant(&client, &query, max_results).await {
                Ok((v, a)) => {
                    hits = v;
                    answer = a;
                    log::info!("[web_search] DDG 兜底命中 {} 条", hits.len());
                }
                Err(e) => log::warn!("[web_search] DDG 兜底也失败: {}", e),
            }
        }

        if hits.is_empty() {
            return Ok(ToolExecResult::plain(format!(
                "web_search 没有拿到任何结果（query: {}）。可能是网络不可达或查询过于生僻；\
                 可改用更通用的关键词，或直接用 web_fetch 打开已知 URL。",
                query
            )));
        }

        let total = hits.len();
        let truncated = total > max_results;
        let sliced: Vec<SearchHit> = hits.into_iter().take(max_results).collect();

        let mut lines: Vec<String> = Vec::new();
        if let Some(a) = &answer {
            lines.push(format!("摘要：{}", a));
        }
        for (i, (url, title, snippet)) in sliced.iter().enumerate() {
            let mut entry = format!("{}. {}", i + 1, title);
            if !snippet.is_empty() {
                entry.push_str(&format!(" — {}", snippet));
            }
            entry.push_str(&format!("\n   {}", url));
            lines.push(entry);
        }
        let mut s = format!("Web results for \"{}\"", query);
        if truncated {
            s.push_str(&format!("（{} 条中显示前 {} 条）", total, max_results));
        }
        s.push('\n');
        s.push_str(&lines.join("\n"));

        let sources: Vec<serde_json::Value> = sliced
            .into_iter()
            .map(|(url, title, snippet)| {
                let mut src = serde_json::json!({ "url": url, "title": title });
                if !snippet.is_empty() {
                    src["snippet"] = serde_json::Value::String(snippet);
                }
                src
            })
            .collect();
        let meta = serde_json::json!({
            "card": "web",
            "kind": "search",
            "sources": sources,
            "answer": answer,
            "truncated": truncated,
        });
        Ok(ToolExecResult::with_meta(s, meta))
    }
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Parallel
    }
}

/// web_fetch：抓取指定 URL 的正文（HTML→纯文本），返回可读 markdown/文本 + 检索摘要。
/// 结果对齐 dsh WebFetchResultView：url（重定向后最终地址）+ statusCode + truncated。
/// 正文即模型可见的纯文本（在 ai-agent-step 的 detail）；卡片仅带抓取摘要。限时 20s、跟随重定向。
pub(crate) struct WebFetchTool;
#[async_trait::async_trait]
impl AiTool for WebFetchTool {
    fn name(&self) -> &'static str {
        "web_fetch"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "抓取指定网页 URL，返回转成纯文本的正文内容（含抓取状态）。用于 web_search 找到来源后深入读取页面具体细节。仅支持 http/https。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": { "type": "string", "description": "要抓取的完整网址（http/https）" },
                        "max_chars": { "type": "integer", "description": "正文最大字符数（默认8000，范围100-20000）" }
                    },
                    "required": ["url"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, _ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if url.is_empty() {
            return Err("web_fetch 缺少 url 参数".to_string());
        }
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err("web_fetch 仅支持 http/https 网址".to_string());
        }
        let max_chars: usize = args.get("max_chars").and_then(|v| v.as_u64()).map(|n| (n as usize).clamp(100, 20_000)).unwrap_or(8000);
        // 限时 20s、跟随最多 5 次重定向；断网/超时视为结果（带状态），不抛工具错误
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .map_err(|e| format!("web_fetch 客户端构建失败: {}", e))?;
        let resp = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            client.get(&url).header("User-Agent", "Mozilla/5.0").send(),
        )
        .await
        .map_err(|_| "web_fetch 超时（>20s，已中止）".to_string())?
        .map_err(|e| format!("web_fetch 请求失败: {}", e))?;
        let status_code = resp.status().as_u16();
        let final_url = resp.url().to_string();
        let body = resp.text().await.map_err(|e| format!("web_fetch 读取正文失败: {}", e))?;

        let mut text = body.trim().to_string();
        // 若已是文本性内容（非 HTML 特征）则原样使用，否则走 HTML→纯文本
        if text.trim_start().starts_with('<') {
            text = html_to_text(&text);
        }
        let truncated = text.chars().count() > max_chars;
        let capped: String = text.chars().take(max_chars).collect();
        let meta = serde_json::json!({
            "card": "web",
            "kind": "fetch",
            "url": final_url,
            "statusCode": status_code,
            "truncated": truncated,
        });
        if !(200..300).contains(&status_code) {
            return Ok(ToolExecResult::with_meta(
                format!("web_fetch 返回状态 {}（{}）", status_code, final_url),
                meta,
            ));
        }
        let message = if capped.trim().is_empty() {
            "（页面无可见文本）".to_string()
        } else {
            capped
        };
        Ok(ToolExecResult::with_meta(message, meta))
    }
}
