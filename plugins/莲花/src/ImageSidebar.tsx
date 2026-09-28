/// <reference path="../../global.d.ts" />
import React from "react";
import { T, useLang } from '../../_shared/pluginRuntime';
import { ThumbImg } from './ImageViewer';
const { useState } = React;
const hostApi = window.__HOST_API__;
const { ModuleSidebarShell, SecondaryNavShell, ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } = window.__HOST_UI__ || {};

// 相册自选封面的键：两类相册共用一张表（见 index.tsx 的 STORAGE_KEY_COVERS），
// 用前缀区分来源，避免键相互碰撞。放在这里而非 index.tsx，是为了避免
// ImageSidebar ↔ index 的循环 import（index 已经单向 import 本文件）。
export function folderCoverKey(folderPath: string): string {
  return 'f:' + folderPath;
}
export function albumCoverKey(albumId: string): string {
  return 'a:' + albumId;
}

/** 每页列出的备选封面数量。面板网格是 5 列，加上「自选」格正好 25 格 = 5 整行。 */
const COVER_PAGE_CANDIDATES = 24;
/** 封面网格列数（与上面配套：5 列 × 5 行） */
const COVER_GRID_COLS = 5;

interface ImageFolder {
  folderPath: string;
  folderName: string;
  coverImage: string;
  imageCount: number;
}

interface CustomAlbum {
  id: string;
  name: string;
  images: string[];
  createdAt: string;
}

interface ImageSidebarProps {
  folders: ImageFolder[];
  customAlbums: CustomAlbum[];
  loading: boolean;
  selectedFolder: ImageFolder | null;
  onSelectFolder: (folder: ImageFolder) => void;
  onAddRoot: () => void;
  onRescan: () => void;
  onRenameFolder?: (folder: ImageFolder, newName: string) => void;
  onDeleteFolder?: (folder: ImageFolder) => void;
  onCreateAlbum?: (name: string) => void;
  onDeleteAlbum?: (albumId: string) => void;
  /** 相册自选封面映射（封面键 → 图片路径） */
  albumCovers?: Record<string, string>;
  /** 设置 / 清除封面；coverPath 为 null 表示恢复默认封面 */
  onSetCover?: (key: string, coverPath: string | null) => void;
  onImportImages?: () => void;
  onOpenModuleSettings?: () => void;
  searchQuery?: string;
  onSearchChange?: (value: string) => void;
}

function ImageIcon() {
  return React.createElement('svg', {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    children: [
      React.createElement('rect', { key: '1', x: '3', y: '3', width: '18', height: '18', rx: '2', ry: '2' }),
      React.createElement('circle', { key: '2', cx: '8.5', cy: '8.5', r: '1.5' }),
      React.createElement('polyline', { key: '3', points: '21 15 16 10 5 21' }),
    ],
  });
}

function FolderIcon() {
  return React.createElement('svg', {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    children: [
      React.createElement('path', { key: '1', d: 'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-5.586a1 1 0 0 1-.707-.293L12 3.414 9.293 6.121A1 1 0 0 1 8.586 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2z' }),
    ],
  });
}

function RefreshIcon() {
  return React.createElement('svg', {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    children: [
      React.createElement('polyline', { key: '1', points: '23 4 23 10 17 10' }),
      React.createElement('polyline', { key: '2', points: '1 20 1 14 7 14' }),
      React.createElement('path', { key: '3', d: 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15' }),
    ],
  });
}

/** 「设置封面」图标（画框 + 星标，与「打开相册」的图片图标区分开） */
function CoverIcon({ size = 14 }: { size?: number }) {
  return React.createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    children: [
      React.createElement('rect', { key: '1', x: '3', y: '3', width: '18', height: '18', rx: '2', ry: '2' }),
      React.createElement('circle', { key: '2', cx: '8.5', cy: '8.5', r: '1.5' }),
      React.createElement('polyline', { key: '3', points: '21 15 16 10 5 21' }),
      React.createElement('path', { key: '4', d: 'M18 3.2l1.1 2.2 2.4.35-1.75 1.7.41 2.4L18 8.72l-2.16 1.13.41-2.4-1.75-1.7 2.4-.35z' }),
    ],
  });
}

