import React from "react";
const { useState, useEffect } = React;
import { SidebarTempSection, type TempPlaylistItem } from './OnlineSidebarShell';
import OnlineMusicSidebar, { type SidebarUserPlaylist } from './_shared/OnlineMusicSidebar';
import { getKugouAuth, getUserPlaylists, type KugouAuth, type KugouPlaylistCard } from './kugouApi';
import type { OnlineTempItem } from './useOnlineSource';

function toTempItem(temp: OnlineTempItem): TempPlaylistItem {
  return {
    id: temp.id,
    name: temp.name,
    count: temp.payload.tracks?.length ?? 0,
  };
}

function toUserPlaylist(pl: KugouPlaylistCard): SidebarUserPlaylist {
  return { id: pl.gid ?? String(pl.id), name: pl.name, trackCount: pl.trackCount ?? 0, cover: pl.cover || null };
}

export interface KugouSidebarProps {
  ranks?: KugouPlaylistCard[];
  activeRankId?: number | null;
  onSelectRank?: (id: number) => void;
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
  onSelectUserPlaylist: (playlist: KugouPlaylistCard) => void;
}

export default function KugouSidebar({
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
  onSelectUserPlaylist,
}: KugouSidebarProps) {
  const [auth, setAuth] = useState<KugouAuth | null>(() => getKugouAuth());
  const [playlists, setPlaylists] = useState<KugouPlaylistCard[]>([]);

  useEffect(() => {
    const handler = () => setAuth(getKugouAuth());
    window.addEventListener('kugou-auth-changed', handler);
    return () => window.removeEventListener('kugou-auth-changed', handler);
  }, []);

  useEffect(() => {
    if (auth?.userid == null) {
      setPlaylists([]);
      return;
    }
    let cancelled = false;
    getUserPlaylists(auth, 100)
      .then((list) => { if (!cancelled) setPlaylists(list); })
      .catch(() => { if (!cancelled) setPlaylists([]); });
    return () => { cancelled = true; };
  }, [auth?.userid]);

  return React.createElement(OnlineMusicSidebar, {
    brandLabel: '铃兰',
    temps: tempPlaylists.map(toTempItem),
    activeTempId,
    onSelectTemp: (item) => {
      const src = tempPlaylists.find(t => t.id === item.id);
      if (src) onSelectTemp(src);
    },
    userPlaylists: playlists.map(toUserPlaylist),
    activePlaylistId: undefined,
    onSelectUserPlaylist: (pl) => {
      const src = playlists.find(p => (p.gid ?? String(p.id)) === String(pl.id));
      if (src) onSelectUserPlaylist(src);
    },
    userEmptyText: auth ? '暂无歌单' : '登录后同步歌单',
    onClose: onCloseKugou,
    onOpenModuleSettings,
    onOpenStats,
    statsActive,
    searchQuery,
    onSearchChange,
    searchPlaceholder: '搜索酷狗音乐',
  });
}
