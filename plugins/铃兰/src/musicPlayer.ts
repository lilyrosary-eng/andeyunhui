// 音乐播放器单例 — 在插件 IIFE 作用域内，不依赖宿主
import { T } from '../../_shared/pluginRuntime';
// 平台判定统一走 src/platform/isLinux.ts 单例（禁止各自 UA 嗅探；此前本文件内联过一份，
// 与 RoamView/NowPlayingView/PlayerBar 的 HEAVY_FX 判据同源，避免双实现漂移）。
import { isLinux } from '@/platform/isLinux';
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
type PlayerEvent = 'play' | 'pause' | 'trackChange' | 'progress' | 'end' | 'queueChange';

class MusicPlayer {
  private audio: HTMLAudioElement;
  private tracks: Track[] = [];
  private currentIndex: number = -1;
  // 已加载到 audio 的 src（用于「同曲不重载」守卫，避免重设 audio.src 触发媒体元素 reset）
  private loadedSrc: string = '';
  // `loadedSrc` 对应的是**哪一条曲目**。单靠 loadedSrc 不够用：切歌后它仍是上一条的 src（非空），
  // 于是「当前选中的这条是否已经加载好了」根本判断不出来（2026-10-09 血案，详见 play() 的注释）。
  // -1 = audio 里没有可信的已加载曲目（初始态 / 已销毁 / **有加载在途**）。
  private loadedIndex: number = -1;
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
  // ===== Web Audio AnalyserNode 直取频谱（非 Windows 平台的真实频谱来源）=====
  //
  // 背景：Windows 走 Rust WASAPI Loopback；但本机（Linux）音频图里**没有任何 sink
  // monitor 节点**（monitor 只由 pipewire-pulse 按需创建，而 Pulse 客户端协议在此
  // 环境不通），OS 级环回采集不可行 ⇒ 只能退伪律动。
  // 而本插件自己持有 audio 元素（见构造函数 `new Audio()`），因此可以直接挂
  // AnalyserNode 取真实频域数据，完全绕开 OS 采集。
  //
  // ⚠ 静音风险（本项目**历史上已踩过**，见 spectrumData 字段注释「解决了
  //   createMediaElementSource 静音问题」——那正是 Windows 改用 WASAPI 的原因）：
  //   createMediaElementSource 会把元素输出**改道**进 WebAudio 图，若 AudioContext
  //   处于 suspended（浏览器自动播放策略）或忘了 connect(destination)，音乐会**直接静音**。
  //   故设三道防线，任何一步不满足就只放弃频谱、绝不碰播放：
  //     1) 只在 ctx.state === 'running' 之后才建源（建完若仍非 running 则断开并放弃）；
  //     2) 建源后立刻 src.connect(ctx.destination) 保持出声；
  //     3) 监听 statechange，一旦被挂起立刻 resume()。
  //   另：整段包在 try/catch 里，异常一律回退伪律动。
  private webAudioCtx: AudioContext | null = null;
  private webAnalyser: AnalyserNode | null = null;
  /** 复用的频域缓冲，避免每帧分配（128 bin）。 */
  private webBins: Uint8Array | null = null;
  /** 是否已尝试过建 Web Analyser（失败不再重试，避免每帧抛错）。 */
  private webAnalyserTried = false;
  /** 是否收到过 Rust 侧真实频谱事件。Windows 为 true ⇒ 永不建 Web Analyser。 */
  private rustSpectrumSeen = false;
  private eventListeners: Record<PlayerEvent, Set<(data: unknown) => void>> = {
    play: new Set(),
    pause: new Set(),
    trackChange: new Set(),
    progress: new Set(),
    end: new Set(),
    queueChange: new Set(),
  };

  constructor() {
    this.audio = new Audio();
    this.audio.volume = this.volume;
    this.audio.preload = 'metadata';
    this.bindEvents();
    this.bindMediaDiagnostics();
    this.setupMediaSessionHandlers();
    this.setupSmtc();
    this.setupSpectrumListener();
  }

