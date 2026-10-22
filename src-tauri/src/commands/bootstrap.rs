//! 路径解析、内置插件/依赖解包、扫描缓存（每次启动只扫一次文件系统）
//!
//! 本文件由 commands.rs 拆分而来（2026-10-18，P1-5 拆 god file）。
//! 约定：用 `use super::*;` 取父模块的 use 与同级 item，不要在子模块里重复 import
//! 父模块已有的依赖；确需额外 import 时写显式路径（显式优先于 glob，不会冲突）。

#![allow(dead_code)] // 部分命令仅在特定平台/配置下被 invoke_handler 引用

use super::*;
// ========== 插件扫描缓存（避免每次启动/刷新都重扫文件系统） ==========
// 值 = (扫描结果, 目录指纹)。用指纹而不是「扫描时刻」做缓存键：旧写法在同一毫秒内
// 改写、或只改文件不改目录时会把坏结果判成新鲜，导致插件永久消失（见 plugins_fingerprint 注释）。
pub(crate) static PLUGIN_SCAN_CACHE: once_cell::sync::Lazy<Mutex<Option<(PluginScanResult, u64)>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

// ========== 路径解析：统一开发期与打包后的插件/依赖目录 ==========
// 开发时 resource_dir() = src-tauri/，打包后 resource_dir() = 安装目录
// 开发时插件在 项目根/bundled-plugins/，打包后在 安装目录/bundled-plugins/

/// 获取内置插件目录（bundled-plugins/）
/// 打包后：resource_dir/bundled-plugins/ 或 resource_dir/_up_/bundled-plugins/
///   （Tauri 对 bundle.resources 中 "../bundled-plugins" 会保留 _up_ 前缀）
/// 开发时：resource_dir 实际是 src-tauri/target/(debug|release)/，项目根在向上三层处；
///   权威 bundled-plugins/ 由 predev 的 deploy-plugins.mjs 写入项目根，必须优先加载它，
///   不能误用 target/(debug|release)/bundled-plugins 这份陈旧构建副本。
pub fn get_bundled_plugins_dir(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    // 打包后：直接路径（仅当不在 target/ 下时才是有效安装目录）
    let bundled = resource_dir.join("bundled-plugins");
    if bundled.exists() {
        let p = bundled.to_string_lossy().replace('\\', "/");
        // 跳过 dev 构建残留的 target/(debug|release)/bundled-plugins 陈旧副本，避免加载到旧插件
        if !(p.contains("/target/debug/bundled-plugins")
            || p.contains("/target/release/bundled-plugins"))
        {
            return Some(bundled);
        }
    }
    // 打包后 NSIS 备选：_up_/bundled-plugins/
    let up_bundled = resource_dir.join("_up_").join("bundled-plugins");
    if up_bundled.exists() {
        return Some(up_bundled);
    }
    // 开发时：resource_dir = src-tauri/target/(debug|release)/，向上三层到项目根
    let dev_bundled = resource_dir
        .join("..")
        .join("..")
        .join("..")
        .join("bundled-plugins");
    if dev_bundled.exists() {
        return Some(dev_bundled);
    }
    // 兜底：CARGO_MANIFEST_DIR（编译期常量，= src-tauri/ 绝对路径）向上一层即项目根
    // ../bundled-plugins 正是 predev 写入、且始终是最新那份。
    //
    // ⚠⚠ 仅**开发构建**启用（2026-10-08 血案）：
    //   这一条会把**编译机的源码绝对路径硬编码进二进制**。开发机上源码目录一直在，
    //   于是连安装版都会命中它 —— 实测 `plugin_paths.log`：
    //       resource_dir      = \\?\D://安得云荟
    //       bundled-plugins   = C://Users//Rosary//Desktop//andeyunhui//src-tauri//..//bundled-plugins
    //   症状：改源码 → `deploy-plugins.mjs` 覆盖项目根 `bundled-plugins/` →
    //        **打包版立刻跟着变**，看起来像「源码污染了打包产物」。
    //   关掉后 release/安装版在本机与他人机器上行为一致：本函数返回 None，
    //   由 `find_plugin_root` 的第二 root（`user_plugins`，
    //   即 `bundled-dlc/plugins/*.mufurong` 的解压落地处）兜底。
    #[cfg(debug_assertions)]
    {
        let manifest_bundled =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("bundled-plugins");
        if manifest_bundled.exists() {
            return Some(manifest_bundled);
        }
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
        let p = deps.to_string_lossy().replace('\\', "/");
        // 跳过 dev 构建残留的 target/(debug|release)/external-deps 陈旧副本
        if !(p.contains("/target/debug/external-deps")
            || p.contains("/target/release/external-deps"))
        {
            return Some(deps);
        }
    }
    let up_deps = resource_dir.join("_up_").join("external-deps");
    if up_deps.exists() {
        return Some(up_deps);
    }
    let dev_deps = resource_dir.join("..").join("external-deps");
    if dev_deps.exists() {
        return Some(dev_deps);
    }
    // 打包后的**正式通道**：`bundled-dlc/external-deps/*.mujin` 由 extract_mujin_deps
    // 解压到 AppData 的 `user_external_deps/`。安装目录本身**不带** external-deps
    // （bundle.resources 只声明了 `../bundled-dlc`），所以这条才是 release/安装版
    // 的实际命中路径 —— 必须排在 CARGO_MANIFEST_DIR 兜底**之前**，
    // 否则会被那条「硬编码编译机路径」抢先命中（2026-10-08 实测）。
    if let Some(user_deps) = get_user_external_deps_dir(app) {
        if user_deps.exists() {
            return Some(user_deps);
        }
    }
    // 开发模式兜底：CARGO_MANIFEST_DIR（编译期常量 = src-tauri/ 绝对路径）。
    // ⚠ 同样仅 debug 启用，理由见 get_bundled_plugins_dir 的注释。
    #[cfg(debug_assertions)]
    {
        let manifest_deps =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("external-deps");
        if manifest_deps.exists() {
            return Some(manifest_deps);
        }
    }
    None
}

