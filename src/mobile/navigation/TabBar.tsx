/**
 * TabBar — 底部 4 Tab 导航（§7.5）。
 *
 * 规格：
 *   高 56dp + var(--safe-bottom)，背景 --nav-primary-bg + 顶部 1px border + backdrop-blur
 *   4 项等分：中转站(Send) / AI对话(MessageSquare) / 发现(Compass) / 我的(User)
 *   图标 24dp，标签 11px 常驻
 *   激活态：图标加粗 + --element-bg 色 + 上方 3dp 指示条（framer-motion layoutId 共享位移动画）
 *   点击反馈：120ms scale(0.94)
 */

import { Send, MessageSquare, Compass, User, type LucideIcon } from 'lucide-react';
import { motion } from 'framer-motion';
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

  return (
    <nav
      className="flex shrink-0 bg-[var(--nav-primary-bg)] border-t border-[var(--border)] backdrop-blur-md"
      style={{ height: 'var(--tabbar-total)', paddingBottom: 'var(--safe-bottom)' }}
      aria-label="主导航"
    >
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
            {/* 激活指示条 · 3dp 圆角条，layoutId 让其在 Tab 间平滑滑动 */}
            {active && (
              <motion.span
                layoutId="tab-indicator"
                className="absolute top-0 left-1/2 -translate-x-1/2 rounded-full bg-[var(--element-bg)]"
                style={{ width: '32px', height: '3px' }}
                transition={{ type: 'spring', damping: 28, stiffness: 380 }}
              />
            )}
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
