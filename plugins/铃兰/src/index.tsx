/// <reference path="../../global.d.ts" />
// 音乐插件入口
import { MusicSidebar } from './MusicSidebar';
import { TrackList } from './TrackList';
import { PlayerBar } from './PlayerBar';
import { NowPlayingView } from './NowPlayingView';
import { musicPlayer, type Track, type PlayMode } from './musicPlayer';
import { useRootPaths, useBlacklist, EmptyState, LoadingState, NoResultsState } from '../../_shared/pluginRuntime';
import { registerOpenWithListener, getPendingOpenWith, importToOpenWithDir, type OpenWithItem } from '../../_shared/openWithFiles';

const React = window.__HOST_REACT__;
const { useState, useEffect, useCallback, useRef, useMemo } = React;
const hostApi = window.__HOST_API__;

interface Playlist {
  id: string;
  name: string;
  tracks: Track[];
  type: 'directory' | 'custom';
}

interface MusicScanProgress {
  found: number;
  total: number;
  done: boolean;
}

const STORAGE_KEY_ROOT = 'music_plugin_root_paths';
const STORAGE_KEY_PLAYLISTS = 'music_playlists';
const STORAGE_KEY_HIDDEN = 'music_plugin_hidden_playlists'; // 兼容旧版

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
  lyricsAlign: 'center' | 'left' | 'right';
  onLyricsAlignChange: (v: 'center' | 'left' | 'right') => void;
  onCleanInvalidFiles: () => void;
  onRefreshAllFolders: () => void;
  totalTracks: number;
  playlistCount: number;
}

