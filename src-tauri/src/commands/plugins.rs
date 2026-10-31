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
    /// 声明式权限：能力制（见 services/plugin_access.rs）。
    /// - 推荐在 manifest 写 `permissions.capabilities`（storage/fs.read/...）；
    /// - 旧式 `permissions.commands` 继续兼容：自动推导能力，并在能力集合之上收紧；
    /// - 沙箱按「命令→能力规则 + 授权账本」放行，不再有全局命令白名单。
    /// 已知边界（有意为之）：只约束 __HOST_API__.invoke；经 vite alias 直连 invoke 的
    /// 宿主内置插件不走这里（其边界在 Tauri capability/ACL）。
    #[serde(default)]
    pub permissions: PluginPermissions,
    /// 来源："bundled"（随包出厂）或 "user"（第三方/用户侧载）。
    /// 内置插件的能力自动批准；用户插件需要用户在扩展页确认。
    #[serde(default)]
    pub origin: String,
}

/// manifest 的 `permissions` 段：声明式权限
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct PluginPermissions {
    /// 旧式逐命令声明（保留兼容）：若存在，会在能力集合之上再收紧。
    pub commands: Vec<String>,
    /// 新式能力声明（推荐）：storage / fs.read / fs.write / fs.pick / media / net /
    /// clipboard.read / clipboard.write / window / system / ai / data / attack。
    pub capabilities: Vec<String>,
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

/// 插件目录指纹（毫秒精度）：任何可能改变扫描结果的文件系统变化都必须让它变化。
///
/// ## 为什么要换掉旧的「最近修改时间（秒）+ 扫描时刻比较」（2026-10-22 血案）
/// 旧实现只取 `bundled-plugins/` 与**一级**子目录的 mtime，秒精度，且用
/// 「扫描时刻 >= mtime」判断新鲜。两个漏洞叠起来会让一个插件**永久消失**：
///   1. `scripts/deploy-plugins.mjs` 复制时是「先清空目标目录，再写 manifest.json」，
///      中间那几毫秒里 `manifest.json` 不存在；
///   2. 应用恰好此刻扫描 → 读失败 → 该插件进 `rejected` → 结果被缓存。
///      而 manifest.json 是**文件**，改写它不动父目录 mtime ⇒ 缓存永远判新鲜，
///      插件在「拓展管理」里一直显示待安装、导航栏入口消失，**直到重启进程**。
/// （用户实测：音乐模块就是这么没的；重新部署也没用，因为部署同样只改文件。）
///
/// 现在：目录 + 每个 `manifest.json` 的 mtime 一起纳入；深度上限 3
/// （`bundled-plugins/茑萝/ide/manifest.json` 正好在第 3 层）；
/// 碰到插件根（有 manifest.json）就停止下潜 —— 插件内部资产变化不影响扫描结果。
pub(crate) fn plugins_fingerprint(app: &AppHandle) -> u64 {
    let dirs: Vec<PathBuf> = [get_bundled_plugins_dir(app), get_user_plugins_dir(app)]
        .into_iter()
        .flatten()
        .collect();
    fingerprint_dirs(&dirs)
}

/// [`plugins_fingerprint`] 的纯目录实现（便于单测；不依赖 AppHandle）。
pub(crate) fn fingerprint_dirs(dirs: &[PathBuf]) -> u64 {
    fn stamp(path: &std::path::Path, acc: &mut u64) {
        if let Ok(meta) = std::fs::metadata(path) {
            if let Ok(modified) = meta.modified() {
                if let Ok(dur) = modified.duration_since(std::time::UNIX_EPOCH) {
                    *acc = (*acc).max(dur.as_millis() as u64);
                }
            }
        }
    }
    fn walk(dir: &std::path::Path, depth: usize, acc: &mut u64) {
        let manifest = dir.join("manifest.json");
        if manifest.is_file() {
            // 插件根：只认 manifest.json 的 mtime。
            // 不 stamp 目录本身 —— 新增/覆盖 index.js 等内部资产会改目录 mtime，
            // 但那不影响扫描结果（只影响加载），不该逼着每次都全量重扫。
            stamp(&manifest, acc);
            return;
        }
        stamp(dir, acc);
        if depth >= 3 {
            return;
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    walk(&entry.path(), depth + 1, acc);
                }
            }
        }
    }

    let mut acc = 0u64;
    for d in dirs {
        walk(d, 0, &mut acc);
    }
    acc
}

/// 扫描 bundled-plugins/ 与 user_plugins/ 下所有子目录，校验 manifest.json 并返回有效 + 被拒绝的插件列表
/// 阶段 0：Rust 端完成 manifest 存在性、解析、必填字段、版本与依赖校验
/// 结果会被缓存，仅当 [`plugins_fingerprint`]（目录 + 每个 manifest.json 的 mtime）变化时重扫
#[tauri::command]
pub async fn get_installed_plugins(app: tauri::AppHandle) -> Result<PluginScanResult, String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || scan_plugins_sync(app2))
        .await
        .map_err(|e| format!("插件扫描任务失败: {e}"))?
}

