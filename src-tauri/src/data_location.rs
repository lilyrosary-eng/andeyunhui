//! 应用数据根（可配置存放位置）模块。
//!
//! 目标：让所有用户数据（笔记 / 插件 / 缓存 / 中转站 / 以安得云荟打开临时目录 /
//! 日志 / 扫描缓存等）可以存放在用户自选目录，而非固定于 C 盘 AppData。
//!
//! 实现手法：Tauri 的 `app.path().app_data_dir()` 由 identifier 推导、不可配置，
//! 且其调用点分散在 80+ 处。为避免对这些业务代码做侵入式替换，这里把 Tauri 固定的
//! `app_data_dir` 路径（简称 `default`）变成一个 **junction（Windows 重解析点）**，
//! 指向用户真实数据目录（简称 `target`）。这样所有 `app.path().app_data_dir()`
//! 的调用在 OS 层自动落到真实目录，业务代码零改动。
//!
//! 三个位置的职责：
//! - `anchor`（LOCALAPPDATA/andeyunhui-dataroot/dataroot.json）：运行时真实数据根记录，
//!   用户可写，**此目录本身不参与迁移**（不能放在 app_data 内，否则一搬家就读不到）。
//! - `seed`（安装目录/andeyunhui.dataroot.json）：安装时 NSIS 写入的初始选择，运行时只读。
//! - `pending`（与 anchor 同目录的 pending-migration.json）：设置里改路径后写入，下次启动早期消费。
//! - `guided`（同目录/guided）：首次运行引导是否已处理过的标记（独立于锚点）。
//! - `migration.log`（同目录/migration.log）：迁移诊断日志。
//!
//! 迁移时机：进程退出时无法安全迁移（文件句柄未释放）。故"关闭/打开时自动迁移"的
//! 安全实现是——设置里改路径 → 写 pending → 提示重启 → 下次启动早期（无任何数据访问前）
//! 由 `prepare_data_root` 执行迁移，再重建 junction。用户感知仅为"重启后下一次打开稍慢"。
//!
//! 迁移实现说明（v2 容错版）：不再依赖 robocopy 的退出码判定成功与否。早期版本用
//! robocopy /MOVE，一旦迁移目录里有任一文件被当前进程锁住（如启动期 Tauri/插件日志、
//! 状态文件），robocopy 返回退出码 >=8，整体被判失败 → 数据原地保留、不更新锚点、不清除
//! pending，表现为"重启了却没迁移"。现改为自带递归拷贝：单文件拷贝失败仅记入日志、不中断
//! 整体迁移；拷贝成功后删除源文件（move 语义），最后尽力删除残留空目录。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Emitter;
use tauri::Manager;

const SEED_FILENAME: &str = "andeyunhui.dataroot.json";
const ANCHOR_DIRNAME: &str = "andeyunhui-dataroot";
const ANCHOR_FILENAME: &str = "dataroot.json";
const MIGRATION_FILENAME: &str = "pending-migration.json";
const GUIDED_FILENAME: &str = "guided";
const LOG_FILENAME: &str = "migration.log";
/// 用户所选根目录下的实际数据子目录名。所有用户数据统一存放于 `<根>/data`，
/// 避免数据散落在用户所选根目录顶层。锚点记录的是"用户所选根"，真正的 junction/migration
/// 目标均为 `<根>/data`，前端显示的也是用户所选根，避免再次选择时形成嵌套 `<根>/data/data`。
const DATA_SUBDIR: &str = "data";

/// 返回某"用户所选根"对应的真实数据目录（`<根>/data`）。
fn data_dir(root: &Path) -> PathBuf {
    root.join(DATA_SUBDIR)
}

