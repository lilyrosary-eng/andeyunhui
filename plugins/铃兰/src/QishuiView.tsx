/// <reference path="../../global.d.ts" />
// 汽水音乐视图 — 全量复用网易云模板
//
// Tab 结构对齐网易云：listen（现在就听） / library（漫游） / search（搜索） / about（关于）
// 由右侧滑出的 ModuleDrawer 控制切换，而非页内 tab 按钮。
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Loader2, AlertCircle, Music2, Play, Sparkles } from 'lucide-react';
import {
  qishuiSearch,
  qishuiGetRecommendPlaylists,
  qishuiGetTopLists,
  qishuiGetPlaylistTracks,
  qishuiGetPlaylistInfo,
  qishuiGetSongUrl,
  type QishuiTrack,
  type QishuiPlaylistCard,
} from './qishuiApi';
import { decryptQishuiAudio } from './qishuiDecrypt';
import {
  qishuiQrCreate,
  qishuiQrCheck,
  qishuiGetUserInfo,
  qishuiLogout,
  loadQishuiAuth,
  saveQishuiAuth,
  clearQishuiAuth,
  type QishuiAuth,
} from './qishuiAuth';
import { MusicHeader } from './MusicHeader';
import {
  PlaylistDetailHeader,
  HeroBanner,
  PlaylistGridRow,
  SearchBar,
  SectionTitle,
} from './_shared/OnlineMusicTemplates';
import { EmptyState } from './_shared/OnlineMusicExtras';
import { TrackRow, type PlayableTrack } from './_shared/TrackRow';
import type { TempPlaylist } from './NeteaseView';

const ACCENT = '#00c2c7'; // 汽水青蓝

export type QishuiTab = 'listen' | 'library' | 'search' | 'about';

export interface QishuiViewHandle {
  openPlaylist: (id: string, name: string) => void;
  restoreTemp: (payload: any) => void;
}

interface QishuiViewProps {
  initialTab: QishuiTab;
  onBack: () => void;
  onPlay: (tracks: PlayableTrack[], startIndex: number, sourceName: string) => void;
  onTempPlaylist?: (temp: TempPlaylist) => void;
  onActivePlaylist?: (id: string) => void;
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

  // 首页推荐/榜单数据
  const [recommend, setRecommend] = useState<QishuiPlaylistCard[]>([]);
  const [tops, setTops] = useState<QishuiPlaylistCard[]>([]);
  // 歌单详情
  const [activePlaylist, setActivePlaylist] = useState<{ id: string; name: string; cover?: string } | null>(null);
  const [playlistInfo, setPlaylistInfo] = useState<{ name: string; cover?: string; trackCount: number } | null>(null);
  // 登录态
  const [auth, setAuth] = useState<QishuiAuth | null>(() => loadQishuiAuth());
  const [qrImg, setQrImg] = useState('');
  const [qrStatus, setQrStatus] = useState('');
  const [qrLoading, setQrLoading] = useState(false);
  const pollRef = useRef<number | null>(null);

  useEffect(() => { setTab(initialTab); }, [initialTab]);