/// 获取用户插件目录（user_plugins/，始终在 AppData 下，用于第三方插件）
pub fn get_user_plugins_dir(app: &AppHandle) -> Option<PathBuf> {
    let app_data = app.path().app_data_dir().ok()?;
    Some(app_data.join("user_plugins"))
}

/// 获取用户外部依赖目录（user_external_deps/，始终在 AppData 下，用于第三方 .mujin 依赖）
/// 与 user_plugins 平级，结构与 external-deps/ 一致（支持 茑萝/ide/ 等母文件夹）
pub fn get_user_external_deps_dir(app: &AppHandle) -> Option<PathBuf> {
    let app_data = app.path().app_data_dir().ok()?;
    Some(app_data.join("user_external_deps"))
}

/// 解析 ffmpeg 共享目录（含 ffmpeg.exe + avcodec/avformat/avutil 等 DLL）。
/// dev：external-deps/全局/ffmpeg（项目源码目录）；
/// release：user_external_deps/全局/ffmpeg（bundled-dlc 的 ffmpeg.mujin 经 extract_mujin_deps 解压后落地处）。
/// 统一供 get_ffmpeg_path 与 init_ffmpeg 使用，修复「打包后 .mujin 解压到 user_external_deps
/// 但旧查找只查 external-deps/，导致录屏找不到 ffmpeg/DLL」的链路断裂。
pub fn get_ffmpeg_dir(app: &AppHandle) -> Option<PathBuf> {
    // 1. dev / 打包资源：external-deps/全局/ffmpeg
    if let Some(deps_dir) = get_external_deps_dir(app) {
        let ffmpeg = deps_dir.join("全局").join("ffmpeg");
        if ffmpeg.exists() {
            return Some(ffmpeg);
        }
    }
    // 2. release 兜底：.mujin 解压到 user_external_deps/全局/ffmpeg
    if let Some(user_deps) = get_user_external_deps_dir(app) {
        let ffmpeg = user_deps.join("全局").join("ffmpeg");
        if ffmpeg.exists() {
            return Some(ffmpeg);
        }
    }
    None
}