/// 解析迁移/兜底搬运时的真实源数据目录：
/// 若旧数据已处于 `<根>/data` 新结构（之前迁移过），则以其为源；
/// 否则把用户所选根本身（旧结构下数据直接散落在根顶层）作为源。
fn resolve_source(root: &Path) -> PathBuf {
    let sub = root.join(DATA_SUBDIR);
    if sub.exists() {
        sub
    } else {
        root.to_path_buf()
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct MigrationPlan {
    from: String,
    to: String,
}

fn local_appdata() -> Option<PathBuf> {
    std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("APPDATA"))
        .ok()
        .map(PathBuf::from)
}

/// 锚点文件（运行时真实数据根记录，用户可写；不参与迁移）。
fn anchor_file() -> Option<PathBuf> {
    let mut p = local_appdata()?;
    p.push(ANCHOR_DIRNAME);
    p.push(ANCHOR_FILENAME);
    Some(p)
}

/// 种子文件（安装目录内，安装时 NSIS 写入初始选择，运行时只读）。
fn seed_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok().map(|p| p.join(SEED_FILENAME))
}

/// pending 迁移标记文件（与 anchor 同目录，固定位置不参与迁移）。
fn pending_file() -> Option<PathBuf> {
    let mut p = local_appdata()?;
    p.push(ANCHOR_DIRNAME);
    p.push(MIGRATION_FILENAME);
    Some(p)
}

/// 首次引导标记文件（独立于锚点；锚点会在首次启动自动写入，不能用于判断是否引导过）。
fn guided_file() -> Option<PathBuf> {
    let mut p = local_appdata()?;
    p.push(ANCHOR_DIRNAME);
    p.push(GUIDED_FILENAME);
    Some(p)
}

/// 诊断日志路径。
fn log_path() -> Option<PathBuf> {
    let mut p = local_appdata()?;
    p.push(ANCHOR_DIRNAME);
    p.push(LOG_FILENAME);
    Some(p)
}

/// 向 migration.log 追加一行（失败则静默忽略，不干扰主流程）。
fn log_msg(msg: &str) {
    if let Some(p) = log_path() {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&p)
            .and_then(|mut f| writeln!(f, "[{}] {}", ts, msg));
    }
}

/// 解析当前真实数据根：锚点 > 种子 > 默认 app_data_dir。
pub fn resolve_data_root(app: &tauri::AppHandle) -> PathBuf {
    if let Some(f) = anchor_file() {
        if let Ok(s) = std::fs::read_to_string(&f) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                if let Some(p) = v.get("data_root").and_then(|x| x.as_str()) {
                    let pb = PathBuf::from(p);
                    if !p.is_empty() && pb.exists() {
                        return pb;
                    }
                }
            }
        }
    }
    if let Some(f) = seed_file(app) {
        if let Ok(s) = std::fs::read_to_string(&f) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                if let Some(p) = v.get("data_root").and_then(|x| x.as_str()) {
                    let pb = PathBuf::from(p);
                    if !p.is_empty() && pb.exists() {
                        return pb;
                    }
                }
            }
        }
    }
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn read_anchor_root() -> Option<PathBuf> {
    let f = anchor_file()?;
    let s = std::fs::read_to_string(&f).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    let p = v.get("data_root")?.as_str()?;
    let pb = PathBuf::from(p);
    if pb.exists() {
        Some(pb)
    } else {
        None
    }
}

fn write_anchor(root: &Path) -> std::io::Result<()> {
    let f = anchor_file()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no local appdata"))?;
    if let Some(parent) = f.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let s = serde_json::json!({ "data_root": root.to_string_lossy() }).to_string();
    std::fs::write(&f, s)
}

#[cfg(windows)]
fn is_junction(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        // FILE_ATTRIBUTE_REPARSE_POINT = 0x400
        (meta.file_attributes() & 0x400) != 0
    } else {
        false
    }
}
#[cfg(not(windows))]
fn is_junction(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

#[cfg(windows)]
fn remove_junction(link: &Path) -> std::io::Result<()> {
    if link.exists() || is_junction(link) {
        let out = std::process::Command::new("cmd")
            .args(["/c", "rmdir", &link.to_string_lossy()])
            .output()?;
        if !out.status.success() && link.exists() {
            let _ = std::fs::remove_dir(link);
        }
    }
    Ok(())
}
#[cfg(not(windows))]
fn remove_junction(link: &Path) -> std::io::Result<()> {
    if link.is_symlink() {
        std::fs::remove_dir(link)?;
    }
    Ok(())
}

#[cfg(windows)]
fn create_junction(link: &Path, target: &Path) -> std::io::Result<()> {
    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let out = std::process::Command::new("cmd")
        .args([
            "/c",
            "mklink",
            "/J",
            &link.to_string_lossy(),
            &target.to_string_lossy(),
        ])
        .output()?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr);
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("mklink 失败: {msg}"),
        ));
    }
    Ok(())
}
#[cfg(not(windows))]
fn create_junction(link: &Path, target: &Path) -> std::io::Result<()> {
    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::os::unix::fs::symlink(target, link)?;
    Ok(())
}

