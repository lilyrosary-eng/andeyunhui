/// <reference path="../../../global.d.ts" />
// 茑萝 · IDE 子插件（专业代码编辑器）
// 内核：CodeMirror 6（按需从 external-deps/niaoluo/ide/codemirror 加载，不进插件包，保持本体轻量）。
// 功能：多标签页、查找/替换、状态栏、最近文件、主题/自动换行切换。
// 不提供降级编辑器：若内核加载失败，给出明确错误与构建提示。
const React = window.__HOST_REACT__;
const hostApi = window.__HOST_API__;
const registry = (window as any).__PLUGIN_REGISTRY__;
const { useState, useRef, useCallback, useEffect } = React;

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
let cmPromise: Promise<CM> | null = null;
function loadCM(): Promise<CM> {
  if (cmPromise) return cmPromise;
  cmPromise = (async () => {
    const w = window as any;
    if (w.__EXT_CM__) return w.__EXT_CM__ as CM;
    const code = await hostApi.invoke<string>('read_external_dep_file', { relativePath: 'niaoluo/ide/codemirror/index.js' });
    if (!code) throw new Error('未找到 CodeMirror 依赖文件（external-deps/niaoluo/ide/codemirror/index.js）');
    const fn = new Function(code);
    fn();
    if (!w.__EXT_CM__) throw new Error('CodeMirror 依赖已读取但挂载失败（window.__EXT_CM__ 未定义）');
    return w.__EXT_CM__ as CM;
  })();
  return cmPromise;
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
}: {
  cm: CM;
  tab: Tab;
  theme: 'auto' | 'dark' | 'light';
  wrap: boolean;
  onViewReady: (v: any) => void;
  onChange: (doc: string) => void;
  onCursor: (line: number, col: number) => void;
  suppressDirtyRef: React.MutableRefObject<boolean>;
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

  const effectiveLang = tab.lang === 'auto' ? (tab.path ? langFromPath(tab.path) : 'plaintext') : tab.lang;

  // 挂载一次
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    langCpt.current = new cm.Compartment();
    themeCpt.current = new cm.Compartment();
    wrapCpt.current = new cm.Compartment();
    selCpt.current = new cm.Compartment();
    const resolvedTheme = theme === 'auto' ? (isDark() ? 'dark' : 'light') : theme;
    const view = new cm.EditorView({
      doc: tab.doc,
      parent: host,
      extensions: [
        cm.basicSetup,
        cm.keymap.of([cm.indentWithTab]),
        cm.search(),
        // 注意：searchKeymap 是一组裸 KeyBinding（{key,run} 普通对象），
        // 必须用 keymap.of 包裹成合法扩展，否则 CM6 报 "Unrecognized extension value ([object Object])"。
        cm.keymap.of(cm.searchKeymap),
        langCpt.current.of(cmLang(cm, effectiveLang)),
        themeCpt.current.of(
          resolvedTheme === 'dark'
            ? cm.oneDark
            : [cm.lightTheme, cm.syntaxHighlighting(cm.defaultHighlightStyle)],
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

  return <div ref={ref} className="flex-1 h-full overflow-hidden text-left" />;
}

// ============ 跨组件共享：侧边栏 → 编辑器打开文件 ============
let addFileTab: ((path: string, content: string) => void) | null = null;

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
  const [wrap, setWrap] = useState<boolean>(true);
  const [recent, setRecent] = useState<string[]>([]);
  const [recentOpen, setRecentOpen] = useState(false);
  const [cursor, setCursor] = useState<{ line: number; col: number }>({ line: 1, col: 1 });

  // 多级嵌套：AI 编程（ai）是 IDE 的子插件，由 IDE 内部以「右侧对话抽屉」形式呈现，
  // 与编辑器并排（Cursor / Codex / Claude Code 风格），而非整面板切换。
  const [aiOpen, setAiOpen] = useState(false);
  const [aiWidth, setAiWidth] = useState(420);
  const [hasAi, setHasAi] = useState(false);

  const viewRef = useRef<any>(null);
  const suppressDirty = useRef<boolean>(false);
  const tabsRef = useRef<Tab[]>([]);
  tabsRef.current = tabs;
  const activeTab = tabs.find((t) => t.id === activeId) || null;

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

  const setTabDoc = useCallback((id: string, doc: string, dirty: boolean) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, doc, dirty } : t)));
  }, []);

  const onChange = useCallback((doc: string) => {
    if (!activeId) return;
    setTabs((prev) => prev.map((t) => (t.id === activeId ? { ...t, doc, dirty: true } : t)));
    setSavedFlash(false);
  }, [activeId]);

  // 注册侧边栏打开文件回调
  useEffect(() => {
    addFileTab = (p, content) => {
      const id = 'f_' + Date.now().toString(36);
      setTabs((prev) => [...prev, { id, path: p, name: baseName(p), doc: content, lang: 'auto', dirty: false }]);
      setRecent((prev) => [p, ...prev.filter((x) => x !== p)].slice(0, 12));
      activateTab(id);
      setStatus('已打开：' + baseName(p));
    };
    return () => { addFileTab = null; };
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

  const find = useCallback(() => { if (viewRef.current && cm) cm.openSearchPanel(viewRef.current); }, [cm]);
  const replace = useCallback(() => { if (viewRef.current && cm) cm.openSearchPanel(viewRef.current); }, [cm]);

  // AI 编程右侧抽屉的拖拽调宽（所有 hook 之后、任何提前返回之前，保持 hooks 顺序稳定）
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

  const aiChild = registry && registry.getChildren
    ? registry.getChildren('ide').find((c: any) => c.id === 'ai')
    : null;
  const AiComp = aiChild?.component as React.ComponentType<any> | undefined;

  const effectiveLang = activeTab ? (activeTab.lang === 'auto' ? (activeTab.path ? langFromPath(activeTab.path) : 'plaintext') : activeTab.lang) : 'plaintext';

  const toolbar = (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-black/20 bg-[#252526] text-sm flex-wrap">
      <button onClick={newDoc} className="btn-press px-2.5 py-1 rounded-lg bg-[#37373d] hover:bg-[#45454d] text-white" title="新建">新建</button>
      <button onClick={openFile} className="btn-press px-2.5 py-1 rounded-lg bg-[#0e639c] hover:bg-[#1177bb] text-white font-medium">打开</button>
      <button onClick={save} className="btn-press px-2.5 py-1 rounded-lg bg-[#37373d] hover:bg-[#45454d] text-white">保存</button>
      <button onClick={saveAs} className="btn-press px-2.5 py-1 rounded-lg bg-[#37373d] hover:bg-[#45454d] text-white">另存为</button>
      <span className="w-px h-5 bg-white/10 mx-0.5" />
      <button onClick={find} className="btn-press px-2.5 py-1 rounded-lg bg-[#37373d] hover:bg-[#45454d] text-white">查找</button>
      <button onClick={replace} className="btn-press px-2.5 py-1 rounded-lg bg-[#37373d] hover:bg-[#45454d] text-white">替换</button>
      <span className="w-px h-5 bg-white/10 mx-0.5" />
      <div className="relative">
        <button onClick={() => setRecentOpen((o) => !o)} className="btn-press px-2.5 py-1 rounded-lg bg-[#37373d] hover:bg-[#45454d] text-white" title="最近打开的文件">最近{recentOpen ? '▴' : '▾'}</button>
        {recentOpen && recent.length > 0 && (
          <div className="absolute z-30 mt-1 w-72 max-h-64 overflow-auto rounded-lg bg-[#2d2d30] border border-white/10 shadow-xl py-1">
            {recent.map((p) => (
              <button key={p} onClick={async () => {
                const content = await hostApi.invoke<string>('read_text_file', { path: p });
                const id = 'f_' + Date.now().toString(36);
                setTabs((prev) => [...prev, { id, path: p, name: baseName(p), doc: content, lang: 'auto', dirty: false }]);
                activateTab(id);
                setStatus('已打开：' + baseName(p));
                setRecentOpen(false);
              }} className="block w-full text-left px-3 py-1.5 text-xs text-neutral-300 hover:bg-white/10 truncate">{p}</button>
            ))}
          </div>
        )}
      </div>
      <span className="w-px h-5 bg-white/10 mx-0.5" />
      <label className="text-neutral-300 text-xs">语言</label>
      <select value={activeTab ? activeTab.lang : 'plaintext'} onChange={(e) => {
        if (activeTab) setTabs((prev) => prev.map((t) => (t.id === activeTab.id ? { ...t, lang: e.target.value } : t)));
      }} className="bg-[#3c3c3c] text-white text-xs rounded px-2 py-1 border border-white/10 outline-none">
        {LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
      </select>
      <button onClick={() => setWrap((w) => !w)} className={`btn-press px-2.5 py-1 rounded-lg text-white text-xs ${wrap ? 'bg-[#0e639c]' : 'bg-[#37373d] hover:bg-[#45454d]'}`}>自动换行</button>
      <button onClick={() => setTheme((t) => (t === 'auto' ? 'dark' : t === 'dark' ? 'light' : 'auto'))} className="btn-press px-2.5 py-1 rounded-lg bg-[#37373d] hover:bg-[#45454d] text-white text-xs">
        {theme === 'auto' ? '跟随' : theme === 'dark' ? '深色' : '浅色'}
      </button>
      {hasAi && (
        <button onClick={() => setAiOpen((o) => !o)} className={`btn-press px-2.5 py-1 rounded-lg text-white text-xs font-medium ${aiOpen ? 'bg-[#1177bb]' : 'bg-[#0e639c] hover:bg-[#1177bb]'}`} title="AI 编程（右侧对话面板）">AI 编程</button>
      )}
      <span className="flex-1" />
      <span className={`text-xs ${savedFlash ? 'text-emerald-400' : 'text-amber-400'}`}>{status}</span>
    </div>
  );

  if (engine === 'error') {
    return (
      <div className="flex-1 flex flex-col h-full bg-[#1e1e1e] text-[#d4d4d4]">
        <div className="px-4 py-3 border-b border-white/10 text-sm font-medium">IDE · 编辑器内核加载失败</div>
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-8 text-center">
          <div className="text-amber-400 text-sm">{errorMsg}</div>
          <pre className="text-left text-xs text-neutral-400 bg-black/30 rounded-lg p-3 max-w-md overflow-auto">node scripts/build-external-deps.mjs</pre>
          <button onClick={() => { setEngine('loading'); cmPromise = null; loadCM().then((api) => { setCm(api); setEngine('cm'); }).catch((e: Error) => { setErrorMsg(e.message); setEngine('error'); }); }} className="btn-press px-4 py-1.5 rounded-lg bg-[#0e639c] hover:bg-[#1177bb] text-white text-sm">重试</button>
        </div>
      </div>
    );
  }

  if (engine === 'loading') {
    return (
      <div className="flex-1 flex flex-col h-full bg-[#1e1e1e] text-[#d4d4d4]">
        {toolbar}
        <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm">正在加载编辑器内核…</div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-[#1e1e1e] text-[#d4d4d4]">
      {toolbar}
      {/* 标签页：左侧可滚动标签区 + 右侧常驻「关闭全部」按钮 */}
      {tabs.length > 0 && (
        <div className="flex items-stretch bg-[#252526] border-b border-black/30">
          <div className="flex items-stretch overflow-x-auto flex-1 min-w-0">
            {tabs.map((t) => (
              <div key={t.id}
                onClick={() => activateTab(t.id)}
                className={`group flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer border-r border-black/30 whitespace-nowrap ${t.id === activeId ? 'bg-[#1e1e1e] text-white' : 'text-neutral-400 hover:bg-white/5'}`}>
                <span className={t.dirty ? 'w-2 h-2 rounded-full bg-amber-400' : 'w-2 h-2 rounded-full bg-transparent'} />
                <span className="max-w-40 truncate">{t.name}</span>
                <button onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                  className="text-neutral-500 hover:text-white hover:bg-white/10 rounded w-4 h-4 flex items-center justify-center shrink-0" title="关闭">✕</button>
              </div>
            ))}
          </div>
          <button onClick={closeAllTabs}
            className="btn-press shrink-0 px-2.5 flex items-center gap-1 text-xs text-neutral-400 hover:text-white hover:bg-white/10 border-l border-black/30"
            title="关闭全部标签页">
            <span className="text-sm leading-none">✕</span>
            <span>全部</span>
          </button>
        </div>
      )}
      {/* 编辑器 + AI 编程右侧抽屉（并排，Cursor / Codex / Claude Code 风格） */}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 h-full overflow-hidden min-w-0">
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
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-neutral-600 text-sm">打开文件或新建文档开始编辑</div>
          )}
        </div>
        {aiOpen && hasAi && (
          <div
            className="relative shrink-0 h-full flex flex-col border-l border-black/30 bg-[#1e1e1e]"
            style={{ width: aiWidth }}
          >
            {/* 拖拽调宽手柄 */}
            <div
              onMouseDown={startAiResize}
              title="拖动调整宽度"
              className="absolute left-0 top-0 h-full w-1.5 -ml-0.5 cursor-col-resize z-20 hover:bg-[#0e639c]/60 transition-colors"
            />
            <div className="flex-1 min-h-0 overflow-hidden">
              {AiComp ? (
                <AiComp docked onClose={() => setAiOpen(false)} />
              ) : (
                <div className="flex-1 flex items-center justify-center text-neutral-600 text-sm">AI 编程模块未加载</div>
              )}
            </div>
          </div>
        )}
      </div>
      {/* 状态栏 */}
      <div className="flex items-center gap-4 px-4 py-1 bg-[#007acc] text-white text-[11px]">
        <span>{activeTab ? (activeTab.path || '未命名') : '无文件'}</span>
        <span className="flex-1" />
        <span>{effectiveLang.toUpperCase()}</span>
        <span>UTF-8</span>
        <span>行 {cursor.line}，列 {cursor.col}</span>
        <span>{savedFlash ? '已保存' : '未保存'}</span>
      </div>
    </div>
  );
}

// ============ 项目目录侧边栏（文件树） ============
type DirEntry = { name: string; path: string; is_dir: boolean };

// 目录优先、同类按名称排序（不改后端顺序，仅前端展示）
function sortEntries(list: DirEntry[]): DirEntry[] {
  return [...list].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
}

function IdeSidebar() {
  const [root, setRoot] = useState<string | null>(null);
  // 根级条目
  const [rootEntries, setRootEntries] = useState<DirEntry[]>([]);
  // 每个已展开目录的子项（按目录 path 索引），实现真正的层级嵌套而非「堆在下面」
  const [childrenMap, setChildrenMap] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [folderError, setFolderError] = useState<string | null>(null);

  const pickFolder = async () => {
    try {
      const picked = await hostApi.invoke<string | null>('pick_directory', {});
      const dir = picked ? picked.trim() : '';
      if (!dir) return;
      setRoot(dir);
      setFolderError(null);
      const list = await hostApi.invoke<DirEntry[]>('list_directory', { path: dir });
      setRootEntries(sortEntries(list));
      setChildrenMap({});
      setExpanded(new Set());
    } catch (e) {
      console.error('[IDE] 打开文件夹失败:', e);
      // 路径不存在（os error 3 等）时显式提示用户，而非仅留控制台报错
      setFolderError('打开文件夹失败：' + (e as Error).message);
    }
  };

  const toggleDir = async (dirPath: string) => {
    if (expanded.has(dirPath)) {
      setExpanded((prev) => { const n = new Set(prev); n.delete(dirPath); return n; });
      return;
    }
    // 展开：已缓存则直接展开，否则先加载子项
    if (!childrenMap[dirPath]) {
      setLoading((prev) => new Set([...prev, dirPath]));
      try {
        const list = await hostApi.invoke<DirEntry[]>('list_directory', { path: dirPath });
        setChildrenMap((prev) => ({ ...prev, [dirPath]: sortEntries(list) }));
      } catch (e) {
        setFolderError('展开目录失败：' + (e as Error).message);
        setLoading((prev) => { const n = new Set(prev); n.delete(dirPath); return n; });
        return;
      }
      setLoading((prev) => { const n = new Set(prev); n.delete(dirPath); return n; });
    }
    setExpanded((prev) => new Set([...prev, dirPath]));
  };

  const openFile = async (p: string) => {
    if (!addFileTab) return;
    try {
      const content = await hostApi.invoke<string>('read_text_file', { path: p });
      addFileTab(p, content);
    } catch (e) {
      console.error('[IDE] 打开文件失败:', p, e);
    }
  };

  // 递归渲染：目录展开时其子项作为「子集」缩进显示在该目录正下方
  const renderLevel = (entries: DirEntry[], depth: number): React.ReactNode =>
    entries.map((e) => (
      <React.Fragment key={e.path}>
        <div
          onClick={() => (e.is_dir ? toggleDir(e.path) : openFile(e.path))}
          style={{ paddingLeft: 8 + depth * 12 }}
          className={`flex items-center gap-1.5 pr-3 py-1 cursor-pointer text-xs transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${
            e.is_dir ? 'text-neutral-600 dark:text-stone-300' : 'text-neutral-500 dark:text-stone-400'
          }`}
        >
          <span className="w-3 text-center text-[11px] shrink-0">
            {e.is_dir ? (loading.has(e.path) ? '…' : expanded.has(e.path) ? '▾' : '▸') : ''}
          </span>
          <span className="shrink-0">{e.is_dir ? '📁' : '📄'}</span>
          <span className="flex-1 truncate">{e.name}</span>
        </div>
        {e.is_dir && expanded.has(e.path) && childrenMap[e.path] && (
          childrenMap[e.path].length === 0 ? (
            <div style={{ paddingLeft: 8 + (depth + 1) * 12 }} className="pr-3 py-1 text-[11px] text-neutral-300 dark:text-stone-600">（空）</div>
          ) : (
            renderLevel(childrenMap[e.path], depth + 1)
          )
        )}
      </React.Fragment>
    ));

  return (
    <div className="flex flex-col h-full">
      <div className="px-2 py-2 border-b border-neutral-200/30 dark:border-stone-700/30 shrink-0">
        <button onClick={pickFolder}
          className="w-full py-1.5 rounded-lg text-xs font-medium bg-[var(--element-bg)]/10 text-[var(--element-bg)] hover:bg-[var(--element-bg)]/20 transition-colors">
          {root ? baseName(root) : '打开文件夹'}
        </button>
        {folderError && (
          <div className="mt-1 px-2 py-1 text-[11px] text-red-500 dark:text-red-400 bg-red-500/10 rounded">
            {folderError}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-auto min-h-0">
        {!root ? (
          <div className="px-2 py-4 text-xs text-neutral-400 dark:text-stone-500 text-center">选择项目目录开始浏览</div>
        ) : rootEntries.length === 0 ? (
          <div className="px-2 py-4 text-xs text-neutral-400 dark:text-stone-500 text-center">目录为空</div>
        ) : (
          <div className="py-1">{renderLevel(rootEntries, 0)}</div>
        )}
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
  desc: '轻量代码编辑器：CodeMirror 6 多语言高亮，多标签/查找替换/最近文件',
  component: IdeEditor,
  sidebar: IdeSidebar,
});
