/// <reference path="../global.d.ts" />
import React from 'react';
import {
  CloudIcon, MusicIcon, PlayIcon, SearchIcon,
} from '../../_shared/icons';
import { T } from '../../_shared/pluginRuntime';
import {
  searchSongs, getListenNow, getTopList, getSongUrl, isLoggedIn, logoutNetease,
  neteaseQrKey, neteaseQrCreate, neteaseQrCheck,
  getUserAccount, getUserPlaylists, neteaseTrackBadges, qualityLabelFromBr,
  type NeteaseTrack, type NeteaseProfile, type NeteasePlaylistItem,
} from './neteaseApi';

const { useState, useEffect, useRef, useCallback } = React;

export type NeteaseTab = 'listen' | 'library' | 'radio' | 'search' | 'login';

const TAB_TITLE_KEYS: Record<NeteaseTab, string> = {
  listen: 'music.moduleDrawer.netease.listenNow',
  library: 'music.moduleDrawer.netease.library',
  radio: 'music.moduleDrawer.netease.radio',
  search: 'music.moduleDrawer.netease.search',
  login: 'music.moduleDrawer.netease.login',
};

export interface PlayableTrack {
  id: string;
  filePath: string;
  title: string;
  artist: string;
  album: string;
  durationSecs: number;
  coverPath?: string;
  quality?: string; // 实际播放音质标签（Hi-Res/无损/高品质/标准），异步取地址后填充
}

interface NeteaseViewProps {
  initialTab: NeteaseTab;
  onBack: () => void;
  onPlay: (tracks: PlayableTrack[], startIndex: number) => void;
}

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

