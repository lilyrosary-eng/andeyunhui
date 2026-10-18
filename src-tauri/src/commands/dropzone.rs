//! 拖拽导入、投递区文件读写、base64/导出/文件名净化
//!
//! 本文件由 commands.rs 拆分而来（2026-10-18，P1-5 拆 god file）。
//! 约定：用 `use super::*;` 取父模块的 use 与同级 item，不要在子模块里重复 import
//! 父模块已有的依赖；确需额外 import 时写显式路径（显式优先于 glob，不会冲突）。

#![allow(dead_code)] // 部分命令仅在特定平台/配置下被 invoke_handler 引用

use super::*;
// ================= 拖入中转站命令 =================

/// 从拖入中转站导入的文件信息
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedFile {
    pub file_id: String,
    pub original_name: String,
    pub extension: String,
    pub size: u64,
    pub stored_path: String,
    /// 文件在磁盘上的绝对路径（用于原生拖出到系统）
    pub absolute_path: String,
    pub imported_at: String,
    pub is_readable: bool,
}

/// 原生文件拖出：把中转站里的文件以 OS 原生拖放（Windows DoDragDrop / CF_HDROP）写到桌面或文件夹。
/// 这是根治 WebView2 不支持 JS `dataTransfer.items.add(File)` 拖出的方案——完全绕过 WebView2，
/// 由 Rust 在 UI 主线程直接发起系统拖拽。前端在文件行上用 onMouseDown 触发。
///
/// ⚠ **仅 Windows**：依赖 `drag` crate（DoDragDrop 的封装），而该 crate 只在
///   `cfg(windows)` 目标下声明（Cargo.toml 的 `[target.'cfg(windows)'.dependencies]`）。
///   Linux/macOS 上没有等价实现——WebKitGTK 的拖出走的是 GTK DnD 模型，
///   不接受「Rust 侧替 webview 发起系统级拖拽」这种用法。
///   非 Windows 保留同名命令并返回明确错误，这样前端不必写平台分支即可调用，
///   用户看到的是「该平台暂不支持原生拖出」而不是 `invoke 找不到命令`。
#[cfg(windows)]
#[tauri::command]
pub fn start_native_file_drag(app: tauri::AppHandle, files: Vec<String>) -> Result<(), String> {
    if files.is_empty() {
        return Err("未提供要拖出的文件".into());
    }
    // 仅保留存在且为绝对路径的文件
    let paths: Vec<std::path::PathBuf> = files
        .into_iter()
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_absolute() && p.exists())
        .collect();
    if paths.is_empty() {
        return Err("没有可拖出的有效文件".into());
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;

    // DoDragDrop 必须在 UI 主线程同步调用并阻塞至拖放结束，故用 run_on_main_thread 调度。
    // 注意：DragItem 因含 Box<dyn Fn> 的 Data 变体而不实现 Send，必须把 DragItem 的构造放在闭包内，
    // 避免把 !Send 的 DragItem 跨线程移动（否则 run_on_main_thread 的 Send 约束不满足）。
    let (tx, rx) = std::sync::mpsc::channel::<drag::Result<()>>();
    app.run_on_main_thread(move || {
        let item = drag::DragItem::Files(paths);
        // 拖拽预览图：应用图标（PNG 字节）。系统拖拽需要一张预览图，否则无法发起。
        let image = drag::Image::Raw(include_bytes!("../../icons/32x32.png").to_vec());
        let options = drag::Options::default();
        let res = drag::start_drag(&window, item, image, |_r, _p| {}, options);
        let _ = tx.send(res);
    })
    .map_err(|e| format!("无法在主线程启动原生拖拽: {}", e))?;

    rx.recv()
        .map_err(|e| format!("等待拖拽结果失败: {}", e))?
        .map_err(|e| format!("原生拖拽失败: {}", e))
}

/// 非 Windows 版的原生拖出：同名同签名，返回明确的能力缺失说明。
///
/// 为什么不直接 `#[cfg]` 掉整个命令：前端 `invoke('start_native_file_drag')` 是
/// 跨平台共用的代码路径，命令不存在会抛「command not found」，在用户看来是
/// 「点了没反应」；返回一条可读错误至少能告诉他们原因，且未来接入 GTK DnD 时
/// 只需替换这个函数体，前端与调用链都不用动。
#[cfg(not(windows))]
#[tauri::command]
pub fn start_native_file_drag(
    _app: tauri::AppHandle,
    _files: Vec<String>,
) -> Result<(), String> {
    Err("该平台暂不支持原生文件拖出（仅 Windows 实现了 DoDragDrop）".into())
}

