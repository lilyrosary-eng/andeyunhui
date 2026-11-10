//! 安装基线变更集：把「刚下载时的插件」与「当前插件」做只读对照。
//!
//! 定位（重要，别和下面两套机制混）：
//! - **AI 编程自带**的会话级回退 / 审阅 / 变更展示：完全独立，继续照旧暴露给用户。
//! - **保命基线**（`services/boot_guard.rs`）：内部用，记上次成功启动的插件集合。
//! - **本模块**：额外的一层，只回答「从下载到现在，这个插件一共被改了什么」。
//!   只读对照 + 可回滚单文件 + 可导出，不介入 AI 的写入链路。
//!
//! 用户可见的基线永远不随改动推进：改多少次、改多久，对比的都是首次见到该插件时的样子
//! （应用升级且用户没改过时，才自动把基线滚到新版本）。
//!
//! 目录：`<AppData>/changesets/<pluginId>/`
//!   - `baseline.json`    基线指纹（版本 + 每个文件的 sha256）
//!   - `baseline/files/`  基线文件副本（超过上限只记指纹，不存内容）
//!   - `exports/`         patch 与 .mufurong 产物（在 changesets 根下）

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 超过这个大小的文件只记指纹，不复制内容（无法出 diff / 无法恢复）。
const MAX_STORE_BYTES: u64 = 2 * 1024 * 1024;
/// 单文件 diff 行数上限，避免超大文件把渲染卡死。
const MAX_DIFF_LINES: usize = 4000;
/// 忽略的目录（构建/版本库产物，不属于插件内容）。
const IGNORED_DIRS: &[&str] = &[".git", "node_modules", "__pycache__"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub hash: String,
    pub size: u64,
    /// 是否保存了内容副本（超过上限的文件只记指纹）
    #[serde(default)]
    pub stored: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Baseline {
    pub plugin_id: String,
    pub version: String,
    pub created_at: u64,
    pub files: Vec<FileEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// added | modified | deleted
    pub path: String,
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub plugin_id: String,
    pub version: String,
    pub baseline_at: u64,
    /// 应用升级后插件版本变了但用户有本地改动，基线没法自动滚到新版本
    pub baseline_stale: bool,
    pub files: Vec<FileChange>,
    pub additions: usize,
    pub deletions: usize,
}

// ================= 路径 =================

fn changesets_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 app_data_dir 失败: {e}"))?
        .join("changesets");
    Ok(dir)
}

fn plugin_root(app: &AppHandle, plugin_id: &str) -> Result<PathBuf, String> {
    Ok(changesets_root(app)?.join(sanitize_id(plugin_id)?))
}

fn baseline_json(app: &AppHandle, plugin_id: &str) -> Result<PathBuf, String> {
    Ok(plugin_root(app, plugin_id)?.join("baseline.json"))
}

fn baseline_files(app: &AppHandle, plugin_id: &str) -> Result<PathBuf, String> {
    Ok(plugin_root(app, plugin_id)?.join("baseline").join("files"))
}

/// 插件 id 直接拼目录名，必须挡住 `..`、绝对路径、分隔符。
fn sanitize_id(id: &str) -> Result<String, String> {
    if id.is_empty() || id.contains("..") || id.contains('/') || id.contains('\\') {
        return Err(format!("非法插件 id: {id}"));
    }
    Ok(id.to_string())
}

/// 相对路径只接受普通分段，挡住 `../` 与盘符。
fn safe_rel(rel: &str) -> Result<PathBuf, String> {
    let path = Path::new(rel);
    if path.is_absolute() {
        return Err(format!("拒绝绝对路径: {rel}"));
    }
    for c in path.components() {
        if !matches!(c, Component::Normal(_)) {
            return Err(format!("拒绝越界路径: {rel}"));
        }
    }
    Ok(path.to_path_buf())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ================= 文件遍历与指纹 =================

struct Scanned {
    rel: String,
    abs: PathBuf,
    size: u64,
}

fn collect_files(root: &Path) -> Vec<Scanned> {
    let mut out = Vec::new();
    if !root.exists() {
        return out;
    }
    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !(e.file_type().is_dir() && IGNORED_DIRS.iter().any(|d| *d == name))
        })
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let abs = entry.path().to_path_buf();
        let rel = match abs.strip_prefix(root) {
            Ok(p) => p.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(Scanned { rel, abs, size });
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    out
}

/// 明显的二进制/资源扩展名：只记指纹不存副本（省空间，也省首次建基线的时间）。
fn is_binary_ext(path: &Path) -> bool {
    const EXT: &[&str] = &[
        "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tif", "tiff", "avif",
        "woff", "woff2", "ttf", "otf", "eot",
        "wasm", "mp4", "webm", "mp3", "wav", "ogg", "zip", "gz", "7z", "pdf",
    ];
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let lower = e.to_ascii_lowercase();
            EXT.contains(&lower.as_str())
        })
        .unwrap_or(false)
}

