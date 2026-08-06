//! 内置「Everything 风格」文件搜索：启动后在后台扫描用户常用媒体库（桌面/文档/下载/图片/音乐/视频），
//! 建 SQLite 索引，提供即时 `LIKE` 搜索；并用 notify 监听变更做防抖增量重建。
//! 复用项目既有依赖：rusqlite(bundled) / walkdir / notify，不引入新重型依赖，保持轻量。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::UNIX_EPOCH;

use chrono::Local;
use rusqlite::{params, Connection};
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

use notify::Watcher;

#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
};
#[cfg(windows)]
use windows::Win32::System::IO::DeviceIoControl;
#[cfg(windows)]
use windows::Win32::System::Ioctl::{FSCTL_QUERY_USN_JOURNAL, FSCTL_READ_USN_JOURNAL};
#[cfg(windows)]
use windows::core::PCWSTR;
use core::ffi::c_void;

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

/// 索引进度事件载荷：count=已扫描文件数，done=是否完成。
#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct IndexProgress {
    pub count: u64,
    pub done: bool,
}

static STATE: Mutex<IndexState> = Mutex::new(IndexState {
    indexing: false,
    count: 0,
    last_indexed: None,
});
static DB_PATH: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// 全局保存 AppHandle，供后台索引线程向前端推送进度事件（"扫描多少展示多少"）。
static APP_HANDLE: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

/// 目录 FileReferenceNumber → 完整路径 的缓存，供 NTFS USN Journal 增量把「父 FRN」解析回完整路径。
/// 全量 build_index 时填充（仅目录，开销远低于文件），USN 增量时按 FRN 反查父目录路径。
static DIR_FRN: LazyLock<Mutex<HashMap<u64, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// 各数据盘在「应用启动时刻」的 USN 检查点（NextUsn）。USN 增量线程从该点开始重放，
/// 以覆盖「全量索引进行期间」发生的变更（全量索引本身已含当时状态，重放为幂等 upsert/delete）。
static USN_START: LazyLock<Mutex<HashMap<String, i64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

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
         CREATE INDEX IF NOT EXISTS idx_path_lower ON files(path_lower);
         CREATE TABLE IF NOT EXISTS trigrams (
            gram TEXT NOT NULL,
            path TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_trigram ON trigrams(gram);",
    )?;
    Ok(conn)
}

/// 枚举本机所有「本地盘符」（固定盘 + 可移动盘），排除网络盘/光驱/无盘符，
/// 避免对非本地或可阻塞的盘做全盘 walk 导致卡死。仅 Windows 有原生实现。
#[cfg(windows)]
fn list_drives() -> Vec<PathBuf> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    let mask = unsafe { GetLogicalDrives() };
    let mut drives = Vec::new();
    for i in 0..26u32 {
        if mask & (1u32 << i) == 0 {
            continue;
        }
        let letter = (b'A' + i as u8) as char;
        let path = format!("{}:\\", letter);
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let ty = unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) };
        // DRIVE 类型编码：固定盘=3、可移动盘=2；跳过网络盘(4)/光驱(5)等易卡顿盘符
        if ty == 3 || ty == 2 {
            drives.push(PathBuf::from(path));
        }
    }
    drives
}

#[cfg(not(windows))]
fn list_drives() -> Vec<PathBuf> {
    // macOS/Linux：返回根目录（全盘索引）；如需更细可遍历 /Volumes、/mnt、/media
    vec![PathBuf::from("/")]
}

