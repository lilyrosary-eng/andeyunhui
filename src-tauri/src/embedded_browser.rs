//! 内置浏览器窗口（网络视频平台页）。
//!
//! # 为什么是「独立窗口」而不是「面板里的子 webview」
//!
//! 最初改用 tauri 的多 webview 能力 `Window::add_child`，把子 webview 精确铺在
//! 面板矩形上。实机验证（Windows / WebView2）发现：子 webview 的 HWND 确实创建在
//! 正确位置，但**始终被主 webview 的合成层盖住**，页面只呈现一片白色 ——
//! 提升 HWND 的 z-order 也无效（WebView2 走的是 DComp 合成，不是 GDI 绘制顺序）。
//!
//! 因此改为 **一个真正的 Tauri 窗口**（WebviewWindow）承载平台页面：
//! - 一定可见、可输入；
//! - 不遮挡主界面（用户可自由拖动/缩放/最大化）；
//! - 与「面板里嵌网页」相比只是少了贴边，稳定性完全不在一个量级。
//!
//! # 嗅探通道
//!
//! 外部页面无法使用 Tauri IPC，因此注入脚本把结果经本协议送出：
//! `location.href = "http://bimedia.localhost/__report/<b64u(json)>"`，
//! 由 `on_navigation` 截获并 `return false` 取消导航（页面不会跳走），
//! 载荷存入 `media_relay` 的进程内缓冲，前端用 `browser_sniff` 取走。
//! 用「导航」而非 fetch 的原因：外部站点的 CSP 管不到导航，但很可能把 fetch 拦掉。

use tauri::http::{header, Response, StatusCode};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "video-browser";

/// 浏览器窗口的 UA：伪装成普通桌面 Edge。
///
/// 默认 UA 会带 Tauri 标识，抖音 / B 站等站点会据此判定为「非常规浏览器」，
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

/// 嗅探上报的拦截逻辑：命中 `bimedia.localhost/__report/...` 时存下载荷并取消导航。
fn sniff_navigation(u: &tauri::Url) -> bool {
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
}

/// 打开（或复用）浏览器窗口。
///
/// `x/y/width/height` 保留在签名里只为兼容既有前端调用；窗口模式下位置由系统窗口
/// 管理器负责（首次创建居中，之后记住用户拖动后的位置）。
#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    // 参数名必须与前端 payload 一致（Tauri 按参数名反序列化，改成 `_x` 会因为缺字段而失败）
    let _ = (x, y, width, height);
    let target = parse_target(&url)?;

    // 已存在：直接导航并聚焦，不重复创建（label 冲突）
    if let Some(win) = app.get_webview_window(LABEL) {
        win.navigate(target).map_err(|e| format!("导航失败：{e}"))?;
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        return Ok(());
    }

    let builder = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(target))
        .title("安得云荟 · 网页")
        .inner_size(1120.0, 780.0)
        .min_inner_size(640.0, 420.0)
        .center()
        .user_agent(DESKTOP_UA)
        .additional_browser_args(BROWSER_ARGS)
        .initialization_script(SNIFF_HOOK)
        .on_navigation(sniff_navigation);

    let win = builder
        .build()
        .map_err(|e| format!("创建浏览器窗口失败：{e}"))?;
    let _ = win.set_focus();
    Ok(())
}

/// 兼容旧前端：面板矩形同步。窗口模式下无需同步（保留命令避免调用方报「未注册」）。
#[tauri::command]
pub async fn browser_set_bounds(
    _app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let _ = (x, y, width, height);
    Ok(())
}

/// 在浏览器里导航到新网址（地址栏回车 / 快捷入口）。
#[tauri::command]
pub async fn browser_navigate(app: AppHandle, url: String) -> Result<(), String> {
    let target = parse_target(&url)?;
    let win = app
        .get_webview_window(LABEL)
        .ok_or_else(|| "浏览器窗口尚未打开".to_string())?;
    win.navigate(target).map_err(|e| format!("导航失败：{e}"))?;
    let _ = win.set_focus();
    Ok(())
}

/// 把浏览器窗口提到最前（用户在主界面点「回到浏览器窗口」时用）。
#[tauri::command]
pub async fn browser_focus(app: AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window(LABEL)
        .ok_or_else(|| "浏览器窗口尚未打开".to_string())?;
    let _ = win.show();
    let _ = win.unminimize();
    win.set_focus().map_err(|e| format!("聚焦失败：{e}"))?;
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
        .ok_or_else(|| "浏览器窗口尚未打开".to_string())?;
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

/// 关闭浏览器窗口
#[tauri::command]
pub async fn browser_close(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(LABEL) {
        win.close().map_err(|e| format!("关闭失败：{e}"))?;
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
