use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use crate::services::note_service;
use crate::services::transfer_station;
use crate::services::image_service;
use crate::services::music_service;
use crate::services::video_service;
use crate::services::cache_service;
use crate::services::document_parser;
use crate::services::reading_service;

// ========== 插件扫描缓存（避免每次启动/刷新都重扫文件系统） ==========
static PLUGIN_SCAN_CACHE: once_cell::sync::Lazy<Mutex<Option<(PluginScanResult, SystemTime)>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

// ========== 路径解析：统一开发期与打包后的插件/依赖目录 ==========
// 开发时 resource_dir() = src-tauri/，打包后 resource_dir() = 安装目录
// 开发时插件在 项目根/bundled-plugins/，打包后在 安装目录/bundled-plugins/

/// 获取内置插件目录（bundled-plugins/）
/// 打包后：resource_dir/bundled-plugins/ 或 resource_dir/_up_/bundled-plugins/
///   （Tauri 对 bundle.resources 中 "../bundled-plugins" 会保留 _up_ 前缀）
/// 开发时：resource_dir/../bundled-plugins/（resource_dir 是 src-tauri/）
pub fn get_bundled_plugins_dir(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    // 打包后：直接路径
    let bundled = resource_dir.join("bundled-plugins");
    if bundled.exists() {
        return Some(bundled);
    }
    // 打包后 NSIS 备选：_up_/bundled-plugins/
    let up_bundled = resource_dir.join("_up_").join("bundled-plugins");
    if up_bundled.exists() {
        return Some(up_bundled);
    }
    // 开发时（resource_dir = src-tauri/，向上一层到项目根）
    let dev_bundled = resource_dir.join("..").join("bundled-plugins");
    if dev_bundled.exists() {
        return Some(dev_bundled);
    }
    None
}

/// 获取外部依赖目录（external-deps/）
/// 打包后：resource_dir/external-deps/ 或 resource_dir/_up_/external-deps/
/// 开发时：resource_dir/../external-deps/
pub fn get_external_deps_dir(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let deps = resource_dir.join("external-deps");
    if deps.exists() {
        return Some(deps);
    }
    let up_deps = resource_dir.join("_up_").join("external-deps");
    if up_deps.exists() {
        return Some(up_deps);
    }
    let dev_deps = resource_dir.join("..").join("external-deps");
    if dev_deps.exists() {
        return Some(dev_deps);
    }
    // 开发模式兜底：CARGO_MANIFEST_DIR（编译期常量，= src-tauri/ 绝对路径）
    // ../external-deps = 项目根 external-deps/。release 在用户机器上此路径不存在，exists() 返回 false 自动跳过。
    let manifest_deps = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("external-deps");
    if manifest_deps.exists() {
        return Some(manifest_deps);
    }
    None
}

/// 获取用户插件目录（user_plugins/，始终在 AppData 下，用于第三方插件）
pub fn get_user_plugins_dir(app: &AppHandle) -> Option<PathBuf> {
    let app_data = app.path().app_data_dir().ok()?;
    Some(app_data.join("user_plugins"))
}

// ========== 插件可见性持久化 ==========
// 禁用状态持久化到 AppData/plugin_visibility.json（一个简单的 id→bool 映射）。
// 这样 bundled-plugins/ 在打包后即使只读（Program Files）也能正常启用/禁用插件，
// 且不污染源码 manifest.json。get_installed_plugins 读取此文件覆盖 manifest.visible。

/// 读取 plugin_visibility.json，返回 id→visible 映射
fn load_plugin_visibility_map(app: &AppHandle) -> std::collections::HashMap<String, bool> {
    let map = std::collections::HashMap::new();
    let app_data = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => return map,
    };
    let path = app_data.join("plugin_visibility.json");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return map,
    };
    match serde_json::from_str::<std::collections::HashMap<String, bool>>(&content) {
        Ok(m) => m,
        Err(_) => map,
    }
}

/// 写入单个插件的可见性到 plugin_visibility.json（合并已有记录）
fn save_plugin_visibility(app: &AppHandle, plugin_id: &str, visible: bool) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| format!("获取 app_data_dir 失败: {}", e))?;
    std::fs::create_dir_all(&app_data).map_err(|e| format!("创建 app_data_dir 失败: {}", e))?;
    let path = app_data.join("plugin_visibility.json");
    let mut map = load_plugin_visibility_map(app);
    map.insert(plugin_id.to_string(), visible);
    let content = serde_json::to_string_pretty(&map).map_err(|e| format!("序列化失败: {}", e))?;
    std::fs::write(&path, content).map_err(|e| format!("写入 plugin_visibility.json 失败: {}", e))?;
    Ok(())
}

// ================= 原有的笔记服务函数 =================
fn notes_root_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {}", e))?;
    Ok(dir)
}

#[tauri::command]
pub fn get_all_notes(app: AppHandle) -> Result<Vec<note_service::NoteInfo>, String> {
    let root_dir = notes_root_dir(&app)?;
    let notes_dir = root_dir.join("notes");
    let pins_dir = root_dir.join("pins");
    note_service::get_all_notes(notes_dir, pins_dir)
}

#[tauri::command]
pub fn search_notes_content(app: AppHandle, query: String) -> Result<Vec<String>, String> {
    let root_dir = notes_root_dir(&app)?;
    let notes_dir = root_dir.join("notes");
    note_service::search_notes_content(notes_dir, &query)
}

#[tauri::command]
pub fn get_note_content(app: AppHandle, note_id: &str) -> Result<Value, String> {
    let root_dir = notes_root_dir(&app)?;
    let notes_dir = root_dir.join("notes");
    note_service::get_note_content(notes_dir, note_id)
}

#[tauri::command]
pub fn save_note(app: AppHandle, note_id: &str, title: &str, content: &str) -> Result<(), String> {
    let root_dir = notes_root_dir(&app)?;
    let notes_dir = root_dir.join("notes");
    let note_path = crate::services::safe_join_ext(&notes_dir, note_id, "md")?;

    // 中转站自动备份：首次保存时备份原文件
    let config = transfer_station::load_config(&root_dir);
    if config.enabled {
        log::debug!(
            "[SaveNote] 自动保存已启用: note_id={}, title={}, content_len={}",
            note_id, title, content.len()
        );
        if note_path.exists() {
            let original = fs::read_to_string(&note_path).unwrap_or_default();
            match transfer_station::backup_original(&root_dir, note_id, &original) {
                Ok(Some(name)) => {
                    log::debug!("[SaveNote] 首次备份成功: backup={}", name);
                }
                Ok(None) => {
                    log::debug!("[SaveNote] 已有备份，跳过备份步骤");
                }
                Err(e) => {
                    log::warn!("[SaveNote] 备份失败（不影响主流程）: {}", e);
                }
            }
        } else {
            log::debug!("[SaveNote] 新文件首次保存: note_id={}, 无原文件可备份", note_id);
        }
        match transfer_station::save_to_transfer_station(&root_dir, note_id, content) {
            Ok(()) => {
                log::debug!("[SaveNote] 中转站同步完成: note_id={}", note_id);
            }
            Err(e) => {
                log::warn!("[SaveNote] 中转站同步失败（不影响主流程）: {}", e);
            }
        }
    } else {
        log::debug!(
            "[SaveNote] 自动保存已禁用，跳过中转站备份: note_id={}",
            note_id
        );
    }

    note_service::save_note(notes_dir, note_id, title, content)
}

#[tauri::command]
pub fn toggle_pin_note(app: AppHandle, note_id: String) -> Result<String, String> {
    let root_dir = notes_root_dir(&app)?;
    let pins_dir = root_dir.join("pins");
    let pin_path = crate::services::safe_join_ext(&pins_dir, &note_id, "pin")?;
    if pin_path.exists() {
        std::fs::remove_file(&pin_path).map_err(|e| format!("取消置顶失败: {}", e))?;
        Ok("unpinned".to_string())
    } else {
        std::fs::create_dir_all(&pins_dir).map_err(|e| format!("创建置顶目录失败: {}", e))?;
        std::fs::write(&pin_path, chrono::Utc::now().to_rfc3339()).map_err(|e| format!("置顶失败: {}", e))?;
        Ok("pinned".to_string())
    }
}

