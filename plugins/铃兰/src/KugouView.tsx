// 酷狗音乐视图（对齐 NeteaseView.tsx 范式）
//
// 复用 netease 的 props/handle 契约（PlayableTrack / TempPlaylist / NeteaseViewHandle 形状），
// 仅把数据源从 neteaseApi 换成 kugouApi。本视图覆盖：搜索、榜单浏览、歌单浏览、播放
// （取播放 URL 后通过 onPlay 交给 musicPlayer）。登录态/红心/账号等暂未实现（酷狗游客态
// 已可搜索+试听+歌词），后续如需会员无损再补扫码登录。

import React from 'react';
const { useState, useEffect, useRef } = React;
import { MusicIcon, PlayIcon, SearchIcon, Sparkles, UserIcon, LibraryIcon, HeartIcon, VideoIcon, DownloadIcon } from 'lucide-react';
import { ArrowLeftIcon } from '../../_shared/icons';
import { T } from '../../_shared/pluginRuntime';
import {
  type KugouAuth,
  type KugouProfile,
  type KugouTrack,
  type KugouPlaylistCard,
  getFavorites,
  getUserPlaylists,
  getKugouVipInfo,
  type KugouVipInfo,
  safeImg,
  searchSongs,
  getSongUrl,
  downloadKugouTrack,
  getTopList,
  getPlaylist,
  getPlaylistByGid,
  getPlaylistBySpecialId,
  getEverydayRecommend,
  getRankList,
  getRecommendPlaylists,
  getMvUrl,
  getArtistDetail,
  getAlbumDetail,
  searchSingerId,
  qualityLabelFromBr,
} from './kugouApi';
import {
  kugouQrCreate,
  kugouQrCheck,
  readKugouAuth,
  logoutKugou,
  fetchKugouProfile,
} from './kugouAuth';
import { musicPlayer, Track } from './musicPlayer';
import { PlayableTrack, TempPlaylist, NeteaseViewHandle } from './NeteaseView';
import { MusicHeader } from './MusicHeader';
import { PlaylistDetailHeader } from '@shared/OnlineMusicTemplates';
import { TrackRow, type TrackBadge } from './_shared/TrackRow';
import { DetailDrawer, type SharedDrawerType, type SharedArtistData, type SharedAlbumData } from './_shared/DetailDrawer';

type KugouTab = 'home' | 'roam' | 'search' | 'mine';

interface KugouViewProps {
  initialTab: KugouTab;
  onBack: () => void;
  onPlay: (tracks: PlayableTrack[], startIndex: number, sourceName: string) => void;
  onTempPlaylist?: (temp: TempPlaylist) => void;
  onActivePlaylist?: (id: number) => void;
  // 受控榜单：侧栏选中后通过 props 驱动视图切换
  selectedRankId?: number | null;
  onRankListLoaded?: (ranks: KugouPlaylistCard[]) => void;
  onActiveRankChange?: (id: number | null) => void;
  // 登录态变化通知外层（用于侧栏切「我的」入口）
  onAuthChange?: (auth: KugouAuth | null) => void;
  // 侧栏搜索框的关键词（与父级共享的 searchQuery）。KugouView 内部再配合 keyword 状态做搜索。
  searchQuery?: string;
  // 内部 tab 变化时同步给父组件，避免“返回热榜”后父组件仍停留在 mine/search 导致抽屉重复点击失效。
  onTabChange?: (tab: KugouTab) => void;
  // 本地收藏（与网易云红心并列的通用本地收藏）：行内红心按钮
  favoriteIds?: Set<string>;
  onToggleFavorite?: (track: PlayableTrack) => void;
  // 播放 MV：解析到直链后交给父组件（复用网易云跳转玉兰链路）
  onPlayMv?: (mv: { id: string; name: string; artist: string; cover: string; url: string }) => void;
}

// 为你推荐 / 热榜卡片（正方形封面 + 标题 + 数量）
function RankCard({
  rank,
  size = 'md',
  onClick,
}: {
  rank: KugouPlaylistCard;
  size?: 'md' | 'lg';
  onClick: () => void;
}) {
  const isLg = size === 'lg';
  return (
    <button
      onClick={onClick}
      className={`btn-press flex flex-col gap-2 text-left group shrink-0 ${isLg ? 'w-44' : 'w-32'}`}
    >
      <div
        className={`relative w-full overflow-hidden rounded-2xl bg-neutral-200/60 dark:bg-stone-700/60 ${
          isLg ? 'aspect-[16/10]' : 'aspect-square'
        }`}
      >
        {rank.cover ? (
          <img
            src={rank.cover}
            alt=""
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <MusicIcon size={isLg ? 32 : 20} className="text-neutral-400 dark:text-stone-500" />
          </div>
        )}
      </div>
      <div className="min-w-0">
        <div className={`font-medium truncate text-neutral-800 dark:text-stone-100 ${isLg ? 'text-sm' : 'text-xs'}`}>
          {rank.name}
        </div>
        {rank.playCount != null ? (
          <div className="text-[10px] text-neutral-400 dark:text-stone-500 truncate">
            {rank.playCount} 播放
          </div>
        ) : null}
      </div>
    </button>
  );
}

// Hero 大卡：带渐变遮罩的横幅推荐位
function HeroCard({ rank, onClick, onPlayAll }: { rank: KugouPlaylistCard; onClick: () => void; onPlayAll: () => void }) {
  return (
    <div
      onClick={onClick}
      className="relative w-full h-48 rounded-3xl overflow-hidden cursor-pointer group btn-press"
    >
      {rank.cover ? (
        <>
          <img
            src={rank.cover}
            alt=""
            className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
        </>
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-orange-400 to-pink-500" />
      )}
      <div className="absolute inset-x-0 bottom-0 p-5 flex items-end justify-between">
        <div className="min-w-0">
          <div className="text-xs text-white/80 mb-1">为你精选</div>
          <div className="text-lg font-bold text-white truncate">{rank.name}</div>
          <div className="text-xs text-white/70 truncate">
            {rank.playCount != null ? `${rank.playCount} 播放 · ` : ''}今日推荐
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onPlayAll();
          }}
          className="btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/20 hover:bg-white/30 text-white text-xs backdrop-blur-sm transition-colors shrink-0"
        >
          <PlayIcon size={14} />
          播放全部
        </button>
      </div>
    </div>
  );
}

