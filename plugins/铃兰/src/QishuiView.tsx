// 汽水音乐主视图（游客态第一版，仿 NeteaseView 范式）
//
// 能力：搜索 / 推荐歌单 / 榜单 / 歌单详情 / 播放（加密流解密）/ 歌词。
// 登录态（扫码，对齐 ddkwork/music-lib）后续 Phase 补，本版不进入登录分支。
//
// 与网易云同构：onPlay 回传 PlayableTrack[]（id 带 qishui- 前缀），
// 解密在拿到 song/url 后于 doPlay 内完成，再喂音乐播放器。

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Loader2, AlertCircle, Music2, Play, ListMusic, Compass } from 'lucide-react';
import {
  qishuiSearch,
  qishuiGetRecommendPlaylists,
  qishuiGetTopLists,
  qishuiGetPlaylistTracks,
  qishuiGetLyric,
  qishuiGetSongUrl,
  QishuiTrack,
  QishuiPlaylistCard,
} from './qishuiApi';
import { decryptQishuiAudio } from './qishuiDecrypt';
import type { PlayableTrack } from './types';
import {
  PlaylistDetailHeader,
  PlaylistGridRow,
  SearchBar,
  SectionTitle,
} from './_shared/OnlineMusicTemplates';

const ACCENT = '#00c2c7'; // 汽水青蓝，对齐品牌色

type QishuiTab = 'recommend' | 'top' | 'search' | 'playlist';

interface QishuiViewProps {
  initialTab: QishuiTab;
  onBack: () => void;
  onPlay: (tracks: PlayableTrack[], startIndex: number, sourceName: string) => void;
  onTempPlaylist?: (temp: {
    id: string;
    name: string;
    tracks: PlayableTrack[];
    payload: { kind: 'playlist' | 'search' | 'recommend'; id?: string; name?: string; keyword?: string; tracks: PlayableTrack[] };
  }) => void;
  onActivePlaylist?: (id: string) => void;
}

export interface QishuiViewHandle {
  openPlaylist: (id: string, name: string) => void;
  restoreTemp: (payload: any) => void;
}

function trackToPlayable(t: QishuiTrack, url: string, quality = ''): PlayableTrack {
  return {
    id: `qishui-${t.id}`,
    filePath: url,
    title: t.name,
    artist: t.artist,
    album: t.album,
    durationSecs: Math.round(t.duration || 0),
    coverPath: t.cover,
    quality,
  };
}