  // 首页推荐+榜单并行拉取
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
    if (tab === 'listen' && !activePlaylist) void loadHome();
  }, [tab, activePlaylist, loadHome]);

  // 搜索（防抖）
  useEffect(() => {
    if (tab !== 'search') return;
    setActivePlaylist(null);
    const kw = keyword.trim();
    if (!kw) { setTracks([]); setLoading(false); return; }
    const req = ++reqRef.current;
    setLoading(true);
    setError('');
    const timer = setTimeout(() => {
      qishuiSearch(kw, 1, 1, 40)
        .then((list) => {
          if (req !== reqRef.current) return;
          setTracks(list);
          if (list.length === 0) setError('没有找到相关歌曲');
        })
        .catch((e) => { if (req === reqRef.current) setError(String(e?.message || e)); })
        .finally(() => { if (req === reqRef.current) setLoading(false); });
    }, 400);
    return () => clearTimeout(timer);
  }, [tab, keyword]);

  // 打开歌单
  const loadPlaylist = useCallback(async (id: string, name: string) => {
    const req = ++reqRef.current;
    setTab('listen');
    setActivePlaylist({ id, name });
    onActivePlaylist?.(id);
    setLoading(true);
    setError('');
    setTracks([]);
    try {
      const [info, list] = await Promise.all([
        qishuiGetPlaylistInfo(id).catch(() => ({ name, trackCount: 0 as number })),
        qishuiGetPlaylistTracks(id),
      ]);
      if (req !== reqRef.current) return;
      setPlaylistInfo(info);
      setTracks(list);
    } catch (e: any) {
      if (req === reqRef.current) setError(String(e?.message || e));
    } finally {
      if (req === reqRef.current) setLoading(false);
    }
  }, [onActivePlaylist]);

  // 暴露命令式方法给侧栏
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
      } else {
        setTab('listen');
      }
    },
  }), []);

  // 二维码登录
  const startQrLogin = useCallback(async () => {
    setQrLoading(true);
    setQrImg('');
    setQrStatus('正在生成二维码…');
    try {
      const { qrcode, token } = await qishuiQrCreate();
      if (!qrcode || !token) {
        setQrStatus('二维码生成失败，请稍后重试');
        return;
      }
      setQrImg(qrcode);
      setQrStatus('请用抖音/汽水音乐 App 扫码登录');
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        const st = await qishuiQrCheck(token);
        if (st.status === 'scanned') {
          setQrStatus('已扫描，请在手机上确认登录');
        } else if (st.status === 'confirmed' && st.cookie) {
          if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
          setQrImg('');
          setQrStatus('登录成功！正在获取用户信息…');
          const newAuth: QishuiAuth = {
            userid: st.userid || '',
            name: st.name || '汽水用户',
            avatar: st.avatar,
            cookie: st.cookie,
          };
          // 尝试拉取用户信息
          const info = await qishuiGetUserInfo(st.cookie);
          if (info) {
            newAuth.name = info.name;
            newAuth.avatar = info.avatar;
          }
          saveQishuiAuth(newAuth);
          setAuth(newAuth);
          setQrStatus('');
        } else if (st.status === 'expired') {
          if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
          setQrStatus('二维码已过期，请重新点击登录');
          setQrImg('');
        }
      }, 2000);
    } catch (e: any) {
      setQrStatus(`登录失败：${e?.message || e}`);
    } finally {
      setQrLoading(false);
    }
  }, []);

  // 退出登录
  const handleLogout = useCallback(async () => {
    if (auth?.cookie) await qishuiLogout(auth.cookie);
    clearQishuiAuth();
    setAuth(null);
    setQrStatus('');
    setQrImg('');
  }, [auth]);

  // 清理轮询
  useEffect(() => {
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, []);

  // 播放：取加密地址 + 解密 → objectURL → 回传播放器
  const doPlay = useCallback(async (list: QishuiTrack[], startIndex: number, sourceName: string) => {
    const track = list[startIndex];
    if (!track) return;
    setPlayingId(track.id);
    try {
      const resp = await qishuiGetSongUrl(track.id, 320000);
      if (!resp.url || !resp.spadeA) {
        setError('该歌曲暂无可播放地址（可能需会员或已下架）');
        setPlayingId(null);
        return;
      }
      // 沙箱内无 fetch，用 hostApi 代理下载二进制音频
      const hostApi = (window as any).__HOST_API__;
      const b64: string = await hostApi.invoke('qishui_download_audio', {
        url: resp.url,
        user_agent: 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36 com.luna.music/100197030',
        referer: 'https://music.douyin.com/',
      });
      // base64 → ArrayBuffer
      const binStr = atob(b64);
      const buf = new ArrayBuffer(binStr.length);
      const u8 = new Uint8Array(buf);
      for (let i = 0; i < binStr.length; i++) u8[i] = binStr.charCodeAt(i);
      const objectUrl = await decryptQishuiAudio(buf, resp.spadeA);
      const quality = track.br ? `${Math.round(track.br / 1000)}k` : '';
      const playable = trackToPlayable({ ...track, url: objectUrl }, objectUrl, quality);
      const playables: PlayableTrack[] = list.map((tr, i) =>
        i === startIndex ? playable : trackToPlayable(tr, '', '')
      );
      onPlay(playables, startIndex, sourceName);
      // 临时歌单回传
      onTempPlaylist?.({
        id: `qishui-temp-${Date.now()}`,
        name: sourceName,
        tracks: playables,
        payload: {
          kind: tab === 'search' ? 'search' : 'playlist',
          id: activePlaylist?.id as any,
          name: sourceName,
          keyword: tab === 'search' ? keyword.trim() : undefined,
          tracks: playables,
        },
      });
    } catch (e: any) {
      console.error('[qishui] play failed', e);
      setError(`播放失败：${e?.message || e}`);
      setPlayingId(null);
    }
  }, [onPlay, onTempPlaylist, tab, keyword, activePlaylist]);

  const playAll = useCallback(() => {
    if (tracks.length === 0) return;
    void doPlay(tracks, 0, activePlaylist?.name || (tab === 'search' ? `搜索：${keyword}` : '汽水音乐'));
  }, [tracks, doPlay, activePlaylist, tab, keyword]);

  const handlePlayTrack = useCallback((t: QishuiTrack) => {
    const idx = tracks.findIndex((x) => x.id === t.id);
    void doPlay(tracks, idx >= 0 ? idx : 0, activePlaylist?.name || '汽水音乐');
  }, [tracks, doPlay, activePlaylist]);

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden overflow-x-hidden relative bg-white dark:bg-[#1e1e1e]">
      {/* 顶栏：复用通用音乐模块模板 */}
      <MusicHeader
        title={
          activePlaylist
            ? activePlaylist.name
            : tab === 'search'
              ? '搜索'
              : tab === 'library'
                ? '漫游'
                : tab === 'about'
                  ? '关于'
                  : '汽水音乐'
        }
        onBackToSub={activePlaylist ? () => { setActivePlaylist(null); setPlaylistInfo(null); setTracks([]); } : undefined}
        onBackToSubTitle="返回"
        onUserClick={() => setTab('about')}
        onCloudClick={onBack}
        cloudTitle="音乐模块"
        user={auth ? { loggedIn: true, name: auth.name, avatarUrl: auth.avatar, initial: auth.name.charAt(0) } : { loggedIn: false }}
      />

      {/* 主内容区 */}
      <div className="flex-1 h-full min-w-0 overflow-y-auto overflow-x-hidden px-4 pb-4">
        {/* listen 首页 / 歌单详情 */}
        {tab === 'listen' && (
          <section className="min-w-0">
            {!activePlaylist ? (
              // 首页推荐流
              <React.Fragment>
                {loading && (
                  <div className="flex items-center justify-center gap-2 py-8 text-neutral-400 dark:text-stone-500 text-sm">
                    <Loader2 size={16} className="animate-spin" /> 加载中…
                  </div>
                )}
                {error && !loading && (
                  <div className="flex items-center gap-2 my-3 px-3 py-2 rounded-xl bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
                    <AlertCircle size={14} /> {error}
                  </div>
                )}

                {/* 推荐歌单 Hero + 横向滑动 */}
                {recommend.length > 0 && (
                  <div className="mb-5">
                    <div className="flex items-center gap-1.5 min-w-0 mb-3">
                      <Sparkles size={16} className="text-[#00c2c7] flex-shrink-0" />
                      <h3 className="text-base font-semibold text-neutral-800 dark:text-stone-100 truncate min-w-0">为你推荐</h3>
                    </div>
                    <HeroBanner
                      coverUrl={recommend[0]?.coverImgUrl}
                      title={recommend[0]?.name || '推荐歌单'}
                      badge="汽水精选"
                      subtitle={recommend[0]?.trackCount ? `${recommend[0].trackCount} 首` : undefined}
                      onClick={() => loadPlaylist(recommend[0].id, recommend[0].name)}
                      accent={ACCENT}
                    />
                    {recommend.length > 1 && (
                      <div className="mt-4">
                        <PlaylistGridRow
                          items={recommend.slice(1).map((p) => ({ id: p.id, name: p.name, coverUrl: p.coverImgUrl, subtitle: `${p.trackCount} 首` }))}
                          onOpen={(id, name) => loadPlaylist(String(id), name)}
                          accent={ACCENT}
                          emptyText="暂无推荐"
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* 热门榜单 */}
                {tops.length > 0 && (
                  <div className="mb-5">
                    <SectionTitle title="热门榜单" accent={ACCENT} />
                    <PlaylistGridRow
                      items={tops.map((p) => ({ id: p.id, name: p.name, coverUrl: p.coverImgUrl, subtitle: `${p.trackCount} 首` }))}
                      onOpen={(id, name) => loadPlaylist(String(id), name)}
                      accent={ACCENT}
                      emptyText="暂无榜单"
                    />
                  </div>
                )}

                {!loading && recommend.length === 0 && tops.length === 0 && (
                  <EmptyState title="暂无内容" desc="请稍后重试或检查网络连接" />
                )}
              </React.Fragment>
            ) : (
              // 歌单详情
              <div className="flex flex-col min-w-0">
                {loading && (
                  <div className="flex items-center justify-center gap-2 py-8 text-neutral-400 dark:text-stone-500 text-sm">
                    <Loader2 size={16} className="animate-spin" /> 加载中…
                  </div>
                )}
                {error && !loading && (
                  <div className="flex items-center gap-2 my-3 px-3 py-2 rounded-xl bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
                    <AlertCircle size={14} /> {error}
                  </div>
                )}
                {!loading && playlistInfo && (
                  <PlaylistDetailHeader
                    coverUrl={playlistInfo.cover}
                    name={playlistInfo.name}
                    brandLabel="汽水音乐"
                    trackCount={tracks.length}
                    accent={ACCENT}
                    onPlayAll={playAll}
                    canSubscribe={false}
                    subscribeDisabledHint="汽水音乐为游客态，无需登录"
                  />
                )}
                {!loading && tracks.length > 0 && (
                  <div className="space-y-0.5">
                    {tracks.map((t, i) => (
                      <TrackRow
                        key={t.id + i}
                        track={trackToPlayable(t, '')}
                        index={i}
                        isPlaying={playingId === t.id}
                        onPlay={() => handlePlayTrack(t)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* 搜索 */}
        {tab === 'search' && (
          <section>
            <SearchBar
              value={keyword}
              onChange={setKeyword}
              placeholder="搜索歌曲 / 歌手"
              autoFocus
            />
            {loading && (
              <div className="flex items-center justify-center gap-2 py-8 text-neutral-400 dark:text-stone-500 text-sm">
                <Loader2 size={16} className="animate-spin" /> 搜索中…
              </div>
            )}
            {error && !loading && (
              <div className="flex items-center gap-2 my-3 px-3 py-2 rounded-xl bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
                <AlertCircle size={14} /> {error}
              </div>
            )}
            {!loading && tracks.length > 0 && (
              <>
                <div className="flex items-center justify-between px-1 py-2">
                  <span className="text-xs text-neutral-500 dark:text-stone-400">共 {tracks.length} 首</span>
                  <button onClick={playAll} className="btn-press flex items-center gap-1.5 px-4 py-1.5 rounded-full text-white text-sm font-medium" style={{ background: ACCENT }}>
                    <Play size={14} /> 播放全部
                  </button>
                </div>
                <div className="space-y-0.5">
                  {tracks.map((t, i) => (
                    <TrackRow
                      key={t.id + i}
                      track={trackToPlayable(t, '')}
                      index={i}
                      isPlaying={playingId === t.id}
                      onPlay={() => handlePlayTrack(t)}
                    />
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        {/* 漫游（游客态：复用推荐+榜单，以流式呈现） */}
        {tab === 'library' && (
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-neutral-800 dark:text-stone-100">漫游</h2>
              <button
                onClick={() => { setRecommend([]); setTops([]); void loadHome(); }}
                className="btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-stone-100 dark:bg-stone-800 text-neutral-600 dark:text-stone-300 text-sm hover:bg-stone-200 dark:hover:bg-stone-700 transition-colors"
                title="换一批"
              >
                <Sparkles size={14} /> 换一批
              </button>
            </div>
            {loading && (
              <div className="flex items-center justify-center gap-2 py-8 text-neutral-400 dark:text-stone-500 text-sm">
                <Loader2 size={16} className="animate-spin" /> 加载中…
              </div>
            )}
            {!loading && recommend.length > 0 && (
              <div className="mb-5">
                <SectionTitle title="发现歌单" accent={ACCENT} />
                <PlaylistGridRow
                  items={recommend.map((p) => ({ id: p.id, name: p.name, coverUrl: p.coverImgUrl, subtitle: `${p.trackCount} 首` }))}
                  onOpen={(id, name) => loadPlaylist(String(id), name)}
                  accent={ACCENT}
                  emptyText="暂无歌单"
                />
              </div>
            )}
            {!loading && tops.length > 0 && (
              <div className="mb-5">
                <SectionTitle title="热门榜单" accent={ACCENT} />
                <PlaylistGridRow
                  items={tops.map((p) => ({ id: p.id, name: p.name, coverUrl: p.coverImgUrl, subtitle: `${p.trackCount} 首` }))}
                  onOpen={(id, name) => loadPlaylist(String(id), name)}
                  accent={ACCENT}
                  emptyText="暂无榜单"
                />
              </div>
            )}
            {!loading && recommend.length === 0 && tops.length === 0 && (
              <EmptyState title="暂无漫游内容" />
            )}
          </section>
        )}

        {/* 关于 / 登录 */}
        {tab === 'about' && (
          <div className="max-w-md mx-auto flex flex-col gap-5 py-8">
            {auth ? (
              // 已登录：显示用户信息
              <div className="flex flex-col items-center gap-3 p-5 rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60">
                <div className="w-20 h-20 rounded-full overflow-hidden bg-neutral-200 dark:bg-stone-700 flex items-center justify-center text-white shadow-lg" style={{ background: ACCENT }}>
                  {auth.avatar ? (
                    <img src={auth.avatar} alt={auth.name} className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-2xl font-bold">{auth.name.charAt(0)}</span>
                  )}
                </div>
                <div className="text-center">
                  <h2 className="text-base font-semibold text-neutral-800 dark:text-stone-100">{auth.name}</h2>
                  <p className="text-xs text-neutral-500 dark:text-stone-400 mt-1">汽水音乐用户</p>
                </div>
                <button
                  onClick={handleLogout}
                  className="btn-press px-4 py-1.5 rounded-lg bg-neutral-200/60 dark:bg-stone-800/60 text-sm text-neutral-700 dark:text-stone-200 hover:bg-neutral-300/60 dark:hover:bg-stone-700/60 transition-colors"
                >
                  退出登录
                </button>
              </div>
            ) : qrImg ? (
              // 二维码已生成
              <div className="max-w-sm mx-auto flex flex-col items-center gap-4 p-6 rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60">
                <h2 className="text-base font-semibold text-neutral-800 dark:text-stone-100">扫码登录汽水音乐</h2>
                <img src={qrImg} alt="登录二维码" className="w-48 h-48 rounded-xl bg-white p-2" />
                <div className="text-sm text-neutral-500 dark:text-stone-400 text-center min-h-[1.5em]">{qrStatus}</div>
                <button onClick={startQrLogin} className="btn-press px-4 py-1.5 rounded-lg bg-neutral-200/60 dark:bg-stone-800/60 text-sm text-neutral-700 dark:text-stone-200 hover:bg-neutral-300/60 dark:hover:bg-stone-700/60 transition-colors">
                  刷新二维码
                </button>
              </div>
            ) : (
              // 未登录：显示登录按钮
              <div className="max-w-sm mx-auto flex flex-col items-center gap-4 p-8 rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60">
                <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-white shadow-lg" style={{ background: ACCENT }}>
                  <Music2 size={32} />
                </div>
                <div className="text-center">
                  <h2 className="text-base font-semibold text-neutral-800 dark:text-stone-100 mb-1">登录汽水音乐</h2>
                  <p className="text-xs text-neutral-500 dark:text-stone-400">扫码登录后可同步歌单、收藏与更高音质</p>
                </div>
                <button
                  onClick={startQrLogin}
                  disabled={qrLoading}
                  className="btn-press w-full px-5 py-2.5 rounded-xl text-white text-sm font-medium transition-colors disabled:opacity-50"
                  style={{ background: ACCENT }}
                >
                  {qrLoading ? '生成中…' : '立即扫码登录'}
                </button>
                <div className="text-xs text-neutral-400 dark:text-stone-500 text-center min-h-[1.2em]">{qrStatus}</div>
              </div>
            )}
            <div className="p-4 rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60">
              <h3 className="text-sm font-semibold text-neutral-800 dark:text-stone-100 mb-2">说明</h3>
              <p className="text-xs text-neutral-500 dark:text-stone-400 leading-relaxed">
                汽水音乐支持游客模式，无需登录即可使用搜索、推荐和播放功能。
                登录后可同步收藏歌单、获取更高音质及个性化推荐。VIP / 付费歌曲可能无法播放完整音频。
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
