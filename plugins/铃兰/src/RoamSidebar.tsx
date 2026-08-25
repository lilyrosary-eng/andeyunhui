/// <reference path="../../global.d.ts" />
// 漫游电台独立侧边栏
//
// 使用 ModuleSidebarShell（与网易云/酷狗/汽水一致）获得底部收起/设置/统计按钮。
// 内容区：四个折叠菜单（铃兰/网易云/酷狗/汽水），每个菜单下有默认歌曲或漫游历史。

import React from "react";
const { useState, useEffect, useRef, useCallback } = React;
import { ChevronDown, ChevronRight, Sparkles, Music as MusicIcon, Play, Trash2, Cloud } from 'lucide-react';
import { T, useLang } from '../../_shared/pluginRuntime';
import { musicPlayer, type Track } from './musicPlayer';
import { OnlineSidebarShell } from './OnlineSidebarShell';

// 各平台推荐歌曲类型
export interface RoamSeedTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  cover?: string;
  durationSecs: number;
  filePath: string;
  quality?: string;
}

export interface RoamHistoryEntry {
  track: RoamSeedTrack;
  playedAt: number;
}

export type RoamSource = 'linglan' | 'netease' | 'kugou' | 'qishui';

interface RoamSidebarProps {
  activeSource: RoamSource | null;
  histories: Record<RoamSource, RoamHistoryEntry[]>;
  seedTracks: Partial<Record<RoamSource, RoamSeedTrack>>;
  onSelectSource: (source: RoamSource) => void;
  onSelectTrack: (source: RoamSource, track: RoamSeedTrack, fromHistory: boolean) => void;
  onClearHistory: (source: RoamSource) => void;
  onBack: () => void;
  onClose: () => void;
  onOpenSettings: () => void;
  settingsActive?: boolean;
  onOpenStats?: () => void;
  statsActive?: boolean;
}

// 各平台配置
const SOURCE_CONFIG: Record<RoamSource, { label: string; icon: string; color: string; colorDark: string; bg: string; bgDark: string }> = {
  linglan: { label: '铃兰', icon: '🎵', color: 'text-[#4caf50]', colorDark: 'dark:text-[#81c784]', bg: 'bg-[#4caf50]/10', bgDark: 'dark:bg-[#4caf50]/10' },
  netease: { label: '网易云', icon: '🎶', color: 'text-[#f44336]', colorDark: 'dark:text-[#ff8a80]', bg: 'bg-[#f44336]/10', bgDark: 'dark:bg-[#f44336]/10' },
  kugou: { label: '酷狗', icon: '🎤', color: 'text-[#ff7700]', colorDark: 'dark:text-[#ffb74d]', bg: 'bg-[#ff7700]/10', bgDark: 'dark:bg-[#ff7700]/10' },
  qishui: { label: '汽水', icon: '🥤', color: 'text-[#00c2c7]', colorDark: 'dark:text-[#4dd0e1]', bg: 'bg-[#00c2c7]/10', bgDark: 'dark:bg-[#00c2c7]/10' },
};

const SOURCE_ORDER: RoamSource[] = ['linglan', 'netease', 'kugou', 'qishui'];

function formatPlayedAt(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  return new Date(ts).toLocaleDateString();
}

function getCoverUrl(path?: string): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  const host = (window as any).__HOST_API__;
  if (host?.convertFileSrc) return host.convertFileSrc(path);
  return path;
}

