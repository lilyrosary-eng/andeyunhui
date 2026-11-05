/**
 * 写回记录面板的展示换算（纯函数，单独可测）
 *
 * 后端给的是毫秒时间戳和完整文件路径。直接显示的话，一屏全是
 * `1762...` 和 `D:\音乐\...`，认不出「这批是哪一次操作」，所以在这里换成
 * 人能扫读的形态。**只做展示**，撤销用的 batchId 一律原样传回后端。
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** 毫秒时间戳 → `2026-11-05 13:40`；拿不到合法时间就显示「未知时间」，不显示 NaN */
export function formatMillis(ms: number | undefined | null): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '未知时间';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '未知时间';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 路径 → 文件名（两种斜杠都认），给面板当样本标签用 */
export function baseName(path: string): string {
  const s = String(path ?? '');
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}
