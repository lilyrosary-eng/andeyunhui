// 共享 markdown 渲染工具（marked + 行内 HTML 转义 + 代码块复制按钮）。
// 桌面（ai-chat 主窗/胶囊/记忆设置）与移动端（MessageList）共用。
//
// 设计要点：
//   - marked 配置：gfm=true（表格/任务列表/删除线）、breaks=true（单换行→<br>，便于流式增量渲染）
//   - 安全：marked 默认转义 HTML；我们不在自定义 renderer 里再拼原始 HTML
//   - 代码块复制按钮：纯字符串注入，复制逻辑由调用方组件监听 .md-copy-btn click 触发
//   - 样式：注入一次到 <head>（幂等），dark/light 模式通用（前景用 currentColor 继承父级）

import { marked } from 'marked';

marked.setOptions({
  gfm: true,
  breaks: true,
  async: false,
});

/** HTML 实体转义（用于把代码块原文塞进 data-* 属性）。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 渲染 markdown 为 HTML（含行内加粗/链接/行内代码/列表/表格/标题/代码块复制按钮）。 */
export function renderMarkdown(content: string): string {
  if (!content) return '';
  try {
    const html = marked.parse(content, { async: false }) as string;
    // 给每个 <pre> 包一层 + 追加复制按钮
    return html.replace(
      /<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g,
      (_, codeHtml: string) => {
        const text = codeHtml
          .replace(/<[^>]+>/g, '')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&');
        return `<div class="md-code-block"><button type="button" class="md-copy-btn" data-code="${escapeHtml(text)}" aria-label="复制代码">复制</button><pre><code>${codeHtml}</code></pre></div>`;
      },
    );
  } catch {
    return escapeHtml(content);
  }
}

// CSS 用 currentColor 与 var(--*) 继承父级气泡颜色，dark/light 通用。
const MD_STYLES_ID = '__andy_md_styles__';
const MD_STYLES_TEXT = `
.md-message { display: block; word-break: break-word; line-height: 1.65; }
.md-message p { margin: 0.4em 0; }
.md-message p:first-child { margin-top: 0; }
.md-message p:last-child { margin-bottom: 0; }
.md-message ul, .md-message ol { margin: 0.4em 0; padding-left: 1.4em; }
.md-message li { margin: 0.15em 0; }
.md-message code {
  background: rgba(127, 127, 127, 0.18);
  border-radius: 4px;
  padding: 0.1em 0.35em;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.92em;
  word-break: break-word;
}
.md-code-block {
  position: relative;
  margin: 0.5em 0;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid currentColor;
  opacity: 0.96;
}
.md-copy-btn {
  position: absolute;
  top: 6px;
  right: 8px;
  z-index: 2;
  background: rgba(127, 127, 127, 0.25);
  color: inherit;
  border: 1px solid currentColor;
  border-radius: 6px;
  padding: 2px 8px;
  font-size: 11px;
  line-height: 1.6;
  cursor: pointer;
  opacity: 0.85;
  transition: opacity 0.15s;
}
.md-copy-btn:hover { opacity: 1; }
.md-copy-btn.copied { color: #16a34a; }
.md-code-block pre {
  margin: 0;
  padding: 12px 14px;
  overflow-x: auto;
  background: rgba(127, 127, 127, 0.12);
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.88em;
  line-height: 1.55;
}
.md-code-block pre code {
  background: transparent;
  padding: 0;
  display: block;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.md-message strong { font-weight: 700; }
.md-message em { font-style: italic; }
.md-message a { color: #2563eb; text-decoration: underline; }
.dark .md-message a { color: #93c5fd; }
.md-message blockquote {
  border-left: 3px solid currentColor;
  margin: 0.4em 0;
  padding-left: 0.7em;
  opacity: 0.75;
}
.md-message table {
  border-collapse: collapse;
  margin: 0.4em 0;
  display: block;
  overflow-x: auto;
  max-width: 100%;
}
.md-message th, .md-message td {
  border: 1px solid currentColor;
  padding: 4px 8px;
  font-size: 0.92em;
}
.md-message h1, .md-message h2, .md-message h3, .md-message h4 {
  font-weight: 700;
  margin: 0.55em 0 0.3em;
  line-height: 1.3;
}
.md-message h1 { font-size: 1.2em; }
.md-message h2 { font-size: 1.1em; }
.md-message h3 { font-size: 1.02em; }
.md-message h4 { font-size: 1em; }
.md-message hr {
  border: none;
  border-top: 1px solid currentColor;
  margin: 0.6em 0;
  opacity: 0.3;
}
.md-message del { opacity: 0.65; }
.md-message input[type=checkbox] { margin-right: 0.4em; }
`;

/** 幂等注入 markdown CSS 到 <head>（多次调用安全）。 */
export function injectMarkdownStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(MD_STYLES_ID)) return;
  const style = document.createElement('style');
  style.id = MD_STYLES_ID;
  style.textContent = MD_STYLES_TEXT;
  document.head.appendChild(style);
}

/** 全局复制按钮 click 代理（挂在 document，捕获阶段）。
 *  返回卸载函数。调用方在组件 mount 时注册一次即可。
 *  通过事件代理避免每条消息都绑定 React handler，对流式长列表友好。
 */
export function attachMarkdownCopyHandler(): () => void {
  if (typeof document === 'undefined') return () => {};
  const handler = (e: Event) => {
    const t = e.target as HTMLElement | null;
    if (!t || !t.classList?.contains('md-copy-btn')) return;
    const code = t.getAttribute('data-code') ?? '';
    if (!code) return;
    const finish = (ok: boolean) => {
      const orig = t.textContent;
      t.textContent = ok ? '已复制' : '失败';
      t.classList.toggle('copied', ok);
      setTimeout(() => {
        if (t.textContent === '已复制' || t.textContent === '失败') t.textContent = orig ?? '复制';
        t.classList.remove('copied');
      }, 1200);
    };
    const copy = async () => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(code);
          finish(true);
          return;
        }
      } catch { /* 降级到 textarea 方案 */ }
      try {
        const ta = document.createElement('textarea');
        ta.value = code;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        finish(true);
      } catch {
        finish(false);
      }
    };
    void copy();
  };
  document.addEventListener('click', handler, true);
  return () => document.removeEventListener('click', handler, true);
}