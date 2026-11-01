import type { PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from '../../host';
import { useEditorState } from '../../hooks';
import { editor } from '../../store';
import { CURVE_PRESETS, sampleBezier } from '../../curve';
import type { Bezier4 } from '../../curve';

function SliderRow(props: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  onChange: (v: number) => void;
}) {
  const { label, min, max, step, value, display, onChange } = props;
  return (
    <div className="flex items-center gap-1.5">
      <label className="w-10 shrink-0 text-[10px] text-neutral-500 dark:text-stone-400">{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 accent-emerald-500"
      />
      <span className="w-8 text-right text-[10px] tabular-nums text-neutral-400 dark:text-stone-500">{display}</span>
    </div>
  );
}

function BrushPreview() {
  const s = useEditorState();
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(180, canvas.clientWidth || 240);
    const h = 56;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const buffer = document.createElement('canvas');
    buffer.width = canvas.width;
    buffer.height = canvas.height;
    const bctx = buffer.getContext('2d')!;
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const width = Math.min(28, Math.max(1, s.size));
    const step = Math.max(0.75, width * s.spacing);
    const alpha = s.flow;

    // 预览路径上的压力从 0 线性升到 1，直接反映当前压感曲线的粗细变化
    const mapPressure = (p: number) => (s.pressureBezier
      ? sampleBezier(s.pressureBezier, p)
      : Math.pow(p, s.pressureCurve));

    const points: Array<[number, number]> = [];
    for (let x = 14; x <= w - 14; x += 2) {
      const t = (x - 14) / Math.max(1, w - 28);
      points.push([x, h / 2 + Math.sin(t * Math.PI * 2) * 14]);
    }
    let totalLen = 0;
    for (let i = 1; i < points.length; i++) {
      totalLen += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    }
    // 首尾渐细：离起点或终点越近越细，和落笔时的算法一致
    const ramp = (len: number) => (s.taper <= 0
      ? 1
      : Math.max(0, Math.min(1, Math.min(len, totalLen - len) / s.taper)));
    let prev: { x: number; y: number; len: number } | null = null;
    const dab = (x: number, y: number, p: number) => {
      const len = prev ? prev.len + Math.hypot(x - prev.x, y - prev.y) : 0;
      prev = { x, y, len };
      const radius = Math.max(0.5, (width * mapPressure(p) * ramp(len)) / 2);
      if (s.hardness >= 1) {
        bctx.globalAlpha = alpha;
        bctx.fillStyle = s.color;
        bctx.beginPath();
        bctx.arc(x, y, radius, 0, Math.PI * 2);
        bctx.fill();
      } else {
        bctx.globalAlpha = 1;
        const [cr, cg, cb] = s.color.replace('#', '').match(/.{2}/g)!.map((v) => parseInt(v, 16));
        const g = bctx.createRadialGradient(x, y, radius * s.hardness, x, y, radius);
        g.addColorStop(0, `rgba(${cr},${cg},${cb},${alpha})`);
        g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        bctx.fillStyle = g;
        bctx.beginPath();
        bctx.arc(x, y, radius, 0, Math.PI * 2);
        bctx.fill();
      }
    };

    const last = Math.max(1, points.length - 1);
    if (points.length) {
      dab(points[0][0], points[0][1], 0);
      let acc = 0;
      for (let i = 1; i < points.length; i++) {
        const [x0, y0] = points[i - 1];
        const [x1, y1] = points[i];
        const dist = Math.hypot(x1 - x0, y1 - y0);
        let t = step - acc;
        while (t <= dist) {
          const ratio = t / Math.max(0.0001, dist);
          dab(x0 + (x1 - x0) * ratio, y0 + (y1 - y0) * ratio, (i - 1 + ratio) / last);
          t += step;
        }
        acc = dist - (t - step);
        if (acc > step) acc = step;
      }
    }
    bctx.globalAlpha = 1;

    ctx.globalAlpha = s.opacity;
    ctx.drawImage(buffer, 0, 0, w, h);
    ctx.globalAlpha = 1;
  }, [s.color, s.size, s.opacity, s.hardness, s.flow, s.spacing, s.pressureCurve, s.pressureBezier, s.taper]);

  return (
    <div
      className="overflow-hidden rounded-md border border-black/10 dark:border-white/10"
      style={{
        backgroundImage:
          'linear-gradient(45deg,#ddd 25%,transparent 25%),linear-gradient(-45deg,#ddd 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ddd 75%),linear-gradient(-45deg,transparent 75%,#ddd 75%)',
        backgroundSize: '10px 10px',
        backgroundPosition: '0 0,0 5px,5px -5px,-5px 0',
        backgroundColor: '#f7f7f4',
      }}
    >
      <canvas ref={ref} className="block h-14 w-full" />
    </div>
  );
}