  /**
   * 媒体元素诊断：把「为什么播不出来」落到日志里。
   *
   * 背景：Linux 上曾出现 `play()` 被拒（`NotSupportedError: The operation is not
   * supported.`），但外部条件全部正常 —— 文件可读（Rust 侧 lofty 能正常 probe 出
   * 标题）、GStreamer 解码器齐全、asset 作用域已放开、声卡里也确实有输出设备。
   * 这种情况下**只有元素自身的事件能给出答案**，否则只能靠猜：
   *   - `error.code` 1=中止 2=网络 3=解码 4=src 不受支持
   *   - `readyState` 0=HAVE_NOTHING … 4=HAVE_ENOUGH_DATA
   *   - `networkState` 3=NETWORK_NO_SOURCE
   * 顺带把 `currentSrc` 截断打出来（能看出 `convertFileSrc` 产出的 asset:// URL
   * 是否被正确编码，文件名含空格/中文时尤其容易在这里出问题）。
   */
  private bindMediaDiagnostics(): void {
    const a = this.audio;
    const short = (s: string | undefined) => (s || '').slice(0, 160);
    const snap = (tag: string) =>
      debugLog(
        `music[media] ${tag} rs=${a.readyState} ns=${a.networkState} ` +
          `err=${a.error ? a.error.code + '/' + a.error.message : 'null'} ` +
          `dur=${Number.isFinite(a.duration) ? a.duration.toFixed(1) : 'NaN'} ` +
          `src=${short(a.currentSrc)}`
      );

    a.addEventListener('loadstart', () => snap('loadstart'));
    a.addEventListener('loadedmetadata', () => snap('loadedmetadata'));
    a.addEventListener('canplay', () => snap('canplay'));
    a.addEventListener('playing', () => snap('playing'));
    a.addEventListener('stalled', () => snap('stalled'));
    a.addEventListener('waiting', () => snap('waiting'));
    a.addEventListener('suspend', () => snap('suspend'));
    a.addEventListener('emptied', () => snap('emptied'));
    a.addEventListener('error', () => snap('error'));
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
      // 让系统媒体卡片的进度条跟着走（节流 ~1s，见 pushSmtcProgress）
      this.pushSmtcProgress();
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
    // Linux：媒体卡片由我们自己的 MPRIS 发布；WebKitGTK 内置 MPRIS 会再出第二张卡。
    // 这里不写 playbackState，作为"能否压掉 WebKit 那张"的最小实验。
    if (isLinux()) return;
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
      if (isLinux()) return; // 同上：位置由 MPRIS 的 Position 属性提供
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
  /** 组装媒体卡片载荷。**必须带 duration_ms / position_ms**：
   *  缺了它们 MPRIS 就没有 mpris:length、Position 恒 0 ⇒ GNOME 媒体卡片没有进度条
   *  （2026-10-24 用 busctl 对照确认；此前一直传 None）。 */
  private smtcPayload(): { title: string; info: Record<string, unknown> } {
    const track = this.getCurrentTrack();
    const has = !!track && this.tracks.length > 0;
    const title = track?.title?.trim()
      ? track.title
      : (track?.filePath ? track.filePath.split(/[\\/]/).pop()! : T('music.unknownTrack'));
    const d = this.audio?.duration;
    const pos = this.audio?.currentTime;
    return {
      title,
      info: {
        title,
        artist: track?.artist ?? '',
        album: track?.album ?? '',
        cover_path: track?.coverPath ?? null,
        media_type: 'music',
        is_playing: this.isPlaying,
        can_prev: has,
        can_next: has,
        duration_ms: Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : null,
        position_ms: Number.isFinite(pos) && pos >= 0 ? Math.round(pos * 1000) : null,
      },
    };
  }

  /** 播放中每秒推一次进度（只推 smtc_update，不打 debug_log —— 否则每秒两条噪音日志）。 */
  private lastSmtcProgressMs = 0;
  private pushSmtcProgress(): void {
    if (!this.isPlaying) return;
    const d = this.audio?.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    const now = Date.now();
    if (now - this.lastSmtcProgressMs < 900) return;
    this.lastSmtcProgressMs = now;
    const api = window.__HOST_API__;
    api?.invoke?.('smtc_update', { info: this.smtcPayload().info }).catch(() => {});
  }

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
      .invoke('smtc_update', { info: this.smtcPayload().info })
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
          case 'seek': {
            // 来自 MPRIS 的拖动：value 是**绝对毫秒**（Seek 偏移已在 Rust 侧叠加）。
            if (typeof value === 'number' && isFinite(value)) {
              const dur = this.audio.duration;
              const t = Math.max(0, value / 1000);
              this.audio.currentTime = Number.isFinite(dur) ? Math.min(t, dur) : t;
              this.updateMediaSessionPosition();
              this.pushSmtcProgress();
            }
            break;
          }
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
    this.emitQueueChange(tracks);
  }

