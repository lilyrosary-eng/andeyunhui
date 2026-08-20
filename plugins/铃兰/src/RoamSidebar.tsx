/// <reference path="../../global.d.ts" />
// 漫游电台独立侧边栏
//
// 设计：
//   - 四个折叠菜单（铃兰/网易云/酷狗/汽水）
//   - 未播放时每个菜单下显示一首默认歌曲（方便切换漫游路径）
//   - 播放某个路径时，该菜单下显示漫游历史（播放一条增加一条）
//   - 切换到别的漫游路径或切换模块时清空历史/缓存
//   - 漫游电台的模块设置独立，不使用铃兰的

import React from "react";
const { useState, useEffect, useRef, useCallback } = React;
import { ChevronDown, ChevronRight, Settings, Sparkles, Music as MusicIcon, Play, Trash2 } from 'lucide-react';
import { T, useLang } from '../../_shared/pluginRuntime';
import { musicPlayer, type Track } from './musicPlayer';

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
  // 当前激活的漫游路径
  activeSource: RoamSource | null;
  // 各平台的漫游历史
  histories: Record<RoamSource, RoamHistoryEntry[]>;
  // 各平台的默认歌曲（未播放时显示）
  seedTracks: Partial<Record<RoamSource, RoamSeedTrack>>;
  // 选择某个漫游路径
  onSelectSource: (source: RoamSource) => void;
  // 点击某首歌曲（从历史或默认歌曲）
  onSelectTrack: (source: RoamSource, track: RoamSeedTrack, fromHistory: boolean) => void;
  // 清空某个路径的历史
  onClearHistory: (source: RoamSource) => void;
  // 关闭漫游侧边栏
  onClose: () => void;
  // 打开漫游设置
  onOpenSettings: () => void;
  // 设置面板是否激活
  settingsActive?: boolean;
}

// 各平台配置
const SOURCE_CONFIG: Record<RoamSource, { label: string; icon: string; color: string; colorDark: string; bg: string; bgDark: string }> = {
  linglan: {
    label: '铃兰',
    icon: '🎵',
    color: 'text-[#4caf50]',
    colorDark: 'dark:text-[#81c784]',
    bg: 'bg-[#4caf50]/10',
    bgDark: 'dark:bg-[#4caf50]/10',
  },
  netease: {
    label: '网易云',
    icon: '🎶',
    color: 'text-[#f44336]',
    colorDark: 'dark:text-[#ff8a80]',
    bg: 'bg-[#f44336]/10',
    bgDark: 'dark:bg-[#f44336]/10',
  },
  kugou: {
    label: '酷狗',
    icon: '🎤',
    color: 'text-[#ff7700]',
    colorDark: 'dark:text-[#ffb74d]',
    bg: 'bg-[#ff7700]/10',
    bgDark: 'dark:bg-[#ff7700]/10',
  },
  qishui: {
    label: '汽水',
    icon: '🥤',
    color: 'text-[#00c2c7]',
    colorDark: 'dark:text-[#4dd0e1]',
    bg: 'bg-[#00c2c7]/10',
    bgDark: 'dark:bg-[#00c2c7]/10',
  },
};

const SOURCE_ORDER: RoamSource[] = ['linglan', 'netease', 'kugou', 'qishui'];

// 格式化时间
function formatTime(sec: number): string {
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatPlayedAt(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  return new Date(ts).toLocaleDateString();
}

// 封面 URL 转换
function getCoverUrl(path?: string): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  const host = (window as any).__HOST_API__;
  if (host?.convertFileSrc) return host.convertFileSrc(path);
  return path;
}

