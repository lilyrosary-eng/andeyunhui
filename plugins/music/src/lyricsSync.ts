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

type HostApiWithEmit = {
  emit: (event: string, payload: unknown) => Promise<void>;
};

function hostEmit(event: string, payload: unknown): void {
  const api = (window as unknown as { __HOST_API__?: HostApiWithEmit }).__HOST_API__;
  // 注意：可选链 ?. 只保护到 api，若 api 为 undefined，api?.emit(...) 结果为 undefined，
  // 再 .catch 会抛 TypeError。用 ?.catch 兜底，避免异步抛出未捕获异常。
  api?.emit(event, payload)?.catch(() => {});
}

function computeAndEmit(): void {
  if (!emitting || lines.length === 0) return;
  const ct = musicPlayer.getCurrentTime() * 1000;
  // 找到最后一个 time_ms <= 当前进度的歌词行
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time_ms <= ct) idx = i;
    else break;
  }
  const cur = idx >= 0 ? lines[idx].text : '';
  const nxt = idx + 1 < lines.length ? lines[idx + 1].text : '';
  if (cur !== lastText) {
    lastText = cur;
    hostEmit('lyrics-update', { currentLine: cur, nextLine: nxt });
  }
}

// 订阅一次，常驻于应用生命周期
musicPlayer.on('progress', () => computeAndEmit());

export const lyricsSync = {
  /** 设置当前曲目歌词行（替换即重新计算并立即推一次当前行） */
  setLines(next: LyricLine[]): void {
    lines = next;
    lastText = '';
    computeAndEmit();
  },
  /** 桌面歌词可见性：开启后若正在播放会立即推一次当前行 */
  setVisible(v: boolean): void {
    emitting = v;
    lastText = '';
    if (v) computeAndEmit();
  },
  /** 清空歌词（切歌/关闭时调用） */
  clear(): void {
    lines = [];
    lastText = '';
  },
  /** 当前是否处于可见（供 UI 同步开关状态） */
  isVisible(): boolean {
    return emitting;
  },
};
