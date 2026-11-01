import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useEffect, useRef } from '../host';
import { useEditorState, useEditorView } from '../hooks';
import { editor } from '../store';

const CHECKER: CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg,#e3e1da 25%,transparent 25%),linear-gradient(-45deg,#e3e1da 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#e3e1da 75%),linear-gradient(-45deg,transparent 75%,#e3e1da 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0,0 8px,8px -8px,-8px 0',
  backgroundColor: '#efede6',
};

export function Board() {
  const state = useEditorState();
  const view = useEditorView();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const lastScreen = useRef({ x: 0, y: 0, visible: false });

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
    if (selection) strokePath(selection);

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

    if (lastScreen.current.visible && s.tool !== 'fill' && s.tool !== 'pick'
      && s.tool !== 'selectRect' && s.tool !== 'selectLasso' && s.tool !== 'move') {
      const r = Math.max(2, (s.size * z) / 2);
      const x = lastScreen.current.x;
      const y = lastScreen.current.y;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,.95)';
      ctx.lineWidth = 0.75;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 1.2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,.6)';
      ctx.fill();
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
    lastScreen.current = { x: e.clientX, y: e.clientY, visible: true };
    editor.pointerDown(e.clientX, e.clientY, isPen ? e.pressure : 0, e.button, isPen);
    drawOverlay();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const isPen = e.pointerType === 'pen';
    lastScreen.current = { x: e.clientX, y: e.clientY, visible: true };
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

  const cursor = state.tool === 'move'
    ? 'move'
    : state.tool === 'pick' || state.tool === 'fill'
      || state.tool === 'selectRect' || state.tool === 'selectLasso'
      ? 'crosshair'
      : 'none';

  return (
    <div
      ref={wrapRef}
      className="absolute inset-0 overflow-hidden"
      style={CHECKER}
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
