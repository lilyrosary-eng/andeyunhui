/**
 * 原生文件拖放的统一入口（Linux 必需，跨平台通用）。
 *
 * # 为什么不能继续用 DOM 的 dragover/drop
 *
 * 本项目主窗口配置是 `dragDropEnabled: false`，即让 WebKitGTK 自己处理系统拖放。
 * 这在 Linux 上有两个致命后果，2026-11-02 实测：
 *
 * 1. **拿不到路径**：WebKitGTK 的 `File` 对象没有 `.path`（那是 Electron/WebView2 的
 *    非标准扩展），`dataTransfer.files` 里只有名字和 MIME。`text/uri-list` 也捞不到
 *    可用内容。于是「拖文件到传输区」什么都拿不到，且被 `if (paths.length)` 静默吞掉。
 * 2. **拦不住导航**：拖入图片时，即便 DOM `drop` 里 `preventDefault()`，WebKit 仍会
 *    导航到该 `file://` —— 整个窗口变成那张图片，且不可恢复（只能重开进程）。
 *
 * 唯一解是让 wry 接管拖放：`dragDropEnabled: true`。此时
 * `tauri-runtime-wry` 的 handler 返回 `true`（见其 lib.rs 中
 * `with_drag_drop_handler(...)` 末尾的 `true`），wry 随即 `drop_finish(true, time)`
 * ⇒ WebKit 认为事件已被消费，不导航；同时通过 `onDragDropEvent` 给出**真实路径**。
 *
 * 代价：DOM 的 dragover/drop **不再触发**（事件已被 wry 消费），所以
 * 「拖入高亮」也要从这里拿状态 —— 本 hook 一并返回 `isOver`。
 *
 * # 用法
 *
 * ```tsx
 * const ref = useRef<HTMLDivElement>(null);
 * const { isOver } = useNativeFileDrop(ref, (paths) => setStaged(...));
 * return <div ref={ref} className={isOver ? 'ring-2' : ''}>...</div>;
 * ```
 *
 * 需要文件**内容**（不是路径）时，拿 paths 之后调后端
 * `read_file_base64` / `read_dropzone_file` 之类去读，别再指望 `FileReader`。
 */
import { useEffect, useState, type RefObject } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

/** 判断某个客户端坐标是否落在元素矩形内（留 0 边距，严格命中） */
function hitTest(el: HTMLElement, x: number, y: number): boolean {
  const r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

export function useNativeFileDrop(
  targetRef: RefObject<HTMLElement | null> | null,
  onDrop: (paths: string[]) => void,
  /** true = 整窗接收（不判坐标）。给 App 这种"全局兜底"用，具体区域靠 `__andengTransferActive` 之类让路。 */
  fullWindow = false,
): { isOver: boolean } {
  const [isOver, setIsOver] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      try {
        const u = await getCurrentWebviewWindow().onDragDropEvent(({ payload }) => {
          const el = targetRef?.current ?? null;
          if (!el && !fullWindow) return;

          if (payload.type === 'leave') {
            setIsOver(false);
            return;
          }

          // over / enter / drop 都带 position（leave 没有，上面已排除）
          // payload.position 是**物理像素**（相对 webview 左上角），
          // getBoundingClientRect 是 CSS 像素，必须按 devicePixelRatio 换算。
          const dpr = window.devicePixelRatio || 1;
          const inside = fullWindow
            ? true
            : hitTest(el as HTMLElement, payload.position.x / dpr, payload.position.y / dpr);

          if (payload.type === 'over' || payload.type === 'enter') {
            setIsOver(inside);
            return;
          }

          // payload.type === 'drop'
          setIsOver(false);
          if (!inside) return; // 落在别的区域，交给那个区域的实例处理
          const paths = (payload.paths || []).filter((p): p is string => Boolean(p));
          if (paths.length) onDrop(paths);
        });
        if (cancelled) {
          u();
          return;
        }
        unlisten = u;
      } catch (err) {
        console.error('[drop] 订阅原生拖放失败:', err);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [targetRef, onDrop, fullWindow]);

  return { isOver };
}
