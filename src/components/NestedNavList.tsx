import { type ReactNode, useMemo, Fragment } from 'react';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent } from '@/components/ui/context-menu';

// ========== 类型 ==========

/** 标准列表项 — 适用于简单的钻取列表（如文件夹→文件、歌单→歌曲） */
export interface NavLayerItem {
  id: string;
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  active?: boolean;
  disabled?: boolean;
  /** 若提供，该项会被包裹在 ContextMenu 中 */
  contextMenu?: ReactNode;
}

/** 导航层 — 支持标准列表（items）或自定义内容（children） */
export interface NavLayer {
  /** 层标题（返回按钮显示用） */
  title: string;
  /** 标准列表项（与 children 二选一） */
  items?: NavLayerItem[];
  /** 自定义内容（与 items 二选一，用于复杂结构如目录树、分组列表） */
  children?: ReactNode;
  /** 空状态文案（仅 items 模式生效） */
  emptyText?: string;
}

export interface NestedNavListProps {
  /**
   * 层级栈：layers[0] 为根层，最后一项为当前活动层。
   * - 长度为 1 时：仅显示当前层，无返回按钮
   * - 长度 > 1 时：顶部显示返回按钮（带上一层标题），下方显示当前层内容
   */
  layers: NavLayer[];
  /** 返回上一层（layers.length > 1 时触发） */
  onBack: () => void;
  /** 点击标准列表项的回调（仅 items 模式生效） */
  onItemClick?: (item: NavLayerItem) => void;
}

// ========== 返回箭头图标 ==========
function BackArrowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

// ========== 主组件 ==========

/**
 * 嵌套导航内容区模板 — 支持多层钻取的侧边栏内容区。
 *
 * 与 ModuleSidebarShell（框架模板）分离：本组件仅负责内容区的层级导航逻辑，
 * 直接返回内容 Fragment（返回按钮 + 当前层内容），不包裹滚动容器。
 * 放在 ModuleSidebarShell 的 children 中使用，由 ModuleSidebarShell 的列表区管理滚动和布局。
 *
 * 用法示例：
 * ```tsx
 * <ModuleSidebarShell moduleId="reading" title="三色堇" ...>
 *   <NestedNavList
 *     layers={[
 *       { title: '书库', children: <DirTree /> },           // 根层：自定义目录树
 *       { title: book.title, items: chapterItems },          // 第二层：标准章节列表
 *     ]}
 *     onBack={() => setCurrentBook(null)}
 *     onItemClick={(item) => selectChapter(item.id)}
 *   />
 * </ModuleSidebarShell>
 * ```
 */
export function NestedNavList({ layers, onBack, onItemClick }: NestedNavListProps) {
  if (layers.length === 0) return null;

  const currentLayer = layers[layers.length - 1];
  const hasParent = layers.length > 1;
  const parentTitle = hasParent ? layers[layers.length - 2].title : '';

  // 渲染返回按钮
  const backButton = hasParent ? (
    <button
      onClick={onBack}
      className="w-full text-left px-3 py-2 rounded-xl transition-colors flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/5 text-neutral-500 dark:text-stone-400 mb-1"
    >
      <span className="flex-shrink-0">
        <BackArrowIcon />
      </span>
      <span className="text-sm font-medium truncate">{parentTitle}</span>
    </button>
  ) : null;

  // 渲染当前层内容
  let layerContent: ReactNode;
  if (currentLayer.children !== undefined) {
    // 自定义内容模式
    layerContent = currentLayer.children;
  } else {
    // 标准列表模式
    const items = currentLayer.items || [];
    layerContent = <ItemList items={items} emptyText={currentLayer.emptyText} onItemClick={onItemClick} />;
  }

  return (
    <Fragment>
      {backButton}
      {layerContent}
    </Fragment>
  );
}

// ========== 标准列表渲染（内部组件，用 memo 优化） ==========

function ItemList({
  items,
  emptyText,
  onItemClick,
}: {
  items: NavLayerItem[];
  emptyText?: string;
  onItemClick?: (item: NavLayerItem) => void;
}) {
  const content = useMemo(() => {
    if (items.length === 0) {
      return (
        <div className="flex-1 flex items-center justify-center text-xs text-neutral-400 dark:text-stone-500 py-8">
          {emptyText || '暂无数据'}
        </div>
      );
    }

    return (
      <div className="space-y-0.5">
        {items.map((item) => {
          const button = (
            <button
              key={item.id}
              onClick={() => onItemClick?.(item)}
              disabled={item.disabled}
              className={`w-full text-left px-3 py-2 rounded-xl transition-colors flex items-center gap-2.5 disabled:opacity-50 ${
                item.active
                  ? 'bg-[var(--element-bg)]/10 text-[var(--element-bg)]'
                  : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400'
              }`}
            >
              {item.icon && <span className="flex-shrink-0 opacity-60">{item.icon}</span>}
              <div className="min-w-0 flex-1">
                <div className="text-sm truncate">{item.title}</div>
                {item.subtitle && <div className="text-[11px] opacity-50 mt-0.5">{item.subtitle}</div>}
              </div>
              {item.badge !== undefined && (
                <span className="text-xs opacity-50 flex-shrink-0">{item.badge}</span>
              )}
              {item.active && (
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--element-bg)] flex-shrink-0" />
              )}
            </button>
          );

          // 若提供 contextMenu，用 ContextMenu 包裹
          if (item.contextMenu) {
            return (
              <ContextMenu key={item.id}>
                <ContextMenuTrigger className="w-full">{button}</ContextMenuTrigger>
                <ContextMenuContent>{item.contextMenu}</ContextMenuContent>
              </ContextMenu>
            );
          }
          return button;
        })}
      </div>
    );
  }, [items, emptyText, onItemClick]);

  return content;
}

export default NestedNavList;