/// 可读文本文件扩展名
pub(crate) const READABLE_EXTENSIONS: &[&str] = &[
    "md", "txt", "json", "csv", "xml", "yaml", "yml", "toml", "ini", "cfg",
    "log", "env", "html", "css", "js", "ts", "tsx", "jsx", "mjs", "cjs",
    "py", "rs", "go", "java", "rb", "php", "c", "cpp", "h", "hpp", "swift",
    "kt", "scala", "sh", "bash", "zsh", "ps1", "bat", "cmd", "sql",
    "r", "m", "mm", "pl", "lua", "dart", "groovy", "gradle", "svelte",
    "vue", "astro", "tex", "bib", "rst", "asciidoc", "adoc",
];

/// 将文件导入中转站（复制到 app_data/transfer_station/dropzone/）
///
/// `placeholder_label`：可选。提供时（如录屏保存），先立即广播 `dropzone-saving` 占位事件
/// （前端展示「录屏文件保存中」），再把实际复制/快照放进后台线程；复制完成后广播
/// `dropzone-changed`（真实文件就位）与 `dropzone-saving-done`（移除占位）。这样巨大文件也
/// 能「保存秒结束」，且中转站即时出现占位、绝不静默处理。
#[tauri::command]
pub fn import_to_dropzone(
    app: tauri::AppHandle,
    source_path: String,
    placeholder_label: Option<String>,
    // 移动语义：true 时把源文件 rename 进 dropzone（同卷零拷贝；跨卷回退 copy+删源），
    // 并删除空的源会话文件夹，避免「保存目录 + 中转站」双重落盘。默认 false（复制，兼容录屏等调用方）。
    move_source: Option<bool>,
) -> Result<ImportedFile, String> {
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    let source = Path::new(&source_path);
    let file_name = source.file_name()
        .ok_or_else(|| "无法获取文件名".to_string())?
        .to_string_lossy()
        .to_string();
    
    let extension = source.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    
    let metadata = std::fs::metadata(&source_path)
        .map_err(|e| format!("无法读取文件元数据: {}", e))?;
    let size = metadata.len();
    
    let is_readable = READABLE_EXTENSIONS.contains(&extension.as_str());
    
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let file_id = format!("{}_{}", timestamp, file_name);
    
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dropzone_dir = app_data.join("transfer_station").join("dropzone");
    std::fs::create_dir_all(&dropzone_dir).map_err(|e| format!("创建目录失败: {}", e))?;
    
    let dest_path = dropzone_dir.join(&file_id);
    let imported_at = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

    let result = ImportedFile {
        file_id: file_id.clone(),
        original_name: file_name.clone(),
        extension: extension.clone(),
        size,
        stored_path: file_id.clone(),
        absolute_path: dest_path.to_string_lossy().to_string(),
        imported_at,
        is_readable,
    };

    // 占位事件：立即让中转站显示「保存中」，绝不静默。
    if let Some(label) = &placeholder_label {
        let _ = app.emit(
            "dropzone-saving",
            serde_json::json!({ "tempId": file_id, "name": file_name, "label": label }),
        );
    }

    // 后台线程执行实际复制与快照，避免巨大文件阻塞命令/前台（保存秒结束）。
    let app_thread = app.clone();
    let source_path_t = source_path;
    let dest_path_t = dest_path;
    let extension_t = extension;
    let size_t = size;
    let timestamp_t = timestamp;
    let file_name_t = file_name;
    let temp_id_t = file_id;
    std::thread::spawn(move || {
        let move_src = move_source.unwrap_or(false);
        // 移动语义：优先 rename（同卷原子、零拷贝、磁盘不翻倍）；跨卷 rename 失败回退 copy+删源。
        // 移动/复制成功后尝试删除空的源会话文件夹（save_dir/<session_id>），避免残留空壳目录。
        let need_copy = if move_src {
            match std::fs::rename(&source_path_t, &dest_path_t) {
                Ok(_) => {
                    let _ = std::fs::remove_dir(
                        Path::new(&source_path_t).parent().unwrap_or_else(|| Path::new("")),
                    );
                    false
                }
                Err(_) => true,
            }
        } else {
            true
        };
        if need_copy {
            if std::fs::copy(&source_path_t, &dest_path_t).is_err() {
                let _ = app_thread.emit(
                    "dropzone-saving-done",
                    serde_json::json!({ "tempId": temp_id_t }),
                );
                return;
            }
            if move_src {
                let _ = std::fs::remove_file(&source_path_t);
                let _ = std::fs::remove_dir(
                    Path::new(&source_path_t).parent().unwrap_or_else(|| Path::new("")),
                );
            }
        }
        // 同时生成「存档」快照（设置「中转站 / 存档」：文件一拖入即快照，可恢复/删除）。
        // 超大文件（>100MB）跳过快照，避免整文件读入内存导致 OOM。
        if size_t <= 100 * 1024 * 1024 {
            let _ = transfer_station::archive_snapshot(
                &app_data,
                "file",
                &format!("{}", timestamp_t),
                &file_name_t,
                &std::fs::read(&dest_path_t).unwrap_or_default(),
                &extension_t,
            );
        }
        // 复制完成：广播真实文件已就位，并移除占位。
        let _ = app_thread.emit("dropzone-changed", ());
        let _ = app_thread.emit(
            "dropzone-saving-done",
            serde_json::json!({ "tempId": temp_id_t }),
        );
    });

    Ok(result)
}

