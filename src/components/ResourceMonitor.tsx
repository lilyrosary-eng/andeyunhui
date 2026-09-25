import { useEffect, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';

// 与后端 get_resource_usage 返回结构一致
interface DiskUsage {
  mount: string;
  total_kb: number;
  used_kb: number;
  percent: number;
}

interface ResourceUsage {
  cpu_percent: number;
  cpu_per_core: number[];
  mem_total_kb: number;
  mem_used_kb: number;
  mem_percent: number;
  net_up_bps: number;
  net_down_bps: number;
  gpu_percent: number | null;
  gpu_name: string | null;
  vram_total_kb: number | null;
  vram_used_kb: number | null;
  disks: DiskUsage[];
}

const HISTORY = 48; // 保留约 48 个采样点（~48s）用于迷你曲线

function fmtBytes(kb: number): string {
  const gb = kb / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(kb / 1024).toFixed(0)} MB`;
}

function fmtSpeed(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1024 / 1024).toFixed(2)} MB/s`;
}

// 占用率配色：<60 绿，60-85 琥珀，>85 红
function levelColor(p: number): string {
  if (p > 85) return '#ef4444';
  if (p > 60) return '#f59e0b';
  return '#10b981';
}

// 迷你曲线（折线）
function Sparkline({ data, color, max }: { data: number[]; color: string; max?: number }) {
  const w = 240;
  const h = 36;
  if (data.length < 2) {
    return <svg width={w} height={h} className="opacity-40" />;
  }
  const m = max ?? Math.max(1, ...data);
  const step = w / (HISTORY - 1);
  const pts = data
    .map((v, i) => {
      const x = i * step;
      const y = h - Math.min(1, v / m) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const area = `0,${h} ${pts} ${w},${h}`;
  const gid = `g-${color.replace('#', '')}`;
  return (
    <svg width={w} height={h} className="overflow-visible">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gid})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// 横向占用条
function Bar({ percent, color }: { percent: number; color: string }) {
  return (
    <div className="h-2 w-full rounded-full bg-black/5 dark:bg-white/10 overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${Math.max(0, Math.min(100, percent))}%`, background: color }}
      />
    </div>
  );
}

function MetricCard({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl bg-white/50 dark:bg-stone-800/40 border border-white/60 dark:border-stone-700/40 p-4 flex flex-col gap-2">
      {children}
    </div>
  );
}

function StatHeader({ title, live, hint }: { title: string; live: boolean; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-medium text-neutral-500 dark:text-stone-400 shrink-0">{title}</span>
      {hint && <span className="text-[10px] text-neutral-400 dark:text-stone-500 truncate">{hint}</span>}
      {live && (
        <span className="flex items-center gap-1 text-[10px] text-emerald-500 shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          实时
        </span>
      )}
    </div>
  );
}

export function ResourceMonitor() {
  const [data, setData] = useState<ResourceUsage | null>(null);
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number>(0);

  // 历史曲线缓冲（用 ref 避免每次渲染重建）
  const hist = useRef({
    cpu: [] as number[],
    gpu: [] as number[],
    vram: [] as number[],
    mem: [] as number[],
    up: [] as number[],
    down: [] as number[],
  });
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const fetchOnce = async () => {
    try {
      const r = (await invoke('get_resource_usage')) as ResourceUsage;
      setData(r);
      setError('');
      setUpdatedAt(Date.now());
      const h = hist.current;
      const vramPct =
        r.vram_total_kb && r.vram_used_kb != null ? (r.vram_used_kb / r.vram_total_kb) * 100 : 0;
      h.cpu.push(r.cpu_percent);
      h.gpu.push(r.gpu_percent ?? 0);
      h.vram.push(vramPct);
      h.mem.push(r.mem_percent);
      h.up.push(r.net_up_bps);
      h.down.push(r.net_down_bps);
      for (const k of ['cpu', 'gpu', 'vram', 'mem', 'up', 'down'] as const) {
        if (h[k].length > HISTORY) h[k] = h[k].slice(-HISTORY);
      }
    } catch (e) {
      setError((e as Error).message || String(e));
    }
  };

  useEffect(() => {
    fetchOnce();
    const id = setInterval(() => {
      if (!pausedRef.current) fetchOnce();
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const h = hist.current;
  const cpuColor = data ? levelColor(data.cpu_percent) : '#10b981';
  const memColor = data ? levelColor(data.mem_percent) : '#10b981';
  const gpuColor = data?.gpu_percent != null ? levelColor(data.gpu_percent) : '#10b981';
  const vramPct =
    data && data.vram_total_kb && data.vram_used_kb != null
      ? (data.vram_used_kb / data.vram_total_kb) * 100
      : 0;
  const VRAM_COLOR = '#8b5cf6';
  const DISK_COLOR = '#0ea5e9';

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden main-panel-bg fade-in">
      {/* 标题栏 */}
      <div className="flex items-center gap-3 px-6 pt-5 pb-3 shrink-0">
        <div className="w-10 h-10 rounded-xl bg-[var(--element-bg)]/10 flex items-center justify-center text-[var(--element-color-raw)] text-lg font-bold">
          ⚡
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold text-neutral-800 dark:text-stone-100">资源监视</h2>
          <p className="text-xs text-neutral-400 dark:text-stone-500 mt-0.5 truncate">
            CPU · GPU · 显存 · 内存 · 硬盘 · 网络 实时占用
            {updatedAt > 0 && ` · ${new Date(updatedAt).toLocaleTimeString('zh-CN')}`}
          </p>
        </div>
        <button
          onClick={() => setPaused((p) => !p)}
          className="px-3 py-1.5 rounded-lg bg-white/70 dark:bg-stone-800/70 border border-white/80 text-neutral-600 dark:text-stone-400 hover:bg-white transition-colors text-xs"
        >
          {paused ? '继续' : '暂停'}
        </button>
        <button
          onClick={fetchOnce}
          className="px-3 py-1.5 rounded-lg bg-white/70 dark:bg-stone-800/70 border border-white/80 text-neutral-600 dark:text-stone-400 hover:bg-white transition-colors text-xs"
        >
          刷新
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6">
        {error && (
          <div className="mb-3 text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-xl p-3">
            采集失败：{error}
          </div>
        )}

        {!data && !error && (
          <div className="text-sm text-neutral-400 dark:text-stone-500 py-6 text-center">正在采集资源占用…</div>
        )}

        {data && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {/* CPU */}
            <MetricCard>
              <StatHeader title="CPU 占用" live={!paused} hint={`${data.cpu_per_core.length} 核`} />
              <div className="flex items-end gap-2">
                <span className="text-3xl font-bold tabular-nums" style={{ color: cpuColor }}>
                  {data.cpu_percent.toFixed(1)}
                  <span className="text-base">%</span>
                </span>
              </div>
              <Bar percent={data.cpu_percent} color={cpuColor} />
              <Sparkline data={h.cpu} color={cpuColor} max={100} />
              {/* 每核迷你条 */}
              <div className="flex items-end gap-[2px] h-8 mt-1">
                {data.cpu_per_core.map((c, i) => (
                  <div key={i} className="flex-1 flex flex-col items-center justify-end" title={`核 ${i}: ${c.toFixed(1)}%`}>
                    <div
                      className="w-full rounded-sm transition-all duration-500"
                      style={{ height: `${Math.max(2, Math.min(100, c))}%`, background: levelColor(c) }}
                    />
                  </div>
                ))}
              </div>
            </MetricCard>

            {/* GPU 利用率（与显存分开，各自独立成卡） */}
            <MetricCard>
              <StatHeader title="GPU 占用" live={!paused} hint={data.gpu_name ?? undefined} />
              {data.gpu_percent != null ? (
                <>
                  <div className="flex items-end gap-2">
                    <span className="text-3xl font-bold tabular-nums" style={{ color: gpuColor }}>
                      {data.gpu_percent.toFixed(1)}
                      <span className="text-base">%</span>
                    </span>
                  </div>
                  <Bar percent={data.gpu_percent} color={gpuColor} />
                  <Sparkline data={h.gpu} color={gpuColor} max={100} />
                  <p className="text-[10px] text-neutral-400 dark:text-stone-500 leading-relaxed">
                    取最忙图形引擎（与任务管理器口径一致）
                  </p>
                </>
              ) : (
                <div className="text-sm text-neutral-400 dark:text-stone-500 py-4">
                  本机暂不支持 GPU 计数器（N/A）
                </div>
              )}
            </MetricCard>

            {/* 显存占用 */}
            <MetricCard>
              <StatHeader title="显存占用" live={!paused} hint="全机所有进程" />
              {data.vram_total_kb != null && data.vram_used_kb != null ? (
                <>
                  <div className="flex items-end gap-2 flex-wrap">
                    <span className="text-3xl font-bold tabular-nums" style={{ color: vramPct > 85 ? '#ef4444' : vramPct > 60 ? '#f59e0b' : VRAM_COLOR }}>
                      {vramPct.toFixed(0)}
                      <span className="text-base">%</span>
                    </span>
                    <span className="text-xs text-neutral-400 dark:text-stone-500 mb-1">
                      {fmtBytes(data.vram_used_kb)} / {fmtBytes(data.vram_total_kb)}
                    </span>
                  </div>
                  <Bar percent={vramPct} color={VRAM_COLOR} />
                  <Sparkline data={h.vram} color={VRAM_COLOR} max={100} />
                </>
              ) : (
                <div className="text-sm text-neutral-400 dark:text-stone-500 py-4">
                  本机暂不支持显存计数器（N/A）
                </div>
              )}
            </MetricCard>

            {/* 内存 */}
            <MetricCard>
              <StatHeader title="内存占用" live={!paused} />
              <div className="flex items-end gap-2">
                <span className="text-3xl font-bold tabular-nums" style={{ color: memColor }}>
                  {data.mem_percent.toFixed(1)}
                  <span className="text-base">%</span>
                </span>
                <span className="text-xs text-neutral-400 dark:text-stone-500 mb-1">
                  {fmtBytes(data.mem_used_kb)} / {fmtBytes(data.mem_total_kb)}
                </span>
              </div>
              <Bar percent={data.mem_percent} color={memColor} />
              <Sparkline data={h.mem} color={memColor} max={100} />
            </MetricCard>

            {/* 硬盘（各固定分区逐行展示） */}
            <MetricCard>
              <StatHeader title="硬盘占用" live={!paused} hint={`${data.disks.length} 个分区`} />
              {data.disks.length === 0 ? (
                <div className="text-sm text-neutral-400 dark:text-stone-500 py-4">未检测到固定分区</div>
              ) : (
                <div className="flex flex-col gap-2.5 mt-0.5">
                  {data.disks.map((d) => {
                    const c = levelColor(d.percent);
                    return (
                      <div key={d.mount}>
                        <div className="flex items-center justify-between text-[11px] mb-1">
                          <span className="font-medium text-neutral-600 dark:text-stone-300">{d.mount}</span>
                          <span className="text-neutral-400 dark:text-stone-500 tabular-nums">
                            {fmtBytes(d.used_kb)} / {fmtBytes(d.total_kb)}（{d.percent.toFixed(0)}%）
                          </span>
                        </div>
                        <Bar percent={d.percent} color={c} />
                      </div>
                    );
                  })}
                </div>
              )}
            </MetricCard>

            {/* 网络 */}
            <MetricCard>
              <StatHeader title="网络速率" live={!paused} />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-neutral-400 dark:text-stone-500">下行</div>
                  <div className="text-xl font-bold tabular-nums text-sky-500">
                    {fmtSpeed(data.net_down_bps)}
                  </div>
                  <Sparkline data={h.down} color={DISK_COLOR} />
                </div>
                <div>
                  <div className="text-xs text-neutral-400 dark:text-stone-500">上行</div>
                  <div className="text-xl font-bold tabular-nums text-teal-500">
                    {fmtSpeed(data.net_up_bps)}
                  </div>
                  <Sparkline data={h.up} color="#14b8a6" />
                </div>
              </div>
            </MetricCard>
          </div>
        )}
      </div>
    </div>
  );
}

export default ResourceMonitor;