/**
 * 相册封面选择面板。
 * 顺序按需求固定：第一个格子是「自选图片」（系统文件框任选一张），其后都是相册内
 * 已有图片作为备选；候选超过一页时按页切分，但「自选」在每页都固定占据第一格，
 * 位置始终不变。
 */
function CoverPickerOverlay(props: {
  title: string;
  candidates: string[];
  loading: boolean;
  page: number;
  pageCount: number;
  current?: string;
  onPickFile: () => void;
  onPick: (path: string) => void;
  onReset: () => void;
  onPage: (page: number) => void;
  onClose: () => void;
}) {
  const { title, candidates, loading, page, pageCount, current, onPickFile, onPick, onReset, onPage, onClose } = props;
  // 分页：备选按每页 COVER_PAGE_CANDIDATES 张切分；「自选」永远是当前页的第一格，
  // 位置固定不变（翻页不会把它挤走或挪位）。
  const start = page * COVER_PAGE_CANDIDATES;
  const visible = candidates.slice(start, start + COVER_PAGE_CANDIDATES);
  return React.createElement('div', {
    className: 'fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4',
    onClick: onClose,
  }, React.createElement('div', {
    className: 'w-[min(600px,92vw)] max-h-[78vh] flex flex-col rounded-2xl bg-white dark:bg-stone-800 shadow-2xl border border-black/10 dark:border-white/10 overflow-hidden',
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  },
    React.createElement('div', { key: 'hdr', className: 'flex items-center gap-2 px-4 py-3 border-b border-black/5 dark:border-white/10' },
      React.createElement('span', { key: 't', className: 'text-sm font-semibold text-neutral-700 dark:text-stone-200 flex-1 truncate' },
        `${T('image.sidebar.setCover')} · ${title}`),
      React.createElement('span', { key: 'n', className: 'text-[11px] text-neutral-400 dark:text-stone-500 flex-shrink-0' },
        T('image.sidebar.coverPicker.total', { n: candidates.length })),
      React.createElement('button', {
        key: 'x',
        onClick: onClose,
        className: 'text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-200 text-lg leading-none px-1',
      }, '×'),
    ),
    React.createElement('div', { key: 'body', className: 'flex-1 overflow-y-auto p-3' },
      React.createElement('div', { key: 'grid', className: `grid gap-2`, style: { gridTemplateColumns: `repeat(${COVER_GRID_COLS}, minmax(0, 1fr))` } },
        // ① 自选图片（每页都固定在第一格）
        React.createElement('button', {
          key: '__pick_file__',
          onClick: onPickFile,
          title: T('image.sidebar.coverPicker.pickFile'),
          className: 'aspect-square rounded-xl border-2 border-dashed border-neutral-300 dark:border-stone-600 hover:border-[var(--element-border)] hover:bg-black/5 dark:hover:bg-white/5 flex flex-col items-center justify-center gap-1 text-neutral-500 dark:text-stone-400 transition-colors',
        },
          React.createElement(CoverIcon, { key: 'i', size: 18 }),
          React.createElement('span', { key: 'l', className: 'text-[10px] leading-tight text-center px-1' }, T('image.sidebar.coverPicker.pickFile')),
        ),
        // ② 相册内备选（本页）：走 200px 缩略图缓存 + 全局限并发 4，只生成当前页可见的缩略图
        visible.map((p) => React.createElement('button', {
          key: p,
          onClick: () => onPick(p),
          title: p,
          className: `aspect-square rounded-xl overflow-hidden bg-[var(--element-muted)] border transition-all ${
            p === current
              ? 'border-[var(--element-border)] ring-2 ring-[var(--element-border)]'
              : 'border-black/10 dark:border-white/10 hover:border-[var(--element-border)]'
          }`,
        }, React.createElement(ThumbImg, { key: 'thumb', path: p }))),
      ),
      loading && React.createElement('p', { key: 'loading', className: 'text-xs text-neutral-400 dark:text-stone-500 mt-3 px-1' }, T('image.sidebar.coverPicker.loading')),
      !loading && candidates.length === 0 && React.createElement('p', { key: 'empty', className: 'text-xs text-neutral-400 dark:text-stone-500 mt-3 px-1' }, T('image.sidebar.coverPicker.empty')),
    ),
    React.createElement('div', { key: 'ftr', className: 'px-4 py-2.5 border-t border-black/5 dark:border-white/10 flex items-center gap-3' },
      // 分页控件（只有一页时不显示，避免噪音）
      pageCount > 1 && React.createElement('div', { key: 'pager', className: 'flex items-center gap-1.5 mr-auto' },
        React.createElement('button', {
          key: 'prev',
          disabled: page <= 0,
          onClick: () => onPage(page - 1),
          className: `w-6 h-6 rounded-lg text-sm leading-none ${page <= 0 ? 'text-neutral-300 dark:text-stone-600 cursor-not-allowed' : 'text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/10'}`,
        }, '‹'),
        React.createElement('span', { key: 'info', className: 'text-[11px] text-neutral-500 dark:text-stone-400 tabular-nums px-0.5' },
          T('image.sidebar.coverPicker.page', { i: page + 1, n: pageCount })),
        React.createElement('button', {
          key: 'next',
          disabled: page >= pageCount - 1,
          onClick: () => onPage(page + 1),
          className: `w-6 h-6 rounded-lg text-sm leading-none ${page >= pageCount - 1 ? 'text-neutral-300 dark:text-stone-600 cursor-not-allowed' : 'text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/10'}`,
        }, '›'),
      ),
      current && React.createElement('button', {
        key: 'reset',
        onClick: onReset,
        className: 'text-xs text-neutral-500 dark:text-stone-400 hover:text-red-400 transition-colors ml-auto',
      }, T('image.sidebar.coverPicker.reset')),
    ),
  ));
}

