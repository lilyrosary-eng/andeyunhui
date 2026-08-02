/// <reference path="../../../global.d.ts" />
import React from "react";
import { marked } from "marked";
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
const hostApi = window.__HOST_API__;
const { useState, useRef, useEffect, useCallback } = React;

interface AiProfile {
  id: string;
  name: string;
  model: string;
  base_url: string;
  api_key: string;
  system_prompt?: string | null;
  thinking?: boolean | null;
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

// Markdown 渲染：AI 与用户消息中的 # 标题、**加粗**、*斜体*、`代码`、列表、引用、链接等字符
// 激活对应效果。gfm 开启表格/删除线等；breaks 让单行换行转 <br>，贴合聊天原有的换行习惯。
// 注意：代码块已由 parseContent 抽离给 CodeBlock，这里只渲染正文片段，不会重复包代码。
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

// 跨组件任意次挂载 / 任意泄漏监听器的全局护栏：保证同一 requestId 在整窗内只处理一次、只调一次 ai_chat。
// 否则出现多份桥接监听（旧版泄漏残留、StrictMode、宿主重复渲染等）时，每个都会调一次 ai_chat，
// 同一 delta 被转发 N 次 → 浮岛 N 连字；且本面板自身 ai-delta 监听（按 activeReq 回写）也让 IDE 跟着 N 连字；
// 第一份抢到 busy 后其余报「正在处理其他请求」。
const AIDE_REQ_GUARD = new Set<string>();
let AIDE_INFLIGHT: string | null = null;
let AIDE_WATCHDOG: ReturnType<typeof setTimeout> | null = null;

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
  // 对话持久化加载完成标记：加载完成前不写盘，避免初始空 state 覆盖磁盘已有数据
  const [convLoaded, setConvLoaded] = useState(false);

  const activeReq = useRef<string | null>(null);
  const assistantId = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const activeConvIdRef = useRef(activeConvId);
  activeConvIdRef.current = activeConvId;
  // 桥接监听须只注册一次（空依赖），处理器内经 ref 读最新值——
  // 若把 conversations/busy 等放进依赖，流式期间每个 delta 都会重挂 effect，
  // 而 hostApi.listen 异步注册 + cleanup 竞态会泄漏监听器，导致浮岛每个 delta 被转发 N 次（字符 N 连重复）。
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;

  // 下拉框只列出「已填写 API Key」的档案；未配置时不展示任何可用模型。
  const configuredProfiles = profiles.filter((p) => p.api_key && p.api_key.trim());
  const activeProfile = configuredProfiles.find((p) => p.id === activeId) || null;
  const activeProfileRef = useRef(activeProfile);
  activeProfileRef.current = activeProfile;
  // 思考模式内联开关：直接写入后端 profile.thinking（与胶囊 / IDE / 攻防共享同一档案字段）
  const toggleThinking = async () => {
    if (!activeProfile) return;
    const next = !activeProfile.thinking;
    setProfiles((prev) => prev.map((p) => (p.id === activeId ? { ...p, thinking: next } : p)));
    try {
      await hostApi.invoke('ai_set_profile_thinking', { profileId: activeId, thinking: next });
    } catch (e) {
      console.warn('[AI] 设置思考模式失败:', e);
      setProfiles((prev) => prev.map((p) => (p.id === activeId ? { ...p, thinking: !next } : p)));
    }
  };

  // 接收其它聊天界面切换「思考模式」的事件，保持胶囊 / IDE / 攻防 三处开关实时同步
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

