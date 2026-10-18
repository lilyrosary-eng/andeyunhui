//! 插件清单解析、扫描、启停、可见性、deskpet 资产导入
//!
//! 本文件由 commands.rs 拆分而来（2026-10-18，P1-5 拆 god file）。
//! 约定：用 `use super::*;` 取父模块的 use 与同级 item，不要在子模块里重复 import
//! 父模块已有的依赖；确需额外 import 时写显式路径（显式优先于 glob，不会冲突）。

#![allow(dead_code)] // 部分命令仅在特定平台/配置下被 invoke_handler 引用

use super::*;
// ================= 插件相关新命令 =================

/// 插件 manifest 结构（与 extensions/{id}/manifest.json 对应）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: String,           // "module" | "service"
    /// 出厂默认可见性（manifest.json 的必填字段，serde 无 default）。
    /// 注意：这只是插件自述的默认值；运行时以扫描函数 scan_plugins_sync 的可见性解析为准：
    /// 用户显式覆盖（plugin_visibility.json）> 默认 true（含无记录的新机首次运行，故全部默认开启）。
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
    pub required_assets: Vec<String>, // 需要的外部依赖资源路径（如 "茑萝/ide/codemirror/index.js"）
    // 注：曾经的 `capabilities: Vec<String>`（"file-system"/"network" 自述标签）
    // 已于 2026-10-18 删除——全仓库没有任何读取方。插件能力由 permissions.commands
    // （下面那段）与 Tauri capability/ACL 共同约束，自述标签只会造成
    // "声明了就像被强制执行"的错觉。serde 默认忽略未知键，故旧 manifest 里的
    // 同名字段不会导致解析失败，只是被静默跳过。
    /// 声明式命令权限：manifest 的 permissions.commands 列出插件要调用的命令，
    /// 沙箱按「声明 ∩ ALLOWED_COMMANDS 全局白名单」强制（见 src/core/pluginSandbox.ts）。
    /// 已知边界（有意为之，勿在此处加固）：
    /// 1. 只约束 __HOST_API__.invoke；经 vite alias 把宿主 src 编进 IIFE 的插件
    ///    （如 ai-chat）直连 invoke，绕过本清单——安全边界在 Tauri capability/ACL，不在这里。
    /// 2. 清单由 scripts/_scan_perms.mjs 以「源码里出现过的命令」保守超集生成
    ///    （宁可宽不可漏），要收紧要人工核对，别指望脚本自动收紧。
    #[serde(default)]
    pub permissions: PluginPermissions,
}

/// manifest 的 `permissions` 段：声明式权限
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct PluginPermissions {
    /// 插件声明要调用的命令名列表；空/未声明 = 回退全局白名单
    pub commands: Vec<String>,
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
pub(crate) fn version_lt(a: &str, b: &str) -> bool {
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

/// 在 user_external_deps/ 与 external-deps/ 中查找相对路径对应的实际文件路径。
/// 优先级：user_external_deps（用户解压，可覆盖）> external-deps（打包资源，兜底）。
/// 用于 validate_required_assets 和 read_external_dep_file 的统一路径解析。
/// 返回 None 表示两处都不存在。
pub(crate) fn find_external_dep_path(app: &tauri::AppHandle, relative_path: &str) -> Option<PathBuf> {
    let rel = relative_path.trim_start_matches(['/', '\\']);
    // 1. 优先用户解压目录（user_external_deps/）
    if let Some(user_deps_dir) = get_user_external_deps_dir(app) {
        let candidate = user_deps_dir.join(rel);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    // 2. 回退打包资源（external-deps/）
    get_external_deps_dir(app).map(|d| d.join(rel)).filter(|p| p.exists())
}

/// 校验 requiredAssets：检查 external-deps 下是否存在 manifest 声明的外部依赖资源。
/// 查找顺序：user_external_deps（用户解压，可覆盖）> external-deps（打包资源，兜底）。
/// 缺失任一资源即返回 Err（含缺失清单），调用方应将插件加入 rejected 列表，
/// 避免运行时才发现依赖缺失导致白屏（ide 的 CodeMirror / wps 的 tiptap 等）。
pub(crate) fn validate_required_assets(app: &tauri::AppHandle, manifest: &PluginManifest) -> Result<(), String> {
    if manifest.required_assets.is_empty() {
        return Ok(());
    }
    let mut missing: Vec<&String> = Vec::new();
    for asset in &manifest.required_assets {
        if find_external_dep_path(app, asset).is_none() {
            missing.push(asset);
        }
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "缺失外部依赖资源: {}（在 external-deps / user_external_deps 下均未找到）",
            missing.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
        ))
    }
}

/// 获取两个插件目录中最近修改时间（秒），用于缓存失效判断
pub(crate) fn plugins_max_mtime(app: &AppHandle) -> u64 {
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
pub async fn get_installed_plugins(app: tauri::AppHandle) -> Result<PluginScanResult, String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || scan_plugins_sync(app2))
        .await
        .map_err(|e| format!("插件扫描任务失败: {e}"))?
}