#[tauri::command]
pub fn delete_note(app: AppHandle, note_id: String) -> Result<(), String> {
    let root_dir = notes_root_dir(&app)?;
    let notes_dir = root_dir.join("notes");
    let trash_dir = root_dir.join("trash_notes");
    let result = note_service::delete_note(notes_dir, trash_dir, &note_id);
    // 清理对应的 pin 文件
    if let Ok(pin_path) = crate::services::safe_join_ext(&root_dir.join("pins"), &note_id, "pin") {
        if pin_path.exists() {
            let _ = std::fs::remove_file(&pin_path);
        }
    }
    result
}

#[tauri::command]
pub fn get_note_tags(app: AppHandle, note_id: String) -> Result<Vec<String>, String> {
    let root_dir = notes_root_dir(&app)?;
    let tags_path = root_dir.join("tags.json");
    note_service::get_note_tags(tags_path, &note_id)
}

#[tauri::command]
pub fn set_note_tags(app: AppHandle, note_id: String, tags: Vec<String>) -> Result<(), String> {
    let root_dir = notes_root_dir(&app)?;
    let tags_path = root_dir.join("tags.json");
    note_service::set_note_tags(tags_path, &note_id, tags)
}

#[tauri::command]
pub fn get_all_tags(app: AppHandle) -> Result<Vec<String>, String> {
    let root_dir = notes_root_dir(&app)?;
    let tags_path = root_dir.join("tags.json");
    note_service::get_all_tags(tags_path)
}

#[tauri::command]
pub fn get_all_note_tags_map(app: AppHandle) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    let root_dir = notes_root_dir(&app)?;
    let tags_path = root_dir.join("tags.json");
    note_service::get_all_note_tags_map(tags_path)
}

/// 创建浮窗笔记子窗口（已迁移到前端 WebviewWindow API，见 src/lib/api.ts）
/// Windows 上若用命令内 run_on_main_thread 同步 build()，会因 WebView2 创建
/// 完成回调需被同一消息循环派发而该闭包正占用消息循环，导致主线程重入死锁、
/// 整个应用卡死。故浮窗改由前端创建，此处不再保留该命令。
#[tauri::command]
pub fn duplicate_note(app: AppHandle, note_id: String) -> Result<String, String> {
    let root_dir = notes_root_dir(&app)?;
    let notes_dir = root_dir.join("notes");
    note_service::duplicate_note(notes_dir, &note_id)
}

// ================= 插件相关新命令 =================

/// 插件 manifest 结构（与 extensions/{id}/manifest.json 对应）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: String,           // "module" | "service"
    pub visible: bool,
    pub entry: String,          // 入口文件名，如 "index.js"
    pub icon_name: String,      // lucide 图标名，如 "Music2"
    pub host_api_version: u32,
    #[serde(default)]
    pub parent: Option<String>, // 子插件归属的父模块 id（如 "niaoluo" / "professional"）
    #[serde(default)]
    pub path: String,           // 相对 extensions/ 的路径（"/" 分隔），用于嵌套子插件读取
    #[serde(default)]
    pub deps: Vec<String>,     // 依赖的其它插件 id（缺一则拒绝加载，reason 提示）
    #[serde(default)]
    pub min_app_version: String,// 要求的最低应用版本（如 "1.2.0"），为空表示不限制
    #[serde(default)]
    pub codename: String,       // 模块代号（如 "铃兰"、"莲花"），为空表示无代号
    #[serde(default)]
    pub required_assets: Vec<String>, // 需要的外部依赖资源路径（如 "niaoluo/ide/codemirror/index.js"）
    #[serde(default)]
    pub capabilities: Vec<String>,    // 插件能力声明（如 "file-system"、"network"）
}

/// 扫描结果：有效插件 + 被拒绝的插件
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginScanResult {
    pub valid: Vec<PluginManifest>,
    pub rejected: Vec<RejectedPlugin>,
}

/// 被拒绝的插件信息
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedPlugin {
    pub folder_name: String,
    pub reason: String,
}

/// 语义化版本比较：返回 a < b（按点分数字逐段比较，非数字段视为 0）
fn version_lt(a: &str, b: &str) -> bool {
    let pa: Vec<u32> = a.split('.').filter_map(|x| x.parse::<u32>().ok()).collect();
    let pb: Vec<u32> = b.split('.').filter_map(|x| x.parse::<u32>().ok()).collect();
    let n = pa.len().max(pb.len());
    for i in 0..n {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        if x != y {
            return x < y;
        }
    }
    false
}

/// 校验 requiredAssets：检查 external-deps 下是否存在 manifest 声明的外部依赖资源。
/// 使用 get_external_deps_dir 统一路径解析（开发时项目根/external-deps，打包后 resource_dir/external-deps）。
/// 缺失任一资源即返回 Err（含缺失清单），调用方应将插件加入 rejected 列表，
/// 避免运行时才发现依赖缺失导致白屏（ide 的 CodeMirror / wps 的 tiptap 等）。
fn validate_required_assets(app: &tauri::AppHandle, manifest: &PluginManifest) -> Result<(), String> {
    if manifest.required_assets.is_empty() {
        return Ok(());
    }
    let deps_dir = get_external_deps_dir(app)
        .ok_or_else(|| "无法解析 external-deps 目录".to_string())?;
    let mut missing: Vec<&String> = Vec::new();
    for asset in &manifest.required_assets {
        let rel = asset.trim_start_matches(['/', '\\']);
        if !deps_dir.join(rel).exists() {
            missing.push(asset);
        }
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "缺失外部依赖资源: {}（在 external-deps 下未找到）",
            missing.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
        ))
    }
}

/// 获取两个插件目录中最近修改时间（秒），用于缓存失效判断
fn plugins_max_mtime(app: &AppHandle) -> u64 {
    let dirs: Vec<PathBuf> = [
        get_bundled_plugins_dir(app),
        get_user_plugins_dir(app),
    ].into_iter().flatten().collect();
    let mut max = 0u64;
    for d in &dirs {
        if let Ok(meta) = std::fs::metadata(d) {
            if let Ok(modified) = meta.modified() {
                if let Ok(dur) = modified.duration_since(std::time::UNIX_EPOCH) {
                    max = max.max(dur.as_secs());
                }
            }
        }
    }
    // 递归子目录的 mtime（新增/删除插件子目录会更新父目录 mtime）
    for d in &dirs {
        if let Ok(entries) = std::fs::read_dir(d) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if let Ok(dur) = modified.duration_since(std::time::UNIX_EPOCH) {
                            max = max.max(dur.as_secs());
                        }
                    }
                }
            }
        }
    }
    max
}

