/// <reference path="../../global.d.ts" />
import React from "react";
import { musicPlayer, type Track, type PlayMode } from './musicPlayer';
import { VolumePopup } from './PlayerBar';
// 沉浸播放页 — 覆盖音乐模块内容区，不覆盖一级导航栏
import {
  PlayIcon, PauseIcon, SkipBackIcon, SkipForwardIcon, MusicIcon,
  RepeatIcon, Repeat1Icon, ShuffleIcon, ArrowLeftIcon,
} from '../../_shared/icons';
const { useState, useEffect, useCallback, useRef, useMemo } = React;
const hostApi = window.__HOST_API__;
const { IconButton } = window.__HOST_UI__ || {};

// ============ 进度条（点击跳转，非 range 拖动手柄）============
function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function ProgressSeekBar({ currentTime, duration, onSeek }: { currentTime: number; duration: number; onSeek: (t: number) => void }) {
  const barRef = useRef<HTMLDivElement>(null);
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const bar = barRef.current;
    if (!bar || !duration) return;
    const rect = bar.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    onSeek(Math.max(0, Math.min(1, ratio)) * duration);
  }, [duration, onSeek]);

  return React.createElement('div', { className: 'w-full' },
    React.createElement('div', {
      ref: barRef,
      onClick: handleClick,
      title: '点击跳转播放位置',
      className: 'relative w-full cursor-pointer group flex items-center',
      style: { height: 'clamp(16px, 2.4vh, 24px)' },
    },
      React.createElement('div', {
        className: 'w-full rounded-full overflow-hidden',
        style: { height: 'clamp(4px, 0.7vh, 7px)', background: 'var(--element-muted)' },
      },
        React.createElement('div', {
          className: 'h-full rounded-full transition-[width] duration-200',
          style: { width: `${pct}%`, background: 'var(--element-bg)' },
        }),
      ),
    ),
    React.createElement('div', {
      className: 'flex justify-between mt-[clamp(4px,0.8vh,8px)]',
      style: { color: 'var(--text-secondary, #78716c)', fontSize: 'clamp(11px, 1.3vw, 14px)' },
    },
      React.createElement('span', null, fmtTime(currentTime)),
      React.createElement('span', null, fmtTime(duration)),
    ),
  );
}

interface LyricLine { time_ms: number; text: string; }
interface LyricsResult { lines: LyricLine[]; source: string; }
type LyricsAlign = 'center' | 'left' | 'right';

interface NowPlayingViewProps {
  track: Track;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onPrev: () => void;
  onNext: () => void;
  volume: number;
  onVolumeChange: (vol: number) => void;
  playMode: PlayMode;
  onPlayModeChange: (mode: PlayMode) => void;
  onClose: () => void;
  lyricsAlign?: LyricsAlign;
}

// 歌词模糊离散档位：当前行 0，相邻行 1px，更远 1.5/2px。
// 录屏场景下大幅降低模糊半径，避免逐行 blur 叠加抬高 GPU/合成开销。
const BLUR_LEVELS = [0, 1, 1.5, 2];
function getBlurLevel(dist: number): number {
  if (dist === 0) return BLUR_LEVELS[0];
  if (dist === 1) return BLUR_LEVELS[1];
  if (dist === 2) return BLUR_LEVELS[2];
  return BLUR_LEVELS[3];
}