/// 扫描根目录：C 盘用户媒体库（桌面/文档/下载/图片/音乐/视频）+ 所有非系统本地盘的根目录。
/// 这样 Everything 风格搜索即可覆盖 D:/E: 等其他盘，而不是只索引 C 盘。
/// 注意：系统盘（C:）只索引用户媒体库、不扫系统盘根，以免扫入 Windows/Program Files 等巨型目录。
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
    // 枚举所有本地盘符，把非系统盘根纳入索引，使搜索覆盖其他盘（D:/E: 等）。
    // 系统盘根（C:\）刻意不加入，避免全盘扫入系统目录；其用户媒体库已由上面加入。
    let system_drive = std::env::var("SystemDrive")
        .unwrap_or_else(|_| "C:".to_string())
        .to_uppercase();
    for d in list_drives() {
        let ds = d.to_string_lossy().to_uppercase();
        let is_system = ds.starts_with(&system_drive) || ds.starts_with("C:");
        if !is_system && d.is_dir() {
            roots.push(d);
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

/// 上报索引进度：写入 STATE.count 并通过事件推给前端（实现"扫描多少展示多少"）。
fn emit_progress(count: u64, done: bool) {
    {
        let mut st = STATE.lock().unwrap();
        st.count = count;
    }
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit("fs-index-progress", IndexProgress { count, done });
    }
}

/// 重建索引（阻塞，应在后台线程调用）。
/// 采用「分段提交」：每 BATCH 条 COMMIT+BEGIN，使已落盘数据在索引期间即可被并发搜索命中；
/// 索引线程降优先级 + 每段轻微限速，平滑 IO、避免拖垮整机（"不崩溃 / 抗压力"）。
fn build_index() {
    let roots = scan_roots();
    if roots.is_empty() {
        return;
    }
    // 全量重建即清空目录 FRN 缓存，稍后按当前目录树重新填充
    DIR_FRN.lock().unwrap().clear();
    // 索引线程降优先级，避免拖垮整机 IO 与交互响应
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Threading::{
            GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
        };
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
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
    // 全量重建同步清空三元组索引，稍后逐条重建
    let _ = conn.execute("DELETE FROM trigrams", []);
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
    let mut since_commit: u64 = 0;
    const BATCH: u64 = 2000;
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
            // 仅目录登记 FRN（文件级不登记，数量少得多），供 USN 增量反查父路径
            #[cfg(windows)]
            if is_dir {
                if let Some(frn) = dir_reference(&p) {
                    DIR_FRN.lock().unwrap().insert(frn, p.clone());
                }
            }
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
                // 维护三元组子串索引（name 与 path 都索引，支持文件名/路径片段搜索）
                db_insert_trigrams(&conn, &p, &name.to_lowercase(), &p.to_lowercase());
            }
            since_commit += 1;
            if since_commit >= BATCH {
                if conn.execute("COMMIT", []).is_err() {
                    break;
                }
                if conn.execute("BEGIN IMMEDIATE", []).is_err() {
                    break;
                }
                since_commit = 0;
                // 分段提交后已落盘部分可立即被搜索命中；上报进度 + 轻微限速平滑 IO
                emit_progress(count, false);
                #[cfg(windows)]
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
        }
    }
    let _ = conn.execute("COMMIT", []);
    drop(insert);
    emit_progress(count, true);
    let mut st = STATE.lock().unwrap();
    st.count = count;
    st.indexing = false;
    st.last_indexed = Some(Local::now().format("%Y-%m-%d %H:%M").to_string());
    log::info!("[FILESEARCH] 索引完成，共 {count} 项");
}

/// 启动索引：设置库路径、后台建库、并启动变更监视（防抖增量重建）。
pub fn start_indexing(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
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
    // 记录各数据盘启动时刻的 USN 检查点（NTFS），供 USN 增量线程从该点重放
    capture_usn_start();
    std::thread::spawn(|| {
        // 延迟 2s，避免与启动其余初始化争抢 IO
        std::thread::sleep(std::time::Duration::from_secs(2));
        build_index();
    });
    start_watcher();
    start_usn_sync();
}

/// 仅监视 C 盘用户媒体库的变更（实时性），不递归 watch 其他盘根，避免整盘监听的句柄/性能问题。
/// 其他盘仍会被一次性索引、可被搜索到，只是其变更不会实时重建索引（可手动触发 fs_index_build）。
fn watch_roots() -> Vec<PathBuf> {
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

/// 判断路径是否落在被监视的 C 盘用户媒体库（及其子目录）内。
/// 用途：跨盘移动（to 路径在其他盘）时，只处理监视范围内的路径，避免把监视外文件误写入索引。
fn is_under_watch(p: &Path) -> bool {
    let s = p.to_string_lossy().to_lowercase();
    watch_roots().iter().any(|r| {
        let rs = r.to_string_lossy().to_lowercase();
        s == rs || s.starts_with(&format!("{}\\", rs))
    })
}

/// 把单条路径 upsert 进索引（存在即覆盖 create/modify/rename-to）；读不到元数据则跳过。
fn db_upsert(conn: &Connection, p: &Path) -> bool {
    let path = p.to_string_lossy().to_string();
    let meta = match std::fs::symlink_metadata(p) {
        Ok(m) => m,
        Err(_) => return false,
    };
    let is_dir = meta.is_dir();
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let size = if is_dir { 0i64 } else { meta.len() as i64 };
    let modified = modified_ts(&meta);
    let nl = name.to_lowercase();
    let pl = path.to_lowercase();
    let ok = conn
        .execute(
            "INSERT OR REPLACE INTO files (path, name, name_lower, path_lower, is_dir, size, modified) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![path, name, nl, pl, if is_dir { 1i64 } else { 0i64 }, size, modified],
        )
        .is_ok();
    if ok {
        // 同步维护三元组子串索引（先清旧再写新，覆盖 rename/modify）
        db_delete_trigrams(conn, &path);
        db_insert_trigrams(conn, &path, &nl, &pl);
    }
    ok
}

/// 删除单条路径及其子项（目录递归删除）：精确匹配该路径 + `prefix\%` 前缀匹配其所有子孙，
/// 避免误删同名前缀的其他目录（如 `C:\a\dir` 不会误删 `C:\a\dirXYZ`）。
fn db_delete(conn: &Connection, p: &Path) -> bool {
    let path = p.to_string_lossy().to_string();
    let like_prefix = format!("{}\\%", path);
    let ok = conn
        .execute(
            "DELETE FROM files WHERE path = ?1 OR path LIKE ?2",
            params![path, like_prefix],
        )
        .is_ok();
    db_delete_trigrams(conn, &path);
    ok
}

/// 增量应用一批变更：仅对「监视范围内」的路径，存在的 upsert、不存在的 delete，整批一个事务提交。
/// 这是把「变动→全量重扫」替换为「只扫增删」的核心，C 盘媒体库保持秒级实时且不再整盘重扫。
fn apply_changes(batch: &[PathBuf]) {
    let conn = match connect() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[FILESEARCH] 增量应用连接失败: {e}");
            return;
        }
    };
    if conn.execute("BEGIN IMMEDIATE", []).is_err() {
        return;
    }
    for p in batch {
        if !is_under_watch(p) {
            continue;
        }
        if p.exists() {
            db_upsert(&conn, p);
        } else {
            db_delete(&conn, p);
        }
    }
    let _ = conn.execute("COMMIT", []);
    // 同步索引计数并即时推送进度
    if let Ok(n) = conn.query_row("SELECT COUNT(*) FROM files", [], |r| r.get::<_, i64>(0)) {
        emit_progress(n.max(0) as u64, false);
    }
}

