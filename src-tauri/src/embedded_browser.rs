//! 内置浏览器窗口（网络视频 / 网络图片等「官方网页」壳）。
//!
//! # 为什么是「独立窗口」而不是「面板里的子 webview」
//!
//! 最初改用 tauri 的多 webview 能力 `Window::add_child`，把子 webview 精确铺在
//! 面板矩形上。实机验证（Windows / WebView2）发现：子 webview 的 HWND 确实创建在
//! 正确位置，但**始终被主 webview 的合成层盖住**，页面只呈现一片白色 ——
//! 提升 HWND 的 z-order 也无效（WebView2 走的是 DComp 合成，不是 GDI 绘制顺序）。
//!
//! 因此改为 **真正的 Tauri 窗口**（WebviewWindow）承载平台页面：
//! - 一定可见、可输入；
//! - 不遮挡主界面（用户可自由拖动/缩放/最大化）；
//! - 与「面板里嵌网页」相比只是少了贴边，稳定性完全不在一个量级。
//!
//! # 多平台并行
//!
//! 每个调用方用 `target`（平台 id）区分，窗口 label = `browser-<target>`，
//! 因此 B 站与抖音可以同时各开一个窗口；`browser_close_all` 用于离开模块时统一收尾。
//!
//! # 登录态
//!
//! 所有浏览器窗口共用**固定**的 WebView2 数据目录（`app_local_data_dir/browser-profile`），
//! cookie / localStorage 随目录持久化：登录一次，下次启动仍在。
//! 注意必须与主窗口使用**同一组** `additional_browser_args`（见 `BROWSER_ARGS`），
//! 否则 WebView2 会拒绝创建（HRESULT 0x8007139F）。
//!
//! # 嗅探通道
//!
//! 外部页面无法使用 Tauri IPC，因此注入脚本把结果经本协议送出：
//! `location.href = "http://bimedia.localhost/__report/<b64u(json)>"`，
//! 由 `on_navigation` 截获并 `return false` 取消导航（页面不会跳走），
//! 载荷按窗口 label 存入 `media_relay` 的进程内缓冲，前端用 `browser_sniff(target)` 取走。
//! 用「导航」而非 fetch 的原因：外部站点的 CSP 管不到导航，但很可能把 fetch 拦掉。

use std::sync::Mutex;

use tauri::http::{header, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// 窗口 label 前缀（同时用于 `browser_close_all` 的批量识别）
pub const LABEL_PREFIX: &str = "browser-";

/// 浏览器下载被凌霄接管时发给前端的事件名。
pub const DOWNLOAD_CAPTURE_EVENT: &str = "download-kit:browser-capture";

/// 被浏览器触发、等待用户决定是否交给凌霄的下载。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDownloadCapture {
    pub url: String,
    pub created_at: i64,
    /// 触发下载的浏览器窗口 label（取 Cookie 时用）。
    pub target: String,
}

/// 进程内缓冲：凌霄没打开时先把捕获存下来，下次打开再取。
static PENDING_DOWNLOAD_CAPTURES: Mutex<Vec<BrowserDownloadCapture>> = Mutex::new(Vec::new());

fn push_download_capture(app: &AppHandle, url: String, target: String) {
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    let capture = BrowserDownloadCapture {
        url,
        created_at,
        target,
    };
    if let Ok(mut guard) = PENDING_DOWNLOAD_CAPTURES.lock() {
        if guard.iter().any(|item| item.url == capture.url) {
            return;
        }
        guard.push(capture.clone());
        if guard.len() > 50 {
            guard.remove(0);
        }
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = app.emit(DOWNLOAD_CAPTURE_EVENT, capture);
    });
}

/// 读取凌霄的接管开关；读不到配置时按开启处理（默认接管）。
fn takeover_enabled(app: &AppHandle) -> bool {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| download_kit::config::load(&dir.join("download-kit")).browser_takeover)
        .unwrap_or(true)
}

/// 取走尚未处理的浏览器下载捕获（凌霄打开时调用）。
#[tauri::command]
pub fn browser_download_captures_take() -> Vec<BrowserDownloadCapture> {
    PENDING_DOWNLOAD_CAPTURES
        .lock()
        .map(|mut guard| std::mem::take(&mut *guard))
        .unwrap_or_default()
}

/// 取某个浏览器窗口对目标 URL 的 Cookie，拼成请求头值（`a=1; b=2`）。
#[tauri::command]
pub fn browser_cookie_header(
    app: AppHandle,
    target: Option<String>,
    url: String,
) -> Result<String, String> {
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("Cookie 目标地址无效: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Ok(String::new());
    }
    let label = window_label(target.as_deref());
    let win = app
        .get_webview_window(&label)
        .ok_or_else(|| "浏览器窗口尚未打开".to_string())?;
    let cookies = win
        .cookies_for_url(parsed)
        .map_err(|e| format!("读取浏览器 Cookie 失败: {e}"))?;
    Ok(cookies
        .iter()
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect::<Vec<_>>()
        .join("; "))
}