/// 攻防模块 · 真实 TLS 指纹通道（curl-impersonate）的搜索根注入。
///
/// gongfang-kit 是独立 crate，拿不到 AppHandle 的路径解析能力，故由宿主在启动时
/// 把外部依赖目录交给它（顺序即优先级：user_external_deps 覆盖 external-deps，与
/// `find_external_dep` 的覆盖语义一致）。
/// 二进制预期位置：`<根>/全局/curl-impersonate/curl-impersonate.exe`（.mujin 打包同名）。
///
/// 未启用 `gongfang-tls-impersonate` feature 时为空实现（零开销）。
pub fn init_tls_impersonate(app: &AppHandle) {
    #[cfg(feature = "gongfang-tls-impersonate")]
    {
        let mut roots = Vec::new();
        if let Some(d) = get_user_external_deps_dir(app) {
            roots.push(d);
        }
        if let Some(d) = get_external_deps_dir(app) {
            roots.push(d);
        }
        if roots.is_empty() {
            log::warn!("[gongfang] TLS 指纹通道：未解析到外部依赖目录，将降级 rustls 通道");
        }
        gongfang_kit::crawler::impersonate::set_search_roots(roots);
    }
    #[cfg(not(feature = "gongfang-tls-impersonate"))]
    {
        let _ = app;
    }
}

// ========== .mufurong 专属格式自动解压 ==========
// .mufurong = ZIP 改后缀。用户把 .mufurong 文件放到 user_plugins/（或子目录）下，
// 应用启动或刷新插件列表时自动扫描并解压到同名目录。
// 已解压且 .mufurong 源文件 mtime 匹配则跳过（速度极快），不匹配则重新解压。
// 大型模块（茑萝/全局/阅读）保留母文件夹：子插件 .mufurong 放在母文件夹下，
// 如 user_plugins/茑萝/ai.mufurong → 解压到 user_plugins/茑萝/ai/

/// 专属格式文件后缀
pub(crate) const MUFURONG_EXT: &str = "mufurong";

/// marker 文件名：解压后在目标目录写入 .mufurong 源文件的 mtime（UNIX 秒数），
/// 用于下次扫描时跳过未变更的插件。与 .mujin 的 MUJIN_MARKER 对称。
pub(crate) const MUFURONG_MARKER: &str = ".mufurong.extracted";

/// 扫描 user_plugins/ 下的 .mufurong 文件，自动解压到同名目录。
/// 递归子目录以支持母文件夹结构（茑萝/、全局/ 等）。
pub fn extract_mufurong_plugins(app: &AppHandle) {
    let user_dir = match get_user_plugins_dir(app) {
        Some(d) => d,
        None => return,
    };
    if !user_dir.exists() {
        return;
    }
    walk_and_extract_mufurong(&user_dir);
}

/// 递归扫描目录下的 .mufurong 文件并解压
pub(crate) fn walk_and_extract_mufurong(dir: &std::path::Path) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            // 递归子目录（支持 茑萝/ 等母文件夹）
            walk_and_extract_mufurong(&path);
        } else if path.extension().and_then(|e| e.to_str()) == Some(MUFURONG_EXT) {
            if let Err(e) = extract_one_mufurong(&path) {
                eprintln!("[mufurong] 解压失败 {}: {}", path.display(), e);
            }
        }
    }
}

