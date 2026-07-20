// 音乐播放器单例 — 在插件 IIFE 作用域内，不依赖宿主
// debugLog 现在双写：①直接 console.log（在 WebView DevTools 控制台可见，不经 Rust 桥、
// 永不被沙箱/ACL 吞掉，是最可靠的排查手段）；②再经 debug_log 命令转发到 Rust 终端。
const debugLog = (m: string) => {
  try { console.error('[music-smtc]', m); } catch { /* 忽略 */ }
  try {
    window.__HOST_API__?.invoke('debug_log', { msg: `[music] ${m}` }).catch(() => {});
  } catch {
    /* 忽略 */
  }
};
// 一次性模块加载探针（console.error 不受沙箱 safe-console 吞没，dev/prod 均可见）
try {
  console.error(
    '[music-diag] musicPlayer.ts 模块开始求值; __HOST_API__=' +
      typeof window.__HOST_API__ +
      '; __HOST_REACT__=' +
      typeof window.__HOST_REACT__ +
      '; 已存在实例=' +
      (typeof (window as unknown as { __MUSIC_PLAYER__?: unknown }).__MUSIC_PLAYER__),
  );
} catch {}
interface Track {
  id: string;
  filePath: string;
  title: string;
  artist: string;
  album: string;
  durationSecs: number;
  coverPath?: string;
}

type PlayMode = 'list' | 'single' | 'random';
type PlayerEvent = 'play' | 'pause' | 'trackChange' | 'progress' | 'end';

class MusicPlayer {
  private audio: HTMLAudioElement;
  private tracks: Track[] = [];
  private currentIndex: number = -1;
  private isPlaying: boolean = false;
  private volume: number = 0.7;
  private playMode: PlayMode = 'list';
  private shuffleIndices: number[] = [];
  // 系统媒体键（smtc-control 事件）监听的注销函数
  private smtcUnlisten: (() => void) | null = null;
  // 持久化：当前播放的歌单 ID，组件重载时恢复选中状态
  currentPlaylistId: string | null = null;
  private eventListeners: Record<PlayerEvent, Set<(data: unknown) => void>> = {
    play: new Set(),
    pause: new Set(),
    trackChange: new Set(),
    progress: new Set(),
    end: new Set(),
  };

  constructor() {
    this.audio = new Audio();
    this.audio.volume = this.volume;
    this.audio.preload = 'metadata';
    this.bindEvents();
    this.setupMediaSessionHandlers();
    this.setupSmtc();
  }

  private bindEvents(): void {
    this.audio.addEventListener('play', () => {
      this.isPlaying = true;
      this.setMediaSessionState('playing');
      this.pushSmtc();
      this.emit('play', null);
    });
    this.audio.addEventListener('pause', () => {
      this.isPlaying = false;
      this.setMediaSessionState('paused');
      this.pushSmtc();
      this.emit('pause', null);
    });
    this.audio.addEventListener('ended', () => {
      this.emit('end', null);
      this.handleEnded();
    });
    this.audio.addEventListener('timeupdate', () => {
      this.updateMediaSessionPosition();
      this.emit('progress', {
        currentTime: this.audio.currentTime,
        duration: this.audio.duration || 0,
      });
    });
  }

  // ===== Windows 任务栏「正在播放」媒体控件（Media Session API）=====
  // WebView2/Chromium 会把 mediaSession 元信息推送到 Windows 任务栏媒体浮窗，
  // 显示歌曲标题/艺术家/专辑/封面，并响应系统媒体按键（播放/暂停/上一首/下一首）。
  private setMediaSessionState(state: 'playing' | 'paused' | 'none'): void {
    try {
      const ms = (navigator as unknown as { mediaSession?: { playbackState?: string } }).mediaSession;
      if (ms) ms.playbackState = state;
    } catch {
      /* mediaSession 不支持时忽略 */
    }
  }

  // 注意：我们刻意【不】通过 JS navigator.mediaSession 设置系统媒体元信息。
  // 原因：WebView2/Chromium 的媒体会话跑在 msedgewebview2.exe 子进程，无法继承主进程
  // AUMID，会在任务栏生成一张「未知应用」卡片（且可能带封面，造成与 Rust SMTC 卡片并存、
  // 互相打架的诡异现象）。任务栏「正在播放」卡片统一由 Rust 进程内的 SystemMediaTransportControls
  // 会话（smtc.rs）负责，它使用正确的 AUMID + 显示名「安得云荟」。故此处不再设置 metadata。
  private updateMediaSessionMeta(_track: Track): void {
    /* 故意留空：OS 媒体卡片由 Rust SMTC 接管 */
  }