/// 将文件导入「以安得云荟打开」固定临时目录。
///
/// 目录位于 `<app_data>/openwith/<module>/`，作为对应媒体模块的常驻库文件夹
/// （与右键「以安得云荟打开」行为一致）。复制（不移动）源文件，保留原始文件名。
///
/// `files` 每项：
/// - `{ kind: "path", path, name? }`：真实 OS 路径（右键打开 / 拖入中转站落地路径）
/// - `{ kind: "bytes", name, bytes }`：内存字节（HTML5 拖放的 Blob）
///
/// 返回固定目录路径与该目录下最终落地文件的绝对路径列表。
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum OpenWithItem {
    Path { path: String, name: Option<String> },
    Bytes { name: String, bytes: Vec<u8> },
}

#[derive(Serialize)]
pub struct OpenWithDirResult {
    dir: String,
    paths: Vec<String>,
}

#[tauri::command]
pub fn import_to_openwith_dir(
    app: tauri::AppHandle,
    module: String,
    files: Vec<OpenWithItem>,
) -> Result<OpenWithDirResult, String> {
    if module.is_empty() {
        return Err("module 不能为空".to_string());
    }
    let dir = openwith_module_dir(&app, &module)?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败: {}", e))?;

    let mut final_paths: Vec<String> = Vec::new();
    for item in files {
        let (file_name, data): (String, Vec<u8>) = match item {
            OpenWithItem::Path { path, name } => {
                let src = std::path::Path::new(&path);
                let name = name
                    .filter(|n| !n.is_empty())
                    .or_else(|| {
                        src.file_name()
                            .map(|n| n.to_string_lossy().to_string())
                    })
                    .ok_or_else(|| format!("无效路径: {}", path))?;
                let bytes = fs::read(&src).map_err(|e| format!("读取源文件失败: {}", e))?;
                (name, bytes)
            }
            OpenWithItem::Bytes { name, bytes } => (name, bytes),
        };
        let dest = dir.join(&file_name);
        fs::write(&dest, &data).map_err(|e| format!("写入临时目录失败: {}", e))?;
        final_paths.push(dest.to_string_lossy().to_string());
    }

    Ok(OpenWithDirResult {
        dir: dir.to_string_lossy().to_string(),
        paths: final_paths,
    })
}

/// 「以安得云荟打开」临时目录根：`<app_data>/openwith`
pub(crate) fn openwith_base_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("openwith"))
        .map_err(|e| format!("获取 app_data 失败: {}", e))
}

/// 指定模块的临时目录：`<app_data>/openwith/<module>`
pub(crate) fn openwith_module_dir(app: &tauri::AppHandle, module: &str) -> Result<PathBuf, String> {
    Ok(openwith_base_dir(app)?.join(module))
}