/// 解压单个 .mufurong 文件到同名目录（去掉 .mufurong 后缀）。
/// 版本比对策略：用 .mufurong 源文件 mtime 与目标目录下的 marker 文件
/// （.mufurong.extracted）内容比对，匹配则跳过。与 .mujin 的策略完全对称。
///
/// 用户源文件保护（3 道防线，与 extract_one_mujin 一致）：
/// 1. marker 不存在 + 目标目录已存在 → 视为用户手动放置的源文件，跳过避免覆盖
/// 2. marker 存在 + mtime 匹配 → 跳过（已解压最新）
/// 3. marker 存在 + mtime 不匹配 + 目标目录含 .mufurong 之外的用户文件 → 跳过避免覆盖
/// 仅当 marker 存在 + mtime 不匹配 + 无用户自定义文件时才执行 clean upgrade（DELETE + 重新解压）
pub(crate) fn extract_one_mufurong(mufurong_path: &std::path::Path) -> Result<(), String> {
    // 读取 .mufurong 源文件的 sha256（内容哈希），用于比对是否已解压最新版本
    let src_hash = sha256_file(mufurong_path).unwrap_or_default();

    // 解压目标目录：去掉 .mufurong 后缀
    let target_dir = mufurong_path.with_extension("");
    let marker_path = target_dir.join(MUFURONG_MARKER);

    if marker_path.exists() {
        // marker 存在 → 之前我们解压过，比较 mtime 决定是否重新解压
        if let Ok(content) = std::fs::read_to_string(&marker_path) {
                        if content.trim() == src_hash {
                return Ok(()); // 内容哈希匹配，跳过
            }
        }
        // marker 存在但内容哈希不匹配 → .mufurong 已更新，需要重新解压
        // 但先打开 .mufurong 检查目标目录是否有用户自定义文件
        let file = std::fs::File::open(mufurong_path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

        if target_dir.exists() {
            // 收集 .mufurong 内的文件清单
            let mut archive_files: std::collections::HashSet<String> = std::collections::HashSet::new();
            for i in 0..archive.len() {
                if let Ok(entry) = archive.by_index(i) {
                    let name = entry.name().to_string();
                    if !name.ends_with('/') {
                        archive_files.insert(name.replace('\\', "/"));
                    }
                }
            }
            // 扫描目标目录，找出 .mufurong 之外的用户自定义文件
            let mut extra_files: Vec<String> = Vec::new();
            collect_extra_files(&target_dir, &target_dir, &archive_files, &mut extra_files);
            if !extra_files.is_empty() {
                eprintln!(
                    "[mufurong] 跳过升级（目标目录含 {} 个 .mufurong 之外的用户文件，避免覆盖）: {}",
                    extra_files.len(),
                    mufurong_path.display()
                );
                // 不更新 marker，下次扫描仍会触发检查（用户可手动删除 target 后恢复自动升级）
                return Ok(());
            }
            // 无用户文件，安全清理 + 重新解压
            let _ = std::fs::remove_dir_all(&target_dir);
        }
        std::fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;

        // 重新解压
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
            let name = entry.name().to_string();
            // 安全检查：防止路径穿越（zip slip 攻击）
            if name.contains("..") {
                continue;
            }
            // 跳过自身 marker 文件（防止历史 .mufurong 内嵌的 marker 覆盖本次写入）
            if name == MUFURONG_MARKER || name.ends_with(&format!("/{}", MUFURONG_MARKER)) {
                continue;
            }
            let outpath = target_dir.join(&name);
            if entry.is_dir() {
                std::fs::create_dir_all(&outpath).ok();
            } else {
                if let Some(parent) = outpath.parent() {
                    std::fs::create_dir_all(parent).ok();
                }
                let mut outfile = std::fs::File::create(&outpath).map_err(|e| e.to_string())?;
                std::io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;
            }
        }

        // 写入 marker 文件，记录源文件 sha256，供下次扫描比对（内容变化即重解压）
        std::fs::write(&marker_path, &src_hash)
            .map_err(|e| format!("写入 marker 失败: {}", e))?;

        eprintln!(
            "[mufurong] 已升级解压: {} -> {}",
            mufurong_path.display(),
            target_dir.display()
        );
        return Ok(());
    }

    // marker 不存在的情况
    if target_dir.exists() {
        // marker 不存在但目标目录已存在 → 视为用户手动放置的源文件，跳过避免覆盖
        eprintln!(
            "[mufurong] 跳过（目标已存在但无 marker，视为用户源文件）: {}",
            mufurong_path.display()
        );
        return Ok(());
    }

    // marker 不存在 + 目标目录不存在 → 首次解压
    std::fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;

    let file = std::fs::File::open(mufurong_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        if name.contains("..") {
            continue;
        }
        if name == MUFURONG_MARKER || name.ends_with(&format!("/{}", MUFURONG_MARKER)) {
            continue;
        }
        let outpath = target_dir.join(&name);
        if entry.is_dir() {
            std::fs::create_dir_all(&outpath).ok();
        } else {
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            let mut outfile = std::fs::File::create(&outpath).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;
        }
    }

    // 写入 marker 文件，记录源文件 sha256，供下次扫描比对（内容变化即重解压）
    std::fs::write(&marker_path, &src_hash)
        .map_err(|e| format!("写入 marker 失败: {}", e))?;

    eprintln!(
        "[mufurong] 已解压: {} -> {}",
        mufurong_path.display(),
        target_dir.display()
    );
    Ok(())
}

