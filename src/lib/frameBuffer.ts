/**
 * 帧缓冲队列 — 渲染隔离核心工具
 *
 * 将高频数据推送（如扫描进度、chunk 推送）批量合并到单帧内消费，
 * 通过 requestAnimationFrame 确保一帧只触发一次 React setState，
 * 避免回流重绘风暴，让 UI 渲染优先级绝对高于业务逻辑。
 *
 * 使用方式：
 *   const fb = useRef(createFrameBuffer<T>((items) => setState(prev => [...prev, ...items])));
 *   fb.current.push(item);  // 在事件回调中调用
 */

export interface FrameBuffer<T> {
  /** 推入一个元素到缓冲区，自动调度 rAF 批量消费 */
  push: (item: T) => void;
  /** 立即清空缓冲区并消费（用于组件卸载前） */
  flush: () => void;
  /** 销毁缓冲区，取消待处理的 rAF */
  destroy: () => void;
}

export function createFrameBuffer<T>(onFlush: (items: T[]) => void): FrameBuffer<T> {
  let buffer: T[] = [];
  let scheduled = false;
  let rafId: number | null = null;

  const flush = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    scheduled = false;
    if (buffer.length === 0) return;
    const items = buffer;
    buffer = [];
    onFlush(items);
  };

  const scheduleFlush = () => {
    if (scheduled) return;
    scheduled = true;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      flush();
    });
  };

  return {
    push(item: T) {
      buffer.push(item);
      scheduleFlush();
    },
    flush,
    destroy() {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      buffer = [];
      scheduled = false;
    },
  };
}