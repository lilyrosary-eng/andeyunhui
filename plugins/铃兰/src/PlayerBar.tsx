/// <reference path="../../global.d.ts" />
import React from "react";
// 音乐播放控制条 — 固定于音乐模块内容区底部，不覆盖导航栏
import { musicPlayer, type Track, type PlayMode } from './musicPlayer';
import type { Playlist } from './index';
import { lyricsSync, parseLrc, isNeteaseRemote, neteaseSongId, isKugouRemote, kugouSongId } from './lyricsSync';
import { neteaseGetLyric } from './neteaseApi';
import { getLyric as kugouGetLyric } from './kugouApi';
import { getNeteaseQualityBr, setNeteaseQualityBr, getNeteaseQualityLabel, NETEASE_QUALITY_OPTIONS, getSongUrl } from './neteaseApi';
import { formatTime } from '../../_shared/utils';

// 网易云歌词加载分支：远程曲跳过本地 get_lyrics，改走 neteaseGetLyric
async function loadNeteaseLyric(t: Track): Promise<void> {
  const sid = neteaseSongId(t);
  if (sid == null) return;
  const parsed = await neteaseGetLyric(sid);
  if (parsed) lyricsSync.setLines(parsed);
  if (!parsed || parsed.length === 0) {
    hostApi.emit('lyrics-update', { currentLine: T('music.nowPlaying.noLyrics'), nextLine: '' }).catch(() => {});
  }
}

// 酷狗歌词加载分支：远程曲走 kugouApi.getLyric
async function loadKugouLyric(t: Track): Promise<void> {
  const hash = kugouSongId(t);
  if (!hash) return;
  const lrc = await kugouGetLyric(hash, t.title || '');
  const parsed = lrc && lrc.lyric ? parseLrc(lrc.lyric) : [];
  lyricsSync.setLines(parsed);
  if (parsed.length === 0) {
    hostApi.emit('lyrics-update', { currentLine: T('music.nowPlaying.noLyrics'), nextLine: '' }).catch(() => {});
  }
}

// 统一歌词加载（本地 + 网易云 + 酷狗）
function loadLyricsFor(t: Track, skipOnline: boolean, localFirst: boolean): Promise<void> {
  if (isNeteaseRemote(t)) return loadNeteaseLyric(t);
  if (isKugouRemote(t)) return loadKugouLyric(t);
  return hostApi.invoke<LyricsResult>('get_lyrics', {
    trackPath: t.filePath,
    title: t.title,
    artist: t.artist,
    skipOnline,
    localFirst,
  }).then((result) => {
    lyricsSync.setLines(result.lines);
    if (result.lines.length === 0) {
      hostApi.emit('lyrics-update', { currentLine: T('music.nowPlaying.noLyrics'), nextLine: '' }).catch(() => {});
    }
  }).catch(() => {});
}
import { T, useLang } from '../../_shared/pluginRuntime';
import {
  PlayIcon, PauseIcon, SkipBackIcon, SkipForwardIcon, VolumeIcon, VolumeMuteIcon,
  ListIcon, SingleIcon, ShuffleIcon, MusicIcon, LyricsIcon, LockIcon, UnlockIcon,
  HeartIcon,
} from '../../_shared/icons';

const { useState, useEffect, useCallback, useRef } = React;
const hostApi = window.__HOST_API__;
const { IconButton: SharedIconButton } = window.__HOST_UI__ || {};

