import { useEffect, useRef, useState } from '../../host';
import { useEditorState } from '../../hooks';
import { editor } from '../../store';
import { PALETTE, hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from '../../color';
import type { ColorMode, ColorTarget } from '../../types';
import { IconSwap } from '../icons';

function ColorSlider(props: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
  bgGradient: string;
  showValue?: boolean;
}) {
  const { label, min, max, step = 1, value, onChange, bgGradient, showValue = true } = props;
  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <span className="w-3.5 font-medium tabular-nums text-neutral-500 dark:text-stone-400">{label}</span>
      <div
        className="relative h-3 flex-1 overflow-hidden rounded-full border border-black/10 dark:border-white/10"
        style={{ background: bgGradient }}
      >
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
        <div
          className="pointer-events-none absolute top-1/2 h-0 w-0 -translate-x-1/2 -translate-y-1/2"
          style={{
            left: `${((value - min) / (max - min)) * 100}%`,
            borderLeft: '4px solid transparent',
            borderRight: '4px solid transparent',
            borderTop: '6px solid #fff',
            filter: 'drop-shadow(0 0 1px rgba(0,0,0,.8))',
          }}
        />
      </div>
      {showValue && (
        <span className="w-7 text-right tabular-nums text-neutral-500 dark:text-stone-400">{Math.round(value)}</span>
      )}
    </div>
  );
}

