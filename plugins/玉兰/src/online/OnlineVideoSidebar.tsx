/// <reference path="../../global.d.ts" />
// 视频模块 · 网络视频侧栏（对齐音乐 OnlineSidebarShell：标题 / 统计 / 搜索 / 平台列表 / 下载队列段）
import React from 'react';
import { VIDEO_PLATFORMS } from './videoPlatforms';
import { CloudIcon, CloseIcon, SearchIcon } from './onlineIcons';
import { videoDownloadManager, type VideoDownloadTask } from './OnlineVideoDownloadManager';

const { useState, useEffect } = React;

interface Props {
  activeId: string | null;
  onSelect: (id: string) => void;
  onExit: () => void;
}

const modeLabel: Record<string, string> = {
  native: '原生',
  webview: '网页',
  special: '特殊',
};

function readNative(id: string, def?: boolean): boolean {
  const v = localStorage.getItem(`video_native_engine_${id}`);
  return v === null ? !!def : v === '1';
}

export function OnlineVideoSidebar({ activeId, onSelect, onExit }: Props) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [dl, setDl] = useState<VideoDownloadTask[]>([]);
  useEffect(() => videoDownloadManager.subscribe(setDl), []);

  const enabledCount = VIDEO_PLATFORMS.filter((p) => readNative(p.id, p.nativeEngineDefault)).length;
  const list = VIDEO_PLATFORMS.filter((p) => p.name.includes(search.trim()));
  const activeDl = dl.filter((t) => t.status === 'downloading' || t.status === 'queued').length;

  return React.createElement(
    'div',
    { className: 'w-64 h-full flex-shrink-0 flex flex-col bg-white/60 dark:bg-stone-800/60 backdrop-blur-md border-r border-white/80 dark:border-stone-700/50' },
    React.createElement(
      'div',
      { className: 'flex items-center gap-2 px-4 py-3 border-b border-neutral-200/60 dark:border-stone-700/50' },
      React.createElement(CloudIcon, { size: 18, className: 'text-neutral-700 dark:text-stone-200' }),
      React.createElement('span', { className: 'text-sm font-semibold text-neutral-800 dark:text-stone-100 flex-1' }, '网络视频'),
      React.createElement(
        'button',
        { onClick: onExit, className: 'btn-press p-1.5 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200 transition-colors', title: '返回本地视频' },
        React.createElement(CloseIcon, { size: 16 }),
      ),
    ),
    React.createElement(
      'div',
      { className: 'px-3 pt-2 pb-1' },
      React.createElement(
        'div',
        { className: 'flex items-center gap-1.5 text-[11px] text-neutral-400 dark:text-stone-500' },
        React.createElement('span', null, `共 ${VIDEO_PLATFORMS.length} 个平台`),
        React.createElement('span', { className: 'opacity-40' }, '·'),
        React.createElement('span', null, `${enabledCount} 个已启用原生引擎`),
      ),
      React.createElement(
        'div',
        { className: 'mt-2 flex items-center gap-2 bg-neutral-100 dark:bg-stone-700 rounded-lg px-2 py-1.5' },
        React.createElement(SearchIcon, { size: 14, className: 'text-neutral-400' }),
        React.createElement('input', {
          value: search,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value),
          placeholder: '搜索平台…',
          className: 'flex-1 bg-transparent text-xs text-neutral-700 dark:text-stone-200 outline-none',
        }),
      ),
    ),
    React.createElement(
      'div',
      { className: 'flex-1 overflow-y-auto p-3 space-y-1' },
      list.map((p) => {
        const isActive = activeId === p.id;
        const isHover = hovered === p.id;
        const nativeOn = readNative(p.id, p.nativeEngineDefault);
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
          React.createElement('div', { className: 'flex h-9 w-9 items-center justify-center rounded-lg shrink-0 text-white text-xs font-bold', style: { background: p.accent } }, p.name.slice(0, 1)),
          React.createElement(
            'div',
            { className: 'flex-1 min-w-0' },
            React.createElement(
              'div',
              { className: 'flex items-center gap-1.5' },
              React.createElement('span', { className: 'text-sm font-medium text-neutral-800 dark:text-stone-100 truncate' }, p.name),
              React.createElement('span', { className: 'text-[10px] px-1 rounded', style: { color: p.accent, background: `${p.accent}1a` } }, modeLabel[p.mode] ?? p.mode),
              React.createElement('span', {
                className: `w-1.5 h-1.5 rounded-full ${nativeOn ? 'bg-emerald-500' : 'bg-neutral-300 dark:bg-stone-600'}`,
                title: nativeOn ? '原生引擎已启用' : '原生引擎未启用',
              }),
            ),
            React.createElement('p', { className: 'text-xs text-neutral-400 dark:text-stone-500 truncate' }, p.desc),
          ),
        );
      }),
      list.length === 0 && React.createElement('p', { className: 'text-center text-xs text-neutral-400 dark:text-stone-500 py-6' }, '无匹配平台'),
    ),
    React.createElement(
      'div',
      { className: 'p-3 border-t border-neutral-200/60 dark:border-stone-700/50 space-y-2' },
      React.createElement(
        'div',
        { className: 'flex items-center gap-2 text-xs text-neutral-500 dark:text-stone-400' },
        React.createElement('span', { className: 'flex-1' }, '下载队列'),
        React.createElement('span', { className: activeDl > 0 ? 'text-emerald-500' : 'text-neutral-400' }, `${activeDl} 进行中 / ${dl.length} 总`),
      ),
      React.createElement(
        'button',
        { onClick: onExit, className: 'w-full btn-press px-3 py-2 rounded-lg text-sm text-neutral-500 dark:text-stone-400 hover:bg-neutral-100 dark:hover:bg-stone-700/60 transition-colors' },
        '← 返回本地视频',
      ),
    ),
  );
}

export default OnlineVideoSidebar;
