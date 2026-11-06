import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useEffect, useRef } from '../host';
import { useEditorState, useEditorView } from '../hooks';
import { editor } from '../store';

/**
 * 透明区棋盘：**位图**图案，不用 CSS 渐变。
 *
 * 为什么换掉渐变：conic / linear 渐变的「硬色标」在边界上仍会被抗锯齿插值出过渡像素，
 * 平铺之后就是每隔一格一条发丝线。用户 2026-11-04 把多层混合、羽化、不透明度、选区、
 * 以及 Windows 系统缩放全部排除后接缝仍在 —— 说明它与缩放和图层混合都无关，
 * 是渐变自身的产物，改缩放永远治不好。
 * 位图 tile 里只有整块 fillRect 的两种颜色，没有插值可发生；再配 `image-rendering: pixelated`，
 * 缩放到非整数设备像素时是复制像素而不是混出新的边。
 *
 * 颜色与几何沿用原来的两色（#e3e1da / #efede6）、16px 一格，观感不变。
 */
function makeCheckerTile(): string {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 16;
  const g = c.getContext('2d')!;
  g.fillStyle = '#efede6';
  g.fillRect(0, 0, 16, 16);
  g.fillStyle = '#e3e1da';
  g.fillRect(0, 0, 8, 8);
  g.fillRect(8, 8, 8, 8);
  return c.toDataURL('image/png');
}

const CHECKER_URL = makeCheckerTile();

const CHECKER: CSSProperties = {
  backgroundImage: `url(${CHECKER_URL})`,
  backgroundSize: '16px 16px',
  imageRendering: 'pixelated',
};

