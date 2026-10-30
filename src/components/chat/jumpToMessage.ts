// 虚拟列表里的精确跳转（对齐 deepseek harness 的 scrollToTurn 语义）。
//
// deepseek 的做法：
//   · 只在消息容器上滚（scrollTop），绝不 scrollIntoView（会带着页面一起滚）；
//   · 用真实 DOM 行做锚点，把目标对齐到视口顶部下方 24px；
//   · 点击后立刻把 active turn 设为被点的轮次，即使内容不够滚（短对话全部可见）
//     高亮也会跟着走。
//
// 我们额外要处理“目标还没渲染”的虚拟列表场景：先平滑滚到估算位置，
// 等渲染出来后再按真实 DOM 位置做一次平滑对齐；仍然只操作容器。

const TARGET_INSET_PX = 24;

interface MessageVirtualizer {
  scrollToIndex: (
    index: number,
    opts?: { align?: 'start' | 'center' | 'end' | 'auto'; behavior?: ScrollBehavior },
  ) => void;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 把目标行对齐到容器顶部下方 24px；只改容器 scrollTop。返回是否找到目标。 */
function alignTarget(
  scrollElement: HTMLElement,
  selector: string,
  behavior: ScrollBehavior,
): boolean {
  const target = scrollElement.querySelector<HTMLElement>(selector);
  if (!target) return false;
  const container = scrollElement.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  const delta = rect.top - container.top - TARGET_INSET_PX;
  if (Math.abs(delta) <= 1) return true;
  const max = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
  const top = Math.max(0, Math.min(scrollElement.scrollTop + delta, max));
  scrollElement.scrollTo({ top, behavior });
  return true;
}

export function jumpToMessageIndex(
  virtualizer: MessageVirtualizer,
  scrollElement: HTMLElement | null,
  index: number,
): void {
  if (!scrollElement) return;
  const reduce = prefersReducedMotion();
  const behavior: ScrollBehavior = reduce ? 'auto' : 'smooth';
  const selector = `[data-msg-index="${index}"]`;

  // 短对话 / 目标已在渲染窗口内：直接按真实 DOM 平滑对齐，不经过任何估算。
  if (alignTarget(scrollElement, selector, behavior)) return;

  // 目标还没渲染：先平滑滚到估算位置，等渲染出来后再做一次真实 DOM 对齐。
  virtualizer.scrollToIndex(index, { align: 'start', behavior });

  let finished = false;
  let fallbackTimer: number | undefined;

  const cleanup = () => {
    scrollElement.removeEventListener('scrollend', onScrollEnd);
    if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer);
  };

  const correct = () => {
    if (alignTarget(scrollElement, selector, behavior)) return;
    // 估算偏差大到目标仍未渲染：瞬移一次把它带进渲染窗口，再对齐。
    virtualizer.scrollToIndex(index, { align: 'start', behavior: 'auto' });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      alignTarget(scrollElement, selector, behavior);
    }));
  };

  const onScrollEnd = () => {
    if (finished) return;
    finished = true;
    cleanup();
    correct();
  };

  scrollElement.addEventListener('scrollend', onScrollEnd, { once: true });
  // scrollend 在部分 WebView 版本上不触发，给一个兜底时长。
  fallbackTimer = window.setTimeout(onScrollEnd, reduce ? 40 : 650);
}
