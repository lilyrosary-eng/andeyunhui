/**
 * AppBar — 移动端顶部应用栏（§7.6）。
 *
 * 规格：
 *   高度 56dp + var(--safe-top)（背景延伸至状态栏下方）
 *   左：☰ 抽屉按钮（一级页）/ ← 返回（二级页），48×48dp
 *   中：页面标题，--m-text-headline，左对齐
 *   右：最多 2 个图标按钮，各 48×48dp
 *   滚动时常驻（不做折叠大标题）
 *   背景 --nav-primary-bg + backdrop-blur（琉璃质感，§7.1 三处静态层之一）
 */

import type { ReactNode } from 'react';
import { Menu, ChevronLeft } from 'lucide-react';

export interface AppBarAction {
  icon: ReactNode;
  onClick: () => void;
  /** aria-label for accessibility */
  label?: string;
}

interface AppBarProps {
  title: string;
  /** 二级页传此回调 → 显示 ← 返回按钮；不传 → 显示 ☰ 抽屉按钮 */
  onBack?: () => void;
  /** 一级页 ☰ 抽屉按钮回调 */
  onMenu?: () => void;
  /** 右侧操作按钮（最多 2 个） */
  actions?: AppBarAction[];
}

export function AppBar({ title, onBack, onMenu, actions = [] }: AppBarProps) {
  const isSecondary = !!onBack;
  const leftAction = isSecondary ? onBack : onMenu;

  return (
    <header
      className="flex items-center shrink-0 bg-[var(--nav-primary-bg)] border-b border-[var(--border)] backdrop-blur-md"
      style={{
        height: 'calc(var(--appbar-h) + var(--safe-top))',
        paddingTop: 'var(--safe-top)',
        paddingLeft: 'var(--safe-left)',
        paddingRight: 'var(--safe-right)',
      }}
    >
      {/* 左侧：☰ 或 ←，48×48dp 触控区 */}
      {leftAction && (
        <button
          type="button"
          onClick={leftAction}
          aria-label={isSecondary ? '返回' : '菜单'}
          className="flex items-center justify-center shrink-0 text-[var(--foreground)] active:scale-95 transition-transform"
          style={{ width: 'var(--touch-min)', height: 'var(--touch-min)' }}
        >
          {isSecondary ? <ChevronLeft size={24} /> : <Menu size={24} />}
        </button>
      )}

      {/* 中间：标题，左对齐（不居中——窄屏居中易与两侧按钮挤压） */}
      <h1
        className="flex-1 truncate font-semibold text-[var(--foreground)] text-left"
        style={{ fontSize: 'var(--m-text-headline)', lineHeight: 'var(--appbar-h)' }}
      >
        {title}
      </h1>

      {/* 右侧：最多 2 个操作按钮 */}
      {actions.slice(0, 2).map((action, i) => (
        <button
          key={i}
          type="button"
          onClick={action.onClick}
          aria-label={action.label}
          className="flex items-center justify-center shrink-0 text-[var(--foreground)] active:scale-95 transition-transform"
          style={{ width: 'var(--touch-min)', height: 'var(--touch-min)' }}
        >
          {action.icon}
        </button>
      ))}
    </header>
  );
}
