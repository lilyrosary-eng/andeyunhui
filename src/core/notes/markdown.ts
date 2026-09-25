import { marked } from 'marked';
import { renderMarkdown } from '@/lib/markdown';

/**
 * Markdown 源码 → 预览 HTML（纯函数，可单测）。
 *
 * 关键修复：**不再把连续换行预处理成 `<br>`**。
 * 旧实现 `content.replace(/\n{2,}/g, '<br>'.repeat(len))` 会把真实换行删掉，
 * 「上一段\n\n## 标题」因此被拼成一行，`##` 不在行首，marked 只当普通段落文本，
 * 于是空行之后的所有行首块级语法（标题 / 列表 / 引用 / 围栏代码）全部失效。
 *
 * 现方案把源码原样交给 marked（gfm + breaks）：
 * - 块级语法交给 marked 按标准 Markdown 规则识别（真实换行就是它的行边界）；
 * - 段内单个换行由 breaks 选项转 <br>，与编辑区逐行显示保持一致；
 * - 段间空行的视觉留白改由预览容器 CSS（段落上下 margin，见 NotesEditor 预览区类名）承担。
 *   取舍：连续 3 个以上空行会折叠成一段间距——按「块级语法正确优先、空行视觉次之」定。
 *   之所以不走「只保留多余空行」的预处理：任何在源码里插入/删除换行的做法都会重新
 *   破坏 marked 的行边界判断，风险远大于收益。
 *
 * 渲染交给共享的 `renderMarkdown`（`src/lib/markdown.ts`）：它在 marked 之上为每个代码块
 * 注入 `.md-code-block` 包裹层与「复制」按钮，并配套 `.md-copy-btn` 样式。笔记预览因此
 * 与 AI 对话区共用同一套代码块交互，不再各写一份；按钮的点击由 NotesEditor 挂载的
 * 全局事件代理（`attachMarkdownCopyHandler`）处理——预览是 dangerouslySetInnerHTML 注入的，
 * 无法直接挂 React onClick。
 * 代价：共享 renderer 自带内容级缓存，与 notesStore 的 mdRenderCache 形成两层缓存。
 * 两层都以源码为键且结果一致，只是多占一份内存，换来的是零重复实现。
 */
export function renderMarkdownPreview(md: string): string {
  if (!md) return '';
  return renderMarkdown(md);
}

/**
 * Markdown → TipTap 兼容 HTML（利用已有的 marked 库）
 * TipTap 的 setContent 接受 HTML，但只识别它 schema 内的元素。
 * marked 输出的是标准 HTML，TipTap 可解析其中的 h1-h6、p、strong、em、code、ul/ol/li、blockquote、img 等。
 */
export function mdToEditorHtml(md: string): string {
  if (!md.trim()) return '';
  // marked 解析 markdown 为 HTML
  const raw = marked.parse(md, { async: false }) as string;
  // 移除 wrapping <p> 的自动换行（保留结构）
  return raw;
}

/**
 * TipTap HTML → Markdown（反向转换，用于保存）
 * TipTap 生成的是干净、结构化的 HTML，可以安全地做标记替换。
 */
