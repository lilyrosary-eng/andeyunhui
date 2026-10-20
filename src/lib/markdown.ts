// 共享 markdown 渲染工具（marked + 行内 HTML 转义 + 代码块复制按钮）。
// 桌面（ai-chat 主窗/胶囊/记忆设置）与移动端（MessageList）共用。
//
// 设计要点：
//   - marked 配置：gfm=true（表格/任务列表/删除线）、breaks=true（单换行→<br>，便于流式增量渲染）
//   - 安全（2026-10-19 修正）：marked **不会**转义原始 HTML —— 此前注释写反了。
//     实测 `marked.parse('<img src=x onerror=alert(1)>')` 原样输出，`[x](javascript:alert(1))`
//     也原样保留 href。模型输出 / 笔记内容都可能被提示注入，因此这里做两道处理：
//       ① renderer.html 覆盖 → 原始 HTML 一律**转义成文本**（不渲染）；
//       ② 解析后把 href/src 里的 javascript:/vbscript:/data:text/html 协议改成 "#"。
//     这是止血级防护，不是边界：要对抗更复杂的变异（SVG/MathML、属性名混淆）应上 DOMPurify。
//   - 代码块复制按钮：纯字符串注入，复制逻辑由调用方组件监听 .md-copy-btn click 触发
//   - 样式：注入一次到 <head>（幂等），dark/light 模式通用（前景用 currentColor 继承父级）

import { marked } from 'marked';
import { ensureHtmlPreviewHost } from '@/components/HtmlPreviewHost';
// 高亮：highlight.js **core** + 按需注册语言（2026-10-20 引入）。
//
// 为什么不是 shiki（实测体积，单位 KB / min）：
//   · hljs core 22.7（gzip 8.4），单语言 3~8（typescript 8.1 / rust 3.1），纯同步、无 wasm
//   · shiki 引擎 oniguruma 内联 wasm **607.9**，语法文件自身也大（rust 16.5 / typescript 186.2），
//     主题 12.4，且首屏必须异步加载 chunk
//   10 语言 + 1 主题的实测量级：hljs ≈ 90 KB（gzip ~30），shiki ≈ 1.0~1.2 MB（gzip ~350）。
//   本应用是离线桌面端、回复里代码块占比高但语言种类有限 ⇒ hljs 的性价比明显更高。
import hljs from 'highlight.js/lib/core';
import hljsJs from 'highlight.js/lib/languages/javascript';
import hljsTs from 'highlight.js/lib/languages/typescript';
import hljsPy from 'highlight.js/lib/languages/python';
import hljsRs from 'highlight.js/lib/languages/rust';
import hljsJson from 'highlight.js/lib/languages/json';
import hljsBash from 'highlight.js/lib/languages/bash';
import hljsXml from 'highlight.js/lib/languages/xml';
import hljsCss from 'highlight.js/lib/languages/css';
import hljsYaml from 'highlight.js/lib/languages/yaml';
import hljsSql from 'highlight.js/lib/languages/sql';
import hljsGo from 'highlight.js/lib/languages/go';
import hljsJava from 'highlight.js/lib/languages/java';
import hljsCpp from 'highlight.js/lib/languages/cpp';
import hljsMd from 'highlight.js/lib/languages/markdown';
import hljsDiff from 'highlight.js/lib/languages/diff';
import hljsIni from 'highlight.js/lib/languages/ini';
import hljsDockerfile from 'highlight.js/lib/languages/dockerfile';

/** 注册的语言（同时是「认得的语言」白名单，未注册的一律不高亮）。 */
const HLJS_LANGS: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  javascript: hljsJs,
  typescript: hljsTs,
  python: hljsPy,
  rust: hljsRs,
  json: hljsJson,
  bash: hljsBash,
  xml: hljsXml,
  css: hljsCss,
  yaml: hljsYaml,
  sql: hljsSql,
  go: hljsGo,
  java: hljsJava,
  cpp: hljsCpp,
  markdown: hljsMd,
  diff: hljsDiff,
  ini: hljsIni,
  dockerfile: hljsDockerfile,
};
for (const [name, def] of Object.entries(HLJS_LANGS)) {
  hljs.registerLanguage(name, def);
}

