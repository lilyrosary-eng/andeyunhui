//! 中转站索引：把「中转站」从**一个目录**升级成**一张索引表**。
//!
//! ## 为什么不扫目录就够了
//!
//! 旧的 `list_dropzone_files` 等价于 `read_dir(dropzone)`：能看到什么，完全取决于
//! 文件在不在那一个目录里。于是出现了两个互相矛盾的后果——
//!
//! 1. 下载到 `D:\资料\` 的东西**永远不出现**在中转站（它没被复制进来）；
//! 2. 从桌面拖进来的文件被**复制**一份进 dropzone（双份磁盘，40GB 视频就是 80GB）。
//!
//! 用户想要的是「中转站 = 所有我经手过的文件的一张清单」，不是「一个暂存文件夹」。
//!
//! ## 现在的模型
//!
//! - `managed`：文件在 dropzone 里，**中转站拥有它**。
//! - `referenced`：文件在用户自己的目录，**中转站只是记得它**。
//!
//! **所有权决定删除语义 —— 这是整个设计的轴。**
//! managed 删了是把中转站自己的副本扔掉，安全；referenced 删了是删用户唯一一份，
//! 不可逆。所以：
//!
//! - `remove_record`（默认动作）：managed → 先把字节归档进回收站再删文件；
//!   referenced → **只删索引条目，磁盘文件一动不动**。
//! - `delete_file`（显式第二动作）：真的删真实文件。
//!
//! ## 三个不要假设
//!
//! 1. **路径随时会消失**。U 盘拔了、资源管理器里改名了、网盘卸载了。
//!    所以每条都要 `stat`，状态记 `ok | missing`；`missing` **保留记录**，
//!    否则插拔一次移动硬盘，历史记录全没了。
//! 2. **文件名不是身份**。改名会打断 `localimg://` 引用、回收站还原、下载断点续传。
//!    所以有稳定 `id`，`name`/`path` 只是属性。
//! 3. **前端不能给路径**。一旦条目可以指向任意位置，「前端传 stored_path、后端拼进目录」
//!    这套旧写法就变成一个任意文件读/删的 IPC。所有操作只收 `id`，路径由后端自己查。

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

use crate::services::transfer_station;

/// 索引文件名。以 `.` 开头，扫目录时必须跳过，否则它会以「一个文件」的身份出现在列表里。
pub const INDEX_FILE: &str = ".station.json";

/// 旧版来源登记表（只有 `文件名 → origin`）。现在只读不写，读到就迁移进索引。
const LEGACY_ORIGIN_FILE: &str = ".origin.json";

const INDEX_VERSION: u32 = 2;

/// 与 `dropzone.rs::READABLE_EXTENSIONS` 同一份清单（文本类可内联预览）。
const READABLE_EXTENSIONS: &[&str] = &[
    "md", "txt", "json", "csv", "xml", "yaml", "yml", "toml", "ini", "cfg", "log", "env", "html",
    "css", "js", "ts", "tsx", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "rb", "php", "c",
    "cpp", "h", "hpp", "swift", "kt", "scala", "sh", "bash", "zsh", "ps1", "bat", "cmd", "sql",
    "r", "m", "mm", "pl", "lua", "dart", "groovy", "gradle", "svelte", "vue", "astro", "tex",
    "bib", "rst", "asciidoc", "adoc",
];

// ================= 对外结构 =================

/// 中转站里的一条。**是索引，不是文件** —— 磁盘上的东西才是真相。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StationEntry {
    /// 稳定 id。重命名/移动后不变，前端所有操作都以它为键。
    pub id: String,
    /// 展示名（当前文件名）。
    pub name: String,
    /// 真实绝对路径。
    pub path: String,
    pub size: u64,
    pub extension: String,
    pub modified_at: String,
    pub added_at: String,
    /// `managed`（中转站拥有）| `referenced`（只记得）
    pub ownership: String,
    /// `local` | `download` | `external`
    pub source: String,
    /// `ok` | `missing`
    pub status: String,
    pub is_readable: bool,
    /// referenced 且来源是下载时的任务 id，用于回写路径 / 重新下载。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_id: Option<String>,
}

impl StationEntry {
    pub fn is_managed(&self) -> bool {
        self.ownership == OWNERSHIP_MANAGED
    }
}

pub const OWNERSHIP_MANAGED: &str = "managed";
pub const OWNERSHIP_REFERENCED: &str = "referenced";

pub const STATUS_OK: &str = "ok";
pub const STATUS_MISSING: &str = "missing";

/// 一个外部来源（下载）的引用。由命令层从 `download_kit::DownloadTask` 映射过来，
/// 这样本模块不依赖 AppHandle，可以纯函数单测。
#[derive(Debug, Clone)]
pub struct DownloadRef {
    pub id: String,
    pub save_path: String,
    pub filename: String,
    pub size: u64,
    pub completed_at_ms: i64,
}

/// 列表结果。`notices` 用于把降级原因显式带给用户——
/// 读取下载记录失败不能静默变成「一个下载都没有」。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StationList {
    pub entries: Vec<StationEntry>,
    pub notices: Vec<String>,
}

// ================= 索引持久化 =================