/// 扫描 bundled-plugins/ 与 user_plugins/ 下所有子目录，校验 manifest.json 并返回有效 + 被拒绝的插件列表
/// 阶段 0：Rust 端完成 manifest 存在性、解析、必填字段、版本与依赖校验
/// 结果会被缓存，仅当插件目录 mtime 变化时重新扫描
#[tauri::command]
pub fn get_installed_plugins(app: tauri::AppHandle) -> Result<PluginScanResult, String> {
    let current_mtime = plugins_max_mtime(&app);

    // 检查缓存
    if let Ok(cache) = PLUGIN_SCAN_CACHE.lock() {
        if let Some((ref cached, ref cached_time)) = *cache {
            if *cached_time >= SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(current_mtime) {
                return Ok(cached.clone());
            }
        }
    }

    // 早期返回：bundled-plugins 与 user_plugins 两个根目录都不存在才认为无插件
    // 顺序：user_plugins（用户态）优先于 bundled-plugins（打包），用户插件可覆盖打包插件
    let ext = get_bundled_plugins_dir(&app);
    let usr = get_user_plugins_dir(&app);
    if ext.is_none() && usr.is_none() {
        return Ok(PluginScanResult { valid: vec![], rejected: vec![] });
    }

    let mut valid = Vec::new();
    let mut rejected = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();

    // 加载用户可见性覆盖（AppData/plugin_visibility.json）
    // 优先级：plugin_visibility.json > manifest.json 的 visible 字段
    let visibility_map = load_plugin_visibility_map(&app);

    // 递归收集 bundled-plugins/ 与 user_plugins/ 下所有 manifest.json
    // （user_plugins 用于第三方插件，不会被版本更新清空）
    let mut manifest_files: Vec<(std::path::PathBuf, String)> = Vec::new();
    fn walk(
        dir: &std::path::Path,
        base: &std::path::Path,
        out: &mut Vec<(std::path::PathBuf, String)>,
    ) {
        // 根目录（dir == base）下的 manifest.json 是插件清单（bundled-plugins 清单副本），
        // 不是单个插件的 manifest，必须跳过，否则会用 PluginManifest（version: String）
        // 解析清单的 "version": 1（整数）导致反序列化失败。
        // 仅对非根目录才检查 manifest.json 作为插件根标志。
        let is_root = dir == base;
        if !is_root {
            let self_manifest = dir.join("manifest.json");
            if self_manifest.exists() {
                if let Ok(rel) = dir.strip_prefix(base) {
                    let rel_str = rel
                        .components()
                        .map(|c| c.as_os_str().to_string_lossy().to_string())
                        .collect::<Vec<_>>()
                        .join("/");
                    out.push((self_manifest, rel_str));
                }
                return;
            }
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    walk(&entry.path(), base, out);
                }
            }
        }
    }
    // user_plugins 优先（用户覆盖打包）；再扫 bundled-plugins
    if let Some(ref usr) = usr { walk(usr, usr, &mut manifest_files); }
    if let Some(ref ext) = ext { walk(ext, ext, &mut manifest_files); }

    for (manifest_path, rel_path) in manifest_files {
        let folder_name = manifest_path
            .parent()
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        // 读取 manifest
        let content = match std::fs::read_to_string(&manifest_path) {
            Ok(c) => c,
            Err(e) => {
                rejected.push(RejectedPlugin {
                    folder_name,
                    reason: format!("manifest.json 读取失败: {}", e),
                });
                continue;
            }
        };

        // 解析 JSON
        let mut manifest: PluginManifest = match serde_json::from_str(&content) {
            Ok(m) => m,
            Err(e) => {
                rejected.push(RejectedPlugin {
                    folder_name,
                    reason: format!("manifest.json JSON 解析失败: {}", e),
                });
                continue;
            }
        };
        // 记录相对路径（嵌套子插件如 "niaoluo/gongjuxiang"），供 read_plugin_file 使用
        manifest.path = rel_path;

        // 必填字段校验
        let mut missing = Vec::new();
        if manifest.id.is_empty() { missing.push("id"); }
        if manifest.name.is_empty() { missing.push("name"); }
        if manifest.kind.is_empty() { missing.push("kind"); }
        if manifest.entry.is_empty() { missing.push("entry"); }
        if !missing.is_empty() {
            rejected.push(RejectedPlugin {
                folder_name,
                reason: format!("缺少必填字段: {}", missing.join(", ")),
            });
            continue;
        }

        // id 重复检测
        if seen_ids.contains(&manifest.id) {
            rejected.push(RejectedPlugin {
                folder_name,
                reason: format!("插件 id '{}' 重复，已跳过", manifest.id),
            });
            eprintln!("[PluginScanner] 警告：重复的插件 id '{}'，已跳过", manifest.id);
            continue;
        }
        // 最低应用版本校验（在标记为已见之前，失败则不计入）
        if !manifest.min_app_version.is_empty()
            && version_lt(env!("CARGO_PKG_VERSION"), &manifest.min_app_version)
        {
            rejected.push(RejectedPlugin {
                folder_name,
                reason: format!(
                    "需要应用版本 >= {}（当前 {}）",
                    manifest.min_app_version,
                    env!("CARGO_PKG_VERSION")
                ),
            });
            continue;
        }
        // requiredAssets 校验：检查 external-deps 下是否存在声明的资源（ide 的 CodeMirror / wps 的 tiptap）。
        // 缺失时拒绝插件，避免运行时白屏。空列表直接通过。
        if let Err(reason) = validate_required_assets(&app, &manifest) {
            rejected.push(RejectedPlugin {
                folder_name,
                reason,
            });
            continue;
        }
        // 依赖校验：manifest.deps 在此架构中专指「外部依赖」(external-deps)，
        // 如 "tiptap" / "codemirror"，由 read_external_dep_file 在运行时按需加载，
        // 并不对应某个插件 id。外部依赖随包或 app_data 始终可用，缺失时插件自身会
        // 弹错误面板（见 WpsEditor 的 tErr 分支），因此这里不应以「插件 id」去校验，
        // 否则会把 wps/ide 这类声明了 external-deps 的插件整条拒绝掉（表现为在茑萝里消失）。
        // 故不再做 missing_deps 拒绝。

        seen_ids.insert(manifest.id.clone());

        // 应用用户可见性覆盖（AppData/plugin_visibility.json 优先于 manifest.json）
        if let Some(override_visible) = visibility_map.get(&manifest.id) {
            manifest.visible = *override_visible;
        }

        valid.push(manifest);
    }

    let result = PluginScanResult { valid, rejected };
    if let Ok(mut cache) = PLUGIN_SCAN_CACHE.lock() {
        *cache = Some((result.clone(), SystemTime::now()));
    }
    Ok(result)
}

/// 根据插件 id 在 bundled-plugins/ 与 user_plugins/ 下递归查找其所在目录。
/// 前端只需传入 manifest 中的干净 id，Rust 端自动定位真实路径。
fn find_plugin_root(app: &tauri::AppHandle, plugin_id: &str) -> Result<std::path::PathBuf, String> {
    // 搜索顺序：user_plugins（第三方）优先，bundled-plugins（内置）兜底
    let roots: Vec<PathBuf> = [
        get_user_plugins_dir(app),
        get_bundled_plugins_dir(app),
    ].into_iter().flatten().collect();
    fn walk(dir: &std::path::Path, plugin_id: &str, out: &mut Option<std::path::PathBuf>) {
        if out.is_some() {
            return;
        }
        let self_manifest = dir.join("manifest.json");
        if self_manifest.exists() {
            if let Ok(content) = std::fs::read_to_string(&self_manifest) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                    if v.get("id").and_then(|x| x.as_str()) == Some(plugin_id) {
                        *out = Some(dir.to_path_buf());
                        return;
                    }
                }
            }
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, plugin_id, out);
                    if out.is_some() {
                        return;
                    }
                }
            }
        }
    }
    let mut found = None;
    for base in roots.iter() {
        if base.exists() {
            walk(base, plugin_id, &mut found);
            if found.is_some() {
                break;
            }
        }
    }
    found.ok_or_else(|| format!("未找到 id 为 '{}' 的插件目录", plugin_id))
}

#[tauri::command]
pub fn read_plugin_file(app: tauri::AppHandle, plugin_id: String, file_name: String) -> Result<String, String> {
    let root = find_plugin_root(&app, &plugin_id)?;
    let file_path = root.join(&file_name);
    std::fs::read_to_string(&file_path).map_err(|e| format!("读取插件文件失败: {}", e))
}

/// 读取「外部依赖」(external-deps) 下的文件内容（IDE 的 CodeMirror 等重量级依赖按需从此加载，
/// 不打包进插件本体，保持插件文件夹轻量）。relative_path 为相对于 external-deps 的路径，含越界防护。
///
/// 使用 get_external_deps_dir 统一路径解析：
/// 开发时：项目根/external-deps/
/// 打包后：resource_dir/external-deps/
#[tauri::command]
pub fn read_external_dep_file(app: tauri::AppHandle, relative_path: String) -> Result<String, String> {
    let root = get_external_deps_dir(&app)
        .ok_or_else(|| "无法解析 external-deps 目录".to_string())?;
    let rel = relative_path.trim_start_matches(['/', '\\']);
    let file_path = root.join(rel);
    // 越界防护：canonicalize 后确保在 root 之下
    let root_canon = root.canonicalize().unwrap_or_else(|_| root.clone());
    if let Ok(canonical) = file_path.canonicalize() {
        if !canonical.starts_with(&root_canon) {
            return Err(format!("越界访问被拒绝: {}", relative_path));
        }
        match std::fs::read_to_string(&canonical) {
            Ok(content) => return Ok(content),
            Err(e) => return Err(format!("读取外部依赖文件失败: {}", e)),
        }
    }
    Err(format!("外部依赖文件不存在: {}", relative_path))
}

