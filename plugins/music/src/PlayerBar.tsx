/// <reference path="../../global.d.ts" />
// 音乐播放控制条 — 固定于音乐模块内容区底部，不覆盖导航栏
import { musicPlayer, type Track, type PlayMode } from './musicPlayer';
import { lyricsSync } from './lyricsSync';
import { formatTime } from '../../_shared/utils';
import {
  PlayIcon, PauseIcon, SkipBackIcon, SkipForwardIcon, VolumeIcon,
  ListIcon, SingleIcon, ShuffleIcon, MusicIcon, LyricsIcon, LockIcon, UnlockIcon,
} from '../../_shared/icons';

const React = window.__HOST_REACT__;
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
}

const ModeLabels: Record<PlayMode, string> = {
  list: '列表循环',
  single: '单曲循环',
  random: '随机播放',
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
      onClick: () => {},
      title: `音量 ${Math.round(volume * 100)}%`,
      active: showPopup,
      children: React.createElement(VolumeIcon),
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

// ========== 播放栏主组件 ==========
export function PlayerBar({ track, isPlaying, onTogglePlay, onPrev, onNext, volume, onVolumeChange, playMode, onPlayModeChange, onCoverClick }: PlayerBarProps) {
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // 歌词可见态初始值取自单例，保证切回音乐模块/重载后仍与浮动窗口一致
  const [lyricsVisible, setLyricsVisible] = useState(() => lyricsSync.isVisible());
  const [lyricsLocked, setLyricsLocked] = useState(false);

  useEffect(() => {
    const unsub = musicPlayer.on('progress', (data: unknown) => {
      const { currentTime: ct, duration: dur } = data as { currentTime: number; duration: number };
      setCurrentTime(ct);
      setDuration(dur);
    });
    return () => unsub();
  }, []);

  // 歌词滚动同步已下沉到 lyricsSync 单例（见 lyricsSync.ts），此处不再处理。

  // 曲目切换时加载歌词（仅可见时）；实际滚动 emit 由 lyricsSync 单例驱动
  useEffect(() => {
    if (!lyricsVisible) return;
    lyricsSync.clear();
    hostApi.emit('lyrics-update', { currentLine: '', nextLine: '' }).catch(() => {});
    const skipOnline = localStorage.getItem('music_online_lyrics') === 'false';
    const localFirst = localStorage.getItem('music_local_lrc_first') === 'true';
    hostApi.invoke<LyricsResult>('get_lyrics', {
      trackPath: track.filePath,
      title: track.title,
      artist: track.artist,
      skipOnline,
      localFirst,
    }).then((result) => {
      lyricsSync.setLines(result.lines);
      if (result.lines.length === 0 && lyricsVisible) {
        hostApi.emit('lyrics-update', { currentLine: '暂无歌词', nextLine: '' }).catch(() => {});
      }
    }).catch(() => {});
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

  // 歌词窗口开关
  const handleToggleLyrics = useCallback(async () => {
    const newVisible = !lyricsVisible;
    setLyricsVisible(newVisible);
    if (newVisible) {
      // 先开启单例同步，确保即便本组件随后被卸载，浮动窗口仍持续滚动
      lyricsSync.setVisible(true);
      await hostApi.invoke('show_lyrics_widget').catch(() => {});
      setTimeout(() => {
        const savedFontSize = localStorage.getItem('music_lyrics_font_size');
        const savedShowNextLine = localStorage.getItem('music_lyrics_show_next_line');
        hostApi.emit('lyrics-style-update', {
          fontSize: savedFontSize ? parseInt(savedFontSize, 10) : undefined,
          showNextLine: savedShowNextLine !== null ? savedShowNextLine === 'true' : undefined,
        }).catch(() => {});
      }, 300);
      hostApi.emit('lyrics-update', { currentLine: '', nextLine: '' }).catch(() => {});
      const skipOnline = localStorage.getItem('music_online_lyrics') === 'false';
      const localFirst = localStorage.getItem('music_local_lrc_first') === 'true';
      hostApi.invoke<LyricsResult>('get_lyrics', {
        trackPath: track.filePath,
        title: track.title,
        artist: track.artist,
        skipOnline,
        localFirst,
      }).then((result) => {
        lyricsSync.setLines(result.lines);
        if (result.lines.length === 0 && newVisible) {
          hostApi.emit('lyrics-update', { currentLine: '暂无歌词', nextLine: '' }).catch(() => {});
        }
      }).catch(() => {});
    } else {
      lyricsSync.setVisible(false);
      lyricsSync.clear();
      await hostApi.invoke('hide_lyrics_widget').catch(() => {});
    }
  }, [lyricsVisible, track]);

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

  const coverUrl = track.coverPath ? hostApi.convertFileSrc(track.coverPath) : null;
  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;

  // 封面 + 歌曲信息（上排左，放大以更醒目）
  const coverInfoEl = (
    <div className="flex items-center gap-4 min-w-0 flex-shrink-0" style={{ width: '240px' }}>
      <div
        onClick={onCoverClick}
        className="w-14 h-14 rounded-xl overflow-hidden flex-shrink-0 shadow-sm ring-1 ring-black/5 dark:ring-white/5 cursor-pointer hover:ring-2 hover:ring-[var(--element-bg)] transition-all"
        style={{ width: '56px', height: '56px' }}
        title="查看沉浸播放页"
      >
        {coverUrl ? (
          React.createElement('img', {
            src: coverUrl,
            alt: '',
            className: 'w-full h-full object-cover',
            style: { width: '100%', height: '100%', objectFit: 'cover' },
          })
        ) : (
          React.createElement('div', {
            className: 'w-full h-full flex items-center justify-center bg-[var(--element-muted)] text-[var(--element-bg)]',
          }, React.createElement(MusicIcon))
        )}
      </div>
      <div className="min-w-0">
        <div className="text-base font-medium text-neutral-700 dark:text-stone-200 truncate leading-tight">{track.title}</div>
        {track.artist && (
          <div className="text-sm text-neutral-400 dark:text-stone-500 truncate leading-tight mt-0.5">{track.artist}</div>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex-shrink-0 border-t border-neutral-200/30 dark:border-stone-700/30 bg-white/70 dark:bg-stone-800/70 backdrop-blur-xl px-6 py-3">
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
            title: ModeLabels[playMode],
            active: playMode !== 'list',
            children: playMode === 'single' ? React.createElement(SingleIcon) : playMode === 'random' ? React.createElement(ShuffleIcon) : React.createElement(ListIcon),
          })}

          {React.createElement(IconButton, {
            onClick: onPrev,
            title: '上一首',
            children: React.createElement(SkipBackIcon),
          })}

          {React.createElement(IconButton, {
            onClick: onTogglePlay,
            title: isPlaying ? '暂停' : '播放',
            children: isPlaying ? React.createElement(PauseIcon) : React.createElement(PlayIcon),
          })}

          {React.createElement(IconButton, {
            onClick: onNext,
            title: '下一首',
            children: React.createElement(SkipForwardIcon),
          })}

          {React.createElement(IconButton, {
            onClick: handleToggleLyrics,
            title: lyricsVisible ? '关闭歌词' : '打开歌词',
            active: lyricsVisible,
            children: React.createElement(LyricsIcon),
          })}

          {lyricsVisible && React.createElement(IconButton, {
            onClick: handleToggleLock,
            title: lyricsLocked ? '解锁歌词' : '锁定歌词',
            active: lyricsLocked,
            children: lyricsLocked ? React.createElement(LockIcon) : React.createElement(UnlockIcon),
          })}

          {React.createElement(VolumePopup, { volume, onVolumeChange })}
          </div>
        </div>
      </div>
    </div>
  );
}