/// 索引里的一个条目。**key 是稳定 id，不是文件名。**
///
/// v1 拿 dropzone 内的文件名当 key，代价有两条，都会在「移动」上撞墙：
/// 1. 改名必须换 key，换 key 就得同步改所有引用它的地方；
/// 2. 文件移出 dropzone 就只能删索引 —— 用户只是换了个位置，
///    文件却从中转站列表里凭空消失。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexEntry {
    /// 绝对路径。托管条目在 dropzone 内；移出去的仍在索引里，路径在外。
    path: String,
    source: String,
    added_at: String,
    /// `managed`（dropzone 内的副本，中转站拥有）| `referenced`（只是记得）
    ownership: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StationIndex {
    version: u32,
    /// key = 稳定 id
    entries: BTreeMap<String, IndexEntry>,
}

impl Default for StationIndex {
    fn default() -> Self {
        Self {
            version: INDEX_VERSION,
            entries: BTreeMap::new(),
        }
    }
}

/// v1 结构，只用于迁移（key 是 dropzone 内文件名）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StationIndexV1 {
    #[serde(default)]
    version: u32,
    entries: BTreeMap<String, ManagedMetaV1>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedMetaV1 {
    id: String,
    source: String,
    added_at: String,
}

pub fn dropzone_dir(app_data: &Path) -> PathBuf {
    app_data.join("transfer_station").join("dropzone")
}

fn index_path(app_data: &Path) -> PathBuf {
    dropzone_dir(app_data).join(INDEX_FILE)
}

/// 读索引。坏 JSON 当作空索引并重建——**坏数据不该让整个中转站打不开**。
fn read_index(app_data: &Path) -> StationIndex {
    let p = index_path(app_data);
    if let Ok(s) = std::fs::read_to_string(&p) {
        if let Ok(idx) = serde_json::from_str::<StationIndex>(&s) {
            if idx.version >= INDEX_VERSION {
                return idx;
            }
        }
        // v1 迁移：key 是文件名，值里带 id。转成 id 为 key、path 为绝对路径。
        if let Ok(v1) = serde_json::from_str::<StationIndexV1>(&s) {
            eprintln!(
                "[中转站] 索引 v{} → v{} 迁移（key: 文件名 → id，共 {} 条）",
                v1.version,
                INDEX_VERSION,
                v1.entries.len()
            );
            let dir = dropzone_dir(app_data);
            let mut idx = StationIndex::default();
            for (file_name, meta) in v1.entries {
                idx.entries.insert(
                    meta.id,
                    IndexEntry {
                        path: dir.join(&file_name).to_string_lossy().to_string(),
                        source: meta.source,
                        added_at: meta.added_at,
                        ownership: OWNERSHIP_MANAGED.to_string(),
                    },
                );
            }
            if let Err(e) = write_index(app_data, &idx) {
                eprintln!("[中转站] v1 索引迁移后写回失败（下次启动会重试）: {e}");
            }
            return idx;
        }
        eprintln!("[中转站] 索引解析失败，按目录重建: {} — {s}", p.display());
    }
    migrate_legacy_origin(app_data)
}

/// 旧 `.origin.json`（`文件名 → origin`）一次迁移。
///
/// 旧表没有 id / added_at，所以补登记时用 `added_at` 取文件 mtime、id 现生成；
/// 迁移完**不删除**旧文件（别的 harness / 旧版本可能还在读），只是不再写它。
fn migrate_legacy_origin(app_data: &Path) -> StationIndex {
    let mut idx = StationIndex::default();
    let dir = dropzone_dir(app_data);
    let legacy = dir.join(LEGACY_ORIGIN_FILE);
    let Ok(s) = std::fs::read_to_string(&legacy) else {
        return idx;
    };
    let Ok(map) = serde_json::from_str::<BTreeMap<String, String>>(&s) else {
        return idx;
    };
    eprintln!("[中转站] 迁移旧来源表 {} 条 → {}", map.len(), INDEX_FILE);
    for (file_name, origin) in map {
        let p = dir.join(&file_name);
        if !p.is_file() {
            continue;
        }
        idx.entries.insert(
            uuid::Uuid::new_v4().to_string(),
            IndexEntry {
                path: p.to_string_lossy().to_string(),
                source: if origin.eq_ignore_ascii_case("external") {
                    "download".to_string()
                } else {
                    "local".to_string()
                },
                added_at: mtime_string(&p),
                ownership: OWNERSHIP_MANAGED.to_string(),
            },
        );
    }
    idx
}

fn write_index(app_data: &Path, idx: &StationIndex) -> Result<(), String> {
    let dir = dropzone_dir(app_data);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建中转站目录失败: {e}"))?;
    let p = index_path(app_data);
    let s = serde_json::to_string_pretty(idx).map_err(|e| format!("序列化中转站索引失败: {e}"))?;
    std::fs::write(&p, s).map_err(|e| format!("写入中转站索引失败: {e}"))
}

// ================= 时间 / 大小工具 =================

fn mtime_string(p: &Path) -> String {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .map(|t| {
            let dt: chrono::DateTime<chrono::Local> = t.into();
            dt.format("%Y-%m-%d %H:%M:%S").to_string()
        })
        .unwrap_or_else(|_| "未知".to_string())
}