  private updateMediaSessionPosition(): void {
    try {
      const ms = navigator as unknown as { mediaSession?: { setPositionState?: (s: { duration: number; position: number; playbackRate: number }) => void } };
      if (!ms.mediaSession || !ms.mediaSession.setPositionState) return;
      const d = this.audio.duration;
      if (!d || !isFinite(d) || d <= 0) return;
      ms.mediaSession.setPositionState({
        duration: d,
        position: Math.min(this.audio.currentTime, d),
        playbackRate: this.audio.playbackRate || 1,
      });
    } catch {
      /* 忽略 */
    }
  }

  // 注意：媒体键（键盘/触摸板/任务栏）统一由 Rust SMTC 的 ButtonPressed 事件回传前端处理，
  // 见 setupSmtc() 中监听的 "smtc-control"。若此处再用 JS 注册媒体键处理器，会与 Rust 路径
  // 重复触发（同一按键执行两次），故刻意留空。
  private setupMediaSessionHandlers(): void {
    /* 故意留空：媒体键由 Rust SMTC 回传处理 */
  }

  // ===== 本进程 SMTC 会话（Rust 端）=====
  // 与 JS mediaSession 不同：该会话运行在 .exe 进程内，任务栏显示「安得云荟」并回传
  // 系统媒体键（键盘/触摸板/任务栏浮窗）。前端只负责推送状态 + 接收控制事件。
  private pushSmtc(): void {
    const track = this.getCurrentTrack();
    const has = !!track && this.tracks.length > 0;
    // 标题兜底：很多音频文件没有标题元数据，空标题会让任务栏回退显示 AUMID；
    // 优先用文件名（去路径），再退到「未知曲目」。
    const fallbackTitle = track?.title?.trim()
      ? track.title
      : (track?.filePath ? track.filePath.split(/[\\/]/).pop()! : '未知曲目');
    const api = window.__HOST_API__;
    debugLog(`music push title=${fallbackTitle} playing=${this.isPlaying} can_prev=${has} can_next=${has} tracks=${this.tracks.length}`);
    if (!api?.invoke) {
      debugLog('music push: NO API');
      return;
    }
    // debug_log 以 [FE] 前缀必定出现在 Rust 终端，作为"推送是否真发出"的不可抵赖证据。
    api.invoke('debug_log', { msg: `MUSIC_PUSH title=${fallbackTitle} playing=${this.isPlaying} can_prev=${has} can_next=${has}` }).catch(() => {});
    api
      .invoke('smtc_update', {
        info: {
          title: fallbackTitle,
          artist: track?.artist ?? '',
          album: track?.album ?? '',
          cover_path: track?.coverPath ?? null,
          media_type: 'music',
          is_playing: this.isPlaying,
          can_prev: has,
          can_next: has,
        },
      })
      .then(() => {
        api.invoke('debug_log', { msg: 'MUSIC_PUSH_OK' }).catch(() => {});
        // 浏览器控制台可见：确认 sMTc_update 是否真正送达 Rust（决定任务栏卡片是否出现）。
        console.error('[SMTC] push OK', { title: fallbackTitle, playing: this.isPlaying });
        // 把 Rust 端真实状态打到控制台，便于排查：session_created(会话是否建出)、
        // is_enabled/playback_status(任务栏卡片是否出现)、process_aumid/actual_top_aumid/
        // reg_displayname(是否解析为「安得云荟」而非「未知应用」)。
        api.invoke<Record<string, unknown>>('smtc_status')
          .then((s) => console.log('[SMTC状态]', s))
          .catch(() => {});
      })
      .catch((e: unknown) => {
        api.invoke('debug_log', { msg: 'MUSIC_PUSH_FAIL ' + String(e) }).catch(() => {});
        console.error('[SMTC] push FAIL', e);
      });
  }

