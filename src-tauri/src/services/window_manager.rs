//! 浮窗（透明/layered WebView2 子窗）统一管理引擎 —— 批次 A：核心引擎 + 环境级自动修复。
//!
//! 背景：透明(layered)窗依赖 WebView2 的 GPU DirectComposition 合成面。当 WebView2 运行时
//! 发生「大版本升级」（例如 149.x → 150.x）时，`%LOCALAPPDATA%\com.rosary.andengyuanhua\EBWebView`
//! 里旧运行时时代的 GPU/着色器合成缓存与新运行时不兼容 → 合成面创建失败 → 所有透明窗
//! 报 `0x8007139F`（"组或资源状态不正确"）；不透明主窗不需合成面故正常。
//!
//! 本模块提供两层保障：
//!   1. `maybe_clear_gpu_cache_on_runtime_change_early()`：在任何 WebView2 创建之前（main() 的
//!      `tauri::Builder` 之前）清掉不兼容的 GPU/着色器缓存（保留 cookie/localStorage）。触发条件：
//!      运行时大版本变化，或上次启动透明窗创建失败（boot_state=failed）——构成自愈循环，根治 0x8007139F。
//!   2. `create_transparent_with_retry(...)`：透明窗创建的统一重试引擎——识别 0x8007139F 瞬态
//!      故障、退避重试、每次失败先销毁可能残留的坏窗，杜绝坏窗残留。

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// WebView2 运行时在 EdgeUpdate 注册表下的固定客户端 GUID。
const WEBVIEW2_CLIENT_GUID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

/// 应用内部标识符（红线常量，严禁改名——决定 EBWebView 数据目录位置）。
const APP_IDENTIFIER: &str = "com.rosary.andengyuanhua";

/// 与 GPU DirectComposition 合成面强相关、可安全清理的缓存子目录（相对 EBWebView）。
/// 仅清 GPU/着色器缓存，绝不动 cookie/localStorage/IndexedDB 等用户数据。
const GPU_CACHE_SUBDIRS: [&str; 6] = [
    "GPUPersistentCache",
    "GrShaderCache",
    "ShaderCache",
    "Default\\GPUCache",
    "Default\\DawnGraphiteCache",
    "Default\\DawnWebGPUCache",
];

/// 为每个浮窗计算独立的 WebView2 数据目录。
///
/// 关键修复：Tauri 用 `data_directory` 作为 `WebContext` 缓存 key，默认（None）时所有窗口
/// 共享同一个 WebContext / 同一个 WebView2 浏览器进程环境。在部分机器上（#5356 类），
/// 共享环境下创建「第二个及以后的 CoreWebView2Controller」会返回 0x8007139F 失败，而主窗
/// （首个控制器）正常。给每个浮窗独立的 data_directory → 各自独立的 WebContext / 浏览器进程
/// → 绕开该共享环境第二控制器失败。已用最小化 wry 双窗口程序验证：独立环境时第二窗成功。
pub fn per_window_data_dir(app: &tauri::AppHandle, label: &str) -> std::path::PathBuf {
    app
        .path()
        .app_data_dir()
        .map(|p| p.join("webviews").join(label))
        .unwrap_or_else(|_| std::env::temp_dir().join("andy_webviews").join(label))
}

/// 读取本机已安装的 WebView2 运行时版本号（形如 `150.0.4078.83`）。
///
/// 优先系统级安装（HKLM WOW6432Node），回退用户级安装（HKCU）。用 `reg query` 实现，
/// 零新依赖；在 `windows_subsystem="windows"` 下用 `CREATE_NO_WINDOW` 避免闪现控制台。
pub fn webview2_runtime_version() -> Option<String> {
    let keys = [
        format!(
            "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{}",
            WEBVIEW2_CLIENT_GUID
        ),
        format!(
            "HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{}",
            WEBVIEW2_CLIENT_GUID
        ),
        format!(
            "HKCU\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{}",
            WEBVIEW2_CLIENT_GUID
        ),
    ];
    for k in &keys {
        if let Some(v) = reg_query_pv(k) {
            return Some(v);
        }
    }
    None
}

