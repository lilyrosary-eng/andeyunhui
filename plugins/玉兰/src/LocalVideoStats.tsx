/// <reference path="../../global.d.ts" />
// 本地视频库 · 统计页（对齐音乐 / 阅读 / 图片模块的统计入口）。
//
// 只统计**已经扫描进内存**的文件夹元信息，不再二次读盘：
// 视频库动辄几百 GB，为了一个统计页重扫目录不值得。
// 网络视频的使用统计是另一份（online/VideoStatsView），两者互不影响。
const React = window.__HOST_REACT__;
const { useMemo } = React;
import { useLang } from '../../_shared/pluginRuntime';

interface VideoFolder {
  folderPath: string;
  folderName: string;
  videoCount: number;
}

interface LocalVideoStatsProps {
  folders: VideoFolder[];
  /** 有续播进度的条目（来自 localStorage），只用于展示「继续观看」数量 */
  resumeCount?: number;
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

export function LocalVideoStats({ folders, resumeCount = 0, onClose }: LocalVideoStatsProps) {
  useLang();

  const stats = useMemo(() => {
    const total = folders.reduce((n, f) => n + (f.videoCount || 0), 0);
    const sorted = [...folders].sort((a, b) => (b.videoCount || 0) - (a.videoCount || 0));
    const maxCount = Math.max(1, ...sorted.map((f) => f.videoCount || 0));
    const empty = folders.filter((f) => (f.videoCount || 0) === 0).length;
    const nonEmpty = folders.length - empty;
    return {
      total, sorted, maxCount, empty, nonEmpty,
      avg: nonEmpty > 0 ? Math.round(total / nonEmpty) : 0,
    };
  }, [folders]);

  const top = stats.sorted.slice(0, 8);

  return React.createElement('div', {
    className: 'h-full overflow-y-auto p-6 bg-[#f5f5f0] dark:bg-[#1c1917]',
  },
    React.createElement('div', { className: 'flex items-center gap-3 mb-4' },
      React.createElement('h2', { className: 'text-lg font-semibold text-neutral-800 dark:text-stone-100' }, '视频库 · 统计'),
      React.createElement('button', {
        onClick: onClose,
        className: 'btn-press ml-auto rounded-lg px-3 py-1.5 text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/10 transition-colors',
      }, '返回'),
    ),

    React.createElement('div', { className: 'grid grid-cols-2 gap-3 max-w-2xl' },
      React.createElement(StatCard, { label: '文件夹', value: String(folders.length), hint: `其中 ${stats.empty} 个为空` }),
      React.createElement(StatCard, { label: '视频总数', value: String(stats.total), hint: `平均每个文件夹 ${stats.avg} 个` }),
      React.createElement(StatCard, { label: '继续观看', value: String(resumeCount), hint: resumeCount > 0 ? '在主侧栏可直接接着播放' : '还没有未看完的视频' }),
      React.createElement(StatCard, {
        label: '最大文件夹',
        value: stats.sorted[0]?.folderName || '—',
        hint: stats.sorted[0] ? `${stats.sorted[0].videoCount} 个视频` : '还没有扫描结果',
      }),
    ),

    React.createElement('h3', {
      className: 'mt-6 mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400 dark:text-stone-500',
    }, '视频最多的文件夹'),

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
                  width: `${Math.round(((f.videoCount || 0) / stats.maxCount) * 100)}%`,
                  background: 'var(--element-bg)',
                },
              }),
            ),
            React.createElement('span', { className: 'w-10 shrink-0 text-right text-xs tabular-nums text-neutral-500 dark:text-stone-400' }, String(f.videoCount || 0)),
          ))
        ),
  );
}

export default LocalVideoStats;
