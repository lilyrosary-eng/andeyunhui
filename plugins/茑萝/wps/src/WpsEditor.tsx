/// <reference path="../../../global.d.ts" />
const React = window.__HOST_REACT__;
const hostApi = window.__HOST_API__;
const { useState, useEffect, useRef, useCallback } = React;

import {
  loadIndex,
  saveIndex,
  loadDoc,
  saveDoc,
  deleteDoc,
  newId,
  kindOf,
  defaultTitle,
  type DocMeta,
  type FileKind,
  type PptSlide,
  type PptSection,
} from './docStore';
import { PptEditor } from './PptEditor';
import { SheetEditor } from './SheetEditor';
import { marked } from 'marked';
import { open, save } from '@tauri-apps/plugin-dialog';

// TipTap 懒加载（与插件沙箱同源：read_external_dep_file + new Function 挂载到 window.__EXT_TIPTAP__）
// 依赖本身在 external-deps/茑萝/wps/tiptap（由 scripts/build-external-deps.mjs 构建，react/react-dom 复用宿主实例）。
interface TiptapApi {
  Editor: any;
  EditorContent: any;
  useEditor: (options: any) => any;
  StarterKit: any;
  Image: any;
  Link: any;
  Placeholder: any;
  Table: any;
  TableRow: any;
  TableHeader: any;
  TableCell: any;
  TextAlign: any;
  Underline: any;
}
let tiptapPromise: Promise<TiptapApi> | null = null;
function loadTiptap(): Promise<TiptapApi> {
  if (tiptapPromise) return tiptapPromise;
  tiptapPromise = (async () => {
    const w = window as any;
    if (w.__EXT_TIPTAP__) return w.__EXT_TIPTAP__ as TiptapApi;
    const code = await hostApi.invoke<string>('read_external_dep_file', { relativePath: '茑萝/wps/tiptap/index.js' });
    if (!code) throw new Error('未找到 TipTap 依赖（external-deps/茑萝/wps/tiptap/index.js），请先运行 node scripts/build-external-deps.mjs');
    new Function(code)();
    if (!w.__EXT_TIPTAP__) throw new Error('TipTap 依赖已读取但挂载失败（window.__EXT_TIPTAP__ 未定义）');
    return w.__EXT_TIPTAP__ as TiptapApi;
  })();
  return tiptapPromise;
}

