// 统一 CSS 注入：首选「构造样式表」（CSSStyleSheet + adoptedStyleSheets），不可用时回退 <style> 元素。
//
// 为什么不能直接用 <style>：Tauri 打包时会给 CSP 的 style-src 追加 nonce，按 CSP 规范
// 「nonce/hash 存在时 'unsafe-inline' 被忽略」→ 运行时动态插入的 <style>（含 React 渲染出的
// <style> 元素）会被整块拦掉，@keyframes / 滚动条 / 覆盖层等注入样式在打包版全部失效。
// dev 走 Vite 服务没有这条 CSP，所以只在打包后异常。构造样式表不经过 style-src 检查，
// dev / 打包表现一致（已实测验证，含 @keyframes）。

interface InjectedCss {
  sheet?: CSSStyleSheet;
  el?: HTMLStyleElement;
}

const injectedCss = new Map<string, InjectedCss>();

/**
 * 注入一段全局 CSS（同一 key 幂等：重复调用不重复注入）。
 * 返回释放函数，可移除本次注入的样式表 / 样式元素；已释放或已被替换时释放为无操作。
 * key 建议用可读的模块名，避免不同模块互相覆盖。
 */
export function injectCssOnce(key: string, css: string): () => void {
  if (typeof document === 'undefined') return () => {};

  const existing = injectedCss.get(key);
  if (existing) {
    const shared = existing;
    return () => dispose(key, shared);
  }

  let created: InjectedCss | null = null;
  try {
    if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in document) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      created = { sheet };
    }
  } catch { /* 构造样式表不可用 → 回退 <style> 元素 */ }

  if (!created) {
    const el = document.createElement('style');
    el.setAttribute('data-injected-css', key);
    el.textContent = css;
    document.head.appendChild(el);
    created = { el };
  }

  const entry: InjectedCss = created;
  injectedCss.set(key, entry);
  return () => dispose(key, entry);
}

function dispose(key: string, entry: InjectedCss): void {
  if (injectedCss.get(key) !== entry) return;
  if (entry.sheet) {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== entry.sheet);
  }
  entry.el?.remove();
  injectedCss.delete(key);
}