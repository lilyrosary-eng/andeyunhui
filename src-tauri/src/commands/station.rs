//! 中转站索引命令层（`station_*`）。
//!
//! ## 为什么不用旧的 `stored_path` 拼路径
//!
//! 旧的 `read_dropzone_file(stored_path)` 直接把前端传来的字符串拼进 dropzone 目录。
//! 在那个模型下这是安全的：拼进来就出不去（目录边界即安全边界）。
//!
//! 一旦中转站变成「一张可以指向任意位置的索引表」，同一种写法就变成
//! **任意文件读/删的 IPC**——前端（或任何能调命令的插件）传 `../../..` 就能读删系统文件。
//!
//! 所以这里的铁律：**所有命令只收 `id`，路径由后端用 id 查索引得到**。
//! 唯一允许前端给路径的是 `station_relocate` 的**目标**路径（用户自己选的目录），
//! 且必须校验为绝对路径。

use super::*;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use crate::services::station::{
    self, DownloadRef, RemoveOutcome, StationEntry, StationList,
};

fn app_data_of(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// 把下载模块的已完成任务映射成中转站引用。
///
/// 读失败必须变成一条 notice 而不是「零条下载」——用户看到列表空了一半
/// 却不知道为什么，比直接报错更难受。
fn collect_downloads(app: &tauri::AppHandle) -> (Vec<DownloadRef>, Vec<String>) {
    match download_kit::commands::completed_tasks(app, 500) {
        Ok(tasks) => {
            let refs = tasks
                .into_iter()
                .map(|t| DownloadRef {
                    id: t.id,
                    save_path: t.save_path,
                    filename: t.filename,
                    size: t.total_bytes,
                    completed_at_ms: t.completed_at.unwrap_or(t.updated_at),
                })
                .collect();
            (refs, Vec::new())
        }
        Err(e) => (
            Vec::new(),
            vec![format!(
                "读取下载记录失败，本次列表不含已下载文件：{e}"
            )],
        ),
    }
}

/// 列出中转站全部条目（托管文件 + 已完成的下载）。
///
/// async + spawn_blocking：要扫目录并对每条 `stat`，条目可能指向网络盘/移动硬盘，
/// 同步跑在主线程上会让整个界面卡住。
#[tauri::command]
pub async fn station_list(app: tauri::AppHandle) -> Result<StationList, String> {
    tokio::task::spawn_blocking(move || {
        let app_data = app_data_of(&app)?;
        let (downloads, notices) = collect_downloads(&app);
        Ok(station::list(&app_data, &downloads, notices))
    })
    .await
    .map_err(|e| format!("station_list 任务失败: {e}"))?
}

/// 在资源管理器里打开中转站根目录。
///
/// 为什么不做成前端直接调 `opener.openPath`：那要求给 `opener:allow-open-path`
/// 开 `path: "**"` 的 scope —— 等于把「打开任意路径」的能力交给整个 webview
/// （含所有插件）。前端调用会直接报
/// `Command plugin:opener|open_path not allowed by ACL`。
/// 后端命令只能打开这一个固定目录，作用面最小。
#[tauri::command]
pub fn open_station_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let app_data = app_data_of(&app)?;
    let root = app_data.join("transfer_station");
    std::fs::create_dir_all(&root).map_err(|e| format!("创建中转站目录失败: {e}"))?;
    app.opener()
        .open_path(root.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("打开中转站目录失败: {e}"))
}

/// 中转站存储概况：根目录、各分项占用。设置页显示 + 「打开文件夹」的落点。
#[tauri::command]
pub async fn station_storage_info(app: tauri::AppHandle) -> Result<station::StorageInfo, String> {
    tokio::task::spawn_blocking(move || {
        let app_data = app_data_of(&app)?;
        Ok(station::storage_info(&app_data))
    })
    .await
    .map_err(|e| format!("station_storage_info 任务失败: {e}"))?
}

