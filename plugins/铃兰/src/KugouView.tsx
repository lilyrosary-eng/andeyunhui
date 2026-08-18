// 酷狗音乐视图（对齐 NeteaseView.tsx 范式）
//
// 复用 netease 的 props/handle 契约（PlayableTrack / TempPlaylist / NeteaseViewHandle 形状），
// 仅把数据源从 neteaseApi 换成 kugouApi。本视图覆盖：搜索、榜单浏览、歌单浏览、播放
// （取播放 URL 后通过 onPlay 交给 musicPlayer）。登录态/红心/账号等暂未实现（酷狗游客态
// 已可搜索+试听+歌词），后续如需会员无损再补扫码登录。

import React from 'react';
const { useState, useEffect, useRef } = React;
import { MusicIcon, PlayIcon, SearchIcon, Sparkles, UserIcon, LibraryIcon, HeartIcon } from 'lucide-react';
import { ArrowLeftIcon } from '../../_shared/icons';
import { T } from '../../_shared/pluginRuntime';
import {
  type KugouAuth,
  type KugouProfile,
  type KugouTrack,
  type KugouPlaylistCard,
  getFavorites,
  getUserPlaylists,
  safeImg,
} from './kugouApi';
import {
  kugouQrCreate,
  kugouQrCheck,
  readKugouAuth,
  logoutKugou,
  fetchKugouProfile,
} from './kugouAuth';
import { musicPlayer, Track } from './musicPlayer';
import {
  KugouTrack,
  KugouPlaylistCard,
  searchSongs,
  getSongUrl,
  getTopList,
  getPlaylist,
  getRankList,
  qualityLabelFromBr,
} from './kugouApi';
import { PlayableTrack, TempPlaylist, NeteaseViewHandle } from './NeteaseView';
import { MusicHeader } from './MusicHeader';

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
        <div className="flex items-center gap-2 pt-4 pb-4">
          <button
            onClick={onBack}
            className="btn-press flex items-center gap-1 px-2.5 py-1 rounded-full bg-neutral-100/70 dark:bg-stone-800/60 text-neutral-600 dark:text-stone-300 text-xs font-medium"
            title="返回热榜"
          >
            <ArrowLeftIcon size={14} />
            热榜
          </button>
          <h2 className="text-2xl font-bold text-neutral-800 dark:text-stone-100">{T('music.kugou.mineTitle') || '我的'}</h2>
        </div>

        {/* 用户信息卡 */}
        <div className="flex items-center gap-4 rounded-2xl p-4 bg-neutral-100/60 dark:bg-stone-800/50">
          {safeImg(profile?.avatar) ? (
            <img src={safeImg(profile.avatar)} alt="" className="w-16 h-16 rounded-full object-cover border border-white dark:border-stone-700" />
          ) : (
            <div className="w-16 h-16 rounded-full flex items-center justify-center bg-orange-500/10 text-orange-500">
              <UserIcon size={28} />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-lg font-semibold text-neutral-800 dark:text-stone-100 truncate">{profile?.nickname || auth.nickname || '酷狗用户'}</div>
            {profile?.signature ? (
              <div className="text-xs text-neutral-500 dark:text-stone-400 truncate mt-0.5">{profile.signature}</div>
            ) : null}
            <div className="text-[10px] text-neutral-400 dark:text-stone-500 mt-1">ID: {auth.userid}{auth.vipType ? ` · 会员` : ''}</div>
          </div>
        </div>

        {/* 收藏 */}
        <section className="mt-6">
          <h3 className="text-base font-bold text-neutral-800 dark:text-stone-100 mb-3">{T('music.kugou.mineFavs') || '我喜欢的音乐'}</h3>
          {dataLoading ? (
            <div className="text-sm text-neutral-400 dark:text-stone-500 py-6 text-center">加载中…</div>
          ) : favs.length > 0 ? (
            <div className="space-y-1">
              {favs.slice(0, 20).map((t) => (
                <div key={t.id} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-neutral-100/40 dark:bg-stone-800/30 cursor-pointer hover:bg-neutral-200/50 dark:hover:bg-stone-700/40" onDoubleClick={() => playTrackList([t], 0, t.name)}>
                  <div className="w-9 h-9 rounded-lg overflow-hidden bg-neutral-200/60 dark:bg-stone-700/60 flex items-center justify-center shrink-0">
                    {t.cover ? <img src={safeImg(t.cover)} alt="" className="w-full h-full object-cover" /> : <MusicIcon size={14} className="text-neutral-400" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-neutral-800 dark:text-stone-100 truncate">{t.name}</div>
                    <div className="text-xs text-neutral-500 dark:text-stone-400 truncate">{t.artist}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-neutral-400 dark:text-stone-500 py-6 text-center rounded-2xl bg-neutral-100/40 dark:bg-stone-800/30">{dataError || (T('music.kugou.mineEmptyFavs') || '暂无收藏')}</div>
          )}
        </section>

        {/* 歌单 */}
        <section className="mt-6">
          <h3 className="text-base font-bold text-neutral-800 dark:text-stone-100 mb-3">{T('music.kugou.minePlaylists') || '我的歌单'}</h3>
          {dataLoading ? (
            <div className="text-sm text-neutral-400 dark:text-stone-500 py-6 text-center">加载中…</div>
          ) : playlists.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {playlists.map((p) => (
                <div key={p.id} className="rounded-xl overflow-hidden bg-neutral-100/50 dark:bg-stone-800/40">
                  <div className="aspect-square bg-neutral-200/60 dark:bg-stone-700/60 flex items-center justify-center">
                    {p.cover ? <img src={safeImg(p.cover)} alt="" className="w-full h-full object-cover" /> : <MusicIcon size={20} className="text-neutral-400" />}
                  </div>
                  <div className="p-2 text-xs font-medium text-neutral-700 dark:text-stone-200 truncate">{p.name}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-neutral-400 dark:text-stone-500 py-6 text-center rounded-2xl bg-neutral-100/40 dark:bg-stone-800/30">{dataError || (T('music.kugou.mineEmptyPlaylists') || '暂无歌单')}</div>
          )}
        </section>

        <div className="flex items-center justify-center mt-8">
          <button onClick={handleLogout} className="btn-press px-4 py-2 rounded-xl bg-red-500/10 text-red-600 dark:text-red-400 text-sm hover:bg-red-500/20 transition-colors">
            {T('music.kugou.mineLogout') || '退出登录'}
          </button>
        </div>
      </div>
    );
  }

  // ===== 游客态：扫码登录 =====
  return (
    <div className="flex-1 overflow-y-auto min-h-0 px-4 pb-6">
      <div className="flex items-center gap-2 pt-4 pb-4">
        <button
          onClick={onBack}
          className="btn-press flex items-center gap-1 px-2.5 py-1 rounded-full bg-neutral-100/70 dark:bg-stone-800/60 text-neutral-600 dark:text-stone-300 text-xs font-medium"
          title="返回热榜"
        >
          <ArrowLeftIcon size={14} />
          热榜
        </button>
        <h2 className="text-2xl font-bold text-neutral-800 dark:text-stone-100">{T('music.kugou.mineTitle') || '我的'}</h2>
      </div>

      <div className="flex flex-col items-center gap-4 py-10 text-center">
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
  };
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export const KugouView = React.forwardRef<NeteaseViewHandle, KugouViewProps>(function KugouView(
  { initialTab, onBack, onPlay, onTempPlaylist, onActivePlaylist, selectedRankId, onRankListLoaded, onActiveRankChange, onAuthChange, searchQuery, onTabChange, favoriteIds, onToggleFavorite },
  ref,
) {
  const [tab, setTab] = useState<KugouTab>(initialTab);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tracks, setTracks] = useState<KugouTrack[]>([]);
  const [keyword, setKeyword] = useState('');
  const [playingId, setPlayingId] = useState<string | null>(null);
  const reqRef = useRef(0);
  const allTracksRef = useRef<KugouTrack[]>([]);
  const [rankList, setRankList] = useState<KugouPlaylistCard[]>([]);
  const [activeRankId, setActiveRankId] = useState<number | null>(null);
  const [homeHeroTracks, setHomeHeroTracks] = useState<KugouTrack[]>([]);
  const [homeHeroLoading, setHomeHeroLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const pageRef = useRef(1);

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

  // 暴露命令式方法给侧栏（临时歌单恢复播放）
  React.useImperativeHandle(ref, () => ({
    openPlaylist: () => {},
    restoreTemp: (payload: any) => {
      if (!payload?.tracks?.length) return;
      musicPlayer.setTracks(payload.tracks, 0);
      musicPlayer.play();
      musicPlayer.currentPlaylistId = payload.id ?? 'kugou-active';
      // 同步主视图：搜索临时歌单切回搜索页并重新拉结果；推荐/榜单临时歌单切回热榜。
      if (payload.kind === 'search') {
        setKeyword(payload.keyword || '');
        changeTab('search');
        setActiveRankId(null);
        if (payload.keyword) void doSearch(payload.keyword);
      } else if (payload.kind === 'recommend') {
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
    const kw = (kwOverride ?? keyword).trim();
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
    setKeyword(searchQuery);
    if (!searchQuery.trim()) {
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
      void doSearch(searchQuery);
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

  async function playTrackList(sourceTracks: KugouTrack[], startIndex: number, playlistName: string) {
    try {
      // 取真实登录态：KugouView 作用域无 auth state，必须从 localStorage 读取，
      // 否则 getSongUrl 永远走游客态，播放取链会返回版权限制。
      const auth = readKugouAuth();
      const quality = currentQuality();
      setPlayingId(sourceTracks[startIndex]?.id ?? null);
      const { url, br } = await getSongUrl(sourceTracks[startIndex]?.hash || sourceTracks[startIndex]?.id, sourceTracks[startIndex]?.albumId, auth, quality);
      if (!url) {
        setError('该歌曲暂无可播放地址（可能需会员或已下架）');
        return;
      }
      // 批量取地址（带容错）
      const playables: PlayableTrack[] = [];
      for (const tk of sourceTracks) {
        try {
          const r = await getSongUrl(tk.hash || tk.id, tk.albumId, auth, quality);
          playables.push(trackToPlayable(tk, r.url, qualityLabelFromBr(r.br)));
        } catch {
          playables.push(trackToPlayable(tk, '', ''));
        }
      }
      onPlay(playables, startIndex, `酷狗 · ${playlistName}`);
      onTempPlaylist?.({
        id: `kugou-temp-${Date.now()}`,
        name: playlistName,
        tracks: playables,
        payload: { kind: tab === 'search' ? 'search' : 'recommend', keyword, tracks: playables },
      });
    } catch (e: any) {
      setError('播放失败：' + (e?.message || e));
    } finally {
      setPlayingId(null);
    }
  }

  async function doPlay(track: KugouTrack, index: number) {
    const currentList = tab === 'home' && activeRankId === null ? homeHeroTracks : allTracksRef.current;
    await playTrackList(currentList, index, track.name);
  }

  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* 顶栏：复用通用音乐模块模板（标题 + 登录按钮 + 云按钮） */}
      <MusicHeader
        title="酷狗音乐"
        onUserClick={() => {
          changeTab('mine');
          setActiveRankId(null);
        }}
        onCloudClick={onBack}
        cloudTitle="音乐模块"
        user={{ loggedIn: !!readKugouAuth() }}
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
            onClick={doSearch}
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

      {/* 首页热榜 */}
      {tab === 'home' && activeRankId === null && (
        <div className="flex-1 overflow-y-auto min-h-0 px-4 pb-6">
          {/* 顶部标题 + 播放全部 */}
          <div className="flex items-center justify-between pt-4 pb-3">
            <h2 className="text-2xl font-bold text-neutral-800 dark:text-stone-100">热榜</h2>
            <button
              onClick={() => {
                if (homeHeroTracks.length) {
                  void playTrackList(homeHeroTracks, 0, '热榜');
                }
              }}
              disabled={homeHeroLoading || homeHeroTracks.length === 0}
              className="btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue-500/90 hover:bg-blue-500 text-white text-sm font-medium disabled:opacity-50"
            >
              <PlayIcon size={14} />
              播放全部
            </button>
          </div>

          {/* 为你推荐 */}
          {rankList.length > 0 && (
            <section className="mt-2 mb-8">
              <div className="flex items-center gap-2 mb-4">
                <Sparkles size={18} className="text-orange-500" />
                <h3 className="text-base font-bold text-neutral-800 dark:text-stone-100">为你推荐</h3>
                <span className="text-xs text-neutral-400 dark:text-stone-500">根据你的口味推荐</span>
              </div>
              <HeroCard
                rank={rankList[0]}
                onClick={() => openRank(rankList[0].id)}
                onPlayAll={() => {
                  if (homeHeroTracks.length) {
                    void playTrackList(homeHeroTracks, 0, rankList[0].name);
                  }
                }}
              />
              {rankList.length > 1 && (
                <div className="flex gap-3 overflow-x-auto scrollbar-thin py-3 mt-2">
                  {rankList.slice(1, 11).map((r) => (
                    <RankCard key={r.id} rank={r} onClick={() => openRank(r.id)} />
                  ))}
                </div>
              )}
            </section>
          )}

          {/* 热榜 */}
          {rankList.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-bold text-neutral-800 dark:text-stone-100">热榜</h3>
                <button
                  onClick={() => {
                    if (homeHeroTracks.length) {
                      void playTrackList(homeHeroTracks, 0, '热榜');
                    }
                  }}
                  disabled={homeHeroLoading || homeHeroTracks.length === 0}
                  className="btn-press flex items-center gap-1 px-2.5 py-1 rounded-full bg-neutral-100/70 dark:bg-stone-800/60 text-neutral-600 dark:text-stone-300 text-xs font-medium disabled:opacity-50"
                >
                  <PlayIcon size={12} />
                  播放全部
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
              <MusicIcon size={32} />
              <span className="text-sm">暂无榜单数据</span>
            </div>
          )}
        </div>
      )}

      {/* 漫游：发现流（对齐网易云"漫游"，游客态复用榜单 + 为你推荐） */}
      {tab === 'roam' && activeRankId === null && (
        <div className="flex-1 overflow-y-auto min-h-0 px-4 pb-6">
          <div className="flex items-center gap-2 pt-4 pb-3">
            <h2 className="text-2xl font-bold text-neutral-800 dark:text-stone-100">{T('music.kugou.roamTitle') || '漫游'}</h2>
            <span className="text-xs text-neutral-400 dark:text-stone-500">{T('music.kugou.roamForYouDesc') || '基于热榜精选，发现更多好歌'}</span>
          </div>

          {/* 为你推荐 */}
          {rankList.length > 0 && (
            <section className="mt-2 mb-8">
              <div className="flex items-center gap-2 mb-4">
                <Sparkles size={18} className="text-orange-500" />
                <h3 className="text-base font-bold text-neutral-800 dark:text-stone-100">{T('music.kugou.roamForYou') || '为你推荐'}</h3>
              </div>
              <HeroCard
                rank={rankList[0]}
                onClick={() => openRank(rankList[0].id)}
                onPlayAll={() => {
                  if (homeHeroTracks.length) {
                    void playTrackList(homeHeroTracks, 0, rankList[0].name);
                  }
                }}
              />
              {rankList.length > 1 && (
                <div className="flex gap-3 overflow-x-auto scrollbar-thin py-3 mt-2">
                  {rankList.slice(1, 11).map((r) => (
                    <RankCard key={r.id} rank={r} onClick={() => openRank(r.id)} />
                  ))}
                </div>
              )}
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
      {tab === 'mine' && activeRankId === null && (
        <MineView onBack={() => changeTab('home')} onAuthChange={onAuthChange} />
      )}

      {/* 榜单/搜索 歌曲列表（漫游 / 我的 未打开榜单详情时由各自区块承载） */}
      {(activeRankId !== null || tab === 'search') && (
        <div className="flex-1 overflow-y-auto min-h-0">
          {activeRankId !== null && (
            <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-200/70 dark:border-stone-700/60">
              <button
                onClick={() => setActiveRankId(null)}
                className="btn-press flex items-center gap-1 px-2.5 py-1 rounded-full bg-neutral-100/70 dark:bg-stone-800/60 text-neutral-600 dark:text-stone-300 text-xs font-medium"
                title="返回热榜"
              >
                <ArrowLeftIcon size={14} />
                返回热榜
              </button>
            </div>
          )}
          {tracks.length > 0 && (
            <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-200/40 dark:border-stone-700/30">
              <span className="text-xs text-neutral-400 dark:text-stone-500">
                {activeRankId !== null ? '榜单歌曲' : '搜索结果'} · {tracks.length} 首
              </span>
              <button
                onClick={() => void playTrackList(tracks, 0, activeRankId !== null ? '酷狗榜单' : `搜索：${keyword}`)}
                className="btn-press flex items-center gap-1 px-2.5 py-1 rounded-full bg-blue-500/90 hover:bg-blue-500 text-white text-xs font-medium"
              >
                <PlayIcon size={12} />
                播放全部
              </button>
            </div>
          )}
          {tracks.map((t, i) => (
            <div
              key={t.id}
              className="flex items-center gap-3 px-3 py-2.5 border-b border-neutral-200/40 dark:border-stone-700/30 cursor-pointer hover:bg-neutral-100/50 dark:hover:bg-stone-800/40"
              onDoubleClick={() => doPlay(t, i)}
            >
              <div
                className="w-10 h-10 rounded-lg overflow-hidden bg-neutral-200/60 dark:bg-stone-700/60 flex items-center justify-center shrink-0"
                onClick={() => doPlay(t, i)}
              >
                {t.cover ? (
                  <img src={t.cover} alt="" className="w-full h-full object-cover" />
                ) : (
                  <MusicIcon size={16} className="text-neutral-400 dark:text-stone-500" />
                )}
              </div>
              <div className="flex-1 min-w-0" onClick={() => doPlay(t, i)}>
                <div className="font-medium text-sm text-neutral-800 dark:text-stone-100 truncate">{t.name}</div>
                <div className="text-xs text-neutral-500 dark:text-stone-400 truncate">
                  {t.artist}{t.album ? ` · ${t.album}` : ''}
                </div>
              </div>
              <span className="text-xs text-neutral-400 dark:text-stone-500 shrink-0">{formatDuration(t.duration)}</span>
              {onToggleFavorite && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleFavorite(trackToPlayable(t, '', ''));
                  }}
                  className="btn-jelly p-1.5 rounded-full text-neutral-400 dark:text-stone-500 hover:text-rose-500 dark:hover:text-rose-400 hover:bg-rose-500/10 transition-colors shrink-0"
                  title={isFav(t) ? '取消收藏' : '收藏'}
                >
                  <HeartIcon size={15} fill={isFav(t) ? 'currentColor' : 'none'} />
                </button>
              )}
              <button
                onClick={() => doPlay(t, i)}
                disabled={playingId === t.id}
                className="btn-press w-8 h-8 rounded-full bg-neutral-100/70 dark:bg-stone-800/60 text-neutral-600 dark:text-stone-300 flex items-center justify-center disabled:opacity-40 shrink-0"
                title="播放"
              >
                {playingId === t.id ? (
                  <PlayIcon size={14} className="text-blue-500" />
                ) : (
                  <PlayIcon size={14} />
                )}
              </button>
            </div>
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
    </div>
  );
});