fn ms_to_string(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| {
            let dt: chrono::DateTime<chrono::Local> = t.into();
            dt.format("%Y-%m-%d %H:%M:%S").to_string()
        })
        .unwrap_or_else(|| "未知".to_string())
}

fn is_readable_ext(ext: &str) -> bool {
    READABLE_EXTENSIONS.contains(&ext)
}

/// 从 `stored_path`（`<毫秒时间戳>_<原名>`）里剥出原始文件名。
///
/// 只剥**纯数字前缀 + 下划线**：老代码用 `splitn(2, '_')`，遇到
/// `2024_report_final.pdf` 这种原名本身带下划线的会剥错，这里收紧成数字判断。
fn strip_timestamp_prefix(file_name: &str) -> String {
    match file_name.split_once('_') {
        Some((head, rest))
            if !head.is_empty() && head.len() >= 10 && head.bytes().all(|b| b.is_ascii_digit()) =>
        {
            rest.to_string()
        }
        _ => file_name.to_string(),
    }
}

// ================= 列表 =================

/// 合成中转站列表：索引条目 + dropzone 目录扫描（补登记）+ 下载任务。
///
/// 三个来源的优先级与去重：
/// 1. **索引是权威的**：先按索引把条目摆出来（含已经移出 dropzone 的那些）；
/// 2. dropzone 里有、索引里没有的文件（用户手动丢进去 / 旧版本遗留）当场补登记
///    —— 否则每次刷新 id 都不一样，前端选中态和操作全失效；
/// 3. 下载任务最后合并，用规范化路径去重，避免同一个文件既是托管又出现在下载记录里。
pub fn list(app_data: &Path, downloads: &[DownloadRef], notices: Vec<String>) -> StationList {
    let dir = dropzone_dir(app_data);
    let mut idx = read_index(app_data);
    let mut notices = notices;
    let mut entries: Vec<StationEntry> = Vec::new();
    let mut known: BTreeMap<String, ()> = BTreeMap::new();
    let mut dirty = false;

    // ---- 1) 扫 dropzone，给索引里没有的文件补登记 ----
    let mut on_disk: Vec<PathBuf> = Vec::new();
    if let Ok(items) = std::fs::read_dir(&dir) {
        for item in items.flatten() {
            let path = item.path();
            if !path.is_file() {
                continue;
            }
            // 以 `.` 开头的一律跳过：索引、旧来源表、以及任何 sidecar。
            if item.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            on_disk.push(path);
        }
    }
    for path in &on_disk {
        let key = canon_key(path);
        let registered = idx
            .entries
            .values()
            .any(|m| canon_key(Path::new(&m.path)) == key);
        if registered {
            continue;
        }
        idx.entries.insert(
            uuid::Uuid::new_v4().to_string(),
            IndexEntry {
                path: path.to_string_lossy().to_string(),
                source: "local".to_string(),
                added_at: mtime_string(path),
                ownership: OWNERSHIP_MANAGED.to_string(),
            },
        );
        dirty = true;
    }

    // ---- 2) 按索引摆条目 ----
    let ids: Vec<String> = idx.entries.keys().cloned().collect();
    for id in ids {
        let Some(meta) = idx.entries.get(&id).cloned() else {
            continue;
        };
        let p = PathBuf::from(&meta.path);
        let exists = p.is_file();
        let in_dropzone = parent_is(&p, &dir);

        if !exists {
            if meta.ownership == OWNERSHIP_MANAGED {
                // 托管副本已经没了（被外部删掉/清空），中转站确实没东西可展示，清掉条目。
                idx.entries.remove(&id);
                dirty = true;
                continue;
            }
            // 引用条目保留为 missing：U 盘拔了、网盘卸载了都是常态，
            // 直接把记录删了等于"插拔一次硬盘，历史全没"。
            notices.push(format!(
                "「{}」在磁盘上已找不到（{}），可能被移动或删除了",
                p.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| id.clone()),
                meta.path
            ));
        }

        // 托管=false 时，所有权以「文件当前是否还在 dropzone 里」为准：
        // 用户把托管文件移出去之后，它就成了"中转站记得、但不由它拥有"的条目。
        let ownership = if in_dropzone { OWNERSHIP_MANAGED } else { OWNERSHIP_REFERENCED };
        let file_name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let ext = p
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);

        known.insert(canon_key(&p), ());
        entries.push(StationEntry {
            id: id.clone(),
            name: strip_timestamp_prefix(&file_name),
            path: meta.path.clone(),
            size,
            extension: ext.clone(),
            modified_at: if exists { mtime_string(&p) } else { "—".to_string() },
            added_at: meta.added_at.clone(),
            ownership: ownership.to_string(),
            source: meta.source.clone(),
            status: if exists { STATUS_OK } else { STATUS_MISSING }.to_string(),
            is_readable: is_readable_ext(&ext),
            download_id: None,
        });
    }

    // ---- 3) 下载任务（去重后合并）----
    for d in downloads {
        let p = PathBuf::from(&d.save_path);
        let key = canon_key(&p);
        if known.contains_key(&key) {
            continue;
        }
        known.insert(key, ());
        let exists = p.is_file();
        let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(d.size);
        let ext = p
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if !exists {
            notices.push(format!(
                "下载记录「{}」在磁盘上已找不到（{}），可能被移动或删除了",
                d.filename, d.save_path
            ));
        }
        entries.push(StationEntry {
            id: d.id.clone(),
            name: d.filename.clone(),
            path: d.save_path.clone(),
            size,
            extension: ext.clone(),
            modified_at: if exists { mtime_string(&p) } else { "—".to_string() },
            added_at: ms_to_string(d.completed_at_ms),
            ownership: OWNERSHIP_REFERENCED.to_string(),
            source: "download".to_string(),
            status: if exists { STATUS_OK } else { STATUS_MISSING }.to_string(),
            is_readable: is_readable_ext(&ext),
            download_id: Some(d.id.clone()),
        });
    }

    if dirty {
        if let Err(e) = write_index(app_data, &idx) {
            // 索引写不进去不阻断列表，但必须说出来：下次刷新 id 会变。
            notices.push(format!("中转站索引写入失败（{e}），下次刷新后条目 id 可能变化"));
        }
    }

    // 新的在前
    entries.sort_by(|a, b| b.added_at.cmp(&a.added_at));
    StationList { entries, notices }
}

