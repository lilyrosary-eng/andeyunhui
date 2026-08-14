// 在线音乐源通用状态桥（网易云 / 酷狗 等网络模块共用）
//
// 抽离原 MusicModule 中「neteaseTemps / neteaseActivePlaylist / activeNeteasePlaylistId /
// activeTempId」这套与具体平台无关的在线播放注册逻辑，做成可复用 Hook。
// 这样每个网络音乐模块只需调用 registerPlay / registerTemp，无需在 MusicModule 里
// 为每个平台复制一遍 setXxxActivePlaylist / setNeteaseTemps 等 setter，实现本地库与
// 在线源、以及各在线源之间的彻底隔离。

import { useState, useCallback } from 'react';
import type { Playlist } from './index';
import type { PlayableTrack, TempPlaylist } from './NeteaseView';

// 在线源临时歌单（侧栏 / 播放列表浮窗展示用），与网易云侧栏的 NeteaseTempItem 同构
export interface OnlineTempItem {
  id: string;
  name: string;
  payload: TempPlaylist;
}

export interface OnlineSourceApi {
  // 当前实际播放的在线源歌单（注入 PlayerBar / NowPlayingView，让浮窗显示在线来源）
  activePlaylist: Playlist | null;
  setActivePlaylist: (p: Playlist | null) => void;
  // 注册的临时歌单列表（最多保留 3 个，滚动淘汰，重复来源不重复占位）
  temps: OnlineTempItem[];
  // 当前高亮的临时歌单 id（在线源侧栏用）
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  // 在线源内部「当前选中的歌单/榜单」id（与网易云侧栏的 activeNeteasePlaylistId 完全分离，
  // 避免酷狗选中榜单时错误高亮网易云侧栏、反之亦然，实现各在线源之间的彻底隔离）
  sourceActiveId: string | number | null;
  setSourceActiveId: (id: string | number | null) => void;
  // 播放某在线源的曲目：注册为临时歌单 + 标记 currentPlaylistId
  registerPlay: (
    tracks: PlayableTrack[],
    startIndex: number,
    name: string,
    type: 'netease-temp' | 'kugou-temp',
  ) => void;
  // 注册一个临时歌单（来自子模块内部如「我喜欢的音乐」整页播放）
  registerTemp: (temp: TempPlaylist) => void;
}

const MAX_TEMPS = 3;

export function useOnlineSource(): OnlineSourceApi {
  const [activePlaylist, setActivePlaylist] = useState<Playlist | null>(null);
  const [temps, setTemps] = useState<OnlineTempItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sourceActiveId, setSourceActiveId] = useState<string | number | null>(null);

  const registerPlay = useCallback(
    (tracks: PlayableTrack[], _startIndex: number, name: string, type: 'netease-temp' | 'kugou-temp') => {
      // 在线播放注册为临时歌单（id 与类型绑定到具体平台，供浮窗区分来源）
      const id = type === 'netease-temp' ? 'netease-active' : 'kugou-active';
      setActivePlaylist({ id, name, type, tracks });
    },
    [],
  );

  const registerTemp = useCallback((temp: TempPlaylist) => {
    const id = String(temp.id ?? temp.name);
    setTemps((prev) => {
      const without = prev.filter((t) => t.id !== id);
      return [{ id, name: temp.name, payload: temp }, ...without].slice(0, MAX_TEMPS);
    });
    setActiveId(id);
  }, []);

  return {
    activePlaylist,
    setActivePlaylist,
    temps,
    activeId,
    setActiveId,
    sourceActiveId,
    setSourceActiveId,
    registerPlay,
    registerTemp,
  };
}