const CURVE_SIZE = 104;
const CURVE_PAD = 10;
const CURVE_INNER = CURVE_SIZE - CURVE_PAD * 2;

function CurveEditor() {
  const s = useEditorState();
  const ref = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<-1 | 0 | 1>(-1);

  const px = (p: number) => CURVE_PAD + p * CURVE_INNER;
  const py = (v: number) => CURVE_SIZE - CURVE_PAD - v * CURVE_INNER;

  const draw = useCallback(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(CURVE_SIZE * dpr);
    canvas.height = Math.round(CURVE_SIZE * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, CURVE_SIZE, CURVE_SIZE);

    ctx.strokeStyle = 'rgba(120,120,120,.18)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const t = i / 4;
      ctx.beginPath(); ctx.moveTo(px(t), py(0)); ctx.lineTo(px(t), py(1)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px(0), py(t)); ctx.lineTo(px(1), py(t)); ctx.stroke();
    }
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(120,120,120,.35)';
    ctx.beginPath(); ctx.moveTo(px(0), py(0)); ctx.lineTo(px(1), py(1)); ctx.stroke();
    ctx.setLineDash([]);

    const b = s.pressureBezier;
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(px(0), py(0));
    if (b) {
      ctx.bezierCurveTo(px(b[0]), py(b[1]), px(b[2]), py(b[3]), px(1), py(1));
    } else {
      for (let i = 1; i <= 32; i++) {
        const t = i / 32;
        ctx.lineTo(px(t), py(Math.pow(t, s.pressureCurve)));
      }
    }
    ctx.stroke();

    ctx.fillStyle = 'rgba(16,185,129,.9)';
    ctx.beginPath(); ctx.arc(px(0), py(0), 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(px(1), py(1), 2.5, 0, Math.PI * 2); ctx.fill();

    if (b) {
      const handles: Array<[number, number]> = [[px(b[0]), py(b[1])], [px(b[2]), py(b[3])]];
      const anchors: Array<[number, number]> = [[px(0), py(0)], [px(1), py(1)]];
      ctx.strokeStyle = 'rgba(16,185,129,.5)';
      ctx.lineWidth = 1;
      handles.forEach((h, i) => {
        ctx.beginPath(); ctx.moveTo(anchors[i][0], anchors[i][1]); ctx.lineTo(h[0], h[1]); ctx.stroke();
      });
      handles.forEach((h) => {
        ctx.beginPath(); ctx.arc(h[0], h[1], 4, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = '#10b981';
        ctx.stroke();
      });
    }
  }, [s.pressureBezier, s.pressureCurve]);

  useEffect(() => { draw(); }, [draw]);

  const toPlot = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left - CURVE_PAD) / CURVE_INNER;
    const y = (CURVE_SIZE - CURVE_PAD - (e.clientY - rect.top)) / CURVE_INNER;
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const b = s.pressureBezier;
    if (!b) return;
    const p = toPlot(e);
    const handles: Array<[number, number]> = [[b[0], b[1]], [b[2], b[3]]];
    let best = -1;
    let bestDist = 0.14;
    handles.forEach((h, i) => {
      const d = Math.hypot(h[0] - p.x, h[1] - p.y);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    if (best < 0) return;
    dragRef.current = best as 0 | 1;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current < 0 || !s.pressureBezier) return;
    const p = toPlot(e);
    const b = s.pressureBezier.slice() as Bezier4;
    if (dragRef.current === 0) { b[0] = p.x; b[1] = p.y; }
    else { b[2] = p.x; b[3] = p.y; }
    editor.setPressureBezier(b);
  };

  const onPointerUp = () => { dragRef.current = -1; };

  return (
    <div className="flex items-start gap-1.5">
      <canvas
        ref={ref}
        width={CURVE_SIZE}
        height={CURVE_SIZE}
        style={{ width: CURVE_SIZE, height: CURVE_SIZE }}
        className="shrink-0 touch-none rounded-md border border-black/10 bg-white/60 dark:border-white/10 dark:bg-black/20"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        title="拖拽控制点精调压感曲线"
      />
      <div className="flex min-w-0 flex-1 flex-wrap content-start gap-1">
        {CURVE_PRESETS.map((preset) => {
          const active = preset.value
            ? !!s.pressureBezier && s.pressureBezier.every((v, i) => Math.abs(v - preset.value![i]) < 0.001)
            : !s.pressureBezier && Math.abs(s.pressureCurve - 1) < 0.001;
          return (
            <button
              key={preset.name}
              className={`rounded border px-1.5 py-0.5 text-[10px] ${active
                ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : 'border-black/10 text-neutral-500 hover:bg-black/5 dark:border-white/10 dark:text-stone-400 dark:hover:bg-white/10'}`}
              onClick={() => {
                if (!preset.value) editor.setPressureCurve(1);
                editor.setPressureBezier(preset.value);
              }}
            >
              {preset.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function BrushPanel() {
  const s = useEditorState();
  const [preset, setPreset] = useState(s.presets[0]?.name ?? '');

  useEffect(() => {
    if (!s.presets.some((p) => p.name === preset)) setPreset(s.presets[0]?.name ?? '');
  }, [s.presets, preset]);

  return (
    <div className="space-y-1.5">
      <BrushPreview />
      <div className="flex items-center gap-1">
        <span className="w-10 shrink-0 text-[10px] text-neutral-500 dark:text-stone-400">预设</span>
        <select
          value={preset}
          onChange={(e) => { setPreset(e.target.value); editor.applyPreset(e.target.value); }}
          title="笔刷预设"
          className="h-6 min-w-0 flex-1 rounded border border-black/10 bg-white/70 px-1 text-[10px] text-neutral-600 outline-none dark:border-white/10 dark:bg-black/20 dark:text-stone-300"
        >
          {s.presets.length === 0 && <option value="">（无）</option>}
          {s.presets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>
        <button
          className="rounded border border-black/10 px-1.5 text-[10px] text-neutral-500 hover:bg-black/5 dark:border-white/10 dark:text-stone-400 dark:hover:bg-white/10"
          onClick={() => {
            const name = window.prompt('预设名称', preset || '我的笔刷');
            if (name) editor.savePreset(name);
          }}
          title="保存当前笔刷为预设"
        >
          存
        </button>
        <button
          className="rounded border border-black/10 px-1.5 text-[10px] text-neutral-500 hover:bg-black/5 disabled:opacity-30 dark:border-white/10 dark:text-stone-400 dark:hover:bg-white/10"
          disabled={!preset}
          onClick={() => editor.deletePreset(preset)}
          title="删除当前预设"
        >
          删
        </button>
      </div>
      <SliderRow label="粗细" min={1} max={60} step={1} value={s.size} display={`${s.size}`} onChange={editor.setSize} />
      <SliderRow label="不透明度" min={0.05} max={1} step={0.05} value={s.opacity} display={`${Math.round(s.opacity * 100)}%`} onChange={editor.setOpacity} />
      <SliderRow label="硬度" min={0} max={1} step={0.05} value={s.hardness} display={`${Math.round(s.hardness * 100)}`} onChange={editor.setHardness} />
      <SliderRow label="流量" min={0.02} max={1} step={0.02} value={s.flow} display={`${Math.round(s.flow * 100)}%`} onChange={editor.setFlow} />
      <SliderRow label="间距" min={0.05} max={1} step={0.05} value={s.spacing} display={`${Math.round(s.spacing * 100)}%`} onChange={editor.setSpacing} />
      <SliderRow label="渐细" min={0} max={100} step={1} value={s.taper} display={`${s.taper}px`} onChange={editor.setTaper} />
      <SliderRow label="速度" min={0} max={1} step={0.05} value={s.velocity} display={`${Math.round(s.velocity * 100)}%`} onChange={editor.setVelocity} />
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-neutral-500 dark:text-stone-400">压感曲线</span>
        <span className="text-[10px] tabular-nums text-neutral-400 dark:text-stone-500">
          {s.pressureBezier ? '曲线' : `γ ${s.pressureCurve.toFixed(2)}`}
        </span>
      </div>
      <CurveEditor />
      <SliderRow label="压感" min={0.3} max={2.5} step={0.05} value={s.pressureCurve} display={s.pressureCurve.toFixed(2)} onChange={editor.setPressureCurve} />
      <SliderRow label="稳定" min={0} max={1} step={0.05} value={s.stabilizer} display={`${Math.round(s.stabilizer * 100)}%`} onChange={editor.setStabilizer} />
      <label className="mt-1 flex cursor-pointer items-center gap-1.5 text-[10px] text-neutral-500 dark:text-stone-400">
        <input
          type="checkbox"
          checked={s.transparent}
          onChange={(e) => editor.setTransparent(e.target.checked)}
          className="accent-emerald-500"
        />
        导出 PNG 时保留透明背景
      </label>
    </div>
  );
}
