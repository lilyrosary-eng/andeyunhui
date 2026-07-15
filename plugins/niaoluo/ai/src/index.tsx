/// <reference path="../../../global.d.ts" />
// 茑萝 · IDE · AI 编程 子插件（Cursor / Claude Code 风格）
//
// 多级嵌套：niaoluo（茑萝）→ ide（IDE）→ ai（AI 编程）。本插件是 IDE 的子插件，
// 由 IDE 主组件在内部以「AI 编程」视图渲染，不单独出现在导航栏。
// 定位：AI「编程」功能属于「IDE」子集（本插件），但 AI「能力」本身属于全局——
// LLM 调用统一走 Rust 后端命令 ai_chat / ai_get_profiles / ai_set_profiles（沙箱屏蔽了 fetch，
// 且配置全局持久化，任意插件都可复用同一份 AI 能力）。
//
// 模型配置统一在「全局设置 → 模型」完成（可配置多份档案）；本面板不再内置设置，
// 仅在输入框旁提供一个下拉框，直接选用已配置的模型档案。
const React = window.__HOST_REACT__;
const hostApi = window.__HOST_API__;
const { useState, useRef, useEffect, useCallback } = React;

interface AiProfile {
  id: string;
  name: string;
  model: string;
  base_url: string;
  api_key: string;
  system_prompt?: string | null;
}

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  error?: boolean;
}

interface CtxFile {
  path: string;
  name: string;
  content: string;
}

// 项目目录条目（用于「关联项目」浏览）
interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

// 递归收集项目源码时跳过的目录（取其巧，避免把依赖/构建产物塞进上下文）
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', 'out', '.next', '.nuxt',
  '.output', '.svelte-kit', 'venv', '.venv', '__pycache__', 'bin', 'obj',
  '.idea', '.vscode', 'coverage', '.turbo', '.cache', 'release',
]);
// 视为源码/文本、可纳入上下文的扩展名
const CODE_EXT = new Set([
  'js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs', 'json', 'py', 'rs', 'go',
  'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte', 'md', 'txt', 'log',
  'c', 'cpp', 'h', 'hpp', 'java', 'kt', 'swift', 'sh', 'bash', 'zsh',
  'toml', 'yaml', 'yml', 'xml', 'ini', 'cfg', 'sql', 'php', 'rb', 'lua',
  'dart', 'ex', 'exs', 'nim', 'zig', 'proto',
]);
function extOf(p: string): string {
  return p.split('.').pop()?.toLowerCase() || '';
}

interface Conversation {
  id: string;
  title: string;
  messages: Msg[];
}

const MAX_CTX_CHARS = 20000;

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

