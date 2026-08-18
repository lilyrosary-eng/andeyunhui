import React from "react";
const { useState, useEffect } = React;
import { OnlineSidebarShell, SidebarTempSection, type TempPlaylistItem } from './OnlineSidebarShell';
import type { KugouPlaylistCard, KugouAuth } from './kugouApi';
import { getKugouAuth } from './kugouApi';
import type { OnlineTempItem } from './useOnlineSource';

function toTempItem(temp: OnlineTempItem): TempPlaylistItem {
  return {
    id: temp.id,
    name: temp.name,
    count: temp.payload.tracks?.length ?? 0,
  };
}

export interface KugouSidebarProps {
  ranks: KugouPlaylistCard[];
  activeRankId?: number | null;
  onSelectRank: (id: number) => void;
  tempPlaylists: OnlineTempItem[];
  activeTempId?: string | null;
  onSelectTemp: (temp: OnlineTempItem) => void;
  onCloseKugou: () => void;
  onOpenModuleSettings?: () => void;
  onOpenStats?: () => void;
  statsActive?: boolean;
  searchQuery?: string;
  onSearchChange?: (value: string) => void;
  onOpenMine?: () => void;
}

function HeartIcon() {
  return React.createElement('svg', {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  }, [
    React.createElement('path', { key: '1', d: 'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z' }),
  ]);
}

function ListIcon() {
  return React.createElement('svg', {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  }, [
    React.createElement('line', { key: '1', x1: 8, y1: 6, x2: 21, y2: 6 }),
    React.createElement('line', { key: '2', x1: 8, y1: 12, x2: 21, y2: 12 }),
    React.createElement('line', { key: '3', x1: 8, y1: 18, x2: 21, y2: 18 }),
    React.createElement('line', { key: '4', x1: 3, y1: 6, x2: 3.01, y2: 6 }),
    React.createElement('line', { key: '5', x1: 3, y1: 12, x2: 3.01, y2: 12 }),
    React.createElement('line', { key: '6', x1: 3, y1: 18, x2: 3.01, y2: 18 }),
  ]);
}

export default function KugouSidebar({
  ranks,
  activeRankId,
  onSelectRank,
  tempPlaylists,
  activeTempId,
  onSelectTemp,
  onCloseKugou,
  onOpenModuleSettings,
  onOpenStats,
  statsActive,
  searchQuery,
  onSearchChange,
  onOpenMine,
}: KugouSidebarProps) {
  const [auth, setAuth] = useState<KugouAuth | null>(getKugouAuth);

  useEffect(() => {
    const handler = () => setAuth(getKugouAuth());
    window.addEventListener('kugou-auth-changed', handler);
    return () => window.removeEventListener('kugou-auth-changed', handler);
  }, []);

  const renderMineSection = () => {
    if (!auth) return null;
    return React.createElement('div', { key: 'mine', className: 'space-y-1' },
      React.createElement('div', {
        className: 'px-1 py-1 text-xs text-neutral-400 dark:text-stone-500',
      }, '我的'),
      React.createElement('button', {
        onClick: onOpenMine,
        className: 'w-full text-left px-3 py-2 rounded-xl transition-colors text-sm hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400',
      }, React.createElement('div', { className: 'font-medium truncate flex items-center gap-2' },
        React.createElement(HeartIcon, { key: 'icon' }),
        '我喜欢的音乐'
      )),
      React.createElement('button', {
        onClick: onOpenMine,
        className: 'w-full text-left px-3 py-2 rounded-xl transition-colors text-sm hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400',
      }, React.createElement('div', { className: 'font-medium truncate flex items-center gap-2' },
        React.createElement(ListIcon, { key: 'icon' }),
        '我的歌单'
      ))
    );
  };

  const titleEl = React.createElement('button', {
    onClick: onCloseKugou,
    className: 'font-bold text-lg text-neutral-800 dark:text-stone-100 hover:text-[var(--element-color-raw)] transition-colors flex items-center gap-2',
    title: '返回本地音乐',
  }, '铃兰');

  return React.createElement(OnlineSidebarShell, {
    title: titleEl,
    onClose: onCloseKugou,
    onOpenModuleSettings,
    onOpenStats,
    statsActive,
    searchQuery,
    onSearchChange,
    searchPlaceholder: '搜索酷狗音乐',
    children: React.createElement('div', { className: 'space-y-4' },
      renderMineSection(),
      React.createElement(SidebarTempSection, {
        items: tempPlaylists.map(toTempItem),
        activeId: activeTempId,
        onSelect: onSelectTemp,
      })
    ),
  });
}