/// 统计目录总字节数（用于迁移进度）。
fn total_bytes(path: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(rd) = std::fs::read_dir(path) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_dir() {
                total += total_bytes(&p);
            } else if let Ok(m) = entry.metadata() {
                total += m.len();
            }
        }
    }
    total
}

/// 递归容错拷贝：把 from 内容拷贝到 to，拷贝成功后删除源文件（move 语义）。
/// 单文件拷贝失败仅计入 failed 并写日志，不中断整体。过程中按已拷贝字节比例向前端推送进度
/// （app 为 None 时不推送，用于 ensure_junction 兜底搬运等无 UI 进度需求的场景）。
/// 返回 (已拷贝字节数, 失败文件数)。
fn copy_tree_tolerant(
    from: &Path,
    to: &Path,
    total: u64,
    app: Option<&tauri::AppHandle>,
) -> (u64, u64) {
    let _ = std::fs::create_dir_all(to);
    let mut copied: u64 = 0;
    let mut failed: u64 = 0;
    let mut last_pct: u8 = 0;
    let entries = match std::fs::read_dir(from) {
        Ok(rd) => rd,
        Err(e) => {
            log_msg(&format!("read_dir 失败 {}: {}", from.display(), e));
            return (copied, failed);
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let dest = to.join(entry.file_name());
        if path.is_dir() {
            let (c, f) = copy_tree_tolerant(&path, &dest, total, app);
            copied += c;
            failed += f;
        } else {
            if let Some(parent) = dest.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            match std::fs::copy(&path, &dest) {
                Ok(_) => {
                    if let Ok(m) = entry.metadata() {
                        copied += m.len();
                    }
                    // 拷贝成功后删除源文件（move 语义）
                    let _ = std::fs::remove_file(&path);
                    if total > 0 {
                        let pct = (copied * 100 / total) as u8;
                        if pct > last_pct {
                            last_pct = pct;
                            if let Some(app) = app {
                                let _ = app.emit(
                                    "migration-progress",
                                    serde_json::json!({ "percent": pct }),
                                );
                            }
                        }
                    }
                }
                Err(e) => {
                    failed += 1;
                    log_msg(&format!(
                        "跳过(可能锁住): {} -> {} : {}",
                        path.display(),
                        dest.display(),
                        e
                    ));
                }
            }
        }
    }
    (copied, failed)
}

/// 容错移动目录（用于 ensure_junction 兜底搬运）：拷贝 + 删除源（不推送进度）。
fn move_dir_tolerant(from: &Path, to: &Path) {
    let _ = std::fs::create_dir_all(to);
    let total = total_bytes(from);
    let (copied, failed) = copy_tree_tolerant(from, to, total, None);
    let _ = std::fs::remove_dir_all(from);
    log_msg(&format!(
        "兜底搬运 {} -> {}：已拷贝 {} 字节，跳过 {} 个文件",
        from.display(),
        to.display(),
        copied,
        failed
    ));
}

/// 执行数据迁移：把 from（解析 junction 后的真实路径）内容移动到 to。
/// 采用容错拷贝，单个被锁文件不会中断整体迁移；通过 app 推送进度事件。
fn do_migrate(app: &tauri::AppHandle, from: &str, to: &str) -> Result<(), String> {
    let from_p = PathBuf::from(from);
    let to_p = PathBuf::from(to);
    let from_real = std::fs::canonicalize(&from_p).unwrap_or(from_p.clone());
    let to_real = std::fs::canonicalize(&to_p).unwrap_or(to_p.clone());
    if from_real == to_real {
        log_msg(&format!(
            "迁移跳过：源与目标相同 {}",
            from_real.display()
        ));
        return Ok(());
    }
    log_msg(&format!(
        "开始迁移 {} -> {}",
        from_real.display(),
        to_real.display()
    ));
    std::fs::create_dir_all(&to_real).map_err(|e| e.to_string())?;
    let total = total_bytes(&from_real);
    let (copied, failed) = copy_tree_tolerant(&from_real, &to_real, total, Some(app));
    // 残留空目录清理（被锁文件可能在后续启动续搬；此处尽力而为）
    let _ = std::fs::remove_dir_all(&from_real);
    log_msg(&format!(
        "迁移完成：已拷贝 {} 字节，跳过 {} 个文件",
        copied,
        failed
    ));
    Ok(())
}

/// 异步执行迁移：不阻塞启动流程，通过事件推送进度，完成后重建 junction 并通知前端。
/// 迁移统一以 `<根>/data` 为真实数据目录：源取旧结构的 `<from>`（或已存在的 `<from>/data`），
/// 目标为 `<to>/data`，实现"数据归集到目标位置下的 data 子目录"。
fn spawn_migration(app: tauri::AppHandle, plan: MigrationPlan) {
    let _ = app.emit("migration-started", ());
    std::thread::spawn(move || {
        let apph = app;
        let src = resolve_source(&PathBuf::from(&plan.from));
        let dst = data_dir(&PathBuf::from(&plan.to));
        match do_migrate(&apph, &src.to_string_lossy(), &dst.to_string_lossy()) {
            Ok(()) => {
                let _ = write_anchor(Path::new(&plan.to));
                if let Ok(default) = apph.path().app_data_dir() {
                    ensure_junction(&default, &dst);
                }
                clear_pending_migration();
                log_msg("pending 迁移成功，已更新锚点并清除标记");
            }
            Err(e) => {
                log_msg(&format!("[DataRoot] 迁移失败，保留原数据: {e}"));
                // 不清除 pending，下次启动可重试。
            }
        }
        let _ = apph.emit("migration-progress", serde_json::json!({ "percent": 100 }));
        let _ = apph.emit("migration-done", ());
    });
}

fn read_pending_migration() -> Option<MigrationPlan> {
    let f = pending_file()?;
    let s = std::fs::read_to_string(&f).ok()?;
    serde_json::from_str::<MigrationPlan>(&s).ok()
}

fn write_pending_migration(plan: &MigrationPlan) -> std::io::Result<()> {
    let f = pending_file()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no local appdata"))?;
    if let Some(parent) = f.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&f, serde_json::to_string(plan).unwrap())
}