/// 浏览器窗口的 UA：伪装成普通桌面 Edge。
///
/// 默认 UA 会带 Tauri 标识，抖音 / B 站 / pixiv 等站点会据此判定为「非常规浏览器」，
/// 表现为白屏、强制登录或滑块 —— 这是内嵌浏览器打不开页面最常见的原因。
const DESKTOP_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) \
     Chrome/132.0.0.0 Safari/537.36 Edg/132.0.0.0";

/// 与主窗口 tauri.conf.json 的 `additionalBrowserArgs` **必须逐字一致**。
///
/// WebView2 的同一个 user-data 目录只允许一套环境参数；新窗口若换成另一组
/// browser args，WebView2 会直接拒绝创建（实测 HRESULT 0x8007139F「组或资源的状态
/// 不是执行请求操作的正确状态」）。这正是「命令返回成功但窗口没出现」的根因。
const BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,MediaSession,HardwareMediaKeyHandling";

/// 把 target（平台 id）规整成合法 label 片段：只留小写字母/数字/连字符。
fn sanitize_target(target: Option<&str>) -> String {
    let raw = target.unwrap_or("").trim().to_lowercase();
    let mut out = String::with_capacity(raw.len());
    for c in raw.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        }
    }
    if out.is_empty() {
        "main".to_string()
    } else {
        out.chars().take(32).collect()
    }
}

/// target → 窗口 label
fn window_label(target: Option<&str>) -> String {
    format!("{}{}", LABEL_PREFIX, sanitize_target(target))
}

/// 注入到每个页面最前面的嗅探钩子。
///
/// 主通道是 `PerformanceObserver`（**不修改页面任何原型**，能拿到页面加载的每一个资源）；
/// fetch / XHR 钩子作为补充，用于捕捉「发起但尚未出现在 resource timing 里」的请求
/// （m3u8 之类常走这条路）。刻意**不**去 patch `HTMLMediaElement.prototype.src`：
/// 那会破坏部分播放器的内部逻辑，风险大于收益。
const SNIFF_HOOK: &str = r#"(function () {
  if (window.__sniffHookInstalled) return;
  window.__sniffHookInstalled = true;
  window.__sniffLog = [];
  function push(u, src, initiatorType) {
    try {
      if (!u || typeof u !== 'string') return;
      if (u.indexOf('blob:') === 0 || u.indexOf('data:') === 0) return;
      window.__sniffLog.push({ url: u, src: src, it: initiatorType || '' });
      if (window.__sniffLog.length > 1200) window.__sniffLog.shift();
    } catch (e) {}
  }
  try {
    var po = new PerformanceObserver(function (list) {
      var es = list.getEntries();
      for (var i = 0; i < es.length; i++) push(es[i].name, 'perf', es[i].initiatorType);
    });
    po.observe({ type: 'resource', buffered: true });
  } catch (e) {}
  try {
    var _fetch = window.fetch;
    if (_fetch) {
      window.fetch = function (input, init) {
        try { push(typeof input === 'string' ? input : (input && input.url), 'fetch', 'fetch'); } catch (e) {}
        return _fetch.apply(this, arguments);
      };
    }
  } catch (e) {}
  try {
    var _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) { push(u, 'xhr', 'xmlhttprequest'); return _open.apply(this, arguments); };
  } catch (e) {}
})();"#;