/// 用 notify 监听 C 盘用户媒体库变更，空闲 3s 防抖后把变更「增量 apply」进索引
/// （单条 INSERT/DELETE/UPDATE，rename/to 在监视外的仅删不增），不再触发全量重扫。
fn start_watcher() {
    let roots = watch_roots();
    if roots.is_empty() {
        return;
    }
    let queue: Arc<Mutex<Vec<PathBuf>>> = Arc::new(Mutex::new(Vec::new()));
    let last_event = Arc::new(Mutex::new(std::time::Instant::now()));
    let q = queue.clone();
    let le = last_event.clone();
    let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            {
                let mut g = q.lock().unwrap();
                for p in ev.paths {
                    g.push(p);
                }
            }
            *le.lock().unwrap() = std::time::Instant::now();
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
    std::thread::spawn(move || {
        // 增量应用线程降优先级，避免拖垮整机 IO
        #[cfg(windows)]
        unsafe {
            use windows::Win32::System::Threading::{
                GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
            };
            let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
        }
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let idle = {
                let d = last_event.lock().unwrap();
                d.elapsed() >= std::time::Duration::from_secs(3)
            };
            if !idle {
                continue;
            }
            let batch: Vec<PathBuf> = {
                let mut g = queue.lock().unwrap();
                if g.is_empty() {
                    Vec::new()
                } else {
                    std::mem::take(&mut *g)
                }
            };
            if batch.is_empty() {
                continue;
            }
            {
                let st = STATE.lock().unwrap();
                if st.indexing {
                    continue; // 全量构建中，丢弃本次增量（全量将覆盖），下次变更再触发
                }
            }
            apply_changes(&batch);
        }
    });
}

/// 生成字符串的 3-字（char）三元组，用于子串索引。长度 <3 时整体作为单个 token。
fn char_trigrams(s: &str) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() < 3 {
        return if s.is_empty() {
            Vec::new()
        } else {
            vec![s.to_string()]
        };
    }
    chars
        .windows(3)
        .map(|w| w.iter().collect::<String>())
        .collect()
}

/// 写入某路径的三元组（同时索引 name 与 path，使「按文件名」与「按路径片段」都能走索引）。
fn db_insert_trigrams(conn: &Connection, path: &str, name_lower: &str, path_lower: &str) {
    let mut stmt = match conn.prepare("INSERT INTO trigrams (gram, path) VALUES (?1,?2)") {
        Ok(s) => s,
        Err(_) => return,
    };
    for g in char_trigrams(name_lower)
        .into_iter()
        .chain(char_trigrams(path_lower))
    {
        let _ = stmt.execute(params![g, path]);
    }
}

/// 删除某路径（及其子孙）对应的三元组。
fn db_delete_trigrams(conn: &Connection, path: &str) {
    let like_prefix = format!("{}\\%", path);
    let _ = conn.execute(
        "DELETE FROM trigrams WHERE path = ?1 OR path LIKE ?2",
        params![path, like_prefix],
    );
}

/// 缓存的只读连接：搜索高频，避免每次 `connect()` 重开连接 + 重建 PRAGMA/表。
static SEARCH_CONN: std::sync::OnceLock<Mutex<Connection>> = std::sync::OnceLock::new();
fn search_conn() -> Option<std::sync::MutexGuard<'static, Connection>> {
    if SEARCH_CONN.get().is_none() {
        if let Ok(c) = connect() {
            let _ = SEARCH_CONN.set(Mutex::new(c));
        }
    }
    SEARCH_CONN.get().and_then(|m| m.lock().ok())
}