fn clear_pending_migration() {
    if let Some(f) = pending_file() {
        let _ = std::fs::remove_file(f);
    }
}

/// 维护 default(junction link) -> target 的指向关系。
fn ensure_junction(default: &Path, target: &Path) {
    if default == target {
        // 目标就是默认目录：确保 default 是真实目录（不是 junction）。
        if is_junction(default) {
            if let Ok(old) = std::fs::canonicalize(default) {
                let _ = remove_junction(default);
                let _ = std::fs::create_dir_all(default);
                if old != default {
                    move_dir_tolerant(&old, default);
                }
            }
        }
        return;
    }
    std::fs::create_dir_all(target).ok();
    if default.exists() {
        if is_junction(default) {
            if let Ok(c) = std::fs::canonicalize(default) {
                if c == std::fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf()) {
                    return; // 已指向正确目标
                }
            }
            let _ = remove_junction(default);
        } else {
            // 真实目录：兜底把内容搬到 target（正常迁移已处理），再删除原目录。
            move_dir_tolerant(default, target);
        }
    }
    let _ = create_junction(default, target);
}

/// 启动早期调用：处理 pending 迁移 + 维护 junction。
/// 若存在待迁移任务，迁移在后台线程异步进行（通过事件推送进度，前端显示遮罩），
/// 不阻塞启动；业务初始化由前端在收到 `migration-done` 后再执行，避免迁移期间读取半拷贝数据。
/// 必须在任何 `app_data_dir` 子路径被业务代码使用前（如 clear_openwith_dir / 日志初始化前）执行。
pub fn prepare_data_root(app: &tauri::AppHandle) {
    // 1) pending 迁移优先（设置里改路径后触发），异步执行。
    if let Some(plan) = read_pending_migration() {
        spawn_migration(app.clone(), plan);
        return;
    }
    // 2) 首次：若锚点不存在，从种子初始化（种子指向安装时选择，否则用默认）。
    if anchor_file().map(|f| !f.exists()).unwrap_or(true) {
        let root = resolve_data_root(app);
        let _ = write_anchor(&root);
        log_msg(&format!("首次初始化锚点 -> {}", root.display()));
    }

    // 3) 维护 junction：default 路径重定向到真实数据根（`<根>/data`）。
    let default = match app.path().app_data_dir() {
        Ok(p) => p,
        Err(_) => return,
    };
    let target = read_anchor_root().unwrap_or_else(|| default.clone());
    // 真实数据目录统一为 `<用户所选根>/data`，数据归集到该子目录而非散落在根顶层。
    let data_target = data_dir(&target);
    ensure_junction(&default, &data_target);
}