// 「关联项目」文件浏览器（模块级，避免父组件重渲染时反复挂载）：浏览当前打开的项目目录，点选文件加入上下文（#12）
function ProjectBrowser({ root, onClose, onPick, onAttachAll }: {
  root: string;
  onClose: () => void;
  onPick: (p: string) => void;
  onAttachAll: () => void;
}) {
  const [rootEntries, setRootEntries] = useState<DirEntry[] | null>(null);
  const [childrenMap, setChildrenMap] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());

  useEffect(() => {
    hostApi.invoke<DirEntry[]>('list_directory', { path: root })
      .then((list) => setRootEntries(list.filter((e) => !(e.is_dir && SKIP_DIRS.has(e.name)))))
      .catch(() => setRootEntries([]));
  }, [root]);

  const toggleDir = async (dirPath: string) => {
    if (expanded.has(dirPath)) {
      setExpanded((prev) => { const n = new Set(prev); n.delete(dirPath); return n; });
      return;
    }
    if (!childrenMap[dirPath]) {
      setLoading((prev) => new Set([...prev, dirPath]));
      try {
        const list = await hostApi.invoke<DirEntry[]>('list_directory', { path: dirPath });
        setChildrenMap((prev) => ({ ...prev, [dirPath]: list.filter((e) => !(e.is_dir && SKIP_DIRS.has(e.name))) }));
      } catch { /* ignore */ }
      setLoading((prev) => { const n = new Set(prev); n.delete(dirPath); return n; });
    }
    setExpanded((prev) => new Set([...prev, dirPath]));
  };

  const renderLevel = (entries: DirEntry[] | null, depth: number): React.ReactNode => {
    if (entries === null) return <div className="px-2 py-1 text-[11px] text-neutral-400">读取中…</div>;
    if (entries.length === 0) return <div className="px-2 py-1 text-[11px] text-neutral-300 dark:text-stone-600">（空）</div>;
    return entries.map((e) => (
      <React.Fragment key={e.path}>
        <div
          onClick={() => (e.is_dir ? toggleDir(e.path) : onPick(e.path))}
          style={{ paddingLeft: 8 + depth * 12 }}
          className={`flex items-center gap-1.5 pr-3 py-1 cursor-pointer text-xs transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${e.is_dir ? 'text-neutral-600 dark:text-stone-300' : 'text-neutral-500 dark:text-stone-400'}`}
        >
          <span className="w-3 text-center text-[11px] shrink-0">
            {e.is_dir ? (loading.has(e.path) ? '…' : expanded.has(e.path) ? '▾' : '▸') : ''}
          </span>
          <span className="shrink-0">{e.is_dir ? '📁' : '📄'}</span>
          <span className="flex-1 truncate">{e.name}</span>
        </div>
        {e.is_dir && expanded.has(e.path) && childrenMap[e.path] && renderLevel(childrenMap[e.path], depth + 1)}
      </React.Fragment>
    ));
  };

  return (
    <div className="absolute bottom-full right-0 mb-1 z-30 w-64 h-64 rounded-lg border border-neutral-200 dark:border-stone-700 bg-white dark:bg-stone-800 shadow-lg flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-neutral-200 dark:border-stone-700 bg-neutral-100 dark:bg-stone-800 text-xs shrink-0">
        <span className="truncate text-neutral-600 dark:text-stone-300">📁 {baseName(root)}</span>
        <button onClick={onClose} className="text-neutral-400 hover:text-red-500 shrink-0 px-1">✕</button>
      </div>
      <div className="flex-1 overflow-auto min-h-0 py-1">
        {renderLevel(rootEntries, 0)}
      </div>
      <button onClick={onAttachAll} className="shrink-0 px-2 py-1.5 text-[11px] text-[var(--element-bg)] hover:bg-black/5 dark:hover:bg-white/5 border-t border-neutral-200 dark:border-stone-700">
        关联整个项目（递归加入全部源码）
      </button>
    </div>
  );
}

// 解析助手回复中的 ``` 代码块（流式未闭合时按纯文本渲染，闭合后转代码块）
type Part = { type: 'text'; value: string } | { type: 'code'; lang: string; value: string };
function parseContent(text: string): Part[] {
  const parts: Part[] = [];
  const regex = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: 'text', value: text.slice(last, m.index) });
    parts.push({ type: 'code', lang: m[1] || '', value: m[2] });
    last = regex.lastIndex;
  }
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
  return parts;
}

function CodeBlock({ lang, value }: { lang: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await hostApi.invoke('clipboard_write', { text: value });
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* 忽略复制失败 */ }
  };
  const saveAs = async () => {
    try {
      const ext = lang && /^[a-z0-9]+$/i.test(lang) ? lang : 'txt';
      const dest = await hostApi.invoke<string | null>('pick_save_file', { defaultName: `snippet.${ext}` });
      if (dest) await hostApi.invoke('write_text_file', { path: dest, content: value });
    } catch { /* 忽略保存失败 */ }
  };
  return (
    <div className="my-2 rounded-lg overflow-hidden border border-neutral-200 dark:border-stone-700 bg-neutral-900 dark:bg-stone-950">
      <div className="flex items-center justify-between px-3 py-1 bg-neutral-800 dark:bg-stone-900 text-[11px] text-neutral-300 dark:text-stone-400">
        <span>{lang || 'code'}</span>
        <div className="flex items-center gap-2">
          <button onClick={copy} className="hover:text-white transition-colors">{copied ? '已复制' : '复制'}</button>
          <button onClick={saveAs} className="hover:text-white transition-colors">保存</button>
        </div>
      </div>
      <pre className="px-3 py-2 text-xs text-neutral-100 dark:text-stone-100 overflow-x-auto whitespace-pre"><code>{value}</code></pre>
    </div>
  );
}