fn file_hash(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| format!("打开失败 {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("读取失败: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 前 8KB 出现 NUL 字节就按二进制处理（够用且不用引入探测库）。
fn is_binary(path: &Path) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 8192];
    let n = f.read(&mut buf).unwrap_or(0);
    buf[..n].contains(&0)
}

fn read_text(path: &Path) -> String {
    // 与 RAG 文本摄取同一教训：中文 txt 常见 GBK，直接 read_to_string 会判失败
    let bytes = std::fs::read(path).unwrap_or_default();
    String::from_utf8_lossy(&bytes).into_owned()
}

// ================= 基线 =================

pub fn load_baseline(app: &AppHandle, plugin_id: &str) -> Option<Baseline> {
    let path = baseline_json(app, plugin_id).ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn save_baseline(app: &AppHandle, baseline: &Baseline) -> Result<(), String> {
    let path = baseline_json(app, &baseline.plugin_id)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建基线目录失败: {e}"))?;
    }
    let json = serde_json::to_string_pretty(baseline).map_err(|e| format!("序列化基线失败: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("写入基线失败: {e}"))?;
    Ok(())
}

/// 用当前插件目录重建基线（覆盖旧的副本与指纹）。
pub fn build_baseline(
    app: &AppHandle,
    plugin_id: &str,
    dir: &Path,
    version: &str,
) -> Result<(), String> {
    let files_root = baseline_files(app, plugin_id)?;
    if files_root.exists() {
        std::fs::remove_dir_all(&files_root).map_err(|e| format!("清理旧基线失败: {e}"))?;
    }
    std::fs::create_dir_all(&files_root).map_err(|e| format!("创建基线目录失败: {e}"))?;

    let mut files = Vec::new();
    for f in collect_files(dir) {
        let hash = file_hash(&f.abs)?;
        let stored = f.size <= MAX_STORE_BYTES && !is_binary_ext(&f.abs);
        if stored {
            let dest = files_root.join(&f.rel);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("创建基线子目录失败: {e}"))?;
            }
            std::fs::copy(&f.abs, &dest).map_err(|e| format!("复制基线文件失败: {e}"))?;
        }
        files.push(FileEntry {
            path: f.rel,
            hash,
            size: f.size,
            stored,
        });
    }

    save_baseline(
        app,
        &Baseline {
            plugin_id: plugin_id.to_string(),
            version: version.to_string(),
            created_at: now_secs(),
            files,
        },
    )
}

/// 保证基线存在。首次见到插件时建立（此刻还没人改过它）。
///
/// 应用升级后插件版本会变：
/// - 用户没改过 → 自动把基线滚到新版本（否则新装的官方更新会全被算成"用户改动"）
/// - 用户改过 → 保留旧基线并标记 stale，不自动合并（避免吞掉用户改动）
pub fn ensure_baseline(app: &AppHandle, plugin_id: &str, dir: &Path, version: &str) {
    if dir.is_dir() {
        let Ok(path) = baseline_json(app, plugin_id) else {
            return;
        };
        if path.exists() {
            let Some(b) = load_baseline(app, plugin_id) else {
                return;
            };
            if b.version == version {
                return;
            }
            let untouched = scan_changes(app, plugin_id, dir)
                .map(|s| s.files.is_empty())
                .unwrap_or(false);
            if untouched {
                if let Err(e) = build_baseline(app, plugin_id, dir, version) {
                    log::warn!("[changeset] 基线随版本滚动失败 {plugin_id}: {e}");
                }
            }
            return;
        }
        if let Err(e) = build_baseline(app, plugin_id, dir, version) {
            log::warn!("[changeset] 建立安装基线失败 {plugin_id}: {e}");
        }
    }
}

/// 放弃「下载时版本」的对照，以当前文件为新基线（用户确认"这些改动我都认了"）。
pub fn reset_baseline(app: &AppHandle, plugin_id: &str, dir: &Path, version: &str) -> Result<(), String> {
    build_baseline(app, plugin_id, dir, version)
}

// ================= 扫描与 diff =================

