/// <reference path="../../global.d.ts" />
// 独立漫游视图 — 完整复刻 player.html 「夏日薄荷」设计
//
// 左右分栏 + 黑胶唱片 + 两行歌词 + EQ 均衡器 + 萤火虫 + 光斑/光束 + 翻转过渡
// 核心漫游逻辑保留：流式推荐 → 自动播放 → 续推 → 历史记录

import React from 'react';
const { useState, useEffect, useRef, useCallback } = React;
import { Music as MusicIcon } from 'lucide-react';
import { musicPlayer } from './musicPlayer';
import {
  getRoamSourceApi,
  clearRoamCache,
  type RoamSource,
  type RoamSeedTrack,
  type RoamHistoryEntry,
} from './roamSources';
import type { PlayableTrack, TempPlaylist } from './NeteaseView';
import { type LyricLine, lyricModeStore, type LyricMode } from './lyricsSync';
import LyricModeButton from './LyricModeButton';

// ---- 工具函数 ----
function roamToPlayable(t: RoamSeedTrack, url?: string, quality = ''): PlayableTrack {
  return { id: t.id, filePath: url || t.filePath || '', title: t.title, artist: t.artist, album: t.album, durationSecs: t.durationSecs, coverPath: t.cover, quality };
}
function formatTime(sec: number): string {
  if (!sec || !isFinite(sec)) return '0:00';
  const t = Math.floor(sec); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
function getCoverUrl(path?: string): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return window.__HOST_API__?.convertFileSrc(path) || path;
}