/// 用三元组索引把「子串匹配」从全表扫描降为「按 gram 取候选 → 内存交集 → 精确 contains 校验」，
/// 候选集通常很小，配合 `idx_trigram` 索引，查询速度与索引规模解耦。
fn search_candidates(conn: &Connection, ql: &str) -> std::collections::HashSet<String> {
    let grams = char_trigrams(ql);
    if grams.is_empty() {
        return std::collections::HashSet::new();
    }
    let mut sets: Vec<std::collections::HashSet<String>> = Vec::with_capacity(grams.len());
    for g in &grams {
        let mut s = std::collections::HashSet::new();
        if let Ok(mut stmt) = conn.prepare("SELECT path FROM trigrams WHERE gram = ?1") {
            if let Ok(rows) = stmt.query_map(params![g], |r| r.get::<_, String>(0)) {
                for p in rows.flatten() {
                    s.insert(p);
                }
            }
        }
        sets.push(s);
    }
    let mut it = sets.into_iter();
    let mut acc = it.next().unwrap_or_default();
    for s in it {
        acc.retain(|p| s.contains(p));
    }
    acc
}

#[tauri::command]
pub fn fs_search(query: String, limit: Option<usize>) -> Vec<SearchResult> {
    let q = query.trim();
    if q.is_empty() {
        return Vec::new();
    }
    let ql = q.to_lowercase();
    let limit_i = limit.unwrap_or(50).min(200) as usize;
    let guard = match search_conn() {
        Some(g) => g,
        None => return Vec::new(),
    };
    let conn: &Connection = &guard;

    // 短查询（<3 字）无法用三元组，回退到包含匹配全表扫描（极少触发）。
    if ql.chars().count() < 3 {
        return run_search_sql(conn, &ql, &format!("%{ql}%"), limit_i as i64);
    }

    let candidates = search_candidates(conn, &ql);
    if candidates.is_empty() {
        return Vec::new();
    }
    let ph = vec!["?"; candidates.len()].join(",");
    let sql = format!(
        "SELECT path, name, is_dir, size, modified FROM files WHERE path IN ({ph})"
    );
    let params: Vec<String> = candidates.into_iter().collect();
    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = match stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
        Ok(SearchResult {
            path: row.get(0)?,
            name: row.get(1)?,
            is_dir: row.get(2)?,
            size: row.get(3)?,
            modified: row.get(4)?,
        })
    }) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<SearchResult> = rows.filter_map(|x| x.ok()).collect();
    // 内存中精确校验子串 + 排序（前缀命中优先、短名优先、目录优先、大文件优先）。
    out.retain(|r| {
        r.name.to_lowercase().contains(&ql) || r.path.to_lowercase().contains(&ql)
    });
    out.sort_by(|a, b| {
        let ap = a.name.to_lowercase().starts_with(&ql);
        let bp = b.name.to_lowercase().starts_with(&ql);
        bp.cmp(&ap)
            .then_with(|| {
                (a.name.chars().count() as i64 - ql.chars().count() as i64)
                    .cmp(&(b.name.chars().count() as i64 - ql.chars().count() as i64))
            })
            .then_with(|| b.is_dir.cmp(&a.is_dir))
            .then_with(|| b.size.cmp(&a.size))
    });
    out.truncate(limit_i);
    out
}

/// 执行一次「包含匹配」全表扫描（仅用于 <3 字的短查询兜底）。
fn run_search_sql(conn: &Connection, ql: &str, pat: &str, limit: i64) -> Vec<SearchResult> {
    let sql = "
        SELECT path, name, is_dir, size, modified FROM files
        WHERE name_lower LIKE ?1 OR path_lower LIKE ?1
        ORDER BY
          CASE WHEN name_lower LIKE ?2 THEN 0 ELSE 1 END,
          (LENGTH(name) - LENGTH(?3)) ASC,
          is_dir DESC,
          size DESC
        LIMIT ?4";
    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(params![pat, pat, ql, limit], |row| {
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

// ===================== NTFS USN Journal 增量同步（阶段3：真·全盘秒级增量） =====================
// 思路：NTFS 维护一个「变更日志」(USN Journal)。我们只在应用启动时刻记录各盘 NextUsn 检查点，
// 之后后台线程周期性读取「自检查点以来所有增删改名」，单条 apply 进 SQLite，做到不遍历、不丢事件、
// 不占句柄（相比递归 notify watch 整盘）。仅 NTFS 生效；非 NTFS / 无日志的盘降级为定时全量重建兜底。

#[cfg(windows)]
fn dir_reference(path: &str) -> Option<u64> {
    use windows::Win32::Storage::FileSystem::{
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        OPEN_EXISTING,
    };
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let h = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )
    }
    .ok()?;
    if h.is_invalid() {
        return None;
    }
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    let ok = unsafe { GetFileInformationByHandle(h, &mut info).is_ok() };
    unsafe {
        let _ = CloseHandle(h);
    }
    if !ok {
        return None;
    }
    Some(((info.nFileIndexHigh as u64) << 32) | (info.nFileIndexLow as u64))
}

/// 非系统盘的盘符列表（D:/E: …），不含 C:。
#[cfg(windows)]
fn data_drive_letters() -> Vec<String> {
    let system = std::env::var("SystemDrive")
        .unwrap_or_else(|_| "C:".into())
        .to_uppercase();
    list_drives()
        .into_iter()
        .filter_map(|d| {
            let s = d.to_string_lossy().to_uppercase();
            let letter = s.chars().next().unwrap_or('?');
            let is_system = s.starts_with(&system) || s.starts_with("C:\\");
            if is_system {
                None
            } else {
                Some(letter.to_string())
            }
        })
        .collect()
}

#[cfg(windows)]
fn is_ntfs(letter: &str) -> bool {
    use windows::Win32::Storage::FileSystem::GetVolumeInformationW;
    let vol = format!("{}:\\", letter);
    let wide: Vec<u16> = vol.encode_utf16().chain(std::iter::once(0)).collect();
    let mut fs = [0u16; 32];
    let res = unsafe {
        GetVolumeInformationW(
            PCWSTR(wide.as_ptr()),
            None,
            None,
            None,
            None,
            Some(&mut fs),
        )
    };
    if res.is_err() {
        return false;
    }
    let name = String::from_utf16_lossy(&fs[..]).trim_end_matches('\0').to_string();
    name.eq_ignore_ascii_case("NTFS")
}

#[cfg(windows)]
fn open_volume(letter: &str) -> Option<HANDLE> {
    use windows::Win32::Storage::FileSystem::{FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
    let vol = format!("\\\\.\\{}:", letter);
    let wide: Vec<u16> = vol.encode_utf16().chain(std::iter::once(0)).collect();
    let h = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            None,
        )
    }
    .ok()?;
    if h.is_invalid() {
        None
    } else {
        Some(h)
    }
}