export function ImageSidebar({ folders, customAlbums, loading, selectedFolder, onSelectFolder, onAddRoot, onRescan, onRenameFolder, onDeleteFolder, onDeleteAlbum, albumCovers, onSetCover, onOpenModuleSettings, searchQuery, onSearchChange }: ImageSidebarProps) {
  useLang();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');

  // ===== 相册自选封面 =====
  // 面板数据：第一个格子固定是「自选图片（系统文件框）」，其后是相册内已有图片作为备选。
  const [coverPicker, setCoverPicker] = useState<{
    key: string;
    title: string;
    /** 打开面板时的自选封面（用于高亮当前选中项与判断是否显示「恢复默认」） */
    current?: string;
    source: { kind: 'folder'; folderPath: string } | { kind: 'album'; images: string[] };
  } | null>(null);
  const [coverCandidates, setCoverCandidates] = useState<string[]>([]);
  const [coverLoading, setCoverLoading] = useState(false);
  // 分页：完整候选列表留在内存（只是路径字符串，2000 张也就几百 KB），
  // 每页只渲染 COVER_PAGE_CANDIDATES 张缩略图 → 大文件夹也不会一次拉起上千个缩略图任务。
  const [coverPage, setCoverPage] = useState(0);
  // 序号守卫：面板连续切换相册时，丢弃上一次异步取图的迟到结果（并发场景不串数据）
  const pickerSeq = React.useRef(0);

  const openCoverPicker = (target: NonNullable<typeof coverPicker>) => {
    const seq = ++pickerSeq.current;
    setCoverPicker(target);
    setCoverCandidates([]);
    setCoverPage(0);
    const finish = (list: string[]) => {
      if (seq !== pickerSeq.current) return; // 已切到别的相册，丢弃
      const arr = Array.isArray(list) ? list.filter((p) => typeof p === 'string' && p) : [];
      setCoverCandidates(arr);
      setCoverPage(0);
      setCoverLoading(false);
    };
    if (target.source.kind === 'album') {
      // 自定义相册的图片列表就在内存里，无需再问后端
      setCoverLoading(false);
      finish(target.source.images);
      return;
    }
    setCoverLoading(true);
    hostApi.invoke<string[]>('get_folder_images', { folderPath: target.source.folderPath })
      .then(finish)
      .catch(() => finish([]));
  };

  const closeCoverPicker = () => {
    pickerSeq.current++; // 让在途请求作废
    setCoverPicker(null);
    setCoverCandidates([]);
    setCoverPage(0);
  };

  // 「自选」：走宿主的系统文件框（pick_file），并把所选文件父目录加入 asset scope，
  // 使 convertFileSrc 能直接渲染这张图。
  const pickCoverFromDisk = async () => {
    if (!coverPicker) return;
    try {
      const files = await hostApi.invoke<string[]>('pick_file', {
        filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'avif'] }],
      });
      const picked = files && files[0];
      if (picked) {
        onSetCover?.(coverPicker.key, picked);
        closeCoverPicker();
      }
    } catch {
      // 取消选择 / 对话框异常：保持面板打开，不做任何改动
    }
  };

  /** 取某个文件夹相册当前生效的封面路径（自选优先，否则用扫描出的自动封面） */
  const folderCoverPath = (folder: ImageFolder): string =>
    albumCovers?.[folderCoverKey(folder.folderPath)] || folder.coverImage || '';

  /** 取某个自定义相册当前生效的封面路径（自选优先，否则用相册内第一张） */
  const customAlbumCoverPath = (album: CustomAlbum): string =>
    albumCovers?.[albumCoverKey(album.id)] || album.images[0] || '';

  const startRename = (folder: ImageFolder) => {
    setRenamingId(folder.folderPath);
    setRenameText(folder.folderName);
  };

  const confirmRename = (folder: ImageFolder) => {
    if (renameText.trim() && renameText !== folder.folderName) {
      onRenameFolder?.(folder, renameText.trim());
    }
    setRenamingId(null);
  };

  const renderFolderGridItem = (folder: ImageFolder) => {
    const isSelected = selectedFolder?.folderPath === folder.folderPath;
    const isRenaming = renamingId === folder.folderPath;
    const coverPath = folderCoverPath(folder);
    const coverUrl = coverPath ? hostApi.convertFileSrc(coverPath) : null;
    const hasCustomCover = !!albumCovers?.[folderCoverKey(folder.folderPath)];

    const cardContent = React.createElement('div', {
      className: `group relative rounded-xl overflow-hidden border cursor-pointer transition-all ${
        isSelected
          ? 'border-[var(--element-border)] ring-1 ring-[var(--element-border)]'
          : 'border-white/80 dark:border-stone-700/50 hover:border-[var(--element-border)] hover:shadow-sm'
      }`,
      onClick: isRenaming ? undefined : () => onSelectFolder(folder),
      children: [
        // 封面缩略图
        React.createElement('div', { key: 'cover', className: 'aspect-square bg-[var(--element-muted)]' },
          coverUrl
            ? React.createElement('img', { src: coverUrl, alt: folder.folderName, className: 'w-full h-full object-cover', loading: 'lazy' })
            : React.createElement('div', { className: 'w-full h-full flex items-center justify-center text-[var(--element-bg)]' },
                React.createElement(FolderIcon, { size: 24 })
              )
        ),
        // 悬停「设置封面」：与右键菜单同一入口，保证鼠标用户也能发现
        onSetCover && !isRenaming && React.createElement('button', {
          key: 'set-cover',
          title: T('image.sidebar.setCover'),
          onClick: (e: React.MouseEvent) => {
            e.stopPropagation();
            openCoverPicker({
              key: folderCoverKey(folder.folderPath),
              title: folder.folderName,
              current: albumCovers?.[folderCoverKey(folder.folderPath)],
              source: { kind: 'folder', folderPath: folder.folderPath },
            });
          },
          className: `absolute top-1.5 right-1.5 z-10 w-6 h-6 rounded-lg bg-black/45 hover:bg-black/65 text-white flex items-center justify-center transition-opacity ${hasCustomCover ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`,
        }, React.createElement(CoverIcon, { size: 12 })),
        // 底部信息覆层
        React.createElement('div', { key: 'overlay', className: 'absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-2' },
          isRenaming
            ? React.createElement('input', {
                key: 'title',
                type: 'text',
                className: 'w-full px-1 py-0.5 bg-white/20 border border-white/30 rounded text-white text-xs focus:outline-none focus:ring-1 focus:ring-white/50',
                value: renameText,
                onChange: (e: React.ChangeEvent<HTMLInputElement>) => setRenameText(e.target.value),
                onKeyDown: (e: React.KeyboardEvent) => {
                  if (e.key === 'Enter') confirmRename(folder);
                  if (e.key === 'Escape') setRenamingId(null);
                },
                onBlur: () => confirmRename(folder),
                autoFocus: true,
                onClick: (e: React.MouseEvent) => e.stopPropagation(),
              })
            : React.createElement('div', { key: 'title', className: 'text-white text-xs font-medium truncate' }, folder.folderName),
          React.createElement('div', { key: 'count', className: 'text-white/70 text-[10px]' }, T('image.count', { n: folder.imageCount }))
        ),
      ]
    });

    if (!ContextMenu || !ContextMenuTrigger || !ContextMenuContent) {
      return React.createElement('div', { key: folder.folderPath }, cardContent);
    }

    return React.createElement(ContextMenu, { key: folder.folderPath },
      React.createElement(ContextMenuTrigger, { key: 'trigger', className: 'w-full' }, cardContent),
      React.createElement(ContextMenuContent, { key: 'content' },
        React.createElement(ContextMenuItem, { key: 'open', onClick: () => onSelectFolder(folder) }, T('image.sidebar.openAlbum')),
        React.createElement(ContextMenuSeparator, { key: 'sep1' }),
        onSetCover && React.createElement(ContextMenuItem, {
          key: 'set-cover',
          onClick: () => openCoverPicker({
            key: folderCoverKey(folder.folderPath),
            title: folder.folderName,
            current: albumCovers?.[folderCoverKey(folder.folderPath)],
            source: { kind: 'folder', folderPath: folder.folderPath },
          }),
        }, T('image.sidebar.setCover')),
        React.createElement(ContextMenuItem, { key: 'rename', onClick: () => startRename(folder) }, T('image.sidebar.rename')),
        React.createElement(ContextMenuItem, {
          key: 'remove',
          onClick: () => onDeleteFolder?.(folder),
          variant: 'destructive',
        }, T('image.sidebar.removeFromList')),
        React.createElement(ContextMenuSeparator, { key: 'sep2' }),
        React.createElement(ContextMenuItem, { key: 'rescan', onClick: onRescan }, T('image.sidebar.rescan')),
      )
    );
  };

  const folderListContent = loading
    ? React.createElement('div', { className: 'text-xs text-neutral-400 dark:text-stone-500 px-1 py-2' }, T('image.sidebar.scanning'))
    : folders.length === 0 && customAlbums.length === 0
      ? React.createElement('div', { className: 'text-xs text-neutral-400 dark:text-stone-500 px-1 py-2' }, T('image.sidebar.noFolders'))
      : React.createElement(React.Fragment, null,
          // 自定义相册
          customAlbums.length > 0 && React.createElement('div', { key: 'custom-albums', className: 'mb-2' },
            React.createElement('div', { key: 'hdr', className: 'text-[10px] font-semibold text-neutral-400 dark:text-stone-500 uppercase tracking-wider px-2 py-1' }, T('image.sidebar.customAlbums')),
            customAlbums.map(album => {
              const coverPath = customAlbumCoverPath(album);
              return React.createElement('div', { key: `album-${album.id}`, className: 'group w-full text-left px-3 py-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400 text-sm flex items-center gap-2' },
                // 相册封面（自选优先，否则用相册内第一张）：复用查看器的 200px 缩略图缓存
                coverPath
                  ? React.createElement('div', { key: 'cover', className: 'w-8 h-8 rounded-lg overflow-hidden bg-[var(--element-muted)] flex-shrink-0' },
                      React.createElement(ThumbImg, { path: coverPath }))
                  : React.createElement(FolderIcon, { key: 'icon' }),
                React.createElement('span', { key: 'name', className: 'font-medium truncate flex-1' }, album.name),
                React.createElement('span', { key: 'count', className: 'text-xs text-neutral-400 dark:text-stone-500 group-hover:hidden' }, T('image.count', { n: album.images.length })),
                onSetCover && React.createElement('button', {
                  key: 'set-cover',
                  onClick: (e: React.MouseEvent) => {
                    e.stopPropagation();
                    openCoverPicker({
                      key: albumCoverKey(album.id),
                      title: album.name,
                      current: albumCovers?.[albumCoverKey(album.id)],
                      source: { kind: 'album', images: album.images },
                    });
                  },
                  className: 'hidden group-hover:flex text-neutral-300 dark:text-stone-600 hover:text-[var(--element-bg)] transition-colors',
                  title: T('image.sidebar.setCover'),
                }, React.createElement(CoverIcon, { size: 13 })),
                onDeleteAlbum && React.createElement('button', {
                  key: 'del',
                  onClick: (e: React.MouseEvent) => { e.stopPropagation(); onDeleteAlbum(album.id); },
                  className: 'text-neutral-300 dark:text-stone-600 hover:text-red-400 transition-colors',
                  title: T('image.sidebar.deleteAlbum'),
                }, React.createElement('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', children: [
                  React.createElement('line', { key: 'x1', x1: '18', y1: '6', x2: '6', y2: '18' }),
                  React.createElement('line', { key: 'x2', x1: '6', y1: '6', x2: '18', y2: '18' }),
                ]})),
              );
            })
          ),
          // 扫描到的文件夹 - 双列缩略图网格
          folders.length > 0 && React.createElement(React.Fragment, { key: 'folders' },
            customAlbums.length > 0 && React.createElement('div', { key: 'hdr', className: 'text-[10px] font-semibold text-neutral-400 dark:text-stone-500 uppercase tracking-wider px-2 py-1' }, T('image.sidebar.scanFolders')),
            React.createElement('div', { key: 'grid', className: 'grid grid-cols-2 gap-2' },
              folders.map(renderFolderGridItem)
            )
          ),
        );

  const secondaryActions = [
    {
      icon: React.createElement(RefreshIcon),
      label: T('image.sidebar.rescan'),
      onClick: onRescan,
    },
  ];

  // 封面选择面板：与侧栏同级渲染（fixed 覆盖层），两种布局分支都要挂上
  const coverPageCount = Math.max(1, Math.ceil(coverCandidates.length / COVER_PAGE_CANDIDATES));
  // 候选列表变化后页码可能越界（例如从 5 页的相册切到 1 页的相册），渲染前夹紧
  const coverPageSafe = Math.min(coverPage, coverPageCount - 1);
  const coverOverlay = coverPicker && onSetCover
    ? React.createElement(CoverPickerOverlay, {
        key: 'cover-picker',
        title: coverPicker.title,
        candidates: coverCandidates,
        loading: coverLoading,
        page: coverPageSafe,
        pageCount: coverPageCount,
        current: coverPicker.current,
        onPickFile: pickCoverFromDisk,
        onPick: (p: string) => { onSetCover(coverPicker.key, p); closeCoverPicker(); },
        onReset: () => { onSetCover(coverPicker.key, null); closeCoverPicker(); },
        onPage: (p: number) => setCoverPage(Math.max(0, Math.min(p, coverPageCount - 1))),
        onClose: closeCoverPicker,
      })
    : null;

  if (!ModuleSidebarShell) {
    return (
      <React.Fragment>
        <div className="w-[260px] h-full flex-shrink-0 bg-white/60 dark:bg-stone-800/60 backdrop-blur-md border-r border-white/80 dark:border-stone-700/50 p-4 overflow-y-auto">
          <div className="flex items-center gap-2 mb-4 px-1">
            <ImageIcon />
            <span className="font-bold text-lg text-neutral-800 dark:text-stone-100">{T('image.title')}</span>
          </div>
          <button
            onClick={onAddRoot}
            className="btn-press w-full element-muted hover:element-hover transition-all py-2.5 rounded-xl font-medium mb-4"
          >
            {T('image.addFolder')}
          </button>
          <div className="flex gap-2 mb-3">
            {secondaryActions.map((action, idx) => (
              React.createElement('button', {
                key: idx,
                onClick: action.onClick,
                className: 'btn-press flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg bg-neutral-100 dark:bg-stone-700/50 text-xs text-neutral-600 dark:text-stone-300 hover:bg-neutral-200 dark:hover:bg-stone-700 transition-colors',
              }, action.icon, action.label)
            ))}
          </div>
          <div className="space-y-0.5">
            {folderListContent}
          </div>
        </div>
        {coverOverlay}
      </React.Fragment>
    );
  }

  return React.createElement(React.Fragment, null,
    React.createElement(ModuleSidebarShell, {
      key: 'shell',
      moduleId: 'image',
      icon: React.createElement(ImageIcon),
      title: T('image.title'),
      onOpenModuleSettings,
      searchQuery,
      onSearchChange,
      searchPlaceholder: T('image.sidebar.search'),
      primaryAction: { label: T('image.addFolder'), onClick: onAddRoot },
      secondaryActions,
      children: React.createElement(React.Fragment, null,
        SecondaryNavShell
          ? React.createElement(SecondaryNavShell, null, folderListContent)
          : React.createElement('div', { className: 'flex-1 overflow-y-auto pr-1 space-y-0.5' }, folderListContent)
      ),
    }),
    coverOverlay,
  );
}