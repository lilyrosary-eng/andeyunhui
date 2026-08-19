// 共享歌曲详情抽屉（歌手 / 专辑）UI 骨架
//
// 设计原则：
//   - 纯 UI 组件，不调用任何 API
//   - 数据通过 props 传入（各端负责格式化后传入）
//   - 业务回调通过 props 传出（各端自行处理）
//   - 使用 _shared/TrackRow 渲染曲目行
//
// 使用方式（以网易云为例）：
//   <DetailDrawer
//     drawer={drawer}
//     onClose={closeDrawer}
//     callbacks={{ onPlayTracks, onPlayMv, onOpenArtist, onOpenAlbum, onSubscribe, onLikeTrack }}
//     artist={artistData}
//     album={albumData}
//     isLoading={loading}
//     accentColor="#f44336"
//     loggedIn={loggedIn}
//     likedTracks={likedSongs}
//     subscribedAlbums={subscribedAlbums}
//   />
//
// 酷狗接入时只需传入格式化的 singerDetail / albumDetail，API 层由 KugouView 负责。

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { PlayIcon, HeartIcon, VideoIcon, DownloadIcon, ChevronLeft, ChevronRight } from 'lucide-react';
import { TrackRow, type PlayableTrack, type TrackBadge } from './TrackRow';

// ============ 数据接口（共享层） ============

export interface SharedArtistData {
  id: number | string;
  name: string;
  cover?: string;
  alias?: string[];
  musicSize?: number;
  albumSize?: number;
  mvSize?: number;
  description?: string;
  hotSongs?: PlayableTrack[];
  allSongs?: PlayableTrack[];
  albums?: SharedAlbumCard[];
  mvs?: SharedMvCard[];
  similarArtists?: SharedArtistCard[];
  loading?: boolean;
  error?: string;
}

export interface SharedAlbumCard {
  id: number | string;
  name: string;
  cover: string;
  publishTime?: string;
  size?: number;
}

export interface SharedMvCard {
  id: number | string;
  name: string;
  cover: string;
  playCount?: number;
}

export interface SharedArtistCard {
  id: number | string;
  name: string;
  cover: string;
}

export interface SharedAlbumData {
  id: number | string;
  name: string;
  cover: string;
  artistName: string;
  artistId?: number | string;
  publishTime?: string;
  company?: string;
  description?: string;
  size?: number;
  tracks?: PlayableTrack[];
  subed?: boolean;
  loading?: boolean;
  error?: string;
}

export type SharedDrawerType =
  | { type: 'none' }
  | { type: 'artist'; id: number | string }
  | { type: 'album'; id: number | string };

export interface SharedDrawerCallbacks {
  onPlayTracks: (tracks: PlayableTrack[], startIndex: number, name?: string) => void;
  onPlayMv?: (mv: { id: string; name: string; artist: string; cover: string; url: string }) => void;
  onOpenArtist?: (id: number | string) => void;
  onOpenAlbum?: (id: number | string) => void;
  onSubscribe?: (id: number | string, subscribe: boolean) => void;
  onLikeTrack?: (trackId: string, liked: boolean) => void;
  onDownload?: (trackId: string) => void;
}

export interface DetailDrawerProps {
  drawer: SharedDrawerType;
  onClose: () => void;
  callbacks: SharedDrawerCallbacks;

  // 数据（由调用方提供，本组件不自行拉取）
  artist?: SharedArtistData | null;
  album?: SharedAlbumData | null;

  // 状态
  isLoading?: boolean;
  error?: string;

  // 样式
  accentColor?: string;

  // 登录态（用于判断订阅按钮可用性）
  loggedIn?: boolean;

  // 已收藏/已订阅状态
  likedTracks?: Set<string>;
  subscribedAlbums?: Set<number | string>;
}

// ============ 工具函数 ============

function formatDuration(sec: number): string {
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function fmtCount(n: number): string {
  if (!n) return '0';
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
  return String(n);
}

function getCoverUrl(path?: string): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  const host = (window as any).__HOST_API__;
  if (host?.convertFileSrc) return host.convertFileSrc(path);
  return path;
}

// ============ 子组件：歌手头部 ============

