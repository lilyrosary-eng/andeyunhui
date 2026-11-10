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
            // 引用条目：只删索引/任务记录。这里刻意不调 station::remove_record，
            // 因为那个函数对 referenced 是 no-op（安全兜底），而我们要真正「忘掉」它。
            match &entry.download_id {
                Some(dl_id) => {
                    download_kit::commands::manager(&app_bg)?.forget(dl_id)?;
                    Ok(RemoveOutcome {
                        deleted_file: false,
                        archived: false,
                        notice: None,
                    })
                }
                None => Err(format!("这条记录没有可移除的来源: {}", entry.name)),
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
    /// 最终落点绝对路径。前端以它为准提示用户（跨卷移动可能因同名冲突微调）。
    pub path: String,
    /// 降级提示（如路径回写失败）。成功且一致时为 None。
    pub notice: Option<String>,
}

/// 改名 / 移动。`new_path` 必须是绝对路径（由系统保存/选择对话框给出）。
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

    let app_bg = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        let app_data = app_data_of(&app_bg)?;
        let (downloads, _) = collect_downloads(&app_bg);
        let entry = station::resolve(&app_data, &downloads, &id)?;
        let landed = station::relocate(&app_data, &entry, &target)?;

        // 引用了下载任务的文件，路径变了必须回写任务库：
        // `save_path` 是断点续传/重试的锚点，不回写就等于让任务记录指向空气。
        let mut notice = None;
        if let Some(dl_id) = entry.download_id.as_deref() {
            let filename = Path::new(&landed)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if let Err(e) =
                download_kit::commands::manager(&app_bg)?.relocate(dl_id, &landed, &filename)
            {
                // 文件已经移到位了，这时回滚文件比留着不一致的记录更糟。
                // 显式告诉用户记录没跟上，让他知道「重试」会下载到旧位置。
                notice = Some(format!(
                    "文件已移动，但下载记录路径回写失败（{e}）——该任务的「重试」仍指向旧位置"
                ));
            }
        }
        Ok::<_, String>(RelocateResult {
            path: landed,
            notice,
        })
    })
    .await
    .map_err(|e| format!("station_relocate 任务失败: {e}"))??;

    let _ = app.emit("dropzone-changed", ());
    Ok(result)
}