function MusicSettingsPanel(p: MusicSettingsPanelProps) {
  const ModuleSettingsPanel = (window.__HOST_UI__ as Record<string, unknown>)?.ModuleSettingsPanel as
    | React.ComponentType<{ title: string; icon: React.ReactNode; onClose: () => void; children: React.ReactNode }>
    | undefined;
  if (!ModuleSettingsPanel) return null;

  return (
    <ModuleSettingsPanel
      title="铃兰"
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
        <h3 className="text-xs font-semibold text-neutral-500 dark:text-stone-400 mb-3">歌词设置</h3>
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-neutral-600 dark:text-stone-300">联网获取歌词</span>
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
          <span className="text-xs text-neutral-600 dark:text-stone-300">本地 LRC 优先于内嵌歌词</span>
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
          <span className="text-xs text-neutral-600 dark:text-stone-300">歌词对齐方式</span>
          <div className="flex gap-1 rounded-lg p-0.5 bg-[var(--element-muted)]">
            {(['center', 'left', 'right'] as const).map((opt) => (
              <button
                key={opt}
                onClick={() => p.onLyricsAlignChange(opt)}
                className="px-2 py-1 rounded-md text-xs transition-colors"
                style={p.lyricsAlign === opt ? { background: 'var(--element-bg)', color: '#fff' } : { color: 'var(--text-secondary, #78716c)' }}
              >
                {opt === 'center' ? '居中' : opt === 'left' ? '左对齐' : '右对齐'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 桌面歌词 */}
      <div className="glass-panel p-4">
        <h3 className="text-xs font-semibold text-neutral-500 dark:text-stone-400 mb-3">桌面歌词</h3>
        <div className="mb-3">
          <label className="block text-xs font-medium text-neutral-500 dark:text-stone-400 mb-2">{`字体大小: ${p.lyricsFontSize}px`}</label>
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
          <span className="text-xs text-neutral-500 dark:text-stone-400">显示下一行预览</span>
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
        <h3 className="text-xs font-semibold text-neutral-500 dark:text-stone-400 mb-3">显示设置</h3>
        <div className="mb-3">
          <label className="block text-xs font-medium text-neutral-500 dark:text-stone-400 mb-2">{`默认音量: ${Math.round(p.volume * 100)}%`}</label>
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
          <span className="text-xs text-neutral-600 dark:text-stone-300">列表始终显示专辑名称</span>
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
      </div>

      {/* 维护 */}
      <div className="glass-panel p-4">
        <h3 className="text-xs font-semibold text-neutral-500 dark:text-stone-400 mb-3">维护</h3>
        <div className="flex flex-col gap-2">
          <button
            onClick={p.onCleanInvalidFiles}
            className="btn-press px-3 py-2 rounded-lg text-xs bg-[var(--element-muted)] text-neutral-600 dark:text-stone-300 hover:opacity-80 transition-opacity text-left"
          >
            清理无效文件
          </button>
          <button
            onClick={p.onRefreshAllFolders}
            className="btn-press px-3 py-2 rounded-lg text-xs bg-[var(--element-muted)] text-neutral-600 dark:text-stone-300 hover:opacity-80 transition-opacity text-left"
          >
            刷新所有文件夹歌单
          </button>
        </div>
      </div>

      {/* 音乐目录 */}
      <div className="glass-panel p-4">
        <h3 className="text-xs font-semibold text-neutral-500 dark:text-stone-400 mb-3">音乐目录</h3>
        {p.rootPaths.length === 0 ? (
          <p className="text-xs text-neutral-400 dark:text-stone-500 mb-2">尚未添加任何目录</p>
        ) : (
          <div className="space-y-1.5 mb-2">
            {p.rootPaths.map((path) => (
              <div key={path} className="flex items-center gap-2 text-sm">
                <span className="flex-1 text-neutral-600 dark:text-stone-300 truncate text-xs">{path}</span>
                <button
                  onClick={() => p.onRemoveRoot(path)}
                  className="btn-press px-2 py-0.5 rounded-lg text-xs text-red-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors flex-shrink-0"
                  title="移除此目录"
                >
                  移除
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          onClick={p.onAddRoot}
          className="btn-press px-3 py-1.5 rounded-lg text-xs bg-[var(--element-muted)] text-[var(--element-bg)] hover:opacity-80 transition-opacity"
        >
          + 添加文件夹
        </button>
      </div>

      {/* 统计 */}
      <div className="glass-panel p-4">
        <p className="text-xs text-neutral-400 dark:text-stone-500">
          {`已扫描 ${p.totalTracks} 首歌曲，${p.playlistCount} 个歌单`}
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

function groupTracksIntoPlaylists(tracks: Track[], rootPath: string): Playlist[] {
  const root = normalizePath(rootPath);
  const groups = new Map<string, { name: string; tracks: Track[] }>();
  for (const t of tracks) {
    const fp = normalizePath(t.filePath);
    const parent = fp.includes('/') ? fp.slice(0, fp.lastIndexOf('/')) : fp;
    const rel = parent.startsWith(root + '/')
      ? parent.slice(root.length + 1)
      : parent === root ? '' : parent;
    let key: string;
    let name: string;
    if (rel === '') {
      key = root;
      name = root.split('/').pop() || '音乐';
    } else {
      const first = rel.split('/')[0];
      key = root + '/' + first;
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

function MusicModule() {
  // 共享运行时：根目录管理（localStorage 持久化）
  const { rootPaths, setRootPaths, addRoot, addRootPath, removeRoot } = useRootPaths(STORAGE_KEY_ROOT);
  // 共享运行时：黑名单管理（Rust 集中管理，必须在 filteredPlaylists useMemo 之前声明）
  const { hidden: hiddenPlaylists, add: addToBlacklist, removeAll: removeAllBlacklist, clear: clearBlacklist } = useBlacklist('music');
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
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
  const [lyricsFontSize, setLyricsFontSize] = useState(() => {
    const saved = localStorage.getItem('music_lyrics_font_size');
    return saved ? parseInt(saved, 10) : 28;
  });
  const [lyricsShowNextLine, setLyricsShowNextLine] = useState(() => {
    const saved = localStorage.getItem('music_lyrics_show_next_line');
    return saved !== null ? saved === 'true' : true;
  });
  const [showNowPlaying, setShowNowPlaying] = useState(false);
  const [currentTrack, setCurrentTrack] = useState<Track | null>(() => musicPlayer.getCurrentTrack());
  const unlistenRef = useRef<(() => void)[]>([]);
  // 当前选中歌单 ID 的 ref：供 handleMoveTrack / handleRemoveTrack 等闭包使用，
  // 避免依赖 selectedPlaylist 导致回调频繁重建
  const selectedPlaylistIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedPlaylistIdRef.current = selectedPlaylist?.id ?? null;
  }, [selectedPlaylist?.id]);

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
    if (rootPaths.length === 0) return;

    unlistenRef.current.forEach(fn => fn());
    unlistenRef.current = [];

    setLoading(true);
    setScanProgress(null);
    // 不重置 playlists/selectedPlaylist：避免切换歌单时播放停止。
    // 扫描结果会通过 setPlaylists([...allDirectoryPlaylists, ...customPlaylists]) 合并覆盖。

    let cancelled = false;
    const allDirectoryPlaylists: Playlist[] = [];

    // 帧缓冲：将高频 scan-progress 批量合并到单帧消费
    const progressBuffer = hostApi.createFrameBuffer<MusicScanProgress>((items) => {
      if (cancelled) return;
      setScanProgress(items[items.length - 1]);
    });

    (async () => {
      // 1. 先尝试为每个路径加载缓存
      const pathsToScan: string[] = [];
      for (const rp of rootPaths) {
        try {
          const cached = await hostApi.invoke('load_music_cache', { rootPath: rp }) as Track[] | null;
          if (cached && cached.length > 0) {
            if (cancelled) return;
            console.log('[Music] 缓存命中:', cached.length, '首 (路径:', rp, ')');
            allDirectoryPlaylists.push(...groupTracksIntoPlaylists(cached, rp));
            continue;
          }
          console.log('[Music] 缓存未命中，需要扫描:', rp);
        } catch (e) {
          console.log('[Music] 缓存加载异常，需要扫描:', rp, e);
        }
        if (!cancelled) pathsToScan.push(rp);
      }

      if (cancelled) return;

      // 2. 如果全都有缓存，直接显示
      if (pathsToScan.length === 0) {
        const savedPlaylists = localStorage.getItem(STORAGE_KEY_PLAYLISTS);
        const customPlaylists: Playlist[] = savedPlaylists ? JSON.parse(savedPlaylists) : [];
        setPlaylists([...allDirectoryPlaylists, ...customPlaylists]);
        // 恢复上次播放的歌单（模块切换/重载后保持选中状态）
        const savedId = musicPlayer.currentPlaylistId;
        const restored = savedId ? allDirectoryPlaylists.find(p => p.id === savedId) : null;
        setSelectedPlaylist(restored || (allDirectoryPlaylists.length > 0 ? allDirectoryPlaylists[0] : null));
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
        allDirectoryPlaylists.push(...groupTracksIntoPlaylists([...currentScanTracks], rp));
      }

      if (cancelled) return;
      setLoading(false);
      const savedPlaylists = localStorage.getItem(STORAGE_KEY_PLAYLISTS);
      const customPlaylists: Playlist[] = savedPlaylists ? JSON.parse(savedPlaylists) : [];
      setPlaylists([...allDirectoryPlaylists, ...customPlaylists]);
      const savedId = musicPlayer.currentPlaylistId;
      const restored = savedId ? allDirectoryPlaylists.find(p => p.id === savedId) : null;
      setSelectedPlaylist(restored || (allDirectoryPlaylists.length > 0 ? allDirectoryPlaylists[0] : null));
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

  // 订阅播放器状态
  useEffect(() => {
    const unsubPlay = musicPlayer.on('play', () => setIsPlaying(true));
    const unsubPause = musicPlayer.on('pause', () => setIsPlaying(false));
    const unsubTrackChange = musicPlayer.on('trackChange', (track) => {
      setCurrentTrack(track as Track | null);
    });
    setIsPlaying(musicPlayer.getIsPlaying());
    setVolume(musicPlayer.getVolume());
    setPlayMode(musicPlayer.getPlayMode());
    return () => { unsubPlay(); unsubPause(); unsubTrackChange(); };
  }, []);

  const handleAddRoot = useCallback(async () => {
    await addRoot();
    // 不重置 selectedPlaylist：新文件夹的扫描结果会自动合并，当前播放不中断
  }, [addRoot]);

  // #3 创建自定义歌单：写入状态 + 持久化 + 立即选中（侧边栏即时刷新）
  const handleCreatePlaylist = useCallback((name: string) => {
    const newPlaylist: Playlist = {
      id: Date.now().toString(),
      name,
      tracks: [],
      type: 'custom',
    };
    setPlaylists(prev => {
      const updated = [...prev, newPlaylist];
      const customPlaylists = updated.filter(p => p.type === 'custom');
      localStorage.setItem(STORAGE_KEY_PLAYLISTS, JSON.stringify(customPlaylists));
      return updated;
    });
    setSelectedPlaylist(newPlaylist);
  }, []);

// 模块加载探针（console.error 必然可见，用于确认 music 插件脚本是否真正执行）
try { console.error('[music-diag] index.tsx 模块开始求值; __HOST_API__=' + typeof window.__HOST_API__); } catch {}
// 模块加载时写入 Rust 端日志，便于确认插件脚本是否真正被加载执行（某些 dev 环境会使用 sandbox）。
try { window.__HOST_API__?.invoke('debug_log', { msg: 'MUSIC_PLUGIN_LOADED' }).catch(()=>{}); } catch {}

  const handleRemoveRoot = useCallback((pathToRemove: string) => {
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
    musicPlayer.currentPlaylistId = playlist.id;
    // 状态保持：切换歌单不重置播放器，当前音乐继续播放。
    // 用户点击新歌单中的歌曲时，handleSelectTrack 会调用 setTracks 刷新。
  }, []);

  const handleSelectTrack = useCallback((track: Track, index: number) => {
    // 如果启用了搜索过滤，index 是过滤后数组中的位置，需要还原为原数组索引
    const tracks = selectedPlaylist?.tracks || [];
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

  // 以安得云荟打开 / 拖入主窗口：复制进固定临时目录 → 注册为常驻库文件夹 → 播放目标
  const processOpenWith = useCallback(async (items: OpenWithItem[]) => {
    try {
      const { dir, paths } = await importToOpenWithDir('music', items);
      addRootPath(dir);
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
        musicPlayer.setTracks([track], 0);
        musicPlayer.play();
      }
    } catch (err) {
      console.error('[Music] 以安得云荟打开失败:', err);
    }
  }, [addRootPath]);

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
    setVolume(vol);
  }, []);

  const handlePlayModeChange = useCallback((mode: PlayMode) => {
    musicPlayer.setPlayMode(mode);
    setPlayMode(mode);
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
        const base = f.split(/[\\/]/).pop() || '未知曲目';
        const fallbackTitle = base.replace(/\.[^.]+$/, '') || '未知曲目';
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
      const customPlaylists = updated.filter((p) => p.type === 'custom');
      localStorage.setItem(STORAGE_KEY_PLAYLISTS, JSON.stringify(customPlaylists));
      return updated;
    });
    setSelectedPlaylist((prev) => (prev ? { ...prev, tracks: [...prev.tracks, ...newTracks] } : prev));
  }, [selectedPlaylist]);

  const handleRenamePlaylist = useCallback((playlist: Playlist, newName: string) => {
    setPlaylists(prev => {
      const updated = prev.map(p => p.id === playlist.id ? { ...p, name: newName } : p);
      // 同步更新 localStorage 中的自定义歌单
      const customPlaylists = updated.filter(p => p.type === 'custom');
      localStorage.setItem(STORAGE_KEY_PLAYLISTS, JSON.stringify(customPlaylists));
      return updated;
    });
    if (selectedPlaylist?.id === playlist.id) {
      setSelectedPlaylist(prev => prev ? { ...prev, name: newName } : null);
    }
  }, [selectedPlaylist]);

  const handleDeletePlaylist = useCallback((playlist: Playlist) => {
    const msg = playlist.type === 'directory'
      ? `确定要从列表中移除 "${playlist.name}" 吗？（不会删除原始文件）`
      : `确定要删除自定义歌单 "${playlist.name}" 吗？此操作不可撤销。`;
    if (!window.confirm(msg)) return;
    if (playlist.type === 'directory') {
      addToBlacklist(playlist.id, playlist.name);
    } else {
      setPlaylists(prev => {
        const updated = prev.filter(p => p.id !== playlist.id);
        const customPlaylists = updated.filter(p => p.type === 'custom');
        localStorage.setItem(STORAGE_KEY_PLAYLISTS, JSON.stringify(customPlaylists));
        return updated;
      });
    }
    if (selectedPlaylist?.id === playlist.id) {
      setSelectedPlaylist(null);
    }
  }, [selectedPlaylist, addToBlacklist]);

  // 移动歌曲到其他歌单：源/目标都更新；自定义歌单持久化到 localStorage
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
      // 仅自定义歌单需要持久化
      const customPlaylists = updated.filter(p => p.type === 'custom');
      localStorage.setItem(STORAGE_KEY_PLAYLISTS, JSON.stringify(customPlaylists));
      return updated;
    });
    // 同步更新当前歌单的 selectedPlaylist
    setSelectedPlaylist(prev => {
      if (!prev || prev.id !== currentId) return prev;
      return { ...prev, tracks: prev.tracks.filter(t => t.id !== track.id) };
    });
  }, []);

  // 移除歌曲：从当前歌单中删除
  // - 自定义歌单：内存删除 + 持久化
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
      const customPlaylists = updated.filter(p => p.type === 'custom');
      localStorage.setItem(STORAGE_KEY_PLAYLISTS, JSON.stringify(customPlaylists));
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
        title="音乐模块"
        description="选择一个包含音乐文件的文件夹，将自动扫描并播放"
        buttonText="选择音乐文件夹"
        onSelect={handleAddRoot}
      />
    );
  }

  if (loading && playlists.length === 0) {
    return (
      <LoadingState
        progressText={scanProgress ? `已扫描 ${scanProgress.found} / ${scanProgress.total} 首...` : '正在扫描音乐...'}
        onCancel={() => hostApi.invoke('cancel_scan').catch(() => {})}
      />
    );
  }

  if (!loading && playlists.length === 0) {
    return (
      <NoResultsState
        text="未找到音乐文件"
        buttonText="添加文件夹"
        onSelect={handleAddRoot}
      />
    );
  }

  return (
    <div className="flex-1 flex h-full overflow-hidden relative" tabIndex={0} onKeyDown={handleModuleKeyDown}>
      <MusicSidebar
        playlists={filteredPlaylists}
        selectedPlaylistId={selectedPlaylist?.id || null}
        onSelectPlaylist={handleSelectPlaylist}
        onSelectFolder={handleAddRoot}
        onCreatePlaylist={handleCreatePlaylist}
        onRenamePlaylist={handleRenamePlaylist}
        onDeletePlaylist={handleDeletePlaylist}
        onOpenModuleSettings={handleOpenModuleSettings}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />
      <div className="flex-1 flex flex-col min-h-0 bg-[#f5f5f0] dark:bg-[#1c1917] relative">
        {showSettings ? (
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
            lyricsAlign={lyricsAlign}
            onLyricsAlignChange={handleLyricsAlignChange}
            onCleanInvalidFiles={handleCleanInvalidFiles}
            onRefreshAllFolders={handleRefreshAllFolders}
            totalTracks={playlists.reduce((sum, p) => sum + p.tracks.length, 0)}
            playlistCount={playlists.length}
          />
        ) : selectedPlaylist ? (
          <TrackList
            tracks={filteredTracks}
            playlistName={selectedPlaylist.name}
            onSelectTrack={handleSelectTrack}
            onAddSong={handleAddSong}
            onMoveTrack={handleMoveTrack}
            onRemoveTrack={handleRemoveTrack}
            otherPlaylists={otherPlaylistsForMenu}
            showAlbum={showAlbum}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-neutral-400 dark:text-stone-500">选择一个歌单开始播放</p>
          </div>
        )}
        {/* PlayerBar 独立持久渲染：切换歌单时不卸载，保持播放状态连续。
            仅在非设置面板且有当前曲目时显示。 */}
        {!showSettings && currentTrack && (
          <PlayerBar
            key={currentTrack.filePath}
            track={currentTrack}
            isPlaying={isPlaying}
            onTogglePlay={togglePlay}
            onPrev={prevTrack}
            onNext={nextTrack}
            volume={volume}
            onVolumeChange={handleVolume}
            playMode={playMode}
            onPlayModeChange={handlePlayModeChange}
            onCoverClick={handleCoverClick}
          />
        )}
      </div>
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
        />
      )}
    </div>
  );
}

// 注册模块到插件系统
window.__PLUGIN_REGISTRY__.register({
  id: 'music',
  name: '铃兰',
  iconName: 'Music2',
  kind: 'module',
  visible: true,
  component: MusicModule,
  sidebar: undefined,
  settings: undefined,
  // 热插拔卸载/重载前释放音频资源，避免 audio 元素与监听器泄漏
  destroy: () => musicPlayer.destroy(),
});