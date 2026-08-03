/**
 * BottomSheet — 移动端底部抽屉（§7.9.1）。
 *
 * 规格：
 *   上两角圆角 20dp（--m-radius-sheet），顶部拖拽指示条 4×32dp
 *   最大高度 60vh，项高 56dp（破坏性项与上文 8dp 间隔）
 *   关闭方式：① 下滑手势 ② 点遮罩 ③ Android 返回键（由 MobileApp 统一拦截）
 *   framer-motion 实现入场/出场动画 + 下滑跟手
 *
 * 设计依据：ANDROID-V1-HANDOFF §7.9.1。
 * 用于替代桌面端的右键上下文菜单/下拉浮层。
 */

import { type ReactNode, useEffect, useRef } from 'react';
import { motion, type PanInfo, AnimatePresence } from 'framer-motion';

export interface BottomSheetItem {
  /** 主文案 */
  label: string;
  /** 可选副文案 / 辅助说明 */
  description?: string;
  /** 可选图标（左侧） */
  icon?: ReactNode;
  /** 点击回调；不传则视为不可点（展示型） */
  onClick?: () => void;
  /** 破坏性操作（删除/退出）→ 末位 + 8dp 间隔 + --destructive 文字色 */
  destructive?: boolean;
  /** 是否禁用 */
  disabled?: boolean;
}

interface BottomSheetProps {
  /** 是否展开 */
  open: boolean;
  /** 关闭回调（下滑/遮罩点击/返回键触发） */
  onClose: () => void;
  /** 顶部标题（可选） */
  title?: string;
  /** 菜单项列表；为空时可只放 children */
  items?: BottomSheetItem[];
  /** 自定义内容（替代 items 用） */
  children?: ReactNode;
}

export function BottomSheet({ open, onClose, title, items = [], children }: BottomSheetProps) {
  // 防止 body 滚动穿透
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // 下滑到阈值则关闭
  const handleDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > 120 || info.velocity.y > 600) {
      onClose();
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center"
          role="dialog"
          aria-modal="true"
        >
          {/* 遮罩层 — 点击关闭 */}
          <motion.div
            className="absolute inset-0 bg-black/40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />

          {/* Sheet 主体 */}
          <motion.div
            className="relative w-full bg-[var(--background)] shadow-float flex flex-col"
            style={{
              borderTopLeftRadius: 'var(--m-radius-sheet)',
              borderTopRightRadius: 'var(--m-radius-sheet)',
              maxHeight: '60vh',
              paddingBottom: 'var(--safe-bottom)',
            }}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 320 }}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.4 }}
            onDragEnd={handleDragEnd}
          >
            {/* 顶部拖拽指示条 4×32dp */}
            <div className="flex justify-center pt-3 pb-2 shrink-0 cursor-grab active:cursor-grabbing">
              <div
                className="bg-[var(--muted-foreground)]/40 rounded-full"
                style={{ width: '32px', height: '4px' }}
              />
            </div>

            {/* 标题 */}
            {title && (
              <h2
                className="px-4 pb-2 font-semibold text-[var(--foreground)] shrink-0"
                style={{ fontSize: 'var(--m-text-headline)' }}
              >
                {title}
              </h2>
            )}

            {/* 内容区 — 可滚动 */}
            <div className="overflow-y-auto overscroll-contain">
              {children}
              {items.map((item, i) => {
                // 破坏性项与前一项间隔 8dp
                const prevDestructive = i > 0 && items[i - 1].destructive;
                const spacer = item.destructive || prevDestructive ? 8 : 0;
                return (
                  <button
                    key={i}
                    type="button"
                    disabled={item.disabled}
                    onClick={item.onClick}
                    className="flex w-full items-center gap-3 px-4 text-left active:bg-[var(--muted)]/60 transition-colors disabled:opacity-50"
                    style={{
                      height: '56px',
                      marginTop: spacer ? `${spacer}px` : undefined,
                      borderTop: i === 0 && !title ? '1px solid var(--border)' : undefined,
                      borderBottom: '1px solid var(--border)',
                    }}
                  >
                    {item.icon && (
                      <span
                        className={item.destructive ? 'text-[var(--destructive)]' : 'text-[var(--foreground)]'}
                        style={{ width: '24px', display: 'flex', justifyContent: 'center' }}
                      >
                        {item.icon}
                      </span>
                    )}
                    <span className="flex-1 min-w-0">
                      <span
                        className={`block truncate ${item.destructive ? 'text-[var(--destructive)]' : 'text-[var(--foreground)]'}`}
                        style={{ fontSize: 'var(--m-text-label)' }}
                      >
                        {item.label}
                      </span>
                      {item.description && (
                        <span
                          className="block truncate text-[var(--muted-foreground)]"
                          style={{ fontSize: 'var(--m-text-caption)' }}
                        >
                          {item.description}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
