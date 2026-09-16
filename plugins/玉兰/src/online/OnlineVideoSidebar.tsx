/// <reference path="../../../global.d.ts" />
// 视频模块 · 网络视频侧栏
//
// 复用 @shared/OnlineSidebarShell（对齐音乐在线侧栏的壳），结构对齐音乐的三块：
//   块1 平台列表（对应音乐的「我喜欢的音乐」位置）
//   块2 临时播放列表（在线播过的视频，可点回播放）
//   块3 下载队列（含「清空已完成」）
//
// 本次修复的缺陷：
//  - 返回入口：标题改为可点按钮（旧版传字符串 title，且壳内 onClose 从未被使用 → 进得去出不来）
//  - 设置/统计入口：补 onOpenModuleSettings / onOpenStats（旧版完全没传）
//  - 下载队列渲染字段错误：旧版读 t.name / t.progress（实际字段是 title / downloaded+total）→ 显示 undefined
//  - 队列只增不减：补「清空已完成」（clearFinished 之前零调用）
//  - 原生引擎开关状态不刷新：纯 API 架构下该开关已无意义，改为静态「支持 API」统计
import React from 'react';
import { VIDEO_PLATFORMS, apiPlatformCount, type OnlineVideoItem } from './videoPlatforms';
import { OnlineSidebarShell } from '@shared/OnlineSidebarShell';
import { VideoIcon } from '@shared/icons';
import { videoDownloadManager, type VideoDownloadTask } from './OnlineVideoDownloadManager';

const { useState, useEffect } = React;

/** 临时播放列表条目：网络视频里播过的项（内存态，用于从侧栏回到播放项） */
export interface VideoTempEntry {
  id: string;
  name: string;
  platformId: string;
  item: OnlineVideoItem;
}

interface Props {
  activeId: string | null;
  onSelect: (id: string) => void;
  onExit: () => void;
  onOpenModuleSettings?: () => void;
  onOpenStats?: () => void;
  statsActive?: boolean;
  temps: VideoTempEntry[];
  activeTempId?: string | null;
  onSelectTemp: (entry: VideoTempEntry) => void;
}

const modeLabel: Record<string, string> = {
  api: 'API',
  url: '浏览器',
};

function statusText(t: VideoDownloadTask): string {
  if (t.status === 'downloading') {
    const pct = t.total > 0 ? ` ${Math.min(100, Math.round((t.downloaded / t.total) * 100))}%` : '';
    return `下载中${pct}`;
  }
  if (t.status === 'queued') return '排队中';
  if (t.status === 'done') return '完成';
  if (t.status === 'error') return '失败';
  if (t.status === 'canceled') return '已取消';
  return t.status;
}