export function RoamSidebar({
  activeSource,
  histories,
  seedTracks,
  onSelectSource,
  onSelectTrack,
  onClearHistory,
  onClose,
  onOpenSettings,
  settingsActive,
}: RoamSidebarProps) {
  useLang();
  const [expandedMenus, setExpandedMenus] = useState<Set<RoamSource>>(new Set());

  // 默认展开激活的路径
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

  // 渲染单首歌曲行
  const renderTrack = (track: RoamSeedTrack, source: RoamSource, isHistory: boolean, index: number) => {
    const coverUrl = getCoverUrl(track.cover);
    const isActive = activeSource === source && musicPlayer.getCurrentTrack()?.id === track.id;
    return (
      <div
        key={`${track.id}-${index}`}
        onClick={() => onSelectTrack(source, track, isHistory)}
        className={`group flex items-center gap-2.5 rounded-lg px-2.5 py-2 cursor-pointer transition-colors ${
          isActive
            ? 'bg-[var(--element-muted)] text-[var(--element-bg)]'
            : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-300'
        }`}
      >
        {/* 封面 */}
        <div className="w-9 h-9 rounded-md overflow-hidden bg-neutral-200/60 dark:bg-stone-700/60 flex items-center justify-center shrink-0">
          {coverUrl ? (
            <img src={coverUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <MusicIcon size={14} className="text-neutral-400" />
          )}
        </div>
        {/* 信息 */}
        <div className="flex-1 min-w-0">
          <div className={`text-xs font-medium truncate ${isActive ? '' : 'text-neutral-700 dark:text-stone-200'}`}>
            {track.title}
          </div>
          <div className="text-[10px] text-neutral-400 dark:text-stone-500 truncate">
            {track.artist || '未知歌手'}
            {isHistory && ` · ${formatPlayedAt(0)}`}
          </div>
        </div>
        {/* 播放按钮 */}
        <button
          onClick={(e) => { e.stopPropagation(); onSelectTrack(source, track, isHistory); }}
          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-full hover:bg-black/10 dark:hover:bg-white/10"
        >
          <Play size={12} className={isActive ? 'text-[var(--element-color-raw)]' : 'text-neutral-400'} />
        </button>
      </div>
    );
  };

  // 渲染折叠菜单
  const renderMenu = (source: RoamSource) => {
    const config = SOURCE_CONFIG[source];
    const expanded = expandedMenus.has(source);
    const isActive = activeSource === source;
    const history = histories[source] || [];
    const seedTrack = seedTracks[source];
    const hasContent = history.length > 0 || !!seedTrack;

    return (
      <div key={source} className="mb-1">
        {/* 折叠头部 */}
        <button
          onClick={() => toggleExpand(source)}
          className={`w-full flex items-center gap-2.5 rounded-xl px-3 py-2.5 transition-colors ${
            isActive
              ? `${config.bg} ${config.bgDark}`
              : 'hover:bg-black/5 dark:hover:bg-white/5'
          }`}
        >
          {/* 图标 */}
          <div className={`w-7 h-7 rounded-lg flex items-center justify-center text-sm shrink-0 ${
            isActive ? `${config.bg} ${config.bgDark}` : 'bg-neutral-200/70 dark:bg-stone-600/50'
          }`}>
            <span>{config.icon}</span>
          </div>
          {/* 标题 */}
          <span className={`flex-1 text-sm font-medium text-left truncate ${
            isActive ? `${config.color} ${config.colorDark}` : 'text-neutral-700 dark:text-stone-200'
          }`}>
            {config.label}
          </span>
          {/* 历史数量 */}
          {history.length > 0 && (
            <span className="text-[10px] text-neutral-400 dark:text-stone-500 shrink-0">
              {history.length} 首
            </span>
          )}
          {/* 展开/收起箭头 */}
          <div className="shrink-0 text-neutral-400 dark:text-stone-500">
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </div>
        </button>

        {/* 折叠内容 */}
        <div
          className={`overflow-hidden transition-all duration-300 ease-out ${
            expanded ? 'max-h-96 opacity-100 mt-1' : 'max-h-0 opacity-0'
          }`}
        >
          <div className="pl-2 pr-1 space-y-0.5">
            {/* 无内容占位 */}
            {!hasContent && (
              <div className="px-3 py-3 text-xs text-neutral-400 dark:text-stone-500 text-center">
                加载中…
              </div>
            )}
            {/* 历史记录（倒序：最新的在顶部） */}
            {history.length > 0 && (
              <>
                <div className="flex items-center justify-between px-2.5 py-1">
                  <span className="text-[10px] font-medium text-neutral-400 dark:text-stone-500 uppercase tracking-wider">
                    漫游历史
                  </span>
                  <button
                    onClick={() => onClearHistory(source)}
                    className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 text-neutral-400 hover:text-red-500 transition-colors"
                    title="清空历史"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
                {history.slice().reverse().map((entry, i) =>
                  renderTrack(entry.track, source, true, history.length - 1 - i)
                )}
              </>
            )}
            {/* 默认歌曲（未播放时显示） */}
            {history.length === 0 && seedTrack && (
              renderTrack(seedTrack, source, false, 0)
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="w-[260px] h-full flex-shrink-0 bg-white/60 dark:bg-stone-800/60 backdrop-blur-md border-r border-white/80 dark:border-stone-700/50 flex flex-col">
      {/* 头部 */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-neutral-200/30 dark:border-stone-700/30">
        <div className="flex items-center gap-2">
          <Sparkles size={18} className="text-[#7c4dff] dark:text-[#b388ff]" />
          <span className="font-bold text-sm text-neutral-800 dark:text-stone-100">漫游电台</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onOpenSettings}
            className={`p-1.5 rounded-lg transition-colors ${
              settingsActive
                ? 'text-[#7c4dff] dark:text-[#b388ff] bg-[#7c4dff]/10'
                : 'text-neutral-400 dark:text-stone-500 hover:text-[#7c4dff] dark:hover:text-[#b388ff] hover:bg-black/5 dark:hover:bg-white/5'
            }`}
            title="漫游设置"
          >
            <Settings size={16} />
          </button>
        </div>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-3">
        <p className="text-[10px] font-medium text-neutral-400 dark:text-stone-500 uppercase tracking-wider mb-2 px-1">
          漫游路径
        </p>
        {SOURCE_ORDER.map(renderMenu)}
      </div>

      {/* 底部提示 */}
      <div className="shrink-0 px-4 py-2 border-t border-neutral-200/30 dark:border-stone-700/30">
        <p className="text-[10px] text-neutral-400 dark:text-stone-500 text-center">
          点击路径开始漫游 · 切换路径清空历史
        </p>
      </div>
    </div>
  );
}

export default RoamSidebar;
