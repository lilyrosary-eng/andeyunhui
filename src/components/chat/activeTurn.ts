// 当前阅读轮次：按“阅读线”（视口顶部下方约 96px / 20%）判断，而不是按第一个可见项。
// 对齐 deepseek harness 的 readVisibleTurn：长回复时，第一个可见项可能还是上一轮
// 的 assistant 尾巴，直接取它会显得高亮提前。
import type { TurnRailItem } from './TurnRail';

interface TurnVirtualizer {
  measurementsCache: Array<{ start: number }>;
  scrollOffset?: number | null;
  scrollRect?: { height: number } | null;
  range?: { startIndex: number } | null;
}

export function activeTurnMessageIndex(
  virtualizer: TurnVirtualizer,
  items: TurnRailItem[],
): number | null {
  const offset = virtualizer.scrollOffset ?? 0;
  const height = virtualizer.scrollRect?.height ?? 0;
  const line = offset + Math.min(96, height * 0.2);

  let active: number | null = null;
  for (const item of items) {
    const measured = virtualizer.measurementsCache[item.messageIndex];
    if (!measured) continue;
    if (measured.start <= line) active = item.messageIndex;
    else break;
  }
  if (active === null) {
    const start = virtualizer.range?.startIndex ?? 0;
    active = items.find((item) => item.messageIndex >= start)?.messageIndex ?? null;
  }
  return active;
}