// 为当前歌曲生成主题色（从封面颜色推导，或用默认薄荷绿）
function getSongTheme(cover?: string | null): { hue: number; fog: string } {
  if (!cover) return { hue: 0, fog: 'rgba(150, 208, 118, 0.55)' };
  let hash = 0;
  for (let i = 0; i < cover.length; i++) hash = ((hash << 5) - hash + cover.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  const fogColors = [
    'rgba(150, 208, 118, 0.55)', 'rgba(248, 198, 104, 0.55)',
    'rgba(120, 168, 224, 0.55)', 'rgba(236, 150, 200, 0.55)',
    'rgba(255, 255, 255, 0.55)',
  ];
  return { hue, fog: fogColors[Math.abs(hash) % fogColors.length] };
}

// player.html 的预设主题（Mint / Magnolia / Lotus / Iris / Lily）
// 使用预设时完全使用这些预设的封面占位、文案、配色，不使用歌曲自带信息
interface PresetTheme {
  title: string;
  sub: string;
  lede: string;
  l1: string;
  l2: string;
  hue: number;
  fog: string;
  bgGradient: string;
  inkColor: string;
  inkSoftColor: string;
  coverGradient: string;
}
const PRESET_THEMES: PresetTheme[] = [
  {
    title: 'Mint', sub: 'Flower your dreams',
    lede: 'A handwritten letter to the season of slow afternoons, jasmine on the windowsill, & the quiet joy of doing nothing at all.',
    l1: '爱上一个人不需明天', l2: '月光落在窗台，风也温柔',
    hue: 0, fog: 'rgba(150, 208, 118, 0.55)',
    bgGradient: 'radial-gradient(ellipse at 22% 38%, #f3fbe2 0%, #d6ecc4 38%, #b3d896 78%, #8cbc6d 100%)',
    inkColor: 'rgba(255,255,255,0.96)', inkSoftColor: 'rgba(255,255,255,0.80)',
    coverGradient: 'radial-gradient(circle at 38% 32%, #ffffff, #cad9ad)',
  },
  {
    title: 'Magnolia', sub: 'Chase the light',
    lede: 'Northern winds and a sky that burns green — a playlist for the longest night of the year.',
    l1: '极光落进你眼眸', l2: '夜色温柔如初见',
    hue: 55, fog: 'rgba(248, 198, 104, 0.55)',
    bgGradient: 'radial-gradient(ellipse at 22% 38%, #fff5e2 0%, #f0d8a4 38%, #d8b870 78%, #c0a050 100%)',
    inkColor: 'rgba(255,255,255,0.96)', inkSoftColor: 'rgba(255,255,255,0.78)',
    coverGradient: 'radial-gradient(circle at 38% 32%, #fff8e8, #e8c878)',
  },
  {
    title: 'Lotus', sub: 'Soft evenings',
    lede: 'A slow-burn record for rainy windows, warm lamps, and the kind of silence that feels like company.',
    l1: '丝绒般的晚风', l2: '心事轻轻在摇晃',
    hue: 205, fog: 'rgba(120, 168, 224, 0.55)',
    bgGradient: 'radial-gradient(ellipse at 22% 38%, #e2f0ff 0%, #b4d4f4 38%, #7aa8d8 78%, #5a88b8 100%)',
    inkColor: 'rgba(255,255,255,0.96)', inkSoftColor: 'rgba(255,255,255,0.80)',
    coverGradient: 'radial-gradient(circle at 38% 32%, #f0f8ff, #a0c4e8)',
  },
  {
    title: 'Iris', sub: 'Quiet mornings',
    lede: 'Coffee steam, open curtains, and a city that hasn\'t quite woken up yet.',
    l1: '晨光漫过窗台', l2: '万物正在苏醒',
    hue: 320, fog: 'rgba(236, 150, 200, 0.55)',
    bgGradient: 'radial-gradient(ellipse at 22% 38%, #ffeef6 0%, #f4c4dc 38%, #d898b8 78%, #b87098 100%)',
    inkColor: 'rgba(255,255,255,0.96)', inkSoftColor: 'rgba(255,255,255,0.80)',
    coverGradient: 'radial-gradient(circle at 38% 32%, #fff0f8, #e8a8c8)',
  },
  {
    title: 'Lily', sub: 'Pure hush',
    lede: 'A still, snow-lit morning — soft light on bare branches, the whole world quieted to a single clean breath.',
    l1: '白雾漫过旧窗棂', l2: '一切都温柔下来',
    hue: 0, fog: 'rgba(255, 255, 255, 0.55)',
    bgGradient: 'radial-gradient(ellipse at 22% 38%, #ffffff 0%, #f0f0f0 38%, #d8d8d8 78%, #b8b8b8 100%)',
    inkColor: 'rgba(40,40,40,0.92)', inkSoftColor: 'rgba(40,40,40,0.65)',
    coverGradient: 'radial-gradient(circle at 38% 32%, #ffffff, #e0e0e0)',
  },
];

interface RoamViewProps {
  source: RoamSource;
  onBack: () => void;
  onPlay: (tracks: PlayableTrack[], startIndex: number, sourceName: string) => void;
  onTempPlaylist?: (temp: TempPlaylist) => void;
  onOpenImmersive?: () => void;
  onHistoryUpdate?: (source: RoamSource, entries: RoamHistoryEntry[]) => void;
  initialHistory?: RoamHistoryEntry[];
}

const ROAM_WINDOW_SIZE = 3;
const sourceLabel: Record<RoamSource, string> = { linglan: '铃兰', netease: '网易云', kugou: '酷狗', qishui: '汽水' };

// EQ bars 数量
const EQ_BARS = 32;

export function RoamView({ source, onBack, onPlay, onTempPlaylist, onOpenImmersive, onHistoryUpdate, initialHistory }: RoamViewProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [nowPlaying, setNowPlaying] = useState<{ track: any; isPlaying: boolean }>({ track: null, isPlaying: false });
  const [roamReloadKey, setRoamReloadKey] = useState(0);
  const [progress, setProgress] = useState({ current: 0, duration: 0 });
  const [flipped, setFlipped] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [isDark, setIsDark] = useState(document.documentElement.classList.contains('dark'));
  const [eqHeights, setEqHeights] = useState<number[]>(new Array(EQ_BARS).fill(15));
  const [songTheme, setSongTheme] = useState({ hue: 0, fog: 'rgba(150, 208, 118, 0.55)' });
  const [themeMode, setThemeMode] = useState<'preset' | 'follow'>(() => {
    const v = localStorage.getItem('roam_theme_mode');
    return v === 'preset' ? 'preset' : 'follow';
  });
  const [coverFilter, setCoverFilter] = useState<'on' | 'off'>(() => {
    const v = localStorage.getItem('roam_cover_filter');
    return v === 'off' ? 'off' : 'on';
  });
  const [barPosition, setBarPosition] = useState<'stage' | 'overlay'>(() => {
    const v = localStorage.getItem('roam_bar_position');
    return v === 'overlay' ? 'overlay' : 'stage';
  });
  const presetIdxRef = useRef(0);
  // 歌词状态
  const [lyricLines, setLyricLines] = useState<LyricLine[]>([]);
  const [curLyric, setCurLyric] = useState<{ cur: string; next: string }>({ cur: '', next: '' });
  const lyricCacheRef = useRef<Map<string, LyricLine[]>>(new Map());
  // 「译/音」三态 + 当前/下一行对应的翻译或音译小字（跟随共享歌词翻译模式）
  const [lyricMode, setLyricMode] = useState<LyricMode>(() => lyricModeStore.get());
  const [curSub, setCurSub] = useState('');
  const [nextSub, setNextSub] = useState('');
  useEffect(() => {
    return lyricModeStore.subscribe(setLyricMode);
  }, []);

  // refs
  const roamReservoir = useRef<RoamSeedTrack[]>([]);
  const roamExtending = useRef(false);
  const roamTrackListRef = useRef<RoamSeedTrack[]>([]);
  const [roamCurrentId, setRoamCurrentId] = useState<string | null>(null);
  const roamStartedRef = useRef(false);
  const roamForceReloadRef = useRef(false);
  const reqRef = useRef(0);
  const historyRef = useRef<RoamHistoryEntry[]>(initialHistory || []);
  const onHistoryUpdateRef = useRef(onHistoryUpdate);
  onHistoryUpdateRef.current = onHistoryUpdate;
  const onPlayRef = useRef(onPlay);
  const onTempPlaylistRef = useRef(onTempPlaylist);
  onPlayRef.current = onPlay;
  onTempPlaylistRef.current = onTempPlaylist;
  const roamWindowRef = useRef<RoamSeedTrack[]>([]);
  const flipTimerRef = useRef<any>(null);
  const burstFromRef = useRef(0);
  const trackIdxRef = useRef(0);
  const eqRafRef = useRef<number>(0);

  // 暗色模式监听
  useEffect(() => {
    const observer = new MutationObserver(() => setIsDark(document.documentElement.classList.contains('dark')));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // 监听主题模式切换
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as 'preset' | 'follow';
      setThemeMode(detail);
    };
    window.addEventListener('roam-theme-mode-changed', handler);
    return () => window.removeEventListener('roam-theme-mode-changed', handler);
  }, []);
  // 监听封面滤镜开关
  useEffect(() => {
    const handler = (e: Event) => {
      setCoverFilter((e as CustomEvent).detail as 'on' | 'off');
    };
    window.addEventListener('roam-cover-filter-changed', handler);
    return () => window.removeEventListener('roam-cover-filter-changed', handler);
  }, []);
  // 监听播放栏位置切换
  useEffect(() => {
    const handler = (e: Event) => {
      setBarPosition((e as CustomEvent).detail as 'stage' | 'overlay');
    };
    window.addEventListener('roam-bar-position-changed', handler);
    return () => window.removeEventListener('roam-bar-position-changed', handler);
  }, []);

  // EQ 动画 — 真实律动：使用 WASAPI Loopback 频域数据，降级到伪律动
  useEffect(() => {
    // 本页是频谱唯一消费者：挂载时唤醒 Rust 采集线程，卸载时休眠（省 CPU/IPC）
    musicPlayer.requestSpectrum();
    return () => { musicPlayer.releaseSpectrum(); };
  }, []);
  useEffect(() => {
    const freqData = new Uint8Array(64);
    const animate = () => {
      const analyser = musicPlayer.getAnalyser();
      if (analyser && nowPlaying.isPlaying) {
        analyser.getByteFrequencyData(freqData);
        const bins = freqData.length;
        setEqHeights(prev => {
          const next = [...prev];
          for (let i = 0; i < EQ_BARS; i++) {
            // 对数映射，让低频在中间，高频在两端（更自然）
            const ratio = i / EQ_BARS;
            const dataIdx = Math.floor(Math.pow(ratio, 1.5) * (bins - 1));
            let v = freqData[dataIdx] / 255;
            // 易驱性增强：非线性增益（平方根拉伸低幅度 + 1.8x 增益 + 偏移）
            v = Math.sqrt(v) * 1.8 + 0.03;
            v = Math.min(1, v);
            next[i] = 5 + v * 92;
          }
          return next;
        });
      } else {
        // 降级：伪律动
        const t = performance.now() / 240;
        const amp = nowPlaying.isPlaying ? 0.9 : 0.2;
        setEqHeights(prev => {
          const next = [...prev];
          for (let i = 0; i < EQ_BARS; i++) {
            const v = (Math.sin(t + i * 0.6) * 0.5 + 0.5) * amp;
            next[i] = 8 + v * 82;
          }
          return next;
        });
      }
      eqRafRef.current = requestAnimationFrame(animate);
    };
    eqRafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(eqRafRef.current);
  }, [nowPlaying.isPlaying]);

  const slideRoamWindow = useCallback((tracks: RoamSeedTrack[], currentId: string) => {
    const idx = tracks.findIndex((t) => t.id === currentId);
    if (idx < 0) return;
    const start = Math.max(0, idx - 1);
    roamWindowRef.current = tracks.slice(start, start + ROAM_WINDOW_SIZE);
  }, []);

  const addToHistory = useCallback((track: RoamSeedTrack) => {
    const entry: RoamHistoryEntry = { track, playedAt: Date.now() };
    const filtered = historyRef.current.filter((e) => e.track.id !== track.id);
    historyRef.current = [...filtered, entry];
    if (historyRef.current.length > 100) historyRef.current = historyRef.current.slice(-100);
    onHistoryUpdateRef.current?.(source, historyRef.current);
  }, [source]);

  const fetchRoamBatch = useCallback(async (count = 8): Promise<RoamSeedTrack[]> => {
    const api = getRoamSourceApi(source);
    const result = await api.fetchBatch(count, 0);
    if (result.tracks.length < count && roamReservoir.current.length < count) {
      try { const more = await api.fetchBatch(50, 0); roamReservoir.current = [...roamReservoir.current, ...more.tracks]; } catch {}
    }
    return result.tracks;
  }, [source]);

  const pushRoamTracks = useCallback(async (batch: RoamSeedTrack[], startIndex: number, first: boolean) => {
    if (!batch.length) return;
    const api = getRoamSourceApi(source);
    if (first) {
      const t0 = batch[startIndex] ?? batch[0];
      const urlRes = await api.getSongUrl(t0).catch((): { url: string; br?: number } => ({ url: '' }));
      const playlist: PlayableTrack[] = batch.map((t, i) => (i === startIndex && urlRes.url) ? roamToPlayable(t, urlRes.url, urlRes.br ? `${urlRes.br}` : '') : roamToPlayable(t, ''));
      onPlayRef.current(playlist, startIndex, '漫游电台');
      const tempId = `roam-${Date.now()}`;
      onTempPlaylistRef.current?.({ id: tempId, name: '漫游电台', coverPath: playlist[startIndex]?.coverPath, tracks: playlist, payload: { kind: 'recommend', name: '漫游电台', tracks: playlist } });
      setRoamCurrentId(playlist[startIndex]?.id ?? null);
      addToHistory(batch[startIndex] ?? batch[0]);
      const tasks: Promise<void>[] = [];
      for (let i = 0; i < batch.length; i++) {
        if (i === startIndex && urlRes.url) continue;
        tasks.push((async () => { const u = await api.getSongUrl(batch[i]).catch(() => null); if (u?.url) musicPlayer.updateTrackUrl(i, u.url); })());
      }
      await Promise.all(tasks);
    } else {
      const playlist: PlayableTrack[] = batch.map((t) => roamToPlayable(t, ''));
      const baseIdx = musicPlayer.getTracks().length;
      musicPlayer.appendTracks(playlist);
      const tasks: Promise<void>[] = [];
      for (let i = 0; i < batch.length; i++) {
        tasks.push((async () => { const u = await api.getSongUrl(batch[i]).catch(() => null); if (u?.url) musicPlayer.updateTrackUrl(baseIdx + i, u.url); })());
      }
      await Promise.all(tasks);
    }
  }, [source, addToHistory]);

  const extendRoam = useCallback(async () => {
    if (roamExtending.current) return;
    roamExtending.current = true;
    try {
      const batch = await fetchRoamBatch(1);
      if (batch.length) {
        roamTrackListRef.current = [...roamTrackListRef.current, ...batch];
        await pushRoamTracks(batch, 0, false);
        const curId = musicPlayer.getCurrentTrack()?.id;
        if (curId) slideRoamWindow(roamTrackListRef.current, curId);
      }
    } catch (e) { console.warn('[roam] 续推失败', e); }
    finally { roamExtending.current = false; }
  }, [fetchRoamBatch, pushRoamTracks, slideRoamWindow]);

  const startRoamWithFirst = useCallback(async (first: RoamSeedTrack[], req: number) => {
    const api = getRoamSourceApi(source);
    const urlRes = await api.getSongUrl(first[0]).catch((): { url: string; br?: number } => ({ url: '' }));
    const playlist: PlayableTrack[] = [roamToPlayable(first[0], urlRes.url, urlRes.br ? `${urlRes.br}` : '')];
    slideRoamWindow(first, first[0].id);
    setLoading(false);
    roamStartedRef.current = true;
    if (!musicPlayer.getCurrentTrack()) {
      onPlayRef.current(playlist, 0, '漫游电台');
      const tempId = `roam-${Date.now()}`;
      onTempPlaylistRef.current?.({ id: tempId, name: '漫游电台', coverPath: playlist[0]?.coverPath, tracks: playlist, payload: { kind: 'recommend', name: '漫游电台', tracks: playlist } });
      setRoamCurrentId(playlist[0]?.id ?? null);
      roamTrackListRef.current = [...first];
      addToHistory(first[0]);
    } else {
      musicPlayer.appendTracks(playlist);
      roamTrackListRef.current = [...roamTrackListRef.current, ...first];
    }
    fetchRoamBatch(7).then((rest) => {
      if (req !== reqRef.current || !rest.length) return;
      pushRoamTracks(rest, 0, false);
      roamTrackListRef.current = [...roamTrackListRef.current, ...rest];
    }).catch(() => {});
  }, [source, fetchRoamBatch, pushRoamTracks, slideRoamWindow, addToHistory]);

  // 初始加载
  useEffect(() => {
    // source 变化时强制重新初始化
    roamStartedRef.current = false;
    roamForceReloadRef.current = false;
    roamReservoir.current = [];
    roamTrackListRef.current = [];
    trackIdxRef.current = 0;
    // 重置历史记录，避免跨源混淆，并从 prop 恢复当前 source 的历史
    historyRef.current = [...(initialHistory || [])];
    lyricCacheRef.current.clear();
    const req = ++reqRef.current;
    setLoading(true); setError('');
    (async () => {
      try {
        const first = await fetchRoamBatch(1);
        if (req !== reqRef.current) return;
        if (!first.length) { setError('暂无推荐歌曲，请稍后再试'); setLoading(false); return; }
        await startRoamWithFirst(first, req);
      } catch (e: any) {
        if (req === reqRef.current) { setError(String(e?.message || e)); setLoading(false); }
      }
    })();
  }, [roamReloadKey, source]); // eslint-disable-line react-hooks/exhaustive-deps

  // 播放器事件
  useEffect(() => {
    const syncNow = () => {
      const t = musicPlayer.getCurrentTrack();
      setNowPlaying({ track: t ? { ...t } : null, isPlaying: musicPlayer.getIsPlaying() });
    };
    const syncProgress = (data: any) => {
      if (data && typeof data.currentTime === 'number') setProgress({ current: data.currentTime, duration: data.duration || 0 });
    };
    const syncCurrent = () => {
      setRoamCurrentId(musicPlayer.getCurrentTrack()?.id ?? null);
      syncNow();
      setProgress({ current: musicPlayer.getCurrentTime(), duration: musicPlayer.getDuration() });
    };
    const maybeExtend = () => {
      const curTrack = musicPlayer.getCurrentTrack();
      const curId = curTrack?.id;
      if (curId) {
        slideRoamWindow(roamTrackListRef.current, curId);
        const track = roamTrackListRef.current.find((t) => t.id === curId);
        if (track) addToHistory(track);
        // 更新主题色：优先用 roamTrackListRef 中的 track（RoamSeedTrack 有 cover 字段），
        // 降级用 musicPlayer 的 track（PlayableTrack 有 coverPath 字段）
        const roamTrack = track as (RoamSeedTrack & { coverPath?: string }) | null;
        const coverUrl = getCoverUrl(
          roamTrack?.cover ||       // RoamSeedTrack.cover
          roamTrack?.coverPath ||   // 兼容：某些映射可能也设置了 coverPath
          (curTrack as any)?.coverPath  // PlayableTrack.coverPath
        );
        if (themeMode === 'preset') {
          presetIdxRef.current = (presetIdxRef.current + 1) % PRESET_THEMES.length;
          const preset = PRESET_THEMES[presetIdxRef.current];
          setSongTheme({ hue: preset.hue, fog: preset.fog });
        } else {
          setSongTheme(getSongTheme(coverUrl));
        }
        // 加载歌词
        loadLyricsForTrack(track || null);
      }
      setRoamCurrentId(curId ?? null);
      syncNow();
      const tracks = musicPlayer.getTracks();
      const idx = musicPlayer.getCurrentIndex();
      const nextInQueue = idx >= 0 && idx + 1 < tracks.length;
      const bufferLow = !nextInQueue || roamReservoir.current.length <= 2;
      if (bufferLow && !roamExtending.current) extendRoam();
    };
    syncNow();
    setRoamCurrentId(musicPlayer.getCurrentTrack()?.id ?? null);
    setProgress({ current: musicPlayer.getCurrentTime(), duration: musicPlayer.getDuration() });
    const unsubTrackChange = musicPlayer.on('trackChange', maybeExtend);
    const unsubPlay = musicPlayer.on('play', syncCurrent);
    const unsubPause = musicPlayer.on('pause', syncNow);
    const unsubProgress = musicPlayer.on('progress', syncProgress);
    const tracks = musicPlayer.getTracks();
    const idx = musicPlayer.getCurrentIndex();
    const nextInQueue = idx >= 0 && idx + 1 < tracks.length;
    if ((!nextInQueue || roamReservoir.current.length <= 2) && !roamExtending.current) extendRoam();
    return () => { unsubTrackChange(); unsubPlay(); unsubPause(); unsubProgress(); };
  }, [extendRoam, slideRoamWindow, addToHistory]);

  // 加载歌词
  const loadLyricsForTrack = useCallback(async (track: RoamSeedTrack | null) => {
    if (!track) { setLyricLines([]); setCurLyric({ cur: '', next: '' }); return; }
    // 检查缓存
    const cached = lyricCacheRef.current.get(track.id);
    if (cached) { setLyricLines(cached); return; }
    try {
      const api = getRoamSourceApi(source);
      if (!api.getLyric) { setLyricLines([]); return; }
      const lines = await api.getLyric(track);
      if (!lines) { setLyricLines([]); return; }
      lyricCacheRef.current.set(track.id, lines);
      setLyricLines(lines);
    } catch { setLyricLines([]); }
  }, [source]);

  // 歌词同步：根据播放进度更新当前行，并按「译/音」模式取到对应的翻译/音译小字
  useEffect(() => {
    if (!lyricLines.length) { setCurLyric({ cur: '', next: '' }); setCurSub(''); setNextSub(''); return; }
    const ct = musicPlayer.getCurrentTime() * 1000;
    let idx = -1;
    for (let i = 0; i < lyricLines.length; i++) {
      if (lyricLines[i].time_ms <= ct) idx = i;
      else break;
    }
    const curLine = idx >= 0 ? lyricLines[idx] : null;
    const nextLine = idx + 1 < lyricLines.length ? lyricLines[idx + 1] : null;
    setCurLyric({ cur: curLine ? curLine.text : '', next: nextLine ? nextLine.text : '' });
    // 小字内容：翻译模式取 translation，音译模式取 romaji
    if (curLine) setCurSub(lyricMode === 'romaji' ? (curLine.romaji || '') : (curLine.translation || ''));
    else setCurSub('');
    if (nextLine) setNextSub(lyricMode === 'romaji' ? (nextLine.romaji || '') : (nextLine.translation || ''));
    else setNextSub('');
  }, [progress.current, lyricLines, lyricMode]);

  const refreshRoam = useCallback(() => {
    roamReservoir.current = []; roamStartedRef.current = false; roamForceReloadRef.current = true;
    clearRoamCache(); lyricCacheRef.current.clear(); setLyricLines([]);
    setRoamReloadKey((k) => k + 1);
  }, []);

  // 翻转动画（防抖 200ms）
  const scheduleFlip = useCallback(() => {
    if (flipTimerRef.current) clearTimeout(flipTimerRef.current);
    flipTimerRef.current = setTimeout(() => {
      setTransitioning(true);
      setFlipped(f => !f);
      setTimeout(() => setTransitioning(false), 760);
    }, 200);
  }, []);

  const handleNext = useCallback(() => {
    burstFromRef.current = trackIdxRef.current;
    musicPlayer.next();
    scheduleFlip();
  }, [scheduleFlip]);

  const handlePrev = useCallback(() => {
    burstFromRef.current = trackIdxRef.current;
    musicPlayer.prev();
    scheduleFlip();
  }, [scheduleFlip]);

  // 预设模式数据
  const curPreset = themeMode === 'preset' ? PRESET_THEMES[presetIdxRef.current] : null;

  // 渲染数据
  const cur = nowPlaying.track;
  const curCover = themeMode === 'preset' ? null : getCoverUrl(cur?.coverPath);
  const dur = progress.duration || cur?.durationSecs || 0;
  const pos = progress.current || 0;
  const pct = dur > 0 ? (pos / dur) * 100 : 0;

  // 自适应缩放因子：基于视口宽度动态计算，小窗口 1.0，大窗口线性增长至上限 1.8
  // 用于让标题、按钮、间距等元素在窗口放大时自然摊开
  const [scaleFactor, setScaleFactor] = useState(1);
  useEffect(() => {
    const updateScale = () => {
      const w = window.innerWidth;
      setScaleFactor(Math.min(1.8, 1 + Math.max(0, (w - 900) / 1000)));
    };
    updateScale();
    window.addEventListener('resize', updateScale);
    return () => window.removeEventListener('resize', updateScale);
  }, []);

  // 颜色 token
  const ink = isDark ? 'rgba(255,255,255,0.93)' : (curPreset ? curPreset.inkColor : 'rgba(255,255,255,0.96)');
  const inkSoft = isDark ? 'rgba(255,255,255,0.62)' : (curPreset ? curPreset.inkSoftColor : 'rgba(255,255,255,0.80)');
  const inkLine = isDark ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.50)';
  const glow = isDark ? '0 2px 10px rgba(0,0,0,0.5)' : '0 2px 0 rgba(155,196,110,0.25), 0 8px 30px rgba(110,168,76,0.35)';
  const stageBg = isDark
    ? 'radial-gradient(ellipse at 22% 38%, #1a2a16 0%, #1c1917 38%, #0e0c0a 78%, #0a0908 100%)'
    : (curPreset ? curPreset.bgGradient : 'radial-gradient(ellipse at 22% 38%, #f3fbe2 0%, #d6ecc4 38%, #b3d896 78%, #8cbc6d 100%)');

  // 右下角两行：只显示歌词，不显示歌曲信息（歌曲信息已在遮罩区显示）
  const lyricLine1 = themeMode === 'preset' && curPreset
    ? curPreset.l1
    : (curLyric.cur || '');
  const lyricLine2 = themeMode === 'preset' && curPreset
    ? curPreset.l2
    : (curLyric.next || '');

  // 标题区：预设模式用预设标题，跟随模式用歌曲信息
  const displayTitle = themeMode === 'preset' && curPreset ? curPreset.title : (cur?.title || 'UNKNOWN');
  const displayArtist = themeMode === 'preset' && curPreset ? curPreset.sub : (cur?.artist || '未知歌手');
  const displayAlbum = themeMode === 'preset' && curPreset ? curPreset.lede : (cur?.album || '');

  // 自适应字号：根据文字长度计算，字越多字号越小，保证一行内完全显示
  // 标题：短文字最大 56px，每多一个字减小，最低不小于 11px
  const titleFontPx = Math.max(11, Math.min(Math.round(56 * scaleFactor), Math.round((window.innerWidth * 0.42) / Math.max(displayTitle.length, 1) * 1.6)));
  // 歌手：最大 16px，最低 8px
  const artistFontPx = Math.max(8, Math.min(Math.round(16 * scaleFactor), Math.round((window.innerWidth * 0.42) / Math.max(displayArtist.length, 1) * 1.8)));
  // 专辑：最大 12px，最低 7px
  const albumFontPx = Math.max(7, Math.min(Math.round(12 * scaleFactor), Math.round((window.innerWidth * 0.42) / Math.max(displayAlbum.length, 1) * 1.8)));

  // ---- 遮罩区文本自适应（限宽内自动缩小字号）----
  // 上面按字符数估算出的字号是第一档，这里再按「真实渲染宽度」测量校正：
  // 若实际超出容器宽度，则按超出的比例等比例缩小到刚好放得下（不低于下限），确保不换行、不被截断。
  const titleRef = useRef<HTMLHeadingElement>(null);
  const artistRef = useRef<HTMLHeadingElement>(null);
  const albumRef = useRef<HTMLParagraphElement>(null);
  const [titleFitPx, setTitleFitPx] = useState<number | null>(null);
  const [artistFitPx, setArtistFitPx] = useState<number | null>(null);
  const [albumFitPx, setAlbumFitPx] = useState<number | null>(null);
  useEffect(() => {
    const targets: Array<{ el: HTMLElement | null; max: number; floor: number; apply: (n: number) => void }> = [
      { el: titleRef.current, max: titleFontPx, floor: 11, apply: setTitleFitPx },
      { el: artistRef.current, max: artistFontPx, floor: 8, apply: setArtistFitPx },
      { el: albumRef.current, max: albumFontPx, floor: 7, apply: setAlbumFitPx },
    ];
    for (const t of targets) {
      const el = t.el;
      if (!el) continue;
      const cs = window.getComputedStyle(el);
      // 左右内边距不随字号缩放，计算时从可用宽与内容宽中扣除，保证比例精确
      const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const availW = el.clientWidth - padX; // 可用于文本的宽度
      if (availW <= 0) { t.apply(t.max); continue; }
      el.style.fontSize = `${t.max}px`; // 先以期望上限测量真实内容宽度
      const contentW = el.scrollWidth - padX;
      if (contentW > availW) {
        // 超出则按比例缩小（下限保护），写回 style 避免闪烁，并同步 state 以驱动最终渲染
        const fit = Math.max(t.floor, Math.round(contentW ? t.max * availW / contentW : t.max));
        el.style.fontSize = `${fit}px`;
        t.apply(fit);
      } else {
        t.apply(t.max);
      }
    }
  }, [displayTitle, displayArtist, displayAlbum, titleFontPx, artistFontPx, albumFontPx]);
  const vinylBg = themeMode === 'preset' && curPreset
    ? curPreset.coverGradient
    : (curCover ? `url(${curCover}) center/cover` : isDark ? 'radial-gradient(circle at 38% 32%, #2a3a22, #0a1209)' : 'radial-gradient(circle at 38% 32%, #ffffff, #cad9ad)');

  // CSS keyframes 和 stage 样式
  const stageStyle = `
    .roam-stage { position: relative; width: 100%; height: 100%; overflow: hidden; background: ${stageBg}; --hue: ${songTheme.hue}deg; --fog: ${songTheme.fog}; }
    .roam-stage * { box-sizing: border-box; }
    @keyframes roam-spin { from { transform: rotate(0deg);} to { transform: rotate(360deg);} }
    @keyframes roam-breathe { 0%,100% { box-shadow: 0 12px 28px -10px rgba(0,0,0,0.4), 0 0 0 0 rgba(255,255,255,0.55);} 50% { box-shadow: 0 12px 28px -10px rgba(0,0,0,0.4), 0 0 0 10px rgba(255,255,255,0);} }
    @keyframes roam-charGlow { 0%,100% { opacity: 0.5; } 50% { opacity: 1; } }
    @keyframes roam-float { 0%,100% { transform: translateY(0) scale(0.6); opacity: 0; } 20% { opacity: 1; } 50% { transform: translateY(-30px) scale(1.2); opacity: 1; } 80% { opacity: 0.8; } }
    .roam-right-cover, .roam-left-cover { position: absolute; top: 0; bottom: 0; overflow: hidden; transition: left 0.7s cubic-bezier(.22,.61,.36,1), width 0.7s cubic-bezier(.22,.61,.36,1), opacity 0.45s ease; }
    .roam-right-cover { left: 44%; width: 56%; z-index: 1; }
    .roam-left-cover { left: 0; width: 44%; z-index: 2; filter: ${coverFilter === 'on' ? 'blur(22px) saturate(1.55) brightness(1.07) hue-rotate(var(--hue))' : 'blur(22px) brightness(1.05)'}; }
    .roam-left-cover img, .roam-right-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .roam-right-cover img { filter: ${coverFilter === 'on' ? 'saturate(1.08) brightness(1.03) hue-rotate(var(--hue))' : 'none'}; }
    .roam-stage.flipped .roam-left-cover { left: 56%; width: 44%; }
    .roam-stage.flipped .roam-right-cover { left: 0; width: 56%; }
    .roam-left { position: absolute; top: 0; bottom: 0; left: 0; width: 44%; z-index: 4; display: flex; flex-direction: column; padding: clamp(14px, 3%, 36px) clamp(16px, 4%, 50px) clamp(14px, 3%, 36px) clamp(16px, 4%, 50px); overflow: hidden; transition: left 0.7s cubic-bezier(.22,.61,.36,1), width 0.7s cubic-bezier(.22,.61,.36,1), opacity 0.45s ease; background: ${isDark ? 'linear-gradient(135deg, rgba(30,42,26,0.35) 0%, rgba(28,25,23,0.12) 40%, rgba(20,40,15,0.18) 100%)' : 'linear-gradient(135deg, rgba(255,255,255,0.30) 0%, rgba(255,255,255,0.08) 40%, rgba(190,222,170,0.14) 100%)'}; backdrop-filter: blur(8px) saturate(140%); -webkit-backdrop-filter: blur(8px) saturate(140%); border-right: 1px solid ${inkLine}; }
    .roam-stage.flipped .roam-left { left: 56%; }
    .roam-stage.transitioning .roam-left, .roam-stage.transitioning .roam-left-cover, .roam-stage.transitioning .roam-right-cover, .roam-stage.transitioning .roam-lyrics, .roam-stage.transitioning .roam-fireflies { opacity: 0; }
    .roam-transition-overlay { position: absolute; inset: 0; z-index: 6; pointer-events: none; opacity: 0; background-color: var(--fog); backdrop-filter: blur(15px) saturate(150%); -webkit-backdrop-filter: blur(15px) saturate(150%); transition: opacity 0.45s ease; }
    .roam-stage.transitioning .roam-transition-overlay { opacity: 1; }
    .roam-vinyl-wrap { position: absolute; left: 22%; top: 50%; transform: translate(-50%, -50%); width: clamp(90px, ${13 * scaleFactor}vw, ${Math.round(160 * scaleFactor)}px); aspect-ratio: 1; z-index: 7; transition: left 0.7s cubic-bezier(.22,.61,.36,1); }
    .roam-stage.flipped .roam-vinyl-wrap { left: 78%; }
    .roam-vinyl { width: 100%; height: 100%; border-radius: 50%; position: relative; overflow: hidden; box-shadow: 0 30px 60px -20px rgba(40,60,30,0.5), 0 0 0 1px rgba(255,255,255,0.65), inset 0 0 26px rgba(255,255,255,0.55), inset 0 0 0 7px rgba(255,255,255,0.18); }
    .roam-vinyl.spinning { animation: roam-spin 28s linear infinite; }
    .roam-bokeh { position: absolute; inset: 0; pointer-events: none; mix-blend-mode: screen; z-index: 3; }
    .roam-bokeh .puff { position: absolute; border-radius: 50%; filter: blur(40px); opacity: 0.55; }
    .roam-fireflies { position: absolute; inset: 0; pointer-events: none; z-index: 5; overflow: hidden; transition: opacity 0.45s ease; }
    .roam-fireflies i { position: absolute; width: 4px; height: 4px; background: #fff; border-radius: 50%; box-shadow: 0 0 12px 2px rgba(255,255,255,0.7); opacity: 0; animation: roam-float 9s ease-in-out infinite; }
    .roam-vignette { position: absolute; inset: 0; z-index: 8; pointer-events: none; background: radial-gradient(ellipse at center, transparent 55%, rgba(20,40,15,0.22) 100%); mix-blend-mode: multiply; }
    .roam-stage.flipped .roam-lyrics { right: auto; left: clamp(16px, 3%, 40px); align-items: flex-start; text-align: left; }
  `;

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden relative" style={{ background: stageBg }}>
      <style dangerouslySetInnerHTML={{ __html: stageStyle }} />

      {/* 主舞台 */}
      <div className="flex-1 relative overflow-hidden">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center" style={{ color: inkSoft }}>
              <div className="w-28 h-28 mx-auto mb-4 rounded-full border-4 border-current border-t-transparent animate-spin" style={{ animationDuration: '1.5s' }} />
              <div className="text-sm">正在为你挑选歌曲…</div>
            </div>
          </div>
        ) : error ? (
          <div className="absolute inset-0 flex items-center justify-center"><div className="text-sm text-red-400/80 text-center">{error}</div></div>
        ) : !cur ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <div className="w-36 h-36 rounded-3xl flex items-center justify-center shadow-lg" style={{ background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.3)' }}>
              <MusicIcon size={52} style={{ color: inkSoft }} />
            </div>
            <div className="text-base font-semibold" style={{ color: inkSoft }}>尚未开始漫游</div>
            <div className="text-sm" style={{ color: inkLine }}>进入漫游页将自动为你播放推荐</div>
          </div>
        ) : (
          <div className={`roam-stage ${flipped ? 'flipped' : ''} ${transitioning ? 'transitioning' : ''}`}>
            {/* 右侧清晰封面 */}
            <div className="roam-right-cover">
              {themeMode === 'preset' && curPreset ? (
                <div className="w-full h-full" style={{ background: curPreset.coverGradient }} />
              ) : curCover ? (
                <img src={curCover} alt="" />
              ) : (
                <div className="w-full h-full flex items-center justify-center" style={{ background: isDark ? '#1e2a1a' : '#a4c084' }}><MusicIcon size={72} style={{ color: inkLine }} /></div>
              )}
            </div>

            {/* 左侧模糊封面 + 光斑 */}
            <div className="roam-left-cover">
              {themeMode === 'preset' && curPreset ? (
                <div className="w-full h-full" style={{ background: curPreset.bgGradient }} />
              ) : curCover ? (
                <img src={curCover} alt="" />
              ) : (
                <div className="w-full h-full" style={{ background: isDark ? '#1a2a16' : '#d6ecc4' }} />
              )}
              <div className="roam-bokeh">
                <div className="puff" style={{ width: 360, height: 360, left: -120, top: -90, background: 'radial-gradient(circle, #ffffff 0%, transparent 70%)' }} />
                <div className="puff" style={{ width: 420, height: 420, left: '8%', top: '18%', background: 'radial-gradient(circle, #e8ffd1 0%, transparent 70%)' }} />
                <div className="puff" style={{ width: 260, height: 260, left: '30%', top: '60%', background: 'radial-gradient(circle, #ffffff 0%, transparent 70%)', opacity: 0.4 }} />
                <div className="puff" style={{ width: 480, height: 480, right: '5%', top: '30%', background: 'radial-gradient(circle, #fff4c4 0%, transparent 70%)', opacity: 0.45 }} />
              </div>
            </div>

            {/* 左侧玻璃面板 */}
            <div className="roam-left">
  {/* 标题区 — 限制宽度不覆盖唱片，长文字自适应缩小字号完全显示 */}
              <div className="flex flex-col gap-1" style={{ paddingLeft: 'clamp(12px, 2%, 22px)', maxWidth: 'calc(100% - 20px)' }}>
                <div className="flex items-center gap-2 mb-2" style={{ fontFamily: 'ui-monospace, monospace', fontSize: `${9 * scaleFactor}px`, letterSpacing: '0.4em', textTransform: 'uppercase', color: inkSoft }}>
                  <span style={{ width: 24 * scaleFactor, height: 1, background: inkLine }} /> A roam playlist
                </div>
                {/* 标题：字号先按字数估算，再按真实宽度测量微调，保证完全显示 */}
                <h1 ref={titleRef} className="font-black leading-none" style={{
                  fontSize: `${titleFitPx ?? titleFontPx}px`,
                  letterSpacing: '-0.02em', color: ink, textShadow: glow,
                  whiteSpace: 'nowrap',
                }}>
                  {displayTitle}
                </h1>
                {/* 歌手：同上自适应 */}
                <h2 ref={artistRef} className="mt-2" style={{
                  fontSize: `${artistFitPx ?? artistFontPx}px`,
                  letterSpacing: '0.15em', textTransform: 'uppercase', color: ink, fontWeight: 400,
                  whiteSpace: 'nowrap',
                }}>
                  {displayArtist}
                </h2>
                {displayAlbum && (
                  <p ref={albumRef} className="mt-2" style={{
                    fontSize: `${albumFitPx ?? albumFontPx}px`, lineHeight: 1.6, color: inkSoft,
                    borderLeft: `1px solid ${inkLine}`, paddingLeft: 10,
                    whiteSpace: 'nowrap',
                  }}>{displayAlbum}</p>
                )}
              </div>

              {/* 遮罩区内播放栏（overlay 模式） */}
              {barPosition === 'overlay' && (
                <div className="mt-auto flex flex-col items-center gap-2" style={{ width: '100%', maxWidth: Math.round(400 * scaleFactor), paddingTop: 'clamp(12px, 2%, 20px)' }}>
                  {/* EQ 均衡器 */}
                  <div className="flex items-end justify-center" style={{ gap: 3, width: '100%', height: 95, marginBottom: 4 }}>
                    {eqHeights.map((h, i) => (
                      <span key={i} style={{
                        flex: '1 1 0', minWidth: 2, maxWidth: 8, height: `${h}%`,
                        background: `linear-gradient(180deg, ${ink}, ${inkLine})`,
                        borderRadius: 2, opacity: 0.85,
                        transition: 'height 0.05s linear',
                      }} />
                    ))}
                  </div>
                  {/* 进度条 — 视觉2px细线，点击区域向上拓展2倍 */}
                  <div className="flex items-center gap-2 w-full" style={{ fontFamily: 'ui-monospace, monospace', fontSize: '9px', color: ink }}>
                    <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 28 }}>{formatTime(pos)}</span>
                    {/* 外层透明容器拓展点击区域（上方14px+下方14px），内层2px细线 */}
                    <div className="flex-1 relative cursor-pointer" style={{ paddingTop: 14, paddingBottom: 14, marginTop: -14, marginBottom: -14 }}
                      onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); musicPlayer.seek(ratio * dur); }}>
                      {/* 视觉细线层：仅2px高，居中于点击区域 */}
                      <div className="relative rounded-full" style={{ height: 2, background: inkLine }}>
                        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: '#fff' }} />
                        <div className="absolute rounded-full" style={{ left: `${pct}%`, top: '50%', transform: 'translate(-50%,-50%)', width: 7, height: 7, background: '#fff', boxShadow: '0 0 0 2px rgba(255,255,255,0.2)' }} />
                      </div>
                    </div>
                    <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 28, textAlign: 'right' }}>{formatTime(dur)}</span>
                  </div>
                  {/* 控制按钮 */}
                  <div className="flex items-center" style={{ gap: `clamp(8px, ${1.2 * scaleFactor}vw, ${Math.round(18 * scaleFactor)}px)`, color: ink }}>
                    <button onClick={handlePrev} style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', padding: 4, lineHeight: 0 }} title="上一首">
                      <svg width={Math.round(18 * scaleFactor)} height={Math.round(18 * scaleFactor)} viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zM9.5 12L20 18V6z"/></svg>
                    </button>
                    <button onClick={() => musicPlayer.togglePlay()} className="rounded-full flex items-center justify-center transition-transform hover:scale-105" style={{ width: `clamp(36px, ${4 * scaleFactor}vw, ${Math.round(48 * scaleFactor)}px)`, height: `clamp(36px, ${4 * scaleFactor}vw, ${Math.round(48 * scaleFactor)}px)`, background: 'rgba(255,255,255,0.92)', color: '#2c5a1a', boxShadow: '0 8px 20px -8px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(255,255,255,0.5)', border: 'none', cursor: 'pointer', animation: nowPlaying.isPlaying ? 'roam-breathe 3.4s ease-in-out infinite' : 'none' }} title={nowPlaying.isPlaying ? '暂停' : '播放'}>
                      {nowPlaying.isPlaying ? (
                        <svg viewBox="0 0 24 24" width={Math.round(18 * scaleFactor)} height={Math.round(18 * scaleFactor)} fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
                      ) : (
                        <svg viewBox="0 0 24 24" width={Math.round(18 * scaleFactor)} height={Math.round(18 * scaleFactor)} fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                      )}
                    </button>
                    <button onClick={handleNext} style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', padding: 4, lineHeight: 0 }} title="下一首">
                      <svg width={Math.round(18 * scaleFactor)} height={Math.round(18 * scaleFactor)} viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM4 6l10.5 6L4 18z"/></svg>
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* 黑胶唱片 — 点击进入沉浸式播放 */}
            <div className="roam-vinyl-wrap" style={{ cursor: 'pointer' }} onClick={onOpenImmersive} title="点击进入沉浸式播放">
              <div className="absolute rounded-full" style={{ inset: '-20%', background: 'radial-gradient(circle, rgba(255,255,255,0.3), transparent 70%)', filter: 'blur(22px)', zIndex: -1 }} />
              <div
                className={`roam-vinyl ${nowPlaying.isPlaying ? 'spinning' : ''}`}
                style={{
                  background: vinylBg,
                }}
              >
                <div className="absolute inset-0 rounded-full" style={{ background: 'conic-gradient(from 210deg, transparent 0deg, rgba(255,255,255,0.18) 26deg, transparent 68deg, rgba(255,255,255,0.08) 150deg, transparent 192deg)', mixBlendMode: 'screen' }} />
                <div className="absolute rounded-full" style={{ width: 5, height: 5, background: '#c4c4c4', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', zIndex: 2, boxShadow: '0 0 0 2px rgba(0,0,0,0.5)' }} />
              </div>
            </div>

            {/* 两行歌词 */}
            <div
              className="roam-lyrics"
              style={{
                position: 'absolute',
                right: flipped ? 'auto' : 'clamp(16px, 3%, 40px)',
                left: flipped ? 'clamp(16px, 3%, 40px)' : 'auto',
                bottom: 'clamp(16px, 4%, 36px)',
                zIndex: 5, display: 'flex', flexDirection: 'column', gap: 'clamp(6px, 0.8vw, 10px)',
                alignItems: flipped ? 'flex-start' : 'flex-end', textAlign: flipped ? 'left' : 'right', pointerEvents: 'none',
                transition: 'right 0.7s cubic-bezier(.22,.61,.36,1), left 0.7s cubic-bezier(.22,.61,.36,1), opacity 0.45s ease',
              }}
            >
              <p style={{ fontWeight: 500, fontSize: `clamp(13px, ${1.4 * scaleFactor}vw, ${Math.round(20 * scaleFactor)}px)`, letterSpacing: '0.04em', color: ink, textShadow: glow, lineHeight: 1.2, margin: 0 }}>
                {[...lyricLine1].map((ch, i) => (
                  <span key={i} style={{ display: 'inline-block', animation: `roam-charGlow 3.6s ease-in-out ${(i * 0.14).toFixed(2)}s infinite`, whiteSpace: 'pre' }}>{ch}</span>
                ))}
              </p>
              {/* 当前行下方：按「译/音」模式显示翻译/音译小字 */}
              {themeMode !== 'preset' && lyricMode !== 'off' && curSub && (
                <p style={{ fontWeight: 300, fontSize: `clamp(9px, ${0.72 * scaleFactor}vw, ${Math.round(11 * scaleFactor)}px)`, letterSpacing: '0.06em', color: inkSoft, opacity: 0.72, textShadow: glow, lineHeight: 1.2, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>{curSub}</p>
              )}
              <p style={{ fontWeight: 300, fontSize: `clamp(10px, ${0.9 * scaleFactor}vw, ${Math.round(13 * scaleFactor)}px)`, letterSpacing: '0.08em', color: inkSoft, textShadow: glow, lineHeight: 1.2, margin: 0 }}>
                {lyricLine2}
              </p>
              {/* 下一行下方：按「译/音」模式显示翻译/音译小字 */}
              {themeMode !== 'preset' && lyricMode !== 'off' && nextSub && (
                <p style={{ fontWeight: 300, fontSize: `clamp(9px, ${0.72 * scaleFactor}vw, ${Math.round(11 * scaleFactor)}px)`, letterSpacing: '0.06em', color: inkSoft, opacity: 0.72, textShadow: glow, lineHeight: 1.2, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>{nextSub}</p>
              )}
            </div>

            {/* 翻转过渡遮罩 */}
            <div className="roam-transition-overlay" />

            {/* 萤火虫 */}
            <div className="roam-fireflies">
              {[[6, 22, 0, 11], [22, 60, 1.6, 8], [38, 14, 3.2, 10], [56, 78, 4.4, 12], [72, 38, 2.2, 9], [88, 66, 5, 11]].map(([l, t, d, dur], i) => (
                <i key={i} style={{ left: `${l}%`, top: `${t}%`, animationDelay: `${d}s`, animationDuration: `${dur}s` }} />
              ))}
            </div>

            {/* 暗角 */}
            <div className="roam-vignette" />

            {/* EQ 均衡器 + 专属播放栏（舞台底部独立层，仅 stage 模式） */}
            {barPosition === 'stage' && (
            <div className="roam-bottom-bar" style={{
              position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 9,
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'clamp(6px, 0.8vw, 12px)',
              padding: 'clamp(10px, 1.5%, 18px) clamp(16px, 4%, 50px) clamp(12px, 1.8%, 22px)',
              background: isDark ? 'linear-gradient(0deg, rgba(20,30,18,0.75) 0%, rgba(20,30,18,0.3) 60%, transparent 100%)' : 'linear-gradient(0deg, rgba(255,255,255,0.45) 0%, rgba(255,255,255,0.15) 60%, transparent 100%)',
              backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
              transition: 'opacity 0.45s ease',
              opacity: transitioning ? 0 : 1,
            }}>
              {/* EQ 均衡器 */}
              <div className="flex items-end justify-center" style={{ gap: 3, width: '100%', maxWidth: 500, height: 95 }}>
                {eqHeights.map((h, i) => (
                  <span key={i} style={{
                    flex: '1 1 0', minWidth: 2, maxWidth: 8, height: `${h}%`,
                    background: `linear-gradient(180deg, ${ink}, ${inkLine})`,
                    borderRadius: 2, opacity: 0.85,
                    transition: 'height 0.05s linear',
                  }} />
                ))}
              </div>

              {/* 进度条 — 视觉2px细线，点击区域向上拓展2倍 */}
              <div className="flex items-center gap-2 w-full" style={{ maxWidth: 500, fontFamily: 'ui-monospace, monospace', fontSize: '9px', color: ink }}>
                <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 28 }}>{formatTime(pos)}</span>
                {/* 外层透明容器拓展点击区域（上方14px+下方14px），内层2px细线 */}
                <div className="flex-1 relative cursor-pointer" style={{ paddingTop: 14, paddingBottom: 14, marginTop: -14, marginBottom: -14 }}
                  onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); musicPlayer.seek(ratio * dur); }}>
                  {/* 视觉细线层：仅2px高，居中于点击区域 */}
                  <div className="relative rounded-full" style={{ height: 2, background: inkLine }}>
                    <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: '#fff' }} />
                    <div className="absolute rounded-full" style={{ left: `${pct}%`, top: '50%', transform: 'translate(-50%,-50%)', width: 7, height: 7, background: '#fff', boxShadow: '0 0 0 2px rgba(255,255,255,0.2)' }} />
                  </div>
                </div>
                <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 28, textAlign: 'right' }}>{formatTime(dur)}</span>
              </div>

              {/* 控制按钮 */}
              <div className="flex items-center" style={{ gap: `clamp(10px, ${1.5 * scaleFactor}vw, ${Math.round(20 * scaleFactor)}px)`, color: ink }}>
                <button onClick={handlePrev} style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', padding: 4, lineHeight: 0 }} title="上一首">
                  <svg width={Math.round(18 * scaleFactor)} height={Math.round(18 * scaleFactor)} viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zM9.5 12L20 18V6z"/></svg>
                </button>
                <button
                  onClick={() => musicPlayer.togglePlay()}
                  className="rounded-full flex items-center justify-center transition-transform hover:scale-105"
                  style={{
                    width: `clamp(36px, ${4 * scaleFactor}vw, ${Math.round(48 * scaleFactor)}px)`, height: `clamp(36px, ${4 * scaleFactor}vw, ${Math.round(48 * scaleFactor)}px)`,
                    background: 'rgba(255,255,255,0.92)', color: '#2c5a1a',
                    boxShadow: '0 8px 20px -8px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(255,255,255,0.5)',
                    border: 'none', cursor: 'pointer',
                    animation: nowPlaying.isPlaying ? 'roam-breathe 3.4s ease-in-out infinite' : 'none',
                  }}
                  title={nowPlaying.isPlaying ? '暂停' : '播放'}
                >
                  {nowPlaying.isPlaying ? (
                    <svg viewBox="0 0 24 24" width={Math.round(18 * scaleFactor)} height={Math.round(18 * scaleFactor)} fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width={Math.round(18 * scaleFactor)} height={Math.round(18 * scaleFactor)} fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                  )}
                </button>
                <button onClick={handleNext} style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', padding: 4, lineHeight: 0 }} title="下一首">
                  <svg width={Math.round(18 * scaleFactor)} height={Math.round(18 * scaleFactor)} viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM4 6l10.5 6L4 18z"/></svg>
                </button>
                {/* 「译/音」三态切换：就近看到歌词时在此切换显示翻译/音译小字 */}
                <LyricModeButton />
              </div>
            </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}