// 降级：如果共享 IconButton 不可用，使用本地实现
const IconButton = SharedIconButton || function IconButton({
  onClick, title, active, children,
}: {
  onClick: () => void; title: string; active?: boolean; children: React.ReactNode;
}) {
  return React.createElement('button', {
    onClick, title,
    className: 'btn-press p-1.5 rounded-full transition-all duration-150',
    style: {
      color: active ? 'var(--element-bg)' : undefined,
      background: 'transparent',
    },
    onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => {
      (e.currentTarget as HTMLButtonElement).style.background = 'var(--element-muted)';
    },
    onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => {
      (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
    },
  }, children);
};

// 歌词数据类型
interface LyricLine { time_ms: number; text: string; }
interface LyricsResult { lines: LyricLine[]; source: string; }

interface PlayerBarProps {
  track: Track;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onPrev: () => void;
  onNext: () => void;
  volume: number;
  onVolumeChange: (vol: number) => void;
  playMode: PlayMode;
  onPlayModeChange: (mode: PlayMode) => void;
  onCoverClick: () => void;
  // 播放列表面板所需：歌单列表、当前播放歌单、选曲回调（带歌单 id）
  playlists: Playlist[];
  currentPlaylistId: string | null;
  onSelectTrack: (playlistId: string, track: Track, index: number) => void;
  isFavorite?: boolean;
  onToggleFavorite?: (track: Track) => void;
}

const ModeLabels: Record<PlayMode, string> = {
  list: 'music.player.modeList',
  single: 'music.player.modeSingle',
  random: 'music.player.modeRandom',
};

// ========== 音量悬浮弹出组件 ==========
function VolumePopup({
  volume,
  onVolumeChange,
}: {
  volume: number;
  onVolumeChange: (vol: number) => void;
}) {
  const [showPopup, setShowPopup] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<number>(0);
  const [isDragging, setIsDragging] = useState(false);
  // 记住最近一次非零音量，作为取消静音时的恢复值（点击静音图标再点恢复时用）。
  const lastVolumeRef = useRef(volume > 0 ? volume : 0.7);
  // 音量变化且非零时记录，供取消静音恢复使用。
  useEffect(() => {
    if (volume > 0) lastVolumeRef.current = volume;
  }, [volume]);
  const isMuted = volume === 0;
  // 点击音量图标：静音↔恢复。静音时把音量置 0，恢复时回到静音前的音量。
  const toggleMute = useCallback(() => {
    if (isMuted) {
      onVolumeChange(lastVolumeRef.current > 0 ? lastVolumeRef.current : 0.7);
    } else {
      onVolumeChange(0);
    }
  }, [isMuted, onVolumeChange]);

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

  return React.createElement('div', {
    className: 'relative',
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
  },
    React.createElement(IconButton, {
      onClick: toggleMute,
      title: isMuted
        ? T('music.player.muted', { pct: Math.round((lastVolumeRef.current || 0.7) * 100) })
        : T('music.player.volume', { pct: Math.round(volume * 100) }),
      active: showPopup,
      children: React.createElement(isMuted ? VolumeMuteIcon : VolumeIcon),
    }),
    showPopup && React.createElement('div', {
      className: 'absolute bottom-full left-1/2 -translate-x-1/2 mb-2 p-3 rounded-xl shadow-lg border border-neutral-200/30 dark:border-stone-700/30 z-50',
      style: { background: 'var(--nav-primary-bg)', backdropFilter: 'blur(12px)' },
      onMouseEnter: () => {
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      },
      onMouseLeave: handleMouseLeave,
    },
      React.createElement('div', { className: 'flex flex-col items-center gap-2' },
        React.createElement('span', {
          className: 'text-xs text-neutral-500 dark:text-stone-400 tabular-nums',
        }, `${Math.round(volume * 100)}`),
        React.createElement('div', {
          ref: trackRef,
          onMouseDown: handleTrackMouseDown,
          className: 'relative w-1.5 h-28 rounded-full cursor-pointer flex-shrink-0',
          style: { background: 'rgb(212 212 212)' },
          children: [
            // 已填充部分
            React.createElement('div', {
              key: 'fill',
              className: 'absolute bottom-0 left-0 right-0 rounded-full',
              style: {
                height: `${volume * 100}%`,
                background: 'var(--element-bg)',
                transition: isDragging ? 'none' : 'height 0.1s',
              },
            }),
            // 拖拽圆点
            React.createElement('div', {
              key: 'thumb',
              className: 'absolute left-1/2 -translate-x-1/2 w-4 h-4 rounded-full shadow-md border-2 border-white dark:border-stone-600',
              style: {
                bottom: `calc(${volume * 100}% - 8px)`,
                background: 'var(--element-bg)',
                transition: isDragging ? 'none' : 'bottom 0.1s',
              },
            }),
          ],
        }),
      ),
    ),
  );
}

export { VolumePopup };

// ========== 播放列表弹窗（与音量弹窗同款：小型弹出式菜单）==========
// 点开可看到「当前播放的歌单是哪个、有哪些歌曲」，并可点选歌曲立即播放。
export function PlaylistPopup({
  playlists,
  currentPlaylistId,
  currentTrack,
  onSelectTrack,
}: {
  playlists: Playlist[];
  currentPlaylistId: string | null;
  currentTrack: Track | null;
  // 选曲回调：带上「该曲所属歌单 id」，由调用方用对应歌单的 tracks 播放（不依赖侧栏选中态）
  onSelectTrack: (playlistId: string, track: Track, index: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // 弹窗内当前展示的歌单：默认跟随实际播放歌单，用户也可在 <select> 中临时浏览其它歌单
  const [displayPlaylistId, setDisplayPlaylistId] = useState<string | null>(currentPlaylistId);

  // 实际播放歌单变化时，弹窗内展示同步回退到当前播放歌单
  useEffect(() => {
    setDisplayPlaylistId(currentPlaylistId);
  }, [currentPlaylistId]);

  // 点击外部 / 选曲 关闭。注意：不监听 scroll 关闭——
  // ① 弹窗内部歌曲列表自身滚轮浏览不应关闭；
  // ② 沉浸式页歌词随播放自动滚动会冒泡为「外部 scroll」误关弹窗。
  // 与 VolumePopup 一致，仅由点击外部或选曲来收起。
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [open]);

  const currentPlaylist = playlists.find(p => p.id === displayPlaylistId) || null;
  // 漫游（临时歌单 netease-active，不在持久歌单列表内）：没有真实 tracks，
  // 改用播放器队列的「已播放 + 当前」片段，按播放顺序天然即为「已播在上、当前在底」，
  // 每播一首新曲队列增长、currentIndex 前移，列表自动追加一条，无需额外状态。
  const isRoam = displayPlaylistId === 'netease-active';
  const roamTracks = isRoam ? musicPlayer.getTracks().slice(0, musicPlayer.getCurrentIndex() + 1) : [];
  const displayTracks = isRoam ? roamTracks : (currentPlaylist?.tracks ?? []);

  return React.createElement('div', { className: 'relative', ref },
    React.createElement(IconButton, {
      onClick: () => setOpen(prev => !prev),
      title: T('music.player.playlist'),
      active: open,
      children: React.createElement(ListIcon, { size: 18 }),
    }),
    open && React.createElement('div', {
      className: 'absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 glass-panel rounded-xl shadow-2xl overflow-hidden flex flex-col',
      style: { width: 'min(320px, 82vw)', maxHeight: 'min(60vh, 440px)' },
    },
      // 头部：漫游（临时歌单）无持久歌单可切换，显示只读标题；否则为歌单选择下拉
      isRoam
        ? React.createElement('div', {
            className: 'px-3 pt-3 pb-2 border-b border-neutral-200/30 dark:border-stone-700/30 flex-shrink-0',
          },
            React.createElement('div', { className: 'text-xs text-neutral-400 dark:text-stone-500 mb-1' }, T('music.player.currentPlaylist')),
            React.createElement('div', {
              className: 'w-full text-neutral-700 dark:text-stone-100 text-xs rounded-lg px-2 py-1.5',
            }, '漫游电台 · 已播放'),
          )
        : React.createElement('div', {
            className: 'px-3 pt-3 pb-2 border-b border-neutral-200/30 dark:border-stone-700/30 flex-shrink-0',
          },
            React.createElement('div', { className: 'text-xs text-neutral-400 dark:text-stone-500 mb-1' }, T('music.player.currentPlaylist')),
            React.createElement('select', {
              value: displayPlaylistId ?? '',
              onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setDisplayPlaylistId(e.target.value),
              className: 'w-full bg-[var(--element-muted)] text-neutral-700 dark:text-stone-100 text-xs rounded-lg px-2 py-1.5 outline-none cursor-pointer',
            },
              playlists.map(p => React.createElement('option', { key: p.id, value: p.id }, p.name)),
            ),
          ),
      // 歌曲列表
      React.createElement('div', { className: 'flex-1 overflow-y-auto px-1 py-1' },
        displayTracks.length === 0
          ? React.createElement('div', {
              className: 'px-3 py-4 text-xs text-neutral-400 dark:text-stone-500 text-center',
            }, T('music.player.emptyPlaylist'))
          : displayTracks.map((t, i) => {
              const isCurrent = currentTrack?.id === t.id;
              return React.createElement('button', {
                key: t.id,
                onClick: () => {
                  if (isRoam) { musicPlayer.playIndex(i); } // 漫游：直接跳到队列该索引
                  else { onSelectTrack(displayPlaylistId as string, t, i); }
                  setOpen(false);
                },
                className: `w-full text-left px-3 py-2 text-xs flex items-center gap-2 rounded-[10px] transition-colors ${
                  isCurrent
                    ? 'text-[var(--element-bg)] bg-[var(--element-muted)] font-medium'
                    : 'text-neutral-600 dark:text-stone-300 hover:bg-[var(--element-muted)]'
                }`,
                title: t.title,
              },
                React.createElement('span', { className: 'truncate flex-1' }, t.title),
                t.artist && React.createElement('span', {
                  className: 'text-neutral-400 dark:text-stone-500 truncate max-w-[40%]',
                }, t.artist),
              );
            }),
      ),
    ),
  );
}

// ========== 播放栏主组件 ==========
export function PlayerBar({ track, isPlaying, onTogglePlay, onPrev, onNext, volume, onVolumeChange, playMode, onPlayModeChange, onCoverClick, playlists, currentPlaylistId, onSelectTrack, isFavorite, onToggleFavorite }: PlayerBarProps) {
  useLang();
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // 封面加载重试：img onError 时递增 key 触发重新加载（最多 3 次）
  const [coverRetryKey, setCoverRetryKey] = useState(0);
  const coverRetryRef = useRef(0);
  // 歌词可见态初始值取自单例，保证切回音乐模块/重载后仍与浮动窗口一致
  const [lyricsVisible, setLyricsVisible] = useState(() => lyricsSync.isVisible());
  const [lyricsLocked, setLyricsLocked] = useState(false);
  // 音质切换菜单态
  const [showQuality, setShowQuality] = useState(false);
  const qualityRef = useRef<HTMLDivElement>(null);

  // 模块可见性降频：音乐模块被切走后（保活树 display:none）progress 仍每秒多次推送，
  // 若照常 setState，隐藏的 PlayerBar 子树会持续重渲（切模块粘滞的来源之一）。
  // 用 IntersectionObserver 跟踪可见性（display:none → isIntersecting=false）：
  // 不可见时只暂存最新值不渲染，重新可见立即补齐，进度条不滞后。
  // 注意：仅影响「本组件渲染」；播放、歌词浮窗（lyricsSync）与 SMTC 上报均不受影响。
  const rootRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(true);
  const pendingProgressRef = useRef({ ct: 0, dur: 0 });

  useEffect(() => {
    const unsub = musicPlayer.on('progress', (data: unknown) => {
      const { currentTime: ct, duration: dur } = data as { currentTime: number; duration: number };
      if (!visibleRef.current) {
        pendingProgressRef.current = { ct, dur };
        return;
      }
      setCurrentTime(ct);
      setDuration(dur);
    });
    return () => unsub();
  }, []);

  // 可见性跟踪（一次设置；首次回调不补值，避免用初始 {0,0} 覆盖真实进度）
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    let first = true;
    const ob = new IntersectionObserver((entries) => {
      const vis = entries.some((e) => e.isIntersecting);
      visibleRef.current = vis;
      if (vis && !first) {
        const { ct, dur } = pendingProgressRef.current;
        setCurrentTime(ct);
        setDuration(dur);
      }
      first = false;
    });
    ob.observe(el);
    return () => ob.disconnect();
  }, []);

  // 切歌时重置封面重试计数器
  useEffect(() => {
    coverRetryRef.current = 0;
    setCoverRetryKey(0);
  }, [track.id, track.filePath]);

  // 歌词滚动同步已下沉到 lyricsSync 单例（见 lyricsSync.ts），此处不再处理。

  // 曲目切换 / 歌词窗口打开时加载歌词（仅可见时）；实际滚动 emit 由 lyricsSync 单例驱动。
  // 开关有两个入口（本面板按钮 / 黄金棋盘浮岛按钮），二者都收敛为「可见性变化」，
  // 故数据侧准备统一放在这里：开启单例 emit + 下发样式 + 拉取歌词，避免两个入口各做一半。
  useEffect(() => {
    if (!lyricsVisible) {
      lyricsSync.setVisible(false);
      lyricsSync.clear();
      return;
    }
    lyricsSync.setVisible(true);
    lyricsSync.clear();
    hostApi.emit('lyrics-update', { currentLine: '', nextLine: '' }).catch(() => {});
    // 样式（字号/是否显示下一行）延后下发：窗口刚 show 时前端可能还没挂载监听
    const styleTimer = setTimeout(() => {
      const savedFontSize = localStorage.getItem('music_lyrics_font_size');
      const savedShowNextLine = localStorage.getItem('music_lyrics_show_next_line');
      hostApi.emit('lyrics-style-update', {
        fontSize: savedFontSize ? parseInt(savedFontSize, 10) : undefined,
        showNextLine: savedShowNextLine !== null ? savedShowNextLine === 'true' : undefined,
      }).catch(() => {});
    }, 300);
    const skipOnline = localStorage.getItem('music_online_lyrics') === 'false';
    const localFirst = localStorage.getItem('music_local_lrc_first') === 'true';
    loadLyricsFor(track, skipOnline, localFirst);
    return () => clearTimeout(styleTimer);
  }, [track.filePath, lyricsVisible]);

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    musicPlayer.seek(time);
    setCurrentTime(time);
  }, []);

  const handlePlayMode = useCallback(() => {
    const modes: PlayMode[] = ['list', 'single', 'random'];
    const currentIdx = modes.indexOf(playMode);
    const nextMode = modes[(currentIdx + 1) % modes.length];
    onPlayModeChange(nextMode);
  }, [playMode, onPlayModeChange]);

  // 音质切换：更新偏好 → 当前曲为网易云源时立即按新码率重新取链并 reload（保留进度）
  const handleSelectQuality = useCallback((br: number) => {
    setNeteaseQualityBr(br);
    setShowQuality(false);
    const cur = musicPlayer.getCurrentTrack();
    const id = cur ? neteaseSongId(cur) : null;
    if (id != null) {
      getSongUrl(id, br)
        .then((res) => { if (res.url) musicPlayer.updateTrackUrl(musicPlayer.getCurrentIndex(), res.url); })
        .catch(() => {});
    }
  }, []);
  // 点击外部关闭音质菜单
  useEffect(() => {
    if (!showQuality) return;
    const onDoc = (e: MouseEvent) => { if (qualityRef.current && !qualityRef.current.contains(e.target as Node)) setShowQuality(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [showQuality]);

  // 歌词窗口开关：只负责请求后端改变窗口可见性。
  // 状态收敛与歌词数据准备统一由 lyrics-widget-visibility-changed 事件驱动
  // （同一链路也服务黄金棋盘浮岛按钮），两个入口不再各说各话。
  const handleToggleLyrics = useCallback(async () => {
    try {
      await hostApi.invoke(lyricsVisible ? 'hide_lyrics_widget' : 'show_lyrics_widget');
    } catch (err) {
      // 召唤失败不再静默（懒建 5 次重试仍失败会抛错，静默吞掉会让用户以为「点了没反应」）
      console.error('[Music] 切换桌面歌词窗口失败:', err);
    }
  }, [lyricsVisible]);

  // 锁定/解锁歌词窗口
  const handleToggleLock = useCallback(async () => {
    const newLocked = !lyricsLocked;
    await hostApi.invoke('set_lyrics_widget_locked', { locked: newLocked }).catch(() => {});
    setLyricsLocked(newLocked);
  }, [lyricsLocked]);

  // 读取初始锁定状态
  useEffect(() => {
    hostApi.invoke<boolean>('get_lyrics_widget_locked').then(setLyricsLocked).catch(() => {});
  }, []);

  // 监听锁定状态变更（由悬浮歌词窗口或本面板触发），保持两端锁定/解锁按钮同步
  useEffect(() => {
    const unlisten = hostApi.listen<{ locked: boolean }>('lyrics-lock-changed', (e) => {
      setLyricsLocked(e.payload.locked);
    });
    return () => { unlisten.then((fn) => fn()).catch(() => {}); };
  }, []);

  // 歌词窗口可见性：后端窗口真实可见性是唯一事实源。
  // 初始读一次以免刷新/切模块后状态错位；之后由事件驱动——这样黄金棋盘浮岛开关窗时，
  // 本面板按钮与歌词数据推送都会跟着收敛。
  useEffect(() => {
    let alive = true;
    hostApi.invoke<boolean>('get_lyrics_widget_visible')
      .then((v) => { if (alive) setLyricsVisible(!!v); })
      .catch(() => {});
    const unlisten = hostApi.listen<{ visible: boolean }>('lyrics-widget-visibility-changed', (e) => {
      if (!alive) return;
      setLyricsVisible(!!e.payload?.visible);
    });
    return () => {
      alive = false;
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // 远程封面（http/https，如网易云直链）直接原样使用，不走 convertFileSrc
  // （convertFileSrc 会把远程 URL 编码成 asset://localhost/http%3A... 导致 500）。
  const coverIsRemote = !!track.coverPath && /^https?:\/\//i.test(track.coverPath);
  const coverUrl = track.coverPath
    ? (coverIsRemote ? track.coverPath : hostApi.convertFileSrc(track.coverPath))
    : null;
  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;

  // 封面 + 歌曲信息（上排左，做成醒目的「当前歌曲信息+图片」卡片）
  const coverInfoEl = (
    <div
      className="flex items-center gap-3 min-w-0 flex-shrink-0 group cursor-pointer rounded-2xl p-1.5 -ml-1.5 transition-colors hover:bg-black/5 dark:hover:bg-white/5"
      style={{ width: '280px' }}
      onClick={onCoverClick}
      title={T('music.player.immersive')}
    >
      <div
        className="relative w-16 h-16 rounded-2xl overflow-hidden flex-shrink-0 shadow-md ring-1 ring-black/5 dark:ring-white/10 transition-all group-hover:ring-2 group-hover:ring-[var(--element-bg)] group-hover:scale-[1.02]"
        style={{ width: '64px', height: '64px' }}
      >
        {coverUrl ? (
          React.createElement('img', {
            key: coverRetryKey, // onError 递增 key 触发重新挂载
            src: coverUrl,
            alt: '',
            className: 'w-full h-full object-cover',
            style: { width: '100%', height: '100%', objectFit: 'cover' },
            onError: () => {
              if (coverRetryRef.current < 3) {
                coverRetryRef.current++;
                setTimeout(() => setCoverRetryKey(coverRetryRef.current), 300);
              }
            },
          })
        ) : (
          React.createElement('div', {
            className: 'w-full h-full flex items-center justify-center bg-[var(--element-muted)] text-[var(--element-bg)]',
          }, React.createElement(MusicIcon))
        )}
        {/* 播放中状态小徽章 */}
        {isPlaying && React.createElement('div', {
          className: 'absolute bottom-1 right-1 flex items-end gap-[2px] px-1 py-1 rounded-md bg-black/40 backdrop-blur-sm',
        }, [1, 2, 3].map((i) => React.createElement('span', {
          key: i,
          className: 'w-[3px] bg-white rounded-full animate-[music-bar_0.8s_ease-in-out_infinite]',
          style: { height: '6px', animationDelay: `${i * 0.12}s` },
        })))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-medium text-[var(--element-bg)] uppercase tracking-wider mb-0.5">
          {T('music.player.nowPlayingLabel')}
        </div>
        <div className="flex items-center gap-2">
          <div className="text-[15px] font-semibold text-neutral-800 dark:text-stone-100 truncate leading-tight">{track.title}</div>
          {track.quality && (
            <span className="shrink-0 text-[10px] font-semibold leading-none px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" title={track.quality}>
              {track.quality}
            </span>
          )}
        </div>
        {track.artist ? (
          <div className="text-[13px] text-neutral-500 dark:text-stone-400 truncate leading-tight mt-0.5">{track.artist}</div>
        ) : (
          <div className="text-[13px] text-neutral-400 dark:text-stone-500 truncate leading-tight mt-0.5">—</div>
        )}
      </div>
    </div>
  );

  return (
    <div ref={rootRef} className="flex-shrink-0 border-t border-neutral-200/30 dark:border-stone-700/30 bg-white/70 dark:bg-stone-800/70 backdrop-blur-xl px-6 py-3">
      <div className="flex items-center gap-4">
        {/* 左：封面+信息 — 垂直居中于整条播放栏，不上不下 */}
        {coverInfoEl}
        {/* 右：上方进度条 + 下方控制按钮 */}
        <div className="flex-1 flex flex-col gap-2.5 min-w-0">
          {/* 进度条 — 占据整行 */}
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="text-[11px] text-neutral-400 dark:text-stone-500 w-9 text-right tabular-nums flex-shrink-0">
              {formatTime(currentTime)}
            </span>
            <div className="flex-1 relative">
              <input
                type="range"
                min={0}
                max={duration || 0}
                step={0.1}
                value={currentTime}
                onChange={handleSeek}
                className="w-full h-0.5 rounded-full appearance-none bg-neutral-200 dark:bg-stone-600 cursor-pointer"
                style={{
                  background: `linear-gradient(to right, var(--element-bg, #5a7f5d) ${progressPct}%, rgb(229 229 229 / 0.5) ${progressPct}%)`,
                }}
              />
            </div>
            <span className="text-[11px] text-neutral-400 dark:text-stone-500 w-9 tabular-nums flex-shrink-0">
              {formatTime(duration)}
            </span>
          </div>

          {/* 下半区：控制按钮 — 在进度条正下方水平居中 */}
          <div className="flex items-center justify-center gap-5">
          {React.createElement(IconButton, {
            onClick: handlePlayMode,
            title: T(ModeLabels[playMode]),
            active: playMode !== 'list',
            children: playMode === 'single' ? React.createElement(SingleIcon) : playMode === 'random' ? React.createElement(ShuffleIcon) : React.createElement(ListIcon),
          })}

          {React.createElement(IconButton, {
            onClick: onPrev,
            title: T('music.player.prev'),
            children: React.createElement(SkipBackIcon),
          })}

          {React.createElement(IconButton, {
            onClick: onTogglePlay,
            title: isPlaying ? T('music.player.pause') : T('music.player.play'),
            children: isPlaying ? React.createElement(PauseIcon) : React.createElement(PlayIcon),
          })}

          {React.createElement(IconButton, {
            onClick: onNext,
            title: T('music.player.next'),
            children: React.createElement(SkipForwardIcon),
          })}

          {onToggleFavorite ? React.createElement(IconButton, {
            onClick: () => onToggleFavorite(track),
            title: T('music.favoriteToggle'),
            active: isFavorite,
            className: isFavorite ? 'text-rose-500' : undefined,
            children: React.createElement(HeartIcon, { fill: isFavorite ? 'currentColor' : 'none' }),
          }) : null}

          {React.createElement(IconButton, {
            onClick: handleToggleLyrics,
            title: lyricsVisible ? T('music.player.closeLyrics') : T('music.player.openLyrics'),
            active: lyricsVisible,
            children: React.createElement(LyricsIcon),
          })}

          {lyricsVisible && React.createElement(IconButton, {
            onClick: handleToggleLock,
            title: lyricsLocked ? T('music.player.unlockLyrics') : T('music.player.lockLyrics'),
            active: lyricsLocked,
            children: lyricsLocked ? React.createElement(LockIcon) : React.createElement(UnlockIcon),
          })}

          {/* 音质切换：展示当前偏好档，点击弹档位菜单；网易云曲即时重取链 */}
          <div className="relative" ref={qualityRef}>
            {React.createElement(IconButton, {
              onClick: () => setShowQuality((v) => !v),
              title: '音质：' + getNeteaseQualityLabel(),
              active: false,
              children: React.createElement('span', { className: 'text-[10px] font-semibold leading-none' }, getNeteaseQualityLabel()),
            })}
            {showQuality && React.createElement('div', {
              className: 'absolute bottom-full mb-2 left-1/2 -translate-x-1/2 w-28 rounded-xl bg-white dark:bg-stone-800 border border-neutral-200 dark:border-stone-700 shadow-lg py-1 z-50',
            }, NETEASE_QUALITY_OPTIONS.map((o) =>
              React.createElement('button', {
                key: o.br,
                onClick: () => handleSelectQuality(o.br),
                className: 'w-full px-3 py-1.5 text-xs text-left ' +
                  (o.br === getNeteaseQualityBr()
                    ? 'text-amber-600 dark:text-amber-400 font-semibold bg-amber-500/10'
                    : 'text-neutral-700 dark:text-stone-200 hover:bg-[var(--element-muted)]'),
                children: `${o.label} · ${o.desc}`,
              }),
            ))}
          </div>

          {React.createElement(PlaylistPopup, { playlists, currentPlaylistId, currentTrack: track, onSelectTrack })}
          {React.createElement(VolumePopup, { volume, onVolumeChange })}
          </div>
        </div>
      </div>
    </div>
  );
}