/// 执行 `reg query <key> /v pv` 并解析出版本值。
fn reg_query_pv(key: &str) -> Option<String> {
    let mut cmd = std::process::Command::new("reg");
    cmd.args(["query", key, "/v", "pv"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    // 目标行形如：    pv    REG_SZ    150.0.4078.83
    for line in stdout.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("pv") {
            if let Some(last) = line.split_whitespace().last() {
                if !last.is_empty() && last.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
                    return Some(last.to_string());
                }
            }
        }
    }
    None
}

/// 取版本号的主版本段（`150.0.4078.83` → `150`）用于「大版本变化」判定。
fn major_of(version: &str) -> &str {
    version.split('.').next().unwrap_or(version)
}

/// EBWebView 数据目录（`%LOCALAPPDATA%\com.rosary.andengyuanhua\EBWebView`）。
fn ebwebview_dir() -> Option<std::path::PathBuf> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    Some(
        std::path::Path::new(&local)
            .join(APP_IDENTIFIER)
            .join("EBWebView"),
    )
}

/// 运行时版本记录文件（与 EBWebView 同级）。
fn runtime_marker_path() -> Option<std::path::PathBuf> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    Some(
        std::path::Path::new(&local)
            .join(APP_IDENTIFIER)
            .join("webview2_runtime_version.txt"),
    )
}

/// 启动结果记录文件（与 EBWebView 同级）：记录上次启动透明窗是否创建成功。
/// 用于「自愈循环」：若上次启动以 0x8007139F 失败，下次启动前清 GPU 缓存自救。
fn boot_state_path() -> Option<std::path::PathBuf> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    Some(
        std::path::Path::new(&local)
            .join(APP_IDENTIFIER)
            .join("boot_state.txt"),
    )
}

/// 标记本次启动透明窗创建「失败」（供下次启动自愈清缓存）。
pub fn mark_boot_failure() {
    if let Some(p) = boot_state_path() {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&p, "failed");
    }
}

/// 标记本次启动透明窗创建「成功」（清掉失败标记，避免下次无意义清缓存）。
pub fn mark_boot_success() {
    if let Some(p) = boot_state_path() {
        let _ = std::fs::write(&p, "ok");
    }
}

/// 清理 EBWebView 下与 GPU 合成相关的缓存子目录（保留 cookie/localStorage）。
/// 返回成功清理的目录数。**必须在 WebView2 未占用 EBWebView 时调用**，否则文件被占用删不掉。
pub fn clear_gpu_composition_caches() -> usize {
    let ebw = match ebwebview_dir() {
        Some(p) => p,
        None => return 0,
    };
    if !ebw.exists() {
        return 0;
    }
    let mut cleared = 0;
    for sub in GPU_CACHE_SUBDIRS {
        let p = ebw.join(sub);
        if p.exists() {
            match std::fs::remove_dir_all(&p) {
                Ok(_) => {
                    cleared += 1;
                    eprintln!("[WindowManager] 已清理 GPU 合成缓存: {}", p.display());
                }
                Err(e) => {
                    eprintln!(
                        "[WindowManager] 清理 GPU 合成缓存失败(可能被占用) {}: {}",
                        p.display(),
                        e
                    );
                }
            }
        }
    }
    cleared
}

