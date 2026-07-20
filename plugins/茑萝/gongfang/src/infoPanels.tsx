/// <reference path="../../../global.d.ts" />
// 攻防模块 · P0 通用信息层组件
// 四大组件：EventStream（事件流）/ MetricsChart（时序图）/ AiReasoningPanel（推理日志）/ TargetWorkspace（目标工作区）
// 设计：订阅 gongfang_event 实时事件 + 拉取历史快照，双轨制内核完全白盒化
const React = window.__HOST_REACT__;
const { useState, useEffect, useRef, useCallback, useMemo } = React;
const hostApi = window.__HOST_API__;

import { CollapsibleSection } from './ui';

// ============ Tauri invoke 封装（攻防命令未加入插件沙箱白名单） ============
const tauriInvoke = <T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { invoke: <U = T>(c: string, a?: Record<string, unknown>) => Promise<U> };
  };
  if (!w.__TAURI_INTERNALS__?.invoke) {
    return Promise.reject(new Error('Tauri 运行时不可用'));
  }
  return w.__TAURI_INTERNALS__.invoke<T>(cmd, args);
};

// ============ 类型定义（与 Rust 端 events.rs 对齐） ============
type Phase = 'Idle' | 'Recon' | 'Exploit' | 'Pivot' | 'Clean';
type EventKind = 'Credential' | 'Success' | 'Rejected' | 'WafAlert' | 'Timeout' | 'ValidationError';
type ReasoningLevel = 'L0' | 'L1' | 'L2' | 'L0_FALLBACK';
type LogLevel = 'info' | 'warn' | 'error';

interface StrategyDelta {
  qps?: number | null;
  per_ip_concurrency?: number | null;
  tls_profile?: string | null;
  stealth_level?: number | null;
  focus_url?: string | null;
  use_browser?: boolean | null;
  proxy_pool_tag?: string | null;
  phase?: Phase | null;
}

interface KernelEvent {
  kind: string;
  ts: number;
  // 各 kind 独立字段（联合类型简化为单一接口）
  generation?: number;
  phase?: Phase;
  delta?: StrategyDelta;
  new_strategy?: unknown;
  event_kind?: EventKind;
  total_reward?: number;
  error_rate?: number;
  level?: ReasoningLevel;
  latency_ms?: number;
  success?: boolean;
  error?: string | null;
  prompt_summary?: string;
  response_summary?: string;
  cmd?: unknown;
  priority?: string;
  focus_url?: string | null;
  remaining_ticks?: number;
  from_gen?: number;
  to_gen?: number;
  target?: string;
  msg?: string;
}

interface MetricSample {
  ts: number;
  reward: number;
  error_rate: number;
  qps: number;
  stealth_level: number;
  generation: number;
}

interface ReasoningEntry {
  ts: number;
  level: ReasoningLevel;
  latency_ms: number;
  success: boolean;
  error: string | null;
  prompt_summary: string;
  response_summary: string;
  delta: StrategyDelta;
}

interface TargetSummary {
  id: string;
  name: string;
  address: string;
  kind: string;
  created_at: number;
  last_active_at: number;
  note: string;
  tags: string[];
  is_active: boolean;
}

// ============ 工具函数 ============
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function fmtRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  return `${Math.floor(diff / 86_400_000)}天前`;
}

