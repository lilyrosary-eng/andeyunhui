/**
 * TabBar — 底部 4 Tab 导航（§7.5）。
 *
 * 规格：
 *   高 56dp + var(--safe-bottom)，背景 --nav-primary-bg + 顶部 1px border + backdrop-blur
 *   4 项等分：中转站(Send) / AI对话(MessageSquare) / 发现(Compass) / 我的(User)
 *   图标 24dp，标签 11px 常驻
 *   激活态：图标加粗 + --element-bg 色 + 上方 3dp 指示条
 *   点击反馈：120ms scale(0.94)
 *
 * 指示条实现：nav 内单条共享指示条（32x3dp 圆角条），位置按 activeIndex 用
 * left: calc(12.5% + index*25%) 精确定位到当前 Tab 中心，transition: left 做平滑滑动。
 * 位置完全由 CSS 百分比计算，不依赖 framer-motion 的 layoutId（浏览器预览时 layoutId
 * 会把指示条重新插值到错误位置造成「绿条偏移」），因此既有滑动动画又保证对齐。
 */

import { Send, MessageSquare, Compass, User, type LucideIcon } from 'lucide-react';
import { useNavStore, type TabId } from '../stores/navStore';

interface TabDef {
  id: TabId;
  label: string;
  icon: LucideIcon;
}

const TABS: TabDef[] = [
  { id: 'transfer', label: '中转站', icon: Send },
  { id: 'chat', label: 'AI对话', icon: MessageSquare },
  { id: 'discover', label: '发现', icon: Compass },
  { id: 'profile', label: '我的', icon: User },
];

export function TabBar() {
  const activeTab = useNavStore((s) => s.activeTab);
  const switchTab = useNavStore((s) => s.switchTab);
  const activeIndex = TABS.findIndex((t) => t.id === activeTab);

  return (
    <nav
      className="relative flex shrink-0 bg-[var(--nav-primary-bg)] border-t border-[var(--border)] backdrop-blur-md"
      style={{ height: 'var(--tabbar-total)', paddingBottom: 'var(--safe-bottom)' }}
      aria-label="主导航"
    >
      {/* 共享激活指示条：left 按 activeIndex 精确百分比定位，transition:left 平滑滑动。
          left: calc(12.5% + index*25%) = 每 Tab 中心（4 等分，各占 25%） */}
      <span
        aria-hidden
        className="absolute top-0 z-10 -translate-x-1/2 rounded-full bg-[var(--element-bg)] pointer-events-none"
        style={{
          width: '32px',
          height: '3px',
          left: `calc(12.5% + ${activeIndex} * 25%)`,
          transition: 'left 240ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      />
      {TABS.map((tab) => {
        const active = activeTab === tab.id;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => switchTab(tab.id)}
            className="relative flex-1 flex flex-col items-center justify-center gap-1 active:scale-[0.94] transition-transform duration-[120ms]"
            style={{ height: 'var(--tabbar-h)' }}
            aria-label={tab.label}
            aria-current={active ? 'page' : undefined}
          >
            <Icon
              size={24}
              strokeWidth={active ? 2.4 : 2}
              className={active ? 'text-[var(--element-bg)]' : 'text-[var(--muted-foreground)]'}
            />
            <span
              className={active ? 'text-[var(--element-bg)]' : 'text-[var(--muted-foreground)]'}
              style={{ fontSize: 'var(--m-text-overline)' }}
            >
              {tab.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
