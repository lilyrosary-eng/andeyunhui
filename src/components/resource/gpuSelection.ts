// 资源监视 · 「监视哪几块 GPU」的选择状态
//
// 为什么要持久化 + 全局共享：
//   · 主窗口面板与桌面浮岛读的是**同一个**后端采样。如果两处各存一份选择，同一次采样
//     会在两个界面显示不同的卡，用户会以为数据错了。
//   · 选择跨会话保留（localStorage），否则每次开面板都要重选。
//
// 三种状态（缺一不可）：
//   · selected === null  → **尚未落定**：本次首次拿到显卡列表后按默认规则选，并落盘。
//     用 null 而不是 [] 是为了让「用户主动选了都不显示」和「还没初始化」区分开。
//   · selected === []    → 用户主动选了「都不展示」，界面给空状态提示，不自动改回去。
//   · selected 非空      → 按集合展示，顺序跟随后端返回的显卡顺序。
//
// 选择键是后端给的 `id`（显卡名#同名序号），**不是** DXGI LUID —— LUID 重启会变。
import { create } from 'zustand';
import { useEffect, useMemo } from 'react';
import type { GpuUsage } from './model';

const STORE_KEY = 'andeyunhui.resource.gpuSel';

function load(): string[] | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw == null) return null;
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return null;
    return v.filter((x): x is string => typeof x === 'string');
  } catch {
    // 存储不可用 / 内容损坏一律按「尚未落定」处理，不阻断面板
    return null;
  }
}

function save(v: string[] | null) {
  try {
    if (v == null) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, JSON.stringify(v));
  } catch {
    /* 忽略：存储失败只影响下次启动的记忆，不影响本次展示 */
  }
}

/**
 * 默认选择：**独占显存最大的那块**（后端已按显存降序返回，即 gpus[0]）。
 * 理由：本机是 iGPU + dGPU 的笔记本；若默认全选，面板会同时列出核显、独显、以及
 * 模拟器/虚拟显示适配器，既嘈杂又让人分不清哪个才是自己要看的。默认落在最强的那块，
 * 其余由用户按需勾选 —— 也正好对上「可以全展示 / 都不展示 / 只展示其中一个」。
 */
function defaultSelection(gpus: GpuUsage[]): string[] {
  const best = gpus.find((g) => (g.vram_total_kb ?? 0) > 0) ?? gpus[0];
  return best ? [best.id] : [];
}

interface GpuSelectionState {
  selected: string[] | null;
  set: (ids: string[]) => void;
  toggle: (id: string) => void;
  /** 传入当前可用显卡列表：仅在「尚未落定」时按默认规则落定 */
  syncDefaults: (gpus: GpuUsage[]) => void;
}

export const useGpuSelection = create<GpuSelectionState>((set, get) => ({
  selected: load(),
  set: (ids) => {
    save(ids);
    set({ selected: ids });
  },
  toggle: (id) => {
    const cur = get().selected ?? [];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    save(next);
    set({ selected: next });
  },
  syncDefaults: (gpus) => {
    if (get().selected !== null) return;
    if (gpus.length === 0) return;
    const next = defaultSelection(gpus);
    save(next);
    set({ selected: next });
  },
}));

/** 从完整显卡列表里筛出「当前被选择监视」的那些（保持后端顺序） */
export function pickSelected(gpus: GpuUsage[], selected: string[] | null): GpuUsage[] {
  if (selected == null) return defaultSelectionById(gpus);
  return gpus.filter((g) => selected.includes(g.id));
}

function defaultSelectionById(gpus: GpuUsage[]): GpuUsage[] {
  const best = gpus.find((g) => (g.vram_total_kb ?? 0) > 0) ?? gpus[0];
  return best ? [best] : [];
}

/** 空列表常量：保持引用稳定，避免每次渲染都让下面的 useMemo 失效 */
export const NO_GPUS: GpuUsage[] = [];

/**
 * 面板统一入口：拿到「要监视的显卡」。
 * 顺带在首次拿到显卡列表时按默认规则落定选择（两处面板谁先挂载谁负责初始化，幂等）。
 */
export function useSyncedGpuSelection(gpus: GpuUsage[]): GpuUsage[] {
  const selected = useGpuSelection((s) => s.selected);
  const sync = useGpuSelection((s) => s.syncDefaults);
  useEffect(() => {
    sync(gpus);
  }, [gpus, sync]);
  return useMemo(() => pickSelected(gpus, selected), [gpus, selected]);
}
