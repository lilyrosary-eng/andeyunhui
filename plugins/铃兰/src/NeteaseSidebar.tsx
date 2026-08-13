import React from "react";
import type { NeteasePlaylistItem } from './neteaseApi';
import type { TempPlaylist } from './NeteaseView';

export interface NeteaseTempItem {
  id: string;
  name: string;
  payload: TempPlaylist;
}

const { useState } = React;
const {
  ModuleSidebarShell,
  SecondaryNavShell,
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} = window.__HOST_UI__ || {};

function HeartIcon() {
  return React.createElement('svg', {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor', stroke: 'none',
  }, React.createElement('path', {
    d: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
  }));
}

function ListIcon() {
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

function Music2Icon() {
  return React.createElement('svg', {
    width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  }, [
    React.createElement('path', { key: '1', d: 'M9 18V5l12-2v13' }),
    React.createElement('circle', { key: '2', cx: '6', cy: '18', r: '3' }),
    React.createElement('circle', { key: '3', cx: '18', cy: '16', r: '3' }),
  ]);
}

export interface NeteaseSidebarProps {
  likedPlaylistId?: number | null;
  tempPlaylists: NeteaseTempItem[];
  userPlaylists: NeteasePlaylistItem[];
  activePlaylistId?: number | null;
  activeTempId?: string | null;
  onSelectLiked: () => void;
  onSelectTemp: (temp: NeteaseTempItem) => void;
  onSelectUserPlaylist: (playlist: NeteasePlaylistItem) => void;
  onCloseNetease: () => void;
  onOpenModuleSettings?: () => void;
  onOpenStats?: () => void;
  onSelectFolder?: () => void;
  searchQuery?: string;
  onSearchChange?: (value: string) => void;
}

export default function NeteaseSidebar({
  likedPlaylistId,
  tempPlaylists,
  userPlaylists,
  activePlaylistId,
  activeTempId,
  onSelectLiked,
  onSelectTemp,
  onSelectUserPlaylist,
  onCloseNetease,
  onOpenModuleSettings,
  onOpenStats,
  onSelectFolder,
  searchQuery,
  onSearchChange,
}: NeteaseSidebarProps) {
  const [tempExpanded, setTempExpanded] = useState(true);
  const [userExpanded, setUserExpanded] = useState(true);

  const renderLiked = () => {
    const isActive = activePlaylistId === likedPlaylistId && activeTempId == null;
    return React.createElement('button', {
      key: 'liked',
      onClick: onSelectLiked,
      className: `w-full text-left px-3 py-2 rounded-xl transition-colors text-sm flex items-center gap-2 ${
        isActive
          ? 'bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100'
          : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400'
      }`,
    }, [
      React.createElement('span', { key: 'icon', className: 'text-rose-500' }, React.createElement(HeartIcon)),
      React.createElement('span', { key: 'label', className: 'font-medium truncate' }, '我喜欢的音乐'),
    ]);
  };

  const renderTempSection = () => {
    if (tempPlaylists.length === 0) return null;
    return React.createElement('div', { key: 'temp', className: 'space-y-1' },
      React.createElement('button', {
        key: 'header',
        onClick: () => setTempExpanded(v => !v),
        className: 'w-full flex items-center justify-between px-1 py-1 text-xs text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-300 transition-colors',
      }, [
        React.createElement('span', { key: 't' }, '临时播放列表'),
        React.createElement('span', { key: 'c' }, tempExpanded ? '−' : '+'),
      ]),
      tempExpanded && tempPlaylists.map((temp, idx) => {
        const isActive = activeTempId === temp.id;
        return React.createElement('button', {
          key: temp.id,
          onClick: () => onSelectTemp(temp),
          className: `w-full text-left px-3 py-2 rounded-xl transition-colors text-sm flex items-center gap-2 ${
            isActive
              ? 'bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100'
              : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400'
          }`,
        }, [
          React.createElement('span', { key: 'icon' }, React.createElement(ListIcon)),
          React.createElement('span', { key: 'label', className: 'truncate' }, `临时${idx + 1}：${temp.name}`),
        ]);
      })
    );
  };

  const renderUserSection = () => {
    const hasItems = userPlaylists.length > 0;
    return React.createElement('div', { key: 'user', className: 'space-y-1' },
      React.createElement('button', {
        key: 'header',
        onClick: () => setUserExpanded(v => !v),
        className: 'w-full flex items-center justify-between px-1 py-1 text-xs text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-300 transition-colors',
      }, [
        React.createElement('span', { key: 't' }, '用户自己的收藏歌单'),
        React.createElement('span', { key: 'c' }, userExpanded ? '−' : '+'),
      ]),
      userExpanded && (
        hasItems
          ? userPlaylists.map(playlist => {
              const isActive = activePlaylistId === playlist.id && activeTempId == null;
              const item = React.createElement('button', {
                key: playlist.id,
                onClick: () => onSelectUserPlaylist(playlist),
                className: `w-full text-left px-3 py-2 rounded-xl transition-colors text-sm ${
                  isActive
                    ? 'bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100'
                    : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400'
                }`,
              }, React.createElement('div', { className: 'font-medium truncate' }, playlist.name));
              if (!ContextMenu || !ContextMenuTrigger || !ContextMenuContent || !ContextMenuItem) return item;
              return React.createElement(ContextMenu, { key: playlist.id },
                React.createElement(ContextMenuTrigger, { className: 'w-full' }, item),
                React.createElement(ContextMenuContent, null,
                  React.createElement(ContextMenuItem, { onClick: () => onSelectUserPlaylist(playlist) }, '播放')
                )
              );
            })
          : React.createElement('div', { key: 'empty', className: 'px-3 py-2 text-xs text-neutral-400 dark:text-stone-500' }, '暂无收藏歌单')
      )
    );
  };

  const titleEl = React.createElement('button', {
    onClick: onCloseNetease,
    className: 'font-bold text-lg text-neutral-800 dark:text-stone-100 hover:text-[var(--element-color-raw)] transition-colors flex items-center gap-2',
    title: '返回本地音乐',
  }, '铃兰');

  const statsButton = onOpenStats
    ? React.createElement('button', {
        key: 'open-stats',
        onClick: () => onOpenStats(),
        title: '统计',
        'aria-label': '统计',
        className: 'p-2 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-[var(--element-color-raw)] hover:bg-black/5 dark:hover:bg-white/5 transition-colors',
        children: '📊',
      })
    : null;

  const content = React.createElement('div', { className: 'space-y-4' },
    renderLiked(),
    renderTempSection(),
    renderUserSection()
  );

  if (!ModuleSidebarShell) {
    return React.createElement('div', { className: 'w-[260px] h-full flex-shrink-0 bg-white/60 dark:bg-stone-800/60 backdrop-blur-md border-r border-white/80 dark:border-stone-700/50 p-4 overflow-y-auto' },
      React.createElement('div', { className: 'flex items-center gap-2 mb-4 px-1' },
        React.createElement(Music2Icon),
        titleEl
      ),
      content
    );
  }

  return React.createElement(ModuleSidebarShell, {
    moduleId: 'music',
    icon: React.createElement(Music2Icon),
    title: titleEl,
    onOpenModuleSettings,
    footerExtra: statsButton,
    searchQuery,
    onSearchChange,
    searchPlaceholder: '搜索本地音乐',
    primaryAction: onSelectFolder ? { label: '添加文件夹', onClick: onSelectFolder } : undefined,
    children: SecondaryNavShell
      ? React.createElement(SecondaryNavShell, null, content)
      : React.createElement('div', { className: 'flex-1 overflow-y-auto pr-1 space-y-3' }, content),
  });
}