// ================= 中转站自动保存命令 =================

/// 配置自动保存（启用/禁用 + 间隔秒数）
#[tauri::command]
pub fn configure_auto_save(app: tauri::AppHandle, enabled: bool, interval_secs: u64) -> Result<(), String> {
    let root_dir = notes_root_dir(&app)?;
    let config = transfer_station::AutoSaveConfig { enabled, interval_secs };
    transfer_station::save_config(&root_dir, &config)
}

/// 获取当前自动保存配置
#[tauri::command]
pub fn get_auto_save_config(app: tauri::AppHandle) -> Result<transfer_station::AutoSaveConfig, String> {
    let root_dir = notes_root_dir(&app)?;
    Ok(transfer_station::load_config(&root_dir))
}

// ================= 插件管理命令 =================

/// 设置插件可见性（启用/禁用，立即生效）
/// 持久化到 AppData/plugin_visibility.json，不修改 manifest.json
/// （bundled-plugins/ 打包后可能只读，且不污染源码）
#[tauri::command]
pub fn set_plugin_visibility(app: tauri::AppHandle, plugin_id: String, visible: bool) -> Result<(), String> {
    // 校验插件存在
    find_plugin_root(&app, &plugin_id)?;
    // 持久化到 AppData/plugin_visibility.json
    save_plugin_visibility(&app, &plugin_id, visible)?;
    // 清除扫描缓存，让下次 get_installed_plugins 重新读取可见性
    if let Ok(mut cache) = PLUGIN_SCAN_CACHE.lock() {
        *cache = None;
    }
    eprintln!(
        "[PluginVisibility] 插件 '{}' visible={}, 已持久化到 plugin_visibility.json",
        plugin_id, visible
    );
    Ok(())
}

/// 强制刷新插件扫描缓存并重新扫描全部目录（响应「检测新插件」按钮）
#[tauri::command]
pub fn refresh_plugins(app: tauri::AppHandle) -> Result<PluginScanResult, String> {
    if let Ok(mut cache) = PLUGIN_SCAN_CACHE.lock() {
        *cache = None;
    }
    get_installed_plugins(app)
}

/// 热重载插件：校验 id 存在后，向前端派发 `plugin-reload` 事件，
/// 由 PluginHost 在应用内重新读取 manifest + 入口脚本并执行（无需重启）。
#[tauri::command]
pub fn reload_plugin(app: tauri::AppHandle, plugin_id: String) -> Result<(), String> {
    find_plugin_root(&app, &plugin_id)?;
    app.emit("plugin-reload", plugin_id)
        .map_err(|e| format!("派发 reload 事件失败: {}", e))
}

/// 热卸载插件：校验 id 存在后，向前端派发 `plugin-unload` 事件，
/// 由 PluginHost 在应用内从注册表移除该插件（无需重启）。
#[tauri::command]
pub fn unload_plugin(app: tauri::AppHandle, plugin_id: String) -> Result<(), String> {
    find_plugin_root(&app, &plugin_id)?;
    app.emit("plugin-unload", plugin_id)
        .map_err(|e| format!("派发 unload 事件失败: {}", e))
}

// ================= 中转站管理命令 =================

/// 中转站文件信息
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferStationFile {
    pub file_id: String,
    pub file_name: String,
    pub size: u64,
    pub modified: String,
    pub is_backup: bool,
}

/// 列出中转站所有文件（当前版本 + 备份）
#[tauri::command]
pub fn list_transfer_station_files(app: tauri::AppHandle) -> Result<Vec<TransferStationFile>, String> {
    let root_dir = notes_root_dir(&app)?;
    let ts_dir = root_dir.join("transfer_station");
    let backups_dir = ts_dir.join("backups");

    let mut files = Vec::new();

    // 扫描当前版本文件
    if ts_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&ts_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let metadata = entry.metadata().ok();
                    let file_name = entry.file_name().to_string_lossy().to_string();
                    let file_id = path.file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    files.push(TransferStationFile {
                        file_id,
                        file_name: file_name.clone(),
                        size: metadata.as_ref().map(|m| m.len()).unwrap_or(0),
                        modified: format_system_time(metadata.as_ref().and_then(|m| m.modified().ok())),
                        is_backup: false,
                    });
                }
            }
        }
    }

    // 扫描备份文件
    if backups_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&backups_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let metadata = entry.metadata().ok();
                    let file_name = entry.file_name().to_string_lossy().to_string();
                    let file_id = path.file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    files.push(TransferStationFile {
                        file_id,
                        file_name: file_name.clone(),
                        size: metadata.as_ref().map(|m| m.len()).unwrap_or(0),
                        modified: format_system_time(metadata.as_ref().and_then(|m| m.modified().ok())),
                        is_backup: true,
                    });
                }
            }
        }
    }

    Ok(files)
}

fn format_system_time(time: Option<std::time::SystemTime>) -> String {
    time.map(|t| {
        let datetime: chrono::DateTime<chrono::Local> = t.into();
        datetime.format("%Y-%m-%d %H:%M:%S").to_string()
    }).unwrap_or_else(|| "未知".to_string())
}

// ================= 托盘模式命令 =================

/// 切换托盘模式（启用/禁用点击关闭按钮时隐藏到托盘）
#[tauri::command]
pub fn toggle_tray_mode(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let root_dir = notes_root_dir(&app)?;
    let config_path = root_dir.join("tray_config.json");

    let config = serde_json::json!({ "enabled": enabled });
    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("序列化托盘配置失败: {}", e))?;
    std::fs::write(&config_path, &content)
        .map_err(|e| format!("写入托盘配置失败: {}", e))?;

    // 更新内存状态
    {
        let state = app.state::<std::sync::Mutex<crate::TrayModeState>>();
        // mutex 中毒（其他线程 panic）时恢复数据，避免二次 panic 导致进程崩溃
        let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
        guard.enabled = enabled;
    }

    log::info!(
        "[TrayMode] 托盘模式已{}，关闭窗口时将{}",
        if enabled { "启用" } else { "禁用" },
        if enabled { "隐藏到托盘" } else { "直接退出" }
    );
    Ok(())
}

/// 获取当前托盘模式配置
#[tauri::command]
pub fn get_tray_mode(app: tauri::AppHandle) -> Result<bool, String> {
    let root_dir = notes_root_dir(&app)?;
    let config_path = root_dir.join("tray_config.json");

    if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("读取托盘配置失败: {}", e))?;
        let config: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("解析托盘配置失败: {}", e))?;
        Ok(config.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false))
    } else {
        Ok(false)
    }
}

// ================= 导出备份命令 =================

/// 导出所有笔记到指定 zip 路径
#[tauri::command]
pub fn export_backup(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let root_dir = notes_root_dir(&app)?;
    let notes_dir = root_dir.join("notes");

    if !notes_dir.exists() {
        return Err("没有可导出的笔记".to_string());
    }

    // 使用 std::fs 递归拷贝 notes 目录到临时目录，再打包为 zip
    let tmp_dir = root_dir.join("_export_tmp");
    if tmp_dir.exists() {
        std::fs::remove_dir_all(&tmp_dir).map_err(|e| format!("清理临时目录失败: {}", e))?;
    }
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;

    // 递归拷贝
    copy_dir(&notes_dir, &tmp_dir.join("notes"))?;

    // 使用系统命令创建 zip（Windows 内置）
    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile", "-Command",
            &format!(
                "Compress-Archive -Path '{}' -DestinationPath '{}' -Force",
                tmp_dir.join("notes").display(),
                path,
            ),
        ])
        .output()
        .map_err(|e| format!("执行打包命令失败: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("打包失败: {}", err));
    }

    // 清理临时目录
    let _ = std::fs::remove_dir_all(&tmp_dir);

    eprintln!("[ExportBackup] 备份导出成功: {}", path);
    Ok(())
}

