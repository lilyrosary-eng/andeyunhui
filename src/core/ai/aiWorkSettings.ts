// AI 工作台的并发设置。
//
// 为什么放在工作台自己而不是全局设置：并发上限只对「多任务并行」的工作台有意义，
// 对话/胶囊不需要排队；放全局反而让用户以为对话也被限流。
// 存 localStorage：与工作台会话同一层，换设备不跟随（本机资源约束是本机的）。
import { storage } from '@/core/storage';

export const AIWORK_PARALLELISM_KEY = 'andeyunhui.aiwork.parallelism';
/** 0 表示不限；默认 3 —— 本地模型与云端都能跑，又不至于一次打满端点。 */
export const AIWORK_PARALLELISM_DEFAULT = 3;
export const AIWORK_PARALLELISM_OPTIONS = [1, 2, 3, 5, 0];

export function loadAiWorkParallelism(): number {
  const raw = storage.getString(AIWORK_PARALLELISM_KEY, '');
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return AIWORK_PARALLELISM_DEFAULT;
  if (value === 0) return 0;
  return AIWORK_PARALLELISM_OPTIONS.includes(value) ? value : AIWORK_PARALLELISM_DEFAULT;
}

export function saveAiWorkParallelism(value: number): void {
  storage.setString(AIWORK_PARALLELISM_KEY, String(Math.max(0, Math.trunc(value))));
}