pub fn scan_changes(app: &AppHandle, plugin_id: &str, dir: &Path) -> Result<Summary, String> {
    let Some(baseline) = load_baseline(app, plugin_id) else {
        return Ok(Summary {
            plugin_id: plugin_id.to_string(),
            version: String::new(),
            baseline_at: 0,
            baseline_stale: false,
            files: Vec::new(),
            additions: 0,
            deletions: 0,
        });
    };

    let files_root = baseline_files(app, plugin_id)?;
    let current: BTreeMap<String, Scanned> = collect_files(dir)
        .into_iter()
        .map(|f| (f.rel.clone(), f))
        .collect();
    let base: BTreeMap<String, &FileEntry> =
        baseline.files.iter().map(|f| (f.path.clone(), f)).collect();

    let mut changes = Vec::new();
    let mut total_add = 0;
    let mut total_del = 0;

    for (rel, cur) in &current {
        let cur_hash = match file_hash(&cur.abs) {
            Ok(h) => h,
            Err(_) => continue,
        };
        match base.get(rel) {
            None => {
                if cur.size > MAX_STORE_BYTES {
                    changes.push(FileChange {
                        path: rel.clone(),
                        status: "added".into(),
                        additions: 0,
                        deletions: 0,
                        binary: true,
                    });
                } else {
                    let (add, del, binary) = count_lines(&files_root.join(rel), &cur.abs);
                    total_add += add;
                    total_del += del;
                    changes.push(FileChange {
                        path: rel.clone(),
                        status: "added".into(),
                        additions: add,
                        deletions: del,
                        binary,
                    });
                }
            }
            Some(b) if b.hash != cur_hash => {
                if !b.stored {
                    // 基线只存了指纹（超过上限），无法出文本差异
                    changes.push(FileChange {
                        path: rel.clone(),
                        status: "modified".into(),
                        additions: 0,
                        deletions: 0,
                        binary: true,
                    });
                } else {
                    let (add, del, binary) = count_lines(&files_root.join(rel), &cur.abs);
                    total_add += add;
                    total_del += del;
                    changes.push(FileChange {
                        path: rel.clone(),
                        status: "modified".into(),
                        additions: add,
                        deletions: del,
                        binary,
                    });
                }
            }
            Some(_) => {}
        }
    }

    for rel in base.keys() {
        if !current.contains_key(rel) {
            let stored = base.get(rel).map(|b| b.stored).unwrap_or(false);
            let (binary, del) = if stored {
                let (_, del, binary) = count_lines(&files_root.join(rel), Path::new(""));
                (binary, del)
            } else {
                (true, 0)
            };
            total_del += del;
            changes.push(FileChange {
                path: rel.clone(),
                status: "deleted".into(),
                additions: 0,
                deletions: del,
                binary,
            });
        }
    }

    changes.sort_by(|a, b| a.path.cmp(&b.path));
    let current_version = current
        .get("manifest.json")
        .map(|f| {
            std::fs::read_to_string(&f.abs)
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|v| v.get("version").and_then(|x| x.as_str()).map(|s| s.to_string()))
                .unwrap_or_default()
        })
        .unwrap_or_default();

    Ok(Summary {
        plugin_id: plugin_id.to_string(),
        version: current_version.clone(),
        baseline_at: baseline.created_at,
        baseline_stale: !current_version.is_empty() && current_version != baseline.version,
        files: changes,
        additions: total_add,
        deletions: total_del,
    })
}

/// 返回 (新增行, 删除行, 是否二进制)。任一侧为空（新增/删除文件）时按空串对比。
fn count_lines(old: &Path, new: &Path) -> (usize, usize, bool) {
    let binary = (!old.as_os_str().is_empty() && is_binary(old))
        || (!new.as_os_str().is_empty() && is_binary(new));
    if binary {
        return (0, 0, true);
    }
    let a = if old.as_os_str().is_empty() {
        String::new()
    } else {
        read_text(old)
    };
    let b = if new.as_os_str().is_empty() {
        String::new()
    } else {
        read_text(new)
    };
    let diff = similar::TextDiff::from_lines(&a, &b);
    let mut add = 0;
    let mut del = 0;
    for change in diff.iter_all_changes() {
        match change.tag() {
            similar::ChangeTag::Insert => add += 1,
            similar::ChangeTag::Delete => del += 1,
            similar::ChangeTag::Equal => {}
        }
    }
    (add, del, false)
}

/// 单个文件的 unified diff（前端按 `+ / - / @@` 着色，与 IDE 的审阅面板同一套渲染直觉）。
pub fn diff_file(app: &AppHandle, plugin_id: &str, dir: &Path, rel: &str) -> Result<String, String> {
    let rel_path = safe_rel(rel)?;
    let old_path = baseline_files(app, plugin_id)?.join(&rel_path);
    let new_path = dir.join(&rel_path);

    let binary = (old_path.exists() && is_binary(&old_path)) || (new_path.exists() && is_binary(&new_path));
    if binary {
        return Ok(format!("二进制文件，无法显示文本差异：{rel}"));
    }

    let old = if old_path.exists() { read_text(&old_path) } else { String::new() };
    let new = if new_path.exists() { read_text(&new_path) } else { String::new() };

    let diff = similar::TextDiff::from_lines(&old, &new);
    let text = diff
        .unified_diff()
        .context_radius(3)
        .header(&format!("a/{rel}"), &format!("b/{rel}"))
        .to_string();

    if text.is_empty() {
        return Ok(String::new());
    }
    let mut lines: Vec<&str> = text.lines().collect();
    if lines.len() > MAX_DIFF_LINES {
        lines.truncate(MAX_DIFF_LINES);
        lines.push("…（差异过长，已截断）");
    }
    Ok(lines.join("\n"))
}

