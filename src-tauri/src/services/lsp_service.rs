// 伪 LSP 诊断服务（轻量方案，对齐用户「能取巧绝不手搓」原则）
//
// 设计要点：
// - 不实现完整 LSP 协议（不 spawn typescript-language-server / rust-analyzer 做 JSON-RPC 通信）
// - 而是用「一次性命令 + 输出解析」做 Diagnostics：tsc --noEmit / cargo check / pyright
// - 输出格式按 LSP 规约解析为 LspDiagnostic[]（对齐 claw-code-main/runtime/src/lsp_client.rs::LspDiagnostic）
// - 仅做 Diagnostics（用户明确要求「先只做 Diagnostics」），不做 Hover/Definition/Completion
//
// 命令选择（按文件扩展名 + 项目根标志文件）：
//   .ts/.tsx/.js/.jsx + tsconfig.json → npx tsc --noEmit --pretty false
//   .rs + Cargo.toml                  → cargo check --message-format=short
//   .py                               → pyright --outputjson（未装则降级 python -m py_compile）
//
// 超时：30s（tsc / cargo check 首次跑可能较慢，但通常 < 10s；超时即 kill 子进程）
// 缓存：进程内 HashMap，key=(project_root, cmd)，TTL 10s（避免每次 keystroke 都跑全项目检查）

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde::Serialize;

/// 单条诊断（对齐 lsp_client.rs::LspDiagnostic）
#[derive(Debug, Clone, Serialize)]
pub struct LspDiagnostic {
    pub path: String,
    pub line: u32,         // 1-based
    pub character: u32,    // 1-based
    pub severity: String,  // "error" | "warning" | "info"
    pub message: String,
    pub source: Option<String>, // "tsc" / "cargo" / "pyright" / "python"
    pub code: Option<String>,   // 错误代码（如 TS1234 / E0308 / pyright-error）
}

/// 诊断结果
#[derive(Debug, Clone, Serialize)]
pub struct LspDiagnosticsResult {
    pub ok: bool,
    pub diagnostics: Vec<LspDiagnostic>,
    pub message: String,
    pub elapsed_ms: u64,
    pub source: String, // 实际使用的诊断源
}

/// 诊断缓存项（TTL 10s）
#[derive(Clone)]
struct CacheEntry {
    diagnostics: Vec<LspDiagnostic>,
    cached_at: Instant,
    source: String,
}

const CACHE_TTL_SECS: u64 = 10;
const CMD_TIMEOUT_SECS: u64 = 30;

