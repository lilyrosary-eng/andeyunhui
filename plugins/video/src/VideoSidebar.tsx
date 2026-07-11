/// <reference path="../../global.d.ts" />
// 视频模块侧边栏 — 两态钻取导航
// 状态 A：文件夹列表；状态 B：选中文件夹下的视频文件列表（集数列表）
const React = window.__HOST_REACT__;
const { useState, useMemo } = React;
const { ModuleSidebarShell, SecondaryNavShell, ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } = window.__HOST_UI__ || {};

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

interface VideoSidebarProps {
  folders: VideoFolder[];
  videos: VideoFile[];
  playingFile: VideoFile | null;
  selectedFolder: VideoFolder | null;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onFolderClick: (folder: VideoFolder) => void;
  onVideoClick: (file: VideoFile) => void;
  onBackToFolders: () => void;
  onChangeRoot: () => void;
  onRescan: () => void;
  onOpenSettings: () => void;
  rootPaths: string[];
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

function FolderIcon() {
  return React.createElement('svg', {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    children: React.createElement('path', {
      d: 'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-5.586a1 1 0 0 1-.707-.293L12 3.414 9.293 6.121A1 1 0 0 1 8.586 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2z',
    }),
  });
}

function FileIcon() {
  return React.createElement('svg', {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    children: React.createElement('polygon', { points: '5 3 19 12 5 21 5 3' }),
  });
}

function ArrowLeftIcon() {
  return React.createElement('svg', {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    children: React.createElement('polyline', { points: '15 18 9 12 15 6' }),
  });
}

function formatSize(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

// ========== 状态 A：文件夹列表 ==========
function FolderListView({
  folders,
  playingFile,
  selectedFolder,
  searchQuery,
  onFolderClick,
}: {
  folders: VideoFolder[];
  playingFile: VideoFile | null;
  selectedFolder: VideoFolder | null;
  searchQuery: string;
  onFolderClick: (folder: VideoFolder) => void;
}) {
  const filteredFolders = useMemo(() => {
    if (!searchQuery.trim()) return folders;
    const q = searchQuery.trim().toLowerCase();
    return folders.filter(f => f.folderName.toLowerCase().includes(q));
  }, [folders, searchQuery]);

  if (filteredFolders.length === 0) {
    return React.createElement('div', {
      className: 'flex-1 flex items-center justify-center text-xs text-neutral-400 dark:text-stone-500',
    }, searchQuery ? '未找到匹配的文件夹' : '暂无文件夹');
  }

  return React.createElement('div', { className: 'space-y-0.5' },
    ...filteredFolders.map((folder) => {
      const isSelected = selectedFolder?.folderPath === folder.folderPath;
      const buttonContent = React.createElement('button', {
        key: 'btn',
        onClick: () => onFolderClick(folder),
        className: `w-full text-left px-3 py-2 rounded-xl transition-colors flex items-center gap-2.5 ${
          isSelected
            ? 'bg-[var(--element-bg)]/10 text-[var(--element-bg)]'
            : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400'
        }`,
      },
        React.createElement('span', { key: 'icon', className: 'flex-shrink-0 opacity-60' },
          React.createElement(FolderIcon),
        ),
        React.createElement('span', { key: 'name', className: 'text-sm font-medium truncate flex-1' }, folder.folderName),
        React.createElement('span', { key: 'count', className: 'text-xs opacity-50 flex-shrink-0' }, `${folder.videoCount}`),
      );
      if (!ContextMenu) return buttonContent;
      return React.createElement(ContextMenu, { key: folder.folderPath },
        React.createElement(ContextMenuTrigger, { className: 'w-full' }, buttonContent),
        React.createElement(ContextMenuContent, null,
          React.createElement(ContextMenuItem, { onClick: () => onFolderClick(folder) }, '打开'),
          React.createElement(ContextMenuSeparator),
          React.createElement(ContextMenuItem, { onClick: () => { try { navigator.clipboard?.writeText(folder.folderName); } catch {} } }, '复制名称'),
        ),
      );
    })
  );
}

// ========== 状态 B：视频文件列表（集数列表） ==========
function VideoListView({
  videos,
  playingFile,
  folderName,
  onVideoClick,
  onBack,
}: {
  videos: VideoFile[];
  playingFile: VideoFile | null;
  folderName: string;
  onVideoClick: (file: VideoFile) => void;
  onBack: () => void;
}) {
  return React.createElement(React.Fragment, null,
    // 返回按钮
    React.createElement('button', {
      onClick: onBack,
      className: 'w-full text-left px-3 py-2 rounded-xl transition-colors flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/5 text-neutral-500 dark:text-stone-400 mb-1',
    },
      React.createElement('span', { className: 'flex-shrink-0' }, React.createElement(ArrowLeftIcon)),
      React.createElement('span', { className: 'text-sm font-medium truncate' }, folderName),
    ),
    // 视频文件列表
    React.createElement('div', { className: 'space-y-0.5' },
      ...videos.map((video) => {
        const isPlaying = playingFile?.filePath === video.filePath;
        return React.createElement('button', {
          key: video.filePath,
          onClick: () => onVideoClick(video),
          className: `w-full text-left px-3 py-2 rounded-xl transition-colors flex items-center gap-2.5 ${
            isPlaying
              ? 'bg-[var(--element-bg)]/10 text-[var(--element-bg)]'
              : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400'
          }`,
        },
          React.createElement('span', { key: 'icon', className: 'flex-shrink-0 opacity-60' },
            React.createElement(FileIcon),
          ),
          React.createElement('div', { key: 'info', className: 'min-w-0 flex-1' },
            React.createElement('div', { className: 'text-sm truncate' }, video.fileName),
            React.createElement('div', { className: 'text-[11px] opacity-50 mt-0.5' }, formatSize(video.sizeBytes)),
          ),
          isPlaying && React.createElement('span', {
            key: 'indicator',
            className: 'w-1.5 h-1.5 rounded-full bg-[var(--element-bg)] flex-shrink-0',
          }),
        );
      })
    ),
  );
}

// ========== 侧边栏主组件 ==========
export function VideoSidebar(props: VideoSidebarProps) {
  const {
    folders, videos, playingFile, selectedFolder,
    searchQuery, onSearchChange,
    onFolderClick, onVideoClick, onBackToFolders,
    onChangeRoot, onRescan, onOpenSettings, rootPaths,
  } = props;

  const isStateB = selectedFolder !== null;

  // 内容：状态 A 或状态 B
  const listContent = isStateB
    ? React.createElement(VideoListView, {
        videos,
        playingFile,
        folderName: selectedFolder.folderName,
        onVideoClick,
        onBack: onBackToFolders,
      })
    : React.createElement(FolderListView, {
        folders,
        playingFile,
        selectedFolder,
        searchQuery,
        onFolderClick,
      });

  const wrappedList = SecondaryNavShell
    ? React.createElement(SecondaryNavShell, null, listContent)
    : React.createElement('div', { className: 'flex-1 overflow-y-auto pr-1' }, listContent);

  return ModuleSidebarShell
    ? React.createElement(ModuleSidebarShell, {
        moduleId: 'video',
        icon: React.createElement(VideoIcon),
        title: '玉兰',
        onOpenModuleSettings: onOpenSettings,
        searchQuery,
        onSearchChange,
        searchPlaceholder: isStateB ? '搜索视频...' : '搜索文件夹...',
        primaryAction: { label: '+ 选择文件夹', onClick: onChangeRoot },
        secondaryActions: [
          {
            icon: React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', children: [
              React.createElement('polyline', { key: '1', points: '23 4 23 10 17 10' }),
              React.createElement('polyline', { key: '2', points: '1 20 1 14 7 14' }),
              React.createElement('path', { key: '3', d: 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15' }),
            ]}),
            label: '重新扫描',
            onClick: onRescan,
          },
          {
            icon: React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', children: [
              React.createElement('circle', { key: '1', cx: '12', cy: '12', r: '3' }),
              React.createElement('path', { key: '2', d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z' }),
            ]}),
            label: '管理文件夹',
            onClick: onOpenSettings,
          },
        ],
        children: wrappedList,
      })
    : null;
}

export default VideoSidebar;