/** 模型常用别名 → 已注册语言名。映射不到又没有同名注册 ⇒ 不高亮（不猜）。 */
const LANG_ALIAS: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', python3: 'python',
  rs: 'rust',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', bash: 'bash',
  html: 'xml', htm: 'xml', vue: 'xml', svg: 'xml', xhtml: 'xml',
  yml: 'yaml',
  md: 'markdown',
  toml: 'ini', conf: 'ini', properties: 'ini',
  'c++': 'cpp', cc: 'cpp', h: 'cpp', hpp: 'cpp', hxx: 'cpp',
  docker: 'dockerfile', dockerfile: 'dockerfile',
  patch: 'diff', udiff: 'diff',
};

/** 语言名归一：能高亮就返回 hljs 语言名，否则返回空串。 */
function normalizeLang(raw?: string): string {
  const l = (raw || '').trim().toLowerCase().split(/[\s:]/)[0];
  if (!l) return '';
  const mapped = LANG_ALIAS[l] ?? l;
  return Object.prototype.hasOwnProperty.call(HLJS_LANGS, mapped) ? mapped : '';
}

/** 能直接在沙箱里跑起来预览的语言（HTML 文档）。 */
const RUNNABLE_LANGS = new Set(['html', 'htm', 'xhtml', 'svg', 'xml']);

/** 渲染选项。 */
export interface MdOptions {
  /**
   * 是否放行原始 HTML。
   *
   * - `false`（默认）：原始 HTML 一律转义成文本 —— AI 对话、浮岛面板等**内容来自模型**的地方。
   *   模型输出可能被提示注入，而主窗有 Tauri IPC 权限，不能直接 innerHTML。
   * - `true`：渲染 HTML **结构**（div/table/details/svg 等），但剔除可执行部分：
   *   `<script>/<style>/<iframe>/<object>/<embed>/<form>/<link>/<meta>/<base>` 整块删除，
   *   `on*=` 事件属性删除，`javascript:` 等协议改写。
   *   只给**用户自己写的笔记**在「纯预览」模式用 —— 那里是用户自己的内容，不是模型产出。
   *   注意：这不是「执行任意 HTML」，脚本仍然不会跑；真要跑脚本走代码块的「预览」（沙箱 iframe）。
   */
  allowHtml?: boolean;
}

/** 当前这次 parse 的选项（marked 的 renderer 是模块级单例，只能走这个通道）。 */
let activeOpts: MdOptions = {};

/** 逐个 parse 递增的标题 id 计数表（同名标题要 id-2 / id-3，否则锚点只会跳到第一个）。 */
let slugCounts = new Map<string, number>();

/** 标题 → 锚点 id：保留中英文数字，空白转 -，去掉其余标点。 */
function slugify(text: string): string {
  const base = text
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}\-_]/gu, '');
  return base || 'section';
}

function uniqueSlug(text: string): string {
  const base = slugify(text);
  const n = (slugCounts.get(base) ?? 0) + 1;
  slugCounts.set(base, n);
  return n === 1 ? base : `${base}-${n}`;
}

/**
 * 原始 HTML 的「结构放行、执行剔除」。
 *
 * 为什么不用 DOMPurify：它要多引一个 ~20KB 运行时，而这里只服务「用户自己笔记的纯预览」
 * 一个场景。正则净化对**可执行面**（脚本/事件属性/危险协议/嵌入对象）够用；
 * 真正对抗恶意输入的地方（模型产出）根本不走这条路径 —— 那边是纯转义。
 */
