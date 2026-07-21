/// <reference path="../../global.d.ts" />
// 阅读插件入口 — 书籍列表 + 阅读视图骨架
import { ReadingSidebar } from './ReadingSidebar';
import { ReadingView } from './ReadingView';
import { useRootPaths, EmptyState, NoResultsState, useStreamingOpen } from '../../_shared/pluginRuntime';
import { registerOpenWithListener, getPendingOpenWith, importToOpenWithDir, type OpenWithItem } from '../../_shared/openWithFiles';

const React = window.__HOST_REACT__;
const { useState, useEffect, useCallback, startTransition } = React;
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

  return React.createElement(ModuleSettingsPanel, {
    title: '三色堇',
    icon: React.createElement(BookIcon),
    onClose,
    children: React.createElement('div', { className: 'space-y-4' },
      // 阅读目录
      React.createElement('div', { className: 'glass-panel p-4' },
        React.createElement('label', { className: 'block text-xs font-medium text-neutral-500 dark:text-stone-400 mb-2' }, '阅读目录'),
        rootPaths.length === 0
          ? React.createElement('p', { className: 'text-sm text-neutral-400 dark:text-stone-500' }, '尚未添加任何文件夹')
          : React.createElement('div', { className: 'space-y-2' },
              ...rootPaths.map((path) =>
                React.createElement('div', { key: path, className: 'flex items-center gap-2 group' },
                  React.createElement('span', { className: 'flex-1 text-sm text-neutral-600 dark:text-stone-300 truncate' }, path),
                  React.createElement('button', {
                    onClick: () => onRemoveRoot(path),
                    className: 'btn-press px-2 py-1 rounded text-xs text-neutral-400 dark:text-stone-500 hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100',
                    title: '移除',
                  }, '移除'),
                )
              ),
            ),
      ),
      // 支持格式
      React.createElement('div', { className: 'glass-panel p-4' },
        React.createElement('label', { className: 'block text-xs font-medium text-neutral-500 dark:text-stone-400 mb-2' }, '支持格式'),
        React.createElement('p', { className: 'text-sm text-neutral-600 dark:text-stone-300' }, 'TXT、EPUB、PDF、DOCX'),
      ),
      // 统计
      React.createElement('div', { className: 'glass-panel p-4' },
        React.createElement('p', { className: 'text-xs text-neutral-400 dark:text-stone-500' }, `已扫描 ${bookCount} 本书`),
      ),
    ),
  });
}

// ========== 主组件 ==========
function ReadingModule() {
  const { rootPaths, addRoot, addRootPath, removeRoot } = useRootPaths(STORAGE_KEY_ROOT);
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentBook, setCurrentBook] = useState<ReadingBook | null>(null);
  const [openingFilePath, setOpeningFilePath] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedChapterIndex, setSelectedChapterIndex] = useState(0);

  // 根目录变化 → 扫描所有根（缓存优先 + 流式增量加载）
  useEffect(() => {
    if (rootPaths.length === 0) {
      setBooks([]);
      setCurrentBook(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
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
        setBooks([...all]);
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
      setBooks(freshAll);
      setLoading(false);
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
    setBooks(prev => prev.filter(b => !underRoot(b.filePath)));
    setCurrentBook(prev => (prev && underRoot(prev.filePath)) ? null : prev);
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
    if (openingFilePath) {
      console.log('[Reading] 跳过：openingFilePath 非空（有书正在打开中）');
      return;
    }
    try {
      await openBook('open_book', { filePath: book.filePath });
    } catch (err) {
      console.error('[Reading] openBook 异常:', err);
    }
  }, [openingFilePath, openBook]);

  // 以安得云荟打开 / 拖入主窗口：复制进固定临时目录 → 注册为常驻库文件夹 → 打开目标书籍
  const processOpenWith = useCallback(async (items: OpenWithItem[]) => {
    try {
      const { dir, paths } = await importToOpenWithDir('reading', items);
      addRootPath(dir);
      if (paths[0]) {
        await openBook('open_book', { filePath: paths[0] }).catch((e) =>
          console.error('[Reading] 以安得云荟打开失败:', e),
        );
      }
    } catch (err) {
      console.error('[Reading] 以安得云荟打开失败:', err);
    }
  }, [addRootPath, openBook]);

  useEffect(() => {
    const unsub = registerOpenWithListener((m, files) => {
      if (m === 'reading') processOpenWith(files);
    });
    const pending = getPendingOpenWith('reading');
    if (pending) processOpenWith(pending);
    return unsub;
  }, [processOpenWith]);

  // startTransition：大 DOM 卸载非阻塞，避免返回书列表时卡顿
  const handleBackToList = useCallback(() => {
    startTransition(() => {
      setCurrentBook(null);
      setSelectedChapterIndex(0);
    });
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
        title="阅读模块"
        description="选择一个包含电子书的文件夹，支持 TXT / EPUB / PDF / DOCX 格式"
        buttonText="选择阅读目录"
        onSelect={handleSelectRoot}
      />
    );
  }

  // 加载中（扫描很快，简易 spinner，无取消按钮以免误导——scan_reading_root 不可中断）
  if (loading && books.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center h-full gap-3">
        <div className="w-6 h-6 border-2 border-[var(--element-bg)] border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-neutral-400 dark:text-stone-500">正在扫描电子书...</p>
      </div>
    );
  }

  // 无结果
  if (!loading && books.length === 0) {
    return (
      <NoResultsState
        text="未找到电子书文件"
        buttonText="更换目录"
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
      />
      <div className="flex-1 h-full overflow-hidden bg-[#f5f5f0] dark:bg-[#1c1917]">
        {showSettings ? (
          <SettingsContent
            rootPaths={rootPaths}
            onRemoveRoot={handleRemoveRoot}
            onClose={() => setShowSettings(false)}
            bookCount={books.length}
          />
        ) : currentBook ? (
          <ReadingView book={currentBook} onBack={handleBackToList} externalChapterIndex={selectedChapterIndex} onChapterChange={setSelectedChapterIndex} />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center h-full gap-3 text-neutral-400 dark:text-stone-500">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-40">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            <p className="text-sm">从左侧选择一本书开始阅读</p>
          </div>
        )}
      </div>
    </div>
  );
}

window.__PLUGIN_REGISTRY__.register({
  id: 'reading',
  name: '三色堇',
  iconName: 'BookOpen',
  kind: 'module',
  visible: true,
  component: ReadingModule,
  sidebar: undefined,
  settings: undefined,
});