function ArtistHeader({
  artist,
  onPlayHot,
}: {
  artist: SharedArtistData;
  onPlayHot: () => void;
}) {
  return (
    <div className="flex gap-4 items-center">
      {artist.cover ? (
        <img
          src={artist.cover}
          alt={artist.name}
          className="w-24 h-24 rounded-2xl object-cover shadow-sm shrink-0"
        />
      ) : (
        <div className="w-24 h-24 rounded-2xl bg-neutral-200 dark:bg-stone-800 flex items-center justify-center text-3xl font-bold text-neutral-400 dark:text-stone-500 shrink-0">
          {artist.name.slice(0, 1)}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <h2 className="text-2xl font-bold text-neutral-800 dark:text-stone-100 truncate">{artist.name}</h2>
        {artist.alias && artist.alias.length > 0 && (
          <div className="text-xs text-neutral-500 dark:text-stone-400 mt-0.5 truncate">
            {artist.alias.join(' / ')}
          </div>
        )}
        <div className="flex flex-wrap gap-3 mt-2 text-xs text-neutral-500 dark:text-stone-400">
          <span>单曲 {fmtCount(artist.musicSize || 0)}</span>
          <span>专辑 {fmtCount(artist.albumSize || 0)}</span>
          <span>MV {fmtCount(artist.mvSize || 0)}</span>
        </div>
      </div>
    </div>
  );
}

// ============ 子组件：专辑头部 ============

function AlbumHeader({
  album,
  onOpenArtist,
}: {
  album: SharedAlbumData;
  onOpenArtist?: (id: number | string) => void;
}) {
  return (
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
        {album.artistId && onOpenArtist ? (
          <button
            onClick={() => onOpenArtist(album.artistId!)}
            className="text-xs text-neutral-500 dark:text-stone-400 mt-0.5 hover:text-emerald-500 dark:hover:text-emerald-400 hover:underline cursor-pointer"
          >
            {album.artistName}
          </button>
        ) : (
          <div className="text-xs text-neutral-500 dark:text-stone-400 mt-0.5">{album.artistName}</div>
        )}
        <div className="text-xs text-neutral-500 dark:text-stone-400 mt-1 truncate">
          {[album.publishTime, album.company, album.size ? `${album.size} 首` : null]
            .filter(Boolean)
            .join(' · ')}
        </div>
        {album.description ? (
          <p className="text-xs text-neutral-400 dark:text-stone-500 mt-1 line-clamp-2">{album.description}</p>
        ) : null}
      </div>
    </div>
  );
}

// ============ 主组件 ============

export const DetailDrawer: React.FC<DetailDrawerProps> = ({
  drawer,
  onClose,
  callbacks,
  artist,
  album,
  isLoading,
  error,
  accentColor = '#f44336',
  loggedIn = false,
  likedTracks,
  subscribedAlbums,
}) => {
  // ===== 抽屉开合动画 =====
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const open = drawer.type !== 'none';

  useEffect(() => {
    if (open) {
      if (closeTimer.current) {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
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

  // ===== 专辑排序 / 视图状态 =====
  const [albumSort, setAlbumSort] = useState<'index' | 'duration' | 'title'>('index');
  const [albumView, setAlbumView] = useState<'list' | 'grid'>('list');
  const [allSongsOpen, setAllSongsOpen] = useState(false);

  // ===== 歌手全部歌曲加载状态 =====
  const [allSongsLoaded, setAllSongsLoaded] = useState(false);

  // 当切换到歌手时重置折叠状态
  useEffect(() => {
    if (drawer.type === 'artist') {
      setAllSongsOpen(false);
      setAllSongsLoaded(false);
    }
  }, [drawer.type, drawer.id]);

  // 专辑曲目排序
  const sortedAlbumTracks = useMemo(() => {
    if (!album?.tracks) return [];
    const arr = [...album.tracks];
    if (albumSort === 'duration') {
      arr.sort((a, b) => a.durationSecs - b.durationSecs);
    } else if (albumSort === 'title') {
      arr.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
    }
    return arr;
  }, [album?.tracks, albumSort]);

  if (!mounted) return null;

  return (
    <div className="absolute inset-0 z-40">
      {/* 遮罩 */}
      <button
        aria-label="关闭详情"
        onClick={handleClose}
        className={`absolute inset-0 bg-black/40 backdrop-blur-[1px] transition-opacity duration-300 ease-out ${visible ? 'opacity-100' : 'opacity-0'}`}
      />
      {/* 抽屉面板 */}
      <div
        className={`absolute left-0 right-0 top-0 h-[80%] rounded-b-3xl bg-white dark:bg-[#232323] shadow-2xl overflow-y-auto overscroll-contain transition-transform duration-300 ease-out will-change-transform ${visible ? 'translate-y-0' : '-translate-y-full'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部操作条 */}
        <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-3 bg-white/90 dark:bg-[#232323]/90 backdrop-blur border-b border-neutral-200/60 dark:border-stone-700/60">
          <button
            onClick={handleClose}
            className="btn-press flex items-center justify-center p-1.5 rounded-lg text-neutral-500 dark:text-stone-400 hover:bg-neutral-200/60 dark:hover:bg-stone-800/60 transition-colors"
            title="返回"
          >
            <ChevronLeft size={20} />
          </button>
          <span className="text-sm font-semibold text-neutral-800 dark:text-stone-100 truncate">
            {drawer.type === 'artist'
              ? (artist?.name || '歌手详情')
              : drawer.type === 'album'
                ? (album?.name || '专辑详情')
                : ''}
          </span>
        </div>

        {/* 加载中 */}
        {isLoading && (
          <div className="text-sm text-neutral-400 dark:text-stone-500 py-10 text-center">加载中…</div>
        )}

        {/* 错误 */}
        {error && (
          <div className="text-sm text-red-500/80 dark:text-red-400/80 py-10 text-center">{error}</div>
        )}

        {/* ===== 歌手详情 ===== */}
        {drawer.type === 'artist' && artist && !isLoading && (
          <div className="p-4 space-y-6">
            <ArtistHeader
              artist={artist}
              onPlayHot={() => {
                if (artist.hotSongs?.length) {
                  callbacks.onPlayTracks(artist.hotSongs, 0, `${artist.name} 热门`);
                }
              }}
            />

            {/* 热门歌曲 */}
            {artist.hotSongs && artist.hotSongs.length > 0 && (
              <section>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-neutral-700 dark:text-stone-200">热门歌曲</h3>
                  <button
                    onClick={() => callbacks.onPlayTracks(artist.hotSongs!, 0, `${artist.name} 热门`)}
                    className="btn-press flex items-center gap-1 px-3 py-1 rounded-full bg-neutral-800 dark:bg-stone-100 text-white dark:text-stone-900 text-xs font-medium hover:bg-neutral-700 dark:hover:bg-stone-200 transition-colors"
                  >
                    <PlayIcon size={12} /> 播放全部
                  </button>
                </div>
                <div className="flex flex-col gap-0.5">
                  {artist.hotSongs.map((t, i) => (
                    <TrackRow
                      key={t.id}
                      track={{
                        ...t,
                        artistId: undefined,
                        albumId: undefined,
                        mvId: undefined,
                        badges: [],
                      }}
                      index={i}
                      isPlaying={false}
                      onPlay={() => callbacks.onPlayTracks(artist!.hotSongs!, i, `${artist.name} 热门`)}
                      onLike={likedTracks?.has(t.id)
                        ? (e) => { e.stopPropagation(); callbacks.onLikeTrack?.(t.id, false); }
                        : (e) => { e.stopPropagation(); callbacks.onLikeTrack?.(t.id, true); }
                      }
                      isLiked={likedTracks?.has(t.id) || false}
                      onOpenArtist={callbacks.onOpenArtist ? (e) => { e.stopPropagation(); callbacks.onOpenArtist!(t.artistId!); } : undefined}
                      onOpenAlbum={callbacks.onOpenAlbum ? (e) => { e.stopPropagation(); callbacks.onOpenAlbum!(t.albumId!); } : undefined}
                      onPlayMv={callbacks.onPlayMv ? (e) => { e.stopPropagation(); callbacks.onPlayMv!({ id: String(t.mvId ?? ''), name: t.title, artist: t.artist, cover: t.coverPath ?? '', url: '' }); } : undefined}
                      onDownload={callbacks.onDownload ? () => { callbacks.onDownload!(t.id); } : undefined}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* 全部歌曲折叠入口 */}
            {artist.allSongs && artist.allSongs.length > 0 && (
              <section>
                <button
                  onClick={() => setAllSongsOpen((v) => !v)}
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
                    {artist.allSongs.map((t, i) => (
                      <TrackRow
                        key={t.id}
                        track={{
                          ...t,
                          artistId: undefined,
                          albumId: undefined,
                          mvId: undefined,
                          badges: [],
                        }}
                        index={i}
                        isPlaying={false}
                        onPlay={() => callbacks.onPlayTracks(artist!.allSongs!, i, `${artist.name} 全部`)}
                        onLike={likedTracks?.has(t.id)
                          ? (e) => { e.stopPropagation(); callbacks.onLikeTrack?.(t.id, false); }
                          : (e) => { e.stopPropagation(); callbacks.onLikeTrack?.(t.id, true); }
                        }
                        isLiked={likedTracks?.has(t.id) || false}
                        onOpenArtist={callbacks.onOpenArtist ? (e) => { e.stopPropagation(); callbacks.onOpenArtist!(t.artistId!); } : undefined}
                        onOpenAlbum={callbacks.onOpenAlbum ? (e) => { e.stopPropagation(); callbacks.onOpenAlbum!(t.albumId!); } : undefined}
                        onPlayMv={callbacks.onPlayMv ? (e) => { e.stopPropagation(); callbacks.onPlayMv!({ id: String(t.mvId ?? ''), name: t.title, artist: t.artist, cover: t.coverPath ?? '', url: '' }); } : undefined}
                        onDownload={callbacks.onDownload ? () => { callbacks.onDownload!(t.id); } : undefined}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* 专辑列表 */}
            {artist.albums && artist.albums.length > 0 && (
              <section>
                <h3 className="text-sm font-semibold text-neutral-700 dark:text-stone-200 mb-2">专辑</h3>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                  {artist.albums.map((al) => (
                    <button
                      key={al.id}
                      onClick={() => callbacks.onOpenAlbum?.(al.id)}
                      className="text-left group"
                      title={al.name}
                    >
                      <div className="relative aspect-square rounded-xl overflow-hidden bg-neutral-200 dark:bg-stone-800 mb-1.5">
                        <img src={al.cover} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                      </div>
                      <div className="text-xs text-neutral-800 dark:text-stone-100 line-clamp-2 leading-tight min-h-[2em]">{al.name}</div>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {/* MV 列表 */}
            {artist.mvs && artist.mvs.length > 0 && callbacks.onPlayMv && (
              <section>
                <h3 className="text-sm font-semibold text-neutral-700 dark:text-stone-200 mb-2">MV</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {artist.mvs.map((m) => (
                    <div
                      key={m.id}
                      className="group cursor-pointer"
                      onClick={() => callbacks.onPlayMv!({
                        id: String(m.id), name: m.name, artist: '', cover: m.cover, url: '',
                      })}
                    >
                      <div className="relative aspect-video rounded-xl overflow-hidden bg-neutral-200 dark:bg-stone-800 mb-1.5">
                        <img src={m.cover} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                        <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                          <PlayIcon size={22} className="text-white" />
                        </div>
                        {m.playCount && m.playCount > 0 && (
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

            {/* 歌手简介 */}
            {artist.description && (
              <section>
                <h3 className="text-sm font-semibold text-neutral-700 dark:text-stone-200 mb-2">歌手简介</h3>
                <p className="text-xs text-neutral-500 dark:text-stone-400 whitespace-pre-wrap leading-relaxed">{artist.description}</p>
              </section>
            )}

            {/* 相似艺人 */}
            {artist.similarArtists && artist.similarArtists.length > 0 && (
              <section>
                <h3 className="text-sm font-semibold text-neutral-700 dark:text-stone-200 mb-2">相似艺人</h3>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                  {artist.similarArtists.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => callbacks.onOpenArtist?.(a.id)}
                      className="text-left group"
                      title={a.name}
                    >
                      <div className="relative aspect-square rounded-full overflow-hidden bg-neutral-200 dark:bg-stone-800 mb-1.5">
                        <img src={a.cover} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                      </div>
                      <div className="text-xs text-neutral-800 dark:text-stone-100 text-center line-clamp-1">{a.name}</div>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {/* ===== 专辑详情 ===== */}
        {drawer.type === 'album' && album && !isLoading && (
          <div className="p-4 space-y-5">
            <AlbumHeader album={album} onOpenArtist={callbacks.onOpenArtist} />

            {/* 操作栏 */}
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => callbacks.onPlayTracks(album.tracks!, 0, album.name)}
                className="btn-press flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-neutral-800 dark:bg-stone-100 text-white dark:text-stone-900 text-sm font-medium hover:bg-neutral-700 dark:hover:bg-stone-200 transition-colors"
              >
                <PlayIcon size={14} /> 播放全部
              </button>

              {callbacks.onSubscribe && (
                <button
                  onClick={() => {
                    callbacks.onSubscribe!(album.id, !(subscribedAlbums?.has(album.id) ?? false));
                  }}
                  disabled={!loggedIn}
                  className="btn-press flex items-center gap-1.5 px-4 py-1.5 rounded-full border border-neutral-300 dark:border-stone-700 text-neutral-700 dark:text-stone-200 text-sm hover:bg-neutral-100 dark:hover:bg-stone-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  title={loggedIn ? ((subscribedAlbums?.has(album.id) ? '取消收藏专辑' : '收藏专辑')) : '请先登录'}
                >
                  <HeartIcon size={14} fill={subscribedAlbums?.has(album.id) ? 'currentColor' : 'none'} />
                  {subscribedAlbums?.has(album.id) ? '已收藏' : '收藏'}
                </button>
              )}

              <div className="flex items-center gap-1 ml-auto">
                {/* 排序 */}
                <div className="flex items-center rounded-full bg-neutral-100 dark:bg-stone-800 p-0.5 text-xs">
                  {(['index', 'duration', 'title'] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => setAlbumSort(s)}
                      className={`px-2.5 py-1 rounded-full transition-colors ${albumSort === s ? 'bg-white dark:bg-stone-600 text-neutral-800 dark:text-stone-100 shadow-sm' : 'text-neutral-500 dark:text-stone-400'}`}
                    >
                      {s === 'index' ? '默认' : s === 'duration' ? '时长' : '名称'}
                    </button>
                  ))}
                </div>
                {/* 视图切换 */}
                <div className="flex items-center rounded-full bg-neutral-100 dark:bg-stone-800 p-0.5 text-xs">
                  {(['list', 'grid'] as const).map((v) => (
                    <button
                      key={v}
                      onClick={() => setAlbumView(v)}
                      className={`px-2.5 py-1 rounded-full transition-colors ${albumView === v ? 'bg-white dark:bg-stone-600 text-neutral-800 dark:text-stone-100 shadow-sm' : 'text-neutral-500 dark:text-stone-400'}`}
                    >
                      {v === 'list' ? '列表' : '网格'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 曲目列表 / 网格 */}
            {album.tracks && album.tracks.length > 0 && (
              albumView === 'list' ? (
                <div className="flex flex-col gap-0.5">
                  {sortedAlbumTracks.map((t, i) => (
                    <TrackRow
                      key={t.id}
                      track={{
                        ...t,
                        artistId: undefined,
                        albumId: undefined,
                        mvId: undefined,
                        badges: [],
                      }}
                      index={i}
                      isPlaying={false}
                      onPlay={() => callbacks.onPlayTracks(album.tracks!, album.tracks!.indexOf(t), album.name)}
                      onLike={likedTracks?.has(t.id)
                        ? (e) => { e.stopPropagation(); callbacks.onLikeTrack?.(t.id, false); }
                        : (e) => { e.stopPropagation(); callbacks.onLikeTrack?.(t.id, true); }
                      }
                      isLiked={likedTracks?.has(t.id) || false}
                      onOpenArtist={callbacks.onOpenArtist ? (e) => { e.stopPropagation(); callbacks.onOpenArtist!(t.artistId!); } : undefined}
                      onOpenAlbum={callbacks.onOpenAlbum ? (e) => { e.stopPropagation(); callbacks.onOpenAlbum!(t.albumId!); } : undefined}
                      onPlayMv={callbacks.onPlayMv ? (e) => { e.stopPropagation(); callbacks.onPlayMv!({ id: String(t.mvId ?? ''), name: t.title, artist: t.artist, cover: t.coverPath ?? '', url: '' }); } : undefined}
                      onDownload={callbacks.onDownload ? () => { callbacks.onDownload!(t.id); } : undefined}
                    />
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                  {sortedAlbumTracks.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => callbacks.onPlayTracks(album.tracks!, album.tracks!.indexOf(t), album.name)}
                      className="text-left group"
                      title={t.title}
                    >
                      <div className="relative aspect-square rounded-xl overflow-hidden bg-neutral-200 dark:bg-stone-800 mb-1.5">
                        {t.coverPath ? (
                          <img src={getCoverUrl(t.coverPath) ?? t.coverPath} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-xl font-bold text-white/80" style={{ background: `linear-gradient(135deg, ${accentColor}40, #3b82f640)` }}>
                            {t.title.slice(0, 1)}
                          </div>
                        )}
                        <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity">
                          <PlayIcon size={20} className="text-white" />
                        </div>
                      </div>
                      <div className="text-xs text-neutral-800 dark:text-stone-100 line-clamp-2 leading-tight min-h-[2em]">{t.title}</div>
                    </button>
                  ))}
                </div>
              )
            )}

            {!album.tracks || album.tracks.length === 0 ? (
              <div className="text-sm text-neutral-400 dark:text-stone-500 py-8 text-center">暂无曲目</div>
            ) : null}
          </div>
        )}

        {/* 无内容 */}
        {drawer.type !== 'none' && !isLoading && !error && !artist && !album && (
          <div className="text-sm text-neutral-400 dark:text-stone-500 py-10 text-center">暂无详情数据</div>
        )}
      </div>
    </div>
  );
};

export default DetailDrawer;
