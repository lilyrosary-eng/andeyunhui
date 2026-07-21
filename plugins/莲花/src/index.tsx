/// <reference path="../../global.d.ts" />
import { ImageViewer } from './ImageViewer';
import { ImageSidebar } from './ImageSidebar';
import { useRootPaths, useBlacklist, useScanStream, EmptyState, LoadingState, NoResultsState } from '../../_shared/pluginRuntime';
import { registerOpenWithListener, getPendingOpenWith, importToOpenWithDir, type OpenWithItem } from '../../_shared/openWithFiles';
const React = window.__HOST_REACT__;
const { useState, useEffect, useCallback, useRef, useMemo } = React;
const hostApi = window.__HOST_API__;

const STORAGE_KEY_ROOT = 'image_plugin_root_path';
const STORAGE_KEY_ALBUMS = 'image_plugin_custom_albums';
const STORAGE_KEY_RENAMES = 'image_plugin_folder_renames';

interface ImageFolder {
  folderPath: string;
  folderName: string;
  coverImage: string;
  imageCount: number;
}

interface ScanProgress {
  found: number;
  total: number;
  done: boolean;
}

interface CustomAlbum {
  id: string;
  name: string;
  images: string[];  // 文件路径列表（仅引用，不修改原文件）
  createdAt: string;
}

