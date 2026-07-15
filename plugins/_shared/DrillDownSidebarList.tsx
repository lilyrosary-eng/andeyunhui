/// <reference path="../global.d.ts" />
// 共享钻取导航列表 — 两态导航（主列表 → 子列表）
// 适用于视频模块（文件夹→视频）、音乐模块（歌单→歌曲）等钻取导航场景
// 消除 VideoSidebar / MusicSidebar 之间的列表渲染重复代码

const React = window.__HOST_REACT__;
const { useMemo } = React;
const { SecondaryNavShell, ContextMenu, ContextMenuTrigger, ContextMenuContent } = window.__HOST_UI__ || {};

// ========== 类型 ==========

export interface DrillDownItem {
  id: string;
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  badge?: string | number;
  active?: boolean;
  /** 若提供，该项会被包裹在 ContextMenu 中 */
  contextMenu?: React.ReactNode;
}

export interface DrillDownSidebarListProps {
  /** 主列表项（drillTitle 为 null 时显示） */
  primaryItems: DrillDownItem[];
  /** 子列表项（drillTitle 不为 null 时显示） */
  secondaryItems?: DrillDownItem[];
  /** 非 null 时进入子列表，显示返回按钮 + 此标题 */
  drillTitle?: string | null;
  onBack?: () => void;
  onItemClick: (item: DrillDownItem) => void;
  primaryEmptyText?: string;
  secondaryEmptyText?: string;
}

// ========== 返回箭头图标 ==========

function BackArrowIcon() {
  return React.createElement('svg', {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    children: React.createElement('polyline', { points: '15 18 9 12 15 6' }),
  });
}

// ========== 主组件 ==========

export function DrillDownSidebarList({
  primaryItems,
  secondaryItems = [],
  drillTitle = null,
  onBack,
  onItemClick,
  primaryEmptyText = '暂无数据',
  secondaryEmptyText = '暂无数据',
}: DrillDownSidebarListProps) {
  const isDrilled = drillTitle !== null && drillTitle !== undefined;
  const items = isDrilled ? secondaryItems : primaryItems;
  const emptyText = isDrilled ? secondaryEmptyText : primaryEmptyText;

  const listContent = useMemo(() => {
    if (items.length === 0) {
      return React.createElement('div', {
        className: 'flex-1 flex items-center justify-center text-xs text-neutral-400 dark:text-stone-500',
      }, emptyText);
    }

    const itemElements = items.map((item, index) => {
      // 兜底：部分调用方可能未提供 id，使用 index 防止 React key 缺失/重复告警
      const itemKey = item.id != null ? item.id : `drilldown-${index}`;
      const button = React.createElement('button', {
        key: itemKey,
        onClick: () => onItemClick(item),
        className: `w-full text-left px-3 py-2 rounded-xl transition-colors flex items-center gap-2.5 ${
          item.active
            ? 'bg-[var(--element-bg)]/10 text-[var(--element-bg)]'
            : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400'
        }`,
      },
        item.icon && React.createElement('span', { key: 'icon', className: 'flex-shrink-0 opacity-60' }, item.icon),
        React.createElement('div', { key: 'info', className: 'min-w-0 flex-1' },
          React.createElement('div', { className: 'text-sm truncate' }, item.title),
          item.subtitle && React.createElement('div', { className: 'text-[11px] opacity-50 mt-0.5' }, item.subtitle),
        ),
        item.badge !== undefined && React.createElement('span', { key: 'badge', className: 'text-xs opacity-50 flex-shrink-0' }, String(item.badge)),
        item.active && React.createElement('span', { key: 'active', className: 'w-1.5 h-1.5 rounded-full bg-[var(--element-bg)] flex-shrink-0' }),
      );

      // 若提供 contextMenu，用 ContextMenu 包裹
      if (item.contextMenu && ContextMenu) {
        return React.createElement(ContextMenu, { key: itemKey },
          React.createElement(ContextMenuTrigger, { key: 'trigger', className: 'w-full' }, button),
          React.createElement(ContextMenuContent, { key: 'content' }, item.contextMenu),
        );
      }
      return button;
    });

    return React.createElement('div', { className: 'space-y-0.5' }, ...itemElements);
  }, [items, emptyText, onItemClick]);

  // 子列表模式：添加返回按钮
  const fullContent = isDrilled && onBack
    ? React.createElement(React.Fragment, null,
        React.createElement('button', {
          onClick: onBack,
          className: 'w-full text-left px-3 py-2 rounded-xl transition-colors flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/5 text-neutral-500 dark:text-stone-400 mb-1',
        },
          React.createElement('span', { className: 'flex-shrink-0' }, React.createElement(BackArrowIcon)),
          React.createElement('span', { className: 'text-sm font-medium truncate' }, drillTitle),
        ),
        listContent,
      )
    : listContent;

  return SecondaryNavShell
    ? React.createElement(SecondaryNavShell, null, fullContent)
    : React.createElement('div', { className: 'flex-1 overflow-y-auto pr-1' }, fullContent);
}

export default DrillDownSidebarList;