export function RoamSidebar(props: RoamSidebarProps) {
  useLang();
  const { activeSource, histories, seedTracks, onSelectSource, onSelectTrack, onClearHistory, onBack, onClose, onOpenSettings, settingsActive, onOpenStats, statsActive } = props;
  const [expandedMenus, setExpandedMenus] = useState<Set<RoamSource>>(new Set(activeSource ? [activeSource] : []));

  useEffect(() => {
    if (activeSource) {
      setExpandedMenus((prev) => new Set([...prev, activeSource]));
    }
  }, [activeSource]);

  const toggleExpand = (source: RoamSource) => {
    setExpandedMenus((prev) => {
      const next = new Set(prev);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  };

  const renderTrack = (track: RoamSeedTrack, source: RoamSource, isHistory: boolean, index: number, playedAt?: number) => {
    const coverUrl = getCoverUrl(track.cover);
    const isActive = activeSource === source && musicPlayer.getCurrentTrack()?.id === track.id;
    return React.createElement('div', {
      key: `${track.id}-${index}`,
      onClick: () => onSelectTrack(source, track, isHistory),
      className: `group flex items-center gap-2.5 rounded-lg px-2.5 py-2 cursor-pointer transition-colors ${
        isActive ? 'bg-[var(--element-muted)] text-[var(--element-bg)]' : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-300'
      }`,
    }, [
      React.createElement('div', { key: 'cover', className: 'w-9 h-9 rounded-md overflow-hidden bg-neutral-200/60 dark:bg-stone-700/60 flex items-center justify-center shrink-0' },
        coverUrl ? React.createElement('img', { src: coverUrl, alt: '', className: 'w-full h-full object-cover' })
                 : React.createElement(MusicIcon, { size: 14, className: 'text-neutral-400' })
      ),
      React.createElement('div', { key: 'info', className: 'flex-1 min-w-0' },
        React.createElement('div', { key: 'title', className: `text-xs font-medium truncate ${isActive ? '' : 'text-neutral-700 dark:text-stone-200'}` }, track.title),
        React.createElement('div', { key: 'sub', className: 'text-[10px] text-neutral-400 dark:text-stone-500 truncate' },
          track.artist || '未知歌手',
          isHistory && playedAt ? ` · ${formatPlayedAt(playedAt)}` : ''
        ),
      ),
      React.createElement('button', {
        key: 'play',
        onClick: (e: React.MouseEvent) => { e.stopPropagation(); onSelectTrack(source, track, isHistory); },
        className: 'opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-full hover:bg-black/10 dark:hover:bg-white/10',
      }, React.createElement(Play, { size: 12, className: isActive ? 'text-[var(--element-color-raw)]' : 'text-neutral-400' })),
    ]);
  };

  const renderMenu = (source: RoamSource) => {
    const config = SOURCE_CONFIG[source];
    const expanded = expandedMenus.has(source);
    const isActive = activeSource === source;
    const history = histories[source] || [];
    const seedTrack = seedTracks[source];
    const hasContent = history.length > 0 || !!seedTrack;

    return React.createElement('div', { key: source, className: 'mb-1' },
      // 折叠头部
      React.createElement('button', {
        onClick: () => toggleExpand(source),
        className: `w-full flex items-center gap-2.5 rounded-xl px-3 py-2.5 transition-colors ${
          isActive ? `${config.bg} ${config.bgDark}` : 'hover:bg-black/5 dark:hover:bg-white/5'
        }`,
      }, [
        React.createElement('div', { key: 'icon', className: `w-7 h-7 rounded-lg flex items-center justify-center text-sm shrink-0 ${
          isActive ? `${config.bg} ${config.bgDark}` : 'bg-neutral-200/70 dark:bg-stone-600/50'
        }` }, config.icon),
        React.createElement('span', { key: 'label', className: `flex-1 text-sm font-medium text-left truncate ${
          isActive ? `${config.color} ${config.colorDark}` : 'text-neutral-700 dark:text-stone-200'
        }` }, config.label),
        history.length > 0 ? React.createElement('span', { key: 'count', className: 'text-[10px] text-neutral-400 dark:text-stone-500 shrink-0' }, `${history.length} 首`) : null,
        React.createElement('div', { key: 'chevron', className: 'shrink-0 text-neutral-400 dark:text-stone-500' },
          expanded ? React.createElement(ChevronDown, { size: 16 }) : React.createElement(ChevronRight, { size: 16 })
        ),
      ]),
      // 折叠内容
      React.createElement('div', {
        className: `overflow-hidden transition-all duration-300 ease-out ${expanded ? 'max-h-96 opacity-100 mt-1' : 'max-h-0 opacity-0'}`,
      },
        React.createElement('div', { className: 'pl-2 pr-1 space-y-0.5' },
          !hasContent ? React.createElement('div', { key: 'empty', className: 'px-3 py-3 text-xs text-neutral-400 dark:text-stone-500 text-center' }, '加载中…') : null,
          history.length > 0 ? [
            React.createElement('div', { key: 'hdr', className: 'flex items-center justify-between px-2.5 py-1' }, [
              React.createElement('span', { key: 'lbl', className: 'text-[10px] font-medium text-neutral-400 dark:text-stone-500 uppercase tracking-wider' }, '漫游历史'),
              React.createElement('button', {
                key: 'clear',
                onClick: () => onClearHistory(source),
                className: 'p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 text-neutral-400 hover:text-red-500 transition-colors',
                title: '清空历史',
              }, React.createElement(Trash2, { size: 11 })),
            ]),
            ...history.slice().reverse().map((entry, i) =>
              renderTrack(entry.track, source, true, history.length - 1 - i, entry.playedAt)
            ),
          ] : null,
          history.length === 0 && seedTrack ? renderTrack(seedTrack, source, false, 0) : null,
        ),
      ),
    );
  };

  // 标题行：Sparkles + "漫游电台" + Cloud 返回按钮（同一行）
  const titleEl = React.createElement('div', { className: 'flex items-center gap-2' },
    React.createElement('button', {
      onClick: onClose,
      className: 'font-bold text-lg text-neutral-800 dark:text-stone-100 hover:text-[var(--element-color-raw)] transition-colors flex items-center gap-2',
      title: '返回本地音乐',
    }, [
      React.createElement(Sparkles, { key: 'icon', size: 18, className: 'text-[#7c4dff] dark:text-[#b388ff]' }),
      '漫游电台',
    ]),
    React.createElement('button', {
      onClick: onBack,
      className: 'ml-auto p-1.5 rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/5 text-neutral-400 dark:text-stone-500',
      title: '返回模块抽屉',
    }, React.createElement(Cloud, { size: 16 })),
  );

  const content = React.createElement('div', { className: 'space-y-4' },
    React.createElement('p', { key: 'label', className: 'text-[10px] font-medium text-neutral-400 dark:text-stone-500 uppercase tracking-wider mb-1 px-1' }, '漫游路径'),
    ...SOURCE_ORDER.map(renderMenu),
  );

  return React.createElement(OnlineSidebarShell, {
    icon: React.createElement(Sparkles, { size: 22, className: 'text-[#7c4dff] dark:text-[#b388ff]' }),
    title: titleEl,
    onClose,
    onOpenModuleSettings: onOpenSettings,
    onOpenStats,
    statsActive,
    children: content,
  });
}

export default RoamSidebar;
