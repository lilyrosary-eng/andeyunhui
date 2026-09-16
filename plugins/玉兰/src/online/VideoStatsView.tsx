/// <reference path="../../../global.d.ts" />
// 网络视频 · 统计视图（对齐音乐模块的「统计」入口）
// 数据来自本地计数（stats.ts），不上报。
import React from 'react';
import { subscribeStats, resetStats, type VideoOnlineStats } from './stats';
import { VIDEO_PLATFORMS } from './videoPlatforms';

const { useState, useEffect } = React;

export function VideoStatsView() {
  const [stats, setStats] = useState<VideoOnlineStats>({ plays: 0, downloads: 0, byPlatform: {} });
  useEffect(() => subscribeStats(setStats), []);

  const rows = VIDEO_PLATFORMS.filter((p) => p.mode === 'api').map((p) => ({
    id: p.id,
    name: p.name,
    accent: p.accent,
    plays: stats.byPlatform[p.id] || 0,
  }));
  const maxPlays = Math.max(1, ...rows.map((r) => r.plays));

  return React.createElement(
    'div',
    { className: 'absolute inset-0 overflow-y-auto p-6' },
    React.createElement('h2', { className: 'text-lg font-semibold text-neutral-800 dark:text-stone-100 mb-4' }, '网络视频 · 使用统计'),
    React.createElement(
      'div',
      { className: 'grid grid-cols-2 gap-3 max-w-2xl' },
      React.createElement(
        'div',
        { className: 'glass-panel p-4 rounded-2xl' },
        React.createElement('p', { className: 'text-xs text-neutral-500 dark:text-stone-400' }, '播放次数'),
        React.createElement('p', { className: 'text-2xl font-bold text-neutral-800 dark:text-stone-100 mt-1' }, String(stats.plays)),
      ),
      React.createElement(
        'div',
        { className: 'glass-panel p-4 rounded-2xl' },
        React.createElement('p', { className: 'text-xs text-neutral-500 dark:text-stone-400' }, '下载次数'),
        React.createElement('p', { className: 'text-2xl font-bold text-neutral-800 dark:text-stone-100 mt-1' }, String(stats.downloads)),
      ),
    ),
    React.createElement(
      'div',
      { className: 'mt-6 max-w-2xl' },
      React.createElement('p', { className: 'text-xs font-medium text-neutral-500 dark:text-stone-400 mb-3' }, '各平台播放分布'),
      rows.length === 0
        ? React.createElement('p', { className: 'text-sm text-neutral-400 dark:text-stone-500' }, '暂无数据')
        : rows.map((r) =>
            React.createElement(
              'div',
              { key: r.id, className: 'mb-2' },
              React.createElement(
                'div',
                { className: 'flex items-center justify-between text-xs mb-1' },
                React.createElement('span', { className: 'text-neutral-600 dark:text-stone-300' }, r.name),
                React.createElement('span', { className: 'text-neutral-400 dark:text-stone-500' }, `${r.plays} 次`),
              ),
              React.createElement(
                'div',
                { className: 'h-1.5 rounded bg-neutral-200 dark:bg-stone-700 overflow-hidden' },
                React.createElement('div', { className: 'h-full rounded', style: { width: `${(r.plays / maxPlays) * 100}%`, background: r.accent } }),
              ),
            ),
          ),
    ),
    React.createElement(
      'button',
      {
        onClick: () => resetStats(),
        className: 'btn-press mt-6 px-3 py-1.5 rounded-lg text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-stone-700 transition-colors',
      },
      '重置统计',
    ),
    React.createElement(
      'p',
      { className: 'mt-4 text-[11px] text-neutral-400 dark:text-stone-500 max-w-2xl leading-relaxed' },
      '说明：统计仅保存在本机，不联网上报；「播放次数」在点击播放时 +1，「下载次数」在单次下载任务成功时 +1。',
    ),
  );
}

export default VideoStatsView;
