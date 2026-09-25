// 资源监视 · 轮询与历史缓冲（主窗口面板与桌面浮岛共用）
//
// 两端原本各自复刻了一份完全相同的「1s 轮询 + 48 点历史」逻辑，后端字段一改就要改两处；
// 抽到这里后，字段口径与曲线缓冲只有一处定义。
//
// 历史曲线按**显卡 id 分桶**：多卡时各自的曲线必须独立，不能混成一条。
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { HISTORY, vramPercent, type ResourceUsage } from './model';

export interface GpuHistory {
  /** GPU 利用率 % 历史 */
  util: number[];
  /** 显存占用 % 历史 */
  vram: number[];
}

export interface ResourceHistory {
  cpu: number[];
  mem: number[];
  up: number[];
  down: number[];
  /** key = GpuUsage.id */
  gpu: Record<string, GpuHistory>;
}

export interface ResourceUsageState {
  data: ResourceUsage | null;
  error: string;
  /** 最近一次成功采样的时间戳（ms），0 表示还没成功过 */
  updatedAt: number;
  hist: ResourceHistory;
  refresh: () => Promise<void>;
}

/** 追加一个采样点；数组长度上限 HISTORY，用 splice 保持数组引用稳定 */
function push(arr: number[], v: number) {
  arr.push(Number.isFinite(v) ? v : 0);
  if (arr.length > HISTORY) arr.splice(0, arr.length - HISTORY);
}

/**
 * 每秒触发一次后端采样。
 * @param paused 暂停时不采样（面板关闭会卸载组件，定时器随之清除，空闲零开销）
 */
export function useResourceUsage(paused = false): ResourceUsageState {
  const [data, setData] = useState<ResourceUsage | null>(null);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState(0);

  // 历史缓冲放 ref，避免每次采样都触发一次额外的状态更新
  const hist = useRef<ResourceHistory>({ cpu: [], mem: [], up: [], down: [], gpu: {} });
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const refresh = useCallback(async () => {
    try {
      const r = await invoke<ResourceUsage>('get_resource_usage');
      const h = hist.current;
      push(h.cpu, r.cpu_percent);
      push(h.mem, r.mem_percent);
      push(h.up, r.net_up_bps);
      push(h.down, r.net_down_bps);
      for (const g of r.gpus) {
        let bucket = h.gpu[g.id];
        if (!bucket) {
          bucket = { util: [], vram: [] };
          h.gpu[g.id] = bucket;
        }
        push(bucket.util, g.util_percent ?? 0);
        push(bucket.vram, vramPercent(g) ?? 0);
      }
      setData(r);
      setError('');
      setUpdatedAt(Date.now());
    } catch (e) {
      setError((e as Error)?.message || String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      if (!pausedRef.current) void refresh();
    }, 1000);
    return () => window.clearInterval(id);
  }, [refresh]);

  return { data, error, updatedAt, hist: hist.current, refresh };
}
