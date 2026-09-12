/// <reference path="../../global.d.ts" />
// 视频模块 · 网络视频侧栏（平台列表 + 返回本地）
import React from 'react';
import { VIDEO_PLATFORMS } from './videoPlatforms';
import { CloudIcon, CloseIcon } from './onlineIcons';

const { useState } = React;

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

export function OnlineVideoSidebar({ activeId, onSelect, onExit }: Props) {
  const [hovered, setHovered] = useState<string | null>(null);
  return React.createElement('div', { className: 'w-64 h-full flex-shrink-0 flex flex-col bg-white/60 dark:bg-stone-800/60 backdrop-blur-md border-r border-white/80 dark:border-stone-700/50' },
    // 头部
    React.createElement('div', { className: 'flex items-center gap-2 px-4 py-3 border-b border-neutral-200/60 dark:border-stone-700/50' },
      React.createElement(CloudIcon, { size: 18, className: 'text-neutral-700 dark:text-stone-200' }),
      React.createElement('span', { className: 'text-sm font-semibold text-neutral-800 dark:text-stone-100 flex-1' }, '网络视频'),
      React.createElement('button', {
        onClick: onExit,
        className: 'btn-press p-1.5 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200 transition-colors',
        title: '返回本地视频',
      }, React.createElement(CloseIcon, { size: 16 })),
    ),
    // 平台列表
    React.createElement('div', { className: 'flex-1 overflow-y-auto p-3 space-y-1' },
      VIDEO_PLATFORMS.map((p) => {
        const isActive = activeId === p.id;
        const isHover = hovered === p.id;
        return React.createElement('button', {
          key: p.id,
          onClick: () => onSelect(p.id),
          onMouseEnter: () => setHovered(p.id),
          onMouseLeave: () => setHovered(null),
          className: `w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
            isActive
              ? 'bg-black/5 dark:bg-white/10'
              : isHover ? 'bg-black/[0.03] dark:bg-white/5' : ''
          }`,
        },
          React.createElement('div', {
            className: 'flex h-9 w-9 items-center justify-center rounded-lg shrink-0 text-white text-xs font-bold',
            style: { background: p.accent },
          }, p.name.slice(0, 1)),
          React.createElement('div', { className: 'flex-1 min-w-0' },
            React.createElement('div', { className: 'flex items-center gap-1.5' },
              React.createElement('span', { className: 'text-sm font-medium text-neutral-800 dark:text-stone-100 truncate' }, p.name),
              React.createElement('span', {
                className: 'text-[10px] px-1 rounded',
                style: { color: p.accent, background: `${p.accent}1a` },
              }, modeLabel[p.mode] ?? p.mode),
            ),
            React.createElement('p', { className: 'text-xs text-neutral-400 dark:text-stone-500 truncate' }, p.desc),
          ),
        );
      }),
    ),
    // 底部
    React.createElement('div', { className: 'p-3 border-t border-neutral-200/60 dark:border-stone-700/50' },
      React.createElement('button', {
        onClick: onExit,
        className: 'w-full btn-press px-3 py-2 rounded-lg text-sm text-neutral-500 dark:text-stone-400 hover:bg-neutral-100 dark:hover:bg-stone-700/60 transition-colors',
      }, '← 返回本地视频'),
    ),
  );
}

export default OnlineVideoSidebar;
