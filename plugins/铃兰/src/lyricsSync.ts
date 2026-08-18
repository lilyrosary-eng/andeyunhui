// 桌面歌词同步单例（模块级，与 React 组件生命周期解耦）
// 只要音乐在播放且桌面歌词可见，就持续根据播放进度 emit `lyrics-update`，
// 即使音乐模块 / PlayerBar 因切换页面被卸载，浮动歌词窗口也能继续滚动，
// 解决「切到其它模块后桌面歌词冻结 / 不滚动」的问题。
import { musicPlayer } from './musicPlayer';

export interface LyricLine {
  time_ms: number;
  text: string;
}

let lines: LyricLine[] = [];
let emitting = false;
let lastText = '';
// 节流：progress 事件约 250ms 一次，但 burst 时可能更频繁。
// 限制 emit 频率为 150ms 一次，防止 IPC 通道堵塞。
let lastEmitTime = 0;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

type HostApiWithEmit = {
  emit: (event: string, payload: unknown) => Promise<void>;
};

function hostEmit(event: string, payload: unknown): void {
  const api = (window as unknown as { __HOST_API__?: HostApiWithEmit }).__HOST_API__;
  api?.emit(event, payload)?.catch(() => {});
}

function computeAndEmit(): void {
  if (!emitting || lines.length === 0) return;
  const ct = musicPlayer.getCurrentTime() * 1000;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time_ms <= ct) idx = i;
    else break;
  }
  const cur = idx >= 0 ? lines[idx].text : '';
  const nxt = idx + 1 < lines.length ? lines[idx + 1].text : '';
  if (cur !== lastText) {
    lastText = cur;
    // 节流：距上次 emit 不足 150ms 则延迟补发
    const now = Date.now();
    if (now - lastEmitTime >= 150) {
      lastEmitTime = now;
      hostEmit('lyrics-update', { currentLine: cur, nextLine: nxt });
    } else {
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        lastEmitTime = Date.now();
        hostEmit('lyrics-update', { currentLine: cur, nextLine: nxt });
      }, 150);
    }
  }
}

// 订阅一次，常驻于应用生命周期
musicPlayer.on('progress', () => computeAndEmit());

export const lyricsSync = {
  setLines(next: LyricLine[]): void {
    lines = next;
    lastText = '';
    computeAndEmit();
  },
  setVisible(v: boolean): void {
    emitting = v;
    lastText = '';
    if (v) computeAndEmit();
  },
  clear(): void {
    lines = [];
    lastText = '';
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
  },
  isVisible(): boolean {
    return emitting;
  },
};

// ===== 网易云远程歌词辅助（PlayerBar 浮窗歌词 / NowPlayingView 沉浸页共用）=====

// 标准 LRC（[mm:ss.xx]文本）解析为 LyricLine[]（time_ms 毫秒）
export function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = [];
  const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of lrc.split('\n')) {
    re.lastIndex = 0;
    let m = re.exec(raw);
    if (!m) continue;
    const times: number[] = [];
    let last = m.index;
    while (m) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const frac = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) : 0;
      times.push((min * 60 + sec + frac / 1000) * 1000);
      last = re.lastIndex;
      m = re.exec(raw);
    }
    const text = raw.slice(last).trim();
    if (text) times.forEach((t) => out.push({ time_ms: t, text }));
  }
  out.sort((a, b) => a.time_ms - b.time_ms);
  return out;
}

// 是否为网易云远程曲：filePath 为 http(s) 直链，id 形如 netease-<songId>
export function isNeteaseRemote(track: { id?: string; filePath?: string }): boolean {
  return !!track.filePath && /^https?:\/\//i.test(track.filePath) && /^netease-\d+$/.test(track.id || '');
}
export function neteaseSongId(track: { id?: string }): number | null {
  const m = (track.id || '').match(/^netease-(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

// 是否为酷狗远程曲：filePath 为 http(s) 直链，id 形如 kugou-<hash>
export function isKugouRemote(track: { id?: string; filePath?: string }): boolean {
  return !!track.filePath && /^https?:\/\//i.test(track.filePath) && /^kugou-/.test(track.id || '');
}
export function kugouSongId(track: { id?: string }): string | null {
  const m = (track.id || '').match(/^kugou-([0-9a-fA-F]+)$/);
  return m ? m[1] : null;
}
