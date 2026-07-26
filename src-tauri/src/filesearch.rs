//! 内置「Everything 风格」文件搜索：启动后在后台扫描用户常用媒体库（桌面/文档/下载/图片/音乐/视频），
//! 建 SQLite 索引，提供即时 `LIKE` 搜索；并用 notify 监听变更做防抖增量重建。
//! 复用项目既有依赖：rusqlite(bundled) / walkdir / notify，不引入新重型依赖，保持轻量。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use chrono::Local;
use rusqlite::{params, Connection};
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

use notify::Watcher;

#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct SearchResult {
    pub path: String,
    pub name: String,
    pub size: i64,
    pub modified: i64,
    pub is_dir: bool,
}

#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct IndexState {
    pub indexing: bool,
    pub count: u64,
    pub last_indexed: Option<String>,
}

static STATE: Mutex<IndexState> = Mutex::new(IndexState {
    indexing: false,
    count: 0,
    last_indexed: None,
});
static DB_PATH: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

fn db_path() -> PathBuf {
    DB_PATH
        .get()
        .cloned()
        .unwrap_or_else(|| std::env::temp_dir().join("andeyunhui_filesearch.db"))
}

fn connect() -> rusqlite::Result<Connection> {
    let p = db_path();
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(&p)?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            name_lower TEXT NOT NULL,
            path_lower TEXT NOT NULL,
            is_dir INTEGER NOT NULL,
            size INTEGER NOT NULL,
            modified INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_name_lower ON files(name_lower);
         CREATE INDEX IF NOT EXISTS idx_path_lower ON files(path_lower);",
    )?;
    Ok(conn)
}

/// 扫描根目录：仅用户常用媒体库（轻量，不扫全盘/系统盘），避免启动过慢与过度膨胀。
fn scan_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(home) = std::env::var("USERPROFILE") {
        for name in [
            "Desktop",
            "Documents",
            "Downloads",
            "Pictures",
            "Music",
            "Videos",
        ] {
            let p = Path::new(&home).join(name);
            if p.is_dir() {
                roots.push(p);
            }
        }
    }
    roots
}

/// 跳过明显无检索价值或超大/系统目录（与整机媒体监视互不干扰）。
fn should_skip_dir(name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    matches!(
        name,
        "node_modules"
            | "target"
            | ".git"
            | "vendor"
            | ".cache"
            | ".npm"
            | ".cargo"
            | "AppData"
            | "Application Data"
            | "Local Settings"
            | "Cookies"
            | "Recent"
            | "SendTo"
            | "Templates"
            | "Links"
            | "Favorites"
            | "Searches"
            | "OneDrive"
            | "$RECYCLE.BIN"
            | "System Volume Information"
            | "Windows"
            | "Program Files"
            | "Program Files (x86)"
            | "ProgramData"
    )
}

fn modified_ts(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 重建索引（阻塞，应在后台线程调用）。
fn build_index() {
    let roots = scan_roots();
    if roots.is_empty() {
        return;
    }
    let conn = match connect() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[FILESEARCH] 建库失败: {e}");
            return;
        }
    };
    if let Err(e) = conn.execute("DELETE FROM files", []) {
        log::warn!("[FILESEARCH] 清空旧索引失败: {e}");
    }
    if conn.execute("BEGIN IMMEDIATE", []).is_err() {
        return;
    }
    let mut insert = match conn.prepare(
        "INSERT OR REPLACE INTO files (path, name, name_lower, path_lower, is_dir, size, modified)
         VALUES (?1,?2,?3,?4,?5,?6,?7)",
    ) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[FILESEARCH] 预备语句失败: {e}");
            let _ = conn.execute("ROLLBACK", []);
            return;
        }
    };
    let mut count: u64 = 0;
    for root in &roots {
        for entry in WalkDir::new(root).into_iter().filter_entry(|e| {
            if e.depth() > 0 && e.file_type().is_dir() {
                if let Some(n) = e.file_name().to_str() {
                    if should_skip_dir(n) {
                        return false;
                    }
                }
            }
            true
        }) {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let is_dir = meta.is_dir();
            let name = entry.file_name().to_string_lossy().to_string();
            let p = entry.path().to_string_lossy().to_string();
            let size = if is_dir { 0i64 } else { meta.len() as i64 };
            let modified = modified_ts(&meta);
            if insert
                .execute(params![
                    p,
                    name,
                    name.to_lowercase(),
                    p.to_lowercase(),
                    if is_dir { 1i64 } else { 0i64 },
                    size,
                    modified
                ])
                .is_ok()
            {
                count += 1;
            }
            if count % 5000 == 0 {
                let mut st = STATE.lock().unwrap();
                st.count = count;
            }
        }
    }
    drop(insert);
    let _ = conn.execute("COMMIT", []);
    let mut st = STATE.lock().unwrap();
    st.count = count;
    st.indexing = false;
    st.last_indexed = Some(Local::now().format("%Y-%m-%d %H:%M").to_string());
    log::info!("[FILESEARCH] 索引完成，共 {count} 项");
}