/// 插件扫描/解压的同步主体（放到 spawn_blocking 线程执行，避免占死 UI/IPC 线程）。
/// 快路径：插件目录 mtime 未变且已有缓存 → 直接命中，不触发解压开销。
/// 慢路径：缓存失效/未初始化 → 先补齐 .mufurong/.mujin 解压，再全量扫描重建缓存。
pub(crate) fn scan_plugins_sync(app: tauri::AppHandle) -> Result<PluginScanResult, String> {
    let current_mtime = plugins_max_mtime(&app);

    // 快路径命中缓存则直接返回（解压放慢路径，避免热路径白白做 sha256+解压）
    if let Ok(cache) = PLUGIN_SCAN_CACHE.lock() {
        if let Some((ref cached, ref cached_time)) = *cache {
            if *cached_time >= SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(current_mtime) {
                return Ok(cached.clone());
            }
        }
    }

    // 慢路径：先解压 user_plugins/ 下的 .mufurong 文件（版本匹配的跳过）。
    // 解压后新目录会改变 mtime，缓存自动失效（本轮扫描后会以 now() 重建缓存）。
    extract_mufurong_plugins(&app);

    // 同步解压 user_external_deps/ 下的 .mujin 文件（mtime 匹配的跳过）。
    // 必须在 validate_required_assets 之前完成，否则用户安装的 .mujin 依赖会被误判为缺失。
    extract_mujin_deps(&app);

    // 早期返回：bundled-plugins 与 user_plugins 两个根目录都不存在才认为无插件
    // 顺序：bundled-plugins（内置，权威）优先于 user_plugins（第三方/用户态），
    // 避免安装版解压出的共享副本污染 dev / release 实例（详见 find_plugin_root 注释）
    let ext = get_bundled_plugins_dir(&app);
    let usr = get_user_plugins_dir(&app);
    if ext.is_none() && usr.is_none() {
        return Ok(PluginScanResult { valid: vec![], rejected: vec![] });
    }

    let mut valid = Vec::new();
    let mut rejected = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();

    // 加载用户可见性覆盖（AppData/plugin_visibility.json）：仅「用户显式开关过」的插件才有记录；
    // 新机首次运行该文件不存在 → 返回空 map（不写任何种子数据），后续解析回落到「默认开启」。
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
    // bundled-plugins 优先（内置权威，且不会被安装版污染）；再扫 user_plugins（第三方/用户态插件）
    if let Some(ref ext) = ext { walk(ext, ext, &mut manifest_files); }
    if let Some(ref usr) = usr { walk(usr, usr, &mut manifest_files); }

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
        // 记录相对路径（嵌套子插件如 "茑萝/gongjuxiang"），供 read_plugin_file 使用
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

        // 可见性解析（唯一事实源，优先级从高到低）：
        //   1) 用户显式覆盖记录 plugin_visibility.json → 以记录为准（关掉后重启仍保持关闭）；
        //   2) 其余 → 默认 true（新机首次运行无记录 ⇒ 全部默认开启，
        //      含无 UI 的 service 类如 screen-recorder：不加载则其快捷功能直接不可用）。
        // manifest.json 的 visible 只是插件自述的出厂默认，不参与这里的判定，
        // 避免默认值散落在各插件 manifest 里（改一处漏一处）。
        // 注：不再有任何「锁死/强制隐藏」名单，可见性完全由用户记录 + 默认开启决定。
        manifest.visible = visibility_map.get(&manifest.id).copied().unwrap_or(true);

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
pub(crate) fn find_plugin_root(app: &tauri::AppHandle, plugin_id: &str) -> Result<std::path::PathBuf, String> {
    // 搜索顺序：bundled-plugins（内置，权威且版本匹配）优先，user_plugins（第三方/用户态）兜底。
    // 关键：user_plugins 位于 AppData，被 dev / release / 安装版 多实例共享；若让 user_plugins 优先，
    // 安装版解压出的副本会污染同机的 release 实例（共用同一 AppData 标识），导致
    // "打开安装版后 release 也读旧插件"。故内置 bundled-plugins 必须优先（与 get_bundled_plugins_dir 注释一致）。
    let roots: Vec<PathBuf> = [
        get_bundled_plugins_dir(app),
        get_user_plugins_dir(app),
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
/// 查找顺序（与 validate_required_assets 一致）：
/// 1. user_external_deps/（用户解压的 .mujin，可覆盖打包依赖）
/// 2. external-deps/（打包资源，兜底）
///
/// 越界防护：以实际命中的根目录（user_external_deps 或 external-deps）为基准做 canonicalize 校验。
#[tauri::command]
pub fn read_external_dep_file(app: tauri::AppHandle, relative_path: String) -> Result<String, String> {
    let rel = relative_path.trim_start_matches(['/', '\\']);

    // 1. 优先 user_external_deps/（含越界防护）
    if let Some(user_deps_dir) = get_user_external_deps_dir(&app) {
        let file_path = user_deps_dir.join(rel);
        if file_path.exists() {
            let root_canon = user_deps_dir.canonicalize().unwrap_or_else(|_| user_deps_dir.clone());
            if let Ok(canonical) = file_path.canonicalize() {
                if canonical.starts_with(&root_canon) {
                    return std::fs::read_to_string(&canonical)
                        .map_err(|e| format!("读取外部依赖文件失败: {}", e));
                }
                return Err(format!("越界访问被拒绝: {}", relative_path));
            }
        }
    }

    // 2. 回退 external-deps/（原逻辑，含越界防护）
    let root = get_external_deps_dir(&app)
        .ok_or_else(|| "无法解析 external-deps 目录".to_string())?;
    let file_path = root.join(rel);
    let root_canon = root.canonicalize().unwrap_or_else(|_| root.clone());
    if let Ok(canonical) = file_path.canonicalize() {
        if !canonical.starts_with(&root_canon) {
            return Err(format!("越界访问被拒绝: {}", relative_path));
        }
        return std::fs::read_to_string(&canonical)
            .map_err(|e| format!("读取外部依赖文件失败: {}", e));
    }
    Err(format!("外部依赖文件不存在: {}", relative_path))
}

/// 读取外部依赖（用户侧载 user_external_deps 优先，其次 bundled external-deps），以 base64 文本返回。
/// 与 `read_external_dep_file` 同源路径解析与越界防护，但面向二进制资产（WASM / ONNX 模型 / 权重），
/// 先读字节再用 STANDARD 编码为 base64，调用方（如前端 PaddleOCR 引擎）解码为 Uint8Array/字符串。
#[tauri::command]
pub fn read_external_dep_bytes(app: tauri::AppHandle, relative_path: String) -> Result<String, String> {
    let user_external_deps = get_user_external_deps_dir(&app);
    let external_deps = get_external_deps_dir(&app);
    let candidates = [user_external_deps, external_deps];

    for root in candidates.iter() {
        if root.is_none() {
            continue;
        }
        let root = root.as_ref().unwrap();
        let full = root.join(&relative_path);

        // 注意：这里必须 continue 而非 `?`。候选根目录（尤其 user_external_deps）
        // 可能尚未被创建，canonicalize 会失败；若用 `?` 直接冒泡，就永远走不到后面的
        // external-deps 兜底，整个命令以「解析根目录失败」告终。与下面 canon_full
        // 的处理保持一致语义：这个根不行就换下一个。
        let canon_root = match root.canonicalize() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let canon_full = match full.canonicalize() {
            Ok(p) => p,
            Err(_) => continue, // 文件不存在，尝试下一个候选根
        };
        if !canon_full.starts_with(&canon_root) {
            continue; // 越界防护：禁止跳出依赖根目录
        }

        let bytes = std::fs::read(&canon_full).map_err(|e| format!("读取依赖字节失败：{}", e))?;
        return Ok(base64::engine::general_purpose::STANDARD.encode(bytes));
    }

    Err(format!("外部依赖未找到：{}", relative_path))
}

/// 返回外部依赖文件的绝对路径（正斜杠），供前端用 `convertFileSrc` 走 asset 协议加载。
/// 与 `read_external_dep_bytes` 适用同一套候选根目录与越界防护，但只返回路径，
/// 不读取字节——避免大图（数 MB）经 base64 走 IPC/事件时超过载荷上限导致加载失败。
#[tauri::command(rename = "read-external-dep-path")]
pub fn read_external_dep_path(app: tauri::AppHandle, relative_path: String) -> Result<String, String> {
    let user_external_deps = get_user_external_deps_dir(&app);
    let external_deps = get_external_deps_dir(&app);
    let candidates = [user_external_deps, external_deps];

    for root in candidates.iter() {
        if root.is_none() {
            continue;
        }
        let root = root.as_ref().unwrap();
        let full = root.join(&relative_path);

        // 同上：根目录不存在时换下一个候选根，不要用 `?` 中断整个命令。
        let canon_root = match root.canonicalize() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let canon_full = match full.canonicalize() {
            Ok(p) => p,
            Err(_) => continue, // 文件不存在，尝试下一个候选根
        };
        if !canon_full.starts_with(&canon_root) {
            continue; // 越界防护：禁止跳出依赖根目录
        }

        return Ok(canon_full.to_string_lossy().replace('\\', "/"));
    }

    Err(format!("外部依赖未找到：{}", relative_path))
}

/// 导入用户本地图片/视频作为桌宠素材。
/// 把 `source_path` 复制到 user_external_deps/deskpet-assets/pet/<filename>，
/// 使其可通过 `read_external_dep_bytes({relativePath:"deskpet-assets/pet/<filename>"})` 读取。
/// 返回相对路径（rel）供前端 manifest 记录；文件名非法字符会被替换为下划线，
/// 与已有文件冲突时自动追加序号后缀。
#[tauri::command]
pub fn import_deskpet_asset(
    app: tauri::AppHandle,
    source_path: String,
    filename: Option<String>,
) -> Result<String, String> {
    let user_dir = get_user_external_deps_dir(&app)
        .ok_or_else(|| "无法获取 user_external_deps 目录".to_string())?;
    let pet_dir = user_dir.join("deskpet-assets").join("pet");
    std::fs::create_dir_all(&pet_dir).map_err(|e| format!("创建桌宠素材目录失败：{}", e))?;

    let src = std::path::Path::new(&source_path);
    if !src.is_file() {
        return Err(format!("源文件不存在或不是普通文件：{}", source_path));
    }

    let raw_name = match filename {
        Some(f) if !f.trim().is_empty() => f.trim().to_string(),
        _ => src
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("asset")
            .to_string(),
    };
    let base = sanitize_deskpet_filename(&raw_name);
    let final_name = unique_deskpet_name(&pet_dir, &base);

    let dest = pet_dir.join(&final_name);
    std::fs::copy(src, &dest).map_err(|e| format!("复制桌宠素材失败：{}", e))?;

    Ok(format!("deskpet-assets/pet/{}", final_name))
}

/// 仅保留文件系统中安全的字符，其余替换为下划线。
pub(crate) fn sanitize_deskpet_filename(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        if ch.is_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        out.push_str("asset");
    }
    out
}

/// 若 pet_dir 下已存在同名文件，则在扩展名前追加 _1/_2 序号直到不冲突。
pub(crate) fn unique_deskpet_name(pet_dir: &std::path::Path, base: &str) -> String {
    if !pet_dir.join(base).exists() {
        return base.to_string();
    }
    let stem = std::path::Path::new(base)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("asset")
        .to_string();
    let ext = std::path::Path::new(base)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_default();
    let mut i = 1;
    loop {
        let name = format!("{}_{}{}", stem, i, ext);
        if !pet_dir.join(&name).exists() {
            return name;
        }
        i += 1;
    }
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
    // 插件目录缺失（未分发 / 已被移除）：不报错，直接跳过。
    // 例：分发时把某个插件目录移出源码，旧的前端状态或用户脚本仍可能带该 id 调用本命令；
    // 抛错只会制造无意义的红灯，而记录本身也没有意义（插件不在，扫描不到它）。
    if find_plugin_root(&app, &plugin_id).is_err() {
        eprintln!(
            "[PluginVisibility] 插件 '{}' 目录不存在，已跳过 visible={}（未分发或已移除）",
            plugin_id, visible
        );
        return Ok(());
    }
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
pub async fn refresh_plugins(app: tauri::AppHandle) -> Result<PluginScanResult, String> {
    if let Ok(mut cache) = PLUGIN_SCAN_CACHE.lock() {
        *cache = None;
    }
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || scan_plugins_sync(app2))
        .await
        .map_err(|e| format!("插件扫描任务失败: {e}"))?
}

/// 热重载插件：向前端派发 `plugin-reload` 事件，
/// 由 PluginHost 在应用内重新读取 manifest + 入口脚本并执行（无需重启）。
/// 插件目录缺失时（未分发 / 已移除）不报错，仅记日志后跳过。
#[tauri::command]
pub fn reload_plugin(app: tauri::AppHandle, plugin_id: String) -> Result<(), String> {
    if find_plugin_root(&app, &plugin_id).is_err() {
        eprintln!(
            "[PluginHot] 插件 '{}' 目录不存在，跳过 reload（未分发或已移除）",
            plugin_id
        );
        return Ok(());
    }
    app.emit("plugin-reload", plugin_id)
        .map_err(|e| format!("派发 reload 事件失败: {}", e))
}

/// 热卸载插件：向前端派发 `plugin-unload` 事件，
/// 由 PluginHost 在应用内从注册表移除该插件（无需重启）。
/// 卸载是幂等操作：目录缺失也照常派发事件，让前端清掉注册表里可能残留的实例。
#[tauri::command]
pub fn unload_plugin(app: tauri::AppHandle, plugin_id: String) -> Result<(), String> {
    if find_plugin_root(&app, &plugin_id).is_err() {
        eprintln!(
            "[PluginHot] 插件 '{}' 目录不存在，仍派发 unload 以清理运行时残留",
            plugin_id
        );
    }
    app.emit("plugin-unload", plugin_id)
        .map_err(|e| format!("派发 unload 事件失败: {}", e))
}

/// 删除插件（连同文件）。
///
/// 行为：
/// 1. 用 `find_plugin_root` 在 user_plugins/ 与 bundled-plugins/ 中定位真实目录
/// 2. 删除该目录本身
/// 3. 在父目录中查找 `<plugin_id>.mufurong` 源包并删除（否则下次启动会被重新解压回来）
/// 4. 从 `plugin_visibility.json` 中移除该 id 的可见性记录
/// 5. 清除插件扫描缓存，使下次 get_installed_plugins 重新读取
/// 6. 派发 `plugin-unload` 事件，让 PluginHost 从注册表中移除
///
/// 注意：bundled-plugins/ 在开发期可能位于源码仓库；打包后位于安装目录。
/// 用户主动点击「垃圾桶」即视为授权删除，本命令不做 user/bundled 区分。
#[tauri::command]
pub fn delete_plugin(app: tauri::AppHandle, plugin_id: String) -> Result<(), String> {
    // 目录缺失（已被删除 / 未分发）不报错：跳过文件删除，继续做记录清理与事件派发，
    // 让前端列表里的残留条目也能点掉（否则用户面对一个删不掉的幽灵条目）。
    match find_plugin_root(&app, &plugin_id) {
        Ok(plugin_dir) => {
            // 1) 删除插件目录
            if plugin_dir.exists() {
                std::fs::remove_dir_all(&plugin_dir)
                    .map_err(|e| format!("删除插件目录失败: {}", e))?;
            }

            // 2) 删除同目录下的 <plugin_id>.mufurong 源包（防止下次启动重新解压）
            if let Some(parent) = plugin_dir.parent() {
                let mufurong_path = parent.join(format!("{}.{}", plugin_id, MUFURONG_EXT));
                if mufurong_path.exists() {
                    let _ = std::fs::remove_file(&mufurong_path);
                }
            }
        }
        Err(_) => {
            eprintln!(
                "[PluginDelete] 插件 '{}' 目录不存在（已删除或未分发），仅清理记录与运行时",
                plugin_id
            );
        }
    }

    // 3) 从 plugin_visibility.json 中移除该 id 的记录
    remove_plugin_visibility(&app, &plugin_id)?;

    // 4) 清除扫描缓存，让下次 get_installed_plugins 反映删除后的状态
    if let Ok(mut cache) = PLUGIN_SCAN_CACHE.lock() {
        *cache = None;
    }

    eprintln!(
        "[PluginDelete] 插件 '{}' 已彻底删除（目录 + .mufurong 包 + 可见性记录）",
        plugin_id
    );

    // 5) 派发 unload 事件，让 PluginHost 从注册表移除运行时实例
    let _ = app.emit("plugin-unload", plugin_id.clone());
    // 同时派发 unregistered 事件（与 PluginHost 卸载流程对齐，触发 ExtManager 列表刷新）
    let _ = app.emit("plugin-unregistered", plugin_id);
    Ok(())
}

/// 在系统文件管理器中打开插件所在目录。
/// 用 `tauri_plugin_opener` 的 `open_path` 打开 `find_plugin_root` 返回的路径。
#[tauri::command]
pub fn open_plugin_folder(app: tauri::AppHandle, plugin_id: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let plugin_dir = find_plugin_root(&app, &plugin_id)
        .map_err(|_| format!("插件 '{}' 未安装或已被移除，无法打开其目录", plugin_id))?;
    let path_str = plugin_dir.to_string_lossy().to_string();
    app.opener()
        .open_path(path_str, None::<&str>)
        .map_err(|e| format!("打开文件夹失败: {}", e))
}
