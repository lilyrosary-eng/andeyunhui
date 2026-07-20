/// <reference path="../../global.d.ts" />
// 视频模块侧边栏 — 使用共享 DrillDownSidebarList 组件
// 状态 A：文件夹列表；状态 B：选中文件夹下的视频文件列表（集数列表）
const React = window.__HOST_REACT__;
const { useMemo, useCallback } = React;
const { ModuleSidebarShell, ContextMenuItem, ContextMenuSeparator } = window.__HOST_UI__ || {};
import { DrillDownSidebarList, type DrillDownItem } from '../../_shared/DrillDownSidebarList';

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

function formatSize(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

// ========== 侧边栏主组件 ==========

export function VideoSidebar(props: VideoSidebarProps) {
  const {
    folders, videos, playingFile, selectedFolder,
    searchQuery, onSearchChange,
    onFolderClick, onVideoClick, onBackToFolders,
    onChangeRoot, onRescan, onOpenSettings,
  } = props;

  const isStateB = selectedFolder !== null;

  // 过滤文件夹（搜索）
  const filteredFolders = useMemo(() => {
    if (!searchQuery.trim()) return folders;
    const q = searchQuery.trim().toLowerCase();
    return folders.filter(f => f.folderName.toLowerCase().includes(q));
  }, [folders, searchQuery]);

  // 转换为 DrillDownItem[]
  const primaryItems: DrillDownItem[] = useMemo(() => {
    return filteredFolders.map(folder => ({
      id: folder.folderPath,
      icon: React.createElement(FolderIcon),
      title: folder.folderName,
      badge: folder.videoCount,
      active: selectedFolder?.folderPath === folder.folderPath,
      contextMenu: ContextMenuItem ? React.createElement(React.Fragment, null,
        React.createElement(ContextMenuItem, { key: 'open', onClick: () => onFolderClick(folder) }, '打开'),
        React.createElement(ContextMenuSeparator, { key: 'sep' }),
        React.createElement(ContextMenuItem, { key: 'copy', onClick: () => { try { navigator.clipboard?.writeText(folder.folderName); } catch {} } }, '复制名称'),
      ) : undefined,
    }));
  }, [filteredFolders, selectedFolder, onFolderClick]);

  const secondaryItems: DrillDownItem[] = useMemo(() => {
    return videos.map(video => ({
      id: video.filePath,
      icon: React.createElement(FileIcon),
      title: video.fileName,
      subtitle: formatSize(video.sizeBytes),
      active: playingFile?.filePath === video.filePath,
    }));
  }, [videos, playingFile]);

  // 统一点击处理
  const handleItemClick = useCallback((item: DrillDownItem) => {
    if (isStateB) {
      const video = videos.find(v => v.filePath === item.id);
      if (video) onVideoClick(video);
    } else {
      const folder = folders.find(f => f.folderPath === item.id);
      if (folder) onFolderClick(folder);
    }
  }, [isStateB, videos, folders, onVideoClick, onFolderClick]);

  const listContent = React.createElement(DrillDownSidebarList, {
    primaryItems,
    secondaryItems,
    drillTitle: isStateB ? selectedFolder!.folderName : null,
    onBack: onBackToFolders,
    onItemClick: handleItemClick,
    primaryEmptyText: searchQuery ? '未找到匹配的文件夹' : '暂无文件夹',
    secondaryEmptyText: '暂无视频',
  });

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
        children: listContent,
      })
    : null;
}

export default VideoSidebar;