// ========== .mujin 专属格式自动解压（外部依赖版） ==========
// .mujin = ZIP 改后缀，与 .mufurong 同源机制，但用于外部依赖（external-deps）。
// 用户把 .mujin 文件放到 user_external_deps/（或子目录）下，
// 应用启动或刷新插件列表时自动扫描并解压到同名目录。
// 已解压且 .mujin 源文件 mtime 匹配则跳过（速度极快），不匹配则重新解压。
//
// 大型模块（茑萝/全局/阅读）保留母文件夹：子依赖 .mujin 放在母文件夹下，
// 如 user_external_deps/茑萝/ide/codemirror.mujin → 解压到 user_external_deps/茑萝/ide/codemirror/
// 不可再分的依赖（markitdown/tiptap 等即使内部有子文件夹）整体打包成单个 .mujin。

/// 专属格式文件后缀
pub(crate) const MUJIN_EXT: &str = "mujin";

/// marker 文件名：解压后在目标目录写入 .mujin 源文件的 mtime（UNIX 秒数），
/// 用于下次扫描时跳过未变更的依赖。
pub(crate) const MUJIN_MARKER: &str = ".mujin.extracted";

/// 扫描 user_external_deps/ 下的 .mujin 文件，自动解压到同名目录。
/// 递归子目录以支持母文件夹结构（茑萝/ide/、全局/ 等）。
pub fn extract_mujin_deps(app: &AppHandle) {
    let user_dir = match get_user_external_deps_dir(app) {
        Some(d) => d,
        None => return,
    };
    if !user_dir.exists() {
        return;
    }
    walk_and_extract_mujin(&user_dir);
}

/// 递归扫描目录下的 .mujin 文件并解压
pub(crate) fn walk_and_extract_mujin(dir: &std::path::Path) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            // 递归子目录（支持 茑萝/ide/ 等母文件夹）
            walk_and_extract_mujin(&path);
        } else if path.extension().and_then(|e| e.to_str()) == Some(MUJIN_EXT) {
            if let Err(e) = extract_one_mujin(&path) {
                eprintln!("[mujin] 解压失败 {}: {}", path.display(), e);
            }
        }
    }
}

