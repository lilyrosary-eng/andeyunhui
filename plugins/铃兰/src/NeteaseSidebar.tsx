import React from "react";
import type { NeteasePlaylistItem } from './neteaseApi';
import type { TempPlaylist } from './NeteaseView';
import { toTempPlaylistItem } from './OnlineSidebarShell';
import OnlineMusicSidebar, { type SidebarLikedPlaylist, type SidebarUserPlaylist } from './_shared/OnlineMusicSidebar';

export interface NeteaseTempItem {
  id: string;
  name: string;
  payload: TempPlaylist;
}

function toUserPlaylist(p: NeteasePlaylistItem): SidebarUserPlaylist {
  return { id: p.id, name: p.name, trackCount: p.trackCount ?? 0, cover: p.coverImgUrl || null };
}

export interface NeteaseSidebarProps {
  likedPlaylistId?: number | null;
  likedPlaylistCount?: number | null;
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
  statsActive?: boolean;
  onSelectFolder?: () => void;
  searchQuery?: string;
  onSearchChange?: (value: string) => void;
}

export default function NeteaseSidebar({
  likedPlaylistId,
  likedPlaylistCount,
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
  statsActive,
  onSelectFolder,
  searchQuery,
  onSearchChange,
}: NeteaseSidebarProps) {
  // 「我喜欢的音乐」在网易云侧栏始终展示（即使歌单 id 尚未就绪/为 null，点击仍触发
  // onSelectLiked 由其内部兜底）。id 为 null 时 count 用 0，active 判定与母本一致
  // （activePlaylistId === id && 非临时态），故 favorite 块不因 id 缺失而消失。
  const likedPlaylist: SidebarLikedPlaylist = { id: likedPlaylistId ?? null, count: likedPlaylistCount ?? 0 };

  return React.createElement(OnlineMusicSidebar, {
    brandLabel: '铃兰',
    likedPlaylist,
    temps: tempPlaylists.map(toTempPlaylistItem),
    activeTempId,
    onSelectTemp: (item) => {
      const src = tempPlaylists.find(t => t.id === item.id);
      if (src) onSelectTemp(src);
    },
    userPlaylists: userPlaylists.map(toUserPlaylist),
    activePlaylistId,
    onSelectUserPlaylist: (pl) => {
      const src = userPlaylists.find(p => p.id === pl.id);
      if (src) onSelectUserPlaylist(src);
    },
    onSelectLiked,
    showUserCover: false, // 网易云用户歌单为纯文字行，不显示封面/占位图（对齐母本布局）
    onClose: onCloseNetease,
    onOpenModuleSettings,
    onOpenStats,
    statsActive,
    onSelectFolder,
    searchQuery,
    onSearchChange,
    searchPlaceholder: '搜索本地音乐',
  });
}