/// 把一批**真实路径**收进中转站（拖入 / 导入的统一入口）。
///
/// ★ 为什么要有这条命令而不是复用 `add_bytes_to_dropzone`：
///   旧链路要求前端先把整个文件读成 base64 再传回后端（1 GB 文件 → 1.37 GB 字符串
///   过 IPC，V8 单字符串有上限，必然失败；中间还白落两次盘）。
///   这里直接收路径，复制走 `fs::copy`，**文件内容不进内存**。
///
/// `copyThreshold`：≤ 它则复制进 dropzone（自包含），> 它则只登记位置。
/// 缺省用 `DEFAULT_COPY_THRESHOLD`（100 MiB）。
#[tauri::command]
pub async fn station_ingest_paths(
    app: tauri::AppHandle,
    paths: Vec<String>,
    copy_threshold: Option<u64>,
) -> Result<station::IngestResult, String> {
    let threshold = copy_threshold.unwrap_or(station::DEFAULT_COPY_THRESHOLD);
    let app_bg = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        let app_data = app_data_of(&app_bg)?;
        // 只接受绝对路径：相对路径的基准是进程 cwd，对用户完全不可预期，
        // 与其猜一个基准，不如明确告诉他这条没收。
        let mut accepted: Vec<PathBuf> = Vec::with_capacity(paths.len());
        let mut rejected: Vec<String> = Vec::new();
        for raw in paths {
            let p = PathBuf::from(&raw);
            if p.is_absolute() {
                accepted.push(p);
            } else {
                rejected.push(format!("跳过（不是绝对路径）：{raw}"));
            }
        }
        let mut out = station::ingest_paths(&app_data, &accepted, threshold);
        if !rejected.is_empty() {
            eprintln!("[中转站] 拒绝 {} 条非绝对路径", rejected.len());
            out.notices.extend(rejected);
        }
        Ok::<_, String>(out)
    })
    .await
    .map_err(|e| format!("station_ingest_paths 任务失败: {e}"))??;

    if !result.entries.is_empty() {
        let _ = app.emit("dropzone-changed", ());
    }
    Ok(result)
}

/// 移除一条记录。**默认动作，不删用户的文件。**
///
/// - 托管（managed）：先把副本归档进回收站，再删 dropzone 里的那份。
/// - 引用（referenced）：只忘掉下载记录，磁盘文件一动不动。
#[tauri::command]
pub async fn station_remove_record(
    app: tauri::AppHandle,
    id: String,
) -> Result<RemoveOutcome, String> {
    let app_bg = app.clone();
    let out = tokio::task::spawn_blocking(move || {
        let app_data = app_data_of(&app_bg)?;
        let (downloads, _) = collect_downloads(&app_bg);
        let entry = station::resolve(&app_data, &downloads, &id)?;

        if entry.is_managed() {
            Ok::<_, String>(station::remove_record(&app_data, &entry))
        } else {
            // 引用条目分两种来源，处理完全不同：
            // - 下载任务：记录在 download-kit 的库里，`forget` 只删库不删文件；
            // - 索引条目（曾经托管、后来被移出 dropzone）：由 remove_record 删索引。
            match &entry.download_id {
                Some(dl_id) => {
                    download_kit::commands::manager(&app_bg)?.forget(dl_id)?;
                    Ok(RemoveOutcome {
                        deleted_file: false,
                        archived: false,
                        notice: None,
                    })
                }
                // 交给 remove_record：它会按"引用条目且无 download_id"分支删索引条目
                None => Ok(station::remove_record(&app_data, &entry)),
            }
        }
    })
    .await
    .map_err(|e| format!("station_remove_record 任务失败: {e}"))??;

    let _ = app.emit("dropzone-changed", ());
    Ok(out)
}

/// 显式删除真实文件（第二动作）。
///
/// 和「移除记录」分开是刻意的：这个动作对引用条目意味着**删掉用户唯一一份文件**，
/// 不可逆。UI 上必须二次确认，且不能做成默认按钮。
#[tauri::command]
pub async fn station_delete_file(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let app_bg = app.clone();
    tokio::task::spawn_blocking(move || {
        let app_data = app_data_of(&app_bg)?;
        let (downloads, _) = collect_downloads(&app_bg);
        let entry: StationEntry = station::resolve(&app_data, &downloads, &id)?;
        station::delete_file(&app_data, &entry)?;
        // 引用条目删了真实文件之后，下载记录也必须一起清掉：
        // 否则任务库还留着一条指向空气的记录，列表下次会把「文件已丢失」再报一遍。
        if let Some(dl_id) = entry.download_id.as_deref() {
            if let Ok(m) = download_kit::commands::manager(&app_bg) {
                if let Err(e) = m.forget(dl_id) {
                    eprintln!("[中转站] 删除文件后清理下载记录失败: {e}");
                }
            }
        }
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| format!("station_delete_file 任务失败: {e}"))??;

    let _ = app.emit("dropzone-changed", ());
    Ok(())
}

/// 改名 / 移动的结果。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelocateResult {
    /// 最终落点绝对路径。前端以它为准提示用户。
    pub path: String,
    /// 降级提示（如路径回写失败）。成功且一致时为 None。
    pub notice: Option<String>,
    /// 是否走了跨卷「读一块写一块」路径（前端据此决定要不要提示耗时）。
    pub streamed: bool,
}

/// 当前移动的取消开关。
///
/// 全局单槽而不是按任务 id 索引：移动是用户一次一个的交互动作，
/// 同时搬两个几十 GB 的文件只会让两块盘一起卡，没有真实收益。
fn move_cancel_slot() -> &'static Mutex<Option<Arc<AtomicBool>>> {
    static SLOT: OnceLock<Mutex<Option<Arc<AtomicBool>>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// 取消正在进行的移动。中止后目标位置的半成品会被删掉。
