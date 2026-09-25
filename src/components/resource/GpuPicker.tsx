// 资源监视 · 「监视哪几块 GPU」选择器
//
// 为什么需要它：本机（以及任何双显卡笔记本）DXGI 会枚举出核显 + 独显（+ 模拟器/虚拟显示
// 适配器）。之前只能取「独占显存最大的那块」，用户没法切到核显看，也没法同时盯两块。
// 现在列出全部适配器，由用户勾选：全展示 / 都不展示 / 只展示其中一块都支持。
//
// 选择状态存在共享 store（localStorage 持久化），主窗口与浮岛共用同一份。
//
// 两种外观：
//   tone="auto" —— 跟随应用主题（主窗口面板用）
//   tone="dark" —— 恒深色（桌面浮岛本来就是深色，若跟随浅色主题会显得突兀）
import { useEffect, useRef, useState } from 'react';
import { useGpuSelection } from './gpuSelection';
import { fmtBytes, shortGpuName, type GpuUsage } from './model';

export interface GpuPickerLabels {
  trigger: string;
  title: string;
  all: string;
  none: string;
  footer: string;
}

const DEFAULT_LABELS: GpuPickerLabels = {
  trigger: 'GPU 选择',
  title: '监视哪些 GPU',
  all: '全选',
  none: '全不选',
  footer: '功耗与频率只有 NVIDIA 显卡能读（走 NVML）；核显与虚拟显示适配器没有公开接口，显示 —',
};

export function GpuPicker({
  gpus,
  tone = 'auto',
  iconOnly = false,
  labels,
}: {
  gpus: GpuUsage[];
  tone?: 'auto' | 'dark';
  iconOnly?: boolean;
  labels?: Partial<GpuPickerLabels>;
}) {
  const L = { ...DEFAULT_LABELS, ...labels };
  const selected = useGpuSelection((s) => s.selected);
  const toggle = useGpuSelection((s) => s.toggle);
  const setSelected = useGpuSelection((s) => s.set);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 点击面板外部关闭（不吞掉面板内的点击）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const current = selected ?? [];
  const disabled = gpus.length === 0;
  const dark = tone === 'dark';

  const triggerCls = dark
    ? 'appearance-none border-none cursor-pointer rounded-lg px-2 h-7 text-[11px] bg-white/[0.07] text-[#f2f2f4] hover:bg-white/[0.13] transition-colors'
    : 'px-2.5 py-1 rounded-lg text-[11px] bg-white/70 dark:bg-stone-800/70 border border-white/80 dark:border-stone-700/60 text-neutral-600 dark:text-stone-400 hover:bg-white dark:hover:bg-stone-700/70 transition-colors';

  return (
    <div className="relative" ref={boxRef} style={{ flex: '0 0 auto' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title={disabled ? '本机未检测到显卡' : L.title}
        className={`${triggerCls} ${disabled ? 'opacity-50 cursor-default' : ''}`}
      >
        {iconOnly ? (
          <span className="inline-flex items-center gap-1">
            {/* 三横线滑块图标：表示「选择要监视哪几块」 */}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 6h16M4 12h16M4 18h16" />
              <circle cx="9" cy="6" r="2.2" fill="currentColor" stroke="none" />
              <circle cx="15" cy="12" r="2.2" fill="currentColor" stroke="none" />
              <circle cx="8" cy="18" r="2.2" fill="currentColor" stroke="none" />
            </svg>
            <span className="tabular-nums opacity-80">
              {current.length}/{gpus.length}
            </span>
          </span>
        ) : (
          <>
            {L.trigger}
            <span className="ml-1 tabular-nums opacity-70">
              {current.length}/{gpus.length}
            </span>
          </>
        )}
      </button>

      {open && !disabled && (
        <div
          className={
            dark
              ? 'absolute right-0 top-full mt-1.5 z-40 w-80 rounded-xl p-3 shadow-2xl'
              : 'absolute right-0 top-full mt-1.5 z-40 w-80 rounded-xl border border-neutral-200 dark:border-stone-700 bg-white dark:bg-stone-900 shadow-xl p-3'
          }
          style={dark ? { background: 'rgba(14,14,16,0.98)', border: '1px solid rgba(255,255,255,0.12)' } : undefined}
        >
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className={`text-xs font-medium ${dark ? 'text-[#f2f2f4]' : 'text-neutral-700 dark:text-stone-200'}`}>
              {L.title}
            </span>
            <div className="flex gap-1.5">
              <button
                className={`text-[11px] px-2 py-0.5 rounded-md ${dark ? 'text-[#e6c35c] hover:bg-white/10' : 'text-[var(--element-color-raw)] hover:bg-neutral-100 dark:hover:bg-stone-800'}`}
                onClick={() => setSelected(gpus.map((g) => g.id))}
              >
                {L.all}
              </button>
              <button
                className={`text-[11px] px-2 py-0.5 rounded-md ${dark ? 'text-[rgba(242,242,244,0.6)] hover:bg-white/10' : 'text-neutral-500 dark:text-stone-400 hover:bg-neutral-100 dark:hover:bg-stone-800'}`}
                onClick={() => setSelected([])}
              >
                {L.none}
              </button>
            </div>
          </div>

          <div className="flex flex-col max-h-64 overflow-y-auto">
            {gpus.map((g, i) => (
              <label
                key={g.id}
                className={`flex items-start gap-2 rounded-lg px-2 py-1.5 cursor-pointer ${dark ? 'hover:bg-white/[0.06]' : 'hover:bg-neutral-50 dark:hover:bg-stone-800/60'}`}
              >
                <input
                  type="checkbox"
                  checked={current.includes(g.id)}
                  onChange={() => toggle(g.id)}
                  className={`mt-0.5 ${dark ? 'accent-[#e6c35c]' : 'accent-[var(--element-color-raw)]'}`}
                />
                <span className="flex-1 min-w-0">
                  <span className={`block text-xs truncate ${dark ? 'text-[#f2f2f4]' : 'text-neutral-700 dark:text-stone-200'}`}>
                    GPU{i + 1} · {shortGpuName(g.name)}
                  </span>
                  <span className={`block text-[10px] truncate ${dark ? 'text-[rgba(242,242,244,0.45)]' : 'text-neutral-400 dark:text-stone-500'}`}>
                    {g.vram_total_kb ? `独立显存 ${fmtBytes(g.vram_total_kb)}` : '无独立显存'}
                    {g.power_w == null && ' · 无功耗/频率读数'}
                  </span>
                </span>
              </label>
            ))}
          </div>

          <p
            className={`mt-2 pt-2 text-[10px] leading-relaxed ${
              dark
                ? 'text-[rgba(242,242,244,0.4)] border-t border-white/10'
                : 'text-neutral-400 dark:text-stone-500 border-t border-neutral-100 dark:border-stone-800'
            }`}
          >
            {L.footer}
          </p>
        </div>
      )}
    </div>
  );
}

export default GpuPicker;