fn copy_dir(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建目录失败: {}", e))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("读取目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let path = entry.path();
        let dest = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir(&path, &dest)?;
        } else {
            std::fs::copy(&path, &dest).map_err(|e| format!("复制文件失败: {}", e))?;
        }
    }
    Ok(())
}

// ================= 中转站交互命令 =================

/// 从中转站还原文件到笔记目录
#[tauri::command]
pub fn restore_transfer_station_file(
    app: tauri::AppHandle,
    file_name: String,
    is_backup: bool,
) -> Result<(), String> {
    let root_dir = notes_root_dir(&app)?;
    let ts_dir = root_dir.join("transfer_station");
    let source_dir = if is_backup { ts_dir.join("backups") } else { ts_dir.clone() };
    let source_path = source_dir.join(&file_name);

    if !source_path.exists() {
        return Err(format!("中转站文件不存在: {}", file_name));
    }

    let content = std::fs::read_to_string(&source_path)
        .map_err(|e| format!("读取中转站文件失败: {}", e))?;

    let notes_dir = root_dir.join("notes");
    std::fs::create_dir_all(&notes_dir).map_err(|e| format!("创建笔记目录失败: {}", e))?;

    // 提取原始 note_id（备份文件名格式: {note_id}_{YYYYMMDD_HHMMSS}.md）
    let note_id = if is_backup {
        file_name
            .strip_suffix(".md")
            .unwrap_or(&file_name)
            .split_once('_')
            .map(|(id, _)| id.to_string())
            .unwrap_or_else(|| file_name.replace(".md", ""))
    } else {
        file_name.replace(".md", "")
    };

    let note_path = notes_dir.join(format!("{}.md", note_id));
    std::fs::write(&note_path, &content)
        .map_err(|e| format!("写入笔记文件失败: {}", e))?;

    eprintln!(
        "[TransferStation] 还原文件: {} -> notes/{}.md, is_backup={}, content_len={}",
        file_name, note_id, is_backup, content.len()
    );
    Ok(())
}

/// 删除中转站中的单个文件
#[tauri::command]
pub fn delete_transfer_station_file(
    app: tauri::AppHandle,
    file_name: String,
    is_backup: bool,
) -> Result<(), String> {
    // 首次备份不可删除
    if is_backup {
        return Err("首次备份不可删除".to_string());
    }

    let root_dir = notes_root_dir(&app)?;
    let ts_dir = root_dir.join("transfer_station");
    let file_path = ts_dir.join(&file_name);

    if !file_path.exists() {
        return Err(format!("中转站文件不存在: {}", file_name));
    }

    std::fs::remove_file(&file_path)
        .map_err(|e| format!("删除中转站文件失败: {}", e))?;

    eprintln!("[TransferStation] 删除文件: {}", file_name);
    Ok(())
}

/// 清空中转站「当前暂存」分组（不影响「首次备份」分组）
#[tauri::command]
pub fn clear_transfer_station(app: tauri::AppHandle) -> Result<u32, String> {
    let root_dir = notes_root_dir(&app)?;
    let ts_dir = root_dir.join("transfer_station");

    if !ts_dir.exists() {
        return Ok(0);
    }

    let mut count = 0u32;
    if let Ok(entries) = std::fs::read_dir(&ts_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                std::fs::remove_file(&path)
                    .map_err(|e| format!("删除文件失败: {}", e))?;
                count += 1;
            }
        }
    }

    eprintln!("[TransferStation] 清空中转站: 已删除 {} 个文件", count);
    Ok(count)
}

// ================= 图片模块命令 =================

/// 扫描并发锁：防止多个扫描同时进行
static IMAGE_SCAN_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static MUSIC_SCAN_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static VIDEO_SCAN_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static READING_SCAN_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// 打开书籍并发锁（与扫描同构：已有打开任务进行中则拒绝新的打开请求）
static OPEN_BOOK_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 扫描图片根目录，流式推送结果（适合大目录）
/// 使用 spawn_blocking 将同步 I/O 从 tokio 线程剥离，避免阻塞异步运行时
#[tauri::command]
pub async fn scan_image_root(app: tauri::AppHandle, root_path: String) -> Result<(), String> {
    if IMAGE_SCAN_RUNNING.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return Err("扫描已在进行中，请稍后重试".to_string());
    }
    let app_handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        image_service::scan_image_root_streaming(&app_handle, &root_path)
    })
    .await;
    IMAGE_SCAN_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    result.map_err(|e| format!("扫描任务执行失败: {}", e))?
}

/// 加载图片扫描缓存，比对源目录 mtime——若目录有新变化则返回 None 触发重扫
#[tauri::command]
pub fn load_image_cache(app: tauri::AppHandle, root_path: String) -> Result<Option<Vec<image_service::ImageFolder>>, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    // 获取源目录最新 mtime
    let src_mtime = std::fs::metadata(&root_path)
        .ok().and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // 文件级缓存带有源 mtime 信封
    match cache_service::load_file_cache::<Vec<image_service::ImageFolder>>(&app_data, "image_scan", &root_path) {
        Some((data, cached_mtime)) if cached_mtime >= src_mtime => Ok(Some(data)),
        _ => Ok(None),
    }
}

/// 删除图片扫描缓存（重新扫描前调用）
#[tauri::command]
pub fn delete_image_cache(app: tauri::AppHandle, root_path: String) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    cache_service::delete_cache(&app_data, "image_scan", &root_path)
}

/// 检查文件是否存在
#[tauri::command]
pub fn check_file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

/// 取消当前扫描（同时重置并发锁）
#[tauri::command]
pub fn cancel_scan() -> Result<(), String> {
    image_service::SCAN_CANCEL.store(true, std::sync::atomic::Ordering::SeqCst);
    music_service::MUSIC_SCAN_CANCEL.store(true, std::sync::atomic::Ordering::SeqCst);
    video_service::VIDEO_SCAN_CANCEL.store(true, std::sync::atomic::Ordering::SeqCst);
    // 阅读模块用代次计数器：递增使所有进行中的扫描/打开任务失效
    reading_service::READING_SCAN_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    reading_service::OPEN_BOOK_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    IMAGE_SCAN_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    MUSIC_SCAN_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    VIDEO_SCAN_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    READING_SCAN_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    OPEN_BOOK_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    Ok(())
}

/// 取消正在进行的书籍打开（open_book 流式任务）
#[tauri::command]
pub fn cancel_open_book() -> Result<(), String> {
    // 递增代次使进行中的 open_book 任务失效（任务在章节循环中检测到代次不匹配后自行退出）
    reading_service::OPEN_BOOK_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    OPEN_BOOK_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    Ok(())
}

/// 获取指定文件夹下所有图片的完整路径列表
#[tauri::command]
pub fn get_folder_images(folder_path: String) -> Result<Vec<String>, String> {
    image_service::get_folder_images(&folder_path)
}

/// 生成缩略图（200px 宽 JPEG，首次生成后缓存复用）
#[tauri::command]
pub fn generate_thumbnail(app: tauri::AppHandle, image_path: String, width: u32) -> Result<String, String> {
    image_service::generate_thumbnail(&app, &image_path, width)
}

/// 打开目录选择对话框，返回选中的路径（用户取消时返回 None）
#[tauri::command]
pub async fn pick_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let folder = app.dialog().file().blocking_pick_folder();
    if let Some(ref p) = folder {
        // 运行时把用户选定目录加入 asset 协议 scope（递归），
        // 这样静态 scope 可保持最小（仅 $APPDATA），降低攻击面。
        let s = p.to_string();
        let _ = app.asset_protocol_scope().allow_directory(std::path::Path::new(&s), true);
    }
    Ok(folder.map(|p| p.to_string()))
}

