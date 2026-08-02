// IDE 内容搜索服务：在项目根目录下递归搜索文件内容（gitignore 感知）。
// 用于 IDE 命令面板 `#` 内容搜索模式与 AI agent 的 grep 工具。
//
// 设计要点：
// - 用 ignore crate（ripgrep 目录遍历核心，MIT）做 gitignore 感知并行遍历
// - 用 regex crate（已是依赖）做字面量子串匹配（regex::escape 转义），大小写可切换
// - 跳过二进制/超大文件，截断超长行，结果数上限保护
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::{Arc, Mutex};

use ignore::{WalkBuilder, WalkState};
use regex::RegexBuilder;
use serde::Serialize;

/// 跳过 >1MB 的文件，避免读入大文件拖慢搜索
const MAX_FILE_SIZE: u64 = 1024 * 1024;
/// 匹配行显示截断长度（按字节，落在字符边界上）
const MAX_LINE_LEN: usize = 500;

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    /// 文件绝对路径
    pub path: String,
    /// 1-based 行号
    pub line: usize,
    /// 匹配行内容（已 trim + 截断）
    pub text: String,
}

/// 在 `root` 下递归搜索包含 `pattern` 的行（字面量子串匹配，gitignore 感知）。
///
/// - `pattern`：搜索字面量（内部用 regex::escape 转义，用户输入不会被当作正则元字符）
/// - `max_results`：结果数上限，默认 200
/// - `case_sensitive`：是否大小写敏感，默认 false
#[tauri::command]
pub fn search_content(
    root: String,
    pattern: String,
    max_results: Option<usize>,
    case_sensitive: Option<bool>,
) -> Result<Vec<SearchHit>, String> {
    let needle = pattern.trim();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("不是有效目录: {}", root));
    }
    let limit = max_results.unwrap_or(200);
    let cs = case_sensitive.unwrap_or(false);

    // 字面量匹配：转义后构造一次正则，循环里只调 is_match（内部走 memchr，比逐行 to_lowercase 快）
    let re = RegexBuilder::new(&regex::escape(needle))
        .case_insensitive(!cs)
        .build()
        .map_err(|e| format!("构建搜索正则失败: {}", e))?;

    let hits: Arc<Mutex<Vec<SearchHit>>> = Arc::new(Mutex::new(Vec::with_capacity(limit.min(256))));

    let walker = WalkBuilder::new(root_path)
        .hidden(true) // 跳过隐藏文件（.git 等）
        .ignore(true) // 读 .ignore
        .git_ignore(true) // 读 .gitignore
        .git_global(true) // 读全局 gitignore
        .git_exclude(true) // 读 .git/info/exclude
        .threads(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8))
        .build_parallel();

    let hits_ref = Arc::clone(&hits);
    walker.run(move || {
        // 每个工作线程持有一份 Arc 克隆 + 正则克隆（Regex 内部 Arc，克隆廉价）
        let hits = Arc::clone(&hits_ref);
        let re = re.clone();
        Box::new(move |entry| {
            // 已满则通知所有线程停止
            if hits
                .lock()
                .map(|h| h.len() >= limit)
                .unwrap_or(false)
            {
                return WalkState::Quit;
            }
            let entry = match entry {
                Ok(e) => e,
                _ => return WalkState::Continue,
            };
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                return WalkState::Continue;
            }
            let path = entry.path();
            // 跳过大文件
            if let Ok(md) = path.metadata() {
                if md.len() > MAX_FILE_SIZE {
                    return WalkState::Continue;
                }
            }
            let file = match File::open(path) {
                Ok(f) => f,
                _ => return WalkState::Continue,
            };
            let path_str = path.to_string_lossy().to_string();
            // 遇到非 UTF8 行直接结束该文件（视为二进制，跳过）
            for (i, line_res) in BufReader::new(file).lines().enumerate() {
                let line = match line_res {
                    Ok(l) => l,
                    _ => break,
                };
                if re.is_match(&line) {
                    let text = if line.len() > MAX_LINE_LEN {
                        // 截断到最近的字符边界，避免切断多字节 UTF-8
                        let mut end = MAX_LINE_LEN;
                        while end > 0 && !line.is_char_boundary(end) {
                            end -= 1;
                        }
                        line[..end].to_string() + "…"
                    } else {
                        line
                    };
                    let mut h = hits.lock().unwrap();
                    if h.len() >= limit {
                        break;
                    }
                    h.push(SearchHit {
                        path: path_str.clone(),
                        line: i + 1,
                        text: text.trim().to_string(),
                    });
                }
            }
            WalkState::Continue
        })
    });

    let mut result = Arc::try_unwrap(hits)
        .map_err(|_| "内部错误: 引用泄漏".to_string())?
        .into_inner()
        .map_err(|_| "内部错误: 互斥锁中毒".to_string())?;
    result.truncate(limit);
    Ok(result)
}
