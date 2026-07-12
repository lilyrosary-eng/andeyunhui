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