/// 清空「以安得云荟打开」临时目录（关软件即销毁，每次打开全新）。
/// 在应用启动与退出时调用；亦作为命令暴露以便按需清理。
#[tauri::command]
pub fn clear_openwith_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = openwith_base_dir(&app)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("清空临时目录失败: {}", e))?;
    }
    Ok(())
}

/// 读取中转站中的文本文件内容
#[tauri::command]
pub fn read_dropzone_file(app: tauri::AppHandle, stored_path: String) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file_path = app_data.join("transfer_station").join("dropzone").join(&stored_path);
    
    if !file_path.exists() {
        return Err(format!("文件不存在: {}", stored_path));
    }

    // 超大文本文件防护：避免一次性读入字符串导致卡死 / 内存溢出
    if let Ok(meta) = std::fs::metadata(&file_path) {
        if meta.len() > 20 * 1024 * 1024 {
            return Err("文件过大（>20MB），无法以文本预览，请下载后查看".into());
        }
    }

    std::fs::read_to_string(&file_path).map_err(|e| format!("读取文件失败: {}", e))
}

/// 列出中转站所有导入文件
#[tauri::command]
pub fn list_dropzone_files(app: tauri::AppHandle) -> Result<Vec<ImportedFile>, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dropzone_dir = app_data.join("transfer_station").join("dropzone");
    
    if !dropzone_dir.exists() {
        return Ok(Vec::new());
    }
    
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dropzone_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() { continue; }
            
            let file_name = entry.file_name().to_string_lossy().to_string();
            let metadata = entry.metadata().ok();
            let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
            
            // 从 file_id 中推断扩展名
            let extension = path.extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            let is_readable = READABLE_EXTENSIONS.contains(&extension.as_str());
            
            let imported_at = metadata.as_ref()
                .and_then(|m| m.modified().ok())
                .map(|t| {
                    let datetime: chrono::DateTime<chrono::Local> = t.into();
                    datetime.format("%Y-%m-%d %H:%M:%S").to_string()
                })
                .unwrap_or_else(|| "未知".to_string());
            
            // 从 file_id 中恢复原始文件名（去掉时间戳前缀）
            let original_name = file_name.splitn(2, '_').nth(1)
                .unwrap_or(&file_name)
                .to_string();
            
            files.push(ImportedFile {
                file_id: file_name.clone(),
                original_name,
                extension,
                size,
                stored_path: file_name.clone(),
                absolute_path: dropzone_dir.join(&file_name).to_string_lossy().to_string(),
                imported_at,
                is_readable,
            });
        }
    }
    
    Ok(files)
}

/// 删除中转站导入文件
#[tauri::command]
pub fn delete_dropzone_file(app: tauri::AppHandle, stored_path: String) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file_path = app_data.join("transfer_station").join("dropzone").join(&stored_path);
    
    if file_path.exists() {
        std::fs::remove_file(&file_path).map_err(|e| format!("删除文件失败: {}", e))?;
    }

    // 删除完成：广播事件让中转站实时刷新
    let _ = app.emit("dropzone-changed", ());

    Ok(())
}

/// 清空所有导入文件
#[tauri::command]
pub fn clear_dropzone(app: tauri::AppHandle) -> Result<u32, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dropzone_dir = app_data.join("transfer_station").join("dropzone");
    
    if !dropzone_dir.exists() {
        return Ok(0);
    }
    
    let mut count = 0u32;
    if let Ok(entries) = std::fs::read_dir(&dropzone_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                std::fs::remove_file(&path).ok();
                count += 1;
            }
        }
    }

    // 清空完成：广播事件让中转站实时刷新
    let _ = app.emit("dropzone-changed", ());

    Ok(count)
}

/// 以 base64 data URL 读取中转站文件（用于拖出到系统）。
#[tauri::command]
pub fn read_dropzone_base64(app: tauri::AppHandle, stored_path: String) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file_path = app_data
        .join("transfer_station")
        .join("dropzone")
        .join(&stored_path);
    // 超大文件防护：避免整文件读入内存 + base64 编码导致 OOM
    if let Ok(meta) = std::fs::metadata(&file_path) {
        if meta.len() > 50 * 1024 * 1024 {
            return Err("文件过大（>50MB），不支持 base64 导出，请使用右键「另存为」".into());
        }
    }
    let bytes = std::fs::read(&file_path).map_err(|e| format!("读取失败: {}", e))?;
    let mime = mime_from_ext(&stored_path);
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