function AiPanel({ docked, onClose, projectRoot }: { docked?: boolean; onClose?: () => void; projectRoot?: string | null }) {
  const [profiles, setProfiles] = useState<AiProfile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // 多份对话：每条对话独立保存消息列表（#10）。首条对话 id 与 activeConvId 必须一致。
  const INITIAL_CONV_ID = useRef('c_' + Date.now().toString(36)).current;
  const [conversations, setConversations] = useState<Conversation[]>(() => [
    { id: INITIAL_CONV_ID, title: '新对话', messages: [] },
  ]);
  const [activeConvId, setActiveConvId] = useState<string>(INITIAL_CONV_ID);
  const [input, setInput] = useState('');
  const [ctxFiles, setCtxFiles] = useState<CtxFile[]>([]);
  const [busy, setBusy] = useState(false);
  // 模型下拉框与对话切换的下拉开合状态（#11 / #10）
  const [modelOpen, setModelOpen] = useState(false);
  const [convOpen, setConvOpen] = useState(false);
  // 「关联项目」文件浏览器开合（#12）
  const [projOpen, setProjOpen] = useState(false);

  const activeReq = useRef<string | null>(null);
  const assistantId = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const activeConvIdRef = useRef(activeConvId);
  activeConvIdRef.current = activeConvId;

  // 下拉框只列出「已填写 API Key」的档案；未配置时不展示任何可用模型。
  const configuredProfiles = profiles.filter((p) => p.api_key && p.api_key.trim());
  const activeProfile = configuredProfiles.find((p) => p.id === activeId) || null;
  const activeConv = conversations.find((c) => c.id === activeConvId) || conversations[0];
  const messages = activeConv ? activeConv.messages : [];

  // 加载全局模型档案（配置在「全局设置 → 模型」完成，这里只读取并供下拉框选用）
  useEffect(() => {
    hostApi.invoke<{ profiles: AiProfile[]; active: string | null }>('ai_get_profiles')
      .then((data) => {
        const list = data.profiles || [];
        setProfiles(list);
        const usable = list.filter((p) => p.api_key && p.api_key.trim());
        const act = (data.active && usable.some((p) => p.id === data.active))
          ? data.active
          : (usable[0] ? usable[0].id : null);
        setActiveId(act);
      })
      .catch((e) => console.warn('[AI] 读取模型档案失败:', e));
  }, []);

  // 注册流式事件监听（全局事件，用 requestId 区分本次请求）
  // 注意：hostApi.listen 是异步的，若清理时 unlisten 还没 resolve 就会泄漏监听器，
  // 导致每次挂载累积一个监听器、ai-delta 被重复 append（回答字符翻倍）。
  // 这里用 cancelled 标记 + 立即反注册，确保即使卸载早于 listen 完成也不会泄漏。
  // 流式增量写入「当前激活对话」对应的消息列表（#10）。
  useEffect(() => {
    let cancelled = false;
    const unlistens: Array<() => void> = [];
    const updateActive = (updater: (ms: Msg[]) => Msg[]) => {
      setConversations((prev) => prev.map((c) => (c.id === activeConvIdRef.current ? { ...c, messages: updater(c.messages) } : c)));
    };
    const append = (delta: string) => {
      const aid = assistantId.current;
      if (!aid) return;
      updateActive((ms) => ms.map((m) => (m.id === aid ? { ...m, content: m.content + delta } : m)));
    };
    const finish = (err?: string) => {
      const aid = assistantId.current;
      setBusy(false);
      activeReq.current = null;
      if (aid) {
        updateActive((ms) => ms.map((m) => {
          if (m.id !== aid) return m;
          if (err) return { ...m, streaming: false, error: true, content: (m.content ? m.content + '\n\n' : '') + '⚠ ' + err };
          return { ...m, streaming: false };
        }));
      }
      assistantId.current = null;
    };
    (async () => {
      const u1 = await hostApi.listen<{ requestId: string; delta: string }>('ai-delta', (e) => {
        if (e.payload.requestId === activeReq.current) append(e.payload.delta);
      });
      const u2 = await hostApi.listen<{ requestId: string }>('ai-done', (e) => {
        if (e.payload.requestId === activeReq.current) finish();
      });
      const u3 = await hostApi.listen<{ requestId: string; error: string }>('ai-error', (e) => {
        if (e.payload.requestId === activeReq.current) finish(e.payload.error);
      });
      if (cancelled) { u1(); u2(); u3(); return; }
      unlistens.push(u1, u2, u3);
    })();
    return () => {
      cancelled = true;
      unlistens.forEach((u) => u());
    };
  }, []);

  // 自动滚动到底部
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // 输入框自适应高度：单行起，随行数扩展，最高 4 行后内部滚动（#8）
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

  const addContextFile = useCallback(async () => {
    try {
      const files = await hostApi.invoke<string[]>('pick_file', {
        filters: [{ name: '代码/文本', extensions: ['js','ts','tsx','jsx','json','py','rs','go','html','htm','css','scss','md','txt','log','vue','c','cpp','java','sh','toml','yaml','yml'] }],
      });
      if (!files || files.length === 0) return;
      const p = files[0];
      let content = await hostApi.invoke<string>('read_text_file', { path: p });
      if (content.length > MAX_CTX_CHARS) content = content.slice(0, MAX_CTX_CHARS) + '\n...(已截断)';
      setCtxFiles((prev) => [...prev.filter((f) => f.path !== p), { path: p, name: baseName(p), content }]);
    } catch (e) {
      console.error('[AI] 添加上下文文件失败:', e);
    }
  }, []);

  // 「关联整个项目」：递归收集项目内源码文件作为上下文（过滤依赖/构建目录与二进制，限制数量与总字符，#12）
  const attachProject = useCallback(async () => {
    if (!projectRoot) return;
    const collected: CtxFile[] = [];
    let total = 0;
    const MAX_FILES = 40;
    const MAX_CHARS = 24000;
    const walk = async (dir: string) => {
      if (collected.length >= MAX_FILES || total >= MAX_CHARS) return;
      let entries: DirEntry[];
      try {
        entries = await hostApi.invoke<DirEntry[]>('list_directory', { path: dir });
      } catch {
        return;
      }
      entries = entries.filter((e) => !(e.is_dir && SKIP_DIRS.has(e.name)));
      for (const e of entries) {
        if (collected.length >= MAX_FILES || total >= MAX_CHARS) break;
        if (e.is_dir) {
          await walk(e.path);
        } else if (CODE_EXT.has(extOf(e.name))) {
          try {
            let content = await hostApi.invoke<string>('read_text_file', { path: e.path });
            if (content.length > MAX_CTX_CHARS) content = content.slice(0, MAX_CTX_CHARS) + '\n...(已截断)';
            if (total + content.length <= MAX_CHARS) {
              collected.push({ path: e.path, name: e.name, content });
              total += content.length;
            }
          } catch {
            /* 跳过无法读取的文件 */
          }
        }
      }
    };
    await walk(projectRoot);
    if (collected.length === 0) return;
    setCtxFiles((prev) => {
      const map = new Map(prev.map((f) => [f.path, f]));
      collected.forEach((f) => map.set(f.path, f));
      return [...map.values()];
    });
  }, [projectRoot]);

  // 点选项目内文件加入上下文（供 ProjectBrowser 调用）
  const pickProjectFile = useCallback(async (p: string) => {
    try {
      let content = await hostApi.invoke<string>('read_text_file', { path: p });
      if (content.length > MAX_CTX_CHARS) content = content.slice(0, MAX_CTX_CHARS) + '\n...(已截断)';
      setCtxFiles((prev) => [...prev.filter((f) => f.path !== p), { path: p, name: baseName(p), content }]);
    } catch { /* ignore */ }
  }, []);

  const buildSystemPrompt = useCallback((): string => {
    let sys = (activeProfile?.system_prompt && activeProfile.system_prompt.trim())
      ? activeProfile.system_prompt.trim()
      : '你是一名资深编程助手，风格类似 Cursor / Claude Code。请用简体中文回答；给出代码时放在 ``` 代码块中并标注语言，必要时简述改动理由与关键点。';
    if (ctxFiles.length > 0) {
      sys += '\n\n以下是用户提供的项目文件作为上下文，请结合它们回答：\n';
      for (const f of ctxFiles) {
        sys += `\n### 文件：${f.path}\n\`\`\`\n${f.content}\n\`\`\`\n`;
      }
    }
    return sys;
  }, [activeProfile, ctxFiles]);

  // 往当前对话追加一条提示（如未配置模型）
  const appendHint = useCallback((text: string) => {
    setConversations((prev) => prev.map((c) => (c.id === activeConvIdRef.current ? {
      ...c, messages: [...c.messages, { id: 'hint_' + Date.now().toString(36), role: 'assistant', content: text, error: true }],
    } : c)));
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (!activeProfile || !activeProfile.api_key.trim()) {
      appendHint('⚠ 尚未配置可用模型：请到「全局设置 → 模型」中添加并填写 API Key，保存后回到此处从下拉框选用。');
      return;
    }
    const userMsg: Msg = { id: 'u_' + Date.now().toString(36), role: 'user', content: text };
    const aid = 'a_' + Date.now().toString(36);
    const asstMsg: Msg = { id: aid, role: 'assistant', content: '', streaming: true };
    const history = messages.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }));
    const payload = [
      { role: 'system', content: buildSystemPrompt() },
      ...history,
      { role: 'user', content: text },
    ];
    // 追加到当前对话；首条用户消息作为对话标题（#10）
    setConversations((prev) => prev.map((c) => (c.id === activeConvIdRef.current ? {
      ...c,
      title: c.title === '新对话' ? (text.slice(0, 12) || c.title) : c.title,
      messages: [...c.messages, userMsg, asstMsg],
    } : c)));
    setInput('');
    setBusy(true);
    const reqId = 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    activeReq.current = reqId;
    assistantId.current = aid;
    try {
      await hostApi.invoke('ai_chat', { requestId: reqId, messages: payload, profileId: activeProfile.id });
    } catch (e) {
      // 后端已通过 ai-error 事件反馈，这里兜底
      if (activeReq.current === reqId) {
        setBusy(false);
        activeReq.current = null;
        setConversations((prev) => prev.map((c) => (c.id === activeConvIdRef.current ? {
          ...c, messages: c.messages.map((m) => (m.id === aid ? { ...m, streaming: false, error: true, content: '⚠ ' + String(e) } : m)),
        } : c)));
        assistantId.current = null;
      }
    }
  }, [input, busy, activeProfile, messages, buildSystemPrompt, appendHint]);

  // 对话管理：清空 / 新建 / 切换 / 删除（#10）
  const clearChat = useCallback(() => {
    if (busy) return;
    setConversations((prev) => prev.map((c) => (c.id === activeConvIdRef.current ? { ...c, messages: [] } : c)));
  }, [busy]);
  const newConversation = useCallback(() => {
    const id = 'c_' + Date.now().toString(36);
    setConversations((prev) => [...prev, { id, title: '新对话', messages: [] }]);
    setActiveConvId(id);
    setConvOpen(false);
  }, []);
  const switchConversation = useCallback((id: string) => {
    setActiveConvId(id);
    setConvOpen(false);
  }, []);
  const removeConversation = useCallback((id: string) => {
    if (busy) return;
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      const list = next.length ? next : [{ id: 'c_' + Date.now().toString(36), title: '新对话', messages: [] }];
      if (id === activeConvIdRef.current) setActiveConvId(list[0].id);
      return list;
    });
  }, [busy]);

  // 键盘：Enter 直接发送；Ctrl/Cmd+Enter 或 Shift+Enter 换行（#8）
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex flex-col h-full bg-neutral-50 dark:bg-stone-900 text-neutral-800 dark:text-stone-100">
      {/* 顶栏：标题 + 对话切换 + 清空 + 关闭（#10） */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-200/60 dark:border-stone-700/60 shrink-0">
        <span className="text-sm font-medium shrink-0">AI 编程</span>
        <div className="relative">
          <button onClick={() => setConvOpen((o) => !o)} title="切换对话"
            className="btn-press max-w-[140px] truncate px-2 py-1 rounded-lg text-xs bg-neutral-200/70 dark:bg-stone-700 hover:bg-neutral-300 dark:hover:bg-stone-600 transition-colors">
            {activeConv?.title || '新对话'} ▾
          </button>
          {convOpen && (
            <div className="absolute left-0 top-full mt-1 z-30 w-56 rounded-lg border border-neutral-200 dark:border-stone-700 bg-white dark:bg-stone-800 shadow-lg max-h-72 overflow-auto py-1">
              {conversations.map((c) => (
                <div key={c.id} className="flex items-center gap-1 px-1.5 hover:bg-black/5 dark:hover:bg-white/5">
                  <button onClick={() => switchConversation(c.id)} title={c.title}
                    className={`flex-1 text-left truncate px-1.5 py-1 rounded text-xs ${c.id === activeConvId ? 'text-[var(--element-bg)] font-medium' : ''}`}>
                    {c.title}
                    <span className="text-neutral-400 dark:text-stone-500 ml-1">{c.messages.length ? c.messages.length + ' 条' : ''}</span>
                  </button>
                  {conversations.length > 1 && (
                    <button onClick={() => removeConversation(c.id)} title="删除对话" className="shrink-0 px-1 py-1 text-neutral-400 hover:text-red-500">✕</button>
                  )}
                </div>
              ))}
              <button onClick={newConversation} className="w-full text-left px-3 py-1.5 text-xs text-[var(--element-bg)] hover:bg-black/5 dark:hover:bg-white/5">＋ 新建对话</button>
            </div>
          )}
        </div>
        <span className="flex-1" />
        <button onClick={clearChat} className="btn-press px-2 py-1 rounded-lg text-xs bg-neutral-200/70 dark:bg-stone-700 hover:bg-neutral-300 dark:hover:bg-stone-600 transition-colors shrink-0">清空</button>
        {onClose && (
          <button onClick={onClose} className="btn-press px-2 py-1 rounded-lg text-xs bg-neutral-200/70 dark:bg-stone-700 hover:bg-red-500/80 hover:text-white transition-colors shrink-0" title="收起 AI 面板">✕</button>
        )}
      </div>

      {/* 消息区 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 px-3 py-3 space-y-3">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center text-neutral-400 dark:text-stone-500 gap-2">
            <div className="text-sm">开始与 AI 结对编程</div>
            <div className="text-xs max-w-xs">可在下方下拉框选择已配置的模型，并「添加文件」把代码作为上下文，再提问、让它解释、重构或生成代码。回复中的代码块可一键复制或保存。</div>
            {profiles.length === 0 && <div className="text-xs text-amber-500 mt-1">尚未配置任何模型</div>}
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div className={`max-w-[92%] rounded-xl px-3 py-2 text-sm leading-relaxed ${
                m.role === 'user'
                  ? 'element-primary'
                  : m.error
                    ? 'bg-red-500/10 text-red-500 dark:text-red-400'
                    : 'bg-white dark:bg-stone-800 border border-neutral-200/60 dark:border-stone-700/60'
              }`}>
                {m.role === 'assistant' ? (
                  <div>
                    {parseContent(m.content).map((part, i) =>
                      part.type === 'code'
                        ? <CodeBlock key={i} lang={part.lang} value={part.value} />
                        : <span key={i} className="whitespace-pre-wrap break-words">{part.value}</span>,
                    )}
                    {m.streaming && <span className="inline-block w-1.5 h-4 ml-0.5 align-middle bg-[var(--element-bg)] animate-pulse" />}
                  </div>
                ) : (
                  <span className="whitespace-pre-wrap break-words">{m.content}</span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* 上下文文件 chips */}
      {ctxFiles.length > 0 && (
        <div className="px-3 pt-2 flex flex-wrap gap-1.5 shrink-0">
          {ctxFiles.map((f) => (
            <span key={f.path} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-neutral-200/70 dark:bg-stone-700 text-neutral-600 dark:text-stone-300" title={f.path}>
              📄 {f.name}
              <button onClick={() => setCtxFiles((prev) => prev.filter((x) => x.path !== f.path))} className="hover:text-red-500">✕</button>
            </span>
          ))}
        </div>
      )}

      {/* 项目关联条（#12）：当前打开的项目，可一键递归关联或浏览目录加入文件 */}
      {projectRoot && (
        <div className="px-3 pt-2 flex items-center gap-1.5 text-[11px] text-neutral-500 dark:text-stone-400 shrink-0 flex-wrap">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-neutral-200/70 dark:bg-stone-700 text-neutral-600 dark:text-stone-300 max-w-[160px] truncate" title={projectRoot}>
            📁 {baseName(projectRoot)}
          </span>
          <button onClick={attachProject} className="btn-press px-2 py-0.5 rounded-full bg-neutral-200/70 dark:bg-stone-700 hover:bg-neutral-300 dark:hover:bg-stone-600 transition-colors">关联项目</button>
          <div className="relative">
            <button onClick={() => setProjOpen((o) => !o)} className="btn-press px-2 py-0.5 rounded-full bg-neutral-200/70 dark:bg-stone-700 hover:bg-neutral-300 dark:hover:bg-stone-600 transition-colors">浏览</button>
            {projOpen && projectRoot && (
              <ProjectBrowser root={projectRoot} onClose={() => setProjOpen(false)} onPick={pickProjectFile} onAttachAll={attachProject} />
            )}
          </div>
          {ctxFiles.length > 0 && <span className="text-neutral-400 dark:text-stone-500">· 已关联 {ctxFiles.length} 个文件</span>}
        </div>
      )}

      {/* 输入区（#8 / #11 / #14） */}
      <div className="px-3 py-2 border-t border-neutral-200/60 dark:border-stone-700/60 shrink-0 relative">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="向 AI 提问或让它写代码…（Enter 发送，Ctrl/Shift+Enter 换行）"
            className="flex-1 resize-none px-3 py-2 rounded-lg text-sm bg-white dark:bg-stone-800 border border-neutral-200 dark:border-stone-700 text-neutral-800 dark:text-stone-100 outline-none focus:ring-2 focus:ring-[var(--element-border)] leading-relaxed"
          />
          {/* 右侧列：模型选择（上）+ 文件/发送（下），容器限制防止撑爆（#14） */}
          <div className="flex flex-col items-stretch gap-1.5 shrink-0">
            {/* 模型选择：平时仅显示当前模型名（省略），点击展开列出全部（#11）；
                置于对话框右侧、发送/文件上方（#14），宽度受限避免溢出 */}
            <div className="relative flex justify-end">
              {configuredProfiles.length === 0 ? (
                <span className="px-2 py-1 rounded text-[11px] bg-amber-500/10 text-amber-600 dark:text-amber-400 max-w-[200px] truncate" title="尚未配置可用模型">
                  未配置模型
                </span>
              ) : modelOpen ? (
                <div className="absolute bottom-full right-0 mb-1 z-30 w-60 rounded-lg border border-neutral-200 dark:border-stone-700 bg-white dark:bg-stone-800 shadow-lg max-h-48 overflow-auto py-1">
                  {configuredProfiles.map((p) => (
                    <button key={p.id} onClick={() => { setActiveId(p.id); setModelOpen(false); }}
                      className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/5 ${p.id === activeId ? 'text-[var(--element-bg)] font-medium' : ''}`}>
                      {p.name || p.model || '未命名'} · {p.model || p.base_url}
                    </button>
                  ))}
                </div>
              ) : (
                <button onClick={() => setModelOpen(true)} title="选择模型"
                  className="btn-press text-[11px] text-neutral-500 dark:text-stone-400 hover:text-neutral-700 dark:hover:text-stone-200 truncate max-w-[200px]">
                  {activeProfile ? `模型：${activeProfile.name || activeProfile.model}` : '选择模型'} ▾
                </button>
              )}
            </div>
            {/* 文件（右）+ 发送（右）：并列（#11） */}
            <div className="flex items-center gap-2">
              <button onClick={addContextFile} title="添加文件作为上下文"
                className="btn-press shrink-0 px-2.5 py-2 rounded-lg text-xs bg-neutral-200/70 dark:bg-stone-700 hover:bg-neutral-300 dark:hover:bg-stone-600 transition-colors">📎 文件</button>
              <button onClick={send} disabled={busy || !input.trim()}
                className="btn-press shrink-0 px-4 py-2 rounded-lg text-sm font-medium element-primary hover:bg-[var(--element-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                {busy ? '生成中…' : '发送'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

window.__PLUGIN_REGISTRY__.register({
  id: 'ai',
  name: 'AI 编程',
  iconName: 'Bot',
  kind: 'module',
  visible: false,
  parent: 'ide',
  category: '开发',
  desc: 'AI 结对编程：多轮流式对话、附加文件上下文、代码一键复制/保存（模型在全局设置配置，下拉框选用）',
  component: AiPanel,
});
