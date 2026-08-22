import React from 'react';
import { toTempPlaylistItem } from './OnlineSidebarShell';
import OnlineMusicSidebar, { type SidebarUserPlaylist } from './_shared/OnlineMusicSidebar';
import type { QishuiPlaylistCard } from './qishuiApi';
import type { OnlineTempItem } from './useOnlineSource';

function toUserPlaylist(p: QishuiPlaylistCard): SidebarUserPlaylist {
  return { id: p.id, name: p.name, trackCount: p.trackCount ?? 0 };
}

export interface QishuiSidebarProps {
  tempPlaylists: OnlineTempItem[];
  activeTempId?: string | null;
  onSelectTemp: (temp: OnlineTempItem) => void;
  recommend: QishuiPlaylistCard[];
  activePlaylistId?: string | null;
  onSelectPlaylist: (id: string, name: string) => void;
  onClose: () => void;
  onOpenModuleSettings?: () => void;
  onOpenStats?: () => void;
  statsActive?: boolean;
  searchQuery?: string;
  onSearchChange?: (value: string) => void;
}

export default function QishuiSidebar({
  tempPlaylists,
  activeTempId,
  onSelectTemp,
  recommend,
  activePlaylistId,
  onSelectPlaylist,
  onClose,
  onOpenModuleSettings,
  onOpenStats,
  statsActive,
  searchQuery,
  onSearchChange,
}: QishuiSidebarProps) {
  return React.createElement(OnlineMusicSidebar, {
    brandLabel: '铃兰',
    temps: tempPlaylists.map(toTempPlaylistItem),
    activeTempId,
    onSelectTemp: (item) => {
      const src = tempPlaylists.find(t => t.id === item.id);
      if (src) onSelectTemp(src);
    },
    // 游客态无登录，推荐歌单作为「榜单 / 推荐」块展示（对齐网易云三块结构，用户块为空）
    ranks: recommend.map(toUserPlaylist),
    activeRankId: activePlaylistId,
    onSelectRank: (pl) => onSelectPlaylist(String(pl.id), pl.name),
    ranksTitle: '推荐歌单',
    onClose: onClose,
    onOpenModuleSettings,
    onOpenStats,
    statsActive,
    searchQuery,
    onSearchChange,
    searchPlaceholder: '搜索汽水音乐',
  });
}