/// 为「拖出到系统」准备一个带原始文件名的导出副本（写入系统临时目录），
/// 返回其绝对路径。前端据此以 text/uri-list(file://) 方式拖出“真实文件”，
/// 而非把 base64 编码当成文本写出。
#[tauri::command]
pub fn prepare_drop_export(
    app: tauri::AppHandle,
    stored_path: String,
    original_name: String,
) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let src = app_data
        .join("transfer_station")
        .join("dropzone")
        .join(&stored_path);
    if !src.exists() {
        return Err(format!("文件不存在: {}", stored_path));
    }
    let safe = sanitize_filename(&original_name);
    let dest = std::env::temp_dir().join(format!("andeng_export_{}", safe));
    std::fs::copy(&src, &dest).map_err(|e| format!("导出准备失败: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

// ================= 原生文档转换（docx / pptx / xlsx / pdf）=================

/// 将源文件复制到中转站「暂存」目录（图标栏中转站列出），并生成 file 存档快照。
/// 供「导入文档」等场景使用：解析文档时把原始文件本身存入中转站，而非解析出的图片。
pub fn copy_file_to_dropzone(
    app_data: &std::path::Path,
    source_path: &str,
    original_name: Option<&str>,
    content: Option<Vec<u8>>,
) -> Result<std::path::PathBuf, String> {
    use std::path::Path as P;
    use std::time::{SystemTime, UNIX_EPOCH};
    let source = P::new(source_path);
    let file_name = match original_name {
        Some(n) if !n.is_empty() => n.to_string(),
        _ => source
            .file_name()
            .ok_or_else(|| "无法获取文件名".to_string())?
            .to_string_lossy()
            .to_string(),
    };
    let extension = source
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let dropzone_dir = app_data.join("transfer_station").join("dropzone");
    std::fs::create_dir_all(&dropzone_dir).map_err(|e| format!("创建目录失败: {}", e))?;
    let dest = dropzone_dir.join(format!("{}_{}", timestamp, file_name));
    std::fs::copy(source_path, &dest).map_err(|e| format!("复制文件失败: {}", e))?;
    // 优先使用调用方已持有的内存字节（如刚编码好的 PNG），避免「写盘后又整文件读回」的冗余 I/O。
    // 超大文件跳过快照：与 import_to_dropzone 同一条红线 —— 快照要整文件读进内存，
    // 打开一个 2 GB 视频就会直接吃掉 2 GB 内存（这正是传输模块卡死的同款成因）。
    const SNAPSHOT_MAX_BYTES: u64 = 100 * 1024 * 1024;
    let snapshot_bytes: Option<Vec<u8>> = match content {
        Some(bytes) => Some(bytes),
        None => {
            let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
            if size <= SNAPSHOT_MAX_BYTES {
                std::fs::read(&dest).ok()
            } else {
                eprintln!(
                    "[中转站] 跳过大文件存档快照（{} MiB > {} MiB 上限）: {}",
                    size / 1024 / 1024,
                    SNAPSHOT_MAX_BYTES / 1024 / 1024,
                    file_name
                );
                None
            }
        }
    };
    if let Some(bytes) = snapshot_bytes {
        transfer_station::archive_snapshot(
            app_data,
            "file",
            &format!("{}", timestamp),
            &file_name,
            &bytes,
            &extension,
        );
    }
    Ok(dest)
}

/// 导入一张图片到「图标栏中转站」：把图片复制进 dropzone（生成 file 存档），
/// 并返回一个指向该副本的 `localimg://` 引用（笔记预览直接读取中转站副本，自包含）。
/// 这样「导入图片」既能在笔记里显示，也会出现在图标栏中转站。
#[tauri::command]
pub fn add_image_to_dropzone(
    app: tauri::AppHandle,
    source_path: String,
    original_name: Option<String>,
) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dest = copy_file_to_dropzone(&app_data, &source_path, original_name.as_deref(), None)?;
    let _ = app.emit("dropzone-changed", ());
    Ok(format!(
        "localimg://{}",
        crate::services::document_parser::js_encode_uri_component(&dest.to_string_lossy())
    ))
}

/// 同上，但接收前端 File 的 base64（HTML5 拖入/粘贴场景，暂无本地路径）。
#[tauri::command]
pub fn add_image_bytes_to_dropzone(
    app: tauri::AppHandle,
    base64: String,
    original_name: String,
) -> Result<String, String> {
    let bytes = base64
        .split(',')
        .nth(1)
        .unwrap_or(&base64)
        .as_bytes();
    let decoded = base64_decode(bytes).map_err(|e| format!("解码失败: {}", e))?;
    let tmp = std::env::temp_dir().join(format!(
        "andeng_img_{}_{}",
        uuid::Uuid::new_v4(),
        original_name
    ));
    std::fs::write(&tmp, &decoded).map_err(|e| format!("写临时文件失败: {}", e))?;
    let tmp_str = tmp.to_string_lossy().to_string();
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dest = copy_file_to_dropzone(&app_data, &tmp_str, Some(&original_name), None)?;
    let _ = std::fs::remove_file(&tmp);
    let _ = app.emit("dropzone-changed", ());
    Ok(format!(
        "localimg://{}",
        crate::services::document_parser::js_encode_uri_component(&dest.to_string_lossy())
    ))
}

/// 导入「文件字节」到图标栏中转站（HTML5 拖入场景：前端只有 File，没有本地路径）。
/// 把字节写入临时文件后复制进 dropzone（生成 file 存档），返回 ImportedFile 元信息。
#[tauri::command]
pub fn add_bytes_to_dropzone(
    app: tauri::AppHandle,
    base64: String,
    original_name: String,
) -> Result<ImportedFile, String> {
    let bytes = base64
        .split(',')
        .nth(1)
        .unwrap_or(&base64)
        .as_bytes();
    let decoded = base64_decode(bytes).map_err(|e| format!("解码失败: {}", e))?;
    let tmp = std::env::temp_dir().join(format!(
        "andeng_drop_{}_{}",
        uuid::Uuid::new_v4(),
        original_name
    ));
    std::fs::write(&tmp, &decoded).map_err(|e| format!("写临时文件失败: {}", e))?;
    let tmp_str = tmp.to_string_lossy().to_string();
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dest = copy_file_to_dropzone(&app_data, &tmp_str, Some(&original_name), None)?;
    let _ = std::fs::remove_file(&tmp);

    // 写入完成：广播事件让中转站实时刷新
    let _ = app.emit("dropzone-changed", ());

    let file_name = dest
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or(original_name.clone());
    let extension = dest
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    let is_readable = READABLE_EXTENSIONS.contains(&extension.as_str());
    let imported_at = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    Ok(ImportedFile {
        file_id: file_name.clone(),
        original_name,
        extension,
        size,
        stored_path: file_name.clone(),
        absolute_path: dest.to_string_lossy().to_string(),
        imported_at,
        is_readable,
    })
}

/// 「保存到…」：把中转站里的文件导出（复制）到用户用系统对话框选择的任意路径。
#[tauri::command]
pub fn export_dropzone_file(
    app: tauri::AppHandle,
    stored_path: String,
    dest_path: String,
) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let src = app_data
        .join("transfer_station")
        .join("dropzone")
        .join(&stored_path);
    if !src.exists() {
        return Err(format!("文件不存在: {}", stored_path));
    }
    std::fs::copy(&src, &dest_path).map_err(|e| format!("导出失败: {}", e))?;
    Ok(())
}

pub(crate) fn base64_decode(input: &[u8]) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(std::str::from_utf8(input).map_err(|e| format!("{}", e))?)
        .map_err(|e| format!("{}", e))
}

/// 读取文件并返回 data URL（base64），用于图片内嵌 / 文本解码
#[tauri::command]
pub fn read_file_base64(file_path: String) -> Result<String, String> {
    let bytes = std::fs::read(&file_path).map_err(|e| format!("读取失败: {}", e))?;
    let mime = mime_from_ext(&file_path);
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

pub(crate) fn sanitize_filename(name: &str) -> String {
    let illegal: &[char] = &['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
    let s: String = name.chars().filter(|c| !illegal.contains(c)).collect();
    if s.trim().is_empty() {
        "file".to_string()
    } else {
        s
    }
}

pub(crate) fn mime_from_ext(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}
