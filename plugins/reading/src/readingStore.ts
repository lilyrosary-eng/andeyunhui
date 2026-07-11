// 阅读进度 / 书签的本地持久化（localStorage）。
// 用书籍完整文件路径作键；命中由调用方基于元信息判断，不依赖缓存机制。
// 仅保存索引类轻量数据（章节号、页码、时间戳），重开时结合流式解析结果跳转。

export interface Bookmark {
  chapterIndex: number;
  page: number;
  chapterTitle: string;
  note?: string;
  createdAt: number;
}

export interface BookStat {
  filePath: string;
  title: string;
  format: string;
  chapterIndex: number;
  page: number;
  totalChapters: number;
  /** 整体阅读进度 0..1（按章节近似） */
  progress: number;
  updatedAt: number;
  bookmarks: Bookmark[];
}

type Store = Record<string, BookStat>;

const STORAGE_KEY = 'reading_stats_v1';
const CURRENT_BOOK_KEY = 'reading_current_book_v1';

function loadStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function saveStore(s: Store): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* 忽略写入异常（隐私模式等） */
  }
}

/** 保存当前正在阅读的书籍路径（跨模块切换恢复用） */
export function setCurrentBookPath(filePath: string | null): void {
  try {
    if (filePath) {
      localStorage.setItem(CURRENT_BOOK_KEY, filePath);
    } else {
      localStorage.removeItem(CURRENT_BOOK_KEY);
    }
  } catch {
    /* 忽略 */
  }
}

/** 获取上次未读完的书籍路径（跨模块切换恢复用） */
export function getCurrentBookPath(): string | null {
  try {
    return localStorage.getItem(CURRENT_BOOK_KEY);
  } catch {
    return null;
  }
}

export function getStat(filePath: string): BookStat | undefined {
  return loadStore()[filePath];
}

export function getAllStats(): BookStat[] {
  return Object.values(loadStore()).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 记录阅读进度（章节级近似 + 页码）。调用频繁，写入成本低。 */
export function updateProgress(
  filePath: string,
  title: string,
  format: string,
  chapterIndex: number,
  page: number,
  totalChapters: number,
): void {
  const s = loadStore();
  const prev = s[filePath];
  const progress =
    totalChapters > 0 ? Math.min(1, (chapterIndex + (page > 0 ? 0.5 : 0)) / totalChapters) : 0;
  s[filePath] = {
    filePath,
    title,
    format,
    chapterIndex,
    page,
    totalChapters,
    progress,
    updatedAt: Date.now(),
    bookmarks: prev ? prev.bookmarks : [],
  };
  saveStore(s);
}

export function addBookmark(filePath: string, bm: Bookmark): void {
  const s = loadStore();
  const prev = s[filePath];
  if (!prev) return;
  prev.bookmarks = [...prev.bookmarks, bm].sort(
    (a, b) => a.chapterIndex - b.chapterIndex || a.createdAt - b.createdAt,
  );
  s[filePath] = prev;
  saveStore(s);
}

export function removeBookmark(filePath: string, createdAt: number): void {
  const s = loadStore();
  const prev = s[filePath];
  if (!prev) return;
  prev.bookmarks = prev.bookmarks.filter((b) => b.createdAt !== createdAt);
  s[filePath] = prev;
  saveStore(s);
}
