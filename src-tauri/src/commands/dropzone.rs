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
    /// 文件来源：`local` = 本机（拖入 / 导入 / 截图 / 录屏），
    /// `external` = 外部下载（huggingface、音乐、视频等）。
    ///
    /// 判定靠 sidecar 登记表 `<dropzone>/.origin.json`（只记 external，未登记一律 local）——
    /// **不靠猜**：扩展名/大小/目录都推断不出来源，猜错比不标更糟。
    pub origin: String,
}

/// 来源登记表文件名。以 `.` 开头，扫描列表时必须跳过（见 `list_dropzone_files`）。
const ORIGIN_FILE: &str = ".origin.json";

/// 读登记表。坏 JSON 当作空表（**坏数据不该让整个列表打不开**）。
pub(crate) fn read_origin_map(dropzone_dir: &std::path::Path) -> std::collections::HashMap<String, String> {
    let path = dropzone_dir.join(ORIGIN_FILE);
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str::<std::collections::HashMap<String, String>>(&s).unwrap_or_else(|e| {
            eprintln!("[中转站] 来源登记表解析失败（当作空表）: {} — {}", path.display(), e);
            Default::default()
        }),
        Err(_) => Default::default(),
    }
}

fn write_origin_map(
    dropzone_dir: &std::path::Path,
    map: &std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let path = dropzone_dir.join(ORIGIN_FILE);
    let s = serde_json::to_string_pretty(map).map_err(|e| format!("序列化来源表失败: {e}"))?;
    std::fs::write(&path, s).map_err(|e| format!("写入来源表失败: {e}"))
}

