import { type ReactNode } from 'react';

export interface SecondaryNavShellProps {
  children: ReactNode;
}

/** 二级导航外壳 — 列表区域框架容器，用于包裹模块的列表内容 */
export function SecondaryNavShell({ children }: SecondaryNavShellProps) {
  return (
    <div className="flex-1 overflow-y-auto pr-1 space-y-3 scrollbar-hide">
      {children}
    </div>
  );
}

export default SecondaryNavShell;