// 我的：游客态提示页（对齐网易云"我的"登录态；登录后可看收藏 / 歌单）
// 我的：真实扫码登录 + 登录态（收藏 / 歌单 / 退出）
function MineView({ onBack, onAuthChange }: { onBack: () => void; onAuthChange?: (auth: KugouAuth | null) => void }) {
  const [auth, setAuth] = useState<KugouAuth | null>(() => readKugouAuth());
  const [profile, setProfile] = useState<KugouProfile | null>(null);
  const [qrImg, setQrImg] = useState('');
  const [qrStatus, setQrStatus] = useState('');
  const [qrLoading, setQrLoading] = useState(false);
  const [favs, setFavs] = useState<KugouTrack[]>([]);
  const [playlists, setPlaylists] = useState<KugouPlaylistCard[]>([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState('');
  const [vipInfo, setVipInfo] = useState<KugouVipInfo | null>(null);
  const pollRef = useRef<number | null>(null);
  const reqRef = useRef(0);

  // 已登录：拉取用户资料 + 收藏 + 歌单。
  // 依赖用 auth?.userid（而非 auth 引用）：fetchKugouProfile 每次返回新对象，
  // 若依赖 auth 引用会无限自循环重跑，导致每秒几百次 onAuthChange 回调把 Rust/代理打爆。
  // 用 debug_log（Rust 转发，日志面板可靠可见）代替 console.log 做关键节点埋点。
  const dlog = (msg: string) => {
    try { window.__HOST_API__?.invoke('debug_log', { msg: `[music-mine] ${msg}` }).catch(() => {}); } catch {}
  };
  useEffect(() => {
    const uid = auth?.userid;
    dlog(`effect run, uid=${uid}`);
    if (!uid) {
      setDataLoading(false);
      setDataError('');
      setProfile(null);
      setFavs([]);
      setPlaylists([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setDataLoading(true);
      setDataError('');
      try {
        // 前端 12s 兜底覆盖整段（含 fetchKugouProfile）：
        // 之前只包 getFavorites/getUserPlaylists，若 fetchKugouProfile 在 Rust 代理层挂起，
        // 会永远 loading（已复现：effect 跑后无 profile done 日志）。
        const { profile: p, auth: a } = await Promise.race([
          fetchKugouProfile(auth!),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('加载超时，请重试')), 12000),
          ),
        ]);
        if (cancelled) return;
        setProfile(p);
        setAuth(a);
        onAuthChange?.(a);
        dlog('profile done, fetching favs+playlists');
        getKugouVipInfo(a).then((v) => { if (!cancelled) setVipInfo(v); }).catch(() => {});

        // getFavorites 内部已拉取全量歌单并返回 { list, playlists }，避免双重请求。
        const favs = await Promise.race([
          getFavorites(a),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('加载超时，请重试')), 15000),
          ),
        ]);
        if (cancelled) return;
        setFavs(favs.list);
        setPlaylists(favs.playlists);
        dlog(`favs=${favs.list.length} playlists=${favs.playlists.length}`);
      } catch (e: any) {
        dlog('MineView catch: ' + (e?.message || e));
        if (!cancelled) setDataError('加载失败：' + (e?.message || e));
      } finally {
        // 不用 loadedUserRef 永久守卫跳过收尾：StrictMode 下首个被取消的实例若跳过
        // setDataLoading(false)，会导致「加载中」永久卡住（已复现）。这里仅由未被取消的
        // 实例负责收尾即可。
        if (!cancelled) setDataLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [auth?.userid]);

  useEffect(() => () => {
    if (pollRef.current) window.clearInterval(pollRef.current);
  }, []);

  async function startQrLogin() {
    setQrLoading(true);
    setQrImg('');
    setQrStatus('正在生成二维码…');
    try {
      const session = await kugouQrCreate();
      setQrImg(session.img || '');
      setQrStatus('请用酷狗 App 扫码登录');
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        try {
          const r = await kugouQrCheck(session.qrcode);
          if (r.status === 'ok' && r.auth) {
            if (pollRef.current) window.clearInterval(pollRef.current);
            setQrImg('');
            setQrStatus('登录成功！');
            setAuth(r.auth);
            onAuthChange?.(r.auth);
          } else if (r.status === 'expired') {
            if (pollRef.current) window.clearInterval(pollRef.current);
            setQrImg('');
            setQrStatus('二维码已过期，请重新点击登录');
          } else if (r.status === 'denied') {
            if (pollRef.current) window.clearInterval(pollRef.current);
            setQrImg('');
            setQrStatus('已拒绝登录');
          } else if (r.status === 'scanned') {
            setQrStatus('已扫描，请在手机上确认');
          }
        } catch (e: any) {
          if (pollRef.current) window.clearInterval(pollRef.current);
          setQrStatus('轮询失败：' + String(e?.message || e));
        }
      }, 2000);
    } catch (e: any) {
      setQrStatus('生成失败：' + String(e?.message || e));
    } finally {
      setQrLoading(false);
    }
  }

  function handleLogout() {
    logoutKugou();
    setAuth(null);
    setProfile(null);
    setFavs([]);
    setPlaylists([]);
    onAuthChange?.(null);
  }

  // ===== 已登录态 =====
  if (auth) {
    return (
      <div className="flex-1 overflow-y-auto min-h-0 px-4 pb-6">
        <div className="max-w-md mx-auto flex flex-col gap-5 py-6">
          {/* 用户信息卡（对齐网易云“我的”页） */}
          <div className="flex flex-col items-center gap-3 p-5 rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60">
            {safeImg(profile?.avatar) ? (
              <img src={safeImg(profile?.avatar)} alt="" className="w-20 h-20 rounded-full object-cover border-2 border-white dark:border-stone-700 shadow-sm" />
            ) : (
              <div className="w-20 h-20 rounded-full bg-orange-500/15 flex items-center justify-center text-orange-600 dark:text-orange-400 text-2xl font-bold">
                {(profile?.nickname || auth.nickname || '酷').slice(0, 1)}
              </div>
            )}
            <div className="text-center">
              <div className="flex items-center justify-center gap-2">
                <span className="text-lg font-semibold text-neutral-800 dark:text-stone-100">{profile?.nickname || auth.nickname || '酷狗用户'}</span>
                {auth.vipType ? (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20">VIP</span>
                ) : null}
              </div>
              {profile?.signature ? (
                <div className="mt-1 text-xs text-neutral-500 dark:text-stone-400 max-w-[260px] truncate">{profile.signature}</div>
              ) : null}
              <div className="mt-2 text-[10px] text-neutral-400 dark:text-stone-500">ID: {auth.userid}</div>
            </div>
          </div>

          {/* 会员状态（对齐网易云“我的”页） */}
          <div className="p-4 rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60">
            <h3 className="text-sm font-semibold text-neutral-800 dark:text-stone-100 mb-2">会员状态</h3>
            {vipInfo == null ? (
              <div className="text-xs text-neutral-400 dark:text-stone-500">查询中…</div>
            ) : vipInfo.isVip ? (
              <div className="flex flex-col gap-1.5 text-xs text-neutral-600 dark:text-stone-300">
                <div className="flex items-center justify-between">
                  <span>{vipInfo.vipName || '酷狗VIP'}</span>
                  <span className="font-medium text-amber-600 dark:text-amber-400">
                    {vipInfo.expireTime
                      ? `至 ${new Date(vipInfo.expireTime * 1000).toLocaleDateString()}`
                      : '已开通'}
                  </span>
                </div>
                <div className="text-[10px] text-neutral-400 dark:text-stone-500">
                  已启用免费听：VIP/付费歌曲按酷狗规则走免费试听通道
                </div>
              </div>
            ) : (
              <div className="text-xs text-neutral-400 dark:text-stone-500">当前账号无会员</div>
            )}
          </div>

          {/* 我喜欢的音乐：只显示数量 */}
          <div className="flex items-center justify-between rounded-2xl bg-neutral-100/60 dark:bg-stone-800/40 px-4 py-3">
            <h3 className="text-sm font-semibold text-neutral-700 dark:text-stone-200">{T('music.kugou.mineFavs') || '我喜欢的音乐'}</h3>
            <span className="text-xs text-neutral-400 dark:text-stone-500">{dataLoading ? '…' : `${favs.length} 首`}</span>
          </div>

          {/* 歌单：只显示数量，具体歌单在左侧侧边栏 */}
          <div className="flex items-center justify-between rounded-2xl bg-neutral-100/60 dark:bg-stone-800/40 px-4 py-3">
            <h3 className="text-sm font-semibold text-neutral-700 dark:text-stone-200">{T('music.kugou.minePlaylists') || '我的歌单'}</h3>
            <span className="text-xs text-neutral-400 dark:text-stone-500">{dataLoading ? '…' : `${playlists.length} 个`}</span>
          </div>

          <div className="flex items-center justify-center gap-3">
            <button onClick={handleLogout} className="btn-press px-4 py-2 rounded-xl bg-red-500/10 text-red-600 dark:text-red-400 text-sm hover:bg-red-500/20 transition-colors">
              {T('music.kugou.mineLogout') || '退出登录'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ===== 游客态：扫码登录 =====
  return (
    <div className="flex-1 overflow-y-auto min-h-0 px-4 pb-6">
      <div className="max-w-sm mx-auto flex flex-col items-center gap-4 py-10 text-center">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-orange-400 to-amber-500 flex items-center justify-center text-white shadow-lg">
          <UserIcon size={30} />
        </div>
        <div className="text-base font-semibold text-neutral-800 dark:text-stone-100">{T('music.kugou.mineLoginTitle') || '登录酷狗音乐'}</div>
        <div className="text-xs text-neutral-400 dark:text-stone-500 max-w-xs">{T('music.kugou.mineLoginDesc') || '扫码登录后可同步收藏、歌单与播放记录'}</div>
      </div>

      {qrImg ? (
        <div className="max-w-sm mx-auto flex flex-col items-center gap-4 p-6 rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60">
          <h2 className="text-base font-semibold text-neutral-800 dark:text-stone-100">{T('music.kugou.mineScanTitle') || '扫码登录酷狗'}</h2>
          <img src={qrImg} alt="登录二维码" className="w-48 h-48 rounded-xl bg-white p-2" />
          <div className="text-sm text-neutral-500 dark:text-stone-400 text-center min-h-[1.5em]">{qrStatus}</div>
          <button onClick={startQrLogin} className="btn-press px-4 py-1.5 rounded-lg bg-neutral-200/60 dark:bg-stone-800/60 text-sm text-neutral-700 dark:text-stone-200 hover:bg-neutral-300/60 dark:hover:bg-stone-700/60 transition-colors">
            {T('music.kugou.mineRefreshQr') || '刷新二维码'}
          </button>
        </div>
      ) : (
        <div className="max-w-sm mx-auto flex flex-col items-center gap-4 p-8 rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60">
          <button
            onClick={startQrLogin}
            disabled={qrLoading}
            className="btn-press w-full px-5 py-2.5 rounded-xl bg-orange-500 text-white text-sm font-medium hover:bg-orange-600 transition-colors disabled:opacity-50"
          >
            {qrLoading ? (T('music.kugou.mineGenQr') || '生成中…') : (T('music.kugou.mineStartQr') || '立即扫码登录')}
          </button>
          <div className="text-xs text-neutral-400 dark:text-stone-500 text-center min-h-[1.2em]">{qrStatus}</div>
        </div>
      )}
    </div>
  );
}

// 把 KugouTrack 转成可直接播放的 PlayableTrack（url 需先经 getSongUrl 取）
function trackToPlayable(t: KugouTrack, url: string, quality = ''): PlayableTrack {
  return {
    id: `kugou-${t.id}`,
    filePath: url,
    title: t.name,
    artist: t.artist,
    album: t.album,
    durationSecs: Math.round((t.duration || 0) / 1000),
    coverPath: t.cover,
    quality,
    hash: t.hash,
    mixsongid: t.mixsongid,
    albumId: t.albumId,
  };
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export const KugouView = React.forwardRef<NeteaseViewHandle, KugouViewProps>(function KugouView(
  { initialTab, onBack, onPlay, onTempPlaylist, onActivePlaylist, selectedRankId, onRankListLoaded, onActiveRankChange, onAuthChange, searchQuery, onTabChange, favoriteIds, onToggleFavorite, onPlayMv },
  ref,
) {
  const [tab, setTab] = useState<KugouTab>(initialTab);
  const [kugouAuth, setKugouAuthState] = useState<KugouAuth | null>(() => readKugouAuth());
  const [kugouVipInfo, setKugouVipInfo] = useState<KugouVipInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tracks, setTracks] = useState<KugouTrack[]>([]);
  const [keyword, setKeyword] = useState('');
  const [playingId, setPlayingId] = useState<string | null>(null);
  const reqRef = useRef(0);
  const allTracksRef = useRef<KugouTrack[]>([]);
  const [rankList, setRankList] = useState<KugouPlaylistCard[]>([]);
  const [recommendPlaylists, setRecommendPlaylists] = useState<KugouPlaylistCard[]>([]);
  const [recommendTracks, setRecommendTracks] = useState<KugouTrack[]>([]);
  const [activeRankId, setActiveRankId] = useState<number | null>(null);
  const [playlistMode, setPlaylistMode] = useState<{ id: string; name: string; cover?: string | null } | null>(null);
  const [homeHeroTracks, setHomeHeroTracks] = useState<KugouTrack[]>([]);
  const [homeHeroLoading, setHomeHeroLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const pageRef = useRef(1);
  // 歌手/专辑详情抽屉
  const [drawer, setDrawer] = useState<SharedDrawerType>({ type: 'none' });
  const [drawerArtist, setDrawerArtist] = useState<SharedArtistData | null>(null);
  const [drawerAlbum, setDrawerAlbum] = useState<SharedAlbumData | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);

  // 统一切 tab：内部状态与父级 kugouTab 保持同步。
  const changeTab = (next: KugouTab) => {
    setTab(next);
    onTabChange?.(next);
  };

  // 父组件（模块抽屉/侧栏「我的」）通过 initialTab 控制酷狗子页面。
  // 之前只 useState(initialTab) 初始化，Kugou 已打开后再点抽屉里的「搜索/漫游/我的」不会切页，
  // 必须像 NeteaseView 一样用 effect 同步 prop。
  React.useEffect(() => {
    changeTab(initialTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab]);

  // 登录态变化同步到顶部栏（扫码登录成功会派发 kugou-auth-changed）
  React.useEffect(() => {
    const handler = () => setKugouAuthState(readKugouAuth());
    window.addEventListener('kugou-auth-changed', handler);
    return () => window.removeEventListener('kugou-auth-changed', handler);
  }, []);

  // 登录态变化时拉取 VIP 信息，用于顶栏徽章与播放逻辑
  React.useEffect(() => {
    if (!kugouAuth?.userid) { setKugouVipInfo(null); return; }
    getKugouVipInfo(kugouAuth).then(setKugouVipInfo).catch(() => {});
  }, [kugouAuth?.userid]);

  // 侧栏「我的歌单」/推荐歌单打开：优先按 global_collection_id 拉取，失败回退 specialid
  const openUserPlaylist = async (pl: { id: string | number; gid?: string | null; name: string; cover?: string | null }) => {
    setLoading(true);
    setError('');
    try {
      let list: KugouTrack[] = [];
      if (pl.gid && String(pl.gid).trim()) {
        try {
          list = await getPlaylistByGid(String(pl.gid), 1, 200);
        } catch (firstErr: any) {
          console.warn('[Kugou] gid 打开失败，回退 specialid:', firstErr?.message || firstErr);
        }
      }
      if (!list.length && pl.id) {
        try {
          list = await getPlaylistBySpecialId(Number(pl.id), 1, 200);
        } catch (secondErr: any) {
          console.warn('[Kugou] specialid 兜底也失败:', secondErr?.message || secondErr);
        }
      }
      if (!list.length) {
        throw new Error('该歌单暂无歌曲或 ID 类型不匹配');
      }
      allTracksRef.current = list;
      setTracks(list);
      setHasMore(false);
      setLoadingMore(false);
      setActiveRankId(null);
      setPlaylistMode({ id: String(pl.gid || pl.id), name: pl.name, cover: pl.cover });
      changeTab('home');
    } catch (e: any) {
      setError('歌单加载失败：' + (e?.message || e));
    } finally {
      setLoading(false);
    }
  };

  // 暴露命令式方法给侧栏（临时歌单恢复播放 / 我的歌单打开）
  React.useImperativeHandle(ref, () => ({
    openPlaylist: (id: number, name: string) => { void openUserPlaylist({ id, name, gid: null, cover: null }); },
    restoreTemp: (payload: any) => {
      if (!payload?.tracks?.length) return;
      musicPlayer.setTracks(payload.tracks, 0);
      musicPlayer.play();
      musicPlayer.currentPlaylistId = payload.id ?? 'kugou-active';
      // 同步主视图：搜索临时歌单切回搜索页并重新拉结果；推荐/榜单临时歌单切回热榜。
      const inner = payload.payload && typeof payload.payload === 'object' ? payload.payload : payload;
      if (inner.kind === 'search') {
        setKeyword(payload.keyword || '');
        changeTab('search');
        setActiveRankId(null);
        if (payload.keyword) void doSearch(payload.keyword);
      } else if (inner.kind === 'recommend') {
        changeTab('home');
        setActiveRankId(null);
      }
    },
  }));

  // 榜单列表（飙升/热歌/新歌等）
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ranks = await getRankList();
        if (cancelled) return;
        setRankList(ranks);
        onRankListLoaded?.(ranks);
        // 首页默认预加载第一个榜单作为 Hero，供「播放全部」使用
        if (ranks.length) {
          loadHomeHero(ranks[0].id);
        }
      } catch (e: any) {
        if (!cancelled) setError('榜单加载失败：' + (e?.message || e));
      }
      // 个性化推荐（猜你喜欢）与榜单并行加载，游客态回落热门歌单
      loadRecommend();
      // 推荐歌单（m.kugou.com/plist/index，免签名直连）
      getRecommendPlaylists(1, 20).then(setRecommendPlaylists).catch(() => {});
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 预加载首页 Hero 榜单曲目（不切换 tab、不进入详情，仅用于「播放全部」）
  async function loadHomeHero(rankId: number) {
    if (!rankId) return;
    setHomeHeroLoading(true);
    try {
      const list = await getTopList(rankId, 1, 30);
      setHomeHeroTracks(list);
    } catch (e: any) {
      console.warn('[Kugou] 首页 Hero 榜单加载失败:', e);
    } finally {
      setHomeHeroLoading(false);
    }
  }

  // Hero 榜单曲目加载完后，如果推荐列表仍空（getEverydayRecommend 失败），
  // 用 heroTracks 填充推荐列表，保证首页有歌曲流。
  React.useEffect(() => {
    if (homeHeroTracks.length > 0 && recommendTracks.length === 0) {
      setRecommendTracks(homeHeroTracks.slice(0, 20));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeHeroTracks]);

  // 进入某个榜单详情
  function openRank(rankId: number) {
    loadRank(rankId);
  }

  // 侧栏驱动榜单切换：selectedRankId 变化时自动加载对应榜单
  React.useEffect(() => {
    if (selectedRankId != null && selectedRankId !== activeRankId) {
      setActiveRankId(selectedRankId);
      onActiveRankChange?.(selectedRankId);
      loadRank(selectedRankId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRankId]);

  // 重新拉取榜单列表并预加载 Hero 曲目（错误重试兜底用，不自动进入详情）
  async function reloadRankList() {
    try {
      const ranks = await getRankList();
      setRankList(ranks);
      onRankListLoaded?.(ranks);
      if (ranks.length) {
        loadHomeHero(ranks[0].id);
      }
    } catch (e: any) {
      setError('榜单加载失败：' + (e?.message || e));
    }
  }

  // 个性化推荐：每日推荐歌曲（登录更精准、游客也可用），失败时降级到榜单热门歌曲。
  async function loadRecommend() {
    try {
      const list = await getEverydayRecommend(kugouAuth, 1, 20);
      if (list.length) {
        setRecommendTracks(list);
        return;
      }
      // 空列表降级
      throw new Error('empty list');
    } catch (e: any) {
      console.warn('[Kugou] 个性化推荐失败，降级榜单热门:', e?.message || e);
      // 降级：取第一个榜单（TOP500）的前 20 首作为推荐
      try {
        if (rankList.length) {
          const fallback = await getTopList(rankList[0].id, 1, 20);
          if (fallback.length) {
            setRecommendTracks(fallback);
            return;
          }
        }
        // rankList 还没加载，用预加载的 homeHeroTracks
        if (homeHeroTracks.length) {
          setRecommendTracks(homeHeroTracks.slice(0, 20));
        }
      } catch (e2: any) {
        console.warn('[Kugou] 榜单降级也失败:', e2?.message || e2);
      }
    }
  }

  async function loadRank(rankId: number) {
    const req = ++reqRef.current;
    setLoading(true);
    setError('');
    setActiveRankId(rankId);
    onActivePlaylist?.(rankId);
    onActiveRankChange?.(rankId);
    try {
      // 15s 防御超时：防止 Rust 代理在网络层挂起时整个内容区永久「加载中」遮罩。
      const list = await Promise.race([
        getTopList(rankId, 1, 30),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('榜单加载超时，请重试')), 15000),
        ),
      ]);
      if (req !== reqRef.current) return;
      allTracksRef.current = list;
      setTracks(list);
      pageRef.current = 1;
      setHasMore(list.length >= 30);
      setLoadingMore(false);
    } catch (e: any) {
      if (req === reqRef.current) setError('榜单加载失败：' + (e?.message || e));
    } finally {
      if (req === reqRef.current) setLoading(false);
    }
  }

  async function doSearch(kwOverride?: string) {
    const kw = String(kwOverride ?? keyword ?? '').trim();
    if (!kw) return;
    const req = ++reqRef.current;
    setLoading(true);
    setError('');
    try {
      // 15s 防御超时：防止 Rust 代理挂起时永久「加载中」遮罩。
      const list = await Promise.race([
        searchSongs(kw, 30, 1),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('搜索超时，请重试')), 15000),
        ),
      ]);
      if (req !== reqRef.current) return;
      allTracksRef.current = list;
      setTracks(list);
      pageRef.current = 1;
      setHasMore(list.length >= 30);
      setLoadingMore(false);
    } catch (e: any) {
      if (req === reqRef.current) setError('搜索失败：' + (e?.message || e));
    } finally {
      if (req === reqRef.current) setLoading(false);
    }
  }

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    const next = pageRef.current + 1;
    setLoadingMore(true);
    try {
      const list = tab === 'search'
        ? await searchSongs(keyword, 30, next)
        : activeRankId != null
          ? await getTopList(activeRankId, next, 30)
          : [];
      pageRef.current = next;
      setTracks((prev) => {
        const seen = new Set(prev.map((t) => t.id));
        const merged = [...prev, ...list.filter((t) => !seen.has(t.id))];
        allTracksRef.current = merged;
        return merged;
      });
      setHasMore(list.length >= 30);
    } catch (e: any) {
      setError('加载更多失败：' + (e?.message || e));
    } finally {
      setLoadingMore(false);
    }
  }

  // 侧栏搜索框输入时，父组件把全局 searchQuery 传下来并切到 search tab。
  // 这里同步到内部 keyword，并做 400ms 防抖自动搜索（与本地侧栏搜索的“过滤”语义不同，
  // 酷狗侧栏搜索需要真正调用 searchSongs）。
  React.useEffect(() => {
    if (searchQuery === undefined) return;
    const q = String(searchQuery ?? '');
    setKeyword(q);
    if (!q.trim()) {
      // 侧栏搜索框清空时，同步清掉旧搜索结果，避免空关键词下仍展示上一轮结果。
      allTracksRef.current = [];
      setTracks([]);
      setHasMore(false);
      setLoadingMore(false);
      return;
    }
    changeTab('search');
    setActiveRankId(null);
    onActiveRankChange?.(null);
    const timer = setTimeout(() => {
      void doSearch(q);
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  function currentQuality(): 'standard' | 'high' | 'lossless' {
    try {
      const v = localStorage.getItem('kugou.playQuality');
      if (v === 'high' || v === 'lossless') return v;
    } catch { /* ignore */ }
    return 'standard';
  }

  function isFav(t: KugouTrack): boolean {
    return !!favoriteIds?.has(`kugou-${t.id}`);
  }

  // 在抽屉曲目里按 id 找完整 PlayableTrack（含 hash），供红心云端写使用
  function findDrawerTrack(id: string): PlayableTrack | undefined {
    const inArtist = drawerArtist?.hotSongs?.find((t) => t.id === id);
    if (inArtist) return inArtist;
    const inAlbum = drawerAlbum?.tracks?.find((t) => t.id === id);
    return inAlbum;
  }

  // 打开歌手详情抽屉
  const openArtistDrawer = React.useCallback(async (id: number | string, name?: string) => {
    let sid = Number(id);
    // 如果没有 singerId 但有歌手名，先搜索获取 singerId
    if (!sid && name) {
      try {
        const searchBody = await searchSingerId(name);
        if (searchBody) {
          sid = Number(searchBody);
        }
      } catch (e) {
        console.warn('[kugou] 搜索歌手ID失败:', e);
      }
    }
    if (!sid) {
      console.warn('[kugou] 无法获取歌手ID');
      return;
    }
    setDrawer({ type: 'artist', id: String(sid) });
    setDrawerArtist(null);
    setDrawerLoading(true);
    try {
      const detail = await getArtistDetail(sid);
      if (detail) {
        setDrawerArtist({
          id: detail.id,
          name: detail.name,
          cover: detail.cover,
          description: detail.description,
          musicSize: detail.musicSize,
          albumSize: detail.albumSize,
          mvSize: detail.mvSize,
          hotSongs: detail.hotSongs.map((t) => trackToPlayable(t, '')),
          albums: detail.albums.map((a) => ({ id: a.id, name: a.name, cover: a.cover || '' })),
        });
      }
    } catch (e) {
      console.error('[kugou] artist detail failed', e);
    } finally {
      setDrawerLoading(false);
    }
  }, []);

  // 打开专辑详情抽屉
  const openAlbumDrawer = React.useCallback(async (id: number | string) => {
    const aid = String(id);
    setDrawer({ type: 'album', id: aid });
    setDrawerAlbum(null);
    setDrawerLoading(true);
    try {
      const detail = await getAlbumDetail(aid);
      if (detail) {
        setDrawerAlbum({
          id: detail.id,
          name: detail.name,
          cover: detail.cover || '',
          artistName: detail.artistName,
          artistId: detail.artistId,
          description: detail.description,
          tracks: detail.tracks.map((t) => trackToPlayable(t, '')),
        });
      }
    } catch (e) {
      console.error('[kugou] album detail failed', e);
    } finally {
      setDrawerLoading(false);
    }
  }, []);

  // 播放 MV：解析直链后交给父组件跳转玉兰
  const handlePlayMv = async (t: KugouTrack) => {
    if (!t.mvHash || !onPlayMv) return;
    try {
      const url = await getMvUrl(t.mvHash);
      onPlayMv({ id: t.mvHash, name: t.name, artist: t.artist, cover: t.cover || '', url });
    } catch (e: any) {
      setError('MV 播放失败：' + (e?.message || e));
    }
  };

  // 下载当前歌曲
  const handleDownload = async (t: KugouTrack) => {
    try {
      await downloadKugouTrack(t, kugouAuth);
    } catch (e: any) {
      setError('下载失败：' + (e?.message || e));
    }
  };

  async function playTrackList(sourceTracks: KugouTrack[], startIndex: number, playlistName: string) {
    try {
      // 取真实登录态：KugouView 作用域无 auth state，必须从 localStorage 读取，
      // 否则 getSongUrl 永远走游客态，播放取链会返回版权限制。
      const auth = readKugouAuth();
      const quality = currentQuality();
      const pickHash = (tk: KugouTrack) => {
        if (quality === 'lossless' && tk.sqHash) return tk.sqHash;
        if (quality === 'high' && tk.hash320) return tk.hash320;
        return tk.hash || tk.id;
      };
      // 先找第一首能播的：VIP/下架歌曲跳过，避免整单卡住
      let playIndex = -1;
      let firstUrl = '';
      let firstBr = 0;
      for (let offset = 0; offset < sourceTracks.length; offset++) {
        const idx = (startIndex + offset) % sourceTracks.length;
        const tk = sourceTracks[idx];
        try {
          // 登录态下对所有歌曲都尝试免费试听通道：搜索结果常不返回 payType 字段，
          // 导致 VIP 歌曲因 payType===undefined 而跳过免费试听，最终返回无地址。
          // getSongUrl 内部会先尝试普通地址，无地址时才走 priv_url 免费试听。
          const free = !!auth?.userid;
          const r = await getSongUrl(pickHash(tk), tk.albumId, auth, quality, free);
          if (r.url) {
            playIndex = idx;
            firstUrl = r.url;
            firstBr = r.br;
            break;
          }
        } catch { /* 跳过无法播放的歌曲 */ }
      }
      if (playIndex < 0 || !firstUrl) {
        setError('当前列表没有可播放的歌曲（可能均为 VIP 或已下架）');
        return;
      }
      if (playIndex !== startIndex) {
        const skipped = sourceTracks[startIndex]?.name || '所选歌曲';
        setNotice(`“${skipped}”暂不可播放，已自动播放下一首`);
        setTimeout(() => setNotice(''), 3000);
      }
      setPlayingId(sourceTracks[playIndex]?.id ?? null);

      // 立即用“首曲可播 + 其余占位”开始播放，其余地址后台补全
      const playables: PlayableTrack[] = sourceTracks.map((tk, i) =>
        i === playIndex
          ? trackToPlayable(tk, firstUrl, qualityLabelFromBr(firstBr))
          : trackToPlayable(tk, '', ''),
      );
      onPlay(playables, playIndex, `酷狗 · ${playlistName}`);
      onTempPlaylist?.({
        id: `kugou-temp-${Date.now()}`,
        name: playlistName,
        tracks: playables,
        payload: { kind: tab === 'search' ? 'search' : 'recommend', keyword, tracks: playables },
      });

      // 后台逐个补全播放地址（不阻塞播放）
      for (let i = 0; i < sourceTracks.length; i++) {
        if (i === playIndex) continue;
        const tk = sourceTracks[i];
        try {
          const free = !!auth?.userid;
          const r = await getSongUrl(pickHash(tk), tk.albumId, auth, quality, free);
          if (!r.url) continue;
          playables[i] = trackToPlayable(tk, r.url, qualityLabelFromBr(r.br));
          musicPlayer.updateTrackUrl(i, r.url);
        } catch { /* 单曲失败不影响整体 */ }
      }
    } catch (e: any) {
      setError('播放失败：' + (e?.message || e));
    } finally {
      setPlayingId(null);
    }
  }

  async function doPlay(track: KugouTrack, index: number) {
    const currentList = tab === 'home' && activeRankId === null && !playlistMode ? homeHeroTracks : allTracksRef.current;
    await playTrackList(currentList, index, track.name);
  }

  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* 顶栏：复用通用音乐模块模板（标题 + 登录按钮 + 云按钮） */}
      <MusicHeader
        title={playlistMode
          ? playlistMode.name
          : activeRankId !== null
            ? (rankList.find((r) => r.id === activeRankId)?.name || '榜单')
            : tab === 'search'
              ? '搜索'
              : tab === 'mine'
                ? '我的'
                : tab === 'roam'
                  ? '漫游'
                  : '酷狗音乐'}
        onBackToSub={playlistMode ? () => setPlaylistMode(null) : activeRankId !== null ? () => setActiveRankId(null) : undefined}
        onBackToSubTitle={playlistMode ? '返回' : '返回热榜'}
        onUserClick={() => {
          changeTab('mine');
          setActiveRankId(null);
          setPlaylistMode(null);
        }}
        onCloudClick={onBack}
        cloudTitle="音乐模块"
        user={kugouAuth
          ? {
              loggedIn: true,
              name: kugouAuth.nickname || '酷狗用户',
              avatarUrl: kugouAuth.avatar || '',
              initial: (kugouAuth.nickname || '酷').slice(0, 1),
              vipBadge: kugouVipInfo?.isVip ? (kugouVipInfo.vipName || 'VIP') : undefined,
            }
          : { loggedIn: false }}
      />

      {/* 顶部不再放子模块切换条；热榜 / 搜索切换改由云按钮（音乐模块）折叠菜单控制 */}

      {/* 搜索 / 榜单筛选条 */}
      {tab === 'search' && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-200/70 dark:border-stone-700/60">
          <div className="flex items-center gap-2 flex-1 px-3 py-1.5 rounded-xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/50">
            <SearchIcon size={16} className="text-neutral-400 dark:text-stone-500 shrink-0" />
            <input
              className="flex-1 bg-transparent outline-none text-sm text-neutral-800 dark:text-stone-100 placeholder:text-neutral-400 dark:placeholder:text-stone-500"
              placeholder="搜索歌曲 / 歌手"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') doSearch();
              }}
            />
          </div>
          <button
            className="btn-press px-3 py-1.5 rounded-lg bg-blue-500/90 hover:bg-blue-500 text-white text-sm font-medium disabled:opacity-50"
            onClick={() => doSearch()}
            disabled={loading}
          >
            搜索
          </button>
        </div>
      )}
      {/* 状态 */}
      {loading && (
        <div className="flex items-center gap-2 px-3 py-3 text-sm text-neutral-500 dark:text-stone-400">
          <span className="w-4 h-4 rounded-full border-2 border-neutral-300 dark:border-stone-600 border-t-blue-500 animate-spin" />
          加载中…
        </div>
      )}
      {notice && (
        <div className="px-3 py-2 text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 border-b border-amber-500/20">
          {notice}
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 px-3 py-3 text-sm text-red-500 dark:text-red-400">
          <span>{error}</span>
          <button
            className="btn-press px-2 py-1 rounded-md bg-neutral-100/70 dark:bg-stone-800/60 text-neutral-700 dark:text-stone-200"
            onClick={() => (activeRankId !== null ? loadRank(activeRankId) : tab === 'search' ? doSearch() : reloadRankList())}
          >
            重试
          </button>
        </div>
      )}

      {/* 首页：个性化 Hero + 横向滚动歌单（对齐网易云「为你推荐」） */}
      {tab === 'home' && activeRankId === null && !playlistMode && (
        <div className="flex-1 overflow-y-auto min-h-0 px-4 pb-6">
          {/* Hero 大卡片 + 横向滚动歌单（个性化推荐歌单） */}
          {recommendPlaylists.length > 0 && (() => {
            const rec = recommendPlaylists;
            const openRec = (pl: KugouPlaylistCard) =>
              openUserPlaylist({ id: pl.id, gid: pl.gid, name: pl.name, cover: pl.cover });
            return (
              <section className="mt-4 mb-8">
                <div className="flex items-center gap-2 mb-4">
                  <Sparkles size={18} className="text-orange-500" />
                  <h3 className="text-base font-bold text-neutral-800 dark:text-stone-100">为你推荐</h3>
                  <span className="text-xs text-neutral-400 dark:text-stone-500">个性化歌单推荐</span>
                </div>
                <HeroCard
                  rank={rec[0]}
                  onClick={() => openRec(rec[0])}
                  onPlayAll={() => {
                    if (homeHeroTracks.length) {
                      void playTrackList(homeHeroTracks, 0, rec[0].name);
                    }
                  }}
                />
                {rec.length > 1 && (
                  <div className="flex gap-3 overflow-x-auto scrollbar-thin py-3 mt-2">
                    {rec.slice(1).map((r) => (
                      <RankCard key={r.id} rank={r} onClick={() => openRec(r)} />
                    ))}
                  </div>
                )}
              </section>
            );
          })()}

          {!loading && !error && recommendPlaylists.length === 0 && rankList.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-neutral-400 dark:text-stone-500">
              <MusicIcon size={32} />
              <span className="text-sm">暂无推荐内容</span>
            </div>
          )}
        </div>
      )}

      {/* 漫游：发现流（对齐网易云"漫游"，游客态复用榜单 + 为你推荐） */}
      {tab === 'roam' && activeRankId === null && !playlistMode && (
        <div className="flex-1 overflow-y-auto min-h-0 px-4 pb-6">
          <div className="flex items-center gap-2 pt-4 pb-3">
            <h2 className="text-2xl font-bold text-neutral-800 dark:text-stone-100">{T('music.kugou.roamTitle') || '漫游'}</h2>
            <span className="text-xs text-neutral-400 dark:text-stone-500">{T('music.kugou.roamForYouDesc') || '基于热榜精选，发现更多好歌'}</span>
          </div>

          {/* 每日推荐（个性化歌曲流，游客也可用） */}
          {recommendTracks.length > 0 && (
            <section className="mt-2 mb-8">
              <div className="flex items-center gap-2 mb-4">
                <Sparkles size={18} className="text-orange-500" />
                <h3 className="text-base font-bold text-neutral-800 dark:text-stone-100">{T('music.kugou.roamForYou') || '每日推荐'}</h3>
                <span className="text-xs text-neutral-400 dark:text-stone-500">根据你的口味个性化推荐</span>
                <button
                  onClick={() => void playTrackList(recommendTracks, 0, '每日推荐')}
                  className="btn-press flex items-center gap-1 px-2.5 py-1 rounded-full bg-blue-500/90 hover:bg-blue-500 text-white text-xs font-medium ml-auto"
                >
                  <PlayIcon size={12} />
                  播放全部
                </button>
              </div>
              <div className="space-y-1">
                {recommendTracks.slice(0, 8).map((t, i) => (
                  <div
                    key={t.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => void playTrackList(recommendTracks, i, '每日推荐')}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        void playTrackList(recommendTracks, i, '每日推荐');
                      }
                    }}
                    className="group flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-neutral-200/50 dark:hover:bg-stone-800/50 active:bg-neutral-300/50 dark:active:bg-stone-700/50 transition-colors text-left cursor-pointer"
                  >
                    <div className="w-10 h-10 rounded-md overflow-hidden bg-neutral-200/60 dark:bg-stone-700/60 flex items-center justify-center shrink-0">
                      {t.cover ? (
                        <img src={t.cover} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <MusicIcon size={16} className="text-neutral-400 dark:text-stone-500" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm text-neutral-800 dark:text-stone-100 truncate">{t.name}</div>
                      <div className="text-xs text-neutral-500 dark:text-stone-400 truncate">
                        {t.artist}{t.album ? ` · ${t.album}` : ''}
                      </div>
                    </div>
                    <span className="text-xs text-neutral-400 dark:text-stone-500 shrink-0">{formatDuration(t.duration)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 热门榜单 */}
          {rankList.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-bold text-neutral-800 dark:text-stone-100">{T('music.kugou.roamHotRanks') || '热门榜单'}</h3>
                <button
                  onClick={() => changeTab('home')}
                  className="btn-press px-2.5 py-1 rounded-full bg-neutral-100/70 dark:bg-stone-800/60 text-neutral-600 dark:text-stone-300 text-xs font-medium"
                >
                  完整榜单
                </button>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                {rankList.map((r) => (
                  <RankCard key={r.id} rank={r} size="lg" onClick={() => openRank(r.id)} />
                ))}
              </div>
            </section>
          )}

          {!loading && !error && rankList.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-neutral-400 dark:text-stone-500">
              <LibraryIcon size={32} />
              <span className="text-sm">暂无推荐内容</span>
            </div>
          )}
        </div>
      )}

      {/* 我的：游客态提示页 */}
      {tab === 'mine' && activeRankId === null && !playlistMode && (
        <MineView onBack={() => changeTab('home')} onAuthChange={onAuthChange} />
      )}

      {/* 榜单/搜索 歌曲列表（漫游 / 我的 未打开榜单详情时由各自区块承载） */}
      {(activeRankId !== null || tab === 'search' || playlistMode != null) && (
        <div className="flex-1 overflow-y-auto min-h-0">
          {/* 榜单 / 歌单详情大封面头部（对齐网易云 PlaylistDetailHeader） */}
          {(activeRankId !== null || playlistMode != null) && (() => {
            const rank = activeRankId != null ? rankList.find(r => r.id === activeRankId) : null;
            const cover = playlistMode?.cover || rank?.cover;
            const name = playlistMode?.name || rank?.name || '';
            return (
              <PlaylistDetailHeader
                coverUrl={cover}
                name={name}
                brandLabel="酷狗音乐"
                trackCount={tracks.length}
                accent="#00aaff"
                onPlayAll={() => {
                  if (tracks.length) {
                    void playTrackList(tracks, 0, playlistMode ? playlistMode.name : '酷狗榜单');
                  }
                }}
                canSubscribe={false}
                subscribeDisabledHint="登录后支持收藏歌单"
              />
            );
          })()}
          {tracks.length > 0 && (
            <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-200/40 dark:border-stone-700/30">
              <span className="text-xs text-neutral-400 dark:text-stone-500">
                {playlistMode ? '歌单歌曲' : activeRankId !== null ? '榜单歌曲' : '搜索结果'} · {tracks.length} 首
              </span>
              <button
                onClick={() => void playTrackList(tracks, 0, playlistMode ? playlistMode.name : activeRankId !== null ? '酷狗榜单' : `搜索：${keyword}`)}
                className="btn-press flex items-center gap-1 px-2.5 py-1 rounded-full bg-blue-500/90 hover:bg-blue-500 text-white text-xs font-medium"
              >
                <PlayIcon size={12} />
                播放全部
              </button>
            </div>
          )}
          {tracks.map((t, i) => (
            <TrackRow
              key={t.id}
              track={{
                id: `kugou-${t.id}`,
                filePath: '',
                title: t.name,
                artist: t.artist,
                album: t.album,
                durationSecs: Math.round((t.duration || 0) / 1000),
                coverPath: t.cover,
                artistId: t.singerId,
                albumId: t.albumId,
                mvId: t.mvHash,
                badges: [
                  (t.privilege ?? 0) >= 10 ? { label: 'VIP', kind: 'vip' as const } : null,
                ].filter((b): b is { label: string; kind: 'vip' } => b !== null),
              }}
              index={i}
              isPlaying={playingId === t.id}
              onPlay={() => doPlay(t, i)}
              onOpenArtist={(e) => { e.stopPropagation(); openArtistDrawer(t.singerId || 0, t.artist); }}
              onOpenAlbum={(e) => { e.stopPropagation(); if (t.albumId) openAlbumDrawer(t.albumId); }}
              onPlayMv={(e) => { e.stopPropagation(); void handlePlayMv(t); }}
              onDownload={(e) => { e.stopPropagation(); void handleDownload(t); }}
              onLike={(e) => { e.stopPropagation(); onToggleFavorite?.(trackToPlayable(t, '', '')); }}
              isLiked={isFav(t)}
              accentColor="#00aaff"
            />
          ))}
          {hasMore && (
            <div className="py-3 text-center">
              <button
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="btn-press px-4 py-1.5 rounded-full bg-neutral-100/70 dark:bg-stone-800/60 text-xs text-neutral-600 dark:text-stone-300 hover:bg-neutral-200/60 dark:hover:bg-stone-700/50 disabled:opacity-50"
              >
                {loadingMore ? '加载中…' : '加载更多'}
              </button>
            </div>
          )}
          {!loading && !error && tracks.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-neutral-400 dark:text-stone-500">
              <MusicIcon size={32} />
              <span className="text-sm">暂无内容</span>
            </div>
          )}
        </div>
      )}

      {/* 歌手/专辑详情抽屉 */}
      <DetailDrawer
        drawer={drawer}
        onClose={() => { setDrawer({ type: 'none' }); setDrawerArtist(null); setDrawerAlbum(null); }}
        callbacks={{
          onPlayTracks: (trks, idx, name) => {
            // 将 PlayableTrack[] 转回 KugouTrack[] 进行播放
            const ktracks: KugouTrack[] = trks.map((t) => ({
              id: t.id.replace('kugou-', ''),
              name: t.title,
              artist: t.artist,
              album: t.album,
              duration: (t.durationSecs || 0) * 1000,
              cover: t.coverPath,
              hash: t.id.replace('kugou-', ''),
            }));
            void playTrackList(ktracks, idx, name || '酷狗音乐');
          },
          onOpenArtist: (id) => openArtistDrawer(id, undefined),
          onOpenAlbum: openAlbumDrawer,
          onPlayMv: onPlayMv ? (mv) => { if (mv.url) onPlayMv(mv); } : undefined,
          onDownload: undefined,
          // 详情抽屉红心：在抽屉曲目里取到完整 PlayableTrack（含 hash）后转发给 onToggleFavorite，
          // 与列表行共用同一收藏源（favoriteIds 的 kugou-<id> 键），保证云端写能拿到 hash。
          onLikeTrack: (trackId) => {
            const full = findDrawerTrack(trackId);
            if (full) onToggleFavorite?.(full);
          },
        }}
        artist={drawerArtist}
        album={drawerAlbum}
        isLoading={drawerLoading}
        accentColor="#00aaff"
        loggedIn={!!kugouAuth}
        likedTracks={favoriteIds}
      />
    </div>
  );
});
