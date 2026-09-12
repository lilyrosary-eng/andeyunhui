/// <reference path="../../global.d.ts" />
// 视频模块 · 网络视频侧栏（复用 @shared/OnlineSidebarShell 壳，对齐音乐在线侧栏：标题/返回/搜索/平台列表/下载队列段）
import React from 'react';
import { VIDEO_PLATFORMS } from './videoPlatforms';
import { OnlineSidebarShell } from '@shared/OnlineSidebarShell';
import { VideoIcon } from '@shared/icons';
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

function statusText(t: VideoDownloadTask): string {
  if (t.status === 'downloading') return '下载中';
  if (t.status === 'queued') return '排队中';
  if (t.status === 'done') return '完成';
  if (t.status === 'error') return '失败';
  return t.status;
}

export function OnlineVideoSidebar({ activeId, onSelect, onExit }: Props) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [dl, setDl] = useState<VideoDownloadTask[]>([]);
  useEffect(() => videoDownloadManager.subscribe(setDl), []);

  const enabledCount = VIDEO_PLATFORMS.filter((p) => readNative(p.id, p.nativeEngineDefault)).length;
  const list = VIDEO_PLATFORMS.filter((p) => p.name.includes(search.trim()));
  const activeDl = dl.filter((t) => t.status === 'downloading' || t.status === 'queued').length;

  const platformSection = React.createElement('div', { className: 'space-y-1' },
    React.createElement('div', { className: 'flex items-center gap-1.5 px-1 text-[11px] text-neutral-400 dark:text-stone-500' },
      React.createElement('span', null, `共 ${VIDEO_PLATFORMS.length} 个平台`),
      React.createElement('span', { className: 'opacity-40' }, '·'),
      React.createElement('span', null, `${enabledCount} 个已启用原生引擎`),
    ),
    list.map((p) => {
      const isActive = activeId === p.id;
      const isHover = hovered === p.id;
      const nativeOn = readNative(p.id, p.nativeEngineDefault);
      return React.createElement('button', {
        key: p.id,
        onClick: () => onSelect(p.id),
        onMouseEnter: () => setHovered(p.id),
        onMouseLeave: () => setHovered(null),
        className: `w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
          isActive ? 'bg-black/5 dark:bg-white/10' : isHover ? 'bg-black/[0.03] dark:bg-white/5' : ''
        }`,
      },
        React.createElement('div', { className: 'flex h-9 w-9 items-center justify-center rounded-lg shrink-0 text-white text-xs font-bold', style: { background: p.accent } }, p.name.slice(0, 1)),
        React.createElement('div', { className: 'flex-1 min-w-0' },
          React.createElement('div', { className: 'flex items-center gap-1.5' },
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
  );

  const downloadSection = React.createElement('div', { className: 'space-y-1 pt-3 border-t border-neutral-200/60 dark:border-stone-700/50' },
    React.createElement('div', { className: 'flex items-center gap-2 px-1 py-1 text-xs text-neutral-400 dark:text-stone-500' },
      React.createElement('span', null, '下载队列'),
      React.createElement('span', { className: 'flex-1' }),
      React.createElement('span', { className: activeDl > 0 ? 'text-emerald-500' : 'text-neutral-400' }, `${activeDl} 进行中 / ${dl.length} 总`),
    ),
    dl.length === 0
      ? React.createElement('div', { className: 'px-3 py-2 text-xs text-neutral-400 dark:text-stone-500' }, '暂无下载任务')
      : dl.map((t) => React.createElement('div', { key: t.id, className: 'px-3 py-1.5 text-xs text-neutral-600 dark:text-stone-400 truncate' },
          `${t.name} · ${statusText(t)}${t.progress != null ? ` ${Math.round(t.progress * 100)}%` : ''}`
        )),
  );

  return React.createElement(OnlineSidebarShell, {
    icon: React.createElement(VideoIcon, { size: 20 }),
    title: '网络视频',
    moduleId: 'video',
    onClose: onExit,
    searchQuery: search,
    onSearchChange: setSearch,
    searchPlaceholder: '搜索平台…',
    children: React.createElement('div', { className: 'space-y-4' }, platformSection, downloadSection),
  });
}

export default OnlineVideoSidebar;