  private setupSmtc(): void {
    const api = window.__HOST_API__;
    if (!api?.listen) { debugLog('music: no listen api, skip'); return; }
    debugLog('music: listener registering');
    // 启动时主动拉取一次 SMTC 诊断（进程级 AUMID / 窗口 AUMID / 注册表 DisplayName 等），
    // 打印到浏览器控制台，便于排查任务栏「未知应用」。Rust 端 [SMTC] 日志走终端，这里补一份控制台可见的。
    api.invoke<Record<string, unknown>>('smtc_status')
      .then((s: Record<string, unknown>) => console.log('[SMTC诊断]', s))
      .catch(() => {});
    api
      .listen<{ action?: string; target?: string } | string>('smtc-control', (e) => {
        // 兼容新旧载荷：新版为 {action,target}，旧版为纯字符串。
        const raw = e.payload as { action?: string; target?: string } | string;
        const action = typeof raw === 'string' ? raw : raw?.action;
        const target = typeof raw === 'string' ? '' : raw?.target;
        // 关键：仅当任务栏当前胜出来源是音乐时才响应；target 为空则兼容旧行为（都响应）。
        if (target && target !== 'music') {
          debugLog(`music BTN ignored action=${action} target=${target}`);
          return;
        }
        debugLog(`music BTN ${action} (target=${target || 'any'})`);
        switch (action) {
          case 'play':
            this.play();
            break;
          case 'pause':
            this.pause();
            break;
          case 'next':
            this.next();
            break;
          case 'previous':
            this.prev();
            break;
          case 'stop':
            this.pause();
            this.audio.currentTime = 0;
            this.updateMediaSessionPosition();
            break;
          case 'seekforward':
            this.seek(this.audio.currentTime + 10);
            break;
          case 'seekbackward':
            this.seek(this.audio.currentTime - 10);
            break;
        }
      })
      .then((u) => {
        this.smtcUnlisten = u;
        debugLog('music: listener registered');
      })
      .catch(() => {});
  }

  private emit(event: PlayerEvent, data: unknown): void {
    this.eventListeners[event].forEach(listener => listener(data));
  }

  on(event: PlayerEvent, listener: (data: unknown) => void): () => void {
    this.eventListeners[event].add(listener);
    return () => { this.eventListeners[event].delete(listener); };
  }

  setTracks(tracks: Track[], startIndex: number = 0): void {
    this.tracks = tracks;
    // 切换歌单时必须重置随机序列：旧 shuffleIndices 基于旧歌单长度，
    // 若新歌单更长则超出旧长度的歌曲永远不会被随机到，反之则索引越界。
    this.shuffleIndices = [];
    if (startIndex >= 0 && startIndex < tracks.length) {
      this.currentIndex = startIndex;
      this.loadTrack(startIndex);
    }
  }

  private loadTrack(index: number): void {
    if (index < 0 || index >= this.tracks.length) return;
    const track = this.tracks[index];
    const api = window.__HOST_API__;
    try { api?.invoke('debug_log', { msg: `MUSIC_LOAD_TRACK idx=${index} file=${track.filePath}` }).catch(()=>{}); } catch {}
    const src = api?.convertFileSrc(track.filePath);
    if (src) {
      this.audio.src = src;
      this.currentIndex = index;
      this.emit('trackChange', track);
      this.updateMediaSessionMeta(track);
      this.pushSmtc();
    }
  }

  play(): void {
    try { window.__HOST_API__?.invoke('debug_log', { msg: `MUSIC_PLAY idx=${this.currentIndex}` }).catch(()=>{}); } catch {}
    if (this.currentIndex < 0 && this.tracks.length > 0) {
      this.currentIndex = 0;
      this.loadTrack(0);
    }
    this.audio.play().catch((err) => {
      console.warn('[MusicPlayer] 播放被阻止或失败:', err.message);
      this.emit('pause', undefined);
    });
  }

  pause(): void {
    this.audio.pause();
  }

  togglePlay(): void {
    if (this.isPlaying) { this.pause(); } else { this.play(); }
  }

  private handleEnded(): void {
    const nextIndex = this.getNextIndex();
    if (nextIndex >= 0) {
      this.loadTrack(nextIndex);
      this.play();
    } else {
      this.pause();
    }
  }

