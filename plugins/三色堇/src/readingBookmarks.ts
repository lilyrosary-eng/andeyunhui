// 阅读书签：记住「某一章 + 章内位置」，可一键跳回。
//
// 与高亮/批注（readingHighlights.ts）相互独立：高亮挂在选中的文字上，书签挂在阅读位置上，
// 所以书签在没加过任何高亮的书里也能用。数据同样只留 localStorage，不碰用户书籍目录。
//
// 存储形状：
//   { [bookPath]: Bookmark[] }
// 每个书签的 pageInChapter 是「章内第几页」（分页模式）；竖版没有页的概念，
// 用 useProgress=true 让跳转逻辑按章内滚动百分比恢复（与 ReadingView 的外部恢复路径一致）。

export interface ReadingBookmark {
  id: string;
  chapterIndex: number;
  pageInChapter: number;
  /** true = 竖版书签（按章内滚动百分比恢复）；false = 分页书签（按章内页码恢复） */
  useProgress: boolean;
  /** 展示文案，如「第 3 章 · 第 5 页」 */
  label: string;
  createdAt: number;
}

const KEY = 'reading_bookmarks_v1';

type Store = Record<string, ReadingBookmark[]>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw) as Store;
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* 配额满/隐私模式：本次不持久化，不影响阅读 */
  }
}

/** 某本书的全部书签（新的在前）。 */
export function listBookmarks(bookPath: string): ReadingBookmark[] {
  const arr = readStore()[bookPath];
  if (!Array.isArray(arr)) return [];
  const valid = arr.filter((b) => b && typeof b.id === 'string' && typeof b.chapterIndex === 'number');
  return valid.sort((a, b) => b.createdAt - a.createdAt);
}

/** 添加书签（返回新列表）。同一位置重复添加会被去重（章 + 页相同即视为同一书签）。 */
export function addBookmark(bookPath: string, bm: Omit<ReadingBookmark, 'id' | 'createdAt'>): ReadingBookmark[] {
  const store = readStore();
  const list = Array.isArray(store[bookPath]) ? store[bookPath] : [];
  const dup = list.find((b) => b.chapterIndex === bm.chapterIndex && b.pageInChapter === bm.pageInChapter && b.useProgress === bm.useProgress);
  if (dup) return listBookmarks(bookPath);
  const next = [
    { ...bm, id: `bm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, createdAt: Date.now() },
    ...list,
  ];
  store[bookPath] = next;
  writeStore(store);
  return listBookmarks(bookPath);
}

/** 删除书签。 */
export function removeBookmark(bookPath: string, id: string): ReadingBookmark[] {
  const store = readStore();
  const list = Array.isArray(store[bookPath]) ? store[bookPath] : [];
  store[bookPath] = list.filter((b) => b.id !== id);
  writeStore(store);
  return listBookmarks(bookPath);
}

/** 判断某位置是否已有书签（用于顶部按钮的高亮）。 */
export function findBookmarkAt(bookPath: string, chapterIndex: number, pageInChapter: number, useProgress: boolean): ReadingBookmark | undefined {
  return listBookmarks(bookPath).find(
    (b) => b.chapterIndex === chapterIndex && b.pageInChapter === pageInChapter && b.useProgress === useProgress,
  );
}
