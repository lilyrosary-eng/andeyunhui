/// <reference path="../../global.d.ts" />
// 视频播放器 — 自定义控制条 + 上一集/下一集 + 双击全屏
import { formatTime } from '../../_shared/utils';
import {
  PlayIcon, PauseIcon, SkipBackIcon, SkipForwardIcon,
  VolumeIcon, VolumeMuteIcon, FullscreenIcon, MinimizeIcon, ArrowLeftIcon,
} from '../../_shared/icons';
const React = window.__HOST_REACT__;
const { useState, useEffect, useCallback, useRef, useMemo } = React;
const hostApi = window.__HOST_API__;
const { IconButton } = window.__HOST_UI__ || {};
// debugLog 双写：①直接 console.log（WebView DevTools 控制台可见，不经 Rust 桥、永不被吞，
// 最可靠的排查手段）；②再经 debug_log 命令转发到 Rust 终端。
const debugLog = (m: string) => {
  try { console.log('[video-smtc]', m); } catch { /* 忽略 */ }
  try {
    hostApi?.invoke?.('debug_log', { msg: `[video] ${m}` }).catch(() => {});
  } catch {
    /* 忽略 */
  }
};

interface VideoFile {
  filePath: string;
  fileName: string;
  sizeBytes: number;
}

interface VideoSettings {
  rememberProgress: boolean;
  rememberVolume: boolean;
  autoHideControls: boolean;
  playbackSpeed: number;
  autoPlayNext: boolean;
}

interface VideoPlayerProps {
  file: VideoFile;
  videoList: VideoFile[];
  onFileChange: (file: VideoFile) => void;
  onBack: () => void;
  settings: VideoSettings;
  onSettingsChange: (s: Partial<VideoSettings>) => void;
}

// 进度存储 key
const PROGRESS_KEY_PREFIX = 'video_progress_';
const VOLUME_KEY = 'video_volume';

const SPEEDS = [0.5, 1, 1.25, 1.5, 2] as const;

// ========== 音量悬浮弹出 ==========
function VolumePopup({ volume, onVolumeChange }: { volume: number; onVolumeChange: (vol: number) => void }) {
  const [showPopup, setShowPopup] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<number>(0);
  const [isDragging, setIsDragging] = useState(false);
  // 记住最近一次非零音量，作为取消静音时的恢复值（点击静音图标再点恢复时用）。
  const lastVolumeRef = useRef(volume > 0 ? volume : 0.7);
  useEffect(() => {
    if (volume > 0) lastVolumeRef.current = volume;
  }, [volume]);

  const updateFromEvent = useCallback((clientY: number) => {
    if (!trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const y = clientY - rect.top;
    const h = rect.height;
    const vol = Math.max(0, Math.min(1, 1 - y / h));
    onVolumeChange(vol);
  }, [onVolumeChange]);

  const handleTrackMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    updateFromEvent(e.clientY);
    const handleMove = (me: MouseEvent) => updateFromEvent(me.clientY);
    const handleUp = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
  }, [updateFromEvent]);

  const handleMouseEnter = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setShowPopup(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    hideTimerRef.current = setTimeout(() => setShowPopup(false), 200) as unknown as number;
  }, []);

  const isMuted = volume === 0;
  const restoreVolume = lastVolumeRef.current > 0 ? lastVolumeRef.current : 0.7;
  const btn = IconButton
    ? React.createElement(IconButton, {
        onClick: () => onVolumeChange(isMuted ? restoreVolume : 0),
        title: isMuted ? `已静音（点击恢复 ${Math.round(restoreVolume * 100)}%）` : `音量 ${Math.round(volume * 100)}%（点击静音）`,
        active: showPopup,
        children: React.createElement(isMuted ? VolumeMuteIcon : VolumeIcon),
      })
    : React.createElement('button', {
        onClick: () => onVolumeChange(isMuted ? restoreVolume : 0),
        title: isMuted ? `已静音（点击恢复 ${Math.round(restoreVolume * 100)}%）` : `音量 ${Math.round(volume * 100)}%（点击静音）`,
        className: 'btn-press p-1.5 rounded-full transition-all duration-150 text-white/70 hover:text-white',
        children: React.createElement(isMuted ? VolumeMuteIcon : VolumeIcon),
      });

  return React.createElement('div', {
    className: 'relative',
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
  }, btn,
    showPopup && React.createElement('div', {
      className: 'absolute bottom-full left-1/2 -translate-x-1/2 mb-2 p-3 rounded-xl shadow-lg border border-white/10 z-50',
      style: { background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(12px)' },
      onMouseEnter: () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current); },
      onMouseLeave: handleMouseLeave,
    },
      React.createElement('div', { className: 'flex flex-col items-center gap-2' },
        React.createElement('span', { className: 'text-xs text-white/60 tabular-nums' }, `${Math.round(volume * 100)}`),
        React.createElement('div', {
          ref: trackRef,
          onMouseDown: handleTrackMouseDown,
          className: 'relative w-1.5 h-28 rounded-full cursor-pointer flex-shrink-0',
          style: { background: 'rgba(255,255,255,0.2)' },
        },
          React.createElement('div', {
            key: 'fill',
            className: 'absolute bottom-0 left-0 right-0 rounded-full',
            style: { height: `${volume * 100}%`, background: 'var(--element-bg)', transition: isDragging ? 'none' : 'height 0.1s' },
          }),
          React.createElement('div', {
            key: 'thumb',
            className: 'absolute left-1/2 -translate-x-1/2 w-4 h-4 rounded-full shadow-md border-2 border-white',
            style: { bottom: `calc(${volume * 100}% - 8px)`, background: 'var(--element-bg)', transition: isDragging ? 'none' : 'bottom 0.1s' },
          }),
        ),
      ),
    ),
  );
}