// ========== 歌词列表子组件（React.memo 隔离进度事件引起的冗余重渲染）==========
// 清晰度（blur/opacity）跟随「滚动视口中心行」focusIdx，而不是播放进度行，
// 这样用户手动滚动到任意位置时，视野中央的歌词会同步变清晰。
// 播放行 currentLyricIdx 仅用于高亮强调（主题强调色）。
const LyricsList = React.memo(({
  lyricsLines,
  currentLyricIdx,
  focusIdx,
  align,
  onLyricClick,
}: {
  lyricsLines: LyricLine[];
  currentLyricIdx: number;
  focusIdx: number;
  align: LyricsAlign;
  onLyricClick: (line: LyricLine) => void;
}) => {
  // 悬停行：高亮后定时自动恢复，避免长时间保持深色
  const [hoveredIdx, setHoveredIdx] = useState(-1);
  const hoverTimerRef = useRef(0);

  const lineStyles = useMemo(() => {
    // 对齐方式影响左右留白：居中对称，左对齐右侧留白大，右对齐左侧留白大
    const padL = align === 'left' ? 'clamp(4px,1vw,10px)'
      : align === 'right' ? 'clamp(12px,3vw,36px)'
      : 'clamp(10px,2vw,20px)';
    const padR = align === 'right' ? 'clamp(4px,1vw,10px)'
      : align === 'left' ? 'clamp(12px,3vw,36px)'
      : 'clamp(10px,2vw,20px)';
    return lyricsLines.map((_, i) => {
      const dist = Math.abs(i - focusIdx);
      const blur = getBlurLevel(dist);
      const opacity = dist === 0 ? 1 : dist === 1 ? 0.82 : dist === 2 ? 0.55 : 0.35;
      let color = 'var(--text-secondary, #78716c)';
      let fontWeight: number = 400;
      if (i === currentLyricIdx) {
        color = 'var(--element-bg, #5a7f5d)';
        fontWeight = 600;
      }
      if (i === hoveredIdx) {
        color = 'var(--element-bg, #5a7f5d)';
      }
      return {
        fontSize: i === currentLyricIdx
          ? 'clamp(18px, 3vw, 30px)'
          : 'clamp(14px, 2vw, 22px)',
        fontWeight,
        color,
        opacity: i === hoveredIdx ? 0.95 : opacity,
        filter: i === hoveredIdx ? 'blur(0px)' : `blur(${blur}px)`,
        textAlign: align as string,
        paddingLeft: padL,
        paddingRight: padR,
      };
    });
  }, [lyricsLines, currentLyricIdx, focusIdx, hoveredIdx, align]);

  // 悬停：高亮并在 700ms 后自动恢复（即使鼠标仍停留）
  const triggerHover = useCallback((i: number) => {
    setHoveredIdx(i);
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setHoveredIdx(-1), 700) as unknown as number;
  }, []);

  // 鼠标移出：立即恢复
  const clearHover = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setHoveredIdx(-1);
  }, []);

  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

  if (lyricsLines.length === 0) {
    return React.createElement('div', {
      className: 'flex items-center justify-center h-full text-neutral-400 dark:text-stone-500',
      style: { fontSize: 'clamp(13px, 1.5vw, 16px)' },
    }, '暂无歌词');
  }

  return lyricsLines.map((line, i) => {
    const style = lineStyles[i];
    return React.createElement('div', {
      key: i,
      className: 'cursor-pointer',
      style: {
        ...style,
        cursor: 'pointer',
        paddingTop: 'clamp(6px, 1.2vh, 14px)',
        paddingBottom: 'clamp(6px, 1.2vh, 14px)',
        transition: 'color 0.4s ease, opacity 0.4s ease, font-size 0.4s ease, filter 0.4s ease',
      },
      onClick: () => onLyricClick(line),
      title: '点击跳转到此处',
      onMouseEnter: () => triggerHover(i),
      onMouseLeave: clearHover,
    }, line.text || '\u00A0');
  });
});