/// 解压单个 .mujin 文件到同名目录（去掉 .mujin 后缀）。
/// 版本比对策略：依赖可能没有 manifest.json，故用 .mujin 源文件 mtime 与
/// 目标目录下的 marker 文件（.mujin.extracted）内容比对，匹配则跳过。
///
/// 用户源文件保护（3 道防线）：
/// 1. marker 不存在 + 目标目录已存在 → 视为用户手动放置的源文件，跳过避免覆盖
/// 2. marker 存在 + mtime 匹配 → 跳过（已解压最新）
/// 3. marker 存在 + mtime 不匹配 + 目标目录含 .mujin 之外的用户文件 → 跳过避免覆盖
/// 仅当 marker 存在 + mtime 不匹配 + 无用户自定义文件时才执行 clean upgrade（DELETE + 重新解压）
pub(crate) fn extract_one_mujin(mujin_path: &std::path::Path) -> Result<(), String> {
    // 读取 .mujin 源文件的 mtime（UNIX 秒数）
    let src_mtime = std::fs::metadata(mujin_path)
        .and_then(|m| m.modified())
        .map_err(|e| format!("读取 mtime 失败: {}", e))?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // 解压目标目录：去掉 .mujin 后缀
    let target_dir = mujin_path.with_extension("");
    let marker_path = target_dir.join(MUJIN_MARKER);

    if marker_path.exists() {
        // marker 存在 → 之前我们解压过，比较 mtime 决定是否重新解压
        if let Ok(content) = std::fs::read_to_string(&marker_path) {
            if let Ok(existing_mtime) = content.trim().parse::<u64>() {
                if existing_mtime == src_mtime {
                    return Ok(()); // mtime 匹配，跳过
                }
            }
        }
        // marker 存在但 mtime 不匹配 → .mujin 已更新，需要重新解压
        // 但先打开 .mujin 检查目标目录是否有用户自定义文件
        let file = std::fs::File::open(mujin_path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

        if target_dir.exists() {
            // 收集 .mujin 内的文件清单
            let mut archive_files: std::collections::HashSet<String> = std::collections::HashSet::new();
            for i in 0..archive.len() {
                if let Ok(entry) = archive.by_index(i) {
                    let name = entry.name().to_string();
                    if !name.ends_with('/') {
                        archive_files.insert(name.replace('\\', "/"));
                    }
                }
            }
            // 扫描目标目录，找出 .mujin 之外的用户自定义文件
            let mut extra_files: Vec<String> = Vec::new();
            collect_extra_files(&target_dir, &target_dir, &archive_files, &mut extra_files);
            if !extra_files.is_empty() {
                eprintln!(
                    "[mujin] 跳过升级（目标目录含 {} 个 .mujin 之外的用户文件，避免覆盖）: {}",
                    extra_files.len(),
                    mujin_path.display()
                );
                // 不更新 marker，下次扫描仍会触发检查（用户可手动删除 target 后恢复自动升级）
                return Ok(());
            }
            // 无用户文件，安全清理 + 重新解压
            let _ = std::fs::remove_dir_all(&target_dir);
        }
        std::fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;

        // 重新解压
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
            let name = entry.name().to_string();
            // 安全检查：防止路径穿越（zip slip 攻击）
            if name.contains("..") {
                continue;
            }
            // 跳过自身 marker 文件（防止历史 .mujin 内嵌的 marker 覆盖本次写入）
            if name == MUJIN_MARKER || name.ends_with(&format!("/{}", MUJIN_MARKER)) {
                continue;
            }
            let outpath = target_dir.join(&name);
            if entry.is_dir() {
                std::fs::create_dir_all(&outpath).ok();
            } else {
                if let Some(parent) = outpath.parent() {
                    std::fs::create_dir_all(parent).ok();
                }
                let mut outfile = std::fs::File::create(&outpath).map_err(|e| e.to_string())?;
                std::io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;
            }
        }

        // 写入 marker 文件，记录源文件 mtime，供下次扫描比对
        std::fs::write(&marker_path, src_mtime.to_string())
            .map_err(|e| format!("写入 marker 失败: {}", e))?;

        eprintln!(
            "[mujin] 已升级解压: {} -> {}",
            mujin_path.display(),
            target_dir.display()
        );
        return Ok(());
    }

    // marker 不存在的情况
    if target_dir.exists() {
        // marker 不存在但目标目录已存在 → 视为用户手动放置的源文件，跳过避免覆盖
        eprintln!(
            "[mujin] 跳过（目标已存在但无 marker，视为用户源文件）: {}",
            mujin_path.display()
        );
        return Ok(());
    }

    // marker 不存在 + 目标目录不存在 → 首次解压
    std::fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;

    let file = std::fs::File::open(mujin_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        if name.contains("..") {
            continue;
        }
        if name == MUJIN_MARKER || name.ends_with(&format!("/{}", MUJIN_MARKER)) {
            continue;
        }
        let outpath = target_dir.join(&name);
        if entry.is_dir() {
            std::fs::create_dir_all(&outpath).ok();
        } else {
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            let mut outfile = std::fs::File::create(&outpath).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;
        }
    }

    // 写入 marker 文件
    std::fs::write(&marker_path, src_mtime.to_string())
        .map_err(|e| format!("写入 marker 失败: {}", e))?;

    eprintln!(
        "[mujin] 已解压: {} -> {}",
        mujin_path.display(),
        target_dir.display()
    );
    Ok(())
}

/// 递归收集 target_dir 中不在 archive_files 集合内的额外文件（用户自定义文件）。
/// 跳过所有 marker 文件（.mufurong.extracted / .mujin.extracted 等 .extracted 后缀文件），
/// rel_base 用于计算相对路径以便与 archive 内名称比对。
/// 同时供 extract_one_mufurong 与 extract_one_mujin 调用。
pub(crate) fn collect_extra_files(
    dir: &std::path::Path,
    rel_base: &std::path::Path,
    archive_files: &std::collections::HashSet<String>,
    out: &mut Vec<String>,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_extra_files(&path, rel_base, archive_files, out);
        } else {
            // 计算相对路径（用 / 分隔，与 archive 内名称一致）
            if let Ok(rel) = path.strip_prefix(rel_base) {
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                // 跳过所有 marker 文件（.mufurong.extracted / .mujin.extracted 等）
                // 约定式：所有以 ".extracted" 结尾的隐藏文件都是 marker，不属于用户文件
                if rel_str.ends_with(".extracted") {
                    continue;
                }
                if !archive_files.contains(&rel_str) {
                    out.push(rel_str);
                }
            }
        }
    }
}

