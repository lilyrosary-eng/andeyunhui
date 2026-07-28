/// <reference path="../../global.d.ts" />
import { useState, useMemo } from 'react';
import { getReadingProgress } from './readingProgress';

interface StatsBook {
  filePath: string;
  title: string;
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${sec} 秒`;
  return `${sec} 秒`;
}

function formatDate(ts: number): string {
  try {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return '—';
  }
}

function BookStatRow({ book, onOpenBook }: { book: StatsBook; onOpenBook: (b: StatsBook) => void }) {
  const [expanded, setExpanded] = useState(false);
  const progress = getReadingProgress(book.filePath);
  const total = progress?.totalChapters || 0;
  const chapterIdx = progress ? Math.min(progress.chapterIndex, Math.max(0, total - 1)) : 0;
  const overall = total > 0 && progress ? Math.round(((chapterIdx + progress.scrollPercent / 100) / total) * 100) : 0;
  const started = !!progress;

  return (
    <div className="rounded-xl border border-black/5 dark:border-white/10 bg-white/40 dark:bg-white/5 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-neutral-700 dark:text-stone-200 truncate">{book.title}</div>
          <div className="text-xs text-neutral-500 dark:text-stone-400 mt-0.5">
            {started ? `第 ${chapterIdx + 1} / ${total} 章 · 总进度 ${overall}%` : '尚未开始阅读'}
          </div>
        </div>
        <span className="ml-3 text-xs text-neutral-400 dark:text-stone-500 shrink-0">
          {expanded ? '收起' : '展开'}
        </span>
      </button>
      {expanded && (
        <div className="px-4 pb-4 pt-1 border-t border-black/5 dark:border-white/10">
          <div className="h-2 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden mb-3">
            <div
              className="h-full rounded-full"
              style={{ width: `${overall}%`, background: 'var(--element-color-raw, #6366f1)' }}
            />
          </div>
          <div className="space-y-1.5 text-xs text-neutral-600 dark:text-stone-300">
            <div className="flex justify-between">
              <span className="text-neutral-500 dark:text-stone-400">当前章节</span>
              <span>{started ? `${chapterIdx + 1} / ${total}` : '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-500 dark:text-stone-400">累计阅读时长</span>
              <span>{progress ? formatDuration(progress.secondsRead) : '0 秒'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-500 dark:text-stone-400">上次阅读</span>
              <span>{progress ? formatDate(progress.lastRead) : '—'}</span>
            </div>
          </div>
          <button
            onClick={() => onOpenBook(book)}
            className="mt-3 w-full btn-press px-3 py-2 rounded-lg bg-[var(--element-color-raw)]/10 text-[var(--element-color-raw)] hover:bg-[var(--element-color-raw)]/20 transition-colors text-sm font-medium"
          >
            回到当前阅读进度
          </button>
        </div>
      )}
    </div>
  );
}

export function ReadingStatsPage({
  books,
  onOpenBook,
  onClose,
}: {
  books: StatsBook[];
  onOpenBook: (b: StatsBook) => void;
  onClose: () => void;
}) {
  // 汇总：总数、已开始数、累计阅读总时长
  const summary = useMemo(() => {
    let started = 0;
    let totalSeconds = 0;
    for (const b of books) {
      const p = getReadingProgress(b.filePath);
      if (p) {
        started += 1;
        totalSeconds += p.secondsRead || 0;
      }
    }
    return { total: books.length, started, totalSeconds };
  }, [books]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-lg font-semibold text-neutral-800 dark:text-stone-100">阅读统计</h2>
            <p className="text-xs text-neutral-500 dark:text-stone-400 mt-0.5">
              共 {books.length} 本书 · 点击任意书籍可回到其阅读进度
            </p>
          </div>
          <button
            onClick={onClose}
            className="btn-press px-3 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm text-neutral-600 dark:text-stone-300 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors"
          >
            返回
          </button>
        </div>
        {books.length > 0 && (
          <div className="grid grid-cols-3 gap-3 mb-5">
            <div className="rounded-xl border border-black/5 dark:border-white/10 bg-white/40 dark:bg-white/5 px-4 py-3">
              <div className="text-2xl font-semibold text-neutral-800 dark:text-stone-100">{summary.total}</div>
              <div className="text-xs text-neutral-500 dark:text-stone-400 mt-0.5">总书籍</div>
            </div>
            <div className="rounded-xl border border-black/5 dark:border-white/10 bg-white/40 dark:bg-white/5 px-4 py-3">
              <div className="text-2xl font-semibold text-neutral-800 dark:text-stone-100">{summary.started}</div>
              <div className="text-xs text-neutral-500 dark:text-stone-400 mt-0.5">已开始阅读</div>
            </div>
            <div className="rounded-xl border border-black/5 dark:border-white/10 bg-white/40 dark:bg-white/5 px-4 py-3">
              <div className="text-2xl font-semibold text-neutral-800 dark:text-stone-100">{formatDuration(summary.totalSeconds)}</div>
              <div className="text-xs text-neutral-500 dark:text-stone-400 mt-0.5">累计阅读时长</div>
            </div>
          </div>
        )}
        {books.length === 0 ? (
          <div className="text-sm text-neutral-400 dark:text-stone-500 py-10 text-center">尚未添加任何书籍目录</div>
        ) : (
          <div className="space-y-3">
            {books.map((b) => (
              <BookStatRow key={b.filePath} book={b} onOpenBook={onOpenBook} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