// 编辑器与打印样式（自包含，不依赖宿主 typography 插件）
const STYLE = `
.wps-root { font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
.wps-canvas { background:#e9e9e6; }
.dark .wps-canvas { background:#15130f; }
.wps-page {
  position:relative;
  background:#fff; width:210mm; min-height:297mm; margin:0 auto;
  padding:20mm 18mm; box-shadow:0 2px 18px rgba(0,0,0,.18); border-radius:2px;
  box-sizing:border-box;
  /* 编辑态自动跨页参考线：每 297mm(A4) 一条淡色分页线，
     打印真实分页由 @page 保证，这里仅作 WYSIWYG 视觉指引 */
  background-image: repeating-linear-gradient(to bottom,
    transparent 0,
    transparent calc(297mm - 1.5px),
    rgba(0,0,0,0.10) calc(297mm - 1.5px),
    rgba(0,0,0,0.10) 297mm);
}
/* 编辑态页码（位于每页右下角页边距内），打印时隐藏 */
.wps-pagenum { position:absolute; right:6mm; font-size:9pt; color:#b3ada2; pointer-events:none; user-select:none; }
.wps-prose { outline:none; color:#1f2328; font-size:11pt; line-height:1.7; min-height:240mm; }
.wps-prose:focus { outline:none; }
.wps-prose > * + * { margin-top:.6em; }
.wps-prose h1 { font-size:1.9em; font-weight:700; line-height:1.25; margin-top:1.1em; }
.wps-prose h2 { font-size:1.5em; font-weight:700; line-height:1.3; margin-top:1em; }
.wps-prose h3 { font-size:1.22em; font-weight:600; line-height:1.35; margin-top:.9em; }
.wps-prose p { margin:0; }
.wps-prose ul, .wps-prose ol { padding-left:1.6em; }
.wps-prose ul { list-style:disc; }
.wps-prose ol { list-style:decimal; }
.wps-prose li > p { margin:0; }
.wps-prose blockquote {
  border-left:3px solid #c9c4ba; padding:.2em 0 .2em 1em; color:#5b5750; font-style:italic;
}
.wps-prose code {
  background:#f1efe9; border-radius:4px; padding:.1em .35em; font-size:.88em;
  font-family:"SFMono-Regular",Consolas,monospace; color:#b4361e;
}
.wps-prose pre {
  background:#1f2328; color:#f3f3f0; border-radius:8px; padding:.9em 1em; overflow:auto;
  font-family:"SFMono-Regular",Consolas,monospace; font-size:.86em; line-height:1.5;
}
.wps-prose pre code { background:transparent; color:inherit; padding:0; }
.wps-prose a.wps-link { color:#2d6cdf; text-decoration:underline; cursor:pointer; }
.wps-prose img { max-width:100%; border-radius:6px; display:block; margin:.4em 0; }
.wps-prose table { border-collapse:collapse; table-layout:fixed; width:100%; margin:.6em 0; overflow:hidden; }
.wps-prose table td, .wps-prose table th {
  border:1px solid #c9c4ba; padding:.4em .6em; vertical-align:top; position:relative; min-width:1em;
}
.wps-prose table th { background:#f1efe9; font-weight:600; }
.wps-prose table .selectedCell:after {
  background:rgba(45,108,223,.15); content:""; position:absolute; left:0; right:0; top:0; bottom:0; pointer-events:none;
}
.wps-prose table .column-resize-handle {
  background:#2d6cdf; bottom:0; position:absolute; right:-2px; top:0; width:3px; pointer-events:none;
}
.wps-prose hr { border:none; border-top:1px solid #d9d4ca; margin:1.2em 0; }
.wps-prose p.is-editor-empty:first-child::before {
  content: attr(data-placeholder); color:#a8a39a; float:left; height:0; pointer-events:none;
}
/* 页眉 / 页脚（编辑态显示为细线分隔的浅色文字，打印时作为文档级页眉页脚） */
.wps-hf { text-align:center; color:#6b6258; font-size:9pt; line-height:1.4; padding:.35em 0; }
.wps-hf-head { border-bottom:1px solid #e5e0d6; margin-bottom:.6em; }
.wps-hf-foot { border-top:1px solid #e5e0d6; margin-top:.6em; }
/* 页眉页脚编辑弹层 */
.wps-hf-pop { position:absolute; z-index:30; top:52px; right:12px; width:280px; background:#fff;
  border:1px solid #e3ddd2; border-radius:10px; box-shadow:0 8px 28px rgba(0,0,0,.16); padding:12px; }
.dark .wps-hf-pop { background:#26221c; border-color:#3a342b; }
.wps-hf-pop label { display:block; font-size:11px; color:#8a847a; margin:0 0 4px; }
.wps-hf-pop input { width:100%; box-sizing:border-box; border:1px solid #ddd6c9; border-radius:6px;
  padding:6px 8px; font-size:12px; background:#fbfaf7; color:#2b2722; outline:none; }
.dark .wps-hf-pop input { background:#1d1a15; border-color:#3a342b; color:#e9e4da; }
@media print {
  .wps-no-print { display:none !important; }
  /* 隐藏宿主左侧侧边栏（含文档列表，由 ModuleSidebarShell 渲染），仅打印 A4 页面 */
  .nav-secondary-bg { display:none !important; }
  html, body { background:#fff !important; }
  .wps-canvas { background:#fff !important; display:block !important; padding:0 !important; overflow:visible !important; }
  .wps-page { box-shadow:none !important; margin:0 !important; width:auto !important; min-height:auto !important; padding:0 !important; border-radius:0 !important; background-image:none !important; position:static !important; }
  .wps-pagenum { display:none !important; }
  .wps-prose { min-height:auto !important; }
  [contenteditable] { outline:none !important; }
  @page { size: A4; margin: 16mm;
    @bottom-center { content: "第 " counter(page) " / " counter(pages) " 页"; font-size:9pt; color:#888; }
  }
}
`;

