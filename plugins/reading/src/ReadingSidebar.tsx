/// <reference path="../../global.d.ts" />
// 阅读模块侧边栏 — 双层 drill-down：
// 第一层：嵌套目录树（母目录 + 子目录 + 书籍）
// 第二层：选中书后切换为章节目录（点击章节在主区域跳转）
const React = window.__HOST_REACT__;
const { useMemo, useState } = React;
const { ModuleSidebarShell, SecondaryNavShell } = window.__HOST_UI__ || {};

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
  onBackToBooks: () => void;
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
    let currentLevel = rootDirs;
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
  const {
    books, currentFilePath, openingFilePath,
    searchQuery, onSearchChange,
    onBookClick, onOpenSettings, onChangeRoot,
    currentBook, currentChapterIndex, onChapterClick, onBackToBooks,
  } = props;

  // ====== 第二层：章节目录（选中书后显示）======
  if (currentBook) {
    const chapterItems: React.ReactNode[] = [];
    if (currentBook.chapters.length === 0) {
      chapterItems.push(React.createElement('div', {
        key: 'loading',
        className: 'flex items-center justify-center py-12 text-xs text-neutral-400 dark:text-stone-500',
      },
        React.createElement('div', {
          className: 'w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin mr-2',
        }),
        '正在加载章节...',
      ));
    } else {
      currentBook.chapters.forEach((ch, i) => {
        const isCurrent = i === currentChapterIndex;
        chapterItems.push(React.createElement('button', {
          key: ch.id || i,
          onClick: () => onChapterClick(i),
          className: `w-full text-left px-2 py-1.5 rounded-lg transition-colors flex items-center gap-2 text-sm ${
            isCurrent
              ? 'bg-[var(--element-bg)]/10 text-[var(--element-bg)]'
              : 'text-neutral-600 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5'
          }`,
        },
          React.createElement('span', { className: 'flex-shrink-0 opacity-60' }, React.createElement(ChapterIcon)),
          React.createElement('span', { className: 'flex-1 truncate' },
            React.createElement('span', { className: 'text-[10px] text-neutral-400 dark:text-stone-500 mr-1.5' }, `${i + 1}.`),
            ch.title || `第 ${i + 1} 章`,
          ),
        ));
      });
    }

    const chapterList = React.createElement('div', { className: 'space-y-0.5' }, ...chapterItems);
    const wrappedChapterList = SecondaryNavShell
      ? React.createElement(SecondaryNavShell, null,
          React.createElement('div', { className: 'flex-1 overflow-y-auto pr-1' }, chapterList),
        )
      : React.createElement('div', { className: 'flex-1 overflow-y-auto pr-1' }, chapterList);

    return ModuleSidebarShell
      ? React.createElement(ModuleSidebarShell, {
          moduleId: 'reading',
          icon: React.createElement(BookIcon),
          title: currentBook.title,
          onOpenModuleSettings: onOpenSettings,
          searchQuery: '',
          onSearchChange: () => {},
          searchPlaceholder: `${currentBook.chapters.length} 章`,
          primaryAction: { label: '← 返回书列表', onClick: onBackToBooks },
          children: wrappedChapterList,
        })
      : null;
  }

  // ====== 第一层：书籍列表（默认）======
  const { rootBooks, rootDirs } = useMemo(() => buildTree(books), [books]);
  const hasDirs = rootDirs.length > 0;

  const filteredRootBooks = useMemo(() => {
    if (!searchQuery.trim()) return rootBooks;
    const q = searchQuery.trim().toLowerCase();
    return rootBooks.filter(b => b.title.toLowerCase().includes(q));
  }, [rootBooks, searchQuery]);

  const isSearching = searchQuery.trim().length > 0;
  const totalBooks = books.length;

  // 构建子元素列表（避免嵌套三元 + spread 导致 TS 解析错误）
  const childrenParts: React.ReactNode[] = [];
  if (filteredRootBooks.length > 0) {
    if (hasDirs) {
      childrenParts.push(React.createElement('div', {
        key: 'root-header',
        className: 'px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-stone-500',
      }, `📚 根目录 · ${filteredRootBooks.length} 本`));
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
    }, '暂无书籍'));
  }

  const treeContent = React.createElement('div', { className: 'space-y-0.5' },
    ...childrenParts,
  );

  const wrappedList = SecondaryNavShell
    ? React.createElement(SecondaryNavShell, null,
        React.createElement('div', { className: 'flex-1 overflow-y-auto pr-1' }, treeContent),
      )
    : React.createElement('div', { className: 'flex-1 overflow-y-auto pr-1' }, treeContent);

  return ModuleSidebarShell
    ? React.createElement(ModuleSidebarShell, {
        moduleId: 'reading',
        icon: React.createElement(BookIcon),
        title: '三色堇',
        onOpenModuleSettings: onOpenSettings,
        searchQuery,
        onSearchChange,
        searchPlaceholder: `搜索 ${totalBooks} 本书...`,
        primaryAction: { label: '+ 选择根目录', onClick: onChangeRoot },
        children: wrappedList,
      })
    : null;
}

export default ReadingSidebar;
