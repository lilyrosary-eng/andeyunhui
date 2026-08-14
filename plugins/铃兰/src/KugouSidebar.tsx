import React from "react";
const { useState } = React;
import { OnlineSidebarShell, SidebarTempSection, type TempPlaylistItem } from './OnlineSidebarShell';
import type { KugouPlaylistCard } from './kugouApi';
import type { OnlineTempItem } from './useOnlineSource';

function toTempItem(temp: OnlineTempItem): TempPlaylistItem {
  return {
    id: temp.id,
    name: temp.name,
    count: temp.payload.tracks?.length ?? 0,
  };
}

function TrophyIcon() {
  return React.createElement('svg', {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  }, [
    React.createElement('path', { key: '1', d: 'M6 9H4.5a2.5 2.5 0 0 1 0-5H6' }),
    React.createElement('path', { key: '2', d: 'M18 9h1.5a2.5 2.5 0 0 0 0-5H18' }),
    React.createElement('path', { key: '3', d: 'M4 22h16' }),
    React.createElement('path', { key: '4', d: 'M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22' }),
    React.createElement('path', { key: '5', d: 'M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22' }),
    React.createElement('path', { key: '6', d: 'M18 2H6v7a6 6 0 0 0 12 0V2z' }),
  ]);
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
}: KugouSidebarProps) {
  const [rankExpanded, setRankExpanded] = useState(true);

  const renderRankSection = () => {
    if (ranks.length === 0) return null;
    return React.createElement('div', { key: 'ranks', className: 'space-y-1' },
      React.createElement('button', {
        key: 'header',
        onClick: () => setRankExpanded(v => !v),
        className: 'w-full flex items-center justify-between px-1 py-1 text-xs text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-300 transition-colors',
      }, [
        React.createElement('span', { key: 't' }, '酷狗榜单'),
        React.createElement('span', { key: 'c' }, rankExpanded ? '−' : '+'),
      ]),
      rankExpanded && ranks.map(rank => {
        const isActive = activeRankId === rank.id;
        return React.createElement('button', {
          key: rank.id,
          onClick: () => onSelectRank(rank.id),
          className: `w-full text-left px-3 py-2 rounded-xl transition-colors text-sm ${
            isActive
              ? 'bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100'
              : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400'
          }`,
        }, [
          React.createElement('div', { key: 'name', className: 'font-medium truncate flex items-center gap-2' },
            React.createElement(TrophyIcon, { key: 'icon' }),
            rank.name
          ),
          rank.playCount != null
            ? React.createElement('div', { key: 'count', className: 'text-xs text-neutral-400 dark:text-stone-500 truncate mt-0.5' }, `${rank.playCount} 播放`)
            : null,
        ]);
      })
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
      renderRankSection(),
      React.createElement(SidebarTempSection, {
        items: tempPlaylists.map(toTempItem),
        activeId: activeTempId,
        onSelect: onSelectTemp,
      })
    ),
  });
}
