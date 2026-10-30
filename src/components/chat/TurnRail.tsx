// 对话轮次导轨（只实现 deepseek_desktop 的 adaptive / 舒缓模式）。
//
// 设计要点：
// - 每一条 **user 消息** 算一轮；刻度间距固定 22px（不是 10px 的密集梯子），
//   超出可视高度时导轨**自己滚动**，两端渐隐 —— 这就是“舒缓滚动”。
// - 导轨本身用 @tanstack/react-virtual 虚拟化：轮次再多也只渲染可视区附近的刻度。
// - 当前轮按滚动位置自动高亮；点击刻度平滑跳到对应消息。
// - 未激活刻度用中性灰：主窗浅色/深色、浮岛深色都看得见；激活刻度用 accent。
// - 右键刻度弹菜单：跳转 / 标记 / 重点标记 / 取消标记（对齐 dsh 的 turn-marks）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { turnMarks, syncTurnMarks, type TurnMark } from './turnMarks';

export interface TurnRailItem {
  /** 稳定的消息 id：标记按它存，避免消息下标变化导致标记错位。 */
  id: string;
  /** 该轮对应的消息下标（messages 数组里的位置）。 */
  messageIndex: number;
  /** 悬停预览文本（通常是用户这一轮的输入）。 */
  label: string;
}

interface TurnRailProps {
  items: TurnRailItem[];
  /** 当前视口顶部所在的轮次（messageIndex）；null = 不指定。 */
  activeMessageIndex: number | null;
  onJump: (messageIndex: number) => void;
  /** 当前刻度颜色；默认金色。 */
  accent?: string;
  /** 标记作用域（通常是「会话类型:会话 id」）；不同会话的标记互不共享。 */
  markScope?: string;
}

/** 固定 22px 间距：舒适、可瞄准；超出就滚动，不压缩。 */
const PITCH = 22;
/** 悬停预览最长显示的字数。 */
const PREVIEW_CHARS = 160;
/** 右键菜单的近似尺寸（用于贴边夹取）。 */
const MENU_W = 150;
const MENU_H = 160;

