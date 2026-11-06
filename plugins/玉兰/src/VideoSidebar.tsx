/// <reference path="../../global.d.ts" />
// 视频模块侧边栏 — 使用共享 DrillDownSidebarList 组件
// 状态 A：文件夹列表；状态 B：选中文件夹下的视频文件列表（集数列表）
const React = window.__HOST_REACT__;
import { T, useLang } from '../../_shared/pluginRuntime';
const { useMemo, useCallback } = React;
const { ModuleSidebarShell, ContextMenuItem, ContextMenuSeparator, BarChart3 } = window.__HOST_UI__ || {};
import { DrillDownSidebarList, type DrillDownItem } from '../../_shared/DrillDownSidebarList';
import { formatTime } from '../../_shared/utils';

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
  onOpenCloud: () => void;
  /** 有续播进度的视频（按最近观看倒序）；为空则不显示「继续观看」区块 */
  resumeItems?: Array<{ filePath: string; fileName: string; position: number }>;
  onResume?: (filePath: string) => void;
  /** 打开「统计」页（本地视频库概览）；不传则不显示该入口 */
  onOpenStats?: () => void;
  /** 统计页是否正在显示（侧栏按钮高亮，与音乐/阅读/图片一致） */
  statsActive?: boolean;
}

// 云形图标（切换按钮 logo）
function CloudIcon() {
  return React.createElement('svg', {
    width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    children: React.createElement('path', { d: 'M17.5 19a4.5 4.5 0 0 0 .5-8.97 6 6 0 0 0-11.64-2A4 4 0 0 0 6.5 19h11z' }),
  });
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
  useLang();
  const {
    folders, videos, playingFile, selectedFolder,
    searchQuery, onSearchChange,
    onFolderClick, onVideoClick, onBackToFolders,
    onChangeRoot, onRescan,   onOpenSettings,
  onOpenCloud,
  resumeItems = [], onResume, onOpenStats, statsActive,
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
        React.createElement(ContextMenuItem, { key: 'open', onClick: () => onFolderClick(folder) }, T('video.sidebar.open')),
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
      primaryEmptyText: searchQuery ? T('video.sidebar.noMatch') : T('video.sidebar.noFolders'),
      secondaryEmptyText: T('video.sidebar.noVideos'),
  });

  // 「继续观看」：只在文件夹列表（状态 A）显示，最多 5 条。
  // 数据来自播放器的续播进度（localStorage），点一下直接进播放器接着看。
  const resumeBlock = !isStateB && resumeItems.length > 0
    ? React.createElement('div', { className: 'px-1 pb-2' },
        React.createElement('div', {
          className: 'text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-stone-500 px-2 py-1',
        }, '继续观看'),
        resumeItems.slice(0, 5).map((item) => React.createElement('button', {
          key: item.filePath,
          onClick: () => onResume?.(item.filePath),
          className: 'btn-press w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-black/5 dark:hover:bg-white/10 transition-colors',
          title: item.filePath,
        },
          React.createElement('span', {
            className: 'w-1.5 h-1.5 rounded-full flex-shrink-0',
            style: { background: 'var(--element-bg)' },
          }),
          React.createElement('span', {
            className: 'min-w-0 flex-1 truncate text-xs text-neutral-600 dark:text-stone-300',
          }, item.fileName),
          React.createElement('span', {
            className: 'shrink-0 text-[10px] tabular-nums text-neutral-400 dark:text-stone-500',
          }, formatTime(item.position)),
        ))
      )
    : null;

  const childrenWithResume = resumeBlock
    ? React.createElement(React.Fragment, null, resumeBlock, listContent)
    : listContent;

  // 侧栏底部统计按钮：与音乐/阅读/图片模块同一模式（footer 区、icon-only、18px、激活高亮）
  const statsButton = onOpenStats
    ? React.createElement('button', {
        key: 'open-stats',
        onClick: () => onOpenStats(),
        title: statsActive ? '关闭统计' : '统计',
        'aria-label': statsActive ? '关闭统计' : '统计',
        className: `p-2 rounded-lg transition-colors ${
          statsActive
            ? 'text-[var(--element-color-raw)] bg-black/5 dark:bg-white/5'
            : 'text-neutral-400 dark:text-stone-500 hover:text-[var(--element-color-raw)] hover:bg-black/5 dark:hover:bg-white/5'
        }`,
        children: BarChart3 ? React.createElement(BarChart3, { size: 18, strokeWidth: 2 }) : '📊',
      })
    : null;

  return ModuleSidebarShell
    ? React.createElement(ModuleSidebarShell, {
        moduleId: 'video',
        // 收起后不再留竖条：本模块内容区自带纸面色，须让收起那列同色，详见 ModuleSidebarShell 的说明
        collapsedSurfaceClass: 'bg-[#f5f5f0] dark:bg-[#1c1917]',
        icon: React.createElement(VideoIcon),
        title: T('video.title'),
        onOpenModuleSettings: onOpenSettings,
        footerExtra: statsButton,
        searchQuery,
        onSearchChange,
        searchPlaceholder: isStateB ? T('video.sidebar.searchVideos') : T('video.sidebar.searchFolders'),
        titleActions: React.createElement('button', {
          onClick: onOpenCloud,
          title: '云',
          className: 'btn-press flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 hover:text-[var(--element-bg)] hover:bg-[var(--element-muted)] transition-colors',
        }, React.createElement(CloudIcon), React.createElement('span', null, '云')),
        primaryAction: { label: T('video.sidebar.chooseFolder'), onClick: onChangeRoot },
        secondaryActions: [
          {
            icon: React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', children: [
              React.createElement('polyline', { key: '1', points: '23 4 23 10 17 10' }),
              React.createElement('polyline', { key: '2', points: '1 20 1 14 7 14' }),
              React.createElement('path', { key: '3', d: 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15' }),
            ]}),
            label: T('video.sidebar.rescan'),
            onClick: onRescan,
          },
        ],
        children: childrenWithResume,
      })
    : null;
}

export default VideoSidebar;
