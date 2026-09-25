// 资源监视（主窗口面板）
//
// 数据来源与口径全部集中在 src/components/resource/：
//   model.ts          —— 接口类型 / 单位换算 / 配色（后端字段口径的唯一前端定义处）
//   useResourceUsage  —— 1s 轮询 + 按显卡分桶的历史曲线
//   gpuSelection      —— 「监视哪几块 GPU」的共享选择（主窗口与浮岛共用）
// 本文件只负责版式。
import { useState, type ReactNode } from 'react';
import {
  fmtBytes,
  fmtDuration,
  fmtFreq,
  fmtMs,
  fmtPercent,
  fmtPower,
  fmtSpeed,
  fmtTemp,
  levelColor,
  shortGpuName,
  vramPercent,
  type GpuUsage,
} from '@/components/resource/model';
import { useResourceUsage } from '@/components/resource/useResourceUsage';
import { NO_GPUS, useSyncedGpuSelection } from '@/components/resource/gpuSelection';
import { GpuPicker } from '@/components/resource/GpuPicker';

const VRAM_COLOR = '#8b5cf6';
const NET_DOWN_COLOR = '#0ea5e9';
const NET_UP_COLOR = '#14b8a6';
const NA_COLOR = '#94a3b8';

// 迷你曲线（折线 + 渐变面积）
function Sparkline({
  data,
  color,
  max,
  height = 36,
}: {
  data: number[];
  color: string;
  max?: number;
  height?: number;
}) {
  const w = 240;
  const h = height;
  if (data.length < 2) return <svg width={w} height={h} className="opacity-40" />;
  const m = max ?? Math.max(1, ...data);
  // span 按「容量」而不是「已有数据条数」算，曲线才不会在缓冲未满时被横向拉伸
  const span = Math.max(1, data.length - 1);
  const step = w / span;
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

/** 一行小字指标（频率 / 功耗 / 读写速度这类附属读数）。
 *  `hint` 用于「这项为什么是 —」的解释，鼠标悬停可见 —— 分发到别人机器上时，
 *  干巴巴的 `—` 会被当成软件坏了，说明原因比换个符号有用得多。 */
function Chips({ items }: { items: { k: string; v: string; hint?: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-neutral-400 dark:text-stone-500">
      {items.map((it) => (
        <span key={it.k} title={it.hint}>
          {it.k} <span className="tabular-nums text-neutral-500 dark:text-stone-400">{it.v}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * 「这块显卡为什么没有功耗/频率/温度」。
 * AMD 是**许可决策**（ADLX 的 SDK 禁止与非宽松许可混用），Intel/NVIDIA 则是**驱动或设备没暴露** ——
 * 两种说法的含义完全不同，所以由后端给出厂商 token 而不是靠显卡名字串猜。
 */
function gpuNoDataHint(g: GpuUsage, what: string): string {
  if (g.vendor === 'amd') return `AMD 显卡的${what}需 ADL/ADLX 接口；本项目因该 SDK 的许可限制未接入`;
  if (g.vendor === 'intel') return `核显/Arc 的${what}由 IGCL（ControlLib.dll）提供，本机驱动未暴露该项`;
  if (g.vendor === 'nvidia') return `NVIDIA 的${what}由 NVML 提供，本机未取到（驱动版本或设备不支持）`;
  return `该适配器（虚拟/基础渲染设备）不提供${what}遥测`;
}

/** 一块显卡的功耗/频率/温度**全部**缺失时的说明（这种卡看起来最像坏了，值得整行写明） */
function gpuAllMissingNote(g: GpuUsage): string {
  if (g.vendor === 'amd') {
    return '该显卡不提供功耗/频率/温度：AMD 传感器需 ADL/ADLX，本项目因许可限制未接入';
  }
  if (g.vendor === 'other') {
    return '该适配器（虚拟/基础渲染设备）不提供功耗/频率/温度';
  }
  return '该显卡的功耗/频率/温度均未取到：厂商遥测接口未在此驱动/设备上暴露';
}

/** 逐引擎利用率：只列出本机真有读数的引擎类型，避免整排「—」占地方 */
function engineItems(g: GpuUsage): { k: string; v: string }[] {
  const pairs: [string, number | null][] = [
    ['3D', g.util_3d],
    ['解码', g.util_video_decode],
    ['编码', g.util_video_encode],
    ['拷贝', g.util_copy],
  ];
  return pairs.flatMap(([k, v]) => (v == null ? [] : [{ k, v: `${Math.round(v)}%` }]));
}

/** 单块显卡的 GPU 占用块；hero=只监视一块时用大字号 */
function GpuUtilBlock({ gpu, hist, hero, label }: { gpu: GpuUsage; hist: number[]; hero: boolean; label: string }) {
  const color = gpu.util_percent != null ? levelColor(gpu.util_percent) : NA_COLOR;
  const engines = engineItems(gpu);
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-neutral-500 dark:text-stone-400 truncate" title={gpu.name}>
          {label}
        </span>
        <span
          className={`font-bold tabular-nums shrink-0 ${hero ? 'text-3xl' : 'text-xl'}`}
          style={{ color }}
        >
          {gpu.util_percent != null ? gpu.util_percent.toFixed(1) : '—'}
          {gpu.util_percent != null && <span className={hero ? 'text-base' : 'text-xs'}>%</span>}
        </span>
      </div>
      <Bar percent={gpu.util_percent ?? 0} color={color} />
      <Chips
        items={[
          {
            k: '频率',
            v: fmtFreq(gpu.clock_mhz),
            hint: gpu.clock_mhz == null ? gpuNoDataHint(gpu, '频率') : undefined,
          },
          {
            k: '功耗',
            v: fmtPower(gpu.power_w),
            hint: gpu.power_w == null ? gpuNoDataHint(gpu, '功耗') : undefined,
          },
          {
            k: '温度',
            v: fmtTemp(gpu.temp_c),
            hint: gpu.temp_c == null ? gpuNoDataHint(gpu, '温度') : undefined,
          },
        ]}
      />
      {engines.length > 0 && (
        <Chips items={[{ k: '引擎', v: engines.map((e) => `${e.k} ${e.v}`).join(' · ') }]} />
      )}
      {/* 三项全缺时整行写明原因：这种卡看起来最像「坏了」 */}
      {gpu.clock_mhz == null && gpu.power_w == null && gpu.temp_c == null && (
        <p className="text-[10px] text-neutral-400 dark:text-stone-500 leading-relaxed">
          {gpuAllMissingNote(gpu)}
        </p>
      )}
      <Sparkline data={hist} color={color} max={100} height={hero ? 36 : 26} />
    </div>
  );
}

/** 单块显卡的显存块 */
function VramBlock({ gpu, hist, hero, label }: { gpu: GpuUsage; hist: number[]; hero: boolean; label: string }) {
  const pct = vramPercent(gpu);
  const color = pct == null ? NA_COLOR : pct > 85 ? '#ef4444' : pct > 60 ? '#f59e0b' : VRAM_COLOR;
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <span className="text-xs text-neutral-500 dark:text-stone-400 truncate" title={gpu.name}>
          {label}
        </span>
        <span className={`font-bold tabular-nums shrink-0 ${hero ? 'text-3xl' : 'text-xl'}`} style={{ color }}>
          {pct != null ? pct.toFixed(0) : '—'}
          {pct != null && <span className={hero ? 'text-base' : 'text-xs'}>%</span>}
        </span>
      </div>
      <Bar percent={pct ?? 0} color={color} />
      <Chips
        items={[
          {
            k: '已用',
            v:
              gpu.vram_used_kb != null && gpu.vram_total_kb != null
                ? `${fmtBytes(gpu.vram_used_kb)} / ${fmtBytes(gpu.vram_total_kb)}`
                : '—',
          },
          // 共享显存：核显的专用显存恒为 0/128MB，不列共享会看起来像坏了
          {
            k: '共享',
            v: gpu.vram_shared_kb != null ? fmtBytes(gpu.vram_shared_kb) : '—',
            hint: gpu.vram_shared_kb == null ? '该适配器未提供共享显存计数器' : undefined,
          },
        ]}
      />
      <Sparkline data={hist} color={color} max={100} height={hero ? 36 : 26} />
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <div className="text-sm text-neutral-400 dark:text-stone-500 py-4">{text}</div>;
}

export function ResourceMonitor() {
  const [paused, setPaused] = useState(false);
  const { data, error, updatedAt, hist, refresh } = useResourceUsage(paused);

  const gpus = data?.gpus ?? NO_GPUS;
  // 只在「用户选择」上做过滤；所有 GPU 相关卡片都走这一份，保证两处卡片的范围一致
  const shown = useSyncedGpuSelection(gpus);
  const multi = shown.length > 1;
  const gpuLabel = (g: GpuUsage) => {
    const idx = gpus.findIndex((x) => x.id === g.id);
    return multi ? `GPU${idx + 1} · ${shortGpuName(g.name)}` : shortGpuName(g.name);
  };

  const cpuColor = data ? levelColor(data.cpu_percent) : '#10b981';
  const memColor = data ? levelColor(data.mem_percent) : '#10b981';
  // 电池配色与「占用率」相反：电量越低越危险（<20% 红、<40% 琥珀）
  const bat = data?.battery;
  const batColor =
    bat?.percent == null ? NA_COLOR : bat.percent < 20 ? '#ef4444' : bat.percent < 40 ? '#f59e0b' : '#10b981';
  // 只列当前真有流量的接口：断开或闲置的口（如未插网线时）列出来只是噪音。
  // 阈值 1 B/s —— 一秒轮询间隔下这点量属于噪声。
  const activeNets = (data?.nets ?? []).filter((n) => n.down_bps > 1 || n.up_bps > 1);

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
            CPU · GPU · 显存 · 内存 · 硬盘 · 网络 实时占用（含频率 / 功耗 / 磁盘 IO）
            {updatedAt > 0 && ` · ${new Date(updatedAt).toLocaleTimeString('zh-CN')}`}
          </p>
        </div>
        <GpuPicker gpus={gpus} />
        <button
          onClick={() => setPaused((p) => !p)}
          className="px-3 py-1.5 rounded-lg bg-white/70 dark:bg-stone-800/70 border border-white/80 dark:border-stone-700/60 text-neutral-600 dark:text-stone-400 hover:bg-white dark:hover:bg-stone-700/70 transition-colors text-xs"
        >
          {paused ? '继续' : '暂停'}
        </button>
        <button
          onClick={() => void refresh()}
          className="px-3 py-1.5 rounded-lg bg-white/70 dark:bg-stone-800/70 border border-white/80 dark:border-stone-700/60 text-neutral-600 dark:text-stone-400 hover:bg-white dark:hover:bg-stone-700/70 transition-colors text-xs"
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
            {/* CPU：占用 + 频率 + 功耗 */}
            <MetricCard>
              <StatHeader title="CPU 占用" live={!paused} hint={`${data.cpu_per_core.length} 核`} />
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold tabular-nums" style={{ color: cpuColor }}>
                  {data.cpu_percent.toFixed(1)}
                  <span className="text-base">%</span>
                </span>
              </div>
              <Bar percent={data.cpu_percent} color={cpuColor} />
              <Chips
                items={[
                  {
                    k: '频率',
                    v: fmtFreq(data.cpu_freq_mhz),
                    hint:
                      data.cpu_freq_mhz == null
                        ? '本机未提供 % Processor Performance 计数器'
                        : undefined,
                  },
                  {
                    k: '功耗',
                    v: fmtPower(data.cpu_power_w),
                    hint:
                      data.cpu_power_w == null
                        ? '该平台未提供 RAPL 功耗计数器（Intel 平台专有）'
                        : undefined,
                  },
                  {
                    k: '温度',
                    v: fmtTemp(data.thermal_temp_c),
                    hint:
                      data.thermal_temp_c == null
                        ? '本机未暴露 ACPI 热区；Windows 无公开的 CPU 核心温度 API（需内核驱动）'
                        : undefined,
                  },
                ]}
              />
              {/* 温度口径必须写出来：ACPI 热区在部分机型上只是主板温区，不是 CPU 核心温度 */}
              {data.thermal_temp_c != null && (
                <p className="text-[10px] text-neutral-400 dark:text-stone-500 leading-relaxed">
                  温度取自 ACPI 热区最高值（部分机型为主板温区，非 CPU 核心温度）
                </p>
              )}
              {/* 功耗与温度**同时**缺失时整行说明（与上一条互斥：那条要求温度有值） */}
              {data.cpu_power_w == null && data.thermal_temp_c == null && (
                <p className="text-[10px] text-neutral-400 dark:text-stone-500 leading-relaxed">
                  功耗与温度均不可用：该平台未提供 RAPL 计数器，且未暴露 ACPI 热区
                </p>
              )}
              <Sparkline data={hist.cpu} color={cpuColor} max={100} />
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

            {/* GPU 利用率：按选中的显卡逐块展示，各自独立聚合（不再把核显的占用当成独显） */}
            <MetricCard>
              <StatHeader
                title="GPU 占用"
                live={!paused}
                hint={multi ? `监视 ${shown.length} 块` : gpus.length ? `${gpus.length} 块可用` : undefined}
              />
              {shown.length === 0 ? (
                <EmptyHint text={gpus.length === 0 ? '本机未检测到显卡' : '未选择要监视的 GPU（点右上「GPU 选择」）'} />
              ) : (
                <div className={multi ? 'flex flex-col gap-3 divide-y divide-black/5 dark:divide-white/5' : ''}>
                  {shown.map((g) => (
                    <div key={g.id} className={multi ? 'pt-3 first:pt-0' : ''}>
                      <GpuUtilBlock
                        gpu={g}
                        hist={hist.gpu[g.id]?.util ?? []}
                        hero={!multi}
                        label={gpuLabel(g)}
                      />
                    </div>
                  ))}
                </div>
              )}
              {shown.length > 0 && (
                <p className="text-[10px] text-neutral-400 dark:text-stone-500 leading-relaxed">
                  取该适配器最忙图形引擎（与任务管理器口径一致）
                </p>
              )}
            </MetricCard>

            {/* 显存占用（与 GPU 占用分开成卡；同为逐块展示） */}
            <MetricCard>
              <StatHeader title="显存占用" live={!paused} hint="全机所有进程" />
              {shown.length === 0 ? (
                <EmptyHint text={gpus.length === 0 ? '本机未检测到显卡' : '未选择要监视的 GPU'} />
              ) : (
                <div className={multi ? 'flex flex-col gap-3 divide-y divide-black/5 dark:divide-white/5' : ''}>
                  {shown.map((g) => (
                    <div key={g.id} className={multi ? 'pt-3 first:pt-0' : ''}>
                      <VramBlock
                        gpu={g}
                        hist={hist.gpu[g.id]?.vram ?? []}
                        hero={!multi}
                        label={gpuLabel(g)}
                      />
                    </div>
                  ))}
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
              <Chips
                items={[
                  {
                    k: '页面文件',
                    v: fmtPercent(data.paging_percent, 0),
                    hint: data.paging_percent == null ? '本机未提供页面文件计数器' : undefined,
                  },
                ]}
              />
              <Sparkline data={hist.mem} color={memColor} max={100} />
            </MetricCard>

            {/* 硬盘：每个分区一行「空间占用 + 实时读/写速度 + 活动度」 */}
            <MetricCard>
              <StatHeader title="硬盘" live={!paused} hint={`${data.disks.length} 个分区`} />
              {data.disks.length === 0 ? (
                <EmptyHint text="未检测到固定分区" />
              ) : (
                <div className="flex flex-col gap-3">
                  {data.disks.map((d) => {
                    const c = levelColor(d.percent);
                    const activity = d.activity;
                    return (
                      <div key={d.mount}>
                        <div className="flex items-center justify-between text-[11px] mb-1 gap-2">
                          <span className="font-medium text-neutral-600 dark:text-stone-300 shrink-0">{d.mount}</span>
                          <span className="text-neutral-400 dark:text-stone-500 tabular-nums truncate">
                            {fmtBytes(d.used_kb)} / {fmtBytes(d.total_kb)}（{d.percent.toFixed(0)}%）
                          </span>
                        </div>
                        <Bar percent={d.percent} color={c} />
                        <div className="mt-1.5">
                          <Chips
                            items={[
                              { k: '读', v: d.read_bps == null ? '—' : fmtSpeed(d.read_bps) },
                              { k: '写', v: d.write_bps == null ? '—' : fmtSpeed(d.write_bps) },
                              { k: '活动', v: fmtPercent(activity, 0) },
                              // 响应时间与队列才是「盘是不是已经成瓶颈」的判据，活动度只说「在忙」
                              {
                                k: '响应',
                                v: fmtMs(d.resp_ms),
                                hint: d.resp_ms == null ? '该卷未提供响应时间计数器' : undefined,
                              },
                              {
                                k: '队列',
                                v: d.queue == null ? '—' : d.queue.toFixed(1),
                                hint: d.queue == null ? '该卷未提供队列长度计数器' : undefined,
                              },
                            ]}
                          />
                        </div>
                        {/* 活动度条：与空间占用条区分开，用中性色 */}
                        <div className="mt-1 h-1 w-full rounded-full bg-black/5 dark:bg-white/10 overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                              width: `${Math.max(0, Math.min(100, activity ?? 0))}%`,
                              background: '#64748b',
                            }}
                          />
                        </div>
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
                  <Sparkline data={hist.down} color={NET_DOWN_COLOR} />
                </div>
                <div>
                  <div className="text-xs text-neutral-400 dark:text-stone-500">上行</div>
                  <div className="text-xl font-bold tabular-nums text-teal-500">
                    {fmtSpeed(data.net_up_bps)}
                  </div>
                  <Sparkline data={hist.up} color={NET_UP_COLOR} />
                </div>
              </div>
              {/* 逐接口明细。虚拟/隧道口标注「不计入」：汇总只累加物理口，
                  否则 Hyper-V vEthernet / VPN 隧道会让同一份流量被算两遍 */}
              {activeNets.length > 0 && (
                <div className="flex flex-col gap-0.5 mt-1">
                  {activeNets.map((n) => (
                    <div key={n.name} className="flex items-center justify-between gap-2 text-[10px]">
                      <span
                        className={`truncate ${
                          n.virtual_iface
                            ? 'text-neutral-300 dark:text-stone-600'
                            : 'text-neutral-500 dark:text-stone-400'
                        }`}
                        title={n.name}
                      >
                        {n.name}
                        {n.virtual_iface && <span className="ml-1 opacity-70">不计入汇总</span>}
                      </span>
                      <span className="tabular-nums shrink-0 text-neutral-400 dark:text-stone-500">
                        ↓ {fmtSpeed(n.down_bps)} · ↑ {fmtSpeed(n.up_bps)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </MetricCard>

            {/* 电池 / 电源：仅「有系统电池」的机器才出这张卡（台式机整卡不出现，不留空位） */}
            {bat?.present && (
              <MetricCard>
                <StatHeader
                  title="电池"
                  live={!paused}
                  hint={bat.ac_online ? '交流供电' : '电池供电'}
                />
                <div className="flex items-end gap-2">
                  <span className="text-3xl font-bold tabular-nums" style={{ color: batColor }}>
                    {bat.percent != null ? bat.percent.toFixed(0) : '—'}
                    {bat.percent != null && <span className="text-base">%</span>}
                  </span>
                  <span className="text-xs text-neutral-400 dark:text-stone-500 mb-1">
                    {bat.charging ? '充电中' : bat.ac_online ? '已接电源' : '放电中'}
                  </span>
                </div>
                <Bar percent={bat.percent ?? 0} color={batColor} />
                <Chips items={[{ k: '剩余时间', v: fmtDuration(bat.seconds_left) }]} />
              </MetricCard>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default ResourceMonitor;