export function TurnRail({
  items,
  activeMessageIndex,
  onJump,
  accent = '#e6c35c',
  markScope = 'default',
}: TurnRailProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pointerInsideRef = useRef(false);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  /** 右键菜单：位置 + 被点的轮次。 */
  const [menu, setMenu] = useState<{ x: number; y: number; item: TurnRailItem } | null>(null);
  /** 标记变化时强制重渲染（导轨刻度不多，整体重渲染足够便宜）。 */
  const [, bumpMarks] = useState(0);
  useEffect(() => turnMarks.subscribe(() => bumpMarks((v) => v + 1)), []);
  // 跨窗口同步：首次挂载/切换会话时从后端拉取；事件监听在 store 内单例注册。
  useEffect(() => { syncTurnMarks(markScope); }, [markScope]);

  const activeIndex = useMemo(
    () => (activeMessageIndex == null ? -1 : items.findIndex((it) => it.messageIndex === activeMessageIndex)),
    [items, activeMessageIndex],
  );

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => PITCH,
    overscan: 4,
    getItemKey: (index) => items[index]?.messageIndex ?? index,
  });

  // 当前轮不在导轨可视区时才把它滚进来：用户正拿着导轨时不要抢滚动。
  useEffect(() => {
    if (activeIndex < 0 || pointerInsideRef.current) return;
    const range = virtualizer.range;
    if (!range) return;
    if (activeIndex < range.startIndex || activeIndex > range.endIndex) {
      virtualizer.scrollToIndex(activeIndex, { align: 'auto' });
    }
  }, [activeIndex, virtualizer]);

  // 菜单打开时：点外面 / Esc 关闭。
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.('.turn-rail-menu')) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const jump = useCallback((messageIndex: number) => {
    onJump(messageIndex);
  }, [onJump]);

  const openMenu = useCallback((item: TurnRailItem, x: number, y: number) => {
    setMenu({
      x: Math.max(8, Math.min(x, window.innerWidth - MENU_W - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - MENU_H - 8)),
      item,
    });
  }, []);

  if (items.length < 2) return null;

  const virtualItems = virtualizer.getVirtualItems();
  const scrollOffset = virtualizer.scrollOffset ?? 0;
  const viewHeight = virtualizer.scrollRect?.height ?? 0;
  const totalSize = virtualizer.getTotalSize();
  const canScroll = totalSize > viewHeight + 1;
  const atTop = scrollOffset <= 1;
  const atBottom = scrollOffset >= totalSize - viewHeight - 1;
  const fade = 'linear-gradient(to bottom, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%)';
  const fadeBottom = 'linear-gradient(to bottom, #000 0, #000 calc(100% - 12px), transparent 100%)';
  const fadeTop = 'linear-gradient(to bottom, transparent 0, #000 12px, #000 100%)';
  const maskImage = !canScroll ? undefined : atTop ? fadeBottom : atBottom ? fadeTop : fade;
  const hoverItem = hoverIndex == null ? null : items[hoverIndex];
  const hoverVi = hoverIndex == null ? null : virtualItems.find((vi) => vi.index === hoverIndex);
  const hoverTop = hoverVi
    ? Math.max(18, Math.min(Math.max(18, viewHeight - 18), hoverVi.start - scrollOffset + PITCH / 2))
    : 18;

  return (
    <div
      className="turn-rail"
      style={{ color: 'inherit' }}
      onPointerEnter={() => { pointerInsideRef.current = true; }}
      onPointerLeave={() => {
        pointerInsideRef.current = false;
        setHoverIndex(null);
      }}
    >
      <div
        ref={scrollerRef}
        className="turn-rail-scroller"
        style={{
          height: '100%',
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          maskImage,
          WebkitMaskImage: maskImage,
        }}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualItems.map((vi) => {
            const item = items[vi.index];
            if (!item) return null;
            const active = vi.index === activeIndex;
            const hovered = vi.index === hoverIndex;
            const mark: TurnMark | undefined = turnMarks.get(markScope, item.id);
            return (
              <button
                key={vi.key}
                type="button"
                className="turn-rail-mark"
                aria-label={`第 ${vi.index + 1} 轮${mark ? mark === 'star' ? '（重点标记）' : '（已标记）' : ''}：${item.label.slice(0, 40)}`}
                aria-current={active ? 'true' : undefined}
                data-turn-mark={mark}
                style={{ transform: `translateY(${vi.start}px)` }}
                onMouseEnter={() => setHoverIndex(vi.index)}
                onMouseLeave={() => setHoverIndex((cur) => (cur === vi.index ? null : cur))}
                onFocus={() => setHoverIndex(vi.index)}
                onBlur={() => setHoverIndex((cur) => (cur === vi.index ? null : cur))}
                onClick={() => jump(item.messageIndex)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openMenu(item, event.clientX, event.clientY);
                }}
                onKeyDown={(event) => {
                  // 键盘版右键菜单：ContextMenu 键或 Shift+F10，锚在刻度右下角。
                  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  openMenu(item, rect.right, rect.bottom);
                }}
              >
                <span
                  aria-hidden
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: '50%',
                    width: active ? 20 : hovered ? 17 : 14,
                    height: 2,
                    borderRadius: 2,
                    background: active ? accent : hovered ? 'rgba(128,128,128,0.85)' : 'rgba(128,128,128,0.5)',
                    transform: 'translateY(-50%)',
                    transition: 'width 140ms ease, opacity 140ms ease, background-color 140ms ease',
                    boxShadow: active ? `0 0 6px ${accent}66` : undefined,
                  }}
                />
                {mark && (
                  <span
                    aria-hidden
                    className={`turn-rail-glyph${mark === 'star' ? ' is-star' : ''}`}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {hoverItem && (
        <div
          className="turn-rail-preview"
          style={{ top: hoverTop }}
          aria-hidden
        >
          {hoverItem.label.length > PREVIEW_CHARS
            ? `${hoverItem.label.slice(0, PREVIEW_CHARS)}…`
            : hoverItem.label || `第 ${(hoverIndex ?? 0) + 1} 轮`}
        </div>
      )}

      {menu && createPortal(
        <div
          className="turn-rail-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button type="button" role="menuitem" onClick={() => { jump(menu.item.messageIndex); setMenu(null); }}>
            跳转
          </button>
          <button type="button" role="menuitem" onClick={() => { turnMarks.set(markScope, menu.item.id, 'mark'); setMenu(null); }}>
            标记
          </button>
          <button type="button" role="menuitem" onClick={() => { turnMarks.set(markScope, menu.item.id, 'star'); setMenu(null); }}>
            重点标记
          </button>
          <button type="button" role="menuitem" onClick={() => { turnMarks.set(markScope, menu.item.id, null); setMenu(null); }}>
            取消标记
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
