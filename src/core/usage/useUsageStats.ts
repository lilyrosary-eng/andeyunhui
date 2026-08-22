// AI 用量 / 成本统计 Hook（对接后端 usage_stats / usage_reset）。
// 纯逻辑层：拉取月内用量汇总，供小圆环 + 悬停面板使用。不渲染 UI。
// 跨模块通用能力：任何模块都可展示用量（用量环）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface UsageModelStat {
  model: string;
  provider: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
}

export interface UsageDayStat {
  day: number;
  requests: number;
  totalTokens: number;
  cost: number;
}

export interface UsageSummary {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  byModel: UsageModelStat[];
  byDay: UsageDayStat[];
}

const EMPTY: UsageSummary = {
  requests: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cost: 0,
  byModel: [],
  byDay: [],
};

export interface UseUsageStatsResult {
  /** 最近 N 天的用量汇总（默认 30 天） */
  stats: UsageSummary;
  /** 是否已加载过（首次拉取完成标志） */
  loaded: boolean;
  /** 重新拉取 */
  refresh: () => Promise<void>;
  /** 清空用量记录（本地数据库），清空后自动刷新 */
  reset: () => Promise<void>;
}

export function useUsageStats(days: number = 30): UseUsageStatsResult {
  const [stats, setStats] = useState<UsageSummary>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const daysRef = useRef(days);
  daysRef.current = days;

  const refresh = useCallback(async () => {
    try {
      const data = await invoke<UsageSummary>('usage_stats', { days: daysRef.current });
      setStats(data ?? EMPTY);
    } catch (e) {
      console.error('[useUsageStats] 拉取用量失败', e);
      setStats(EMPTY);
    } finally {
      setLoaded(true);
    }
  }, []);

  const reset = useCallback(async () => {
    try {
      await invoke('usage_reset');
    } catch (e) {
      console.error('[useUsageStats] 清空用量失败', e);
    }
    await refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { stats, loaded, refresh, reset };
}