  private getNextIndex(): number {
    if (this.tracks.length === 0) return -1;
    switch (this.playMode) {
      case 'single': return this.currentIndex;
      case 'random':
        if (this.shuffleIndices.length === 0) {
          this.shuffleIndices = this.tracks.map((_, i) => i);
          for (let i = this.shuffleIndices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.shuffleIndices[i], this.shuffleIndices[j]] = [this.shuffleIndices[j], this.shuffleIndices[i]];
          }
        }
        const cur = this.shuffleIndices.indexOf(this.currentIndex);
        return this.shuffleIndices[(cur + 1) % this.shuffleIndices.length];
      default: return (this.currentIndex + 1) % this.tracks.length;
    }
  }

  private getPrevIndex(): number {
    if (this.tracks.length === 0) return -1;
    switch (this.playMode) {
      case 'single': return this.currentIndex;
      case 'random':
        if (this.shuffleIndices.length === 0) return (this.currentIndex - 1 + this.tracks.length) % this.tracks.length;
        const cur = this.shuffleIndices.indexOf(this.currentIndex);
        return this.shuffleIndices[(cur - 1 + this.shuffleIndices.length) % this.shuffleIndices.length];
      default: return (this.currentIndex - 1 + this.tracks.length) % this.tracks.length;
    }
  }

  next(): void {
    const idx = this.getNextIndex();
    if (idx >= 0) { this.loadTrack(idx); this.play(); }
  }

  prev(): void {
    const idx = this.getPrevIndex();
    if (idx >= 0) { this.loadTrack(idx); this.play(); }
  }

  seek(time: number): void { this.audio.currentTime = time; }
  setVolume(vol: number): void { this.volume = Math.max(0, Math.min(1, vol)); this.audio.volume = this.volume; }
  setPlayMode(mode: PlayMode): void { this.playMode = mode; if (mode !== 'random') this.shuffleIndices = []; }
  getIsPlaying(): boolean { return this.isPlaying; }
  getCurrentTrack(): Track | null { return this.tracks[this.currentIndex] || null; }
  getCurrentIndex(): number { return this.currentIndex; }
  getTracks(): Track[] { return this.tracks; }
  getVolume(): number { return this.volume; }
  getPlayMode(): PlayMode { return this.playMode; }
  getCurrentTime(): number { return this.audio.currentTime || 0; }
  getDuration(): number { return this.audio.duration || 0; }

  /**
   * 释放播放器持有的所有资源：暂停音频、清空 src、移除事件监听。
   * 由 PluginHost 在插件卸载/重载前调用 destroy 钩子触发。
   * 调用后清除 window.__MUSIC_PLAYER__ 全局引用，使下次加载创建全新实例，
   * 避免复用「已销毁」的旧实例（audio.src 已清空、监听器已清空）导致功能失效。
   */
  destroy(): void {
    try {
      this.smtcUnlisten?.();
      this.smtcUnlisten = null;
      debugLog('music: listener removed');
    } catch {
      /* 忽略 */
    }
    try {
      this.audio.pause();
      this.audio.src = '';
      this.audio.removeAttribute('src');
      this.audio.load();
    } catch { /* 忽略：audio 已处于异常态 */ }
    // 清空所有事件监听器，防止孤儿回调
    (Object.keys(this.eventListeners) as PlayerEvent[]).forEach(k => {
      this.eventListeners[k].clear();
    });
    this.tracks = [];
    this.currentIndex = -1;
    this.isPlaying = false;
    // 清除全局引用，使重载时 `globalWin.__MUSIC_PLAYER__ ?? new MusicPlayer()` 走新建分支
    const w = window as unknown as { __MUSIC_PLAYER__?: MusicPlayer };
    if (w.__MUSIC_PLAYER__ === this) {
      delete w.__MUSIC_PLAYER__;
    }
  }
}

// 单例：热重载时若 window.__MUSIC_PLAYER__ 已被 destroy 清除，则新建实例。
// window.__MUSIC_PLAYER__ 由全局类型声明定义，供跨模块访问（如歌词悬浮窗）。
const globalWin = window as unknown as { __MUSIC_PLAYER__?: MusicPlayer };
export const musicPlayer: MusicPlayer = globalWin.__MUSIC_PLAYER__ ?? new MusicPlayer();
globalWin.__MUSIC_PLAYER__ = musicPlayer;
// 也尝试把播放器暴露到顶层 window，方便 DevTools 控制台直接访问（插件可能跑在 sandbox/iframe）。
try {
  ((window.top as unknown) as any).__MUSIC_PLAYER__ = musicPlayer;
} catch {}
try { window.__HOST_API__?.invoke('debug_log', { msg: 'MUSIC_PLAYER_READY' }).catch(()=>{}); } catch {}
export type { Track, PlayMode };