/// <reference path="../../global.d.ts" />
import React from "react";
// 音乐插件入口
import { MusicSidebar } from './MusicSidebar';
import { TrackList } from './TrackList';
import { ModuleDrawer } from './ModuleDrawer';
import { PlayerBar } from './PlayerBar';
import { NowPlayingView } from './NowPlayingView';
import { NeteaseView, type PlayableTrack, type TempPlaylist, type NeteaseViewHandle } from './NeteaseView';
import { KugouView } from './KugouView';
import KugouSidebar from './KugouSidebar';
import NeteaseSidebar from './NeteaseSidebar';
import { useOnlineSource } from './useOnlineSource';
import type { KugouPlaylistCard } from './kugouApi';
import NeteaseStatsView from './NeteaseStatsView';
import NeteaseSettingsPanel from './NeteaseSettingsPanel';
import KugouStatsView from './KugouStatsView';
import KugouSettingsPanel from './KugouSettingsPanel';
import { isLikedPlaylist, likeNeteaseSong, type NeteasePlaylistItem, type NeteaseProfile } from './neteaseApi';
import { musicPlayer, type Track, type PlayMode } from './musicPlayer';
import { useRootPaths, useBlacklist, EmptyState, LoadingState, NoResultsState, T, useLang } from '../../_shared/pluginRuntime';
import { dispatchOpenWith, registerOpenWithListener, getPendingOpenWith, importToOpenWithDir, type OpenWithItem } from '../../_shared/openWithFiles';

const { useState, useEffect, useCallback, useRef, useMemo } = React;
const hostApi = window.__HOST_API__;

export interface Playlist {
  id: string;
  name: string;
  tracks: Track[];
  type: 'directory' | 'custom' | 'netease-temp' | 'kugou-temp';
}

interface MusicScanProgress {
  found: number;
  total: number;
  done: boolean;
}

const STORAGE_KEY_ROOT = 'music_plugin_root_paths';
const STORAGE_KEY_PLAYLISTS = 'music_playlists';
const STORAGE_KEY_HIDDEN = 'music_plugin_hidden_playlists'; // 兼容旧版

// 从 localStorage 读取已持久化的自定义歌单（与保存逻辑共用同一 key）
function getCustomPlaylistsFromStorage(): Playlist[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_PLAYLISTS);
    return saved ? (JSON.parse(saved) as Playlist[]) : [];
  } catch {
    return [];
  }
}

// 将前端 Track 映射为 SQLite 歌单曲目（track_id 用 file_path，保证同文件唯一）
function toPlaylistTrack(t: Track) {
  return {
    trackId: t.id || t.filePath,
    position: 0,
    title: t.title || '',
    artist: t.artist || '',
    album: t.album || '',
    filePath: t.filePath || '',
    coverPath: t.coverPath || '',
    durationMs: Math.round((t.durationSecs || 0) * 1000),
  };
}

// 自建歌单同步到 SQLite：把整张歌单的曲目以 replace 方式落库，作为持久化真源。
// 调用为 fire-and-forget，失败仅告警不影响内存状态（localStorage 仍作兜底镜像）。
function syncCustomPlaylistToDb(playlist: Playlist) {
  if (playlist.type !== 'custom') return;
  try {
    hostApi
      .invoke('music_replace_playlist_tracks', {
        playlistId: playlist.id,
        tracks: playlist.tracks.map(toPlaylistTrack),
      })
      .catch((e) => console.warn('[Music] 同步歌单到 SQLite 失败:', playlist.id, e));
  } catch (e) {
    console.warn('[Music] 同步歌单到 SQLite 异常:', playlist.id, e);
  }
}

// track_id 统一用 file_path（保证同文件唯一），与 toPlaylistTrack 保持一致
function trackIdOf(t: Track): string {
  return t.id || t.filePath || '';
}

// 前端 Track → SQLite favorite 记录
function toFavoriteTrack(t: Track) {
  return {
    trackId: trackIdOf(t),
    title: t.title || '',
    artist: t.artist || '',
    album: t.album || '',
    filePath: t.filePath || '',
    coverPath: t.coverPath || '',
    durationMs: Math.round((t.durationSecs || 0) * 1000),
    addedAt: Date.now(),
  };
}

// 收藏状态落 SQLite（fire-and-forget）
function syncFavoriteToDb(t: Track, favorite: boolean) {
  try {
    hostApi
      .invoke('music_set_favorite', { track: toFavoriteTrack(t), favorite })
      .catch((e) => console.warn('[Music] 收藏状态同步失败:', trackIdOf(t), e));
  } catch (e) {
    console.warn('[Music] 收藏状态同步异常:', trackIdOf(t), e);
  }
}

// 从 SQLite 加载收藏集合（track_id set），作为重载后的真源
async function loadFavoritesFromDb(): Promise<Set<string>> {
  try {
    const rows = await hostApi.invoke<{ trackId: string }[]>('music_list_favorites');
    return new Set(rows.map((r) => r.trackId));
  } catch (e) {
    console.warn('[Music] 加载收藏失败，回退 localStorage:', e);
    try {
      const saved = localStorage.getItem('music_favorites');
      return new Set(saved ? (JSON.parse(saved) as string[]) : []);
    } catch {
      return new Set();
    }
  }
}

// 由收藏集合生成「我的收藏」虚拟歌单（type: 'favorite'，不独立落库，由 favorites 表驱动）
function buildFavoritePlaylist(favIds: Set<string>, allTracks: Track[]): Playlist | null {
  if (favIds.size === 0) return null;
  const tracks = allTracks.filter((t) => favIds.has(trackIdOf(t)));
  return { id: '__favorite__', name: T('music.favoritePlaylist'), tracks, type: 'custom' };
}

// 播放状态持久化：把上次播放的 track_id / position / volume / 模式写入 SQLite
function savePlayerStateToDb(key: string, value: string) {
  try {
    hostApi.invoke('music_save_player_state', { key, value }).catch((e) => console.warn('[Music] 播放状态保存失败:', key, e));
  } catch (e) {
    console.warn('[Music] 播放状态保存异常:', key, e);
  }
}

// 精确进度续播：保存当前播放位置（秒，取整）到 player_state 的 'position' key
function savePositionToDb() {
  try {
    const pos = Math.round(musicPlayer.getCurrentTime());
    if (pos > 0) savePlayerStateToDb('position', String(pos));
  } catch (e) {
    console.warn('[Music] 播放位置保存异常:', e);
  }
}

// 收集当前所有可见曲目（目录 + 自定义），供收藏歌单解析
function collectAllTracks(playlists: Playlist[]): Track[] {
  const map = new Map<string, Track>();
  for (const p of playlists) {
    for (const t of p.tracks) {
      const id = trackIdOf(t);
      if (id && !map.has(id)) map.set(id, t);
    }
  }
  return [...map.values()];
}

// 从 SQLite 加载封面覆盖映射（手动设封面的持久化真源）
async function loadCoverOverridesFromDb(): Promise<Map<string, string>> {
  try {
    const rows = await hostApi.invoke<{ filePath: string; coverPath: string }[]>('music_get_all_cover_overrides');
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.filePath, r.coverPath);
    console.log('[Music][探针] loadCoverOverridesFromDb 加载条数:', m.size);
    return m;
  } catch (e) {
    console.warn('[Music] 加载封面覆盖失败:', e);
    return new Map();
  }
}

// 把封面覆盖应用到内存 playlists（所有同 file_path 的 track 同步封面）
function applyCoverOverrides(playlists: Playlist[], overrides: Map<string, string>): Playlist[] {
  if (overrides.size === 0) return playlists;
  let matched = 0;
  let changed = 0;
  const result = playlists.map((p) => ({
    ...p,
    tracks: p.tracks.map((t) => {
      const fp = t.filePath || t.id;
      if (fp && overrides.has(fp)) {
        matched++;
        const cov = overrides.get(fp);
        if (cov !== t.coverPath) {
          changed++;
          return { ...t, coverPath: cov };
        }
      }
      return t;
    }),
  }));
  console.log('[Music][探针] applyCoverOverrides: 歌单数=', playlists.length, '覆盖数=', overrides.size, '匹配曲目=', matched, '实际变更=', changed);
  return result;
}

// 文件读为 base64（用于手动设封面）
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // result 形如 "data:image/png;base64,xxxx"，取逗号后部分
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

// 手动设封面：选图片文件 → base64 → music_set_cover，更新内存 + override map
async function setCoverForTrack(track: Track, overrides: Map<string, string>): Promise<Map<string, string>> {
  const fp = track.filePath || track.id;
  if (!fp) return overrides;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.style.position = 'fixed';
  input.style.opacity = '0';
  input.style.pointerEvents = 'none';
  input.style.zIndex = '-1';
  document.body.appendChild(input);
  const picked = await new Promise<File | null>((resolve) => {
    input.onchange = () => resolve(input.files && input.files[0] ? input.files[0] : null);
    input.oncancel = () => resolve(null);
    input.click();
  });
  input.remove();
  if (!picked) return overrides;
  const b64 = await fileToBase64(picked);
  const mime = picked.type || 'image/jpeg';
  const coverPath = await hostApi.invoke<string>('music_set_cover', { filePath: fp, dataBase64: b64, mime });
  const next = new Map(overrides);
  next.set(fp, coverPath);
  return next;
}

// 重扫单文件元数据（忽略手动封面），返回重抽后的 track（封面不含 override）
async function rescanTrackMetadata(track: Track): Promise<Track | null> {
  const fp = track.filePath || track.id;
  if (!fp) return null;
  try {
    return await hostApi.invoke<Track>('music_rescan_metadata', { filePath: fp });
  } catch (e) {
    console.warn('[Music] 重扫元数据失败:', fp, e);
    return null;
  }
}

// 精确进度续播：恢复上次播放的曲目与位置（不自动播放，定位后由用户点播放继续）。
// 仅当 selected 含 last_track_id 且 position 足够大（>5s，避免开头无意义 seek）时生效。
async function resumeLastPosition(selected: Playlist | null) {
  if (!selected || selected.tracks.length === 0) return;
  try {
    const lastTrackId = (await hostApi.invoke<string | null>('music_get_player_state', { key: 'last_track_id' })) || '';
    const lastId = lastTrackId;
    if (!lastId) return;
    const idx = selected.tracks.findIndex((t) => trackIdOf(t) === lastId);
    if (idx < 0) return;
    const posStr = (await hostApi.invoke<string | null>('music_get_player_state', { key: 'position' })) || '0';
    const pos = parseInt(posStr, 10);
    if (!isFinite(pos) || pos <= 5) return;
    // 加载到该曲目（setTracks 不自动播放），再定位进度
    musicPlayer.setTracks(selected.tracks, idx);
    musicPlayer.seek(pos);
    console.log('[Music] 续播定位:', lastId, '位置=', pos, '秒');
  } catch (e) {
    console.warn('[Music] 续播定位失败:', e);
  }
}

// 编辑曲目标签信息并写回文件
async function editTrackTags(
  track: Track,
  fields: { title?: string; artist?: string; album?: string; trackNumber?: number },
): Promise<void> {
  const fp = track.filePath || track.id;
  if (!fp) return;
  try {
    await hostApi.invoke('music_edit_track', {
      filePath: fp,
      title: fields.title ?? null,
      artist: fields.artist ?? null,
      album: fields.album ?? null,
      trackNumber: fields.trackNumber ?? null,
    });
  } catch (e) {
    console.warn('[Music] 标签写回失败:', fp, e);
    throw e;
  }
}

// 读取曲目原始歌词文本（优先 .lrc 文件，其次内嵌标签）。
async function loadLyricsText(track: Track): Promise<{ text: string; source: string }> {
  const fp = track.filePath || track.id;
  if (!fp) return { text: '', source: 'none' };
  try {
    return await hostApi.invoke<{ text: string; source: string }>('get_lyrics_text', { trackPath: fp });
  } catch (e) {
    console.error('[Music] 读取歌词文本失败:', e);
    return { text: '', source: 'none' };
  }
}