/// `p` 的父目录是否就是 `dir`（用于判断「还在不在 dropzone 里」）。
///
/// 不能直接用 `canon_key(p).starts_with(canon_key(dir))`：那样
/// `dropzone2/x` 会被误判成在 `dropzone` 里。必须比到**父目录**这一级。
fn parent_is(p: &Path, dir: &Path) -> bool {
    match p.parent() {
        Some(parent) => canon_key(parent) == canon_key(dir),
        None => false,
    }
}

/// 用于去重的路径键：能 canonicalize 就 canonicalize（消掉 `\\?\` 与短名差异），
/// 不能（文件已不存在）就小写原样。Windows 路径大小写不敏感，必须归一。
fn canon_key(p: &Path) -> String {
    match p.canonicalize() {
        Ok(c) => c.to_string_lossy().to_lowercase(),
        Err(_) => p.to_string_lossy().to_lowercase(),
    }
}

// ================= 按 id 定位 =================

/// 解析一个 id 到条目。
///
/// **这是唯一允许把「前端输入」变成「文件路径」的地方。** 除了这里，
/// 任何地方都不该接受前端传来的绝对路径——那等于开一个任意文件读/删的 IPC。
///
/// 索引里存的是后端自己写下的绝对路径，所以这里查表得到的路径是可信的；
/// 前端唯一能控制的只有 `id` 这一个键。
pub fn resolve(app_data: &Path, downloads: &[DownloadRef], id: &str) -> Result<StationEntry, String> {
    let dir = dropzone_dir(app_data);
    let idx = read_index(app_data);
    if let Some(meta) = idx.entries.get(id) {
        let path = PathBuf::from(&meta.path);
        if !path.is_file() {
            return Err(format!("文件已不在原位置: {}", meta.path));
        }
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        // 所有权按「现在还在不在 dropzone 里」实时判定，和 list() 保持同一口径。
        let ownership = if parent_is(&path, &dir) {
            OWNERSHIP_MANAGED
        } else {
            OWNERSHIP_REFERENCED
        };
        return Ok(StationEntry {
            id: id.to_string(),
            name: strip_timestamp_prefix(&file_name),
            path: meta.path.clone(),
            size: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
            extension: ext.clone(),
            modified_at: mtime_string(&path),
            added_at: meta.added_at.clone(),
            ownership: ownership.to_string(),
            source: meta.source.clone(),
            status: STATUS_OK.to_string(),
            is_readable: is_readable_ext(&ext),
            download_id: None,
        });
    }
    if let Some(d) = downloads.iter().find(|d| d.id == id) {
        let p = PathBuf::from(&d.save_path);
        let exists = p.is_file();
        let ext = p
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        return Ok(StationEntry {
            id: d.id.clone(),
            name: d.filename.clone(),
            path: d.save_path.clone(),
            size: std::fs::metadata(&p).map(|m| m.len()).unwrap_or(d.size),
            extension: ext.clone(),
            modified_at: if exists { mtime_string(&p) } else { "—".to_string() },
            added_at: ms_to_string(d.completed_at_ms),
            ownership: OWNERSHIP_REFERENCED.to_string(),
            source: "download".to_string(),
            status: if exists { STATUS_OK } else { STATUS_MISSING }.to_string(),
            is_readable: is_readable_ext(&ext),
            download_id: Some(d.id.clone()),
        });
    }
    Err(format!("中转站里没有这个条目: {id}"))
}

// ================= 移除记录（默认动作）=================

/// 移除记录时到底发生了什么。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveOutcome {
    /// 是否真的动了磁盘。
    pub deleted_file: bool,
    /// 是否进了回收站。
    pub archived: bool,
    /// 必须给用户看的提示（回收站没进去 / 超配额 / 降级）。成功且安全时为空。
    pub notice: Option<String>,
}

