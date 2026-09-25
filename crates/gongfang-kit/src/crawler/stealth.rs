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

/// 默认 Referer：无 Referer 时补 Google 首页
///
/// 借鉴 Scrapling（BSD 3-Clause）的 stealth 策略：真实用户很少「直接命中深链」，
/// 带一个搜索引擎来源更符合自然流量分布，降低「爬虫裸奔」特征。
pub const DEFAULT_REFERER: &str = "https://www.google.com/";

/// 一次请求的浏览器同构请求头集合
///
/// 说明：`Accept-Encoding` 只在 reqwest 启用了对应解码特性时才可声明，
/// 否则响应体不会被解压（gongfang-kit 已启用 gzip/brotli/deflate）。
#[derive(Debug, Clone)]
pub struct StealthHeaders {
    pub user_agent: &'static str,
    pub accept: &'static str,
    pub accept_language: &'static str,
    pub accept_encoding: &'static str,
    /// Chromium 系专有 Client Hints（Firefox/Safari 不发送，故为 None）
    pub sec_ch_ua: Option<&'static str>,
    pub sec_ch_ua_mobile: Option<&'static str>,
    pub sec_ch_ua_platform: Option<&'static str>,
    pub upgrade_insecure_requests: &'static str,
}

impl StealthHeaders {
    /// 展开为 (name, value) 列表，便于批量写入 reqwest 请求
    pub fn pairs(&self) -> Vec<(&'static str, &'static str)> {
        let mut v = vec![
            ("User-Agent", self.user_agent),
            ("Accept", self.accept),
            ("Accept-Language", self.accept_language),
            ("Accept-Encoding", self.accept_encoding),
            ("Upgrade-Insecure-Requests", self.upgrade_insecure_requests),
        ];
        if let Some(x) = self.sec_ch_ua {
            v.push(("sec-ch-ua", x));
        }
        if let Some(x) = self.sec_ch_ua_mobile {
            v.push(("sec-ch-ua-mobile", x));
        }
        if let Some(x) = self.sec_ch_ua_platform {
            v.push(("sec-ch-ua-platform", x));
        }
        v
    }
}

/// 按 TLS 指纹档案返回浏览器同构请求头
///
/// 与 `user_agent` 保持同一档案体系：UA / Client Hints / 平台三者必须自洽，
/// 否则「UA 说 Chrome on Windows、Client Hints 说 macOS」反而是更明显的爬虫特征。
pub fn headers_for(tls_profile: &str) -> StealthHeaders {
    match tls_profile {
        "firefox_120" => StealthHeaders {
            user_agent: user_agent("firefox_120"),
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            accept_language: "zh-CN,zh;q=0.9,en;q=0.8",
            accept_encoding: "gzip, deflate, br",
            sec_ch_ua: None,
            sec_ch_ua_mobile: None,
            sec_ch_ua_platform: None,
            upgrade_insecure_requests: "1",
        },
        "safari_17" => StealthHeaders {
            user_agent: user_agent("safari_17"),
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            accept_language: "zh-CN,zh;q=0.9",
            accept_encoding: "gzip, deflate, br",
            sec_ch_ua: None,
            sec_ch_ua_mobile: None,
            sec_ch_ua_platform: None,
            upgrade_insecure_requests: "1",
        },
        // 默认 Chrome on Windows
        _ => StealthHeaders {
            user_agent: user_agent("chrome_122"),
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
            accept_language: "zh-CN,zh;q=0.9,en;q=0.8",
            accept_encoding: "gzip, deflate, br",
            sec_ch_ua: Some("\"Chromium\";v=\"122\", \"Not(A:Brand\";v=\"24\", \"Google Chrome\";v=\"122\""),
            sec_ch_ua_mobile: Some("?0"),
            sec_ch_ua_platform: Some("\"Windows\""),
            upgrade_insecure_requests: "1",
        },
    }
}

/// CDP 早期注入脚本（在 about:blank 阶段覆盖 Navigator 属性）
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
