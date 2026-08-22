// 在线音乐模块通用侧栏模板（酷狗 / 汽水 / 网易云共享「三块」结构）
//
// 母本：NeteaseSidebar.tsx
//   - 块1「我喜欢的音乐」(likedPlaylist)
//   - 块2「临时播放列表」(SidebarTempSection，来自 OnlineSidebarShell)
//   - 块3「用户自己的收藏歌单」(userPlaylists) + 右键「播放」菜单
// 抽离后酷狗/汽水传入各自数据源，布局 100% 对齐网易云。
//
// 差异点保留为可选 props：
//   - ranks：酷狗有榜单块，网易云/汽水无（汽水游客态无用户歌单时也空）。
//   - 逻辑（拉取用户歌单、收藏）各自在调用方实现，模板只负责渲染与右键壳。

import React from 'react';
import { OnlineSidebarShell, SidebarTempSection, type TempPlaylistItem } from '../OnlineSidebarShell';

const { useState } = React;
const {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  BarChart3,
  ModuleSidebarShell,
  SecondaryNavShell,
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

// ============ 通用数据类型 ============
export interface SidebarLikedPlaylist {
  // id 允许 null：网易云「我喜欢的音乐」始终渲染，歌单 id 尚未就绪时仍占位，
  // 点击交给 onSelectLiked 内部兜底（此时 active 判定与母本一致：null===null 视为激活）。
  id: string | number | null;
  count?: number | null;
}
export interface SidebarUserPlaylist {
  id: string | number;
  name: string;
  trackCount?: number | null;
  cover?: string | null;
}

// ============ 块1：我喜欢的音乐 ============
function SidebarLikedSection({
  liked, active, onSelect,
}: {
  liked?: SidebarLikedPlaylist;
  active: boolean;
  onSelect: () => void;
}) {
  if (!liked) return null;
  return React.createElement('button', {
    key: 'liked',
    onClick: onSelect,
    className: `w-full text-left px-3 py-2 rounded-xl transition-colors text-sm ${
      active
        ? 'bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100'
        : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400'
    }`,
  }, [
    React.createElement('div', { key: 'name', className: 'font-medium truncate flex items-center gap-2' },
      React.createElement(HeartIcon, { key: 'ico' }),
      '我喜欢的音乐'
    ),
    liked.count != null ? React.createElement('div', { key: 'count', className: 'text-xs text-neutral-400 dark:text-stone-500 truncate mt-0.5' }, `${liked.count} 首`) : null,
  ]);
}

// ============ 块3：用户收藏歌单（含右键播放） ============
// showCover=false 时隐藏封面/占位图标（网易云用户歌单用纯文字行，对齐母本布局）。
// tempActive 指当前激活的是临时播放列表：此时用户歌单不应高亮（与 liked 判定一致）。
function SidebarUserSection({
  playlists, activeId, onSelect, emptyText = '暂无收藏歌单', showCover = true, tempActive = false,
}: {
  playlists: SidebarUserPlaylist[];
  activeId?: string | number | null;
  onSelect?: (pl: SidebarUserPlaylist) => void;
  emptyText?: string;
  showCover?: boolean;
  tempActive?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  return React.createElement('div', { key: 'user', className: 'space-y-1' },
    React.createElement('button', {
      key: 'header',
      onClick: () => setExpanded(v => !v),
      className: 'w-full flex items-center justify-between px-1 py-1 text-xs text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-300 transition-colors',
    }, [
      React.createElement('span', { key: 't' }, '用户自己的收藏歌单'),
      React.createElement('span', { key: 'c' }, expanded ? '−' : '+'),
    ]),
    expanded && (
      playlists.length > 0
        ? playlists.map(pl => {
            const isActive = !tempActive && activeId === pl.id;
            const coverNode = showCover
              ? (pl.cover
                  ? React.createElement('img', {
                      key: `cv-${pl.id}`,
                      src: pl.cover,
                      alt: '',
                      className: 'w-9 h-9 rounded-lg object-cover flex-shrink-0',
                      loading: 'lazy',
                    })
                  : React.createElement(Music2Icon, { key: `cv-${pl.id}` }))
              : null;
            const item = React.createElement('button', {
              key: pl.id,
              onClick: () => onSelect?.(pl),
              className: `w-full flex items-center gap-2.5 px-3 py-2 rounded-xl transition-colors text-sm ${
                isActive
                  ? 'bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100'
                  : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400'
              }`,
            }, [
              coverNode,
              React.createElement('div', { key: `meta-${pl.id}`, className: 'min-w-0 flex-1' }, [
                React.createElement('div', { key: `name-${pl.id}`, className: 'font-medium truncate' }, pl.name),
                React.createElement('div', { key: `count-${pl.id}`, className: 'text-xs text-neutral-400 dark:text-stone-500 truncate mt-0.5' }, `${pl.trackCount ?? 0} 首`),
              ]),
            ]);
            if (!ContextMenu || !ContextMenuTrigger || !ContextMenuContent || !ContextMenuItem) return item;
            return React.createElement(ContextMenu, { key: pl.id },
              React.createElement(ContextMenuTrigger, { className: 'w-full' }, item),
              React.createElement(ContextMenuContent, null,
                React.createElement(ContextMenuItem, { onClick: () => onSelect?.(pl) }, '播放')
              )
            );
          })
        : React.createElement('div', { key: 'empty', className: 'px-3 py-2 text-xs text-neutral-400 dark:text-stone-500' }, emptyText)
    )
  );
}

// ============ 可选块：榜单（酷狗有，网易云/汽水无） ============
function SidebarRanksSection({
  ranks, activeId, onSelect, title = '榜单',
}: {
  ranks: SidebarUserPlaylist[];
  activeId?: string | number | null;
  onSelect: (pl: SidebarUserPlaylist) => void;
  title?: string;
}) {
  if (ranks.length === 0) return null;
  const [expanded, setExpanded] = useState(true);
  return React.createElement('div', { key: 'ranks', className: 'space-y-1' },
    React.createElement('button', {
      key: 'header',
      onClick: () => setExpanded(v => !v),
      className: 'w-full flex items-center justify-between px-1 py-1 text-xs text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-300 transition-colors',
    }, [
      React.createElement('span', { key: 't' }, title),
      React.createElement('span', { key: 'c' }, expanded ? '−' : '+'),
    ]),
    expanded && ranks.map(r => {
      const isActive = activeId === r.id;
      return React.createElement('button', {
        key: r.id,
        onClick: () => onSelect(r),
        className: `w-full text-left px-3 py-2 rounded-xl transition-colors text-sm ${
          isActive
            ? 'bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100'
            : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400'
        }`,
      }, [
        React.createElement('div', { key: `name-${r.id}`, className: 'font-medium truncate' }, r.name),
        React.createElement('div', { key: `count-${r.id}`, className: 'text-xs text-neutral-400 dark:text-stone-500 truncate mt-0.5' }, `${r.trackCount ?? 0} 首`),
      ]);
    })
  );
}

// ============ 主模板 ============
export interface OnlineMusicSidebarProps {
  brandLabel: string; // 标题栏文字，如 "铃兰"（保留原样）
  likedPlaylist?: SidebarLikedPlaylist;
  temps: TempPlaylistItem[]; // 已转成 TempPlaylistItem 的临时列表
  activeTempId?: string | null;
  onSelectTemp: (item: TempPlaylistItem) => void;
  userPlaylists?: SidebarUserPlaylist[];
  activePlaylistId?: string | number | null;
  onSelectUserPlaylist?: (pl: SidebarUserPlaylist) => void;
  /** 独立处理「我喜欢的音乐」点击；缺省时回落 to onSelectUserPlaylist(合成 liked) */
  onSelectLiked?: () => void;
  /** 用户歌单行是否显示封面/占位图（网易云传 false 用纯文字行） */
  showUserCover?: boolean;
  userEmptyText?: string;
  ranks?: SidebarUserPlaylist[];
  activeRankId?: string | number | null;
  onSelectRank?: (pl: SidebarUserPlaylist) => void;
  ranksTitle?: string;
  onClose: () => void;
  onOpenModuleSettings?: () => void;
  onOpenStats?: () => void;
  statsActive?: boolean;
  onSelectFolder?: () => void;
  searchQuery?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
}

export default function OnlineMusicSidebar(props: OnlineMusicSidebarProps) {
  const {
    brandLabel,
    likedPlaylist,
    temps,
    activeTempId,
    onSelectTemp,
    userPlaylists = [],
    activePlaylistId,
    onSelectUserPlaylist,
    onSelectLiked,
    showUserCover = true,
    userEmptyText,
    ranks = [],
    activeRankId,
    onSelectRank,
    ranksTitle,
    onClose,
    onOpenModuleSettings,
    onOpenStats,
    statsActive,
    onSelectFolder,
    searchQuery,
    onSearchChange,
    searchPlaceholder,
  } = props;

  const likedActive = !!likedPlaylist && activePlaylistId === likedPlaylist.id && activeTempId == null;
  const titleEl = React.createElement('button', {
    onClick: onClose,
    className: 'font-bold text-lg text-neutral-800 dark:text-stone-100 hover:text-[var(--element-color-raw)] transition-colors flex items-center gap-2',
    title: '返回本地音乐',
  }, brandLabel);

  const content = React.createElement('div', { className: 'space-y-4' },
    React.createElement(SidebarLikedSection, {
      key: 'liked-sec',
      liked: likedPlaylist,
      active: likedActive,
      onSelect: () => {
        if (onSelectLiked) { onSelectLiked(); return; }
        // 无独立 onSelectLiked 时合成 liked 回落：id 为 null 时无可合成歌单，忽略
        if (likedPlaylist && likedPlaylist.id != null && onSelectUserPlaylist) onSelectUserPlaylist({ id: likedPlaylist.id, name: '我喜欢的音乐', trackCount: likedPlaylist.count });
      },
    }),
    React.createElement(SidebarTempSection, {
      key: 'temp-sec',
      items: temps,
      activeId: activeTempId,
      onSelect: onSelectTemp,
    }),
    React.createElement(SidebarUserSection, {
      key: 'user-sec',
      playlists: userPlaylists,
      activeId: activePlaylistId,
      onSelect: onSelectUserPlaylist,
      emptyText: userEmptyText,
      showCover: showUserCover,
      tempActive: activeTempId != null,
    }),
    ranks.length > 0 && onSelectRank
      ? React.createElement(SidebarRanksSection, {
          key: 'ranks-sec',
          ranks,
          activeId: activeRankId,
          onSelect: onSelectRank,
          title: ranksTitle,
        })
      : null
  );

  return React.createElement(OnlineSidebarShell, {
    icon: React.createElement(Music2Icon),
    title: titleEl,
    onClose,
    onOpenModuleSettings,
    onOpenStats,
    statsActive,
    searchQuery,
    onSearchChange,
    searchPlaceholder,
    primaryAction: onSelectFolder ? { label: '添加文件夹', onClick: onSelectFolder } : undefined,
    children: content,
  });
}