///
/// 返回 `true` 表示确实有一个移动在跑并已被要求停止；`false` 表示当前没有移动。
/// 不用报错表达"没什么可取消的"——用户连点两下取消不该看到红字。
#[tauri::command]
pub fn station_move_cancel() -> Result<bool, String> {
    let slot = move_cancel_slot();
    let guard = slot.lock().map_err(|_| "移动取消槽损坏".to_string())?;
    match guard.as_ref() {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            Ok(true)
        }
        None => Ok(false),
    }
}

/// 改名 / 移动。`new_path` 必须是绝对路径（由系统保存/选择对话框给出）。
///
/// 同卷是原子的 `rename`（瞬时）；跨卷才会走流式复制 —— 那条路径会通过
/// `station-move-progress` 持续上报 `{ id, done, total }`，可以用
/// `station_move_cancel` 中止。
#[tauri::command]
pub async fn station_relocate(
    app: tauri::AppHandle,
    id: String,
    new_path: String,
) -> Result<RelocateResult, String> {
    if new_path.trim().is_empty() {
        return Err("目标路径不能为空".to_string());
    }
    let target = PathBuf::from(&new_path);
    if !target.is_absolute() {
        return Err("目标路径必须是绝对路径".to_string());
    }

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let slot = move_cancel_slot();
        let mut guard = slot.lock().map_err(|_| "移动取消槽损坏".to_string())?;
        if guard.is_some() {
            return Err("已有移动在进行中，请等它结束或先取消".to_string());
        }
        *guard = Some(cancel.clone());
    }

    let app_bg = app.clone();
    let emit_id = id.clone();
    // 闭包是 move 的，所以给后台线程一份克隆；外面留着 `cancel` 用于收尾时比对同一把锁。
    let cancel_bg = cancel.clone();
    let result = tokio::task::spawn_blocking(move || {
        let app_data = app_data_of(&app_bg)?;
        let (downloads, _) = collect_downloads(&app_bg);
        let entry = station::resolve(&app_data, &downloads, &id)?;

        // 进度节流：4 MiB 一块，30 GB 就是七千多次回调。全发事件会把
        // IPC 和前端渲染打满，所以按「百分比变化且间隔 ≥200ms」才发一次。
        let mut last_pct: i64 = -1;
        let mut last_at = std::time::Instant::now();
        let app_evt = app_bg.clone();
        let mut cb = |done: u64, total: u64| {
            let pct = if total == 0 {
                100
            } else {
                (done.saturating_mul(100) / total) as i64
            };
            let now = std::time::Instant::now();
            if pct == last_pct && now.duration_since(last_at).as_millis() < 200 {
                return;
            }
            last_pct = pct;
            last_at = now;
            let _ = app_evt.emit(
                "station-move-progress",
                serde_json::json!({ "id": emit_id, "done": done, "total": total }),
            );
        };
        let mut ctx = station::MoveCtx {
            cancel: Some(&cancel_bg),
            progress: Some(&mut cb),
        };
        let landed = station::relocate_with(&app_data, &entry, &target, &mut ctx)?;

        // 引用了下载任务的文件，路径变了必须回写任务库：
        // `save_path` 是断点续传/重试的锚点，不回写就等于让任务记录指向空气。
        let mut notice = None;
        if let Some(dl_id) = entry.download_id.as_deref() {
            let filename = Path::new(&landed.path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if let Err(e) =
                download_kit::commands::manager(&app_bg)?.relocate(dl_id, &landed.path, &filename)
            {
                // 文件已经移到位了，这时回滚文件比留着不一致的记录更糟。
                // 显式告诉用户记录没跟上，让他知道「重试」会下载到旧位置。
                notice = Some(format!(
                    "文件已移动，但下载记录路径回写失败（{e}）——该任务的「重试」仍指向旧位置"
                ));
            }
        }
        Ok::<_, String>(RelocateResult {
            path: landed.path,
            notice,
            streamed: landed.streamed,
        })
    })
    .await;

    // 无论成败都要释放取消槽，否则下一次移动会被"已有移动在进行中"永久挡住。
    // 只清自己放进去的那把，避免误清掉别人刚设置的。
    if let Ok(mut slot) = move_cancel_slot().lock() {
        if slot
            .as_ref()
            .map(|c| Arc::ptr_eq(c, &cancel))
            .unwrap_or(false)
        {
            *slot = None;
        }
    }

    let result = result.map_err(|e| format!("station_relocate 任务失败: {e}"))??;
    let _ = app.emit("dropzone-changed", ());
    Ok(result)
}