function formatDuration(sec: number): string {
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export const QishuiView = React.forwardRef<QishuiViewHandle, QishuiViewProps>(function QishuiView(
  { initialTab, onBack, onPlay, onTempPlaylist, onActivePlaylist },
  ref,
) {
  const [tab, setTab] = useState<QishuiTab>(initialTab);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [keyword, setKeyword] = useState('');
  const [tracks, setTracks] = useState<QishuiTrack[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const reqRef = useRef(0);

  const [recommend, setRecommend] = useState<QishuiPlaylistCard[]>([]);
  const [tops, setTops] = useState<QishuiPlaylistCard[]>([]);
  const [activePlaylist, setActivePlaylist] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => { setTab(initialTab); }, [initialTab]);

  // 首次进入：并行拉推荐 + 榜单
  const loadHome = useCallback(async () => {
    const req = ++reqRef.current;
    setLoading(true);
    setError('');
    try {
      const [rec, top] = await Promise.all([
        qishuiGetRecommendPlaylists(18).catch(() => []),
        qishuiGetTopLists().catch(() => []),
      ]);
      if (req !== reqRef.current) return;
      setRecommend(rec);
      setTops(top);
    } catch (e: any) {
      if (req === reqRef.current) setError(String(e?.message || e));
    } finally {
      if (req === reqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'recommend' && recommend.length === 0 && !loading) void loadHome();
  }, [tab, recommend.length, loading, loadHome]);

  const doSearch = useCallback(async () => {
    if (!keyword.trim()) return;
    const req = ++reqRef.current;
    setLoading(true);
    setError('');
    setTab('search');
    try {
      const list = await qishuiSearch(keyword.trim(), 1, 1, 40);
      if (req !== reqRef.current) return;
      setTracks(list);
      if (list.length === 0) setError('没有找到相关歌曲');
    } catch (e: any) {
      if (req === reqRef.current) setError(String(e?.message || e));
    } finally {
      if (req === reqRef.current) setLoading(false);
    }
  }, [keyword]);

  const loadPlaylist = useCallback(async (id: string, name: string) => {
    const req = ++reqRef.current;
    setActivePlaylist({ id, name });
    onActivePlaylist?.(id);
    setTab('playlist');
    setLoading(true);
    setError('');
    try {
      const list = await qishuiGetPlaylistTracks(id);
      if (req !== reqRef.current) return;
      setTracks(list);
    } catch (e: any) {
      if (req === reqRef.current) setError(String(e?.message || e));
    } finally {
      if (req === reqRef.current) setLoading(false);
    }
  }, [onActivePlaylist]);

  const openPlaylistRef = useRef<(id: string, name: string) => void>(() => {});
  openPlaylistRef.current = loadPlaylist;

  React.useImperativeHandle(ref, () => ({
    openPlaylist: (id: string, name: string) => { void openPlaylistRef.current(id, name); },
    restoreTemp: (payload: any) => {
      if (!payload) return;
      const inner = payload.payload && typeof payload.payload === 'object' ? payload.payload : payload;
      if (inner.kind === 'playlist' && inner.id != null) {
        void openPlaylistRef.current(payload.id, payload.name);
      } else if (inner.kind === 'search') {
        setTab('search');
        setKeyword(payload.keyword || '');
        void doSearch();
      } else {
        setTab('recommend');
      }
    },
  }), [doSearch]);

  // 播放：取加密地址 + 解密 → objectURL → 回传播放器
  const doPlay = useCallback(async (list: QishuiTrack[], startIndex: number) => {
    const track = list[startIndex];
    if (!track) return;
    setPlayingId(track.id);
    try {
      const { url, spadeA } = await qishuiGetSongUrl(track.id, 320000);
      if (!url || !spadeA) {
        setError('该歌曲暂无可播放地址（可能需会员或已下架）');
        setPlayingId(null);
        return;
      }
      const resp = await fetch(url);
      const buf = await resp.arrayBuffer();
      const objectUrl = await decryptQishuiAudio(buf, spadeA);
      const playable = trackToPlayable({ ...track, url: objectUrl }, objectUrl, track.br ? `${Math.round(track.br / 1000)}k` : '');
      const playables = list.map((tr, i) =>
        i === startIndex ? playable : trackToPlayable(tr, '', '')
      );
      onPlay(playables, startIndex, '汽水音乐');
    } catch (e: any) {
      console.error('[qishui] play failed', e);
      setError(`播放失败：${e?.message || e}`);
      setPlayingId(null);
    }
  }, [onPlay]);

  const playAll = useCallback(() => {
    if (tracks.length === 0) return;
    void doPlay(tracks, 0);
  }, [tracks, doPlay]);

  const renderTrackRow = (tr: QishuiTrack, idx: number) => (
    <div
      key={tr.id + idx}
      className="group flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer text-sm"
      onDoubleClick={() => void doPlay(tracks, idx)}
    >
      <div className="w-6 text-center text-neutral-400 dark:text-stone-500 shrink-0">
        {playingId === tr.id ? <Play size={14} className="text-[var(--element-color-raw)]" /> : idx + 1}
      </div>
      <div
        className="relative w-10 h-10 rounded-md overflow-hidden bg-neutral-200/60 dark:bg-stone-800/60 shrink-0"
        style={{ backgroundImage: tr.cover ? `url(${tr.cover})` : undefined, backgroundSize: 'cover' }}
      >
        {!tr.cover && <div className="w-full h-full flex items-center justify-center text-neutral-400"><Music2 size={16} /></div>}
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-neutral-800 dark:text-stone-100 truncate">{tr.name}</div>
        <div className="text-xs text-neutral-500 dark:text-stone-400 truncate">{tr.artist}</div>
      </div>
      <div className="hidden sm:block text-xs text-neutral-500 dark:text-stone-400 truncate max-w-[160px]">{tr.album}</div>
      <div className="text-xs text-neutral-400 dark:text-stone-500 shrink-0 w-10 text-right">{formatDuration(tr.duration)}</div>
    </div>
  );

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-200/70 dark:border-stone-700/60">
        <button className="btn-press text-neutral-500 dark:text-stone-400 hover:text-neutral-800 dark:hover:text-stone-100" onClick={onBack} title="返回">‹</button>
        <div className="flex items-center gap-1">
          <button className={`btn-press px-3 py-1.5 rounded-lg text-sm transition-colors ${tab === 'recommend' ? 'bg-neutral-200/70 dark:bg-stone-700 text-neutral-800 dark:text-stone-100' : 'text-neutral-500 dark:text-stone-400 hover:text-neutral-800 dark:hover:text-stone-100'}`} onClick={() => setTab('recommend')}>
            <Compass size={14} /> 推荐
          </button>
          <button className={`btn-press px-3 py-1.5 rounded-lg text-sm transition-colors ${tab === 'top' ? 'bg-neutral-200/70 dark:bg-stone-700 text-neutral-800 dark:text-stone-100' : 'text-neutral-500 dark:text-stone-400 hover:text-neutral-800 dark:hover:text-stone-100'}`} onClick={() => setTab('top')}>
            <ListMusic size={14} /> 榜单
          </button>
          <button className={`btn-press px-3 py-1.5 rounded-lg text-sm transition-colors ${tab === 'search' ? 'bg-neutral-200/70 dark:bg-stone-700 text-neutral-800 dark:text-stone-100' : 'text-neutral-500 dark:text-stone-400 hover:text-neutral-800 dark:hover:text-stone-100'}`} onClick={() => setTab('search')}>
            <Search size={14} /> 搜索
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 px-4 pb-6">
        {error && (
          <div className="flex items-center gap-2 my-3 px-3 py-2 rounded-xl bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
            <AlertCircle size={14} /> {error}
          </div>
        )}
        {loading && (
          <div className="flex items-center justify-center gap-2 py-8 text-neutral-400 dark:text-stone-500 text-sm">
            <Loader2 size={16} className="spin" /> 加载中…
          </div>
        )}

        {!loading && tab === 'recommend' && (
          <div className="space-y-5">
            <section>
              <SectionTitle title="推荐歌单" accent={ACCENT} />
              <PlaylistGridRow
                items={recommend.map((p) => ({ id: p.id, name: p.name, coverUrl: p.coverImgUrl, subtitle: `${p.trackCount} 首` }))}
                onOpen={(id, name) => void loadPlaylist(String(id), name)}
                accent={ACCENT}
                emptyText="暂无推荐"
              />
            </section>
            <section>
              <SectionTitle title="热门榜单" accent={ACCENT} />
              <PlaylistGridRow
                items={tops.map((p) => ({ id: p.id, name: p.name, coverUrl: p.coverImgUrl, subtitle: `${p.trackCount} 首` }))}
                onOpen={(id, name) => void loadPlaylist(String(id), name)}
                accent={ACCENT}
                emptyText="暂无榜单"
              />
            </section>
          </div>
        )}

        {!loading && tab === 'top' && (
          <div className="space-y-1">
            <SectionTitle title="热门榜单" accent={ACCENT} />
            {tops.map((p, i) => (
              <button key={p.id} onClick={() => void loadPlaylist(p.id, p.name)} className="btn-press w-full flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 text-left">
                <span className="w-6 text-center text-sm font-semibold text-neutral-400 dark:text-stone-500">{i + 1}</span>
                <div className="relative w-12 h-12 rounded-lg overflow-hidden bg-neutral-200/60 dark:bg-stone-800/60 shrink-0">
                  {p.coverImgUrl ? (
                    <img src={p.coverImgUrl} alt={p.name} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-neutral-400"><Music2 size={16} /></div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-neutral-800 dark:text-stone-100 truncate">{p.name}</div>
                  <div className="text-xs text-neutral-500 dark:text-stone-400">{p.trackCount} 首</div>
                </div>
              </button>
            ))}
          </div>
        )}

        {!loading && tab === 'search' && (
          <div className="space-y-2">
            <SearchBar value={keyword} onChange={(v) => setKeyword(v)} placeholder="搜索歌曲 / 歌手" />
            {tracks.length > 0 && (
              <>
                <div className="flex items-center justify-between px-1 py-2">
                  <span className="text-xs text-neutral-500 dark:text-stone-400">共 {tracks.length} 首</span>
                  <button onClick={playAll} className="btn-press flex items-center gap-1.5 px-4 py-1.5 rounded-full text-white text-sm font-medium" style={{ background: ACCENT }}>
                    <Play size={14} /> 播放全部
                  </button>
                </div>
                <div className="space-y-0.5">{tracks.map(renderTrackRow)}</div>
              </>
            )}
          </div>
        )}

        {!loading && tab === 'playlist' && activePlaylist && (
          <div className="space-y-4">
            <PlaylistDetailHeader
              coverUrl={undefined}
              name={activePlaylist.name}
              brandLabel="汽水音乐"
              trackCount={tracks.length}
              accent={ACCENT}
              onPlayAll={playAll}
            />
            <div className="space-y-0.5">{tracks.map(renderTrackRow)}</div>
          </div>
        )}
      </div>
    </div>
  );
});
