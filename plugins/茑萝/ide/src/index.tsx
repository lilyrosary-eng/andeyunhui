/// <reference path="../../../global.d.ts" />
import { marked } from 'marked';
// 茑萝 · IDE 子插件（专业代码编辑器）
// 模块化拆分（边做功能边拆分）：explorer/commandPalette 抽到 modules/，通过 ideShared 通信
import { ideShared } from './modules/shared';
import { IdeSidebar } from './modules/ideSidebar';
import { CommandPalette, type PaletteCommand } from './modules/commandPalette';
// Agent 工具系统增强（阶段二）：权限引擎 + 工具注册表 + 计划模式 + 子代理
// 工具元数据与系统提示词（generateToolSystemPrompt/BUILTIN_TOOLS）暂用本地 SYSTEM_PROMPT，仅引入子代理运行器
import { PlanModePanel, EMPTY_PLAN, type PlanState } from './modules/agent/planMode';
// 权限引擎：逐工具规则（alwaysAllow/alwaysAsk/alwaysDeny）覆盖 PermissionMode 默认行为
// 技能系统（阶段五）：SKILL.md 渐进式披露——索引注入 system prompt + <skill> 工具按需加载全文
import { SkillRegistry, loadBuiltinSkills, discoverProjectSkills, mergeSkills } from './modules/agent/skills';
// 真 PTY 终端（阶段四）：portable-pty 后端 + xterm.js 前端，替换原一次性命令终端 IdeTerminal
import { IdePtyTerminal } from './modules/terminal';
// 内核：CodeMirror 6（按需从 external-deps/茑萝/ide/codemirror 加载，不进插件包，保持本体轻量）。
// 功能：多标签页、查找/替换、状态栏、最近文件、主题/自动换行切换。
// 不提供降级编辑器：若内核加载失败，给出明确错误与构建提示。
const React = window.__HOST_REACT__;
const hostApi = window.__HOST_API__ as unknown as {
  invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  convertFileSrc: (filePath: string) => string;
  listen: <T = unknown>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;
  emit: (event: string, payload?: unknown) => Promise<void>;
  createFrameBuffer: <T>(onFlush: (items: T[]) => void) => any;
  createFloatingWindow: (label: string, url: string, options: Record<string, unknown>) => Promise<void>;
};
const registry = (window as any).__PLUGIN_REGISTRY__;
const { useState, useRef, useCallback, useEffect, useMemo } = React;

// Markdown 渲染：AI 与用户消息中的 # 标题、**加粗**、*斜体*、`代码`、列表、引用、链接等字符
// 激活对应效果（gfm + 单行换行转 <br>，贴合聊天换行习惯）。样式只注入一次。
const MD_CSS = `
.niaoluo-md { font-size: inherit; line-height: 1.6; word-break: break-word; }
.niaoluo-md > :first-child { margin-top: 0; }
.niaoluo-md > :last-child { margin-bottom: 0; }
.niaoluo-md p { margin: 0 0 0.5em; }
.niaoluo-md h1, .niaoluo-md h2, .niaoluo-md h3, .niaoluo-md h4 { margin: 0.6em 0 0.3em; font-weight: 600; line-height: 1.3; }
.niaoluo-md h1 { font-size: 1.35em; } .niaoluo-md h2 { font-size: 1.2em; } .niaoluo-md h3 { font-size: 1.08em; } .niaoluo-md h4 { font-size: 1em; }
.niaoluo-md ul, .niaoluo-md ol { margin: 0.3em 0 0.6em; padding-left: 1.4em; }
.niaoluo-md ul { list-style: disc; } .niaoluo-md ol { list-style: decimal; }
.niaoluo-md li { margin: 0.15em 0; }
.niaoluo-md li > ul, .niaoluo-md li > ol { margin: 0.15em 0; }
.niaoluo-md a { color: var(--element-bg); text-decoration: underline; }
.niaoluo-md code { background: rgba(127,127,127,0.18); padding: 0.1em 0.35em; border-radius: 4px; font-size: 0.9em; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.niaoluo-md pre { background: rgba(127,127,127,0.12); padding: 0.6em 0.8em; border-radius: 8px; overflow-x: auto; margin: 0.4em 0; }
.niaoluo-md pre code { background: none; padding: 0; }
.niaoluo-md blockquote { border-left: 3px solid rgba(127,127,127,0.4); margin: 0.4em 0; padding: 0.1em 0.8em; opacity: 0.85; }
.niaoluo-md hr { border: none; border-top: 1px solid rgba(127,127,127,0.3); margin: 0.6em 0; }
.niaoluo-md table { border-collapse: collapse; margin: 0.4em 0; font-size: 0.92em; }
.niaoluo-md th, .niaoluo-md td { border: 1px solid rgba(127,127,127,0.3); padding: 0.25em 0.5em; }
`;
let mdStyleInjected = false;
function ensureMdStyle() {
  if (mdStyleInjected) return;
  if (typeof document !== 'undefined' && !document.getElementById('niaoluo-md-style')) {
    const s = document.createElement('style');
    s.id = 'niaoluo-md-style';
    s.textContent = MD_CSS;
    document.head.appendChild(s);
  }
  mdStyleInjected = true;
}
function mdHtml(t: string): string {
  try {
    return marked.parse(t, { gfm: true, breaks: true, async: false }) as string;
  } catch {
    return t;
  }
}
function Markdown({ text, className }: { text: string; className?: string }) {
  useEffect(() => {
    ensureMdStyle();
  }, []);
  return (
    <div
      className={'niaoluo-md ' + (className || '')}
      dangerouslySetInnerHTML={{ __html: mdHtml(text) }}
    />
  );
}

// ============ CodeMirror 懒加载（与插件沙箱同源：read_external_dep_file + new Function） ============
interface CM {
  EditorView: any;
  basicSetup: any;
  EditorState: any;
  Compartment: any;
  keymap: any;
  defaultKeymap: any;
  history: any;
  historyKeymap: any;
  indentWithTab: any;
  syntaxHighlighting: any;
  defaultHighlightStyle: any;
  lightTheme: any;
  lightHighlight: any;
  javascript: any;
  python: any;
  html: any;
  css: any;
  json: any;
  oneDark: any;
  search: any;
  searchKeymap: any;
  openSearchPanel: (v: any) => boolean;
  openReplacePanel: (v: any) => boolean;
  closeSearchPanel: (v: any) => void;
}
// CodeMirror 通过动态 import 加载（与 茑萝/gongfang 的 professionalExtras 完全一致）。
// 关键：由 Vite 模块图把 IDE 与 gongfang 的 @codemirror/state 收敛为「同一份实例」，
// 避免「multiple instances of @codemirror/state are loaded」崩溃
// （此前 IDE 走 external-deps 独立 bundle，与主包里 gongfang 动态 import 的那份
//  @codemirror/state 并存于同一 realm，导致 EditorView 扩展 instanceof 校验失败）。
// 注意：沙箱遮蔽了 fetch，但原生 import() 由 WebView 运行时处理，不受影响（gongfang 已验证）。
let cmPromise: Promise<CM> | null = null;
function loadCM(): Promise<CM> {
  if (cmPromise) return cmPromise;
  cmPromise = (async () => {
    const cmMod: any = await import('codemirror');
    const viewMod: any = await import('@codemirror/view');
    const stateMod: any = await import('@codemirror/state');
    const cmdMod: any = await import('@codemirror/commands');
    const langMod: any = await import('@codemirror/language');
    const searchMod: any = await import('@codemirror/search');
    const langJs: any = await import('@codemirror/lang-javascript');
    const langPy: any = await import('@codemirror/lang-python');
    const langHtml: any = await import('@codemirror/lang-html');
    const langCss: any = await import('@codemirror/lang-css');
    const langJson: any = await import('@codemirror/lang-json');
    const themeOneDark: any = await import('@codemirror/theme-one-dark');

    // 浅色主题（与旧 external-deps bundle 同形状）
    const lightTheme = viewMod.EditorView.theme(
      {
        '&': { color: '#24292e', backgroundColor: '#ffffff' },
        '.cm-content': { caretColor: '#24292e' },
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#24292e' },
        '.cm-gutters': { backgroundColor: '#f6f8fa', color: '#959da5', border: 'none' },
        '.cm-activeLine': { backgroundColor: '#f0f3f6' },
        '.cm-activeLineGutter': { backgroundColor: '#f0f3f6' },
        '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
          backgroundColor: '#c8e1ff !important',
        },
        '.cm-tooltip': { border: '1px solid #c8c8c8', backgroundColor: '#f6f8fa' },
      },
      { dark: false },
    );

    return {
      EditorView: viewMod.EditorView,
      basicSetup: cmMod.basicSetup,
      EditorState: stateMod.EditorState,
      Compartment: stateMod.Compartment,
      keymap: viewMod.keymap,
      defaultKeymap: cmdMod.defaultKeymap,
      history: cmdMod.history,
      historyKeymap: cmdMod.historyKeymap,
      indentWithTab: cmdMod.indentWithTab,
      syntaxHighlighting: langMod.syntaxHighlighting,
      defaultHighlightStyle: langMod.defaultHighlightStyle,
      lightTheme,
      lightHighlight: langMod.defaultHighlightStyle,
      javascript: langJs.javascript,
      python: langPy.python,
      html: langHtml.html,
      css: langCss.css,
      json: langJson.json,
      oneDark: themeOneDark.oneDark,
      search: searchMod.search,
      searchKeymap: searchMod.searchKeymap,
      openSearchPanel: searchMod.openSearchPanel,
      openReplacePanel: searchMod.openReplacePanel,
      closeSearchPanel: searchMod.closeSearchPanel,
    } as CM;
  })();
  return cmPromise;
}


// ============ Tab 补全（#13）：AI 补全 + 本地降级 ============
// 说明：CodeMirror 外部依赖未打包 @codemirror/autocomplete，故自行实现（取巧、轻量）。
// 本地补全：基于当前文档已有词元的前缀匹配（最长公共扩展），效果稍差但零依赖、零网络。
function localComplete(view: any): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.head);
  const before = line.text.slice(0, sel.head - line.from);
  const m = before.match(/[A-Za-z_$][A-Za-z0-9_$]*$/);
  if (!m) return false;
  const prefix = m[0];
  if (prefix.length < 2) return false; // 太短无意义
  const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  const words = new Set<string>();
  let x: RegExpExecArray | null;
  const docText = state.doc.toString();
  while ((x = re.exec(docText))) {
    if (x[0] !== prefix) words.add(x[0]);
  }
  const cands = [...words].filter((w) => w.startsWith(prefix) && w.length > prefix.length);
  if (cands.length === 0) return false;
  // 计算最长公共扩展
  let ext = cands[0].slice(prefix.length);
  for (const w of cands) {
    let i = 0;
    const wext = w.slice(prefix.length);
    while (i < ext.length && i < wext.length && ext[i] === wext[i]) i++;
    ext = ext.slice(0, i);
  }
  if (ext.length === 0 && cands.length === 1) ext = cands[0].slice(prefix.length);
  if (ext.length === 0) return false;
  view.dispatch({
    changes: { from: sel.head, insert: ext },
    selection: { anchor: sel.head + ext.length },
  });
  return true;
}

// AI 补全：调用全局 ai_chat（流式）续写光标处代码，返回补全文本（无 AI 时由调用方降级）。
function completionPrompt(ctx: string): string {
  return [
    '你是一个代码补全器。下面是光标之前的源代码：',
    '```',
    ctx,
    '```',
    '请直接从光标位置续写代码：只输出新增代码片段，不要重复已有内容，不要解释，不要使用 Markdown 代码块围栏。若无需补全，输出空字符串。',
  ].join('\n');
}

async function aiCompleteText(ctx: string, activeId: string): Promise<string> {
  if (!activeId) return '';
  const reqId = 'tc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let acc = '';
  let done = false;
  let errMsg: string | null = null;
  const u1 = await hostApi.listen<{ requestId: string; delta: string }>('ai-delta', (e) => {
    if (e.payload.requestId === reqId) acc += e.payload.delta;
  });
  const u2 = await hostApi.listen<{ requestId: string }>('ai-done', (e) => {
    if (e.payload.requestId === reqId) done = true;
  });
  const u3 = await hostApi.listen<{ requestId: string; error: string }>('ai-error', (e) => {
    if (e.payload.requestId === reqId) { errMsg = e.payload.error; done = true; }
  });
  try {
    await hostApi.invoke('ai_chat', {
      requestId: reqId,
      messages: [{ role: 'user', content: completionPrompt(ctx) }],
      profileId: activeId,
    });
    await new Promise<void>((res) => {
      const t = setInterval(() => { if (done) { clearInterval(t); res(); } }, 60);
      setTimeout(() => { clearInterval(t); res(); }, 25000);
    });
  } catch (e) {
    errMsg = String(e);
  } finally {
    u1(); u2(); u3();
  }
  return errMsg ? '' : acc;
}

// ============ 语言映射 ============
const EXT_LANG: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', ts: 'javascript', tsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', py: 'python', rs: 'rust', go: 'go',
  html: 'html', htm: 'html', css: 'css', scss: 'css',
  txt: 'plaintext', md: 'plaintext', log: 'plaintext',
};
const LANGS = [
  { id: 'auto', label: '自动' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'json', label: 'JSON' },
  { id: 'python', label: 'Python' },
  { id: 'rust', label: 'Rust' },
  { id: 'go', label: 'Go' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'plaintext', label: '纯文本' },
];

// 底部面板（问题/输出/调试/终端）标签
const BOTTOM_LABELS: Record<'problems' | 'output' | 'debug' | 'terminal', string> = {
  problems: '问题', output: '输出', debug: '调试', terminal: '终端',
};

// 「问题」面板：双源诊断（前端轻量扫描 + 后端 LSP 类型诊断）。
// - scanProblems：行尾空白、超长行、括号不匹配、TODO/FIXME 等通用静态检查（零依赖、即时）
// - lsp_diagnostics：后端 spawn tsc/cargo check/pyright 做真实类型诊断（1s 防抖、10s 缓存）
// 对齐 claw-code-main/runtime/src/lsp_client.rs::LspDiagnostic 结构。
interface Problem {
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  source?: string; // "scan" / "tsc" / "cargo" / "pyright" / "python"
  code?: string;   // 错误代码（TS1234 / E0308 / SyntaxError…）
}
function scanProblems(doc: string): Problem[] {
  const problems: Problem[] = [];
  const lines = doc.split('\n');
  const counts: Record<string, number> = { '(': 0, ')': 0, '{': 0, '}': 0, '[': 0, ']': 0 };
  lines.forEach((ln, i) => {
    const lineNo = i + 1;
    if (ln.length > 0 && /\s+$/.test(ln)) {
      problems.push({ line: lineNo, column: ln.replace(/\s+$/, '').length + 1, severity: 'warning', message: '行尾有多余空白', source: 'scan' });
    }
    if (ln.length > 120) {
      problems.push({ line: lineNo, column: 121, severity: 'warning', message: `行过长（${ln.length} 字符，建议 ≤120）`, source: 'scan' });
    }
    const m = ln.match(/(TODO|FIXME|XXX|HACK)/);
    if (m) {
      problems.push({ line: lineNo, column: (m.index ?? 0) + 1, severity: 'info', message: `标记：${m[1]}`, source: 'scan' });
    }
    for (const ch of ln) { if (ch in counts) counts[ch]++; }
  });
  const pair = (open: string, close: string, name: string) => {
    if (counts[open] !== counts[close]) {
      problems.push({ line: 1, column: 1, severity: 'error', message: `${name}不匹配：${open} 有 ${counts[open]} 个，${close} 有 ${counts[close]} 个`, source: 'scan' });
    }
  };
  pair('(', ')', '圆括号');
  pair('{', '}', '花括号');
  pair('[', ']', '方括号');
  return problems;
}


function langFromPath(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() || '';
  return EXT_LANG[ext] || 'plaintext';
}
function cmLang(cm: CM, lang: string): any {
  switch (lang) {
    case 'javascript': return cm.javascript({ jsx: true, typescript: true });
    case 'json': return cm.json();
    case 'python': return cm.python();
    case 'html': return cm.html();
    case 'css': return cm.css();
    default: return [];
  }
}
function isDark(): boolean {
  return document.documentElement.classList.contains('dark');
}
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

// ============ 自主编辑（agent）模式：路径解析 / 指令解析 / 简易 diff ============
// 待审阅的改动条目（由 IDE 主组件持有，渲染审阅面板）
interface AgentEdit {
  id: string;
  path: string;
  old: string;        // 红色区域：要被删除/替换的现有代码（新建文件为 ''）
  new: string;        // 绿色区域：要新增/替换的代码
  isNew: boolean;     // 是否为新建文件（无红色区域）
  status: 'pending' | 'kept' | 'undone' | 'failed' | 'blocked';
  error?: string;
}


function normEq(a: string, b: string): boolean {
  return a.replace(/\\/g, '/') === b.replace(/\\/g, '/');
}



// ============ 策略引擎 + 许可令牌（替代硬编码 PROTECTED_PATTERNS 的临时放行能力） ============
// 对齐 policy_engine.rs::PolicyRule + PolicyAction + permission_enforcer.rs::check_with_required_mode
// 与 approval_tokens.rs::ApprovalToken（Pending/Granted/Consumed/Expired/Revoked）
//
// 四档 PermissionMode（抄 permissions.rs::PermissionMode 概念）：
//   read-only  → 所有 <write>/<edit>/<shell> 直接 block（仅放行 <read>/<ast>）
//   plan       → 只允许 <read>/<ast>，所有写/shell/mcp 都 block（用于让 agent 出方案不落地）
//   normal     → 当前行为（按 isTrusted 走 trust_resolver 逻辑）
//   dangerous  → 破坏性操作需 approval="token" 属性，token 由用户在 UI 看到、口头告诉 agent
//                token 为一次性（对齐 approval_tokens.rs::one-shot），用后即消费、需重新生成
//
// 注意：read-only/plan/dangerous 三档为「叠加在 isTrusted 之上的额外约束」：
//   - 未信任 + read-only = 仍然全 block（取更严的一档）
//   - 已信任 + dangerous = 需 token 才能写/破坏性 shell
type PermissionMode = 'read-only' | 'plan' | 'normal' | 'dangerous';
const PERMISSION_MODES: PermissionMode[] = ['read-only', 'plan', 'normal', 'dangerous'];
const PERMISSION_MODE_META: Record<PermissionMode, { label: string; chip: string; cls: string; desc: string }> = {
  'read-only': { label: '只读', chip: '🟢', cls: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10', desc: '所有 <write>/<edit>/<shell> 直接拦截，仅放行 <read>/<ast>' },
  'plan': { label: '方案', chip: '🔵', cls: 'text-sky-600 dark:text-sky-400 bg-sky-500/10', desc: '只允许 <read>/<ast>，agent 出方案不落地' },
  'normal': { label: '常规', chip: '🟡', cls: 'text-amber-600 dark:text-amber-400 bg-amber-500/10', desc: '按信任状态走默认逻辑（已信任=可写+受限shell，未信任=只读）' },
  'dangerous': { label: '高危', chip: '🔴', cls: 'text-red-600 dark:text-red-400 bg-red-500/10', desc: '破坏性操作需 approval="token" 属性，token 一次性使用' },
};

// 生成 6 位许可令牌（大小写字母+数字，对齐 approval_tokens.rs::generate_token 的可读字符集）
function generateApprovalToken(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混字符 I/O/0/1
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// 解码 XML 实体，让指令属性（path / command）里能安全携带引号等字符，
// 解决「命令里直接写双引号会被截断」的问题（前端约定：双引号属性内用 &quot; 转义）。



// ---------- 行级替换的「语义补全」：空白归一化模糊定位 ----------
function normalizedSpan(haystack: string, needle: string): [number, number] | null {
  if (!needle) return null;
  const hChars: string[] = [];
  const hMap: number[] = [];
  let prevWS = false;
  for (let i = 0; i < haystack.length; i++) {
    const ch = haystack[i];
    const isWS = ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
    if (isWS) { if (!prevWS) { hChars.push(' '); hMap.push(i); prevWS = true; } }
    else { hChars.push(ch); hMap.push(i); prevWS = false; }
  }
  const n = hChars.join('');
  const needleN = needle.replace(/\s+/g, ' ').trim();
  if (!needleN) return null;
  const idx = n.indexOf(needleN);
  if (idx < 0) return null;
  const start = hMap[idx];
  const endIdx = idx + needleN.length;
  const end = endIdx < hMap.length ? hMap[endIdx] : haystack.length;
  return [start, end];
}
function fuzzyReplace(content: string, oldStr: string, newStr: string): string | null {
  if (!oldStr) return null;
  const exact = content.indexOf(oldStr);
  if (exact >= 0) return content.slice(0, exact) + newStr + content.slice(exact + oldStr.length);
  const span = normalizedSpan(content, oldStr);
  if (span) return content.slice(0, span[0]) + newStr + content.slice(span[1]);
  return null;
}

// ---------- Lint Fix 轻量守卫：括号平衡（忽略字符串与注释）----------
function bracketsBalanced(s: string): boolean {
  const pair: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < s.length) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '(' || c === '[' || c === '{') stack.push(c);
    else if (c === ')' || c === ']' || c === '}') { if (stack.pop() !== pair[c]) return false; }
    i++;
  }
  return stack.length === 0;
}

// ---- 对外 API：classifyShell（合并 intent + validation，返回完整风险信息） ----