export function NowPlayingView({
  track,
  isPlaying,
  onTogglePlay,
  onPrev,
  onNext,
  volume,
  onVolumeChange,
  playMode,
  onPlayModeChange,
  onClose,
  lyricsAlign = 'center',
}: NowPlayingViewProps) {
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [lyricsLines, setLyricsLines] = useState<LyricLine[]>([]);
  const [currentLyricIdx, setCurrentLyricIdx] = useState(-1);
  const [prevCoverUrl, setPrevCoverUrl] = useState<string | null>(null);
  const lyricsScrollRef = useRef<HTMLDivElement>(null);
  const [bgVisible, setBgVisible] = useState(true);
  const prevLyricIdxRef = useRef(-1);
  const lastScrollTimeRef = useRef(0);
  const currentTimeRef = useRef(0);
  const durationRef = useRef(0);
  const rAF = useRef(0);
  // 滚动视口中心行：用于歌词清晰度跟随用户滚动位置
  const [focusLyricIdx, setFocusLyricIdx] = useState(0);
  const focusLyricIdxRef = useRef(0);

  const coverUrl: string | null = track.coverPath ? hostApi.convertFileSrc(track.coverPath) : null;

  // 背景：切歌时平滑过渡（旧封面渐隐，新封面渐显）— 仅在曲目变化时计算
  useEffect(() => {
    if (coverUrl) {
      setBgVisible(false);
      const t = setTimeout(() => {
        setPrevCoverUrl(coverUrl);
        setBgVisible(true);
      }, 50);
      return () => clearTimeout(t);
    } else {
      setPrevCoverUrl(null);
      setBgVisible(true);
    }
  }, [coverUrl]);

  // ====== 性能优化：合并两个 progress 监听器为一个，共享数据 ======
  useEffect(() => {
    const unsub = musicPlayer.on('progress', (_data: unknown) => {
      const ct = musicPlayer.getCurrentTime();
      const dur = musicPlayer.getDuration();

      if (Math.abs(currentTimeRef.current - ct) > 0.1) {
        currentTimeRef.current = ct;
        setCurrentTime(ct);
      }
      if (Math.abs(durationRef.current - dur) > 0.5) {
        durationRef.current = dur;
        setDuration(dur);
      }

      if (lyricsLinesRef.current.length > 0) {
        const ctMs = ct * 1000;
        const lines = lyricsLinesRef.current;
        let idx = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].time_ms <= ctMs) idx = i;
          else break;
        }
        if (idx !== prevLyricIdxRef.current) {
          prevLyricIdxRef.current = idx;
          setCurrentLyricIdx(idx);
        }
      }
    });
    return () => unsub();
  }, []);

  // 用 ref 持有 lyricsLines，避免 progress 监听器闭包捕获旧值
  const lyricsLinesRef = useRef<LyricLine[]>([]);
  useEffect(() => { lyricsLinesRef.current = lyricsLines; }, [lyricsLines]);

  // 加载歌词（传递模块设置参数）
  useEffect(() => {
    setLyricsLines([]);
    lyricsLinesRef.current = [];
    setCurrentLyricIdx(-1);
    prevLyricIdxRef.current = -1;
    setFocusLyricIdx(0);
    focusLyricIdxRef.current = 0;
    const skipOnline = localStorage.getItem('music_online_lyrics') === 'false';
    const localFirst = localStorage.getItem('music_local_lrc_first') === 'true';
    hostApi.invoke<LyricsResult>('get_lyrics', {
      trackPath: track.filePath,
      title: track.title,
      artist: track.artist,
      skipOnline,
      localFirst,
    }).then((result) => {
      setLyricsLines(result.lines);
    }).catch(() => {});
  }, [track.filePath]);

  // 自动滚动歌词：节流至 300ms 间隔，避免高频 smooth scroll 造成卡顿
  useEffect(() => {
    if (currentLyricIdx < 0 || !lyricsScrollRef.current) return;
    const now = performance.now();
    if (now - lastScrollTimeRef.current < 300) return; // 节流 300ms
    lastScrollTimeRef.current = now;

    const container = lyricsScrollRef.current;
    const lineEl = container.children[currentLyricIdx] as HTMLElement | undefined;
    if (lineEl) {
      const containerHeight = container.clientHeight;
      const lineTop = lineEl.offsetTop;
      const lineHeight = lineEl.offsetHeight;
      const targetScroll = lineTop - containerHeight / 2 + lineHeight / 2;
      if (rAF.current) cancelAnimationFrame(rAF.current);
      rAF.current = requestAnimationFrame(() => {
        container.scrollTo({ top: targetScroll, behavior: 'smooth' });
      });
    }
  }, [currentLyricIdx]);

  // 滚动时计算视口中心行，使歌词清晰度跟随滚动位置
  const handleLyricsScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const container = e.currentTarget;
    const center = container.scrollTop + container.clientHeight / 2;
    const lines = lyricsLinesRef.current;
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < lines.length; i++) {
      const el = container.children[i] as HTMLElement | undefined;
      if (!el) continue;
      const lineCenter = el.offsetTop + el.offsetHeight / 2;
      const d = Math.abs(lineCenter - center);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    if (best !== focusLyricIdxRef.current) {
      focusLyricIdxRef.current = best;
      setFocusLyricIdx(best);
    }
  }, []);

  const handlePlayMode = useCallback(() => {
    const modes: PlayMode[] = ['list', 'single', 'random'];
    const currentIdx = modes.indexOf(playMode);
    const nextMode = modes[(currentIdx + 1) % modes.length];
    onPlayModeChange(nextMode);
  }, [playMode, onPlayModeChange]);

  // 点击歌词行 / 进度条跳转进度
  const handleSeek = useCallback((t: number) => {
    musicPlayer.seek(t);
  }, []);
  const handleLyricClick = useCallback((line: LyricLine) => {
    handleSeek(line.time_ms / 1000);
  }, [handleSeek]);

  return React.createElement('div', {
    className: 'absolute inset-0 z-40 flex flex-col',
    style: {
      // 不透明底色即可，移除全屏 backdrop-filter 实时高斯模糊：
      // 录屏（WGC 捕获 + ffmpeg 编码）时，全屏 blur(20px) 每帧重绘会严重抬升 GPU 开销、
      // 直接导致卡顿；底色本身已不透明，去掉模糊视觉几乎无差、性能大幅改善。
      background: 'var(--nav-primary-bg)',
      overflow: 'hidden',
    },
  },
    // 背景层：专辑封面模糊放大渐变铺底
    prevCoverUrl && coverUrl && React.createElement('div', {
      key: 'bg-cover',
      className: 'absolute inset-0',
      style: {
        backgroundImage: `url(${prevCoverUrl})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        filter: 'blur(30px) saturate(1.2)',
        opacity: bgVisible ? 0.35 : 0,
        transition: 'opacity 1.2s ease',
        transform: 'scale(1.15)',
      },
    }),
    // 背景遮罩渐变
    React.createElement('div', {
      key: 'bg-overlay',
      className: 'absolute inset-0',
      style: {
        background: 'linear-gradient(180deg, var(--nav-primary-bg) 0%, transparent 40%, transparent 60%, var(--nav-primary-bg) 100%)',
      },
    }),

    // 顶部栏：返回按钮
    React.createElement('div', {
      className: 'flex items-center px-[clamp(12px,2vw,24px)] py-[clamp(8px,1.5vh,16px)] flex-shrink-0 relative z-10',
    },
      React.createElement(IconButton, {
        onClick: onClose,
        title: '返回',
        children: React.createElement(ArrowLeftIcon, { size: 20 }),
      }),
    ),

    // 主体：左右分栏（随窗口放大，留白更宽松；尺寸已适度收敛）
    React.createElement('div', {
      className: 'flex-1 flex items-center justify-center gap-[clamp(20px,4.5vw,60px)] px-[clamp(16px,3vw,40px)] pb-[clamp(8px,2vh,24px)] min-h-0 relative z-10',
    },
      // 左侧：封面 + 信息 + 控制 + 进度条
      React.createElement('div', {
        className: 'flex flex-col items-center gap-[clamp(14px,2.5vw,32px)]',
        style: { width: 'clamp(220px, 36vw, 460px)' },
      },
        // 大封面 — 随窗口可用空间放大（同时受宽度与高度约束，避免溢出）
        React.createElement('div', {
          className: 'rounded-2xl overflow-hidden shadow-2xl ring-1 ring-black/10 dark:ring-white/5 flex-shrink-0',
          style: {
            width: 'clamp(180px, min(34vw, 44vh), 520px)',
            height: 'clamp(180px, min(34vw, 44vh), 520px)',
          },
        },
          coverUrl
            ? React.createElement('img', {
                src: coverUrl,
                alt: '',
                className: 'w-full h-full object-cover',
                style: { width: '100%', height: '100%', objectFit: 'cover' },
              })
            : React.createElement('div', {
                className: 'w-full h-full flex items-center justify-center bg-[var(--element-muted)] text-[var(--element-bg)]',
              }, React.createElement(MusicIcon, { size: 56 })),
        ),

        // 歌曲信息 — 响应式字号，随窗口放大（已适度收敛）
        React.createElement('div', { className: 'text-center w-full' },
          React.createElement('div', {
            className: 'font-semibold text-neutral-800 dark:text-stone-100 truncate',
            style: { fontSize: 'clamp(16px, 2.6vw, 28px)' },
          }, track.title),
          track.artist && React.createElement('div', {
            className: 'text-neutral-500 dark:text-stone-400 mt-[clamp(4px,1vh,12px)] truncate',
            style: { fontSize: 'clamp(12px, 1.5vw, 18px)' },
          }, track.artist),
        ),

        // 进度条（点击跳转）
        React.createElement(ProgressSeekBar, {
          currentTime,
          duration,
          onSeek: handleSeek,
        }),

        // 播放控制（仅图标+悬停弹出，无常驻 range 滑条）
        React.createElement('div', {
          className: 'flex items-center',
          style: { gap: 'clamp(10px, 2vw, 24px)' },
        },
          React.createElement(IconButton, {
            onClick: handlePlayMode,
            title: playMode === 'list' ? '列表循环' : playMode === 'single' ? '单曲循环' : '随机播放',
            active: playMode !== 'list',
            children: playMode === 'single'
              ? React.createElement(Repeat1Icon, { size: 18 })
              : playMode === 'random'
                ? React.createElement(ShuffleIcon, { size: 18 })
                : React.createElement(RepeatIcon, { size: 18 }),
          }),
          React.createElement(IconButton, {
            onClick: onPrev,
            title: '上一首',
            children: React.createElement(SkipBackIcon, { size: 18 }),
          }),
          React.createElement(IconButton, {
            onClick: onTogglePlay,
            title: isPlaying ? '暂停' : '播放',
            children: isPlaying ? React.createElement(PauseIcon, { size: 22 }) : React.createElement(PlayIcon, { size: 22 }),
          }),
          React.createElement(IconButton, {
            onClick: onNext,
            title: '下一首',
            children: React.createElement(SkipForwardIcon, { size: 18 }),
          }),
          React.createElement(VolumePopup, { volume, onVolumeChange }),
        ),
      ),

      // 占位：预留与歌词列等宽的空间，使控制区在 justify-center 下保持在原居中位置
      // （专辑仍偏左居中），不会被推到最左；该块不可见、不响应事件
      React.createElement('div', {
        style: { width: 'clamp(300px, 44vw, 600px)', pointerEvents: 'none' },
      }),

      // 右侧：歌词展示区（可交互）— 绝对定位于右侧，约 10px 距右边框，
      // 脱离文档流，不影响左侧控制区的动态相对布局
      React.createElement('div', {
        className: 'flex flex-col min-h-0',
        style: {
          position: 'absolute',
          right: '10px',
          top: '0',
          bottom: '0',
          maxWidth: 'clamp(300px, 44vw, 600px)',
          width: 'clamp(300px, 44vw, 600px)',
        },
      },
        React.createElement('div', {
          ref: lyricsScrollRef,
          onScroll: handleLyricsScroll,
          className: 'flex-1 overflow-y-auto overflow-x-hidden',
          style: {
            scrollBehavior: 'smooth',
            willChange: 'scroll-position',
            maskImage: 'linear-gradient(to bottom, transparent 0%, black 8%, black 92%, transparent 100%)',
            WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 8%, black 92%, transparent 100%)',
            // padding 设为约容器高度的一半：确保第一行/最后一行也能滚动到容器正中央，
            // 不会被 mask 渐变的 transparent 区域遮住（原 6vh 太小，首尾歌词看不清）。
            paddingTop: 'calc(50vh - 80px)',
            paddingBottom: 'calc(50vh - 80px)',
          },
        },
          React.createElement(LyricsList, {
            lyricsLines,
            currentLyricIdx,
            focusIdx: focusLyricIdx,
            align: lyricsAlign,
            onLyricClick: handleLyricClick,
          }),
        ),
      ),
    ),
  );
}