/// 前端点「嗅探」时执行的收集脚本。
///
/// ★ 必须在这里就过滤掉 js/css/font/json 这些噪声：一个视频页动辄 300+ 资源，
///   九成是脚本与样式，全抛给用户等于没有结果。只保留「媒体 / 图片 / 分片」三类，
///   并把 initiatorType 一并带出，供前端区分「元素直链」与「网络分片」。
const SNIFF_COLLECT: &str = r#"(function () {
  try {
    var MEDIA_RE = /\.(mp4|webm|mkv|mov|m4v|flv|m3u8|mpd|m4s|ts|mp3|m4a|aac|flac|wav|ogg)([?#]|$)/i;
    var SEG_RE   = /\.(m4s|ts|m4a)([?#]|$)/i;
    var IMG_RE   = /\.(jpe?g|png|webp|gif|avif|bmp)([?#]|$)/i;
    var NOISE_RE = /\.(js|mjs|css|map|json|woff2?|ttf|otf|eot|svg|html?|txt|xml|ico|wasm)([?#]|$)/i;
    // 无扩展名的媒体地址（抖音/B站 CDN 常见）：靠路径关键字与查询参数识别
    var MEDIA_HINT = /(\/video\/tos\/|douyinvod|aweme|mime_type=video|video_mp4|\/playurl|bilivideo|\/api\/x\/player|\/hls\/)/i;

    function kindOf(u, initiatorType) {
      if (SEG_RE.test(u)) return 'segment';
      if (MEDIA_RE.test(u)) return 'media';
      if (IMG_RE.test(u)) return 'image';
      if (initiatorType === 'video' || initiatorType === 'audio') return 'media';
      if (initiatorType === 'img') return 'image';
      if (MEDIA_HINT.test(u)) return 'media';
      if (NOISE_RE.test(u)) return 'noise';
      return 'other';
    }

    var out = [], seen = {};
    function add(u, initiatorType, extra) {
      try {
        if (!u || typeof u !== 'string') return;
        if (u.indexOf('blob:') === 0 || u.indexOf('data:') === 0) return;
        var kind = kindOf(u, initiatorType);
        if (kind === 'noise') return;
        // other 只留「页面显式引用的元素地址」（video/img 的 currentSrc），网络请求里的 other 一律丢
        if (kind === 'other' && initiatorType !== 'media') return;
        if (seen[u]) return;
        seen[u] = 1;
        var o = { url: u, kind: kind, it: initiatorType || '' };
        if (extra) { for (var k in extra) { o[k] = extra[k]; } }
        out.push(o);
      } catch (e) {}
    }

    var log = window.__sniffLog || [];
    for (var i = 0; i < log.length; i++) add(log[i].url, log[i].it || log[i].src || 'auto');

    var vs = document.querySelectorAll('video, audio, source');
    for (var j = 0; j < vs.length; j++) {
      var el = vs[j];
      add(el.currentSrc || el.src, 'media', { tag: (el.tagName || '').toLowerCase() });
    }
    var imgs = document.querySelectorAll('img');
    for (var k = 0; k < imgs.length; k++) {
      var im = imgs[k];
      var s = im.currentSrc || im.src;
      if (s && (im.naturalWidth >= 96 || im.naturalHeight >= 96)) {
        add(s, 'img', { w: im.naturalWidth, h: im.naturalHeight });
      }
    }

    var payload = JSON.stringify({
      page: location.href,
      title: document.title,
      items: out.slice(0, 300)
    });
    var b64 = btoa(unescape(encodeURIComponent(payload)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    location.href = 'http://bimedia.localhost/__report/' + b64;
  } catch (e) {}
})();"#;

fn parse_target(url: &str) -> Result<tauri::Url, String> {
    let u = tauri::Url::parse(url).map_err(|e| format!("网址无效：{e}"))?;
    match u.scheme() {
        "http" | "https" => Ok(u),
        other => Err(format!("只允许 http/https 网址，收到：{other}")),
    }
}

/// 嗅探上报的拦截逻辑：命中 `bimedia.localhost/__report/...` 时存下载荷并取消导航。
fn sniff_navigation(label: &str, u: &tauri::Url) -> bool {
    if u.host_str() == Some("bimedia.localhost")
        && u.path().starts_with(crate::media_relay::REPORT_PATH_PREFIX)
    {
        if let Some(p) = u.path().strip_prefix(crate::media_relay::REPORT_PATH_PREFIX) {
            if let Some(json) = crate::media_relay::decode_b64u(p) {
                crate::media_relay::push_sniff_report(label, json);
            }
        }
        return false;
    }
    true
}

/// 浏览器窗口共用的 WebView2 数据目录（登录态就存在这里）。
fn profile_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|p| p.join("browser-profile"))
}

/// 打开（或复用）某个平台的浏览器窗口。
///
/// `target` 决定窗口 label 与嗅探归属（同一 target 永远对应同一个窗口）；
/// `x/y/width/height` 仅为兼容既有前端调用保留，窗口位置交给系统窗口管理器。
#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    target: Option<String>,
    url: String,
    title: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let _ = (x, y, width, height);
    let url_target = parse_target(&url)?;
    let label = window_label(target.as_deref());

    // 已存在：直接导航并聚焦（同平台重复打开不产生第二个窗口）
    if let Some(win) = app.get_webview_window(&label) {
        win.navigate(url_target).map_err(|e| format!("导航失败：{e}"))?;
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        return Ok(());
    }

    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url_target))
        .title(title.unwrap_or_else(|| "安得云荟 · 网页".to_string()))
        .inner_size(1120.0, 780.0)
        .min_inner_size(640.0, 420.0)
        .center()
        .user_agent(DESKTOP_UA)
        .additional_browser_args(BROWSER_ARGS)
        .initialization_script(SNIFF_HOOK);
    // 固定 profile：cookie/localStorage 持久化，登录一次下次仍在；多个平台窗口共享同一份。
    if let Some(dir) = profile_dir(&app) {
        builder = builder.data_directory(dir);
    }
    let nav_label = label.clone();
    builder = builder.on_navigation(move |u| sniff_navigation(&nav_label, u));

    // 下载接管：命中 Requested 时取消浏览器自身下载，转交凌霄处理。
    // 关闭接管时返回 true，保持浏览器原生下载行为。
    let capture_app = app.clone();
    let capture_label = label.clone();
    builder = builder.on_download(move |_webview, event| match event {
        tauri::webview::DownloadEvent::Requested { url, .. } => {
            if !takeover_enabled(&capture_app) {
                return true;
            }
            push_download_capture(&capture_app, url.to_string(), capture_label.clone());
            false
        }
        _ => true,
    });

    let win = builder
        .build()
        .map_err(|e| format!("创建浏览器窗口失败：{e}"))?;
    let _ = win.set_focus();
    Ok(())
}

/// 兼容旧前端：窗口模式下无需同步面板矩形。
#[tauri::command]
pub async fn browser_set_bounds(
    _app: AppHandle,
    target: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let _ = (target, x, y, width, height);
    Ok(())
}

/// 在浏览器里导航到新网址（地址栏回车）。
#[tauri::command]
pub async fn browser_navigate(app: AppHandle, target: Option<String>, url: String) -> Result<(), String> {
    let u = parse_target(&url)?;
    let label = window_label(target.as_deref());
    let win = app
        .get_webview_window(&label)
        .ok_or_else(|| "浏览器窗口尚未打开".to_string())?;
    win.navigate(u).map_err(|e| format!("导航失败：{e}"))?;
    let _ = win.set_focus();
    Ok(())
}

/// 把某个平台的浏览器窗口提到最前。
#[tauri::command]
pub async fn browser_focus(app: AppHandle, target: Option<String>) -> Result<(), String> {
    let label = window_label(target.as_deref());
    let win = app
        .get_webview_window(&label)
        .ok_or_else(|| "浏览器窗口尚未打开".to_string())?;
    let _ = win.show();
    let _ = win.unminimize();
    win.set_focus().map_err(|e| format!("聚焦失败：{e}"))?;
    Ok(())
}

/// 触发一次嗅探：执行收集脚本 → 等页面把结果上报回来 → 返回该窗口的原始 JSON 列表。
#[tauri::command]
pub async fn browser_sniff(app: AppHandle, target: Option<String>) -> Result<Vec<String>, String> {
    let label = window_label(target.as_deref());
    let wv = app
        .get_webview(&label)
        .ok_or_else(|| "浏览器窗口尚未打开".to_string())?;
    wv.eval(SNIFF_COLLECT)
        .map_err(|e| format!("执行嗅探脚本失败：{e}"))?;
    // 上报要走一次「导航」往返；宁可多等一点也不漏结果。
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    Ok(crate::media_relay::take_sniff_reports(&label))
}

/// 当前浏览器地址（地址栏回显用；失败返回空串）
#[tauri::command]
pub async fn browser_current_url(app: AppHandle, target: Option<String>) -> Result<String, String> {
    let label = window_label(target.as_deref());
    match app.get_webview(&label) {
        Some(wv) => Ok(wv.url().map(|u| u.to_string()).unwrap_or_default()),
        None => Ok(String::new()),
    }
}

/// 关闭某个平台的浏览器窗口
#[tauri::command]
pub async fn browser_close(app: AppHandle, target: Option<String>) -> Result<(), String> {
    let label = window_label(target.as_deref());
    if let Some(win) = app.get_webview_window(&label) {
        win.close().map_err(|e| format!("关闭失败：{e}"))?;
    }
    Ok(())
}

/// 关闭所有由本模块创建的浏览器窗口（离开模块 / 卸载面板时调用）。
#[tauri::command]
pub async fn browser_close_all(app: AppHandle) -> Result<(), String> {
    for win in app.webview_windows().into_values() {
        if win.label().starts_with(LABEL_PREFIX) {
            let _ = win.close();
        }
    }
    Ok(())
}

/// 用**系统默认浏览器**打开网址。
///
/// 为什么需要它：部分站点（pixiv 等）在大陆被网络阻断，而 WebView2 只跟随系统代理。
/// 如果用户的梯子只对浏览器生效（PAC/规则/扩展代理），内嵌窗口就会打不开；
/// 这时把链接交给系统浏览器是唯一可靠的路。
#[tauri::command]
pub async fn browser_open_external(app: AppHandle, url: String) -> Result<(), String> {
    let target = parse_target(&url)?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(target.to_string(), None::<&str>)
        .map_err(|e| format!("调起系统浏览器失败：{e}"))
}

/// 上报通道的兜底响应（正常会被 on_navigation 取消，见文件头注释）
#[allow(dead_code)]
pub(crate) fn report_fallback() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .body(b"<script>if(history.length>1)history.back()</script>".to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}
