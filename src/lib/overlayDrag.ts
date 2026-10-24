import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { isLinux } from '@/platform/isLinux';

/**
 * 原生 Wayland 浮窗拖动。
 *
 * 背景（2026-10-24 查实）：tao 0.35 的 `drag_window()` 传 `begin_move_drag(1,x,y,**0**)`，
 * Wayland 的 `xdg_toplevel.move` 必须带当前输入事件的 serial ⇒ `startDragging()` 与
 * `data-tauri-drag-region` 在原生 Wayland 上根本不可能生效（不是我们代码的问题）。
 *
 * 于是走合成器：Rust 命令 → D-Bus `org.andeyunhui.Pin` → GNOME 扩展 `move_frame`。
 * 优先让扩展 `begin_grab_op(MOVING)` 自己跟随指针；不可用时回退到
 * 「累积 movementX/Y + overlay_drag_move」。
 *
 * 非 Linux：调用方继续用原生 `startDragging()`，本模块返回 false。
 */

let dragging = false;

/** 开始拖动。返回 true 表示已经接管（调用方不要再调 startDragging）。 */
export async function beginOverlayDrag(ev: {
  button: number;
  pointerId?: number;
  currentTarget: EventTarget | null;
}): Promise<boolean> {
  if (!isLinux() || ev.button !== 0 || dragging) return false;
  const win = getCurrentWindow();
  const label = win.label;
  dragging = true;

  let handled = false;
  try {
    handled = await invoke<boolean>('overlay_drag_begin', { label });
  } catch {
    handled = false;
  }

  const finish = () => {
    dragging = false;
    invoke('overlay_drag_end', { label }).catch(() => {});
    window.removeEventListener('pointerup', finish, true);
  };

  if (handled) {
    // 合成器已进入 MOVING 抓取：位移由 mutter 完成，我们只管收尾
    window.addEventListener('pointerup', finish, true);
    return true;
  }

  // ---- 回退路径：自己算位移 ----
  // 用 movementX/Y 而不是 screenX/clientX：Wayland 下客户端拿不到绝对屏幕坐标，
  // 而窗口被我们移动时 clientX 也会跟着变，只有 movement 是纯指针增量。
  const scale = await win.scaleFactor().catch(() => 1);
  const pos = await win.outerPosition().catch(() => null);
  if (!pos) {
    dragging = false;
    return false;
  }
  let x = pos.x / (scale || 1);
  let y = pos.y / (scale || 1);
  let raf = 0;

  const el = ev.currentTarget as HTMLElement | null;
  const pid = ev.pointerId;
  try {
    if (pid !== undefined) el?.setPointerCapture?.(pid);
  } catch {
    /* 某些透明窗不支持捕获，忽略 */
  }

  const onMove = (e: PointerEvent) => {
    if (pid !== undefined && e.pointerId !== pid) return;
    x += e.movementX;
    y += e.movementY;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      invoke('overlay_drag_move', { label, x: Math.round(x), y: Math.round(y) }).catch(() => {});
    });
  };
  const onUp = () => {
    if (raf) cancelAnimationFrame(raf);
    window.removeEventListener('pointermove', onMove, true);
    try {
      if (pid !== undefined) el?.releasePointerCapture?.(pid);
    } catch {
      /* ignore */
    }
    finish();
  };

  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  return true;
}

/** 只要布尔结果：合成器是否接管了这次拖动（桌宠用它与自绘拖动互斥）。 */
export async function overlayDragBeginAsync(label: string): Promise<boolean> {
  if (!isLinux()) return false;
  try {
    return await invoke<boolean>('overlay_drag_begin', { label });
  } catch {
    return false;
  }
}

/** 只发"开始/移动/结束"三个原语，供已有自绘拖动逻辑的组件（如桌宠）复用。 */
export function overlayDragBegin(label: string): void {
  if (!isLinux()) return;
  invoke('overlay_drag_begin', { label }).catch(() => {});
}

export function overlayDragMove(label: string, x: number, y: number): void {
  if (!isLinux()) return;
  invoke('overlay_drag_move', { label, x: Math.round(x), y: Math.round(y) }).catch(() => {});
}

export function overlayDragEnd(label: string): void {
  if (!isLinux()) return;
  invoke('overlay_drag_end', { label }).catch(() => {});
}