/// 在任何 WebView2 创建之前调用（main() 的 `tauri::Builder` 之前）：
/// 比对本机 WebView2 运行时版本与上次记录的版本，检测到「大版本变化」就清掉不兼容的
/// GPU/着色器合成缓存，从根本上消除运行时升级导致的透明窗 0x8007139F。
///
/// 首次运行（无记录）不清缓存，仅写入版本基线，避免全新安装无谓清理。
pub fn maybe_clear_gpu_cache_on_runtime_change_early() {
    let current = match webview2_runtime_version() {
        Some(v) => v,
        None => {
            eprintln!("[WindowManager] 未能读取 WebView2 运行时版本，跳过环境自修复");
            return;
        }
    };
    let marker = match runtime_marker_path() {
        Some(p) => p,
        None => return,
    };
    let previous = std::fs::read_to_string(&marker)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // 上次启动是否以失败告终（透明窗 0x8007139F 未自愈）。若是，本次启动前清缓存自救。
    let boot_failed = boot_state_path()
        .and_then(|p| std::fs::read_to_string(&p).ok())
        .map(|s| s.trim() == "failed")
        .unwrap_or(false);
    let version_changed = previous
        .as_ref()
        .map_or(false, |prev| major_of(prev) != major_of(&current));

    if version_changed || boot_failed {
        let reason = if version_changed {
            format!(
                "运行时大版本变化 {} → {}",
                previous.as_deref().unwrap_or("?"),
                current
            )
        } else {
            "上次启动透明窗创建失败(0x8007139F)待自愈".to_string()
        };
        eprintln!(
            "[WindowManager] 检测到需清理 GPU 合成缓存（{}），自动清理",
            reason
        );
        let n = clear_gpu_composition_caches();
        eprintln!("[WindowManager] 环境自修复完成，清理 {} 个缓存目录", n);
    } else if previous.is_some() {
        eprintln!(
            "[WindowManager] WebView2 运行时版本一致({})，上次启动正常，无需清理缓存",
            previous.as_deref().unwrap()
        );
    } else {
        eprintln!(
            "[WindowManager] 首次记录 WebView2 运行时版本基线: {}（不清缓存）",
            current
        );
    }

    // 写回当前版本作为下次比对基线
    if let Some(parent) = marker.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(&marker, &current) {
        eprintln!("[WindowManager] 写入运行时版本基线失败: {}", e);
    }
    // 本次启动已尝试（基于旧 boot_state 完成自愈决策），先记「ok」；若后续浮窗创建真失败，
    // create 路径里的 mark_boot_failure() 会覆盖回 failed，下一启动继续自愈。避免残留 failed
    // 标记导致每次启动都无意义地清 GPU 缓存。
    mark_boot_success();
}

/// 透明窗创建的统一重试引擎。
///
/// 透明(layered)窗依赖 WebView2 DirectComposition 合成面，冷启动（尤其刚清过 GPU 缓存后）
/// 合成面可能在头几百毫秒尚未就绪，此时接连创建多个透明窗易撞 `0x8007139F`。本引擎：
///   - 识别 `0x8007139F` / `failed to create webview` 为瞬态故障；
///   - 退避重试（150/300/600/1000ms，最多 5 次）；
///   - 每次失败先销毁可能残留的坏窗（`label` 为窗口真实 label），杜绝坏窗残留占用 label。
///
/// **关键修复**：`b.build()` 在 WebView2 初始化失败时【仍返回 Ok】——HWND 已建出但 WebView2
/// 内部坏掉，wry 仅在日志里打 `[ERROR] failed to create webview`。若仅依赖 `build()` 的返回值，
/// 5 次重试全是「假成功」，最终 mark_boot_failure 不会被调用，自愈循环断链。
/// 因此 `create()` 返回 Ok 后必须做一次【同步健康检查】：sleep 300ms 等 WebView2 初始化完成，
/// 再调 `scale_factor()` 验证。失败则销毁坏窗并真正进入重试。
///
/// `create` 闭包应是幂等的（已存在则复用、失败则不注册坏窗），故重试绝对安全。
pub fn create_transparent_with_retry<E: std::fmt::Display>(
    app: &tauri::AppHandle,
    label: &str,
    mut create: impl FnMut() -> Result<(), E>,
) -> bool {
    const BACKOFF_MS: [u64; 4] = [150, 300, 600, 1000];
    const MAX_ATTEMPTS: usize = 5;
    const HEALTH_PROBE_MS: u64 = 300;
    for attempt in 1..=MAX_ATTEMPTS {
        match create() {
            Ok(_) => {
                // 同步健康检查：build() 在 WebView2 初始化失败时仍可能返回 Ok，
                // 必须等待 WebView2 真正完成初始化后再用 scale_factor 验证。
                // 否则坏窗会被当作成功 → mark_boot_success → 下次启动不清 GPU 缓存 → 自愈循环断链。
                std::thread::sleep(std::time::Duration::from_millis(HEALTH_PROBE_MS));
                let healthy = app
                    .get_webview_window(label)
                    .map(|w| w.scale_factor().is_ok())
                    .unwrap_or(false);
                if healthy {
                    return true;
                }
                // 坏窗：销毁后走重试流程（与 build() 报错时一致）
                if let Some(w) = app.get_webview_window(label) {
                    let _ = w.destroy();
                }
                eprintln!(
                    "[WindowManager] 启动窗 {} 第{}/{}次健康检查失败（WebView2 初始化未完成或 0x8007139F），销毁重试",
                    label, attempt, MAX_ATTEMPTS
                );
                if attempt < MAX_ATTEMPTS {
                    let backoff = BACKOFF_MS[(attempt - 1).min(BACKOFF_MS.len() - 1)];
                    std::thread::sleep(std::time::Duration::from_millis(backoff));
                }
            }
            Err(e) => {
                let es = e.to_string();
                let low = es.to_lowercase();
                let transient = low.contains("8007139f") || low.contains("failed to create webview");
                eprintln!(
                    "[WindowManager] 透明窗 {} 第{}/{}次创建失败: {}{}",
                    label,
                    attempt,
                    MAX_ATTEMPTS,
                    es,
                    if transient {
                        "（0x8007139F 瞬态：GPU 合成面未就绪，退避重试）"
                    } else {
                        ""
                    }
                );
                // 清理可能残留的坏窗，确保下次重试真正重建、不被占用的 label 阻挡
                if let Some(w) = app.get_webview_window(label) {
                    let _ = w.destroy();
                }
                if attempt < MAX_ATTEMPTS {
                    let backoff = BACKOFF_MS[(attempt - 1).min(BACKOFF_MS.len() - 1)];
                    std::thread::sleep(std::time::Duration::from_millis(backoff));
                }
            }
        }
    }
    eprintln!(
        "[WindowManager] 透明窗 {} {}次重试仍失败，标记本次启动失败（下次启动将清缓存自愈）",
        label, MAX_ATTEMPTS
    );
    mark_boot_failure();
    false
}