// ============ 前端命令 ============

/// 返回当前真实数据根路径（供设置面板显示）。
#[tauri::command]
pub fn get_data_root(app: tauri::AppHandle) -> String {
    resolve_data_root(&app).to_string_lossy().to_string()
}

/// 设置新的数据根。成功写入 pending 迁移标记，调用方应随后重启应用以触发自动迁移。
#[tauri::command]
pub fn set_data_root(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let new = PathBuf::from(&path);
    std::fs::create_dir_all(&new).map_err(|e| format!("无法创建目录: {e}"))?;
    let probe = new.join(".andeyunhui_write_test");
    std::fs::write(&probe, b"ok").map_err(|e| format!("目录不可写: {e}"))?;
    let _ = std::fs::remove_file(&probe);

    let current = read_anchor_root()
        .unwrap_or_else(|| app.path().app_data_dir().unwrap_or_default());
    // 规范化比较：忽略大小写/斜杠差异，避免把"同一目录"误判为需要迁移（否则会形成 from==to 自搬）。
    let cur_norm = std::fs::canonicalize(&current).unwrap_or(current.clone());
    let new_norm = std::fs::canonicalize(&new).unwrap_or(new.clone());
    if cur_norm == new_norm {
        log_msg(&format!(
            "set_data_root：新目录与当前相同（{}），无需迁移",
            new_norm.display()
        ));
        return Ok(());
    }

    log_msg(&format!(
        "set_data_root：写入 pending {} -> {}",
        current.display(),
        new.display()
    ));
    write_pending_migration(&MigrationPlan {
        from: current.to_string_lossy().to_string(),
        to: new.to_string_lossy().to_string(),
    })
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 重启应用（用于应用设置变更后生效，迁移在下次启动早期执行）。
#[tauri::command]
pub fn restart_app() {
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::process::Command::new(exe).spawn();
    }
    std::process::exit(0);
}

/// 是否从未被引导过数据根选择（引导标记不存在）。用于首次运行引导。
#[tauri::command]
pub fn needs_data_root_setup(_app: tauri::AppHandle) -> bool {
    guided_file().map(|f| !f.exists()).unwrap_or(true)
}

/// 标记已完成首次引导（无论用户是否更改了位置），避免重复弹窗。
#[tauri::command]
pub fn mark_data_root_guided() {
    if let Some(f) = guided_file() {
        if let Some(parent) = f.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&f, "1");
    }
}

/// 当前是否存在待执行（或正在执行）的数据迁移。前端挂载时主动查询，
/// 以弥补可能错过 `migration-started` 事件（迁移在 setup 阶段即开始，早于前端监听注册）的情况。
#[tauri::command]
pub fn is_migration_pending() -> bool {
    pending_file().map(|f| f.exists()).unwrap_or(false)
}
