/// <reference path="../../global.d.ts" />
// 独立漫游视图：从网易云「漫游」tab 抽离为通用模板，
// 作为模块抽屉中的第五个卡片入口。复用网易云 API（getListenNow / getPersonalFm / getSongUrl），
// 使用全局 musicPlayer 实例进行播放与队列管理。
//
// 设计原则：轻量高效，不引入网易云的完整生命周期（登录/歌单/搜索等），
// 只保留漫游核心：流式推荐 → 自动播放 → 续推 → 沉浸式单曲展示。

import React from 'react';
const { useState, useEffect, useRef, useCallback } = React;
import { Sparkles, Music as MusicIcon, ChevronLeft } from 'lucide-react';
import { CloudIcon } from '../../_shared/icons';
import { MusicHeader } from './MusicHeader';
import { musicPlayer } from './musicPlayer';
import {
  getListenNow,
  getPersonalFm,
  getSongUrl,
  getSongWiki,
  isLoggedIn,
  neteaseTrackBadges,
  qualityLabelFromBr,
  type NeteaseTrack,
  type SongWiki,
} from './neteaseApi';
import type { PlayableTrack, TempPlaylist } from './NeteaseView';

// ---- 工具函数 ----
function trackToPlayable(t: NeteaseTrack, url: string, quality = ''): PlayableTrack {
  return {
    id: `netease-${t.id}`,
    filePath: url,
    title: t.name,
    artist: t.artist,
    album: t.album,
    durationSecs: Math.round((t.duration || 0) / 1000),
    coverPath: t.cover,
    quality,
  };
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ---- 组件 Props ----
interface RoamViewProps {
  onBack: () => void;
  onPlay: (tracks: PlayableTrack[], startIndex: number, sourceName: string) => void;
  onTempPlaylist?: (temp: TempPlaylist) => void;
  onOpenImmersive?: () => void;
  // 歌手/专辑抽屉
  onOpenArtist?: (id: number | string, name?: string) => void;
  onOpenAlbum?: (id: number | string, name?: string) => void;
}

// ---- 漫游展示窗口 ----
const ROAM_WINDOW_SIZE = 3;

export function RoamView({ onBack, onPlay, onTempPlaylist, onOpenImmersive, onOpenArtist, onOpenAlbum }: RoamViewProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [nowPlaying, setNowPlaying] = useState<{ track: any; isPlaying: boolean }>({ track: null, isPlaying: false });
  const [roamReloadKey, setRoamReloadKey] = useState(0);

  // 漫游队列与缓冲
  const [roamOffset, setRoamOffset] = useState(0);
  const roamReservoir = useRef<NeteaseTrack[]>([]);
  const roamExtending = useRef(false);
  const roamTrackListRef = useRef<NeteaseTrack[]>([]);
  const [roamCurrentId, setRoamCurrentId] = useState<string | null>(null);
  const [roamWiki, setRoamWiki] = useState<SongWiki | null>(null);
  const roamWikiMap = useRef<Record<number, SongWiki | null>>({});
  const roamWikiLoading = useRef(false);
  const roamStartedRef = useRef(false);
  const roamForceReloadRef = useRef(false);
  const reqRef = useRef(0);

  // ref 回调稳定化
  const onPlayRef = useRef(onPlay);
  const onTempPlaylistRef = useRef(onTempPlaylist);
  onPlayRef.current = onPlay;
  onTempPlaylistRef.current = onTempPlaylist;

  // 展示窗口
  const roamWindowRef = useRef<NeteaseTrack[]>([]);

  const slideRoamWindow = useCallback((tracks: NeteaseTrack[], currentId: number | string) => {
    const idx = tracks.findIndex((t) => `netease-${t.id}` === currentId || t.id === currentId);
    if (idx < 0) return;
    const start = Math.max(0, idx - 1);
    const end = Math.min(tracks.length, start + ROAM_WINDOW_SIZE);
    roamWindowRef.current = tracks.slice(start, end);
  }, []);

  // 拉取下一批漫游曲目
  const fetchRoamBatch = useCallback(async (count = 8): Promise<NeteaseTrack[]> => {
    if (isLoggedIn()) {
      const list = await getPersonalFm(count, roamOffset);
      if (list.length) { setRoamOffset((o) => o + list.length); return list; }
    }
    if (roamReservoir.current.length < count) {
      const need = Math.max(count, 8);
      const seed = await getListenNow(need);
      roamReservoir.current = [...roamReservoir.current, ...seed];
      if (seed.length >= 8) {
        getListenNow(50)
          .then((more) => { roamReservoir.current = [...roamReservoir.current, ...more]; })
          .catch(() => {});
      }
    }
    const slice = roamReservoir.current.splice(0, count);
    return slice;
  }, [roamOffset]);

  // 推入播放队列
  const pushRoamTracks = useCallback(async (batch: NeteaseTrack[], startIndex: number, first: boolean) => {
    if (!batch.length) return;
    roamTrackListRef.current = [...roamTrackListRef.current, ...batch];
    if (first) {
      const t0 = batch[startIndex] ?? batch[0];
      const firstRes = await getSongUrl(t0.id);
      const firstQuality = qualityLabelFromBr(firstRes.br ?? 0);
      const playlist: PlayableTrack[] = batch.map((t, i) =>
        (i === startIndex && firstRes.url)
          ? trackToPlayable(t, firstRes.url, firstQuality)
          : trackToPlayable(t, '')
      );
      onPlayRef.current(playlist, startIndex, '漫游电台');
      const tempId = `roam-${Date.now()}`;
      onTempPlaylistRef.current?.({
        id: tempId,
        name: '漫游电台',
        coverPath: playlist[startIndex]?.coverPath,
        tracks: playlist,
        payload: { kind: 'recommend', name: '漫游电台', tracks: playlist },
      });
      setRoamCurrentId(playlist[startIndex]?.id ?? null);
      // 并发补全地址
      const tasks: Promise<void>[] = [];
      for (let i = 0; i < batch.length; i++) {
        if (i === startIndex && firstRes.url) continue;
        tasks.push((async () => {
          const u = await getSongUrl(batch[i].id).catch(() => null);
          if (u?.url) musicPlayer.updateTrackUrl(i, u.url);
        })());
      }
      await Promise.all(tasks);
    } else {
      const playlist: PlayableTrack[] = batch.map((t) => trackToPlayable(t, ''));
      const baseIdx = musicPlayer.getTracks().length;
      musicPlayer.appendTracks(playlist);
      const tasks: Promise<void>[] = [];
      for (let i = 0; i < batch.length; i++) {
        tasks.push((async () => {
          const u = await getSongUrl(batch[i].id).catch(() => null);
          if (u?.url) musicPlayer.updateTrackUrl(baseIdx + i, u.url);
        })());
      }
      await Promise.all(tasks);
    }
  }, []);

  // 续推
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
    } catch (e) {
      console.warn('[roam] 续推失败', e);
    } finally {
      roamExtending.current = false;
    }
  }, [fetchRoamBatch, pushRoamTracks, slideRoamWindow]);

  // 首屏首歌
  const startRoamWithFirst = useCallback(async (first: NeteaseTrack[], req: number) => {
    const firstRes = await getSongUrl(first[0].id).catch(() => null);
    const firstQuality = qualityLabelFromBr(firstRes?.br ?? 0);
    const playlist: PlayableTrack[] = [trackToPlayable(first[0], firstRes?.url ?? '')];
    slideRoamWindow(first, first[0].id);
    setLoading(false);
    roamStartedRef.current = true;
    if (!musicPlayer.getCurrentTrack()) {
      onPlayRef.current(playlist, 0, '漫游电台');
      const tempId = `roam-${Date.now()}`;
      onTempPlaylistRef.current?.({
        id: tempId, name: '漫游电台', coverPath: playlist[0]?.coverPath,
        tracks: playlist, payload: { kind: 'recommend', name: '漫游电台', tracks: playlist },
      });
      setRoamCurrentId(playlist[0]?.id ?? null);
      roamTrackListRef.current = [...first];
    } else {
      musicPlayer.appendTracks(playlist);
      roamTrackListRef.current = [...roamTrackListRef.current, ...first];
    }
    // 后台补满
    fetchRoamBatch(7).then((rest) => {
      if (req !== reqRef.current || !rest.length) return;
      pushRoamTracks(rest, 0, false);
      roamTrackListRef.current = [...roamTrackListRef.current, ...rest];
    }).catch(() => {});
  }, [fetchRoamBatch, pushRoamTracks, slideRoamWindow]);

  // 初始加载
  useEffect(() => {
    if (roamStartedRef.current && !roamForceReloadRef.current) { setLoading(false); return; }
    roamForceReloadRef.current = false;
    roamReservoir.current = [];
    roamTrackListRef.current = [];
    const req = ++reqRef.current;
    setLoading(true);
    setError('');
    setRoamOffset(0);
    (async () => {
      try {
        const first = await fetchRoamBatch(1);
        if (req !== reqRef.current) return;
        if (!first.length) {
          const fallback = await getListenNow(50);
          if (req !== reqRef.current) return;
          roamReservoir.current = fallback;
          const f = fallback.slice(0, 1);
          if (!f.length) { if (req === reqRef.current) setLoading(false); return; }
          await startRoamWithFirst(f, req);
        } else {
          await startRoamWithFirst(first, req);
        }
      } catch (e: any) {
        if (req === reqRef.current) { setError(String(e?.message || e)); setLoading(false); }
      }
    })();
  }, [roamReloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 懒加载百科
  const loadWikiForCurrent = useCallback((cur: NeteaseTrack | null) => {
    if (!cur) { setRoamWiki(null); return; }
    const cached = roamWikiMap.current[cur.id];
    if (cached !== undefined) { setRoamWiki(cached); return; }
    if (roamWikiLoading.current) return;
    roamWikiLoading.current = true;
    setRoamWiki(null);
    getSongWiki(cur.id)
      .then((w) => { roamWikiMap.current[cur.id] = w; if (roamTrackListRef.current.find((t) => t.id === cur.id)) setRoamWiki(w); })
      .catch(() => { roamWikiMap.current[cur.id] = null; })
      .finally(() => { roamWikiLoading.current = false; });
  }, []);

  // 订阅播放器事件
  useEffect(() => {
    const syncNow = () => setNowPlaying({ track: musicPlayer.getCurrentTrack(), isPlaying: musicPlayer.getIsPlaying() });
    const syncCurrent = () => {
      const cur = roamTrackListRef.current.find((t) => `netease-${t.id}` === musicPlayer.getCurrentTrack()?.id) || null;
      setRoamCurrentId(musicPlayer.getCurrentTrack()?.id ?? null);
      loadWikiForCurrent(cur);
      syncNow();
    };
    const maybeExtend = () => {
      const curId = musicPlayer.getCurrentTrack()?.id;
      if (curId) slideRoamWindow(roamTrackListRef.current, curId);
      const cur = roamTrackListRef.current.find((t) => `netease-${t.id}` === curId) || null;
      setRoamCurrentId(curId ?? null);
      loadWikiForCurrent(cur);
      syncNow();
      const tracks = musicPlayer.getTracks();
      const idx = musicPlayer.getCurrentIndex();
      const nextInQueue = idx >= 0 && idx + 1 < tracks.length;
      const bufferLow = !nextInQueue || roamReservoir.current.length <= 2;
      if (bufferLow && !roamExtending.current) extendRoam();
    };
    syncNow();
    setRoamCurrentId(musicPlayer.getCurrentTrack()?.id ?? null);
    loadWikiForCurrent(roamTrackListRef.current.find((t) => `netease-${t.id}` === musicPlayer.getCurrentTrack()?.id) || null);
    const unsubTrackChange = musicPlayer.on('trackChange', maybeExtend);
    const unsubPlay = musicPlayer.on('play', syncCurrent);
    const unsubPause = musicPlayer.on('pause', syncNow);
    // 进入时补一批
    const tracks = musicPlayer.getTracks();
    const idx = musicPlayer.getCurrentIndex();
    const nextInQueue = idx >= 0 && idx + 1 < tracks.length;
    if ((!nextInQueue || roamReservoir.current.length <= 2) && !roamExtending.current) extendRoam();
    return () => {
      unsubTrackChange();
      unsubPlay();
      unsubPause();
    };
  }, [extendRoam, loadWikiForCurrent, slideRoamWindow]);

  const refreshRoam = useCallback(() => {
    roamReservoir.current = [];
    setRoamOffset(0);
    roamStartedRef.current = false;
    roamForceReloadRef.current = true;
    setRoamReloadKey((k) => k + 1);
  }, []);

  // 渲染
  const coverOf = (path?: string) => {
    if (!path) return null;
    if (/^https?:\/\//i.test(path)) return path;
    return window.__HOST_API__?.convertFileSrc(path) || path;
  };

  const cur = nowPlaying.track;
  const curCover = coverOf(cur?.coverPath);
  const curNetease = roamTrackListRef.current.find((t) => `netease-${t.id}` === cur?.id) || null;

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden overflow-x-hidden relative bg-white dark:bg-[#1e1e1e]">
      <MusicHeader
        title="漫游电台"
        onBackToSub={undefined}
        onUserClick={() => {}}
        onCloudClick={onBack}
        cloudTitle="音乐模块"
        user={{ loggedIn: false }}
      />

      <div className="flex-1 h-full min-w-0 overflow-y-auto overflow-x-hidden px-4 pb-4">
        <section className="min-w-0">
          <div className="mb-3 flex items-center justify-between pt-2">
            <h2 className="text-lg font-semibold text-neutral-800 dark:text-stone-100">漫游</h2>
            <button
              onClick={refreshRoam}
              className="btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-stone-100 dark:bg-stone-800 text-neutral-600 dark:text-stone-300 text-sm hover:bg-stone-200 dark:hover:bg-stone-700 transition-colors"
              title="换一批漫游"
            >
              <Sparkles size={14} />
              换一批
            </button>
          </div>

          {loading ? (
            <div className="text-sm text-neutral-400 dark:text-stone-500 py-8 text-center">加载中…</div>
          ) : error ? (
            <div className="text-sm text-red-500/80 dark:text-red-400/80 py-8 text-center">{error}</div>
          ) : !cur ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <div className="w-40 h-40 rounded-3xl bg-[var(--element-muted)] text-[var(--element-bg)] flex items-center justify-center shadow-sm">
                <MusicIcon size={56} />
              </div>
              <div className="text-base font-semibold text-neutral-500 dark:text-stone-400">尚未开始漫游</div>
              <div className="text-sm text-neutral-400 dark:text-stone-500">进入漫游页将自动为你播放推荐</div>
            </div>
          ) : (
            <div className="flex flex-col items-center pt-6 pb-4">
              {/* 居中大封面 */}
              <div
                onClick={onOpenImmersive}
                className="relative w-56 h-56 rounded-3xl overflow-hidden shadow-lg ring-1 ring-black/10 dark:ring-white/10 cursor-pointer transition-transform hover:scale-[1.02]"
                title="打开沉浸播放"
              >
                {curCover ? (
                  React.createElement('img', { src: curCover, alt: '', className: 'w-full h-full object-cover', style: { width: '100%', height: '100%', objectFit: 'cover' } })
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-[var(--element-muted)] text-[var(--element-bg)]">
                    <MusicIcon size={56} />
                  </div>
                )}
                {nowPlaying.isPlaying && (
                  <div className="absolute bottom-2 right-2 flex items-end gap-[2px] px-1.5 py-1 rounded-md bg-black/40 backdrop-blur-sm">
                    {[1, 2, 3].map((i) => (
                      <span key={i} className="w-[3px] bg-white rounded-full animate-[music-bar_0.8s_ease-in-out_infinite]" style={{ height: '8px', animationDelay: `${i * 0.12}s` }} />
                    ))}
                  </div>
                )}
              </div>

              {/* 下方元数据 */}
              <div className="mt-5 flex flex-col items-center text-center px-4 w-full max-w-md">
                <div className="text-lg font-semibold text-neutral-800 dark:text-stone-100 leading-tight">{cur.title}</div>
                <div className="mt-1.5 text-sm leading-tight flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1">
                  <button
                    type="button"
                    className="text-neutral-500 dark:text-stone-400 hover:text-emerald-500 dark:hover:text-emerald-400 hover:underline cursor-pointer"
                    onClick={() => curNetease && onOpenArtist?.(curNetease.artistId!, curNetease.artist)}
                    disabled={!curNetease?.artistId}
                  >{cur.artist || '—'}</button>
                  <span className="opacity-50">·</span>
                  <button
                    type="button"
                    className="text-neutral-500 dark:text-stone-400 hover:text-emerald-500 dark:hover:text-emerald-400 hover:underline cursor-pointer"
                    onClick={() => curNetease && onOpenAlbum?.(curNetease.albumId!, curNetease.album)}
                    disabled={!curNetease?.albumId}
                  >{cur.album || '—'}</button>
                </div>

                {/* 音质徽章 + 时长 + 播放状态 */}
                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                  {curNetease && neteaseTrackBadges(curNetease).map((b) => (
                    <span
                      key={b.kind}
                      className={
                        'inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ' +
                        (b.kind === 'vip'
                          ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20'
                          : b.kind === 'hires'
                            ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20'
                            : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20')
                      }
                    >
                      {b.label}
                    </span>
                  ))}
                  {cur.durationSecs > 0 && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-neutral-100 dark:bg-stone-800 text-neutral-600 dark:text-stone-400 border-neutral-200 dark:border-stone-700">
                      {formatDuration(cur.durationSecs * 1000)}
                    </span>
                  )}
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-neutral-100 dark:bg-stone-800 text-neutral-600 dark:text-stone-400 border-neutral-200 dark:border-stone-700">
                    {nowPlaying.isPlaying ? '正在播放' : '已暂停'}
                  </span>
                </div>

                {/* 歌曲百科 */}
                {roamWiki && (
                  <div className="mt-4 w-full max-w-sm p-3 rounded-xl bg-neutral-100/60 dark:bg-stone-800/40 border border-neutral-200/40 dark:border-stone-700/40 text-left">
                    {roamWiki.publishTime && (
                      <div className="text-[11px] text-neutral-500 dark:text-stone-400">
                        发行：{roamWiki.publishTime}
                      </div>
                    )}
                    {roamWiki.language && (
                      <div className="text-[11px] text-neutral-500 dark:text-stone-400 mt-0.5">
                        语种：{roamWiki.language}
                      </div>
                    )}
                    {roamWiki.bpm && (
                      <div className="text-[11px] text-neutral-500 dark:text-stone-400 mt-0.5">
                        BPM：{roamWiki.bpm}
                      </div>
                    )}
                    {roamWiki.genres && roamWiki.genres.length > 0 && (
                      <div className="text-[11px] text-neutral-500 dark:text-stone-400 mt-0.5">
                        曲风：{roamWiki.genres.join(' / ')}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
