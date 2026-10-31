import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { useEffect, useRef } from '../host';
import { useEditorState } from '../hooks';
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
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

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
    const ro = new ResizeObserver(() => clearOverlay());
    ro.observe(wrap);
    return () => {
      wrap.removeEventListener('wheel', onWheel);
      ro.disconnect();
      editor.detach();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearOverlay = () => {
    const c = overlayRef.current;
    if (!c) return;
    c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
  };

  const drawCursorRing = (clientX: number, clientY: number) => {
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
    const s = editor.getState();
    if (s.tool === 'fill' || s.tool === 'pick') return;
    const rect = c.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const r = Math.max(2, (s.size * s.zoom) / 2);
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
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button === 2) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const isPen = e.pointerType === 'pen';
    editor.pointerDown(e.clientX, e.clientY, isPen ? e.pressure : 0, e.button, isPen);
    drawCursorRing(e.clientX, e.clientY);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const isPen = e.pointerType === 'pen';
    editor.pointerMove(e.clientX, e.clientY, isPen ? e.pressure : 0, isPen);
    drawCursorRing(e.clientX, e.clientY);
  };

  const onPointerUp = () => {
    editor.pointerUp();
  };

  const onPointerLeave = () => {
    editor.clearCursor();
    clearOverlay();
  };

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
        style={{ cursor: state.tool === 'pick' || state.tool === 'fill' ? 'crosshair' : 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
      />
      <canvas
        ref={overlayRef}
        className="pointer-events-none absolute inset-0 h-full w-full"
      />
    </div>
  );
}
