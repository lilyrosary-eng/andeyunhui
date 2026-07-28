/// <reference path="../../global.d.ts" />

// 阅读进度持久化（内嵌、常驻，无需开关）：
// 按书籍 filePath 记录当前章节、章内滚动进度、总章数、累计阅读秒数、上次阅读时间。
// 数据存于 localStorage，随应用数据持久化；跨重启保留，下次打开同一本书自动恢复到上次章节。

export interface ReadingProgress {
  chapterIndex: number;
  scrollPercent: number;
  totalChapters: number;
  secondsRead: number;
  lastRead: number;
}

const KEY = 'andeyunhui.reading.progress.v1';

type Store = Record<string, ReadingProgress>;

function readAll(): Store {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as Store;
  } catch {
    return {};
  }
}

export function getReadingProgress(filePath: string): ReadingProgress | null {
  const all = readAll();
  return all[filePath] || null;
}

export function saveReadingProgress(filePath: string, data: ReadingProgress): void {
  try {
    const all = readAll();
    all[filePath] = data;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // 存储不可用或被占满时静默忽略，相关后果由用户自行承担
  }
}

export function clearReadingProgress(filePath: string): void {
  try {
    const all = readAll();
    delete all[filePath];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // 忽略
  }
}