// 进程内缓存：key=(project_root, source, file_mtime)，TTL 10s
// 文件 mtime 未变 → 复用上次诊断，避免每次 keystroke 都跑全项目检查
static DIAGNOSTICS_CACHE: Lazy<Mutex<HashMap<String, CacheEntry>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// 主命令：lsp_diagnostics(path, project_root)
/// 前端在打开文件时调用，返回当前文件的诊断列表（已按 path 过滤）
#[tauri::command]
pub async fn lsp_diagnostics(path: String, project_root: Option<String>) -> Result<LspDiagnosticsResult, String> {
    let start = Instant::now();
    let file_path = PathBuf::from(&path);
    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let root = project_root.clone().unwrap_or_default();
    let root_path = if root.is_empty() {
        PathBuf::from(".")
    } else {
        PathBuf::from(&root)
    };

    // 选择命令（按扩展名 + 标志文件）
    let (cmd, args, source) = match ext.as_str() {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
            if !root_path.join("tsconfig.json").exists()
                && !root_path.join("tsconfig.app.json").exists()
            {
                return Ok(LspDiagnosticsResult {
                    ok: true,
                    diagnostics: vec![],
                    message: "无 tsconfig.json，跳过 tsc 诊断".into(),
                    elapsed_ms: start.elapsed().as_millis() as u64,
                    source: "tsc".into(),
                });
            }
            (
                "npx",
                vec!["tsc".to_string(), "--noEmit".to_string(), "--pretty".to_string(), "false".to_string()],
                "tsc".to_string(),
            )
        }
        "rs" => {
            if !root_path.join("Cargo.toml").exists() {
                return Ok(LspDiagnosticsResult {
                    ok: true,
                    diagnostics: vec![],
                    message: "无 Cargo.toml，跳过 cargo check".into(),
                    elapsed_ms: start.elapsed().as_millis() as u64,
                    source: "cargo".into(),
                });
            }
            (
                "cargo",
                vec!["check".to_string(), "--message-format=short".to_string()],
                "cargo".to_string(),
            )
        }
        "py" => {
            // 优先 pyright（更全面），未装则降级 py_compile（仅语法检查）
            let has_pyright = Command::new("pyright")
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok();
            if has_pyright {
                ("pyright", vec!["--outputjson".to_string()], "pyright".to_string())
            } else {
                (
                    "python",
                    vec!["-m".to_string(), "py_compile".to_string(), path.clone()],
                    "python".to_string(),
                )
            }
        }
        _ => {
            return Ok(LspDiagnosticsResult {
                ok: true,
                diagnostics: vec![],
                message: format!("不支持的文件类型: .{}", ext),
                elapsed_ms: start.elapsed().as_millis() as u64,
                source: "none".into(),
            });
        }
    };

    // 缓存 key：project_root + source + file mtime（文件未改 → 复用上次诊断）
    let cache_key = format!("{}|{}|{}", root, source, file_mtime_key(&file_path));
    if let Ok(cache) = DIAGNOSTICS_CACHE.lock() {
        if let Some(entry) = cache.get(&cache_key) {
            if entry.cached_at.elapsed().as_secs() < CACHE_TTL_SECS {
                let filtered = filter_by_path(&entry.diagnostics, &file_path);
                let count = filtered.len();
                return Ok(LspDiagnosticsResult {
                    ok: true,
                    diagnostics: filtered,
                    message: format!("{} 诊断（缓存）：{} 条", entry.source, count),
                    elapsed_ms: start.elapsed().as_millis() as u64,
                    source: entry.source.clone(),
                });
            }
        }
    }

    // 执行命令（同步 spawn + 轮询超时，避免 tokio process feature 依赖）
    let output = run_with_timeout(cmd, &args, &root_path, CMD_TIMEOUT_SECS);
    let output = match output {
        Ok(o) => o,
        Err(e) => {
            return Ok(LspDiagnosticsResult {
                ok: false,
                diagnostics: vec![],
                message: format!("执行 {} 失败: {}", cmd, e),
                elapsed_ms: start.elapsed().as_millis() as u64,
                source,
            });
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = format!("{}\n{}", stdout, stderr);

    // 解析诊断
    let all_diags: Vec<LspDiagnostic> = match source.as_str() {
        "tsc" => parse_tsc(&combined),
        "cargo" => parse_cargo(&combined),
        "pyright" => parse_pyright(&stdout),
        "python" => parse_python(&combined),
        _ => vec![],
    };

    // 写缓存
    if let Ok(mut cache) = DIAGNOSTICS_CACHE.lock() {
        cache.insert(
            cache_key.clone(),
            CacheEntry {
                diagnostics: all_diags.clone(),
                cached_at: Instant::now(),
                source: source.clone(),
            },
        );
        // 清理过期项（防止 HashMap 无限增长）
        cache.retain(|_, v| v.cached_at.elapsed().as_secs() < CACHE_TTL_SECS * 6);
    }

    let filtered = filter_by_path(&all_diags, &file_path);
    let count = filtered.len();
    Ok(LspDiagnosticsResult {
        ok: true,
        diagnostics: filtered,
        message: format!("{} 诊断完成：{} 条", source, count),
        elapsed_ms: start.elapsed().as_millis() as u64,
        source,
    })
}

/// 取文件的 mtime + size 作为缓存 key（文件未改 → 复用诊断）
fn file_mtime_key(path: &Path) -> String {
    let meta = std::fs::metadata(path);
    match meta {
        Ok(m) => {
            let mtime = m.modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            format!("{}_{}", mtime, m.len())
        }
        Err(_) => "unknown".to_string(),
    }
}

/// 按 path 过滤诊断（tsc / cargo 是全项目的，需过滤到当前文件）
fn filter_by_path(diags: &[LspDiagnostic], target: &Path) -> Vec<LspDiagnostic> {
    let target_canon = target.canonicalize().unwrap_or_else(|_| target.to_path_buf());
    diags
        .iter()
        .filter(|d| {
            let p = Path::new(&d.path);
            let p_canon = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
            p_canon == target_canon
        })
        .cloned()
        .collect()
}

/// 同步执行命令 + 超时控制（轮询 try_wait，超时 kill）
fn run_with_timeout(
    cmd: &str,
    args: &[String],
    cwd: &Path,
    timeout_secs: u64,
) -> Result<std::process::Output, String> {
    let mut child = Command::new(cmd)
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn {} 失败: {}", cmd, e))?;

    let start = Instant::now();
    let timeout = Duration::from_secs(timeout_secs);
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                // 子进程已退出，收集输出
                return child
                    .wait_with_output()
                    .map_err(|e| format!("收集输出失败: {}", e));
            }
            Ok(None) => {
                // 仍在运行
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("命令超时（{}s）", timeout_secs));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("wait 失败: {}", e)),
        }
    }
}

// ============ 输出解析器 ============