// ============ 事件类型元数据（颜色/标签/中文说明） ============
const EVENT_META: Record<string, { color: string; bg: string; label: string }> = {
  tick: { color: 'text-neutral-400', bg: 'bg-neutral-500/10', label: 'TICK' },
  strategy_committed: { color: 'text-violet-600 dark:text-violet-400', bg: 'bg-violet-500/10', label: '策略' },
  reward_recorded: { color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-500/10', label: '奖励' },
  ai_reasoning: { color: 'text-sky-600 dark:text-sky-400', bg: 'bg-sky-500/10', label: '推理' },
  user_command_injected: { color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-500/10', label: '指令' },
  phase_executed: { color: 'text-indigo-600 dark:text-indigo-400', bg: 'bg-indigo-500/10', label: '阶段' },
  soft_landing: { color: 'text-cyan-600 dark:text-cyan-400', bg: 'bg-cyan-500/10', label: '软着陆' },
  rollback: { color: 'text-rose-600 dark:text-rose-400', bg: 'bg-rose-500/10', label: '回滚' },
  kernel_started: { color: 'text-emerald-700 dark:text-emerald-300', bg: 'bg-emerald-600/15', label: '启动' },
  kernel_stopped: { color: 'text-neutral-600 dark:text-stone-300', bg: 'bg-neutral-600/15', label: '停止' },
  log: { color: 'text-neutral-500 dark:text-stone-400', bg: 'bg-neutral-500/5', label: '日志' },
};

function eventSummary(ev: KernelEvent): string {
  switch (ev.kind) {
    case 'tick':
      return `gen=${ev.generation} phase=${ev.phase}`;
    case 'strategy_committed':
      return `gen=${ev.generation} ${deltaSummary(ev.delta)}`;
    case 'reward_recorded':
      return `${ev.event_kind} → 奖励 ${ev.total_reward} 错误率 ${(ev.error_rate * 100).toFixed(1)}%`;
    case 'ai_reasoning':
      return `${ev.level} ${ev.latency_ms}ms ${ev.success ? '✓' : '✗'} ${ev.response_summary?.slice(0, 60) ?? ''}`;
    case 'user_command_injected':
      return `[${ev.priority}] ${typeof ev.cmd === 'object' ? JSON.stringify(ev.cmd) : String(ev.cmd)}`;
    case 'phase_executed':
      return `${ev.phase}${ev.focus_url ? ' @ ' + ev.focus_url : ''}`;
    case 'soft_landing':
      return `剩余 ${ev.remaining_ticks} tick`;
    case 'rollback':
      return `gen ${ev.from_gen} → ${ev.to_gen}`;
    case 'kernel_started':
      return '双轨制内核已启动';
    case 'kernel_stopped':
      return '双轨制内核已停止';
    case 'log':
      return `[${ev.target}] ${ev.msg}`;
    default:
      return JSON.stringify(ev);
  }
}

function deltaSummary(delta?: StrategyDelta): string {
  if (!delta) return '';
  const parts: string[] = [];
  if (delta.qps != null) parts.push(`qps=${delta.qps}`);
  if (delta.stealth_level != null) parts.push(`stealth=${delta.stealth_level}`);
  if (delta.phase != null) parts.push(`phase=${delta.phase}`);
  if (delta.tls_profile != null) parts.push(`tls=${delta.tls_profile}`);
  if (delta.focus_url != null) parts.push(`focus=${delta.focus_url || '∅'}`);
  if (delta.use_browser != null) parts.push(`browser=${delta.use_browser}`);
  if (delta.per_ip_concurrency != null) parts.push(`conc=${delta.per_ip_concurrency}`);
  if (delta.proxy_pool_tag != null) parts.push(`proxy=${delta.proxy_pool_tag}`);
  return parts.join(' ');
}

// ============================================================
// 组件 1：EventStream — 内核事件流（底部全局事件流）
// ============================================================
const FILTER_OPTIONS = [
  { key: 'strategy_committed', label: '策略' },
  { key: 'reward_recorded', label: '奖励' },
  { key: 'ai_reasoning', label: '推理' },
  { key: 'user_command_injected', label: '指令' },
  { key: 'phase_executed', label: '阶段' },
  { key: 'soft_landing', label: '软着陆' },
  { key: 'rollback', label: '回滚' },
  { key: 'kernel_started', label: '启动' },
  { key: 'kernel_stopped', label: '停止' },
  { key: 'log', label: '日志' },
];

export function EventStream({ height = 220 }: { height?: number }) {
  const [events, setEvents] = useState<KernelEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [filterSet, setFilterSet] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  // rAF 批量更新：高频事件先缓冲到 ref，下一帧统一 flush（避免 50ms 内多次 setState）
  const bufferRef = useRef<KernelEvent[]>([]);
  const rafRef = useRef<number | null>(null);

  // 初始化：拉取历史 + 订阅实时事件
  useEffect(() => {
    let unsub: (() => void) | null = null;
    tauriInvoke<KernelEvent[]>('gongfang_events_recent', { n: 100 })
      .then((hist) => setEvents(hist))
      .catch(() => {});

    hostApi
      .listen<KernelEvent>('gongfang_event', (e) => {
        if (pausedRef.current) return;
        bufferRef.current.push(e.payload);
        // 限制缓冲区大小
        if (bufferRef.current.length > 50) bufferRef.current.splice(0, bufferRef.current.length - 50);
        // rAF 批量 flush
        if (rafRef.current === null) {
          rafRef.current = requestAnimationFrame(() => {
            rafRef.current = null;
            const batch = bufferRef.current;
            bufferRef.current = [];
            if (batch.length === 0) return;
            setEvents((prev) => {
              const next = prev.concat(batch);
              if (next.length > 500) next.splice(0, next.length - 500);
              return next;
            });
          });
        }
      })
      .then((u) => (unsub = u))
      .catch(() => {});

    return () => {
      if (unsub) unsub();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // 自动滚动到底部（节流：rAF）
  const scrollRafRef = useRef<number | null>(null);
  useEffect(() => {
    if (paused) return;
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, [events, paused]);

  const filtered = useMemo(() => {
    if (filterSet.size === 0) return events;
    return events.filter((e) => filterSet.has(e.kind));
  }, [events, filterSet]);

  // 渲染窗口：只渲染最后 80 条（避免 500 条 DOM 导致卡顿）
  const visibleEvents = useMemo(() => {
    const MAX_VISIBLE = 80;
    if (filtered.length <= MAX_VISIBLE) return filtered;
    return filtered.slice(filtered.length - MAX_VISIBLE);
  }, [filtered]);

  const toggleFilter = (key: string) => {
    setFilterSet((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <CollapsibleSection
      title="事件流"
      badge={`${filtered.length} 条`}
      badgeTone="sky"
      storageKey="info_event_stream"
      bodyClassName="space-y-2 px-0 pb-0"
      right={
        <>
          <button
            onClick={() => setPaused((p) => !p)}
            className={`btn-press px-2 py-0.5 rounded text-[11px] border ${
              paused
                ? 'border-amber-500/40 bg-amber-500/15 text-amber-600 dark:text-amber-400'
                : 'border-black/10 dark:border-stone-700/50 text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5'
            }`}
            title={paused ? '继续' : '暂停'}
          >
            {paused ? '⏸ 已暂停' : '▶ 实时'}
          </button>
          <button
            onClick={() => setEvents([])}
            className="btn-press px-2 py-0.5 rounded text-[11px] text-neutral-500 dark:text-stone-400 border border-black/10 dark:border-stone-700/50 hover:bg-black/5 dark:hover:bg-white/5"
            title="清空"
          >
            清空
          </button>
        </>
      }
    >
      {/* 过滤器条 */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-black/5 dark:border-stone-700/40 flex-wrap">
        <span className="text-[10px] text-neutral-400 mr-1">过滤:</span>
        {FILTER_OPTIONS.map((opt) => {
          const active = filterSet.size === 0 || filterSet.has(opt.key);
          return (
            <button
              key={opt.key}
              onClick={() => toggleFilter(opt.key)}
              className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                active
                  ? 'bg-black/5 dark:bg-white/10 text-neutral-700 dark:text-stone-200'
                  : 'text-neutral-400 line-through'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
        {filterSet.size > 0 && (
          <button
            onClick={() => setFilterSet(new Set())}
            className="px-1.5 py-0.5 rounded text-[10px] text-sky-600 dark:text-sky-400 hover:underline"
          >
            全部
          </button>
        )}
      </div>

      {/* 事件列表 */}
      <div
        ref={scrollRef}
        className="overflow-y-auto font-mono text-[11px] leading-relaxed px-3 py-2 space-y-0.5"
        style={{ height }}
      >
        {filtered.length === 0 ? (
          <div className="text-center text-neutral-400 py-8 text-xs">等待内核事件...</div>
        ) : (
          <>
            {visibleEvents.length < filtered.length && (
              <div className="text-center text-[10px] text-neutral-400 py-1 border-b border-dashed border-black/5 dark:border-stone-700/40 mb-1">
                ↑ 仅显示最近 {visibleEvents.length} 条（共 {filtered.length} 条）
              </div>
            )}
            {visibleEvents.map((ev, i) => {
            const meta = EVENT_META[ev.kind] ?? EVENT_META.log;
            return (
              <div key={`${ev.ts}-${i}`} className={`flex items-start gap-2 px-1.5 py-0.5 rounded ${meta.bg}`}>
                <span className="text-neutral-400 shrink-0 tabular-nums">{fmtTime(ev.ts)}</span>
                <span className={`shrink-0 font-semibold ${meta.color}`}>[{meta.label}]</span>
                <span className="text-neutral-700 dark:text-stone-300 break-all">{eventSummary(ev)}</span>
              </div>
            );
          })}
          </>
        )}
      </div>
    </CollapsibleSection>
  );
}

// ============================================================
// 组件 2：MetricsChart — 时序指标图（lightweight-charts 4 曲线）
// ============================================================
export function MetricsChart({ height = 220 }: { height?: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<unknown | null>(null);
  const seriesRef = useRef<Record<string, unknown>>({});
  const [seconds, setSeconds] = useState(300);
  const [lastUpdate, setLastUpdate] = useState(0);

  // 初始化图表
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;

    // 动态 import 避免阻塞首屏
    import('lightweight-charts')
      .then(({ createChart, LineSeries, ColorType, CrosshairMode }) => {
        if (disposed || !container) return;
        const chart = createChart(container, {
          width: container.clientWidth,
          height,
          layout: {
            background: { type: ColorType.Solid, color: 'transparent' },
            textColor: '#999',
            fontSize: 10,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          },
          grid: {
            vertLines: { color: 'rgba(120,120,120,0.08)' },
            horzLines: { color: 'rgba(120,120,120,0.08)' },
          },
          crosshair: { mode: CrosshairMode.Normal },
          rightPriceScale: { borderColor: 'rgba(120,120,120,0.2)' },
          timeScale: {
            borderColor: 'rgba(120,120,120,0.2)',
            timeVisible: true,
            secondsVisible: true,
          },
        });
        chartRef.current = chart;

        const rewardSeries = chart.addSeries(LineSeries, {
          color: '#10b981',
          lineWidth: 2,
          priceScaleId: 'left',
          title: '奖励',
        });
        const errSeries = chart.addSeries(LineSeries, {
          color: '#ef4444',
          lineWidth: 2,
          priceScaleId: 'right',
          title: '错误率',
        });
        const qpsSeries = chart.addSeries(LineSeries, {
          color: '#3b82f6',
          lineWidth: 1,
          priceScaleId: 'right',
          title: 'QPS',
        });
        const stealthSeries = chart.addSeries(LineSeries, {
          color: '#a855f7',
          lineWidth: 1,
          priceScaleId: 'right',
          title: '隐身',
        });
        seriesRef.current = { reward: rewardSeries, err: errSeries, qps: qpsSeries, stealth: stealthSeries };
      })
      .catch(() => {});

    // 响应式
    const ro = new ResizeObserver(() => {
      const chart = chartRef.current as { applyWidth?: (w: number) => void; resize?: (w: number, h: number) => void } | null;
      if (chart && container) {
        try {
          (chart as { applyWidth: (w: number) => void }).applyWidth(container.clientWidth);
        } catch {
          /* v5 使用 applyWidth */
        }
      }
    });
    ro.observe(container);

    return () => {
      disposed = true;
      ro.disconnect();
      const chart = chartRef.current as { remove?: () => void } | null;
      if (chart?.remove) chart.remove();
      chartRef.current = null;
      seriesRef.current = {};
    };
  }, [height]);

  // 拉取数据
  const refresh = useCallback(async () => {
    try {
      const data = await tauriInvoke<MetricSample[]>('gongfang_metrics_history', { seconds });
      const series = seriesRef.current as {
        reward?: { setData?: (d: unknown[]) => void };
        err?: { setData?: (d: unknown[]) => void };
        qps?: { setData?: (d: unknown[]) => void };
        stealth?: { setData?: (d: unknown[]) => void };
      };
      if (!series.reward) return;

      // time 必须是秒级 UTCTimestamp
      const rewardData = data.map((m) => ({ time: Math.floor(m.ts / 1000) as never, value: m.reward }));
      const errData = data.map((m) => ({ time: Math.floor(m.ts / 1000) as never, value: m.error_rate * 100 }));
      const qpsData = data.map((m) => ({ time: Math.floor(m.ts / 1000) as never, value: m.qps }));
      const stealthData = data.map((m) => ({ time: Math.floor(m.ts / 1000) as never, value: m.stealth_level }));

      series.reward.setData?.(rewardData);
      series.err.setData?.(errData);
      series.qps.setData?.(qpsData);
      series.stealth.setData?.(stealthData);
      setLastUpdate(Date.now());
    } catch {
      /* 内核未启动 */
    }
  }, [seconds]);

  // 定时刷新
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  const chart = chartRef.current as { timeScale?: () => { fitContent?: () => void } } | null;
  if (chart?.timeScale) {
    try {
      chart.timeScale().fitContent?.();
    } catch {
      /* ignore */
    }
  }

  return (
    <CollapsibleSection
      title="时序指标"
      badge={lastUpdate > 0 ? '实时' : '无数据'}
      badgeTone={lastUpdate > 0 ? 'emerald' : 'neutral'}
      storageKey="info_metrics_chart"
      bodyClassName="space-y-1 px-0 pb-0"
      right={
        <>
          <div className="hidden sm:flex items-center gap-1.5 text-[10px] mr-1">
            <span className="flex items-center gap-0.5">
              <span className="inline-block w-2 h-0.5 bg-emerald-500" />奖励
            </span>
            <span className="flex items-center gap-0.5">
              <span className="inline-block w-2 h-0.5 bg-rose-500" />错误率
            </span>
            <span className="flex items-center gap-0.5">
              <span className="inline-block w-2 h-0.5 bg-blue-500" />QPS
            </span>
            <span className="flex items-center gap-0.5">
              <span className="inline-block w-2 h-0.5 bg-purple-500" />隐身
            </span>
          </div>
          {[60, 300, 1800].map((s) => (
            <button
              key={s}
              onClick={() => setSeconds(s)}
              className={`btn-press px-1.5 py-0.5 rounded text-[10px] ${
                seconds === s
                  ? 'bg-black/10 dark:bg-white/15 text-[var(--element-bg)]'
                  : 'text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5'
              }`}
            >
              {s < 60 ? `${s}s` : s < 3600 ? `${s / 60}m` : `${s / 3600}h`}
            </button>
          ))}
          <button
            onClick={refresh}
            className="btn-press px-2 py-0.5 rounded text-[11px] text-neutral-500 dark:text-stone-400 border border-black/10 dark:border-stone-700/50 hover:bg-black/5 dark:hover:bg-white/5"
            title="立即刷新"
          >
            ↻
          </button>
        </>
      }
    >
      <div ref={containerRef} style={{ height }} className="w-full" />
      {lastUpdate === 0 && (
        <div className="text-center text-[10px] text-neutral-400 py-1">
          内核未启动或无数据
        </div>
      )}
    </CollapsibleSection>
  );
}

// ============================================================
// 组件 3：AiReasoningPanel — AI 推理日志（推理过程白盒化）
// ============================================================
const LEVEL_META: Record<ReasoningLevel, { color: string; label: string }> = {
  L0: { color: 'bg-neutral-500/15 text-neutral-600 dark:text-stone-300', label: 'L0 规则' },
  L1: { color: 'bg-sky-500/15 text-sky-600 dark:text-sky-400', label: 'L1 轻量' },
  L2: { color: 'bg-violet-500/15 text-violet-600 dark:text-violet-400', label: 'L2 深度' },
  L0_FALLBACK: { color: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', label: 'L0 兜底' },
};

export function AiReasoningPanel({ height = 280 }: { height?: number }) {
  const [entries, setEntries] = useState<ReasoningEntry[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await tauriInvoke<ReasoningEntry[]>('gongfang_ai_reasoning_recent', { n: 20 });
      setEntries(data);
    } catch {
      /* 内核未启动 */
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <CollapsibleSection
      title="AI 推理日志"
      badge={`${entries.length} 条`}
      badgeTone="violet"
      storageKey="info_ai_reasoning"
      bodyClassName="px-0 pb-0"
      right={
        <button
          onClick={refresh}
          className="btn-press px-2 py-0.5 rounded text-[11px] text-neutral-500 dark:text-stone-400 border border-black/10 dark:border-stone-700/50 hover:bg-black/5 dark:hover:bg-white/5"
          title="刷新"
        >
          ↻
        </button>
      }
    >
      <div className="overflow-y-auto px-3 py-2 space-y-2" style={{ height }}>
        {entries.length === 0 ? (
          <div className="text-center text-neutral-400 py-8 text-xs">
            暂无推理记录
            <div className="text-[10px] mt-1">启动内核后，AI 每 500ms 推理一次</div>
          </div>
        ) : (
          entries.map((e, i) => {
            const meta = LEVEL_META[e.level] ?? LEVEL_META.L0;
            const isExpanded = expanded === i;
            return (
              <div
                key={i}
                className="rounded-lg border border-black/5 dark:border-stone-700/40 bg-black/[0.02] dark:bg-white/[0.02] overflow-hidden"
              >
                <div
                  className="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                  onClick={() => setExpanded(isExpanded ? null : i)}
                >
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${meta.color}`}>
                    {meta.label}
                  </span>
                  <span className="text-[10px] text-neutral-500 dark:text-stone-400 tabular-nums">
                    {e.latency_ms}ms
                  </span>
                  <span className={`text-[10px] ${e.success ? 'text-emerald-500' : 'text-rose-500'}`}>
                    {e.success ? '✓' : '✗'}
                  </span>
                  <span className="text-[10px] text-neutral-400 ml-auto tabular-nums">{fmtTime(e.ts)}</span>
                </div>
                <div className="px-2 pb-1.5 text-[11px] text-neutral-600 dark:text-stone-300">
                  <div className="text-neutral-500 dark:text-stone-400">
                    <span className="text-neutral-400">Prompt:</span> {e.prompt_summary || '(空)'}
                  </div>
                  {!e.success && e.error && (
                    <div className="text-rose-500 mt-0.5">错误: {e.error}</div>
                  )}
                  {isExpanded && (
                    <>
                      <div className="text-neutral-700 dark:text-stone-200 mt-1">
                        <span className="text-neutral-400">Response:</span> {e.response_summary || '(空)'}
                      </div>
                      {e.delta && Object.keys(e.delta).length > 0 && (
                        <div className="mt-1 text-violet-600 dark:text-violet-400">
                          <span className="text-neutral-400">Delta:</span> {deltaSummary(e.delta) || '(无变更)'}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </CollapsibleSection>
  );
}

// ============================================================
// 组件 4：TargetWorkspace — 目标工作区（侧栏多目标管理）
// ============================================================
const KIND_META: Record<string, { icon: string; color: string; label: string }> = {
  crawler: { icon: '🕸', color: 'text-emerald-600 dark:text-emerald-400', label: '爬虫' },
  pentest: { icon: '🎯', color: 'text-rose-600 dark:text-rose-400', label: '渗透' },
  reverse: { icon: '🔍', color: 'text-violet-600 dark:text-violet-400', label: '逆向' },
  automation: { icon: '🤖', color: 'text-sky-600 dark:text-sky-400', label: '自动化' },
  gateway: { icon: '🌐', color: 'text-amber-600 dark:text-amber-400', label: '网关' },
  general: { icon: '📍', color: 'text-neutral-500 dark:text-stone-400', label: '通用' },
};

export function TargetWorkspace({ onActivate }: { onActivate?: (target: TargetSummary) => void }) {
  const [targets, setTargets] = useState<TargetSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', address: '', kind: 'general', note: '' });

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await tauriInvoke<TargetSummary[]>('gongfang_target_list');
      setTargets(data);
    } catch {
      /* 内核未启动 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSave = async () => {
    if (!form.name.trim() || !form.address.trim()) return;
    try {
      await tauriInvoke('gongfang_target_save', {
        req: {
          name: form.name.trim(),
          address: form.address.trim(),
          kind: form.kind,
          note: form.note.trim() || null,
          tags: null,
        },
      });
      setForm({ name: '', address: '', kind: 'general', note: '' });
      setShowForm(false);
      refresh();
    } catch (e) {
      alert(`保存失败: ${e}`);
    }
  };

  const handleActivate = async (id: string) => {
    try {
      await tauriInvoke('gongfang_target_activate', { id });
      refresh();
      const t = targets.find((x) => x.id === id);
      if (t && onActivate) onActivate({ ...t, is_active: true });
    } catch (e) {
      alert(`激活失败: ${e}`);
    }
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('确认删除该目标？相关元数据将一并清除。')) return;
    try {
      await tauriInvoke('gongfang_target_delete', { id });
      refresh();
    } catch (err) {
      alert(`删除失败: ${err}`);
    }
  };

  return (
    <div className="flex flex-col h-full bg-white/60 dark:bg-white/[0.03] rounded-xl border border-black/5 dark:border-stone-700/50 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-black/5 dark:border-stone-700/40 bg-black/[0.02] dark:bg-white/[0.02]">
        <span className="text-xs font-semibold text-[var(--element-bg)]">目标工作区</span>
        <span className="text-[10px] text-neutral-400">{targets.length}</span>
        <div className="flex-1" />
        <button
          onClick={() => setShowForm((v) => !v)}
          className="btn-press px-2 py-0.5 rounded text-[11px] text-sky-600 dark:text-sky-400 border border-sky-500/30 hover:bg-sky-500/10"
          title="新建目标"
        >
          {showForm ? '取消' : '+ 新建'}
        </button>
        <button
          onClick={refresh}
          className="btn-press px-2 py-0.5 rounded text-[11px] text-neutral-500 dark:text-stone-400 border border-black/10 dark:border-stone-700/50 hover:bg-black/5 dark:hover:bg-white/5"
          title="刷新"
        >
          ↻
        </button>
      </div>

      {/* 新建目标表单 */}
      {showForm && (
        <div className="px-3 py-2 border-b border-black/5 dark:border-stone-700/40 bg-black/[0.02] dark:bg-white/[0.02] space-y-1.5">
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="名称（如：测试站 A）"
            className="w-full px-2 py-1 rounded text-xs bg-white dark:bg-stone-900 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] placeholder:text-neutral-400 focus:outline-none focus:border-sky-500/50"
          />
          <input
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
            placeholder="地址（URL / IP / 文件路径）"
            className="w-full px-2 py-1 rounded text-xs bg-white dark:bg-stone-900 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] placeholder:text-neutral-400 focus:outline-none focus:border-sky-500/50"
          />
          <div className="flex gap-1.5">
            <select
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
              className="px-2 py-1 rounded text-xs bg-white dark:bg-stone-900 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)]"
            >
              {Object.entries(KIND_META).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
            <input
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder="备注（可选）"
              className="flex-1 px-2 py-1 rounded text-xs bg-white dark:bg-stone-900 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] placeholder:text-neutral-400 focus:outline-none focus:border-sky-500/50"
            />
            <button
              onClick={handleSave}
              className="btn-press px-3 py-1 rounded text-xs bg-sky-500/15 text-sky-600 dark:text-sky-400 hover:bg-sky-500/25"
            >
              保存
            </button>
          </div>
        </div>
      )}

      {/* 目标列表 */}
      <div className="flex-1 overflow-y-auto">
        {loading && targets.length === 0 ? (
          <div className="text-center text-neutral-400 py-8 text-xs">加载中...</div>
        ) : targets.length === 0 ? (
          <div className="text-center text-neutral-400 py-8 text-xs">
            暂无目标
            <div className="text-[10px] mt-1">点击「+ 新建」添加攻防目标</div>
          </div>
        ) : (
          targets.map((t) => {
            const meta = KIND_META[t.kind] ?? KIND_META.general;
            return (
              <div
                key={t.id}
                onClick={() => handleActivate(t.id)}
                className={`group px-3 py-2 border-b border-black/5 dark:border-stone-700/30 cursor-pointer transition-colors ${
                  t.is_active
                    ? 'bg-sky-500/10 hover:bg-sky-500/15'
                    : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm">{meta.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-xs font-medium truncate ${meta.color}`}>{t.name}</span>
                      {t.is_active && (
                        <span className="px-1 py-0.5 rounded text-[9px] bg-sky-500/20 text-sky-600 dark:text-sky-400">
                          激活
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-neutral-500 dark:text-stone-400 truncate font-mono">
                      {t.address}
                    </div>
                  </div>
                  <button
                    onClick={(e) => handleDelete(t.id, e)}
                    className="opacity-0 group-hover:opacity-100 btn-press px-1.5 py-0.5 rounded text-[10px] text-rose-500 hover:bg-rose-500/10 transition-opacity"
                    title="删除"
                  >
                    ✕
                  </button>
                </div>
                <div className="flex items-center gap-2 mt-0.5 text-[9px] text-neutral-400">
                  <span>{meta.label}</span>
                  <span>·</span>
                  <span>{fmtRelative(t.last_active_at)}</span>
                  {t.tags.length > 0 && (
                    <>
                      <span>·</span>
                      <span className="truncate">{t.tags.join(',')}</span>
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