export function editorHtmlToMd(html: string): string {
  let md = html;

  // 链接：<a href="url">text</a> → [text](url)
  md = md.replace(/<a[^>]*\shref="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');

  // 图片：<img src="url"> → ![](url)
  md = md.replace(/<img[^>]*\ssrc="([^"]*)"[^>]*\/?>/gi, (_m, src) => `\n![](${src})\n`);

  // 粗体：<strong> / <b>
  md = md.replace(/<\/?(?:strong|b)>/gi, '**');

  // 斜体：<em> / <i>
  md = md.replace(/<\/?(?:em|i)>/gi, '*');

  // 内联代码：<code>
  md = md.replace(/<\/?code>/gi, '`');

  // 删除线：<s> / <del> / <strike>
  md = md.replace(/<\/?(?:s|del|strike)>/gi, '~~');

  // 段落：<p> 去标签，保留换行
  md = md.replace(/<\/p>\s*<p>/gi, '\n\n');
  md = md.replace(/<\/?p>/gi, '');

  // 换行：<br>
  md = md.replace(/<br\s*\/?>/gi, '\n');

  // 标题：h1-h6
  md = md.replace(/<h(\d)>/gi, (_m, level) => '\n' + '#'.repeat(Number(level)) + ' ');
  md = md.replace(/<\/h\d>/gi, '\n');

  // 无序列表
  md = md.replace(/<li>\s*/gi, '- ');
  md = md.replace(/<\/li>/gi, '\n');
  md = md.replace(/<\/?ul>/gi, '');

  // 有序列表
  let olIdx = 0;
  md = md.replace(/<ol>/gi, () => { olIdx = 0; return ''; });
  md = md.replace(/<li>/gi, () => { olIdx += 1; return `${olIdx}. `; });
  md = md.replace(/<\/ol>/gi, '');

  // 引用
  md = md.replace(/<blockquote>/gi, '\n> ');
  md = md.replace(/<\/blockquote>/gi, '\n');

  // 水平线
  md = md.replace(/<hr\s*\/?>/gi, '\n---\n');

  // 清理多余的 HTML 标签
  md = md.replace(/<[^>]+>/g, '');

  // 清理多余空行
  md = md.replace(/\n{3,}/g, '\n\n');

  // HTML 实体解码
  md = md.replace(/&amp;/g, '&');
  md = md.replace(/&lt;/g, '<');
  md = md.replace(/&gt;/g, '>');
  md = md.replace(/&quot;/g, '"');
  md = md.replace(/&#39;/g, "'");

  return md.trim();
}

/** 文本编辑指令的输入/输出：选区用 [selectionStart, selectionEnd) 表示 */
export interface MarkdownEditState {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

/**
 * 用 Markdown 标记包裹选区（加粗 `**`、斜体 `*`、内联代码 `` ` ``、链接 `[]()`）。
 * 未选中文字时插入 placeholder 并选中它（链接按钮用 URL 兜底），方便直接继续输入。
 * 工具栏按钮改成「插入字面标记」而非富文本命令，编辑区因此始终是原始 Markdown。
 */
export function wrapMarkdownSelection(
  state: MarkdownEditState,
  before: string,
  after: string,
  placeholder = '',
): MarkdownEditState {
  const { text, selectionStart, selectionEnd } = state;
  const inner = text.slice(selectionStart, selectionEnd) || placeholder;
  return {
    text: text.slice(0, selectionStart) + before + inner + after + text.slice(selectionEnd),
    // 回填后选中被包裹的内容（不含标记），便于覆写占位文本
    selectionStart: selectionStart + before.length,
    selectionEnd: selectionStart + before.length + inner.length,
  };
}

/**
 * 给选区覆盖的每一行加行首标记（标题 `## `、无序列表 `- `、引用 `> `）。
 * 空行跳过以免产生「只有标记没有内容」的碎块；行尾换行符保留，不影响后续块级语法识别。
 */
export function prefixMarkdownLines(
  state: MarkdownEditState,
  prefix: string,
): MarkdownEditState {
  const { text, selectionStart, selectionEnd } = state;
  const lineStart = text.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1;
  // 选区恰好停在行尾换行符处时回退一格，避免把下一行也算进选区
  const scanFrom = selectionEnd > lineStart && text[selectionEnd - 1] === '\n'
    ? selectionEnd - 1
    : selectionEnd;
  const nl = text.indexOf('\n', scanFrom);
  const lineEnd = nl === -1 ? text.length : nl + 1;
  const block = text.slice(lineStart, lineEnd);
  const nextBlock = block
    .split('\n')
    .map((line) => (line.trim() === '' ? line : prefix + line))
    .join('\n');
  return {
    text: text.slice(0, lineStart) + nextBlock + text.slice(lineEnd),
    selectionStart: lineStart,
    selectionEnd: lineStart + nextBlock.length,
  };
}
