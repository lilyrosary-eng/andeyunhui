// 酷狗音乐视图（对齐 NeteaseView.tsx 范式）
//
// 复用 netease 的 props/handle 契约（PlayableTrack / TempPlaylist / NeteaseViewHandle 形状），
// 仅把数据源从 neteaseApi 换成 kugouApi。本视图覆盖：搜索、榜单浏览、歌单浏览、播放
// （取播放 URL 后通过 onPlay 交给 musicPlayer）。登录态/红心/账号等暂未实现（酷狗游客态
// 已可搜索+试听+歌词），后续如需会员无损再补扫码登录。

import React from 'react';
const { useState, useEffect, useRef } = React;
import { MusicIcon, PlayIcon, SearchIcon } from 'lucide-react';
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

type KugouTab = 'search' | 'rank';

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
  { initialTab, onBack, onPlay, onTempPlaylist, onActivePlaylist, selectedRankId, onRankListLoaded, onActiveRankChange },
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

  // 暴露命令式方法给侧栏（临时歌单恢复播放）
  React.useImperativeHandle(ref, () => ({
    openPlaylist: () => {},
    restoreTemp: (payload: any) => {
      if (!payload?.tracks?.length) return;
      musicPlayer.setTracks(payload.tracks, 0);
      musicPlayer.play();
      musicPlayer.currentPlaylistId = payload.id ?? 'kugou-active';
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
        // 默认选中第一个榜单（飙升），除非外部已通过 selectedRankId 指定
        if (ranks.length && selectedRankId == null && activeRankId === null) {
          setActiveRankId(ranks[0].id);
          onActiveRankChange?.(ranks[0].id);
          loadRank(ranks[0].id);
        }
      } catch (e: any) {
        if (!cancelled) setError('榜单加载失败：' + (e?.message || e));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 侧栏驱动榜单切换：selectedRankId 变化时自动加载对应榜单
  React.useEffect(() => {
    if (selectedRankId != null && selectedRankId !== activeRankId) {
      setActiveRankId(selectedRankId);
      onActiveRankChange?.(selectedRankId);
      loadRank(selectedRankId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRankId]);

  // 重新拉取榜单列表并默认选中第一个（错误重试兜底用）
  async function reloadRankList() {
    try {
      const ranks = await getRankList();
      setRankList(ranks);
      onRankListLoaded?.(ranks);
      if (ranks.length) {
        setActiveRankId(ranks[0].id);
        onActiveRankChange?.(ranks[0].id);
        loadRank(ranks[0].id);
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
      const list = await getTopList(rankId, 1, 30);
      if (req !== reqRef.current) return;
      allTracksRef.current = list;
      setTracks(list);
    } catch (e: any) {
      if (req === reqRef.current) setError('榜单加载失败：' + (e?.message || e));
    } finally {
      if (req === reqRef.current) setLoading(false);
    }
  }

  async function doSearch() {
    const kw = keyword.trim();
    if (!kw) return;
    const req = ++reqRef.current;
    setLoading(true);
    setError('');
    try {
      const list = await searchSongs(kw, 30, 1);
      if (req !== reqRef.current) return;
      allTracksRef.current = list;
      setTracks(list);
    } catch (e: any) {
      if (req === reqRef.current) setError('搜索失败：' + (e?.message || e));
    } finally {
      if (req === reqRef.current) setLoading(false);
    }
  }

  async function doPlay(track: KugouTrack, index: number) {
    try {
      setPlayingId(track.id);
      const { url, br } = await getSongUrl(track.hash || track.id, track.albumId);
      if (!url) {
        setError('该歌曲暂无可播放地址（可能需会员或已下架）');
        return;
      }
      const quality = qualityLabelFromBr(br);
      void trackToPlayable(track, url, quality);
      // 整页作为临时歌单交给播放器：批量取地址（带容错）
      const playables: PlayableTrack[] = [];
      for (const tk of allTracksRef.current) {
        try {
          const r = await getSongUrl(tk.hash || tk.id, tk.albumId);
          playables.push(trackToPlayable(tk, r.url, qualityLabelFromBr(r.br)));
        } catch {
          playables.push(trackToPlayable(tk, '', ''));
        }
      }
      onPlay(playables, index, `酷狗 · ${track.name}`);
      onTempPlaylist?.({
        id: `kugou-temp-${Date.now()}`,
        name: tab === 'search' ? `搜索：${keyword}` : '酷狗榜单',
        tracks: playables,
        payload: { kind: tab === 'search' ? 'search' : 'recommend', keyword, tracks: playables },
      });
    } catch (e: any) {
      setError('播放失败：' + (e?.message || e));
    } finally {
      setPlayingId(null);
    }
  }

  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* 顶栏：复用通用音乐模块模板（标题 + 登录按钮 + 云按钮） */}
      <MusicHeader
        title="酷狗音乐"
        onUserClick={() => {
          // 酷狗游客态暂未实现登录页，点击给出轻提示，后续可在此打开用户页
          setError('酷狗登录功能待接入');
        }}
        onCloudClick={onBack}
        cloudTitle="音乐模块"
        user={{ loggedIn: false }}
      />

      {/* 子模块切换（搜索 / 榜单）：保留在顶栏下方作为第二行 */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0">
        <div className="flex items-center gap-1 p-1 rounded-lg bg-neutral-100/70 dark:bg-stone-800/60">
          {(['search', 'rank'] as KugouTab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1 rounded-md text-sm transition-colors ${
                tab === t
                  ? 'bg-white dark:bg-stone-700 text-neutral-800 dark:text-stone-100 shadow-sm'
                  : 'text-neutral-500 dark:text-stone-400'
              }`}
            >
              {t === 'search' ? '搜索' : '榜单'}
            </button>
          ))}
        </div>
      </div>

      {/* 搜索 / 榜单切换内容 */}
      {tab === 'search' ? (
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
      ) : (
        <div className="flex items-center gap-3 overflow-x-auto scrollbar-thin px-3 py-2 border-b border-neutral-200/70 dark:border-stone-700/60">
          {rankList.map((r) => {
            const active = activeRankId === r.id;
            return (
              <button
                key={r.id}
                onClick={() => loadRank(r.id)}
                className={`flex flex-col items-center gap-1 shrink-0 w-14 ${
                  active ? 'opacity-100' : 'opacity-70 hover:opacity-100'
                }`}
                title={String(r.name)}
              >
                <span
                  className={`w-14 h-14 rounded-xl flex items-center justify-center text-xs font-semibold text-center leading-tight px-1 overflow-hidden ${
                    active
                      ? 'bg-blue-500/20 text-blue-600 dark:text-blue-300 ring-1 ring-blue-500/40'
                      : 'bg-neutral-100/70 dark:bg-stone-800/60 text-neutral-700 dark:text-stone-200'
                  }`}
                >
                  {r.name}
                </span>
              </button>
            );
          })}
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
            onClick={() => (tab === 'search' ? doSearch() : activeRankId ? loadRank(activeRankId) : reloadRankList())}
          >
            重试
          </button>
        </div>
      )}

      {/* 歌曲列表 */}
      <div className="flex-1 overflow-y-auto min-h-0">
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
        {!loading && !error && tracks.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-neutral-400 dark:text-stone-500">
            <MusicIcon size={32} />
            <span className="text-sm">暂无内容</span>
          </div>
        )}
      </div>
    </div>
  );
});
