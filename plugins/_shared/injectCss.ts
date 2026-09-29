// 统一 CSS 注入：首选「构造样式表」（CSSStyleSheet + adoptedStyleSheets），不可用时回退 <style> 元素。
//
// 为什么不能用 <style>：Tauri 打包时会给 CSP 的 style-src 追加 nonce，按 CSP 规范
// 「nonce/hash 存在时 'unsafe-inline' 被忽略」→ 动态插入的 <style> 会被整块拦掉，
// 插件自带 CSS（Tailwind 补充量、xterm 终端样式、Markdown 样式、input[type=range] 滑条等）
// 在打包版全部失效；dev 走 Vite 服务没有这条 CSP，所以只在打包后异常。
// 构造样式表不经过 style-src 检查，dev / 打包表现一致（已实测验证，含 @keyframes）。

const injectedCss = new Map<string, { sheet?: CSSStyleSheet; el?: HTMLStyleElement }>();

/**
 * 注入一段全局 CSS。同一 key 重复调用只会保留一份实例（内容变化时原地更新）。
 * key 建议用可读的模块名，避免不同模块互相覆盖。
 */
export function injectCss(key: string, css: string): void {
  if (typeof document === 'undefined') return;
  const prev = injectedCss.get(key);

  // 首选：构造样式表
  try {
    if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in document) {
      if (prev?.sheet) {
        prev.sheet.replaceSync(css);
        return;
      }
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      injectedCss.set(key, { sheet });
      return;
    }
  } catch {
    /* 回退 <style> 元素 */
  }

  if (prev?.el) {
    prev.el.textContent = css;
    return;
  }
  const el = document.createElement('style');
  el.setAttribute('data-injected-css', key);
  el.textContent = css;
  document.head.appendChild(el);
  injectedCss.set(key, { el });
}

/** 移除某个 key 注入的 CSS（可选，一般无需调用：插件样式随应用生命周期常驻） */
export function removeInjectedCss(key: string): void {
  const prev = injectedCss.get(key);
  if (!prev) return;
  if (prev.sheet) {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== prev.sheet);
  }
  prev.el?.remove();
  injectedCss.delete(key);
}