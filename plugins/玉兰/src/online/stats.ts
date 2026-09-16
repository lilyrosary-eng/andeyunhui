/// <reference path="../../../global.d.ts" />
// 网络视频 · 本地使用统计（对齐音乐模块「统计」入口）
//
// 纯本地计数，存 localStorage，不上报。用于侧栏「统计」按钮展示：
// 播放次数 / 下载次数 / 各平台使用分布。
const KEY = 'video_online_stats';

export interface VideoOnlineStats {
  plays: number;
  downloads: number;
  /** platformId -> 播放次数 */
  byPlatform: Record<string, number>;
}

const EMPTY: VideoOnlineStats = { plays: 0, downloads: 0, byPlatform: {} };

type Listener = (s: VideoOnlineStats) => void;
const listeners = new Set<Listener>();

function read(): VideoOnlineStats {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY, byPlatform: {} };
    const parsed = JSON.parse(raw);
    return {
      plays: Number(parsed?.plays) || 0,
      downloads: Number(parsed?.downloads) || 0,
      byPlatform: typeof parsed?.byPlatform === 'object' && parsed.byPlatform ? parsed.byPlatform : {},
    };
  } catch {
    return { ...EMPTY, byPlatform: {} };
  }
}

function write(next: VideoOnlineStats) {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 忽略写入失败（隐私模式等） */
  }
  listeners.forEach((l) => l(next));
}

export function subscribeStats(fn: Listener): () => void {
  listeners.add(fn);
  fn(read());
  return () => listeners.delete(fn);
}

export function bumpPlay(platformId: string) {
  const s = read();
  const byPlatform = { ...s.byPlatform, [platformId]: (s.byPlatform[platformId] || 0) + 1 };
  write({ ...s, plays: s.plays + 1, byPlatform });
}

export function bumpDownload(_platformId: string) {
  const s = read();
  write({ ...s, downloads: s.downloads + 1 });
}

export function resetStats() {
  write({ ...EMPTY, byPlatform: {} });
}