/// 文件选择对话框过滤器（前端传入）
#[derive(serde::Deserialize)]
pub struct FileDialogFilter {
    name: String,
    extensions: Vec<String>,
}

/// 打开文件选择对话框，返回选中的文件路径列表
#[tauri::command]
pub async fn pick_file(app: tauri::AppHandle, filters: Option<Vec<FileDialogFilter>>) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mut builder = app.dialog().file();
    if let Some(filter_list) = &filters {
        for f in filter_list {
            let exts: Vec<&str> = f.extensions.iter().map(|s| s.as_str()).collect();
            builder = builder.add_filter(&f.name, &exts);
        }
    }
    let files = builder.blocking_pick_files();
    let paths: Vec<String> = files.unwrap_or_default().into_iter().map(|p| p.to_string()).collect();
    // 运行时把所选文件的父目录加入 asset scope，便于后续 convertFileSrc 加载
    for p in &paths {
        if let Some(parent) = std::path::Path::new(p).parent() {
            let _ = app.asset_protocol_scope().allow_directory(parent, false);
        }
    }
    Ok(paths)
}

// 另存为：打开「保存文件」对话框，返回选中的路径（取消时 None）
#[tauri::command]
pub async fn pick_save_file(app: tauri::AppHandle, default_name: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .blocking_save_file();
    Ok(path.map(|p| p.to_string()))
}

// 写入纯文本文件（IDE 子插件「保存」用）。原子写入：先写同目录临时文件，再 rename 替换，
// 避免 AI 生成到一半断网/崩溃导致原文件被截断为 0 字节（写前锁定 / 原子替换）。
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
        }
    }
    let tmp = format!("{}.{}.tmp", path, std::process::id());
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| format!("写入失败: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("写入失败: {}", e)
    })
}

// 读取文本文件内容（IDE 子插件用），以 UTF-8 解析（含非法字节时容错替换）
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("读取失败: {}", e))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

// 删除文件（IDE 自主编辑「撤销新建文件」用；不存在时视为成功）
#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Ok(());
    }
    std::fs::remove_file(&path).map_err(|e| format!("删除失败: {}", e))
}

// ================= 音乐模块命令 =================

/// 扫描音乐根目录，流式推送结果（适合大目录）
/// 使用 spawn_blocking 将同步 I/O 从 tokio 线程剥离，避免阻塞异步运行时
#[tauri::command]
pub async fn scan_music_root(app: tauri::AppHandle, root_path: String) -> Result<(), String> {
    if MUSIC_SCAN_RUNNING.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return Err("扫描已在进行中，请稍后重试".to_string());
    }
    let app_handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        music_service::scan_music_root_streaming(&app_handle, &root_path)
    })
    .await;
    MUSIC_SCAN_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    result.map_err(|e| format!("扫描任务执行失败: {}", e))?
}

/// 加载音乐扫描缓存（如果存在），返回 None 表示需要重新扫描
#[tauri::command]
pub fn load_music_cache(app: tauri::AppHandle, root_path: String) -> Result<Option<Vec<music_service::Track>>, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(cache_service::load_cache::<Vec<music_service::Track>>(&app_data, "music_scan", &root_path)
        .map(|(data, _mtime)| data))
}

/// 删除音乐扫描缓存（重新扫描前调用）
#[tauri::command]
pub fn delete_music_cache(app: tauri::AppHandle, root_path: String) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    cache_service::delete_cache(&app_data, "music_scan", &root_path)
}

/// 读取单个音频文件的元数据（标题/歌手/专辑/时长/内嵌封面）。
/// 供「手动添加歌曲」（非目录扫描）复用与目录扫描完全一致的解析逻辑
/// （music_service::extract_track_metadata），从而识别手动添加歌曲的元信息。
#[tauri::command]
pub fn read_track_metadata(app: tauri::AppHandle, file_path: String) -> music_service::Track {
    let cover_dir = app.path().app_data_dir().ok().map(|d| d.join("music_covers"));
    if let Some(ref dir) = cover_dir {
        let _ = std::fs::create_dir_all(dir);
    }
    music_service::extract_track_metadata(std::path::Path::new(&file_path), cover_dir.as_deref())
}

// ================= 视频模块命令 =================

/// 扫描视频根目录，流式推送结果（适合大目录）
#[tauri::command]
pub async fn scan_video_root(app: tauri::AppHandle, root_path: String) -> Result<(), String> {
    if VIDEO_SCAN_RUNNING.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return Err("扫描已在进行中，请稍后重试".to_string());
    }
    let app_handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        video_service::scan_video_root_streaming(&app_handle, &root_path)
    })
    .await;
    VIDEO_SCAN_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    result.map_err(|e| format!("扫描任务执行失败: {}", e))?
}

/// 加载视频扫描缓存（如果存在），返回 None 表示需要重新扫描
#[tauri::command]
pub fn load_video_cache(app: tauri::AppHandle, root_path: String) -> Result<Option<Vec<video_service::VideoFolder>>, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(cache_service::load_cache::<Vec<video_service::VideoFolder>>(&app_data, "video_scan", &root_path)
        .map(|(data, _mtime)| data))
}

/// 删除视频扫描缓存（重新扫描前调用）
#[tauri::command]
pub fn delete_video_cache(app: tauri::AppHandle, root_path: String) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    cache_service::delete_cache(&app_data, "video_scan", &root_path)
}

/// 获取指定文件夹下所有视频文件信息
#[tauri::command]
pub fn get_folder_videos(folder_path: String) -> Result<Vec<video_service::VideoFile>, String> {
    video_service::get_folder_videos(&folder_path)
}

// ================= 阅读模块命令 =================

/// 扫描阅读根目录，流式推送结果（适合大目录，扫整个磁盘也不卡死）
/// 使用 spawn_blocking 将同步 I/O 从 tokio 线程剥离，避免阻塞异步运行时
#[tauri::command]
pub async fn scan_reading_root(app: tauri::AppHandle, root_path: String) -> Result<Vec<reading_service::BookSummary>, String> {
    if READING_SCAN_RUNNING.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return Err("扫描已在进行中，请稍后重试".to_string());
    }
    let app_handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        reading_service::scan_reading_root_streaming(&app_handle, &root_path)
    })
    .await;
    READING_SCAN_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    result.map_err(|e| format!("扫描任务执行失败: {}", e))?
}

/// 加载阅读扫描缓存（如果存在），返回 None 表示需要重新扫描
#[tauri::command]
pub fn load_reading_cache(app: tauri::AppHandle, root_path: String) -> Result<Option<Vec<reading_service::BookSummary>>, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(cache_service::load_cache::<Vec<reading_service::BookSummary>>(&app_data, "reading_scan", &root_path)
        .map(|(data, _mtime)| data))
}

/// 删除阅读扫描缓存（重新扫描前调用）
#[tauri::command]
pub fn delete_reading_cache(app: tauri::AppHandle, root_path: String) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    cache_service::delete_cache(&app_data, "reading_scan", &root_path)
}

/// 流式打开书籍：先推 open-book-meta，再按章分块推 open-book-chunk，
/// 完成推 open-book-progress(done=true)。命中书籍缓存时秒开；解析结果落盘缓存。
/// 与扫描同构：spawn_blocking 卸载同步解析 + 并发锁拒绝重复打开 + 支持 cancel_open_book 取消。
#[tauri::command]
pub async fn open_book(app: tauri::AppHandle, file_path: String) -> Result<(), String> {
    if OPEN_BOOK_RUNNING.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return Err("正在打开其他书籍，请稍后".to_string());
    }
    let app_handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        reading_service::open_book_streaming(&app_handle, &file_path)
    })
    .await;
    OPEN_BOOK_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    result.map_err(|e| format!("打开书籍任务执行失败: {}", e))?
}

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
        let image = drag::Image::Raw(include_bytes!("../icons/32x32.png").to_vec());
        let options = drag::Options::default();
        let res = drag::start_drag(&window, item, image, |_r, _p| {}, options);
        let _ = tx.send(res);
    })
    .map_err(|e| format!("无法在主线程启动原生拖拽: {}", e))?;

    rx.recv()
        .map_err(|e| format!("等待拖拽结果失败: {}", e))?
        .map_err(|e| format!("原生拖拽失败: {}", e))
}

