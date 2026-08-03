/**
 * SafeArea — env(safe-area-inset-*) 封装（§7.4.2）。
 *
 * 用法：<SafeArea top bottom><Content /></SafeArea>
 * 按需注入 padding，不用的方向不添加（避免不必要的间距）。
 */

import type { CSSProperties, ReactNode } from 'react';

interface SafeAreaProps {
  children: ReactNode;
  /** 注入 padding-top: var(--safe-top) — 状态栏下方 */
  top?: boolean;
  /** 注入 padding-bottom: var(--safe-bottom) — 手势导航条上方 */
  bottom?: boolean;
  /** 注入 padding-left: var(--safe-left) — 横屏挖孔屏 */
  left?: boolean;
  /** 注入 padding-right: var(--safe-right) — 横屏挖孔屏 */
  right?: boolean;
  className?: string;
}

export function SafeArea({ children, top, bottom, left, right, className = '' }: SafeAreaProps) {
  const style: CSSProperties = {
    paddingTop: top ? 'var(--safe-top)' : undefined,
    paddingBottom: bottom ? 'var(--safe-bottom)' : undefined,
    paddingLeft: left ? 'var(--safe-left)' : undefined,
    paddingRight: right ? 'var(--safe-right)' : undefined,
  };
  return (
    <div className={className} style={style}>
      {children}
    </div>
  );
}
