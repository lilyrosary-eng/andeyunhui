//! 内嵌浏览器（子 webview）：把「网络视频」的面板区当作浏览器用。
//!
//! # 为什么用「子 webview」而不是旧方案的浮窗
//!
//! 旧实现用 `alwaysOnTop: true` 的**独立 OS 浮窗**盖在面板上，带来三个固有缺陷：
//! 遮挡主窗口 UI、不跟随主窗移动、尺寸不同步。
//!
//! 本模块改用 tauri 的多 webview 能力 `Window::add_child(builder, pos, size)`
//! （需 `unstable` feature），把子 webview **精确铺在面板矩形上** —— 它是主窗口的一部分，
//! 随窗口移动/最小化，不越界、不遮挡其它 UI。
//!
//! # 与主界面 HTML 的层级关系（重要）
//!
//! 子 webview 是**独立的渲染面**，会盖在它矩形范围内主 webview 的 DOM 之上。
//! 所以「嗅探结果」不能做成覆盖在它上面的浮层 —— 前端在打开结果抽屉时会**把浏览器矩形收窄**，
//! 让两者永不重叠（见 BrowserPanel 的 bounds 计算）。
//!
//! # 嗅探通道
//!
//! 外部页面无法使用 Tauri IPC，因此注入脚本把结果经本协议送出：
//! `location.href = "http://bimedia.localhost/__report/<b64u(json)>"`，
//! 由下面的 `on_navigation` 截获并 `return false` 取消导航（页面不会跳走），
//! 载荷存入 `media_relay` 的进程内缓冲，前端用 `browser_sniff` 取走。
//! 用「导航」而非 fetch 的原因：外部站点的 CSP 管不到导航，但很可能把 fetch 拦掉。

use tauri::http::{header, Response, StatusCode};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};

pub const LABEL: &str = "video-browser";

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
  function push(u, src) {
    try {
      if (!u || typeof u !== 'string') return;
      if (u.indexOf('blob:') === 0 || u.indexOf('data:') === 0) return;
      window.__sniffLog.push({ url: u, src: src });
      if (window.__sniffLog.length > 800) window.__sniffLog.shift();
    } catch (e) {}
  }
  try {
    var po = new PerformanceObserver(function (list) {
      var es = list.getEntries();
      for (var i = 0; i < es.length; i++) push(es[i].name, 'perf');
    });
    po.observe({ type: 'resource', buffered: true });
  } catch (e) {}
  try {
    var _fetch = window.fetch;
    if (_fetch) {
      window.fetch = function (input, init) {
        try { push(typeof input === 'string' ? input : (input && input.url), 'fetch'); } catch (e) {}
        return _fetch.apply(this, arguments);
      };
    }
  } catch (e) {}
  try {
    var _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) { push(u, 'xhr'); return _open.apply(this, arguments); };
  } catch (e) {}
})();"#;

/// 前端点「嗅探」时执行的收集脚本：合并钩子记录 + DOM 扫描，去重后上报。
const SNIFF_COLLECT: &str = r#"(function () {
  try {
    var out = [], seen = {};
    function add(u, kind, extra) {
      try {
        if (!u || typeof u !== 'string') return;
        if (u.indexOf('blob:') === 0 || u.indexOf('data:') === 0) return;
        if (seen[u]) return;
        seen[u] = 1;
        var o = { url: u, kind: kind };
        if (extra) { for (var k in extra) { o[k] = extra[k]; } }
        out.push(o);
      } catch (e) {}
    }
    var log = window.__sniffLog || [];
    for (var i = 0; i < log.length; i++) { add(log[i].url, log[i].src || 'auto'); }
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
        add(s, 'image', { w: im.naturalWidth, h: im.naturalHeight });
      }
    }
    var payload = JSON.stringify({
      page: location.href,
      title: document.title,
      items: out.slice(0, 200)
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

/// 打开（或复用）内嵌浏览器，并把矩形对齐到面板区域。
/// 坐标为**逻辑像素**、相对主窗口客户区左上角。
#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let target = parse_target(&url)?;
    let pos = LogicalPosition::new(x, y);
    let size = LogicalSize::new(width.max(1.0), height.max(1.0));

    // 已存在：只更新位置/尺寸并导航（避免重复创建导致 label 冲突）
    if let Some(wv) = app.get_webview(LABEL) {
        let _ = wv.set_position(pos);
        let _ = wv.set_size(size);
        wv.navigate(target).map_err(|e| format!("导航失败：{e}"))?;
        let _ = wv.show();
        return Ok(());
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "未找到主窗口 main".to_string())?;

    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(target))
        .initialization_script(SNIFF_HOOK)
        .zoom_hotkeys_enabled(false)
        .on_navigation(|u| {
            // 嗅探上报：截获并取消这次导航，页面停留在原处
            if u.host_str() == Some("bimedia.localhost")
                && u.path().starts_with(crate::media_relay::REPORT_PATH_PREFIX)
            {
                if let Some(p) = u.path().strip_prefix(crate::media_relay::REPORT_PATH_PREFIX) {
                    if let Some(json) = crate::media_relay::decode_b64u(p) {
                        crate::media_relay::push_sniff_report(json);
                    }
                }
                return false;
            }
            true
        });

    window
        .add_child(builder, pos, size)
        .map_err(|e| format!("创建内嵌浏览器失败：{e}"))?;
    Ok(())
}

/// 同步浏览器矩形（面板尺寸变化、打开嗅探抽屉收窄时调用）。
#[tauri::command]
pub async fn browser_set_bounds(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(wv) = app.get_webview(LABEL) {
        let _ = wv.set_position(LogicalPosition::new(x, y));
        let _ = wv.set_size(LogicalSize::new(width.max(1.0), height.max(1.0)));
    }
    Ok(())
}

/// 在浏览器里导航到新网址（地址栏回车 / 快捷入口）。
#[tauri::command]
pub async fn browser_navigate(app: AppHandle, url: String) -> Result<(), String> {
    let target = parse_target(&url)?;
    let wv = app
        .get_webview(LABEL)
        .ok_or_else(|| "内嵌浏览器尚未打开".to_string())?;
    wv.navigate(target).map_err(|e| format!("导航失败：{e}"))?;
    Ok(())
}

/// 触发一次嗅探：执行收集脚本 → 等页面把结果上报回来 → 返回原始 JSON 列表。
///
/// 返回的是页面自报的 JSON 字符串数组（含 page/title/items），由前端解析。
/// 等 500ms 是因为上报要走一次「导航」往返；宁可多等一点也不漏结果。
#[tauri::command]
pub async fn browser_sniff(app: AppHandle) -> Result<Vec<String>, String> {
    let wv = app
        .get_webview(LABEL)
        .ok_or_else(|| "内嵌浏览器尚未打开".to_string())?;
    wv.eval(SNIFF_COLLECT)
        .map_err(|e| format!("执行嗅探脚本失败：{e}"))?;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    Ok(crate::media_relay::take_sniff_reports())
}

/// 当前浏览器地址（用于地址栏回显；失败返回空串）
#[tauri::command]
pub async fn browser_current_url(app: AppHandle) -> Result<String, String> {
    match app.get_webview(LABEL) {
        Some(wv) => Ok(wv.url().map(|u| u.to_string()).unwrap_or_default()),
        None => Ok(String::new()),
    }
}

/// 关闭并销毁内嵌浏览器
#[tauri::command]
pub async fn browser_close(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview(LABEL) {
        wv.close().map_err(|e| format!("关闭失败：{e}"))?;
    }
    Ok(())
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