// 保存歌词：写回内嵌标签，并可选择同时生成/覆盖 .lrc 文件。
async function saveTrackLyrics(track: Track, lyrics: string, saveToLrc: boolean): Promise<void> {
  const fp = track.filePath || track.id;
  if (!fp) return;
  try {
    await hostApi.invoke('save_track_lyrics', {
      trackPath: fp,
      lyrics,
      saveToLrc,
    });
  } catch (e) {
    console.error('[Music] 保存歌词失败:', e);
    throw e;
  }
}

// 从 SQLite 加载自建歌单（替代仅读 localStorage 的恢复逻辑），作为重载后的真源。
async function loadCustomPlaylistsFromDb(): Promise<Playlist[]> {
  try {
    const summaries = await hostApi.invoke<{ id: string; title: string; coverPath?: string }[]>(
      'music_list_playlists',
    );
    const customs: Playlist[] = [];
    for (const s of summaries) {
      const tracksRaw = await hostApi.invoke<{
        trackId: string;
        title: string;
        artist: string;
        album: string;
        filePath?: string;
        coverPath?: string;
        durationMs: number;
      }[]>('music_list_playlist_tracks', { playlistId: s.id });
      customs.push({
        id: s.id,
        name: s.title,
        type: 'custom',
        tracks: tracksRaw.map((t) => ({
          id: t.trackId,
          filePath: t.filePath || t.trackId,
          title: t.title,
          artist: t.artist,
          album: t.album,
          durationSecs: (t.durationMs || 0) / 1000,
          coverPath: t.coverPath,
        })),
      });
    }
    return customs;
  } catch (e) {
    console.warn('[Music] 从 SQLite 加载歌单失败，回退 localStorage:', e);
    return getCustomPlaylistsFromStorage();
  }
}

// ========== 音乐模块设置面板（JSX 实现，取代原 React.createElement 嵌套）==========
interface MusicSettingsPanelProps {
  onClose: () => void;
  rootPaths: string[];
  onRemoveRoot: (p: string) => void;
  onAddRoot: () => void;
  volume: number;
  onVolumeChange: (v: number) => void;
  lyricsFontSize: number;
  onLyricsFontSize: (v: number) => void;
  lyricsShowNextLine: boolean;
  onLyricsShowNextLine: (v: boolean) => void;
  onlineLyricsEnabled: boolean;
  onOnlineLyricsToggle: (v: boolean) => void;
  localLrcFirst: boolean;
  onLocalLrcFirstToggle: (v: boolean) => void;
  showAlbum: boolean;
  onShowAlbumToggle: (v: boolean) => void;
  playMode: 'list' | 'single' | 'random';
  onPlayModeChange: (v: 'list' | 'single' | 'random') => void;
  lyricsAlign: 'center' | 'left' | 'right';
  onLyricsAlignChange: (v: 'center' | 'left' | 'right') => void;
  onCleanInvalidFiles: () => void;
  onRefreshAllFolders: () => void;
  totalTracks: number;
  playlistCount: number;
}

// 听歌统计页（按钮位置参考阅读模块侧栏底部统计入口；数据来自后端 music_get_listen_stats / music_get_listen_ranking）
type ListenStatRow = {
  day: string;
  playCount: number;
  trackCount: number;
  totalMs: number;
};

type RankingTrack = {
  trackId: string;
  title: string;
  artist: string;
  playCount: number;
};

type RankingArtist = {
  artist: string;
  playCount: number;
};

type ListenRanking = {
  totalPlays: number;
  totalMs: number;
  prevTotalPlays: number;
  prevTotalMs: number;
  topTracks: RankingTrack[];
  topArtists: RankingArtist[];
};