/// 诊断命令：返回各浮窗的存在性与健康度（能否取到缩放比——坏窗最可靠的信号），
/// 以及当前 WebView2 运行时版本。用于排查 0x8007139F 时一眼看清哪个窗坏了。
#[tauri::command]
pub fn overlay_window_health(app: tauri::AppHandle) -> serde_json::Value {
    const LABELS: [&str; 9] = [
        "main",
        "lyrics-widget",
        "recorder-widget",
        "recorder-select",
        "recording-border",
        "screenshot-overlay",
        "tray-menu",
        "floating-clipboard",
        "floating-dropzone",
    ];
    let mut windows = Vec::new();
    for label in LABELS {
        let (exists, healthy) = match app.get_webview_window(label) {
            Some(w) => (true, w.scale_factor().is_ok()),
            None => (false, false),
        };
        windows.push(serde_json::json!({
            "label": label,
            "exists": exists,
            "healthy": healthy,
        }));
    }
    serde_json::json!({
        "windows": windows,
        "webview2_runtime": webview2_runtime_version(),
    })
}

/// 把闭包 marshal 到主线程执行，并【阻塞等待】其真正执行完成后再返回结果。
///
/// 关键：Tauri 2 的 `run_on_main_thread` 是「非阻塞」的——它只把闭包排队到主线程事件循环、
/// 立刻返回，闭包在后续事件循环迭代才执行。批次 B 初版用 `Arc<Mutex>` 在闭包执行前立刻读取，
/// 永远拿到 `None`（报「未返回构建结果」），真正的错误是主线程稍后异步执行时才打的，重试完全失效。
/// 这里用 `(Mutex, Condvar)` 等闭包跑完，并用 `catch_unwind` 兜住闭包内 panic（避免 panic 被吞、
/// 结果永远为空导致误判失败）。
fn run_on_main_thread_result<F, R>(app: &tauri::AppHandle, f: F) -> Result<R, String>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    // 闭包内用 catch_unwind 兜住 panic：完成标记里存的是 `Result<R, Box<dyn Any + Send>>`。
    type Slot<R> = Option<Result<R, Box<dyn std::any::Any + Send>>>;
    let pair: std::sync::Arc<(std::sync::Mutex<Slot<R>>, std::sync::Condvar)> =
        std::sync::Arc::new((std::sync::Mutex::new(None), std::sync::Condvar::new()));
    let pair2 = pair.clone();
    app.run_on_main_thread(move || {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
        let mut slot = pair2.0.lock().unwrap();
        *slot = Some(r);
        pair2.1.notify_one();
    })
    .map_err(|e| format!("marshal 到主线程失败: {}", e))?;
    let (lock, cvar) = &*pair;
    let mut slot = lock.lock().unwrap();
    while slot.is_none() {
        slot = cvar.wait(slot).unwrap();
    }
    slot.take()
        .unwrap()
        .map_err(|_| "主线程建窗闭包发生 panic（已兜住，不会让命令误判为未返回）".to_string())
}

