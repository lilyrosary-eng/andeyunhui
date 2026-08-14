import React from "react";
const { useState, useEffect } = React;
import { T, useLang } from '../../_shared/pluginRuntime';
import { kugou, type KugouPlaylistCard } from './kugouApi';

function fmtInt(n: number, lang: string): string {
  if (lang.startsWith('zh') || lang.startsWith('ja') || lang.startsWith('ko')) {
    return n.toLocaleString('zh-CN');
  }
  return n.toLocaleString('en-US');
}

function fmtPlayCount(n: number, lang: string): string {
  if (!n) return '0';
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return fmtInt(n, lang);
}

function RefreshCwIcon() {
  return React.createElement('svg', {
    width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  }, [
    React.createElement('path', { key: '1', d: 'M23 4v6h-6' }),
    React.createElement('path', { key: '2', d: 'M1 20v-6h6' }),
    React.createElement('path', { key: '3', d: 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15' }),
  ]);
}

function ListMusicIcon() {
  return React.createElement('svg', {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  }, [
    React.createElement('line', { key: '1', x1: '8', y1: '6', x2: '21', y2: '6' }),
    React.createElement('line', { key: '2', x1: '8', y1: '12', x2: '21', y2: '12' }),
    React.createElement('line', { key: '3', x1: '8', y1: '18', x2: '21', y2: '18' }),
    React.createElement('line', { key: '4', x1: '3', y1: '6', x2: '3.01', y2: '6' }),
    React.createElement('line', { key: '5', x1: '3', y1: '12', x2: '3.01', y2: '12' }),
    React.createElement('line', { key: '6', x1: '3', y1: '18', x2: '3.01', y2: '18' }),
  ]);
}

export default function KugouStatsView() {
  const lang = useLang();
  const [ranks, setRanks] = useState<KugouPlaylistCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    kugou
      .getRankList()
      .then((list) => setRanks(list))
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalPlay = ranks.reduce((sum, r) => sum + (r.playCount || 0), 0);

  const header = React.createElement('div', { className: 'flex items-center justify-between mb-4' },
    React.createElement('h2', { className: 'text-lg font-semibold text-neutral-800 dark:text-stone-100' }, T('music.stats.title', '统计')),
    React.createElement('button', {
      onClick: load,
      className: 'flex items-center gap-1 text-xs text-neutral-400 dark:text-stone-500 hover:text-[var(--element-color-raw)] transition-colors',
    }, [
      React.createElement(RefreshCwIcon, { key: 'i' }),
      React.createElement('span', { key: 't' }, T('music.netease.stats.refresh', '刷新')),
    ]),
  );

  if (loading) {
    return React.createElement('div', { className: 'p-6' }, header,
      React.createElement('div', { className: 'text-neutral-400 dark:text-stone-500 text-sm py-12 text-center' }, T('music.stats.loading', '加载中…')),
    );
  }

  if (error) {
    return React.createElement('div', { className: 'p-6' }, header,
      React.createElement('div', { className: 'text-red-500/80 text-sm py-12 text-center' }, error),
    );
  }

  const summary = React.createElement('div', { className: 'grid grid-cols-2 gap-3 mb-6' }, [
    React.createElement('div', { key: 'a', className: 'rounded-2xl bg-[var(--element-muted)]/60 p-4' }, [
      React.createElement('div', { key: 'v', className: 'text-2xl font-semibold text-neutral-800 dark:text-stone-100' }, fmtInt(ranks.length, lang)),
      React.createElement('div', { key: 'l', className: 'text-xs text-neutral-400 dark:text-stone-500 mt-1' }, T('music.stats.rankCount', '榜单数')),
    ]),
    React.createElement('div', { key: 'b', className: 'rounded-2xl bg-[var(--element-muted)]/60 p-4' }, [
      React.createElement('div', { key: 'v', className: 'text-2xl font-semibold text-neutral-800 dark:text-stone-100' }, fmtPlayCount(totalPlay, lang)),
      React.createElement('div', { key: 'l', className: 'text-xs text-neutral-400 dark:text-stone-500 mt-1' }, T('music.stats.totalPlay', '总播放量')),
    ]),
  ]);

  const list = React.createElement('div', { className: 'space-y-2' },
    React.createElement('div', { className: 'flex items-center gap-2 text-sm font-medium text-neutral-600 dark:text-stone-300 mb-1' }, [
      React.createElement(ListMusicIcon, { key: 'i' }),
      React.createElement('span', { key: 't' }, T('music.stats.rankPlay', '榜单播放量')),
    ]),
    ...ranks.map((r, idx) =>
      React.createElement('div', {
        key: r.id,
        className: 'flex items-center gap-3 px-3 py-2 rounded-xl bg-black/[0.02] dark:bg-white/[0.02] hover:bg-black/5 dark:hover:bg-white/5 transition-colors',
      }, [
        React.createElement('span', { key: 'rank', className: 'text-sm font-semibold text-neutral-400 dark:text-stone-500 w-5 text-center' }, String(idx + 1)),
        React.createElement('div', { key: 'name', className: 'flex-1 min-w-0 truncate text-sm text-neutral-700 dark:text-stone-200' }, r.name),
        React.createElement('span', { key: 'count', className: 'text-xs text-neutral-400 dark:text-stone-500 tabular-nums' }, `${fmtPlayCount(r.playCount || 0, lang)} 播放`),
      ]),
    ),
  );

  return React.createElement('div', { className: 'p-6' }, header, summary, list);
}
