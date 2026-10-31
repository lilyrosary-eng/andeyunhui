import { useEffect, useRef, useState } from '../host';
import { useEditorState, useEditorView } from '../hooks';
import { editor } from '../store';
import { IconFit } from './icons';

const NAV_W = 220;
const NAV_H = 120;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function NavigatorPanel() {
  const s = useEditorState();
  const view = useEditorView();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [zoomDraft, setZoomDraft] = useState(Math.round(s.zoom * 100));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    editor.drawCompositeTo(canvas, NAV_W, NAV_H);
  }, [s.revision, s.doc.w, s.doc.h, s.layers]);

  useEffect(() => { setZoomDraft(Math.round(s.zoom * 100)); }, [s.zoom]);

  const scale = Math.min(NAV_W / s.doc.w, NAV_H / s.doc.h);
  const ox = (NAV_W - s.doc.w * scale) / 2;
  const oy = (NAV_H - s.doc.h * scale) / 2;

  const vx = -view.panX / view.zoom;
  const vy = -view.panY / view.zoom;
  const vw = view.stageW / view.zoom;
  const vh = view.stageH / view.zoom;
  const x1 = clamp(vx, 0, s.doc.w);
  const y1 = clamp(vy, 0, s.doc.h);
  const x2 = clamp(vx + vw, 0, s.doc.w);
  const y2 = clamp(vy + vh, 0, s.doc.h);
  const rectLeft = ((ox + x1 * scale) / NAV_W) * 100;
  const rectTop = ((oy + y1 * scale) / NAV_H) * 100;
  const rectW = Math.max(0, ((x2 - x1) * scale) / NAV_W * 100);
  const rectH = Math.max(0, ((y2 - y1) * scale) / NAV_H * 100);

  const panTo = (clientX: number, clientY: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * NAV_W;
    const ny = ((clientY - rect.top) / rect.height) * NAV_H;
    const docX = (nx - ox) / scale;
    const docY = (ny - oy) / scale;
    editor.centerOnDocPoint(clamp(docX, 0, s.doc.w), clamp(docY, 0, s.doc.h));
  };

  return (
    <div className="shrink-0">
      <div className="mb-1 flex items-center justify-between px-0.5">
        <span className="text-[11px] font-medium text-neutral-400 dark:text-stone-500">导航器</span>
        <button
          onClick={() => editor.fitView()}
          className="btn-press rounded p-1 text-neutral-400 hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-stone-200"
          title="适应窗口 (Ctrl+0)"
        >
          <IconFit size={12} />
        </button>
      </div>
      <div
        ref={wrapRef}
        className="relative cursor-crosshair touch-none overflow-hidden rounded-md border border-black/10 bg-white/60 dark:border-white/10 dark:bg-black/20"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          dragging.current = true;
          panTo(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => { if (dragging.current) panTo(e.clientX, e.clientY); }}
        onPointerUp={() => { dragging.current = false; }}
        onPointerCancel={() => { dragging.current = false; }}
        onPointerLeave={() => { dragging.current = false; }}
      >
        <canvas ref={canvasRef} className="block h-auto w-full" style={{ aspectRatio: `${NAV_W} / ${NAV_H}` }} />
        <div
          className="pointer-events-none absolute border border-[var(--element-bg)] bg-[var(--element-bg)]/10"
          style={{ left: `${rectLeft}%`, top: `${rectTop}%`, width: `${rectW}%`, height: `${rectH}%` }}
        />
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <input
          type="range"
          min={10}
          max={800}
          step={1}
          value={zoomDraft}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            setZoomDraft(v);
            editor.zoomTo(v / 100);
          }}
          className="flex-1 accent-emerald-500"
          title="缩放"
        />
        <span className="w-9 text-right text-[10px] tabular-nums text-neutral-400 dark:text-stone-500">{zoomDraft}%</span>
      </div>
    </div>
  );
}