/// 插件扫描/解压的同步主体（放到 spawn_blocking 线程执行，避免占死 UI/IPC 线程）。
/// 快路径：指纹未变且已有缓存 → 直接命中，不触发解压开销。
/// 慢路径：缓存失效/未初始化 → 先补齐 .mufurong/.mujin 解压，再全量扫描重建缓存。
pub(crate) fn scan_plugins_sync(app: tauri::AppHandle) -> Result<PluginScanResult, String> {
    let fingerprint = plugins_fingerprint(&app);

    // 快路径命中缓存则直接返回（解压放慢路径，避免热路径白白做 sha256+解压）。
    // 缓存键是**指纹**而不是「扫描时刻」：同一毫秒内的改写用时刻比较会误判成新鲜。
    if let Ok(cache) = PLUGIN_SCAN_CACHE.lock() {
        if let Some((ref cached, ref cached_fp)) = *cache {
            if *cached_fp == fingerprint {
                log::debug!(
                    "[plugins] 扫描缓存命中（指纹 {fingerprint}）：{} 个有效 / {} 个拒绝",
                    cached.valid.len(),
                    cached.rejected.len()
                );
                return Ok(cached.clone());
            }
            log::info!(
                "[plugins] 扫描缓存失效（指纹 {cached_fp} → {fingerprint}），重新扫描插件目录"
            );
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
    // 「可重试」失败：manifest 读不到 / 解析不了。几乎都是部署脚本写入的瞬时窗口，
    // 缓存它等于把一次坏运气钉死到进程结束（音乐模块消失就是这么来的）⇒ 出现即不写缓存。
    let mut transient_reject = false;

    // 加载用户可见性覆盖（AppData/plugin_visibility.json）：仅「用户显式开关过」的插件才有记录；
    // 新机首次运行该文件不存在 → 返回空 map（不写任何种子数据），后续解析回落到「默认开启」。
    let visibility_map = load_plugin_visibility_map(&app);

    // 递归收集 bundled-plugins/ 与 user_plugins/ 下所有 manifest.json
    // （user_plugins 用于第三方插件，不会被版本更新清空）
    // (manifest 路径, 相对路径, 是否内置)
    let mut manifest_files: Vec<(std::path::PathBuf, String, bool)> = Vec::new();
    fn walk(
        dir: &std::path::Path,
        base: &std::path::Path,
        bundled: bool,
        out: &mut Vec<(std::path::PathBuf, String, bool)>,
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
                    out.push((self_manifest, rel_str, bundled));
                }
                return;
            }
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    walk(&entry.path(), base, bundled, out);
                }
            }
        }
    }
    // bundled-plugins 优先（内置权威，且不会被安装版污染）；再扫 user_plugins（第三方/用户态插件）
    if let Some(ref ext) = ext { walk(ext, ext, true, &mut manifest_files); }
    if let Some(ref usr) = usr { walk(usr, usr, false, &mut manifest_files); }

    for (manifest_path, rel_path, bundled) in manifest_files {
        let folder_name = manifest_path
            .parent()
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        // 读取 manifest
        let content = match std::fs::read_to_string(&manifest_path) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[plugins] manifest 读取失败（视为可重试，不写缓存）: {} — {e}", manifest_path.display());
                transient_reject = true;
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
                log::warn!("[plugins] manifest 解析失败（视为可重试，不写缓存）: {} — {e}", manifest_path.display());
                transient_reject = true;
                rejected.push(RejectedPlugin {
                    folder_name,
                    reason: format!("manifest.json JSON 解析失败: {}", e),
                });
                continue;
            }
        };
        // 记录相对路径（嵌套子插件如 "茑萝/gongjuxiang"），供 read_plugin_file 使用
        manifest.path = rel_path;
        manifest.origin = if bundled { "bundled".into() } else { "user".into() };

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
    log::info!(
        "[plugins] 扫描完成：{} 个有效 / {} 个拒绝{}",
        result.valid.len(),
        result.rejected.len(),
        if transient_reject { "（含可重试失败）" } else { "" }
    );
    for r in &result.rejected {
        log::warn!("[plugins] 拒绝 {} — {}", r.folder_name, r.reason);
    }
    if transient_reject {
        // 不写缓存：下一次 get_installed_plugins 会重扫。部署脚本正在改写目录时就是这种情况，
        // 缓存它会让插件在「拓展管理」里一直显示待安装（2026-10-22 音乐模块消失事故）。
        log::warn!("[plugins] 本次结果含可重试失败，跳过缓存写入（下次调用会重新扫描）");
    } else if let Ok(mut cache) = PLUGIN_SCAN_CACHE.lock() {
        // 指纹在解压之后重算：extract_mufurong_plugins 会新增目录，用扫描开始时的旧指纹
        // 会让下一次调用立刻判失效、白扫一遍。
        let fp_after = plugins_fingerprint(&app);
        *cache = Some((result.clone(), fp_after));
        log::debug!("[plugins] 已写入扫描缓存（指纹 {fp_after}）");
    }
    Ok(result)
}

