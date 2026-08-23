/// <reference path="../../global.d.ts" />
// ============================================================
// Web 接口模块 · 统一侧边栏壳
//
// 不再手搓 <aside>，改为复用宿主 `ModuleSidebarShell`（标题/图标/搜索/
// 主操作按钮/底部收起+设置齿轮/系统主色高亮），列表项套宿主 `ContextMenu`
// 支持右键「启动/编辑/删除」，与 AI 对话、铃兰、玉兰等模块观感一致。
// ============================================================
const React = window.__HOST_REACT__;

const {
  ModuleSidebarShell,
  SecondaryNavShell,
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} = window.__HOST_UI__ || {};

/** 地球图标：Web 接口模块的侧边栏图标 */
export function GlobeIcon() {
  return React.createElement('svg', {
    width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  }, [
    React.createElement('circle', { key: '1', cx: '12', cy: '12', r: '10' }),
    React.createElement('line', { key: '2', x1: '2', y1: '12', x2: '22', y2: '12' }),
    React.createElement('path', { key: '3', d: 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z' }),
  ]);
}

export type WebPresetStatusKind = 'idle' | 'starting' | 'running' | 'stopped' | 'error';

export interface WebSidebarItem {
  id: string;
  name: string;
  desc?: string;
  /** 命令预览（列表回退显示的说明行） */
  hint?: string;
  /** 运行态（用于右侧小状态点） */
  runStatus?: WebPresetStatusKind;
}

export interface WebSidebarShellProps {
  icon?: React.ReactNode;
  title: string;
  searchQuery?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  onOpenModuleSettings?: () => void;
  onAdd: () => void;
  onStart: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  items: WebSidebarItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  emptyText?: string;
}

const statusDot: Record<WebPresetStatusKind, string> = {
  idle:     'bg-neutral-300 dark:bg-stone-600',
  starting: 'bg-amber-500 animate-pulse',
  running:  'bg-emerald-500',
  stopped:  'bg-neutral-300 dark:bg-stone-600',
  error:    'bg-red-500',
};

/** 单个预设项（带右键菜单 + 系统主色高亮） */
function WebSidebarItem({ item, active, onSelect, onStart, onEdit, onDelete }: {
  item: WebSidebarItem;
  active: boolean;
  onSelect: (id: string) => void;
  onStart: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const hasContext = !!(ContextMenu && ContextMenuTrigger && ContextMenuContent && ContextMenuItem);

  const buttonContent = React.createElement('button', {
    onClick: () => onSelect(item.id),
    className: `w-full text-left rounded-xl px-3 py-2 transition-colors ${
      active
        ? 'bg-[var(--element-muted)] text-[var(--element-color-raw)]'
        : 'hover:bg-black/5 dark:hover:bg-white/5'
    }`,
    children: [
      React.createElement('div', { key: 'row', className: 'flex items-center justify-between gap-2' },
        React.createElement('span', {
          key: 'name',
          className: 'text-sm font-medium text-neutral-800 dark:text-stone-100 truncate',
        }, item.name),
        item.runStatus && item.runStatus !== 'idle'
          ? React.createElement('span', {
              key: 'dot',
              className: `w-2 h-2 rounded-full shrink-0 ${statusDot[item.runStatus] ?? statusDot.idle}`,
              title: '运行中',
            })
          : null,
      ),
      item.desc
        ? React.createElement('div', {
            key: 'desc',
            className: 'mt-0.5 text-xs text-neutral-400 dark:text-stone-500 truncate',
          }, item.desc)
        : null,
      item.hint
        ? React.createElement('div', {
            key: 'hint',
            className: 'mt-0.5 font-mono text-[11px] text-neutral-400 dark:text-stone-600 truncate',
          }, item.hint)
        : null,
    ],
  });

  if (!hasContext) return buttonContent;

  return React.createElement(ContextMenu, { key: item.id },
    React.createElement(ContextMenuTrigger, { key: 'trigger', className: 'w-full' }, buttonContent),
    React.createElement(ContextMenuContent, { key: 'content' },
      React.createElement(ContextMenuItem, { key: 'open', onClick: () => onSelect(item.id) }, '打开'),
      React.createElement(ContextMenuItem, { key: 'start', onClick: () => onStart(item.id) }, '一键启动'),
      React.createElement(ContextMenuSeparator, { key: 'sep' }),
      React.createElement(ContextMenuItem, { key: 'edit', onClick: () => onEdit(item.id) }, '编辑'),
      React.createElement(ContextMenuItem, {
        key: 'delete',
        onClick: () => onDelete(item.id),
        variant: 'destructive',
      }, '删除'),
    ),
  );
}

export function WebSidebarShell({
  icon, title, searchQuery, onSearchChange, searchPlaceholder, onOpenModuleSettings,
  onAdd, onStart, onEdit, onDelete, items, selectedId, onSelect, emptyText,
}: WebSidebarShellProps) {
  // 兜底：宿主未提供 ModuleSidebarShell 时退回简单容器（与 OnlineSidebarShell 一致）
  if (!ModuleSidebarShell) {
    return React.createElement('div', {
      className: 'w-[260px] h-full flex-shrink-0 bg-white/60 dark:bg-stone-800/60 backdrop-blur-md border-r border-white/80 dark:border-stone-700/50 p-4 overflow-y-auto flex flex-col',
    }, [
      React.createElement('div', { key: 'head', className: 'flex items-center gap-2 mb-4 px-1' },
        icon ?? React.createElement(GlobeIcon),
        React.createElement('span', { key: 't', className: 'font-bold text-lg text-neutral-800 dark:text-stone-100 truncate' }, title),
      ),
      React.createElement('div', { key: 'primary', className: 'mb-3' },
        React.createElement('button', {
          onClick: onAdd,
          className: 'btn-press w-full rounded-xl bg-sky-500 py-2 text-sm font-medium text-white hover:bg-sky-600',
        }, '新建预设'),
      ),
      React.createElement('div', { key: 'list', className: 'flex-1 min-h-0 overflow-y-auto space-y-1' },
        items.length === 0
          ? React.createElement('div', { key: 'empty', className: 'px-3 py-6 text-center text-xs text-neutral-400 dark:text-stone-500' }, emptyText || '还没有预设')
          : items.map((it) => React.createElement(WebSidebarItem, {
              key: it.id, item: it, active: selectedId === it.id,
              onSelect, onStart, onEdit, onDelete,
            })),
      ),
    ]);
  }

  const list = items.length === 0
    ? React.createElement('div', { key: 'empty', className: 'px-3 py-6 text-center text-xs text-neutral-400 dark:text-stone-500' }, emptyText || '还没有预设。点「新建」，选本地文件/文件夹自动识别后保存。')
    : items.map((it) => React.createElement(WebSidebarItem, {
        key: it.id, item: it, active: selectedId === it.id,
        onSelect, onStart, onEdit, onDelete,
      }));

  return React.createElement(ModuleSidebarShell, {
    moduleId: 'web-interface',
    icon: icon ?? React.createElement(GlobeIcon),
    title,
    onOpenModuleSettings,
    searchQuery,
    onSearchChange,
    searchPlaceholder,
    primaryAction: { label: '新建预设', onClick: onAdd },
    children: SecondaryNavShell
      ? React.createElement(SecondaryNavShell, null, list)
      : React.createElement('div', { className: 'flex-1 overflow-y-auto pr-1 space-y-3' }, list),
  });
}

export default WebSidebarShell;