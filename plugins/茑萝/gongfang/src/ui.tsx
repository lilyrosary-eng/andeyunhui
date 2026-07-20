/// <reference path="../../../global.d.ts" />
// 攻防模块 · 通用 UI 原语
//   CollapsibleSection — 可折叠面板（状态持久化 + 计数 badge + 左侧色条）
//   useHotkeys         — 全局快捷键 Hook（数字键切 Tab / E 导出 / I 信息台 / T 目标）
//   SituationalBar     — 态势感知条（phase/reward/error_rate/qps/generation 实时一行）
//   StatusPill         — 状态药丸（带颜色 + 标签 + 值）
// 设计：复用宿主 React，零新增依赖，专业工具风（Burp/IDA 折叠面板习惯）
const React = window.__HOST_REACT__;
const { useState, useEffect, useCallback, useRef } = React;

// ============ CollapsibleSection ============
type Accent = 'default' | 'attack' | 'defense' | 'info' | 'warn';

const ACCENT_BAR: Record<Accent, string> = {
  default: 'bg-neutral-400',
  attack: 'bg-rose-500',
  defense: 'bg-sky-500',
  info: 'bg-violet-500',
  warn: 'bg-amber-500',
};

interface CollapsibleSectionProps {
  title: string;
  badge?: string | number;
  badgeTone?: 'neutral' | 'emerald' | 'amber' | 'rose' | 'sky' | 'violet';
  defaultOpen?: boolean;
  storageKey?: string;
  accent?: Accent;
  right?: React.ReactNode;
  children: React.ReactNode;
  /** 折叠时是否仍渲染 children（display:none），默认 false（卸载） */
  keepMounted?: boolean;
  className?: string;
  /** 内容区样式（默认 px-4 pb-4 space-y-3） */
  bodyClassName?: string;
}

const BADGE_TONE: Record<NonNullable<CollapsibleSectionProps['badgeTone']>, string> = {
  neutral: 'bg-black/[0.06] dark:bg-white/10 text-neutral-500 dark:text-stone-400',
  emerald: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  amber: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  rose: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  sky: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  violet: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
};

