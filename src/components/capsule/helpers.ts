// 黄金棋盘浮岛共享辅助函数（从 Capsule.tsx 抽出）
import type { PlayInfo } from './types';

export function fmtTime(d = new Date()): string {
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

export function toPlayInfo(p: Record<string, unknown> | null | undefined): PlayInfo {
  const o = (p ?? {}) as Record<string, unknown>;
  return {
    title: typeof o.title === 'string' ? o.title : '',
    artist: typeof o.artist === 'string' ? o.artist : '',
    album: typeof o.album === 'string' ? o.album : '',
    is_playing: !!o.is_playing,
    media_type: typeof o.media_type === 'string' ? o.media_type : '',
    cover_path: typeof o.cover_path === 'string' && o.cover_path ? o.cover_path : null,
    can_prev: !!o.can_prev,
    can_next: !!o.can_next,
    source: typeof o.source === 'string' ? o.source : undefined,
    key: typeof o.key === 'string' ? o.key : undefined,
  };
}

export function weatherLabel(code: number | null): string {
  if (code == null) return '—';
  if (code === 0) return '晴';
  if (code <= 3) return '多云';
  if (code <= 48) return '雾';
  if (code <= 67) return '雨';
  if (code <= 77) return '雪';
  if (code <= 82) return '阵雨';
  if (code <= 86) return '阵雪';
  if (code >= 95) return '雷暴';
  return '—';
}

// 带手动超时的 fetch（不依赖 AbortSignal.timeout，兼容老版 WebView2）
export async function fetchJson(url: string, ms: number): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
