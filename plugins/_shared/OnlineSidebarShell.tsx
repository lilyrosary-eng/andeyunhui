import React from "react";
const { useState } = React;

const {
  ModuleSidebarShell,
  SecondaryNavShell,
  BarChart3,
} = window.__HOST_UI__ || {};

export function Music2Icon() {
  return React.createElement('svg', {
    width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  }, [
    React.createElement('path', { key: '1', d: 'M9 18V5l12-2v13' }),
    React.createElement('circle', { key: '2', cx: '6', cy: '18', r: '3' }),
    React.createElement('circle', { key: '3', cx: '18', cy: '16', r: '3' }),
  ]);
}

export interface OnlineSidebarShellProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  /** 宿主模块 id（'music' / 'video' 等），透传给 ModuleSidebarShell 用于折叠状态隔离 */
  moduleId?: string;
  onClose: () => void;
  onOpenModuleSettings?: () => void;
  onOpenStats?: () => void;
  statsActive?: boolean;
  searchQuery?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  primaryAction?: { label: string; onClick: () => void };
  children: React.ReactNode;
}

export function OnlineSidebarShell({
  icon,
  title,
  moduleId,
  onClose,
  onOpenModuleSettings,
  onOpenStats,
  statsActive,
  searchQuery,
  onSearchChange,
  searchPlaceholder,
  primaryAction,
  children,
}: OnlineSidebarShellProps) {
  // 标题兼容：调用方若传字符串（未自带返回按钮），则包一层可点按钮调用 onClose。
  // 音乐侧栏自行传入 button 元素（不受影响）；视频侧栏也自行传入 button（双保险）。
  const titleNode =
    typeof title === 'string'
      ? React.createElement('button', {
          key: 'shell-title',
          onClick: () => onClose(),
          className: 'font-bold text-lg text-neutral-800 dark:text-stone-100 hover:text-[var(--element-color-raw)] transition-colors',
          title: '返回',
        }, title)
      : title;

  const statsButton = onOpenStats
    ? React.createElement('button', {
        key: 'open-stats',
        onClick: () => onOpenStats(),
        title: statsActive ? '关闭统计' : '统计',
        'aria-label': statsActive ? '关闭统计' : '统计',
        className: `p-2 rounded-lg transition-colors ${
          statsActive
            ? 'text-[var(--element-color-raw)] bg-black/5 dark:bg-white/5'
            : 'text-neutral-400 dark:text-stone-500 hover:text-[var(--element-color-raw)] hover:bg-black/5 dark:hover:bg-white/5'
        }`,
        children: BarChart3 ? React.createElement(BarChart3, { size: 18, strokeWidth: 2 }) : '📊',
      })
    : null;

  if (!ModuleSidebarShell) {
    return React.createElement('div', { className: 'w-[260px] h-full flex-shrink-0 bg-white/60 dark:bg-stone-800/60 backdrop-blur-md border-r border-white/80 dark:border-stone-700/50 p-4 overflow-y-auto' },
      React.createElement('div', { className: 'flex items-center gap-2 mb-4 px-1' },
        icon ?? React.createElement(Music2Icon),
        titleNode
      ),
      children
    );
  }

  return React.createElement(ModuleSidebarShell, {
    // ⚠️ 必须透传 moduleId：此前硬编码 'music'，导致视频在线侧栏与音乐侧栏
    // 共用同一个折叠状态 key（moduleToggleKey('music')），折叠一个另一个也跟着变。
    moduleId: moduleId || 'music',
    icon: icon ?? React.createElement(Music2Icon),
    title: titleNode,
    onOpenModuleSettings,
    footerExtra: statsButton,
    searchQuery,
    onSearchChange,
    searchPlaceholder,
    primaryAction,
    children: SecondaryNavShell
      ? React.createElement(SecondaryNavShell, null, children)
      : React.createElement('div', { className: 'flex-1 overflow-y-auto pr-1 space-y-3' }, children),
  });
}

export default OnlineSidebarShell;

// 在线源侧栏通用的「临时播放列表」折叠段：网易云 / 酷狗 复用同一套渲染与高亮
export interface TempPlaylistItem {
  id: string;
  name: string;
  count: number;
}

// 在线源临时歌单 → 侧栏项的统一映射（网易云 / 酷狗 / 汽水 共用同一结构）
export function toTempPlaylistItem(item: { id: string; name: string; payload: { tracks?: unknown[] } }): TempPlaylistItem {
  return {
    id: item.id,
    name: item.name,
    count: item.payload.tracks?.length ?? 0,
  };
}

export interface SidebarTempSectionProps {
  items: TempPlaylistItem[];
  activeId?: string | null;
  onSelect: (item: TempPlaylistItem) => void;
}

export function SidebarTempSection({ items, activeId, onSelect }: SidebarTempSectionProps) {
  const [expanded, setExpanded] = useState(true);
  if (items.length === 0) return null;
  return React.createElement('div', { key: 'temp', className: 'space-y-1' },
    React.createElement('button', {
      key: 'header',
      onClick: () => setExpanded(v => !v),
      className: 'w-full flex items-center justify-between px-1 py-1 text-xs text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-300 transition-colors',
    }, [
      React.createElement('span', { key: 't' }, '临时播放列表'),
      React.createElement('span', { key: 'c' }, expanded ? '−' : '+'),
    ]),
    expanded && items.map((temp, idx) => {
      const isActive = activeId === temp.id;
      return React.createElement('button', {
        key: temp.id,
        onClick: () => onSelect(temp),
        className: `w-full text-left px-3 py-2 rounded-xl transition-colors text-sm ${
          isActive
            ? 'bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100'
            : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400'
        }`,
      }, [
        React.createElement('div', { key: 'label', className: 'truncate' }, `临时${idx + 1}：${temp.name}`),
        React.createElement('div', { key: 'count', className: 'text-xs text-neutral-400 dark:text-stone-500 truncate mt-0.5' }, `${temp.count} 首`),
      ]);
    })
  );
}
