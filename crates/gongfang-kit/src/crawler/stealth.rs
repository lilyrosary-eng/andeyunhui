//! CDP 隐身注入：navigator.webdriver 清除 + Canvas/WebGL 噪声
//!
//! 替代 LD_PRELOAD 字体劫持（Linux 专属，Windows 不可用）
//! 用 chromiumoxide 的 Page::add_script_to_evaluate_on_new_document 在页面初始化前注入
//!
//! 注意：chromiumoxide 较重，实际浏览器集成在后续阶段。此处先提供 JS 脚本常量与 UA 伪装。

/// TLS 指纹档案对应的 User-Agent
pub fn user_agent(tls_profile: &str) -> &'static str {
    match tls_profile {
        "chrome_122" => "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "firefox_120" => "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
        "safari_17" => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        _ => "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    }
}

/// CDP 早期注入脚本（在 about:blank 阶段覆盖 Navigator 属性）
///
/// 实现：
/// - navigator.webdriver = undefined
/// - Canvas 哈希噪声（0.0001 像素偏移，保持 >99.5% 相似度但哈希不重复）
/// - WebGL 着色器微调
/// - plugins/languages 伪装
pub const STEALTH_JS: &str = r#"
(() => {
  // 1. 清除 webdriver 标记
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
  } catch (e) {}

  // 2. Canvas 噪声（微小偏移，破坏哈希但视觉无差异）
  try {
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      const ctx = this.getContext('2d');
      if (ctx) {
        const w = this.width, h = this.height;
        if (w > 0 && h > 0) {
          const img = ctx.getImageData(0, 0, w, h);
          for (let i = 0; i < img.data.length; i += 4) {
            // 0.5% 像素加 ±1 噪声
            if (Math.random() < 0.005) {
              img.data[i] = Math.min(255, img.data[i] + 1);
            }
          }
          ctx.putImageData(img, 0, 0);
        }
      }
      return origToDataURL.apply(this, args);
    };
  } catch (e) {}

  // 3. WebGL 着色器噪声
  try {
    const origGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(p) {
      // VENDOR / RENDERER 加噪
      if (p === 37445 || p === 37446) {
        return 'Apple GPU';
      }
      return origGetParameter.call(this, p);
    };
  } catch (e) {}

  // 4. plugins 伪装
  try {
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
      configurable: true,
    });
  } catch (e) {}

  // 5. languages 一致性
  try {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['zh-CN', 'zh', 'en-US', 'en'],
      configurable: true,
    });
  } catch (e) {}
})();
"#;

/// 通过 CDP 注入隐身脚本（chromiumoxide，需 crawler-browser feature）
#[cfg(feature = "crawler-browser")]
pub async fn apply_stealth(
    page: &chromiumoxide::Page,
) -> Result<(), String> {
    use chromiumoxide::cdp::browser_protocol::page::AddScriptToEvaluateOnNewDocumentParams;
    page.execute(
        AddScriptToEvaluateOnNewDocumentParams::builder()
            .source(STEALTH_JS)
            .build(),
    )
    .await
    .map_err(|e| format!("CDP 注入失败: {}", e))?;
    log::info!("[stealth] CDP 隐身脚本已注入");
    Ok(())
}
