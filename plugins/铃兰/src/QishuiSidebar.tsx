// 汽水音乐侧栏（游客态第一版，仿 KugouSidebar 用 OnlineSidebarShell）
//
// 游客态：不展示头像/登录态，仅「我的收藏（临时播放列表）/ 推荐歌单」两段。
// 登录态（红心歌单）后续 Phase 补。点击歌单 → onSelectPlaylist 经父组件 openPlaylist。

import React from 'react';
import { User as UserIcon, ListMusic } from 'lucide-react';
import OnlineSidebarShell, { SidebarTempSection, TempPlaylistItem } from './OnlineSidebarShell';

interface QishuiPlaylistCard {
  id: string;
  name: string;
  coverImgUrl: string;
  trackCount: number;
  playCount: number;
}

interface QishuiSidebarProps {
  tempPlaylists?: TempPlaylistItem[];
  tempActiveId?: string | null;
  onSelectTemp?: (item: TempPlaylistItem) => void;
  recommend?: QishuiPlaylistCard[];
  activePlaylistId?: string | null;
  onSelectPlaylist?: (pl: QishuiPlaylistCard) => void;
}

export function QishuiSidebar(props: QishuiSidebarProps) {
  const { tempPlaylists, tempActiveId, onSelectTemp, recommend, activePlaylistId, onSelectPlaylist } = props;

  const renderMineSection = () => {
    return React.createElement(
      'div',
      { className: 'space-y-1' },
      // 游客态：提示登录态后续开放
      React.createElement(
        'div',
        { className: 'px-1 py-2 text-xs text-neutral-400 dark:text-stone-500' },
        '登录后可同步「我的收藏」歌单（当前为游客态）'
      ),
      // 临时播放列表（本次会话在线播放过的歌单）
      React.createElement(SidebarTempSection, {
        key: 'temp',
        items: tempPlaylists || [],
        activeId: tempActiveId,
        onSelect: (item: TempPlaylistItem) => onSelectTemp?.(item),
      })
    );
  };

  const renderTopSection = () => {
    return React.createElement(
      'div',
      { className: 'space-y-1' },
      (recommend || []).map((pl) =>
        React.createElement(
          'button',
          {
            key: pl.id,
            onClick: () => onSelectPlaylist?.(pl),
            className: `sidebar-nav-item w-full text-left ${activePlaylistId === pl.id ? 'active' : ''}`,
          },
          [
            React.createElement('span', { className: 'icons-wrap', key: 'ic' },
              React.createElement(ListMusic, { size: 16, strokeWidth: 2 })),
            React.createElement('span', { className: 'label', key: 'lb' }, pl.name),
          ]
        )
      )
    );
  };

  return React.createElement(OnlineSidebarShell, {
    icon: React.createElement(UserIcon, { size: 16 }),
    title: '汽水音乐',
    onClose: () => {},
    searchQuery: '',
    onSearchChange: () => {},
    searchPlaceholder: '搜索汽水音乐',
    children: React.createElement(
      React.Fragment,
      null,
      renderMineSection(),
      React.createElement('div', { className: 'sidebar-section-label px-1 pt-2 text-xs text-neutral-400' }, '推荐歌单'),
      renderTopSection()
    ),
  });
}

export default QishuiSidebar;