function ImageModule() {
  // 共享运行时：根目录管理（localStorage 持久化）
  const { rootPaths, setRootPaths, addRoot, addRootPath, removeRoot } = useRootPaths(STORAGE_KEY_ROOT);
  const [folders, setFolders] = useState<ImageFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<ImageFolder | null>(null);
  const [rescanCounter, setRescanCounter] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  // 以安得云荟打开 / 拖入：定位打开的图片 + 强制重挂载查看器
  const [openWithInitialPath, setOpenWithInitialPath] = useState<string | null>(null);
  const [openWithNonce, setOpenWithNonce] = useState(0);

  // 自定义相册（仅存在于应用内部列表，不涉及文件系统操作）
  const [customAlbums, setCustomAlbums] = useState<CustomAlbum[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_ALBUMS);
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });

  // 文件夹重命名映射（仅影响显示名称，不修改文件系统）
  const [folderRenames, setFolderRenames] = useState<Record<string, string>>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_RENAMES);
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  });

  // 已隐藏的文件夹黑名单（使用 Rust 集中管理，支持全局查看和恢复）
  const { hidden: hiddenFolders, add: addToBlacklist, removeAll: removeAllBlacklist, clear: clearBlacklist } = useBlacklist('image');

  // 加载扫描结果（优先缓存，无缓存时扫描）—— 共享 useScanStream：帧缓冲 + 缓存优先 + 可取消
  const { start: scanStart, cancel: scanCancel } = useScanStream<ImageFolder>({
    chunkEvent: 'scan-chunk',
    progressEvent: 'scan-progress',
    cacheCommand: 'load_image_cache',
    scanCommand: 'scan_image_root',
    rootPaths,
    onItems: (items) => setFolders(prev => [...prev, ...items]),
    onProgress: (p) => setScanProgress(p),
    onDone: () => setLoading(false),
    onError: (e) => {
      if (String(e).includes('扫描已在进行中')) return;
      console.error('[Image] 扫描失败:', e);
    },
  });

  useEffect(() => {
    if (rootPaths.length === 0) return;

    setFolders([]);
    setLoading(true);
    setScanProgress(null);
    scanStart();

    return () => scanCancel();
  }, [rootPaths, rescanCounter, scanStart, scanCancel]);

  const handleAddRoot = useCallback(async () => {
    const result = await addRoot();
    if (result) {
      setSelectedFolder(null);
    }
  }, [addRoot]);

  const handleRemoveRoot = useCallback((pathToRemove: string) => {
    removeRoot(pathToRemove);
    // 同时移除该路径下的文件夹数据
    setFolders(prev => prev.filter(f => !f.folderPath.startsWith(pathToRemove)));
    setSelectedFolder(prev => {
      if (prev && prev.folderPath.startsWith(pathToRemove)) {
        return null;
      }
      return prev;
    });
  }, [removeRoot]);

  const handleFolderClick = useCallback((folder: ImageFolder) => {
    setSelectedFolder(folder);
  }, []);

  const handleBack = useCallback(() => {
    setSelectedFolder(null);
  }, []);

  // 以安得云荟打开 / 拖入主窗口：复制进固定临时目录 → 注册为常驻库文件夹 → 打开目标图片
  const processOpenWith = useCallback(async (items: OpenWithItem[]) => {
    try {
      const { dir, paths } = await importToOpenWithDir('image', items);
      addRootPath(dir);
      if (paths[0]) {
        setOpenWithInitialPath(paths[0]);
        setOpenWithNonce((n) => n + 1);
        setSelectedFolder({ folderPath: dir, folderName: '以安得云荟打开' });
      }
    } catch (err) {
      console.error('[Image] 以安得云荟打开失败:', err);
    }
  }, [addRootPath]);

  useEffect(() => {
    const unsub = registerOpenWithListener((m, files) => {
      if (m === 'image') processOpenWith(files);
    });
    const pending = getPendingOpenWith('image');
    if (pending) processOpenWith(pending);
    return unsub;
  }, [processOpenWith]);

  const handleRescan = useCallback(async () => {
    // 清除所有路径的缓存，重新扫描
    for (const path of rootPaths) {
      try {
        await hostApi.invoke('delete_image_cache', { rootPath: path });
      } catch (e) {
        // 缓存可能不存在，忽略
      }
    }
    // 从 Rust 黑名单清除当前模块的所有条目
    await removeAllBlacklist([...hiddenFolders]);
    clearBlacklist();
    setRescanCounter(c => c + 1);
  }, [rootPaths, hiddenFolders, removeAllBlacklist, clearBlacklist]);

  // 重命名文件夹：仅影响内部列表显示名称，不修改文件系统
  const handleRenameFolder = useCallback((folder: ImageFolder, newName: string) => {
    setFolderRenames(prev => {
      const updated = { ...prev, [folder.folderPath]: newName };
      localStorage.setItem(STORAGE_KEY_RENAMES, JSON.stringify(updated));
      return updated;
    });
  }, []);

  // 从列表移除文件夹：加入 Rust 黑名单持久化，不再显示
  const handleDeleteFolder = useCallback((folder: ImageFolder) => {
    addToBlacklist(folder.folderPath, folder.folderName);
    if (selectedFolder?.folderPath === folder.folderPath) {
      setSelectedFolder(null);
    }
  }, [selectedFolder, addToBlacklist]);

  // 新建自定义相册：仅存在于应用内部列表
  const handleCreateAlbum = useCallback((name: string) => {
    const newAlbum: CustomAlbum = {
      id: Date.now().toString(),
      name,
      images: [],
      createdAt: new Date().toISOString(),
    };
    setCustomAlbums(prev => {
      const updated = [...prev, newAlbum];
      localStorage.setItem(STORAGE_KEY_ALBUMS, JSON.stringify(updated));
      return updated;
    });
  }, []);

  // 删除自定义相册
  const handleDeleteAlbum = useCallback((albumId: string) => {
    setCustomAlbums(prev => {
      const updated = prev.filter(a => a.id !== albumId);
      localStorage.setItem(STORAGE_KEY_ALBUMS, JSON.stringify(updated));
      return updated;
    });
  }, []);

  // 模块设置（当前为占位，后续扩展）
  const handleOpenModuleSettings = useCallback(() => {
    setShowSettings(prev => !prev);
  }, []);

  // 应用文件夹重命名到显示列表，并过滤黑名单
  const displayFolders = useCallback(() => {
    return folders
      .filter(f => !hiddenFolders.has(f.folderPath))
      .map(f => ({
        ...f,
        folderName: folderRenames[f.folderPath] || f.folderName,
      }));
  }, [folders, folderRenames, hiddenFolders]);

  const displayFolderList = displayFolders();

  // 根据搜索词过滤文件夹列表（大小写不敏感）
  const filteredFolders = useMemo(() => {
    if (!searchQuery.trim()) return displayFolderList;
    const q = searchQuery.trim().toLowerCase();
    return displayFolderList.filter(f => f.folderName.toLowerCase().includes(q));
  }, [displayFolderList, searchQuery]);

  if (rootPaths.length === 0) {
    return (
      <EmptyState
        icon={
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--element-bg)]">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
        }
        title="图片模块"
        description="选择一个包含图片的文件夹作为根目录，将自动按子文件夹分组展示"
        buttonText="添加文件夹"
        onSelect={handleAddRoot}
      />
    );
  }

  if (loading && folders.length === 0) {
    return (
      <LoadingState
        progressText={scanProgress ? `已发现 ${scanProgress.found} 个文件夹...` : '正在扫描图片...'}
        onCancel={() => hostApi.invoke('cancel_scan').catch(() => {})}
      />
    );
  }

  if (!loading && folders.length === 0) {
    return (
      <NoResultsState
        text="未找到包含图片的文件夹"
        buttonText="更换目录"
        onSelect={handleAddRoot}
      />
    );
  }

  return (
    <div className="flex-1 flex h-full overflow-hidden">
      <ImageSidebar
        folders={filteredFolders}
        customAlbums={customAlbums}
        loading={loading}
        selectedFolder={selectedFolder}
        onSelectFolder={handleFolderClick}
        onAddRoot={handleAddRoot}
        onRescan={handleRescan}
        onRenameFolder={handleRenameFolder}
        onDeleteFolder={handleDeleteFolder}
        onCreateAlbum={handleCreateAlbum}
        onDeleteAlbum={handleDeleteAlbum}
        onOpenModuleSettings={handleOpenModuleSettings}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />
      <div className="flex-1 h-full overflow-hidden bg-[#f5f5f0] dark:bg-[#1c1917]">
        {showSettings ? (
          React.createElement(window.__HOST_UI__?.ModuleSettingsPanel || 'div', {
            title: '莲花',
            icon: React.createElement('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', children: [
              React.createElement('rect', { key: '1', x: '3', y: '3', width: '18', height: '18', rx: '2', ry: '2' }),
              React.createElement('circle', { key: '2', cx: '8.5', cy: '8.5', r: '1.5' }),
              React.createElement('polyline', { key: '3', points: '21 15 16 10 5 21' }),
            ]}),
            onClose: () => setShowSettings(false),
            children: React.createElement(React.Fragment, null,
              React.createElement('div', { className: 'glass-panel p-4' },
                React.createElement('label', { className: 'block text-xs font-medium text-neutral-500 dark:text-stone-400 mb-2' }, '图片根目录'),
                rootPaths.length === 0
                  ? React.createElement('p', { className: 'text-sm text-neutral-400 dark:text-stone-500' }, '尚未添加任何文件夹')
                  : React.createElement('div', { className: 'space-y-2' },
                      rootPaths.map((path) =>
                        React.createElement('div', { key: path, className: 'flex items-center gap-2 group' },
                          React.createElement('span', { className: 'flex-1 text-sm text-neutral-600 dark:text-stone-300 truncate' }, path),
                          React.createElement('button', {
                            onClick: () => handleRemoveRoot(path),
                            className: 'btn-press px-2 py-1 rounded-lg text-xs text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100',
                          }, '移除'),
                        )
                      ),
                    ),
                React.createElement('div', { className: 'mt-3' },
                  React.createElement('button', {
                    onClick: handleAddRoot,
                    className: 'btn-press px-3 py-1.5 rounded-lg text-xs bg-[var(--element-bg)] text-white hover:opacity-90 transition-opacity',
                  }, '添加文件夹'),
                ),
              ),
              React.createElement('div', { className: 'glass-panel p-4' },
                React.createElement('p', { className: 'text-xs text-neutral-400 dark:text-stone-500' },
                  `已扫描 ${folders.length} 个文件夹，${customAlbums.length} 个自定义相册`
                ),
              ),
            ),
          })
        ) : selectedFolder ? (
          <ImageViewer
            key={`openwith-${openWithNonce}`}
            folderPath={selectedFolder.folderPath}
            folderName={selectedFolder.folderName}
            onBack={handleBack}
            initialPath={openWithInitialPath ?? undefined}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center h-full gap-3 text-neutral-400 dark:text-stone-500">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-40">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            <p className="text-sm">从左侧选择一个文件夹开始浏览</p>
          </div>
        )}
      </div>
    </div>
  );
}

window.__PLUGIN_REGISTRY__.register({
  id: 'image',
  name: '莲花',
  iconName: 'Image',
  kind: 'module',
  visible: true,
  component: ImageModule,
  sidebar: undefined,
  settings: undefined,
});