export function Board() {
  const state = useEditorState();
  const view = useEditorView();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const lastScreen = useRef({ x: 0, y: 0, visible: false });

  /**
   * client 视觉像素 → 覆盖层画布的布局像素。
   * 笔尖环是直接 `ctx.arc(x, y)` 画在覆盖层上的，原先存的是裸 clientX/clientY：
   * 既没减画布原点（于是整体偏一个「侧栏宽 + DocBar 高」），也没除宿主 zoom，
   * 结果系统光标与自绘笔尖环同时出现且不重合（用户 2026-11-01 反馈）。
   */
  const toOverlayLocal = (clientX: number, clientY: number) => {
    const c = overlayRef.current ?? canvasRef.current;
    if (!c) return { x: clientX, y: clientY };
    const rect = c.getBoundingClientRect();
    const layout = c.clientWidth || 1;
    const s = rect.width > 0 ? rect.width / layout : 1;
    return { x: (clientX - rect.left) / s, y: (clientY - rect.top) / s };
  };

  const drawOverlay = useCallback(() => {
    const c = overlayRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    const tw = Math.round(w * dpr);
    const th = Math.round(h * dpr);
    if (c.width !== tw || c.height !== th) {
      c.width = tw;
      c.height = th;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const v = editor.getView();
    const s = editor.getState();
    const z = v.zoom || 1;
    const t = editor.getSelectionTransform();

    const strokePath = (path: Path2D) => {
      ctx.save();
      ctx.translate(v.panX, v.panY);
      ctx.scale(z, z);
      if (t.active) {
        if (t.scale !== 1 || t.rotation !== 0) {
          ctx.translate(t.pivotX, t.pivotY);
          ctx.rotate(t.rotation);
          ctx.scale(t.scale, t.scale);
          ctx.translate(-t.pivotX, -t.pivotY);
        } else if (t.dx || t.dy) {
          ctx.translate(t.dx, t.dy);
        }
      }
      ctx.lineWidth = 1 / z;
      ctx.setLineDash([4 / z, 4 / z]);
      ctx.lineDashOffset = 0;
      ctx.strokeStyle = 'rgba(0,0,0,.85)';
      ctx.stroke(path);
      ctx.lineDashOffset = 4 / z;
      ctx.strokeStyle = 'rgba(255,255,255,.95)';
      ctx.stroke(path);
      ctx.restore();
    };

    const selection = editor.getSelectionPath();
    const outline = editor.getSelectionOutline();
    if (outline) {
      // 收缩/扩展过的选区没有几何路径，直接画 mask 的 1px 边界带（深色 + 偏移白边）
      ctx.save();
      ctx.translate(v.panX, v.panY);
      ctx.scale(z, z);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(outline, 0, 0);
      ctx.filter = 'invert(1)';
      ctx.drawImage(outline, 1 / z, 1 / z);
      ctx.filter = 'none';
      ctx.restore();
    } else if (selection) {
      strokePath(selection);
    }

    if (selection && s.tool === 'move' && !t.active) {
      const b = editor.getSelectionDisplayBounds();
      if (b) {
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        const size = 6 / z;
        const rotY = b.y - 24 / z;
        ctx.save();
        ctx.translate(v.panX, v.panY);
        ctx.scale(z, z);
        ctx.lineWidth = 1 / z;
        ctx.strokeStyle = 'rgba(0,0,0,.55)';
        ctx.beginPath();
        ctx.moveTo(cx, b.y);
        ctx.lineTo(cx, rotY);
        ctx.stroke();
        const handles: Array<[number, number]> = [
          [b.x, b.y], [cx, b.y], [b.x + b.w, b.y],
          [b.x, cy], [b.x + b.w, cy],
          [b.x, b.y + b.h], [cx, b.y + b.h], [b.x + b.w, b.y + b.h],
        ];
        for (const [hx, hy] of handles) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(hx - size / 2, hy - size / 2, size, size);
          ctx.strokeStyle = 'rgba(0,0,0,.75)';
          ctx.strokeRect(hx - size / 2, hy - size / 2, size, size);
        }
        ctx.beginPath();
        ctx.arc(cx, rotY, 4 / z, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.75)';
        ctx.stroke();
        ctx.restore();
      }
    }

    const draft = editor.getSelectionDraft();
    if (draft && draft.points.length > 0) {
      const p = new Path2D();
      if (draft.tool === 'selectRect') {
        const end = draft.points[1] ?? draft.points[0];
        p.rect(
          Math.min(draft.start.x, end.x),
          Math.min(draft.start.y, end.y),
          Math.abs(end.x - draft.start.x),
          Math.abs(end.y - draft.start.y),
        );
      } else {
        p.moveTo(draft.points[0].x, draft.points[0].y);
        for (let i = 1; i < draft.points.length; i++) p.lineTo(draft.points[i].x, draft.points[i].y);
      }
      strokePath(p);
    }

    if (lastScreen.current.visible) {
      const x = lastScreen.current.x;
      const y = lastScreen.current.y;
      // 深 + 浅双描边：画布底色不确定（白画布、深色图层、棋盘透明区）都要看得见。
      const twoTone = (path: () => void, wDark = 1.5, wLight = 0.75) => {
        ctx.lineWidth = wDark;
        ctx.strokeStyle = 'rgba(0,0,0,.55)';
        path();
        ctx.lineWidth = wLight;
        ctx.strokeStyle = 'rgba(255,255,255,.95)';
        path();
      };
      const ringed = s.tool !== 'fill' && s.tool !== 'pick'
        && s.tool !== 'selectRect' && s.tool !== 'selectLasso' && s.tool !== 'move';
      if (ringed) {
        const r = Math.max(2, (s.size * z) / 2);
        twoTone(() => {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.stroke();
        });
        ctx.beginPath();
        ctx.arc(x, y, 1.2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,.6)';
        ctx.fill();
      } else if (s.tool === 'move') {
        twoTone(() => {
          ctx.beginPath();
          ctx.arc(x, y, 6, 0, Math.PI * 2);
          ctx.stroke();
        });
      } else {
        // 油漆桶 / 取色 / 框选 / 套索：十字准星（系统光标已整块隐藏，必须自己画出来）
        twoTone(() => {
          ctx.beginPath();
          ctx.moveTo(x - 7, y);
          ctx.lineTo(x + 7, y);
          ctx.moveTo(x, y - 7);
          ctx.lineTo(x, y + 7);
          ctx.stroke();
        });
      }
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    editor.attach(canvas, wrap);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      editor.wheel(e.deltaY, e.clientX, e.clientY);
    };
    wrap.addEventListener('wheel', onWheel, { passive: false });
    const ro = new ResizeObserver(() => drawOverlay());
    ro.observe(wrap);
    return () => {
      wrap.removeEventListener('wheel', onWheel);
      ro.disconnect();
      editor.detach();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    drawOverlay();
  }, [drawOverlay, state.selectionVersion, state.zoom, state.tool, state.size, view.panX, view.panY, view.zoom]);

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button === 2) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const isPen = e.pointerType === 'pen';
    lastScreen.current = { ...toOverlayLocal(e.clientX, e.clientY), visible: true };
    editor.pointerDown(e.clientX, e.clientY, isPen ? e.pressure : 0, e.button, isPen);
    drawOverlay();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const isPen = e.pointerType === 'pen';
    lastScreen.current = { ...toOverlayLocal(e.clientX, e.clientY), visible: true };
    editor.pointerMove(e.clientX, e.clientY, isPen ? e.pressure : 0, isPen, e.shiftKey);
    drawOverlay();
  };

  const onPointerUp = () => {
    editor.pointerUp();
    drawOverlay();
  };

  const onPointerLeave = () => {
    if (editor.getSelectionDraft()) return;
    lastScreen.current = { ...lastScreen.current, visible: false };
    editor.clearCursor();
    drawOverlay();
  };

  // 画布上只显示自绘光标（用户 2026-11-04 要求）。系统光标整块隐藏，
  // 所以 drawOverlay 里每种工具都必须画出自己的光标标记（环 / 圆 / 十字准星），
  // 否则会「找不到指针在哪」。`cursor` 是可继承属性，加在容器上就覆盖整块画布区。
  const cursor = 'none';

  return (
    <div
      ref={wrapRef}
      className="absolute inset-0 overflow-hidden"
      style={{ ...CHECKER, cursor }}
      onContextMenu={(e) => {
        e.preventDefault();
        editor.openContextMenu(e.clientX, e.clientY);
      }}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
      />
      <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full" />
    </div>
  );
}