/// 移除一条记录。**默认动作，不删用户的东西。**
///
/// - `managed`：中转站自己的副本 → 先归档进回收站，再删 dropzone 里的文件。
///   归档失败也照样删（列表必须能清），但返回显式提示说明这次**不可撤销**。
/// - `referenced`：用户的真实文件 → **只删索引条目，磁盘一动不动**。
pub fn remove_record(app_data: &Path, entry: &StationEntry) -> RemoveOutcome {
    if !entry.is_managed() {
        // 引用条目：**绝不碰磁盘**。
        //
        // 但要区分两种引用：
        // - 来源是下载任务（`download_id` 有值）：记录在 download-kit 的库里，
        //   由命令层调 `forget` 清掉，这里什么都不做；
        // - 来源是索引（曾经托管、后来被用户移出 dropzone）：必须把索引条目删掉，
        //   否则用户点了「移除记录」看起来毫无反应，下次刷新它还在原地。
        if entry.download_id.is_none() {
            drop_index_entry(app_data, &entry.id);
        }
        return RemoveOutcome {
            deleted_file: false,
            archived: false,
            notice: None,
        };
    }

    let path = Path::new(&entry.path);

    // 走 `archive_file_at`（fs::copy 流式）而不是把文件读进内存再写：
    // 中转站里 1~2 GB 的视频很常见，`fs::read` 会直接把进程顶爆。
    // source_id 必须每次唯一，否则同 (kind, source_id) 的覆盖语义
    // 会把上一次回收站记录顶掉，用户就找不回上一个文件了。
    let source_id = uuid::Uuid::new_v4().to_string();
    let outcome = transfer_station::archive_file_at(
        app_data,
        "file",
        &source_id,
        &entry.name,
        path,
        &entry.extension,
        Some(path),
    );
    let archived = outcome.is_archived();
    let mut notice = outcome.notice();

    match std::fs::remove_file(path) {
        Ok(_) => {
            drop_index_entry(app_data, &entry.id);
            RemoveOutcome {
                deleted_file: true,
                archived,
                notice,
            }
        }
        Err(e) => {
            // 文件没删掉就**不能**把记录也删了，否则列表里看不见、磁盘上还在，
            // 用户再也没有入口去处理它。
            if notice.is_none() {
                notice = Some(format!("删除文件失败（{e}），记录已保留"));
            } else {
                notice = Some(format!(
                    "删除文件失败（{e}），记录已保留；{}",
                    notice.unwrap_or_default()
                ));
            }
            RemoveOutcome {
                deleted_file: false,
                archived,
                notice,
            }
        }
    }
}

/// 显式删除真实文件（第二动作，UI 上必须和「移除记录」分开）。
pub fn delete_file(app_data: &Path, entry: &StationEntry) -> Result<(), String> {
    let path = Path::new(&entry.path);
    if path.is_file() {
        std::fs::remove_file(path).map_err(|e| format!("删除文件失败: {e}"))?;
    }
    drop_index_entry(app_data, &entry.id);
    Ok(())
}

/// 从索引里删掉一条。`id` 是索引的 key，所以这里是 O(log n) 的精确删除，
/// 不再需要「拿文件名反查」那种容易在改名后失手的写法。
fn drop_index_entry(app_data: &Path, id: &str) {
    let mut idx = read_index(app_data);
    if idx.entries.remove(id).is_some() {
        if let Err(e) = write_index(app_data, &idx) {
            eprintln!("[中转站] 移除索引条目后写回失败: {e}");
        }
    }
}

// ================= 改名 / 移动 =================

// ================= 改名 / 移动 =================

/// 移动过程的上下文：可取消 + 进度回调。
///
/// 为什么移动不能做成"点一下就好"：同卷 `rename` 是原子的、瞬时的，
/// 但**跨卷**（从 C 盘搬到 D 盘）只能「读一块写一块」，30 GB 是分钟级。
/// 把这种事包成一个没有反馈的同步调用，用户唯一能做的就是以为它卡死了。
pub struct MoveCtx<'a> {
    /// 置 true 时中止。中止后目标位置的半成品会被删掉——
    /// 留半个文件比失败本身更糟：它看起来像成功了。
    pub cancel: Option<&'a AtomicBool>,
    /// (已复制字节, 总字节)。走同卷 rename 时不会逐块回调，只在结束时补一次满值。
    pub progress: Option<&'a mut dyn FnMut(u64, u64)>,
}

impl<'a> MoveCtx<'a> {
    pub fn silent() -> Self {
        Self {
            cancel: None,
            progress: None,
        }
    }
    fn canceled(&self) -> bool {
        self.cancel
            .map(|c| c.load(Ordering::Relaxed))
            .unwrap_or(false)
    }
    fn report(&mut self, done: u64, total: u64) {
        if let Some(cb) = self.progress.as_mut() {
            (**cb)(done, total);
        }
    }
}

/// 每次读写的块大小。4 MiB 在机械盘上顺序读写表现不错，又不会把内存顶起来。
const MOVE_CHUNK: usize = 4 * 1024 * 1024;

