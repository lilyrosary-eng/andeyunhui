/// <reference path="../../global.d.ts" />
// 视频插件入口
import { VideoPlayer } from './VideoPlayer';
import { VideoSidebar } from './VideoSidebar';
import { useRootPaths, useBlacklist, useScanStream, EmptyState, LoadingState, NoResultsState } from '../../_shared/pluginRuntime';
import { registerOpenWithListener, getPendingOpenWith, importToOpenWithDir, type OpenWithItem } from '../../_shared/openWithFiles';

const React = window.__HOST_REACT__;
const { useState, useEffect, useCallback, useRef, useMemo } = React;
const hostApi = window.__HOST_API__;

const STORAGE_KEY_ROOT = 'video_plugin_root_paths';
const SETTINGS_KEY = 'video_plugin_settings';

// ========== 类型 ==========
interface VideoFolder {
  folderPath: string;
  folderName: string;
  videoCount: number;
}

interface VideoFile {
  filePath: string;
  fileName: string;
  sizeBytes: number;
}

interface ScanProgress {
  found: number;
  total: number;
  done: boolean;
}

interface VideoSettings {
  rememberProgress: boolean;
  rememberVolume: boolean;
  autoHideControls: boolean;
  playbackSpeed: number;
  autoPlayNext: boolean;
}

const DEFAULT_SETTINGS: VideoSettings = {
  rememberProgress: true,
  rememberVolume: true,
  autoHideControls: true,
  playbackSpeed: 1,
  autoPlayNext: true,
};

