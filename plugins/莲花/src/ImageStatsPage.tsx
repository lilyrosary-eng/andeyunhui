/// <reference path="../../global.d.ts" />
// 图片库 · 统计页（对齐音乐 / 视频模块的「统计」入口）。
//
// 数据全部来自已经扫描进内存的文件夹列表，不再触发二次磁盘扫描：
// 大图库重扫一次代价很高，而「有多少个文件夹 / 多少张图 / 占比」这些指标
// 用现有元信息就足够。所有统计只在本机计算，不上报。
const React = window.__HOST_REACT__;
const { useMemo } = React;
import { T, useLang } from '../../_shared/pluginRuntime';

interface ImageFolder {
  folderPath: string;
  folderName: string;
  coverImage: string;
  imageCount: number;
}

interface CustomAlbum {
  id: string;
  name: string;
  images: string[];
}

interface ImageStatsPageProps {
  folders: ImageFolder[];
  customAlbums: CustomAlbum[];
  onClose: () => void;
}

const CARD = 'rounded-2xl border border-black/10 dark:border-white/10 bg-white/70 dark:bg-stone-800/60 p-4';

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return React.createElement('div', { className: CARD },
    React.createElement('p', { className: 'text-xs text-neutral-500 dark:text-stone-400' }, label),
    React.createElement('p', { className: 'mt-1 text-2xl font-bold tabular-nums text-neutral-800 dark:text-stone-100' }, value),
    hint ? React.createElement('p', { className: 'mt-0.5 text-[11px] text-neutral-400 dark:text-stone-500' }, hint) : null,
  );
}

export function ImageStatsPage({ folders, customAlbums, onClose }: ImageStatsPageProps) {
  useLang();

  const stats = useMemo(() => {
    const total = folders.reduce((n, f) => n + (f.imageCount || 0), 0);
    const albumImages = customAlbums.reduce((n, a) => n + (a.images?.length || 0), 0);
    const sorted = [...folders].sort((a, b) => (b.imageCount || 0) - (a.imageCount || 0));
    const maxCount = Math.max(1, ...sorted.map((f) => f.imageCount || 0));
    const empty = folders.filter((f) => (f.imageCount || 0) === 0).length;
    // 「平均每个文件夹」用有图的文件夹算，否则空目录会把均值稀释成没意义的数
    const nonEmpty = folders.length - empty;
    return {
      total, albumImages, sorted, maxCount, empty, nonEmpty,
      avg: nonEmpty > 0 ? Math.round(total / nonEmpty) : 0,
    };
  }, [folders, customAlbums]);

  const top = stats.sorted.slice(0, 8);

  return React.createElement('div', {
    className: 'absolute inset-0 z-20 overflow-y-auto p-6 bg-[#f5f5f0] dark:bg-[#1c1917]',
  },
    React.createElement('div', { className: 'flex items-center gap-3 mb-4' },
      React.createElement('h2', { className: 'text-lg font-semibold text-neutral-800 dark:text-stone-100' }, '图片库 · 统计'),
      React.createElement('button', {
        onClick: onClose,
        className: 'btn-press ml-auto rounded-lg px-3 py-1.5 text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/10 transition-colors',
      }, T('image.sidebar.back') || '返回'),
    ),

    React.createElement('div', { className: 'grid grid-cols-2 gap-3 max-w-2xl' },
      React.createElement(StatCard, { label: '文件夹', value: String(folders.length), hint: `其中 ${stats.empty} 个为空` }),
      React.createElement(StatCard, { label: '图片总数', value: String(stats.total), hint: `平均每个文件夹 ${stats.avg} 张` }),
      React.createElement(StatCard, { label: '自定义相册', value: String(customAlbums.length), hint: `共收录 ${stats.albumImages} 张` }),
      React.createElement(StatCard, {
        label: '最大文件夹',
        value: stats.sorted[0]?.folderName || '—',
        hint: stats.sorted[0] ? `${stats.sorted[0].imageCount} 张` : '还没有扫描结果',
      }),
    ),

    React.createElement('h3', {
      className: 'mt-6 mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400 dark:text-stone-500',
    }, '图片最多的文件夹'),

    top.length === 0
      ? React.createElement('p', { className: 'text-sm text-neutral-400 dark:text-stone-500' }, '还没有扫描到任何文件夹。')
      : React.createElement('div', { className: 'max-w-2xl space-y-1.5' },
          top.map((f) => React.createElement('div', {
            key: f.folderPath,
            className: 'flex items-center gap-3 rounded-xl px-3 py-2 bg-white/60 dark:bg-stone-800/50 border border-black/5 dark:border-white/5',
            title: f.folderPath,
          },
            React.createElement('span', { className: 'w-40 shrink-0 truncate text-xs text-neutral-700 dark:text-stone-200' }, f.folderName),
            React.createElement('div', { className: 'flex-1 h-1.5 rounded-full overflow-hidden bg-black/5 dark:bg-white/10' },
              React.createElement('div', {
                className: 'h-full rounded-full',
                style: {
                  width: `${Math.round(((f.imageCount || 0) / stats.maxCount) * 100)}%`,
                  background: 'var(--element-bg)',
                },
              }),
            ),
            React.createElement('span', { className: 'w-10 shrink-0 text-right text-xs tabular-nums text-neutral-500 dark:text-stone-400' }, String(f.imageCount || 0)),
          ))
        ),
  );
}

export default ImageStatsPage;