/// 流式复制：读一块写一块，边写边报进度，可中止。
///
/// 不用 `fs::copy`：它没有办法报进度、也没办法中途停下，
/// 而这两件事正是"跨卷搬大文件"唯一的用户可见部分。
fn copy_streaming(src: &Path, dst: &Path, ctx: &mut MoveCtx) -> Result<u64, String> {
    let total = std::fs::metadata(src)
        .map_err(|e| format!("读取源文件大小失败: {e}"))?
        .len();
    let mut reader = std::fs::File::open(src).map_err(|e| format!("打开源文件失败: {e}"))?;
    let mut writer = std::fs::File::create(dst).map_err(|e| format!("创建目标文件失败: {e}"))?;
    let mut buf = vec![0u8; MOVE_CHUNK];
    let mut done = 0u64;
    loop {
        if ctx.canceled() {
            drop(writer);
            // 半成品必须删掉：留着它，用户在目标目录看到的是一个大小不对、
            // 可能还打不开的文件，比"没有这个文件"误导得多。
            let _ = std::fs::remove_file(dst);
            return Err("已取消移动".to_string());
        }
        let n = reader.read(&mut buf).map_err(|e| format!("读取失败: {e}"))?;
        if n == 0 {
            break;
        }
        writer
            .write_all(&buf[..n])
            .map_err(|e| format!("写入失败: {e}"))?;
        done += n as u64;
        ctx.report(done, total);
    }
    writer.flush().map_err(|e| format!("刷新缓冲区失败: {e}"))?;
    Ok(done)
}

/// 改名或移动。返回新路径。
///
/// 顺序是**先动磁盘、后改库**：中间失败最多是索引/任务记录还指向旧路径（下次刷新
/// 会变成 `missing`，用户能看见）；反过来先改库再动盘，失败后记录说在新地方、
/// 文件还在老地方，续传会往另一个文件里写。
/// 移动结果。
#[derive(Debug, Clone)]
pub struct MoveOutcome {
    pub path: String,
    /// 是否走了跨卷的流式复制（而不是瞬时 `rename`）。
    /// 由实现如实报告，不靠"父目录变没变"去猜——猜错了会给出误导性的耗时提示。
    pub streamed: bool,
}

pub fn relocate(
    app_data: &Path,
    entry: &StationEntry,
    new_path: &Path,
) -> Result<String, String> {
    relocate_with(app_data, entry, new_path, &mut MoveCtx::silent()).map(|o| o.path)
}