#[cfg(windows)]
fn query_journal(h: HANDLE) -> Option<(u64, i64)> {
    use windows::Win32::System::Ioctl::USN_JOURNAL_DATA_V0;
    let mut data = USN_JOURNAL_DATA_V0::default();
    let mut ret = 0u32;
    let res = unsafe {
        DeviceIoControl(
            h,
            FSCTL_QUERY_USN_JOURNAL,
            None,
            0,
            Some(&mut data as *mut _ as *mut c_void),
            size_of::<USN_JOURNAL_DATA_V0>() as u32,
            Some(&mut ret as *mut u32),
            None,
        )
    };
    if res.is_ok() {
        Some((data.UsnJournalID, data.NextUsn))
    } else {
        None
    }
}

#[cfg(windows)]
fn read_usn_range(h: HANDLE, journal_id: u64, start_usn: i64, out: &mut [u8]) -> Option<i64> {
    use windows::Win32::System::Ioctl::READ_USN_JOURNAL_DATA_V0;
    let r = READ_USN_JOURNAL_DATA_V0 {
        StartUsn: start_usn,
        ReasonMask: 0xFFFF_FFFF,
        ReturnOnlyOnClose: Default::default(),
        Timeout: 0,
        BytesToWaitFor: 0,
        UsnJournalID: journal_id,
    };
    let mut ret = 0u32;
    let res = unsafe {
        DeviceIoControl(
            h,
            FSCTL_READ_USN_JOURNAL,
            Some(&r as *const _ as *const c_void),
            size_of::<READ_USN_JOURNAL_DATA_V0>() as u32,
            Some(out.as_mut_ptr() as *mut c_void),
            out.len() as u32,
            Some(&mut ret as *mut u32),
            None,
        )
    };
    if res.is_ok() {
        Some(rd_i64(out, 0))
    } else {
        None
    }
}

