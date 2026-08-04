/**
 * NavStack — 每 Tab 独立导航栈渲染器（§7.5.2）。
 *
 * 职责：
 *   - 渲染当前 Tab 栈顶屏（render()）
 *   - framer-motion 页面转场：push 时左滑进入，pop 时右滑返回
 *   - 切换 Tab 时不做转场（直接淡入），保留各 Tab 滚动位置（通过 key 触发独立 DOM）
 *
 * 性能：AnimatePresence mode="wait" 确保旧屏退场后再渲染新屏，避免双屏同时布局。
 */

import { useEffect, useRef, type RefObject } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavStore, selectCurrentScreen, selectStackDepth } from '../stores/navStore';

interface NavStackProps {
  /**
   * 外部可选 ref，指向滚动容器本身。
   * MobileApp 用它挂载「内容区右滑打开抽屉」手势（useDrawerSwipe）。
   */
  containerRef?: RefObject<HTMLDivElement>;
}

export function NavStack({ containerRef }: NavStackProps = {}) {
  const activeTab = useNavStore((s) => s.activeTab);
  const current = useNavStore(selectCurrentScreen);
  const depth = useNavStore(selectStackDepth);
  const innerRef = useRef<HTMLDivElement>(null);
  // 外部传入则复用同一个容器 ref，避免多包一层 DOM
  const scrollRef = containerRef ?? innerRef;

  // 栈深变化（push/pop）或 Tab 切换时，滚动位置归零
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [activeTab, depth, current?.id]);

  if (!current) {
    // 初始化前的空态（initRoots 未调用），渲染空白避免崩溃
    return <div ref={scrollRef} className="flex-1 overflow-y-auto" />;
  }

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto overscroll-contain"
      // touch-action: pan-y：纵向滚动交给浏览器；横向手势留给 useDrawerSwipe（开抽屉）。
      // 缺省 touch-action:auto 时浏览器可能吞掉 pointermove，导致真机左滑不生效。
      style={{ touchAction: 'pan-y' }}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={current.id}
          initial={{ x: 24, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: -24, opacity: 0 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        >
          {current.render()}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