/// 启动索引：设置库路径、后台建库、并启动变更监视（防抖增量重建）。
pub fn start_indexing(app: &AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = DB_PATH.set(dir.join("filesearch.db"));
    }
    {
        let mut st = STATE.lock().unwrap();
        if st.indexing {
            return;
        }
        st.indexing = true;
    }
    std::thread::spawn(|| {
        // 延迟 2s，避免与启动其余初始化争抢 IO
        std::thread::sleep(std::time::Duration::from_secs(2));
        build_index();
    });
    start_watcher();
}

/// 用 notify 监听根目录变更，空闲 20s 后防抖重建索引（维持「Everything 风格」的实时性）。
fn start_watcher() {
    let roots = scan_roots();
    if roots.is_empty() {
        return;
    }
    let debounce: std::sync::Arc<Mutex<Option<std::time::Instant>>> =
        std::sync::Arc::new(Mutex::new(None));
    let cb = debounce.clone();
    let mut watcher = match notify::recommended_watcher(move |_ev: notify::Result<notify::Event>| {
        if let Ok(mut g) = cb.lock() {
            *g = Some(std::time::Instant::now());
        }
    }) {
        Ok(w) => w,
        Err(e) => {
            log::warn!("[FILESEARCH] 变更监视创建失败: {e}");
            return;
        }
    };
    for r in &roots {
        let _ = watcher.watch(r, notify::RecursiveMode::Recursive);
    }
    // 故意泄漏 watcher，使其存活至进程结束（等价于全局后台监听）
    std::mem::forget(watcher);
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(5));
        let due = {
            let g = debounce.lock().unwrap();
            matches!(*g, Some(t) if t.elapsed() >= std::time::Duration::from_secs(20))
        };
        if due {
            {
                let mut g = debounce.lock().unwrap();
                *g = None;
            }
            {
                let mut st = STATE.lock().unwrap();
                if st.indexing {
                    continue;
                }
                st.indexing = true;
            }
            build_index();
        }
    });
}

#[tauri::command]
pub fn fs_search(query: String, limit: Option<usize>) -> Vec<SearchResult> {
    let q = query.trim();
    if q.is_empty() {
        return Vec::new();
    }
    let conn = match connect() {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let ql = q.to_lowercase();
    let limit = limit.unwrap_or(50).min(200) as i64;
    // 名称前缀优先，其次路径/名称包含；目录优先、再按体积排序，贴近 Everything 的直觉。
    let sql = "
        SELECT path, name, is_dir, size, modified FROM files
        WHERE name_lower LIKE ?1 OR path_lower LIKE ?2
        ORDER BY
          CASE WHEN name_lower LIKE ?3 THEN 0 ELSE 1 END,
          (LENGTH(name) - LENGTH(?4)) ASC,
          is_dir DESC,
          size DESC
        LIMIT ?5";
    let contain = format!("%{ql}%");
    let prefix = format!("{ql}%");
    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(params![contain, contain, prefix, ql, limit], |row| {
        Ok(SearchResult {
            path: row.get(0)?,
            name: row.get(1)?,
            is_dir: row.get(2)?,
            size: row.get(3)?,
            modified: row.get(4)?,
        })
    });
    match rows {
        Ok(r) => r.filter_map(|x| x.ok()).collect(),
        Err(_) => Vec::new(),
    }
}

#[tauri::command]
pub fn fs_index_status() -> IndexState {
    STATE.lock().unwrap().clone()
}

#[tauri::command]
pub fn fs_index_build() {
    {
        let mut st = STATE.lock().unwrap();
        if st.indexing {
            return;
        }
        st.indexing = true;
    }
    std::thread::spawn(build_index);
}

/// 在资源管理器/文件管理器中打开（文件则高亮定位，目录则打开）。跨平台尽力而为。
#[tauri::command]
pub fn fs_open_path(path: String) {
    #[cfg(windows)]
    {
        let p = path.replace('/', "\\");
        if Path::new(&p).is_dir() {
            let _ = std::process::Command::new("explorer").arg(&p).spawn();
        } else {
            let _ = std::process::Command::new("explorer")
                .arg(format!("/select,\"{p}\""))
                .spawn();
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&path).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(&path).spawn();
    }
}
