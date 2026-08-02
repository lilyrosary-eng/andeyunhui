/// <reference path="../../global.d.ts" />
// 阅读插件入口 — 书籍列表 + 阅读视图骨架
import { ReadingSidebar } from './ReadingSidebar';
import { ReadingView } from './ReadingView';
import { ReadingStatsPage } from './ReadingStatsPage';
import { getReadingProgress, saveReadingProgress, type ReadingProgress } from './readingProgress';
import { setCurrentBookPath, getCurrentBookPath } from './readingStore';
import { useRootPaths, EmptyState, NoResultsState, useStreamingOpen, T, useLang } from '../../_shared/pluginRuntime';
import { registerOpenWithListener, getPendingOpenWith, importToOpenWithDir, type OpenWithItem } from '../../_shared/openWithFiles';

const React = window.__HOST_REACT__;
const { useState, useEffect, useCallback, useRef, startTransition } = React;
const hostApi = window.__HOST_API__;

const STORAGE_KEY_ROOT = 'reading_plugin_root_paths';

// ========== 类型（与 Rust 端 reading_service.rs 对齐）==========
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

// 与 Rust reading_service.rs OpenBookMeta 对齐
interface OpenBookMeta {
  filePath: string;
  title: string;
  author: string | null;
  format: string;
  totalChapters: number;
  cached: boolean;
}

// 母/子文件夹识别：先把每本书的 parentDir 归一化到「最深（最长）祖先根」之下，
// 再按绝对路径去重。这样当 D:/ 与 D:/Music 同时作为根时，D:/Music/BIXUS/book.txt
// 始终以 parentDir="BIXUS" 归入同一树节点，而不会被拆成 "Music/BIXUS" 与 "BIXUS" 两个节点。
function dedupBooks(books: BookSummary[], rootPaths: string[] = []): BookSummary[] {
  const roots = rootPaths
    .map((p) => p.replace(/\\/g, '/').replace(/\/+$/, ''))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length); // 最长优先 → 第一个命中的即最深根
  // 1) 归一化 parentDir 到最深根之下
  const normalized = books.map((b) => {
    const fp = b.filePath.replace(/\\/g, '/');
    const parent = fp.includes('/') ? fp.slice(0, fp.lastIndexOf('/')) : fp;
    let best = '';
    for (const r of roots) {
      if (parent === r || parent.startsWith(r + '/')) {
        best = r;
        break;
      }
    }
    const parentDir = best && parent !== best ? parent.slice(best.length + 1) : '';
    return { ...b, parentDir };
  });
  // 2) 按绝对路径去重（同一文件可能被父根递归扫描与自身作为根扫描各命中一次）
  const map = new Map<string, BookSummary>();
  for (const b of normalized) {
    const key = b.filePath.replace(/\\/g, '/').toLowerCase();
    if (!map.has(key)) map.set(key, b);
  }
  return Array.from(map.values());
}

// ========== 图标 ==========
function BookIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

// ========== 设置面板 ==========
function SettingsContent({
  rootPaths,
  onRemoveRoot,
  onClose,
  bookCount,
}: {
  rootPaths: string[];
  onRemoveRoot: (path: string) => void;
  onClose: () => void;
  bookCount: number;
}) {
  const ModuleSettingsPanel = (window.__HOST_UI__ as Record<string, unknown>)?.ModuleSettingsPanel as React.FC<{
    title: string; icon: React.ReactNode; onClose: () => void; children: React.ReactNode;
  }> | undefined;

  if (!ModuleSettingsPanel) return null;

  useLang();
  return React.createElement(ModuleSettingsPanel, {
    title: T('reading.title'),
    icon: React.createElement(BookIcon),
    onClose,
    children: React.createElement('div', { className: 'space-y-4' },
      // 阅读目录
      React.createElement('div', { className: 'glass-panel p-4' },
        React.createElement('label', { className: 'block text-xs font-medium text-neutral-500 dark:text-stone-400 mb-2' }, T('reading.settings.dirs')),
        rootPaths.length === 0
          ? React.createElement('p', { className: 'text-sm text-neutral-400 dark:text-stone-500' }, T('reading.settings.noDirs'))
          : React.createElement('div', { className: 'space-y-2' },
              ...rootPaths.map((path) =>
                React.createElement('div', { key: path, className: 'flex items-center gap-2 group' },
                  React.createElement('span', { className: 'flex-1 text-sm text-neutral-600 dark:text-stone-300 truncate' }, path),
                  React.createElement('button', {
                    onClick: () => onRemoveRoot(path),
                    className: 'btn-press px-2 py-1 rounded text-xs text-neutral-400 dark:text-stone-500 hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100',
                    title: T('reading.remove'),
                  }, T('reading.remove')),
                )
              ),
            ),
      ),
      // 支持格式
      React.createElement('div', { className: 'glass-panel p-4' },
        React.createElement('label', { className: 'block text-xs font-medium text-neutral-500 dark:text-stone-400 mb-2' }, T('reading.settings.formats')),
        React.createElement('p', { className: 'text-sm text-neutral-600 dark:text-stone-300' }, 'TXT、EPUB、PDF、DOCX'),
      ),
      // 统计
      React.createElement('div', { className: 'glass-panel p-4' },
        React.createElement('p', { className: 'text-xs text-neutral-400 dark:text-stone-500' }, T('reading.settings.scanned', { n: bookCount })),
      ),
    ),
  });
}