  // 对话持久化：挂载时从后端加载（避免关闭软件后丢失），变更时防抖 500ms 写盘。
  // 不用 localStorage（5MB 限制 + WebView 数据目录清理风险）；
  // 不引入 NPSL/SQLite（用户明确拒绝强传染协议，桌面对话量级 JSON 文件足够）。
  useEffect(() => {
    let cancelled = false;
    hostApi.invoke<{ conversations: Conversation[]; active_id?: string | null }>('ai_get_conversations')
      .then((data) => {
        if (cancelled) return;
        const list = (data && Array.isArray(data.conversations) && data.conversations.length > 0)
          ? data.conversations.map((c) => ({
              // 兼容旧字段：role/content 必有；id/title 兜底
              id: c.id || ('c_' + Math.random().toString(36).slice(2, 8)),
              title: c.title || '新对话',
              // 加载后默认 streaming=false（流式状态不持久化）
              messages: (c.messages || []).map((m) => ({
                id: m.id || ('m_' + Math.random().toString(36).slice(2, 8)),
                role: (m.role === 'user' || m.role === 'assistant') ? m.role : 'assistant',
                content: m.content || '',
                streaming: false,
                error: m.error || false,
              }) as Msg),
            }))
          : [{ id: INITIAL_CONV_ID, title: '新对话', messages: [] }];
        setConversations(list);
        // 恢复激活对话：优先 active_id，其次首条
        const aid = (data?.active_id && list.some((c) => c.id === data.active_id))
          ? data.active_id!
          : list[0].id;
        setActiveConvId(aid);
        setConvLoaded(true);
      })
      .catch((e) => {
        console.warn('[AI] 读取对话持久化失败（已降级为新对话）:', e);
        setConvLoaded(true);
      });
    return () => { cancelled = true; };
  }, []);

