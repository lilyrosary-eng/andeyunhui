// IDE 源码管理服务：用系统 git CLI（std::process::Command）实现 status/diff/stage/commit/log/branch。
//
// 设计要点：
// - 不引入 git2/libgit2 原生依赖：借用用户已安装的 git（兼容至上、轻量高效，契合用户规则）。
//   git2 需 cmake 编译 libgit2，增大二进制与构建时长；git CLI 零原生依赖，版本随系统。
// - 所有命令用 Command::new("git").args([...]) 显式传参，不经 shell，杜绝注入。
// - 解析 git --porcelain=v1 -z 稳定输出（NUL 分隔），重命名按 old\0new 两段处理。
// - 错误统一 Result<T, String>，与现有 services（search_service 等）风格一致。
//
// 对齐 terax-ai-main source-control / git-history 模块的数据契约。

use std::path::Path;
use std::process::Command;

use serde::Serialize;

/// 单文件状态码（git porcelain XY 的归一化）
/// X = 暂存区状态，Y = 工作区状态
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum GitStatusKind {
    Unchanged,   // ' '
    Modified,    // M
    Added,       // A
    Deleted,     // D
    Renamed,     // R
    Copied,      // C
    Updated,     // U（合并冲突）
    Untracked,   // ?
    Ignored,     // !
    Missing,     // 文件被删但 git 还认得（D in worktree）
}