// ========== 主组件 ==========
function ReadingModule() {
  useLang();
  const { rootPaths, addRoot, addRootPathEphemeral, removeRoot } = useRootPaths(STORAGE_KEY_ROOT);
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentBook, setCurrentBook] = useState<ReadingBook | null>(null);
  const [openingFilePath, setOpeningFilePath] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedChapterIndex, setSelectedChapterIndex] = useState(0);
  // 恢复用一次性标记：章内滚动百分比（竖版）/ 章内页码偏移（分页），由 ReadingView apply 后清空
  const [restoreScrollPercent, setRestoreScrollPercent] = useState<number | null>(null);
  const [restorePageInChapter, setRestorePageInChapter] = useState<number | null>(null);
  const [scanComplete, setScanComplete] = useState(false);

  // 阅读进度统计面板 + 持久化（内嵌常驻，无需开关）
  const [showStats, setShowStats] = useState(false);
  const currentBookRef = useRef<ReadingBook | null>(null);
  const progressRef = useRef<ReadingProgress | null>(null);
  const dirtyRef = useRef(false);
  const loadedPathRef = useRef<string | null>(null);
  const restoreStartedRef = useRef(false);

  // 根目录变化 → 扫描所有根（缓存优先 + 流式增量加载）
  useEffect(() => {
    if (rootPaths.length === 0) {
      setBooks([]);
      setCurrentBook(null);
      setScanComplete(true);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setScanComplete(false);
    setCurrentBook(null);

    (async () => {
      const all: BookSummary[] = [];
      for (const path of rootPaths) {
        if (cancelled) return;
        // 1) 尝试缓存秒开
        try {
          const cached = await hostApi.invoke<BookSummary[] | null>('load_reading_cache', { rootPath: path });
          if (cancelled) return;
          if (Array.isArray(cached) && cached.length > 0) {
            all.push(...cached);
          }
        } catch {}
      }
      // 2) 缓存命中：先展示，后台异步扫描（可选）
      if (!cancelled && all.length > 0) {
        all.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
        setBooks(dedupBooks([...all], rootPaths));
        setLoading(false);
      }
      // 3) 全量扫描（并行所有根）
      const freshAll: BookSummary[] = [];
      for (const path of rootPaths) {
        if (cancelled) return;
        try {
          const res = await hostApi.invoke<BookSummary[]>('scan_reading_root', { rootPath: path });
          if (cancelled) return;
          if (Array.isArray(res)) freshAll.push(...res);
        } catch (err) {
          if (cancelled) return;
          if (String(err).includes('扫描已在进行中')) continue;
          console.error('[Reading] 扫描失败:', path, err);
        }
      }
      if (cancelled) return;
      freshAll.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
      setBooks(dedupBooks(freshAll, rootPaths));
      setLoading(false);
      setScanComplete(true);
    })();

    // cleanup: cancel Rust-side scan so flags are released
    return () => {
      cancelled = true;
      hostApi.invoke('cancel_scan').catch(() => {});
    };
  }, [rootPaths]);

  const handleSelectRoot = useCallback(async () => {
    await addRoot();
  }, [addRoot]);

  const handleRemoveRoot = useCallback((pathToRemove: string) => {
    removeRoot(pathToRemove);
    // 规范化为正斜杠后再做边界匹配，避免 D:/Books 误删 D:/Books2/...
    const normRoot = pathToRemove.replace(/\\/g, '/').replace(/\/+$/, '');
    const underRoot = (fp: string) => {
      const n = fp.replace(/\\/g, '/');
      return n === normRoot || n.startsWith(normRoot + '/');
    };
    const cur = currentBookRef.current;
    setBooks(prev => prev.filter(b => !underRoot(b.filePath)));
    setCurrentBook(prev => (prev && underRoot(prev.filePath)) ? null : prev);
    if (cur && underRoot(cur.filePath)) setCurrentBookPath(null);
  }, [removeRoot]);

  // 点击书籍 → 流式打开（useStreamingOpen 处理事件推送 + 帧缓冲合并）
  const { open: openBook } = useStreamingOpen<OpenBookMeta, ReadingChapter>(
    {
      metaEvent: 'open-book-meta',
      itemEvent: 'open-book-chunk',
      progressEvent: 'open-book-progress',
    },
    {
      onMeta: (meta) => {
        setCurrentBook({
          filePath: meta.filePath,
          title: meta.title,
          author: meta.author,
          chapters: [],
        });
        setSelectedChapterIndex(0);
        loadedPathRef.current = null;
        setOpeningFilePath(meta.filePath);
        setShowSettings(false);
      },
      onItems: (chapters) => {
        setCurrentBook((prev) => prev ? {
          ...prev,
          chapters: [...prev.chapters, ...chapters],
        } : null);
      },
      onDone: () => {
        setOpeningFilePath(null);
      },
      onError: (err) => {
        console.error('[Reading] 打开书籍失败:', err);
        setOpeningFilePath(null);
        setCurrentBook(null);
      },
    },
    { cancelCommand: 'cancel_open_book' },
  );

  const handleBookClick = useCallback(async (book: BookSummary) => {
    console.log('[Reading] 点击书籍:', book.title, 'filePath:', book.filePath, 'openingFilePath:', openingFilePath);
    // 重置「已加载路径」标记，确保每次点击都重新触发进度恢复（restore 守卫依赖它判断是否为新书）。
    // 否则回目录 / 切模块后再次打开同一本书时 loadedPathRef 仍等于该书路径，整个 restore 块被跳过，
    // selectedChapterIndex 停在 onMeta 设的 0 → 永远停在第 1 章（进度归零）。
    loadedPathRef.current = null;
    if (openingFilePath) {
      console.log('[Reading] 跳过：openingFilePath 非空（有书正在打开中）');
      return;
    }
    try {
      await openBook('open_book', { filePath: book.filePath });
      setCurrentBookPath(book.filePath);
    } catch (err) {
      console.error('[Reading] openBook 异常:', err);
    }
  }, [openingFilePath, openBook]);

  // 以安得云荟打开 / 拖入主窗口：复制进固定临时目录 → 注册为常驻库文件夹 → 打开目标书籍
  const processOpenWith = useCallback(async (items: OpenWithItem[]) => {
    try {
      const { dir, paths } = await importToOpenWithDir('reading', items);
      addRootPathEphemeral(dir);
      if (paths[0]) {
        await openBook('open_book', { filePath: paths[0] }).catch((e) =>
          console.error('[Reading] 以安得云荟打开失败:', e),
        );
      }
    } catch (err) {
      console.error('[Reading] 以安得云荟打开失败:', err);
    }
  }, [addRootPathEphemeral, openBook]);

  useEffect(() => {
    const unsub = registerOpenWithListener((m, files) => {
      if (m === 'reading') processOpenWith(files);
    });
    const pending = getPendingOpenWith('reading');
    if (pending) processOpenWith(pending);
    return unsub;
  }, [processOpenWith]);

  // ===== 阅读进度持久化（内嵌、常驻，无需开关）=====
  // 打开新书时恢复上次章节；章节陆续到达后夹紧索引；每秒累计阅读时长；节流写入 localStorage。
  useEffect(() => {
    if (!currentBook) {
      currentBookRef.current = null;
      loadedPathRef.current = null;
      return;
    }
    currentBookRef.current = currentBook;
    const total = currentBook.chapters.length;
    if (loadedPathRef.current !== currentBook.filePath) {
      loadedPathRef.current = currentBook.filePath;
      const saved = getReadingProgress(currentBook.filePath);
      // [DIAG] 阅读进度恢复诊断
      console.log('[reading-diag] restore', currentBook.filePath, 'saved=', saved ? { ch: saved.chapterIndex, sp: saved.scrollPercent, pic: saved.pageInChapter, tc: saved.totalChapters } : null);
      if (saved) {
        progressRef.current = { ...saved, totalChapters: total };
        setSelectedChapterIndex(saved.chapterIndex);
        // 恢复标记保持到章节流式加载完成（由下方独立 effect 延迟清除）。
        // 此前用 requestAnimationFrame 一帧后清除是致命 bug：章节流式到达前
        // 目标章节 DOM 尚不存在，ReadingView 无法应用跳转/滚动，恢复必然落空。
        setRestoreScrollPercent(saved.scrollPercent ?? 0);
        setRestorePageInChapter(saved.pageInChapter ?? 0);
      } else {
        progressRef.current = { chapterIndex: 0, scrollPercent: 0, totalChapters: total, secondsRead: 0, lastRead: Date.now() };
        setSelectedChapterIndex(0);
        setRestoreScrollPercent(null);
        setRestorePageInChapter(null);
      }
      dirtyRef.current = false;
    } else if (progressRef.current && total > 0) {
      progressRef.current.totalChapters = total;
      // 关键：仅在章节全部加载完成后才夹紧索引。流式加载期间 total 偏小，
      // 夹紧会把已保存的章节进度永久改小并写回（「进度归零」的元凶之一）。
      if (openingFilePath === null) {
        const clamped = Math.min(progressRef.current.chapterIndex, total - 1);
        if (clamped !== progressRef.current.chapterIndex) {
          progressRef.current.chapterIndex = clamped;
          setSelectedChapterIndex(clamped);
        }
      }
    }
  }, [currentBook, openingFilePath]);

  // 章节全部到达（openingFilePath 归 null）后，给 ReadingView 一小段时间应用
  // 最终跳转（每批章节到达都会重放恢复跳转），随后清除一次性恢复标记，
  // 避免后续用户点击章节/翻页被误用旧的滚动位置。
  useEffect(() => {
    if (!currentBook || openingFilePath !== null) return;
    if (restoreScrollPercent == null && restorePageInChapter == null) return;
    const t = setTimeout(() => {
      setRestoreScrollPercent(null);
      setRestorePageInChapter(null);
    }, 300);
    return () => clearTimeout(t);
  }, [currentBook, openingFilePath, restoreScrollPercent, restorePageInChapter]);

  // 章节切换 → 记录并标记脏
  useEffect(() => {
    if (!currentBookRef.current || !progressRef.current) return;
    progressRef.current.chapterIndex = selectedChapterIndex;
    progressRef.current.lastRead = Date.now();
    dirtyRef.current = true;
  }, [selectedChapterIndex]);

  // 阅读时长累计 + 节流持久化；卸载/切书时落盘
  useEffect(() => {
    if (!currentBook) return;
    // 在闭包中捕获本书路径，避免返回列表时 currentBookRef 被提前置空导致卸载落盘被跳过（进度丢失）
    const path = currentBook.filePath;
    const tick = setInterval(() => {
      if (progressRef.current) {
        progressRef.current.secondsRead += 1;
        progressRef.current.lastRead = Date.now();
        dirtyRef.current = true;
      }
    }, 1000);
    const flush = setInterval(() => {
      if (dirtyRef.current && progressRef.current) {
        saveReadingProgress(path, progressRef.current);
        dirtyRef.current = false;
      }
    }, 4000);
    return () => {
      clearInterval(tick);
      clearInterval(flush);
      if (progressRef.current) {
        saveReadingProgress(path, progressRef.current);
      }
    };
  }, [currentBook]);

  // 章内滚动进度上报
  const handleScrollProgress = useCallback((p: number) => {
    if (progressRef.current) {
      progressRef.current.scrollPercent = p;
      dirtyRef.current = true;
    }
  }, []);
  // 分页/双栏模式章内页码上报
  const handlePageProgress = useCallback((p: number) => {
    if (progressRef.current) {
      progressRef.current.pageInChapter = p;
      dirtyRef.current = true;
    }
  }, []);

  // 跨模块切换/重载恢复：阅读组件会被卸载，currentBook 随之丢失；
  // 挂载后若全量扫描完成且存在上次在读的书，自动重新打开并恢复进度。
  useEffect(() => {
    if (restoreStartedRef.current) return;
    if (currentBook || openingFilePath) return;
    if (!scanComplete) return;
    if (books.length === 0) return;
    const saved = getCurrentBookPath();
    if (!saved) return;
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    const savedNorm = norm(saved);
    const b = books.find(x => norm(x.filePath) === savedNorm);
    if (b) {
      restoreStartedRef.current = true;
      handleBookClick(b);
    } else {
      setCurrentBookPath(null);
    }
  }, [books, scanComplete, currentBook, openingFilePath, handleBookClick]);

  // startTransition：大 DOM 卸载非阻塞，避免返回书列表时卡顿
  const handleBackToList = useCallback(() => {
    startTransition(() => {
      setCurrentBook(null);
      setSelectedChapterIndex(0);
    });
    setCurrentBookPath(null);
  }, []);

  const handleChapterClick = useCallback((index: number) => {
    setSelectedChapterIndex(index);
  }, []);

  const handleOpenSettings = useCallback(() => {
    setShowSettings(prev => !prev);
  }, []);

  // 空状态：无根目录
  if (rootPaths.length === 0) {
    return (
      <EmptyState
        icon={
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--element-bg)]">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
        }
        title={T('reading.emptyTitle')}
        description={T('reading.emptyDesc')}
        buttonText={T('reading.emptyButton')}
        onSelect={handleSelectRoot}
      />
    );
  }

  // 加载中（扫描很快，简易 spinner，无取消按钮以免误导——scan_reading_root 不可中断）
  if (loading && books.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center h-full gap-3">
        <div className="w-6 h-6 border-2 border-[var(--element-bg)] border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-neutral-400 dark:text-stone-500">{T('reading.scanning')}</p>
      </div>
    );
  }

  // 无结果
  if (!loading && books.length === 0) {
    return (
      <NoResultsState
        text={T('reading.noFiles')}
        buttonText={T('shared.changeDir')}
        onSelect={handleSelectRoot}
      />
    );
  }

  return (
    <div className="flex-1 flex h-full overflow-hidden">
      <ReadingSidebar
        books={books}
        currentFilePath={currentBook?.filePath ?? null}
        openingFilePath={openingFilePath}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onBookClick={handleBookClick}
        onOpenSettings={handleOpenSettings}
        onChangeRoot={handleSelectRoot}
        currentBook={currentBook}
        currentChapterIndex={selectedChapterIndex}
        onChapterClick={handleChapterClick}
        onBackToBooks={handleBackToList}
        onOpenStats={() => setShowStats((v) => !v)}
      />
      <div className="flex-1 h-full overflow-hidden bg-[#f5f5f0] dark:bg-[#1c1917] relative">
        {currentBook ? (
          <ReadingView book={currentBook} onBack={handleBackToList} externalChapterIndex={selectedChapterIndex} onChapterChange={setSelectedChapterIndex} onScrollProgress={handleScrollProgress} externalScrollPercent={restoreScrollPercent} externalPageInChapter={restorePageInChapter} onPageProgress={handlePageProgress} />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center h-full gap-3 text-neutral-400 dark:text-stone-500">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-40">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            <p className="text-sm">{T('reading.selectBookHint')}</p>
          </div>
        )}
        {showStats && (
          <div className="absolute inset-0 z-20 bg-[#f5f5f0] dark:bg-[#1c1917]">
            <ReadingStatsPage
              books={books}
              onOpenBook={(b) => {
                if (b.filePath !== currentBook?.filePath) {
                  handleBookClick(b as BookSummary);
                } else {
                  // 已在阅读该书：直接跳回已保存进度（即便停留在别处也能「回到当前进度」）
                  const p = getReadingProgress(b.filePath);
                  if (p) {
                    setSelectedChapterIndex(p.chapterIndex);
                    setRestorePageInChapter(p.pageInChapter ?? 0);
                    setRestoreScrollPercent(p.scrollPercent ?? 0);
                  }
                }
                setShowStats(false);
              }}
              onClose={() => setShowStats(false)}
            />
          </div>
        )}
        {showSettings && (
          <div className="absolute inset-0 z-20 bg-[#f5f5f0] dark:bg-[#1c1917]">
            <SettingsContent
              rootPaths={rootPaths}
              onRemoveRoot={handleRemoveRoot}
              onClose={() => setShowSettings(false)}
              bookCount={books.length}
            />
          </div>
        )}
      </div>
    </div>
  );
}

  window.__PLUGIN_REGISTRY__.register({
    id: 'reading',
    name: T('reading.title'),
  iconName: 'BookOpen',
  kind: 'module',
  visible: true,
  component: ReadingModule,
  sidebar: undefined,
  settings: undefined,
});
