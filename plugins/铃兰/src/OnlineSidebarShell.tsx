import React from "react";
const { useState } = React;

const {
  ModuleSidebarShell,
  SecondaryNavShell,
  BarChart3,
} = window.__HOST_UI__ || {};

function Music2Icon() {
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
        title
      ),
      children
    );
  }

  return React.createElement(ModuleSidebarShell, {
    moduleId: 'music',
    icon: icon ?? React.createElement(Music2Icon),
    title,
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
