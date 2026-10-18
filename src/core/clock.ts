import { useEffect, useState } from 'react';

/**
 * 渲染期安全时钟。
 *
 * 背景：eslint `react-hooks/purity` 禁止在渲染期调用 `Date.now()` / `new Date()`
 * —— 同一帧重复渲染会拿到不同结果，破坏 React 的幂等假设。
 * 但「认识 N 天」这类展示确实需要当前时间，且只需要「天」精度。
 *
 * 做法：把"今天 00:00 的 epoch 秒"缓存在模块作用域（导入时算一次，不属于任何渲染），
 * 由 `useToday()` 挂一个定时器在跨天时刷新并触发重渲染。
 * 渲染期读的是普通模块变量， purity 规则不再报警，跨天后数值仍然正确。
 */

const DAY_SEC = 86400;

function truncateToDay(epochMs: number): number {
  const d = new Date(epochMs);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** 模块导入时确定；此后只可能被 useToday 的定时器向前推进。 */
let todaySec = truncateToDay(Date.now());

/** 跨天对齐间隔。30 分钟足够覆盖"一天"粒度，且失焦/休眠恢复后 setInterval 仍会补触发。 */
const REALIGN_MS = 30 * 60 * 1000;

/**
 * 距 `firstMetAtSec`（epoch 秒）已过天数。
 * `firstMetAtSec <= 0` 表示从未记录，返回 0；`min` 用于"至少显示 1 天"的展示口径。
 */
export function daysSince(firstMetAtSec: number | null | undefined, min = 0): number {
  if (firstMetAtSec == null || !(firstMetAtSec > 0)) return 0;
  return Math.max(min, Math.floor((todaySec - firstMetAtSec) / DAY_SEC));
}

/**
 * 订阅"今天"。组件渲染期调用本 hook 拿当前天，跨天时自动重渲染。
 * 定时器只在真的跨过 00:00 时才 setState，不会每 30 分钟白刷一次。
 */
export function useToday(): number {
  const [today, setToday] = useState(todaySec);
  useEffect(() => {
    const id = setInterval(() => {
      const next = truncateToDay(Date.now());
      if (next !== todaySec) {
        todaySec = next;
        setToday(next);
      }
    }, REALIGN_MS);
    return () => clearInterval(id);
  }, []);
  return today;
}