/// 诊断/修复命令：手动触发清理 GPU 合成缓存。
/// 注意：运行中 WebView2 占用 EBWebView，部分文件可能删不掉，需重启后彻底生效。
#[tauri::command]
pub fn overlay_clear_gpu_cache() -> Result<String, String> {
    let n = clear_gpu_composition_caches();
    Ok(format!(
        "已尝试清理 GPU 合成缓存，成功清理 {} 个目录（若部分被占用，重启应用后生效）",
        n
    ))
}

/// 前端动态浮窗的统一创建 profile（反序列化自 `invoke('overlay_window_get_or_create')` 的 profile 参数）。
/// 所有字段可选，未传则套用透明的「安全默认档」——与已验证可抗 0x8007139F 的写法一致。
#[derive(serde::Deserialize, Default)]
pub struct OverlayProfile {
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub min_width: Option<f64>,
    pub min_height: Option<f64>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub transparent: Option<bool>,
    pub decorations: Option<bool>,
    pub shadow: Option<bool>,
    pub skip_taskbar: Option<bool>,
    pub always_on_top: Option<bool>,
    pub resizable: Option<bool>,
    pub drag_drop_enabled: Option<bool>,
    /// 预热场景：为 true 时窗口 build 后立即隐藏（绘制前不可见），不再依赖离屏坐标；
    /// 仍用 visible:true 创建以规避 WebView2 0x8007139F。
    pub hidden: Option<bool>,
}