/// 带进度/可取消的移动实现。
pub fn relocate_with(
    app_data: &Path,
    entry: &StationEntry,
    new_path: &Path,
    ctx: &mut MoveCtx,
) -> Result<MoveOutcome, String> {
    let src = Path::new(&entry.path);
    if !src.is_file() {
        return Err("源文件不存在，无法改名/移动".to_string());
    }
    if canon_key(new_path) == canon_key(src) {
        // 目标就是自己：什么都不用做，但也不能当成"成功移动"糊弄过去
        return Err("目标路径与当前位置相同".to_string());
    }
    if new_path.exists() {
        return Err(format!("目标已存在: {}", new_path.display()));
    }
    if let Some(parent) = new_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建目标目录失败 {}: {e}", parent.display()))?;
    }

    let total = std::fs::metadata(src).map(|m| m.len()).unwrap_or(0);

    // 同卷 rename 是原子的、零拷贝；跨卷会失败（Windows 上是 ERROR_NOT_SAME_DEVICE），
    // 这时才退回流式复制。先试 rename 是为了让"改个名"这种常见操作保持瞬时。
    let renamed = match std::fs::rename(src, new_path) {
        Ok(_) => true,
        Err(e) => {
            eprintln!(
                "[中转站] rename 失败（{e}），回退到流式复制: {} → {}",
                src.display(),
                new_path.display()
            );
            false
        }
    };

    if renamed {
        ctx.report(total, total);
    } else {
        copy_streaming(src, new_path, ctx)?;
        std::fs::remove_file(src).map_err(|e| {
            format!(
                "已复制到 {} 但删除源文件失败（{e}），现在有两份副本，请手动删掉其中一份",
                new_path.display()
            )
        })?;
    }

    // 索引里只更新这一条的 path/ownership。**不移除条目**：
    // 用户只是把文件挪了个位置，它不该从中转站列表里消失。
    let dropzone = dropzone_dir(app_data);
    let mut idx = read_index(app_data);
    if let Some(meta) = idx.entries.get_mut(&entry.id) {
        meta.path = new_path.to_string_lossy().to_string();
        meta.ownership = if parent_is(new_path, &dropzone) {
            OWNERSHIP_MANAGED.to_string()
        } else {
            OWNERSHIP_REFERENCED.to_string()
        };
        write_index(app_data, &idx)?;
    }
    Ok(MoveOutcome {
        path: new_path.to_string_lossy().to_string(),
        streamed: !renamed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "station_test_{tag}_{}",
            uuid::Uuid::new_v4().simple()
        ));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(dropzone_dir(&d)).unwrap();
        d
    }

    fn touch(app: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let p = dropzone_dir(app).join(name);
        fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn managed_files_get_stable_ids_across_calls() {
        let app = tmp("stable_id");
        touch(&app, "1700000000000_a.txt", b"hi");

        let first = list(&app, &[], vec![]);
        assert_eq!(first.entries.len(), 1);
        let id1 = first.entries[0].id.clone();
        assert_eq!(first.entries[0].name, "a.txt", "时间戳前缀应被剥掉");

        let second = list(&app, &[], vec![]);
        assert_eq!(second.entries[0].id, id1, "id 必须跨刷新稳定");
    }

    #[test]
    fn index_and_origin_sidecars_are_not_listed() {
        let app = tmp("skip_dot");
        touch(&app, ".station.json", b"{}");
        touch(&app, ".origin.json", b"{}");
        touch(&app, "real.txt", b"x");
        let l = list(&app, &[], vec![]);
        assert_eq!(l.entries.len(), 1, "以 . 开头的 sidecar 不能出现在列表里");
    }

    #[test]
    fn download_entries_are_referenced_and_report_missing() {
        let app = tmp("download_ref");
        let present = app.join("user").join("present.bin");
        fs::create_dir_all(present.parent().unwrap()).unwrap();
        fs::write(&present, b"12345").unwrap();

        let downloads = vec![
            DownloadRef {
                id: "dl-1".into(),
                save_path: present.to_string_lossy().into(),
                filename: "present.bin".into(),
                size: 5,
                completed_at_ms: 1_700_000_000_000,
            },
            DownloadRef {
                id: "dl-2".into(),
                save_path: app.join("user").join("gone.bin").to_string_lossy().into(),
                filename: "gone.bin".into(),
                size: 9,
                completed_at_ms: 1_700_000_001_000,
            },
        ];
        let l = list(&app, &downloads, vec![]);
        assert_eq!(l.entries.len(), 2);
        let gone = l.entries.iter().find(|e| e.id == "dl-2").unwrap();
        assert_eq!(gone.status, STATUS_MISSING, "磁盘上没了要标 missing");
        assert_eq!(gone.ownership, OWNERSHIP_REFERENCED);
        assert!(
            l.notices.iter().any(|n| n.contains("gone.bin")),
            "missing 条目必须有显式提示，不能静默"
        );
    }

    #[test]
    fn download_already_in_dropzone_is_not_duplicated() {
        let app = tmp("dedup");
        let p = touch(&app, "1700000000000_x.bin", b"abc");
        let downloads = vec![DownloadRef {
            id: "dl-x".into(),
            save_path: p.to_string_lossy().into(),
            filename: "x.bin".into(),
            size: 3,
            completed_at_ms: 1_700_000_000_000,
        }];
        let l = list(&app, &downloads, vec![]);
        assert_eq!(l.entries.len(), 1, "同一个文件不能既 managed 又 referenced");
        assert_eq!(l.entries[0].ownership, OWNERSHIP_MANAGED);
    }

    #[test]
    fn remove_record_on_managed_archives_then_deletes() {
        let app = tmp("remove_managed");
        let p = touch(&app, "1700000000000_keep.txt", b"payload");
        let l = list(&app, &[], vec![]);
        let entry = l.entries[0].clone();

        let out = remove_record(&app, &entry);
        assert!(out.deleted_file, "managed 应删掉 dropzone 里的副本");
        assert!(out.archived, "应先进回收站");
        assert!(out.notice.is_none(), "顺利进回收站时不该有告警");
        assert!(!p.exists(), "dropzone 文件应已删除");

        let archives = transfer_station::list_archives(&app);
        assert_eq!(archives.len(), 1, "回收站里应有 1 条");
        assert_eq!(
            archives[0].origin_path.as_deref(),
            Some(p.to_string_lossy().as_ref()),
            "回收站要记住原路径，否则还原不回去"
        );
    }

    #[test]
    fn remove_record_on_referenced_touches_nothing() {
        let app = tmp("remove_referenced");
        let real = app.join("user").join("mine.bin");
        fs::create_dir_all(real.parent().unwrap()).unwrap();
        fs::write(&real, b"data").unwrap();

        let downloads = vec![DownloadRef {
            id: "dl-mine".into(),
            save_path: real.to_string_lossy().into(),
            filename: "mine.bin".into(),
            size: 4,
            completed_at_ms: 1_700_000_000_000,
        }];
        let l = list(&app, &downloads, vec![]);
        let out = remove_record(&app, &l.entries[0]);
        assert!(!out.deleted_file, "referenced 绝不能碰磁盘");
        assert!(real.is_file(), "用户的文件必须还在");
    }

    #[test]
    fn resolve_rejects_unknown_id() {
        let app = tmp("resolve_unknown");
        assert!(resolve(&app, &[], "nope").is_err());
    }

    #[test]
    fn rename_keeps_id_and_updates_index_key() {
        let app = tmp("rename");
        let p = touch(&app, "1700000000000_old.txt", b"x");
        let l = list(&app, &[], vec![]);
        let entry = l.entries[0].clone();

        let new_path = dropzone_dir(&app).join("1700000000000_new.txt");
        let landed = relocate(&app, &entry, &new_path).unwrap();
        assert_eq!(Path::new(&landed), new_path);
        assert!(!p.exists());

        let after = list(&app, &[], vec![]);
        assert_eq!(after.entries.len(), 1);
        assert_eq!(after.entries[0].id, entry.id, "改名后 id 必须不变");
        assert_eq!(after.entries[0].name, "new.txt");
        assert_eq!(after.entries[0].status, STATUS_OK);
        assert_eq!(after.entries[0].ownership, OWNERSHIP_MANAGED);
    }

    /// 移动到 dropzone **外面**之后，条目必须还在列表里（变成"仅登记"）。
    ///
    /// 这是 v1 索引结构撑不住的那条：旧实现把索引 key 当作 dropzone 内文件名，
    /// 文件一移出去就只能删索引，于是"用户只是换了个位置，文件凭空消失"。
    #[test]
    fn move_out_of_dropzone_keeps_entry_as_referenced() {
        let app = tmp("move_out");
        touch(&app, "1700000000000_doc.txt", b"payload");
        let l = list(&app, &[], vec![]);
        let entry = l.entries[0].clone();
        assert_eq!(entry.ownership, OWNERSHIP_MANAGED);

        let outside = app.join("user").join("moved").join("doc.txt");
        relocate(&app, &entry, &outside).unwrap();

        let after = list(&app, &[], vec![]);
        assert_eq!(after.entries.len(), 1, "移出去不该从列表里消失");
        assert_eq!(after.entries[0].id, entry.id, "id 必须保持不变");
        assert_eq!(
            after.entries[0].ownership, OWNERSHIP_REFERENCED,
            "移出 dropzone 后应由 managed 变成 referenced"
        );
        assert_eq!(after.entries[0].status, STATUS_OK);
        assert_eq!(Path::new(&after.entries[0].path), outside);
    }

    /// 从托管移出去的条目，点「移除记录」应该**只在索引里消失**，文件不能动。
    ///
    /// 这条防的是一个真实的坑：这类条目的 `download_id` 是 None，
    /// 早期实现会直接返回"没有可移除的来源"，用户点了没反应、下次刷新它还在。
    #[test]
    fn removing_referenced_index_entry_keeps_file() {
        let app = tmp("remove_moved");
        touch(&app, "1700000000000_a.txt", b"x");
        let entry = list(&app, &[], vec![]).entries[0].clone();
        let outside = app.join("user").join("a.txt");
        relocate(&app, &entry, &outside).unwrap();

        let moved = list(&app, &[], vec![]).entries[0].clone();
        assert_eq!(moved.ownership, OWNERSHIP_REFERENCED);
        assert!(moved.download_id.is_none(), "索引条目不挂下载任务 id");

        let out = remove_record(&app, &moved);
        assert!(!out.deleted_file, "引用条目绝不能删文件");
        assert!(outside.is_file(), "用户的文件必须还在");
        assert!(
            list(&app, &[], vec![]).entries.is_empty(),
            "索引条目应已被移除，否则用户点完移除下次刷新它还在"
        );
    }

    /// 取消移动：目标位置不能留下半成品。
    #[test]
    fn canceled_move_leaves_no_partial_file() {
        use std::sync::atomic::AtomicBool;
        let app = tmp("move_cancel");
        touch(&app, "1700000000000_big.bin", &vec![7u8; 1024]);
        let l = list(&app, &[], vec![]);
        let entry = l.entries[0].clone();

        let dst = app.join("elsewhere").join("big.bin");
        let cancel = AtomicBool::new(true); // 一开始就是取消状态
        let mut ctx = MoveCtx {
            cancel: Some(&cancel),
            progress: None,
        };
        // 同卷 rename 会直接成功，所以这里先造一个跨"设备"的场景不现实；
        // 直接验 copy_streaming 的取消路径更可靠。
        let src = Path::new(&entry.path);
        std::fs::create_dir_all(dst.parent().unwrap()).unwrap();
        let err = copy_streaming(src, &dst, &mut ctx).unwrap_err();
        assert!(err.contains("取消"), "应报告已取消，实际: {err}");
        assert!(!dst.exists(), "取消后不能留下半成品");

        // 源文件必须还是完整的
        assert_eq!(std::fs::metadata(src).unwrap().len(), 1024);
    }

    /// v1 索引（key 是文件名）必须能自动迁移，否则升级后老用户的中转站直接清空。
    #[test]
    fn v1_index_is_migrated_to_id_keyed() {
        let app = tmp("index_migrate");
        let p = touch(&app, "1700000000000_keep.txt", b"abc");
        let v1 = format!(
            r#"{{"version":1,"entries":{{"1700000000000_keep.txt":{{"id":"stable-id-1","source":"local","addedAt":"2026-01-01 00:00:00"}}}}}}"#
        );
        fs::write(dropzone_dir(&app).join(INDEX_FILE), v1).unwrap();

        let l = list(&app, &[], vec![]);
        assert_eq!(l.entries.len(), 1);
        assert_eq!(l.entries[0].id, "stable-id-1", "迁移必须保住原 id");
        assert_eq!(Path::new(&l.entries[0].path), p);
        assert_eq!(l.entries[0].ownership, OWNERSHIP_MANAGED);

        // 迁移结果要落盘成 v2
        let raw = fs::read_to_string(dropzone_dir(&app).join(INDEX_FILE)).unwrap();
        assert!(raw.contains("\"version\": 2") || raw.contains("\"version\":2"), "应写回 v2: {raw}");
    }

    #[test]
    fn strip_prefix_only_for_numeric_timestamp() {
        assert_eq!(strip_timestamp_prefix("1700000000000_a_b.txt"), "a_b.txt");
        assert_eq!(strip_timestamp_prefix("2024_report.pdf"), "2024_report.pdf");
        assert_eq!(strip_timestamp_prefix("plain.txt"), "plain.txt");
    }
}