// ============ 插件 Hook 生命周期（借鉴 hooks.rs::HookEvent + plugin_lifecycle.rs） ============
// 暴露 window.__IDE_AGENT_HOOKS__ 注册点，允许其他子插件扩展 agent 行为。
// 对齐 hooks.rs::HookEvent（PreToolUse/PostToolUse/PostToolUseFailure）：
// - before* 钩子可返回 { cancel, reason, modify } 拦截或改写操作
// - after* 钩子仅通知，不可改写（except afterRead 可 modify 内容）
// 对齐 plugin_lifecycle.rs::PluginState：hooks 自身有状态（registered→active→error）

type HookName =
  | 'beforeShell' | 'afterShell'
  | 'beforeWrite' | 'afterWrite'
  | 'beforeEdit' | 'afterEdit'
  | 'beforeRead' | 'afterRead'
  | 'beforeCommit'
  | 'beforeMcp' | 'afterMcp'        // MCP 外部工具调用（A2）
  | 'beforeSubagent' | 'afterSubagent' // 子代理启动（A2）
  | 'onToolError';                   // 工具执行失败（A1，对齐 hooks.rs::PostToolUseFailure）

interface HookResult {
  cancel?: boolean;       // 拦截该操作
  reason?: string;        // 拦截/提示原因（展示给 agent）
  modify?: any;           // 改写操作输入（beforeShell→string 命令, beforeWrite→string 内容, beforeEdit→{old,new}, beforeRead→void, afterRead→string, beforeCommit→AgentEdit[]）
  messages?: string[];    // 附加信息（展示给用户）
}

type HookCallback = (...args: any[]) => HookResult | Promise<HookResult | undefined> | undefined;

interface HookEntry {
  id: string;             // 注册者标识（插件 id）
  name: HookName;
  callback: HookCallback;
  state: 'registered' | 'active' | 'error'; // 对齐 PluginState 简化版
  errorCount: number;
}

class HookRegistry {
  private hooks = new Map<HookName, HookEntry[]>();
  private counter = 0;

  register(id: string, name: HookName, callback: HookCallback): () => void {
    const entry: HookEntry = { id: id + '#' + (++this.counter), name, callback, state: 'registered', errorCount: 0 };
    if (!this.hooks.has(name)) this.hooks.set(name, []);
    this.hooks.get(name)!.push(entry);
    entry.state = 'active';
    // 返回取消注册函数
    return () => {
      const arr = this.hooks.get(name);
      if (!arr) return;
      const idx = arr.indexOf(entry);
      if (idx >= 0) arr.splice(idx, 1);
    };
  }

  // 运行某事件的所有钩子，合并结果（对齐 hooks.rs::run_pre_tool_use 的 deny/modify/messages 语义）
  async run(name: HookName, ...args: any[]): Promise<HookResult> {
    const arr = this.hooks.get(name);
    if (!arr || arr.length === 0) return {};
    const merged: HookResult = { messages: [] };
    for (const entry of arr) {
      if (entry.state === 'error' && entry.errorCount > 3) continue; // 连续失败超 3 次自动禁用
      try {
        const r = await entry.callback(...args);
        entry.errorCount = 0;
        if (r) {
          if (r.cancel) { merged.cancel = true; if (r.reason) merged.reason = (merged.reason ? merged.reason + '; ' : '') + r.reason; }
          if (r.modify !== undefined) merged.modify = r.modify; // 后注册的优先（覆盖）
          if (r.messages) merged.messages!.push(...r.messages);
        }
      } catch (e) {
        entry.errorCount++;
        entry.state = 'error';
        if (entry.errorCount > 3) entry.state = 'error'; // 永久禁用
        // 钩子异常不阻断主流程（对齐 hooks.rs::is_failed 的容错语义）
        console.warn(`[IDE Hook] ${entry.id}.${name} 异常:`, e);
      }
    }
    return merged;
  }

  // 调试用：列出所有已注册钩子
  list(): { id: string; name: HookName; state: string; errorCount: number }[] {
    const out: { id: string; name: HookName; state: string; errorCount: number }[] = [];
    for (const [name, arr] of this.hooks) for (const e of arr) out.push({ id: e.id, name, state: e.state, errorCount: e.errorCount });
    return out;
  }

  count(): number {
    let n = 0;
    for (const arr of this.hooks.values()) n += arr.length;
    return n;
  }
}

const hookRegistry = new HookRegistry();

// 暴露到 window 供其他子插件注册（对齐 window.__PLUGIN_REGISTRY__ 模式）
// 用法：window.__IDE_AGENT_HOOKS__.register('my-plugin', 'beforeShell', (cmd, cwd) => { ... })
const w0 = window as any;
w0.__IDE_AGENT_HOOKS__ = {
  register: (id: string, name: HookName, callback: HookCallback) => hookRegistry.register(id, name, callback),
  list: () => hookRegistry.list(),
  count: () => hookRegistry.count(),
};

// 解析 <think>...</think> 块（Anthropic Claude / DeepSeek-R1 等模型的推理过程），从可见文本中剥离。
// 返回 thinking（可空）+ visible（剥离后剩余的正文）。流式时未闭合的 <think> 也算作 thinking。
function parseThinking(content: string): { thinking: string | null; visible: string } {
  if (!content) return { thinking: null, visible: '' };
  // 已闭合的 <think>...</think>
  const closed: string[] = [];
  let visible = content.replace(/<think\b[^>]*>([\s\S]*?)<\/think>/g, (_m, inner) => {
    closed.push(inner.trim());
    return '';
  });
  // 未闭合的 <think>（流式中途）：把开标签之后的部分当 thinking，visible 置空
  const openIdx = visible.indexOf('<think');
  if (openIdx >= 0) {
    const after = visible.slice(openIdx);
    const gt = after.indexOf('>');
    if (gt >= 0) {
      closed.push(after.slice(gt + 1).trim());
      visible = visible.slice(0, openIdx);
    }
  }
  const thinking = closed.length > 0 ? closed.join('\n\n') : null;
  return { thinking, visible: visible.trim() };
}

// 估算单轮 agent 任务的美元成本（按 OpenAI/Anthropic 公开价格表粗算，仅用于状态栏提示，非账单）
// 输入：inputTokens, outputTokens, model 名（用于匹配价格档位）
function estimateCost(inputTokens: number, outputTokens: number, model: string | undefined): number {
  const m = (model || '').toLowerCase();
  // 价格表（USD / 1M tokens），来源：2025 年公开定价
  // 档位：opus / sonnet / haiku / gpt-4 / gpt-4o / gpt-4o-mini / deepseek / 其他
  let inPrice = 3.0, outPrice = 15.0; // 默认按 sonnet 档
  if (m.includes('opus')) { inPrice = 15; outPrice = 75; }
  else if (m.includes('sonnet')) { inPrice = 3; outPrice = 15; }
  else if (m.includes('haiku')) { inPrice = 0.25; outPrice = 1.25; }
  else if (m.includes('gpt-4o-mini') || m.includes('gpt-4.1-mini')) { inPrice = 0.15; outPrice = 0.6; }
  else if (m.includes('gpt-4o') || m.includes('gpt-4.1')) { inPrice = 2.5; outPrice = 10; }
  else if (m.includes('gpt-4-turbo') || m.includes('gpt-4-32k')) { inPrice = 10; outPrice = 30; }
  else if (m.includes('deepseek')) { inPrice = 0.14; outPrice = 0.28; }
  else if (m.includes('qwen') || m.includes('glm') || m.includes('doubao')) { inPrice = 0.5; outPrice = 1.5; }
  return (inputTokens / 1_000_000) * inPrice + (outputTokens / 1_000_000) * outPrice;
}

// 格式化耗时（毫秒 → "12.3s" / "1m 23s"）
function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  const m = Math.floor(s / 60);
  const rs = Math.floor(s % 60);
  return `${m}m ${rs}s`;
}

// ============ Prompt Cache 前端层（借鉴 claw-code-main/api/src/prompt_cache.rs） ============
// 两层缓存：
//   1. completionCache：前端请求指纹缓存（SHA-256），命中直接重放，TTL 30s。
//      仅用于 cacheable=true 的确定性调用（如 summarizeHistory 重试、相同 prompt 二次提交）。
//   2. providerCacheStats：解析 ai-done 事件的 usage 字段，统计 provider 侧 cache_read/cache_creation tokens。
//      对应 prompt_cache.rs 的 PromptCacheStats（tracked_requests / cache_hits / cache_read_input_tokens…）。

// 从 usage 对象中提取 cache 相关 token 数（兼容 OpenAI / DeepSeek / Anthropic 字段名）
function parseUsageTokens(usage: any): { promptTokens: number; completionTokens: number; cacheReadTokens: number; cacheCreationTokens: number } {
  if (!usage) return { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  return {
    promptTokens: usage.prompt_tokens || usage.input_tokens || 0,
    completionTokens: usage.completion_tokens || usage.output_tokens || 0,
    // Anthropic: cache_read_input_tokens / cache_creation_input_tokens
    // DeepSeek: prompt_cache_hit_tokens / prompt_cache_miss_tokens
    // OpenAI: prompt_tokens_details.cached_tokens
    cacheReadTokens: usage.cache_read_input_tokens || usage.prompt_cache_hit_tokens || (usage.prompt_tokens_details?.cached_tokens) || 0,
    cacheCreationTokens: usage.cache_creation_input_tokens || usage.prompt_cache_miss_tokens || 0,
  };
}

// ============ 信任解析器（借鉴 claw-code-main/runtime/src/trust_resolver.rs） ============
// VSCode 同款「Do you trust the files in this folder」机制：
// 首次打开某项目根时弹窗询问，结果存 localStorage；未信任目录下，agent 的 <shell> 与 <write> 默认禁用，
// 仅允许 <read>/<ast>（只读探索）。借鉴 trust_resolver.rs 的 TrustPolicy 三态：AutoTrust/RequireApproval/Deny。
const TRUSTED_ROOTS_KEY = 'ide_trusted_roots_v1';
function getTrustedRoots(): Set<string> {
  try {
    const raw = localStorage.getItem(TRUSTED_ROOTS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}
function saveTrustedRoots(set: Set<string>): void {
  try { localStorage.setItem(TRUSTED_ROOTS_KEY, JSON.stringify([...set])); } catch { /* 忽略 */ }
}
function addTrustedRoot(path: string): void {
  if (!path) return;
  const s = getTrustedRoots();
  s.add(path);
  saveTrustedRoots(s);
}
function removeTrustedRoot(path: string): void {
  const s = getTrustedRoots();
  s.delete(path);
  saveTrustedRoots(s);
}
function isPathTrusted(path: string | null | undefined): boolean {
  if (!path) return false;
  const s = getTrustedRoots();
  if (s.has(path)) return true;
  // 支持父目录信任继承：若任意上级目录被信任，子目录也算信任
  for (const r of s) {
    if (path.startsWith(r.replace(/[\\/]+$/, '') + '/') || path.startsWith(r.replace(/[\\/]+$/, '') + '\\')) return true;
  }
  return false;
}

// ============ 会话持久化与分叉（对齐 session.rs::Session + SessionFork + task_registry.rs::Task） ============
// 设计要点（直接抄 session.rs 的字段与轮转策略）：
//   - JSONL 持久化 → 这里用 localStorage（5MB 限制足够 ~50 个会话，单会话超 256KB 触发截断）
//   - 256KB 轮转：单会话 JSON 超 256KB 时，截断 messages 中间（保留首尾各 20 条，中间用占位符）
//   - 字段截断：单条 content 超 8KB 截断尾部（对齐 session.rs::truncate_field）
//   - 最多保留 20 个会话（对齐 task_registry.rs 的轮转上限），超出按 ts 升序删除最旧
//
// 数据结构（对齐 session.rs::Session + task_registry.rs::Task）：
//   PersistedSession.id          ← task_id
//   PersistedSession.ts          ← heartbeat / updated_at
//   PersistedSession.projectRoot ← team_id（项目隔离）
//   PersistedSession.firstPrompt ← prompt（列表显示用）
//   PersistedSession.messages    ← messages
//   PersistedSession.conv        ← UI 对话历史（AgentMsg[]，便于直接恢复显示）
//   PersistedSession.edits       ← pendingEdits（待审阅改动）
//   PersistedSession.stats       ← agentStats
//   PersistedSession.parentSessionId ← SessionFork.parent_session_id
//   PersistedSession.branchName      ← SessionFork.branch_name
interface PersistedSession {
  id: string;
  ts: number;
  projectRoot: string;
  firstPrompt: string;
  messages: { role: string; content: string }[];
  conv: AgentMsg[];
  edits: AgentEdit[];
  stats: {
    totalInputTokens: number; totalOutputTokens: number; totalCost: number;
    totalShells: number; totalEdits: number; totalReads: number; rounds: number;
    cacheReadTokens: number; cacheCreationTokens: number; cacheHits: number; cacheMisses: number;
  };
  parentSessionId?: string;
  branchName?: string;
}
// 会话索引条目（轻量，仅用于列表展示，不含完整 messages）
interface SessionIndexEntry {
  id: string;
  ts: number;
  projectRoot: string;
  firstPrompt: string;
  rounds: number;
  parentSessionId?: string;
  branchName?: string;
}
const SESSION_INDEX_KEY = 'ide_session_index_v1';
const SESSION_KEY_PREFIX = 'ide_session_';
const SESSION_MAX_COUNT = 20;          // 最多保留 20 个会话
const SESSION_TRUNCATE_BYTES = 256 * 1024; // 单会话超 256KB 触发截断
const FIELD_TRUNCATE_BYTES = 8 * 1024;     // 单条 content 超 8KB 截断

// 字段截断（对齐 session.rs::truncate_field）：超长尾部截断 + 占位符
function truncateField(s: string, maxBytes: number): string {
  // UTF-8 字节长度估算（粗略：Latin 字符 1 字节，CJK 3 字节）
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i)!;
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    if (bytes > maxBytes) {
      return s.slice(0, i) + '\n…（字段超长已截断，原始 ' + s.length + ' 字符）';
    }
  }
  return s;
}

// 会话级截断（对齐 session.rs 256KB 轮转）：messages 中间截断保留首尾
function truncateSessionMessages(messages: { role: string; content: string }[]): { role: string; content: string }[] {
  let totalBytes = 0;
  const truncated = messages.map((m) => {
    const c = truncateField(m.content, FIELD_TRUNCATE_BYTES);
    totalBytes += c.length * 2; // 粗略估算
    return { role: m.role, content: c };
  });
  if (totalBytes <= SESSION_TRUNCATE_BYTES) return truncated;
  // 中间截断：保留首尾各 20 条
  const KEEP = 20;
  if (truncated.length <= KEEP * 2) return truncated;
  const head = truncated.slice(0, KEEP);
  const tail = truncated.slice(truncated.length - KEEP);
  const omitted = truncated.length - KEEP * 2;
  head.push({ role: 'system', content: `…（中间 ${omitted} 条消息已截断以满足 256KB 上限）…` });
  return [...head, ...tail];
}

// 读取会话索引
function loadSessionIndex(): SessionIndexEntry[] {
  try {
    const raw = localStorage.getItem(SESSION_INDEX_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function saveSessionIndex(idx: SessionIndexEntry[]): void {
  try { localStorage.setItem(SESSION_INDEX_KEY, JSON.stringify(idx)); } catch { /* 忽略 */ }
}

// 保存单个会话（写 localStorage + 更新索引 + 轮转）
function savePersistedSession(sess: PersistedSession): void {
  try {
    const truncatedMsgs = truncateSessionMessages(sess.messages);
    const body: PersistedSession = { ...sess, messages: truncatedMsgs };
    localStorage.setItem(SESSION_KEY_PREFIX + sess.id, JSON.stringify(body));
    // 更新索引
    const idx = loadSessionIndex().filter((e) => e.id !== sess.id);
    idx.unshift({
      id: sess.id, ts: sess.ts, projectRoot: sess.projectRoot,
      firstPrompt: sess.firstPrompt, rounds: sess.stats.rounds,
      parentSessionId: sess.parentSessionId, branchName: sess.branchName,
    });
    // 轮转：保留最近 SESSION_MAX_COUNT 个
    const trimmed = idx.slice(0, SESSION_MAX_COUNT);
    // 删除被裁掉的会话 body
    for (const e of idx.slice(SESSION_MAX_COUNT)) {
      try { localStorage.removeItem(SESSION_KEY_PREFIX + e.id); } catch { /* 忽略 */ }
    }
    saveSessionIndex(trimmed);
  } catch { /* localStorage 满 */ }
}

// 加载单个会话完整数据
function loadPersistedSession(id: string): PersistedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY_PREFIX + id);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedSession;
  } catch { return null; }
}

// 删除单个会话
function deletePersistedSession(id: string): void {
  try { localStorage.removeItem(SESSION_KEY_PREFIX + id); } catch { /* 忽略 */ }
  saveSessionIndex(loadSessionIndex().filter((e) => e.id !== id));
}

// 列出指定项目的会话（按 ts 降序）
function listSessionsForProject(projectRoot: string): SessionIndexEntry[] {
  return loadSessionIndex()
    .filter((e) => e.projectRoot === projectRoot)
    .sort((a, b) => b.ts - a.ts);
}



// 粗略 token 估算（中英文混排/代码场景下的护栏用，非精确）：约按字符数 / 4。
function estimateTokens(s: string): number {
  if (!s) return 0;
  // CJK 按字计 1~2 token，ASCII 词按空格计；用字符数/4 作保守近似
  return Math.ceil(s.length / 4);
}




interface Tab {
  id: string;
  path: string;       // 空字符串表示未保存的新文档
  name: string;
  doc: string;
  lang: string;       // 用户/自动选定的语言 id
  dirty: boolean;
}

// ============ 主编辑器（命令式 view 引用，标签页切换时整体替换文档） ============
function CmEditor({
  cm, tab, theme, wrap, onViewReady, onChange, onCursor, suppressDirtyRef,
  tabUseAi, aiAvailable, aiActiveId, onDegrade,
}: {
  cm: CM;
  tab: Tab;
  theme: 'auto' | 'dark' | 'light';
  wrap: boolean;
  onViewReady: (v: any) => void;
  onChange: (doc: string) => void;
  onCursor: (line: number, col: number) => void;
  suppressDirtyRef: React.MutableRefObject<boolean>;
  tabUseAi: boolean;
  aiAvailable: boolean;
  aiActiveId: string | null;
  onDegrade: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<any>(null);
  const langCpt = useRef<any>(null);
  const themeCpt = useRef<any>(null);
  const wrapCpt = useRef<any>(null);
  const selCpt = useRef<any>(null);
  const onChangeRef = useRef(onChange);
  const onCursorRef = useRef(onCursor);
  onChangeRef.current = onChange;
  onCursorRef.current = onCursor;

  // Tab 补全：用 ref 透传最新开关/状态，使一次性挂载的 keymap 始终读到最新值（#13）
  const tabUseAiRef = useRef(tabUseAi);
  const aiAvailableRef = useRef(aiAvailable);
  const aiActiveIdRef = useRef(aiActiveId);
  const onDegradeRef = useRef(onDegrade);
  tabUseAiRef.current = tabUseAi;
  aiAvailableRef.current = aiAvailable;
  aiActiveIdRef.current = aiActiveId;
  onDegradeRef.current = onDegrade;
  const aiBusyRef = useRef(false);

  // 显式定义选区背景，避免浅色主题下鼠标拖动选择无可见高亮。
  // 关键：CM6 核心 baseTheme 的 "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground"
  // 选择器特异性更高，聚焦（拖选）时会盖过普通自定义主题 → 浅色下选区几乎不可见；
  // 深色的 oneDark 用了 !important 故正常。这里同样加 !important 强制生效（覆盖 baseTheme）。
  const selectionTheme = (dark: boolean) => cm.EditorView.theme({
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: (dark ? 'rgba(75, 110, 175, 0.55)' : 'rgba(30, 110, 200, 0.35)') + ' !important',
    },
    '.cm-selectionMatch': {
      backgroundColor: (dark ? 'rgba(75, 110, 175, 0.35)' : 'rgba(30, 110, 200, 0.22)') + ' !important',
    },
  }, { dark });

  // 查找浮层：半透明毛玻璃弹窗风格（替代默认铺满顶部的搜索条，#5）
  const searchPanelLight = cm.EditorView.theme({
    '.cm-panel.cm-search': {
      position: 'absolute', top: '8px', right: '12px', left: 'auto', zIndex: '30', margin: '0',
      backgroundColor: 'rgba(255,255,255,0.82)',
      backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
      border: '1px solid rgba(0,0,0,0.08)', borderRadius: '10px',
      boxShadow: '0 10px 30px rgba(0,0,0,0.18)', padding: '6px 8px',
    },
    '.cm-search': { fontSize: '12px', color: '#404040' },
    '.cm-search input': {
      backgroundColor: 'rgba(255,255,255,0.9)', border: '1px solid rgba(0,0,0,0.12)',
      borderRadius: '6px', padding: '2px 6px', color: '#1f1f1f', outline: 'none',
    },
    '.cm-search button': {
      backgroundColor: 'rgba(0,0,0,0.04)', border: '1px solid rgba(0,0,0,0.08)',
      borderRadius: '6px', padding: '2px 8px', margin: '0 2px', color: '#404040', cursor: 'pointer',
    },
    '.cm-search label': { margin: '0 4px', color: '#525252' },
  });
  const searchPanelDark = cm.EditorView.theme({
    '.cm-panel.cm-search': {
      position: 'absolute', top: '8px', right: '12px', left: 'auto', zIndex: '30', margin: '0',
      backgroundColor: 'rgba(28,25,23,0.82)',
      backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
      border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px',
      boxShadow: '0 10px 30px rgba(0,0,0,0.5)', padding: '6px 8px',
    },
    '.cm-search': { fontSize: '12px', color: '#e7e5e4' },
    '.cm-search input': {
      backgroundColor: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.15)',
      borderRadius: '6px', padding: '2px 6px', color: '#f5f5f4', outline: 'none',
    },
    '.cm-search button': {
      backgroundColor: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: '6px', padding: '2px 8px', margin: '0 2px', color: '#e7e5e4', cursor: 'pointer',
    },
    '.cm-search label': { margin: '0 4px', color: '#a8a29e' },
  });

  const effectiveLang = tab.lang === 'auto' ? (tab.path ? langFromPath(tab.path) : 'plaintext') : tab.lang;

  // 挂载一次
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    langCpt.current = new cm.Compartment();
    themeCpt.current = new cm.Compartment();
    wrapCpt.current = new cm.Compartment();
    selCpt.current = new cm.Compartment();

    // Tab 补全（#13）：优先用用户部署的 AI 续写；无 AI 或关闭时降级本地补全；均不可时退化为缩进。
    const doAiComplete = async (view: any) => {
      if (aiBusyRef.current) return;
      aiBusyRef.current = true;
      try {
        const doc = view.state.doc;
        const head = view.state.selection.main.head;
        const before = doc.sliceString(0, head);
        const ctx = before.length > 6000 ? '...' + before.slice(-6000) : before;
        const text = await aiCompleteText(ctx, aiActiveIdRef.current || '');
        if (text && text.trim()) {
          const clean = text.replace(/^[\r\n]+/, '');
          view.dispatch({
            changes: { from: head, insert: clean },
            selection: { anchor: head + clean.length },
          });
        }
      } catch {
        /* 忽略补全失败 */
      } finally {
        aiBusyRef.current = false;
      }
    };
    const tabHandler = (view: any): boolean => {
      if (tabUseAiRef.current && aiAvailableRef.current) {
        doAiComplete(view);
        return true;
      }
      // 本地补全（效果稍差）
      const didLocal = localComplete(view);
      if (!didLocal) {
        if (tabUseAiRef.current && !aiAvailableRef.current) onDegradeRef.current();
        const r = cm.indentWithTab.run ? cm.indentWithTab.run(view) : false;
        return typeof r === 'boolean' ? r : true;
      }
      return true;
    };

    const resolvedTheme = theme === 'auto' ? (isDark() ? 'dark' : 'light') : theme;
    const view = new cm.EditorView({
      doc: tab.doc,
      parent: host,
      extensions: [
        cm.basicSetup,
        // 关键：CM6 默认 .cm-editor 高度 auto（随内容撑高），导致 .cm-scroller 永不溢出 →
        // 无滚动条、滚轮无效。强制 height:100% 让 scroller 成为滚动容器，竖向/横向滚动条与滚轮才生效。
        // 注意：必须「始终生效」（不带 { dark:false }），否则深色主题下该主题不挂载、滚动依旧失效。
        cm.EditorView.theme({
          '&': { height: '100%', position: 'relative' },
          '.cm-scroller': { overflow: 'auto' },
        }),
        cm.keymap.of([{ key: 'Tab', run: tabHandler }]),
        cm.search(),
        // 注意：searchKeymap 是一组裸 KeyBinding（{key,run} 普通对象），
        // 必须用 keymap.of 包裹成合法扩展，否则 CM6 报 "Unrecognized extension value ([object Object])"。
        cm.keymap.of(cm.searchKeymap),
        langCpt.current.of(cmLang(cm, effectiveLang)),
        themeCpt.current.of(
          resolvedTheme === 'dark'
            ? [cm.oneDark, searchPanelDark]
            : [cm.lightTheme, cm.syntaxHighlighting(cm.defaultHighlightStyle), searchPanelLight],
        ),
        selCpt.current.of(selectionTheme(resolvedTheme === 'dark')),
        wrapCpt.current.of(wrap ? cm.EditorView.lineWrapping : []),
        cm.EditorView.updateListener.of((u: any) => {
          if (u.docChanged) {
            if (!suppressDirtyRef.current) onChangeRef.current(view.state.doc.toString());
            else onChangeRef.current(view.state.doc.toString());
          }
          const head = u.state.selection.main.head;
          const line = u.state.doc.lineAt(head);
          onCursorRef.current(line.number, head - line.from + 1);
        }),
      ],
    });
    viewRef.current = view;
    onViewReady(view);
    return () => { view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 主题切换
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const resolvedTheme = theme === 'auto' ? (isDark() ? 'dark' : 'light') : theme;
    const dark = resolvedTheme === 'dark';
    view.dispatch({
      effects: [
        themeCpt.current.reconfigure(
          dark ? cm.oneDark : [cm.lightTheme, cm.syntaxHighlighting(cm.defaultHighlightStyle)],
        ),
        selCpt.current.reconfigure(selectionTheme(dark)),
      ],
    });
  }, [theme, cm]);

  // 自动换行切换
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: wrapCpt.current.reconfigure(wrap ? cm.EditorView.lineWrapping : []) });
  }, [wrap, cm]);

  // 语言切换（用户手动选）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: langCpt.current.reconfigure(cmLang(cm, effectiveLang)) });
  }, [effectiveLang, cm]);

  return <div ref={ref} className="h-full w-full min-h-0 overflow-hidden text-left" />;
}

