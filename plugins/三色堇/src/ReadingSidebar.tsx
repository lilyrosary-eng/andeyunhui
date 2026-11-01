/// <reference path="../../global.d.ts" />
// 阅读模块侧边栏 — 双层 drill-down：
// 第一层：嵌套目录树（母目录 + 子目录 + 书籍）
// 第二层：选中书后切换为「目录 / 笔记」双 tab（目录=章节列表；笔记=高亮与批注，可跳转/搜索/删除/编辑/导出）
const React = window.__HOST_REACT__;
import { T, useLang } from '../../_shared/pluginRuntime';
import {
  HIGHLIGHT_BG,
  buildReadingNoteMarkdown,
  deleteHighlight,
  emitHighlightsChanged,
  listHighlights,
  noteIdForBook,
  onHighlightsChanged,
  updateHighlight,
  type HighlightRecord,
} from './readingHighlights';
const { useMemo, useState, useEffect, useCallback } = React;
const { ModuleSidebarShell, NestedNavList, BarChart3 } = window.__HOST_UI__ || {};
const hostApi = window.__HOST_API__;

interface BookSummary {
  filePath: string;
  title: string;
  format: 'txt' | 'epub' | 'pdf' | 'docx';
  parentDir: string;
}

interface ReadingChapter {
  id: string;
  title: string;
  content: string;
}

interface ReadingBook {
  filePath: string;
  title: string;
  author: string | null;
  chapters: ReadingChapter[];
}

interface DirNode {
  name: string;
  fullPath: string;
  books: BookSummary[];
  children: DirNode[];
}

interface ReadingSidebarProps {
  books: BookSummary[];
  currentFilePath: string | null;
  openingFilePath: string | null;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onBookClick: (book: BookSummary) => void;
  onOpenSettings: () => void;
  onChangeRoot: () => void;
  // drill-down 第二层：章节目录
  currentBook: ReadingBook | null;
  currentChapterIndex: number;
  onChapterClick: (index: number) => void;
  /** 笔记 tab 点击高亮 → 跳原文章节并定位高亮 */
  onHighlightJump?: (chapterIndex: number, highlightId: string) => void;
  onBackToBooks: () => void;
  onOpenStats: () => void;
}