// ========== 主组件 ==========
export function VideoPlayer({ file, videoList, onFileChange, onBack, settings, onSettingsChange }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(() => {
    // 记住音量
    if (settings.rememberVolume) {
      const saved = localStorage.getItem(VOLUME_KEY);
      if (saved) return parseFloat(saved);
    }
    return 0.7;
  });
  const [showControls, setShowControls] = useState(true);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const hideTimerRef = useRef<number>(0);
  const videoUrl = hostApi.convertFileSrc(file.filePath);

  // 当前视频在列表中的位置
  const currentIndex = useMemo(() =>
    videoList.findIndex(v => v.filePath === file.filePath),
    [file.filePath, videoList]
  );
  const isFirst = currentIndex <= 0;
  const isLast = currentIndex >= videoList.length - 1;

  // 用 ref 保存最新导航状态，避免 smtc-control 监听器闭包捕获到过期的 currentIndex/isFirst/isLast。
  const navRef = useRef({ currentIndex, isFirst, isLast, videoList, onFileChange });
  navRef.current = { currentIndex, isFirst, isLast, videoList, onFileChange };

  // 直接推送（不走 useEffect，避免 effect 不触发导致推送丢失）：在 <video> 原生
  // play/pause/loadedmetadata 事件里调用，保证真实播放时一定把元信息推到 Rust。
  // console.error 在沙箱里永不被吞（safe console 仅 noop 掉 log/info/debug），
  // 故用它做诊断，Rust 终端必能看见，便于确认推送是否真发出。
  const pushSmtcNow = useCallback((playing: boolean) => {
    const api = (window.__HOST_API__ as any) || hostApi;
    if (!api || !api.invoke) {
      console.error('[video-smtc][DIAG] pushSmtcNow: NO API');
      return;
    }
    const title = file?.fileName || '视频';
    const nav = navRef.current;
    console.error('[video-smtc][DIAG] pushSmtcNow playing=', playing, 'title=', title);
    api.invoke('debug_log', { msg: `VIDEO_PUSH_NOW playing=${playing} title=${title}` }).catch(() => {});
    api
      .invoke('smtc_update', {
        info: {
          title,
          artist: '',
          album: '',
          media_type: 'video',
          is_playing: playing,
          can_prev: !nav.isFirst,
          can_next: !nav.isLast,
        },
      })
      .then(() => {
        console.error('[video-smtc][DIAG] push OK');
        api.invoke('debug_log', { msg: 'VIDEO_PUSH_NOW_OK' }).catch(() => {});
      })
      .catch((e: unknown) => {
        console.error('[video-smtc][DIAG] push FAIL', String(e));
        api.invoke('debug_log', { msg: 'VIDEO_PUSH_NOW_FAIL ' + String(e) }).catch(() => {});
      });
  }, [file?.fileName]);

  // 记住进度
  useEffect(() => {
    if (!settings.rememberProgress) return;
    const savedKey = PROGRESS_KEY_PREFIX + file.filePath;
    const savedTime = localStorage.getItem(savedKey);
    const video = videoRef.current;
    if (savedTime && video) {
      const t = parseFloat(savedTime);
      if (t > 1) { // 跳过开头几秒，避免跳到结尾
        video.currentTime = t;
      }
    }
  }, [file.filePath, settings.rememberProgress]);

  // 进度自动保存
  useEffect(() => {
    if (!settings.rememberProgress) return;
    const interval = setInterval(() => {
      const video = videoRef.current;
      if (video && !video.paused && video.currentTime > 0) {
        localStorage.setItem(PROGRESS_KEY_PREFIX + file.filePath, String(video.currentTime));
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [file.filePath, settings.rememberProgress]);

  // 音量持久化
  useEffect(() => {
    if (settings.rememberVolume) {
      localStorage.setItem(VOLUME_KEY, String(volume));
    }
  }, [volume, settings.rememberVolume]);

  // 视频事件绑定
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onTimeUpdate = () => setCurrentTime(video.currentTime);
    const onLoadedMetadata = () => setDuration(video.duration);
    const onEnded = () => {
      setIsPlaying(false);
      // 自动播放下一集
      if (settings.autoPlayNext && !isLast && currentIndex >= 0) {
        const next = videoList[currentIndex + 1];
        if (next) onFileChange(next);
      }
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('ended', onEnded);
    video.volume = volume;
    video.playbackRate = settings.playbackSpeed;

    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('ended', onEnded);
    };
  }, [file.filePath]);

  // Windows 任务栏「正在播放」媒体控件：
  //  - JS mediaSession：把文件名作为标题推送（兜底；Chromium 可能已被 --disable-features=MediaSession 禁用，故全程 guard）。
  //  - 本进程 SMTC 会话（Rust 端）：任务栏显「岸灯鸢花」并回传系统媒体键。
  // 关键：smtc-control 监听必须【无条件】注册，不能依赖 Chromium mediaSession 是否存在——
  // 否则一旦 mediaSession 被禁用，视频就完全收不到任务栏/触摸板的播放、上一集、下一集指令。
  // JS mediaSession（仅作兜底，存在才用）：绑定系统媒体键处理器 + 同步 Chromium 播放态。
  // 本进程 SMTC 的元信息推送已拆到下方独立 effect，不依赖 <video> 元素是否存在，
  // 避免 video 元素未挂载导致推送不执行（→ 任务栏回退 com.andengyuanhua.desktop + 媒体键被丢弃）。
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const ms = (navigator as unknown as { mediaSession?: Record<string, unknown> }).mediaSession as
      | { metadata?: unknown; playbackState?: string; setPositionState?: (s: { duration: number; position: number; playbackRate: number }) => void; setActionHandler?: (a: string, h: ((d?: { seekTime?: number }) => void) | null) => void }
      | undefined;
    // 注意：与 music 插件同理，任务栏「正在播放」卡片统一由 Rust SMTC 会话负责，
    // 且媒体键由 Rust ButtonPressed 回传处理。此处【不】设置 JS navigator.mediaSession
    // 的 metadata 与处理器，避免 WebView2 生成一张「未知应用」的重复卡片、并与 Rust 路径
    // 重复触发媒体键。Rust 侧的元信息推送在下方独立的 useEffect（pushSmtcNow）中完成。
    if (ms) {
      /* 故意留空：OS 媒体卡片由 Rust SMTC 接管，媒体键由 Rust 回传处理 */
    }
    const onPlay = () => { try { if (ms) ms.playbackState = 'playing'; } catch { /* */ } };
    const onPause = () => { try { if (ms) ms.playbackState = 'paused'; } catch { /* */ } };
    const onTime = () => {
      try {
        if (ms && ms.setPositionState && video.duration) {
          ms.setPositionState({ duration: video.duration, position: video.currentTime, playbackRate: video.playbackRate });
        }
      } catch { /* */ }
    };
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('timeupdate', onTime);
    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('timeupdate', onTime);
      if (ms && ms.setActionHandler) {
        ms.setActionHandler('play', null);
        ms.setActionHandler('pause', null);
        ms.setActionHandler('seekto', null);
        ms.setActionHandler('seekbackward', null);
        ms.setActionHandler('seekforward', null);
        ms.setActionHandler('stop', null);
      }
    };
  }, [file.filePath]);

  // 本进程 SMTC 会话元信息推送：【独立于 <video> 元素】，文件/播放态变化时即推。
  // 修复此前 video 元素未挂载导致 pushSmtc 不执行 → video_ok 恒为 false → 媒体键被判定
  // 「无活动会话」丢弃、任务栏回退显示 com.andengyuanhua.desktop。
  useEffect(() => {
    const api = (window.__HOST_API__ as any) || hostApi;
    if (!api || !api.invoke) {
      console.error('[video-smtc][DIAG] effect: NO API');
      return;
    }
    if (!file) {
      // 早期 file 为空时直接跳过（不再静默丢推送），并用 debug_log 留痕便于定位。
      api.invoke('debug_log', { msg: 'VIDEO_PUSH_EFFECT skip: file 为空' }).catch(() => {});
      return;
    }
    const title = file.fileName || '视频';
    // debug_log 会以 [FE] 前缀必定出现在 Rust 终端，作为"推送是否真发出"的不可抵赖证据。
    api.invoke('debug_log', { msg: `VIDEO_PUSH_EFFECT fileName=${title} playing=${isPlaying} isFirst=${isFirst} isLast=${isLast}` }).catch(() => {});
    api.invoke('smtc_update', {
      info: {
        title,
        artist: '',
        album: '',
        media_type: 'video',
        is_playing: isPlaying,
        can_prev: !isFirst,
        can_next: !isLast,
      },
    })
      .then(() => api.invoke('debug_log', { msg: 'VIDEO_PUSH_EFFECT_OK' }).catch(() => {}))
      .catch((e: unknown) => api.invoke('debug_log', { msg: 'VIDEO_PUSH_EFFECT_FAIL ' + String(e) }).catch(() => {}));
  }, [file?.filePath, isPlaying, isFirst, isLast]);

  // 系统媒体键监听：独立成 effect，【挂载即注册】，不依赖 <video> 元素是否存在，
  // 内部动态读取 videoRef/navRef，彻底避免被上面的 if (!video) return 早退而漏注册
  //（此前"视频模块按键无效果、DevTools 无日志"的根因）。
  useEffect(() => {
    if (!window.__HOST_API__) {
      console.warn('[video] 缺少 __HOST_API__，媒体键监听未注册');
      return;
    }
    let cleaned = false;
    let unsub: (() => void) | null = null;
    debugLog('video: smtc listener registering (always-on)');
    hostApi
      .listen<{ action?: string; target?: string } | string>('smtc-control', (e) => {
        const raw = e.payload as { action?: string; target?: string } | string;
        const b = typeof raw === 'string' ? raw : raw?.action;
        const t = typeof raw === 'string' ? '' : raw?.target;
        if (t && t !== 'video') {
          debugLog(`video BTN ignored action=${b} target=${t}`);
          return;
        }
        const nav = navRef.current;
        const video = videoRef.current;
        debugLog(`video BTN ${b} (target=${t || 'any'}) isFirst=${nav?.isFirst} isLast=${nav?.isLast} idx=${nav?.currentIndex}`);
        if (b === 'play') { if (video) video.play().catch(() => {}); }
        else if (b === 'pause') { if (video) video.pause(); }
        else if (b === 'toggle' || b === 'playpause') { if (video) { if (video.paused) video.play().catch(() => {}); else video.pause(); } }
        else if (b === 'next') { if (nav && !nav.isLast) { const n = nav.videoList[nav.currentIndex + 1]; if (n) nav.onFileChange(n); } }
        else if (b === 'previous') { if (nav && !nav.isFirst) { const p = nav.videoList[nav.currentIndex - 1]; if (p) nav.onFileChange(p); } }
        else if (b === 'stop') { if (video) { video.pause(); video.currentTime = 0; } }
        else if (b === 'seekforward') { if (video) video.currentTime = Math.min(video.duration || 0, video.currentTime + 10); }
        else if (b === 'seekbackward') { if (video) video.currentTime = Math.max(0, video.currentTime - 10); }
      })
      .then((u) => { if (cleaned) u(); else { unsub = u; debugLog('video: smtc listener registered'); } })
      .catch((e) => { console.warn('[video] smtc-control 监听注册失败（媒体键将失效）', e); debugLog('video: smtc listener register FAILED ' + String(e)); });
    return () => {
      cleaned = true;
      if (unsub) { unsub(); debugLog('video: smtc listener removed'); }
    };
  }, []);

  // 音量/播放速度变动同步到 video
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
    }
  }, [volume]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = settings.playbackSpeed;
    }
  }, [settings.playbackSpeed]);

  // 监听全屏状态变化
  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  // 控制条自动隐藏
  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (!isPlaying) return;
    hideTimerRef.current = setTimeout(() => {
      setShowControls(false);
    }, 3000) as unknown as number;
  }, [isPlaying]);

  useEffect(() => {
    resetHideTimer();
    return () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current); };
  }, [isPlaying, settings.autoHideControls]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) { video.play().catch(() => {}); }
    else { video.pause(); }
  }, []);

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    if (videoRef.current) videoRef.current.currentTime = time;
    setCurrentTime(time);
  }, []);

  const handleFullscreen = useCallback(() => {
    if (isFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (containerRef.current) {
      containerRef.current.requestFullscreen().catch(() => {});
    }
  }, [isFullscreen]);

  // 双击全屏切换
  const handleDblClick = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      handleFullscreen();
    }
  }, [handleFullscreen]);

  // 上一集
  const handlePrev = useCallback(() => {
    if (isFirst) return;
    const prev = videoList[currentIndex - 1];
    if (prev) onFileChange(prev);
  }, [currentIndex, isFirst, videoList, onFileChange]);

  // 下一集
  const handleNext = useCallback(() => {
    if (isLast) return;
    const next = videoList[currentIndex + 1];
    if (next) onFileChange(next);
  }, [currentIndex, isLast, videoList, onFileChange]);

  const toggleSpeedMenu = useCallback(() => setShowSpeedMenu(p => !p), []);
  const setSpeed = useCallback((speed: number) => {
    onSettingsChange({ playbackSpeed: speed });
    setShowSpeedMenu(false);
  }, [onSettingsChange]);

  // 键盘快捷键：上下键调音量，左右键调进度，空格控制启停
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const video = videoRef.current;
    if (!video) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (video.paused) { video.play().catch(() => {}); }
        else { video.pause(); }
        break;
      case 'ArrowUp':
        e.preventDefault();
        setVolume(v => Math.min(1, Math.round((v + 0.05) * 100) / 100));
        break;
      case 'ArrowDown':
        e.preventDefault();
        setVolume(v => Math.max(0, Math.round((v - 0.05) * 100) / 100));
        break;
      case 'ArrowLeft':
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 5);
        break;
      case 'ArrowRight':
        e.preventDefault();
        video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
        break;
    }
    resetHideTimer();
  }, [resetHideTimer]);

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const canHide = settings.autoHideControls;

  // 当前速度标签
  const speedLabel = settings.playbackSpeed >= 1
    ? `${settings.playbackSpeed}x`
    : `${settings.playbackSpeed}x`;

  return React.createElement('div', {
    ref: containerRef,
    className: 'subtle-frame relative flex flex-col h-full bg-black group',
    tabIndex: 0,
    onKeyDown: handleKeyDown,
    onMouseMove: resetHideTimer,
    onMouseLeave: () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (isPlaying) setShowControls(false);
    },
  },
    // 视频元素
    React.createElement('video', {
      ref: videoRef,
      src: videoUrl,
      className: 'w-full h-full object-contain',
      onClick: togglePlay,
      onDoubleClick: handleDblClick,
      autoPlay: true,
      // 原生播放事件内联推送：真实播放/暂停时必定触发，不依赖 useEffect 时机。
      onPlay: () => {
        setIsPlaying(true);
        pushSmtcNow(true);
      },
      onPause: () => {
        setIsPlaying(false);
        pushSmtcNow(false);
      },
      onLoadedMetadata: () => {
        if (videoRef.current) setDuration(videoRef.current.duration);
        pushSmtcNow(isPlaying);
      },
      style: { cursor: canHide && !showControls ? 'none' : 'default' },
    }),

    // 顶部返回栏
    React.createElement('div', {
      className: `absolute top-0 left-0 right-0 flex items-center gap-3 px-4 py-2 bg-gradient-to-b from-black/70 to-transparent transition-opacity duration-300 ${
        showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`,
    },
      IconButton
        ? React.createElement(IconButton, { onClick: onBack, title: '返回', children: React.createElement(ArrowLeftIcon) })
        : React.createElement('button', { onClick: onBack, className: 'btn-press p-1.5 rounded-full transition-all duration-150 text-white/70 hover:text-white', children: React.createElement(ArrowLeftIcon) }),
      React.createElement('span', { className: 'text-sm text-white/80 truncate flex-1' }, file.fileName),
    ),

    // 中央大播放按钮（暂停时显示）
    !isPlaying && React.createElement('div', {
      className: `absolute inset-0 flex items-center justify-center transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0'}`,
      onClick: togglePlay,
    },
      React.createElement('div', {
        className: 'w-16 h-16 rounded-full bg-white/50 backdrop-blur-sm flex items-center justify-center cursor-pointer hover:bg-white/70 transition-colors text-white shadow-lg',
        children: React.createElement(PlayIcon),
      }),
    ),

    // 底部控制条
    React.createElement('div', {
      className: `absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent transition-opacity duration-300 ${
        showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`,
    },
      React.createElement('div', { className: 'px-4 pb-3 pt-8 text-white/90' },
        // 第一行：进度条（跨满宽度）
        React.createElement('div', { className: 'flex items-center gap-2.5 mb-3' },
          React.createElement('span', { className: 'text-[11px] text-white/60 w-9 text-right tabular-nums flex-shrink-0' }, formatTime(currentTime)),
          React.createElement('div', { className: 'flex-1 relative' },
            React.createElement('input', {
              type: 'range',
              min: 0, max: duration || 0, step: 0.1,
              value: currentTime,
              onChange: handleSeek,
              className: 'w-full h-0.5 rounded-full appearance-none cursor-pointer',
              style: { background: `linear-gradient(to right, var(--element-bg, #5a7f5d) ${progressPct}%, rgba(255,255,255,0.2) ${progressPct}%)` },
            }),
          ),
          React.createElement('span', { className: 'text-[11px] text-white/60 w-9 tabular-nums flex-shrink-0' }, formatTime(duration)),
        ),

        // 第二行：左 [上一集][播放/暂停][下一集] | 右 [速度][音量][全屏]
        React.createElement('div', { className: 'flex items-center justify-between' },
          // 左侧控制组
          React.createElement('div', { className: 'flex items-center gap-1' },
            // 上一集
            IconButton
              ? React.createElement(IconButton, {
                  onClick: handlePrev,
                  title: '上一集',
                  children: React.createElement('span', { style: { opacity: isFirst ? 0.3 : 1 } },
                    React.createElement(SkipBackIcon),
                  ),
                  active: false,
                })
              : React.createElement('button', {
                  onClick: handlePrev,
                  disabled: isFirst,
                  title: '上一集',
                  style: { opacity: isFirst ? 0.3 : 1, cursor: isFirst ? 'default' : 'pointer' },
                  className: 'btn-press p-1.5 rounded-full transition-all duration-150 text-white/70 hover:text-white',
                  children: React.createElement(SkipBackIcon),
                }),

            // 播放/暂停
            IconButton
              ? React.createElement(IconButton, {
                  onClick: togglePlay,
                  title: isPlaying ? '暂停' : '播放',
                  children: React.createElement(isPlaying ? PauseIcon : PlayIcon),
                })
              : React.createElement('button', {
                  onClick: togglePlay,
                  className: 'btn-press p-1.5 rounded-full transition-all duration-150 text-white/70 hover:text-white',
                  children: React.createElement(isPlaying ? PauseIcon : PlayIcon),
                }),

            // 下一集
            IconButton
              ? React.createElement(IconButton, {
                  onClick: handleNext,
                  title: '下一集',
                  children: React.createElement('span', { style: { opacity: isLast ? 0.3 : 1 } },
                    React.createElement(SkipForwardIcon),
                  ),
                  active: false,
                })
              : React.createElement('button', {
                  onClick: handleNext,
                  disabled: isLast,
                  title: '下一集',
                  style: { opacity: isLast ? 0.3 : 1, cursor: isLast ? 'default' : 'pointer' },
                  className: 'btn-press p-1.5 rounded-full transition-all duration-150 text-white/70 hover:text-white',
                  children: React.createElement(SkipForwardIcon),
                }),
          ),

          // 右侧控制组
          React.createElement('div', { className: 'flex items-center gap-1' },
            // 播放速度
            React.createElement('div', { className: 'relative' },
              IconButton
                ? React.createElement(IconButton, {
                    onClick: toggleSpeedMenu,
                    title: `播放速度 ${speedLabel}`,
                    active: showSpeedMenu,
                    children: React.createElement('span', { className: 'text-xs font-medium text-white/80' }, speedLabel),
                  })
                : React.createElement('button', {
                    onClick: toggleSpeedMenu,
                    title: `播放速度 ${speedLabel}`,
                    className: 'btn-press p-1.5 rounded-full transition-all duration-150 text-white/70 hover:text-white',
                    children: React.createElement('span', { className: 'text-xs font-medium' }, speedLabel),
                  }),
              showSpeedMenu && React.createElement('div', {
                className: 'absolute bottom-full left-1/2 -translate-x-1/2 mb-2 py-1 rounded-xl shadow-lg border border-white/10 z-50 min-w-[80px]',
                style: { background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(12px)' },
              },
                ...SPEEDS.map(speed =>
                  React.createElement('button', {
                    key: speed,
                    onClick: () => setSpeed(speed),
                    className: `w-full text-center px-4 py-1.5 text-sm transition-colors ${
                      settings.playbackSpeed === speed
                        ? 'text-white font-medium'
                        : 'text-white/50 hover:text-white/80'
                    }`,
                    children: `${speed}x`,
                  })
                ),
              ),
            ),

            // 音量
            React.createElement(VolumePopup, { volume, onVolumeChange: setVolume }),

            // 全屏（双态图标：进入/退出）
            IconButton
              ? React.createElement(IconButton, {
                  onClick: handleFullscreen,
                  title: isFullscreen ? '退出全屏' : '全屏',
                  children: React.createElement(isFullscreen ? MinimizeIcon : FullscreenIcon),
                })
              : React.createElement('button', {
                  onClick: handleFullscreen,
                  className: 'btn-press p-1.5 rounded-full transition-all duration-150 text-white/70 hover:text-white',
                  children: React.createElement(isFullscreen ? MinimizeIcon : FullscreenIcon),
                }),
          ),
        ),
      ),
    ),
  );
}