/// 前端统一建窗命令：所有动态浮窗（截图/托盘/剪贴板/中转站/浮窗笔记/插件沙箱）都改走它，
/// 不再各自 `new WebviewWindow`。彻底消除「命令里建窗死锁」「坏窗残留」「错误抓不到」三类问题。
///
/// 设计要点：
/// - 用 `run_on_main_thread_result(...)` 把 `WebviewWindowBuilder::build()` marshal 到主线程并**阻塞等结果**
///   （Tauri 2 的 `run_on_main_thread` 本身是非阻塞的，立刻读结果只会拿到空值）。窗口必须在拥有事件循环的主
///   线程创建，命令跑在 async 线程直接 `build` 会 0x8007139F/死锁；marshal 后让前端按需窗也享受与 `setup`
///   常驻窗完全相同的主线程安全创建 + 重试。
/// - 复用：已存在且健康（能取缩放比）的窗直接返回 label，不重建。
/// - **同步健康检查（关键修复）**：`b.build()` 在 WebView2 初始化失败时仍返回 Ok——HWND 已建出但
///   WebView2 内部坏掉（wry 仅在日志打 `[ERROR] failed to create webview`）。原实现把异步 300ms 探测
///   放在独立线程里，函数早已 `return Ok(label)` —— 前端拿到「成功」立即去用窗口，遇到坏窗报
///   `无法获取缩放比`。改为：build 返回 Ok 后**先 sleep 300ms 等 WebView2 完成初始化，再同步调
///   `scale_factor()` 验证**。失败则销毁坏窗并真正进入重试。
/// - 智能重试：识别 `0x8007139F`/`failed to create webview` 为瞬态故障，退避 150/300/600/1000ms 最多 5 次，
///   每次失败先 `destroy()` 该 label 再重试，确保无坏窗残留。
/// - 命中 0x8007139F 时立即尝试清理 GPU 合成缓存（根因自愈），随后继续退避重试——多数情况下清缓存后下一次
///   重试即成功，无需重启。
/// - **`mark_boot_failure()` 收尾（关键修复）**：5 次重试全部失败时标记本次启动失败，下次启动前
///   `maybe_clear_gpu_cache_on_runtime_change_early()` 会清 GPU 缓存自救。原实现不调用 mark_boot_failure，
///   导致运行时浮窗失败时下次启动也不清缓存，自愈循环断链。
/// - **绝不用 `visible:false`** 创建透明(layered)窗（否则 WebView2 初始化失败 → 0x8007139F 坏窗）。
#[tauri::command]
pub async fn overlay_window_get_or_create(
    app: tauri::AppHandle,
    label: String,
    url: String,
    profile: Option<OverlayProfile>,
) -> Result<String, String> {
    let p = profile.unwrap_or_default();

    // 复用已有健康窗：能取缩放比即健康，直接返回
    if let Some(w) = app.get_webview_window(&label) {
        if w.scale_factor().is_ok() {
            return Ok(label);
        }
        // 半注册坏窗：先清掉，避免占用 label 阻挡重建
        let _ = w.destroy();
    }

    let transparent = p.transparent.unwrap_or(true);
    let decorations = p.decorations.unwrap_or(false);
    let shadow = p.shadow.unwrap_or(false);
    let skip_taskbar = p.skip_taskbar.unwrap_or(false);
    let always_on_top = p.always_on_top.unwrap_or(true);
    let resizable = p.resizable.unwrap_or(false);
    let drag_drop = p.drag_drop_enabled.unwrap_or(true);
    let hidden = p.hidden.unwrap_or(false);
    let x = p.x.unwrap_or(-4000.0);
    let y = p.y.unwrap_or(-4000.0);
    let inner_w = p.width.unwrap_or(480.0);
    let inner_h = p.height.unwrap_or(400.0);
    let min_w = p.min_width;
    let min_h = p.min_height;

    const BACKOFF_MS: [u64; 4] = [150, 300, 600, 1000];
    const HEALTH_PROBE_MS: u64 = 300;
    let mut last_err = String::new();
    // 进程内只触发一次 GPU 缓存自愈（命中 0x8007139F 时），避免重复清缓存抖动
    static CACHE_SELF_HEALED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    use std::sync::atomic::Ordering;

    for attempt in 1..=5 {
        // 每次重试前先清残留坏窗，确保真正重建而非被占用的 label 阻挡
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.destroy();
        }

        let build_app = app.clone();
        let build_label = label.clone();
        let build_url = url.clone();
        // 关键修复：独立 data_directory → 独立 WebContext / 浏览器进程，绕开共享环境第二控制器 0x8007139F
        let per_win_dd = per_window_data_dir(&build_app, &build_label);

        // 用 run_on_main_thread_result 把 build 闭包 marshal 到主线程并【阻塞等结果】。
        // 直接 run_on_main_thread 是非阻塞的（闭包排队到事件循环稍后执行），立刻读共享变量只会拿到
        // 空值——这正是初版「未返回构建结果」的根因；现用 Condvar 等闭包真正跑完再返回。
        let built: Result<(), String> = run_on_main_thread_result(&app, move || {
            let mut b = WebviewWindowBuilder::new(
                &build_app,
                build_label,
                WebviewUrl::App(build_url.into()),
            )
            .decorations(decorations)
            .transparent(transparent)
            .shadow(shadow)
            .skip_taskbar(skip_taskbar)
            .always_on_top(always_on_top)
            .resizable(resizable)
            .position(x, y)
            .inner_size(inner_w, inner_h)
            .visible(true) // 透明(layered)窗绝不用 visible:false，否则 WebView2 报 0x8007139F 坏窗
            .data_directory(per_win_dd);
            if let Some(mw) = min_w {
                b = b.min_inner_size(mw, min_h.unwrap_or(200.0));
            }
            // 默认启用原生拖放；仅当 profile 显式 drag_drop_enabled=false（如中转站浮窗）时禁用。
            if !drag_drop {
                b = b.disable_drag_drop_handler();
            }
            match b.build() {
                Ok(w) => {
                    // 预热场景：build 成功后立即隐藏，确保窗口在任何绘制前不可见。
                    // 仍用 visible:true 创建以规避 WebView2 0x8007139F；隐藏在 build 同闭包内完成，
                    // 不依赖离屏坐标（多屏下 -4000 也可能落入可见区）。WebView2 已在 build 时初始化，
                    // 隐藏不影响后续「即点即用」冷启动收益。
                    if hidden {
                        let _ = w.hide();
                    }
                    Ok(())
                }
                Err(e) => Err(e.to_string()),
            }
        })?;

        match built {
            Ok(()) => {
                // 同步健康检查：build() 在 WebView2 初始化失败时【仍返回 Ok】——HWND 已建出但
                // WebView2 内部坏掉（wry 仅在日志打 `[ERROR] failed to create webview`）。
                // 必须等待 WebView2 真正完成初始化后再用 scale_factor 验证，否则函数返回 Ok 后
                // 前端立即用窗口会撞 `无法获取缩放比`，且原异步探测线程此时还没运行。
                tokio::time::sleep(std::time::Duration::from_millis(HEALTH_PROBE_MS)).await;

                let probe_app = app.clone();
                let probe_label = label.clone();
                let healthy: bool = run_on_main_thread_result(&app, move || {
                    probe_app
                        .get_webview_window(&probe_label)
                        .map(|w| w.scale_factor().is_ok())
                        .unwrap_or(false)
                })?;

                if healthy {
                    return Ok(label);
                }

                // 坏窗：销毁后走重试流程（与 build() 报错时一致）
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = w.destroy();
                }
                last_err = "WebView2 初始化未完成（健康检查 scale_factor 失败）".to_string();
                eprintln!(
                    "[WindowManager] 浮窗 {} 第{}/5次健康检查失败（坏窗已销毁，重试）",
                    label, attempt
                );
                if attempt < 5 {
                    let backoff = BACKOFF_MS[(attempt - 1).min(BACKOFF_MS.len() - 1)];
                    tokio::time::sleep(std::time::Duration::from_millis(backoff)).await;
                }
            }
            Err(e) => {
                last_err = e.clone();
                let low = e.to_lowercase();
                let transient =
                    low.contains("8007139f") || low.contains("failed to create webview");
                // 首次命中 0x8007139F 瞬态故障，立即尝试清理 GPU 合成缓存（根因自愈），随后继续退避重试。
                if transient && !CACHE_SELF_HEALED.swap(true, Ordering::SeqCst) {
                    let n = clear_gpu_composition_caches();
                    eprintln!(
                        "[WindowManager] 浮窗 {} 命中 0x8007139F，已尝试自愈清理 GPU 合成缓存 {} 个目录（若被占用需重启彻底生效）",
                        label, n
                    );
                }
                eprintln!(
                    "[WindowManager] 浮窗 {} 第{}/5次创建失败: {}{}",
                    label,
                    attempt,
                    e,
                    if transient {
                        "（瞬态：GPU 合成面未就绪，退避重试）"
                    } else {
                        ""
                    }
                );
                if attempt < 5 {
                    let backoff = BACKOFF_MS[(attempt - 1).min(BACKOFF_MS.len() - 1)];
                    tokio::time::sleep(std::time::Duration::from_millis(backoff)).await;
                }
            }
        }
    }
    // 关键修复：标记本次启动失败，下次启动前 maybe_clear_gpu_cache_on_runtime_change_early()
    // 会清 GPU 合成缓存自救。原实现缺这一步 → 运行时浮窗全坏但下次启动也不清缓存，自愈循环断链。
    mark_boot_failure();
    Err(format!(
        "浮窗 {} 创建失败（已重试 5 次）: {}",
        label, last_err
    ))
}

