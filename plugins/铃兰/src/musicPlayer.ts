// 音乐播放器单例 — 在插件 IIFE 作用域内，不依赖宿主
import { T } from '../../_shared/pluginRuntime';
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
  quality?: string;       // 实际播放音质标签（Hi-Res/无损/高品质/标准）
  mvPath?: string;        // 本地关联的 MV 视频文件路径（右键「插入 MV」绑定）
}

type PlayMode = 'list' | 'single' | 'random';
type PlayerEvent = 'play' | 'pause' | 'trackChange' | 'progress' | 'end';

class MusicPlayer {
  private audio: HTMLAudioElement;
  private tracks: Track[] = [];
  private currentIndex: number = -1;
  // 已加载到 audio 的 src（用于「同曲不重载」守卫，避免重设 audio.src 触发媒体元素 reset）
  private loadedSrc: string = '';
  private isPlaying: boolean = false;
  private volume: number = 0.7;
  private playMode: PlayMode = 'list';
  private shuffleIndices: number[] = [];
  // 系统媒体键（smtc-control 事件）监听的注销函数
  private smtcUnlisten: (() => void) | null = null;
  // 持久化：当前播放的歌单 ID，组件重载时恢复选中状态
  currentPlaylistId: string | null = null;
  // 频谱数据：优先使用 Rust WASAPI Loopback 真实频谱，降级到伪律动。
  // WASAPI Loopback 不干扰 WebView2 音频路由，解决了 createMediaElementSource 静音问题。
  private spectrumData: Uint8Array = new Uint8Array(64);
  private lastTickTime = 0;
  private pendingPlayedMs = 0;
  private hasRealSpectrum: boolean = false;  // 是否收到过 Rust 真实频谱数据
  // 用户是否已请求播放（点击播放/选曲）：用于区分"正在播放"和"暂停"状态，
  // 解决网易云延迟取地址时 play() 失败 → isPlaying=false → updateTrackUrl 不触发 play 的问题。
  private playRequested: boolean = false;
  private pseudoAnimFrame: number | null = null;
  private pseudoStartTime: number = 0;
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
    this.setupSpectrumListener();
  }

  private bindEvents(): void {
    this.audio.addEventListener('play', () => {
      this.isPlaying = true;
      this.startPseudoAnalyser();
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
      // 实际听歌时长累计：仅播放中按 tick 增量累加，单次 delta 封顶 5s（seek 掠过不算「听」）。
      // 用于切歌时结算上一曲的真实播放量（trackChange 时 audio.currentTime 已被重置为 0，
      // 直接读 getCurrentTime 会把整首听完记成 0ms —— 累计听歌时长虚低的根因）。
      const now = this.audio.currentTime;
      if (this.playRequested && now > this.lastTickTime) {
        this.pendingPlayedMs += Math.min(now - this.lastTickTime, 5) * 1000;
      }
      this.lastTickTime = now;
      this.updateMediaSessionPosition();
      this.emit('progress', {
        currentTime: this.audio.currentTime,
        duration: this.audio.duration || 0,
      });
    });
  }

  /** 结算并清零累计的实际听歌时长（切歌/暂停落库时调用）。 */
  consumePendingPlayedMs(): number {
    const v = Math.round(this.pendingPlayedMs);
    this.pendingPlayedMs = 0;
    return v;
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
      : (track?.filePath ? track.filePath.split(/[\\/]/).pop()! : T('music.unknownTrack'));
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
      .listen<{ action?: string; target?: string; value?: number } | string>('smtc-control', (e) => {
        // 兼容新旧载荷：新版为 {action,target,value}，旧版为纯字符串。
        const raw = e.payload as { action?: string; target?: string; value?: number } | string;
        const action = typeof raw === 'string' ? raw : raw?.action;
        const target = typeof raw === 'string' ? '' : raw?.target;
        const value = typeof raw === 'object' ? raw?.value : undefined;
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
          case 'volume':
            if (typeof value === 'number' && isFinite(value)) this.setVolume(value);
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
    // 远程 URL（http/https，如网易云直链）直接原样赋值，
    // 不要走 convertFileSrc（它只用于本地文件路径，会把远程 URL 编码成 asset:// 导致 500）。
    const isRemote = !!track.filePath && /^https?:\/\//i.test(track.filePath);
    const src = !track.filePath ? '' : (isRemote ? track.filePath : (api?.convertFileSrc(track.filePath) || track.filePath));
    // 关键修复：若目标曲与「当前已加载曲」完全相同（同一 index + 同一 src 且已加载到 audio），
    // 不要重设 audio.src —— 否则会触发媒体元素 reset（播放中断、currentTime 归零、SMTC 卡片丢失）。
    // 典型场景：切到其它模块再切回音乐模块时，resumeLastPosition 会重复 setTracks 到同一首歌，
    // 旧逻辑每次都重设 src 导致「切回音乐模块播放被暂停、点击播放栏无效」。
    if (index === this.currentIndex && src && this.loadedSrc === src) {
      debugLog(`music loadTrack skip(reload same track) idx=${index}`);
      this.emit('trackChange', track);
      this.updateMediaSessionMeta(track);
      this.pushSmtc();
      return;
    }
    if (src) {
      this.audio.src = src;
      this.loadedSrc = src;
      this.currentIndex = index;
      this.emit('trackChange', track);
      this.updateMediaSessionMeta(track);
      this.pushSmtc();
    } else {
      // filePath 为空（网易云延迟取地址占位）：标记等待，待 updateTrackUrl 补完后 reload
      this.loadedSrc = '';
      this.currentIndex = index;
      this.emit('trackChange', track);
    }
  }

  // 网易云等远程曲：点击后先以空 filePath 占位进入队列，后台异步补全地址时调用本方法。
  // 若补的是当前正在播放/等待的曲，则自动 reload 该曲（保留播放进度）。
  // 关键修复：补全 URL 后重新 emit trackChange 让 UI 更新封面；
  // 无论 isPlaying 状态如何，只要用户曾请求播放就自动续播（解决延迟取地址导致的静音）。
  updateTrackUrl(index: number, url: string): void {
    if (index < 0 || index >= this.tracks.length || !url) return;
    const track = this.tracks[index];
    if (!track) return;
    const wasWaiting = !track.filePath;
    track.filePath = url;
    if (index === this.currentIndex && wasWaiting) {
      const pos = this.audio.currentTime || 0;
      const api = window.__HOST_API__;
      const isRemote = /^https?:\/\//i.test(url);
      const nextSrc = isRemote ? url : (api?.convertFileSrc(url) || url);
      this.audio.src = nextSrc;
      this.loadedSrc = nextSrc;
      try { this.audio.currentTime = pos; } catch { /* ignore */ }
      // 重新 emit trackChange，让 UI 更新封面和歌曲信息（之前 filePath 为空时封面可能未加载）
      this.emit('trackChange', track);
      // 用户已请求播放则自动续播（不依赖 isPlaying，因为 play() 失败后 isPlaying=false）
      if (this.playRequested) {
        this.audio.play().catch((err) => {
          console.warn('[MusicPlayer] updateTrackUrl play failed:', err.message);
        });
      }
    }
  }

  play(): void {
    this.playRequested = true;  // 标记用户已请求播放
    try { window.__HOST_API__?.invoke('debug_log', { msg: `MUSIC_PLAY idx=${this.currentIndex}` }).catch(()=>{}); } catch {}
    if (this.currentIndex < 0 && this.tracks.length > 0) {
      this.currentIndex = 0;
      this.loadTrack(0);
    }
    // 如果当前 track 的 filePath 为空（网易云延迟取地址占位），
    // audio.play() 会失败但不影响后续 updateTrackUrl 时的自动续播。
    this.audio.play().catch((err) => {
      console.warn('[MusicPlayer] 播放被阻止或失败:', err.message);
      // 不 emit pause，保持 playRequested=true 让 updateTrackUrl 能续播
    });
  }

  // 启动伪律动：仅在未收到 Rust 真实频谱时作为降级方案
  private startPseudoAnalyser(): void {
    if (this.pseudoAnimFrame !== null) return;
    this.pseudoStartTime = performance.now();
    const tick = () => {
      if (!this.isPlaying) {
        this.pseudoAnimFrame = null;
        return;
      }
      // 如果有真实频谱数据，不再生成伪律动
      if (this.hasRealSpectrum) {
        this.pseudoAnimFrame = null;
        return;
      }
      const t = (performance.now() - this.pseudoStartTime) / 1000;
      const vol = this.volume; // 0~1
      const n = this.spectrumData.length;
      for (let i = 0; i < n; i++) {
        const freqRatio = i / n;
        const wave =
          Math.sin(t * 3.2 + i * 0.35) * 0.6 +
          Math.sin(t * 7.1 + i * 0.18) * 0.35 +
          Math.sin(t * 1.5 + i * 0.7) * 0.25;
        const base = (1 - freqRatio * 0.55) * vol * 240;
        const noise = Math.random() * 40 * vol;
        const val = Math.max(0, Math.min(255, base * (0.5 + wave * 0.5) + noise));
        this.spectrumData[i] =
          this.spectrumData[i] * 0.65 + val * 0.35;
      }
      this.pseudoAnimFrame = requestAnimationFrame(tick);
    };
    this.pseudoAnimFrame = requestAnimationFrame(tick);
  }

  // 监听 Rust 端 audio-spectrum 事件，接收真实频域数据
  private spectrumUnlisten: (() => void) | null = null;
  // 频谱惰性激活：只有真实消费者（漫游页 EQ）注册时才唤醒 Rust 采集线程。
  // 此前无条件 active:true → Rust 以 30fps 持续推送 64 桶事件，本地音乐模块
  // 完全不消费，却让 IPC 队列被持续填充 → 切模块的请求排队 → 粘滞感。
  private spectrumWanted = 0;
  requestSpectrum(): void {
    this.spectrumWanted++;
    this.syncSpectrum();
  }
  releaseSpectrum(): void {
    this.spectrumWanted = Math.max(0, this.spectrumWanted - 1);
    this.syncSpectrum();
  }
  private syncSpectrum(): void {
    window.__HOST_API__?.invoke('spectrum_set_listener', { active: this.spectrumWanted > 0 }).catch(() => {});
  }
  private setupSpectrumListener(): void {
    const api = window.__HOST_API__;
    if (!api?.listen) return;
    api.listen<number[]>('audio-spectrum', (event) => {
      const data = event.payload;
      if (Array.isArray(data) && data.length > 0) {
        this.hasRealSpectrum = true;
        // 平滑插值，避免帧间跳变
        const n = Math.min(data.length, this.spectrumData.length);
        for (let i = 0; i < n; i++) {
          this.spectrumData[i] = this.spectrumData[i] * 0.5 + (data[i] as number) * 0.5;
        }
      }
    }).then(() => {
      // 初始同步：构造时 wanted=0 → Rust 采集线程保持休眠，直到有消费者请求
      this.syncSpectrum();
    }).catch(() => {});
  }

  // 获取频谱数据供 EQ 动画使用
  // 优先返回 Rust WASAPI Loopback 真实频谱，降级到伪律动
  getAnalyser(): { getByteFrequencyData: (arr: Uint8Array) => void; frequencyBinCount: number } | null {
    const data = this.spectrumData;
    return {
      frequencyBinCount: data.length,
      getByteFrequencyData: (arr: Uint8Array) => {
        for (let i = 0; i < Math.min(arr.length, data.length); i++) {
          arr[i] = data[i];
        }
      },
    } as any;
  }

  pause(): void {
    this.playRequested = false; // 用户主动暂停
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
  // 跳转到队列中指定索引播放（漫游队列点击切歌用）
  playIndex(index: number): void {
    if (index < 0 || index >= this.tracks.length) return;
    this.loadTrack(index);
    this.play();
  }

  seek(time: number): void { this.audio.currentTime = time; }
  setVolume(vol: number): void { this.volume = Math.max(0, Math.min(1, vol)); this.audio.volume = this.volume; }
  setPlayMode(mode: PlayMode): void { this.playMode = mode; if (mode !== 'random') this.shuffleIndices = []; }
  getIsPlaying(): boolean { return this.isPlaying; }
  getCurrentTrack(): Track | null { return this.tracks[this.currentIndex] || null; }
  getCurrentIndex(): number { return this.currentIndex; }
  getTracks(): Track[] { return this.tracks; }
  // 流式追加：漫游等场景在播放接近队尾时，把下一批曲目接到队列末尾。
  // 仅追加、不打断当前播放、不触发 trackChange（避免 UI 误以为切歌）。
  appendTracks(tracks: Track[]): void {
    if (!tracks.length) return;
    this.tracks = [...this.tracks, ...tracks];
    // 顺序播放模式下，随机序列需要补齐新长度，否则超出旧长度的曲不会被随机到。
    if (this.playMode === 'random' && this.shuffleIndices.length) {
      const start = this.tracks.length - tracks.length;
      for (let i = start; i < this.tracks.length; i++) this.shuffleIndices.push(i);
    }
  }
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
      this.spectrumUnlisten?.();
      this.spectrumUnlisten = null;
      // 通知 Rust：已退订频谱 → 无监听时采集线程休眠（省 CPU）
      window.__HOST_API__?.invoke('spectrum_set_listener', { active: false }).catch(() => {});
      debugLog('music: spectrum listener removed');
    } catch {
      /* 忽略 */
    }
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
      this.loadedSrc = '';
      this.audio.removeAttribute('src');
      this.audio.load();
    } catch { /* 忽略：audio 已处于异常态 */ }
    this.playRequested = false;
    // 停止伪律动动画帧
    if (this.pseudoAnimFrame !== null) {
      cancelAnimationFrame(this.pseudoAnimFrame);
      this.pseudoAnimFrame = null;
    }
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