function Divider() {
  return <span className="w-px h-5 bg-neutral-300/70 dark:bg-stone-600/60 mx-1" />;
}

function Btn(props: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const { onClick, active, disabled, title, children, wide } = props;
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`h-8 min-w-8 px-2 rounded-md text-[13px] flex items-center justify-center transition-colors select-none
        ${wide ? 'px-2.5' : ''}
        ${active ? 'bg-[var(--element-bg)]/15 text-[var(--element-bg)]' : 'text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/10'}
        ${disabled ? 'opacity-35 pointer-events-none' : ''}`}
    >
      {children}
    </button>
  );
}

// ============ 文档列表共享总线 + 左侧侧边栏（复用绘画「母目录+子目录」模板） ============
// 与绘画 HuihuaSidebar/画布 同范式：模块级快照 + 订阅 + 操作注册，
// 使宿主侧边栏中的 WpsSidebar 与编辑器主体 WpsEditorBody 共用同一份文档状态。
interface DocSnapshot {
  docs: DocMeta[];
  activeId: string;
}
let docSnapshot: DocSnapshot = { docs: [], activeId: '' };
const docListeners = new Set<() => void>();
function publishDocs(docs: DocMeta[], activeId: string) {
  docSnapshot = { docs, activeId };
  docListeners.forEach((fn) => fn());
}
const docOps: {
  select: (id: string) => void;
  create: (kind: FileKind) => void;
  rename: () => void;
  remove: (id: string) => void;
} = { select: () => {}, create: () => {}, rename: () => {}, remove: () => {} };

