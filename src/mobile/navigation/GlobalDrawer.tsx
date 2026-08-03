/**
 * GlobalDrawer — 左侧全局抽屉（§7.4.2 / §7.7）。
 *
 * 规格：
 *   宽 min(84vw, 320px)，从左缘滑出
 *   framer-motion drag + dragConstraints 实现跟手 + 惯性吸附
 *   双触发：左缘手势拖出（🔒 L4，后续实现）+ AppBar ☰ 按钮（本组件只负责打开后渲染）
 *   遮罩层点击关闭
 *   下滑/右滑手势关闭
 */

import type { ReactNode } from 'react';
import { motion, AnimatePresence, type PanInfo } from 'framer-motion';
import { useNavStore } from '../stores/navStore';

interface GlobalDrawerProps {
  /** 抽屉内容（导航项、用户信息等） */
  children: ReactNode;
}

export function GlobalDrawer({ children }: GlobalDrawerProps) {
  const open = useNavStore((s) => s.drawerOpen);
  const setOpen = useNavStore((s) => s.setDrawerOpen);

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    // 左滑超过 100px 或速度足够 → 关闭
    if (info.offset.x < -100 || info.velocity.x < -600) {
      setOpen(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-40" aria-modal="true" role="dialog">
          {/* 遮罩层 */}
          <motion.div
            className="absolute inset-0 bg-black/40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setOpen(false)}
          />

          {/* 抽屉主体 */}
          <motion.aside
            className="absolute top-0 bottom-0 left-0 bg-[var(--background)] shadow-float flex flex-col overflow-hidden"
            style={{
              width: 'var(--drawer-w)',
              paddingLeft: 'var(--safe-left)',
              paddingRight: 'var(--safe-right)',
              paddingTop: 'var(--safe-top)',
              paddingBottom: 'var(--safe-bottom)',
            }}
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 320 }}
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={{ left: 0.4, right: 0 }}
            onDragEnd={handleDragEnd}
          >
            {children}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}
