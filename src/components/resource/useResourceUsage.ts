// 资源监视 · 轮询与历史缓冲（主窗口面板与桌面浮岛共用）
//
// 两端原本各自复刻了一份完全相同的「1s 轮询 + 48 点历史」逻辑，后端字段一改就要改两处；
// 抽到这里后，字段口径与曲线缓冲只有一处定义。
//
// 历史曲线按**显卡 id 分桶**：多卡时各自的曲线必须独立，不能混成一条。
import { useCallback, useEffect, useState } from 'react';
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

  // 历史缓冲用 state 的初始值承载：push() 是原地改数组，不触发渲染，
  // 真正的重渲染由下面的 setData 负责；缓冲对象身份恒定，消费者每次渲染读到的都是最新曲线。
  // （早先这里是 ref + 渲染期 return hist.current，会被 react-hooks/refs 判为"渲染期读 ref"。）
  const [hist] = useState<ResourceHistory>(() => ({ cpu: [], mem: [], up: [], down: [], gpu: {} }));

  const refresh = useCallback(async () => {
    try {
      const r = await invoke<ResourceUsage>('get_resource_usage');
      const h = hist;
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
  }, [hist]);

  // paused 直接进依赖：暂停时连定时器都不建（空闲零开销），恢复时立即补一次采样。
  // 不再需要 pausedRef 镜像——渲染期写 ref 同样违反 react-hooks/refs。
  useEffect(() => {
    void refresh();
    if (paused) return;
    const id = window.setInterval(() => { void refresh(); }, 1000);
    return () => window.clearInterval(id);
  }, [refresh, paused]);

  return { data, error, updatedAt, hist, refresh };
}