// 单个可折叠容器（文档 / 演示文件 / 表格）
function SidebarGroup({
  label,
  kind,
  items,
  activeId,
}: {
  label: string;
  kind: FileKind;
  items: DocMeta[];
  activeId: string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="shrink-0">
      <div className="flex items-center gap-1 px-1 py-1">
        <button
          onClick={() => setOpen((v) => !v)}
          title={open ? '收起' : '展开'}
          className="w-5 h-5 rounded text-neutral-400 dark:text-stone-500 hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center text-[10px]"
        >
          {open ? '▾' : '▸'}
        </button>
        <span className="text-[11px] font-medium text-neutral-400 dark:text-stone-500 flex-1">
          {label}
          <span className="ml-1 text-neutral-300 dark:text-stone-600">{items.length}</span>
        </span>
        <button
          onClick={() => docOps.create(kind)}
          title={`新建${label}`}
          className="h-6 w-6 rounded-md text-neutral-500 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center text-base leading-none"
        >
          +
        </button>
      </div>
      {open && (
        <div className="pb-1">
          {items.length === 0 ? (
            <div className="px-3 py-1.5 text-[12px] text-neutral-300 dark:text-stone-600">暂无</div>
          ) : (
            items.map((m) => (
              <button
                key={m.id}
                onClick={() => docOps.select(m.id)}
                className={`w-full text-left px-3 py-2 ml-2 text-[13px] truncate rounded-lg transition-colors
                  ${m.id === activeId ? 'bg-[var(--element-bg)]/10 text-[var(--element-bg)]' : 'text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/5'}`}
              >
                <span className="truncate">{m.title}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function WpsSidebar() {
  const [snap, setSnap] = useState<DocSnapshot>(() => docSnapshot);
  useEffect(() => {
    const fn = () => setSnap(docSnapshot);
    docListeners.add(fn);
    return () => { docListeners.delete(fn); };
  }, []);
  const activeId = snap.activeId;
  const byKind = (k: FileKind) => snap.docs.filter((m) => kindOf(m) === k);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 三容器：文档 / 演示文件 / 表格 */}
      <div className="flex-1 overflow-auto py-1 min-h-0">
        <SidebarGroup label="文档" kind="doc" items={byKind('doc')} activeId={activeId} />
        <SidebarGroup label="演示文件" kind="ppt" items={byKind('ppt')} activeId={activeId} />
        <SidebarGroup label="表格" kind="sheet" items={byKind('sheet')} activeId={activeId} />
      </div>
      {/* 底部：重命名 / 删除（作用于当前选中的文件，跨容器通用） */}
      <div className="border-t border-white/70 dark:border-stone-700/50 p-1.5 flex gap-1 shrink-0">
        <button
          onClick={() => docOps.rename()}
          disabled={!activeId}
          className="flex-1 h-7 rounded-md text-xs text-neutral-500 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
        >
          重命名
        </button>
        <button
          onClick={() => docOps.remove(activeId)}
          disabled={!activeId}
          className="flex-1 h-7 rounded-md text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-40"
        >
          删除
        </button>
      </div>
    </div>
  );
}

// P0 占位：演示文件 / 表格 正式编辑器在后续阶段实现（P1 / P3）。
function ComingSoon({ kind }: { kind: FileKind }) {
  const label = kind === 'ppt' ? '演示文件' : kind === 'sheet' ? '表格' : '文档';
  const tip =
    kind === 'ppt'
      ? '演示文件编辑器将在 P1 阶段实现：幻灯片缩略图、中央画布（拖拽 / 缩放 / 文本 / 图片 / 形状）与右侧属性面板。'
      : '表格编辑器将在 P3 阶段实现。';
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 h-full bg-[#f5f5f0] dark:bg-[#1c1917] text-center px-8">
      <div className="text-neutral-400 dark:text-stone-500 text-sm font-medium">{label}编辑器</div>
      <div className="text-neutral-400 dark:text-stone-500 text-[13px] max-w-xs leading-relaxed">{tip}</div>
      <div className="text-[12px] text-neutral-300 dark:text-stone-600">暂可新建与重命名，正式编辑即将推出</div>
    </div>
  );
}

export function WpsEditor() {
  const [t, setT] = useState<TiptapApi | null>(null);
  const [tErr, setTErr] = useState<string>('');

  useEffect(() => {
    setTErr('');
    loadTiptap()
      .then((api) => setT(api))
      .catch((e: Error) => setTErr(e.message));
  }, []);

  if (tErr) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 h-full bg-[#f5f5f0] dark:bg-[#1c1917] text-center px-8">
        <div className="text-red-500 text-sm">{tErr}</div>
        <pre className="text-left text-xs text-neutral-500 bg-black/5 dark:bg-white/10 rounded-lg p-3 max-w-md overflow-auto">node scripts/build-external-deps.mjs</pre>
        <button
          onClick={() => { tiptapPromise = null; loadTiptap().then(setT).catch((e: Error) => setTErr(e.message)); }}
          className="btn-press px-4 py-1.5 rounded-lg bg-[var(--element-bg)]/15 text-[var(--element-bg)] text-sm"
        >
          重试
        </button>
      </div>
    );
  }
  if (!t) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-500 dark:text-stone-400 text-sm h-full bg-[#f5f5f0] dark:bg-[#1c1917]">
        正在加载编辑器内核（TipTap）…
      </div>
    );
  }
  return <WpsEditorBody t={t} />;
}

function WpsEditorBody({ t }: { t: TiptapApi }) {
  const EditorContent = t.EditorContent;
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [title, setTitle] = useState('未命名文档');
  const [header, setHeader] = useState('');
  const [footer, setFooter] = useState('');
  // 当前激活文件的类型，决定主区渲染哪种编辑器
  const activeMeta = docs.find((d) => d.id === activeId);
  const kind = kindOf(activeMeta);
  const [hfOpen, setHfOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // 编辑态自动跨页：根据页面总高度估算页数，渲染右下角页码（打印真实分页由 @page 保证）
  const [pageCount, setPageCount] = useState(1);
  const pageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const update = () => {
      const pxPerPage = 297 * (96 / 25.4); // 297mm ≈ 1122.5px @96dpi
      setPageCount(Math.max(1, Math.ceil(el.offsetHeight / pxPerPage)));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 文档列表共享总线（供左侧 WpsSidebar 复用绘画同款「母目录+子目录」模板）：
  // 用 ref 持有最新文档状态，使注册给侧边栏的操作始终读取最新值，避免闭包陈旧。
  const docsRef = useRef<DocMeta[]>(docs);
  const activeIdRef = useRef<string>(activeId);
  const titleRef = useRef<string>(title);
  docsRef.current = docs;
  activeIdRef.current = activeId;
  titleRef.current = title;

  const loadingRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 用 ref 持有最新 scheduleSave，避免 useEditor 的 onUpdate 闭包捕获首帧（activeId 为空）导致存错文档
  const scheduleSaveRef = useRef<(content?: unknown) => void>(() => {});

  const editor = t.useEditor({
    extensions: [
      t.StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      t.Underline,
      t.TextAlign.configure({ types: ['heading', 'paragraph'] }),
      t.Table.configure({ resizable: true }),
      t.TableRow,
      t.TableHeader,
      t.TableCell,
      t.Image.configure({ inline: false, allowBase64: true }),
      t.Link.configure({
        openOnClick: false,
        HTMLAttributes: { rel: 'noopener noreferrer', class: 'wps-link' },
      }),
      t.Placeholder.configure({ placeholder: '开始输入，或粘贴 / 拖入图片…' }),
    ],
    content: '',
    editorProps: { attributes: { class: 'wps-prose' } },
    onUpdate: ({ editor }: { editor: any }) => {
      if (loadingRef.current) return;
      scheduleSaveRef.current(editor.getJSON());
    },
  });

  const flushSave = useCallback(
    (content: unknown) => {
      if (!activeId) return;
      const doc = { id: activeId, title, content, header, footer, updatedAt: Date.now(), kind };
      // 仅文档类型有 TipTap 内容需要写回；演示文件 / 表格暂只更新索引
      if (kind === 'doc') saveDoc(doc);
      setDocs((prev) => {
        const next = prev.map((m) =>
          m.id === activeId ? { ...m, title, updatedAt: doc.updatedAt } : m,
        );
        saveIndex(next);
        return next;
      });
      setSavedAt(doc.updatedAt);
      setSaving(false);
    },
    [activeId, title, header, footer, kind],
  );

  // 演示文件内容落盘：写回 content（slides）并刷新索引 updatedAt，经共享总线同步侧栏。
  // id 由 PptEditor 在调度时传入，避免切换文件时被父级 activeIdRef 误用。
  const persistPpt = useCallback(
    (id: string, slides: PptSlide[], sections: PptSection[] = []) => {
      if (!id) return;
      const now = Date.now();
      saveDoc({ id, title: titleRef.current, content: { slides, sections }, kind: 'ppt', header: '', footer: '', updatedAt: now });
      const next = docsRef.current.map((m) => (m.id === id ? { ...m, updatedAt: now } : m));
      docsRef.current = next;
      saveIndex(next);
      publishDocs(next, id);
    },
    [],
  );

  // 表格内容落盘：写回 content（Univer workbook snapshot）并刷新索引 updatedAt，经共享总线同步侧栏。
  const persistSheet = useCallback(
    (id: string, content: unknown) => {
      if (!id) return;
      const now = Date.now();
      saveDoc({ id, title: titleRef.current, content, kind: 'sheet', header: '', footer: '', updatedAt: now });
      const next = docsRef.current.map((m) => (m.id === id ? { ...m, updatedAt: now } : m));
      docsRef.current = next;
      saveIndex(next);
      publishDocs(next, id);
    },
    [],
  );

  const scheduleSave = useCallback(
    (content?: unknown) => {
      setSaving(true);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const cur = editor ? content ?? editor.getJSON() : content;
        flushSave(cur);
      }, 700);
    },
    [editor, flushSave],
  );

  // 每次渲染同步最新 scheduleSave 到 ref（供 onUpdate 调用）
  scheduleSaveRef.current = scheduleSave;

  // 初始化：无文档则建一份默认文档
  useEffect(() => {
    const list = loadIndex();
    if (list.length === 0) {
      const id = newId();
      const meta: DocMeta = { id, title: '文档 1', updatedAt: Date.now(), kind: 'doc' };
      saveIndex([meta]);
      docsRef.current = [meta];
      setDocs([meta]);
      activeIdRef.current = id;
      setActiveId(id);
      setTitle(meta.title);
    } else {
      docsRef.current = list;
      setDocs(list);
      activeIdRef.current = list[0].id;
      setActiveId(list[0].id);
      setTitle(list[0].title);
    }
    publishDocs(docsRef.current, activeIdRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 注册文档列表操作给左侧侧边栏（WpsSidebar 经共享总线调用）
  useEffect(() => {
    docOps.select = selectDoc;
    docOps.create = createDoc;
    docOps.rename = renameDoc;
    docOps.remove = removeDoc;
    return () => {
      docOps.select = () => {};
      docOps.create = () => {};
      docOps.rename = () => {};
      docOps.remove = () => {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换 / 载入文档到编辑器
  useEffect(() => {
    if (!editor || !activeId) return;
    if (kind !== 'doc') {
      setHeader('');
      setFooter('');
      return;
    }
    const d = loadDoc(activeId);
    loadingRef.current = true;
    if (d && d.content) {
      editor.commands.setContent(d.content as object, false);
    } else {
      editor.commands.clearContent(false);
    }
    setHeader(d?.header || '');
    setFooter(d?.footer || '');
    loadingRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, activeId]);

  const selectDoc = (id: string) => {
    if (id === activeIdRef.current) return;
    activeIdRef.current = id;
    setActiveId(id);
    const m = docsRef.current.find((x) => x.id === id);
    if (m) setTitle(m.title);
    publishDocs(docsRef.current, id);
  };

  const createDoc = (kind: FileKind) => {
    const id = newId();
    const n = docsRef.current.filter((m) => kindOf(m) === kind).length + 1;
    const title = defaultTitle(kind, n);
    const meta: DocMeta = { id, title, updatedAt: Date.now(), kind };
    const next = [meta, ...docsRef.current];
    docsRef.current = next;
    saveIndex(next);
    setDocs(next);
    activeIdRef.current = id;
    setActiveId(id);
    setTitle(title);
    publishDocs(next, id);
    if (editor && kind === 'doc') {
      loadingRef.current = true;
      editor.commands.clearContent(false);
      loadingRef.current = false;
    }
  };

  const renameDoc = () => {
    const name = window.prompt('重命名文档', titleRef.current);
    if (name == null) return;
    const t = name.trim() || '未命名文档';
    setTitle(t);
    const id = activeIdRef.current;
    const next = docsRef.current.map((m) => (m.id === id ? { ...m, title: t } : m));
    docsRef.current = next;
    setDocs(next);
    saveIndex(next);
    publishDocs(next, id);
    scheduleSave();
  };

  const removeDoc = (id: string) => {
    if (!window.confirm('删除该文档？此操作不可撤销。')) return;
    deleteDoc(id);
    const next = docsRef.current.filter((m) => m.id !== id);
    docsRef.current = next;
    setDocs(next);
    saveIndex(next);
    if (id === activeIdRef.current) {
      if (next.length > 0) {
        activeIdRef.current = next[0].id;
        setActiveId(next[0].id);
        setTitle(next[0].title);
        publishDocs(next, next[0].id);
      } else {
        createDoc('doc');
      }
    } else {
      publishDocs(next, activeIdRef.current);
    }
  };

  const onTitleChange = (v: string) => {
    setTitle(v);
    scheduleSave();
  };

  const insertImage = () => {
    const url = window.prompt('插入图片地址（http(s):// 或 data: 内嵌）', '');
    if (!url) return;
    editor?.chain().focus().setImage({ src: url }).run();
  };

  const setLink = () => {
    const prev = editor?.getAttributes('link').href as string | undefined;
    const url = window.prompt('链接地址（留空取消链接）', prev || 'https://');
    if (url == null) return;
    if (url.trim() === '') {
      editor?.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor?.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  const doPrint = () => {
    // 触发 Chromium 打印（可「另存为 PDF」），打印样式仅输出 A4 页面
    window.print();
  };

  // 导入 .docx：复用原生 convert_to_markdown（docx→markdown），再经 marked 转 HTML 载入编辑器
  const importDocx = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Word 文档', extensions: ['docx'] }],
      });
      if (typeof selected !== 'string' || !selected) return;
      const md = await hostApi.invoke<string>('convert_to_markdown', { filePath: selected });
      const html = (await marked.parse(md)) as string;
      if (editor) {
        loadingRef.current = true;
        editor.commands.setContent(html, false);
        loadingRef.current = false;
      }
      scheduleSave();
    } catch (e) {
      window.alert('导入失败：' + (e instanceof Error ? e.message : String(e)));
    }
  };

  // 导出 .docx：将 TipTap 文档 JSON 交由原生 wps_export_docx 生成 OOXML
  const exportDocx = async () => {
    try {
      const p = await save({
        defaultPath: title || '文档',
        filters: [{ name: 'Word 文档', extensions: ['docx'] }],
      });
      if (!p) return;
      const json = JSON.stringify(editor ? editor.getJSON() : {});
      await hostApi.invoke('wps_export_docx', { path: p, json });
      window.alert('已导出为 ' + p);
    } catch (e) {
      window.alert('导出失败：' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const savedLabel = saving
    ? '保存中…'
    : savedAt
      ? `已保存 ${new Date(savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
      : '自动保存已开启';

  // 演示文件：交由 PptEditor 处理（自身管理幻灯片内容与持久化）
  if (kind === 'ppt') return <PptEditor activeId={activeId} title={title} onPersist={persistPpt} />;
  // 表格：Univer 引擎驱动的专业表格编辑器（公式 / 图表 / 排序 / 筛选 / 冻结 / 合并）
  if (kind === 'sheet') return <SheetEditor activeId={activeId} title={title} onPersist={persistSheet} />;

  return (
    <div className="wps-root flex-1 flex h-full min-h-0 bg-[#f5f5f0] dark:bg-[#1c1917]">
      {/* 文档列表已移至左侧宿主侧边栏（WpsSidebar，复用绘画「母目录+子目录」模板） */}

      {/* 主区域 */}
      <div className="flex-1 flex flex-col min-w-0 h-full">
        {/* 工具栏 */}
        <div className="wps-no-print flex items-center gap-0.5 px-3 py-2 border-b border-white/70 dark:border-stone-700/50 flex-wrap">
          <Btn title="撤销" onClick={() => editor?.chain().focus().undo().run()} disabled={!editor?.can().undo()}>
            ↶
          </Btn>
          <Btn title="重做" onClick={() => editor?.chain().focus().redo().run()} disabled={!editor?.can().redo()}>
            ↷
          </Btn>
          <Divider />
          <Btn title="加粗" active={editor?.isActive('bold')} onClick={() => editor?.chain().focus().toggleBold().run()}>
            <span style={{ fontWeight: 800 }}>B</span>
          </Btn>
          <Btn title="斜体" active={editor?.isActive('italic')} onClick={() => editor?.chain().focus().toggleItalic().run()}>
            <span style={{ fontStyle: 'italic' }}>I</span>
          </Btn>
          <Btn title="删除线" active={editor?.isActive('strike')} onClick={() => editor?.chain().focus().toggleStrike().run()}>
            <span style={{ textDecoration: 'line-through' }}>S</span>
          </Btn>
          <Btn title="下划线" active={editor?.isActive('underline')} onClick={() => editor?.chain().focus().toggleUnderline().run()}>
            <span style={{ textDecoration: 'underline' }}>U</span>
          </Btn>
          <Btn title="行内代码" active={editor?.isActive('code')} onClick={() => editor?.chain().focus().toggleCode().run()}>
            <span style={{ fontFamily: 'monospace' }}>{'</>'}</span>
          </Btn>
          <Divider />
          <Btn title="正文" active={editor?.isActive('paragraph')} onClick={() => editor?.chain().focus().setParagraph().run()}>
            正文
          </Btn>
          <Btn title="标题 1" active={editor?.isActive('heading', { level: 1 })} onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}>
            H1
          </Btn>
          <Btn title="标题 2" active={editor?.isActive('heading', { level: 2 })} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>
            H2
          </Btn>
          <Btn title="标题 3" active={editor?.isActive('heading', { level: 3 })} onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}>
            H3
          </Btn>
          <Divider />
          <Btn title="左对齐" active={editor?.isActive({ textAlign: 'left' })} onClick={() => editor?.chain().focus().setTextAlign('left').run()}>
            ⇤
          </Btn>
          <Btn title="居中" active={editor?.isActive({ textAlign: 'center' })} onClick={() => editor?.chain().focus().setTextAlign('center').run()}>
            ≡
          </Btn>
          <Btn title="右对齐" active={editor?.isActive({ textAlign: 'right' })} onClick={() => editor?.chain().focus().setTextAlign('right').run()}>
            ⇥
          </Btn>
          <Divider />
          <Btn title="插入表格" onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
            表格
          </Btn>
          <Divider />
          <Btn title="无序列表" active={editor?.isActive('bulletList')} onClick={() => editor?.chain().focus().toggleBulletList().run()}>
            • 列表
          </Btn>
          <Btn title="有序列表" active={editor?.isActive('orderedList')} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>
            1. 列表
          </Btn>
          <Btn title="引用" active={editor?.isActive('blockquote')} onClick={() => editor?.chain().focus().toggleBlockquote().run()}>
            ❝
          </Btn>
          <Btn title="代码块" active={editor?.isActive('codeBlock')} onClick={() => editor?.chain().focus().toggleCodeBlock().run()}>
            代码块
          </Btn>
          <Btn title="分割线" onClick={() => editor?.chain().focus().setHorizontalRule().run()}>
            ―
          </Btn>
          <Divider />
          <Btn title="插入链接" active={editor?.isActive('link')} onClick={setLink}>
            链接
          </Btn>
          <Btn title="插入图片" onClick={insertImage}>
            图片
          </Btn>
          <div className="flex-1" />
          <Btn title="页眉 / 页脚" onClick={() => setHfOpen((v) => !v)} active={hfOpen}>
            页眉页脚
          </Btn>
          <Btn title="导入 .docx" onClick={importDocx}>
            导入
          </Btn>
          <Btn title="导出为 .docx" onClick={exportDocx}>
            导出 .docx
          </Btn>
          <Btn title="打印 / 导出 PDF" onClick={doPrint} wide>
            打印 / PDF
          </Btn>
        </div>

        {/* A4 画布 */}
        <div className="wps-canvas flex-1 overflow-auto py-8 px-4">
          {hfOpen && (
            <div className="wps-hf-pop wps-no-print">
              <label>页眉</label>
              <input
                value={header}
                placeholder="如：项目周报 · 机密"
                onChange={(e) => { setHeader(e.target.value); scheduleSave(); }}
              />
              <label style={{ marginTop: 10 }}>页脚</label>
              <input
                value={footer}
                placeholder="如：第 1 页 / 共 3 页"
                onChange={(e) => { setFooter(e.target.value); scheduleSave(); }}
              />
              <div className="flex justify-end mt-3">
                <button
                  onClick={() => setHfOpen(false)}
                  className="px-3 py-1 rounded-md text-xs bg-[var(--element-bg)]/15 text-[var(--element-bg)]"
                >
                  完成
                </button>
              </div>
            </div>
          )}
          <div className="wps-page" ref={pageRef}>
            {/* 编辑态页码（仅多页时显示，打印隐藏） */}
            {pageCount > 1 &&
              Array.from({ length: pageCount }, (_, i) => (
                <div key={i} className="wps-pagenum" style={{ top: `calc(297mm * ${i} + 280mm)` }}>
                  {i + 1}
                </div>
              ))}
            {header && <div className="wps-hf wps-hf-head">{header}</div>}
            <input
              value={title}
              onChange={(e) => onTitleChange(e.target.value)}
              placeholder="无标题文档"
              className="w-full bg-transparent border-none outline-none font-bold text-2xl text-neutral-800 dark:text-stone-100 mb-3 placeholder:text-neutral-300"
            />
            <EditorContent editor={editor} />
            {footer && <div className="wps-hf wps-hf-foot">{footer}</div>}
          </div>
        </div>

        {/* 状态栏 */}
        <div className="wps-no-print flex items-center gap-3 px-4 py-1.5 border-t border-white/70 dark:border-stone-700/50 text-[11px] text-neutral-400 dark:text-stone-500">
          <span>{savedLabel}</span>
          {editor && (
            <span className="ml-auto">{editor.getText().length} 字</span>
          )}
        </div>
      </div>

      <style>{STYLE}</style>
    </div>
  );
}

export default WpsEditor;
