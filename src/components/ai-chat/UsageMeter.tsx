// AI 用量小圆环 + 悬停面板（参考 dsh 的用量指示：一个小圆环，鼠标悬停展开使用详情）。
// 展示近 30 天累计成本 / 请求数；悬停面板含总览 + 按模型 + 按日的明细。
import { useState } from 'react';
import { useUsageStats, type UsageSummary } from './useUsageStats';

/** 将 cost(USD) 格式化为紧凑可读字符串 */
function fmtCost(cost: number): string {
  if (cost >= 1000) return `$${(cost / 1000).toFixed(1)}k`;
  if (cost >= 100) return `$${cost.toFixed(0)}`;
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(4)}`;
}

function fmtTokens(n: number): string {
  if (!n) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/** 圆环进度：给定 [0,1] 比例与方向，绘制一段弧 */
function Ring({ value }: { value: number }) {
  const R = 15;
  const C = 2 * Math.PI * R;
  const pct = Math.min(Math.max(value, 0), 1);
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" className="-rotate-90">
      <circle cx="20" cy="20" r={R} fill="none" stroke="rgba(128,128,128,0.25)" strokeWidth="4" />
      <circle
        cx="20"
        cy="20"
        r={R}
        fill="none"
        stroke={pct >= 0.9 ? '#f59e0b' : '#0ea5e9'}
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={`${C * pct} ${C}`}
      />
    </svg>
  );
}

function DetailPanel({ stats }: { stats: UsageSummary }) {
  return (
    <div
      className="pointer-events-none absolute right-0 top-full mt-2 w-72 rounded-2xl border bg-white/95 dark:bg-stone-900/95 backdrop-blur-xl p-4 shadow-2xl opacity-0 translate-y-1 transition-all duration-150 group-hover:opacity-100 group-hover:translate-y-0 z-50"
      style={{ borderColor: 'rgba(0,0,0,0.1)' }}
    >
      <div className="flex items-end justify-between mb-3">
        <div>
          <div className="text-[11px] text-neutral-400 dark:text-stone-500">近 30 天 AI 用量</div>
          <div className="text-2xl font-semibold text-neutral-800 dark:text-stone-100">{fmtCost(stats.cost)}</div>
        </div>
        <div className="text-right text-[11px] text-neutral-400 dark:text-stone-500">
          <div>请求 {stats.requests}</div>
          <div>总 token {fmtTokens(stats.totalTokens)}</div>
        </div>
      </div>

      {stats.byModel.length > 0 ? (
        <div className="space-y-1.5 mb-3">
          {stats.byModel.slice(0, 4).map((m) => (
            <div key={m.model} className="flex items-center justify-between text-[11px]">
              <span className="truncate max-w-[150px] text-neutral-600 dark:text-stone-400">{m.model}</span>
              <span className="text-neutral-400 dark:text-stone-500 shrink-0 ml-2">
                {fmtTokens(m.totalTokens)} · {fmtCost(m.cost)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-neutral-400 dark:text-stone-500 mb-3">暂无用量记录</div>
      )}

      {/* 最近 7 天成本迷你柱状图 */}
      <div className="flex items-end gap-1 h-10">
        {stats.byDay.slice(-7).map((d) => {
          const max = Math.max(...stats.byDay.slice(-7).map((x) => x.cost), 0.0001);
          const h = Math.max((d.cost / max) * 100, 2);
          const label = new Date(d.day).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
          return (
            <div key={d.day} className="flex-1 flex flex-col items-center gap-0.5" title={`${label} · ${fmtCost(d.cost)}`}>
              <div className="w-full rounded-sm bg-sky-500/60" style={{ height: `${h}%` }} />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-neutral-400 dark:text-stone-600">
        <span>{stats.byDay.length ? new Date(stats.byDay[Math.max(0, stats.byDay.length - 7)].day).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '-'}</span>
        <span>{stats.byDay.length ? new Date(stats.byDay[stats.byDay.length - 1].day).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '-'}</span>
      </div>
    </div>
  );
}

export interface UsageMeterProps {
  /** 是否暗色皮肤（胶囊形态） */
  dark?: boolean;
  /** 圆环显示的成本饱和基准（USD）。默认按最大合理值自适应。 */
  maxCost?: number;
}

export function UsageMeter({ dark = false, maxCost }: UsageMeterProps) {
  const { stats, reset } = useUsageStats(30);
  // 圆环进度：成本相对一个自适应基准，避免刚用一点就满环。
  const satur = maxCost ?? Math.max(stats.cost, 0.5);
  const ratio = stats.cost / satur;

  return (
    <div className={`relative group ${dark ? 'text-white/70' : 'text-neutral-500'} cursor-default`}>
      <button
        onClick={() => void reset()}
        title="点击清空用量统计"
        className={`flex items-center gap-1 rounded-lg px-1 py-0.5 transition-colors ${dark ? 'hover:bg-white/10' : 'hover:bg-black/5'}`}
      >
        <Ring value={ratio} />
        <span className="text-[11px] leading-none">{fmtCost(stats.cost)}</span>
      </button>
      <DetailPanel stats={stats} />
    </div>
  );
}

export default UsageMeter;