// ============ 跨组件共享：侧边栏 → 编辑器打开文件 ============
// 已迁移至 modules/shared.ts 的 ideShared 对象（FileExplorer 与 IdeEditor 独立渲染，靠它通信）
// 下方代码通过 ideShared.addFileTab / ideShared.projectRoot 访问。

// ============ 跨组件共享：当前打开的项目根目录（供 AI 编程关联，#12） ============
// 已迁移至 ideShared.projectRoot（由 FileExplorer 设置，此处通过 ideShared 读取）

// IdeEditor 与 IdeAgent 为相互独立的组件：IdeEditor 的写盘守卫需把「括号不平衡」警告推给 IdeAgent 的会话，用模块级桥接函数打通
let _agentWarnHandler: ((msg: string) => void) | null = null;
function setAgentWarnHandler(fn: ((msg: string) => void) | null) { _agentWarnHandler = fn; }
function agentWarn(msg: string) { _agentWarnHandler?.(msg); }

// ============ 主组件 ============
type Engine = 'loading' | 'cm' | 'error';

function IdeEditor() {
  const [engine, setEngine] = useState<Engine>('loading');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [cm, setCm] = useState<CM | null>(null);

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('未打开文件');
  const [savedFlash, setSavedFlash] = useState<boolean>(true);
  const [theme, setTheme] = useState<'auto' | 'dark' | 'light'>('auto');
  const [wrap, setWrap] = useState<boolean>(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [recentOpen, setRecentOpen] = useState(false);
  const [cursor, setCursor] = useState<{ line: number; col: number }>({ line: 1, col: 1 });

  // 多级嵌套：AI 编程（ai）是 IDE 的子插件，由 IDE 内部以「右侧对话抽屉」形式呈现，
  // 与编辑器并排（Cursor / Codex / Claude Code 风格），而非整面板切换。
  const [aiOpen, setAiOpen] = useState(true);
  const [aiWidth, setAiWidth] = useState(420);
  const [hasAi, setHasAi] = useState(false);

  // 当前打开的项目根（供 AI 编程关联，#12）
  const [projRoot, setProjRoot] = useState<string | null>(ideShared.projectRoot);

  // 每个子模块自己的设置（#13）：IDE 模块设置，localStorage 持久化
  const [ideSettings, setIdeSettings] = useState<IdeSettingsData>(loadIdeSettings);
  const [showIdeSettings, setShowIdeSettings] = useState(false);

  // 自主编辑（agent）模式的待审阅改动列表（由 IdeAgent 产出，IDE 主组件渲染审阅面板）
  const [agentReview, setAgentReview] = useState<AgentEdit[] | null>(null);
  const [agentOriginals, setAgentOriginals] = useState<Record<string, string>>({});
  const [agentVerdict, setAgentVerdict] = useState<string | null>(null);

  // 检测「用户部署的 AI」：读取全局模型档案，存在已填 Key 的档案即视为已部署
  const [aiProfiles, setAiProfiles] = useState<{ id: string; api_key?: string }[]>([]);
  const [aiActiveId, setAiActiveId] = useState<string | null>(null);
  const aiAvailable = aiProfiles.some((p) => p.api_key && p.api_key.trim());

  // 底部面板（问题/输出/调试/终端）：默认关闭，点击状态栏按钮展开
  const [bottomView, setBottomView] = useState<null | 'problems' | 'output' | 'debug' | 'terminal'>(null);
  const [bottomH, setBottomH] = useState(200);

  // LSP 诊断状态（伪 LSP：后端 spawn tsc/cargo check/pyright 一次性命令）
  // 对齐 lsp_client.rs::LspServerStatus 状态机：Starting → Connected / Error
  const [lspProblems, setLspProblems] = useState<Problem[]>([]);
  const [lspStatus, setLspStatus] = useState<{ loading: boolean; message: string; source: string; elapsedMs: number }>({ loading: false, message: '', source: '', elapsedMs: 0 });

  const viewRef = useRef<any>(null);
  const suppressDirty = useRef<boolean>(false);
  const tabsRef = useRef<Tab[]>([]);
  tabsRef.current = tabs;
  // recentRef 同步 recent 状态，供 ideShared.recentFiles（命令面板 MRU 排序）读取最新值
  const recentRef = useRef<string[]>([]);
  recentRef.current = recent;
  const activeTab = tabs.find((t) => t.id === activeId) || null;

  // 命令面板（Ctrl+P 文件快速打开 / Ctrl+Shift+P 命令模式）
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<'files' | 'commands'>('files');

  // 挂载时尝试加载 CodeMirror
  useEffect(() => {
    let alive = true;
    loadCM()
      .then((api) => { if (alive) { setCm(api); setEngine('cm'); } })
      .catch((e: Error) => { if (alive) { setErrorMsg(e.message); setEngine('error'); } });
    return () => { alive = false; };
  }, []);

  // 同步「AI 编程」子插件（ai）是否就绪：插件并行加载存在竞态，
  // 故初次检查 + 监听 plugin-registered/unregistered 动态更新。
  useEffect(() => {
    const sync = () => {
      const kids = registry && registry.getChildren ? registry.getChildren('ide') : [];
      setHasAi(kids.some((c: any) => c.id === 'ai'));
    };
    sync();
    const handler = () => sync();
    window.addEventListener('plugin-registered', handler);
    window.addEventListener('plugin-unregistered', handler);
    return () => {
      window.removeEventListener('plugin-registered', handler);
      window.removeEventListener('plugin-unregistered', handler);
    };
  }, []);

  // 监听「打开项目」事件，同步当前项目根（#12）
  useEffect(() => {
    const h = (e: Event) => setProjRoot((e as CustomEvent<string>).detail);
    window.addEventListener('ide-project-changed', h);
    return () => window.removeEventListener('ide-project-changed', h);
  }, []);

  // 启动读取全局模型档案，判断「用户部署的 AI」是否可用（#13）
  useEffect(() => {
    hostApi.invoke<{ profiles: { id: string; api_key?: string }[]; active: string | null }>('ai_get_profiles')
      .then((data) => {
        const list = data.profiles || [];
        setAiProfiles(list);
        const usable = list.filter((p) => p.api_key && p.api_key.trim());
        const act = (data.active && usable.some((p) => p.id === data.active))
          ? data.active
          : (usable[0] ? usable[0].id : null);
        setAiActiveId(act);
      })
      .catch(() => {});
  }, []);

  // 应用 IDE 模块设置（默认主题/自动换行）于加载时生效（#13）
  useEffect(() => {
    setTheme(ideSettings.defaultTheme);
    setWrap(ideSettings.autoWrap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 更新 IDE 设置：持久化 + 即时套用主题/换行（#13）
  const updateIdeSettings = useCallback((patch: Partial<IdeSettingsData>) => {
    setIdeSettings((prev) => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(IDE_SETTINGS_KEY, JSON.stringify(next)); } catch { /* 忽略 */ }
      if ('defaultTheme' in patch) setTheme(next.defaultTheme);
      if ('autoWrap' in patch) setWrap(next.autoWrap);
      return next;
    });
  }, []);

  // 自主编辑审阅：把改动写入磁盘 + 同步已打开的标签页
  const applyTabByPath = useCallback((path: string, doc: string) => {
    setTabs((prev) => prev.map((t) => (t.path && normEq(t.path, path) ? { ...t, doc, dirty: false } : t)));
  }, []);
  // 各 edit 当前状态同步到 ref，供处理器同步读取（规避 setState 异步导致提交时读到旧值）
  const agentReviewRef = useRef<AgentEdit[] | null>(null);
  const agentOriginalsRef = useRef<Record<string, string>>({});
  useEffect(() => { agentReviewRef.current = agentReview; }, [agentReview]);

  // 依据各 edit 的 status，从原始文件内容重新计算并写盘：保留=应用（删除红区），撤销=跳过（保留原红区）
  const commitEdits = useCallback(async (edits: AgentEdit[]) => {
    const orig = agentOriginalsRef.current;
    const byPath = new Map<string, AgentEdit[]>();
    for (const e of edits) {
      if (e.status === 'failed' || e.status === 'blocked') continue;
      if (!byPath.has(e.path)) byPath.set(e.path, []);
      byPath.get(e.path)!.push(e);
    }
    for (const [path, list] of byPath) {
      const isNewFile = list.some((e) => e.isNew);
      const hasKept = list.some((e) => e.status === 'kept');
      let c = orig[path] ?? '';
      let failedId: string | null = null;
      for (const e of list) {
        if (e.status !== 'kept') continue;
        if (e.isNew) { c = e.new; continue; }
        // 行级替换的「语义补全」：先精确匹配，失败再用空白归一化模糊定位（容许多/少空行、尾部空白等细微漂移）
        const replaced = fuzzyReplace(c, e.old, e.new);
        if (replaced === null) { failedId = e.id; break; }
        c = replaced;
      }
      if (failedId) {
        setAgentReview((prev) => prev ? prev.map((x) => x.id === failedId ? { ...x, status: 'failed', error: '未在当前文件中找到匹配内容（已尝试空白归一化模糊匹配），保存失败' } : x) : prev);
        continue;
      }
      if (!hasKept && isNewFile) {
        await hostApi.invoke('delete_file', { path }).catch(() => {});
        applyTabByPath(path, '');
        continue;
      }
      await hostApi.invoke('write_text_file', { path, content: c }).catch(() => {});
      applyTabByPath(path, c);
      // Lint Fix 轻量守卫：若原文件括号平衡而保存后不平衡，提示用户检查（避免错位导致的语法破坏）
      const before = orig[path] ?? '';
      if (bracketsBalanced(before) && !bracketsBalanced(c)) {
        agentWarn(`⚠ 文件 ${path} 保存后括号/花括号可能不匹配（原文件平衡、现文件不平衡），请检查是否因定位错位导致，必要时在编辑器中修复。`);
      }
    }
  }, [applyTabByPath]);

  // 收到 agent 产出的编辑列表：读取各文件原始内容（用于定位与回滚）
  const onAgentChanges = useCallback(async (edits: AgentEdit[], verdict?: string | null) => {
    const orig: Record<string, string> = {};
    for (const e of edits) {
      if (e.isNew) { orig[e.path] = ''; continue; }
      try { orig[e.path] = (await hostApi.invoke<string>('read_text_file', { path: e.path })).replace(/\r\n/g, '\n'); }
      catch { orig[e.path] = ''; }
    }
    agentOriginalsRef.current = orig;
    setAgentOriginals(orig);
    // 改动直接保留并即时落盘（用户要求：agent 改动应自动保存，而非弹窗待审阅后再手动「保留」）。
    // 被策略/信任/保护拦截（status: blocked）或定位失败（failed）的保留原状态，不误写。
    const applied = edits.map((e) =>
      e.status === 'blocked' || e.status === 'failed' ? e : { ...e, status: 'kept' as const },
    );
    agentReviewRef.current = applied;
    setAgentReview(applied);
    setAgentVerdict(verdict || null);
    await commitEdits(applied);
  }, [commitEdits]);

  // 保留=应用该处改动（删除红区）；撤销=放弃该处改动（保留原红区）。每次切换都即时重算写盘，支持来回切换
  const agentKeep = useCallback((e: AgentEdit) => {
    const cur = agentReviewRef.current; if (!cur) return;
    const next = cur.map((x) => x.id === e.id ? { ...x, status: 'kept' as const } : x);
    agentReviewRef.current = next; setAgentReview(next);
    commitEdits(next);
  }, [commitEdits]);
  const agentUndo = useCallback((e: AgentEdit) => {
    const cur = agentReviewRef.current; if (!cur) return;
    const next = cur.map((x) => x.id === e.id ? { ...x, status: 'undone' as const } : x);
    agentReviewRef.current = next; setAgentReview(next);
    commitEdits(next);
  }, [commitEdits]);
  const agentKeepAll = useCallback(async () => {
    const cur = agentReviewRef.current; if (!cur) return;
    const next = cur.map((x) => ({ ...x, status: 'kept' as const }));
    agentReviewRef.current = next; setAgentReview(next);
    await commitEdits(next);
  }, [commitEdits]);
  const agentUndoAll = useCallback(async () => {
    const cur = agentReviewRef.current; if (!cur) return;
    const next = cur.map((x) => ({ ...x, status: 'undone' as const }));
    agentReviewRef.current = next; setAgentReview(next);
    await commitEdits(next);
  }, [commitEdits]);
  // 完成：提交当前选择（保留的应用、撤销的跳过）并关闭面板
  const agentFinish = useCallback(async () => {
    const cur = agentReviewRef.current;
    if (cur) await commitEdits(cur);
    agentReviewRef.current = null;
    setAgentReview(null);
    setAgentVerdict(null);
  }, [commitEdits]);
  // 回滚本次会话（操作回滚）：把所有被改动文件恢复到 agent 运行前的原始快照，新建文件则删除，随后关闭面板
  const agentRollbackAll = useCallback(async () => {
    const orig = agentOriginalsRef.current;
    const edits = agentReviewRef.current || [];
    const newPaths = new Set(edits.filter((e) => e.isNew).map((e) => e.path));
    for (const [path, content] of Object.entries(orig)) {
      if (newPaths.has(path)) {
        await hostApi.invoke('delete_file', { path }).catch(() => {});
        applyTabByPath(path, '');
      } else {
        await hostApi.invoke('write_text_file', { path, content }).catch(() => {});
        applyTabByPath(path, content);
      }
    }
    agentReviewRef.current = null;
    setAgentReview(null);
    setAgentVerdict(null);
  }, [applyTabByPath]);

  // 降级提醒（仅提示一次/会话）：开启 AI 补全但无 AI 时（#13）
  const degradeReminded = useRef(false);
  const onTabDegrade = useCallback(() => {
    if (degradeReminded.current) return;
    degradeReminded.current = true;
    setStatus('⚠ 未检测到已部署的 AI：Tab 补全已降级为本地补全（可在 IDE 设置中关闭该选项）');
  }, []);

  // 复用侧边栏模块设置齿轮（#13）：宿主侧边栏齿轮点击会派发 module-settings-toggle 事件，
  // 此处监听并切换 IDE 独立设置页（不再在工具栏另设按钮）。
  useEffect(() => {
    const h = (e: Event) => {
      const detail = (e as CustomEvent<{ moduleId?: string }>).detail;
      if (detail && detail.moduleId && detail.moduleId !== 'ide') return;
      setShowIdeSettings((o) => !o);
    };
    window.addEventListener('module-settings-toggle', h);
    return () => window.removeEventListener('module-settings-toggle', h);
  }, []);

  const setTabDoc = useCallback((id: string, doc: string, dirty: boolean) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, doc, dirty } : t)));
  }, []);

  const onChange = useCallback((doc: string) => {
    if (!activeId) return;
    setTabs((prev) => prev.map((t) => (t.id === activeId ? { ...t, doc, dirty: true } : t)));
    setSavedFlash(false);
  }, [activeId]);

  // 注册侧边栏打开文件回调（迁移至 ideShared，供 FileExplorer/CommandPalette 调用）
  useEffect(() => {
    ideShared.addFileTab = (p, content) => {
      const id = 'f_' + Date.now().toString(36);
      setTabs((prev) => [...prev, { id, path: p, name: baseName(p), doc: content, lang: 'auto', dirty: false }]);
      setRecent((prev) => [p, ...prev.filter((x) => x !== p)].slice(0, 12));
      activateTab(id);
      setStatus('已打开：' + baseName(p));
    };
    // 暴露最近文件列表给命令面板 MRU 排序
    ideShared.recentFiles = () => recentRef.current;
    return () => { ideShared.addFileTab = null; ideShared.recentFiles = null; };
  }, []);

  const activateTab = useCallback((id: string) => {
    const next = tabsRef.current.find((t) => t.id === id);
    setActiveId(id);
    setSavedFlash(!next ? true : !next.dirty);
    setStatus(next ? (next.path ? '已打开：' + baseName(next.path) : '未命名文档') : '未打开文件');
  }, []);

  const openFile = useCallback(async () => {
    try {
      const files = await hostApi.invoke<string[]>('pick_file', {
        filters: [{ name: '代码/文本', extensions: ['js','ts','tsx','jsx','json','py','rs','go','html','htm','css','scss','md','txt','log','vue','c','cpp','java','sh','toml','yaml','yml'] }],
      });
      if (files && files.length > 0) {
        const p = files[0];
        const content = await hostApi.invoke<string>('read_text_file', { path: p });
        const id = 'f_' + Date.now().toString(36);
        const newTab: Tab = { id, path: p, name: baseName(p), doc: content, lang: 'auto', dirty: false };
        setTabs((prev) => [...prev, newTab]);
        setRecent((prev) => [p, ...prev.filter((x) => x !== p)].slice(0, 12));
        activateTab(id);
        setStatus('已打开：' + baseName(p));
      }
    } catch (e) {
      setStatus('打开失败：' + (e as Error).message);
    }
  }, [activateTab]);

  const doSave = useCallback(async (target: string, tab: Tab) => {
    const view = viewRef.current;
    const content = view ? view.state.doc.toString() : tab.doc;
    try {
      await hostApi.invoke('write_text_file', { path: target, content });
      setTabDoc(tab.id, content, false);
      setSavedFlash(true);
      setStatus('已保存：' + baseName(target));
    } catch (e) {
      setStatus('保存失败：' + (e as Error).message);
    }
  }, [setTabDoc]);

  const save = useCallback(() => {
    if (!activeTab) return;
    if (!activeTab.path) return saveAs();
    doSave(activeTab.path, activeTab);
  }, [activeTab, doSave]);

  const saveAs = useCallback(async () => {
    if (!activeTab) return;
    const defaultName = activeTab.path ? baseName(activeTab.path) : 'untitled.txt';
    try {
      const dest = await hostApi.invoke<string | null>('pick_save_file', { defaultName });
      if (dest) {
        await doSave(dest, activeTab);
        setTabs((prev) => prev.map((t) => (t.id === activeTab.id ? { ...t, path: dest, name: baseName(dest) } : t)));
      }
    } catch (e) {
      setStatus('另存为失败：' + (e as Error).message);
    }
  }, [activeTab, doSave]);

  const newDoc = useCallback(() => {
    const id = 'n_' + Date.now().toString(36);
    const t: Tab = { id, path: '', name: '未命名', doc: '', lang: 'plaintext', dirty: false };
    setTabs((prev) => [...prev, t]);
    activateTab(id);
    setStatus('新建文档');
  }, [activateTab]);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (activeId === id) {
        const fallback = next[Math.max(0, idx - 1)] || null;
        setActiveId(fallback ? fallback.id : null);
        setStatus(fallback ? (fallback.path ? '已打开：' + baseName(fallback.path) : '未命名文档') : '未打开文件');
      }
      return next;
    });
  }, [activeId]);

  const closeAllTabs = useCallback(() => {
    setTabs([]);
    setActiveId(null);
    setStatus('未打开文件');
    setSavedFlash(true);
  }, []);

  // AI 编程右侧常驻列拖拽调宽（所有 hook 之后、任何提前返回之前，保持 hooks 顺序稳定）
  const startAiResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = aiWidth;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(760, Math.max(320, startW + (startX - ev.clientX)));
      setAiWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [aiWidth]);

  // 底部面板拖拽调高
  const startBottomResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = bottomH;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(480, Math.max(120, startH + (ev.clientY - startY)));
      setBottomH(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [bottomH]);

  // 标签页条：用非被动原生 wheel 监听，在存在横向溢出时把纵向滚轮转为横向滚动，
  // 让「打开文件过多」时也能用滚轮浏览标签（配合 overflow-x-auto 的滚动条）。
  const tabScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = tabScrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth > el.clientWidth + 1) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [tabs.length]);

  // 全局快捷键：Ctrl/Cmd+P 命令面板、Ctrl/Cmd+Shift+P 命令模式、
  // Ctrl/Cmd+F 查找、Ctrl/Cmd+H 替换、Ctrl/Cmd+S 保存、Ctrl/Cmd+Shift+S 另存为
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      // Ctrl+P / Ctrl+Shift+P：命令面板（无需编辑器就绪，打开即可）
      if (k === 'p') {
        e.preventDefault();
        setPaletteMode(e.shiftKey ? 'commands' : 'files');
        setPaletteOpen(true);
        return;
      }
      const v = viewRef.current;
      if (!v || !cm) return;
      if (k === 'f') { e.preventDefault(); cm.openSearchPanel(v); }
      else if (k === 'h') { e.preventDefault(); cm.openReplacePanel(v); }
      else if (k === 's') { e.preventDefault(); if (e.shiftKey) saveAs(); else save(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cm, save, saveAs]);



  const aiChild = registry && registry.getChildren
    ? registry.getChildren('ide').find((c: any) => c.id === 'ai')
    : null;
  const AiComp = aiChild?.component as React.ComponentType<any> | undefined;

  const effectiveLang = activeTab ? (activeTab.lang === 'auto' ? (activeTab.path ? langFromPath(activeTab.path) : 'plaintext') : activeTab.lang) : 'plaintext';

  // 「问题」面板：当面板展开时，对当前激活文件做轻量诊断（#9）。仅在展开时计算，避免空耗。
  const problems = useMemo<Problem[]>(() => {
    if (bottomView !== 'problems' || !activeTab) return [];
    // 合并双源诊断：scanProblems（前端即时） + lspProblems（后端类型诊断）
    // LSP 诊断优先级更高（真实类型错误），scanProblems 作为通用静态检查补充
    const scan = scanProblems(activeTab.doc || '');
    return [...lspProblems, ...scan];
  }, [bottomView, activeTab?.doc, activeTab?.id, lspProblems]);

  // LSP 诊断触发：activeTab.path 变化时（1s 防抖）调用后端 lsp_diagnostics
  // 仅对有路径的文件触发（新建未保存文件无 path，跳过）
  useEffect(() => {
    if (!activeTab || !activeTab.path) {
      setLspProblems([]);
      setLspStatus({ loading: false, message: '', source: '', elapsedMs: 0 });
      return;
    }
    // 仅对支持的语言触发（ts/tsx/js/jsx/rs/py），其他语言跳过
    const ext = activeTab.path.split('.').pop()?.toLowerCase() || '';
    if (!['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'rs', 'py'].includes(ext)) {
      setLspProblems([]);
      setLspStatus({ loading: false, message: `.${ext} 文件不支持 LSP 诊断`, source: '', elapsedMs: 0 });
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLspStatus((s) => ({ ...s, loading: true }));
      try {
        const res: any = await hostApi.invoke<any>('lsp_diagnostics', {
          path: activeTab.path,
          projectRoot: ideShared.projectRoot || undefined,
        });
        if (cancelled) return;
        const diags: Problem[] = (res?.diagnostics || []).map((d: any) => ({
          line: d.line,
          column: d.character,
          severity: (d.severity === 'error' || d.severity === 'warning' || d.severity === 'info') ? d.severity : 'info',
          message: d.message,
          source: d.source,
          code: d.code,
        }));
        setLspProblems(diags);
        setLspStatus({
          loading: false,
          message: res?.message || '',
          source: res?.source || '',
          elapsedMs: res?.elapsed_ms || 0,
        });
      } catch (e: any) {
        if (cancelled) return;
        setLspProblems([]);
        setLspStatus({ loading: false, message: 'LSP 诊断失败：' + String(e), source: '', elapsedMs: 0 });
      }
    }, 1000); // 1s 防抖：避免快速切换 tab 时频繁触发
    return () => { cancelled = true; clearTimeout(timer); };
  }, [activeTab?.path, ideShared.projectRoot]);

  // 点击问题条目：将编辑器滚动并定位到对应行（仅滚动，不强行改写选区，稳定优先）
  const gotoProblem = useCallback((p: Problem) => {
    const view = viewRef.current;
    if (!cm || !view) return;
    const doc = view.state.doc;
    const lineNo = Math.min(Math.max(p.line, 1), doc.lines);
    const line = doc.line(lineNo);
    const pos = Math.min(line.from + (p.column - 1), line.to);
    view.dispatch({ effects: cm.EditorView.scrollIntoView(pos, { y: 'center' }) });
    view.focus();
  }, [cm]);


  // 命令面板：从路径打开文件（读内容 → ideShared.addFileTab 添加标签页）
  const openFileFromPalette = useCallback(async (p: string) => {
    try {
      const content = await hostApi.invoke<string>('read_text_file', { path: p });
      ideShared.addFileTab?.(p, content);
    } catch (e) {
      setStatus('打开失败：' + (e as Error).message);
    }
  }, []);

  // 命令面板命令列表（Ctrl+Shift+P 模式）
  const paletteCommands = useMemo<PaletteCommand[]>(() => [
    { id: 'new', label: '新建文件', run: newDoc },
    { id: 'open', label: '打开文件…', run: openFile },
    { id: 'save', label: '保存', shortcut: 'Ctrl+S', run: save },
    { id: 'saveAs', label: '另存为…', shortcut: 'Ctrl+Shift+S', run: saveAs },
    { id: 'recent', label: '最近打开的文件', run: () => setRecentOpen((o) => !o) },
    { id: 'theme-auto', label: '主题：自动', run: () => setTheme('auto') },
    { id: 'theme-light', label: '主题：浅色', run: () => setTheme('light') },
    { id: 'theme-dark', label: '主题：深色', run: () => setTheme('dark') },
    { id: 'wrap', label: '切换自动换行', run: () => setWrap((w) => !w) },
    { id: 'ai', label: '切换 AI 编程面板', run: () => setAiOpen((o) => !o) },
    { id: 'panel-problems', label: '面板：问题', run: () => setBottomView('problems') },
    { id: 'panel-output', label: '面板：输出', run: () => setBottomView('output') },
    { id: 'panel-debug', label: '面板：调试控制台', run: () => setBottomView('debug') },
    { id: 'panel-terminal', label: '面板：终端', run: () => setBottomView('terminal') },
    { id: 'panel-close', label: '关闭底部面板', run: () => setBottomView(null) },
    { id: 'settings', label: 'IDE 模块设置', run: () => setShowIdeSettings((o) => !o) },
  ], [newDoc, openFile, save, saveAs]);

  const toolbar = (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-200 dark:border-stone-700 bg-neutral-100 dark:bg-stone-800 text-sm flex-wrap">
      <button onClick={newDoc} className="btn-press px-2.5 py-1 rounded-lg bg-neutral-200/70 dark:bg-stone-700 text-neutral-700 dark:text-stone-200 hover:bg-neutral-300 dark:hover:bg-stone-600 transition-colors" title="新建">新建</button>
      <button onClick={openFile} className="btn-press px-2.5 py-1 rounded-lg text-white font-medium element-primary hover:bg-[var(--element-hover)] transition-colors">打开</button>
      <button onClick={save} className="btn-press px-2.5 py-1 rounded-lg bg-neutral-200/70 dark:bg-stone-700 text-neutral-700 dark:text-stone-200 hover:bg-neutral-300 dark:hover:bg-stone-600 transition-colors" title="保存 (Ctrl+S)">保存</button>
      <span className="w-px h-5 bg-neutral-300 dark:bg-stone-600 mx-0.5" />
      <div className="relative">
        <button onClick={() => setRecentOpen((o) => !o)} className="btn-press px-2.5 py-1 rounded-lg bg-neutral-200/70 dark:bg-stone-700 text-neutral-700 dark:text-stone-200 hover:bg-neutral-300 dark:hover:bg-stone-600 transition-colors" title="最近打开的文件">最近{recentOpen ? '▴' : '▾'}</button>
        {recentOpen && recent.length > 0 && (
          <div className="absolute z-30 mt-1 w-72 max-h-64 overflow-auto rounded-lg bg-white dark:bg-stone-800 border border-neutral-200 dark:border-stone-700 shadow-xl py-1">
            {recent.map((p) => (
              <button key={p} onClick={async () => {
                const content = await hostApi.invoke<string>('read_text_file', { path: p });
                const id = 'f_' + Date.now().toString(36);
                setTabs((prev) => [...prev, { id, path: p, name: baseName(p), doc: content, lang: 'auto', dirty: false }]);
                activateTab(id);
                setStatus('已打开：' + baseName(p));
                setRecentOpen(false);
              }} className="block w-full text-left px-3 py-1.5 text-xs text-neutral-700 dark:text-stone-300 hover:bg-neutral-100 dark:hover:bg-stone-700 truncate">{p}</button>
            ))}
          </div>
        )}
      </div>
      <span className="w-px h-5 bg-neutral-300 dark:bg-stone-600 mx-0.5" />
      <label className="text-neutral-500 dark:text-stone-400 text-xs">语言</label>
      <select value={activeTab ? activeTab.lang : 'plaintext'} onChange={(e) => {
        if (activeTab) setTabs((prev) => prev.map((t) => (t.id === activeTab.id ? { ...t, lang: e.target.value } : t)));
      }} className="bg-white dark:bg-stone-800 text-neutral-700 dark:text-stone-200 text-xs rounded px-2 py-1 border border-neutral-200 dark:border-stone-700 outline-none">
        {LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
      </select>
      <button onClick={() => setWrap((w) => !w)} className={`btn-press px-2.5 py-1 rounded-lg text-xs ${wrap ? 'element-primary text-white' : 'bg-neutral-200/70 dark:bg-stone-700 text-neutral-700 dark:text-stone-200 hover:bg-neutral-300 dark:hover:bg-stone-600'}`} title="自动换行（关掉后超长行出现横向滚动条）">自动换行</button>
      <button onClick={() => setTheme((t) => (t === 'auto' ? 'dark' : t === 'dark' ? 'light' : 'auto'))} className="btn-press px-2.5 py-1 rounded-lg bg-neutral-200/70 dark:bg-stone-700 text-neutral-700 dark:text-stone-200 hover:bg-neutral-300 dark:hover:bg-stone-600 transition-colors text-xs">
        {theme === 'auto' ? '跟随' : theme === 'dark' ? '深色' : '浅色'}
      </button>
      {hasAi && (
        <button onClick={() => setAiOpen((o) => !o)} className={`btn-press px-2.5 py-1 rounded-lg text-white text-xs font-medium ${aiOpen ? 'element-primary' : 'bg-neutral-700 dark:bg-stone-600 hover:bg-neutral-600 dark:hover:bg-stone-500'} transition-colors`} title="AI 编程（右侧常驻对话列，点击收起/展开）">{ideSettings.mode === 'agent' ? 'AI 代理' : 'AI 编程'}</button>
      )}
      <span className="flex-1" />
      <span className={`text-xs ${savedFlash ? 'text-emerald-500' : 'text-amber-500'}`}>{status}</span>
    </div>
  );

  // IDE 模块设置页（#13）：独立设置，区别于全局「茑萝」设置
  if (showIdeSettings) {
    return (
      <div className="flex-1 flex flex-col h-full w-full min-w-0 relative overflow-hidden bg-white dark:bg-stone-900 text-neutral-800 dark:text-stone-100">
        {toolbar}
        <IdeSettings
          settings={ideSettings}
          onChange={updateIdeSettings}
          onClose={() => setShowIdeSettings(false)}
          aiAvailable={aiAvailable}
        />
      </div>
    );
  }

  if (engine === 'error') {
    return (
      <div className="flex-1 flex flex-col h-full bg-white dark:bg-stone-900 text-neutral-800 dark:text-stone-100">
        <div className="px-4 py-3 border-b border-neutral-200 dark:border-stone-700 text-sm font-medium">IDE · 编辑器内核加载失败</div>
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-8 text-center">
          <div className="text-amber-500 text-sm">{errorMsg}</div>
          <pre className="text-left text-xs text-neutral-600 dark:text-stone-300 bg-neutral-100 dark:bg-stone-800 rounded-lg p-3 max-w-md overflow-auto">请完全重启应用（pnpm tauri dev）后重试</pre>
          <button onClick={() => { setEngine('loading'); cmPromise = null; loadCM().then((api) => { setCm(api); setEngine('cm'); }).catch((e: Error) => { setErrorMsg(e.message); setEngine('error'); }); }} className="btn-press px-4 py-1.5 rounded-lg text-white text-sm element-primary hover:bg-[var(--element-hover)] transition-colors">重试</button>
        </div>
      </div>
    );
  }

  if (engine === 'loading') {
    return (
      <div className="flex-1 flex flex-col h-full bg-white dark:bg-stone-900 text-neutral-800 dark:text-stone-100">
        {toolbar}
        <div className="flex-1 flex items-center justify-center text-neutral-400 dark:text-stone-500 text-sm">正在加载编辑器内核…</div>
      </div>
    );
  }

  return (
    <div className="relative flex-1 flex flex-col h-full w-full min-w-0 overflow-hidden bg-white dark:bg-stone-900 text-neutral-800 dark:text-stone-100">
      {toolbar}
      {/* 标签页：左侧可滚动标签区（支持滚轮/拖拽横向浏览） + 右侧常驻「关闭全部」按钮 */}
      {tabs.length > 0 && (
        <div className="flex items-stretch bg-neutral-100 dark:bg-stone-800 border-b border-neutral-200 dark:border-stone-700">
          <div
            ref={tabScrollRef}
            className="flex items-stretch overflow-x-auto flex-1 min-w-0"
          >
            {tabs.map((t) => (
              <div key={t.id}
                onClick={() => activateTab(t.id)}
                className={`group flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer border-r border-neutral-200 dark:border-stone-700/70 whitespace-nowrap shrink-0 ${t.id === activeId ? 'bg-white dark:bg-stone-900 text-neutral-800 dark:text-stone-100' : 'text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5'}`}>
                <span className={t.dirty ? 'w-2 h-2 rounded-full bg-amber-400' : 'w-2 h-2 rounded-full bg-transparent'} />
                <span className="max-w-40 truncate">{t.name}</span>
                <button onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                  className="text-neutral-400 dark:text-stone-500 hover:text-neutral-800 dark:hover:text-stone-100 hover:bg-black/10 dark:hover:bg-white/10 rounded w-4 h-4 flex items-center justify-center shrink-0" title="关闭">✕</button>
              </div>
            ))}
          </div>
          <button onClick={closeAllTabs}
            className="btn-press shrink-0 px-2.5 flex items-center gap-1 text-xs text-neutral-500 dark:text-stone-400 hover:text-neutral-800 dark:hover:text-stone-100 hover:bg-black/5 dark:hover:bg-white/5 border-l border-neutral-200 dark:border-stone-700"
            title="关闭全部标签页">
            <span className="text-sm leading-none">✕</span>
            <span>全部</span>
          </button>
        </div>
      )}
      {/* 编辑器 + AI 编程右侧常驻列：AI 独占右列（shrink-0 永不被挤走），编辑器 min-w-0 自适应 */}
      <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden">
        <div className="flex-1 h-full overflow-hidden min-w-0 min-h-0">
          {activeTab ? (
            <CmEditor
              key={activeTab.id}
              cm={cm!}
              tab={activeTab}
              theme={theme}
              wrap={wrap}
              onViewReady={(v) => { viewRef.current = v; }}
              onChange={onChange}
              onCursor={(line, col) => setCursor({ line, col })}
              suppressDirtyRef={suppressDirty}
              tabUseAi={ideSettings.tabUseAi}
              aiAvailable={aiAvailable}
              aiActiveId={aiActiveId}
              onDegrade={onTabDegrade}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-neutral-400 dark:text-stone-500 text-sm">打开文件或新建文档开始编辑</div>
          )}
        </div>
        {/* agent 模式：保持侧边 docked 列（需贴着编辑器上下文） */}
        {hasAi && aiOpen && ideSettings.mode === 'agent' && (
          <div
            className="relative shrink-0 h-full flex flex-col border-l border-neutral-200 dark:border-stone-700 bg-white dark:bg-stone-900"
            style={{ width: aiWidth, minWidth: 320 }}
          >
            {/* 拖拽调宽手柄 */}
            <div
              onMouseDown={startAiResize}
              title="拖动调整宽度"
              className="absolute left-0 top-0 h-full w-1.5 -ml-0.5 cursor-col-resize z-20 hover:bg-[var(--element-bg)]/40 transition-colors"
            />
            <div className="flex-1 min-h-0 overflow-hidden">
              {AiComp ? (
                <IdeAgent projectRoot={projRoot} activeProfileId={aiActiveId} onProfileChange={setAiActiveId} onChanges={onAgentChanges} />
              ) : (
                <div className="flex-1 flex items-center justify-center text-neutral-400 dark:text-stone-500 text-sm">AI 编程模块未加载</div>
              )}
            </div>
          </div>
        )}

        {/* chat 模式（normal）：非覆盖式弹窗，从 IDE 窗口右下角浮出，不遮挡编辑器 */}
        {hasAi && aiOpen && ideSettings.mode !== 'agent' && (
          <div
            className="absolute bottom-4 right-4 z-30 flex flex-col bg-white dark:bg-stone-900 border border-neutral-200 dark:border-stone-700 rounded-2xl shadow-2xl overflow-hidden"
            style={{ width: 420, height: 460, maxHeight: 'calc(100% - 32px)' }}
          >
            {AiComp ? (
              <AiComp docked onClose={() => setAiOpen(false)} projectRoot={projRoot} />
            ) : (
              <div className="flex-1 flex items-center justify-center text-neutral-400 dark:text-stone-500 text-sm">AI 编程模块未加载</div>
            )}
          </div>
        )}
      </div>
      {/* 底部面板：问题 / 输出 / 调试 / 终端（点击状态栏按钮展开，可拖拽调高、可关闭，#2） */}
      {bottomView && (
        <div className="shrink-0 border-t border-neutral-200 dark:border-stone-700 bg-white dark:bg-stone-900 flex flex-col" style={{ height: bottomH }}>
          <div className="flex items-center gap-1 px-2 py-1 border-b border-neutral-200 dark:border-stone-700 bg-neutral-100 dark:bg-stone-800 text-xs shrink-0">
            {(['problems', 'output', 'debug', 'terminal'] as const).map((v) => (
              <button key={v} onClick={() => setBottomView(v)} className={`btn-press px-2 py-0.5 rounded ${bottomView === v ? 'element-muted text-[var(--element-bg)]' : 'text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5'}`}>{BOTTOM_LABELS[v]}</button>
            ))}
            <span className="flex-1" />
            <div onMouseDown={startBottomResize} title="拖动调整高度" className="cursor-row-resize px-2 text-neutral-400 hover:text-neutral-700 dark:hover:text-stone-200 select-none">⠿</div>
            <button onClick={() => setBottomView(null)} className="btn-press px-2 py-0.5 rounded text-neutral-400 hover:text-red-500" title="关闭面板">✕</button>
          </div>
          <div className="flex-1 overflow-auto min-h-0 text-xs text-neutral-700 dark:text-stone-300 p-3 font-mono whitespace-pre-wrap">
            {bottomView === 'problems' && (
              <>
                {/* LSP 诊断状态条：显示加载状态 / 诊断源 / 耗时 */}
                {activeTab?.path && (
                  <div className="mb-2 pb-1 border-b border-neutral-200 dark:border-stone-700 text-[10px] text-neutral-500 dark:text-stone-400 flex items-center gap-2">
                    {lspStatus.loading ? (
                      <span className="text-sky-500">⟳ LSP 诊断中…</span>
                    ) : lspStatus.source ? (
                      <span>
                        <span className="text-cyan-600 dark:text-cyan-400">{lspStatus.source}</span>
                        {lspStatus.message ? ` · ${lspStatus.message}` : ''}
                        {lspStatus.elapsedMs > 0 ? ` · ${lspStatus.elapsedMs}ms` : ''}
                      </span>
                    ) : lspStatus.message ? (
                      <span>{lspStatus.message}</span>
                    ) : null}
                  </div>
                )}
                {problems.length === 0
                  ? <div className="text-emerald-600 dark:text-emerald-400">✓ 当前工作区没有检测到问题</div>
                  : (
                    <div className="space-y-0.5">
                      {problems.map((p, i) => (
                        <button key={i} onClick={() => gotoProblem(p)} title={p.code ? `${p.source || ''} · ${p.code}` : (p.source || '点击定位到该行')}
                          className="block w-full text-left px-1 py-0.5 rounded hover:bg-black/5 dark:hover:bg-white/5 flex items-start gap-2">
                          <span className={`shrink-0 ${p.severity === 'error' ? 'text-red-500' : p.severity === 'warning' ? 'text-amber-500' : 'text-sky-500'}`}>
                            {p.severity === 'error' ? '✕' : p.severity === 'warning' ? '⚠' : 'ℹ'}
                          </span>
                          <span className="text-neutral-400 dark:text-stone-500 shrink-0 w-20">{p.line}:{p.column}</span>
                          {/* 诊断来源 chip：scan=灰、tsc/cargo/pyright=青（LSP 类型诊断更醒目） */}
                          {p.source && p.source !== 'scan' && (
                            <span className="shrink-0 px-1 rounded bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-300 text-[9px]">
                              {p.source}{p.code ? `·${p.code}` : ''}
                            </span>
                          )}
                          <span className="flex-1 min-w-0 truncate">{p.message}</span>
                        </button>
                      ))}
                    </div>
                  )
                }
              </>
            )}
            {bottomView === 'output' && <div className="text-neutral-500 dark:text-stone-400">（暂无输出）</div>}
            {bottomView === 'debug' && <div className="text-neutral-500 dark:text-stone-400">（调试控制台：未启动调试会话）</div>}
            {bottomView === 'terminal' && <IdePtyTerminal />}
          </div>
        </div>
      )}
      {/* 状态栏（绿条）：左侧四个面板按钮（问题/输出/调试/终端），右侧保留语言/光标等信息 */}
      <div className="flex items-center gap-3 px-4 py-1 text-white text-[11px] element-primary min-w-0 overflow-hidden">
        {(['problems', 'output', 'debug', 'terminal'] as const).map((v) => {
          // 问题按钮显示 error/warning 计数 badge（仅 problems 显示）
          const badge = v === 'problems' ? (() => {
            const errs = problems.filter((p) => p.severity === 'error').length;
            const warns = problems.filter((p) => p.severity === 'warning').length;
            return errs + warns;
          })() : 0;
          return (
            <button key={v} onClick={() => setBottomView(bottomView === v ? null : v)} className={`btn-press px-1.5 py-0.5 rounded shrink-0 flex items-center gap-1 ${bottomView === v ? 'bg-white/25' : 'hover:bg-white/15'}`} title={BOTTOM_LABELS[v]}>
              {BOTTOM_LABELS[v]}
              {badge > 0 && (
                <span className={`px-1 rounded text-[9px] ${problems.some((p) => p.severity === 'error') ? 'bg-red-500/80' : 'bg-amber-500/80'}`}>{badge}</span>
              )}
            </button>
          );
        })}
        <span className="flex-1 min-w-0" />
        <span className="shrink-0">{effectiveLang.toUpperCase()}</span>
        <span className="shrink-0">UTF-8</span>
        <span className="shrink-0">行 {cursor.line}，列 {cursor.col}</span>
        <span className="shrink-0">{savedFlash ? '已保存' : '未保存'}</span>
      </div>
      {/* 自主编辑审阅面板：列出本次 AI 改动，逐文件保留/撤销，或一键全部 */}
      {agentReview && (
        <AgentReviewOverlay
          changes={agentReview}
          originals={agentOriginals}
          verdict={agentVerdict}
          onKeep={agentKeep}
          onUndo={agentUndo}
          onKeepAll={agentKeepAll}
          onUndoAll={agentUndoAll}
          onFinish={agentFinish}
          onRollback={agentRollbackAll}
        />
      )}
      {/* 命令面板 overlay：Ctrl+P 文件快速打开 / Ctrl+Shift+P 命令模式 / # 内容搜索 */}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        root={projRoot}
        onOpenFile={openFileFromPalette}
        commands={paletteCommands}
        initialMode={paletteMode}
      />
    </div>
  );
}

