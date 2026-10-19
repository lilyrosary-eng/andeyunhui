/// <reference path="../../../global.d.ts" />
// 茑萝 · IDE 子插件（专业代码编辑器）
// 模块化拆分（边做功能边拆分）：explorer/commandPalette 抽到 modules/，通过 ideShared 通信
import { ideShared } from './modules/shared';
import { IdeSidebar } from './modules/ideSidebar';
import { CommandPalette, type PaletteCommand } from './modules/commandPalette';
// Agent 工具系统增强（阶段二）：权限引擎 + 工具注册表 + 计划模式 + 子代理
// 工具元数据与系统提示词（generateToolSystemPrompt/BUILTIN_TOOLS）暂用本地 SYSTEM_PROMPT，仅引入子代理运行器
// 权限引擎：逐工具规则（alwaysAllow/alwaysAsk/alwaysDeny）覆盖 PermissionMode 默认行为
// 技能系统（阶段五）：SKILL.md 渐进式披露——索引注入 system prompt + <skill> 工具按需加载全文
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
const { useState, useRef, useCallback, useEffect, useMemo } = React;



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








// 解码 XML 实体，让指令属性（path / command）里能安全携带引号等字符，
// 解决「命令里直接写双引号会被截断」的问题（前端约定：双引号属性内用 &quot; 转义）。





/** 编辑器标签页（被 IdeEditor 的状态与保存逻辑使用）。 */
interface Tab {
  id: string;
  path: string; // 空字符串表示未保存的新文档
  name: string;
  doc: string;
  lang: string; // 用户/自动选定的语言 id
  dirty: boolean;
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




// ============ Prompt Cache 前端层（借鉴 claw-code-main/api/src/prompt_cache.rs） ============
// 两层缓存：
//   1. completionCache：前端请求指纹缓存（SHA-256），命中直接重放，TTL 30s。
//      仅用于 cacheable=true 的确定性调用（如 summarizeHistory 重试、相同 prompt 二次提交）。
//   2. providerCacheStats：解析 ai-done 事件的 usage 字段，统计 provider 侧 cache_read/cache_creation tokens。
//      对应 prompt_cache.rs 的 PromptCacheStats（tracked_requests / cache_hits / cache_read_input_tokens…）。



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

  // 2026-10-19：IDE 主窗口的 AI 面板（右侧常驻列 + 浮出窗）已**移除**，
  // AI 统一走黄金棋盘浮岛的「编程」标签页（浮岛已是独立执行器，不依赖本模块加载）。
  // 保留的 aiProfiles / aiActiveId 只服务编辑器内的行内补全（tabUseAi → aiCompleteText）。

  // 当前打开的项目根（供 AI 编程关联，#12）
  const [projRoot, setProjRoot] = useState<string | null>(ideShared.projectRoot);

  // 每个子模块自己的设置（#13）：IDE 模块设置，localStorage 持久化
  const [ideSettings, setIdeSettings] = useState<IdeSettingsData>(loadIdeSettings);
  const [showIdeSettings, setShowIdeSettings] = useState(false);

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

  // 监听「打开项目」事件，同步当前项目根（#12）
  useEffect(() => {
    const h = (e: Event) => setProjRoot((e as CustomEvent<string>).detail);
    window.addEventListener('ide-project-changed', h);
    return () => window.removeEventListener('ide-project-changed', h);
  }, []);

  // 把当前项目根写进 localStorage，供**黄金棋盘浮岛的 AI 编程**读取。
  //
  // 为什么走 localStorage 而不是事件：浮岛已经是独立执行器（2026-10-19 方案 B），
  // 它不该依赖 IDE 模块是否加载；而 localStorage 同源，IDE 没开时浮岛仍能拿到上次的路径。
  // 失败只 warn —— 写不进去顶多让浮岛退回"未关联项目"，不影响 IDE 本身。
  useEffect(() => {
    try {
      if (projRoot) localStorage.setItem('ide:lastProjectRoot', projRoot);
    } catch (e) {
      console.warn('[IDE] 写入 ide:lastProjectRoot 失败（浮岛将无法自动关联项目）:', e);
    }
  }, [projRoot]);

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
        {/* 2026-10-19：AI 面板已移除 —— 编程对话统一走黄金棋盘浮岛的「编程」标签页。
            编辑器仍保留行内补全（tabUseAi），那部分不依赖这块 UI。 */}
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

      {/* 2026-10-19：原「AI 模式（普通对话 / 自主编辑）」开关已移除 ——
          它唯一的作用是切换右侧 AI 面板的形态（常驻列 vs 浮出窗），而那个面板已删。
          留着只会让用户以为还能切。AI 现在统一在黄金棋盘浮岛里选「编程」标签，
          对话/代理两种模式由浮岛自己提供。 */}

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
