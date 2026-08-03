/**
 * useDrawerSwipe — 内容区「左 → 右」横滑打开全局抽屉（§7.4.2 双触发之手势触发）。
 *
 * 需求：在中央内容区（不限边缘）从左往右滑，效果等同点击 AppBar 左上角 ☰ 按钮。
 *
 * 设计要点（移动端手势与滚动共存的关键）：
 *   1. 用原生 Pointer Events 挂在内容容器上，避免与 framer-motion 的页面转场 drag 打架。
 *   2. 方向判定一次性锁定：首次超过 SLOP 时比较 |dx| 与 |dy|，
 *      纵向优先 → 判为滚动，本次手势直接放弃（不再拦截），保证列表滚动手感不受影响。
 *   3. 只认「向右」：dx 必须为正，避免与返回/左滑手势冲突。
 *   4. 排除可横向滚动的祖先（如横向列表、代码块、输入框内选择），
 *      命中则不接管，防止误触。
 *   5. 阈值：位移 > OPEN_DX 或（位移 > MIN_DX 且速度 > OPEN_V）→ 打开抽屉。
 *   6. 抽屉已打开 / BottomSheet 打开时不响应。
 *
 * 桌面零影响：本 hook 仅被 MobileApp 使用。
 */

import { useEffect, type RefObject } from 'react';
import { useNavStore } from '../stores/navStore';

/** 方向锁定判定阈值（px）：超过它才决定这次手势是横滑还是纵滚 */
const SLOP = 8;
/** 无视速度的绝对打开位移（px）——调小提高灵敏度 */
const OPEN_DX = 50;
/** 配合速度判定的最小位移（px） */
const MIN_DX = 24;
/** 快速轻扫速度阈值（px/s）——调低更易触发 */
const OPEN_V = 400;

/** 元素或其祖先是否存在可横向滚动区域（命中则让位，不接管手势） */
function hasHorizontallyScrollableAncestor(start: EventTarget | null, stop: HTMLElement): boolean {
  let el = start instanceof HTMLElement ? start : null;
  while (el && el !== stop) {
    // 可横向滚动：内容宽度溢出 + overflow-x 允许滚动
    if (el.scrollWidth > el.clientWidth + 1) {
      const ox = getComputedStyle(el).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
    // 输入类控件内的光标拖动不应被劫持
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) return true;
    // 显式退出标记：需要自己处理横滑的组件加 data-no-drawer-swipe
    if (el.dataset.noDrawerSwipe !== undefined) return true;
    el = el.parentElement;
  }
  return false;
}

/**
 * @param ref 内容容器 ref（手势监听挂载点）
 * @param enabled 是否启用（抽屉已开时应传 false）
 */
export function useDrawerSwipe(ref: RefObject<HTMLElement | null>, enabled = true) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;

    let tracking = false;
    /** null = 尚未锁定方向；'x' = 横滑接管；'y' = 纵滚放弃 */
    let axis: 'x' | 'y' | null = null;
    let startX = 0;
    let startY = 0;
    let startT = 0;
    let pointerId = -1;

    const reset = () => {
      tracking = false;
      axis = null;
      pointerId = -1;
    };

    const onPointerDown = (e: PointerEvent) => {
      // 仅单指触摸 / 笔；鼠标不参与（桌面端本就不挂载）
      if (e.pointerType === 'mouse') return;
      if (!e.isPrimary) return;
      const s = useNavStore.getState();
      if (s.drawerOpen || s.bottomSheetOpen) return;
      if (hasHorizontallyScrollableAncestor(e.target, el)) return;

      tracking = true;
      axis = null;
      startX = e.clientX;
      startY = e.clientY;
      startT = e.timeStamp;
      pointerId = e.pointerId;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!tracking || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      // 方向锁定：只在首次越过 SLOP 时判定一次
      if (axis === null) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        if (Math.abs(dy) >= Math.abs(dx)) {
          // 纵向占优 → 交给正常滚动，本次手势不再处理
          axis = 'y';
          tracking = false;
          return;
        }
        if (dx <= 0) {
          // 向左滑不属于「打开抽屉」，放弃
          axis = 'y';
          tracking = false;
          return;
        }
        axis = 'x';
      }

      if (axis !== 'x') return;

      const dt = Math.max(1, e.timeStamp - startT);
      const v = (dx / dt) * 1000; // px/s

      if (dx > OPEN_DX || (dx > MIN_DX && v > OPEN_V)) {
        useNavStore.getState().setDrawerOpen(true);
        reset();
      }
    };

    const onPointerEnd = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      reset();
    };

    // passive: true —— 全程不 preventDefault（纵滚交还浏览器），保证滚动性能
    el.addEventListener('pointerdown', onPointerDown, { passive: true });
    el.addEventListener('pointermove', onPointerMove, { passive: true });
    el.addEventListener('pointerup', onPointerEnd, { passive: true });
    el.addEventListener('pointercancel', onPointerEnd, { passive: true });

    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerEnd);
      el.removeEventListener('pointercancel', onPointerEnd);
    };
  }, [ref, enabled]);
}