function MusicStatsView({ onClose, favoriteCount = 0 }: { onClose: () => void; favoriteCount?: number }) {
  useLang();
  const T = (window as any).__HOST_I18N__?.t || ((k: string) => k);
  const [rows, setRows] = useState<ListenStatRow[] | null>(null);
  const [ranking, setRanking] = useState<ListenRanking | null>(null);
  const [range, setRange] = useState<7 | 30>(7);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [statData, rankData] = await Promise.all([
          hostApi.invoke('music_get_listen_stats', { days: range }) as Promise<ListenStatRow[]>,
          hostApi.invoke('music_get_listen_ranking', { days: range }) as Promise<ListenRanking>,
        ]);
        if (!cancelled) {
          setRows(statData || []);
          setRanking(rankData);
        }
      } catch (e: any) {
        if (!cancelled) setError(String(e?.message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [range]);

  const statRows = rows || [];
  const daily = statRows.map((r) => [r.day, r.playCount] as [string, number]);
  const maxPlays = daily.reduce((m, [, p]) => Math.max(m, p), 0);
  const totalDuration = statRows.reduce((s, r) => s + r.totalMs, 0) / 1000;
  const totalPlays = statRows.reduce((s, r) => s + r.playCount, 0);
  const hours = Math.floor(totalDuration / 3600);
  const minutes = Math.floor((totalDuration % 3600) / 60);
  const activeDays = daily.filter(([, p]) => p > 0).length;

  // 环比：与上一个等长区间对比
  const prev = ranking?.prevTotalPlays || 0;
  const delta = totalPlays - prev;
  const deltaPct = prev > 0 ? Math.round((delta / prev) * 100) : (totalPlays > 0 ? 100 : 0);
  const rangeLabel = range === 7 ? T('music.stats.last7') : T('music.stats.last30');
  const prevLabel = range === 7 ? T('music.stats.prev7') : T('music.stats.prev30');

  const isEmpty = !loading && !error && totalPlays === 0 && daily.length === 0;

  return (
    <div className="flex flex-col h-full bg-[#f5f5f0] dark:bg-[#1c1917]">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-neutral-200/50 dark:border-stone-700/50">
        <button
          onClick={onClose}
          className="px-2 py-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-neutral-500 dark:text-stone-400 text-base"
          aria-label={T('music.stats.back')}
        >
          ←
        </button>
        <h2 className="text-lg font-semibold text-neutral-800 dark:text-stone-100">{T('music.stats.title')}</h2>
        <div className="ml-auto flex gap-1 text-sm">
          {([7, 30] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={
                'px-3 py-1 rounded-lg transition-colors ' +
                (range === r
                  ? 'bg-[var(--element-color-raw)] text-white'
                  : 'text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5')
              }
            >
              {r === 7 ? T('music.stats.last7') : T('music.stats.last30')}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        {loading ? (
          <div className="text-neutral-400 dark:text-stone-500 text-sm py-10 text-center">{T('music.stats.loading')}</div>
        ) : error ? (
          <div className="text-red-500 text-sm py-10 text-center">{T('music.stats.error')}: {error}</div>
        ) : isEmpty ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="text-4xl mb-3">🎵</div>
            <div className="text-neutral-500 dark:text-stone-400 text-sm">{T('music.stats.emptyHint')}</div>
            <button
              onClick={onClose}
              className="mt-4 px-4 py-2 rounded-xl bg-[var(--element-color-raw)] text-white text-sm hover:opacity-90 transition-opacity"
            >
              {T('music.stats.goListen')}
            </button>
          </div>
        ) : (
          <div className="space-y-6 max-w-3xl">
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-2xl bg-black/5 dark:bg-white/5 px-4 py-4">
                <div className="text-2xl font-semibold text-neutral-800 dark:text-stone-100">{totalPlays}</div>
                <div className="text-xs text-neutral-500 dark:text-stone-400 mt-1">{T('music.stats.playCount')}</div>
              </div>
              <div className="rounded-2xl bg-black/5 dark:bg-white/5 px-4 py-4">
                <div className="text-2xl font-semibold text-neutral-800 dark:text-stone-100">
                  {hours}<span className="text-base font-normal text-neutral-500 dark:text-stone-400">{T('music.stats.hour')}</span>
                  {minutes}<span className="text-base font-normal text-neutral-500 dark:text-stone-400">{T('music.stats.minute')}</span>
                </div>
                <div className="text-xs text-neutral-500 dark:text-stone-400 mt-1">{T('music.stats.listenTime')}</div>
              </div>
              <div className="rounded-2xl bg-black/5 dark:bg-white/5 px-4 py-4">
                <div className="text-2xl font-semibold text-neutral-800 dark:text-stone-100">{activeDays}</div>
                <div className="text-xs text-neutral-500 dark:text-stone-400 mt-1">{T('music.stats.activeDays')}</div>
              </div>
            </div>

            <div className="rounded-2xl bg-black/5 dark:bg-white/5 px-4 py-3 flex items-center gap-3">
              <span className="text-lg">❤️</span>
              <div>
                <div className="text-2xl font-semibold text-neutral-800 dark:text-stone-100 leading-none">{favoriteCount}</div>
                <div className="text-xs text-neutral-500 dark:text-stone-400 mt-1">{T('music.stats.favoriteCount')}</div>
              </div>
            </div>

            <div className="rounded-2xl bg-black/5 dark:bg-white/5 px-4 py-3 text-sm flex items-center gap-2">
              <span className="text-neutral-500 dark:text-stone-400">
                {rangeLabel} {T('music.stats.vs')} {prevLabel}
              </span>
              <span className={'ml-auto font-medium ' + (delta > 0 ? 'text-emerald-500' : delta < 0 ? 'text-rose-500' : 'text-neutral-400 dark:text-stone-500')}>
                {delta > 0 ? '▲ +' : delta < 0 ? '▼ ' : ''}{deltaPct}%
              </span>
              <span className="text-neutral-400 dark:text-stone-500 text-xs">
                ({delta >= 0 ? '+' : ''}{delta} {T('music.stats.playCountUnit')})
              </span>
            </div>

            <div>
              <div className="text-sm text-neutral-500 dark:text-stone-400 mb-3">{T('music.stats.dailyTrend')}</div>
              <div className="space-y-1.5">
                {daily.length === 0 ? (
                  <div className="text-neutral-400 dark:text-stone-500 text-sm py-6 text-center">{T('music.stats.noData')}</div>
                ) : (
                  daily.map(([date, plays]) => (
                    <div key={date} className="flex items-center gap-3">
                      <div className="w-20 shrink-0 text-xs text-neutral-500 dark:text-stone-400 tabular-nums">{date.slice(5)}</div>
                      <div className="flex-1 h-5 rounded-md bg-black/5 dark:bg-white/5 overflow-hidden">
                        <div
                          className="h-full rounded-md bg-[var(--element-color-raw)]/80"
                          style={{ width: maxPlays > 0 ? `${Math.max((plays / maxPlays) * 100, plays > 0 ? 4 : 0)}%` : '0%' }}
                        />
                      </div>
                      <div className="w-10 shrink-0 text-xs text-neutral-500 dark:text-stone-400 text-right tabular-nums">{plays}</div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <div className="text-sm font-medium text-neutral-700 dark:text-stone-200 mb-3">{T('music.stats.topTracks')}</div>
                {(ranking?.topTracks?.length ?? 0) === 0 ? (
                  <div className="text-neutral-400 dark:text-stone-500 text-sm py-6 text-center">{T('music.stats.noData')}</div>
                ) : (
                  <div className="space-y-1">
                    {ranking!.topTracks.map((t, i) => (
                      <div key={t.trackId} className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5">
                        <div className="w-5 text-right text-xs text-neutral-400 dark:text-stone-500 tabular-nums">{i + 1}</div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-neutral-800 dark:text-stone-100 truncate">{t.title || T('music.stats.unknownTrack')}</div>
                          <div className="text-xs text-neutral-500 dark:text-stone-400 truncate">{t.artist}</div>
                        </div>
                        <div className="shrink-0 text-xs text-neutral-500 dark:text-stone-400 tabular-nums">
                          {t.playCount} {T('music.stats.repeatUnit')}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <div className="text-sm font-medium text-neutral-700 dark:text-stone-200 mb-3">{T('music.stats.topArtists')}</div>
                {(ranking?.topArtists?.length ?? 0) === 0 ? (
                  <div className="text-neutral-400 dark:text-stone-500 text-sm py-6 text-center">{T('music.stats.noData')}</div>
                ) : (
                  <div className="space-y-1">
                    {ranking!.topArtists.map((a, i) => (
                      <div key={a.artist} className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5">
                        <div className="w-5 text-right text-xs text-neutral-400 dark:text-stone-500 tabular-nums">{i + 1}</div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-neutral-800 dark:text-stone-100 truncate">{a.artist}</div>
                        </div>
                        <div className="shrink-0 text-xs text-neutral-500 dark:text-stone-400 tabular-nums">
                          {a.playCount} {T('music.stats.playCountUnit')}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MusicSettingsPanel(p: MusicSettingsPanelProps) {
  useLang();
  const ModuleSettingsPanel = (window.__HOST_UI__ as Record<string, unknown>)?.ModuleSettingsPanel as
    | React.ComponentType<{ title: string; icon: React.ReactNode; onClose: () => void; children: React.ReactNode }>
    | undefined;
  if (!ModuleSettingsPanel) return null;

  return (
    <ModuleSettingsPanel
      title={T('music.title')}
      icon={
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
      }
      onClose={p.onClose}
    >
      {/* 歌词设置 */}
      <div className="glass-panel p-4">
        <h3 className="text-xs font-semibold text-neutral-500 dark:text-stone-400 mb-3">{T('music.settings.lyrics')}</h3>
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-neutral-600 dark:text-stone-300">{T('music.settings.onlineLyrics')}</span>
          <button
            onClick={() => p.onOnlineLyricsToggle(!p.onlineLyricsEnabled)}
            className="w-9 h-5 rounded-full transition-colors"
            style={{ backgroundColor: p.onlineLyricsEnabled ? 'var(--element-bg)' : 'rgb(212 212 212)', position: 'relative' }}
          >
            <div
              className="w-4 h-4 rounded-full bg-white shadow-sm"
              style={{ position: 'absolute', top: '2px', left: p.onlineLyricsEnabled ? '18px' : '2px', transition: 'left 0.2s' }}
            />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-neutral-600 dark:text-stone-300">{T('music.settings.localLrcFirst')}</span>
          <button
            onClick={() => p.onLocalLrcFirstToggle(!p.localLrcFirst)}
            className="w-9 h-5 rounded-full transition-colors"
            style={{ backgroundColor: p.localLrcFirst ? 'var(--element-bg)' : 'rgb(212 212 212)', position: 'relative' }}
          >
            <div
              className="w-4 h-4 rounded-full bg-white shadow-sm"
              style={{ position: 'absolute', top: '2px', left: p.localLrcFirst ? '18px' : '2px', transition: 'left 0.2s' }}
            />
          </button>
        </div>
        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-neutral-600 dark:text-stone-300">{T('music.settings.lyricsAlign')}</span>
          <div className="flex gap-1 rounded-lg p-0.5 bg-[var(--element-muted)]">
            {(['center', 'left', 'right'] as const).map((opt) => (
              <button
                key={opt}
                onClick={() => p.onLyricsAlignChange(opt)}
                className="px-2 py-1 rounded-md text-xs transition-colors"
                style={p.lyricsAlign === opt ? { background: 'var(--element-bg)', color: '#fff' } : { color: 'var(--text-secondary, #78716c)' }}
              >
                {opt === 'center' ? T('music.settings.alignCenter') : opt === 'left' ? T('music.settings.alignLeft') : T('music.settings.alignRight')}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 桌面歌词 */}
      <div className="glass-panel p-4">
        <h3 className="text-xs font-semibold text-neutral-500 dark:text-stone-400 mb-3">{T('music.settings.desktopLyrics')}</h3>
        <div className="mb-3">
          <label className="block text-xs font-medium text-neutral-500 dark:text-stone-400 mb-2">{T('music.settings.fontSize', { px: p.lyricsFontSize })}</label>
          <input
            type="range"
            min={16}
            max={48}
            value={p.lyricsFontSize}
            onChange={(e) => p.onLyricsFontSize(Number(e.target.value))}
            className="w-full"
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-neutral-500 dark:text-stone-400">{T('music.settings.nextLinePreview')}</span>
          <button
            onClick={() => p.onLyricsShowNextLine(!p.lyricsShowNextLine)}
            className="w-9 h-5 rounded-full transition-colors"
            style={{ backgroundColor: p.lyricsShowNextLine ? 'var(--element-bg)' : 'rgb(212 212 212)', position: 'relative' }}
          >
            <div
              className="w-4 h-4 rounded-full bg-white shadow-sm"
              style={{ position: 'absolute', top: '2px', left: p.lyricsShowNextLine ? '18px' : '2px', transition: 'left 0.2s' }}
            />
          </button>
        </div>
      </div>

      {/* 显示设置 */}
      <div className="glass-panel p-4">
        <h3 className="text-xs font-semibold text-neutral-500 dark:text-stone-400 mb-3">{T('music.settings.display')}</h3>
        <div className="mb-3">
          <label className="block text-xs font-medium text-neutral-500 dark:text-stone-400 mb-2">{T('music.settings.defaultVolume', { pct: Math.round(p.volume * 100) })}</label>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(p.volume * 100)}
            onChange={(e) => p.onVolumeChange(Number(e.target.value) / 100)}
            className="w-full"
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-neutral-600 dark:text-stone-300">{T('music.settings.alwaysShowAlbum')}</span>
          <button
            onClick={() => p.onShowAlbumToggle(!p.showAlbum)}
            className="w-9 h-5 rounded-full transition-colors"
            style={{ backgroundColor: p.showAlbum ? 'var(--element-bg)' : 'rgb(212 212 212)', position: 'relative' }}
          >
            <div
              className="w-4 h-4 rounded-full bg-white shadow-sm"
              style={{ position: 'absolute', top: '2px', left: p.showAlbum ? '18px' : '2px', transition: 'left 0.2s' }}
            />
          </button>
        </div>
        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-neutral-600 dark:text-stone-300">{T('music.settings.playMode')}</span>
          <div className="flex gap-1 rounded-lg p-0.5 bg-[var(--element-muted)]">
            {(['list', 'single', 'random'] as const).map((opt) => (
              <button
                key={opt}
                onClick={() => p.onPlayModeChange(opt)}
                className="px-2 py-1 rounded-md text-xs transition-colors"
                style={p.playMode === opt ? { background: 'var(--element-bg)', color: '#fff' } : { color: 'var(--text-secondary, #78716c)' }}
              >
                {opt === 'list' ? T('music.player.modeList') : opt === 'single' ? T('music.player.modeSingle') : T('music.player.modeRandom')}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 维护 */}
      <div className="glass-panel p-4">
        <h3 className="text-xs font-semibold text-neutral-500 dark:text-stone-400 mb-3">{T('music.settings.maintenance')}</h3>
        <div className="flex flex-col gap-2">
          <button
            onClick={p.onCleanInvalidFiles}
            className="btn-press px-3 py-2 rounded-lg text-xs bg-[var(--element-muted)] text-neutral-600 dark:text-stone-300 hover:opacity-80 transition-opacity text-left"
          >
            {T('music.settings.cleanInvalid')}
          </button>
          <button
            onClick={p.onRefreshAllFolders}
            className="btn-press px-3 py-2 rounded-lg text-xs bg-[var(--element-muted)] text-neutral-600 dark:text-stone-300 hover:opacity-80 transition-opacity text-left"
          >
            {T('music.settings.refreshPlaylists')}
          </button>
        </div>
      </div>

      {/* 音乐目录 */}
      <div className="glass-panel p-4">
        <h3 className="text-xs font-semibold text-neutral-500 dark:text-stone-400 mb-3">{T('music.settings.musicDirs')}</h3>
        {p.rootPaths.length === 0 ? (
          <p className="text-xs text-neutral-400 dark:text-stone-500 mb-2">{T('music.settings.noDirs')}</p>
        ) : (
          <div className="space-y-1.5 mb-2">
            {p.rootPaths.map((path) => (
              <div key={path} className="flex items-center gap-2 text-sm">
                <span className="flex-1 text-neutral-600 dark:text-stone-300 truncate text-xs">{path}</span>
                <button
                  onClick={() => p.onRemoveRoot(path)}
                  className="btn-press px-2 py-0.5 rounded-lg text-xs text-red-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors flex-shrink-0"
                  title={T('music.settings.removeDir')}
                >
                  {T('music.remove')}
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          onClick={p.onAddRoot}
          className="btn-press px-3 py-1.5 rounded-lg text-xs bg-[var(--element-muted)] text-[var(--element-bg)] hover:opacity-80 transition-opacity"
        >
          + {T('music.settings.addFolder')}
        </button>
      </div>

      {/* 统计 */}
      <div className="glass-panel p-4">
        <p className="text-xs text-neutral-400 dark:text-stone-500">
          {T('music.settings.scanned', { tracks: p.totalTracks, playlists: p.playlistCount })}
        </p>
      </div>
    </ModuleSettingsPanel>
  );
}

// ====== 音乐导入：按子文件夹分组（与图片模块一致）======
// 导入总文件夹后，自动识别其下的一级子文件夹，并以每个子文件夹创建一张歌单，
// 子文件夹内的音频（递归）归入对应歌单；根目录下的散落音频归入以根目录命名的歌单。
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/$/, '');
}

// 母/子文件夹识别：每首歌归属其「最长（最深）祖先根」，再在该根下按一级子文件夹建歌单。
// 这样当 D:/ 与 D:/Music 同时作为根时，D:/Music/BIXUS/song.mp3 只会归入 D:/Music/BIXUS 歌单，
// 而不会既出现在 D:/Music 聚合歌单、又出现在 D:/Music/BIXUS 子歌单（避免跨歌单重复与重复 key）。
function groupTracksIntoPlaylists(tracks: Track[], allRootPaths: string[]): Playlist[] {
  const roots = allRootPaths
    .map(normalizePath)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length); // 最长优先 → 第一个命中的即最深根
  const groups = new Map<string, { name: string; tracks: Track[] }>();
  for (const t of tracks) {
    const fp = normalizePath(t.filePath);
    const parent = fp.includes('/') ? fp.slice(0, fp.lastIndexOf('/')) : fp;
    // 找到最深（最长）的祖先根
    let bestRoot: string | null = null;
    for (const r of roots) {
      if (parent === r || parent.startsWith(r + '/')) {
        bestRoot = r;
        break;
      }
    }
    if (!bestRoot) continue; // 不在任何根目录下，跳过
    const rel = parent === bestRoot ? '' : parent.slice(bestRoot.length + 1);
    let key: string;
    let name: string;
    if (rel === '') {
      key = bestRoot;
      name = bestRoot.split('/').pop() || T('music.title');
    } else {
      const first = rel.split('/')[0];
      key = bestRoot + '/' + first;
      name = first;
    }
    if (!groups.has(key)) groups.set(key, { name, tracks: [] });
    groups.get(key)!.tracks.push(t);
  }
  return Array.from(groups.entries()).map(([id, g]) => ({
    id,
    name: g.name,
    tracks: g.tracks,
    type: 'directory' as const,
  }));
}

// 跨根目录去重：父根递归扫描与子根单独扫描可能命中同一音轨，
// 或各自生成相同 id 的歌单，导致重复/冲突（母/子文件夹识别冲突）。
// 先合并相同 id 的歌单，再按绝对路径去重，更深的目录根优先保留音轨。
function dedupDirectoryPlaylists(playlists: Playlist[]): Playlist[] {
  const dirPlaylists = playlists.filter(p => p.type !== 'custom');
  const byId = new Map<string, Playlist>();
  for (const pl of dirPlaylists) {
    const existing = byId.get(pl.id);
    if (!existing) {
      byId.set(pl.id, { ...pl, tracks: [...pl.tracks] });
    } else {
      existing.tracks.push(...pl.tracks);
    }
  }
  const ordered = Array.from(byId.values()).sort((a, b) => b.id.length - a.id.length);
  const seen = new Set<string>();
  const deduped: Playlist[] = [];
  for (const pl of ordered) {
    const tracks = pl.tracks.filter(t => {
      const key = t.filePath.replace(/\\/g, '/');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    deduped.push({ ...pl, tracks });
  }
  const uniqueOrder = Array.from(new Set(dirPlaylists.map(p => p.id)));
  const map = new Map(deduped.map(r => [r.id, r]));
  // 过滤空壳歌单：父/子根递归扫描可能对同一音轨产生不同 id 的歌单，
  // 去重后其中一个会退化为空列表，留下无意义的 phantom 歌单（母/子文件夹冲突的边缘表现）。
  return uniqueOrder.map(id => map.get(id)!).filter(Boolean).filter(p => p.tracks.length > 0);
}

// 最终兜底去重：保证写入 state 的 playlists 绝不含重复 id（彻底消除 React 重复 key 告警）。
// 同名 id 保留音轨数更多的那份（被丢弃的那份往往才是真正带子文件夹音轨的，避免「只识别到母文件夹」）。
function dedupePlaylistsById(playlists: Playlist[]): Playlist[] {
  const byId = new Map<string, Playlist>();
  for (const p of playlists) {
    const existing = byId.get(p.id);
    if (!existing || p.tracks.length > existing.tracks.length) {
      byId.set(p.id, p);
    }
  }
  return Array.from(byId.values());
}

function MusicModule() {
  useLang();
  // 共享运行时：根目录管理（localStorage 持久化）
  const { rootPaths, setRootPaths, addRoot, addRootPathEphemeral, removeRoot } = useRootPaths(STORAGE_KEY_ROOT);
  // 共享运行时：黑名单管理（Rust 集中管理，必须在 filteredPlaylists useMemo 之前声明）
  const { hidden: hiddenPlaylists, add: addToBlacklist, removeAll: removeAllBlacklist, clear: clearBlacklist } = useBlacklist('music');
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  // 在线音乐源通用状态桥（网易云 / 酷狗 共用，与本地模块彻底隔离）
  const online = useOnlineSource();
  // 网易云模块侧栏状态（与本地模块完全分离）
  // 用户「我喜欢的音乐」歌单 id（侧栏「我的收藏」）
  const [likedPlaylistId, setLikedPlaylistId] = useState<number | null>(null);
  // 用户自己的全部歌单（侧栏「用户自己的收藏歌单」铺开）
  const [userPlaylists, setUserPlaylists] = useState<NeteasePlaylistItem[]>([]);
  // 当前网易云侧栏高亮：歌单 id（临时列表高亮走 online.activeId）
  const [activeNeteasePlaylistId, setActiveNeteasePlaylistId] = useState<number | null>(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
  // 收藏集合（track_id set），真源为 SQLite favorite 表；localStorage 作兜底镜像
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('music_favorites');
      return new Set(saved ? (JSON.parse(saved) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  // 封面覆盖映射（file_path -> cover_path）：手动设封面的持久化真源；扫描后叠加到内存 track
  const [coverOverrides, setCoverOverrides] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(rootPaths.length > 0);
  const [scanProgress, setScanProgress] = useState<MusicScanProgress | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(() => {
    const saved = localStorage.getItem('music_plugin_volume');
    return saved ? parseFloat(saved) : 0.7;
  });
  const [playMode, setPlayMode] = useState<PlayMode>('list');
  const [searchQuery, setSearchQuery] = useState('');
  // 按搜索关键词过滤歌单（匹配歌单名），并排除黑名单
  const filteredPlaylists = useMemo(() => {
    const visible = playlists.filter(p => !hiddenPlaylists.has(p.id));
    if (!searchQuery.trim()) return visible;
    const q = searchQuery.trim().toLowerCase();
    return visible.filter(p => p.name.toLowerCase().includes(q));
  }, [playlists, searchQuery, hiddenPlaylists]);
  // 按搜索关键词过滤当前歌单的歌曲（匹配标题、歌手、专辑）
  const filteredTracks = useMemo(() => {
    if (!selectedPlaylist || !searchQuery.trim()) return selectedPlaylist?.tracks ?? [];
    const q = searchQuery.trim().toLowerCase();
    return selectedPlaylist.tracks.filter(t =>
      t.title.toLowerCase().includes(q) ||
      (t.artist && t.artist.toLowerCase().includes(q)) ||
      (t.album && t.album.toLowerCase().includes(q))
    );
  }, [selectedPlaylist, searchQuery]);
  const [showSettings, setShowSettings] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [lyricsFontSize, setLyricsFontSize] = useState(() => {
    const saved = localStorage.getItem('music_lyrics_font_size');
    return saved ? parseInt(saved, 10) : 28;
  });
  const [lyricsShowNextLine, setLyricsShowNextLine] = useState(() => {
    const saved = localStorage.getItem('music_lyrics_show_next_line');
    return saved !== null ? saved === 'true' : true;
  });
  const [showNowPlaying, setShowNowPlaying] = useState(false);
  const [showModuleDrawer, setShowModuleDrawer] = useState(false);
  // 网易云视图：currentView==='netease' 时主区显示网易云，初始二级 tab 由抽屉子项点击决定
  const [neteaseOpen, setNeteaseOpen] = useState(false);
  const [neteaseTab, setNeteaseTab] = useState<'listen' | 'library' | 'radio' | 'search' | 'login'>('listen');
  const [neteaseProfile, setNeteaseProfile] = useState<NeteaseProfile | null>(null);
  // 网易云红心状态（受控源）：列表与底部播放栏共用，确保两侧同步
  const [neteaseLiked, setNeteaseLiked] = useState<Set<number>>(new Set());
  // 网易云视图 ref：供侧栏调用 openPlaylist / restoreTemp
  const neteaseViewRef = useRef<NeteaseViewHandle | null>(null);
  // 酷狗音乐视图：与网易云完全并列的第二在线平台
  const [kugouOpen, setKugouOpen] = useState(false);
  const [kugouTab, setKugouTab] = useState<'home' | 'roam' | 'search' | 'mine'>('home');
  // 酷狗侧栏状态：榜单列表与当前选中榜单（与酷狗视图双向同步）
  const [kugouRankList, setKugouRankList] = useState<KugouPlaylistCard[]>([]);
  const [kugouActiveRankId, setKugouActiveRankId] = useState<number | null>(null);
  const [kugouSettingsOpen, setKugouSettingsOpen] = useState(false);
  const [kugouStatsOpen, setKugouStatsOpen] = useState(false);
  const kugouViewRef = useRef<NeteaseViewHandle | null>(null);

  const [currentTrack, setCurrentTrack] = useState<Track | null>(() => musicPlayer.getCurrentTrack());
  const unlistenRef = useRef<(() => void)[]>([]);
  // 当前选中歌单 ID 的 ref：供 handleMoveTrack / handleRemoveTrack 等闭包使用，
  // 避免依赖 selectedPlaylist 导致回调频繁重建
  const selectedPlaylistIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedPlaylistIdRef.current = selectedPlaylist?.id ?? null;
  }, [selectedPlaylist?.id]);

  // 自定义歌单 + 收藏独立恢复：即使未配置任何音乐文件夹，重载后也应立即从 SQLite 恢复，
  // 避免「仅自建歌单（手动添加音频）」场景下列表在重载后消失。
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      loadCustomPlaylistsFromDb(),
      loadFavoritesFromDb(),
      loadCoverOverridesFromDb(),
      hostApi.invoke<string | null>('music_get_player_state', { key: 'volume' }).catch(() => null),
      hostApi.invoke<string | null>('music_get_player_state', { key: 'play_mode' }).catch(() => null),
    ]).then(([customs, favs, overrides, volState, modeState]) => {
      if (cancelled) return;
      console.log('[Music][探针] 挂载恢复: 自定义歌单=', customs.length, '收藏=', favs.size, '封面覆盖=', overrides.size);
      if (favs.size > 0) setFavorites(favs);
      if (overrides.size > 0) setCoverOverrides(overrides);
      if (customs.length > 0) {
        const applied = applyCoverOverrides(customs, overrides);
        setPlaylists(prev => [...prev.filter(p => p.type !== 'custom' && p.id !== '__favorite__'), ...applied]);
      }
      // 恢复上次音量 / 播放模式（SQLite 优先，回退音乐播放器默认）
      if (volState) {
        const v = parseFloat(volState);
        if (!Number.isNaN(v)) { musicPlayer.setVolume(v); setVolume(v); }
      }
      if (modeState === 'list' || modeState === 'single' || modeState === 'random') {
        musicPlayer.setPlayMode(modeState);
        setPlayMode(modeState);
      }
    });
    return () => { cancelled = true; };
  }, []);

  // F.11 模块本地设置
  const [onlineLyricsEnabled, setOnlineLyricsEnabled] = useState(() => {
    return localStorage.getItem('music_online_lyrics') !== 'false';
  });
  const [localLrcFirst, setLocalLrcFirst] = useState(() => {
    return localStorage.getItem('music_local_lrc_first') === 'true';
  });
  const [showAlbum, setShowAlbum] = useState(() => {
    return localStorage.getItem('music_show_album') !== 'false';
  });
  // 沉浸页歌词对齐方式：center（居中）/ left（左对齐）/ right（右对齐）
  const [lyricsAlign, setLyricsAlign] = useState<'center' | 'left' | 'right'>(() => {
    const saved = localStorage.getItem('music_lyrics_align');
    return saved === 'left' || saved === 'right' ? saved : 'center';
  });
  // 重扫标记：避免 setRootPaths([]) 导致播放器卸载
  const [rescanFlag, setRescanFlag] = useState(0);

  // 流式扫描音乐（支持多根目录）
  useEffect(() => {
    if (rootPaths.length === 0) {
      // 无音乐文件夹时仍需恢复自定义歌单（由挂载期恢复 effect 负责），此处直接结束扫描
      setLoading(false);
      return;
    }

    unlistenRef.current.forEach(fn => fn());
    unlistenRef.current = [];

    setLoading(true);
    setScanProgress(null);
    // 不重置 playlists/selectedPlaylist：避免切换歌单时播放停止。
    // 扫描结果会通过 setPlaylists([...allDirectoryPlaylists, ...customPlaylists]) 合并覆盖。

    let cancelled = false;
    const allDirectoryPlaylists: Playlist[] = [];
    // 修复：扫描/缓存恢复前先确保封面覆盖已从 SQLite 就绪，使用本次加载的
    // 局部 overrides 而非 state 闭包（后者可能仍是初始空 Map，导致覆盖晚到/漏叠）。
    let overrides: Map<string, string> = new Map();

    // 帧缓冲：将高频 scan-progress 批量合并到单帧消费
    const progressBuffer = hostApi.createFrameBuffer<MusicScanProgress>((items) => {
      if (cancelled) return;
      setScanProgress(items[items.length - 1]);
    });

    (async () => {
      // 修复：在扫描/缓存恢复前 await 加载封面覆盖，保证后续 applyCoverOverrides 用已就绪值
      overrides = await loadCoverOverridesFromDb();
      if (!cancelled && overrides.size > 0) setCoverOverrides(overrides);

      // 1. 先尝试为每个路径加载缓存
      const pathsToScan: string[] = [];
      for (const rp of rootPaths) {
        try {
          const cached = await hostApi.invoke('load_music_cache', { rootPath: rp }) as
            | { tracks: Track[]; dirMtimeMs: number }
            | null;
          if (cached && cached.tracks.length > 0) {
            // 比对源目录 mtime：若目录已变更（如新增了含音乐的子文件夹），丢弃旧缓存重扫
            const dirMtime = (await hostApi.invoke('get_dir_mtime', { path: rp })) as number;
            if (cached.dirMtimeMs >= dirMtime) {
              if (cancelled) return;
              console.log('[Music] 缓存命中:', cached.tracks.length, '首 (路径:', rp, ')');
              allDirectoryPlaylists.push(...groupTracksIntoPlaylists(cached.tracks, rootPaths));
              continue;
            }
            console.log('[Music] 目录已变更，缓存失效需重扫:', rp);
          } else {
            console.log('[Music] 缓存未命中，需要扫描:', rp);
          }
        } catch (e) {
          console.log('[Music] 缓存加载异常，需要扫描:', rp, e);
        }
        if (!cancelled) pathsToScan.push(rp);
      }

      if (cancelled) return;

      // 2. 如果全都有缓存，直接显示
      if (pathsToScan.length === 0) {
        const dedupedDir = dedupDirectoryPlaylists(allDirectoryPlaylists);
        setPlaylists(prev => dedupePlaylistsById(applyCoverOverrides([...dedupedDir, ...prev.filter(p => p.type === 'custom')], overrides)));
        // 恢复上次播放的歌单（模块切换/重载后保持选中状态，目录与自定义均匹配）
        const savedId = musicPlayer.currentPlaylistId;
        const candidates = [...dedupedDir, ...getCustomPlaylistsFromStorage()];
        const restored = savedId ? candidates.find(p => p.id === savedId) : null;
        const selected = restored || dedupedDir[0] || getCustomPlaylistsFromStorage()[0] || null;
        const applied = selected ? applyCoverOverrides([selected], overrides)[0] : null;
        console.log('[Music][探针] 缓存恢复 selectedPlaylist:', applied?.id, '曲目数=', applied?.tracks.length ?? 0, '有封面数=', applied?.tracks.filter((t: Track) => t.coverPath).length ?? 0, 'coverOverrides.size=', coverOverrides.size);
        setSelectedPlaylist(applied);
        // 精确进度续播：恢复上次曲目位置（不自动播放，用户点播放继续）
        resumeLastPosition(applied);
        setLoading(false);
        return;
      }

      // 3. 逐个扫描无缓存的路径
      const unsubChunk = await hostApi.listen('music-scan-chunk', (event: { payload: Track[] }) => {
        if (cancelled) return;
        for (const t of event.payload) {
          if (!currentScanTracks.some(existing => existing.id === t.id)) {
            currentScanTracks.push(t);
          }
        }
        // 进度更新通过帧缓冲批处理
        progressBuffer.push({ found: currentScanTracks.length, total: 0, done: false });
      });
      const unsubProgress = await hostApi.listen('music-scan-progress', (event: { payload: MusicScanProgress }) => {
        progressBuffer.push(event.payload);
      });
      unlistenRef.current = [unsubChunk, unsubProgress];

      let currentScanTracks: Track[] = [];

      for (const rp of pathsToScan) {
        if (cancelled) return;
        currentScanTracks = [];
        setScanProgress({ found: 0, total: 0, done: false });

        try {
          await hostApi.invoke('scan_music_root', { rootPath: rp });
        } catch (err) {
          if (cancelled) break;
          if (String(err).includes('扫描已在进行中')) continue;
          console.error('[Music] 扫描失败:', rp, err);
        }

        if (cancelled) return;
        allDirectoryPlaylists.push(...groupTracksIntoPlaylists([...currentScanTracks], rootPaths));
      }

      if (cancelled) return;
      setLoading(false);
      // 从当前 state 合并自定义歌单（避免覆盖扫描期间用户新建的歌单），
      // 同时支持恢复上次选中的自定义歌单
      const dedupedDir = dedupDirectoryPlaylists(allDirectoryPlaylists);
      setPlaylists(prev => applyCoverOverrides([...dedupedDir, ...prev.filter(p => p.type === 'custom')], overrides));
      const savedId = musicPlayer.currentPlaylistId;
      const candidates = [...dedupedDir, ...getCustomPlaylistsFromStorage()];
      const restored = savedId ? candidates.find(p => p.id === savedId) : null;
      const selected = restored || dedupedDir[0] || getCustomPlaylistsFromStorage()[0] || null;
      const applied = selected ? applyCoverOverrides([selected], overrides)[0] : null;
      console.log('[Music][探针] 扫描完成恢复 selectedPlaylist:', applied?.id, '曲目数=', applied?.tracks.length ?? 0, '有封面数=', applied?.tracks.filter((t: Track) => t.coverPath).length ?? 0, 'coverOverrides.size=', coverOverrides.size);
      setSelectedPlaylist(applied);
      // 精确进度续播：恢复上次曲目位置（不自动播放，用户点播放继续）
      resumeLastPosition(applied);
    })();

    return () => {
      cancelled = true;
      progressBuffer.destroy();
      unlistenRef.current.forEach(fn => {
        try { fn(); } catch (e) { /* 热重载时回调已清理，忽略 */ }
      });
      hostApi.invoke('cancel_scan').catch(() => {});
    };
  }, [rootPaths, rescanFlag]);

  // 收藏集合变化 或 曲目列表变化 → 重建「我的收藏」歌单并注入 playlists（置顶）。
  // 依赖 playlists 以在目录扫描完成后用最新曲目填充收藏歌单的 tracks；
  // 内容等价时返回同一引用，避免 setPlaylists 触发 playlists 变化 → effect 再跑的无限循环。
  useEffect(() => {
    setPlaylists(prev => {
      const fav = buildFavoritePlaylist(favorites, collectAllTracks(prev));
      const base = prev.filter(p => p.id !== '__favorite__' && p.id !== 'netease-temp');
      // 注：网易云临时歌单已迁移到独立网易云侧栏（NeteaseSidebar），不再混入本地 playlists
      const next = [fav, ...base].filter(Boolean) as Playlist[];
      const prevFav = prev.find(p => p.id === '__favorite__');
      // 已等价（收藏曲目数一致 + 列表长度一致）则保持原引用，终止循环
      if (prevFav && fav && prevFav.tracks.length === fav.tracks.length && prev.length === next.length) {
        return prev;
      }
      return next;
    });
  }, [favorites, playlists]);

  // 订阅播放器状态
  useEffect(() => {
    const unsubPlay = musicPlayer.on('play', () => setIsPlaying(true));
    const unsubPause = musicPlayer.on('pause', () => { setIsPlaying(false); savePositionToDb(); });
    // 精确进度续播：逐秒回传的 progress 事件节流每 5s 落库一次位置
    let lastSaveTs = 0;
    const unsubProgress = musicPlayer.on('progress', () => {
      const now = Date.now();
      if (now - lastSaveTs >= 5000) {
        lastSaveTs = now;
        savePositionToDb();
      }
    });
    const unsubTrackChange = musicPlayer.on('trackChange', (track) => {
      setCurrentTrack(track as Track | null);
      // 切歌时先把上一首的位置落库（若还在播），再记录新曲
      savePositionToDb();
      // 持久化播放状态：上次播放的 track_id / 所属歌单
      const t = track as Track | null;
      if (t) {
        const tid = trackIdOf(t);
        savePlayerStateToDb('last_track_id', tid);
        savePlayerStateToDb('last_playlist_id', musicPlayer.currentPlaylistId || '');
        // 听歌统计：记录本次播放（fire-and-forget）
        try {
          hostApi
            .invoke('music_record_play_session', {
              trackId: tid,
              title: t.title || '',
              artist: t.artist || '',
              album: t.album || '',
              durationMs: Math.round((t.durationSecs || 0) * 1000),
              playedMs: Math.round(musicPlayer.getCurrentTime() * 1000),
            })
            .catch((e) => console.warn('[Music] 听歌统计记录失败:', tid, e));
        } catch (e) {
          console.warn('[Music] 听歌统计记录异常:', e);
        }
      }
    });
    setIsPlaying(musicPlayer.getIsPlaying());
    setVolume(musicPlayer.getVolume());
    setPlayMode(musicPlayer.getPlayMode());
    return () => { unsubPlay(); unsubPause(); unsubProgress(); unsubTrackChange(); };
  }, []);

  const handleAddRoot = useCallback(async () => {
    await addRoot();
    // 不重置 selectedPlaylist：新文件夹的扫描结果会自动合并，当前播放不中断
  }, [addRoot]);

  // #3 创建自定义歌单：写入状态 + 持久化 + 立即选中（侧边栏即时刷新）
  const handleCreatePlaylist = useCallback((name: string) => {
    const tempId = 'pl_' + Date.now().toString();
    const newPlaylist: Playlist = {
      id: tempId,
      name,
      tracks: [],
      type: 'custom',
    };
    setPlaylists(prev => [...prev, newPlaylist]);
    setSelectedPlaylist(newPlaylist);
    // 落库 SQLite（真源），成功后回填真实 id
    hostApi
      .invoke<{ id: string; title: string }>('music_create_playlist', { title: name })
      .then((res) => {
        setPlaylists(prev =>
          prev.map(p => (p.id === tempId ? { ...p, id: res.id } : p)),
        );
        setSelectedPlaylist(prev => (prev && prev.id === tempId ? { ...prev, id: res.id } : prev));
      })
      .catch((e) => {
        console.warn('[Music] 创建歌单落库失败，仅内存态:', e);
        // 失败兜底：仍写 localStorage 镜像
        try {
          const mirror = JSON.parse(localStorage.getItem(STORAGE_KEY_PLAYLISTS) || '[]');
          mirror.push(newPlaylist);
          localStorage.setItem(STORAGE_KEY_PLAYLISTS, JSON.stringify(mirror));
        } catch { /* ignore */ }
      });
  }, []);

// 模块加载探针（console.error 必然可见，用于确认 music 插件脚本是否真正执行）
try { console.error('[music-diag] index.tsx 模块开始求值; __HOST_API__=' + typeof window.__HOST_API__); } catch {}
// 模块加载时写入 Rust 端日志，便于确认插件脚本是否真正被加载执行（某些 dev 环境会使用 sandbox）。
try { window.__HOST_API__?.invoke('debug_log', { msg: 'MUSIC_PLUGIN_LOADED' }).catch(()=>{}); } catch {}

  const handleRemoveRoot = useCallback((pathToRemove: string) => {
    // 删除该目录的扫描缓存：否则移除后再重新选择同一文件夹会因缓存命中而复用旧数据
    // （尤其是内嵌封面——封面按文件路径哈希命名、已存在则跳过，导致改封面后封面图不变）。
    try {
      hostApi.invoke('delete_music_cache', { rootPath: pathToRemove });
    } catch {
      /* 忽略：缓存不存在时删除失败属正常 */
    }
    removeRoot(pathToRemove);
    const rootF = normalizePath(pathToRemove);
    // 同时移除该根目录下所有（按子文件夹分组的）目录歌单数据
    setPlaylists(prev => {
      const filtered = prev.filter(p => !(p.id === rootF || p.id.startsWith(rootF + '/')));
      const customPlaylists = filtered.filter(p => p.type === 'custom');
      localStorage.setItem(STORAGE_KEY_PLAYLISTS, JSON.stringify(customPlaylists));
      return filtered;
    });
    if (selectedPlaylist && (selectedPlaylist.id === rootF || selectedPlaylist.id.startsWith(rootF + '/'))) {
      setSelectedPlaylist(null);
    }
  }, [removeRoot, selectedPlaylist]);

  const handleSelectPlaylist = useCallback((playlist: Playlist) => {
    setSelectedPlaylist(playlist);
    // 从设置/统计页切回歌单列表
    setShowSettings(false);
    setShowStats(false);
    // 注意：浏览歌单不再改写 musicPlayer.currentPlaylistId。
    // 该字段现仅代表「当前实际播放的音乐所归属的歌单」，且只在真正加载曲目时写入
    // （见 handleSelectTrack / handlePopupSelectTrack / processOpenWith）。
    // 这样播放栏与沉浸页的「播放列表」按钮才能正确显示实际在播放的歌单，
    // 而不是侧栏点开的那一个；浏览/切换歌单只是改变显示，不会中断或改变播放归属。
  }, []);

  const handleSelectTrack = useCallback((track: Track, index: number) => {
    // 切到本地播放时，清掉在线源临时歌单，避免播放列表浮窗仍显示在线来源
    online.setActivePlaylist(null);
    // 如果启用了搜索过滤，index 是过滤后数组中的位置，需要还原为原数组索引
    const tracks = selectedPlaylist?.tracks || [];
    // 真正加载该歌单曲目时才更新「实际播放歌单」归属，供播放列表面板正确显示
    if (tracks.length > 0) {
      musicPlayer.currentPlaylistId = selectedPlaylist?.id ?? null;
    }
    if (searchQuery.trim()) {
      const originalIndex = tracks.findIndex(t => t.id === track.id);
      if (originalIndex !== -1) {
        try { window.__HOST_API__?.invoke('debug_log', { msg: `UI_SELECT_TRACK idx=${originalIndex} id=${track.id}` }).catch(()=>{}); } catch {}
        musicPlayer.setTracks(tracks, originalIndex);
        musicPlayer.play();
        return;
      }
    }
    try { window.__HOST_API__?.invoke('debug_log', { msg: `UI_SELECT_TRACK idx=${index} id=${track.id}` }).catch(()=>{}); } catch {}
    musicPlayer.setTracks(tracks, index);
    musicPlayer.play();
  }, [selectedPlaylist?.tracks, searchQuery]);

  // 播放列表面板选曲：直接用「该曲所属歌单」的 tracks 播放，
  // 不依赖侧栏选中态，避免从其它歌单点歌时索引错位。
  const handlePopupSelectTrack = useCallback((playlistId: string, track: Track, index: number) => {
    const pl = playlists.find(p => p.id === playlistId);
    const list = pl?.tracks ?? [];
    if (list.length === 0) return;
    // 从播放列表面板点选其它歌单的歌曲时，归属随之更新（否则按钮仍显示旧歌单）
    if (playlistId !== 'netease-active' && playlistId !== 'kugou-active') {
      online.setActivePlaylist(null);
    }
    musicPlayer.currentPlaylistId = playlistId;
    musicPlayer.setTracks(list, index);
    musicPlayer.play();
  }, [playlists]);

  // 以安得云荟打开 / 拖入主窗口：复制进固定临时目录 → 注册为常驻库文件夹 → 播放目标
  const processOpenWith = useCallback(async (items: OpenWithItem[]) => {
    try {
      const { dir, paths } = await importToOpenWithDir('music', items);
      addRootPathEphemeral(dir);
      if (paths[0]) {
        const name = paths[0].split(/[\\/]/).pop() || paths[0];
        const track: Track = {
          id: paths[0],
          filePath: paths[0],
          title: name,
          artist: '',
          album: '',
          durationSecs: 0,
        };
        // 以「安得云荟」打开/拖入的临时曲目不属于任何歌单，归属置空
        musicPlayer.currentPlaylistId = null;
        musicPlayer.setTracks([track], 0);
        musicPlayer.play();
      }
    } catch (err) {
      console.error('[Music] 以安得云荟打开失败:', err);
    }
  }, [addRootPathEphemeral]);

  useEffect(() => {
    const unsub = registerOpenWithListener((m, files) => {
      if (m === 'music') processOpenWith(files);
    });
    const pending = getPendingOpenWith('music');
    if (pending) processOpenWith(pending);
    return unsub;
  }, [processOpenWith]);

  const togglePlay = useCallback(() => {
    try { window.__HOST_API__?.invoke('debug_log', { msg: `UI_TOGGLE_PLAY` }).catch(()=>{}); } catch {}
    musicPlayer.togglePlay();
  }, []);
  const prevTrack = useCallback(() => { try { window.__HOST_API__?.invoke('debug_log', { msg: `UI_PREV` }).catch(()=>{}); } catch {} ; musicPlayer.prev(); }, []);
  const nextTrack = useCallback(() => { try { window.__HOST_API__?.invoke('debug_log', { msg: `UI_NEXT` }).catch(()=>{}); } catch {} ; musicPlayer.next(); }, []);

  const handleVolume = useCallback((vol: number) => {
    musicPlayer.setVolume(vol);
    localStorage.setItem('music_plugin_volume', String(vol));
    savePlayerStateToDb('volume', String(vol));
    setVolume(vol);
  }, []);

  const handlePlayModeChange = useCallback((mode: PlayMode) => {
    musicPlayer.setPlayMode(mode);
    savePlayerStateToDb('play_mode', mode);
    setPlayMode(mode);
  }, []);

  // 收藏/取消收藏：更新内存集合 + localStorage 镜像 + SQLite 真源（fire-and-forget）
  const toggleFavorite = useCallback((track: Track) => {
    const id = trackIdOf(track);
    if (!id) return;
    setFavorites(prev => {
      const next = new Set(prev);
      const nowFav = !next.has(id);
      if (nowFav) next.add(id);
      else next.delete(id);
      // 镜像到 localStorage（兜底）
      try {
        localStorage.setItem('music_favorites', JSON.stringify([...next]));
      } catch { /* 忽略配额错误 */ }
      // 落 SQLite（真源）
      syncFavoriteToDb(track, nowFav);
      return next;
    });
  }, []);

  // 网易云红心：写网易云 + 更新受控状态 + 同步本地收藏，供列表与底部播放栏共用
  const toggleNeteaseLike = useCallback((songId: number, like: boolean) => {
    setNeteaseLiked((prev) => {
      const next = new Set(prev);
      if (like) next.add(songId); else next.delete(songId);
      return next;
    });
    likeNeteaseSong(songId, like).catch((e) => console.warn('[netease] 红心写入失败', songId, e));
  }, []);

  // 封面覆盖映射加载/变更后，确保已加载的歌单曲目也应用覆盖。
  // 修复：启动时扫描 effect 可能在 overrides 尚未加载完成时就已经 setPlaylists，
  // 导致重启后封面不显示；监听 coverOverrides 可兜底重新叠加。
  useEffect(() => {
    console.log('[Music][探针] coverOverrides effect 触发, size=', coverOverrides.size);
    if (coverOverrides.size === 0) return;
    setPlaylists(prev => {
      console.log('[Music][探针] coverOverrides effect -> setPlaylists, prev 长度=', prev.length);
      return applyCoverOverrides(prev, coverOverrides);
    });
    setSelectedPlaylist(prev => {
      if (!prev) return prev;
      const applied = applyCoverOverrides([prev], coverOverrides)[0];
      console.log('[Music][探针] coverOverrides effect -> setSelectedPlaylist, 曲目数=', applied.tracks.length, '有封面数=', applied.tracks.filter((t: Track) => t.coverPath).length);
      return applied;
    });
  }, [coverOverrides]);

  // 手动设封面：更新 override map + 内存所有同 file_path 曲目封面
  const handleSetCover = useCallback(async (track: Track) => {
    const next = await setCoverForTrack(track, coverOverrides);
    setCoverOverrides(next);
    setPlaylists(prev => applyCoverOverrides(prev, next));
    // 同步当前选中歌单（UI 直接渲染 selectedPlaylist.tracks，若不更新则封面不刷新）
    setSelectedPlaylist(prev => (prev ? applyCoverOverrides([prev], next)[0] : prev));
  }, [coverOverrides]);

  // 重置封面：删除手动覆盖，回退到音频内嵌封面
  const handleResetCover = useCallback(async (track: Track) => {
    const fp = track.filePath || track.id;
    if (!fp) return;
    try {
      await hostApi.invoke('music_delete_cover_override', { filePath: fp });
      const next = new Map(coverOverrides);
      next.delete(fp);
      setCoverOverrides(next);
      setPlaylists(prev => applyCoverOverrides(prev, next));
      // 同步当前选中歌单（UI 直接渲染 selectedPlaylist.tracks，若不更新则封面不刷新）
      setSelectedPlaylist(prev => (prev ? applyCoverOverrides([prev], next)[0] : prev));
      console.log('[Music] 重置封面:', fp);
    } catch (e) {
      console.warn('[Music] 重置封面失败:', fp, e);
    }
  }, [coverOverrides]);

  // 重扫该曲元数据（忽略手动封面），更新内存对应曲目（封面保留手动 override）
  const handleRescanTrack = useCallback(async (track: Track) => {
    const rescanned = await rescanTrackMetadata(track);
    if (!rescanned) return;
    const fp = rescanned.filePath || rescanned.id;
    setPlaylists(prev =>
      prev.map(p => ({
        ...p,
        tracks: p.tracks.map(t => {
          const tFp = t.filePath || t.id;
          if (tFp !== fp) return t;
          const cov = coverOverrides.get(fp) ?? rescanned.coverPath;
          return { ...t, title: rescanned.title, artist: rescanned.artist, album: rescanned.album, durationSecs: rescanned.durationSecs, coverPath: cov };
        }),
      }))
    );
  }, [coverOverrides]);

  // 编辑曲目标签信息并写回文件 + 更新内存
  const handleEditTrack = useCallback(async (track: Track, fields: { title?: string; artist?: string; album?: string; trackNumber?: number }) => {
    await editTrackTags(track, fields);
    const fp = track.filePath || track.id;
    const updateTracks = (tracks: Track[]) => tracks.map(t => {
      const tFp = t.filePath || t.id;
      if (tFp !== fp) return t;
      return {
        ...t,
        title: fields.title ?? t.title,
        artist: fields.artist ?? t.artist,
        album: fields.album ?? t.album,
      };
    });
    setPlaylists(prev =>
      prev.map(p => ({ ...p, tracks: updateTracks(p.tracks) }))
    );
    // 同步当前选中歌单（UI 直接渲染 selectedPlaylist.tracks）
    setSelectedPlaylist(prev => (prev ? { ...prev, tracks: updateTracks(prev.tracks) } : prev));
  }, []);

  // #4 添加歌曲：选择音频文件后真正加入当前歌单（自定义歌单持久化，目录歌单仅内存）
  const handleAddSong = useCallback(async () => {
    if (!selectedPlaylist) return;
    let files: string[] = [];
    try {
      files = await hostApi.invoke<string[]>('pick_file', {
        filters: [{ name: 'Audio', extensions: ['mp3', 'flac', 'wav', 'ogg', 'm4a'] }],
      });
    } catch (err) {
      console.warn('[Music] 选择文件失败:', err);
      return;
    }
    if (!files || files.length === 0) return;
    // 手动添加歌曲：复用与目录扫描完全一致的元信息解析（read_track_metadata → lofty），
    // 识别标题/艺术家/专辑/时长/内嵌封面；解析失败时回退为「文件名当标题」。
    const newTracks: Track[] = await Promise.all(
      files.map(async (f) => {
    const base = f.split(/[\\/]/).pop() || T('music.unknownTrack');
    const fallbackTitle = base.replace(/\.[^.]+$/, '') || T('music.unknownTrack');
        try {
          const t = await hostApi.invoke<Track>('read_track_metadata', { filePath: f });
          return {
            ...t,
            id: t.filePath || f,
            title: t.title || fallbackTitle,
          };
        } catch (err) {
          console.warn('[Music] 读取元信息失败，回退文件名:', f, err);
          return {
            id: f,
            filePath: f,
            title: fallbackTitle,
            artist: '',
            album: '',
            durationSecs: 0,
            coverPath: undefined,
          };
        }
      }),
    );
    setPlaylists((prev) => {
      const updated = prev.map((p) =>
        p.id === selectedPlaylist.id ? { ...p, tracks: [...p.tracks, ...newTracks] } : p,
      );
      // 兜底镜像
      try {
        const mirror = updated.filter((p) => p.type === 'custom');
        localStorage.setItem(STORAGE_KEY_PLAYLISTS, JSON.stringify(mirror));
      } catch { /* ignore */ }
      return updated;
    });
    setSelectedPlaylist((prev) => {
      if (!prev) return prev;
      const synced = { ...prev, tracks: [...prev.tracks, ...newTracks] };
      syncCustomPlaylistToDb(synced);
      return synced;
    });
  }, [selectedPlaylist]);

  const handleRenamePlaylist = useCallback((playlist: Playlist, newName: string) => {
    setPlaylists(prev => {
      const updated = prev.map(p => p.id === playlist.id ? { ...p, name: newName } : p);
      // 兜底镜像
      try {
        const mirror = updated.filter(p => p.type === 'custom');
        localStorage.setItem(STORAGE_KEY_PLAYLISTS, JSON.stringify(mirror));
      } catch { /* ignore */ }
      const renamed = updated.find(p => p.id === playlist.id);
      if (renamed) syncCustomPlaylistToDb(renamed);
      return updated;
    });
    // 歌单名变更也要落库 playlist 表（标题）
    hostApi
      .invoke('music_rename_playlist', { playlistId: playlist.id, title: newName })
      .catch((e) => console.warn('[Music] 重命名歌单失败:', playlist.id, e));
    if (selectedPlaylist?.id === playlist.id) {
      setSelectedPlaylist(prev => prev ? { ...prev, name: newName } : null);
    }
  }, [selectedPlaylist]);

  const handleDeletePlaylist = useCallback((playlist: Playlist) => {
    const msg = playlist.type === 'directory'
      ? T('music.confirmRemovePlaylist', { name: playlist.name })
      : T('music.confirmDeletePlaylist', { name: playlist.name });
    if (!window.confirm(msg)) return;
    if (playlist.type === 'directory') {
      addToBlacklist(playlist.id, playlist.name);
    } else {
      setPlaylists(prev => {
        const updated = prev.filter(p => p.id !== playlist.id);
        return updated;
      });
      // 从 SQLite 删除（真源）
      hostApi
        .invoke('music_delete_playlist', { playlistId: playlist.id })
        .catch((e) => console.warn('[Music] 删除歌单失败:', playlist.id, e));
      // 兜底镜像
      try {
        const mirror = (JSON.parse(localStorage.getItem(STORAGE_KEY_PLAYLISTS) || '[]') as Playlist[])
          .filter(p => p.id !== playlist.id);
        localStorage.setItem(STORAGE_KEY_PLAYLISTS, JSON.stringify(mirror));
      } catch { /* ignore */ }
    }
    if (selectedPlaylist?.id === playlist.id) {
      setSelectedPlaylist(null);
    }
  }, [selectedPlaylist, addToBlacklist]);

  // 移动歌曲到其他歌单：源/目标都更新；受影响自定义歌单同步到 SQLite
  const handleMoveTrack = useCallback((track: Track, targetPlaylistId: string) => {
    const currentId = selectedPlaylistIdRef.current;
    if (!currentId || currentId === targetPlaylistId) return;
    setPlaylists(prev => {
      const updated = prev.map(p => {
        if (p.id === currentId) {
          return { ...p, tracks: p.tracks.filter(t => t.id !== track.id) };
        }
        if (p.id === targetPlaylistId) {
          // 避免重复：若目标歌单已有该曲目则跳过
          if (p.tracks.some(t => t.id === track.id)) return p;
          return { ...p, tracks: [...p.tracks, track] };
        }
        return p;
      });
      // 兜底镜像 + 同步 SQLite
      try {
        const mirror = updated.filter(p => p.type === 'custom');
        localStorage.setItem(STORAGE_KEY_PLAYLISTS, JSON.stringify(mirror));
      } catch { /* ignore */ }
      updated
        .filter(p => (p.id === currentId || p.id === targetPlaylistId) && p.type === 'custom')
        .forEach(syncCustomPlaylistToDb);
      return updated;
    });
    // 同步更新当前歌单的 selectedPlaylist
    setSelectedPlaylist(prev => {
      if (!prev || prev.id !== currentId) return prev;
      return { ...prev, tracks: prev.tracks.filter(t => t.id !== track.id) };
    });
  }, []);

  // 复制到其他歌单：仅把歌曲加入目标歌单（去重），源歌单保持不变
  const handleCopyTrack = useCallback((track: Track, targetPlaylistId: string) => {
    setPlaylists(prev => {
      const updated = prev.map(p => {
        if (p.id === targetPlaylistId) {
          // 避免重复：若目标歌单已有该曲目则跳过
          if (p.tracks.some(t => t.id === track.id)) return p;
          return { ...p, tracks: [...p.tracks, track] };
        }
        return p;
      });
      // 兜底镜像 + 同步 SQLite
      try {
        const mirror = updated.filter(p => p.type === 'custom');
        localStorage.setItem(STORAGE_KEY_PLAYLISTS, JSON.stringify(mirror));
      } catch { /* ignore */ }
      updated
        .filter(p => p.id === targetPlaylistId && p.type === 'custom')
        .forEach(syncCustomPlaylistToDb);
      return updated;
    });
  }, []);

  // 移除歌曲：从当前歌单中删除
  // - 自定义歌单：内存删除 + 同步 SQLite
  // - 目录歌单：仅内存删除（下次扫描会重新出现，因为源文件仍在）
  const handleRemoveTrack = useCallback((track: Track) => {
    const currentId = selectedPlaylistIdRef.current;
    if (!currentId) return;
    setPlaylists(prev => {
      const updated = prev.map(p => {
        if (p.id === currentId) {
          return { ...p, tracks: p.tracks.filter(t => t.id !== track.id) };
        }
        return p;
      });
      // 兜底镜像 + 同步 SQLite
      try {
        const mirror = updated.filter(p => p.type === 'custom');
        localStorage.setItem(STORAGE_KEY_PLAYLISTS, JSON.stringify(mirror));
      } catch { /* ignore */ }
      updated
        .filter(p => p.id === currentId && p.type === 'custom')
        .forEach(syncCustomPlaylistToDb);
      return updated;
    });
    setSelectedPlaylist(prev => {
      if (!prev || prev.id !== currentId) return prev;
      return { ...prev, tracks: prev.tracks.filter(t => t.id !== track.id) };
    });
  }, []);

  // 供 TrackList 下拉菜单使用：除当前歌单外的所有歌单
  const otherPlaylistsForMenu = useMemo(() => {
    if (!selectedPlaylist) return [];
    return playlists
      .filter(p => p.id !== selectedPlaylist.id)
      .map(p => ({ id: p.id, name: p.name }));
  }, [playlists, selectedPlaylist]);

  // 模块设置（当前为占位，后续扩展）
  const handleOpenModuleSettings = useCallback(() => {
    setShowStats(false);
    setShowSettings(prev => !prev);
  }, []);

  const handleCoverClick = useCallback(() => {
    setShowNowPlaying(prev => !prev);
  }, []);

  const handleCloseNowPlaying = useCallback(() => {
    setShowNowPlaying(false);
  }, []);

  // 键盘快捷键：上下键调音量，左右键调进度，空格控制启停
  const handleModuleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // 仅在非搜索、非设置页面响应键盘（输入框聚焦时不处理）
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        musicPlayer.togglePlay();
        break;
      case 'ArrowUp':
        e.preventDefault();
        handleVolume(Math.min(1, Math.round((musicPlayer.getVolume() + 0.05) * 100) / 100));
        break;
      case 'ArrowDown':
        e.preventDefault();
        handleVolume(Math.max(0, Math.round((musicPlayer.getVolume() - 0.05) * 100) / 100));
        break;
      case 'ArrowLeft':
        e.preventDefault();
        musicPlayer.seek(Math.max(0, musicPlayer.getCurrentTime() - 5));
        break;
      case 'ArrowRight':
        e.preventDefault();
        musicPlayer.seek(Math.min(musicPlayer.getDuration(), musicPlayer.getCurrentTime() + 5));
        break;
    }
  }, [handleVolume]);

  // 歌词样式设置
  const handleLyricsFontSize = useCallback((val: number) => {
    setLyricsFontSize(val);
    localStorage.setItem('music_lyrics_font_size', String(val));
    hostApi.emit('lyrics-style-update', { fontSize: val }).catch(() => {});
  }, []);

  const handleLyricsShowNextLine = useCallback((val: boolean) => {
    setLyricsShowNextLine(val);
    localStorage.setItem('music_lyrics_show_next_line', String(val));
    hostApi.emit('lyrics-style-update', { showNextLine: val }).catch(() => {});
  }, []);

  // F.11 设置处理函数
  const handleOnlineLyricsToggle = useCallback((val: boolean) => {
    setOnlineLyricsEnabled(val);
    localStorage.setItem('music_online_lyrics', String(val));
  }, []);

  const handleLocalLrcFirstToggle = useCallback((val: boolean) => {
    setLocalLrcFirst(val);
    localStorage.setItem('music_local_lrc_first', String(val));
  }, []);

  const handleShowAlbumToggle = useCallback((val: boolean) => {
    setShowAlbum(val);
    localStorage.setItem('music_show_album', String(val));
  }, []);

  // 歌词对齐方式设置
  const handleLyricsAlignChange = useCallback((val: 'center' | 'left' | 'right') => {
    setLyricsAlign(val);
    localStorage.setItem('music_lyrics_align', val);
  }, []);

  // 清理无效文件：扫描所有歌单，移除指向已不存在文件的曲目
  const handleCleanInvalidFiles = useCallback(async () => {
    const allTracks: { playlistId: string; trackId: string; filePath: string }[] = [];
    playlists.forEach(pl => {
      pl.tracks.forEach(t => {
        allTracks.push({ playlistId: pl.id, trackId: t.id, filePath: t.filePath });
      });
    });

    // 逐个检查文件是否存在（避免并发过高）
    const invalidPaths = new Set<string>();
    for (const t of allTracks) {
      try {
        const exists = await hostApi.invoke<boolean>('check_file_exists', { path: t.filePath });
        if (!exists) invalidPaths.add(t.filePath);
      } catch {
        // 检查失败时保留该条目
      }
    }

    if (invalidPaths.size === 0) return;

    const cleaned = playlists.map(pl => ({
      ...pl,
      tracks: pl.tracks.filter(t => !invalidPaths.has(t.filePath)),
    }));
    setPlaylists(cleaned);
    const customPlaylists = cleaned.filter(p => p.type === 'custom');
    localStorage.setItem(STORAGE_KEY_PLAYLISTS, JSON.stringify(customPlaylists));
  }, [playlists]);

  // 刷新所有文件夹歌单：重新扫描已配置的文件夹路径，并清除黑名单
  const handleRefreshAllFolders = useCallback(async () => {
    for (const rp of rootPaths) {
      try {
        await hostApi.invoke('delete_music_cache', { rootPath: rp });
      } catch (err) {
        console.warn('[Music] 删除缓存失败:', err);
      }
    }
    await removeAllBlacklist([...rootPaths]);
    clearBlacklist();
    setRescanFlag(n => n + 1);
  }, [rootPaths, removeAllBlacklist, clearBlacklist]);

  if (rootPaths.length === 0) {
    return (
      <EmptyState
        icon={
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--element-bg)]">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
        }
        title={T('music.emptyTitle')}
        description={T('music.emptyDesc')}
        buttonText={T('music.emptyButton')}
        onSelect={handleAddRoot}
      />
    );
  }

  if (loading && playlists.length === 0) {
    return (
      <LoadingState
        progressText={scanProgress ? T('music.scanProgress', { found: scanProgress.found, total: scanProgress.total }) : T('music.scanning')}
        onCancel={() => hostApi.invoke('cancel_scan').catch(() => {})}
      />
    );
  }

  if (!loading && playlists.length === 0) {
    return (
      <NoResultsState
        text={T('music.noFiles')}
        buttonText={T('music.addFolder')}
        onSelect={handleAddRoot}
      />
    );
  }

  return (
    <div className="flex-1 flex h-full overflow-hidden relative" tabIndex={0} onKeyDown={handleModuleKeyDown}>
      {neteaseOpen ? (
        <NeteaseSidebar
          likedPlaylistId={likedPlaylistId}
          likedPlaylistCount={userPlaylists.find(p => isLikedPlaylist(p))?.trackCount ?? 0}
          tempPlaylists={online.temps}
          userPlaylists={userPlaylists}
          activePlaylistId={activeNeteasePlaylistId}
          activeTempId={online.activeId}
          onSelectLiked={() => {
            setActiveNeteasePlaylistId(likedPlaylistId);
            online.setActiveId(null);
            if (likedPlaylistId != null) {
              setNeteaseTab('listen');
              neteaseViewRef.current?.openPlaylist(likedPlaylistId, '我喜欢的音乐');
            }
          }}
          onSelectTemp={(item) => {
            online.setActiveId(item.id);
            setActiveNeteasePlaylistId(null);
            neteaseViewRef.current?.restoreTemp(item.payload);
          }}
          onSelectUserPlaylist={(playlist) => {
            setActiveNeteasePlaylistId(playlist.id);
            online.setActiveId(null);
            setNeteaseTab('listen');
            neteaseViewRef.current?.openPlaylist(playlist.id, playlist.name);
          }}
          onCloseNetease={() => setNeteaseOpen(false)}
          onOpenModuleSettings={handleOpenModuleSettings}
          onOpenStats={() => setShowStats(v => !v)}
          statsActive={showStats}
          onSelectFolder={handleAddRoot}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
        />
      ) : kugouOpen ? (
        <KugouSidebar
          ranks={kugouRankList}
          activeRankId={kugouActiveRankId}
          onSelectRank={(id) => {
            setKugouActiveRankId(id);
            online.setActiveId(null);
          }}
          tempPlaylists={online.temps}
          activeTempId={online.activeId}
          onSelectTemp={(item) => {
            online.setActiveId(item.id);
            setKugouActiveRankId(null);
            (kugouViewRef.current as any)?.restoreTemp?.(item.payload);
          }}
          onCloseKugou={() => setKugouOpen(false)}
          onOpenModuleSettings={() => setKugouSettingsOpen(v => !v)}
          onOpenStats={() => setKugouStatsOpen(v => !v)}
          statsActive={kugouStatsOpen}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
        />
      ) : (
        <MusicSidebar
          playlists={filteredPlaylists}
          selectedPlaylistId={selectedPlaylist?.id || null}
          onSelectPlaylist={handleSelectPlaylist}
          onSelectFolder={handleAddRoot}
          onCreatePlaylist={handleCreatePlaylist}
          onRenamePlaylist={handleRenamePlaylist}
          onDeletePlaylist={handleDeletePlaylist}
          onOpenModuleSettings={handleOpenModuleSettings}
          onOpenStats={() => setShowStats(v => !v)}
          statsActive={showStats}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
        />
      )}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-[#f5f5f0] dark:bg-[#1c1917]">
        <div className="flex-1 min-w-0 min-h-0 overflow-hidden relative">
          {showStats ? (
            neteaseOpen ? (
              <NeteaseStatsView onClose={() => setShowStats(false)} playlists={userPlaylists} likedCount={neteaseLiked.size} />
            ) : (
              <MusicStatsView onClose={() => setShowStats(false)} favoriteCount={favorites.size} />
            )
          ) : showSettings ? (
            neteaseOpen ? (
              <NeteaseSettingsPanel onClose={() => setShowSettings(false)} />
            ) : (
              <div className="h-full min-w-0 overflow-y-auto">
                <MusicSettingsPanel
                  onClose={() => setShowSettings(false)}
                  rootPaths={rootPaths}
                  onRemoveRoot={handleRemoveRoot}
                  onAddRoot={handleAddRoot}
                  volume={volume}
                  onVolumeChange={handleVolume}
                  lyricsFontSize={lyricsFontSize}
                  onLyricsFontSize={handleLyricsFontSize}
                  lyricsShowNextLine={lyricsShowNextLine}
                  onLyricsShowNextLine={handleLyricsShowNextLine}
                  onlineLyricsEnabled={onlineLyricsEnabled}
                  onOnlineLyricsToggle={handleOnlineLyricsToggle}
                  localLrcFirst={localLrcFirst}
                  onLocalLrcFirstToggle={handleLocalLrcFirstToggle}
                  showAlbum={showAlbum}
                  onShowAlbumToggle={handleShowAlbumToggle}
                  playMode={playMode}
                  onPlayModeChange={handlePlayModeChange}
                  lyricsAlign={lyricsAlign}
                  onLyricsAlignChange={handleLyricsAlignChange}
                  onCleanInvalidFiles={handleCleanInvalidFiles}
                  onRefreshAllFolders={handleRefreshAllFolders}
                  totalTracks={playlists.reduce((sum, p) => sum + p.tracks.length, 0)}
                  playlistCount={playlists.length}
                />
              </div>
            )
          ) : neteaseOpen ? (
            <NeteaseView
              ref={neteaseViewRef}
              initialTab={neteaseTab}
              onBack={() => setShowModuleDrawer(true)}
              onPlay={(tracks: PlayableTrack[], startIndex: number, sourceName: string) => {
                musicPlayer.setTracks(tracks, startIndex);
                musicPlayer.play();
                // 把网易云当前播放注册为临时歌单，让播放列表浮窗同步显示网易云来源
                musicPlayer.currentPlaylistId = 'netease-active';
                online.registerPlay(tracks, startIndex, sourceName, 'netease-temp');
              }}
              onTempPlaylist={(temp: TempPlaylist) => {
                online.registerTemp(temp);
                setActiveNeteasePlaylistId(null);
              }}
              onUserPlaylists={(items) => {
                // 用户自己的全部歌单（铺开到侧栏「用户自己的收藏歌单」）
                setUserPlaylists(items);
                const liked = items.find(p => isLikedPlaylist(p));
                if (liked) setLikedPlaylistId(liked.id);
              }}
              onActivePlaylist={(id) => {
                setActiveNeteasePlaylistId(id);
                online.setActiveId(null);
              }}
              onProfileChange={setNeteaseProfile}
              likedSongs={neteaseLiked}
              onLikedSongsChange={setNeteaseLiked}
              onToggleFavorite={toggleFavorite}
              onPlayMv={(mv) => {
                // 跨模块播放 MV：复用「以安得云荟打开」全局中枢（dispatchOpenWith），
                // 由 App 切到「玉兰」模块，玉兰消费后在内存创建临时列表播放。
                // 临时列表不落地、不持久化（关闭软件即销毁）。
                dispatchOpenWith('video', [{
                  url: mv.url,
                  name: [mv.name, mv.artist].filter(Boolean).join(' - '),
                  artist: mv.artist,
                  cover: mv.cover,
                }]);
              }}
              onOpenImmersive={handleCoverClick}
            />
          ) : kugouOpen ? (
            <KugouView
              ref={kugouViewRef}
              initialTab={kugouTab}
              onBack={() => setShowModuleDrawer(true)}
              onPlay={(tracks: PlayableTrack[], startIndex: number, sourceName: string) => {
                musicPlayer.setTracks(tracks, startIndex);
                musicPlayer.play();
                musicPlayer.currentPlaylistId = 'kugou-active';
                online.registerPlay(tracks, startIndex, sourceName, 'kugou-temp');
              }}
              onTempPlaylist={(temp: TempPlaylist) => {
                online.registerTemp(temp);
                online.setSourceActiveId(null);
              }}
              onActivePlaylist={(id) => {
                // 酷狗榜单高亮走在线源独立的 sourceActiveId，不污染网易云侧栏状态
                online.setSourceActiveId(id);
                online.setActiveId(null);
              }}
              selectedRankId={kugouActiveRankId}
              onRankListLoaded={setKugouRankList}
              onActiveRankChange={setKugouActiveRankId}
            />
          ) : null}
          {kugouOpen && kugouSettingsOpen ? (
            <KugouSettingsPanel onBack={() => setKugouSettingsOpen(false)} />
          ) : null}
          {kugouOpen && kugouStatsOpen ? (
            <KugouStatsView />
          ) : null}
          {selectedPlaylist ? (
            <TrackList
              tracks={filteredTracks}
              playlistName={selectedPlaylist.name}
              onSelectTrack={handleSelectTrack}
              onAddSong={handleAddSong}
              onOpenDrawer={() => setShowModuleDrawer(true)}
              onMoveTrack={handleMoveTrack}
              onCopyTrack={handleCopyTrack}
              onRemoveTrack={handleRemoveTrack}
              otherPlaylists={otherPlaylistsForMenu}
              showAlbum={showAlbum}
              favoriteIds={favorites}
              onToggleFavorite={toggleFavorite}
              onSetCover={handleSetCover}
              onResetCover={handleResetCover}
              onRescanTrack={handleRescanTrack}
              onEditTrack={handleEditTrack}
              loadLyricsText={loadLyricsText}
              saveTrackLyrics={saveTrackLyrics}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-sm text-neutral-400 dark:text-stone-500">{T('music.selectPlaylistHint')}</p>
            </div>
          )}
        </div>
        {/* PlayerBar 固定在内容区下方；设置/统计页也保持显示，不被覆盖。 */}
        {currentTrack && (() => {
          // 网易云歌曲：红心读/写走统一的网易云状态（neteaseLiked + toggleNeteaseLike）
          const neteaseMatch = /^netease-(\d+)$/.exec(currentTrack.id);
          const isNetease = !!neteaseMatch;
          const neteaseId = neteaseMatch ? Number(neteaseMatch[1]) : 0;
          return (
          <PlayerBar
            key={currentTrack.filePath}
            track={currentTrack}
            isPlaying={isPlaying}
            isFavorite={isNetease ? neteaseLiked.has(neteaseId) : favorites.has(trackIdOf(currentTrack))}
            onToggleFavorite={isNetease ? (() => toggleNeteaseLike(neteaseId, !neteaseLiked.has(neteaseId))) : toggleFavorite}
            onTogglePlay={togglePlay}
            onPrev={prevTrack}
            onNext={nextTrack}
            volume={volume}
            onVolumeChange={handleVolume}
            playMode={playMode}
            onPlayModeChange={handlePlayModeChange}
            onCoverClick={handleCoverClick}
            playlists={online.activePlaylist ? [...playlists, online.activePlaylist] : playlists}
            currentPlaylistId={musicPlayer.currentPlaylistId ?? selectedPlaylist?.id ?? null}
            onSelectTrack={handlePopupSelectTrack}
          />
          );
        })()}
      </div>
      <ModuleDrawer
        open={showModuleDrawer}
        onClose={() => setShowModuleDrawer(false)}
        isNeteaseOpen={neteaseOpen}
        onSelectLocalMusic={() => {
          setNeteaseOpen(false);
          setKugouOpen(false);
          setShowModuleDrawer(false);
        }}
        onSelectNetease={(key: 'listen' | 'library' | 'radio' | 'search' | 'login') => {
          setNeteaseTab(key);
          setNeteaseOpen(true);
          setKugouOpen(false);
        }}
        onSelectKugou={(key: 'home' | 'roam' | 'search' | 'mine') => {
          setKugouTab(key);
          setKugouOpen(true);
          setNeteaseOpen(false);
          // 切换折叠菜单子项时，清理榜单详情 / 收藏夹等内层级状态，避免覆盖漫游 / 我的
          setKugouActiveRankId(null);
          setSelectedPlaylist(null);
        }}
        isKugouOpen={kugouOpen}
        neteaseProfile={neteaseProfile}
      />
      {showNowPlaying && currentTrack && (
        <NowPlayingView
          track={currentTrack}
          isPlaying={isPlaying}
          onTogglePlay={togglePlay}
          onPrev={prevTrack}
          onNext={nextTrack}
          volume={volume}
          onVolumeChange={handleVolume}
          playMode={playMode}
          onPlayModeChange={handlePlayModeChange}
          onClose={handleCloseNowPlaying}
          lyricsAlign={lyricsAlign}
          playlists={online.activePlaylist ? [...playlists, online.activePlaylist] : playlists}
          currentPlaylistId={musicPlayer.currentPlaylistId ?? selectedPlaylist?.id ?? null}
          onSelectTrack={handlePopupSelectTrack}
        />
      )}
    </div>
  );
}

// 注册模块到插件系统
window.__PLUGIN_REGISTRY__.register({
  id: 'music',
  name: T('music.title'),
  iconName: 'Music2',
  kind: 'module',
  visible: true,
  component: MusicModule,
  sidebar: undefined,
  settings: undefined,
  // 热插拔卸载/重载前释放音频资源，避免 audio 元素与监听器泄漏
  destroy: () => musicPlayer.destroy(),
});