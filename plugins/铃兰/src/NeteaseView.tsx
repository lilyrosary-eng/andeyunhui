/// <reference path="../global.d.ts" />
import React from 'react';
import {
  CloudIcon, HeartIcon, MusicIcon, PlayIcon, SearchIcon,
} from '../../_shared/icons';
import { T } from '../../_shared/pluginRuntime';
import {
  searchSongs, getListenNow, getTopList, getSongUrl, isLoggedIn, logoutNetease,
  neteaseQrKey, neteaseQrCreate, neteaseQrCheck,
  getUserAccount, getUserPlaylists, neteaseTrackBadges, qualityLabelFromBr, likeNeteaseSong,
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
  // 在线播放时把当前来源歌单作为「临时歌单」回传给侧栏，挂到「我的收藏」下方
  onTempPlaylist?: (temp: TempPlaylist) => void;
  // 登录成功后把用户全部歌单回传（侧栏「用户自己的收藏歌单」铺开）
  onUserPlaylists?: (items: NeteasePlaylistItem[]) => void;
  // 当前正在查看的歌单 id（侧栏高亮）
  onActivePlaylist?: (id: number) => void;
}

// 在线播放生成的临时歌单（挂在侧栏「我的收藏」之下）
export interface TempPlaylist {
  id: string;
  name: string;
  coverPath?: string;
  tracks: PlayableTrack[];
  // 来源描述，供侧栏点击「临时N」时恢复对应视图
  payload: {
    kind: 'playlist' | 'search' | 'recommend';
    id?: number;
    name?: string;
    keyword?: string;
    tracks: PlayableTrack[];
  };
}