// ========== 图标 ==========
function BookIcon() {
  return React.createElement('svg', {
    width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    children: [
      React.createElement('path', { key: '1', d: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20' }),
      React.createElement('path', { key: '2', d: 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z' }),
    ],
  });
}

function FolderIcon({ open }: { open: boolean }) {
  return React.createElement('svg', {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    children: open
      ? [React.createElement('path', { key: '1', d: 'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z' }), React.createElement('path', { key: '2', d: 'M2 10h20' })]
      : [React.createElement('path', { key: '1', d: 'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z' })],
  });
}

function ChevronIcon({ open }: { open: boolean }) {
  return React.createElement('svg', {
    width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round',
    style: { transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease' },
    children: React.createElement('polyline', { points: '9 18 15 12 9 6' }),
  });
}

function BookIconSmall() {
  return React.createElement('svg', {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    children: [
      React.createElement('path', { key: '1', d: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20' }),
      React.createElement('path', { key: '2', d: 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z' }),
    ],
  });
}

function FormatTag({ format }: { format: 'txt' | 'epub' | 'pdf' | 'docx' }) {
  const cls = {
    epub: 'bg-[var(--element-bg)]/15 text-[var(--element-bg)]',
    pdf: 'bg-rose-500/15 text-rose-500 dark:text-rose-400',
    docx: 'bg-sky-500/15 text-sky-500 dark:text-sky-400',
    txt: 'bg-neutral-200/70 dark:bg-stone-600/40 text-neutral-500 dark:text-stone-400',
  }[format];
  return React.createElement('span', {
    className: `text-[10px] font-medium uppercase px-1.5 py-0.5 rounded flex-shrink-0 ${cls}`,
  }, format);
}

// ========== 构建目录树 ==========
function buildTree(books: BookSummary[]): { rootBooks: BookSummary[]; rootDirs: DirNode[] } {
  const dirMap = new Map<string, BookSummary[]>();
  for (const b of books) {
    const key = b.parentDir || '';
    if (!dirMap.has(key)) dirMap.set(key, []);
    dirMap.get(key)!.push(b);
  }

  const rootBooks = (dirMap.get('') || []).sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
  dirMap.delete('');

  // 构建嵌套目录结构
  const dirPaths = Array.from(dirMap.keys()).sort();
  const rootDirs: DirNode[] = [];
  const pathToNode = new Map<string, DirNode>();

  for (const dp of dirPaths) {
    const parts = dp.split(/[/\\]/).filter(Boolean);
    let currentPath = '';
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      const prevPath = currentPath;
      currentPath = currentPath ? `${currentPath}/${seg}` : seg;
      if (i === parts.length - 1) {
        // leaf — actual dir with books
        const node: DirNode = {
          name: seg,
          fullPath: dp,
          books: dirMap.get(dp) || [],
          children: [],
        };
        if (pathToNode.has(prevPath)) {
          pathToNode.get(prevPath)!.children.push(node);
        } else {
          // top-level dir
          rootDirs.push(node);
        }
        pathToNode.set(currentPath, node);
      } else {
        // intermediate
        if (!pathToNode.has(currentPath)) {
          const node: DirNode = {
            name: seg,
            fullPath: currentPath,
            books: [],
            children: [],
          };
          if (pathToNode.has(prevPath)) {
            pathToNode.get(prevPath)!.children.push(node);
          } else {
            rootDirs.push(node);
          }
          pathToNode.set(currentPath, node);
        }
      }
    }
  }

  // 排序目录和书籍
  const sortNode = (node: DirNode) => {
    node.books.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
    node.children.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    node.children.forEach(sortNode);
  };
  rootDirs.forEach(sortNode);

  return { rootBooks, rootDirs };
}

// ========== 目录树节点 ==========
function DirTreeNode({
  node,
  depth,
  currentFilePath,
  openingFilePath,
  onBookClick,
  searchQuery,
  defaultOpen,
}: {
  node: DirNode;
  depth: number;
  currentFilePath: string | null;
  openingFilePath: string | null;
  onBookClick: (book: BookSummary) => void;
  searchQuery: string;
  defaultOpen: boolean;
}): React.ReactElement | null {
  const [open, setOpen] = useState(defaultOpen);
  const totalBooks = node.books.length + node.children.reduce((s, c) => s + c.books.length + c.children.length, 0);
  const hasBooks = totalBooks > 0;
  if (!hasBooks && searchQuery) return null;

  return React.createElement('div', { key: node.fullPath },
    React.createElement('button', {
      onClick: () => setOpen(!open),
      className: `w-full text-left px-2 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 text-xs font-medium text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5`,
      style: { paddingLeft: `${8 + depth * 12}px` },
    },
      React.createElement(ChevronIcon, { open }),
      React.createElement(FolderIcon, { open }),
      React.createElement('span', { className: 'flex-1 truncate' }, node.name),
      React.createElement('span', { className: 'text-[10px] text-neutral-400 dark:text-stone-500 flex-shrink-0' }, totalBooks),
    ),
    open && node.children.map(child =>
      React.createElement(DirTreeNode, {
        key: child.fullPath,
        node: child,
        depth: depth + 1,
        currentFilePath,
        openingFilePath,
        onBookClick,
        searchQuery,
        defaultOpen: searchQuery.length > 0,
      })
    ),
    open && node.books.map(book => {
      const isCurrent = currentFilePath === book.filePath;
      const isOpening = openingFilePath === book.filePath;
      return React.createElement('button', {
        key: book.filePath,
        onClick: () => onBookClick(book),
        disabled: isOpening,
        style: { paddingLeft: `${20 + (depth + 1) * 12}px` },
        className: `w-full text-left px-2 py-1.5 rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 text-sm ${
          isCurrent
            ? 'bg-[var(--element-bg)]/10 text-[var(--element-bg)]'
            : 'text-neutral-600 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5'
        }`,
      },
        React.createElement('span', { className: 'flex-shrink-0 opacity-60' }, React.createElement(BookIconSmall)),
        React.createElement('span', { className: 'font-medium truncate flex-1' }, book.title),
        isOpening
          ? React.createElement('span', {
              className: 'w-3 h-3 border border-current border-t-transparent rounded-full animate-spin flex-shrink-0',
            })
          : React.createElement(FormatTag, { format: book.format }),
      );
    }),
  );
}

// ========== 章节列表项图标 ==========
function ChapterIcon() {
  return React.createElement('svg', {
    width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    children: [
      React.createElement('line', { key: '1', x1: 8, y1: 6, x2: 21, y2: 6 }),
      React.createElement('line', { key: '2', x1: 8, y1: 12, x2: 21, y2: 12 }),
      React.createElement('line', { key: '3', x1: 8, y1: 18, x2: 21, y2: 18 }),
      React.createElement('line', { key: '4', x1: 3, y1: 6, x2: 3.01, y2: 6 }),
      React.createElement('line', { key: '5', x1: 3, y1: 12, x2: 3.01, y2: 12 }),
      React.createElement('line', { key: '6', x1: 3, y1: 18, x2: 3.01, y2: 18 }),
    ],
  });
}

// ========== 侧边栏主组件 ==========
export function ReadingSidebar(props: ReadingSidebarProps) {
  useLang();
  const {
    books, currentFilePath, openingFilePath,
    searchQuery, onSearchChange,
    onBookClick, onOpenSettings, onChangeRoot,
    currentBook, currentChapterIndex, onChapterClick, onHighlightJump, onBackToBooks,
    onOpenStats,
  } = props;

  // 侧边栏第三个按钮：阅读统计（列出全部书籍，无需先打开某本书）
  const statsButton = React.createElement('button', {
    onClick: () => onOpenStats(),
    title: T('reading.sidebar.stats'),
    'aria-label': T('reading.sidebar.stats'),
    className: 'p-2 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-[var(--element-color-raw)] hover:bg-black/5 dark:hover:bg-white/5 transition-colors',
  }, BarChart3 ? React.createElement(BarChart3, { size: 18, strokeWidth: 2 }) : '📊');

  // Hooks 必须全部位于任何条件 return 之前（React 规则），
  // 否则点击书籍（currentBook 从 null 变有值）会提前 return 导致 "Rendered fewer hooks than expected"
  const { rootBooks, rootDirs } = useMemo(() => buildTree(books), [books]);
  const hasDirs = rootDirs.length > 0;
  const filteredRootBooks = useMemo(() => {
    if (!searchQuery.trim()) return rootBooks;
    const q = searchQuery.trim().toLowerCase();
    return rootBooks.filter(b => b.title.toLowerCase().includes(q));
  }, [rootBooks, searchQuery]);

  // ===== 「目录 / 笔记」tab 与高亮列表状态（同样全部放在条件 return 之前）=====
  const [hlTab, setHlTab] = useState<'toc' | 'notes'>('toc');
  const [noteQuery, setNoteQuery] = useState('');
  const [highlights, setHighlights] = useState<HighlightRecord[]>([]);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [noteExists, setNoteExists] = useState<boolean | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  const bookPath = currentBook?.filePath || null;
  const normPath = (p: string) => p.replace(/\\/g, '/').toLowerCase();

  useEffect(() => {
    if (!bookPath) {
      setHighlights([]);
      setNoteExists(null);
      setExportMsg(null);
      setEditingId(null);
      return;
    }
    setHighlights(listHighlights(bookPath));
    setExportMsg(null);
    setEditingId(null);
    // 「一书一笔记」是否已存在：决定导出按钮文案（导出 / 更新）与「打开笔记」入口
    let alive = true;
    hostApi?.invoke('get_note_content', { noteId: noteIdForBook(bookPath) })
      .then(() => { if (alive) setNoteExists(true); })
      .catch(() => { if (alive) setNoteExists(false); });
    return () => { alive = false; };
  }, [bookPath]);

  useEffect(() => onHighlightsChanged((fp) => {
    if (bookPath && normPath(fp) === normPath(bookPath)) setHighlights(listHighlights(bookPath));
  }), [bookPath]);

  const refreshHighlights = useCallback(() => {
    if (bookPath) setHighlights(listHighlights(bookPath));
  }, [bookPath]);

  const handleHighlightDelete = useCallback((id: string) => {
    if (!bookPath) return;
    deleteHighlight(bookPath, id);
    emitHighlightsChanged(bookPath);
    refreshHighlights();
  }, [bookPath, refreshHighlights]);

  const handleNoteStartEdit = useCallback((h: HighlightRecord) => {
    setEditingId(h.id);
    setEditDraft(h.note || '');
  }, []);

  const handleNoteSaveEdit = useCallback((id: string) => {
    if (!bookPath) return;
    updateHighlight(bookPath, id, { note: editDraft });
    emitHighlightsChanged(bookPath);
    refreshHighlights();
    setEditingId(null);
  }, [bookPath, editDraft, refreshHighlights]);

  const openLinkedNote = useCallback(() => {
    if (!bookPath) return;
    const noteId = noteIdForBook(bookPath);
    hostApi?.navigate?.({ module: 'notes', entity: noteId, props: { noteId } });
  }, [bookPath]);

  // 导出一本书 → 一篇笔记（幂等：noteId 由书路径 hash 决定，重复导出即更新）
  const handleExport = useCallback(async () => {
    if (!currentBook || !hostApi?.invoke) return;
    if (currentBook.chapters.length === 0 || exportBusy) return;
    setExportBusy(true);
    setExportMsg(null);
    const noteId = noteIdForBook(currentBook.filePath);
    try {
      const recs = listHighlights(currentBook.filePath);
      const md = buildReadingNoteMarkdown(
        currentBook.title,
        currentBook.filePath,
        currentBook.chapters.map((ch, i) => ({ index: i, id: ch.id, title: ch.title })),
        recs,
      );
      await hostApi.invoke('save_note', {
        noteId,
        title: T('reading.notes.noteTitle', { title: currentBook.title }),
        content: md,
      });
      // 高亮批量回填 noteId（回链信息；失败不影响导出结果）
      for (const r of recs) {
        if (r.noteId !== noteId) updateHighlight(currentBook.filePath, r.id, { noteId }, { touch: false });
      }
      setNoteExists(true);
      emitHighlightsChanged(currentBook.filePath);
      // 宿主笔记列表刷新（宿主在 NotesModule 监听；插件不直接 import 宿主 zustand store）
      window.dispatchEvent(new CustomEvent('andy:notes-refresh'));
      // 统一走导航契约打开笔记
      hostApi.navigate?.({ module: 'notes', entity: noteId, props: { noteId } });
    } catch (err) {
      console.error('[reading] 导出读书笔记失败:', err);
      setExportMsg(T('reading.notes.exportFailed'));
    } finally {
      setExportBusy(false);
    }
  }, [currentBook, exportBusy]);

  // ====== 第二层：章节目录（选中书后显示）======
  // 使用 NestedNavList 模板：返回按钮在内容区顶部（不占用 primaryAction 导入按钮），
  // 设置通过 ModuleSidebarShell 底部齿轮（与视频模块一致）
  if (currentBook) {
    const chapterLayers = currentBook.chapters.length === 0
      ? [
          { title: T('reading.sidebar.bookList') },
          { title: currentBook.title, children: React.createElement('div', {
              className: 'flex items-center justify-center py-12 text-xs text-neutral-400 dark:text-stone-500',
            },
              React.createElement('div', {
                className: 'w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin mr-2',
              }),
              T('reading.loadingChapters'),
            ) },
        ]
      : [
          { title: T('reading.sidebar.bookList') },
          {
            title: currentBook.title,
            items: currentBook.chapters.map((ch, i) => ({
              id: String(i),
              icon: React.createElement(ChapterIcon),
              title: `${i + 1}. ${ch.title || T('reading.chapterN', { n: i + 1 })}`,
              active: i === currentChapterIndex,
            })),
          },
        ];

    // ===== 「目录 / 笔记」tab 行 =====
    const tabRow = React.createElement('div', { className: 'flex items-center gap-1 px-2 pb-2' },
      ...([
        { key: 'toc' as const, label: T('reading.tab.toc') },
        { key: 'notes' as const, label: T('reading.tab.notes') },
      ].map((tab) => React.createElement('button', {
        key: tab.key,
        onClick: () => setHlTab(tab.key),
        className: `flex-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors ${
          hlTab === tab.key
            ? 'bg-[var(--element-bg)]/10 text-[var(--element-bg)]'
            : 'text-neutral-400 dark:text-stone-500 hover:bg-black/5 dark:hover:bg-white/5'
        }`,
      }, tab.label, tab.key === 'notes' && highlights.length > 0
        ? React.createElement('span', { className: 'ml-1 text-[10px] opacity-70' }, highlights.length)
        : null))),
    );

    // ===== 笔记 tab：高亮 + 批注列表（搜索 / 跳转 / 删除 / 编辑批注 / 导出）=====
    const q = noteQuery.trim().toLowerCase();
    const visibleNotes = q
      ? highlights.filter((h) =>
          (h.quote || '').toLowerCase().includes(q) ||
          (h.note || '').toLowerCase().includes(q) ||
          (currentBook.chapters[h.chapterIndex]?.title || '').toLowerCase().includes(q))
      : highlights;

    const notesPanel = React.createElement('div', { className: 'flex flex-col min-h-0 flex-1' },
      // 导出行
      React.createElement('div', { className: 'px-2 pb-2 space-y-1' },
        React.createElement('div', { className: 'flex items-center gap-1.5' },
          React.createElement('button', {
            onClick: () => { void handleExport(); },
            disabled: exportBusy || currentBook.chapters.length === 0,
            className: 'btn-press flex-1 px-2 py-1.5 rounded-lg text-xs font-medium bg-[var(--element-bg)] text-white hover:opacity-90 transition-opacity disabled:opacity-50',
          }, exportBusy ? T('reading.notes.exporting') : (noteExists ? T('reading.notes.update') : T('reading.notes.export'))),
          noteExists && React.createElement('button', {
            onClick: openLinkedNote,
            title: T('reading.notes.openNote'),
            className: 'btn-press px-2 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5 transition-colors',
          }, T('reading.notes.openNote')),
        ),
        exportMsg && React.createElement('p', { className: 'text-[10px] text-red-400 dark:text-red-400 px-0.5' }, exportMsg),
        // 搜索
        React.createElement('input', {
          type: 'text',
          value: noteQuery,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setNoteQuery(e.target.value),
          placeholder: T('reading.notes.searchPlaceholder'),
          className: 'w-full px-2.5 py-1.5 rounded-lg bg-black/5 dark:bg-white/5 border border-transparent focus:border-[var(--element-bg)] outline-none text-xs text-neutral-600 dark:text-stone-300 placeholder:text-neutral-400 dark:placeholder:text-stone-500',
        }),
      ),
      // 列表
      React.createElement('div', { className: 'flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-1.5' },
        visibleNotes.length === 0
          ? React.createElement('div', { className: 'py-8 text-center text-xs text-neutral-400 dark:text-stone-500 px-2 leading-relaxed' }, T('reading.notes.empty'))
          : visibleNotes.map((h) => {
              const chapterLabel = currentBook.chapters[h.chapterIndex]?.title || T('reading.chapterN', { n: h.chapterIndex + 1 });
              return React.createElement('div', {
                key: h.id,
                className: 'group rounded-lg border border-black/5 dark:border-white/10 bg-white/50 dark:bg-white/5 px-2 py-2',
              },
                React.createElement('button', {
                  onClick: () => onHighlightJump?.(h.chapterIndex, h.id),
                  className: 'w-full text-left',
                },
                  React.createElement('div', { className: 'flex items-center gap-1.5 mb-1' },
                    React.createElement('span', {
                      className: 'w-2.5 h-2.5 rounded-full flex-shrink-0 border border-black/10 dark:border-white/20',
                      style: { backgroundColor: HIGHLIGHT_BG[h.color] },
                    }),
                    React.createElement('span', { className: 'text-[10px] text-neutral-400 dark:text-stone-500 truncate flex-1' }, chapterLabel),
                    h.stale && React.createElement('span', {
                      className: 'text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 flex-shrink-0',
                    }, T('reading.notes.stale')),
                  ),
                  React.createElement('p', { className: 'text-xs text-neutral-600 dark:text-stone-300 line-clamp-2 break-all' }, `「${h.quote}」`),
                  h.note
                    ? React.createElement('p', { className: 'mt-1 text-[11px] text-neutral-500 dark:text-stone-400 line-clamp-2 break-all' }, `✎ ${h.note}`)
                    : null,
                ),
                React.createElement('div', { className: 'flex items-center justify-end gap-1 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity' },
                  React.createElement('button', {
                    onClick: () => handleNoteStartEdit(h),
                    className: 'px-1.5 py-0.5 rounded text-[10px] text-neutral-400 dark:text-stone-500 hover:text-[var(--element-color-raw)] hover:bg-black/5 dark:hover:bg-white/5 transition-colors',
                  }, T('reading.hl.note')),
                  React.createElement('button', {
                    onClick: () => handleHighlightDelete(h.id),
                    className: 'px-1.5 py-0.5 rounded text-[10px] text-neutral-400 dark:text-stone-500 hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors',
                  }, T('reading.hl.delete')),
                ),
                editingId === h.id && React.createElement('div', { className: 'mt-1.5' },
                  React.createElement('textarea', {
                    autoFocus: true,
                    rows: 3,
                    value: editDraft,
                    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setEditDraft(e.target.value),
                    placeholder: T('reading.notes.notePlaceholder'),
                    className: 'w-full text-xs rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 resize-none outline-none focus:border-[var(--element-bg)] text-neutral-700 dark:text-stone-200',
                  }),
                  React.createElement('div', { className: 'flex items-center justify-end gap-1.5 mt-1' },
                    React.createElement('button', {
                      onClick: () => setEditingId(null),
                      className: 'px-2 py-1 rounded-md text-[10px] text-neutral-400 dark:text-stone-500 hover:bg-black/5 dark:hover:bg-white/10 transition-colors',
                    }, T('reading.notes.cancel')),
                    React.createElement('button', {
                      onClick: () => handleNoteSaveEdit(h.id),
                      className: 'px-2 py-1 rounded-md text-[10px] bg-[var(--element-bg)] text-white hover:opacity-90 transition-opacity',
                    }, T('reading.notes.save')),
                  ),
                ),
              );
            }),
      ),
    );

    const nestedContent = NestedNavList
      ? React.createElement(NestedNavList, {
          layers: chapterLayers,
          onBack: onBackToBooks,
          onItemClick: (item: { id: string }) => onChapterClick(parseInt(item.id, 10)),
        })
      : React.createElement(React.Fragment, null,
          React.createElement('button', {
            onClick: onBackToBooks,
            className: 'w-full text-left px-3 py-2 rounded-xl transition-colors flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/5 text-neutral-500 dark:text-stone-400 mb-1',
          }, T('reading.backToList')),
          React.createElement('div', { className: 'space-y-0.5' },
            ...currentBook.chapters.map((ch, i) => React.createElement('button', {
              key: ch.id || i,
              onClick: () => onChapterClick(i),
              className: `w-full text-left px-2 py-1.5 rounded-lg transition-colors flex items-center gap-2 text-sm ${
                i === currentChapterIndex
                  ? 'bg-[var(--element-bg)]/10 text-[var(--element-bg)]'
                  : 'text-neutral-600 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5'
              }`,
            },
              React.createElement('span', { className: 'flex-shrink-0 opacity-60' }, React.createElement(ChapterIcon)),
              React.createElement('span', { className: 'flex-1 truncate' },
                React.createElement('span', { className: 'text-[10px] text-neutral-400 dark:text-stone-500 mr-1.5' }, `${i + 1}.`),
                ch.title || T('reading.chapterN', { n: i + 1 }),
              ),
            )),
          ),
        );

    return ModuleSidebarShell
      ? React.createElement(ModuleSidebarShell, {
          moduleId: 'reading',
          // 收起后不再留竖条：本模块内容区自带纸面色，须让收起那列同色，详见 ModuleSidebarShell 的说明
          collapsedSurfaceClass: 'bg-[#f5f5f0] dark:bg-[#1c1917]',
          icon: React.createElement(BookIcon),
          title: currentBook.title,
          onOpenModuleSettings: onOpenSettings,
          footerExtra: statsButton,
          searchQuery: '',
          onSearchChange: () => {},
          searchPlaceholder: T('reading.chapterCount', { n: currentBook.chapters.length }),
          // 不使用 primaryAction —— 返回按钮由 NestedNavList 内容区提供（与视频模块一致）
          children: React.createElement(React.Fragment, null,
            tabRow,
            hlTab === 'toc'
              ? nestedContent
              : notesPanel,
          ),
        })
      : null;
  }

  // ====== 第一层：书籍列表（默认）======
  const isSearching = searchQuery.trim().length > 0;
  const totalBooks = books.length;

  // 构建子元素列表（避免嵌套三元 + spread 导致 TS 解析错误）
  const childrenParts: React.ReactNode[] = [];
  if (filteredRootBooks.length > 0) {
    if (hasDirs) {
      childrenParts.push(React.createElement('div', {
        key: 'root-header',
        className: 'px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-stone-500',
      }, T('reading.sidebar.root', { n: filteredRootBooks.length })));
    }
    for (const book of filteredRootBooks) {
      const isCurrent = currentFilePath === book.filePath;
      const isOpening = openingFilePath === book.filePath;
      childrenParts.push(React.createElement('button', {
        key: book.filePath,
        onClick: () => onBookClick(book),
        disabled: isOpening,
        className: `w-full text-left px-2 py-1.5 rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 text-sm ${
          isCurrent
            ? 'bg-[var(--element-bg)]/10 text-[var(--element-bg)]'
            : 'text-neutral-600 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5'
        }`,
      },
        React.createElement('span', { className: 'flex-shrink-0 opacity-60' }, React.createElement(BookIconSmall)),
        React.createElement('span', { className: 'font-medium truncate flex-1' }, book.title),
        isOpening
          ? React.createElement('span', { className: 'w-3 h-3 border border-current border-t-transparent rounded-full animate-spin flex-shrink-0' })
          : React.createElement(FormatTag, { format: book.format }),
      ));
    }
  }
  // 目录树
  for (const node of rootDirs) {
    childrenParts.push(React.createElement(DirTreeNode, {
      key: node.fullPath,
      node,
      depth: 0,
      currentFilePath,
      openingFilePath,
      onBookClick,
      searchQuery,
      defaultOpen: isSearching || rootDirs.length <= 2,
    }));
  }
  if (totalBooks === 0) {
    childrenParts.push(React.createElement('div', {
      className: 'flex-1 flex items-center justify-center text-xs text-neutral-400 dark:text-stone-500 py-8',
    }, T('reading.sidebar.noBooks')));
  }

  const treeContent = React.createElement('div', { className: 'space-y-0.5' },
    ...childrenParts,
  );

  // 不再用 SecondaryNavShell 包裹 — ModuleSidebarShell 列表区已是滚动容器，避免双重 overflow-y-auto
  const wrappedList = treeContent;

  return ModuleSidebarShell
    ? React.createElement(ModuleSidebarShell, {
        moduleId: 'reading',
        // 收起后不再留竖条：本模块内容区自带纸面色，须让收起那列同色，详见 ModuleSidebarShell 的说明
        collapsedSurfaceClass: 'bg-[#f5f5f0] dark:bg-[#1c1917]',
        icon: React.createElement(BookIcon),
        title: T('reading.title'),
        onOpenModuleSettings: onOpenSettings,
        footerExtra: statsButton,
        searchQuery,
        onSearchChange,
    searchPlaceholder: T('reading.sidebar.search', { n: totalBooks }),
    primaryAction: { label: T('reading.sidebar.chooseRoot'), onClick: onChangeRoot },
        children: wrappedList,
      })
    : null;
}

export default ReadingSidebar;