  // 防抖保存：conversations / activeConvId 变化时延迟 500ms 写盘，避免流式增量触发频繁 I/O。
  // convLoaded 为 false 时跳过（加载阶段不写盘，防止空 state 覆盖磁盘）。
  useEffect(() => {
    if (!convLoaded) return;
    // 跳过流式中的中间态：仅当不 busy 或最后一条消息非 streaming 时立即保存，
    // 但因 500ms 防抖已足够降频，这里不再额外过滤，保持逻辑简单。
    const timer = setTimeout(() => {
      // 序列化时剥离 streaming 字段（后端不需要，减小文件体积）
      const payload = {
        conversations: conversations.map((c) => ({
          id: c.id,
          title: c.title,
          messages: c.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            ...(m.error ? { error: true } : {}),
          })),
        })),
        active_id: activeConvId,
      };
      hostApi.invoke('ai_save_conversations', { payload })
        .catch((e) => console.warn('[AI] 对话持久化保存失败:', e));
    }, 500);
    return () => clearTimeout(timer);
  }, [conversations, activeConvId, convLoaded]);

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

  // 桥接：黄金棋盘浮岛「AI 编程」按钮接管本面板对话（chat 模式）
  // 浮岛 emit('capsule-ide-chat-request', {requestId, text, profileId?, history?}) → 本面板执行并转发回流式事件。
  // 若浮岛传入 history，则由浮岛自持消息（不写入 IDE 自身对话），IDE 仅执行并转发。
  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | null = null;
    const p = hostApi.listen('capsule-ide-chat-request', async (e: any) => {
      if (cancelled) return;
      const payload = e?.payload || {};
      const requestId: string = payload.requestId;
      const text: string = (payload.text || '').trim();
      if (!requestId || !text) return;
      // 全局去重护栏：同一 requestId 整窗只处理一次（防多监听器 / 多挂载导致 N 倍 ai_chat 与 N 倍转发）
      if (AIDE_REQ_GUARD.has(requestId)) return;
      AIDE_REQ_GUARD.add(requestId);
      if (AIDE_REQ_GUARD.size > 256) AIDE_REQ_GUARD.clear();
      if (busyRef.current) {
        await hostApi.emit('capsule-ide-chat-error', { requestId, error: 'IDE 正在处理其他请求，请稍后再试' });
        return;
      }
      // 优先使用浮岛传入的档案；否则回落当前激活档案
      const activeProf = activeProfileRef.current;
      let profId: string | undefined = payload.profileId || activeProf?.id;
      let prof = profilesRef.current.find((x) => x.id === profId) || activeProf;
      if (!prof || !prof.api_key || !prof.api_key.trim()) {
        // 回落：直接读后端最新档案，修复浮岛转发时本面板 profiles 尚未就绪（时序/竞态）导致的「未配置模型」
        try {
          const fresh = (await hostApi.invoke('ai_get_profiles')) as any;
          const list: any[] = Array.isArray(fresh?.profiles) ? fresh.profiles : [];
          const usable = list.filter((p: any) => p.api_key && p.api_key.trim());
          const act = fresh?.active && usable.some((p: any) => p.id === fresh.active) ? fresh.active : (usable[0]?.id ?? null);
          profId = payload.profileId || act;
          prof = list.find((x: any) => x.id === profId) || usable.find((x: any) => x.id === act) || null;
        } catch { /* 忽略，走下方统一报错 */ }
      }
      if (!prof || !prof.api_key || !prof.api_key.trim()) {
        await hostApi.emit('capsule-ide-chat-error', { requestId, error: '⚠ 尚未配置可用模型：请到「全局设置 → 模型」添加并填写 API Key' });
        return;
      }
      // 浮岛传入历史则由浮岛持有消息；否则回落 IDE 当前激活对话历史
      const capsuleManaged = Array.isArray(payload.history);
      const histSrc = capsuleManaged
        ? (payload.history as Array<{ role: string; content: string }>).filter((m: any) => m && m.role && m.content != null).map((m: any) => ({ role: m.role, content: String(m.content) }))
        : (conversationsRef.current.find((c) => c.id === activeConvIdRef.current)?.messages || [])
            .filter((m: any) => !m.error)
            .map((m: any) => ({ role: m.role, content: m.content }));
      const msgPayload = [
        { role: 'system', content: buildSystemPrompt() },
        ...histSrc,
        { role: 'user', content: text },
      ];
      // 浮岛 AI 编程：IDE 负责执行并流式回传；同时把同一轮镜像进 IDE 自身对话，
      // 使「浮岛 ↔ IDE」两端可见同一会话（同步）。本面板自身的 ai-delta 监听会按
      // activeReq.current/assistantId.current 把流式内容写回这条对话，done 时复位 busy。
      const uid = 'u_' + Date.now().toString(36);
      const aid = 'a_' + Date.now().toString(36);
      setConversations((prev) => prev.map((c) => (c.id === activeConvIdRef.current ? {
        ...c,
        title: c.title === '新对话' ? (text.slice(0, 12) || c.title) : c.title,
        messages: [...c.messages, { id: uid, role: 'user', content: text }, { id: aid, role: 'assistant', content: '', streaming: true }],
      } : c)));
      setBusy(true);
      activeReq.current = requestId; // 让本面板自身 ai-delta 监听回写这条对话（接管）
      assistantId.current = aid;
      // 转发流式事件给浮岛（按 requestId 过滤），done/error 后反注册转发监听
      const fwd = (name: string, pl: any) => { void hostApi.emit('capsule-ide-chat-' + name, pl); };
      let done = false;
      const teardown = () => {
        if (done) return;
        done = true;
        u1(); u2(); u3(); u4();
        if (AIDE_WATCHDOG !== null) { clearTimeout(AIDE_WATCHDOG); AIDE_WATCHDOG = null; }
        AIDE_INFLIGHT = null;
      };
      const u1 = await hostApi.listen('ai-delta', (ev: any) => { if (ev?.payload?.requestId === requestId) fwd('delta', ev.payload); });
      const u2 = await hostApi.listen('ai-reasoning-delta', (ev: any) => { if (ev?.payload?.requestId === requestId) fwd('reasoning-delta', ev.payload); });
      const u3 = await hostApi.listen('ai-done', (ev: any) => { if (ev?.payload?.requestId === requestId) { fwd('done', ev.payload); teardown(); } });
      const u4 = await hostApi.listen('ai-error', (ev: any) => { if (ev?.payload?.requestId === requestId) { fwd('error', ev.payload); teardown(); } });
      // 看门狗：若 180s 内未收到 done/error（后端异常静默），强制复位 busy 与在途标记，避免永久卡「正在处理其他请求」
      AIDE_INFLIGHT = requestId;
      AIDE_WATCHDOG = setTimeout(() => {
        if (AIDE_INFLIGHT === requestId) { AIDE_INFLIGHT = null; setBusy(false); activeReq.current = null; assistantId.current = null; }
        teardown();
      }, 180000);

      try {
        await hostApi.invoke('ai_chat', { requestId, messages: msgPayload, profileId: prof.id });
      } catch (err) {
        fwd('error', { requestId, error: String(err) });
        teardown();
        if (activeReq.current === requestId) {
          setBusy(false);
          activeReq.current = null;
          assistantId.current = null;
        }
      }
    });
    p.then((u) => { if (cancelled) { u(); return; } unsub = u; }).catch(() => {});
    return () => { cancelled = true; if (unsub) unsub(); };
  }, []);

  // 浮岛「清空对话」：重置 IDE 普通对话（chat 模式）并存盘
  useEffect(() => {
    let unsub: (() => void) | null = null;
    hostApi.listen<{}>('capsule-ide-clear-conversations', () => {
      const fresh: Conversation[] = [{ id: 'c_' + Date.now().toString(36), title: '新对话', messages: [] }];
      setConversations(fresh);
      setActiveConvId(fresh[0].id);
      activeConvIdRef.current = fresh[0].id;
      hostApi.invoke('ai_save_conversations', { payload: { conversations: fresh, active_id: fresh[0].id } })
        .catch(() => {});
    }).then((u) => { unsub = u; });
    return () => unsub?.();
  }, []);

  // 自动滚动到底部（流式渲染含代码高亮时高度会后置，rAF 兜底再滚一次，避免长对话需手动翻找）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    const id = requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    return () => cancelAnimationFrame(id);
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
    // 注意：用户「人设 / 额外要求(system_prompt)」由后端 ai_chat 统一组合并合并进首条 system 消息，
    // 此处不再重复拼接 system_prompt，避免双重注入；只保留编程助手基底 + 项目文件上下文。
    let sys = '你是一名资深编程助手，风格类似 Cursor / Claude Code。请用简体中文回答；给出代码时放在 ``` 代码块中并标注语言，必要时简述改动理由与关键点。';
    if (ctxFiles.length > 0) {
      sys += '\n\n以下是用户提供的项目文件作为上下文，请结合它们回答：\n';
      for (const f of ctxFiles) {
        sys += `\n### 文件：${f.path}\n\`\`\`\n${f.content}\n\`\`\`\n`;
      }
    }
    return sys;
  }, [ctxFiles]);

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
                        : <Markdown key={i} text={part.value} className="whitespace-pre-wrap break-words" />,
                    )}
                    {m.streaming && <span className="inline-block w-1.5 h-4 ml-0.5 align-middle bg-[var(--element-bg)] animate-pulse" />}
                  </div>
                ) : (
                  <Markdown text={m.content} className="whitespace-pre-wrap break-words" />
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
                    <button key={p.id} onClick={() => { setActiveId(p.id); setModelOpen(false); hostApi.emit('ai-active-profile-changed', { id: p.id }).catch(() => {}); }}
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
              <button onClick={toggleThinking} title={activeProfile?.thinking ? '思考模式：开（先输出思维链再回答）' : '思考模式：关（点击开启）'}
                className={`btn-press shrink-0 px-2.5 py-2 rounded-lg text-xs border transition-colors ${
                  activeProfile?.thinking
                    ? 'border-[var(--element-border)] bg-[rgba(230,195,92,0.14)] text-[var(--element-bg)] font-medium'
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
