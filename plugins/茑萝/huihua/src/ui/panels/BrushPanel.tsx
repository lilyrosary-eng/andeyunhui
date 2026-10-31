import { useEffect, useRef } from '../../host';
import { useEditorState } from '../../hooks';
import { editor } from '../../store';

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
    const radius = Math.max(0.5, width / 2);
    const step = Math.max(0.75, width * s.spacing);
    const alpha = s.flow;

    const dab = (x: number, y: number) => {
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

    const points: Array<[number, number]> = [];
    for (let x = 14; x <= w - 14; x += 2) {
      const t = (x - 14) / Math.max(1, w - 28);
      points.push([x, h / 2 + Math.sin(t * Math.PI * 2) * 14]);
    }
    if (points.length) {
      dab(points[0][0], points[0][1]);
      let acc = 0;
      for (let i = 1; i < points.length; i++) {
        const [x0, y0] = points[i - 1];
        const [x1, y1] = points[i];
        const dist = Math.hypot(x1 - x0, y1 - y0);
        let t = step - acc;
        while (t <= dist) {
          const ratio = t / Math.max(0.0001, dist);
          dab(x0 + (x1 - x0) * ratio, y0 + (y1 - y0) * ratio);
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
  }, [s.color, s.size, s.opacity, s.hardness, s.flow, s.spacing]);

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

export function BrushPanel() {
  const s = useEditorState();
  return (
    <div className="space-y-1.5">
      <BrushPreview />
      <SliderRow label="粗细" min={1} max={60} step={1} value={s.size} display={`${s.size}`} onChange={editor.setSize} />
      <SliderRow label="不透明度" min={0.05} max={1} step={0.05} value={s.opacity} display={`${Math.round(s.opacity * 100)}%`} onChange={editor.setOpacity} />
      <SliderRow label="硬度" min={0} max={1} step={0.05} value={s.hardness} display={`${Math.round(s.hardness * 100)}`} onChange={editor.setHardness} />
      <SliderRow label="流量" min={0.02} max={1} step={0.02} value={s.flow} display={`${Math.round(s.flow * 100)}%`} onChange={editor.setFlow} />
      <SliderRow label="间距" min={0.05} max={1} step={0.05} value={s.spacing} display={`${Math.round(s.spacing * 100)}%`} onChange={editor.setSpacing} />
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
