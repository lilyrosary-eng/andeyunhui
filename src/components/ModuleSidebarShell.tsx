import { type ReactNode, useState, useEffect, useCallback, useRef } from 'react';
import { Settings, PanelLeftClose, PanelLeftOpen, Home } from 'lucide-react';
import { CollapsibleSearch } from '@/components/CollapsibleSearch';

const SIDEBAR_COLLAPSE_KEY = 'module_sidebar_collapsed';
const SIDEBAR_EXPANDED_WIDTH = 260;
const SIDEBAR_COLLAPSED_WIDTH = 48;
const COLLAPSE_FADE_MS = 150;
const COLLAPSE_WIDTH_MS = 300;

export interface ModuleSidebarShellProps {
  moduleId: string;
  icon: ReactNode;
  title: string;
  onOpenModuleSettings?: () => void;
  moduleSettingsLabel?: string;
  footerExtra?: ReactNode;
  primaryAction?: { label: string; onClick: () => void };
  secondaryActions?: Array<{ icon: ReactNode; label: string; onClick: () => void }>;
  /** 搜索框 — 传入后自动在标题下方渲染 CollapsibleSearch */
  searchQuery?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  /** 标题下方的返回按钮（如侧边栏内的「返回茑萝」），使用 UI 库的 Home 图标 */
  backAction?: { label?: string; onClick: () => void };
  children: ReactNode;
}

export function ModuleSidebarShell({
  moduleId,
  icon,
  title,
  onOpenModuleSettings,
  moduleSettingsLabel = '模块设置',
  footerExtra,
  primaryAction,
  secondaryActions,
  searchQuery,
  onSearchChange,
  searchPlaceholder,
  backAction,
  children,
}: ModuleSidebarShellProps) {
  const storageKey = `${SIDEBAR_COLLAPSE_KEY}_${moduleId}`;

  // 持久化状态
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem(storageKey) === 'true';
  });
  const [contentVisible, setContentVisible] = useState(() => {
    return localStorage.getItem(storageKey) !== 'true';
  });

  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  // 清理定时器
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const toggleCollapse = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    if (collapsed) {
      // 展开：宽度先展开，内容再出现（"壳打开→内容出来"）
      setCollapsed(false);
      localStorage.setItem(storageKey, 'false');
      timerRef.current = setTimeout(() => {
        setContentVisible(true);
      }, COLLAPSE_WIDTH_MS);
    } else {
      // 收起：内容先消失，宽度再收缩（"内容收走→壳合上"）
      setContentVisible(false);
      timerRef.current = setTimeout(() => {
        setCollapsed(true);
        localStorage.setItem(storageKey, 'true');
      }, COLLAPSE_FADE_MS);
    }
  }, [collapsed, storageKey]);

  return (
    <div
      className="h-full flex-shrink-0 nav-secondary-bg backdrop-blur-md border-r border-white/80 dark:border-stone-700/50 flex flex-col slide-in-left overflow-hidden"
      style={{
        width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH,
        transition: `width ${COLLAPSE_WIDTH_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`,
      }}
    >
      {/* 收起态：窄条，仅显示展开按钮 */}
      {collapsed ? (
        <div className="h-full flex flex-col items-center justify-between py-3">
          {/* 顶部：模块图标（缩小版，视觉锚点） */}
          <div className="text-neutral-500 dark:text-stone-400 scale-75 origin-top">
            {icon}
          </div>
          {/* 底部：展开按钮 */}
          <button
            onClick={toggleCollapse}
            title="展开侧边栏"
            className="btn-press w-9 h-9 flex items-center justify-center rounded-xl text-neutral-400 dark:text-stone-500 hover:text-[var(--element-color-raw)] hover:bg-[var(--element-muted)] transition-colors"
          >
            <PanelLeftOpen size={18} />
          </button>
        </div>
      ) : (
        <div
          className="flex-1 flex flex-col min-h-0"
          style={{
            opacity: contentVisible ? 1 : 0,
            transform: contentVisible ? 'scale(1)' : 'scale(0.95)',
            transition: `opacity ${COLLAPSE_FADE_MS}ms ease, transform ${COLLAPSE_FADE_MS}ms ease`,
          }}
        >
          {/* 顶部标题区：图标 + 标题 */}
          <div className="shrink-0 flex items-center gap-2 px-4 pt-4 pb-3">
            {icon}
            <span className="font-bold text-lg tracking-tight text-neutral-800 dark:text-stone-100">{title}</span>
          </div>

          {/* 返回按钮（可选）：标题下方、靠左，小房子图标 */}
          {backAction && (
            <div className="shrink-0 px-3 pb-2">
              <button
                onClick={backAction.onClick}
                title="返回茑萝"
                className="btn-press flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                <Home size={15} />
                {backAction.label && <span>{backAction.label}</span>}
              </button>
            </div>
          )}

          {/* 搜索框（可选） */}
          {searchQuery !== undefined && onSearchChange && (
            <div className="shrink-0 px-4 pb-2">
              <CollapsibleSearch
                value={searchQuery}
                onChange={onSearchChange}
                placeholder={searchPlaceholder || `搜索${title}...`}
              />
            </div>
          )}

          {/* 主操作按钮（可选） */}
          {primaryAction && (
            <div className="shrink-0 px-4 pb-2">
              <button
                onClick={primaryAction.onClick}
                className="btn-press w-full element-muted hover:element-hover transition-all py-2.5 rounded-xl font-medium"
              >
                {primaryAction.label}
              </button>
            </div>
          )}

          {/* 二级操作按钮组（可选） */}
          {secondaryActions && secondaryActions.length > 0 && (
            <div className="shrink-0 px-4 pb-2 flex gap-2">
              {secondaryActions.map((action, idx) => (
                <button
                  key={idx}
                  onClick={action.onClick}
                  className="btn-press flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg bg-neutral-100 dark:bg-stone-700/50 text-xs text-neutral-600 dark:text-stone-300 hover:bg-neutral-200 dark:hover:bg-stone-700 transition-colors"
                >
                  {action.icon}
                  {action.label}
                </button>
              ))}
            </div>
          )}

          {/* 列表内容区 */}
          <div className="flex-1 overflow-y-auto px-4 pb-2 flex flex-col">
            {children}
          </div>

          {/* 底部栏：收起按钮 + 设置齿轮 */}
          <div className="shrink-0 border-t border-neutral-200/30 dark:border-stone-700/30 px-4 py-2.5 flex items-center gap-1">
            <button
              onClick={toggleCollapse}
              title="收起侧边栏"
              className="btn-press w-9 h-9 flex items-center justify-center rounded-xl text-neutral-400 dark:text-stone-500 hover:text-[var(--element-color-raw)] hover:bg-[var(--element-muted)] transition-colors"
            >
              <PanelLeftClose size={18} />
            </button>
            {onOpenModuleSettings && (
              <button
                onClick={onOpenModuleSettings}
                title={moduleSettingsLabel}
                className="btn-press w-9 h-9 flex items-center justify-center rounded-xl text-neutral-400 dark:text-stone-500 hover:text-[var(--element-color-raw)] hover:bg-[var(--element-muted)] transition-colors"
              >
                <Settings size={18} />
              </button>
            )}
            {footerExtra}
          </div>
        </div>
      )}
    </div>
  );
}

export default ModuleSidebarShell;