/// 根据插件 id 在 bundled-plugins/ 与 user_plugins/ 下递归查找其所在目录。
/// 前端只需传入 manifest 中的干净 id，Rust 端自动定位真实路径。
/// 插件目录是否来自 bundled-plugins（内置随包，视为可信）。
pub(crate) fn is_bundled_plugin_dir(app: &tauri::AppHandle, dir: &std::path::Path) -> bool {
    get_bundled_plugins_dir(app)
        .map(|b| dir.starts_with(&b))
        .unwrap_or(false)
}

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

    // 4) 清除授权账本与授权路径（否则重装后仍带着旧授权）
    crate::services::plugin_access::clear_plugin_access(&app, &plugin_id);

    // 5) 清除扫描缓存，让下次 get_installed_plugins 反映删除后的状态
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

#[cfg(test)]
mod fingerprint_tests {
    use super::fingerprint_dirs;
    use std::fs;
    use std::path::{Path, PathBuf};

    /// 造一个临时插件根：root/<name>/manifest.json
    fn make_root(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("andy-plugin-fp-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(p.join("铃兰")).unwrap();
        fs::write(p.join("铃兰").join("manifest.json"), r#"{"id":"music"}"#).unwrap();
        p
    }

    fn fp(root: &Path) -> u64 {
        fingerprint_dirs(&[root.to_path_buf()])
    }

    /// **血案本体**：改写 manifest.json 必须让指纹变化。
    ///
    /// 旧实现只取目录 mtime，而改文件不动目录 mtime ⇒ 缓存永远判新鲜，
    /// 于是「部署窗口期扫到一个半成品」会被永久缓存，插件在导航栏消失、
    /// 拓展管理显示待安装（2026-10-22 音乐模块事故）。
    #[test]
    fn rewriting_manifest_invalidates_fingerprint() {
        let root = make_root("rewrite");
        let before = fp(&root);
        // 确保落到不同的毫秒（NTFS 精度 100ns，但指纹截到毫秒）
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(root.join("铃兰").join("manifest.json"), r#"{"id":"music","v":2}"#).unwrap();
        let after = fp(&root);
        assert_ne!(before, after, "改写 manifest.json 后指纹没变 —— 缓存会永久判新鲜");
        let _ = fs::remove_dir_all(&root);
    }

    /// 部署的原子替换（tmp + rename）同样要触发失效：rename 会更新文件 mtime。
    #[test]
    fn atomic_replace_invalidates_fingerprint() {
        let root = make_root("rename");
        let before = fp(&root);
        std::thread::sleep(std::time::Duration::from_millis(20));
        let tmp = root.join("铃兰").join("manifest.json.tmp");
        fs::write(&tmp, r#"{"id":"music","v":3}"#).unwrap();
        fs::rename(&tmp, root.join("铃兰").join("manifest.json")).unwrap();
        assert_ne!(before, fp(&root), "tmp+rename 替换后指纹没变");
        let _ = fs::remove_dir_all(&root);
    }

    /// 新增/删除插件目录必须让指纹变化（缓存失效的最基本要求）。
    #[test]
    fn adding_and_removing_plugin_dir_invalidates_fingerprint() {
        let root = make_root("addrm");
        let before = fp(&root);
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::create_dir_all(root.join("玉兰")).unwrap();
        fs::write(root.join("玉兰").join("manifest.json"), r#"{"id":"video"}"#).unwrap();
        let added = fp(&root);
        assert_ne!(before, added, "新增插件目录后指纹没变");
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::remove_dir_all(root.join("玉兰")).unwrap();
        assert_ne!(added, fp(&root), "删除插件目录后指纹没变");
        let _ = fs::remove_dir_all(&root);
    }

    /// 没有任何变化时指纹必须稳定 —— 否则每次调用都全量重扫，缓存形同虚设。
    #[test]
    fn fingerprint_is_stable_without_changes() {
        let root = make_root("stable");
        assert_eq!(fp(&root), fp(&root));
        std::thread::sleep(std::time::Duration::from_millis(20));
        assert_eq!(fp(&root), fp(&root), "没改任何文件，指纹却变了");
        let _ = fs::remove_dir_all(&root);
    }

    /// 插件根之下的内部资产（index.js / assets）变化**不该**让指纹变：
    /// 那不影响扫描结果，只影响加载，每次构建都重扫没有意义。
    #[test]
    fn plugin_internal_assets_do_not_invalidate_fingerprint() {
        let root = make_root("inner");
        let before = fp(&root);
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(root.join("铃兰").join("index.js"), "// rebuilt").unwrap();
        assert_eq!(before, fp(&root), "插件内部资产不该触发重扫");
        let _ = fs::remove_dir_all(&root);
    }
}