export function NeteaseView({ initialTab, onBack, onPlay }: NeteaseViewProps) {
  const [tab, setTab] = useState<NeteaseTab>(initialTab);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [tracks, setTracks] = useState<NeteaseTrack[]>([]);
  const [keyword, setKeyword] = useState('');
  const [playingId, setPlayingId] = useState<number | null>(null);
  const reqRef = useRef(0);
  // 无限下拉分页状态：offset/total 跟踪已加载与总量，hasMore 判断是否还能继续拉
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const PAGE = 30; // 每页拉取条数
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const loadingMoreRef = useRef(false);

  // 登录态
  const [loggedIn, setLoggedIn] = useState(isLoggedIn());
  const [profile, setProfile] = useState<NeteaseProfile | null>(null);
  const [playlists, setPlaylists] = useState<NeteasePlaylistItem[]>([]);
  const [qrImg, setQrImg] = useState('');
  const [qrStatus, setQrStatus] = useState(''); // 文案提示
  const [qrLoading, setQrLoading] = useState(false);
  const pollRef = useRef<number | null>(null);

  useEffect(() => { setTab(initialTab); }, [initialTab]);

  // 离开 login tab 或卸载时停止轮询
  useEffect(() => {
    return () => {
      if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, []);

  const startQrLogin = useCallback(async () => {
    setQrLoading(true);
    setQrImg('');
    setQrStatus('正在生成二维码…');
    try {
      const key = await neteaseQrKey();
      const session = await neteaseQrCreate(key);
      setQrImg(session.qrimg || '');
      setQrStatus('请用手机网易云 App 扫码登录');
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        try {
          const code = await neteaseQrCheck(key);
          if (code === 800) {
            if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
            setQrStatus('二维码已过期，请重新点击登录');
            setQrImg('');
          } else if (code === 802) {
            setQrStatus('已扫描，请在手机上确认登录');
          } else if (code === 803) {
            if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
            setLoggedIn(true);
            setQrImg('');
            setLoggedIn(true);
            setQrStatus('登录成功！');
            // 登录成功后刷新当前列表
            try { setProfile(await getUserAccount()); } catch {}
            const req = ++reqRef.current;
            setLoading(true);
            getListenNow(20)
              .then((list) => { if (req === reqRef.current) { setTracks(list); setLoading(false); } })
              .catch(() => { if (req === reqRef.current) setLoading(false); });
          }
        } catch (e) {
          if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
          setQrStatus('轮询失败：' + String(e?.message || e));
        }
      }, 2000);
    } catch (e) {
      setQrStatus('生成失败：' + String(e?.message || e));
    } finally {
      setQrLoading(false);
    }
  }, []);

  const handleLogout = useCallback(() => {
    logoutNetease();
    setLoggedIn(false);
    setQrImg('');
    setQrStatus('');
    if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  // 「现在就听」自动拉取（推荐一次性返回，不做分页）
  useEffect(() => {
    if (tab !== 'listen') return;
    setPlaylistId(null); // 离开歌单分页模式
    const req = ++reqRef.current;
    setLoading(true);
    setError('');
    setOffset(0);
    getListenNow(50)
      .then((list) => {
        if (req === reqRef.current) {
          setTracks(list);
          setTotal(list.length);
          setHasMore(false);
          setLoading(false);
        }
      })
      .catch((e) => { if (req === reqRef.current) { setError(String(e?.message || e)); setLoading(false); } });
  }, [tab]);

  // 搜索（防抖）：每次关键词变化时重置分页，从头加载
  useEffect(() => {
    if (tab !== 'search') return;
    setPlaylistId(null); // 离开歌单分页模式
    const kw = keyword.trim();
    if (!kw) { setTracks([]); setLoading(false); setHasMore(false); return; }
    const req = ++reqRef.current;
    setLoading(true);
    setError('');
    setOffset(0);
    const timer = setTimeout(() => {
      searchSongs(kw, PAGE, 0)
        .then((res) => {
          if (req !== reqRef.current) return;
          setTracks(res.tracks);
          setTotal(res.total);
          setOffset(res.tracks.length);
          setHasMore(res.tracks.length < res.total);
          setLoading(false);
        })
        .catch((e) => { if (req === reqRef.current) { setError(String(e?.message || e)); setLoading(false); } });
    }, 400);
    return () => clearTimeout(timer);
  }, [tab, keyword]);

  // 加载搜索下一页（无限下拉）：追加结果并更新 offset/hasMore
  const loadMoreSearch = useCallback(async () => {
    const kw = keyword.trim();
    if (!kw || loadingMoreRef.current || !hasMore) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const req = reqRef.current;
    try {
      const res = await searchSongs(kw, PAGE, offset);
      if (req !== reqRef.current) return;
      setTracks((prev) => [...prev, ...res.tracks]);
      setOffset((o) => o + res.tracks.length);
      setHasMore(offset + res.tracks.length < res.total);
    } catch (e) {
      console.warn('[netease] 加载搜索下一页失败', e);
    } finally {
      if (req === reqRef.current) { setLoadingMore(false); loadingMoreRef.current = false; }
    }
  }, [keyword, offset, hasMore]);

  // 「我的歌单」自动拉取（登录态）
  useEffect(() => {
    if (tab !== 'library' || !loggedIn) return;
    const req = ++reqRef.current;
    setLoading(true);
    setError('');
    const uid = profile?.userId || 0;
    getUserPlaylists(uid)
      .then((list) => { if (req === reqRef.current) { setPlaylists(list); setLoading(false); } })
      .catch((e) => { if (req === reqRef.current) { setError(String(e?.message || e)); setLoading(false); } });
  }, [tab, loggedIn, profile?.userId]);

  const [playlistId, setPlaylistId] = useState<number | null>(null);

  const openPlaylist = useCallback(async (id: number) => {
    const req = ++reqRef.current;
    try {
      setPlaylistId(id);
      setLoading(true);
      setError('');
      setOffset(0);
      const res = await getTopList(id, PAGE, 0);
      if (req !== reqRef.current) return;
      setTracks(res.tracks);
      setTotal(res.total);
      setOffset(res.tracks.length);
      setHasMore(res.tracks.length < res.total);
      setLoading(false);
    } catch (e) {
      if (req === reqRef.current) { setError(String((e as any)?.message || e)); setLoading(false); }
    }
  }, []);

  // 加载歌单/榜单下一页（无限下拉）
  const loadMorePlaylist = useCallback(async () => {
    if (playlistId == null || loadingMoreRef.current || !hasMore) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const req = reqRef.current;
    try {
      const res = await getTopList(playlistId, PAGE, offset);
      if (req !== reqRef.current) return;
      setTracks((prev) => [...prev, ...res.tracks]);
      setOffset((o) => o + res.tracks.length);
      setHasMore(offset + res.tracks.length < res.total);
    } catch (e) {
      console.warn('[netease] 加载歌单下一页失败', e);
    } finally {
      if (req === reqRef.current) { setLoadingMore(false); loadingMoreRef.current = false; }
    }
  }, [playlistId, offset, hasMore]);

  // 触底哨兵：用 IntersectionObserver 监听底部元素，滚动到附近时按需加载下一页
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry?.isIntersecting) return;
      if (tab === 'search') loadMoreSearch();
      else if (tab === 'listen' && playlistId != null) loadMorePlaylist();
    }, { root: scrollRef.current, rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [tab, playlistId, loadMoreSearch, loadMorePlaylist]);

  const handlePlayAll = useCallback(async () => {
    const playlist: PlayableTrack[] = [];
    for (const t of tracks) {
      const res = await getSongUrl(t.id);
      if (res.url) playlist.push(trackToPlayable(t, res.url, qualityLabelFromBr(res.br)));
    }
    if (playlist.length) onPlay(playlist, 0);
  }, [tracks, onPlay]);

  const handlePlayTrack = useCallback(async (t: NeteaseTrack) => {
    setPlayingId(t.id);
    const res = await getSongUrl(t.id);
    if (res.url) {
      // 只同步取点击单曲的地址，立即播放，避免整张列表串行取地址导致数秒延迟。
      // 其余曲以空 filePath 占位进入队列，后台异步补全地址（见下方 fire-and-forget）。
      const quality = qualityLabelFromBr(res.br);
      const playable = trackToPlayable(t, res.url, quality);
      const startIndex = tracks.findIndex((x) => x.id === t.id);
      const playlist: PlayableTrack[] = tracks.map((x) => {
        if (x.id === t.id) return playable;
        const p = trackToPlayable(x, '');
        return p;
      });
      onPlay(playlist, startIndex >= 0 ? startIndex : 0);

      // 后台补全其余曲的播放地址（不阻塞播放）；补到当前播放的等待曲时播放器会自动 reload
      const player = (window as unknown as { __MUSIC_PLAYER__?: { updateTrackUrl?: (i: number, u: string) => void } }).__MUSIC_PLAYER__;
      if (player?.updateTrackUrl) {
        for (let i = 0; i < tracks.length; i++) {
          if (i === startIndex) continue;
          const u = await getSongUrl(tracks[i].id).catch(() => null);
          if (u?.url) player.updateTrackUrl(i, u.url);
        }
      }
    }
    setPlayingId(null);
  }, [tracks, onPlay]);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden relative bg-white dark:bg-[#1e1e1e]">
      {/* 顶部栏：左侧当前标题，右侧云按钮（点击从右滑出模块抽屉） */}
      <div className="shrink-0 flex items-center justify-between px-4 pt-4 pb-2">
        <h2 className="text-sm font-semibold text-neutral-800 dark:text-stone-100">{T(TAB_TITLE_KEYS[tab])}</h2>
        <button
          onClick={onBack}
          className="btn-press flex items-center justify-center p-2 rounded-lg text-neutral-500 dark:text-stone-400 hover:bg-neutral-200/60 dark:hover:bg-stone-800/60 transition-colors"
          title={T('music.moduleDrawer.title')}
        >
          <CloudIcon size={18} />
        </button>
      </div>

      {/* 主内容区 */}
      <div ref={scrollRef} className="flex-1 h-full overflow-y-auto px-4 pb-4">
        {tab === 'listen' && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-neutral-800 dark:text-stone-100">{T('music.moduleDrawer.netease.listenNow')}</h2>
              {tracks.length > 0 && (
                <button onClick={handlePlayAll} className="btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/15 text-blue-600 dark:text-blue-400 text-sm hover:bg-blue-500/25 transition-colors">
                  <PlayIcon size={14} />
                  {T('music.track.playAll') || '播放全部'}
                </button>
              )}
            </div>
            {renderBody()}
          </section>
        )}

        {tab === 'search' && (
          <section>
            <h2 className="text-lg font-semibold text-neutral-800 dark:text-stone-100 mb-3">{T('music.moduleDrawer.netease.search')}</h2>
            <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60">
              <SearchIcon size={16} />
              <input
                autoFocus
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder={T('music.moduleDrawer.netease.searchDesc')}
                className="flex-1 bg-transparent outline-none text-sm text-neutral-800 dark:text-stone-100 placeholder:text-neutral-400 dark:placeholder:text-stone-500"
              />
            </div>
            {renderBody()}
          </section>
        )}

        {tab === 'library' && (
          <section>
            <h2 className="text-lg font-semibold text-neutral-800 dark:text-stone-100 mb-3">{T('music.moduleDrawer.netease.library')}</h2>
            {!loggedIn ? (
              <div className="flex flex-col items-center gap-3 py-10 text-sm text-neutral-500 dark:text-stone-400">
                <span>登录后查看「我的歌单」</span>
                <button onClick={() => setTab('login')} className="btn-press px-4 py-2 rounded-xl bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 transition-colors">
                  {T('music.moduleDrawer.netease.login')}
                </button>
              </div>
            ) : playlists.length === 0 && !loading ? (
              <div className="text-sm text-neutral-500 dark:text-stone-400 py-10">暂无歌单</div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {playlists.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => openPlaylist(p.id)}
                    className="btn-press flex flex-col gap-2 p-2 rounded-xl bg-neutral-100/60 dark:bg-stone-800/50 hover:bg-neutral-200/60 dark:hover:bg-stone-700/60 transition-colors text-left"
                  >
                    <img src={p.coverImgUrl} alt={p.name} className="w-full aspect-square object-cover rounded-lg bg-neutral-200 dark:bg-stone-700" />
                    <div className="text-xs text-neutral-700 dark:text-stone-200 line-clamp-2 h-8 overflow-hidden">{p.name}</div>
                    <div className="text-[10px] text-neutral-400 dark:text-stone-500">{p.trackCount} 首 · {p.creator}</div>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
        {tab === 'radio' && <PlaceholderTab title={T('music.moduleDrawer.netease.radio')} desc={T('music.moduleDrawer.netease.radioDesc')} />}
        {tab === 'login' && (
          <section className="flex flex-col items-center justify-center py-10 gap-4">
            <h2 className="text-lg font-semibold text-neutral-800 dark:text-stone-100">{T('music.moduleDrawer.netease.login')}</h2>
            {loggedIn ? (
              <div className="flex flex-col items-center gap-3">
                <div className="px-3 py-1.5 rounded-lg bg-green-500/15 text-green-600 dark:text-green-400 text-sm">已登录网易云</div>
                <button onClick={handleLogout} className="btn-press px-4 py-2 rounded-lg bg-neutral-200/60 dark:bg-stone-800/60 text-sm text-neutral-700 dark:text-stone-200 hover:bg-neutral-300/60 dark:hover:bg-stone-700/60 transition-colors">
                  退出登录
                </button>
              </div>
            ) : qrImg ? (
              <div className="flex flex-col items-center gap-3">
                <img src={qrImg} alt="登录二维码" className="w-48 h-48 rounded-lg bg-white p-2" />
                <div className="text-sm text-neutral-500 dark:text-stone-400 text-center max-w-xs">{qrStatus}</div>
                <button onClick={startQrLogin} className="btn-press px-4 py-1.5 rounded-lg bg-neutral-200/60 dark:bg-stone-800/60 text-sm text-neutral-700 dark:text-stone-200 hover:bg-neutral-300/60 dark:hover:bg-stone-700/60 transition-colors">
                  刷新二维码
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <button
                  onClick={startQrLogin}
                  disabled={qrLoading}
                  className="btn-press px-5 py-2.5 rounded-xl bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 transition-colors disabled:opacity-50"
                >
                  {qrLoading ? '生成中…' : '登录网易云（扫码）'}
                </button>
                <div className="text-sm text-neutral-500 dark:text-stone-400 text-center max-w-xs">
                  {qrStatus || '使用手机网易云 App 扫码登录，登录后可正常使用推荐 / 歌单 / 搜索'}
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );

  function renderBody() {
    if (loading) {
      return <div className="text-sm text-neutral-400 dark:text-stone-500 py-8 text-center">{T('music.loading') || '加载中…'}</div>;
    }
    if (error) {
      return <div className="text-sm text-red-500/80 dark:text-red-400/80 py-8 text-center">{error}</div>;
    }
    if (!tracks.length) {
      if (tab === 'search') return <div className="text-sm text-neutral-400 dark:text-stone-500 py-8 text-center">输入关键词以搜索歌曲</div>;
      return <div className="text-sm text-neutral-400 dark:text-stone-500 py-8 text-center">暂无内容</div>;
    }
    return (
      <div className="flex flex-col gap-1">
        {tracks.map((t) => (
          <button
            key={t.id}
            onClick={() => handlePlayTrack(t)}
            className="btn-press group flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-neutral-200/50 dark:hover:bg-stone-800/50 transition-colors text-left"
          >
            {t.cover ? (
              <img src={t.cover} alt="" className="w-10 h-10 rounded-md object-cover shrink-0" />
            ) : (
              <span className="w-10 h-10 rounded-md bg-neutral-200/60 dark:bg-stone-800/60 flex items-center justify-center shrink-0 text-neutral-400 dark:text-stone-500">
                <MusicIcon size={16} />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="block text-sm text-neutral-800 dark:text-stone-100 truncate">{t.name}</span>
                {neteaseTrackBadges(t).map((b) => (
                  <span
                    key={b.label}
                    className={
                      'shrink-0 text-[9px] font-semibold leading-none px-1 py-0.5 rounded ' +
                      (b.kind === 'vip'
                        ? 'text-amber-600 dark:text-amber-400 bg-amber-500/15'
                        : b.kind === 'hires'
                          ? 'text-fuchsia-600 dark:text-fuchsia-400 bg-fuchsia-500/15'
                          : 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/15')
                    }
                    title={b.label}
                  >
                    {b.label}
                  </span>
                ))}
              </span>
              <span className="block text-xs text-neutral-400 dark:text-stone-500 truncate">{t.artist} · {t.album}</span>
            </span>
            <span className="text-xs text-neutral-400 dark:text-stone-500 shrink-0">{formatDuration(t.duration)}</span>
            {playingId === t.id && <PlayIcon size={14} />}
          </button>
        ))}
        {/* 无限下拉：仅在支持分页的 tab（搜索 / 歌单）显示加载状态与触底哨兵 */}
        {(tab === 'search' || (tab === 'listen' && playlistId != null)) && (
          <div ref={sentinelRef} className="py-3 text-center text-xs text-neutral-400 dark:text-stone-500">
            {loadingMore ? '加载中…' : hasMore ? '下拉加载更多' : (tracks.length ? '已经到底啦' : '')}
          </div>
        )}
      </div>
    );
  }
}

function PlaceholderTab({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center py-16">
      <div className="w-14 h-14 rounded-2xl bg-neutral-200/60 dark:bg-stone-800/60 flex items-center justify-center text-neutral-400 dark:text-stone-500 mb-3">
        <MusicIcon size={24} />
      </div>
      <div className="text-base font-medium text-neutral-700 dark:text-stone-200">{title}</div>
      <div className="text-sm text-neutral-400 dark:text-stone-500 mt-1 max-w-xs">{desc}（敬请期待）</div>
    </div>
  );
}