// ========== bundled-dlc 内置私有格式分发 ==========
// 安装包不再含 raw bundled-plugins/ 与 external-deps/ 目录，
// 改为在 bundled-dlc/ 下放置 .mufurong/.mujin 私有格式包。
// 应用启动时一次性复制到 user_plugins/ 与 user_external_deps/，
// 然后由既有的 extract_mufurong_plugins / extract_mujin_deps 自动解压。
//
// 优势：
//   1. 安装包内只有压缩包（ZIP 改后缀），体积更小
//   2. 用户安装位置始终在 AppData 下，避免 Program Files 只读冲突
//   3. 与 .mufurong/.mujin DLC 分发渠道完全统一

/// 获取 bundled-dlc/ 目录（含 .mufurong/.mujin 私有格式资源）
/// 打包后：resource_dir/bundled-dlc/ 或 resource_dir/_up_/bundled-dlc/
/// 开发时：通常不存在（prepare-bundled-dlc.mjs 仅在 tauri build 前运行）
pub fn get_bundled_dlc_dir(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let dlc = resource_dir.join("bundled-dlc");
    if dlc.exists() {
        return Some(dlc);
    }
    let up_dlc = resource_dir.join("_up_").join("bundled-dlc");
    if up_dlc.exists() {
        return Some(up_dlc);
    }
    let dev_dlc = resource_dir.join("..").join("bundled-dlc");
    if dev_dlc.exists() {
        return Some(dev_dlc);
    }
    None
}

/// 从 bundled-dlc/ 复制 .mufurong/.mujin 到 user_plugins/ 与 user_external_deps/。
/// - .mufurong → user_plugins/<rel_path>（保留母文件夹结构 茑萝/、全局/）
/// - .mujin    → user_external_deps/<rel_path>（保留母文件夹结构 茑萝/ide/、全局/）
/// 已存在且大小相同的文件跳过（速度极快）。
/// 复制后由既有的 extract_mufurong_plugins / extract_mujin_deps 自动解压。
pub fn extract_bundled_dlc(app: &AppHandle) {
    let bundled_dlc = match get_bundled_dlc_dir(app) {
        Some(d) => d,
        None => return,
    };
    let user_plugins = match get_user_plugins_dir(app) {
        Some(d) => d,
        None => return,
    };
    let user_deps = match get_user_external_deps_dir(app) {
        Some(d) => d,
        None => return,
    };
    let _ = std::fs::create_dir_all(&user_plugins);
    let _ = std::fs::create_dir_all(&user_deps);

    // bundled-dlc/plugins/ → user_plugins/
    let bundled_plugins_dlc = bundled_dlc.join("plugins");
    if bundled_plugins_dlc.exists() {
        walk_copy_dlc(&bundled_plugins_dlc, &user_plugins, MUFURONG_EXT);
    }
    // bundled-dlc/external-deps/ → user_external_deps/
    let bundled_deps_dlc = bundled_dlc.join("external-deps");
    if bundled_deps_dlc.exists() {
        walk_copy_dlc(&bundled_deps_dlc, &user_deps, MUJIN_EXT);
    }
}

/// 递归扫描 src 目录下的 .<ext> 文件，复制到 dst 下保持相对路径。
/// 若目标已存在且 size 相同则跳过。
pub(crate) fn walk_copy_dlc(src: &std::path::Path, dst: &std::path::Path, ext: &str) {
    let entries = match std::fs::read_dir(src) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Ok(rel) = path.strip_prefix(src) {
                let sub_dst = dst.join(rel);
                walk_copy_dlc(&path, &sub_dst, ext);
            }
        } else if path.extension().and_then(|e| e.to_str()) == Some(ext) {
            if let Err(e) = copy_dlc_file(&path, src, dst) {
                eprintln!("[bundled-dlc] 复制失败 {}: {}", path.display(), e);
            }
        }
    }
}

