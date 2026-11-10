/**
 * 中转站的前端设置（本机 localStorage）。
 *
 * 目前只有一项：拖入文件时「复制进中转站」与「只登记位置」的分界线。
 *
 * 为什么这条线需要用户能改：
 * - 一律复制：拖一个 40 GB 的视频进来就是 80 GB 磁盘；
 * - 一律只登记：一张 200 KB 的截图只记位置，用户在资源管理器里删掉它，
 *   中转站里的预览就没了。
 * 默认 100 MiB（小的复制、大的只登记），但不同人的磁盘结构差别很大，
 * 所以把它做成可调而不是写死在代码里。
 */

/** 默认分界线：100 MiB（与后端 `station::DEFAULT_COPY_THRESHOLD` 保持一致）。 */
export const DEFAULT_COPY_THRESHOLD = 100 * 1024 * 1024;

const KEY_COPY_THRESHOLD = 'andyh.station.copyThresholdBytes';

/** 读分界线。非法值（NaN / 负数）一律回退默认值，不让坏数据把拖入搞坏。 */
export function loadCopyThreshold(): number {
  try {
    const raw = localStorage.getItem(KEY_COPY_THRESHOLD);
    if (!raw) return DEFAULT_COPY_THRESHOLD;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      console.warn('[中转站] 复制阈值非法，回退默认值:', raw);
      return DEFAULT_COPY_THRESHOLD;
    }
    return n;
  } catch (err) {
    console.warn('[中转站] 读取复制阈值失败，回退默认值:', err);
    return DEFAULT_COPY_THRESHOLD;
  }
}

export function saveCopyThreshold(bytes: number): void {
  try {
    localStorage.setItem(KEY_COPY_THRESHOLD, String(Math.max(0, Math.floor(bytes))));
  } catch (err) {
    console.error('[中转站] 保存复制阈值失败:', err);
  }
}
