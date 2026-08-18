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
      if (payload.kind === 'playlist' && payload.id != null) {
        void openPlaylistRef.current(payload.id, payload.name);
      } else if (payload.kind === 'search') {
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
      className="music-online-row"
      onDoubleClick={() => void doPlay(tracks, idx)}
    >
      <div className="music-online-row-index">{playingId === tr.id ? <Play size={14} /> : idx + 1}</div>
      <div className="music-online-row-cover" style={{ backgroundImage: tr.cover ? `url(${tr.cover})` : undefined }}>
        {!tr.cover && <Music2 size={16} />}
      </div>
      <div className="music-online-row-main">
        <div className="music-online-row-title">{tr.name}</div>
        <div className="music-online-row-artist">{tr.artist}</div>
      </div>
      <div className="music-online-row-album">{tr.album}</div>
      <div className="music-online-row-dur">{formatDuration(tr.duration)}</div>
    </div>
  );

  return (
    <div className="music-online-view">
      <div className="music-online-topbar">
        <button className="music-online-back" onClick={onBack}>‹</button>
        <div className="music-online-tabs">
          <button className={tab === 'recommend' ? 'active' : ''} onClick={() => setTab('recommend')}>
            <Compass size={14} /> 推荐
          </button>
          <button className={tab === 'top' ? 'active' : ''} onClick={() => setTab('top')}>
            <ListMusic size={14} /> 榜单
          </button>
          <button className={tab === 'search' ? 'active' : ''} onClick={() => setTab('search')}>
            <Search size={14} /> 搜索
          </button>
        </div>
        {tab === 'search' && (
          <div className="music-online-search">
            <input
              value={keyword}
              placeholder="搜索歌曲 / 歌手"
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void doSearch(); }}
            />
            <button onClick={() => void doSearch()}><Search size={14} /></button>
          </div>
        )}
      </div>

      <div className="music-online-body">
        {error && <div className="music-online-error"><AlertCircle size={14} /> {error}</div>}
        {loading && <div className="music-online-loading"><Loader2 size={16} className="spin" /> 加载中…</div>}

        {!loading && tab === 'recommend' && (
          <div className="music-online-grid-wrap">
            <div className="music-online-section-title">推荐歌单</div>
            <div className="music-online-grid">
              {recommend.map((p) => (
                <div key={p.id} className="music-online-card" onClick={() => void loadPlaylist(p.id, p.name)}>
                  <div className="music-online-card-cover" style={{ backgroundImage: p.coverImgUrl ? `url(${p.coverImgUrl})` : undefined }}>
                    {!p.coverImgUrl && <Music2 size={22} />}
                    <span className="music-online-card-count">{p.trackCount} 首</span>
                  </div>
                  <div className="music-online-card-name">{p.name}</div>
                </div>
              ))}
            </div>
            <div className="music-online-section-title">热门榜单</div>
            <div className="music-online-grid">
              {tops.map((p) => (
                <div key={p.id} className="music-online-card" onClick={() => void loadPlaylist(p.id, p.name)}>
                  <div className="music-online-card-cover" style={{ backgroundImage: p.coverImgUrl ? `url(${p.coverImgUrl})` : undefined }}>
                    {!p.coverImgUrl && <Music2 size={22} />}
                    <span className="music-online-card-count">{p.trackCount} 首</span>
                  </div>
                  <div className="music-online-card-name">{p.name}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {!loading && tab === 'top' && (
          <div className="music-online-list">
            {tops.map((p, i) => (
              <div key={p.id} className="music-online-rank-row" onClick={() => void loadPlaylist(p.id, p.name)}>
                <span className="music-online-rank-no">{i + 1}</span>
                <div className="music-online-card-cover sm" style={{ backgroundImage: p.coverImgUrl ? `url(${p.coverImgUrl})` : undefined }} />
                <div className="music-online-row-main"><div className="music-online-row-title">{p.name}</div><div className="music-online-row-artist">{p.trackCount} 首</div></div>
              </div>
            ))}
          </div>
        )}

        {!loading && tab === 'search' && tracks.length > 0 && (
          <>
            <div className="music-online-playall" onClick={playAll}><Play size={14} /> 播放全部</div>
            <div className="music-online-rows">{tracks.map(renderTrackRow)}</div>
          </>
        )}

        {!loading && tab === 'playlist' && activePlaylist && (
          <>
            <div className="music-online-playlist-head">
              <div className="music-online-card-cover" style={{ backgroundImage: undefined }}>
                <Music2 size={24} />
              </div>
              <div>
                <div className="music-online-row-title">{activePlaylist.name}</div>
                <div className="music-online-row-artist">{tracks.length} 首</div>
              </div>
              <button className="music-online-playall" onClick={playAll}><Play size={14} /> 播放全部</button>
            </div>
            <div className="music-online-rows">{tracks.map(renderTrackRow)}</div>
          </>
        )}
      </div>
    </div>
  );
});