/// 解析 tsc 输出：path(line,col): error TS1234: message
fn parse_tsc(text: &str) -> Vec<LspDiagnostic> {
    let re = regex::Regex::new(
        r"^(.+?)\((\d+),(\d+)\):\s+(error|warning|info)\s+(TS\d+):\s+(.+)$",
    )
    .unwrap();
    text.lines()
        .filter_map(|line| {
            let caps = re.captures(line)?;
            Some(LspDiagnostic {
                path: caps[1].to_string(),
                line: caps[2].parse().unwrap_or(1),
                character: caps[3].parse().unwrap_or(1),
                severity: caps[4].to_string(),
                message: caps[6].to_string(),
                source: Some("tsc".into()),
                code: Some(caps[5].to_string()),
            })
        })
        .collect()
}

/// 解析 cargo check --message-format=short 输出：path:line:col: error[Exxxx]: message
fn parse_cargo(text: &str) -> Vec<LspDiagnostic> {
    let re = regex::Regex::new(
        r"^(.+?):(\d+):(\d+):\s+(error|warning|note|help)(?:\[(E\d+)\])?:\s+(.+)$",
    )
    .unwrap();
    text.lines()
        .filter_map(|line| {
            let caps = re.captures(line)?;
            // 跳过 note/help（不是真正的诊断级别）
            let sev = match caps[4].to_string().as_str() {
                "error" => "error",
                "warning" => "warning",
                _ => "info",
            };
            // 跳过非文件路径（如 "warning: unused" 这种没有路径的行）
            let path_str = caps[1].to_string();
            if !path_str.contains('.') && !Path::new(&path_str).is_absolute() {
                return None;
            }
            Some(LspDiagnostic {
                path: path_str,
                line: caps[2].parse().unwrap_or(1),
                character: caps[3].parse().unwrap_or(1),
                severity: sev.to_string(),
                message: caps[6].to_string(),
                source: Some("cargo".into()),
                code: caps.get(5).map(|m| m.as_str().to_string()),
            })
        })
        .collect()
}

/// 解析 pyright --outputjson 输出（JSON 格式）
fn parse_pyright(stdout: &str) -> Vec<LspDiagnostic> {
    let v: serde_json::Value = match serde_json::from_str(stdout) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    v["generalDiagnostics"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|d| {
                    let severity = d["severity"].as_str().unwrap_or("warning");
                    let sev = match severity {
                        "error" => "error",
                        "warning" => "warning",
                        _ => "info",
                    };
                    let range = &d["range"];
                    let start = &range["start"];
                    // pyright line/character 是 0-based，转 1-based
                    let line = start["line"].as_u64().unwrap_or(0) as u32 + 1;
                    let character = start["character"].as_u64().unwrap_or(0) as u32 + 1;
                    let file = d["file"].as_str().unwrap_or("").to_string();
                    if file.is_empty() {
                        return None;
                    }
                    Some(LspDiagnostic {
                        path: file,
                        line,
                        character,
                        severity: sev.to_string(),
                        message: d["message"].as_str().unwrap_or("").to_string(),
                        source: Some("pyright".into()),
                        code: d["rule"].as_str().map(|s| s.to_string()),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 解析 python -m py_compile 输出（仅语法错误，无类型检查）
/// 格式：File "path", line N\n    code\n    ^\nSyntaxError: msg
fn parse_python(text: &str) -> Vec<LspDiagnostic> {
    let mut diags: Vec<LspDiagnostic> = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_line: u32 = 1;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("  File \"") {
            if let Some(end) = rest.find("\",") {
                current_path = Some(rest[..end].to_string());
                if let Some(l) = rest[end + 2..].strip_prefix(" line ") {
                    if let Ok(n) = l.trim().parse::<u32>() {
                        current_line = n;
                    }
                }
            }
        } else if let Some(msg) = line.strip_prefix("SyntaxError: ") {
            if let Some(p) = &current_path {
                diags.push(LspDiagnostic {
                    path: p.clone(),
                    line: current_line,
                    character: 1,
                    severity: "error".into(),
                    message: format!("SyntaxError: {}", msg),
                    source: Some("python".into()),
                    code: Some("SyntaxError".into()),
                });
            }
        } else if let Some(msg) = line.strip_prefix("IndentationError: ") {
            if let Some(p) = &current_path {
                diags.push(LspDiagnostic {
                    path: p.clone(),
                    line: current_line,
                    character: 1,
                    severity: "error".into(),
                    message: format!("IndentationError: {}", msg),
                    source: Some("python".into()),
                    code: Some("IndentationError".into()),
                });
            }
        } else if let Some(msg) = line.strip_prefix("TabError: ") {
            if let Some(p) = &current_path {
                diags.push(LspDiagnostic {
                    path: p.clone(),
                    line: current_line,
                    character: 1,
                    severity: "error".into(),
                    message: format!("TabError: {}", msg),
                    source: Some("python".into()),
                    code: Some("TabError".into()),
                });
            }
        }
    }
    diags
}