// 暴露给父组件（侧栏）调用的命令式方法
export interface NeteaseViewHandle {
  openPlaylist: (id: number, name: string) => void;
  restoreTemp: (payload: any) => void;
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

export const NeteaseView = React.forwardRef<NeteaseViewHandle, NeteaseViewProps>(function NeteaseView(
  { initialTab, onBack, onPlay, onTempPlaylist, onUserPlaylists, onActivePlaylist },
  ref,
) {
  const [tab, setTab] = useState<NeteaseTab>(initialTab);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [tracks, setTracks] = useState<NeteaseTrack[]>([]);
  const [keyword, setKeyword] = useState('');
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [likedSongs, setLikedSongs] = useState<Set<number>>(new Set()); // 已写入网易云「我喜欢的音乐」的歌曲
  const reqRef = useRef(0);
  // 无限下拉分页状态：offset/total 跟踪已加载与总量，hasMore 判断是否还能继续拉
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [reachedLimit, setReachedLimit] = useState(false); // 已达本地预览上限
  const PAGE = 30; // 每页拉取条数
  // 「现在就听」精选歌单（模块化网格）：并行拉取几个官方榜单的封面与曲目数
  const [featured, setFeatured] = useState<{ id: number; name: string; cover: string; trackCount: number }[]>([]);
  // 本地预览上限：避免一次性下拉拉取成千上万首导致 DOM 爆炸、主线程卡死、
  // 顶部云按钮（tab 切换）失去响应。到达上限后停止续拉并提示。
  const MAX_ITEMS = 300;
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const loadingMoreRef = useRef(false);

  // 登录态
  const [loggedIn, setLoggedIn] = useState(isLoggedIn());
  const [profile, setProfile] = useState<NeteaseProfile | null>(null);
  const [playlists, setPlaylists] = useState<NeteasePlaylistItem[]>([]);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [qrImg, setQrImg] = useState('');
  const [qrStatus, setQrStatus] = useState(''); // 文案提示
  const [qrLoading, setQrLoading] = useState(false);
  const pollRef = useRef<number | null>(null);

  useEffect(() => { setTab(initialTab); }, [initialTab]);

  // 最新 openPlaylist 镜像，供 useImperativeHandle 在空依赖下安全调用（避免 render 期 TDZ）
  const openPlaylistRef = useRef<(id: number, name?: string) => void>(() => {});
  // 暴露命令式方法给父组件（侧栏）调用
  React.useImperativeHandle(ref, () => ({
    openPlaylist: (id: number, name: string) => { void openPlaylistRef.current(id, name); },
    restoreTemp: (payload: any) => {
      if (!payload) return;
      const kind: string = payload.kind;
      if (kind === 'playlist' && payload.id != null) {
        void openPlaylistRef.current(payload.id, payload.name);
      } else if (kind === 'search') {
        setTab('search');
        setKeyword(payload.keyword || '');
      } else {
        setTab('library');
      }
    },
  }), []);

  // 离开 login tab 或卸载时停止轮询
  useEffect(() => {
    return () => {
      if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, []);

  // 组件挂载时：若本地已有登录 cookie，验证并拉取用户资料/歌单，避免"已登录但显示未登录"
  const fetchProfile = useCallback(async (silent = false, allowLogout = true) => {
    if (!isLoggedIn()) return;
    if (!silent) setProfileLoading(true);
    setProfileError('');
    try {
      // 加 10 秒超时，避免服务端无响应时一直卡"正在获取"
      const p = await Promise.race([
        getUserAccount(),
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('请求超时（10s）')), 10000)),
      ]);
      if (p) {
        setProfile(p);
        try {
          const list = await getUserPlaylists(p.userId);
          setPlaylists(list);
          // 上抛用户全部歌单给侧栏（铺开为「用户自己的收藏歌单」），并解析「我喜欢的音乐」
          onUserPlaylists?.(list);
        } catch (e) {
          console.warn('[netease] 获取用户歌单失败', e);
          setPlaylists([]);
        }
        setLoggedIn(true);
      } else {
        // 服务端返回空 profile：cookie 可能已过期或权限不足
        if (allowLogout) {
          logoutNetease();
          setLoggedIn(false);
          setProfile(null);
          setPlaylists([]);
        }
        setProfileError('登录已过期，请重新登录');
      }
    } catch (e) {
      console.warn('[netease] 获取用户信息失败', e);
      // 仅获取失败时不自动退出，保留"已登录"态并显示错误与重试按钮；
      // 用户可点"重新获取"或"退出登录"，避免 cookie 其实有效只是网络抖动时被清掉。
      setProfileError('获取用户信息失败：' + (e?.message || String(e)));
    } finally {
      setProfileLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isLoggedIn()) return;
    fetchProfile(true);
  }, [fetchProfile]);

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
          const { code, cookieSaved } = await neteaseQrCheck(key);
          if (code === 800) {
            if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
            setQrStatus('二维码已过期，请重新点击登录');
            setQrImg('');
          } else if (code === 802) {
            setQrStatus('已扫描，请在手机上确认登录');
          } else if (code === 803) {
            if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
            setQrImg('');
            if (!cookieSaved) {
              setQrStatus('登录成功，但未能读取登录凭据，请退出后重新扫码');
              return;
            }
            setLoggedIn(true);
            setQrStatus('登录成功！正在获取资料…');
            // 登录成功后立即拉取用户资料和歌单；登录态已确定，获取失败也不应直接退出
            fetchProfile(false, false);
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

  // 「现在就听」自动拉取：不再直接加载单曲推荐流，改为精选歌单网格；推荐流移到「猜你喜欢」tab
  useEffect(() => {
    if (tab !== 'listen') return;
    if (playlistId != null) return; // 正在查看某歌单详情，不要重置回网格
    setPlaylistId(null); // 离开歌单分页模式
    sourceNameRef.current = T('music.moduleDrawer.netease.listenNow');
    const req = ++reqRef.current;
    setLoading(false);
    setError('');
    setOffset(0);
    setTracks([]);
    setTotal(0);
    setHasMore(false);
    // 并行拉取「精选歌单」网格（官方榜单封面 + 曲目数），模块化呈现、和网易云首页对齐
    const FEATURED: { id: number; name: string }[] = [
      { id: 19723756, name: '飙升榜' },
      { id: 3779629, name: '新歌榜' },
      { id: 3778678, name: '热歌榜' },
      { id: 2884035, name: '原创榜' },
    ];
    Promise.all(FEATURED.map(async (f) => {
      try {
        const r = await getTopList(f.id, 1, 0);
        const cover = r.tracks[0]?.cover || '';
        return { ...f, cover, trackCount: r.total };
      } catch {
        return { ...f, cover: '', trackCount: 0 };
      }
    })).then((arr) => { if (req === reqRef.current) setFeatured(arr); });
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
          setReachedLimit(res.tracks.length >= MAX_ITEMS);
          setHasMore(res.tracks.length < res.total && res.tracks.length < MAX_ITEMS);
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
      const next = offset + res.tracks.length;
      setOffset(next);
      const limit = next >= MAX_ITEMS;
      setReachedLimit(limit);
      setHasMore(!limit && next < res.total);
    } catch (e) {
      console.warn('[netease] 加载搜索下一页失败', e);
    } finally {
      if (req === reqRef.current) { setLoadingMore(false); loadingMoreRef.current = false; }
    }
  }, [keyword, offset, hasMore]);

  // 「猜你喜欢」自动拉取：把原「现在就听」下方的推荐单曲流移到这里
  useEffect(() => {
    if (tab !== 'library') return;
    setPlaylistId(null); // 离开歌单分页模式
    sourceNameRef.current = '猜你喜欢';
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

  const [playlistId, setPlaylistId] = useState<number | null>(null);
  // 当前面板来源名（用于临时歌单命名）：歌单/榜单进入时记录，tab 切换时更新
  const sourceNameRef = useRef<string>('');

  const openPlaylist = useCallback(async (id: number, name?: string) => {
    const req = ++reqRef.current;
    try {
      setPlaylistId(id);
      if (name) sourceNameRef.current = name;
      onActivePlaylist?.(id);
      setLoading(true);
      setError('');
      setOffset(0);
      const res = await getTopList(id, PAGE, 0);
      if (req !== reqRef.current) return;
      setTracks(res.tracks);
      setTotal(res.total);
      setOffset(res.tracks.length);
      setReachedLimit(res.tracks.length >= MAX_ITEMS);
      setHasMore(res.tracks.length < res.total && res.tracks.length < MAX_ITEMS);
      setLoading(false);
    } catch (e) {
      if (req === reqRef.current) { setError(String((e as any)?.message || e)); setLoading(false); }
    }
  }, [onActivePlaylist]);
  // 保持命令式句柄始终调用最新 openPlaylist（useImperativeHandle 依赖为 []，避免 TDZ）
  openPlaylistRef.current = openPlaylist;

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
      const next = offset + res.tracks.length;
      setOffset(next);
      const limit = next >= MAX_ITEMS;
      setReachedLimit(limit);
      setHasMore(!limit && next < res.total);
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

  const buildTempName = useCallback((): string => {
    const src = sourceNameRef.current;
    if (src) return src;
    if (tab === 'search') return `搜索：${keyword.trim()}`;
    return T('music.moduleDrawer.netease.listenNow');
  }, [tab, keyword]);

  const handlePlayAll = useCallback(async () => {
    const playlist: PlayableTrack[] = [];
    for (const t of tracks) {
      const res = await getSongUrl(t.id);
      if (res.url) playlist.push(trackToPlayable(t, res.url, qualityLabelFromBr(res.br)));
    }
    if (playlist.length) {
      onPlay(playlist, 0);
      const tempId = playlistId != null ? `playlist-${playlistId}` : tab === 'search' ? `search-${keyword.trim()}` : 'recommend';
      onTempPlaylist?.({
        id: tempId,
        name: buildTempName(),
        coverPath: playlist[0]?.coverPath,
        tracks: playlist,
        payload: {
          kind: playlistId != null ? 'playlist' : tab === 'search' ? 'search' : 'recommend',
          id: playlistId ?? undefined,
          name: buildTempName(),
          keyword: tab === 'search' ? keyword.trim() : undefined,
          tracks: playlist,
        },
      });
    }
  }, [tracks, onPlay, onTempPlaylist, buildTempName]);

  const handleLike = useCallback(async (e: React.MouseEvent, t: NeteaseTrack) => {
    e.stopPropagation();
    if (!isLoggedIn()) {
      setError('请先登录网易云，再收藏到「我喜欢的音乐」');
      return;
    }
    try {
      await likeNeteaseSong(t.id, true);
      setLikedSongs((prev) => new Set(prev).add(t.id));
    } catch (err: any) {
      setError(`收藏失败：${err?.message || String(err)}`);
    }
  }, []);

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
      const tempId = playlistId != null ? `playlist-${playlistId}` : tab === 'search' ? `search-${keyword.trim()}` : 'recommend';
      onTempPlaylist?.({
        id: tempId,
        name: buildTempName(),
        coverPath: playlist[startIndex >= 0 ? startIndex : 0]?.coverPath,
        tracks: playlist,
        payload: {
          kind: playlistId != null ? 'playlist' : tab === 'search' ? 'search' : 'recommend',
          id: playlistId ?? undefined,
          name: buildTempName(),
          keyword: tab === 'search' ? keyword.trim() : undefined,
          tracks: playlist,
        },
      });

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
        <h2 className="text-sm font-semibold text-neutral-800 dark:text-stone-100">
          {tab === 'library'
            ? '猜你喜欢'
            : tab === 'login' && loggedIn
              ? '我的账号'
              : T(TAB_TITLE_KEYS[tab])}
        </h2>
        <div className="flex items-center gap-2">
          {loggedIn ? (
            <button
              onClick={() => setTab('login')}
              className="btn-press flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-neutral-200/60 dark:hover:bg-stone-800/60 transition-colors"
              title={profile ? `网易云：${profile.nickname}` : '已登录网易云'}
            >
              {profile?.avatarUrl ? (
                <img src={profile.avatarUrl} alt="" className="w-6 h-6 rounded-full object-cover" />
              ) : (
                <span className="w-6 h-6 rounded-full bg-blue-500/15 text-blue-600 dark:text-blue-400 flex items-center justify-center text-xs font-bold">
                  {profile ? profile.nickname.slice(0, 1) : '云'}
                </span>
              )}
              <span className="text-xs text-neutral-700 dark:text-stone-200 max-w-[80px] truncate">
                {profile ? profile.nickname : '已登录'}
              </span>
            </button>
          ) : (
            <button
              onClick={() => setTab('login')}
              className="btn-press text-xs text-neutral-500 dark:text-stone-400 hover:text-blue-600 dark:hover:text-blue-400 px-2 py-1 rounded-lg hover:bg-neutral-200/60 dark:hover:bg-stone-800/60 transition-colors"
            >
              登录
            </button>
          )}
          <button
            onClick={onBack}
            className="btn-press flex items-center justify-center p-2 rounded-lg text-neutral-500 dark:text-stone-400 hover:bg-neutral-200/60 dark:hover:bg-stone-800/60 transition-colors"
            title={T('music.moduleDrawer.title')}
          >
            <CloudIcon size={18} />
          </button>
        </div>
      </div>

      {/* 主内容区 */}
      <div ref={scrollRef} className="flex-1 h-full overflow-y-auto px-4 pb-4">
        {tab === 'listen' && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-neutral-800 dark:text-stone-100">{T('music.moduleDrawer.netease.listenNow')}</h2>
              {tracks.length > 0 && !playlistId && (
                <button onClick={handlePlayAll} className="btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/15 text-blue-600 dark:text-blue-400 text-sm hover:bg-blue-500/25 transition-colors">
                  <PlayIcon size={14} />
                  {T('music.track.playAll') || '播放全部'}
                </button>
              )}
            </div>
            {!playlistId ? (
              // 「现在就听」模块化：精选歌单网格（和网易云首页推荐对齐），点击进入歌单详情
              <div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-5">
                  {featured.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => openPlaylist(f.id, f.name)}
                      className="btn-press group flex flex-col text-left"
                    >
                      <div className="relative aspect-square rounded-xl overflow-hidden bg-neutral-200/60 dark:bg-stone-800/60 mb-2">
                        {f.cover ? (
                          <img src={f.cover} alt={f.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-2xl font-bold text-white/80 bg-gradient-to-br from-blue-500/70 to-fuchsia-500/70">
                            {f.name.slice(0, 1)}
                          </div>
                        )}
                      </div>
                      <div className="text-sm font-medium text-neutral-800 dark:text-stone-100 truncate">{f.name}</div>
                      <div className="text-xs text-neutral-500 dark:text-stone-400">
                        {f.trackCount > 0 ? `共 ${f.trackCount} 首` : '榜单'}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              renderBody()
            )}
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
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-neutral-800 dark:text-stone-100">猜你喜欢</h2>
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
        {tab === 'radio' && <PlaceholderTab title={T('music.moduleDrawer.netease.radio')} desc={T('music.moduleDrawer.netease.radioDesc')} />}
        {tab === 'login' && (
          <section className="py-6">
            {loggedIn ? (
              <div className="max-w-md mx-auto flex flex-col gap-5">
                {profile ? (
                  <div className="flex flex-col items-center gap-3 p-5 rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60">
                    <img src={profile.avatarUrl} alt="" className="w-20 h-20 rounded-full object-cover border-2 border-white dark:border-stone-700 shadow-sm" />
                    <div className="text-center">
                      <div className="flex items-center justify-center gap-2">
                        <span className="text-lg font-semibold text-neutral-800 dark:text-stone-100">{profile.nickname}</span>
                        {profile.vipType > 0 && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20">VIP</span>
                        )}
                      </div>
                      {profile.signature ? (
                        <div className="mt-1 text-xs text-neutral-500 dark:text-stone-400 max-w-[260px] truncate">{profile.signature}</div>
                      ) : null}
                      <div className="mt-2 text-[10px] text-neutral-400 dark:text-stone-500">ID: {profile.userId}</div>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-3 p-5 rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60">
                    <div className="w-20 h-20 rounded-full bg-blue-500/15 flex items-center justify-center text-blue-600 dark:text-blue-400 text-2xl font-bold">云</div>
                    {profileError ? (
                      <div className="text-center">
                        <div className="text-sm text-red-600 dark:text-red-400 max-w-[240px]">{profileError}</div>
                        <button
                          onClick={() => fetchProfile()}
                          disabled={profileLoading}
                          className="btn-press mt-2 px-3 py-1 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 text-xs hover:bg-blue-500/20 transition-colors disabled:opacity-50"
                        >
                          {profileLoading ? '获取中…' : '重新获取'}
                        </button>
                      </div>
                    ) : (
                      <div className="text-sm text-neutral-500 dark:text-stone-400">{profileLoading ? '正在获取用户信息…' : '未能读取用户信息'}</div>
                    )}
                  </div>
                )}

                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-neutral-800 dark:text-stone-100">我的歌单</h3>
                    <span className="text-xs text-neutral-400 dark:text-stone-500">{playlists.length} 个</span>
                  </div>
                  {playlists.length > 0 ? (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {playlists.map((pl) => (
                        <button
                          key={pl.id}
                          onClick={() => { openPlaylist(pl.id, pl.name); setTab('listen'); }}
                          className="btn-press text-left group"
                          title={pl.name}
                        >
                          <div className="relative aspect-square rounded-xl overflow-hidden mb-2 bg-neutral-200 dark:bg-stone-700">
                            <img src={pl.coverImgUrl} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors" />
                            <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded-md bg-black/40 text-white text-[10px] flex items-center gap-0.5">
                              <PlayIcon size={10} />
                              {pl.trackCount}
                            </div>
                          </div>
                          <div className="text-xs text-neutral-800 dark:text-stone-100 line-clamp-2 leading-tight min-h-[2em]">{pl.name}</div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-neutral-400 dark:text-stone-500 text-center py-8 rounded-2xl bg-neutral-100/50 dark:bg-stone-800/40 border border-dashed border-neutral-200 dark:border-stone-700">
                      {profileLoading ? '正在加载歌单…' : profileError ? '获取用户信息失败，无法加载歌单' : '暂无歌单'}
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-center gap-3">
                  <button
                    onClick={handleLogout}
                    className="btn-press px-4 py-2 rounded-xl bg-red-500/10 text-red-600 dark:text-red-400 text-sm hover:bg-red-500/20 transition-colors"
                  >
                    退出登录
                  </button>
                </div>
              </div>
            ) : qrImg ? (
              <div className="max-w-sm mx-auto flex flex-col items-center gap-4 p-6 rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60">
                <h2 className="text-base font-semibold text-neutral-800 dark:text-stone-100">扫码登录网易云</h2>
                <img src={qrImg} alt="登录二维码" className="w-48 h-48 rounded-xl bg-white p-2" />
                <div className="text-sm text-neutral-500 dark:text-stone-400 text-center min-h-[1.5em]">{qrStatus}</div>
                <button onClick={startQrLogin} className="btn-press px-4 py-1.5 rounded-lg bg-neutral-200/60 dark:bg-stone-800/60 text-sm text-neutral-700 dark:text-stone-200 hover:bg-neutral-300/60 dark:hover:bg-stone-700/60 transition-colors">
                  刷新二维码
                </button>
              </div>
            ) : (
              <div className="max-w-sm mx-auto flex flex-col items-center gap-4 p-8 rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-red-500 to-rose-600 flex items-center justify-center text-white shadow-lg">
                  <CloudIcon size={32} />
                </div>
                <div className="text-center">
                  <h2 className="text-base font-semibold text-neutral-800 dark:text-stone-100 mb-1">登录网易云音乐</h2>
                  <p className="text-xs text-neutral-500 dark:text-stone-400">扫码登录后即可使用推荐、歌单、搜索与收藏同步</p>
                </div>
                <button
                  onClick={startQrLogin}
                  disabled={qrLoading}
                  className="btn-press w-full px-5 py-2.5 rounded-xl bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-50"
                >
                  {qrLoading ? '生成中…' : '立即扫码登录'}
                </button>
                <div className="text-xs text-neutral-400 dark:text-stone-500 text-center min-h-[1.2em]">{qrStatus}</div>
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
    return renderBodyInner();
  }

  // 单曲列表（推荐流 / 歌单详情共用），不含加载态与空态
  function renderBodyInner() {
    return (
      <div className="flex flex-col gap-1">
        {tracks.map((t) => (
          <div
            key={t.id}
            role="button"
            tabIndex={0}
            onClick={() => handlePlayTrack(t)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlePlayTrack(t); } }}
            className="btn-press group flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-neutral-200/50 dark:hover:bg-stone-800/50 transition-colors text-left cursor-pointer"
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
            <button
              onClick={(e) => handleLike(e, t)}
              className="btn-press p-1.5 rounded-full text-neutral-400 dark:text-stone-500 hover:text-rose-500 dark:hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
              title="收藏到网易云「我喜欢的音乐」"
            >
              <HeartIcon size={15} fill={likedSongs.has(t.id) ? 'currentColor' : 'none'} />
            </button>
          </div>
        ))}
        {/* 无限下拉：仅在支持分页的 tab（搜索 / 歌单）显示加载状态与触底哨兵 */}
        {(tab === 'search' || (tab === 'listen' && playlistId != null)) && (
          <div ref={sentinelRef} className="py-3 text-center text-xs text-neutral-400 dark:text-stone-500">
            {loadingMore
              ? '加载中…'
              : reachedLimit
                ? `已加载 ${offset} 首（本地预览上限 ${MAX_ITEMS} 首，可在搜索中缩小范围）`
                : hasMore
                  ? '下拉加载更多'
                  : (tracks.length ? `已显示全部 ${offset} 首` : '')}
          </div>
        )}
      </div>
    );
  }
});

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