fn rd_u32(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
fn rd_u64(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}
fn rd_i64(b: &[u8], o: usize) -> i64 {
    rd_u64(b, o) as i64
}
fn rd_u16(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}

/// 从 USN 记录的 UTF-16 文件名段取出文件名。
fn read_usn_name(b: &[u8], name_off: usize, name_len: usize) -> String {
    let mut s = String::new();
    let mut i = 0;
    while i + 1 < name_len && name_off + i + 1 < b.len() {
        let w = u16::from_le_bytes([b[name_off + i], b[name_off + i + 1]]);
        if w == 0 {
            break;
        }
        s.push(char::from_u32(w as u32).unwrap_or('\u{fffd}'));
        i += 2;
    }
    s
}

/// 解析 USN 返回缓冲区：前 8 字节是「下次起始 Usn」，其后是一串 USN_RECORD_V2，以 Usn=-1 结束。
/// 返回 (父目录FRN, 自身FRN, 文件名, Reason)。
fn parse_usn(buf: &[u8]) -> Vec<(u64, u64, String, u32)> {
    let mut out = Vec::new();
    let mut p = 8;
    while p + 60 <= buf.len() {
        let rec_len = rd_u32(buf, p) as usize;
        if rec_len < 60 {
            break;
        }
        let major = rd_u16(buf, p + 4);
        if major != 2 {
            // 仅支持 V2 记录布局；V3/V4 跳过（不丢整体，全量重建兜底）
            p += rec_len;
            continue;
        }
        let usn = rd_i64(buf, p + 24);
        if usn == -1 {
            break; // USN_EOF
        }
        let frn = rd_u64(buf, p + 8);
        let parent = rd_u64(buf, p + 16);
        let reason = rd_u32(buf, p + 40);
        let name_len = rd_u16(buf, p + 56) as usize;
        let name_off = rd_u16(buf, p + 58) as usize;
        let name = read_usn_name(buf, p + name_off, name_len);
        out.push((parent, frn, name, reason));
        p += rec_len;
    }
    out
}

/// 按单条 USN 记录应用变更：存在则 upsert、删除/改名旧名则 delete，并维护 DIR_FRN 缓存。
fn apply_one(conn: &Connection, parent: u64, frn: u64, name: &str, reason: u32) {
    let parent_path = { DIR_FRN.lock().unwrap().get(&parent).cloned() };
    let Some(parent_path) = parent_path else {
        return;
    };
    let full = format!("{}\\{}", parent_path, name);
    let is_delete = reason & 0x0000_0200 != 0; // USN_REASON_FILE_DELETE
    let is_rename_old = reason & 0x0000_1000 != 0; // USN_REASON_RENAME_OLD_NAME（旧名/旧位置）
    if is_delete || is_rename_old {
        db_delete(conn, Path::new(&full));
        DIR_FRN.lock().unwrap().remove(&frn);
    } else {
        // 创建 / 改名新名 / 内容或属性变更 → upsert（含目录则刷新 FRN 缓存）
        if db_upsert(conn, Path::new(&full)) {
            if let Ok(m) = std::fs::symlink_metadata(&full) {
                if m.is_dir() {
                    DIR_FRN.lock().unwrap().insert(frn, full.clone());
                }
            }
        }
    }
}

fn apply_usn_records(records: &[(u64, u64, String, u32)]) {
    let conn = match connect() {
        Ok(c) => c,
        Err(_) => return,
    };
    if conn.execute("BEGIN IMMEDIATE", []).is_err() {
        return;
    }
    for (parent, frn, name, reason) in records {
        apply_one(&conn, *parent, *frn, name, *reason);
    }
    let _ = conn.execute("COMMIT", []);
    if let Ok(n) = conn.query_row("SELECT COUNT(*) FROM files", [], |r| r.get::<_, i64>(0)) {
        emit_progress(n.max(0) as u64, false);
    }
}

#[cfg(windows)]
fn usn_thread(letter: String) {
    use windows::Win32::System::Threading::{
        GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
    };
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    }
    let h = match open_volume(&letter) {
        Some(h) => h,
        None => {
            log::warn!("[FILESEARCH] USN: 无法打开卷 {letter}:");
            return;
        }
    };
    let (mut journal_id, mut next) = match query_journal(h) {
        Some(x) => x,
        None => {
            unsafe {
                let _ = CloseHandle(h);
            }
            log::warn!("[FILESEARCH] USN: 卷 {letter}: 无可用日志（非 NTFS 或需管理员权限）");
            return;
        }
    };
    // 从该盘「应用启动时刻」的检查点开始重放，覆盖全量索引期间的变更
    if let Some(s) = USN_START.lock().unwrap().get(&letter).copied() {
        next = s;
    }
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        std::thread::sleep(std::time::Duration::from_secs(15));
        {
            let st = STATE.lock().unwrap();
            if st.indexing {
                continue; // 全量构建中，跳过（构建完成后下一轮继续）
            }
        }
        // 重新查询，检测日志是否被重置（卷被 chkdsk / 手动清空）
        match query_journal(h) {
            Some((id, _n)) if id == journal_id => {}
            Some((id, n)) => {
                journal_id = id;
                next = n;
                continue; // 日志已重建，从新起点跟，不重放旧历史
            }
            None => {
                unsafe {
                    let _ = CloseHandle(h);
                }
                build_index(); // 日志不可用，退回全量重建
                return;
            }
        }
        let Some(new_next) = read_usn_range(h, journal_id, next, &mut buf) else {
            unsafe {
                let _ = CloseHandle(h);
            }
            build_index();
            return;
        };
        let records = parse_usn(&buf);
        if !records.is_empty() {
            apply_usn_records(&records);
        }
        next = new_next;
    }
}

/// 启动 USN 增量同步：NTFS 数据盘各起一个线程；非 NTFS / 无日志盘降级为定期全量重建兜底。
fn start_usn_sync() {
    #[cfg(windows)]
    {
        let mut ntfs = Vec::new();
        let mut non_ntfs = Vec::new();
        for letter in data_drive_letters() {
            if is_ntfs(&letter) {
                ntfs.push(letter);
            } else {
                non_ntfs.push(letter);
            }
        }
        for letter in ntfs {
            std::thread::spawn(move || usn_thread(letter));
        }
        if !non_ntfs.is_empty() {
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(1800)); // 30 分钟一次兜底全量
                {
                    let st = STATE.lock().unwrap();
                    if st.indexing {
                        continue;
                    }
                }
                build_index();
            });
        }
    }
}