function loadSettings(): VideoSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(s: VideoSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

// ========== 图标 ==========
function VideoIcon() {
  return React.createElement('svg', {
    width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    children: [
      React.createElement('polygon', { key: '1', points: '23 7 16 12 23 17 23 7' }),
      React.createElement('rect', { key: '2', x: '1', y: '5', width: '15', height: '14', rx: '2', ry: '2' }),
    ],
  });
}

// ========== 设置面板内容 ==========
function SettingsContent({
  settings,
  onSettingsChange,
  folders,
  rootPaths,
  onRemoveRoot,
  onClose,
}: {
  settings: VideoSettings;
  onSettingsChange: (s: Partial<VideoSettings>) => void;
  folders: VideoFolder[];
  rootPaths: string[];
  onRemoveRoot: (path: string) => void;
  onClose: () => void;
}) {
  const ModuleSettingsPanel = (window.__HOST_UI__ as Record<string, unknown>)?.ModuleSettingsPanel as React.FC<{
    title: string; icon: React.ReactNode; onClose: () => void; children: React.ReactNode;
  }> | undefined;

  const panel = ModuleSettingsPanel
    ? React.createElement(ModuleSettingsPanel, {
        title: '玉兰',
        icon: React.createElement(VideoIcon),
        onClose,
        children: React.createElement('div', { className: 'space-y-4' },
          // 目录
          React.createElement('div', { className: 'glass-panel p-4' },
            React.createElement('label', { className: 'block text-xs font-medium text-neutral-500 dark:text-stone-400 mb-2' }, '视频目录'),
            rootPaths.length === 0
              ? React.createElement('p', { className: 'text-sm text-neutral-400 dark:text-stone-500' }, '尚未添加任何文件夹')
              : React.createElement('div', { className: 'space-y-2' },
                  ...rootPaths.map((path) =>
                    React.createElement('div', { key: path, className: 'flex items-center gap-2 group' },
                      React.createElement('span', { className: 'flex-1 text-sm text-neutral-600 dark:text-stone-300 truncate' }, path),
                      React.createElement('button', {
                        onClick: () => onRemoveRoot(path),
                        className: 'btn-press px-2 py-1 rounded text-xs text-neutral-400 dark:text-stone-500 hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100',
                        title: '移除',
                      }, '移除'),
                    )
                  ),
                ),
          ),
          // 播放设置
          React.createElement('div', { className: 'glass-panel p-4 space-y-3' },
            React.createElement('h3', { className: 'text-sm font-medium text-neutral-700 dark:text-stone-200' }, '播放'),
            // 记住播放进度
            React.createElement('label', { className: 'flex items-center justify-between cursor-pointer' },
              React.createElement('span', { className: 'text-sm text-neutral-600 dark:text-stone-300' }, '记住播放进度'),
              React.createElement('div', {
                onClick: () => onSettingsChange({ rememberProgress: !settings.rememberProgress }),
                className: `w-9 h-5 rounded-full relative transition-colors cursor-pointer ${settings.rememberProgress ? 'bg-[var(--element-bg)]' : 'bg-neutral-300 dark:bg-stone-600'}`,
              },
                React.createElement('div', {
                  className: `absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${settings.rememberProgress ? 'translate-x-[18px]' : 'translate-x-0.5'}`,
                }),
              ),
            ),
            // 记住音量
            React.createElement('label', { className: 'flex items-center justify-between cursor-pointer' },
              React.createElement('span', { className: 'text-sm text-neutral-600 dark:text-stone-300' }, '记住音量'),
              React.createElement('div', {
                onClick: () => onSettingsChange({ rememberVolume: !settings.rememberVolume }),
                className: `w-9 h-5 rounded-full relative transition-colors cursor-pointer ${settings.rememberVolume ? 'bg-[var(--element-bg)]' : 'bg-neutral-300 dark:bg-stone-600'}`,
              },
                React.createElement('div', {
                  className: `absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${settings.rememberVolume ? 'translate-x-[18px]' : 'translate-x-0.5'}`,
                }),
              ),
            ),
            // 鼠标静止后自动隐藏
            React.createElement('label', { className: 'flex items-center justify-between cursor-pointer' },
              React.createElement('span', { className: 'text-sm text-neutral-600 dark:text-stone-300' }, '鼠标静止后自动隐藏'),
              React.createElement('div', {
                onClick: () => onSettingsChange({ autoHideControls: !settings.autoHideControls }),
                className: `w-9 h-5 rounded-full relative transition-colors cursor-pointer ${settings.autoHideControls ? 'bg-[var(--element-bg)]' : 'bg-neutral-300 dark:bg-stone-600'}`,
              },
                React.createElement('div', {
                  className: `absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${settings.autoHideControls ? 'translate-x-[18px]' : 'translate-x-0.5'}`,
                }),
              ),
            ),
            // 自动播放下一集
            React.createElement('label', { className: 'flex items-center justify-between cursor-pointer' },
              React.createElement('span', { className: 'text-sm text-neutral-600 dark:text-stone-300' }, '自动播放下一集'),
              React.createElement('div', {
                onClick: () => onSettingsChange({ autoPlayNext: !settings.autoPlayNext }),
                className: `w-9 h-5 rounded-full relative transition-colors cursor-pointer ${settings.autoPlayNext ? 'bg-[var(--element-bg)]' : 'bg-neutral-300 dark:bg-stone-600'}`,
              },
                React.createElement('div', {
                  className: `absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${settings.autoPlayNext ? 'translate-x-[18px]' : 'translate-x-0.5'}`,
                }),
              ),
            ),
            // 默认播放速度
            React.createElement('div', { className: 'flex items-center justify-between' },
              React.createElement('span', { className: 'text-sm text-neutral-600 dark:text-stone-300' }, '默认播放速度'),
              React.createElement('select', {
                value: settings.playbackSpeed,
                onChange: (e: React.ChangeEvent<HTMLSelectElement>) => onSettingsChange({ playbackSpeed: parseFloat(e.target.value) }),
                className: 'text-sm bg-white dark:bg-stone-700 border border-neutral-200 dark:border-stone-600 rounded-lg px-2 py-1 text-neutral-700 dark:text-stone-200',
              },
                React.createElement('option', { value: '0.5' }, '0.5x'),
                React.createElement('option', { value: '1' }, '1x'),
                React.createElement('option', { value: '1.25' }, '1.25x'),
                React.createElement('option', { value: '1.5' }, '1.5x'),
                React.createElement('option', { value: '2' }, '2x'),
              ),
            ),
          ),
          // 防休眠（待确认）
          React.createElement('div', { className: 'glass-panel p-4' },
            React.createElement('div', { className: 'flex items-center justify-between' },
              React.createElement('div', { className: 'flex items-center gap-2' },
                React.createElement('span', { className: 'text-sm text-neutral-600 dark:text-stone-300' }, '播放时防止系统休眠'),
                React.createElement('span', { className: 'text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400' }, '待确认'),
              ),
              React.createElement('span', { className: 'text-xs text-neutral-400 dark:text-stone-500' }, '需安装插件'),
            ),
          ),
          // 统计
          React.createElement('div', { className: 'glass-panel p-4' },
            React.createElement('p', { className: 'text-xs text-neutral-400 dark:text-stone-500' },
              `已扫描 ${folders.length} 个文件夹`
            ),
          ),
        ),
      })
    : null;

  return panel as React.ReactElement;
}

// ========== 主组件 ==========
function VideoModule() {
  // 共享运行时：根目录管理（localStorage 持久化）
  const { rootPaths, addRoot, addRootPathEphemeral, removeRoot } = useRootPaths(STORAGE_KEY_ROOT);
  // 共享运行时：黑名单管理（Rust 集中管理）
  const { hidden: hiddenFolders, add: addToBlacklist, removeAll: removeAllBlacklist, clear: clearBlacklist } = useBlacklist('video');
  const [folders, setFolders] = useState<VideoFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<VideoFolder | null>(null);
  const [videos, setVideos] = useState<VideoFile[]>([]);
  const [videosLoading, setVideosLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [rescanCounter, setRescanCounter] = useState(0);
  const [playingFile, setPlayingFile] = useState<VideoFile | null>(null);
  const [settings, setSettings] = useState<VideoSettings>(loadSettings);

  // 保存设置
  const handleSettingsChange = useCallback((partial: Partial<VideoSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...partial };
      saveSettings(next);
      return next;
    });
  }, []);

  // 扫描视频根目录（支持多根目录 + 缓存）—— 共享 useScanStream：帧缓冲 + 缓存优先 + 可取消
  const { start: scanStart, cancel: scanCancel } = useScanStream<VideoFolder>({
    chunkEvent: 'video-scan-chunk',
    progressEvent: 'video-scan-progress',
    cacheCommand: 'load_video_cache',
    scanCommand: 'scan_video_root',
    rootPaths,
    onItems: (items) => setFolders(prev => [...prev, ...items]),
    onProgress: (p) => setScanProgress(p),
    onDone: () => setLoading(false),
    onError: (e) => {
      if (String(e).includes('扫描已在进行中')) return;
      console.error('[Video] 扫描失败:', e);
    },
  });

  useEffect(() => {
    if (rootPaths.length === 0) return;

    setFolders([]);
    setSelectedFolder(null);
    setVideos([]);
    setPlayingFile(null);
    setLoading(true);
    setScanProgress(null);
    scanStart();

    return () => scanCancel();
  }, [rootPaths, rescanCounter, scanStart, scanCancel]);

  // 添加根目录
  const handleSelectRoot = useCallback(async () => {
    const result = await addRoot();
    if (result) {
      setSelectedFolder(null);
    }
  }, [addRoot]);

  // 移除根目录
  const handleRemoveRoot = useCallback((pathToRemove: string) => {
    removeRoot(pathToRemove);
    setFolders(prev => prev.filter(f => !f.folderPath.startsWith(pathToRemove)));
    setSelectedFolder(prev => {
      if (prev && prev.folderPath.startsWith(pathToRemove)) return null;
      return prev;
    });
    hostApi.invoke('delete_video_cache', { rootPath: pathToRemove }).catch((err: unknown) => console.warn('[Video] 删除缓存失败:', err));
  }, [removeRoot]);

  // 点击文件夹 → 加载视频文件列表（状态 B）
  const handleFolderClick = useCallback(async (folder: VideoFolder) => {
    setSelectedFolder(folder);
    setPlayingFile(null);
    setVideosLoading(true);
    try {
      const files = await hostApi.invoke<VideoFile[]>('get_folder_videos', { folderPath: folder.folderPath });
      setVideos(files);
    } catch (err) {
      console.error('[Video] 加载视频列表失败:', err);
      setVideos([]);
    }
    setVideosLoading(false);
  }, []);

  // 点击视频文件 → 播放（状态 B → 播放器）
  const handleVideoClick = useCallback((file: VideoFile) => {
    setPlayingFile(file);
  }, []);

  // 返回文件夹列表（状态 B → 状态 A）
  const handleBackToFolders = useCallback(() => {
    setSelectedFolder(null);
    setVideos([]);
    setPlayingFile(null);
  }, []);

  // 播放器返回
  const handleBackFromPlayer = useCallback(() => {
    setPlayingFile(null);
  }, []);

  // 切换文件（上一集/下一集）
  const handleFileChange = useCallback((file: VideoFile) => {
    setPlayingFile(file);
  }, []);

  // 以安得云荟打开 / 拖入主窗口：复制进固定临时目录 → 注册为常驻库文件夹 → 播放目标
  const processOpenWith = useCallback(async (items: OpenWithItem[]) => {
    try {
      const { dir, paths } = await importToOpenWithDir('video', items);
      addRootPathEphemeral(dir);
      setRescanCounter((c) => c + 1);
      if (paths[0]) {
        setPlayingFile({
          filePath: paths[0],
          fileName: paths[0].split(/[\\/]/).pop() || paths[0],
          sizeBytes: 0,
        });
      }
    } catch (err) {
      console.error('[Video] 以安得云荟打开失败:', err);
    }
  }, [addRootPathEphemeral]);

  useEffect(() => {
    const unsub = registerOpenWithListener((m, files) => {
      if (m === 'video') processOpenWith(files);
    });
    const pending = getPendingOpenWith('video');
    if (pending) processOpenWith(pending);
    return unsub;
  }, [processOpenWith]);

  // 模块设置
  const handleOpenModuleSettings = useCallback(() => {
    setShowSettings(prev => !prev);
  }, []);

  // 重新扫描
  const handleRescan = useCallback(async () => {
    for (const path of rootPaths) {
      try { await hostApi.invoke('delete_video_cache', { rootPath: path }); } catch (err) { console.warn('[Video] 删除缓存失败:', err); }
    }
    await removeAllBlacklist([...rootPaths]);
    clearBlacklist();
    setFolders([]);
    setSelectedFolder(null);
    setVideos([]);
    setPlayingFile(null);
    setRescanCounter(c => c + 1);
  }, [rootPaths, removeAllBlacklist, clearBlacklist]);
  
  // 屏蔽视频文件夹
  const handleHideFolder = useCallback((folder: VideoFolder) => {
    addToBlacklist(folder.folderPath, folder.folderName);
    if (selectedFolder?.folderPath === folder.folderPath) {
      setSelectedFolder(null);
    }
  }, [selectedFolder, addToBlacklist]);
  
  // 过滤黑名单的文件夹
  const visibleFolders = useMemo(() => 
    folders.filter(f => !hiddenFolders.has(f.folderPath)),
    [folders, hiddenFolders]
  );

  // 空状态
  if (rootPaths.length === 0) {
    return (
      <EmptyState
        icon={
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--element-bg)]">
            <polygon points="23 7 16 12 23 17 23 7" />
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          </svg>
        }
        title="视频模块"
        description="选择一个包含视频文件的文件夹，将自动按子文件夹分组展示"
        buttonText="选择视频文件夹"
        onSelect={handleSelectRoot}
      />
    );
  }

  // 扫描中
  if (loading && folders.length === 0) {
    return (
      <LoadingState
        progressText={scanProgress ? `已发现 ${scanProgress.found} 个文件夹...` : '正在扫描视频...'}
        onCancel={() => hostApi.invoke('cancel_scan').catch(() => {})}
      />
    );
  }

  // 无结果
  if (!loading && folders.length === 0) {
    return (
      <NoResultsState
        text="未找到包含视频的文件夹"
        buttonText="更换目录"
        onSelect={handleSelectRoot}
      />
    );
  }

  // 主内容区
  const renderContent = () => {
    // 设置面板（优先级最高，参考音乐模块：设置可顶掉当前主面板页面）
    if (showSettings) {
      return React.createElement(SettingsContent, {
        settings,
        onSettingsChange: handleSettingsChange,
        folders,
        rootPaths,
        onRemoveRoot: handleRemoveRoot,
        onClose: () => setShowSettings(false),
      });
    }

    // 播放视图
    if (playingFile) {
      return React.createElement(VideoPlayer, {
        file: playingFile,
        videoList: videos,
        onFileChange: handleFileChange,
        onBack: handleBackFromPlayer,
        settings,
        onSettingsChange: handleSettingsChange,
      });
    }

    // 已选中文件夹但视频还在加载
    if (selectedFolder && videosLoading) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-neutral-400 dark:text-stone-500">加载中...</p>
        </div>
      );
    }

    // 已选中文件夹但无视频
    if (selectedFolder && videos.length === 0) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-neutral-400 dark:text-stone-500">该文件夹没有视频文件</p>
        </div>
      );
    }

    // 默认：未选中文件夹
    return (
      <div className="flex-1 flex flex-col items-center justify-center h-full gap-3 text-neutral-400 dark:text-stone-500">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-40">
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
        <p className="text-sm">从左侧选择一个文件夹开始浏览</p>
      </div>
    );
  };

  return (
    <div className="flex-1 flex h-full overflow-hidden">
      {React.createElement(VideoSidebar, {
        folders: visibleFolders,
        videos,
        playingFile,
        selectedFolder,
        searchQuery,
        onSearchChange: setSearchQuery,
        onFolderClick: handleFolderClick,
        onVideoClick: handleVideoClick,
        onBackToFolders: handleBackToFolders,
        onChangeRoot: handleSelectRoot,
        onRescan: handleRescan,
        onOpenSettings: handleOpenModuleSettings,
        rootPaths,
      })}
      <div className="flex-1 h-full overflow-hidden bg-[#f5f5f0] dark:bg-[#1c1917]">
        {renderContent()}
      </div>
    </div>
  );
}

// 注册模块
window.__PLUGIN_REGISTRY__.register({
  id: 'video',
  name: '玉兰',
  iconName: 'Video',
  kind: 'module',
  visible: true,
  component: VideoModule,
  sidebar: undefined,
  settings: undefined,
});