export function CollapsibleSection({
  title,
  badge,
  badgeTone = 'neutral',
  defaultOpen = true,
  storageKey,
  accent = 'default',
  right,
  children,
  keepMounted = false,
  className = '',
  bodyClassName = 'px-4 pb-4 space-y-3',
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState<boolean>(() => {
    if (storageKey) {
      try {
        const v = localStorage.getItem(`gongfang_cs_${storageKey}`);
        if (v !== null) return v === '1';
      } catch {}
    }
    return defaultOpen;
  });

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (storageKey) {
        try {
          localStorage.setItem(`gongfang_cs_${storageKey}`, next ? '1' : '0');
        } catch {}
      }
      return next;
    });
  }, [storageKey]);

  return (
    <section
      className={`relative bg-white/60 dark:bg-white/[0.03] rounded-xl border border-black/5 dark:border-stone-700/50 overflow-hidden ${className}`}
    >
      {/* 左侧色条 */}
      <span className={`absolute left-0 top-0 bottom-0 w-[2px] ${ACCENT_BAR[accent]}`} aria-hidden />

      {/* 标题栏（可点击切换，用 div+role 避免 button 嵌套 button 的 DOM 警告） */}
      <div
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
        className="w-full flex items-center gap-2 pl-4 pr-3 py-2.5 text-left cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.03] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40"
        aria-expanded={open}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`text-neutral-400 transition-transform shrink-0 ${open ? 'rotate-90' : ''}`}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <h3 className="text-sm font-medium text-[var(--element-bg)] truncate">{title}</h3>
        {badge !== undefined && badge !== '' && (
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono tabular-nums shrink-0 ${BADGE_TONE[badgeTone]}`}>
            {badge}
          </span>
        )}
        <div className="flex-1" />
        {right && <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>{right}</div>}
      </div>

      {/* 内容区 */}
      {open ? (
        <div className={bodyClassName}>{children}</div>
      ) : keepMounted ? (
        <div className="hidden">{children}</div>
      ) : null}
    </section>
  );
}

// ============ useHotkeys ============
// 全局快捷键：在 GongfangModule 顶层调用，注册一组快捷键映射
// 约定：忽略 input/textarea/contenteditable 内的按键
type KeyHandler = (e: KeyboardEvent) => void;

interface HotkeySpec {
  key: string;          // 小写键名，如 '1'/'e'/'i'/'t'/'escape'
  ctrl?: boolean;       // 是否需 Ctrl
  shift?: boolean;
  handler: KeyHandler;
  description?: string; // 用于帮助提示
}

export function useHotkeys(specs: HotkeySpec[]) {
  const specsRef = useRef(specs);
  specsRef.current = specs;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 忽略输入框内的按键（除非带 Ctrl）
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isInput = tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable;
      if (isInput && !e.ctrlKey) return;

      const key = e.key.toLowerCase();
      for (const spec of specsRef.current) {
        if (spec.key !== key) continue;
        if (!!spec.ctrl !== e.ctrlKey) continue;
        if (!!spec.shift !== e.shiftKey) continue;
        e.preventDefault();
        spec.handler(e);
        break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

// ============ StatusPill ============
// 紧凑状态药丸：标签 + 值 + 色调
type PillTone = 'neutral' | 'emerald' | 'amber' | 'rose' | 'sky' | 'violet';

const PILL_TONE: Record<PillTone, string> = {
  neutral: 'text-neutral-500 dark:text-stone-400',
  emerald: 'text-emerald-600 dark:text-emerald-400',
  amber: 'text-amber-600 dark:text-amber-400',
  rose: 'text-rose-600 dark:text-rose-400',
  sky: 'text-sky-600 dark:text-sky-400',
  violet: 'text-violet-600 dark:text-violet-400',
};

export function StatusPill({
  label,
  value,
  tone = 'neutral',
  mono = true,
}: {
  label: string;
  value: React.ReactNode;
  tone?: PillTone;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-black/[0.03] dark:bg-white/[0.04]">
      <span className="text-[10px] text-neutral-400">{label}</span>
      <span className={`text-[11px] ${mono ? 'font-mono tabular-nums' : ''} ${PILL_TONE[tone]}`}>{value}</span>
    </div>
  );
}

// ============ SituationalBar ============
// 态势感知条：内核实时状态一行展示（phase/reward/error_rate/qps/generation/elapsed）
// 当 status 为 null 时显示"内核未启动"占位

interface KernelSituation {
  running: boolean;
  phase?: string;
  phaseLabel?: string;
  phaseTone?: PillTone;
  reward?: number;
  errorRate?: number;
  qps?: number;
  generation?: number;
  elapsedMs?: number;
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

export function SituationalBar({ situation }: { situation: KernelSituation }) {
  if (!situation.running) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-black/[0.03] dark:bg-white/[0.03] border border-black/5 dark:border-stone-700/50">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-neutral-400" />
        <span className="text-[11px] text-neutral-400">内核未启动</span>
      </div>
    );
  }

  const errTone: PillTone = situation.errorRate == null
    ? 'neutral'
    : situation.errorRate > 0.5
    ? 'rose'
    : situation.errorRate > 0.2
    ? 'amber'
    : 'emerald';

  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-black/[0.03] dark:bg-white/[0.03] border border-black/5 dark:border-stone-700/50 overflow-x-auto">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px] shadow-emerald-500/60 shrink-0" />
      <StatusPill label="phase" value={situation.phaseLabel ?? situation.phase ?? '—'} tone={situation.phaseTone ?? 'sky'} />
      {situation.reward != null && <StatusPill label="reward" value={situation.reward} tone={situation.reward >= 0 ? 'emerald' : 'rose'} />}
      {situation.errorRate != null && <StatusPill label="err" value={`${(situation.errorRate * 100).toFixed(1)}%`} tone={errTone} />}
      {situation.qps != null && <StatusPill label="qps" value={situation.qps} tone="neutral" />}
      {situation.generation != null && <StatusPill label="gen" value={`#${situation.generation}`} tone="violet" />}
      {situation.elapsedMs != null && <StatusPill label="elapsed" value={fmtElapsed(situation.elapsedMs)} tone="neutral" />}
    </div>
  );
}

// ============ SessionTimer ============
// 内核运行时长计时器：从 startTs 开始累加，每秒刷新
export function useSessionTimer(running: boolean, startTs: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running || !startTs) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running, startTs]);
  if (!running || !startTs) return null;
  return fmtElapsed(now - startTs);
}
