/// <reference path="../global.d.ts" />
import React from 'react';
import { ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import {
  CloudIcon, HeartIcon, MusicIcon, PlayIcon, SearchIcon, VideoIcon,
} from '../../_shared/icons';
import { T } from '../../_shared/pluginRuntime';
import {
  searchSongs, getListenNow, getPersonalFm, getTopList, getPersonalizedPlaylists, getSongUrl, getSongWiki, isLoggedIn, logoutNetease,
  neteaseQrKey, neteaseQrCreate, neteaseQrCheck,
  getUserAccount, getUserPlaylists, neteaseTrackBadges, qualityLabelFromBr, likeNeteaseSong, subscribeNeteasePlaylist, isLikedPlaylist,
  getMvPlayable,
  getArtistDetail, getArtistAlbums, getArtistAllSongs, getArtistMvs, getArtistDesc, getSimilarArtists,
  getAlbumDetail, subscribeAlbum,
  getVipInfo, getAdFreeTab,
  type NeteaseVipInfo, type NeteaseAdFreeTab,
  type NeteaseTrack, type NeteaseProfile, type NeteasePlaylistItem,
  type NeteaseArtist, type NeteaseArtistAlbum, type NeteaseMvItem, type NeteaseSimilarArtist,
  type NeteaseAlbum, type AlbumDetailResult,
} from './neteaseApi';
import { musicPlayer, type Track } from './musicPlayer';
import { MusicHeader } from './MusicHeader';

const { useState, useEffect, useRef, useCallback, useMemo } = React;

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
  onPlay: (tracks: PlayableTrack[], startIndex: number, sourceName: string) => void;
  // 在线播放时把当前来源歌单作为「临时歌单」回传给侧栏，挂到「我的收藏」下方
  onTempPlaylist?: (temp: TempPlaylist) => void;
  // 登录成功后把用户全部歌单回传（侧栏「用户自己的收藏歌单」铺开）
  onUserPlaylists?: (items: NeteasePlaylistItem[]) => void;
  // 当前正在查看的歌单 id（侧栏高亮）
  onActivePlaylist?: (id: number) => void;
  // 用户资料变化时回传（用于模块抽屉显示登录态）
  onProfileChange?: (profile: NeteaseProfile | null) => void;
  // 网易云红心状态（受控）：由父组件统一持有，确保列表与底部播放栏共用同一状态源
  likedSongs?: Set<number>;
  // 列表红心写操作后上报，由父组件统一调网易云 + 本地收藏
  onLikedSongsChange?: (ids: Set<number>) => void;
  // 单曲红心变化时同步到本地收藏（让底部播放栏红心保持一致）
  onToggleFavorite?: (track: PlayableTrack) => void;
  // 点击 MV 图标：取 MV 播放信息后，请求跳转到「玉兰」模块播放。
  // 参数为已解析好的 MV 播放信息（含网络 URL），由父组件负责跨模块切换 + 玉兰接收。
  onPlayMv?: (mv: { id: number; name: string; artist: string; cover: string; url: string }) => void;
  // 点击漫游页「当前播放」封面 → 打开沉浸播放页（与底部播放栏一致）
  onOpenImmersive?: () => void;
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
  { initialTab, onBack, onPlay, onTempPlaylist, onUserPlaylists, onActivePlaylist, onProfileChange, likedSongs: likedSongsProp, onLikedSongsChange, onToggleFavorite, onPlayMv, onOpenImmersive },
  ref,
) {
  const [tab, setTab] = useState<NeteaseTab>(initialTab);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [tracks, setTracks] = useState<NeteaseTrack[]>([]);
  const [keyword, setKeyword] = useState('');
  const [playingId, setPlayingId] = useState<number | null>(null);
  // 漫游页「当前播放」陈列：直接镜像 musicPlayer 单例，覆盖本地曲与网易云曲。
  const [nowPlaying, setNowPlaying] = useState<{ track: Track | null; isPlaying: boolean }>({
    track: musicPlayer.getCurrentTrack(),
    isPlaying: musicPlayer.getIsPlaying(),
  });
  // 流式漫游队列（musicPlayer 当前队列的镜像，用于陈列），append 时同步刷新。
  const [roamQueue, setRoamQueue] = useState<Track[]>(musicPlayer.getTracks());
  // 受控：父组件持有网易云红心状态，这里仅做兜底默认值
  const likedSongs = likedSongsProp ?? new Set<number>();
  const reqRef = useRef(0);
  // 顶部个人资料按钮用作「进入账号 / 返回」切换，记录进入前的 tab
  const previousTabRef = useRef<NeteaseTab>('listen');
  // 歌单/榜单全量曲目缓存：getTopList 已一次性返回完整列表（playlist/detail 不支持 offset 切片），
  // 下拉分页改为从这份缓存纯前端切片续显，避免重复请求导致的无限重复。
  const allTracksRef = useRef<NeteaseTrack[]>([]);
  // 无限下拉分页状态：offset/total 跟踪已加载与总量，hasMore 判断是否还能继续拉
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [reachedLimit, setReachedLimit] = useState(false); // 已达本地预览上限
  const PAGE = 30; // 每页拉取条数
  // 「现在就听」精选歌单（模块化网格）：并行拉取几个官方榜单的封面与曲目数
  const [featured, setFeatured] = useState<{ id: number; name: string; cover: string; trackCount: number }[]>([]);
  // 「为你推荐」个性化歌单流：登录态个性化 / 游客态热门（对齐 MusicStorm /personalized/playlist）
  const [personalized, setPersonalized] = useState<{ id: number; name: string; coverUrl: string; trackCount?: number; copywriter?: string }[]>([]);
  const [personalizedLoaded, setPersonalizedLoaded] = useState(false);
  const [personalizedError, setPersonalizedError] = useState('');
  const recommendScrollRef = useRef<HTMLDivElement>(null);
  const hotScrollRef = useRef<HTMLDivElement>(null);
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

  // 会员信息（A 任务）：黑胶VIP/红V等级、到期、自动续费
  const [vipInfo, setVipInfo] = useState<NeteaseVipInfo | null>(null);
  const [vipLoading, setVipLoading] = useState(false);
  // 「看广告免费听」活动（B 任务 · B4：查询展示 + 官方跳转）
  const [adTab, setAdTab] = useState<NeteaseAdFreeTab | null>(null);

  useEffect(() => { setTab(initialTab); }, [initialTab]);

  // profile 变化时回传父组件，用于模块抽屉同步登录态
  useEffect(() => {
    onProfileChange?.(profile);
  }, [profile, onProfileChange]);

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
          // 拉取「我喜欢的音乐」歌单的歌曲 id，初始化红心状态（读线）
          const liked = list.find((pl) => isLikedPlaylist(pl));
          if (liked) {
            getTopList(liked.id, 100000)
              .then((res) => {
                if (!res) return;
                const ids = new Set(res.tracks.map((t) => t.id));
                onLikedSongsChange?.(ids);
                console.log('[netease] 初始化我喜欢的音乐，共', ids.size, '首');
              })
              .catch((e) => console.warn('[netease] 拉取我喜欢的音乐失败', e));
          }
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

  // 拉取会员信息 + 「看广告免费听」活动状态（A + B 查询层）
  const fetchVipAndAd = useCallback(async () => {
    if (!isLoggedIn()) return;
    setVipLoading(true);
    try {
      const [vip, ad] = await Promise.allSettled([getVipInfo(), getAdFreeTab()]);
      if (vip.status === 'fulfilled') setVipInfo(vip.value);
      if (ad.status === 'fulfilled') setAdTab(ad.value);
    } catch (e) {
      console.warn('[netease] 会员/活动信息获取失败', e);
    } finally {
      setVipLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isLoggedIn()) return;
    fetchProfile(true);
  }, [fetchProfile]);

  // 进入「我的账号」tab 时刷新会员与活动信息（同时刷新冷却剩余）
  useEffect(() => {
    if (tab === 'login' && loggedIn) {
      fetchVipAndAd();
    }
  }, [tab, loggedIn, fetchVipAndAd]);

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
            // 同步拉取会员信息 + 「看广告免费听」活动状态
            fetchVipAndAd();
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
    setProfile(null);
    setQrImg('');
    setQrStatus('');
    if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  // 「现在就听」自动拉取：不再直接加载单曲推荐流，改为精选歌单网格；推荐流移到「猜你喜欢」tab
  useEffect(() => {
    if (tab !== 'listen') return;
    if (playlistId != null) return; // 正在查看某歌单详情，不要重置回网格
    setPlaylistId(null); // 离开歌单分页模式
    setPlaylistInfo(null);
    setNotice(null);
    sourceNameRef.current = T('music.moduleDrawer.netease.listenNow') || '热榜';
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
    // 并行拉取「为你推荐」个性化歌单（休闲态个性化 / 游客态热门），对齐 MusicStorm
    setPersonalizedError('');
    getPersonalizedPlaylists(24)
      .then((arr) => {
        if (req !== reqRef.current) return;
        console.log('[netease] personalized/playlist ok, count=', arr.length);
        setPersonalized(arr);
        setPersonalizedLoaded(true);
      })
      .catch((err) => {
        if (req !== reqRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[netease] personalized/playlist failed:', msg);
        setPersonalized([]);
        setPersonalizedError(msg || '推荐加载失败');
        setPersonalizedLoaded(true);
      });
  }, [tab]);

  // 搜索（防抖）：每次关键词变化时重置分页，从头加载
  useEffect(() => {
    if (tab !== 'search') return;
    setPlaylistId(null); // 离开歌单分页模式
    setPlaylistInfo(null);
    setNotice(null);
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

  // 「漫游」流式推送：进入漫游页时拉首批并（未播放则）自动播放；
  // 播放接近队尾时再拉下一批 append 进 musicPlayer 队列，而非三首循环。
  const [roamOffset, setRoamOffset] = useState(0);
  const [roamReloadKey, setRoamReloadKey] = useState(0); // 换一批：自增触发重新拉取
  const roamReservoir = useRef<NeteaseTrack[]>([]); // 游客态一次性取回的推荐池，按需切片续推
  const roamExtending = useRef(false);
  const roamTrackListRef = useRef<NeteaseTrack[]>([]); // 镜像漫游队列的 NeteaseTrack（含 artistId/albumId），供单曲展示查抽屉
  const [roamCurrentId, setRoamCurrentId] = useState<string | null>(null); // 当前展示的单曲 id（netease-${id}）
  const [roamWiki, setRoamWiki] = useState<import('./neteaseApi').SongWiki | null>(null); // 当前单曲的歌曲百科（懒加载）
  const roamWikiMap = useRef<Record<number, import('./neteaseApi').SongWiki | null>>({}); // 按歌曲 id 缓存百科，避免重复请求
  const roamWikiLoading = useRef(false); // 防止并发重复拉取
  // 用 ref 承接父组件传入的回调，避免其 identity 变化导致漫游加载 effect 重跑（即「暂停/任意重渲染就刷新一次」）
  const onPlayRef = useRef(onPlay);
  const onTempPlaylistRef = useRef(onTempPlaylist);
  onPlayRef.current = onPlay;
  onTempPlaylistRef.current = onTempPlaylist;

  // 拉下一批漫游曲目（登录态用私人 FM 真增量，游客态从一次性推荐池切片）
  const fetchRoamBatch = useCallback(async (): Promise<NeteaseTrack[]> => {
    if (isLoggedIn()) {
      const list = await getPersonalFm(8, roamOffset);
      if (list.length) { setRoamOffset((o) => o + 8); return list; }
    }
    // 游客态：首次灌满推荐池，之后从池里切片续推
    if (roamReservoir.current.length === 0) {
      roamReservoir.current = await getListenNow(50);
    }
    const slice = roamReservoir.current.splice(0, 8);
    return slice;
  }, [roamOffset]);

  // 把一批曲目转为 PlayableTrack 并入 musicPlayer 队列（首播用 onPlay，续推用 appendTracks）。
  // 首播会同步取 startIndex 的真实播放地址，其余曲目空 URL 占位；所有曲目后台异步补全地址，
  // 避免「元数据进了 SMTC 但音频无法播放、时间显示 0:00」的问题。
  const pushRoamTracks = useCallback(async (batch: NeteaseTrack[], startIndex: number, first: boolean) => {
    if (!batch.length) return;
    // 始终把本批次 NeteaseTrack 镜像进漫游列表（含 artistId/albumId），供单曲展示查抽屉
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
      // 后台补全同批其余曲地址（不阻塞播放）
      for (let i = 0; i < batch.length; i++) {
        if (i === startIndex && firstRes.url) continue;
        const u = await getSongUrl(batch[i].id).catch(() => null);
        if (u?.url) musicPlayer.updateTrackUrl(i, u.url);
      }
    } else {
      const playlist: PlayableTrack[] = batch.map((t) => trackToPlayable(t, ''));
      const baseIdx = musicPlayer.getTracks().length;
      musicPlayer.appendTracks(playlist);
      // 后台补全新追加曲目地址
      for (let i = 0; i < batch.length; i++) {
        const u = await getSongUrl(batch[i].id).catch(() => null);
        if (u?.url) musicPlayer.updateTrackUrl(baseIdx + i, u.url);
      }
    }
    setRoamQueue(musicPlayer.getTracks());
  }, []);

  // 续推下一批（播放接近队尾时调用）
  const extendRoam = useCallback(async () => {
    if (roamExtending.current) return;
    roamExtending.current = true;
    try {
      const batch = await fetchRoamBatch();
      if (batch.length) await pushRoamTracks(batch, 0, false);
    } catch (e) {
      console.warn('[netease] 漫游续推失败', e);
    } finally {
      roamExtending.current = false;
    }
  }, [fetchRoamBatch, pushRoamTracks]);

  useEffect(() => {
    if (tab !== 'library') return;
    setPlaylistId(null); // 离开歌单分页模式
    setPlaylistInfo(null);
    setNotice(null);
    sourceNameRef.current = '漫游';
    roamReservoir.current = [];
    roamTrackListRef.current = [];
    const req = ++reqRef.current;
    setLoading(true);
    setError('');
    setOffset(0);
    (async () => {
      try {
        const list = await fetchRoamBatch();
        if (req !== reqRef.current) return;
        const safeList = list.length ? list : await getListenNow(50);
        const finalList = req === reqRef.current ? safeList : list;
        setTotal(finalList.length);
        setHasMore(false);
        setLoading(false);
        // 进入漫游页：仅当队列中【没有任何已加载曲目】（即从未播放过）时才自动起播漫游首批。
        // 注意：暂停时 getIsPlaying() 也为 false，但此时当前曲目仍在队列中，不应被漫游列表整体替换并强制起播，
        // 否则会出现「暂停即自动切换到漫游列表继续播放」的问题。
        if (!musicPlayer.getCurrentTrack() && finalList.length) {
          await pushRoamTracks(finalList, 0, true);
        }
      } catch (e: any) {
        if (req === reqRef.current) { setError(String(e?.message || e)); setLoading(false); }
      }
    })();
  }, [tab, roamReloadKey, fetchRoamBatch, pushRoamTracks]);
  const refreshRoam = useCallback(() => {
    roamReservoir.current = [];
    setRoamOffset(0);
    setRoamReloadKey((k) => k + 1); // 触发上面 effect 重新拉取首批
  }, []);

  // 懒加载当前单曲的歌曲百科（手机版网易云「歌曲百科」）：发行时间、语种、BPM、乐器、曲风、乐谱。
  // 按歌曲 id 缓存，切换单曲时仅对未加载过的曲目发起请求，不阻塞播放与渲染。
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

  // 订阅音乐播放器事件：同步「当前播放」单曲展示与漫游队列镜像，
  // 并在漫游队列接近队尾时（剩余不足 3 首）自动续推下一批，实现流式漫游。
  useEffect(() => {
    const syncNow = () => setNowPlaying({ track: musicPlayer.getCurrentTrack(), isPlaying: musicPlayer.getIsPlaying() });
    const syncCurrent = () => {
      const cur = roamTrackListRef.current.find((t) => `netease-${t.id}` === musicPlayer.getCurrentTrack()?.id) || null;
      setRoamCurrentId(musicPlayer.getCurrentTrack()?.id ?? null);
      loadWikiForCurrent(cur);
      syncNow();
    };
    const maybeExtend = () => {
      const len = musicPlayer.getTracks().length;
      const idx = musicPlayer.getCurrentIndex();
      if (tab === 'library' && len - 1 - idx <= 2) extendRoam();
      // 切歌时更新展示的单曲（暂停不会触发 trackChange，故不会刷新单曲）
      const cur = roamTrackListRef.current.find((t) => `netease-${t.id}` === musicPlayer.getCurrentTrack()?.id) || null;
      setRoamCurrentId(musicPlayer.getCurrentTrack()?.id ?? null);
      loadWikiForCurrent(cur);
      syncNow();
    };
    syncNow();
    setRoamCurrentId(musicPlayer.getCurrentTrack()?.id ?? null);
    loadWikiForCurrent(roamTrackListRef.current.find((t) => `netease-${t.id}` === musicPlayer.getCurrentTrack()?.id) || null);
    const unsubTrackChange = musicPlayer.on('trackChange', maybeExtend);
    const unsubPlay = musicPlayer.on('play', syncCurrent);
    const unsubPause = musicPlayer.on('pause', syncNow); // 仅更新播放态，不切换/刷新单曲
    // 进入漫游页时若队列右侧缓冲不足，先补一批（保证播放衔接）
    if (tab === 'library') {
      const len = musicPlayer.getTracks().length;
      const idx = musicPlayer.getCurrentIndex();
      if (len - 1 - idx <= 2) extendRoam();
    }
    return () => {
      unsubTrackChange();
      unsubPlay();
      unsubPause();
    };
  }, [tab, extendRoam]);

  const [playlistId, setPlaylistId] = useState<number | null>(null);
  const [playlistInfo, setPlaylistInfo] = useState<{ name: string; coverUrl?: string; description?: string; trackCount: number; playCount?: number } | null>(null);
  const [subscribedPlaylist, setSubscribedPlaylist] = useState(false);
  const [notice, setNotice] = useState<{ text: string; type?: 'success' | 'error' } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2200);
    return () => clearTimeout(t);
  }, [notice]);
  // 当前面板来源名（用于临时歌单命名）：歌单/榜单进入时记录，tab 切换时更新
  const sourceNameRef = useRef<string>('');

  // ===== 顶部抽屉详情（歌手 / 专辑，对齐 MusicStorm） =====
  // 抽屉从顶部弹出，覆盖下方 80% 区域，可滚动，点击遮罩 / 返回按钮关闭。
  type DrawerState =
    | { type: 'none' }
    | { type: 'artist'; id: number }
    | { type: 'album'; id: number };
  const [drawer, setDrawer] = useState<DrawerState>({ type: 'none' });

  // 从单曲列表点击歌手名 / 专辑名进入详情（需 track 携带 artistId / albumId）
  const openArtistDrawer = useCallback((artistId?: number) => {
    if (!artistId) return;
    setDrawer({ type: 'artist', id: artistId });
  }, []);
  const openAlbumDrawer = useCallback((albumId?: number) => {
    if (!albumId) return;
    setDrawer({ type: 'album', id: albumId });
  }, []);
  const closeDrawer = useCallback(() => setDrawer({ type: 'none' }), []);

  const openPlaylist = useCallback(async (id: number, name?: string) => {
    const req = ++reqRef.current;
    try {
      setPlaylistId(id);
      if (name) sourceNameRef.current = name;
      onActivePlaylist?.(id);
      setLoading(true);
      setError('');
      setOffset(0);
      const res = await getTopList(id, 100000, 0);
      if (req !== reqRef.current) return;
      // 全量缓存：playlist/detail 一次性返回完整列表，下拉分页从缓存纯前端切片
      allTracksRef.current = res.tracks;
      const shown = res.tracks.slice(0, MAX_ITEMS);
      setTracks(shown);
      setTotal(res.total || res.tracks.length);
      setOffset(shown.length);
      setReachedLimit(shown.length >= MAX_ITEMS);
      setHasMore(shown.length < (res.total || res.tracks.length) && shown.length < MAX_ITEMS);
      setPlaylistInfo({
        name: name || res.description || '歌单详情',
        coverUrl: res.coverUrl,
        description: res.description,
        trackCount: res.total || res.tracks.length,
        playCount: res.playCount,
      });
      // 查询当前歌单是否已收藏（仅登录态）
      if (profile?.userId) {
        getUserPlaylists(profile.userId, 1000)
          .then((list) => {
            if (req !== reqRef.current) return;
            setSubscribedPlaylist(list.some((p) => p.id === id));
          })
          .catch(() => {});
      } else {
        setSubscribedPlaylist(false);
      }
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
      // 纯前端切片：从 allTracksRef 全量缓存中按当前已显示数续取，不再请求接口
      const all = allTracksRef.current;
      const nextSlice = all.slice(offset, Math.min(offset + PAGE, MAX_ITEMS));
      if (!nextSlice.length) { setHasMore(false); return; }
      setTracks((prev) => [...prev, ...nextSlice]);
      const next = offset + nextSlice.length;
      setOffset(next);
      const limit = next >= MAX_ITEMS;
      setReachedLimit(limit);
      setHasMore(!limit && next < (total || all.length));
    } catch (e) {
      console.warn('[netease] 加载歌单下一页失败', e);
    } finally {
      if (req === reqRef.current) { setLoadingMore(false); loadingMoreRef.current = false; }
    }
  }, [playlistId, offset, hasMore, total]);

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
    return T('music.moduleDrawer.netease.listenNow') || '热榜';
  }, [tab, keyword]);

  const scrollRecommend = (dir: 'left' | 'right') => {
    const el = recommendScrollRef.current;
    if (!el) return;
    const step = Math.max(el.clientWidth * 0.75, 200);
    el.scrollBy({ left: dir === 'left' ? -step : step, behavior: 'smooth' });
  };
  const scrollHot = (dir: 'left' | 'right') => {
    const el = hotScrollRef.current;
    if (!el) return;
    const step = Math.max(el.clientWidth * 0.75, 200);
    el.scrollBy({ left: dir === 'left' ? -step : step, behavior: 'smooth' });
  };

  const handlePlayAll = useCallback(async () => {
    if (tracks.length === 0) return;
    // 只同步取第一首地址立即播放，避免整张列表串行取地址导致数秒延迟。
    // 其余曲以空 filePath 占位进队列，后台并发补全地址。
    const firstRes = await getSongUrl(tracks[0].id);
    const playlist: PlayableTrack[] = tracks.map((t, i) =>
      i === 0 && firstRes.url
        ? trackToPlayable(t, firstRes.url, qualityLabelFromBr(firstRes.br))
        : trackToPlayable(t, '')
    );
    const tempName = buildTempName();
    onPlay(playlist, 0, tempName);
    const tempId = playlistId != null ? `playlist-${playlistId}` : tab === 'search' ? `search-${keyword.trim()}` : 'recommend';
    onTempPlaylist?.({
      id: tempId,
      name: tempName,
      coverPath: playlist[0]?.coverPath,
      tracks: playlist,
      payload: {
        kind: playlistId != null ? 'playlist' : tab === 'search' ? 'search' : 'recommend',
        id: playlistId ?? undefined,
        name: tempName,
        keyword: tab === 'search' ? keyword.trim() : undefined,
        tracks: playlist,
      },
    });

    // 后台并发补全其余曲的播放地址（不阻塞播放）
    const player = (window as unknown as { __MUSIC_PLAYER__?: { updateTrackUrl?: (i: number, u: string) => void } }).__MUSIC_PLAYER__;
    if (player?.updateTrackUrl) {
      for (let i = 1; i < tracks.length; i++) {
        const u = await getSongUrl(tracks[i].id).catch(() => null);
        if (u?.url) player.updateTrackUrl(i, u.url);
      }
    }
  }, [tracks, onPlay, onTempPlaylist, buildTempName]);

  const handleLike = useCallback(async (e: React.MouseEvent | undefined, t: NeteaseTrack) => {
    e?.stopPropagation?.();
    if (!isLoggedIn()) {
      setError('请先登录网易云，再收藏到「我喜欢的音乐」');
      return;
    }
    // 单曲红心与歌单收藏对齐标准：按当前状态 toggle（已喜欢则取消）
    const currentlyLiked = likedSongs?.has(t.id) ?? false;
    const next = !currentlyLiked;
    try {
      await likeNeteaseSong(t.id, next);
      // 写成功后上报父组件，统一更新网易云红心状态（仅管线上的 likedSongs，不碰本地收藏）
      const nextSet = new Set(likedSongs ?? []);
      if (next) nextSet.add(t.id);
      else nextSet.delete(t.id);
      onLikedSongsChange?.(nextSet);
      console.log('[netease] like song 已同步红心状态', { neteaseId: t.id, liked: next });
    } catch (err: any) {
      setError(`${next ? '收藏' : '取消收藏'}失败：${err?.message || String(err)}`);
    }
  }, [likedSongs, onLikedSongsChange]);

  // 点击 MV 图标：取 MV 播放地址 → 通知父组件跳转到玉兰模块播放（创建临时列表，关闭即销毁）
  const handlePlayMv = useCallback(async (e: React.MouseEvent | undefined, t: NeteaseTrack) => {
    e?.stopPropagation?.();
    if (!t || !t.mvId) {
      console.warn('[netease][mv] 无效的 track（t 缺失或缺少 mvId）', t);
      return;
    }
    try {
      const mv = await getMvPlayable(t.mvId);
      if (!mv || !mv.url) {
        setError('该歌曲的 MV 暂不可用或获取失败');
        return;
      }
      onPlayMv?.({
        id: mv.id,
        name: mv.name || t.name,
        artist: mv.artist || t.artist,
        cover: mv.cover || t.cover || '',
        url: mv.url,
      });
    } catch (err: any) {
      setError(`MV 播放失败：${err?.message || String(err)}`);
    }
  }, [onPlayMv]);

  const handleSubscribePlaylist = useCallback(async () => {
    if (!isLoggedIn() || playlistId == null) {
      if (playlistId != null) setNotice({ text: '请先登录网易云，再收藏歌单', type: 'error' });
      return;
    }
    const next = !subscribedPlaylist;
    try {
      const resp = await subscribeNeteasePlaylist(playlistId, next);
      // 服务端可能返回 code:200 但 message 含失败描述（如"不能收藏此歌单"），必须二次校验
      const code = resp?.code;
      const msg = resp?.message || resp?.msg;
      const realOk = code === 200 || code === undefined;
      if (realOk && !(msg && /不能|失败|无法|无权|error/i.test(String(msg)))) {
        // 收藏/取消成功后，以服务端真实歌单列表刷新侧栏，避免"已收藏但侧栏不刷新"或"取消后仍显示"
        try {
          if (profile) {
            const list = await getUserPlaylists(profile.userId, 1000);
            setPlaylists(list);
            onUserPlaylists?.(list);
            const actual = list.some((p) => p.id === playlistId);
            setSubscribedPlaylist(actual);
            setNotice({ text: actual ? '已收藏歌单' : '已取消收藏歌单', type: 'success' });
            return;
          }
        } catch (syncErr) {
          console.warn('[netease] 收藏歌单后刷新侧栏失败', syncErr);
        }
        setSubscribedPlaylist(next);
        setNotice({ text: next ? '已收藏歌单' : '已取消收藏歌单', type: 'success' });
      } else {
        setNotice({ text: `收藏未生效：${msg || ('code ' + code)}`, type: 'error' });
      }
    } catch (err: any) {
      setNotice({ text: `收藏歌单失败：${err?.message || String(err)}`, type: 'error' });
    }
  }, [playlistId, subscribedPlaylist, profile, onUserPlaylists]);

  // 收藏 / 取消收藏专辑（顶部详情抽屉使用）
  const handleSubscribeAlbum = useCallback(async (albumId: number, subscribe: boolean) => {
    if (!loggedIn) {
      setNotice({ type: 'error', text: '请先登录网易云' });
      return;
    }
    try {
      await subscribeAlbum(albumId, subscribe);
      setNotice({ type: 'success', text: subscribe ? '已收藏专辑' : '已取消收藏' });
    } catch (e) {
      console.warn('[netease] 收藏专辑失败', e);
      setNotice({ type: 'error', text: subscribe ? '收藏专辑失败' : '取消收藏失败' });
    }
  }, [loggedIn]);

  // 播放任意曲目列表（单曲点击 / 列表播放全部通用）。startIndex 指定从哪首起播；name 用于临时歌单命名（不传则用默认）。
  const playTrackList = useCallback(async (list: NeteaseTrack[], startIndex: number, name?: string) => {
    if (list.length === 0) return;
    const t = list[startIndex] ?? list[0];
    setPlayingId(t.id);
    const res = await getSongUrl(t.id);
    if (res.url) {
      // 只同步取点击单曲的地址，立即播放，避免整张列表串行取地址导致数秒延迟。
      // 其余曲以空 filePath 占位进入队列，后台异步补全地址（见下方 fire-and-forget）。
      const quality = qualityLabelFromBr(res.br);
      const playable = trackToPlayable(t, res.url, quality);
      const playlist: PlayableTrack[] = list.map((x) => {
        if (x.id === t.id) return playable;
        return trackToPlayable(x, '');
      });
      const tempName = name || buildTempName();
      onPlay(playlist, startIndex, tempName);
      const tempId = name ? `detail-${encodeURIComponent(name).slice(0, 24)}-${Date.now()}` : (playlistId != null ? `playlist-${playlistId}` : tab === 'search' ? `search-${keyword.trim()}` : 'recommend');
      onTempPlaylist?.({
        id: tempId,
        name: tempName,
        coverPath: playlist[startIndex]?.coverPath,
        tracks: playlist,
        payload: {
          kind: name ? 'recommend' : (playlistId != null ? 'playlist' : tab === 'search' ? 'search' : 'recommend'),
          id: playlistId ?? undefined,
          name: tempName,
          keyword: tab === 'search' ? keyword.trim() : undefined,
          tracks: playlist,
        },
      });

      // 后台补全其余曲的播放地址（不阻塞播放）；跳过已立即取地址的点击曲，避免重复请求。
      // 补到当前播放的等待曲时播放器会自动 reload。
      const player = (window as unknown as { __MUSIC_PLAYER__?: { updateTrackUrl?: (i: number, u: string) => void } }).__MUSIC_PLAYER__;
      if (player?.updateTrackUrl) {
        for (let i = 0; i < list.length; i++) {
          if (i === startIndex) continue;
          const u = await getSongUrl(list[i].id).catch(() => null);
          if (u?.url) player.updateTrackUrl(i, u.url);
        }
      }
    }
    setPlayingId(null);
  }, [playlistId, keyword, onPlay, onTempPlaylist]);

  const handlePlayTrack = useCallback(async (t: NeteaseTrack) => {
    const idx = tracks.findIndex((x) => x.id === t.id);
    await playTrackList(tracks, idx >= 0 ? idx : 0);
  }, [tracks, playTrackList]);

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden overflow-x-hidden relative bg-white dark:bg-[#1e1e1e]">
      {/* 顶部栏：复用通用音乐模块模板（标题 + 登录按钮 + 云按钮） */}
      <MusicHeader
        title={
          playlistId != null
            ? (sourceNameRef.current || (T(TAB_TITLE_KEYS.listen) || '热榜'))
            : (tab === 'library'
                ? '漫游'
                : tab === 'login' && loggedIn
                  ? '我的账号'
                  : T(TAB_TITLE_KEYS[tab]))
        }
        onBackToSub={playlistId != null ? () => setPlaylistId(null) : undefined}
        onBackToSubTitle={T(TAB_TITLE_KEYS.listen) || '现在就听'}
        onUserClick={() => {
          if (loggedIn) {
            if (tab === 'login') setTab(previousTabRef.current);
            else { previousTabRef.current = tab; setTab('login'); }
          } else {
            setTab('login');
          }
        }}
        onCloudClick={onBack}
        cloudTitle={T('music.moduleDrawer.title')}
        user={
          loggedIn
            ? {
                loggedIn: true,
                name: profile?.nickname,
                avatarUrl: profile?.avatarUrl,
                initial: profile?.nickname ? profile.nickname.slice(0, 1) : '云',
              }
            : { loggedIn: false }
        }
      />

      {/* 主内容区 */}
      <div ref={scrollRef} className="flex-1 h-full min-w-0 overflow-y-auto overflow-x-hidden px-4 pb-4">
        {tab === 'listen' && (
          <section className="min-w-0">
            <div className="flex items-center justify-between min-w-0 mb-3">
              <h2 className="text-lg font-semibold text-neutral-800 dark:text-stone-100 truncate min-w-0">{T('music.moduleDrawer.netease.listenNow')}</h2>
              {tracks.length > 0 && !playlistId && (
                <button onClick={handlePlayAll} className="btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/15 text-blue-600 dark:text-blue-400 text-sm hover:bg-blue-500/25 transition-colors">
                  <PlayIcon size={14} />
                  {T('music.track.playAll') || '播放全部'}
                </button>
              )}
            </div>
            {!playlistId ? (
              // 首页推荐流：先「为你推荐」（Hero 置顶 + 横向滑动小卡片），后「热榜」官方榜单
              <React.Fragment>
                {/* 「为你推荐」个性化歌单流：登录态个性化 / 游客态热门，对齐 MusicStorm 首页 */}
                <div className="mb-5">
                  <div className="flex items-center gap-1.5 min-w-0 mb-3">
                    <Sparkles size={16} className="text-fuchsia-500 dark:text-fuchsia-400 flex-shrink-0" />
                    <h3 className="text-base font-semibold text-neutral-800 dark:text-stone-100 truncate min-w-0">
                      {loggedIn ? '为你推荐' : '热门歌单'}
                    </h3>
                    {loggedIn && (
                      <span className="text-[10px] text-fuchsia-500/80 dark:text-fuchsia-400/80 truncate min-w-0">
                        根据你的口味推荐
                      </span>
                    )}
                  </div>
                  {!personalizedLoaded ? (
                    <div className="text-xs text-neutral-500 dark:text-stone-400">加载推荐中…</div>
                  ) : personalizedError ? (
                    <div className="flex flex-col gap-2 text-xs text-red-500 dark:text-red-400">
                      <div>推荐加载失败：{personalizedError}</div>
                      <button
                        onClick={() => {
                          setPersonalizedLoaded(false);
                          setPersonalizedError('');
                          getPersonalizedPlaylists(24)
                            .then((arr) => { setPersonalized(arr); setPersonalizedLoaded(true); })
                            .catch((err) => { setPersonalized([]); setPersonalizedError(err instanceof Error ? err.message : String(err)); setPersonalizedLoaded(true); });
                        }}
                        className="self-start px-3 py-1.5 rounded-lg bg-neutral-100 dark:bg-stone-800 hover:bg-neutral-200 dark:hover:bg-stone-700 text-neutral-700 dark:text-stone-200 transition-colors"
                      >
                        重试
                      </button>
                    </div>
                  ) : personalized.length === 0 ? (
                    <div className="text-xs text-neutral-500 dark:text-stone-400">暂无推荐歌单</div>
                  ) : (
                    <div className="space-y-4">
                      {/* 关联度最高的推荐歌单：圆角正方形 Hero 置顶 */}
                      <button
                        onClick={() => openPlaylist(personalized[0].id, personalized[0].name)}
                        className="btn-press group relative w-full max-w-full h-44 sm:h-52 rounded-2xl overflow-hidden text-left"
                        title={personalized[0].copywriter || personalized[0].name}
                      >
                        {personalized[0].coverUrl ? (
                          <img src={personalized[0].coverUrl} alt={personalized[0].name} className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center text-4xl font-bold text-white/80 bg-gradient-to-br from-fuchsia-500/70 to-blue-500/70">
                            {personalized[0].name.slice(0, 1)}
                          </div>
                        )}
                        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                        <div className="absolute bottom-0 left-0 right-0 p-4">
                          <div className="text-xs text-fuchsia-300 font-medium mb-1">
                            {loggedIn ? '为你精选' : '热门推荐'}
                          </div>
                          <div className="text-lg font-bold text-white truncate">{personalized[0].name}</div>
                          <div className="text-xs text-white/70">
                            {personalized[0].trackCount ? `${personalized[0].trackCount} 首 · ` : ''}{personalized[0].copywriter || '今日推荐'}
                          </div>
                        </div>
                      </button>

                      {/* 其余推荐：横向滑动小卡片，左右翻页 */}
                      <div className="relative w-full min-w-0">
                        <button
                          type="button"
                          onClick={() => scrollRecommend('left')}
                          className="absolute left-0 top-[calc(50%-12px)] z-10 flex h-7 w-7 -ml-1 items-center justify-center rounded-full bg-background/90 text-foreground shadow hover:bg-background border border-border/40 opacity-80 hover:opacity-100 transition-opacity"
                          aria-label="向左翻页"
                        >
                          <ChevronLeft className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => scrollRecommend('right')}
                          className="absolute right-0 top-[calc(50%-12px)] z-10 flex h-7 w-7 -mr-1 items-center justify-center rounded-full bg-background/90 text-foreground shadow hover:bg-background border border-border/40 opacity-80 hover:opacity-100 transition-opacity"
                          aria-label="向右翻页"
                        >
                          <ChevronRight className="w-4 h-4" />
                        </button>
                        <div
                          ref={recommendScrollRef}
                          className="flex gap-3 overflow-x-auto min-w-0 pb-2 scrollbar-thin scroll-smooth"
                        >
                          {personalized.slice(1, 13).map((p) => (
                            <button
                              key={p.id}
                              onClick={() => openPlaylist(p.id, p.name)}
                              className="btn-press group flex-shrink-0 flex flex-col text-left w-28 sm:w-32"
                              title={p.copywriter || p.name}
                            >
                              <div className="relative aspect-square rounded-xl overflow-hidden bg-neutral-200/60 dark:bg-stone-800/60 mb-2">
                                {p.coverUrl ? (
                                  <img src={p.coverUrl} alt={p.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center text-xl font-bold text-white/80 bg-gradient-to-br from-fuchsia-500/70 to-blue-500/70">
                                    {p.name.slice(0, 1)}
                                  </div>
                                )}
                              </div>
                              <div className="text-xs font-medium text-neutral-800 dark:text-stone-100 line-clamp-2">{p.name}</div>
                              <div className="text-[10px] text-neutral-500 dark:text-stone-400 truncate">
                                {p.trackCount ? `${p.trackCount} 首` : '歌单'}
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* 「热榜」官方榜单横向小卡片 */}
                <div className="mb-2">
                  <div className="flex items-center justify-between min-w-0 mb-3">
                    <h3 className="text-base font-semibold text-neutral-800 dark:text-stone-100 truncate min-w-0">热榜</h3>
                    {tracks.length > 0 && (
                      <button onClick={handlePlayAll} className="btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/15 text-blue-600 dark:text-blue-400 text-sm hover:bg-blue-500/25 transition-colors">
                        <PlayIcon size={14} />
                        {T('music.track.playAll') || '播放全部'}
                      </button>
                    )}
                  </div>
                  <div className="relative w-full min-w-0">
                    <button
                      type="button"
                      onClick={() => scrollHot('left')}
                      className="absolute left-0 top-[calc(50%-12px)] z-10 flex h-7 w-7 -ml-1 items-center justify-center rounded-full bg-background/90 text-foreground shadow hover:bg-background border border-border/40 opacity-80 hover:opacity-100 transition-opacity"
                      aria-label="向左翻页"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => scrollHot('right')}
                      className="absolute right-0 top-[calc(50%-12px)] z-10 flex h-7 w-7 -mr-1 items-center justify-center rounded-full bg-background/90 text-foreground shadow hover:bg-background border border-border/40 opacity-80 hover:opacity-100 transition-opacity"
                      aria-label="向右翻页"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                    <div
                      ref={hotScrollRef}
                      className="flex gap-3 overflow-x-auto min-w-0 pb-2 scrollbar-thin scroll-smooth"
                    >
                      {featured.map((f) => (
                        <button
                          key={f.id}
                          onClick={() => openPlaylist(f.id, f.name)}
                          className="btn-press group flex-shrink-0 flex flex-col text-left w-28 sm:w-32"
                          title={f.name}
                        >
                          <div className="relative aspect-square rounded-xl overflow-hidden bg-neutral-200/60 dark:bg-stone-800/60 mb-2">
                            {f.cover ? (
                              <img src={f.cover} alt={f.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-xl font-bold text-white/80 bg-gradient-to-br from-blue-500/70 to-fuchsia-500/70">
                                {f.name.slice(0, 1)}
                              </div>
                            )}
                          </div>
                          <div className="text-xs font-medium text-neutral-800 dark:text-stone-100 line-clamp-2">{f.name}</div>
                          <div className="text-[10px] text-neutral-500 dark:text-stone-400">
                            {f.trackCount > 0 ? `共 ${f.trackCount} 首` : '榜单'}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </React.Fragment>
            ) : (
              <div className="flex flex-col min-w-0">
                {/* 临时浮动提示：收藏/取消收藏反馈 */}
                <div className="h-6 mb-2 flex items-center justify-center">
                  {notice && (
                    <span
                      className={`px-3 py-0.5 rounded-full text-xs font-medium transition-opacity duration-300 ${
                        notice.type === 'error'
                          ? 'bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400'
                          : 'bg-green-50 text-green-600 dark:bg-green-950/40 dark:text-green-400'
                      }`}
                    >
                      {notice.text}
                    </span>
                  )}
                </div>
                {/* 歌单详情页头部 */}
                {playlistInfo && (
                  <div className="flex gap-5 mb-5 min-w-0">
                    <div className="shrink-0 w-32 h-32 sm:w-40 sm:h-40 rounded-2xl overflow-hidden bg-neutral-200 dark:bg-stone-800 shadow-sm">
                      {playlistInfo.coverUrl ? (
                        <img src={playlistInfo.coverUrl} alt={playlistInfo.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-3xl font-bold text-neutral-400 dark:text-stone-500">
                          {playlistInfo.name.slice(0, 1)}
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0 flex flex-col justify-center gap-2">
                      <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-stone-400">
                        <span className="px-1.5 py-0.5 rounded bg-red-500/10 text-red-600 dark:text-red-400">网易云</span>
                        <span>{playlistInfo.trackCount} 首</span>
                        {playlistInfo.playCount ? <span>· {(playlistInfo.playCount / 10000).toFixed(1)} 万次播放</span> : null}
                      </div>
                      <h2 className="text-xl sm:text-2xl font-bold text-neutral-800 dark:text-stone-100 truncate">{playlistInfo.name}</h2>
                      {playlistInfo.description ? (
                        <p className="text-xs text-neutral-500 dark:text-stone-400 line-clamp-2">{playlistInfo.description}</p>
                      ) : null}
                      <div className="flex items-center gap-2 mt-1">
                        <button onClick={handlePlayAll} className="btn-press flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-neutral-800 dark:bg-stone-100 text-white dark:text-stone-900 text-sm font-medium hover:bg-neutral-700 dark:hover:bg-stone-200 transition-colors">
                          <PlayIcon size={14} />
                          播放全部
                        </button>
                        <button
                          onClick={handleSubscribePlaylist}
                          disabled={!loggedIn}
                          className="btn-press flex items-center gap-1.5 px-4 py-1.5 rounded-full border border-neutral-300 dark:border-stone-700 text-neutral-700 dark:text-stone-200 text-sm hover:bg-neutral-100 dark:hover:bg-stone-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          title={loggedIn ? (subscribedPlaylist ? '取消收藏歌单' : '收藏歌单') : '请先登录网易云'}
                        >
                          <HeartIcon size={14} fill={subscribedPlaylist ? 'currentColor' : 'none'} />
                          {subscribedPlaylist ? '已收藏' : '收藏歌单'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                {renderBody()}
              </div>
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
            <div className="mb-3 flex items-center justify-between">
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
            {renderRoam()}
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

                {/* 会员信息（A 任务）：黑胶VIP/红V等级、到期、自动续费 */}
                <div className="p-4 rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60">
                  <h3 className="text-sm font-semibold text-neutral-800 dark:text-stone-100 mb-2">会员状态</h3>
                  {vipLoading && !vipInfo ? (
                    <div className="text-xs text-neutral-400 dark:text-stone-500">查询中…</div>
                  ) : vipInfo && vipInfo.isVip ? (
                    <div className="flex flex-col gap-1.5 text-xs text-neutral-600 dark:text-stone-300">
                      {vipInfo.vipLevel > 0 && (
                        <div className="flex items-center justify-between">
                          <span>黑胶VIP</span>
                          <span className="font-medium text-amber-600 dark:text-amber-400">
                            Lv.{vipInfo.vipLevel}
                            {vipInfo.expireTime > 0 ? ` · 至 ${new Date(vipInfo.expireTime).toLocaleDateString()}` : ''}
                          </span>
                        </div>
                      )}
                      {vipInfo.redVipLevel > 0 && (
                        <div className="flex items-center justify-between">
                          <span>红V认证</span>
                          <span className="font-medium text-red-500 dark:text-red-400">Lv.{vipInfo.redVipLevel}</span>
                        </div>
                      )}
                      {vipInfo.musicPackage && (
                        <div className="flex items-center justify-between">
                          <span>音乐包</span>
                          <span className="font-medium">Lv.{vipInfo.musicPackage.vipLevel}{vipInfo.musicPackage.expireTime > 0 ? ` · 至 ${new Date(vipInfo.musicPackage.expireTime).toLocaleDateString()}` : ''}</span>
                        </div>
                      )}
                      <div className="flex items-center justify-between">
                        <span>自动续费</span>
                        <span className={vipInfo.autoRenew ? 'text-emerald-500' : 'text-neutral-400'}>{vipInfo.autoRenew ? '已开启' : '未开启'}</span>
                      </div>
                    </div>
                  ) : (
                    <div className="text-xs text-neutral-400 dark:text-stone-500">当前账号无会员</div>
                  )}
                </div>

                {/* 「看广告免费听」活动（B 任务 · B4：查询展示 + 官方跳转领取） */}
                <div className="p-4 rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60">
                  <h3 className="text-sm font-semibold text-neutral-800 dark:text-stone-100 mb-2">看广告免费听</h3>
                  {adTab ? (
                    <div className="text-xs text-neutral-600 dark:text-stone-300 mb-2">
                      {adTab.available
                        ? `${adTab.title || '看广告免费听'}：活动进行中，当前剩余免费听 ${Math.round(adTab.remainSeconds / 60)} 分钟`
                        : '当前暂无活动'}
                    </div>
                  ) : (
                    <div className="text-xs text-neutral-400 dark:text-stone-500 mb-2">活动状态查询中…</div>
                  )}
                  <button
                    onClick={() => {
                      const u = adTab?.actionUrl;
                      if (!u) return;
                      // 官方 deeplink：跳转到网易云客户端看广告领取。领券需易盾反作弊 token + 真实广告 reqId，
                      // 无法直接后端硬连（B3 已验证返回 400），故引导用户走官方路径。
                      // 注意：sandbox webview 的 window.open 会被 Tauri 拦截，orpheus:// 等自定义协议也不被
                      // webview 交给系统处理；必须经宿主 opener 命令（open_external_url）由系统拉起网易云客户端。
                      const host = window.__HOST_API__;
                      if (host && typeof host.invoke === 'function') {
                        Promise.resolve(host.invoke('open_external_url', { url: u })).catch((err: unknown) => {
                          console.warn('[music] 打开官方领券链接失败:', err);
                          alert('未检测到网易云桌面客户端，无法打开 orpheus:// 链接。请安装官方客户端后重试：https://music.163.com/download');
                        });
                      } else if (location) {
                        location.href = u;
                      }
                    }}
                    disabled={!adTab?.actionUrl}
                    className="btn-press w-full px-3 py-2 rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400 text-sm hover:bg-amber-500/25 transition-colors disabled:opacity-50"
                  >
                    {adTab?.actionTitle || '前往官方领取免费听'}
                  </button>
                  <div className="mt-1.5 text-[10px] text-neutral-400 dark:text-stone-500">
                    需安装网易云桌面客户端；点击将尝试唤起客户端观看广告领取。若提示“无法打开 orpheus 链接”，说明未安装客户端或协议未注册，请前往 https://music.163.com/download 安装。
                  </div>
                </div>

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

        {/* 歌手 / 专辑详情顶部抽屉（覆盖下方 80%，点击遮罩或返回关闭） */}
        {drawer.type !== 'none' && (
          <DetailDrawer
            drawer={drawer}
            onClose={closeDrawer}
            onPlayTracks={playTrackList}
            onPlayMv={handlePlayMv}
            onOpenArtist={openArtistDrawer}
            onOpenAlbum={openAlbumDrawer}
            onSubscribeAlbum={handleSubscribeAlbum}
            onLikeTrack={handleLike}
            likedSongs={likedSongs}
            loggedIn={loggedIn}
          />
        )}
      </div>
    </div>
  );

  // 漫游页主体：单曲沉浸展示（居中大封面 + 下方元数据），流式后台续推队列，不做列表式。
  function renderRoam() {
    if (loading) {
      return <div className="text-sm text-neutral-400 dark:text-stone-500 py-8 text-center">{T('music.loading') || '加载中…'}</div>;
    }
    if (error) {
      return <div className="text-sm text-red-500/80 dark:text-red-400/80 py-8 text-center">{error}</div>;
    }
    const cur = nowPlaying.track;
    const coverOf = (path?: string) => {
      if (!path) return null;
      if (/^https?:\/\//i.test(path)) return path;
      return window.__HOST_API__?.convertFileSrc(path) || path;
    };
    const curCover = coverOf(cur?.coverPath);
    // 当前展示单曲的 NeteaseTrack（含 artistId/albumId），用于开抽屉
    const curNetease = roamTrackListRef.current.find((t) => `netease-${t.id}` === cur?.id) || null;

    if (!cur) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <div className="w-40 h-40 rounded-3xl bg-[var(--element-muted)] text-[var(--element-bg)] flex items-center justify-center shadow-sm">
            <MusicIcon size={56} />
          </div>
          <div className="text-base font-semibold text-neutral-500 dark:text-stone-400">尚未开始漫游</div>
          <div className="text-sm text-neutral-400 dark:text-stone-500">进入漫游页将自动为你播放推荐</div>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center pt-6 pb-4">
        {/* 居中大封面 */}
        <div
          onClick={onOpenImmersive}
          className="relative w-56 h-56 rounded-3xl overflow-hidden shadow-lg ring-1 ring-black/10 dark:ring-white/10 cursor-pointer transition-transform hover:scale-[1.02]"
          title={T('music.player.immersive')}
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
              onClick={() => curNetease && openArtistDrawer(curNetease.artistId)}
              disabled={!curNetease?.artistId}
            >{cur.artist || '—'}</button>
            <span className="opacity-50">·</span>
            <button
              type="button"
              className="text-neutral-500 dark:text-stone-400 hover:text-emerald-500 dark:hover:text-emerald-400 hover:underline cursor-pointer"
              onClick={() => curNetease && openAlbumDrawer(curNetease.albumId)}
              disabled={!curNetease?.albumId}
            >{cur.album || '—'}</button>
          </div>

          {/* 扩展信息：音质徽章 + 时长 + 播放状态 */}
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

          {/* 歌曲百科（手机版网易云「歌曲百科」：发行时间 / 语种 / BPM / 乐器 / 曲风 / 乐谱） */}
          {curNetease && (() => {
            const w = roamWiki;
            if (!w) {
              return (
                <div className="mt-3 w-full text-[11px] text-neutral-400 dark:text-stone-500">
                  歌曲百科加载中…
                </div>
              );
            }
            type WikiItem = { label: string; value: string };
            const items: WikiItem[] = [];
            if (w.publishTime) items.push({ label: '发行时间', value: w.publishTime });
            if (w.language) items.push({ label: '语种', value: w.language });
            if (w.bpm) items.push({ label: 'BPM', value: String(w.bpm) });
            if (w.genres?.length) items.push({ label: '曲风', value: w.genres.join(' / ') });
            if (w.instruments?.length) items.push({ label: '乐器', value: w.instruments.join(' / ') });
            if (!items.length) return null;
            return (
              <div className="mt-4 w-full">
                <div className="text-[10px] uppercase tracking-wider text-neutral-400 dark:text-stone-500 mb-2 flex items-center gap-1.5">
                  <span className="inline-block w-1 h-3 rounded-sm bg-emerald-400/70" />
                  歌曲百科
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {items.map((it) => (
                    <div
                      key={it.label}
                      className="rounded-xl border border-neutral-200/60 dark:border-stone-700/60 bg-neutral-50/50 dark:bg-stone-800/40 px-3 py-2 text-left"
                    >
                      <div className="text-[10px] text-neutral-400 dark:text-stone-500">{it.label}</div>
                      <div className="text-sm font-medium text-neutral-700 dark:text-stone-200 mt-0.5 truncate">{it.value}</div>
                    </div>
                  ))}
                  {w.hasSheet && (
                    <div
                      key="sheet"
                      className="rounded-xl border border-emerald-300/50 dark:border-emerald-700/50 bg-emerald-50/40 dark:bg-emerald-900/15 px-3 py-2 text-left"
                    >
                      <div className="text-[10px] text-emerald-600/70 dark:text-emerald-400/70">乐谱</div>
                      <div className="text-sm font-medium text-emerald-700 dark:text-emerald-300 mt-0.5">
                        {w.sheetUrl ? (
                          <a href={w.sheetUrl} target="_blank" rel="noreferrer" className="hover:underline">查看官方乐谱</a>
                        ) : '已收录'}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* 关联 / 下一首预告 */}
          {(() => {
            const queue = musicPlayer.getTracks();
            const idx = musicPlayer.getCurrentIndex();
            const next = queue[idx + 1];
            return next ? (
              <div className="mt-4 w-full rounded-xl border border-neutral-200/60 dark:border-stone-700/60 bg-neutral-50/50 dark:bg-stone-800/40 p-3 text-left">
                <div className="text-[10px] uppercase tracking-wider text-neutral-400 dark:text-stone-500 mb-1">即将播放</div>
                <div className="flex items-center gap-3">
                  {next.coverPath ? (
                    <img src={coverOf(next.coverPath) || ''} alt="" className="w-10 h-10 rounded-lg object-cover shrink-0" />
                  ) : (
                    <span className="w-10 h-10 rounded-lg bg-neutral-200/60 dark:bg-stone-700/60 flex items-center justify-center shrink-0 text-neutral-400 dark:text-stone-500"><MusicIcon size={16} /></span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-neutral-800 dark:text-stone-100 truncate">{next.title}</div>
                    <div className="text-xs text-neutral-500 dark:text-stone-400 truncate">{next.artist}</div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-4 text-[11px] text-neutral-400 dark:text-stone-500">
                来自 漫游电台 · 根据你的口味推荐
              </div>
            );
          })()}
        </div>
      </div>
    );
  }

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
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('[data-action]')) return;
              handlePlayTrack(t);
            }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlePlayTrack(t); } }}
            className="group flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-neutral-200/50 dark:hover:bg-stone-800/50 active:bg-neutral-300/50 dark:active:bg-stone-700/50 transition-colors text-left cursor-pointer"
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
              <span className="block text-xs text-neutral-400 dark:text-stone-500 truncate">
                <button
                  type="button"
                  className="hover:text-emerald-500 dark:hover:text-emerald-400 hover:underline cursor-pointer"
                  onClick={(e) => { e.stopPropagation(); openArtistDrawer(t.artistId); }}
                  disabled={!t.artistId}
                >{t.artist}</button>
                <span className="opacity-50 mx-1">·</span>
                <button
                  type="button"
                  className="hover:text-emerald-500 dark:hover:text-emerald-400 hover:underline cursor-pointer"
                  onClick={(e) => { e.stopPropagation(); openAlbumDrawer(t.albumId); }}
                  disabled={!t.albumId}
                >{t.album}</button>
              </span>
            </span>
            <span className="text-xs text-neutral-400 dark:text-stone-500 shrink-0">{formatDuration(t.duration)}</span>
            {playingId === t.id && <PlayIcon size={14} />}
            {t.mvId ? (
              <button
                data-action="mv"
                onClick={(e) => handlePlayMv(e, t)}
                className="btn-jelly p-1.5 rounded-full text-neutral-400 dark:text-stone-500 hover:text-sky-500 dark:hover:text-sky-400 hover:bg-sky-500/10 transition-colors"
                title="播放 MV（跳转到玉兰）"
              >
                <VideoIcon size={15} />
              </button>
            ) : null}
            <button
              data-action="like"
              onClick={(e) => handleLike(e, t)}
              className="btn-jelly p-1.5 rounded-full text-neutral-400 dark:text-stone-500 hover:text-rose-500 dark:hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
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

// ====================================================================
// 歌手 / 专辑详情顶部抽屉（覆盖下方 80%，可滚动，点击遮罩 / 返回关闭）
// 对齐 MusicStorm 的 artist.tsx / album.tsx：歌手含热门歌 + 专辑 + MV + 简介 + 相似艺人；
// 专辑含曲目 + 播放全部 + 收藏 + 排序 + 视图切换。
// ====================================================================

type DetailDrawerProps = {
  drawer: { type: 'none' } | { type: 'artist'; id: number } | { type: 'album'; id: number };
  onClose: () => void;
  onPlayTracks: (list: NeteaseTrack[], startIndex: number, name?: string) => void;
  onPlayMv: (e: React.MouseEvent, t: NeteaseTrack) => void;
  onOpenArtist: (id?: number) => void;
  onOpenAlbum: (id?: number) => void;
  onSubscribeAlbum: (id: number, subscribe: boolean) => void;
  onLikeTrack: (e: React.MouseEvent | undefined, t: NeteaseTrack) => void;
  likedSongs?: Set<number> | null;
  loggedIn: boolean;
};

function DetailDrawer(props: DetailDrawerProps) {
  const { drawer, onClose, onPlayTracks, onPlayMv, onOpenArtist, onOpenAlbum, onSubscribeAlbum, onLikeTrack, likedSongs, loggedIn } = props;

  // ===== 抽屉开合动画 =====
  // mounted 控制真实挂载/卸载；visible 控制入场/退场 transition。
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const open = drawer.type !== 'none';

  useEffect(() => {
    if (open) {
      if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
      setMounted(true);
      const id = window.requestAnimationFrame(() => setVisible(true));
      return () => window.cancelAnimationFrame(id);
    } else if (mounted) {
      setVisible(false);
      closeTimer.current = window.setTimeout(() => setMounted(false), 280);
    }
    return undefined;
  }, [open, mounted]);

  const handleClose = useCallback(() => {
    setVisible(false);
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => { setMounted(false); onClose(); }, 280);
  }, [onClose]);

  // 抽屉内点击 MV：先解析播放地址，再用 props.onPlayMv 把已解析对象交给父组件（跨模块跳转玉兰）。
  // 注意：props.onPlayMv 的语义是「接收已解析 mv 对象」，而非 (e, t)，故不可在图标上直接 onPlayMv(e, t)。
  const [mvNotice, setMvNotice] = useState<string | null>(null);

  // 抽屉内 MV 按钮专用：从 DOM 的 data-mvid 读取 id，不依赖事件闭包（沙箱重渲染下闭包 t 偶发丢失，导致 t 为 undefined）。
  const playMvById = useCallback(async (e: React.MouseEvent | undefined, mvId: number) => {
    e?.stopPropagation?.();
    if (!mvId) {
      console.warn('[netease][mv] 缺失 mvId', mvId);
      return;
    }
    try {
      const mv = await getMvPlayable(mvId);
      if (!mv || !mv.url) {
        setMvNotice('该歌曲的 MV 暂不可用或获取失败');
        return;
      }
      onPlayMv?.({ id: mv.id, name: mv.name || '', artist: mv.artist || '', cover: mv.cover || '', url: mv.url });
    } catch (err: any) {
      setMvNotice(`MV 播放失败：${err?.message || String(err)}`);
    }
  }, [onPlayMv]);

  // ===== 歌手详情数据 =====
  const [artist, setArtist] = useState<NeteaseArtist | null>(null);
  const [hotSongs, setHotSongs] = useState<NeteaseTrack[]>([]);
  const [artistAlbums, setArtistAlbums] = useState<NeteaseArtistAlbum[]>([]);
  const [artistMvs, setArtistMvs] = useState<NeteaseMvItem[]>([]);
  const [artistDesc, setArtistDesc] = useState('');
  const [simiArtists, setSimiArtists] = useState<NeteaseSimilarArtist[]>([]);
  const [artistLoading, setArtistLoading] = useState(true);

  // 歌手全部歌曲（折叠展开 / 分页加载）
  const [allSongsOpen, setAllSongsOpen] = useState(false);
  const [allSongs, setAllSongs] = useState<NeteaseTrack[]>([]);
  const [allSongsLoading, setAllSongsLoading] = useState(false);
  const [allSongsOffset, setAllSongsOffset] = useState(0);
  const [allSongsMore, setAllSongsMore] = useState(false);
  const [allSongsDone, setAllSongsDone] = useState(false);

  // ===== 专辑详情数据 =====
  const [album, setAlbum] = useState<NeteaseAlbum | null>(null);
  const [albumTracks, setAlbumTracks] = useState<NeteaseTrack[]>([]);
  const [albumLoading, setAlbumLoading] = useState(true);
  const [albumSubed, setAlbumSubed] = useState(false);

  // ===== 专辑视图/排序状态 =====
  const [albumSort, setAlbumSort] = useState<'index' | 'duration' | 'title'>('index');
  const [albumView, setAlbumView] = useState<'list' | 'grid'>('list');

  const isArtist = drawer.type === 'artist';
  const targetId = drawer.type !== 'none' ? drawer.id : 0;

  // 进入 / 切换 target 时重置并拉取数据
  useEffect(() => {
    let cancelled = false;
    if (drawer.type === 'artist') {
      setArtistLoading(true);
      setArtist(null); setHotSongs([]); setArtistAlbums([]); setArtistMvs([]); setArtistDesc(''); setSimiArtists([]);
      setAllSongsOpen(false); setAllSongs([]); setAllSongsLoading(false); setAllSongsOffset(0); setAllSongsMore(false); setAllSongsDone(false);
      setMvNotice(null);
      Promise.all([
        getArtistDetail(drawer.id),
        getArtistAlbums(drawer.id, 0, 50),
        getArtistMvs(drawer.id, 0, 30),
        getArtistDesc(drawer.id),
        getSimilarArtists(drawer.id),
      ]).then(([d, al, mvs, desc, simi]) => {
        if (cancelled) return;
        if (d) { setArtist(d.artist); setHotSongs(d.hotSongs); }
        setArtistAlbums(al.albums);
        setArtistMvs(mvs.mvs);
        setArtistDesc(desc);
        setSimiArtists(simi);
        setArtistLoading(false);
      }).catch(() => { if (!cancelled) setArtistLoading(false); });
    } else if (drawer.type === 'album') {
      setAlbumLoading(true);
      setAlbum(null); setAlbumTracks([]); setAlbumSubed(false); setAlbumSort('index'); setAlbumView('list');
      getAlbumDetail(drawer.id).then((r) => {
        if (cancelled || !r) { if (!cancelled) setAlbumLoading(false); return; }
        setAlbum(r.album); setAlbumTracks(r.tracks); setAlbumSubed(!!r.album.subed);
        setAlbumLoading(false);
      }).catch(() => { if (!cancelled) setAlbumLoading(false); });
    }
    return () => { cancelled = true; };
  }, [drawer.type, targetId]);

  // 专辑曲目排序后的展示列表
  const sortedAlbumTracks = useMemo(() => {
    const arr = [...albumTracks];
    if (albumSort === 'duration') arr.sort((a, b) => a.duration - b.duration);
    else if (albumSort === 'title') arr.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    return arr;
  }, [albumTracks, albumSort]);

  const fmtCount = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n));

  // 加载歌手全部歌曲：首次展开拉第一页，之后分页追加；全部加载完标记 allSongsDone。
  const loadAllSongs = useCallback(async (reset: boolean) => {
    if (!artist || allSongsLoading || (allSongsDone && !reset)) return;
    const offset = reset ? 0 : allSongsOffset;
    setAllSongsLoading(true);
    const r = await getArtistAllSongs(artist.id, offset, 100, 'hot');
    setAllSongs((prev) => (reset ? r.tracks : [...prev, ...r.tracks]));
    setAllSongsOffset(offset + r.tracks.length);
    setAllSongsMore(r.more);
    if (!r.more) setAllSongsDone(true);
    setAllSongsLoading(false);
  }, [artist, allSongsLoading, allSongsOffset, allSongsDone]);

  const toggleAllSongs = useCallback(() => {
    setAllSongsOpen((prev) => {
      const next = !prev;
      if (next && allSongs.length === 0 && !allSongsDone) loadAllSongs(true);
      return next;
    });
  }, [allSongs.length, allSongsDone, loadAllSongs]);

  if (!mounted) return null;

  return (
    <div className="absolute inset-0 z-40">
      {/* 遮罩：点击关闭（带渐隐动画） */}
      <button
        aria-label="关闭详情"
        onClick={handleClose}
        className={`absolute inset-0 bg-black/40 backdrop-blur-[1px] transition-opacity duration-300 ease-out ${visible ? 'opacity-100' : 'opacity-0'}`}
      />
      {/* 顶部抽屉面板：覆盖下方 80%，可滚动（带下滑入场 / 上滑退场动画） */}
      <div
        className={`absolute left-0 right-0 top-0 h-[80%] rounded-b-3xl bg-white dark:bg-[#232323] shadow-2xl overflow-y-auto overscroll-contain transition-transform duration-300 ease-out will-change-transform ${visible ? 'translate-y-0' : '-translate-y-full'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部操作条：返回 + 标题 */}
        <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-3 bg-white/90 dark:bg-[#232323]/90 backdrop-blur border-b border-neutral-200/60 dark:border-stone-700/60">
          <button
            onClick={handleClose}
            className="btn-press flex items-center justify-center p-1.5 rounded-lg text-neutral-500 dark:text-stone-400 hover:bg-neutral-200/60 dark:hover:bg-stone-800/60 transition-colors"
            title="返回"
          >
            <ChevronLeft size={20} />
          </button>
          <span className="text-sm font-semibold text-neutral-800 dark:text-stone-100 truncate">
            {isArtist ? (artist?.name || '歌手详情') : (album?.name || '专辑详情')}
          </span>
        </div>

        {isArtist ? (
          // ================= 歌手详情 =================
          <div className="p-4 space-y-6">
            {artistLoading ? (
              <div className="text-sm text-neutral-400 dark:text-stone-500 py-10 text-center">加载中…</div>
            ) : !artist ? (
              <div className="text-sm text-red-500/80 dark:text-red-400/80 py-10 text-center">歌手信息加载失败</div>
            ) : (
              <>
                {/* 头部 */}
                <div className="flex gap-4 items-center">
                  {artist.cover ? (
                    <img src={artist.cover} alt={artist.name} className="w-24 h-24 rounded-2xl object-cover shadow-sm shrink-0" />
                  ) : (
                    <div className="w-24 h-24 rounded-2xl bg-neutral-200 dark:bg-stone-800 flex items-center justify-center text-3xl font-bold text-neutral-400 dark:text-stone-500 shrink-0">
                      {artist.name.slice(0, 1)}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <h2 className="text-2xl font-bold text-neutral-800 dark:text-stone-100 truncate">{artist.name}</h2>
                    {artist.alias && artist.alias.length > 0 && (
                      <div className="text-xs text-neutral-500 dark:text-stone-400 mt-0.5 truncate">{artist.alias.join(' / ')}</div>
                    )}
                    <div className="flex flex-wrap gap-3 mt-2 text-xs text-neutral-500 dark:text-stone-400">
                      <span>单曲 {fmtCount(artist.musicSize || 0)}</span>
                      <span>专辑 {fmtCount(artist.albumSize || 0)}</span>
                      <span>MV {fmtCount(artist.mvSize || 0)}</span>
                    </div>
                  </div>
                </div>

                {/* 热门歌曲 */}
                <section>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-semibold text-neutral-700 dark:text-stone-200">热门歌曲</h3>
                    {hotSongs.length > 0 && (
                      <button
                        onClick={() => onPlayTracks(hotSongs, 0, `${artist.name} 热门`)}
                        className="btn-press flex items-center gap-1 px-3 py-1 rounded-full bg-neutral-800 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-medium hover:bg-neutral-700 dark:hover:bg-stone-200 transition-colors"
                      >
                        <PlayIcon size={12} /> 播放全部
                      </button>
                    )}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {hotSongs.slice(0, 20).map((t, i) => (
                      <button
                        key={t.id}
                        onClick={() => onPlayTracks(hotSongs, i, `${artist.name} 热门`)}
                        className="group flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-neutral-200/50 dark:hover:bg-stone-800/50 transition-colors text-left"
                      >
                        <span className="w-5 text-xs text-neutral-400 dark:text-stone-500 text-right shrink-0">{i + 1}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm text-neutral-800 dark:text-stone-100 truncate">{t.name}</span>
                          <span className="block text-xs text-neutral-400 dark:text-stone-500 truncate">
                            <span
                              className="hover:text-emerald-500 dark:hover:text-emerald-400 hover:underline cursor-pointer"
                              onClick={(e) => { e.stopPropagation(); onOpenArtist(t.artistId); }}
                            >{t.artist}</span>
                            <span className="opacity-40 mx-1">·</span>
                            <span
                              className="hover:text-emerald-500 dark:hover:text-emerald-400 hover:underline cursor-pointer"
                              onClick={(e) => { e.stopPropagation(); onOpenAlbum(t.albumId); }}
                            >{t.album}</span>
                          </span>
                        </span>
                        <button
                          data-action="like"
                          onClick={(e) => onLikeTrack(e, t)}
                          className="btn-jelly p-1.5 rounded-full transition-colors shrink-0"
                          title={likedSongs?.has(t.id) ? '取消收藏' : '收藏到网易云「我喜欢的音乐」'}
                        >
                          <HeartIcon
                            size={14}
                            fill={likedSongs?.has(t.id) ? 'currentColor' : 'none'}
                            className={likedSongs?.has(t.id)
                              ? 'text-rose-500 dark:text-rose-400'
                              : 'text-neutral-400 dark:text-stone-500 hover:text-rose-500 dark:hover:text-rose-400'}
                          />
                        </button>
                        {t.mvId && (
                          <button
                            data-action="mv"
                            data-mvid={t.mvId}
                            onClick={(e) => playMvById(e, Number((e.currentTarget as HTMLElement).dataset.mvid))}
                            className="btn-jelly p-1.5 rounded-full text-neutral-400 dark:text-stone-500 hover:text-sky-500 dark:hover:text-sky-400 hover:bg-sky-500/10 transition-colors shrink-0"
                            title="播放 MV（跳转到玉兰）"
                          >
                            <VideoIcon size={14} />
                          </button>
                        )}
                      </button>
                    ))}
                  </div>
                </section>

                {/* 全部歌曲：折叠入口，展开后分页加载 */}
                <section>
                  <button
                    onClick={toggleAllSongs}
                    className="group flex w-full items-center justify-between mb-2 px-2 py-1.5 rounded-lg hover:bg-neutral-200/50 dark:hover:bg-stone-800/50 transition-colors"
                  >
                    <span className="text-sm font-semibold text-neutral-700 dark:text-stone-200">
                      全部歌曲{artist.musicSize ? `（${fmtCount(artist.musicSize)}）` : ''}
                    </span>
                    <ChevronRight
                      size={16}
                      className={`text-neutral-400 dark:text-stone-500 transition-transform duration-200 ${allSongsOpen ? 'rotate-90' : ''}`}
                    />
                  </button>
                  {allSongsOpen && (
                    <div className="flex flex-col gap-0.5">
                      {allSongs.length === 0 && allSongsLoading && (
                        <div className="text-xs text-neutral-400 dark:text-stone-500 py-4 text-center">加载中…</div>
                      )}
                      {allSongs.map((t, i) => (
                        <button
                          key={t.id}
                          onClick={() => onPlayTracks(allSongs, i, `${artist.name} 全部`)}
                          className="group flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-neutral-200/50 dark:hover:bg-stone-800/50 transition-colors text-left"
                        >
                          <span className="w-5 text-xs text-neutral-400 dark:text-stone-500 text-right shrink-0">{i + 1}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm text-neutral-800 dark:text-stone-100 truncate">{t.name}</span>
                            <span className="block text-xs text-neutral-400 dark:text-stone-500 truncate">
                              <span
                                className="hover:text-emerald-500 dark:hover:text-emerald-400 hover:underline cursor-pointer"
                                onClick={(e) => { e.stopPropagation(); onOpenArtist(t.artistId); }}
                              >{t.artist}</span>
                              <span className="opacity-40 mx-1">·</span>
                              <span
                                className="hover:text-emerald-500 dark:hover:text-emerald-400 hover:underline cursor-pointer"
                                onClick={(e) => { e.stopPropagation(); onOpenAlbum(t.albumId); }}
                              >{t.album}</span>
                            </span>
                          </span>
                          <button
                            data-action="like"
                            onClick={(e) => onLikeTrack(e, t)}
                            className="btn-jelly p-1.5 rounded-full transition-colors shrink-0"
                            title={likedSongs?.has(t.id) ? '取消收藏' : '收藏到网易云「我喜欢的音乐」'}
                          >
                            <HeartIcon
                              size={14}
                              fill={likedSongs?.has(t.id) ? 'currentColor' : 'none'}
                              className={likedSongs?.has(t.id)
                                ? 'text-rose-500 dark:text-rose-400'
                                : 'text-neutral-400 dark:text-stone-500 hover:text-rose-500 dark:hover:text-rose-400'}
                            />
                          </button>
                          {t.mvId && (
                            <button
                              data-action="mv"
                              data-mvid={t.mvId}
                              onClick={(e) => playMvById(e, Number((e.currentTarget as HTMLElement).dataset.mvid))}
                              className="btn-jelly p-1.5 rounded-full text-neutral-400 dark:text-stone-500 hover:text-sky-500 dark:hover:text-sky-400 hover:bg-sky-500/10 transition-colors shrink-0"
                              title="播放 MV（跳转到玉兰）"
                            >
                              <VideoIcon size={14} />
                            </button>
                          )}
                        </button>
                      ))}
                      {allSongsMore && !allSongsLoading && (
                        <button
                          onClick={() => loadAllSongs(false)}
                          className="btn-press mx-auto mt-2 px-4 py-1.5 rounded-full bg-neutral-200/70 dark:bg-stone-800/70 text-xs text-neutral-600 dark:text-stone-300 hover:bg-neutral-300/70 dark:hover:bg-stone-700/70 transition-colors"
                        >
                          加载更多
                        </button>
                      )}
                      {allSongsLoading && allSongs.length > 0 && (
                        <div className="text-xs text-neutral-400 dark:text-stone-500 py-3 text-center">加载中…</div>
                      )}
                    </div>
                  )}
                </section>

                {/* 专辑 */}
                {artistAlbums.length > 0 && (
                  <section>
                    <h3 className="text-sm font-semibold text-neutral-700 dark:text-stone-200 mb-2">专辑</h3>
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                      {artistAlbums.map((al) => (
                        <button key={al.id} onClick={() => onOpenAlbum(al.id)} className="text-left group" title={al.name}>
                          <div className="relative aspect-square rounded-xl overflow-hidden bg-neutral-200 dark:bg-stone-800 mb-1.5">
                            <img src={al.cover} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                          </div>
                          <div className="text-xs text-neutral-800 dark:text-stone-100 line-clamp-2 leading-tight min-h-[2em]">{al.name}</div>
                        </button>
                      ))}
                    </div>
                  </section>
                )}

                {/* MV */}
                {artistMvs.length > 0 && (
                  <section>
                    <h3 className="text-sm font-semibold text-neutral-700 dark:text-stone-200 mb-2">MV</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {artistMvs.map((m) => (
                        <div key={m.id} className="group cursor-pointer" onClick={(e) => playMvById(e, m.id)}>
                          <div className="relative aspect-video rounded-xl overflow-hidden bg-neutral-200 dark:bg-stone-800 mb-1.5">
                            <img src={m.cover} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                            <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                              <PlayIcon size={22} className="text-white" />
                            </div>
                            {m.playCount > 0 && (
                              <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/50 text-white text-[10px]">
                                {fmtCount(m.playCount)}
                              </div>
                            )}
                          </div>
                          <div className="text-xs text-neutral-800 dark:text-stone-100 line-clamp-2 leading-tight min-h-[2em]">{m.name}</div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {/* 简介 */}
                {artistDesc && (
                  <section>
                    <h3 className="text-sm font-semibold text-neutral-700 dark:text-stone-200 mb-2">歌手简介</h3>
                    <p className="text-xs text-neutral-500 dark:text-stone-400 whitespace-pre-wrap leading-relaxed">{artistDesc}</p>
                  </section>
                )}

                {/* 相似艺人 */}
                {simiArtists.length > 0 && (
                  <section>
                    <h3 className="text-sm font-semibold text-neutral-700 dark:text-stone-200 mb-2">相似艺人</h3>
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                      {simiArtists.map((a) => (
                        <button key={a.id} onClick={() => onOpenArtist(a.id)} className="text-left group" title={a.name}>
                          <div className="relative aspect-square rounded-full overflow-hidden bg-neutral-200 dark:bg-stone-800 mb-1.5">
                            <img src={a.cover} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                          </div>
                          <div className="text-xs text-neutral-800 dark:text-stone-100 text-center line-clamp-1">{a.name}</div>
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                {mvNotice && (
                  <div className="px-3 py-2 rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 text-xs">{mvNotice}</div>
                )}
              </>
            )}
          </div>
        ) : (
          // ================= 专辑详情 =================
          <div className="p-4 space-y-5">
            {albumLoading ? (
              <div className="text-sm text-neutral-400 dark:text-stone-500 py-10 text-center">加载中…</div>
            ) : !album ? (
              <div className="text-sm text-red-500/80 dark:text-red-400/80 py-10 text-center">专辑信息加载失败</div>
            ) : (
              <>
                {/* 头部 */}
                <div className="flex gap-4 items-center">
                  {album.cover ? (
                    <img src={album.cover} alt={album.name} className="w-24 h-24 rounded-2xl object-cover shadow-sm shrink-0" />
                  ) : (
                    <div className="w-24 h-24 rounded-2xl bg-neutral-200 dark:bg-stone-800 flex items-center justify-center text-3xl font-bold text-neutral-400 dark:text-stone-500 shrink-0">
                      {album.name.slice(0, 1)}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <h2 className="text-xl font-bold text-neutral-800 dark:text-stone-100 truncate">{album.name}</h2>
                    <button
                      onClick={() => onOpenArtist(album.artistId)}
                      className="text-xs text-neutral-500 dark:text-stone-400 mt-0.5 hover:text-emerald-500 dark:hover:text-emerald-400 hover:underline cursor-pointer"
                    >{album.artistName}</button>
                    <div className="text-xs text-neutral-500 dark:text-stone-400 mt-1 truncate">
                      {album.publishTime ? `${album.publishTime}` : ''}
                      {album.company ? ` · ${album.company}` : ''}
                      {album.size ? ` · ${album.size} 首` : ''}
                    </div>
                    {album.description && (
                      <p className="text-xs text-neutral-400 dark:text-stone-500 mt-1 line-clamp-2">{album.description}</p>
                    )}
                  </div>
                </div>

                {/* 操作栏：播放全部 + 收藏 + 排序 + 视图切换 */}
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => onPlayTracks(albumTracks, 0, album.name)}
                    className="btn-press flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-neutral-800 dark:bg-stone-100 text-white dark:text-stone-900 text-sm font-medium hover:bg-neutral-700 dark:hover:bg-stone-200 transition-colors"
                  >
                    <PlayIcon size={14} /> 播放全部
                  </button>
                  <button
                    onClick={() => { onSubscribeAlbum(album.id, !albumSubed); setAlbumSubed((v) => !v); }}
                    disabled={!loggedIn}
                    className="btn-press flex items-center gap-1.5 px-4 py-1.5 rounded-full border border-neutral-300 dark:border-stone-700 text-neutral-700 dark:text-stone-200 text-sm hover:bg-neutral-100 dark:hover:bg-stone-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title={loggedIn ? (albumSubed ? '取消收藏专辑' : '收藏专辑') : '请先登录'}
                  >
                    <HeartIcon size={14} fill={albumSubed ? 'currentColor' : 'none'} />
                    {albumSubed ? '已收藏' : '收藏'}
                  </button>

                  <div className="flex items-center gap-1 ml-auto">
                    {/* 排序 */}
                    <div className="flex items-center rounded-full bg-neutral-100 dark:bg-stone-800 p-0.5 text-xs">
                      {(['index', 'duration', 'title'] as const).map((s) => (
                        <button
                          key={s}
                          onClick={() => setAlbumSort(s)}
                          className={`px-2.5 py-1 rounded-full transition-colors ${albumSort === s ? 'bg-white dark:bg-stone-600 text-neutral-800 dark:text-stone-100 shadow-sm' : 'text-neutral-500 dark:text-stone-400'}`}
                        >{s === 'index' ? '默认' : s === 'duration' ? '时长' : '名称'}</button>
                      ))}
                    </div>
                    {/* 视图切换 */}
                    <div className="flex items-center rounded-full bg-neutral-100 dark:bg-stone-800 p-0.5 text-xs">
                      {(['list', 'grid'] as const).map((v) => (
                        <button
                          key={v}
                          onClick={() => setAlbumView(v)}
                          className={`px-2.5 py-1 rounded-full transition-colors ${albumView === v ? 'bg-white dark:bg-stone-600 text-neutral-800 dark:text-stone-100 shadow-sm' : 'text-neutral-500 dark:text-stone-400'}`}
                        >{v === 'list' ? '列表' : '网格'}</button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* 曲目列表 / 网格 */}
                {albumView === 'list' ? (
                  <div className="flex flex-col gap-0.5">
                    {sortedAlbumTracks.map((t, i) => (
                      <div
                        key={t.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => onPlayTracks(albumTracks, albumTracks.indexOf(t), album.name)}
                        className="group flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-neutral-200/50 dark:hover:bg-stone-800/50 transition-colors text-left cursor-pointer"
                      >
                        <span className="w-5 text-xs text-neutral-400 dark:text-stone-500 text-right shrink-0">
                          {albumSort === 'index' ? i + 1 : albumTracks.indexOf(t) + 1}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="block text-sm text-neutral-800 dark:text-stone-100 truncate">{t.name}</span>
                            {neteaseTrackBadges(t).map((b) => (
                              <span key={b.label} className={
                                'shrink-0 text-[9px] font-semibold leading-none px-1 py-0.5 rounded ' +
                                (b.kind === 'vip' ? 'text-amber-600 dark:text-amber-400 bg-amber-500/15'
                                  : b.kind === 'hires' ? 'text-fuchsia-600 dark:text-fuchsia-400 bg-fuchsia-500/15'
                                  : 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/15')
                              } title={b.label}>{b.label}</span>
                            ))}
                          </span>
                        </span>
                        <span className="text-xs text-neutral-400 dark:text-stone-500 shrink-0">{formatDuration(t.duration)}</span>
                        <button
                          data-action="like"
                          onClick={(e) => onLikeTrack(e, t)}
                          className="btn-jelly p-1.5 rounded-full transition-colors shrink-0"
                          title={likedSongs?.has(t.id) ? '取消收藏' : '收藏到网易云「我喜欢的音乐」'}
                        >
                          <HeartIcon
                            size={14}
                            fill={likedSongs?.has(t.id) ? 'currentColor' : 'none'}
                            className={likedSongs?.has(t.id)
                              ? 'text-rose-500 dark:text-rose-400'
                              : 'text-neutral-400 dark:text-stone-500 hover:text-rose-500 dark:hover:text-rose-400'}
                          />
                        </button>
                        {t.mvId && (
                          <button
                            data-action="mv"
                            data-mvid={t.mvId}
                            onClick={(e) => playMvById(e, Number((e.currentTarget as HTMLElement).dataset.mvid))}
                            className="btn-jelly p-1.5 rounded-full text-neutral-400 dark:text-stone-500 hover:text-sky-500 dark:hover:text-sky-400 hover:bg-sky-500/10 transition-colors shrink-0"
                            title="播放 MV（跳转到玉兰）"
                          >
                            <VideoIcon size={14} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                    {sortedAlbumTracks.map((t) => (
                      <button key={t.id} onClick={() => onPlayTracks(albumTracks, albumTracks.indexOf(t), album.name)} className="text-left group" title={t.name}>
                        <div className="relative aspect-square rounded-xl overflow-hidden bg-neutral-200 dark:bg-stone-800 mb-1.5">
                          <img src={t.cover || album.cover} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                          <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity">
                            <PlayIcon size={20} className="text-white" />
                          </div>
                        </div>
                        <div className="text-xs text-neutral-800 dark:text-stone-100 line-clamp-2 leading-tight min-h-[2em]">{t.name}</div>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