/// 给某个中转站文件打来源标签。
///
/// `path_or_id` 接受绝对路径或 file_id（两种调用方都常见）。
/// **只对已在中转站里的文件生效**：路径不在 dropzone 内就静默忽略并返回 false ——
/// 下载到别的目录的文件本来就不该出现在这个列表里。
#[tauri::command]
pub fn mark_dropzone_origin(
    app: tauri::AppHandle,
    path_or_id: String,
    origin: String,
) -> Result<bool, String> {
    let norm = if origin.eq_ignore_ascii_case("external") { "external" } else { "local" };
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dropzone_dir = app_data.join("transfer_station").join("dropzone");
    let input = std::path::PathBuf::from(&path_or_id);
    let file_id = if input.is_absolute() {
        let parent = input.parent().unwrap_or(&dropzone_dir);
        // 路径必须在 dropzone 内，否则不登记
        if parent.canonicalize().ok() != dropzone_dir.canonicalize().ok() {
            eprintln!("[中转站] 忽略来源登记（不在中转站内）: {}", path_or_id);
            return Ok(false);
        }
        input.file_name().map(|s| s.to_string_lossy().to_string())
    } else {
        Some(path_or_id.clone())
    };
    let Some(file_id) = file_id else { return Ok(false) };
    if !dropzone_dir.join(&file_id).exists() {
        eprintln!("[中转站] 忽略来源登记（文件不存在）: {}", file_id);
        return Ok(false);
    }
    let mut map = read_origin_map(&dropzone_dir);
    map.insert(file_id.clone(), norm.to_string());
    write_origin_map(&dropzone_dir, &map)?;
    eprintln!("[中转站] 来源登记 {} → {}", file_id, norm);
    Ok(true)
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
        // 这条路径是「用户导入/拖入」—— 一定是本机产生
        origin: "local".to_string(),
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

    // 后台线程执行实际复制，避免巨大文件阻塞命令/前台（保存秒结束）。
    //
    // ★ 这里**不再**顺手做一份存档快照。旧实现在导入时就 `fs::read` 整个文件塞进
    //   archives，后果是每个拖进来的文件都白占双份磁盘（40GB 视频 = 80GB），
    //   而用户根本没删它。真正的回收站语义是「删除时才归档」，
    //   由 `station_remove_record` 在移除托管条目时用流式复制完成。
    //   （截图侧早就这么判断了，见 screenshot.rs 的同类注释。）
    let app_thread = app.clone();
    let source_path_t = source_path;
    let dest_path_t = dest_path;
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

/// 「以安得云荟打开」时，超过这个大小就**不复制**、直接用原路径。
///
/// 为什么要有这条线：复制一个 2 GB 视频要读 2 GB + 写 2 GB，用户看到的是
/// 点了之后两三秒没反应 —— 而他要的是"立刻播放"。用户开一个自己的文件，
/// 本来也不需要我们先给他存一份。
///
/// 小文件仍然复制：几 MB 的东西复制是瞬时的，自包含（原文件被移走也能再看）。
const OPENWITH_COPY_LIMIT: u64 = 100 * 1024 * 1024;

/// 把「以安得云荟打开」的文件准备到临时目录。返回临时目录与每个文件的实际可播放路径。
///
/// ★ 曾经的实现有两个叠加的毛病，用户感知是"点了没反应两三秒"：
///   1. `fs::read` 把整个文件读进内存再 `fs::write` 出去 —— 2 GB 视频就是
///      2 GB 内存 + 2 GB 磁盘复制，而且全程在主线程；
///   2. 无论多大都复制一份，等于凭空多占一份磁盘。
///   现在：同步改异步（不冻界面）、小文件用 `fs::copy`（不进内存）、
///   大文件完全不复制（直接返回原路径）。
#[tauri::command]
pub async fn import_to_openwith_dir(
    app: tauri::AppHandle,
    module: String,
    files: Vec<OpenWithItem>,
) -> Result<OpenWithDirResult, String> {
    if module.is_empty() {
        return Err("module 不能为空".to_string());
    }
    let app_bg = app.clone();
    tokio::task::spawn_blocking(move || {
        let dir = openwith_module_dir(&app_bg, &module)?;
        fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败: {}", e))?;

        let mut final_paths: Vec<String> = Vec::new();
        for item in files {
            match item {
                OpenWithItem::Path { path, name } => {
                    let src = std::path::Path::new(&path);
                    let file_name = name
                        .filter(|n| !n.is_empty())
                        .or_else(|| {
                            src.file_name()
                                .map(|n| n.to_string_lossy().to_string())
                        })
                        .ok_or_else(|| format!("无效路径: {}", path))?;
                    if !src.is_file() {
                        return Err(format!("文件不存在: {}", path));
                    }
                    let size = fs::metadata(src).map(|m| m.len()).unwrap_or(0);
                    if size > OPENWITH_COPY_LIMIT {
                        // 大文件：不复制，直接用原路径。下面 `addRootPathEphemeral(dir)`
                        // 注册的临时目录里不会有它，但播放走的是这个路径，够用。
                        eprintln!(
                            "[OpenWith] 「{}」{:.1} MB 超过复制阈值 {:.0} MB，直接使用原路径",
                            file_name,
                            size as f64 / 1048576.0,
                            OPENWITH_COPY_LIMIT as f64 / 1048576.0
                        );
                        final_paths.push(path);
                        continue;
                    }
                    let dest = dir.join(&file_name);
                    // fs::copy 不把文件读进内存（对比原来的 read+write）
                    fs::copy(src, &dest).map_err(|e| format!("复制到临时目录失败: {}", e))?;
                    final_paths.push(dest.to_string_lossy().to_string());
                }
                OpenWithItem::Bytes { name, bytes } => {
                    let dest = dir.join(&name);
                    fs::write(&dest, &bytes).map_err(|e| format!("写入临时目录失败: {}", e))?;
                    final_paths.push(dest.to_string_lossy().to_string());
                }
            }
        }

        Ok(OpenWithDirResult {
            dir: dir.to_string_lossy().to_string(),
            paths: final_paths,
        })
    })
    .await
    .map_err(|e| format!("import_to_openwith_dir 任务失败: {e}"))?
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

/// `stored_path` 是否是安全的单段文件名。
///
/// ★ **安全边界**：只接受单段文件名。带分隔符、`..`、盘符、绝对路径一律拒绝。
///
/// 为什么必须显式校验：读/删/base64/导出这几个命令都是
/// `join("transfer_station").join("dropzone").join(stored_path)`。旧模型下目录边界
/// 确实兜住了（拼进来就出不去），但那是**靠"没人传坏值"**，不是写在代码里的约束。
/// 中转站一旦支持指向任意路径的条目，`stored_path = "../../../config.json"`
/// 就是一个任意文件读/删接口 —— 本项目 CSP 全放行、插件也能调命令，这不是理论风险。
///
/// 抽成纯函数是为了能单测：这类边界判定最怕写完没人验，等出事才发现 `..` 那条漏了。
pub(crate) fn is_safe_stored_path(stored_path: &str) -> bool {
    !(stored_path.is_empty()
        || stored_path.contains("..")
        || stored_path.contains('/')
        || stored_path.contains('\\')
        || stored_path.contains(':')
        || stored_path.contains('\0')
        || std::path::Path::new(stored_path).is_absolute())
}

fn dropzone_file(app: &tauri::AppHandle, stored_path: &str) -> Result<std::path::PathBuf, String> {
    if !is_safe_stored_path(stored_path) {
        eprintln!("[中转站] 拒绝非法文件名: {:?}", stored_path);
        return Err(format!("非法的中转站文件名: {}", stored_path));
    }
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(app_data
        .join("transfer_station")
        .join("dropzone")
        .join(stored_path))
}

/// 读取中转站中的文本文件内容
#[tauri::command]
pub fn read_dropzone_file(app: tauri::AppHandle, stored_path: String) -> Result<String, String> {
    let file_path = dropzone_file(&app, &stored_path)?;

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
    
    let origin_map = read_origin_map(&dropzone_dir);
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dropzone_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() { continue; }
            
            let file_name = entry.file_name().to_string_lossy().to_string();
            // ★ 跳过 sidecar / 系统隐藏文件：`.origin.json` 不是用户文件，
            //   不过滤的话它会以「来源登记表」的身份出现在中转站列表里。
            if file_name.starts_with('.') { continue; }
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
            
            let origin = origin_map
                .get(&file_name)
                .cloned()
                .unwrap_or_else(|| "local".to_string());
            files.push(ImportedFile {
                file_id: file_name.clone(),
                original_name,
                origin,
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

/// 删除中转站托管文件（**只对 dropzone 内的副本生效**，即 ownership = managed）。
///
/// 引用条目（下载到用户目录的文件）不在这里删——它们只收 id，走 `station_delete_file`。
#[tauri::command]
pub fn delete_dropzone_file(app: tauri::AppHandle, stored_path: String) -> Result<(), String> {
    let file_path = dropzone_file(&app, &stored_path)?;

    if file_path.exists() {
        std::fs::remove_file(&file_path).map_err(|e| format!("删除文件失败: {}", e))?;
    }

    // 删除完成：广播事件让中转站实时刷新
    let _ = app.emit("dropzone-changed", ());

    Ok(())
}

/// 清空所有**托管**文件（dropzone 目录里的副本）。
///
/// ★ 必须跳过 `.` 开头的 sidecar：`.station.json` 是索引本身，
///   把它删了会让所有条目的 id 重新生成，前端选中态、回收站还原全断。
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
            if !path.is_file() {
                continue;
            }
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            std::fs::remove_file(&path).ok();
            count += 1;
        }
    }

    // 清空完成：广播事件让中转站实时刷新
    let _ = app.emit("dropzone-changed", ());

    Ok(count)
}

/// 以 base64 data URL 读取中转站文件（用于拖出到系统）。
#[tauri::command]
pub fn read_dropzone_base64(app: tauri::AppHandle, stored_path: String) -> Result<String, String> {
    let file_path = dropzone_file(&app, &stored_path)?;
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
    let src = dropzone_file(&app, &stored_path)?;
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
    // `extension` 原本用于生成导入时的存档快照，那个行为已移除（见下方注释），
    // 但调用方签名保持不变；这里显式丢弃以免留下"看起来还在用"的假象。
    let _extension = source
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
    // `content` 保留在签名里只是为了不改动所有调用方；导入时不再据此生成存档快照。
    // （理由见 `import_to_dropzone`：新增文件不需要「旧版本存档」语义，
    //   回收站由删除路径 `station_remove_record` 用流式复制负责。）
    let _ = content;
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
        // 同上：这条路径也是本机写入
        origin: "local".to_string(),
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
    let src = dropzone_file(&app, &stored_path)?;
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

#[cfg(test)]
mod tests {
    use super::is_safe_stored_path;

    /// 这条测试是本次改造的安全底线：中转站一旦能指向任意路径，
    /// `stored_path` 就是攻击面，必须是一条**断言**而不是"应该没人传坏值"。
    #[test]
    fn rejects_path_traversal_and_absolute_paths() {
        assert!(!is_safe_stored_path("../../../config.json"));
        assert!(!is_safe_stored_path("..\\..\\credentials.json"));
        assert!(!is_safe_stored_path("/etc/passwd"));
        assert!(!is_safe_stored_path("C:\\Windows\\win.ini"));
        assert!(!is_safe_stored_path("a/b.txt"));
        assert!(!is_safe_stored_path("a\\b.txt"));
        assert!(!is_safe_stored_path(""));
        assert!(!is_safe_stored_path("dots..in..name"));
        // NUL 截断（Windows 上 `a\0b` 传给某些 API 会被截成 `a`）
        assert!(!is_safe_stored_path("a\0b"));
    }

    #[test]
    fn accepts_plain_file_names() {
        assert!(is_safe_stored_path("1700000000000_report.pdf"));
        assert!(is_safe_stored_path("带空格 的中文名.txt"));
        assert!(is_safe_stored_path("a.b.c.d"));
        // 点开头是允许的（列表层会跳过 sidecar，但"以点开头"本身不非法）
        assert!(is_safe_stored_path(".station.json"));
    }
}