/// 可读文本文件扩展名
const READABLE_EXTENSIONS: &[&str] = &[
    "md", "txt", "json", "csv", "xml", "yaml", "yml", "toml", "ini", "cfg",
    "log", "env", "html", "css", "js", "ts", "tsx", "jsx", "mjs", "cjs",
    "py", "rs", "go", "java", "rb", "php", "c", "cpp", "h", "hpp", "swift",
    "kt", "scala", "sh", "bash", "zsh", "ps1", "bat", "cmd", "sql",
    "r", "m", "mm", "pl", "lua", "dart", "groovy", "gradle", "svelte",
    "vue", "astro", "tex", "bib", "rst", "asciidoc", "adoc",
];

/// 将文件导入中转站（复制到 app_data/transfer_station/dropzone/）
#[tauri::command]
pub fn import_to_dropzone(app: tauri::AppHandle, source_path: String) -> Result<ImportedFile, String> {
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
    std::fs::copy(&source_path, &dest_path).map_err(|e| format!("复制文件失败: {}", e))?;

    // 同时生成「存档」快照（设置「中转站 / 存档」：文件一拖入即快照，可恢复/删除）。
    // 超大文件（>100MB）跳过快照，避免整文件读入内存导致 OOM。
    if size <= 100 * 1024 * 1024 {
        let _ = transfer_station::archive_snapshot(
            &app_data,
            "file",
            &format!("{}", timestamp),
            &file_name,
            &std::fs::read(&dest_path).unwrap_or_default(),
            &extension,
        );
    }
    
    let imported_at = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    
    Ok(ImportedFile {
        file_id: file_id.clone(),
        original_name: file_name,
        extension,
        size,
        stored_path: file_id.clone(),
        absolute_path: dest_path.to_string_lossy().to_string(),
        imported_at,
        is_readable,
    })
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
    
    Ok(count)
}

// ================= 通用存档（快照）命令 =================

/// 生成一份存档快照（content 为 base64 编码，支持二进制）。
#[tauri::command]
pub fn archive_snapshot(
    app: tauri::AppHandle,
    kind: String,
    source_id: String,
    name: String,
    content_base64: String,
    ext: String,
) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let bytes = base64_decode(content_base64.trim().as_bytes())
        .map_err(|e| format!("存档解码失败: {}", e))?;
    transfer_station::archive_snapshot(&app_data, &kind, &source_id, &name, &bytes, &ext)
        .map(|_| ())
        .ok_or_else(|| "存档写入失败".to_string())
}

/// 列出所有存档快照。
#[tauri::command]
pub fn list_archives(app: tauri::AppHandle) -> Result<Vec<transfer_station::ArchiveEntry>, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(transfer_station::list_archives(&app_data))
}

/// 恢复存档到原位置（笔记 → notes 目录；文件/图片 → 中转站暂存目录）。
#[tauri::command]
pub fn restore_archive(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    transfer_station::restore_archive(&app_data, &id)
}

/// 删除单个存档快照。
#[tauri::command]
pub fn delete_archive(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    transfer_station::delete_archive(&app_data, &id)
}

/// 清空所有存档快照。
#[tauri::command]
pub fn clear_archives(app: tauri::AppHandle) -> Result<u32, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    transfer_station::clear_archives(&app_data)
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

// ================= IDE 项目目录文件列表 =================

#[derive(Debug, Clone, serde::Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[tauri::command]
pub fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| format!("读取目录失败: {}", e))?;
    let mut result: Vec<DirEntry> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = p.is_dir();
        // 跳过隐藏文件/文件夹
        if name.starts_with('.') { continue; }
        result.push(DirEntry { name, path: p.to_string_lossy().to_string(), is_dir });
    }
    result.sort_by(|a, b| {
        if a.is_dir != b.is_dir { b.is_dir.cmp(&a.is_dir) }
        else { a.name.to_lowercase().cmp(&b.name.to_lowercase()) }
    });
    Ok(result)
}

// 确保目录存在（IDE 自主编辑「记忆/原则」文件夹自动创建用）
#[tauri::command]
pub fn ensure_directory(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("创建目录失败: {}", e))
}

// ================= 内容黑名单管理（统一管理图库/音乐/视频的被屏蔽文件夹） =================

/// 黑名单条目
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BlacklistEntry {
    pub path: String,           // 文件夹路径
    pub module: String,         // 所属模块: "image" | "music" | "video"
    pub display_name: String,   // 显示名称（文件夹名）
    pub blocked_at: String,     // 屏蔽时间
}

/// 获取指定模块的黑名单
#[tauri::command]
pub fn get_blacklist(app: tauri::AppHandle, module: String) -> Result<Vec<BlacklistEntry>, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let blacklist_path = app_data.join("content_blacklist.json");
    
    if !blacklist_path.exists() {
        return Ok(Vec::new());
    }
    
    let content = std::fs::read_to_string(&blacklist_path)
        .map_err(|e| format!("读取黑名单失败: {}", e))?;
    
    let all_entries: Vec<BlacklistEntry> = serde_json::from_str(&content)
        .map_err(|e| format!("解析黑名单失败: {}", e))?;
    
    // 按模块筛选
    let filtered: Vec<BlacklistEntry> = all_entries
        .into_iter()
        .filter(|e| e.module == module)
        .collect();
    
    Ok(filtered)
}

/// 获取所有模块的黑名单（用于全局管理）
#[tauri::command]
pub fn get_all_blacklist(app: tauri::AppHandle) -> Result<Vec<BlacklistEntry>, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let blacklist_path = app_data.join("content_blacklist.json");
    
    if !blacklist_path.exists() {
        return Ok(Vec::new());
    }
    
    let content = std::fs::read_to_string(&blacklist_path)
        .map_err(|e| format!("读取黑名单失败: {}", e))?;
    
    serde_json::from_str(&content).map_err(|e| format!("解析黑名单失败: {}", e))
}

/// 添加条目到黑名单
#[tauri::command]
pub fn add_to_blacklist(app: tauri::AppHandle, module: String, path: String, display_name: String) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let blacklist_path = app_data.join("content_blacklist.json");
    
    let mut entries: Vec<BlacklistEntry> = if blacklist_path.exists() {
        let content = std::fs::read_to_string(&blacklist_path)
            .map_err(|e| format!("读取黑名单失败: {}", e))?;
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        Vec::new()
    };
    
    // 去重
    if !entries.iter().any(|e| e.path == path && e.module == module) {
        entries.push(BlacklistEntry {
            path,
            module,
            display_name,
            blocked_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        });
    }
    
    let content = serde_json::to_string_pretty(&entries)
        .map_err(|e| format!("序列化黑名单失败: {}", e))?;
    std::fs::write(&blacklist_path, content)
        .map_err(|e| format!("写入黑名单失败: {}", e))?;
    
    Ok(())
}

/// 从黑名单移除条目（恢复显示）
#[tauri::command]
pub fn remove_from_blacklist(app: tauri::AppHandle, module: String, path: String) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let blacklist_path = app_data.join("content_blacklist.json");
    
    if !blacklist_path.exists() {
        return Ok(());
    }
    
    let content = std::fs::read_to_string(&blacklist_path)
        .map_err(|e| format!("读取黑名单失败: {}", e))?;
    let mut entries: Vec<BlacklistEntry> = serde_json::from_str(&content)
        .map_err(|e| format!("解析黑名单失败: {}", e))?;
    
    entries.retain(|e| !(e.path == path && e.module == module));
    
    let content = serde_json::to_string_pretty(&entries)
        .map_err(|e| format!("序列化黑名单失败: {}", e))?;
    std::fs::write(&blacklist_path, content)
        .map_err(|e| format!("写入黑名单失败: {}", e))?;
    
    Ok(())
}