// ================= 回滚 =================

/// 把单个文件恢复到安装基线。基线里没有（新增文件）就删除。
pub fn restore_file(app: &AppHandle, plugin_id: &str, dir: &Path, rel: &str) -> Result<bool, String> {
    let rel_path = safe_rel(rel)?;
    let base_path = baseline_files(app, plugin_id)?.join(&rel_path);
    let live_path = dir.join(&rel_path);

    if base_path.exists() {
        if let Some(parent) = live_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
        std::fs::copy(&base_path, &live_path).map_err(|e| format!("恢复文件失败: {e}"))?;
        Ok(true)
    } else if live_path.exists() {
        std::fs::remove_file(&live_path).map_err(|e| format!("删除新增文件失败: {e}"))?;
        Ok(true)
    } else {
        Ok(false)
    }
}

/// 整插件恢复到安装基线。返回 (恢复的文件数, 删除的文件数)。
pub fn restore_all(app: &AppHandle, plugin_id: &str, dir: &Path) -> Result<(usize, usize), String> {
    let summary = scan_changes(app, plugin_id, dir)?;
    let mut restored = 0;
    let mut removed = 0;
    for f in summary.files {
        if f.status == "deleted" {
            if restore_file(app, plugin_id, dir, &f.path)? {
                restored += 1;
            }
        } else if f.status == "added" {
            if restore_file(app, plugin_id, dir, &f.path)? {
                removed += 1;
            }
        } else if restore_file(app, plugin_id, dir, &f.path)? {
            restored += 1;
        }
    }
    Ok((restored, removed))
}

// ================= 导出 =================

fn exports_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = changesets_root(app)?.join("exports");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建导出目录失败: {e}"))?;
    Ok(dir)
}

/// 导出统一 patch（可直接 `git apply` / 发给别人看）。
pub fn export_patch(app: &AppHandle, plugin_id: &str, dir: &Path) -> Result<String, String> {
    let summary = scan_changes(app, plugin_id, dir)?;
    if summary.files.is_empty() {
        return Err("没有改动，无需导出".into());
    }
    let mut out = String::new();
    for f in &summary.files {
        let text = diff_file(app, plugin_id, dir, &f.path)?;
        if !text.is_empty() {
            out.push_str(&text);
            if !text.ends_with('\n') {
                out.push('\n');
            }
        }
    }
    let path = exports_dir(app)?.join(format!("{}-{}.patch", plugin_id, now_secs()));
    std::fs::write(&path, out).map_err(|e| format!("写入 patch 失败: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// 把当前插件目录打包成 `.mufurong`（ZIP 改后缀，与 scripts/pack-mufurong.mjs 同格式）。
pub fn pack_plugin(app: &AppHandle, plugin_id: &str, dir: &Path, version: &str) -> Result<String, String> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    let out_path = exports_dir(app)?.join(format!(
        "{}-{}-{}.mufurong",
        plugin_id,
        if version.is_empty() { "dev" } else { version },
        now_secs()
    ));
    let file = std::fs::File::create(&out_path).map_err(|e| format!("创建包失败: {e}"))?;
    let mut zw = zip::ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    for f in collect_files(dir) {
        zw.start_file(&f.rel, opts).map_err(|e| format!("写入包失败: {e}"))?;
        let bytes = std::fs::read(&f.abs).map_err(|e| format!("读取文件失败: {e}"))?;
        zw.write_all(&bytes).map_err(|e| format!("写入包失败: {e}"))?;
    }
    zw.finish().map_err(|e| format!("收尾包失败: {e}"))?;
    Ok(out_path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_rel_rejects_traversal() {
        assert!(safe_rel("src/index.tsx").is_ok());
        assert!(safe_rel("../etc/passwd").is_err());
        assert!(safe_rel("a/../../b").is_err());
        assert!(safe_rel("C:/Windows").is_err());
    }

    #[test]
    fn sanitize_id_rejects_separators() {
        assert!(sanitize_id("niaoluo").is_ok());
        assert!(sanitize_id("../evil").is_err());
        assert!(sanitize_id("a/b").is_err());
    }
}
