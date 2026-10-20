//! 命令 · 本地图片定位（2026-10-20）
//!
//! ## 解决什么
//! 从别处**复制粘贴**进来的 markdown / HTML，图片往往是相对路径（`images/a.png`）。
//! 这类路径在 webview 里没有基准目录，必然 404；而剪贴板里也拿不到来源目录。
//! 既然无法"推断"，就做**兜底检索**：在若干候选根目录下按文件名/相对后缀查找。
//!
//! ## 为什么必须是有界的
//! 这是被渲染路径调用的（一张图一次）。若在用户家目录里无限制递归，一次粘贴能把
//! 磁盘扫上几十秒。所以：
//!   · 每个根目录最多走 `MAX_ENTRIES` 个条目、最深 `MAX_DEPTH` 层
//!   · 全局时间预算 `BUDGET`（超时即返回已找到的结果）
//!   · 跳过 `.git` / `node_modules` / `target` / `dist` / `.andeyunhui` 等重目录
//!   · 只看图片扩展名
//!
//! ## 缓存
//! 命中结果缓存到进程退出；未命中的结果只缓存 `MISS_TTL`（30s）——
//! 用户可能刚好在粘贴后才把图片拷进某个目录，永久缓存漏判会让人困惑。
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use walkdir::WalkDir;

/// 每个根目录最多遍历的条目数。
const MAX_ENTRIES: usize = 20_000;
/// 最大递归深度。
const MAX_DEPTH: usize = 6;
/// 单次请求的时间预算（所有根目录共享）。
const BUDGET: Duration = Duration::from_millis(400);
/// 未命中的缓存有效期。
const MISS_TTL: Duration = Duration::from_secs(30);

const SKIP_DIRS: &[&str] = &[
    ".git", ".svn", ".hg", "node_modules", "target", "dist", "build",
    ".andeyunhui", ".next", ".cache", "__pycache__", "venv", ".venv",
    "$RECYCLE.BIN", "System Volume Information",
];

const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "tif", "tiff",
];

/// rel → (绝对路径, 记录时间)。`None` 表示未命中（按 MISS_TTL 过期）。
type Cache = HashMap<String, (Option<String>, Instant)>;

fn cache() -> &'static Mutex<Cache> {
    static C: OnceLock<Mutex<Cache>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn is_image(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn norm(p: &str) -> String {
    p.replace('\\', "/").trim_start_matches("./").to_string()
}

/// `rel` 的末尾是否与候选路径的末尾一致（按路径段比较，避免 `a/x.png` 匹配到 `ba/x.png`）。
fn matches(rel_norm: &str, candidate: &Path) -> bool {
    let cand = norm(&candidate.to_string_lossy());
    if cand == rel_norm {
        return true;
    }
    if cand.ends_with(&format!("/{rel_norm}")) {
        return true;
    }
    // rel 不含目录时，按文件名匹配（最常见的 `![](a.png)`）
    if !rel_norm.contains('/') {
        if let Some(name) = candidate.file_name().and_then(|n| n.to_str()) {
            return name.eq_ignore_ascii_case(rel_norm);
        }
    }
    false
}

fn search_roots(roots: &[PathBuf], rel_norm: &str, deadline: Instant) -> Option<String> {
    // 1) 快路径：直接拼（rel 里带了正确的相对结构）
    for root in roots {
        let direct = root.join(rel_norm);
        if direct.is_file() {
            return Some(direct.to_string_lossy().to_string());
        }
    }
    // 2) 有界遍历
    for root in roots {
        if !root.is_dir() {
            continue;
        }
        let mut seen = 0usize;
        for entry in WalkDir::new(root)
            .max_depth(MAX_DEPTH)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                let name = e.file_name().to_string_lossy();
                !(e.file_type().is_dir() && SKIP_DIRS.iter().any(|s| name.eq_ignore_ascii_case(s)))
            })
            .flatten()
        {
            if Instant::now() > deadline {
                log::warn!("[image-resolve] 时间预算用尽，返回已找到的结果: {rel_norm}");
                return None;
            }
            if !entry.file_type().is_file() {
                continue;
            }
            seen += 1;
            if seen > MAX_ENTRIES {
                log::warn!("[image-resolve] 单根条目上限 {MAX_ENTRIES} 命中，放弃: {}", root.display());
                break;
            }
            if is_image(entry.path()) && matches(rel_norm, entry.path()) {
                return Some(entry.path().to_string_lossy().to_string());
            }
        }
    }
    None
}

/// 批量解析相对图片路径。返回 rel → 绝对路径（未命中为 None）。
///
/// `roots` 由前端传入（项目根、用户显式指定的图片目录等）；
/// 未传时只试系统常用目录（桌面/下载/图片/文档），不扫整个家目录。
#[tauri::command]
pub fn resolve_local_images(
    app: tauri::AppHandle,
    paths: Vec<String>,
    roots: Option<Vec<String>>,
) -> HashMap<String, Option<String>> {
    use tauri::Manager;

    let mut candidates: Vec<PathBuf> = Vec::new();
    for r in roots.unwrap_or_default() {
        let p = PathBuf::from(r);
        if p.is_dir() {
            candidates.push(p);
        }
    }
    // 系统常用目录兜底（限制在内置目录，避免家目录大扫）
    if let Ok(d) = app.path().desktop_dir() {
        candidates.push(d);
    }
    for d in [
        app.path().download_dir().ok(),
        app.path().picture_dir().ok(),
        app.path().document_dir().ok(),
    ]
    .into_iter()
    .flatten()
    {
        candidates.push(d);
    }
    // 去重
    let mut uniq: Vec<PathBuf> = Vec::new();
    for c in candidates {
        if !uniq.iter().any(|u| u == &c) {
            uniq.push(c);
        }
    }

    let deadline = Instant::now() + BUDGET;
    let mut out: HashMap<String, Option<String>> = HashMap::new();
    let mut guard = cache().lock().unwrap_or_else(|e| e.into_inner());

    for raw in paths {
        if raw.trim().is_empty() || out.contains_key(&raw) {
            continue;
        }
        let rel_norm = norm(&raw);
        // 缓存
        if let Some((hit, at)) = guard.get(&rel_norm) {
            match hit {
                Some(p) if Path::new(p).is_file() => {
                    out.insert(raw.clone(), Some(p.clone()));
                    continue;
                }
                Some(_) => { /* 文件没了，重新找 */ }
                None if at.elapsed() < MISS_TTL => {
                    out.insert(raw.clone(), None);
                    continue;
                }
                None => {}
            }
        }

        let abs = PathBuf::from(&rel_norm);
        let found = if abs.is_absolute() && abs.is_file() {
            Some(abs.to_string_lossy().to_string())
        } else {
            search_roots(&uniq, &rel_norm, deadline)
        };
        if found.is_none() {
            log::info!("[image-resolve] 未找到: {raw}（候选根 {:?}）", uniq);
        }
        guard.insert(rel_norm, (found.clone(), Instant::now()));
        out.insert(raw, found);
    }
    out
}