function sanitizeRawHtml(html: string): string {
  return html
    // 成对标签整块删（含内容），先做，避免只删开标签留下脚本正文
    .replace(/<\s*(script|style|iframe|object|embed|form|link|meta|base)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    // 自闭合/孤立的开标签
    .replace(/<\s*\/?\s*(script|style|iframe|object|embed|form|link|meta|base)\b[^>]*>/gi, '')
    // 事件属性（onclick / onerror / onload …），带引号与不带引号两种写法
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    // 危险协议
    .replace(/(href|src|action)\s*=\s*(["'])\s*(?:javascript|vbscript|data:text\/html)[^"']*\2/gi, '$1="#"');
}

marked.use({
  gfm: true,
  breaks: true,
  async: false,
  renderer: {
    // 标题：必须生成 id，否则文档里的「目录」跳不过去。
    // 血案（2026-10-20 用户实测）：`[安装](#安装)` 的 href 是 #安装，但 marked 默认不给
    // 标题 id ⇒ 浏览器找不到目标 ⇒ 整个 webview 去导航这个 fragment ⇒ 被系统浏览器（Edge）接走。
    // this 的类型用 any：marked 的 Renderer 泛型与这里只用到 parser 一处，
    // 显式写 `this: {parser}` 会与它的 `_Renderer<string,string>` 签名不兼容。
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    heading(this: any, token: { depth: number; tokens?: unknown[] }) {
      const inner: string = this.parser.parseInline(token.tokens ?? []);
      const id = uniqueSlug(inner);
      return `<h${token.depth} id="${escapeHtml(id)}" class="md-heading">${inner}</h${token.depth}>`;
    },
    // 原始 HTML：默认只当文本；允许时（用户自己笔记的纯预览）渲染结构但剔除可执行部分
    html(token: { text: string }) {
      return activeOpts.allowHtml ? sanitizeRawHtml(token.text) : escapeHtml(token.text);
    },
    // 代码块：语言标签 + 复制 + （HTML 类）预览。
    // 以前是在 marked 输出的字符串上再跑一条正则给 <pre><code> 套壳，那个做法有两个隐患：
    // ① 正则会把**行内**代码误伤成块（只要出现 <pre><code> 字样）；② 拿不到 lang 语义
    //   （要再解析 class），也就没法做「按语言决定按钮」。现在直接在渲染器里生成。
    code(token: { text: string; lang?: string; escaped?: boolean }) {
      const rawLang = (token.lang || '').trim().toLowerCase();
      const hl = normalizeLang(rawLang);
      let body: string;
      if (hl) {
        try {
          body = hljs.highlight(token.text, { language: hl, ignoreIllegals: true }).value;
        } catch (e) {
          // 语法内部炸了不能让整条消息变空白：退回纯文本，并留痕
          console.warn('[markdown] 高亮失败，退回纯文本:', hl, e);
          body = escapeHtml(token.text);
        }
      } else {
        body = escapeHtml(token.text);
      }
      const label = rawLang || 'text';
      const dataCode = escapeHtml(token.text);
      const runnable = RUNNABLE_LANGS.has(rawLang.split(/\s/)[0]);
      const runBtn = runnable
        ? `<button type="button" class="md-run-btn" data-code="${dataCode}" data-lang="${escapeHtml(label)}" title="在沙箱 iframe 里运行（与主窗口隔离，可交互）">预览</button>`
        : '';
      return `<div class="md-code-block" data-lang="${escapeHtml(label)}">`
        + `<div class="md-code-head"><span class="md-lang">${escapeHtml(label)}</span>`
        + `<span class="md-code-actions">${runBtn}`
        + `<button type="button" class="md-copy-btn" data-code="${dataCode}" aria-label="复制代码">复制</button>`
        + `</span></div>`
        + `<pre><code class="hljs">${body}</code></pre></div>`;
    },
    // 链接：标出 target/rel（真正打开由全局 click 代理接管）。
    // 此前 markdown 里的链接是「裸」<a href>，在 Tauri webview 里点一下会**导航整个窗口**，
    // 应用直接被替换成目标网页、只能重启 —— 这是用户问的「跳转无法交互」的真相。
    link(token: { href: string; title?: string | null; text: string }) {
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      return `<a href="${escapeHtml(token.href)}"${title} target="_blank" rel="noopener noreferrer" class="md-link">${token.text}</a>`;
    },
  },
});

/** 把 href/src 里的可执行协议换成 #（marked 不做协议过滤）。 */
function neutralizeDangerousProtocols(html: string): string {
  return html.replace(
    /(href|src)(\s*=\s*)(["'])\s*(?:javascript|vbscript|data:text\/html)[^"']*\3/gi,
    '$1$2$3#$3',
  );
}

/** HTML 实体转义（用于把代码块原文塞进 data-* 属性）。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 渲染 markdown 为 HTML（含行内加粗/链接/行内代码/列表/表格/标题/代码块复制按钮）。 */
export function renderMarkdown(content: string, opts?: MdOptions): string {
  if (!content) return '';
  // 缓存键必须带模式：同一段源码在「转义」与「放行 HTML」下产物完全不同，
  // 只按 content 做键会让第一次的结果污染另一种模式。
  const cacheKey = (opts?.allowHtml ? 'H:' : 'E:') + content;
  const hit = mdCache.get(cacheKey);
  if (hit !== undefined) return hit;
  let result: string;
  activeOpts = opts ?? {};
  slugCounts = new Map();
  try {
    // 代码块的外壳与高亮已由 renderer.code 生成，这里只做协议中和（不再跑二道正则：
    // 旧正则会把已经生成的 .md-code-block 再套一层，复制按钮重复、复制内容被转义两次）
    result = neutralizeDangerousProtocols(marked.parse(content, { async: false }) as string);
  } catch {
    result = escapeHtml(content);
  }
  // 内容级缓存：长对话/笔记在流式增量重渲染时，历史消息的 marked 解析结果直接命中，
  // 避免每次 setState 都把全部历史消息重新 parse（同步 marked 是长对话卡顿的主要来源）。
  //
  // 淘汰策略（2026-10-20 改）：满了按插入顺序淘汰最旧的 10%，而不是 clear() 整表。
  // 原因：流式输出时每个增量都是**新字符串**，缓存必然不命中且会快速把表撑满；
  // 旧实现在第 2000 条时整表清空，连历史消息（那些真正还能命中的）一起丢掉，
  // 下一次重渲染又要全量重新解析 —— 表现为「长对话越聊越卡」，且卡顿是周期性的。
  if (mdCache.size >= MD_CACHE_MAX) {
    let drop = Math.ceil(MD_CACHE_MAX * 0.1);
    for (const key of mdCache.keys()) {
      mdCache.delete(key);
      if (--drop <= 0) break;
    }
  }
  mdCache.set(cacheKey, result);
  return result;
}

// markdown 渲染结果缓存（内容 → HTML）。仅缓存，无副作用；容量封顶，防内存膨胀。
const mdCache = new Map<string, string>();
const MD_CACHE_MAX = 2000;

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
  border: 1px solid rgba(127, 127, 127, 0.35);
  opacity: 0.98;
}
/* 代码块头：语言标签在左，按钮在右。以前只有一个绝对定位的复制按钮，
   没有语言标识，也放不下第二个动作（预览）。 */
.md-code-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: rgba(127, 127, 127, 0.16);
  border-bottom: 1px solid rgba(127, 127, 127, 0.22);
  font-size: 10.5px;
  line-height: 1.6;
}
.md-lang {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.7;
}
.md-code-actions { margin-left: auto; display: flex; gap: 6px; }
.md-copy-btn, .md-run-btn {
  background: rgba(127, 127, 127, 0.22);
  color: inherit;
  border: 1px solid rgba(127, 127, 127, 0.4);
  border-radius: 6px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 1.6;
  cursor: pointer;
  opacity: 0.9;
  transition: opacity 0.15s, background 0.15s;
}
.md-copy-btn:hover, .md-run-btn:hover { opacity: 1; background: rgba(127, 127, 127, 0.35); }
.md-copy-btn.copied { color: #16a34a; }
.md-run-btn { font-weight: 600; }
.md-code-block pre {
  margin: 0;
  padding: 10px 12px;
  overflow-x: auto;
  background: rgba(127, 127, 127, 0.1);
  white-space: pre;
  font-size: 0.86em;
  line-height: 1.55;
}
.md-code-block pre code {
  background: transparent;
  padding: 0;
  display: block;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
/* 语法高亮配色（GitHub 主题的一套最小集合）。
   不引入 highlight.js 的整份主题 CSS：它按 .hljs 全局生效，会把插件里的代码块也一起改掉。 */
.md-code-block .hljs-comment, .md-code-block .hljs-quote { color: #6e7781; font-style: italic; }
.md-code-block .hljs-keyword, .md-code-block .hljs-selector-tag, .md-code-block .hljs-doctag,
.md-code-block .hljs-formula { color: #cf222e; }
.md-code-block .hljs-string, .md-code-block .hljs-regexp, .md-code-block .hljs-addition { color: #0a3069; }
.md-code-block .hljs-number, .md-code-block .hljs-literal, .md-code-block .hljs-link { color: #0550ae; }
.md-code-block .hljs-title, .md-code-block .hljs-section, .md-code-block .hljs-function .hljs-title { color: #8250df; }
.md-code-block .hljs-built_in, .md-code-block .hljs-type, .md-code-block .hljs-class .hljs-title { color: #953800; }
.md-code-block .hljs-attr, .md-code-block .hljs-attribute, .md-code-block .hljs-property,
.md-code-block .hljs-variable, .md-code-block .hljs-template-variable { color: #0550ae; }
.md-code-block .hljs-tag, .md-code-block .hljs-name, .md-code-block .hljs-selector-id,
.md-code-block .hljs-selector-class { color: #116329; }
.md-code-block .hljs-meta, .md-code-block .hljs-deletion { color: #6e7781; }
.md-code-block .hljs-emphasis { font-style: italic; }
.md-code-block .hljs-strong { font-weight: 700; }
.dark .md-code-block .hljs-comment, .dark .md-code-block .hljs-quote { color: #8b949e; }
.dark .md-code-block .hljs-keyword, .dark .md-code-block .hljs-selector-tag,
.dark .md-code-block .hljs-doctag, .dark .md-code-block .hljs-formula { color: #ff7b72; }
.dark .md-code-block .hljs-string, .dark .md-code-block .hljs-regexp,
.dark .md-code-block .hljs-addition { color: #a5d6ff; }
.dark .md-code-block .hljs-number, .dark .md-code-block .hljs-literal,
.dark .md-code-block .hljs-link { color: #79c0ff; }
.dark .md-code-block .hljs-title, .dark .md-code-block .hljs-section { color: #d2a8ff; }
.dark .md-code-block .hljs-built_in, .dark .md-code-block .hljs-type { color: #ffa657; }
.dark .md-code-block .hljs-attr, .dark .md-code-block .hljs-attribute,
.dark .md-code-block .hljs-property, .dark .md-code-block .hljs-variable,
.dark .md-code-block .hljs-template-variable { color: #79c0ff; }
.dark .md-code-block .hljs-tag, .dark .md-code-block .hljs-name,
.dark .md-code-block .hljs-selector-id, .dark .md-code-block .hljs-selector-class { color: #7ee787; }
.dark .md-code-block .hljs-meta, .dark .md-code-block .hljs-deletion { color: #8b949e; }
.md-message strong { font-weight: 700; }
.md-message em { font-style: italic; }
/* 链接：蓝字 + 下划线。
   必须同时覆盖 .notes-preview —— 笔记预览的容器类不是 .md-message（它用 tailwind prose），
   prose 的 --tw-prose-links 是近黑色，所以之前链接看着和正文一样。
   .notes-preview.prose a 多一级特异性，才能压过 .prose a。 */
.md-message a, .notes-preview a, .notes-preview.prose a {
  color: #2563eb;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.dark .md-message a, .dark .notes-preview a, .dark .notes-preview.prose a { color: #60a5fa; }
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

/** 幂等注入 markdown CSS（多次调用安全）。
 *
 *  优先走「构造样式表」（CSSStyleSheet + adoptedStyleSheets）：打包后 Tauri 会给 CSP 的 style-src
 *  追加 nonce，按 CSP 规范 nonce/hash 存在时 'unsafe-inline' 被忽略 → 动态插入的 <style> 被整块拦掉。
 *  dev 走 Vite 服务没有该 CSP，所以只在打包版异常：预览卡片底色/边框、复制按钮、pre-wrap 全失效，
 *  多行提示词源码因此塌成一行并被裁断。构造样式表不经过 style-src 检查，dev / 打包表现一致。
 *  旧版曾用 document.getElementById(MD_STYLES_ID) 做幂等判断，adoptedStyleSheets 不产生元素，
 *  所以改用模块级标志。 */
let mdStylesInjected = false;
export function injectMarkdownStyles(): void {
  if (typeof document === 'undefined' || mdStylesInjected) return;
  try {
    if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in document) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(MD_STYLES_TEXT);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      mdStylesInjected = true;
      return;
    }
  } catch { /* 构造样式表不可用，走下面的兜底 */ }
  if (document.getElementById(MD_STYLES_ID)) {
    mdStylesInjected = true;
    return;
  }
  const style = document.createElement('style');
  style.id = MD_STYLES_ID;
  style.textContent = MD_STYLES_TEXT;
  document.head.appendChild(style);
  mdStylesInjected = true;
}

/** 全局交互代理（挂在 document，捕获阶段）。返回卸载函数。
 *
 *  处理 markdown 渲染结果里的三类可交互元素，全部走事件代理，
 *  避免每条消息都绑 React handler（对流式长列表友好）：
 *    1. `.md-copy-btn` —— 复制代码
 *    2. `.md-run-btn`  —— HTML 代码块「预览」：派发 andy:preview-html，由 HtmlPreviewHost 弹沙箱 iframe
 *    3. `a[href]`      —— 链接。**必须拦截**：Tauri webview 里裸 `<a href>` 会把整个应用窗口
 *       导航成目标网页（回不来，只能重启），所以 http(s) 一律交给系统浏览器打开。
 */
function markdownClickHandler(e: Event) {
  {
    const t = e.target as HTMLElement | null;
    if (!t) return;

    // ---- 3) 链接 ----
    const anchor = t.closest?.('a[href]') as HTMLAnchorElement | null;
    if (anchor) {
      // 只接管 markdown 渲染区里的链接。别处的 <a>（设置页、插件 UI）保持原行为，
      // 否则这个 document 级捕获监听会误伤整个应用。
      if (!anchor.closest('.md-message, .notes-preview')) return;
      const href = anchor.getAttribute('href') || '';
      if (!href) return;
      // **所有** markdown 链接一律先拦住默认导航：
      // webview 一旦自己导航，轻则整窗被目标网页替换，重则交给系统浏览器（Edge）。
      e.preventDefault();
      e.stopPropagation();

      // 站内锚点（目录）：在**软件内部**滚到目标标题，不经过系统浏览器。
      // 血案（2026-10-20 用户实测）：旧代码对 `#` 直接 return（不 preventDefault），
      // 而当时的标题没有 id ⇒ 目标找不到 ⇒ webview 拿这个 fragment 去导航 ⇒ 跳到 Edge。
      if (href.startsWith('#')) {
        const raw = href.slice(1);
        let id = raw;
        try {
          id = decodeURIComponent(raw);
        } catch (err) {
          console.warn('[markdown] 锚点解码失败，按原文查找:', raw, err);
        }
        const target = document.getElementById(id) || document.getElementById(raw);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          // 闪一下描边：目录跳转后用户需要知道"落到哪一行了"
          const prevOutline = target.style.outline;
          const prevOffset = target.style.outlineOffset;
          target.style.outline = '2px solid rgba(59,130,246,0.65)';
          target.style.outlineOffset = '2px';
          window.setTimeout(() => {
            target.style.outline = prevOutline;
            target.style.outlineOffset = prevOffset;
          }, 1200);
        } else {
          console.warn('[markdown] 目录锚点没有对应标题（标题被改过，或不是标题锚点）:', href);
        }
        return;
      }

      if (/^(https?:|mailto:)/i.test(href)) {
        // 动态 import：移动端/未启用 opener 插件的构建里不会因此炸掉
        void import('@tauri-apps/plugin-opener')
          .then((m) => m.openUrl(href))
          .catch((err: unknown) => {
            console.warn('[markdown] 系统浏览器打开失败，尝试 window.open:', href, err);
            window.open(href, '_blank', 'noopener');
          });
      } else {
        // 相对路径 / file: 等：不猜它指向哪，明确告诉用户点了没反应的原因
        console.warn('[markdown] 非 http(s) 链接不自动打开（避免误导航）：', href);
        anchor.title = `不自动打开的链接：${href}`;
      }
      return;
    }

    // ---- 2) HTML 代码块预览 ----
    if (t.classList?.contains('md-run-btn')) {
      const code = t.getAttribute('data-code') ?? '';
      const lang = t.getAttribute('data-lang') ?? 'html';
      if (!code) return;
      window.dispatchEvent(new CustomEvent('andy:preview-html', { detail: { code, lang } }));
      return;
    }

    // ---- 1) 复制 ----
    if (!t.classList?.contains('md-copy-btn')) return;
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
}

/**
 * 幂等安装：AI 对话、浮岛两个面板、笔记、移动端各自都会调一次，
 * 旧实现是「每调一次就往 document 上再挂一个捕获监听」——同屏有 N 个渲染方
 * 就会把同一次点击处理 N 遍（复制执行 N 次、预览弹 N 次）。
 * 现在用引用计数：第一个调用者装、最后一个卸载者摘。
 */
let attachedCount = 0;
export function attachMarkdownCopyHandler(): () => void {
  if (typeof document === 'undefined') return () => {};
  // 预览宿主随 markdown 一起就位：任何能渲染 md 的 webview 点「预览」都能用
  ensureHtmlPreviewHost();
  attachedCount += 1;
  if (attachedCount === 1) document.addEventListener('click', markdownClickHandler, true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    attachedCount = Math.max(0, attachedCount - 1);
    if (attachedCount === 0) document.removeEventListener('click', markdownClickHandler, true);
  };
}