// ============ IDE 模块设置（#13）：每个子模块各自独立设置，区别于全局「茑萝」 ============
interface IdeSettingsData {
  tabUseAi: boolean;                          // Tab 补全是否使用用户部署的 AI
  autoWrap: boolean;                          // 默认自动换行
  defaultTheme: 'auto' | 'light' | 'dark';    // 默认主题
  mode: 'normal' | 'agent';                   // AI 模式：普通对话 / 自主编辑
}
const IDE_SETTINGS_KEY = 'ide_settings';
const defaultIdeSettings: IdeSettingsData = { tabUseAi: false, autoWrap: false, defaultTheme: 'auto', mode: 'normal' };
function loadIdeSettings(): IdeSettingsData {
  try {
    const raw = localStorage.getItem(IDE_SETTINGS_KEY);
    if (raw) return { ...defaultIdeSettings, ...JSON.parse(raw) };
  } catch { /* 忽略 */ }
  return defaultIdeSettings;
}

// 轻量开关（宿主未暴露 Switch，自绘一个切换）
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ${checked ? 'bg-[var(--element-color-raw)]' : 'bg-neutral-300 dark:bg-stone-600'}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : ''}`} />
    </button>
  );
}

const HostUI = (window as any).__HOST_UI__ || {};
const HostModuleSettingsPanel = HostUI.ModuleSettingsPanel as React.ComponentType<any> | undefined;

// ============ MCP 服务器配置面板 ============
// 对齐 claw-code-main/runtime/src/mcp_client.rs::McpClientBootstrap：
// 用户配置 stdio 命令（如 npx -y @modelcontextprotocol/server-filesystem /path），
// 后端在 agent 调用时 spawn → initialize → tools/list → tools/call → kill。
interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}
interface McpTool {
  name: string;
  description?: string;
  input_schema?: any;
}
function McpSettingsSection() {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [toolsCache, setToolsCache] = useState<Record<string, { tools: McpTool[]; ts: number; error?: string }>>({});
  const [editing, setEditing] = useState<Partial<McpServerConfig> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res: any = await hostApi.invoke<any>('mcp_list_servers');
      setServers(res?.servers || []);
    } catch { /* 忽略 */ }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const saveServer = async (s: McpServerConfig) => {
    setLoading(true);
    try {
      const res: any = await hostApi.invoke<any>('mcp_save_server', { server: s });
      setServers(res?.servers || []);
      setEditing(null);
    } catch (e) { alert('保存失败：' + String(e)); }
    setLoading(false);
  };
  const removeServer = async (id: string) => {
    if (!confirm('删除此 MCP 服务器？')) return;
    setLoading(true);
    try {
      const res: any = await hostApi.invoke<any>('mcp_remove_server', { serverId: id });
      setServers(res?.servers || []);
      setToolsCache((prev) => { const n = { ...prev }; delete n[id]; return n; });
    } catch (e) { alert('删除失败：' + String(e)); }
    setLoading(false);
  };
  const listTools = async (id: string) => {
    setLoading(true);
    try {
      const tools: any = await hostApi.invoke<any>('mcp_list_tools', { serverId: id });
      setToolsCache((prev) => ({ ...prev, [id]: { tools: tools || [], ts: Date.now() } }));
    } catch (e) {
      setToolsCache((prev) => ({ ...prev, [id]: { tools: [], ts: Date.now(), error: String(e) } }));
    }
    setLoading(false);
  };

  const card = 'bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 divide-y divide-neutral-200/50 dark:divide-stone-700/50 overflow-hidden';
  const labelCls = 'text-sm font-medium text-neutral-700 dark:text-stone-200 block';
  const inputCls = 'w-full bg-white dark:bg-stone-900/50 text-neutral-700 dark:text-stone-200 text-sm rounded-lg px-3 py-2 border border-neutral-200 dark:border-stone-700 outline-none focus:border-cyan-400 dark:focus:border-cyan-600';

  return (
    <section>
      <h3 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3 flex items-center gap-2">
        MCP 服务器
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-300">扩展工具</span>
      </h3>
      <div className={card}>
        <div className="p-4">
          <p className="text-xs text-neutral-500 dark:text-stone-400 mb-3">
            配置 stdio 模式的 MCP 服务器，agent 会自动获得这些工具（如 filesystem / github / sqlite）。
            <a href="https://github.com/modelcontextprotocol/servers" target="_blank" rel="noreferrer" className="text-cyan-600 dark:text-cyan-400 ml-1 hover:underline">查看官方服务器列表 ↗</a>
          </p>

          {/* 已配置的服务器列表 */}
          {servers.length > 0 && (
            <div className="space-y-2 mb-3">
              {servers.map((s) => {
                const tc = toolsCache[s.id];
                return (
                  <div key={s.id} className="rounded-lg border border-neutral-200 dark:border-stone-700 p-3 text-xs">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`w-2 h-2 rounded-full ${s.enabled ? 'bg-emerald-500' : 'bg-neutral-400'}`} />
                      <span className="font-medium text-neutral-800 dark:text-stone-100">{s.name}</span>
                      <span className="text-neutral-400 dark:text-stone-500">· {s.id}</span>
                      <span className="flex-1" />
                      <button onClick={() => listTools(s.id)} disabled={loading} className="btn-press px-2 py-0.5 rounded text-cyan-600 dark:text-cyan-400 hover:bg-cyan-50 dark:hover:bg-cyan-900/30 disabled:opacity-50" title="列出该服务器提供的工具">工具</button>
                      <button onClick={() => setEditing({ ...s })} disabled={loading} className="btn-press px-2 py-0.5 rounded text-neutral-500 hover:bg-black/5 dark:hover:bg-white/5">编辑</button>
                      <button onClick={() => removeServer(s.id)} disabled={loading} className="btn-press px-2 py-0.5 rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30">删除</button>
                    </div>
                    <div className="text-neutral-500 dark:text-stone-400 font-mono break-all">{s.command} {s.args.join(' ')}</div>
                    {tc?.error && <div className="mt-1 text-red-500">⚠ {tc.error}</div>}
                    {tc && !tc.error && tc.tools.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {tc.tools.map((t) => (
                          <span key={t.name} title={t.description} className="px-1.5 py-0.5 rounded bg-cyan-50 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300 text-[10px]">{t.name}</span>
                        ))}
                      </div>
                    )}
                    {tc && !tc.error && tc.tools.length === 0 && <div className="mt-1 text-neutral-400">（无工具）</div>}
                  </div>
                );
              })}
            </div>
          )}

          {/* 添加/编辑表单 */}
          {editing ? (
            <div className="rounded-lg border border-cyan-300 dark:border-cyan-700 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-neutral-700 dark:text-stone-200">{editing.id ? '编辑' : '添加'} MCP 服务器</span>
                <button onClick={() => setEditing(null)} className="text-neutral-400 hover:text-red-500">✕</button>
              </div>
              <div>
                <label className={labelCls}>ID（唯一标识，如 filesystem）</label>
                <input className={inputCls} value={editing.id || ''} onChange={(e) => setEditing({ ...editing, id: e.target.value })} placeholder="filesystem" disabled={!!servers.find((s) => s.id === editing.id)} />
              </div>
              <div>
                <label className={labelCls}>显示名</label>
                <input className={inputCls} value={editing.name || ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Filesystem MCP" />
              </div>
              <div>
                <label className={labelCls}>命令（可执行文件）</label>
                <input className={inputCls} value={editing.command || ''} onChange={(e) => setEditing({ ...editing, command: e.target.value })} placeholder="npx" />
              </div>
              <div>
                <label className={labelCls}>参数（空格分隔）</label>
                <input className={inputCls} value={(editing.args || []).join(' ')} onChange={(e) => setEditing({ ...editing, args: e.target.value.split(/\s+/).filter(Boolean) })} placeholder="-y @modelcontextprotocol/server-filesystem /path/to/dir" />
              </div>
              <div>
                <label className={labelCls}>环境变量（KEY=VALUE，每行一个，可选）</label>
                <textarea className={inputCls + ' font-mono'} rows={2} value={Object.entries(editing.env || {}).map(([k, v]) => `${k}=${v}`).join('\n')} onChange={(e) => {
                  const env: Record<string, string> = {};
                  e.target.value.split('\n').forEach((line) => {
                    const eq = line.indexOf('=');
                    if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1);
                  });
                  setEditing({ ...editing, env });
                }} placeholder={'API_KEY=xxx'} />
              </div>
              <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-stone-300">
                <input type="checkbox" checked={editing.enabled !== false} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} />
                启用
              </label>
              <button
                onClick={() => saveServer({
                  id: editing.id || ('mcp_' + Date.now().toString(36)),
                  name: editing.name || editing.id || 'MCP Server',
                  command: editing.command || '',
                  args: editing.args || [],
                  env: editing.env || {},
                  enabled: editing.enabled !== false,
                })}
                disabled={loading || !editing.command}
                className="btn-press w-full px-3 py-2 rounded-lg text-white text-sm font-medium element-primary disabled:opacity-50"
              >
                {loading ? '保存中…' : '保存'}
              </button>
            </div>
          ) : (
            <button onClick={() => setEditing({ id: '', name: '', command: '', args: [], env: {}, enabled: true })} disabled={loading}
              className="btn-press w-full px-3 py-2 rounded-lg border border-dashed border-neutral-300 dark:border-stone-600 text-neutral-500 dark:text-stone-400 hover:border-cyan-400 hover:text-cyan-600 dark:hover:text-cyan-400 text-sm">
              + 添加 MCP 服务器
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function IdeSettings({
  settings, onChange, onClose, aiAvailable,
}: {
  settings: IdeSettingsData;
  onChange: (patch: Partial<IdeSettingsData>) => void;
  onClose: () => void;
  aiAvailable: boolean;
}) {
  const card = 'bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 divide-y divide-neutral-200/50 dark:divide-stone-700/50 overflow-hidden';
  const labelCls = 'text-sm font-medium text-neutral-700 dark:text-stone-200 block';
  const subCls = 'text-xs text-neutral-500 dark:text-stone-400 mt-0.5';
  const body = (
    <div className="space-y-5">
      <section>
        <h3 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3">Tab 补全</h3>
        <div className={card}>
          <div className="flex justify-between items-center p-4">
            <div>
              <span className={labelCls}>用 AI 补全</span>
              <p className={subCls}>Tab 键使用你部署的 AI 续写代码；未部署 AI 时自动降级为本地补全。</p>
            </div>
            <Toggle checked={settings.tabUseAi} onChange={(v) => onChange({ tabUseAi: v })} />
          </div>
          {settings.tabUseAi && !aiAvailable && (
            <div className="p-4 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400 bg-amber-500/10">
              ⚠ 未检测到已部署的 AI（请到「全局设置 → 模型」添加模型档案并填写 API Key）。Tab 补全将自动降级为本地补全。
            </div>
          )}
        </div>
      </section>

      <section>
        <h3 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3">编辑器默认</h3>
        <div className={card}>
          <div className="flex justify-between items-center p-4">
            <div>
              <span className={labelCls}>默认自动换行</span>
              <p className={subCls}>打开文件时是否默认开启自动换行。</p>
            </div>
            <Toggle checked={settings.autoWrap} onChange={(v) => onChange({ autoWrap: v })} />
          </div>
          <div className="flex justify-between items-center p-4">
            <div>
              <span className={labelCls}>默认主题</span>
              <p className={subCls}>打开 IDE 时使用的主题。</p>
            </div>
            <select
              value={settings.defaultTheme}
              onChange={(e) => onChange({ defaultTheme: e.target.value as IdeSettingsData['defaultTheme'] })}
              className="bg-white dark:bg-stone-800 text-neutral-700 dark:text-stone-200 text-xs rounded px-2 py-1 border border-neutral-200 dark:border-stone-700 outline-none"
            >
              <option value="auto">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </div>
        </div>
      </section>

      <section>
        <h3 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3">AI 模式</h3>
        <div className={card}>
          <div className="p-4">
            <div className="flex gap-2">
              <button onClick={() => onChange({ mode: 'normal' })}
                className={`btn-press flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${settings.mode === 'normal' ? 'element-primary text-white' : 'bg-neutral-200/70 dark:bg-stone-700 text-neutral-700 dark:text-stone-200 hover:bg-neutral-300 dark:hover:bg-stone-600'}`}>
                普通对话
              </button>
              <button onClick={() => onChange({ mode: 'agent' })}
                className={`btn-press flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${settings.mode === 'agent' ? 'element-primary text-white' : 'bg-neutral-200/70 dark:bg-stone-700 text-neutral-700 dark:text-stone-200 hover:bg-neutral-300 dark:hover:bg-stone-600'}`}>
                自主编辑
              </button>
            </div>
            <p className={subCls + ' mt-2'}>
              {settings.mode === 'agent'
                ? '自主编辑：AI 会自行读取并修改项目文件，结束后列出改动供你逐文件保留或撤销。建议先在左侧打开项目文件夹。'
                : '普通对话：AI 作为结对编程助手，仅回复建议，不直接改动文件。'}
            </p>
          </div>
        </div>
      </section>

      <McpSettingsSection />
    </div>
  );
  if (HostModuleSettingsPanel) {
    return (
      <HostModuleSettingsPanel title="IDE" icon={null} onClose={onClose}>
        {body}
      </HostModuleSettingsPanel>
    );
  }
  // 兜底：宿主未暴露设置面板时直接渲染
  return (
    <div className="flex-1 h-full overflow-y-auto p-6">
      <div className="max-w-lg mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-neutral-800 dark:text-stone-100">IDE 设置</h2>
          <button onClick={onClose} className="btn-press w-8 h-8 flex items-center justify-center rounded-lg text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-300 hover:bg-black/5 dark:hover:bg-white/5">✕</button>
        </div>
        {body}
      </div>
    </div>
  );
}

// ============ 自主编辑（agent）模式组件 ============
// 交互：用户输入自然语言指令 → 进入工具调用循环（ReAct 式）：
//   AI 回复中包含 <read>/<write> 指令时，前端读取/记录文件，并把结果回填后继续追问，
//   直到 AI 输出 <done/> 或不再产生指令。结束后把记录到的写入汇总成「待审阅改动」交给 IDE 主组件。
type AgentMsg = { id: string; role: 'user' | 'assistant' | 'tool'; content: string; streaming?: boolean; error?: boolean };
// 浮岛转发来的对话消息（与浮岛 aideMessages 对齐：仅 user/assistant，无 system/tool）
type ChatMessage = { role: 'user' | 'assistant'; content: string };

function IdeAgent({
  projectRoot, activeProfileId, onProfileChange, onChanges,
}: {
  projectRoot?: string | null;
  activeProfileId?: string | null;
  onProfileChange?: (id: string) => void;
  onChanges: (changes: AgentEdit[], verdict?: string | null) => void;
}) {
  const [conv, setConv] = useState<AgentMsg[]>([]);
  useEffect(() => {
    setAgentWarnHandler((msg) => setConv((prev) => [...prev, { id: 'w_' + Date.now().toString(36), role: 'assistant', content: msg }]));
    return () => setAgentWarnHandler(null);
  }, []);
  // convRef / statsRef: 镜像 conv / agentStats 的最新值，供 useCallback 内读取（避免依赖频繁变化）
  const convRef = useRef<AgentMsg[]>([]);
  useEffect(() => { convRef.current = conv; }, [conv]);
  const statsRef = useRef<any>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [, setPlanChips] = useState<string[]>([]);
  // 结构化计划模式（阶段二增强）：从 planMode.tsx 导入，支持 <plan><step> 解析 + 用户确认流程
  const [planState, setPlanState] = useState<PlanState>(EMPTY_PLAN);
  // 模型选择（与普通对话面板一致，复用全局模型档案）
  const [profiles, setProfiles] = useState<{ id: string; name?: string; model?: string; base_url?: string; api_key?: string; thinking?: boolean | null }[]>([]);
  const [modelOpen, setModelOpen] = useState(false);

  const historyRef = useRef<{ role: string; content: string }[]>([]);
  const bufRef = useRef('');
  const assistantIdRef = useRef<string | null>(null);
  const reqRef = useRef<string | null>(null);
  const handlersRef = useRef<{ onDelta: () => void; onDone: (err?: string, usage?: any) => void } | null>(null);
  // 浮岛「AI 编程」agent 桥：当前请求 requestId + 多轮累积的已清洗文本（回传浮岛用）
  const capsuleAgentReqRef = useRef<string | null>(null);
  const agentRunCleanedRef = useRef<string>('');
  const cancelRef = useRef(false);
  const resolveRef = useRef<(() => void) | null>(null);
  const errRef = useRef<string | null>(null);

  // 会话持久化状态（对齐 session.rs::Session + task_registry.rs::Task）
  // currentSessionId: null=新会话未保存；非 null=已绑定到某持久化会话（恢复/分叉载入或首次保存后）
  // sessions: 当前项目的会话索引列表（按 ts 降序），用于下拉面板显示
  // historyOpen: 历史下拉面板开关
  // pendingEditsRef: 保存 runAgent 内部的 pendingEdits 引用，供会话保存时读取
  const currentSessionIdRef = useRef<string | null>(null);
  const pendingEditsRef = useRef<AgentEdit[]>([]);
  const [sessions, setSessions] = useState<SessionIndexEntry[]>([]);
  // 当前激活会话 id（响应式，供页头下拉框高亮当前会话）
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // 刷新会话列表（每次 projectRoot 变化或保存/删除后调用）
  const refreshSessions = useCallback(() => {
    if (projectRoot) setSessions(listSessionsForProject(projectRoot));
    else setSessions([]);
  }, [projectRoot]);
  useEffect(() => { refreshSessions(); }, [refreshSessions]);
  // 保存当前会话（手动或自动）：捕获 historyRef + conv + pendingEdits + stats
  const saveCurrentSession = useCallback((opts?: { branchName?: string; parentSessionId?: string }) => {
    if (!projectRoot) return;
    const msgs = historyRef.current;
    if (msgs.length === 0) return; // 空会话不保存
    // 取第一条 user 消息作为 firstPrompt（截断 80 字）
    const firstUser = msgs.find((m) => m.role === 'user');
    const firstPrompt = (firstUser?.content || '(空会话)').replace(/\s+/g, ' ').slice(0, 80);
    // 复用现有 sessionId 或生成新 id
    let sid = currentSessionIdRef.current;
    if (!sid) {
      sid = 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      currentSessionIdRef.current = sid;
    }
    const sess: PersistedSession = {
      id: sid,
      ts: Date.now(),
      projectRoot,
      firstPrompt,
      messages: msgs,
      conv: convRef.current,
      edits: pendingEditsRef.current,
      stats: {
        totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0,
        totalShells: 0, totalEdits: 0, totalReads: 0, rounds: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0, cacheHits: 0, cacheMisses: 0,
      },
      branchName: opts?.branchName,
      parentSessionId: opts?.parentSessionId,
    };
    // 用最新 agentStats 填充（通过 ref 拿到最新值）
    statsRef.current && Object.assign(sess.stats, statsRef.current);
    savePersistedSession(sess);
    currentSessionIdRef.current = sess.id;
    setCurrentSessionId(sess.id);
    refreshSessions();
  }, [projectRoot, refreshSessions]);
  // 恢复会话：载入 historyRef + conv + pendingEdits + stats
  const restoreSession = useCallback((id: string) => {
    const sess = loadPersistedSession(id);
    if (!sess) return;
    historyRef.current = sess.messages.slice();
    convRef.current = sess.conv.slice();
    pendingEditsRef.current = sess.edits.slice();
    currentSessionIdRef.current = sess.id;
    setCurrentSessionId(sess.id);
    // 恢复 conv 显示（用 ref 中的副本，避免 setConv 异步导致显示滞后）
    setConv(sess.conv.slice());
    setPlanChips(sess.edits.map((e) => e.path));
    if (sess.stats) {
      setAgentStats((s) => ({
        ...s,
        totalInputTokens: sess.stats.totalInputTokens || 0,
        totalOutputTokens: sess.stats.totalOutputTokens || 0,
        totalCost: sess.stats.totalCost || 0,
        totalShells: sess.stats.totalShells || 0,
        totalEdits: sess.stats.totalEdits || 0,
        totalReads: sess.stats.totalReads || 0,
        rounds: sess.stats.rounds || 0,
        cacheReadTokens: sess.stats.cacheReadTokens || 0,
        cacheCreationTokens: sess.stats.cacheCreationTokens || 0,
        cacheHits: sess.stats.cacheHits || 0,
        cacheMisses: sess.stats.cacheMisses || 0,
      }));
    }
    setHistoryOpen(false);
    setConv((prev) => [...prev, { id: 'r_' + Date.now().toString(36), role: 'tool', content: `📚 已恢复会话（${new Date(sess.ts).toLocaleString()}，${sess.messages.length} 条消息，${sess.edits.length} 条改动）` }]);
  }, []);
  // 分叉会话：载入父会话 history，但生成新 sessionId + parentSessionId
  const forkSession = useCallback((id: string) => {
    const sess = loadPersistedSession(id);
    if (!sess) return;
    historyRef.current = sess.messages.slice();
    convRef.current = sess.conv.slice();
    pendingEditsRef.current = sess.edits.slice();
    // 生成新 sessionId（分叉点）
    const newSid = 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    currentSessionIdRef.current = newSid;
    setCurrentSessionId(newSid);
    const branchName = `fork-${new Date().toLocaleString()}`;
    setConv(sess.conv.slice());
    setPlanChips(sess.edits.map((e) => e.path));
    setHistoryOpen(false);
    setConv((prev) => [...prev, { id: 'f_' + Date.now().toString(36), role: 'tool', content: `🌿 已分叉会话（父: ${sess.firstPrompt.slice(0, 40)}...）\n分叉名: ${branchName}\n可继续对话，分叉会话将独立保存。` }]);
    // 立即保存分叉会话（带 parentSessionId）
    savePersistedSession({
      id: newSid, ts: Date.now(), projectRoot: sess.projectRoot,
      firstPrompt: sess.firstPrompt + ' [fork]',
      messages: sess.messages, conv: sess.conv, edits: sess.edits,
      stats: sess.stats, parentSessionId: id, branchName,
    });
    refreshSessions();
  }, [refreshSessions]);
  // 删除会话
  const removeSession = useCallback((id: string) => {
    deletePersistedSession(id);
    refreshSessions();
  }, [refreshSessions]);
  // 「新建会话」按钮：清空当前 conv / historyRef / pendingEdits / sessionId
  const newSession = useCallback(() => {
    historyRef.current = [];
    convRef.current = [];
    pendingEditsRef.current = [];
    currentSessionIdRef.current = null;
    setCurrentSessionId(null);
    setConv([]);
    setPlanChips([]);
    setAgentStats((s) => ({
      ...s, roundStartTs: null, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0,
      totalShells: 0, totalEdits: 0, totalReads: 0, rounds: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0, cacheHits: 0, cacheMisses: 0, contextTokens: 0,
    }));
    setHistoryOpen(false);
  }, []);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // 会话级统计（借鉴 TUI-ENHANCEMENT-PLAN.md 的状态栏：model/token/cost/duration）
  // cacheReadTokens / cacheCreationTokens / cacheHits / cacheMisses 对齐
  // prompt_cache.rs::PromptCacheStats（total_cache_read_input_tokens / completion_cache_hits…）
  const [agentStats, setAgentStats] = useState<{
    roundStartTs: number | null;     // 当前轮开始时间戳（毫秒），null=空闲
    totalInputTokens: number;        // 累计输入 token（估算）
    totalOutputTokens: number;       // 累计输出 token（估算）
    totalCost: number;               // 累计美元成本（估算）
    totalShells: number;             // 累计 shell 调用数
    totalEdits: number;              // 累计 edit/write 数
    totalReads: number;              // 累计 read/ast 数
    rounds: number;                  // 累计轮数
    cacheReadTokens: number;         // provider 侧缓存命中的输入 token（cache_read_input_tokens）
    cacheCreationTokens: number;     // provider 侧缓存创建的输入 token（cache_creation_input_tokens）
    cacheHits: number;               // 前端 completionCache 命中数
    cacheMisses: number;             // 前端 completionCache 未命中数
    contextTokens: number;           // 当前上下文窗口占用（最近一轮 input+output，用于进度条）
  }>({ roundStartTs: null, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0, totalShells: 0, totalEdits: 0, totalReads: 0, rounds: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cacheHits: 0, cacheMisses: 0, contextTokens: 0 });
  // 镜像 agentStats 到 ref，供 saveCurrentSession useCallback 读取最新值
  useEffect(() => { statsRef.current = agentStats; }, [agentStats]);
  const [nowTick, setNowTick] = useState(0); // 1s 心跳，让状态栏的计时器刷新
  const [hookCount, setHookCount] = useState(0); // 已注册插件 Hook 数（状态栏指示用）
  useEffect(() => {
    if (agentStats.roundStartTs === null) return;
    const t = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [agentStats.roundStartTs]);

  // 信任解析器状态（借鉴 trust_resolver.rs 的 RequireApproval → AutoTrust 流转）
  const [trustDialogOpen, setTrustDialogOpen] = useState(false);
  const [isTrusted, setIsTrusted] = useState(false);
  useEffect(() => {
    if (!projectRoot) { setIsTrusted(false); setTrustDialogOpen(false); return; }
    const trusted = isPathTrusted(projectRoot);
    setIsTrusted(trusted);
    setTrustDialogOpen(!trusted);
  }, [projectRoot]);
  const handleTrust = useCallback(() => {
    if (projectRoot) { addTrustedRoot(projectRoot); setIsTrusted(true); }
    setTrustDialogOpen(false);
  }, [projectRoot]);
  const handleUntrust = useCallback(() => {
    if (projectRoot) { removeTrustedRoot(projectRoot); setIsTrusted(false); }
    setTrustDialogOpen(false);
  }, [projectRoot]);

  // 策略引擎状态（对齐 policy_engine.rs + permission_enforcer.rs::check_with_required_mode）
  // 四档 PermissionMode：read-only / plan / normal / dangerous（默认 normal）
  // approvalToken：dangerous 模式下的一次性许可令牌（对齐 approval_tokens.rs::one-shot）
  //   - 进入 dangerous 模式 → 生成 6 位码
  //   - agent 指令带 approval="abc123" 且匹配 → 放行破坏性操作 + 消费令牌（置 null）
  //   - 用户点击「刷新令牌」→ 生成新 6 位码
  //   - 离开 dangerous 模式 → 清空令牌
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('normal');
  const [approvalToken, setApprovalToken] = useState<string | null>(null);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  // 切换模式：进入 dangerous 自动生成新令牌；离开 dangerous 清空令牌
  const switchMode = useCallback((mode: PermissionMode) => {
    setPermissionMode(mode);
    if (mode === 'dangerous') setApprovalToken(generateApprovalToken());
    else setApprovalToken(null);
    setModeMenuOpen(false);
  }, []);
  const regenerateToken = useCallback(() => {
    setApprovalToken(generateApprovalToken());
  }, []);

  // MCP 工具列表（对齐 mcp_client.rs::ManagedMcpTool：server_id + 工具元信息）
  // agent 启动时调用 mcp_list_all_tools 刷新，注入到系统提示词
  const [, setMcpTools] = useState<{ serverId: string; serverName: string; tool: McpTool }[]>([]);
  const refreshMcpTools = useCallback(async (): Promise<{ serverId: string; serverName: string; tool: McpTool }[]> => {
    try {
      const res: any = await hostApi.invoke<any>('mcp_list_all_tools');
      // 后端返回 Vec<(String, String, Vec<McpTool>)> → 序列化为 [[serverId, serverName, [tools]]]
      const list: { serverId: string; serverName: string; tool: McpTool }[] = [];
      if (Array.isArray(res)) {
        for (const item of res) {
          const [sid, sname, tools] = Array.isArray(item) ? item : [item?.serverId || item?.id || '', item?.serverName || item?.name || '', item?.tools || []];
          if (!sid) continue;
          for (const t of (tools || [])) list.push({ serverId: sid, serverName: sname || sid, tool: t });
        }
      }
      setMcpTools(list);
      return list;
    } catch { setMcpTools([]); return []; }
  }, []);
  useEffect(() => { refreshMcpTools(); }, [refreshMcpTools]);

  // 技能系统（阶段五·渐进式披露）：内置技能 + 项目级 .IDE/skills/*/SKILL.md
  // 模块级注册表（ref，避免重渲染），skillsIndex 为注入 system prompt 的紧凑索引（state，触发 prompt 重建）
  const skillRegistryRef = useRef(new SkillRegistry());
  const [, setSkillsIndex] = useState('');
  const refreshSkills = useCallback(async (): Promise<void> => {
    try {
      const builtin = loadBuiltinSkills();
      const project = await discoverProjectSkills(projectRoot);
      // 项目同名覆盖内置（mergeSkills 先放内置后放项目，SkillRegistry.setAll 后插入者覆盖）
      skillRegistryRef.current.setAll(mergeSkills(builtin, project));
      setSkillsIndex(skillRegistryRef.current.getIndex());
    } catch {
      // 失败时至少保留内置技能
      skillRegistryRef.current.setAll(loadBuiltinSkills());
      setSkillsIndex(skillRegistryRef.current.getIndex());
    }
  }, [projectRoot]);
  useEffect(() => { refreshSkills(); }, [refreshSkills]);

  // 工具卡片配对表：cid → conv 卡片 id（tool-start pending 卡 → stage:"tool" 结果落地更新）
  const toolCardRef = useRef<Map<string, string>>(new Map());
  // 后端本轮暂存编辑（ai-agent-edits 事件），收尾转交给宿主审阅面板
  const backendEditsRef = useRef<AgentEdit[]>([]);
  // 危险操作审批弹窗：来自 ai-agent-approval 事件，回调 ai_agent_approve 决定放行/拒绝
  const [approvalReq, setApprovalReq] = useState<{ requestId: string; approvalId: string; tool: string; operation: string } | null>(null);
  const respondApproval = useCallback(async (approved: boolean) => {
    const cur = approvalReq;
    if (!cur) return;
    setApprovalReq(null);
    try {
      await hostApi.invoke('ai_agent_approve', { approvalId: cur.approvalId, approved });
    } catch (e) {
      setConv((prev) => [...prev, { id: 'ap_' + Date.now().toString(36), role: 'tool', content: '⚠ 审批回传失败：' + String(e) }]);
    }
  }, [approvalReq]);

  // 流式事件监听（按 requestId 路由）：渲染后端 ai_chat_agent 全程事件。
  //  - ai-agent-step: stage="tool-start"(pending 卡)/stage="tool"(按 cid 配对更新)
  //  - ai-delta/ai-done/ai-error：文本流式输出与收尾
  //  - ai-agent-approval：危险操作审批弹窗
  //  - ai-agent-edits：本轮暂存编辑，收尾交宿主审阅。
  useEffect(() => {
    let cancelled = false;
    const unlistens: Array<() => void> = [];
    const finish = (err?: string, usage?: any) => {
      // busy 由 runAgent 统一掌控（开始置 true、结束/取消/出错置 false）。
      reqRef.current = null;
      if (handlersRef.current) {
        if (err) {
          const id = assistantIdRef.current;
          if (id) setConv((prev) => prev.map((m) => (m.id === id ? { ...m, content: (m.content ? m.content + '\n' : '') + '⚠ ' + err, error: true, streaming: false } : m)));
        }
        handlersRef.current.onDone(err, usage);
      }
    };
    (async () => {
      const uStep = await hostApi.listen<any>('ai-agent-step', (e) => {
        const p = e.payload || {};
        if (p.requestId !== reqRef.current) return;
        if (p.stage === 'tool-start') {
          const title = (p.meta && (p.meta.title || p.meta.cardTitle)) || p.name || '工具';
          const card: AgentMsg = { id: 'tk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), role: 'tool', content: '⋯ ' + title, streaming: true };
          if (p.cid != null) toolCardRef.current.set(String(p.cid), card.id);
          setConv((prev) => [...prev, card]);
        } else if (p.stage === 'tool') {
          const label = (p.ok === false ? '✗ ' : '✓ ') + ((p.meta && (p.meta.title || p.meta.cardTitle)) || p.name || '工具') + (p.ok === false && p.detail ? '\n' + String(p.detail).slice(0, 400) : '');
          const cid = p.cid != null ? toolCardRef.current.get(String(p.cid)) : undefined;
          if (cid) {
            toolCardRef.current.delete(String(p.cid));
            setConv((prev) => prev.map((m) => (m.id === cid ? { ...m, content: label, streaming: false } : m)));
          } else {
            setConv((prev) => [...prev, { id: 'tk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), role: 'tool', content: label }]);
          }
        }
      });
      const uApproval = await hostApi.listen<any>('ai-agent-approval', (e) => {
        const p = e.payload || {};
        if (p.requestId !== reqRef.current) return;
        setApprovalReq({ requestId: p.requestId, approvalId: p.approvalId, tool: p.tool, operation: p.operation });
      });
      const uEdits = await hostApi.listen<any>('ai-agent-edits', (e) => {
        const p = e.payload || {};
        if (p.requestId !== reqRef.current) return;
        backendEditsRef.current = (Array.isArray(p.edits) ? p.edits : []).map((ed: any) => ({
          id: ed.id || 'e_' + Date.now().toString(36),
          path: ed.path,
          old: ed.oldText || '',
          new: ed.newText || '',
          isNew: ed.action === 'write' || !ed.oldText,
          status: 'pending',
          error: undefined,
        } as AgentEdit));
        if (backendEditsRef.current.length) setPlanChips(backendEditsRef.current.map((x) => x.path));
      });
      const uDelta = await hostApi.listen<{ requestId: string; delta: string }>('ai-delta', (e) => {
        if (e.payload.requestId === reqRef.current) {
          bufRef.current += e.payload.delta;
          const id = assistantIdRef.current;
          if (id) setConv((prev) => prev.map((m) => (m.id === id ? { ...m, content: bufRef.current } : m)));
          // 浮岛「AI 编程」agent 桥：后端已输出清洗后文本，直接回传（多轮累积到 agentRunCleanedRef）
          if (capsuleAgentReqRef.current) {
            hostApi.emit('capsule-ide-agent-delta', {
              requestId: capsuleAgentReqRef.current,
              text: (agentRunCleanedRef.current ? agentRunCleanedRef.current + '\n—\n' : '') + e.payload.delta,
            });
          }
        }
      });
      const uDone = await hostApi.listen<{ requestId: string; usage?: any }>('ai-done', (e) => {
        if (e.payload.requestId === reqRef.current) {
          // 浮岛 agent 桥：提交本轮文本到 run 级缓冲（done 不在此发，由 runAgent 末尾统一发）
          if (capsuleAgentReqRef.current) {
            agentRunCleanedRef.current = (agentRunCleanedRef.current ? agentRunCleanedRef.current + '\n—\n' : '') + bufRef.current;
          }
          finish(undefined, e.payload.usage);
        }
      });
      const uErr = await hostApi.listen<{ requestId: string; error: string }>('ai-error', (e) => {
        if (e.payload.requestId === reqRef.current) {
          // 浮岛 agent 桥：本轮出错直接报错回传（runAgent 末尾的 emitAgentEnd 会因 req 已清空而不重复发）
          if (capsuleAgentReqRef.current) {
            hostApi.emit('capsule-ide-agent-error', { requestId: capsuleAgentReqRef.current, error: e.payload.error });
            capsuleAgentReqRef.current = null;
          }
          finish(e.payload.error);
        }
      });
      if (cancelled) { uStep(); uApproval(); uEdits(); uDelta(); uDone(); uErr(); return; }
      unlistens.push(uStep, uApproval, uEdits, uDelta, uDone, uErr);
    })();
    return () => { cancelled = true; unlistens.forEach((u) => u()); };
  }, []);

  useEffect(() => { const el = scrollRef.current; if (!el) return; el.scrollTop = el.scrollHeight; const id = requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; }); return () => cancelAnimationFrame(id); }, [conv]);

  const autoResize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const cs = getComputedStyle(el);
    const lh = parseInt(cs.lineHeight) || 20;
    const pad = parseInt(cs.paddingTop) + parseInt(cs.paddingBottom);
    const maxH = lh * 4 + pad;
    el.style.height = Math.min(el.scrollHeight, maxH) + 'px';
    el.style.overflowY = el.scrollHeight > maxH ? 'auto' : 'hidden';
  }, []);
  useEffect(() => { autoResize(); }, [input, autoResize]);

  // Git 分支检测（对齐 TUI-ENHANCEMENT-PLAN.md 状态栏 git branch 指示）：
  // 项目根变更时异步读取当前分支名，用于状态栏显示。零依赖 —— 复用后端 run_shell_command。
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  useEffect(() => {
    if (!projectRoot) { setGitBranch(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const out = await hostApi.invoke<string>('run_shell_command', { command: 'git branch --show-current', cwd: projectRoot });
        const br = (out || '').trim();
        if (!cancelled) setGitBranch(br || null);
      } catch { if (!cancelled) setGitBranch(null); }
    })();
    return () => { cancelled = true; };
  }, [projectRoot]);

  // 加载全局模型档案，供 agent 模式的下拉框选用（与普通对话面板一致）
  useEffect(() => {
    hostApi.invoke<{ profiles: { id: string; name?: string; model?: string; base_url?: string; api_key?: string }[] }>('ai_get_profiles')
      .then((data) => setProfiles(data.profiles || []))
      .catch(() => {});
  }, []);
  const configuredProfiles = profiles.filter((p) => p.api_key && p.api_key.trim());
  const activeProfile = configuredProfiles.find((p) => p.id === activeProfileId) || null;
  // 思考模式内联开关：直接写入后端 profile.thinking（与胶囊 / 茑萝AI / 攻防共享同一档案字段）
  const toggleThinking = useCallback(async () => {
    if (!activeProfileId) return;
    const next = !activeProfile?.thinking;
    setProfiles((prev) => prev.map((p) => (p.id === activeProfileId ? { ...p, thinking: next } : p)));
    try {
      await hostApi.invoke('ai_set_profile_thinking', { profileId: activeProfileId, thinking: next });
    } catch (e) {
      console.warn('[IDE] 设置思考模式失败:', e);
      setProfiles((prev) => prev.map((p) => (p.id === activeProfileId ? { ...p, thinking: !next } : p)));
    }
  }, [activeProfileId, activeProfile?.thinking]);

  // 接收其它聊天界面切换「思考模式」的事件，保持胶囊 / 茑萝AI / 攻防 三处开关实时同步
  React.useEffect(() => {
    let un: any = null;
    hostApi.listen('ai-thinking-changed', (e: any) => {
      const pid = e?.payload?.profile_id;
      const th = e?.payload?.thinking;
      if (!pid) return;
      setProfiles((ps: any[]) => ps.map((p) => (p.id === pid ? { ...p, thinking: th } : p)));
    }).then((u: any) => { un = u; }).catch(() => {});
    return () => { if (un) un(); };
  }, []);

  // 发起单次后端 Agent 执行并等待其通过事件回收（ai-done/ai-error 前挂起）。
  // 后端 ai_chat_agent 内部完成工具循环/子代理/记忆压缩，前端仅渲染事件。
  const callBackendAgent = useCallback((requestId: string, messages: { role: string; content: string }[]) => {
    return new Promise<void>((resolve) => {
      const inputTokens = messages.reduce((s, m) => s + estimateTokens(typeof m.content === 'string' ? m.content : ''), 0);
      resolveRef.current = resolve;
      handlersRef.current = {
        onDelta: () => {},
        onDone: (e?: string, usage?: any) => {
          handlersRef.current = null;
          resolveRef.current = null;
          errRef.current = e || null;
          // 累计 token 与成本估算（借鉴 TUI-ENHANCEMENT-PLAN.md 的 token 进度条）
          const outputTokens = estimateTokens(bufRef.current);
          const prof = profiles.find((p) => p.id === activeProfileId);
          const cost = estimateCost(inputTokens, outputTokens, prof?.model);
          // Prompt Cache（provider 侧）：解析 usage.cache_read_input_tokens /
          // cache_creation_input_tokens，对齐 prompt_cache.rs::apply_usage_to_stats。
          const u = parseUsageTokens(usage);
          setAgentStats((s) => ({
            ...s,
            totalInputTokens: s.totalInputTokens + inputTokens,
            totalOutputTokens: s.totalOutputTokens + outputTokens,
            totalCost: s.totalCost + cost,
            cacheReadTokens: s.cacheReadTokens + u.cacheReadTokens,
            cacheCreationTokens: s.cacheCreationTokens + u.cacheCreationTokens,
            contextTokens: inputTokens + outputTokens, // 最近一轮的上下文占用（用于进度条）
          }));
          resolve();
        },
      };
      hostApi.invoke('ai_chat_agent', {
        requestId,
        messages,
        profileId: activeProfileId,
        projectRoot: projectRoot || undefined,
        max_rounds: 8,
      })
        .catch((e: any) => { handlersRef.current = null; resolveRef.current = null; errRef.current = String(e); bufRef.current += '\n⚠ ' + String(e); resolve(); });
    });
  }, [activeProfileId, profiles, projectRoot]);

  // 运行时取消：通知后端终止后台 Agent，置标志、使当前请求失效并立即解除挂起
  const cancelAgent = useCallback(() => {
    cancelRef.current = true;
    const rid = reqRef.current;
    reqRef.current = null;
    resolveRef.current?.();
    resolveRef.current = null;
    setApprovalReq(null);
    setBusy(false);
    setAgentStats((s) => ({ ...s, roundStartTs: null }));
    setConv((prev) => [...prev, { id: 'c_' + Date.now().toString(36), role: 'assistant', content: '⛔ 已取消运行' }]);
    if (rid) hostApi.invoke('ai_agent_cancel', { requestId: rid }).catch(() => {});
  }, []);

  // 浮岛「AI 编程」agent 桥：本轮/本任务结束时统一回传 done（错误则传 error），emit 后清空 requestId 防止重复
  const emitAgentEnd = useCallback((err?: string) => {
    if (capsuleAgentReqRef.current) {
      hostApi.emit(err ? 'capsule-ide-agent-error' : 'capsule-ide-agent-done', {
        requestId: capsuleAgentReqRef.current,
        ...(err ? { error: err } : {}),
      });
      capsuleAgentReqRef.current = null;
    }
  }, []);

const runAgent = useCallback(async (overrideText?: string, seed?: ChatMessage[]) => {
    const text = (overrideText ?? input).trim();
    if (!text || busy) return;
    if (!activeProfileId) {
      setConv((prev) => [...prev, { id: 'h_' + Date.now().toString(36), role: 'assistant', content: '⚠ 尚未配置可用模型：请到「全局设置 → 模型」添加并填写 API Key。', error: true }]);
      return;
    }
    cancelRef.current = false;
    setBusy(true);
    setInput('');
    // 浮岛代理请求：以浮岛共享对话历史（chat/agent 共用的 aideMessages）作为本轮上下文，
    // 使 agent 模式与浮岛（及 chat 模式）共享同一对话，而非每次从空白开始。
    if (seed && seed.length) {
      historyRef.current = [...seed];
      setConv(seed.map((m, i) => ({ id: 'seed_' + i, role: m.role, content: m.content })));
    }
    // 标记本轮开始（用于状态栏计时器）
    setAgentStats((s) => ({ ...s, roundStartTs: Date.now(), rounds: s.rounds + 1 }));
    const uid = 'u_' + Date.now().toString(36);
    setConv((prev) => [...prev, { id: uid, role: 'user', content: text }]);
    historyRef.current.push({ role: 'user', content: text });

    const requestId = 'ag_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    reqRef.current = requestId;
    const aid = 'a_' + Date.now().toString(36);
    assistantIdRef.current = aid;
    // 重置本轮显示状态
    bufRef.current = '';
    backendEditsRef.current = [];
    toolCardRef.current.clear();
    setPlanChips([]);
    setApprovalReq(null);
    setHookCount(hookRegistry.count()); // 刷新状态栏 Hook 计数
    setConv((prev) => [...prev, { id: aid, role: 'assistant', content: '', streaming: true }]);

    // 单次委派后端：后端 ai_chat_agent 内部完成工具循环/子代理/记忆；前端事件驱动渲染，ai-done/ai-error 回收
    await callBackendAgent(requestId, historyRef.current.map((m) => ({ role: m.role, content: m.content })));
    if (cancelRef.current) { setBusy(false); emitAgentEnd(); return; }

    // 收尾：将最终文本/错误归档进对话历史，本轮编辑转交宿主审阅面板
    const finalErr = errRef.current;
    if (!finalErr && bufRef.current) {
      historyRef.current.push({ role: 'assistant', content: bufRef.current });
    }
    const editsOut = backendEditsRef.current;
    setPlanChips(editsOut.map((x) => x.path));
    setBusy(false);
    setAgentStats((s) => ({ ...s, roundStartTs: null }));
    if (finalErr) {
      emitAgentEnd(finalErr);
    } else {
      if (editsOut.length > 0) onChanges(editsOut, null);
      else setConv((prev) => [...prev, { id: 'd_' + Date.now().toString(36), role: 'assistant', content: '（本次没有文件被修改）' }]);
      emitAgentEnd();
    }
    // 会话持久化：runAgent 结束自动保存（对齐 session.rs::flush）
    setTimeout(() => saveCurrentSession(), 0);
  }, [input, busy, activeProfileId, projectRoot, onChanges, saveCurrentSession, emitAgentEnd, callBackendAgent]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      runAgent();
    }
  };

  // 浮岛「AI 编程」agent 桥：接收浮岛转发来的请求，直接驱动本 AgentPane 执行（仅 agent 模式挂载时生效）
  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | undefined;
    hostApi.listen<{ requestId: string; text: string; profileId?: string; history?: ChatMessage[] }>('capsule-ide-agent-request', async (e) => {
      const payload = (e?.payload || {}) as any;
      const requestId = payload.requestId;
      const text = (payload.text || '').trim();
      if (!requestId || !text) return;
      // 去重护栏：同一 requestId 已在处理则静默忽略（防泄漏的重复监听器二次触发并误报「正在处理其他请求」）
      if (capsuleAgentReqRef.current === requestId) return;
      if (busy || capsuleAgentReqRef.current) {
        await hostApi.emit('capsule-ide-agent-error', { requestId, error: 'IDE 正在处理其他请求，请稍后再试' });
        return;
      }
      capsuleAgentReqRef.current = requestId;
      agentRunCleanedRef.current = '';
      // 可选：浮岛若指定模型，切换到该档案（ID 不匹配则忽略，沿用当前激活档案）
      if (payload.profileId && payload.profileId !== activeProfileId && onProfileChange && configuredProfiles.some((p: any) => p.id === payload.profileId)) {
        onProfileChange(payload.profileId);
      }
      // runAgent 用闭包内 activeProfileId：若上面切了档，先下一帧再跑，确保用上新档案
      if (payload.profileId && payload.profileId !== activeProfileId) {
        await new Promise((r) => setTimeout(r, 0));
      }
      // 以浮岛共享对话历史作为种子，使 agent 模式与 chat 模式/浮岛共享同一对话上下文
      await runAgent(text, payload.history);
    }).then((u) => { if (cancelled) { u(); return; } unsub = u; });
    // 依赖含 runAgent（其 useCallback 依赖 input 等，每次输入都变）→ effect 高频重挂；
    // hostApi.listen 异步注册，cancelled 守卫确保「清理先于注册完成」时也能反注册，杜绝监听器泄漏累积。
    return () => { cancelled = true; unsub?.(); };
  }, [busy, runAgent, activeProfileId, onProfileChange, configuredProfiles]);

  // 浮岛「清空对话」：清除 IDE 代理历史会话（localStorage）并存盘重置
  useEffect(() => {
    let unsub: (() => void) | undefined;
    hostApi.listen<{}>('capsule-ide-clear-conversations', () => {
      try {
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && (k === SESSION_INDEX_KEY || k.startsWith('ide_session_'))) keys.push(k);
        }
        keys.forEach((k) => localStorage.removeItem(k));
      } catch { /* 忽略 */ }
      setSessions([]);
      setCurrentSessionId(null);
      if (typeof newSession === 'function') newSession();
    }).then((u) => { unsub = u; });
    return () => unsub?.();
  }, [newSession]);

  return (
    <div className="flex flex-col h-full bg-neutral-50 dark:bg-stone-900 text-neutral-800 dark:text-stone-100">
      {/* 后端 Agent 危险操作审批弹窗（ai-agent-approval） */}
      {approvalReq && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40" role="dialog">
          <div className="mx-4 max-w-md w-full rounded-xl border border-neutral-200 dark:border-stone-700 bg-white dark:bg-stone-800 p-5 shadow-xl">
            <div className="text-sm font-semibold mb-2">⚠ 需要授权</div>
            <div className="text-xs text-neutral-500 dark:text-stone-400 mb-4 break-words">
              后端 Agent 请求执行操作 <span className="font-medium text-neutral-700 dark:text-stone-200">{approvalReq.tool}</span>：
              <pre className="mt-1 max-h-40 overflow-auto text-[11px] whitespace-pre-wrap bg-black/5 dark:bg-white/5 rounded p-2">{approvalReq.operation}</pre>
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => respondApproval(false)} className="px-3 py-1.5 rounded text-xs bg-neutral-100 dark:bg-stone-700 hover:bg-neutral-200 dark:hover:bg-stone-600">拒绝</button>
              <button onClick={() => respondApproval(true)} className="px-3 py-1.5 rounded text-xs bg-red-500 hover:bg-red-600 text-white">允许</button>
            </div>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-200/60 dark:border-stone-700/60 shrink-0">
        <span className="text-sm font-medium shrink-0">AI 代理</span>
        <span className="text-[11px] text-neutral-400 dark:text-stone-500">自主编辑模式</span>
        <span className="flex-1" />
        {/* 模型选择（与普通对话面板一致） */}
        <div className="relative">
          {configuredProfiles.length === 0 ? (
            <span className="px-2 py-1 rounded text-[11px] bg-amber-500/10 text-amber-600 dark:text-amber-400 max-w-[180px] truncate" title="尚未配置可用模型">未配置模型</span>
          ) : modelOpen ? (
            <div className="absolute top-full right-0 mt-1 z-30 w-60 rounded-lg border border-neutral-200 dark:border-stone-700 bg-white dark:bg-stone-800 shadow-lg max-h-48 overflow-auto py-1">
              {configuredProfiles.map((p) => (
                <button key={p.id} onClick={() => { onProfileChange?.(p.id); setModelOpen(false); }}
                  className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/5 ${p.id === activeProfileId ? 'text-[var(--element-bg)] font-medium' : ''}`}>
                  {p.name || p.model || '未命名'} · {p.model || p.base_url}
                </button>
              ))}
            </div>
          ) : (
            <button onClick={() => setModelOpen(true)} title="选择模型"
              className="btn-press text-[11px] text-neutral-500 dark:text-stone-400 hover:text-neutral-700 dark:hover:text-stone-200 truncate max-w-[180px]">
              {activeProfile ? `模型：${activeProfile.name || activeProfile.model}` : '选择模型'} ▾
            </button>
          )}
        </div>
        {!projectRoot && <span className="text-[11px] text-neutral-400 dark:text-stone-500" title="建议先在左侧打开项目文件夹">未打开项目</span>}
      </div>
      {/* 会话统计状态栏（借鉴 TUI-ENHANCEMENT-PLAN.md：model/token/cost/duration/shells/edits） */}
      <div className="flex items-center gap-2 px-3 py-1 text-[10px] border-b border-neutral-200/40 dark:border-stone-700/40 bg-neutral-50/50 dark:bg-stone-800/30 shrink-0 whitespace-nowrap overflow-x-auto">
        {/* 当前模型名（对齐 TUI-ENHANCEMENT-PLAN.md 状态栏 model 指示） */}
        {activeProfile && (
          <span className="text-indigo-600 dark:text-indigo-400 font-mono" title={`模型：${activeProfile.model || '未知'}\n档案：${activeProfile.name || activeProfile.id}${activeProfile.base_url ? '\n端点：' + activeProfile.base_url : ''}`}>
            🤖 {(activeProfile.model || activeProfile.name || '默认').slice(0, 24)}
          </span>
        )}
        {/* Git 分支（对齐 TUI-ENHANCEMENT-PLAN.md 状态栏 git branch 指示） */}
        {gitBranch && (
          <span className="text-orange-600 dark:text-orange-400 font-mono" title={`当前 Git 分支：${gitBranch}`}>
            🌿 {gitBranch}
          </span>
        )}
        {agentStats.roundStartTs !== null && (
          <span className="text-emerald-600 dark:text-emerald-400 font-mono" title="本轮耗时">
            ⏱ {formatDuration(Date.now() - agentStats.roundStartTs + (nowTick & 0))}
          </span>
        )}
        <span className="text-neutral-500 dark:text-stone-400 font-mono" title="累计输入/输出 token（估算）">
          📊 {(agentStats.totalInputTokens / 1000).toFixed(1)}k↓ / {(agentStats.totalOutputTokens / 1000).toFixed(1)}k↑
        </span>
        {agentStats.totalCost > 0 && (
          <span className="text-amber-600 dark:text-amber-400 font-mono" title="累计成本估算（USD）">
            💰 ${agentStats.totalCost.toFixed(4)}
          </span>
        )}
        <span className="text-sky-600 dark:text-sky-400 font-mono" title="累计 shell 调用数">⚡ {agentStats.totalShells}</span>
        <span className="text-purple-600 dark:text-purple-400 font-mono" title="累计 read/ast 次数">🔍 {agentStats.totalReads}</span>
        <span className="text-emerald-600 dark:text-emerald-400 font-mono" title="累计 edit/write 次数">✎ {agentStats.totalEdits}</span>
        <span className="text-neutral-400 dark:text-stone-500 font-mono" title="累计轮数">🔄 {agentStats.rounds}</span>
        {(agentStats.cacheReadTokens > 0 || agentStats.cacheCreationTokens > 0 || agentStats.cacheHits > 0) && (
          <span
            className="text-cyan-600 dark:text-cyan-400 font-mono"
            title={`Provider 缓存：命中读取 ${agentStats.cacheReadTokens.toLocaleString()} tok / 创建 ${agentStats.cacheCreationTokens.toLocaleString()} tok\n前端 completionCache：命中 ${agentStats.cacheHits} / 未命中 ${agentStats.cacheMisses}`}
          >
            📦 {agentStats.cacheReadTokens > 0
              ? `${(agentStats.cacheReadTokens / 1000).toFixed(1)}k cache`
              : `${agentStats.cacheHits}hit`}
          </span>
        )}
        {/* Token 上下文进度条（对齐 TUI-ENHANCEMENT-PLAN.md token 进度条）：
            显示当前上下文窗口占用率，>80% 转红预警，>60% 转黄提示 */}
        {agentStats.contextTokens > 0 && (() => {
          const CTX_CAP = 200000; // 对齐 TOKEN_CAP
          const pct = Math.min(100, (agentStats.contextTokens / CTX_CAP) * 100);
          const color = pct > 80 ? 'bg-red-500' : pct > 60 ? 'bg-amber-500' : 'bg-emerald-500';
          const txtColor = pct > 80 ? 'text-red-600 dark:text-red-400' : pct > 60 ? 'text-amber-600 dark:text-amber-400' : 'text-neutral-500 dark:text-stone-400';
          return (
            <span className={`font-mono inline-flex items-center gap-1 ${txtColor}`} title={`上下文窗口占用：${(agentStats.contextTokens / 1000).toFixed(1)}k / ${(CTX_CAP / 1000).toFixed(0)}k（${pct.toFixed(0)}%）\n>60% 触发自动压缩，>80% 预警`}>
              📈
              <span className="inline-block w-12 h-2 rounded-sm bg-neutral-200 dark:bg-stone-700 overflow-hidden align-middle">
                <span className={`block h-full ${color} transition-all`} style={{ width: pct + '%' }} />
              </span>
              {pct.toFixed(0)}%
            </span>
          );
        })()}
        {/* 插件 Hook 指示器（对齐 hooks.rs + plugin_lifecycle.rs）：显示已注册钩子数 */}
        {hookCount > 0 && (
          <span
            className="text-pink-600 dark:text-pink-400 font-mono"
            title={`已注册 ${hookCount} 个插件 Hook\n其他子插件通过 window.__IDE_AGENT_HOOKS__.register() 注册\n钩子类型：beforeShell/afterShell/beforeWrite/afterWrite/beforeEdit/afterEdit/beforeRead/afterRead/beforeCommit`}
          >
            🪝 {hookCount}
          </span>
        )}
        <span className="flex-1" />
        {/* 会话历史（对齐 session.rs::Session 持久化 + task_registry.rs::Task 列表） */}
        <div className="relative shrink-0">
          {/* 对话选择下拉框（与 chat 模式一致：切换已保存的多轮会话） */}
          {sessions.length > 0 && (
            <select
              value={currentSessionId ?? ''}
              onChange={(e) => { const v = e.target.value; if (v) restoreSession(v); }}
              title="切换会话"
              className="max-w-[160px] text-xs rounded-md border border-neutral-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-neutral-800 dark:text-stone-100 px-2 py-1 outline-none"
            >
              <option value="">当前会话</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>{(s.firstPrompt || '(空会话)').slice(0, 22)}</option>
              ))}
            </select>
          )}
          <button
            onClick={() => setHistoryOpen((v) => !v)}
            className={`btn-press font-mono px-1.5 py-0.5 rounded ${sessions.length > 0 ? 'text-purple-600 dark:text-purple-400 bg-purple-500/10' : 'text-neutral-400 dark:text-stone-500 bg-neutral-500/5'}`}
            title={`会话历史（${sessions.length} 个已保存）\n点击查看/恢复/分叉历史会话`}
          >
            📚 {sessions.length}
          </button>
          {historyOpen && (
            <div className="absolute top-full right-0 mt-1 z-30 w-80 rounded-lg border border-neutral-200 dark:border-stone-700 bg-white dark:bg-stone-800 shadow-lg">
              <div className="flex items-center gap-1 px-3 py-1.5 border-b border-neutral-200 dark:border-stone-700 text-[11px] text-neutral-500 dark:text-stone-400">
                <span className="font-semibold">📚 会话历史</span>
                <span className="flex-1" />
                <button onClick={newSession} className="btn-press px-1.5 py-0.5 rounded text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10" title="清空当前对话，开始新会话">+ 新建</button>
                <button onClick={() => saveCurrentSession()} className="btn-press px-1.5 py-0.5 rounded text-sky-600 dark:text-sky-400 hover:bg-sky-500/10" title="手动保存当前会话">💾 保存</button>
              </div>
              <div className="max-h-80 overflow-y-auto">
                {sessions.length === 0 ? (
                  <div className="px-3 py-4 text-center text-[11px] text-neutral-400 dark:text-stone-500">
                    暂无已保存会话<br/><span className="text-[10px]">agent 运行结束后会自动保存</span>
                  </div>
                ) : sessions.map((s) => (
                  <div key={s.id} className="px-3 py-1.5 border-b border-neutral-100 dark:border-stone-700/50 hover:bg-black/5 dark:hover:bg-white/5">
                    <div className="flex items-start gap-1.5">
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] text-neutral-700 dark:text-stone-200 truncate font-medium" title={s.firstPrompt}>
                          {s.parentSessionId && <span className="text-purple-500 mr-1" title={`分叉自 ${s.parentSessionId}`}>🌿</span>}
                          {s.firstPrompt || '(空会话)'}
                        </div>
                        <div className="text-[10px] text-neutral-400 dark:text-stone-500 mt-0.5">
                          {new Date(s.ts).toLocaleString()} · {s.rounds} 轮{s.branchName ? ` · ${s.branchName}` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0">
                        <button onClick={() => restoreSession(s.id)} className="btn-press px-1 py-0.5 rounded text-[10px] text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10" title="恢复此会话（覆盖当前）">↩ 恢复</button>
                        <button onClick={() => forkSession(s.id)} className="btn-press px-1 py-0.5 rounded text-[10px] text-purple-600 dark:text-purple-400 hover:bg-purple-500/10" title="分叉此会话（原会话保留，从该点继续）">🌿 分叉</button>
                        <button onClick={() => removeSession(s.id)} className="btn-press px-1 py-0.5 rounded text-[10px] text-red-500 hover:bg-red-500/10" title="删除此会话">✕</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        {/* 策略引擎：PermissionMode 切换器（对齐 policy_engine.rs::PolicyRule + permission_enforcer.rs） */}
        <div className="relative shrink-0">
          <button
            onClick={() => setModeMenuOpen((v) => !v)}
            className={`btn-press font-mono px-1.5 py-0.5 rounded ${PERMISSION_MODE_META[permissionMode].cls}`}
            title={`权限模式：${PERMISSION_MODE_META[permissionMode].label}\n${PERMISSION_MODE_META[permissionMode].desc}`}
          >
            {PERMISSION_MODE_META[permissionMode].chip} {PERMISSION_MODE_META[permissionMode].label}
          </button>
          {modeMenuOpen && (
            <div className="absolute top-full right-0 mt-1 z-30 w-64 rounded-lg border border-neutral-200 dark:border-stone-700 bg-white dark:bg-stone-800 shadow-lg py-1">
              {PERMISSION_MODES.map((m) => (
                <button
                  key={m}
                  onClick={() => switchMode(m)}
                  className={`block w-full text-left px-2.5 py-1.5 text-[11px] hover:bg-black/5 dark:hover:bg-white/5 ${m === permissionMode ? 'font-bold ' + PERMISSION_MODE_META[m].cls : 'text-neutral-600 dark:text-stone-300'}`}
                >
                  <span className="mr-1">{PERMISSION_MODE_META[m].chip}</span>
                  <span>{PERMISSION_MODE_META[m].label}</span>
                  <span className="block text-[10px] text-neutral-400 dark:text-stone-500 mt-0.5">{PERMISSION_MODE_META[m].desc}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {/* dangerous 模式令牌显示（对齐 approval_tokens.rs::one-shot） */}
        {permissionMode === 'dangerous' && (
          <button
            onClick={regenerateToken}
            className={`btn-press font-mono px-1.5 py-0.5 rounded ${approvalToken ? 'text-red-600 dark:text-red-400 bg-red-500/10' : 'text-neutral-400 dark:text-stone-500 bg-neutral-500/5'}`}
            title={approvalToken ? `许可令牌：${approvalToken}\n一次性使用，agent 必须在指令加 approval="${approvalToken}"\n点击刷新生成新令牌` : '令牌已消费或未生成\n点击生成新令牌'}
          >
            {approvalToken ? `🔑 ${approvalToken}` : '🔑 已消费'}
          </button>
        )}
        {/* 信任状态指示（借鉴 trust_resolver.rs 的 TrustPolicy 三态） */}
        {projectRoot && (
          <button
            onClick={() => setTrustDialogOpen(true)}
            className={`btn-press font-mono px-1.5 py-0.5 rounded ${isTrusted ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10' : 'text-amber-600 dark:text-amber-400 bg-amber-500/10'}`}
            title={isTrusted ? '已信任此项目（点击管理）' : '⚠ 项目未信任：写入与非只读 shell 被拦截（点击信任）'}
          >
            {isTrusted ? '🛡 信任' : '⚠ 未信任'}
          </button>
        )}
        {agentStats.roundStartTs !== null && (
          <span className="text-emerald-500 animate-pulse" title="agent 正在运行">●</span>
        )}
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 px-3 py-3 space-y-3">
        {/* 计划模式面板（阶段二）：agent 输出 <plan><step>…</step></plan> 后展示，用户确认/拒绝/编辑步骤 */}
        {planState.visible && planState.steps.length > 0 && (
          <PlanModePanel
            plan={planState}
            onUpdate={setPlanState}
            onConfirm={() => {
              setPlanState((p) => ({ ...p, confirmed: true }));
              historyRef.current.push({ role: 'user', content: '✅ 用户已确认计划，请按步骤逐步执行。每完成一步可不必等待确认，继续下一步，全部完成后输出 <done/> 并总结。' });
              setConv((prev) => [...prev, { id: 'pc_' + Date.now().toString(36), role: 'tool', content: '✅ 计划已确认，agent 开始执行' }]);
            }}
            onReject={() => {
              setPlanState({ steps: [], confirmed: false, visible: false });
              historyRef.current.push({ role: 'user', content: '❌ 用户拒绝了该计划，请重新规划或调整方案后再执行。' });
              setConv((prev) => [...prev, { id: 'pc_' + Date.now().toString(36), role: 'tool', content: '❌ 计划已拒绝，等待重新规划' }]);
            }}
          />
        )}
        {conv.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center text-neutral-400 dark:text-stone-500 gap-2 text-sm">
            <div>用自然语言让 AI 自主修改项目</div>
            <div className="text-xs max-w-xs">AI 会自行读取并编辑文件，结束后列出改动供你逐文件保留或撤销。建议先在左侧打开项目文件夹。</div>
          </div>
        ) : conv.map((m) => {
          // 解析 <think> 块（借鉴 TUI-ENHANCEMENT-PLAN.md：thinking 指示器）
          const { thinking, visible } = m.role === 'assistant' ? parseThinking(m.content) : { thinking: null, visible: m.content };
          // 工具消息：内容超过 200 字符时默认折叠（可点击展开）
          const isLongTool = m.role === 'tool' && m.content.length > 200;
          // 工具消息首行（用作折叠态摘要）
          const firstLine = isLongTool ? m.content.split('\n')[0].slice(0, 120) : '';
          return (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div className={`max-w-[92%] rounded-xl px-3 py-2 text-sm leading-relaxed ${m.role === 'user' ? 'element-primary' : m.role === 'tool' ? 'bg-neutral-200/70 dark:bg-stone-700/70 text-neutral-500 dark:text-stone-400 text-xs' : m.error ? 'bg-red-500/10 text-red-500 dark:text-red-400' : 'bg-white dark:bg-stone-800 border border-neutral-200/60 dark:border-stone-700/60'}`}>
              {m.streaming && <span className="inline-block w-1.5 h-4 ml-0.5 align-middle bg-[var(--element-bg)] animate-pulse" />}
              {/* 思考过程（<think> 块）：默认折叠，淡色显示 */}
              {thinking && (
                <details className="mb-1.5 rounded-md bg-neutral-100/60 dark:bg-stone-900/40 border border-neutral-200/50 dark:border-stone-700/50 px-2 py-1">
                  <summary className="cursor-pointer text-[11px] text-purple-500 dark:text-purple-400 select-none flex items-center gap-1">
                    <span>🧠</span><span>思考过程</span>
                    {m.streaming && <span className="text-[10px] text-neutral-400">（生成中…）</span>}
                  </summary>
                  <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] text-neutral-500 dark:text-stone-400 font-mono leading-relaxed">{thinking}</pre>
                </details>
              )}
              {/* 长工具消息：折叠态只显示首行摘要 */}
              {isLongTool ? (
                <details>
                  <summary className="cursor-pointer select-none">
                    <span className="whitespace-pre-wrap break-words">{firstLine}{m.content.length > firstLine.length ? ' …' : ''}</span>
                    <span className="ml-1 text-[10px] text-neutral-400">（{m.content.length} 字符，点击展开）</span>
                  </summary>
                  <span className="whitespace-pre-wrap break-words block mt-1">{m.content}</span>
                </details>
              ) : (
                m.role === 'tool'
                  ? <span className="whitespace-pre-wrap break-words">{visible}</span>
                  : <Markdown text={visible} className="whitespace-pre-wrap break-words" />
              )}
            </div>
          </div>
          );
        })}
      </div>
      <div className="px-3 py-2 border-t border-neutral-200/60 dark:border-stone-700/60 shrink-0 relative">
        <div className="rounded-xl border border-neutral-200 dark:border-stone-700 bg-white dark:bg-stone-800 shadow-sm px-3 py-2 flex flex-col gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="例如：把 src/utils.ts 里的 debounce 改成支持 leading 选项…"
            className="w-full resize-none bg-transparent outline-none text-sm text-neutral-800 dark:text-stone-100 placeholder:text-neutral-400 leading-relaxed"
            style={{ maxHeight: 140 }}
          />
          <div className="flex items-center justify-between gap-2">
            <button onClick={toggleThinking} title={activeProfile?.thinking ? '思考模式：开（先输出思维链再回答）' : '思考模式：关（点击开启）'}
              className={`btn-press shrink-0 px-2.5 py-1.5 rounded-lg text-xs border transition-colors ${
                activeProfile?.thinking
                  ? 'border-[var(--element-border)] bg-[rgba(230,195,92,0.14)] text-neutral-800 dark:text-stone-100 font-medium'
                  : 'border-neutral-200 dark:border-stone-700 text-neutral-600 dark:text-stone-300'
              }`}>
              {activeProfile?.thinking ? (
                    <>
                      <span className="inline-block w-[7px] h-[7px] rounded-full mr-1 align-middle" style={{ background: '#22c55e' }} />
                      思考·开
                    </>
                  ) : (
                    <>
                      <span className="inline-block w-[7px] h-[7px] rounded-full mr-1 align-middle" style={{ background: 'rgba(120,120,120,0.45)' }} />
                      思考·关
                    </>
                  )}
            </button>
            <button onClick={busy ? cancelAgent : () => runAgent()} disabled={busy ? false : !input.trim()}
              className={`btn-press shrink-0 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${busy ? 'bg-red-500/90 text-white hover:bg-red-500' : 'element-primary hover:bg-[var(--element-hover)]'}`}>
              {busy ? '⛔ 取消' : '运行'}
            </button>
          </div>
        </div>
      </div>
      {/* 信任解析器弹窗（借鉴 trust_resolver.rs 的 RequireApproval → AutoTrust 流转） */}
      {trustDialogOpen && projectRoot && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-6" onClick={() => setTrustDialogOpen(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white dark:bg-stone-900 border border-neutral-200 dark:border-stone-700 shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-neutral-200 dark:border-stone-700 flex items-center gap-2">
              <span className="text-base">{isTrusted ? '🛡' : '⚠'}</span>
              <span className="text-sm font-semibold text-neutral-800 dark:text-stone-100">{isTrusted ? '管理项目信任' : '信任此项目？'}</span>
            </div>
            <div className="px-4 py-4 text-xs text-neutral-600 dark:text-stone-300 space-y-2 leading-relaxed">
              <div>项目路径：</div>
              <div className="font-mono text-[11px] bg-neutral-100 dark:bg-stone-800 rounded px-2 py-1 break-all">{projectRoot}</div>
              {!isTrusted ? (
                <>
                  <div>未信任模式下，AI 代理的 <code className="px-1 bg-neutral-100 dark:bg-stone-800 rounded">&lt;write&gt;</code> / <code className="px-1 bg-neutral-100 dark:bg-stone-800 rounded">&lt;edit&gt;</code> 与非只读 <code className="px-1 bg-neutral-100 dark:bg-stone-800 rounded">&lt;shell&gt;</code> 将被拦截，仅允许只读探索（<code className="px-1 bg-neutral-100 dark:bg-stone-800 rounded">&lt;read&gt;</code> / <code className="px-1 bg-neutral-100 dark:bg-stone-800 rounded">&lt;ast&gt;</code> / 只读命令）。</div>
                  <div className="text-amber-600 dark:text-amber-400">信任后将允许 AI 修改文件与执行构建/测试命令。仅对你确认安全的项目根目录授权。</div>
                </>
              ) : (
                <div className="text-emerald-600 dark:text-emerald-400">此项目已信任。撤销信任后将立即恢复只读模式（不影响已落盘的改动）。</div>
              )}
            </div>
            <div className="px-4 py-3 border-t border-neutral-200 dark:border-stone-700 flex items-center justify-end gap-2">
              <button onClick={() => setTrustDialogOpen(false)} className="btn-press px-3 py-1.5 rounded-lg text-xs text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/5">关闭</button>
              {isTrusted ? (
                <button onClick={handleUntrust} className="btn-press px-3 py-1.5 rounded-lg text-xs bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20">撤销信任</button>
              ) : (
                <button onClick={handleTrust} className="btn-press px-3 py-1.5 rounded-lg text-xs text-white element-primary hover:bg-[var(--element-hover)]">🛡 信任此项目</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// 改动摘要面板：非阻塞、默认折叠在编辑器底部。改动已由 onAgentChanges 自动保留并落盘，
// 这里仅作「已保存」的折叠摘要，供用户随时展开查看 diff / 撤销 / 回滚，不阻断后续操作。
function AgentReviewOverlay({
  changes, originals, verdict, onKeep, onUndo, onKeepAll, onUndoAll, onFinish, onRollback,
}: {
  changes: AgentEdit[];
  originals: Record<string, string>;
  verdict?: string | null;
  onKeep: (c: AgentEdit) => void;
  onUndo: (c: AgentEdit) => void;
  onKeepAll: () => void;
  onUndoAll: () => void;
  onFinish: () => void;
  onRollback: () => void;
}) {
  const [panelOpen, setPanelOpen] = useState(false); // 默认折叠（不立刻占用注意力）
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const kept = changes.filter((c) => c.status === 'kept').length;
  const undone = changes.filter((c) => c.status === 'undone').length;
  const blocked = changes.filter((c) => c.status === 'blocked' || c.status === 'failed').length;
  return (
    <div className="shrink-0 border-t border-neutral-200/70 dark:border-stone-700/70 bg-neutral-100/50 dark:bg-stone-800/40">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          onClick={() => setPanelOpen((v) => !v)}
          className="btn-press flex items-center gap-1 text-xs font-medium text-neutral-700 dark:text-stone-200"
          title="展开 / 折叠本次改动"
        >
          <span className={`inline-block transition-transform ${panelOpen ? 'rotate-90' : ''}`}>▶</span>
          本次改动（{changes.length} 处{blocked ? `，其中 ${blocked} 处未应用` : ''}）
        </button>
        <span className="text-[11px] text-neutral-400 dark:text-stone-500">{kept > 0 ? `已自动保存 ${kept} 处` : '无改动'}</span>
        <span className="flex-1" />
        {undone > 0 && (
          <button onClick={onKeepAll} className="btn-press px-2 py-0.5 rounded-md text-[11px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20">全部保留</button>
        )}
        {kept > 0 && (
          <button onClick={onUndoAll} className="btn-press px-2 py-0.5 rounded-md text-[11px] bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20">全部撤销</button>
        )}
        <button onClick={onRollback} className="btn-press px-2 py-0.5 rounded-md text-[11px] bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20">回滚本次</button>
        <button onClick={onFinish} className="btn-press px-2 py-0.5 rounded-md text-[11px] text-neutral-400 dark:text-stone-500 hover:bg-black/5 dark:hover:bg-white/5" title="收起摘要">×</button>
      </div>
      {panelOpen && (
        <div className="max-h-56 overflow-auto divide-y divide-neutral-200/60 dark:divide-stone-700/60 border-t border-neutral-200/50 dark:border-stone-700/50">
          {verdict && (
            <div className={`px-3 py-1.5 text-[11px] whitespace-pre-wrap ${verdict.startsWith('✅') ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'}`}>
              {verdict}
            </div>
          )}
          {changes.map((c) => (
            <div key={c.id} className="p-2">
              <div className="flex items-center gap-2">
                <span className="text-sm truncate flex-1 text-neutral-700 dark:text-stone-200" title={c.path}>{c.isNew ? '🆕 ' : ''}{baseName(c.path)}</span>
                <span className={`text-[11px] px-1.5 py-0.5 rounded ${c.status === 'kept' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : c.status === 'undone' ? 'bg-red-500/15 text-red-600 dark:text-red-400' : (c.status === 'failed' || c.status === 'blocked') ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400' : 'bg-neutral-200/70 dark:bg-stone-700 text-neutral-500 dark:text-stone-400'}`}>
                  {c.status === 'kept' ? '已保存' : c.status === 'undone' ? '已撤销' : c.status === 'failed' ? '定位失败' : c.status === 'blocked' ? '已拦截' : '待决定'}
                </span>
                <button onClick={() => setOpen((o) => ({ ...o, [c.id]: !o[c.id] }))} className="btn-press text-[11px] text-neutral-400 hover:text-neutral-700 dark:hover:text-stone-200">{open[c.id] ? '隐藏' : '查看'}</button>
                {c.status !== 'kept' && c.status !== 'failed' && c.status !== 'blocked' && (
                  <button onClick={() => onKeep(c)} className="btn-press px-2 py-0.5 rounded text-[11px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20">保留</button>
                )}
                {c.status !== 'undone' && c.status !== 'blocked' && (
                  <button onClick={() => onUndo(c)} className="btn-press px-2 py-0.5 rounded text-[11px] bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20">撤销</button>
                )}
              </div>
              <div className="text-[11px] text-neutral-400 dark:text-stone-500 truncate mt-0.5">{c.path}</div>
              {(c.status === 'failed' || c.status === 'blocked') && c.error && <div className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">{c.error}</div>}
              {open[c.id] && c.status !== 'blocked' && <EditHunk original={originals[c.path] ?? ''} edit={c} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// 单处增删的可视化：红底（旧/将被删） + 绿底（新/将新增），并展示两侧上下文
function EditHunk({ original, edit }: { original: string; edit: AgentEdit }) {
  if (edit.isNew) {
    return (
      <pre className="mt-2 max-h-72 overflow-auto text-xs rounded-lg p-2 bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 dark:text-emerald-300 whitespace-pre">{edit.new}</pre>
    );
  }
  const idx = original.indexOf(edit.old);
  if (idx < 0) {
    return (
      <div className="mt-2 space-y-1">
        <div className="text-[11px] text-amber-600 dark:text-amber-400">⚠ 未能在文件中定位该片段（可能已变动），保存时该处会失败。</div>
        {edit.old && <pre className="max-h-44 overflow-auto text-xs rounded-lg p-2 bg-red-500/10 text-red-600 dark:text-red-400 whitespace-pre">{edit.old}</pre>}
        {edit.new && <pre className="max-h-44 overflow-auto text-xs rounded-lg p-2 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 whitespace-pre">{edit.new}</pre>}
      </div>
    );
  }
  const before = original.slice(0, idx);
  const after = original.slice(idx + edit.old.length);
  const ctxBefore = before.split('\n').slice(-2).join('\n');
  const ctxAfter = after.split('\n').slice(0, 2).join('\n');
  const oldLines = edit.old.split('\n');
  const newLines = edit.new.split('\n');
  return (
    <pre className="mt-2 max-h-72 overflow-auto text-xs rounded-lg p-2 bg-neutral-50 dark:bg-stone-950 border border-neutral-200 dark:border-stone-700 whitespace-pre">
      {ctxBefore && <div className="text-neutral-400 dark:text-stone-500">{ctxBefore}</div>}
      {oldLines.map((l, i) => (
        <div key={'o' + i} className="bg-red-500/10 text-red-600 dark:text-red-400"><span className="select-none inline-block w-4 text-red-400/70">-</span>{l}</div>
      ))}
      <div className="text-neutral-400 dark:text-stone-500 py-0.5">↓ 替换为</div>
      {newLines.map((l, i) => (
        <div key={'n' + i} className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"><span className="select-none inline-block w-4 text-emerald-500/70">+</span>{l}</div>
      ))}
      {ctxAfter && <div className="text-neutral-400 dark:text-stone-500">{ctxAfter}</div>}
    </pre>
  );
}

window.__PLUGIN_REGISTRY__.register({
  id: 'ide',
  name: 'IDE',
  iconName: 'Code',
  kind: 'module',
  visible: false,
  parent: 'niaoluo',
  category: '开发',
  desc: '轻量代码编辑器：CodeMirror 6 多语言高亮，多标签/查找替换/命令面板/文件树',
  component: IdeEditor,
  sidebar: IdeSidebar,
});