/// 获取指定模块的黑名单路径集合（前端过滤器用，返回仅路径的数组）
#[tauri::command]
pub fn get_blacklist_paths(app: tauri::AppHandle, module: String) -> Result<Vec<String>, String> {
    let entries = get_blacklist(app, module)?;
    Ok(entries.into_iter().map(|e| e.path).collect())
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
    // 优先使用调用方已持有的内存字节（如刚编码好的 PNG），避免「写盘后又整文件读回」的冗余 I/O
    let snapshot_bytes: Vec<u8> = match content {
        Some(bytes) => bytes,
        None => std::fs::read(&dest).unwrap_or_default(),
    };
    transfer_station::archive_snapshot(
        app_data,
        "file",
        &format!("{}", timestamp),
        &file_name,
        &snapshot_bytes,
        &extension,
    );
    Ok(dest)
}

/// 调用原生解析器将文件转换为 Markdown（无需 Python，毫秒级；PDF 也能出图）。
/// 同时把原始文档存入图标栏中转站（dropzone），解析出的图片仅用于预览、不进中转站列表。
#[tauri::command]
pub async fn convert_to_markdown(app: tauri::AppHandle, file_path: String) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    // 原生文档解析（OOXML / PDF）可能很慢且同步阻塞，
    // 放到专用阻塞线程，避免卡住 Tauri 命令通道（阅读模块已采用此方式）。
    let fp = file_path.clone();
    let ad = app_data.clone();
    let parsed = tauri::async_runtime::spawn_blocking(move || {
        document_parser::convert_document_to_markdown(&fp, &ad)
    })
    .await
    .map_err(|e| format!("解析线程异常: {}", e))??;
    // 原始文档存入图标栏中转站（轻量，主线程即可）
    let _ = copy_file_to_dropzone(&app_data, &file_path, None, None);
    Ok(parsed)
}

/// wps 文档编辑器：将 TipTap 文档 JSON 导出为 .docx 文件。
#[tauri::command]
pub fn wps_export_docx(path: String, json: String) -> Result<(), String> {
    let bytes = crate::services::docx_wps::json_to_docx(&json)?;
    std::fs::write(&path, &bytes).map_err(|e| format!("写入 {} 失败: {}", path, e))?;
    Ok(())
}

/// wps 演示文件编辑器：将幻灯片 JSON 导出为 .pptx 文件（PresentationML）。
#[tauri::command]
pub fn wps_export_pptx(path: String, json: String) -> Result<(), String> {
    let bytes = crate::services::pptx_wps::json_to_pptx(&json)?;
    std::fs::write(&path, &bytes).map_err(|e| format!("写入 {} 失败: {}", path, e))?;
    Ok(())
}

/// wps 演示文件编辑器：从 .pptx 文件导入为幻灯片 JSON。
#[tauri::command]
pub fn wps_import_pptx(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("读取 {} 失败: {}", path, e))?;
    crate::services::pptx_import::pptx_to_json(&bytes)
}

/// 将 base64 文件内容写入临时文件，调用原生解析器转换为 Markdown。
#[tauri::command]
pub async fn convert_bytes_to_markdown(
    app: tauri::AppHandle,
    base64: String,
    extension: String,
    original_name: Option<String>,
) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let ad = app_data.clone();
    let oname = original_name.clone();
    // 重解码 + 写临时文件 + 原生解析：放在阻塞线程，避免大文件卡住命令通道
    let parsed = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let bytes = base64
            .split(',')
            .nth(1)
            .unwrap_or(&base64)
            .as_bytes();
        let decoded = base64_decode(bytes).map_err(|e| format!("解码失败: {}", e))?;
        // 超大文件防护：避免一次性解码进内存导致崩溃 / 卡死
        if decoded.len() > 300 * 1024 * 1024 {
            return Err("文件过大（>300MB），暂不支持解析".into());
        }
        let tmp = std::env::temp_dir().join(format!("andeng_drop_{}.{}", uuid::Uuid::new_v4(), extension));
        std::fs::write(&tmp, &decoded).map_err(|e| format!("写临时文件失败: {}", e))?;
        let tmp_str = tmp.to_string_lossy().to_string();
        let result = document_parser::convert_document_to_markdown(&tmp_str, &ad);
        // 原始文档存入图标栏中转站（使用原始文件名）
        let _ = copy_file_to_dropzone(&ad, &tmp_str, oname.as_deref(), None);
        let _ = std::fs::remove_file(&tmp);
        result
    })
    .await
    .map_err(|e| format!("解析线程异常: {}", e))??;
    Ok(parsed)
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

fn base64_decode(input: &[u8]) -> Result<Vec<u8>, String> {
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

fn sanitize_filename(name: &str) -> String {
    let illegal: &[char] = &['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
    let s: String = name.chars().filter(|c| !illegal.contains(c)).collect();
    if s.trim().is_empty() {
        "file".to_string()
    } else {
        s
    }
}

fn mime_from_ext(path: &str) -> &'static str {
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

// ============================================================
// 路线 A — 分发解耦：插件下载安装
// ============================================================

/// 将插件文件写入 `user_plugins/{plugin_id}/{file_name}`。
/// 用于分发解耦：前端从清单获取文件内容后，调此命令写盘，再触发热加载。
#[tauri::command]
pub fn install_plugin_file(
    app: tauri::AppHandle,
    plugin_id: String,
    file_name: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let user_plugins_dir = get_user_plugins_dir(&app)
        .ok_or_else(|| "无法解析 user_plugins 目录".to_string())?;
    let dir = user_plugins_dir.join(&plugin_id);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("创建目录失败: {}", e))?;
    let safe_name = sanitize_filename(&file_name);
    std::fs::write(dir.join(&safe_name), &data)
        .map_err(|e| format!("写入 {} 失败: {}", safe_name, e))?;
    Ok(())
}

/// 读取插件清单（JSON），返回原始文本。
/// 统一从 bundled-plugins/manifest.json 读取（开发时项目根，打包后 resource_dir）
#[tauri::command]
pub fn read_manifest(app: tauri::AppHandle) -> Result<String, String> {
    if let Some(bundled_dir) = get_bundled_plugins_dir(&app) {
        let manifest_path = bundled_dir.join("manifest.json");
        if manifest_path.exists() {
            return std::fs::read_to_string(&manifest_path)
                .map_err(|e| format!("读取清单失败: {}", e));
        }
    }
    Err("未找到插件清单 manifest.json".into())
}

/// 路线 A 分发解耦：从 bundled-plugins 一次性复制整个插件到 user_plugins，
/// 然后触发热加载。省去前端逐文件 fetch 的复杂性。
#[tauri::command]
pub fn install_bundled_plugin(app: tauri::AppHandle, plugin_id: String) -> Result<String, String> {
    let bundled_base = get_bundled_plugins_dir(&app)
        .ok_or_else(|| "无法解析 bundled-plugins 目录".to_string())?;
    let src = if bundled_base.join(&plugin_id).exists() {
        bundled_base.join(&plugin_id)
    } else {
        let user_plugins_dir = get_user_plugins_dir(&app)
            .ok_or_else(|| "无法解析 user_plugins 目录".to_string())?;
        return Err(format!(
            "未找到插件包。请将 {} 的 manifest.json 与 index.js 放入:\n  {}\\\n然后点击「检测新插件」。",
            plugin_id,
            user_plugins_dir.display()
        ));
    };

    let dst = get_user_plugins_dir(&app)
        .ok_or_else(|| "无法解析 user_plugins 目录".to_string())?
        .join(&plugin_id);

    // 递归复制
    copy_dir_recursive(&src, &dst)
        .map_err(|e| format!("复制插件文件失败: {}", e))?;

    // 从清单中取插件名用于提示
    let manifest = src.join("manifest.json");
    let name = std::fs::read_to_string(&manifest)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(String::from))
        .unwrap_or_else(|| plugin_id.clone());

    Ok(name)
}

use std::path::Path;
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), std::io::Error> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let dest = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else {
            std::fs::copy(entry.path(), &dest)?;
        }
    }
    Ok(())
}