/// 复制单个 .mufurong/.mujin 到 dst 下保持相对路径。
//// 计算文件 sha256 十六进制串（用于判断 .mufurong 内容是否变化）
pub(crate) fn sha256_file(path: &std::path::Path) -> Option<String> {
    use std::io::Read;
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => return None,
        };
        hasher.update(&buf[..n]);
    }
    Some(format!("{:x}", hasher.finalize()))
}

// 已存在且内容哈希相同则跳过；否则覆盖（用户可手动删除 user 端文件后重启恢复）。
pub(crate) fn copy_dlc_file(
    src_file: &std::path::Path,
    src_root: &std::path::Path,
    dst_root: &std::path::Path,
) -> Result<(), String> {
    let rel = src_file.strip_prefix(src_root).map_err(|e| e.to_string())?;
    let dst_file = dst_root.join(rel);
    if let Some(parent) = dst_file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    // 内容哈希一致则视为相同，跳过复制（比「大小一致」更可靠：
    // 大小相同但内容不同也能识别，避免陈旧 .mufurong 残留在 user_plugins）
    if let (Some(src_hash), Some(dst_hash)) = (sha256_file(src_file), sha256_file(&dst_file)) {
        if src_hash == dst_hash {
            return Ok(());
        }
    }
    std::fs::copy(src_file, &dst_file).map_err(|e| format!("复制文件失败: {}", e))?;
    eprintln!(
        "[bundled-dlc] 已复制: {} -> {}",
        src_file.display(),
        dst_file.display()
    );
    Ok(())
}

// ========== 插件可见性持久化 ==========
// 禁用状态持久化到 AppData/plugin_visibility.json（一个简单的 id→bool 映射）。
// 这样 bundled-plugins/ 在打包后即使只读（Program Files）也能正常启用/禁用插件，
// 且不污染源码 manifest.json。get_installed_plugins 读取此文件覆盖 manifest.visible。

// 历史说明：这里曾有一份「锁死」黑名单（FORCE_HIDDEN_PLUGIN_IDS，含 gongfang），
// 强制该插件不可见且拒绝用户启用。该机制已按用户要求整体移除 —— 代码层不再做任何可见性阻挡，
// 插件是否被分发改由「源码/部署目录里有没有这个插件」决定（把插件目录移出 plugins/ 即不参与构建与打包）。
// 因此可见性判定的唯一依据是下方：用户显式覆盖记录 > 默认开启。

/// 读取 plugin_visibility.json，返回 id→visible 映射
pub(crate) fn load_plugin_visibility_map(app: &AppHandle) -> std::collections::HashMap<String, bool> {
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
pub(crate) fn save_plugin_visibility(app: &AppHandle, plugin_id: &str, visible: bool) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| format!("获取 app_data_dir 失败: {}", e))?;
    std::fs::create_dir_all(&app_data).map_err(|e| format!("创建 app_data_dir 失败: {}", e))?;
    let path = app_data.join("plugin_visibility.json");
    let mut map = load_plugin_visibility_map(app);
    map.insert(plugin_id.to_string(), visible);
    let content = serde_json::to_string_pretty(&map).map_err(|e| format!("序列化失败: {}", e))?;
    std::fs::write(&path, content).map_err(|e| format!("写入 plugin_visibility.json 失败: {}", e))?;
    Ok(())
}

/// 从 plugin_visibility.json 中移除指定插件 id 的记录（删除插件时调用，避免残留无效配置）
pub(crate) fn remove_plugin_visibility(app: &AppHandle, plugin_id: &str) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| format!("获取 app_data_dir 失败: {}", e))?;
    let path = app_data.join("plugin_visibility.json");
    if !path.exists() {
        return Ok(());
    }
    let mut map = load_plugin_visibility_map(app);
    if map.remove(plugin_id).is_none() {
        return Ok(()); // 原本就没有该 id 的记录
    }
    let content = serde_json::to_string_pretty(&map).map_err(|e| format!("序列化失败: {}", e))?;
    std::fs::write(&path, content).map_err(|e| format!("写入 plugin_visibility.json 失败: {}", e))?;
    Ok(())
}

// ================= 原有的笔记服务函数 =================
pub(crate) fn notes_root_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {}", e))?;
    Ok(dir)
}