export function OnlineVideoSidebar({
  activeId,
  onSelect,
  onExit,
  onOpenModuleSettings,
  onOpenStats,
  statsActive,
  temps,
  activeTempId,
  onSelectTemp,
}: Props) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [dl, setDl] = useState<VideoDownloadTask[]>([]);
  useEffect(() => videoDownloadManager.subscribe(setDl), []);

  const apiCount = apiPlatformCount();
  const list = VIDEO_PLATFORMS.filter((p) => p.name.includes(search.trim()));
  const activeDl = dl.filter((t) => t.status === 'downloading' || t.status === 'queued').length;
  const finishedDl = dl.filter((t) => t.status === 'done' || t.status === 'error' || t.status === 'canceled').length;

  // ============ 块1：平台列表 ============
  const platformSection = React.createElement(
    'div',
    { className: 'space-y-1' },
    React.createElement(
      'div',
      { className: 'flex items-center gap-1.5 px-1 text-[11px] text-neutral-400 dark:text-stone-500' },
      React.createElement('span', null, `共 ${VIDEO_PLATFORMS.length} 个平台`),
      React.createElement('span', { className: 'opacity-40' }, '·'),
      React.createElement('span', null, `${apiCount} 个支持 API`),
    ),
    list.map((p) => {
      const isActive = activeId === p.id;
      const isHover = hovered === p.id;
      const supported = p.mode === 'api';
      return React.createElement(
        'button',
        {
          key: p.id,
          onClick: () => onSelect(p.id),
          onMouseEnter: () => setHovered(p.id),
          onMouseLeave: () => setHovered(null),
          className: `w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
            isActive ? 'bg-black/5 dark:bg-white/10' : isHover ? 'bg-black/[0.03] dark:bg-white/5' : ''
          }`,
        },
        React.createElement(
          'div',
          { className: 'flex h-9 w-9 items-center justify-center rounded-lg shrink-0 text-white text-xs font-bold', style: { background: p.accent } },
          p.name.slice(0, 1),
        ),
        React.createElement(
          'div',
          { className: 'flex-1 min-w-0' },
          React.createElement(
            'div',
            { className: 'flex items-center gap-1.5' },
            React.createElement('span', { className: 'text-sm font-medium text-neutral-800 dark:text-stone-100 truncate' }, p.name),
            React.createElement(
              'span',
              {
                className: `text-[10px] px-1 rounded shrink-0 ${supported ? '' : 'text-neutral-400 dark:text-stone-500'}`,
                style: supported ? { color: p.accent, background: `${p.accent}1a` } : undefined,
              },
              modeLabel[p.mode] ?? p.mode,
            ),
          ),
          React.createElement('p', { className: 'text-xs text-neutral-400 dark:text-stone-500 truncate' }, p.desc),
        ),
      );
    }),
    list.length === 0 && React.createElement('p', { className: 'text-center text-xs text-neutral-400 dark:text-stone-500 py-6' }, '无匹配平台'),
  );

  // ============ 块2：临时播放列表 ============
  const tempSection =
    temps.length > 0
      ? React.createElement(
          'div',
          { className: 'space-y-1 pt-3 border-t border-neutral-200/60 dark:border-stone-700/50' },
          React.createElement('div', { className: 'px-1 py-1 text-xs text-neutral-400 dark:text-stone-500' }, `临时播放列表 · ${temps.length}`),
          temps.map((t) => {
            const isActive = activeTempId === t.id;
            return React.createElement(
              'button',
              {
                key: t.id,
                onClick: () => onSelectTemp(t),
                className: `w-full text-left px-3 py-2 rounded-xl transition-colors text-sm ${
                  isActive
                    ? 'bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100'
                    : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400'
                }`,
              },
              React.createElement('div', { className: 'font-medium truncate' }, t.name),
              React.createElement('div', { className: 'text-xs text-neutral-400 dark:text-stone-500 truncate mt-0.5' }, t.platformId === 'douyin' ? '抖音' : '哔哩哔哩'),
            );
          }),
        )
      : null;

  // ============ 块3：下载队列 ============
  const downloadSection = React.createElement(
    'div',
    { className: 'space-y-1 pt-3 border-t border-neutral-200/60 dark:border-stone-700/50' },
    React.createElement(
      'div',
      { className: 'flex items-center gap-2 px-1 py-1 text-xs text-neutral-400 dark:text-stone-500' },
      React.createElement('span', null, '下载队列'),
      React.createElement('span', { className: 'flex-1' }),
      finishedDl > 0 &&
        React.createElement(
          'button',
          {
            onClick: () => videoDownloadManager.clearFinished(),
            className: 'hover:text-neutral-700 dark:hover:text-stone-200 transition-colors',
            title: '清空已完成/失败任务',
          },
          '清空',
        ),
      React.createElement('span', { className: activeDl > 0 ? 'text-emerald-500' : '' }, `${activeDl} 进行中 / ${dl.length} 总`),
    ),
    dl.length === 0
      ? React.createElement('div', { className: 'px-3 py-2 text-xs text-neutral-400 dark:text-stone-500' }, '暂无下载任务')
      : dl.map((t) =>
          React.createElement(
            'div',
            { key: t.id, className: 'group px-3 py-1.5 text-xs text-neutral-600 dark:text-stone-400' },
            React.createElement(
              'div',
              { className: 'flex items-center gap-2' },
              React.createElement('span', { className: 'flex-1 truncate', title: t.title }, t.title),
              React.createElement('span', { className: 'shrink-0 text-neutral-400 dark:text-stone-500' }, statusText(t)),
              React.createElement(
                'button',
                {
                  onClick: () => videoDownloadManager.remove(t.id),
                  className: 'shrink-0 opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-red-500 transition-opacity',
                  title: '移除',
                },
                '×',
              ),
            ),
            t.status === 'downloading' && t.total > 0
              ? React.createElement(
                  'div',
                  { className: 'h-0.5 mt-1 rounded bg-neutral-200 dark:bg-stone-600 overflow-hidden' },
                  React.createElement('div', {
                    className: 'h-full bg-emerald-500',
                    style: { width: `${Math.min(100, Math.round((t.downloaded / t.total) * 100))}%` },
                  }),
                )
              : null,
          ),
        ),
  );

  // 标题做成按钮：点击返回本地视频（与音乐侧栏一致；壳本身不消费 onClose）
  const titleEl = React.createElement(
    'button',
    {
      onClick: onExit,
      className: 'font-bold text-lg text-neutral-800 dark:text-stone-100 hover:text-[var(--element-color-raw)] transition-colors flex items-center gap-2',
      title: '返回本地视频',
    },
    '网络视频',
  );

  return React.createElement(OnlineSidebarShell, {
    icon: React.createElement(VideoIcon, { size: 20 }),
    title: titleEl,
    moduleId: 'video',
    onClose: onExit,
    onOpenModuleSettings,
    onOpenStats,
    statsActive,
    searchQuery: search,
    onSearchChange: setSearch,
    searchPlaceholder: '搜索平台…',
    children: React.createElement('div', { className: 'space-y-4' }, platformSection, tempSection, downloadSection),
  });
}

export default OnlineVideoSidebar;