/// 记录各 NTFS 数据盘启动时刻的 USN 检查点（NextUsn），供 USN 增量线程从该点重放。
fn capture_usn_start() {
    #[cfg(windows)]
    {
        for letter in data_drive_letters() {
            if !is_ntfs(&letter) {
                continue;
            }
            if let Some(h) = open_volume(&letter) {
                if let Some((_, next)) = query_journal(h) {
                    USN_START.lock().unwrap().insert(letter, next);
                }
                unsafe {
                    let _ = CloseHandle(h);
                }
            }
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- rd_u32 / rd_u64 / rd_u16 / rd_i64：LE 读取 ----------
    #[test]
    fn rd_le_normal_values() {
        let b = [0x78, 0x56, 0x34, 0x12, 0xef, 0xcd, 0xab, 0x90, 0x01, 0x00];
        assert_eq!(rd_u32(&b, 0), 0x1234_5678);
        assert_eq!(rd_u32(&b, 4), 0x90ab_cdef);
        assert_eq!(rd_u64(&b, 0), 0x90ab_cdef_1234_5678);
        assert_eq!(rd_u16(&b, 0), 0x5678);
        assert_eq!(rd_u16(&b, 8), 0x0001);
        assert_eq!(rd_i64(&b, 0), 0x90ab_cdef_1234_5678u64 as i64);
    }

    // 现状固化：越界读取会 panic（索引越界 / try_into().unwrap()），不返回 0
    #[test]
    #[should_panic]
    fn rd_u32_out_of_bounds_panics() {
        rd_u32(&[1, 2, 3], 0);
    }

    #[test]
    #[should_panic]
    fn rd_u64_out_of_bounds_panics() {
        rd_u64(&[1, 2, 3, 4, 5, 6, 7], 0);
    }

    #[test]
    #[should_panic]
    fn rd_u16_out_of_bounds_panics() {
        rd_u16(&[1], 0);
    }

    // ---------- read_usn_name：UTF-16 LE 解码，NUL 停止 ----------
    fn utf16le(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
    }

    #[test]
    fn read_usn_name_ascii() {
        let b = utf16le("report.txt");
        assert_eq!(read_usn_name(&b, 0, b.len()), "report.txt");
    }

    #[test]
    fn read_usn_name_chinese() {
        let b = utf16le("文件.txt");
        assert_eq!(read_usn_name(&b, 0, b.len()), "文件.txt");
    }

    #[test]
    fn read_usn_name_stops_at_nul() {
        let b = utf16le("ab\0cd");
        assert_eq!(read_usn_name(&b, 0, b.len()), "ab");
    }

    #[test]
    fn read_usn_name_truncated_buffer_is_safe() {
        // name_len 超出可用字节：截断返回已解出部分，不 panic
        let b = utf16le("ab");
        assert_eq!(read_usn_name(&b, 0, 100), "ab");
    }

    #[test]
    fn read_usn_name_empty() {
        assert_eq!(read_usn_name(&[0, 0], 0, 0), "");
        assert_eq!(read_usn_name(&[], 0, 10), "");
    }

    // ---------- parse_usn：USN 记录 V2 解析 ----------
    /// 按 USN_RECORD_V2 布局构造一条合法记录（major=2，FileNameOffset=60）。
    fn usn_v2(frn: u64, parent: u64, usn: i64, reason: u32, name: &str) -> Vec<u8> {
        let name_bytes = utf16le(name);
        let mut rec = vec![0u8; 60];
        let rec_len = (60 + name_bytes.len()) as u32;
        rec[0..4].copy_from_slice(&rec_len.to_le_bytes());
        rec[4..6].copy_from_slice(&2u16.to_le_bytes()); // MajorVersion = 2
        rec[8..16].copy_from_slice(&frn.to_le_bytes());
        rec[16..24].copy_from_slice(&parent.to_le_bytes());
        rec[24..32].copy_from_slice(&usn.to_le_bytes());
        rec[40..44].copy_from_slice(&reason.to_le_bytes());
        rec[56..58].copy_from_slice(&(name_bytes.len() as u16).to_le_bytes()); // FileNameLength
        rec[58..60].copy_from_slice(&60u16.to_le_bytes()); // FileNameOffset
        rec.extend_from_slice(&name_bytes);
        rec
    }

    #[test]
    fn parse_usn_single_v2_record() {
        let mut buf: Vec<u8> = vec![0; 8]; // 前 8 字节为「下次起始 Usn」
        buf.extend(usn_v2(100, 200, 7, 0x0100, "a.txt"));
        let out = parse_usn(&buf);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0], (200, 100, "a.txt".to_string(), 0x0100));
    }

    #[test]
    fn parse_usn_chinese_name_and_multiple_records() {
        let mut buf: Vec<u8> = vec![0; 8];
        buf.extend(usn_v2(1, 2, 1, 0, "文件.txt"));
        buf.extend(usn_v2(3, 4, 2, 0, "b.png"));
        let out = parse_usn(&buf);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], (2, 1, "文件.txt".to_string(), 0));
        assert_eq!(out[1], (4, 3, "b.png".to_string(), 0));
    }

    #[test]
    fn parse_usn_stops_at_eof_record() {
        // usn = -1 为 USN_EOF：其后的记录不再解析
        let mut buf: Vec<u8> = vec![0; 8];
        buf.extend(usn_v2(1, 2, 1, 0, "keep.txt"));
        buf.extend(usn_v2(3, 4, -1, 0, "eof.txt"));
        buf.extend(usn_v2(5, 6, 3, 0, "after.txt"));
        let out = parse_usn(&buf);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].2, "keep.txt");
    }

    #[test]
    fn parse_usn_skips_v3_and_v4_records() {
        // 非 V2（major != 2）记录按 rec_len 跳过，其后的 V2 记录仍被解析
        let mut v3 = vec![0u8; 60];
        v3[0..4].copy_from_slice(&60u32.to_le_bytes());
        v3[4..6].copy_from_slice(&3u16.to_le_bytes()); // major = 3
        let mut buf: Vec<u8> = vec![0; 8];
        buf.extend(v3);
        buf.extend(usn_v2(11, 22, 5, 0, "ok.txt"));
        let out = parse_usn(&buf);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0], (22, 11, "ok.txt".to_string(), 0));
    }

    #[test]
    fn parse_usn_short_buffer_returns_empty_without_panic() {
        assert!(parse_usn(&[]).is_empty());
        assert!(parse_usn(&[1, 2, 3, 4, 5, 6, 7]).is_empty());
        assert!(parse_usn(&[0; 8]).is_empty());
    }

    #[test]
    fn parse_usn_short_record_length_breaks() {
        // rec_len < 60 → break，不 panic
        let mut bad = vec![0u8; 8 + 64];
        bad[8..12].copy_from_slice(&59u32.to_le_bytes());
        assert!(parse_usn(&bad).is_empty());
    }

    #[test]
    fn parse_usn_rec_len_beyond_buffer_no_panic() {
        // 记录声称 rec_len 远超缓冲区 → 跳过，不 panic
        let mut buf: Vec<u8> = vec![0; 8 + 60];
        buf[8..12].copy_from_slice(&100_000u32.to_le_bytes());
        buf[12..14].copy_from_slice(&2u16.to_le_bytes());
        let out = parse_usn(&buf);
        assert_eq!(out.len(), 1); // 越界记录本身仍被解析出（字段全 0，名为空）
        assert_eq!(out[0].2, "");
    }

    #[test]
    fn parse_usn_name_out_of_range_is_empty_no_panic() {
        // name_off/name_len 指向缓冲区外 → 文件名解出为空，不 panic
        let mut buf: Vec<u8> = vec![0; 8];
        buf.extend(usn_v2(1, 2, 1, 0, ""));
        let p = 8;
        buf[p + 56..p + 58].copy_from_slice(&100u16.to_le_bytes());
        buf[p + 58..p + 60].copy_from_slice(&0xFFFFu16.to_le_bytes());
        let out = parse_usn(&buf);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].2, "");
    }

    // ---------- should_skip_dir ----------
    #[test]
    fn skip_dot_prefixed_and_blacklisted_dirs() {
        assert!(should_skip_dir(".git"));
        assert!(should_skip_dir(".hidden"));
        assert!(should_skip_dir("node_modules"));
        assert!(should_skip_dir("target"));
        assert!(should_skip_dir("vendor"));
        assert!(should_skip_dir(".cache"));
        assert!(should_skip_dir(".npm"));
        assert!(should_skip_dir(".cargo"));
        assert!(should_skip_dir("AppData"));
        assert!(should_skip_dir("Windows"));
        assert!(should_skip_dir("Program Files"));
        assert!(should_skip_dir("Program Files (x86)"));
        assert!(should_skip_dir("ProgramData"));
        assert!(should_skip_dir("OneDrive"));
        assert!(should_skip_dir("$RECYCLE.BIN"));
        assert!(should_skip_dir("System Volume Information"));
    }

    #[test]
    fn keep_normal_dirs() {
        assert!(!should_skip_dir("Documents"));
        assert!(!should_skip_dir("projects"));
        assert!(!should_skip_dir("src"));
        assert!(!should_skip_dir("Desktop"));
        assert!(!should_skip_dir(""));
    }

    #[test]
    fn blacklist_is_case_sensitive() {
        assert!(!should_skip_dir("Node_Modules"));
        assert!(!should_skip_dir("WINDOWS"));
        assert!(!should_skip_dir("node_modules2"));
    }

    // ---------- char_trigrams ----------
    #[test]
    fn trigrams_short_strings() {
        assert_eq!(char_trigrams(""), Vec::<String>::new());
        assert_eq!(char_trigrams("ab"), vec!["ab".to_string()]);
        assert_eq!(char_trigrams("abc"), vec!["abc".to_string()]);
    }

    #[test]
    fn trigrams_long_strings() {
        let expect = vec!["abc", "bcd", "cde", "def"]
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>();
        assert_eq!(char_trigrams("abcdef"), expect);
    }

    #[test]
    fn trigrams_chinese() {
        assert_eq!(char_trigrams("中文"), vec!["中文".to_string()]);
        let expect = vec!["中文字", "文字符", "字符串"]
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>();
        assert_eq!(char_trigrams("中文字符串"), expect);
    }
}