  // 队列变更通知：供「临时播放栏」自动记录播放队列。
  // 用微任务延迟一拍再广播——调用方习惯在 setTracks 之后同步设置 currentPlaylistId
  // （如漫游电台 = 'roam-active'），延迟一拍才能读到正确来源，从而过滤掉漫游电台自身的队列。
  private emitQueueChange(tracks: Track[]): void {
    if (!tracks.length) return;
    const snapshot = tracks.slice();
    const notify = () => {
      try { this.emit('queueChange', { tracks: snapshot, playlistId: this.currentPlaylistId }); } catch { /* 忽略 */ }
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(notify);
    else setTimeout(notify, 0);
  }

  private async loadTrack(index: number): Promise<void> {
    if (index < 0 || index >= this.tracks.length) return;
    // 一进入就作废「已加载」标记：此刻 audio 里还是**上一条**的 src，
    // 任何在这段 await 期间发生的 play() 都必须走「先加载再播」，而不是直接播旧源。
    this.loadedIndex = -1;
    const track = this.tracks[index];
    const api = window.__HOST_API__;
    try { api?.invoke('debug_log', { msg: `MUSIC_LOAD_TRACK idx=${index} file=${track.filePath}` }).catch(()=>{}); } catch {}
    // Linux 上本地文件要 fetch 成 blob 才是异步的 ⇒ 用序号守卫防止竞态：
    // 快速连点切歌时，先发后到的旧请求不能覆盖新歌。
    const seq = ++this.loadSeq;
    // 远程 URL（http/https，如网易云直链）直接原样赋值，
    // 不要走 convertFileSrc（它只用于本地文件路径，会把远程 URL 编码成 asset:// 导致 500）。
    // Linux 上本地文件额外走 blob: —— 原因见 resolvePlayableSrc 的注释
    // （WebKitGTK 的媒体加载器不接管 asset:// 自定义 scheme）。
    const src = !track.filePath ? '' : await this.resolvePlayableSrc(api, track.filePath);
    // 期间用户又切了别的歌 ⇒ 丢弃本次结果，别把新歌的 src 覆盖掉
    if (seq !== this.loadSeq) {
      debugLog(`music loadTrack 竞态丢弃 idx=${index} (seq=${seq} 当前=${this.loadSeq})`);
      return;
    }
    // 关键修复：若目标曲与「当前已加载曲」完全相同（同一 index + 同一 src 且已加载到 audio），
    // 不要重设 audio.src —— 否则会触发媒体元素 reset（播放中断、currentTime 归零、SMTC 卡片丢失）。
    // 典型场景：切到其它模块再切回音乐模块时，resumeLastPosition 会重复 setTracks 到同一首歌，
    // 旧逻辑每次都重设 src 导致「切回音乐模块播放被暂停、点击播放栏无效」。
    if (index === this.currentIndex && src && this.loadedSrc === src) {
      debugLog(`music loadTrack skip(reload same track) idx=${index}`);
      // 同一首歌、src 未变 ⇒ 不重设 audio.src（避免 reset），但「已加载」标记必须补回来：
      // 上面入口处刚把它置成 -1，否则 play() 会误判为「需要加载」而多绕一圈。
      this.loadedIndex = index;
      this.emit('trackChange', track);
      this.updateMediaSessionMeta(track);
      this.pushSmtc();
      return;
    }
    if (src) {
      this.audio.src = src;
      this.loadedSrc = src;
      this.loadedIndex = index;
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
      // 与 loadTrack 同一套处理：Linux 本地文件走 blob:
      const seq = ++this.loadSeq;
      void this.resolvePlayableSrc(api, url).then((nextSrc) => {
        if (seq !== this.loadSeq) return; // 已被更新的切歌取代
        this.audio.src = nextSrc;
        this.loadedSrc = nextSrc;
        this.loadedIndex = index;
        try { this.audio.currentTime = pos; } catch { /* ignore */ }
        // 重新 emit trackChange，让 UI 更新封面和歌曲信息（之前 filePath 为空时封面可能未加载）
        this.emit('trackChange', track);
        // 用户已请求播放则自动续播（不依赖 isPlaying，因为 play() 失败后 isPlaying=false）
        if (this.playRequested) {
          this.audio.play().catch((err) => {
            console.warn('[MusicPlayer] updateTrackUrl play failed:', err.message);
          });
        }
      });
    }
  }

  // ==============================================================
  // 音源地址解析：Linux 必须绕开 asset:// 自定义 scheme
  // ==============================================================
  //
  // 【实测根因】本地音乐在 Linux 上一直播不出，媒体元素报
  //   error.code = 4 (MEDIA_ERR_SRC_NOT_SUPPORTED)、networkState = 3 (NETWORK_NO_SOURCE)
  // 且 **Tauri 的 asset 协议处理器一次都没被调用**（连「路径不存在」「403」这些
  // log::error 都没有），CSP 也没有违规记录。
  //   ⇒ 请求根本没进 Tauri。原因是 **WebKitGTK 的媒体加载器不接管自定义 URI scheme**：
  //     `convertFileSrc` 产出的 `asset://localhost/...`，图片走普通资源加载能通，
  //     音视频走的是另一条（媒体）加载路径，那条不认自定义 scheme。
  //   （Windows 是 WebView2，asset:// 走虚拟主机映射，媒体也通 —— 所以那边一直正常。）
  //
  // 【解法】仍然用 asset:// 把文件**读出来**（fetch 走普通资源加载，这条是通的，
  //   且 CSP 的 connect-src 本就允许 `asset:`），再转成 `blob:` URL 交给媒体元素
  //   —— blob: 是同源 URL，媒体加载器原生支持，dev（http://localhost:1420）与
  //   打包后（tauri://）行为一致，不需要额外放开 file: 或改 CSP。
  //
  // 代价：整首歌进内存（FLAC 常见 30~60MB）。换曲时 revoke 旧的 objectURL 即可，
  // 本地文件播放场景完全可接受；远程直链（酷狗/网易云 https）不走这条路。
  /** 切歌序号守卫：解析本地音源是异步的（Linux 要问后端要 URL），靠它防止竞态覆盖。 */
  private loadSeq = 0;

  /**
   * 把「本地文件路径」变成「媒体元素能吃的 src」。
   * 远程直链原样返回。
   */
  private async resolvePlayableSrc(api: any, rawPath: string): Promise<string> {
    const isRemote = /^https?:\/\//i.test(rawPath);
    if (isRemote) return rawPath;

    // ---- Linux：交给本地媒体 HTTP 服务 ----
    // 不能用 asset:// —— WebKitGTK 的**媒体加载器不接管自定义 scheme**（图片走
    // 普通资源加载能通、音视频不走那条路），表现为 error.code=4 / NETWORK_NO_SOURCE。
    // 也不能整首 fetch 成 blob —— 那会反复把文件页塞进 page cache，实测把
    // page cache 撑到 5.65GB 直接 OOM 掉整机（内核日志 anon 451MB / file 5.65GB，
    // 栈顶 filemap_add_folio）。详见 src-tauri/src/media_http.rs 的文件头。
    // 本地 HTTP 服务流式按需读（含 Range），内存恒定、还能拖进度。
    if (isLinux()) {
      try {
        const url: string = await api.invoke('media_http_url', { path: rawPath });
        debugLog('music: 使用本地媒体 HTTP 源');
        return url;
      } catch (e) {
        debugLog('music: media_http_url 失败，回退 asset:// | ' + String(e));
        return api?.convertFileSrc?.(rawPath) || rawPath;
      }
    }

    // ---- Windows / 其它：convertFileSrc 走 asset 虚拟主机映射，一直是好的 ----
    return api?.convertFileSrc?.(rawPath) || rawPath;
  }

  /** 播放失败时把「门禁状态」写进日志 —— 光看 err.message 区分不出「无授权/无源/解码失败」。 */
  private reportPlayFailure(err: unknown): void {
    const e = err as { name?: string; message?: string } | undefined;
    console.warn(
      '[MusicPlayer] 播放被阻止或失败:',
      e && e.name,
      e && e.message,
      `| rs=${this.audio.readyState} ns=${this.audio.networkState}` +
        ` mediaErr=${this.audio.error ? this.audio.error.code : 'null'}` +
        ` paused=${this.audio.paused} vol=${this.audio.volume}` +
        ` src=${(this.audio.currentSrc || '').slice(0, 160)}`
    );
    // 不 emit pause，保持 playRequested=true 让 updateTrackUrl 能续播
  }

  /**
   * 切到指定索引并播放。
   *
   * ⚠ 存在的唯一理由：`loadTrack` 是 async 的，而 `audio.src` 必须**在 play() 之前**就位。
   * 原来的写法 `this.loadTrack(i); this.play();` 已经坏了 —— play() 会在 src 仍为空时执行。
   * 所有「切歌后播放」的场景（下一首/上一首/点队列/自动连播）都必须走这里。
   */
  private playAt(index: number): void {
    const wanted = index;
    void this.loadTrack(index).then(() => {
      // 期间被更晚的切歌取代 ⇒ 交给那次流程负责，这里不要插一脚
      if (this.currentIndex !== wanted) return;
      this.playRequested = true;
      this.audio.play().catch((err) => this.reportPlayFailure(err));
    });
  }

  play(): void {
    this.playRequested = true;  // 标记用户已请求播放
    try { window.__HOST_API__?.invoke('debug_log', { msg: `MUSIC_PLAY idx=${this.currentIndex}` }).catch(()=>{}); } catch {}

    // ⚠⚠ 必须先等 loadTrack 把 audio.src 设好，再调 play()。
    //
    // 血案（2026-10-08，Windows 侧反馈「无法播放音乐」）：`loadTrack` 原本是**同步**的，
    // `this.audio.src` 在下面这行 play() 之前就已就位。为了给 Linux 的本地媒体 HTTP 服务
    // 换取 URL，`loadTrack` 被改成 `async`（内部 `await resolvePlayableSrc(...)`）。
    // **即使 resolvePlayableSrc 内部走的是同步分支（Windows 的 convertFileSrc），
    // async 函数返回的仍是 Promise，await 必然产生一个微任务延迟** —— 于是
    // `audio.src` 落后于 `audio.play()`，play() 在「无源」状态下被调用 ⇒ 点了播放没反应。
    // 这个回归是跨平台的，Windows 上直接表现为「音乐播不出来」。
    // 需要先加载的两种情况：
    //   a) 还没有当前曲目（currentIndex < 0）；
    //   b) 有当前曲目，但 audio 里那条**不是**它（切歌后 loadTrack 还没 resolve，
    //      或者刚 setTracks 换了歌单）。
    //      ⚠ 我上一版把判据写成 `!loadedSrc` 是**错的** —— 切歌后 loadedSrc 仍是旧值（非空），
    //      于是被判成「已加载」⇒ 直接 play() 打在旧源上 ⇒ 新源一赋值就把媒体元素 reset 掉。
    //      这就是 2026-10-09「第一次能播、之后再点列表里的歌一律播不出（进度停在 0，
    //      拖进度条能出时长但播不动）」的真凶。正解见下面 needLoad 的注释。
    const cur = this.currentIndex >= 0 ? this.tracks[this.currentIndex] : undefined;
    // ⚠⚠ 判据不能只看 `!loadedSrc`（切歌后它仍是上一条的 src，非空）。
    // 正解：判断「**audio 里那条就是当前选中的这条**」——用 loadedIndex 对比。
    // loadedIndex 在 loadTrack 入口先置 -1，所以「加载在途」也天然被算作需要等待。
    const needLoad = this.currentIndex < 0
      ? this.tracks.length > 0
      : (this.loadedIndex !== this.currentIndex || !this.loadedSrc);
    // 决策留痕：这条日志能直接回答「这次点击为什么播不出」——
    // needLoad=0 且 loadedIndex!=idx 就是旧 bug 的签名。
    try {
      window.__HOST_API__?.invoke('debug_log', {
        msg: `MUSIC_PLAY_DECIDE idx=${this.currentIndex} loadedIndex=${this.loadedIndex}`
          + ` hasSrc=${this.loadedSrc ? 1 : 0} hasPath=${cur?.filePath ? 1 : 0} needLoad=${needLoad ? 1 : 0}`,
      }).catch(() => {});
    } catch { /* 忽略 */ }
    if (needLoad) {
      const idx = this.currentIndex >= 0 ? this.currentIndex : 0;
      this.currentIndex = idx;
      this.playAt(idx);
      return;
    }

    // 曲目已加载（或该曲 filePath 缺失，如网易云延迟取地址占位）：直接播。
    // 后者 play() 必然失败，但不影响后续 updateTrackUrl 时的自动续播。
    this.audio.play().catch((err) => this.reportPlayFailure(err));
  }

  // 启动伪律动：仅在未收到 Rust 真实频谱时作为降级方案。
  // 惰性与真实频谱同源：只有频谱消费者（漫游页 EQ，走 requestSpectrum）存在时才跑——
  // 此前 play 事件无条件启动，非漫游页播放时每帧空转 64 桶计算且让主线程永不空闲
  // （破坏浏览器空闲调度，所有交互与它争帧预算 → 音乐模块「粘滞感」的来源之一）。
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
      // 无消费者（不在漫游页）：停跑，等 requestSpectrum 再次唤醒
      if (this.spectrumWanted === 0) {
        this.pseudoAnimFrame = null;
        return;
      }
      // 非 Windows 兜底：用 Web Audio AnalyserNode 取真实频域数据。
      // 仅在「从未收到过 Rust 事件」时才建源 ⇒ Windows 走原路径、行为完全不变。
      if (!this.rustSpectrumSeen && this.ensureWebAnalyser()) {
        this.pullWebSpectrum();
        this.pseudoAnimFrame = requestAnimationFrame(tick);
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

  // ================================================================
  // Web Audio AnalyserNode：非 Windows 平台的真实频谱来源
  // ================================================================

  /**
   * 惰性建立 AudioContext + MediaElementSource + AnalyserNode。
   *
   * ⚠ 静音防护（本项目历史上踩过，详见 webAudioCtx 字段注释）：
   *   只有 ctx.state === 'running' 才建源。建源会把 audio 输出改道进 WebAudio 图，
   *   挂起态下改道 = 直接静音。因此顺序是「先建 ctx、确认 running、再建源」。
   *
   * @returns 是否持有可用的 AnalyserNode（false 表示放弃，回退伪律动）
   */
  private ensureWebAnalyser(): boolean {
    if (this.webAnalyser) return true;
    if (this.webAnalyserTried) return false;
    this.webAnalyserTried = true;

    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return false;

    try {
      const ctx = new Ctor();
      // 防线 1：非 running 一律不建源（自动播放策略下 ctx 初始可能是 suspended）
      if (ctx.state !== 'running') {
        void ctx.close().catch(() => {});
        return false;
      }

      const src = ctx.createMediaElementSource(this.audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;              // → 128 个频域 bin，够 64 条可视化
      analyser.smoothingTimeConstant = 0.72; // 自带时间平滑
      analyser.minDecibels = -85;
      analyser.maxDecibels = -20;
      src.connect(analyser);
      // 防线 2：必须回连 destination，否则元素声音被改道后无处输出 → 静音
      src.connect(ctx.destination);

      // 防线 3：被挂起立刻恢复（切后台/锁屏会触发）
      ctx.addEventListener('statechange', () => {
        if (ctx.state === 'suspended' && this.isPlaying) {
          void ctx.resume().catch(() => {});
        }
      });

      this.webAudioCtx = ctx;
      this.webAnalyser = analyser;
      this.webBins = new Uint8Array(analyser.frequencyBinCount);
      debugLog('music: Web Audio 频谱已启用（非 Windows 真实频域数据）');
      return true;
    } catch (e) {
      // 任何异常都只放弃频谱，不影响播放
      debugLog('music: Web Audio 频谱初始化失败，回退伪律动: ' + String(e));
      this.webAudioCtx = null;
      this.webAnalyser = null;
      this.webBins = null;
      return false;
    }
  }

  /**
   * 从 AnalyserNode 取一帧频域数据，按**对数分组**聚合成 64 条。
   *
   * 为什么对数分组：AnalyserNode 的 bin 是线性频率，fftSize=256 时 128 个 bin 里
   * 绝大部分落在 2kHz 以上（人耳对低频更敏感）。等宽切成 64 条会导致低频只有
   * 2~3 根条在动、其余全静。改成 30Hz→Nyquist 的等比分箱后，低频段分辨率显著变好。
   */
  private pullWebSpectrum(): void {
    const analyser = this.webAnalyser;
    const bins = this.webBins;
    if (!analyser || !bins) return;
    analyser.getByteFrequencyData(bins as Uint8Array<ArrayBuffer>);

    const n = this.spectrumData.length;
    const nyquist = (this.webAudioCtx?.sampleRate ?? 44100) / 2;
    const binHz = nyquist / bins.length;
    const F_MIN = 30; // 20Hz 以下几乎无内容，从 30Hz 起
    const ratio = nyquist / F_MIN;

    for (let i = 0; i < n; i++) {
      const f0 = F_MIN * Math.pow(ratio, i / n);
      const f1 = F_MIN * Math.pow(ratio, (i + 1) / n);
      let b0 = Math.floor(f0 / binHz);
      let b1 = Math.ceil(f1 / binHz);
      if (b0 >= bins.length) b0 = bins.length - 1;
      if (b1 <= b0) b1 = b0 + 1;
      if (b1 > bins.length) b1 = bins.length;
      let peak = 0;
      for (let b = b0; b < b1; b++) {
        if (bins[b] > peak) peak = bins[b];
      }
      // getByteFrequencyData 已做 dB→0..255 映射，低频天然偏小，给一点增益让低频条可见
      const v = Math.min(255, peak * 1.2);
      this.spectrumData[i] = this.spectrumData[i] * 0.55 + v * 0.45;
    }
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
    // 消费者就位：若正在播放且尚无真实频谱，立即恢复伪律动兜底
    // （否则 EQ 要等 Rust 真实频谱首帧才有动画）
    if (this.isPlaying && !this.hasRealSpectrum) this.startPseudoAnalyser();
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
        // 标记 Rust 侧真实频谱可用（Windows）：此后**永不**创建 MediaElementSource，
        // 既保持 Windows 原有行为不变，也规避改道静音风险。
        this.rustSpectrumSeen = true;
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
      this.playAt(nextIndex);
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
    if (idx >= 0) { this.playAt(idx); }
  }

  prev(): void {
    const idx = this.getPrevIndex();
    if (idx >= 0) { this.playAt(idx); }
  }
  // 跳转到队列中指定索引播放（漫游队列点击切歌用）
  playIndex(index: number): void {
    if (index < 0 || index >= this.tracks.length) return;
      this.playAt(index);
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
      // 关闭 Web Audio 图：audio 输出曾被改道进 ctx，close() 同时断开，
      // 元素后续由插件销毁流程清空 src，不会再有声音从旧图流出。
      if (this.webAudioCtx) {
        void this.webAudioCtx.close().catch(() => {});
        this.webAudioCtx = null;
        this.webAnalyser = null;
        this.webBins = null;
        debugLog('music: Web Audio 频谱已关闭');
      }
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
      this.loadedIndex = -1;
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