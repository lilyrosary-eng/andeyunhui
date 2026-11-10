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
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::services::transfer_station;

/// 索引文件名。以 `.` 开头，扫目录时必须跳过，否则它会以「一个文件」的身份出现在列表里。
pub const INDEX_FILE: &str = ".station.json";

/// 旧版来源登记表（只有 `文件名 → origin`）。现在只读不写，读到就迁移进索引。
const LEGACY_ORIGIN_FILE: &str = ".origin.json";

const INDEX_VERSION: u32 = 1;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedMeta {
    id: String,
    source: String,
    added_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StationIndex {
    version: u32,
    /// key = dropzone 内的文件名（= `stored_path`）
    entries: BTreeMap<String, ManagedMeta>,
}

impl Default for StationIndex {
    fn default() -> Self {
        Self {
            version: INDEX_VERSION,
            entries: BTreeMap::new(),
        }
    }
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
        match serde_json::from_str::<StationIndex>(&s) {
            Ok(mut idx) => {
                if idx.version == 0 {
                    idx.version = INDEX_VERSION;
                }
                return idx;
            }
            Err(e) => eprintln!("[中转站] 索引解析失败，按目录重建: {} — {e}", p.display()),
        }
    }
    migrate_legacy_origin(app_data)
}

/// 旧 `.origin.json`（`文件名 → origin`）一次迁移。
///
/// 旧表没有 id / added_at，所以补登记时用 `added_at` 取文件 mtime、id 现生成；
/// 迁移完**不删除**旧文件（别的 harness / 旧版本可能还在读），只是不再写它。
fn migrate_legacy_origin(app_data: &Path) -> StationIndex {
    let mut idx = StationIndex::default();
    let legacy = dropzone_dir(app_data).join(LEGACY_ORIGIN_FILE);
    let Ok(s) = std::fs::read_to_string(&legacy) else {
        return idx;
    };
    let Ok(map) = serde_json::from_str::<BTreeMap<String, String>>(&s) else {
        return idx;
    };
    eprintln!("[中转站] 迁移旧来源表 {} 条 → {}", map.len(), INDEX_FILE);
    for (file_name, origin) in map {
        let p = dropzone_dir(app_data).join(&file_name);
        if !p.is_file() {
            continue;
        }
        idx.entries.insert(
            file_name,
            ManagedMeta {
                id: uuid::Uuid::new_v4().to_string(),
                source: if origin.eq_ignore_ascii_case("external") {
                    "download".to_string()
                } else {
                    "local".to_string()
                },
                added_at: mtime_string(&p),
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

/// 合成中转站列表：`managed`（扫 dropzone）+ `referenced`（下载任务）。
///
/// 会**惰性补登记**：dropzone 里出现索引没有的文件（用户手动丢进去、旧版本遗留），
/// 当场分配 id 并落盘。否则每次刷新 id 都不一样，前端选中态和操作全失效。
pub fn list(app_data: &Path, downloads: &[DownloadRef], notices: Vec<String>) -> StationList {
    let dir = dropzone_dir(app_data);
    let mut idx = read_index(app_data);
    let mut notices = notices;
    let mut entries: Vec<StationEntry> = Vec::new();
    let mut known: BTreeMap<String, ()> = BTreeMap::new();
    let mut dirty = false;

    if let Ok(items) = std::fs::read_dir(&dir) {
        for item in items.flatten() {
            let path = item.path();
            if !path.is_file() {
                continue;
            }
            let file_name = item.file_name().to_string_lossy().to_string();
            // 以 `.` 开头的一律跳过：索引、旧来源表、以及任何 sidecar。
            if file_name.starts_with('.') {
                continue;
            }
            let size = item.metadata().map(|m| m.len()).unwrap_or(0);
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();

            let meta = idx.entries.get(&file_name).cloned();
            let meta = match meta {
                Some(m) => m,
                None => {
                    // 惰性补登记
                    let m = ManagedMeta {
                        id: uuid::Uuid::new_v4().to_string(),
                        source: "local".to_string(),
                        added_at: mtime_string(&path),
                    };
                    idx.entries.insert(file_name.clone(), m.clone());
                    dirty = true;
                    m
                }
            };

            known.insert(canon_key(&path), ());
            entries.push(StationEntry {
                id: meta.id,
                name: strip_timestamp_prefix(&file_name),
                path: path.to_string_lossy().to_string(),
                size,
                extension: ext.clone(),
                modified_at: mtime_string(&path),
                added_at: meta.added_at,
                ownership: OWNERSHIP_MANAGED.to_string(),
                source: meta.source,
                status: STATUS_OK.to_string(),
                is_readable: is_readable_ext(&ext),
                download_id: None,
            });
        }
    }

    // 索引里指向已消失文件的条目：清掉，避免越积越多。
    // （managed 的文件被外部删掉，中转站确实没东西可展示了）
    let before = idx.entries.len();
    let alive: Vec<String> = entries
        .iter()
        .map(|e| {
            Path::new(&e.path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default()
        })
        .collect();
    idx.entries.retain(|k, _| alive.contains(k));
    if idx.entries.len() != before {
        dirty = true;
    }

    // referenced：下载任务。文件已经托管在 dropzone 里的跳过，否则同一个文件出现两次。
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
pub fn resolve(app_data: &Path, downloads: &[DownloadRef], id: &str) -> Result<StationEntry, String> {
    // 只在 dropzone 里找 managed，避免把整份索引当可信路径直接读
    let dir = dropzone_dir(app_data);
    let idx = read_index(app_data);
    if let Some((file_name, meta)) = idx.entries.iter().find(|(_, m)| m.id == id) {
        let path = dir.join(file_name);
        if path.is_file() {
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            return Ok(StationEntry {
                id: meta.id.clone(),
                name: strip_timestamp_prefix(file_name),
                path: path.to_string_lossy().to_string(),
                size: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
                extension: ext.clone(),
                modified_at: mtime_string(&path),
                added_at: meta.added_at.clone(),
                ownership: OWNERSHIP_MANAGED.to_string(),
                source: meta.source.clone(),
                status: STATUS_OK.to_string(),
                is_readable: is_readable_ext(&ext),
                download_id: None,
            });
        }
        return Err(format!("文件已不在中转站里: {file_name}"));
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
            drop_index_entry(app_data, &entry.path);
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
    drop_index_entry(app_data, &entry.path);
    Ok(())
}

fn drop_index_entry(app_data: &Path, path: &str) {
    let Some(file_name) = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
    else {
        return;
    };
    let mut idx = read_index(app_data);
    if idx.entries.remove(&file_name).is_some() {
        if let Err(e) = write_index(app_data, &idx) {
            eprintln!("[中转站] 移除索引条目后写回失败: {e}");
        }
    }
}

// ================= 改名 / 移动 =================

/// 改名或移动。返回新路径。
///
/// 顺序是**先动磁盘、后改库**：中间失败最多是索引/任务记录还指向旧路径（下次刷新
/// 会变成 `missing`，用户能看见）；反过来先改库再动盘，失败后记录说在新地方、
/// 文件还在老地方，续传会往另一个文件里写。
pub fn relocate(
    app_data: &Path,
    entry: &StationEntry,
    new_path: &Path,
) -> Result<String, String> {
    let src = Path::new(&entry.path);
    if !src.is_file() {
        return Err("源文件不存在，无法改名/移动".to_string());
    }
    if new_path.exists() && new_path != src {
        return Err(format!("目标已存在: {}", new_path.display()));
    }
    if let Some(parent) = new_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建目标目录失败 {}: {e}", parent.display()))?;
    }

    // 同卷 rename 是原子的、零拷贝；跨卷会失败，回退到 copy + 删源。
    // 跨卷搬大文件是分钟级的，所以调用方必须把它当长任务处理（前端有进度提示）。
    let moved = match std::fs::rename(src, new_path) {
        Ok(_) => true,
        Err(_) => {
            std::fs::copy(src, new_path).map_err(|e| format!("复制到目标位置失败: {e}"))?;
            std::fs::remove_file(src).map_err(|e| {
                format!(
                    "已复制到 {} 但删除源文件失败（{e}），现在有两个副本",
                    new_path.display()
                )
            })?;
            true
        }
    };
    if !moved {
        return Err("移动失败".to_string());
    }

    let new_name = new_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "目标路径没有文件名".to_string())?;
    let new_path_str = new_path.to_string_lossy().to_string();

    if entry.is_managed() {
        // 索引的 key 是 dropzone 内的文件名，改名就必须换 key
        let dropzone = dropzone_dir(app_data);
        let old_name = src
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let mut idx = read_index(app_data);
        let meta = idx.entries.remove(&old_name);
        // 移出 dropzone 之后它就不再是托管的了，索引里不该再留；
        // 若还在 dropzone 内（纯改名），换个 key 继续登记。
        if new_path.parent().map(|p| canon_key(p)) == Some(canon_key(&dropzone)) {
            if let Some(m) = meta {
                idx.entries.insert(new_name.clone(), m);
            }
        }
        write_index(app_data, &idx)?;
    }
    Ok(new_path_str)
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
    }

    #[test]
    fn strip_prefix_only_for_numeric_timestamp() {
        assert_eq!(strip_timestamp_prefix("1700000000000_a_b.txt"), "a_b.txt");
        assert_eq!(strip_timestamp_prefix("2024_report.pdf"), "2024_report.pdf");
        assert_eq!(strip_timestamp_prefix("plain.txt"), "plain.txt");
    }
}