impl GitStatusKind {
    fn from_char(c: char) -> Self {
        match c {
            'M' => Self::Modified,
            'A' => Self::Added,
            'D' => Self::Deleted,
            'R' => Self::Renamed,
            'C' => Self::Copied,
            'U' => Self::Updated,
            '?' => Self::Untracked,
            '!' => Self::Ignored,
            _ => Self::Unchanged,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct GitFileStatus {
    /// 相对仓库根的路径（重命名时为最终路径 new）
    pub path: String,
    /// 重命名时的原路径（仅 R/C 有值）
    pub old_path: Option<String>,
    /// 暂存区状态（X）
    pub staged: GitStatusKind,
    /// 工作区状态（Y）
    pub unstaged: GitStatusKind,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitStatusResult {
    /// 当前分支名（游离头时为 "HEAD"）
    pub branch: String,
    /// 上游跟踪分支（如 "origin/main"），无则 None
    pub upstream: Option<String>,
    pub files: Vec<GitFileStatus>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitCommit {
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    pub email: String,
    /// Unix 时间戳（秒）
    pub time: i64,
    /// 父提交 sha 列表
    pub parents: Vec<String>,
    /// 提交标题（首行）
    pub message: String,
}

// ===== 内部：统一 git 调用 =====
// 返回 stdout（lossy UTF-8）；失败时把 stderr 一起拼进错误信息，便于前端展示。
fn run_git(repo: &str, args: &[&str]) -> Result<String, String> {
    let repo_path = Path::new(repo);
    if !repo_path.is_dir() {
        return Err(format!("不是有效目录: {}", repo));
    }
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0") // 禁用交互式凭证提示，避免挂起
        .env("LC_ALL", "C")              // 稳定英文输出，避免本地化干扰解析
        .output()
        .map_err(|e| format!("启动 git 失败：{}（请确认系统已安装 git）", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        // 常见场景：非 git 仓库 → 返回明确提示
        if stderr.contains("not a git repository") || stderr.contains("not a git repo") {
            return Err("当前目录不是 git 仓库".to_string());
        }
        let mut msg = format!("git {} 失败", args.join(" "));
        if !stderr.is_empty() {
            msg.push_str(&format!("：{}", stderr));
        } else if !stdout.is_empty() {
            msg.push_str(&format!("：{}", stdout));
        }
        return Err(msg);
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// 递归向上找 git 仓库根（在 repo 目录内执行 git rev-parse --show-toplevel）。
/// 前端可能传入项目子目录，这里统一解析到仓库根，避免 status 路径不一致。
fn resolve_repo_root(repo: &str) -> Result<String, String> {
    // 先校验目录存在（run_git 会做），再解析根
    run_git(repo, &["rev-parse", "--show-toplevel"])
        .map(|s| s.trim().to_string())
}

// ===== 命令：git_status =====
/// 获取工作区状态（porcelain v1 -z，含分支行）。
#[tauri::command]
pub fn git_status(repo: String) -> Result<GitStatusResult, String> {
    let root = resolve_repo_root(&repo)?;
    // -b: 输出分支行；--porcelain=v1: 稳定格式；-z: NUL 分隔，路径不转义
    let raw = run_git(&root, &["status", "--porcelain=v1", "-b", "-z"])?;
    let mut files: Vec<GitFileStatus> = Vec::new();
    let mut branch = String::from("HEAD");
    let mut upstream: Option<String> = None;

    // -z 输出按 \0 分隔；分支行（## 开头）总是第一条；重命名条目占两段（old\0new）
    let parts: Vec<&str> = raw.split('\0').collect();
    let mut i = 0;
    while i < parts.len() {
        let part = parts[i];
        if part.is_empty() {
            i += 1;
            continue;
        }
        if let Some(branch_line) = part.strip_prefix("## ") {
            // 分支行格式：
            //   "main"                          → 无上游
            //   "main...origin/main"            → 有上游
            //   "main...origin/main [ahead 2]"  → 有上游 + 领先/落后
            //   "HEAD (no branch)"              → 游离头
            let core = branch_line.split(' ').next().unwrap_or("");
            if let Some(idx) = core.find("...") {
                branch = core[..idx].to_string();
                upstream = Some(core[idx + 3..].to_string());
            } else {
                branch = core.to_string();
            }
            i += 1;
            continue;
        }
        // 普通条目：前两字符为 XY 状态，第三字符为空格，其后为路径
        if part.len() < 3 {
            i += 1;
            continue;
        }
        let bytes = part.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let path_raw = &part[3..];
        // 重命名/复制（R/C）：紧跟下一段是目标路径
        if (x == 'R' || x == 'C') && i + 1 < parts.len() {
            let old_path = path_raw.to_string();
            let new_path = parts[i + 1].to_string();
            files.push(GitFileStatus {
                path: new_path,
                old_path: Some(old_path),
                staged: GitStatusKind::from_char(x),
                unstaged: GitStatusKind::from_char(y),
            });
            i += 2;
        } else {
            files.push(GitFileStatus {
                path: path_raw.to_string(),
                old_path: None,
                staged: GitStatusKind::from_char(x),
                unstaged: GitStatusKind::from_char(y),
            });
            i += 1;
        }
    }
    Ok(GitStatusResult { branch, upstream, files })
}

// ===== 命令：git_diff =====
/// 获取 unified diff 文本。
/// - staged=true：已暂存改动（git diff --staged）
/// - staged=false：未暂存改动（git diff）
/// - path：可选，限定单文件；None 则全部
#[tauri::command]
pub fn git_diff(repo: String, staged: bool, path: Option<String>) -> Result<String, String> {
    let root = resolve_repo_root(&repo)?;
    let mut args: Vec<&str> = vec!["diff", "--no-color"];
    if staged {
        args.push("--staged");
    }
    // 路径分隔符：用 -- 明确分隔选项与路径，避免路径以 - 开头被误判为选项
    if path.is_some() {
        args.push("--");
    }
    let path_str = path.unwrap_or_default();
    if !path_str.is_empty() {
        // 生命周期：path_str 需活到 run_git 返回，此处借用 OK
        args.push(path_str.as_str());
    }
    run_git(&root, &args)
}

// ===== 命令：git_stage / git_unstage =====
/// 暂存文件（git add <path>）。path 为 "." 时暂存全部。
#[tauri::command]
pub fn git_stage(repo: String, path: String) -> Result<(), String> {
    let root = resolve_repo_root(&repo)?;
    let p = if path.trim().is_empty() { "." } else { path.trim() };
    run_git(&root, &["add", "--", p])?;
    Ok(())
}

/// 取消暂存（git reset -- <path>）。path 为 "." 时取消全部。
#[tauri::command]
pub fn git_unstage(repo: String, path: String) -> Result<(), String> {
    let root = resolve_repo_root(&repo)?;
    let p = if path.trim().is_empty() { "." } else { path.trim() };
    run_git(&root, &["reset", "-q", "--", p])?;
    Ok(())
}

// ===== 命令：git_commit =====
/// 提交暂存区（git commit -m <message>）。返回新 HEAD sha。
#[tauri::command]
pub fn git_commit(repo: String, message: String) -> Result<String, String> {
    let root = resolve_repo_root(&repo)?;
    let msg = message.trim();
    if msg.is_empty() {
        return Err("提交信息不能为空".to_string());
    }
    run_git(&root, &["commit", "-m", msg])?;
    // 返回新 HEAD sha（短）
    let sha = run_git(&root, &["rev-parse", "--short", "HEAD"])?;
    Ok(sha.trim().to_string())
}

// ===== 命令：git_current_branch / git_branch_list =====
/// 当前分支名（游离头返回 "HEAD"）。
#[tauri::command]
pub fn git_current_branch(repo: String) -> Result<String, String> {
    let root = resolve_repo_root(&repo)?;
    let out = run_git(&root, &["branch", "--show-current"])?;
    let b = out.trim();
    if b.is_empty() {
        Ok("HEAD".to_string()) // 游离头
    } else {
        Ok(b.to_string())
    }
}

/// 本地 + 远程分支列表（去重，去掉 remotes/ 前缀与 HEAD 指针行）。
#[tauri::command]
pub fn git_branch_list(repo: String) -> Result<Vec<String>, String> {
    let root = resolve_repo_root(&repo)?;
    // --format 简化输出：每行一个 refname，去掉前缀 refs/heads/ refs/remotes/
    let out = run_git(&root, &["for-each-ref", "--format=%(refname:short)", "refs/heads/", "refs/remotes/"])?;
    let mut branches: Vec<String> = out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && !l.ends_with("/HEAD"))
        .collect();
    branches.sort();
    branches.dedup();
    Ok(branches)
}

// ===== 命令：git_log =====
/// 提交历史（git log -n max --pretty=format:NUL 分隔）。
#[tauri::command]
pub fn git_log(repo: String, max: Option<usize>) -> Result<Vec<GitCommit>, String> {
    let root = resolve_repo_root(&repo)?;
    let limit = max.unwrap_or(100);
    // %H 全 sha %h 短 sha %an 作者名 %ae 邮箱 %at 时间戳 %P 父sha(空格分隔) %s 标题
    // 用 NUL(%x00) 分隔字段，%x1e 作记录分隔符（避免换行消息破坏对齐——%s 仅首行故可，但稳妥起见用记录分隔）
    let fmt = "%H%x00%h%x00%an%x00%ae%x00%at%x00%P%x00%s%x1e";
    let n_arg = format!("-n{}", limit);
    let out = run_git(&root, &["log", &n_arg, &format!("--pretty=format:{}", fmt)])?;
    let mut commits: Vec<GitCommit> = Vec::new();
    for record in out.split('\x1e') {
        let record = record.trim_start_matches('\n');
        if record.is_empty() {
            continue;
        }
        let fields: Vec<&str> = record.split('\x00').collect();
        if fields.len() < 7 {
            continue;
        }
        let time = fields[4].parse::<i64>().unwrap_or(0);
        let parents: Vec<String> = fields[5]
            .split_whitespace()
            .map(|s| s.to_string())
            .collect();
        commits.push(GitCommit {
            sha: fields[0].to_string(),
            short_sha: fields[1].to_string(),
            author: fields[2].to_string(),
            email: fields[3].to_string(),
            time,
            parents,
            message: fields[6].to_string(),
        });
    }
    Ok(commits)
}