function HexRow({ color, onChange }: { color: string; onChange: (c: string) => void }) {
  return (
    <div className="flex w-full items-center gap-1">
      <span
        className="h-7 w-7 shrink-0 rounded-md border border-black/10 shadow-inner dark:border-white/10"
        style={{ backgroundColor: color }}
      />
      <input
        type="text"
        value={color.toUpperCase()}
        onChange={(e) => {
          const v = e.target.value.trim();
          if (/^#?[0-9a-fA-F]{6}$/.test(v)) onChange((v.startsWith('#') ? v : '#' + v).toLowerCase());
        }}
        className="min-w-0 flex-1 rounded border border-black/10 bg-white/60 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-neutral-700 dark:border-white/10 dark:bg-black/20 dark:text-stone-200"
        maxLength={7}
      />
      <label
        className="relative h-7 w-7 shrink-0 cursor-pointer overflow-hidden rounded-md border border-black/10 dark:border-white/10"
        title="系统拾色器"
      >
        <input
          type="color"
          value={color}
          onChange={(e) => onChange(e.target.value)}
          className="absolute -left-2 -top-2 h-12 w-12 cursor-pointer border-0 p-0"
        />
      </label>
    </div>
  );
}

function ColorWheelView({ color, onChange }: { color: string; onChange: (c: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<'ring' | 'square' | null>(null);
  const SIZE = 184;
  const RING_THICK = 22;
  const [r, g, b] = hexToRgb(color);
  const [hue, sat, val] = rgbToHsv(r, g, b);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== SIZE * dpr) c.width = SIZE * dpr;
    if (c.height !== SIZE * dpr) c.height = SIZE * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    const cx = SIZE / 2;
    const cy = SIZE / 2;
    const outerR = SIZE / 2 - 4;
    const innerR = outerR - RING_THICK;

    const conic = ctx.createConicGradient(-Math.PI / 2, cx, cy);
    for (let i = 0; i <= 12; i++) conic.addColorStop(i / 12, `hsl(${i * 30}, 100%, 50%)`);
    ctx.save();
    ctx.fillStyle = conic;
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.restore();

    const sq = innerR * 1.35;
    const sqX = cx - sq / 2;
    const sqY = cy - sq / 2;
    ctx.fillStyle = `hsl(${hue}, 100%, 50%)`;
    ctx.fillRect(sqX, sqY, sq, sq);
    const g1 = ctx.createLinearGradient(sqX, sqY, sqX + sq, sqY);
    g1.addColorStop(0, 'rgba(255,255,255,1)');
    g1.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g1;
    ctx.fillRect(sqX, sqY, sq, sq);
    const g2 = ctx.createLinearGradient(sqX, sqY, sqX, sqY + sq);
    g2.addColorStop(0, 'rgba(0,0,0,0)');
    g2.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = g2;
    ctx.fillRect(sqX, sqY, sq, sq);
    ctx.strokeStyle = 'rgba(0,0,0,.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(sqX + 0.5, sqY + 0.5, sq - 1, sq - 1);

    const hueAng = ((hue - 90) * Math.PI) / 180;
    const hueR = (outerR + innerR) / 2;
    const hx = cx + Math.cos(hueAng) * hueR;
    const hy = cy + Math.sin(hueAng) * hueR;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(hx, hy, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const svX = sqX + (sat / 100) * sq;
    const svY = sqY + (1 - val / 100) * sq;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(svX, svY, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [hue, sat, val]);

  const ptToXY = (clientX: number, clientY: number) => {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    return { x: clientX - rect.left - SIZE / 2, y: clientY - rect.top - SIZE / 2 };
  };

  const apply = (mx: number, my: number, region: 'ring' | 'square') => {
    const sq = (SIZE / 2 - 4 - RING_THICK) * 1.35;
    if (region === 'ring') {
      let ang = (Math.atan2(my, mx) * 180) / Math.PI + 90;
      if (ang < 0) ang += 360;
      if (ang >= 360) ang -= 360;
      const [nr, ng, nb] = hsvToRgb(ang, sat, val);
      onChange(rgbToHex(nr, ng, nb));
    } else {
      const sx = Math.max(0, Math.min(sq, mx + sq / 2));
      const sy = Math.max(0, Math.min(sq, my + sq / 2));
      const [nr, ng, nb] = hsvToRgb(hue, (sx / sq) * 100, (1 - sy / sq) * 100);
      onChange(rgbToHex(nr, ng, nb));
    }
  };

  return (
    <div className="flex flex-col items-center gap-1.5">
      <canvas
        ref={canvasRef}
        width={SIZE}
        height={SIZE}
        style={{ width: SIZE, height: SIZE }}
        className="touch-none select-none rounded-full"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          const { x, y } = ptToXY(e.clientX, e.clientY);
          const d = Math.sqrt(x * x + y * y);
          const outerR = SIZE / 2 - 4;
          const innerR = outerR - RING_THICK;
          const sqHalf = (innerR * 1.35) / 2;
          if (d <= sqHalf) { dragRef.current = 'square'; apply(x, y, 'square'); }
          else if (d <= outerR && d >= innerR) { dragRef.current = 'ring'; apply(x, y, 'ring'); }
        }}
        onPointerMove={(e) => {
          if (!dragRef.current) return;
          const { x, y } = ptToXY(e.clientX, e.clientY);
          apply(x, y, dragRef.current);
        }}
        onPointerUp={() => { dragRef.current = null; }}
        onPointerLeave={() => { dragRef.current = null; }}
      />
      <HexRow color={color} onChange={onChange} />
    </div>
  );
}

function RgbSliders({ color, onChange }: { color: string; onChange: (c: string) => void }) {
  const [r, g, b] = hexToRgb(color);
  const set = (nr: number, ng: number, nb: number) => onChange(rgbToHex(nr, ng, nb));
  return (
    <div className="space-y-1.5">
      <ColorSlider label="R" min={0} max={255} value={r} onChange={(v) => set(v, g, b)} bgGradient={`linear-gradient(90deg, rgb(0,${g},${b}), rgb(255,${g},${b}))`} />
      <ColorSlider label="G" min={0} max={255} value={g} onChange={(v) => set(r, v, b)} bgGradient={`linear-gradient(90deg, rgb(${r},0,${b}), rgb(${r},255,${b}))`} />
      <ColorSlider label="B" min={0} max={255} value={b} onChange={(v) => set(r, g, v)} bgGradient={`linear-gradient(90deg, rgb(${r},${g},0), rgb(${r},${g},255))`} />
      <HexRow color={color} onChange={onChange} />
    </div>
  );
}

function HsvSliders({ color, onChange }: { color: string; onChange: (c: string) => void }) {
  const [r, g, b] = hexToRgb(color);
  const [h, s, v] = rgbToHsv(r, g, b);
  const set = (nh: number, ns: number, nv: number) => {
    const [nr, ng, nb] = hsvToRgb(nh, ns, nv);
    onChange(rgbToHex(nr, ng, nb));
  };
  const hueStops = (() => {
    let stops = 'linear-gradient(90deg';
    for (let i = 0; i <= 12; i++) stops += `, hsl(${i * 30} 100% 50%)`;
    return stops + ')';
  })();
  return (
    <div className="space-y-1.5">
      <ColorSlider label="H" min={0} max={360} step={1} value={h} onChange={(x) => set(x, s, v)} bgGradient={hueStops} />
      <ColorSlider label="S" min={0} max={100} step={1} value={s} onChange={(x) => set(h, x, v)} bgGradient={`linear-gradient(90deg, hsl(${h}, 0%, ${v / 2}%), hsl(${h}, 100%, 50%))`} />
      <ColorSlider label="V" min={0} max={100} step={1} value={v} onChange={(x) => set(h, s, x)} bgGradient={`linear-gradient(90deg, #000, hsl(${h}, ${s}%, 50%))`} />
      <HexRow color={color} onChange={onChange} />
    </div>
  );
}

function PaletteView({ color, recent, onPick }: { color: string; recent: string[]; onPick: (c: string) => void }) {
  const cur = color.toLowerCase();
  return (
    <div className="space-y-2">
      <HexRow color={color} onChange={onPick} />
      <div>
        <div className="mb-1 text-[10px] font-medium text-neutral-400 dark:text-stone-500">最近使用</div>
        <div className="grid grid-cols-10 gap-[3px]">
          {Array.from({ length: 10 }).map((_, i) => {
            const c = recent[i];
            if (!c) return <div key={i} className="aspect-square w-full rounded-sm border border-dashed border-black/10 dark:border-white/10" />;
            return (
              <button
                key={i}
                onClick={() => onPick(c)}
                title={c}
                className={`aspect-square w-full rounded-sm transition-transform hover:scale-110 ${cur === c ? 'ring-1 ring-[var(--element-bg)] ring-offset-1' : ''}`}
                style={{ backgroundColor: c, border: c === '#ffffff' ? '1px solid #cbd5e1' : '1px solid transparent' }}
              />
            );
          })}
        </div>
      </div>
      <div>
        <div className="mb-1 text-[10px] font-medium text-neutral-400 dark:text-stone-500">色板</div>
        <div className="grid grid-cols-10 gap-[3px]">
          {PALETTE.map((c) => (
            <button
              key={c}
              onClick={() => onPick(c)}
              title={c}
              className={`aspect-square w-full rounded-sm transition-transform hover:scale-110 ${cur === c.toLowerCase() ? 'ring-1 ring-[var(--element-bg)] ring-offset-1' : ''}`}
              style={{ backgroundColor: c, border: c.toLowerCase() === '#ffffff' ? '1px solid #cbd5e1' : '1px solid transparent' }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function IconWheel({ active }: { active: boolean }) {
  const stroke = active ? '#fff' : 'currentColor';
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <defs>
        <linearGradient id="hw-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff5252" /><stop offset=".17" stopColor="#ffd24a" />
          <stop offset=".34" stopColor="#7cf06a" /><stop offset=".5" stopColor="#3ad6ff" />
          <stop offset=".67" stopColor="#5b6cff" /><stop offset=".84" stopColor="#c64cff" />
          <stop offset="1" stopColor="#ff4ea1" />
        </linearGradient>
      </defs>
      <circle cx="8" cy="8" r="6" stroke="url(#hw-grad)" strokeWidth="2" fill="none" />
      <circle cx="8" cy="8" r="2" fill={stroke} />
    </svg>
  );
}

function IconRgb({ active }: { active: boolean }) {
  const stroke = active ? '#fff' : 'currentColor';
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="3" width="12" height="2.4" rx=".6" fill="#ef4444" />
      <rect x="2" y="6.8" width="12" height="2.4" rx=".6" fill="#22c55e" />
      <rect x="2" y="10.6" width="12" height="2.4" rx=".6" fill="#3b82f6" />
      <line x1="13.5" y1="3" x2="13.5" y2="5.4" stroke={stroke} strokeWidth=".6" />
    </svg>
  );
}

function IconHsv({ active }: { active: boolean }) {
  const stroke = active ? '#fff' : 'currentColor';
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="3" y="2" width="2.4" height="12" rx=".6" fill="#ff5252" />
      <rect x="6.8" y="2" width="2.4" height="12" rx=".6" fill="#22c55e" />
      <rect x="10.6" y="2" width="2.4" height="12" rx=".6" fill={stroke} />
    </svg>
  );
}

function IconPaletteTab({ active }: { active: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2" width="5" height="5" rx="1" fill="#ef4444" />
      <rect x="9" y="2" width="5" height="5" rx="1" fill="#22c55e" />
      <rect x="2" y="9" width="5" height="5" rx="1" fill="#3b82f6" />
      <rect x="9" y="9" width="5" height="5" rx="1" fill={active ? '#fff' : '#facc15'} />
    </svg>
  );
}

export function ColorPanel() {
  const s = useEditorState();
  const [target, setTarget] = useState<ColorTarget>('fg');
  const active = target === 'fg' ? s.color : s.bgColor;
  const setActive = (c: string) => editor.setColor(c, target);

  const tabs: { mode: ColorMode; label: string; icon: (p: { active: boolean }) => any }[] = [
    { mode: 'wheel', label: '色轮', icon: IconWheel },
    { mode: 'rgb', label: 'RGB', icon: IconRgb },
    { mode: 'hsv', label: 'HSV', icon: IconHsv },
    { mode: 'palette', label: '色板', icon: IconPaletteTab },
  ];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="relative h-9 w-9">
          <button
            onClick={() => setTarget('bg')}
            title="编辑背景色"
            className={`absolute bottom-0 right-0 h-6 w-6 rounded border ${target === 'bg' ? 'border-[var(--element-bg)] ring-1 ring-[var(--element-bg)]' : 'border-black/20 dark:border-white/20'}`}
            style={{ backgroundColor: s.bgColor }}
          />
          <button
            onClick={() => setTarget('fg')}
            title="编辑前景色"
            className={`absolute left-0 top-0 h-6 w-6 rounded border ${target === 'fg' ? 'border-[var(--element-bg)] ring-1 ring-[var(--element-bg)]' : 'border-black/20 dark:border-white/20'}`}
            style={{ backgroundColor: s.color }}
          />
        </div>
        <button
          className="btn-press rounded-md p-1.5 text-neutral-500 hover:bg-black/5 dark:text-stone-400 dark:hover:bg-white/10"
          onClick={() => editor.swapColors()}
          title="交换前景/背景 (X)"
        >
          <IconSwap size={14} />
        </button>
        <button
          className="rounded-md px-1.5 py-1 text-[10px] text-neutral-500 hover:bg-black/5 dark:text-stone-400 dark:hover:bg-white/10"
          onClick={() => { editor.setColor('#000000', 'fg'); editor.setColor('#ffffff', 'bg'); }}
          title="重置为黑/白"
        >
          黑／白
        </button>
        <span className="ml-auto text-[10px] text-neutral-400 dark:text-stone-500">
          {target === 'fg' ? '前景色' : '背景色'}
        </span>
      </div>

      <div className="flex items-center gap-1 rounded-lg bg-black/[.04] p-0.5 dark:bg-white/[.04]">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const on = s.colorMode === tab.mode;
          return (
            <button
              key={tab.mode}
              onClick={() => editor.setColorMode(tab.mode)}
              title={tab.label}
              className={`flex flex-1 flex-col items-center gap-0.5 rounded-md py-1 transition-colors ${
                on
                  ? 'bg-[var(--element-bg)] text-white shadow-sm'
                  : 'text-neutral-500 hover:bg-black/5 dark:text-stone-400 dark:hover:bg-white/5'
              }`}
            >
              <Icon active={on} />
              <span className="text-[9px] leading-none">{tab.label}</span>
            </button>
          );
        })}
      </div>

      {s.colorMode === 'wheel' && <ColorWheelView color={active} onChange={setActive} />}
      {s.colorMode === 'rgb' && <RgbSliders color={active} onChange={setActive} />}
      {s.colorMode === 'hsv' && <HsvSliders color={active} onChange={setActive} />}
      {s.colorMode === 'palette' && <PaletteView color={active} recent={s.recentColors} onPick={setActive} />}
    </div>
  );
}