/// 销毁指定浮窗（前端统一入口的关闭通道，与 `overlay_window_get_or_create` 配对）。
#[tauri::command]
pub fn overlay_window_destroy(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(&label) {
        w.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 诊断实验 v2：隔离 0x8007139F 真凶，并区分「窗被销毁」vs「窗在但 webview 死」两种结局。
///
/// 关键认知（推翻初版结论）：启动窗在 `build()` 同步报 0x8007139F（次级控制器创建即失败），
/// 但隔离窗 `build()` 成功、500ms 后才坏死——两者时序不同，不是同一个「次级控制器永远建不出」。
/// 所以本版重点查清：窗到底是【被谁销毁】还是【webview 自行崩溃】，以及【前端 JS 是否参与】。
///
/// 每种配置：(名字, transparent, x, y, url_kind, pre_sleep_ms)
///   url_kind="app"   -> 导航 "/"（运行完整前端，暴露「前端误关窗」嫌疑）
///   url_kind="blank" -> 导航一个不存在的自定义协议路径（不加载前端 JS，隔离前端干扰）
///   pre_sleep_ms     -> 建窗前先阻塞等待，测试「延迟创建是否存活」
///
/// 探活拆分 exists_500ms（窗口对象是否还在 Tauri 窗口管理器）与 scale_ok_500ms（能取缩放比=webview 活着），
/// 二者组合即可区分：exists=false => 窗被销毁（我方代码/前端/wry 主动关）；exists=true&scale=false => 窗在但 webview 崩溃。
/// 触发：正常启动下启动窗失败会自动跑；或设 ANDY_DIAG=1 启动跳过正常浮窗只跑本实验。
#[tauri::command]
pub async fn overlay_window_diag(app: tauri::AppHandle) -> serde_json::Value {
    let cases: Vec<(&str, bool, f64, f64, &str, u64)> = vec![
        ("opaque-normal", false, 200.0, 200.0, "app", 0),
        ("transparent-normal", true, 200.0, 200.0, "app", 0),
        ("opaque-offscreen", false, -4000.0, -4000.0, "app", 0),
        ("transparent-offscreen", true, -4000.0, -4000.0, "app", 0),
        // blank 用例：不加载前端 JS，隔离「前端运行期误关窗」嫌疑
        ("opaque-blank", false, 200.0, 200.0, "blank", 0),
        ("transparent-blank", true, 200.0, 200.0, "blank", 0),
        // late 用例：建窗前先等 3s，测试「延迟创建的窗是否逃脱早期环境未就绪 / 启动期污染」
        ("late-opaque-normal", false, 200.0, 200.0, "app", 3000),
    ];
    let mut results = Vec::new();
    for (name, transparent, x, y, url_kind, pre_sleep_ms) in cases {
        let label = format!("__diag_{}", name);
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.destroy();
        }
        if pre_sleep_ms > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(pre_sleep_ms)).await;
        }
        let url = if url_kind == "blank" {
            WebviewUrl::App("__diag_blank__.html".into()) // 自定义协议 404，不加载前端 JS
        } else {
            WebviewUrl::App("/".into())
        };
        // 建窗必须在主线程（WebView2 限制），run_on_main_thread_result 阻塞等结果
        let build_app = app.clone();
        let t0 = std::time::Instant::now();
        // 关键修复：独立 data_directory → 独立 WebContext / 浏览器进程，绕开共享环境第二控制器 0x8007139F
        let per_win_dd = per_window_data_dir(&build_app, &label);
        let built: Result<(), String> = run_on_main_thread_result(&build_app, {
            let build_label = label.clone();
            let inner = build_app.clone();
            let build_url = url.clone();
            move || {
                WebviewWindowBuilder::new(&inner, build_label, build_url)
                    .decorations(false)
                    .transparent(transparent)
                    .shadow(false)
                    .skip_taskbar(false)
                    .always_on_top(true)
                    .resizable(false)
                    .position(x, y)
                    .inner_size(400.0, 300.0)
                    .visible(true)
                    .data_directory(per_win_dd)
                    .build()
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            }
        })
        .unwrap_or_else(|e| Err(format!("marshal 失败: {}", e)));
        let build_ms = t0.elapsed().as_millis() as u64;

        // 坏窗可能在 build 返回 Ok 后 ~300ms 才坏死，故等 500ms 再探活
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        // 探活拆分 exists / scale_ok，主线程执行（scale_factor 需主线程）
        let probe_app = app.clone();
        let (exists, scale_ok): (bool, bool) = run_on_main_thread_result(&probe_app, {
            let probe_label = label.clone();
            let inner2 = probe_app.clone();
            move || match inner2.get_webview_window(&probe_label) {
                Some(w) => (true, w.scale_factor().is_ok()),
                None => (false, false),
            }
        })
        .unwrap_or((false, false));
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.destroy();
        }
        let err = built.as_ref().err().cloned();
        eprintln!(
            "[DIAG] {} transparent={} url={} pos=({},{}): build_ok={} build_ms={} exists_500ms={} scale_ok_500ms={} err={:?}",
            name, transparent, url_kind, x, y, built.is_ok(), build_ms, exists, scale_ok, err
        );
        results.push(serde_json::json!({
            "case": name,
            "transparent": transparent,
            "url": url_kind,
            "pos": [x, y],
            "build_ok": built.is_ok(),
            "build_ms": build_ms,
            "exists_500ms": exists,
            "scale_ok_500ms": scale_ok,
            "build_err": err,
        }));
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    serde_json::json!({ "results": results })
}
