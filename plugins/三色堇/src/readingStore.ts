// 当前正在阅读的书籍路径（localStorage）。
// 说明：阅读进度与阅读统计已统一由 readingProgress.ts / ReadingStatsPage 承担；
// 本文件只保留「当前书」这一项，供跨模块切换/重启后恢复。
// 旧版的书签（Bookmark）与 reading_stats_v1 进度存储已移除——从未有 UI 接入。

const CURRENT_BOOK_KEY = 'reading_current_book_v1';

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
