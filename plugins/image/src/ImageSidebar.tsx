/// <reference path="../../global.d.ts" />
const React = window.__HOST_REACT__;
const { useState } = React;
const hostApi = window.__HOST_API__;
const { ModuleSidebarShell, SecondaryNavShell, ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } = window.__HOST_UI__ || {};

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

export function ImageSidebar({ folders, customAlbums, loading, selectedFolder, onSelectFolder, onAddRoot, onRescan, onRenameFolder, onDeleteFolder, onCreateAlbum, onDeleteAlbum, onImportImages: _onImportImages, onOpenModuleSettings, searchQuery, onSearchChange }: ImageSidebarProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [showNewAlbumInput, setShowNewAlbumInput] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState('');

  const handleImportImages = () => {
    hostApi.invoke<string[]>('pick_file', { filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] })
      .then((files) => {
        if (files && files.length > 0) {
          console.log('[Image] 导入图片:', files);
        }
      })
      .catch(() => {});
  };

  const handleCreateAlbum = () => {
    if (!newAlbumName.trim()) return;
    onCreateAlbum?.(newAlbumName.trim());
    setNewAlbumName('');
    setShowNewAlbumInput(false);
  };

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
    const coverUrl = folder.coverImage ? hostApi.convertFileSrc(folder.coverImage) : null;

    const cardContent = React.createElement('div', {
      className: `group relative rounded-xl overflow-hidden border cursor-pointer transition-all ${
        isSelected
          ? 'border-[var(--element-border)] ring-1 ring-[var(--element-border)]'
          : 'border-white/80 dark:border-stone-700/50 hover:border-[var(--element-border)] hover:shadow-sm'
      }`,
      onClick: isRenaming ? undefined : () => onSelectFolder(folder),
      children: [
        // 封面缩略图
        React.createElement('div', { className: 'aspect-square bg-[var(--element-muted)]' },
          coverUrl
            ? React.createElement('img', { src: coverUrl, alt: folder.folderName, className: 'w-full h-full object-cover', loading: 'lazy' })
            : React.createElement('div', { className: 'w-full h-full flex items-center justify-center text-[var(--element-bg)]' },
                React.createElement(FolderIcon, { size: 24 })
              )
        ),
        // 底部信息覆层
        React.createElement('div', { className: 'absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-2' },
          isRenaming
            ? React.createElement('input', {
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
            : React.createElement('div', { className: 'text-white text-xs font-medium truncate' }, folder.folderName),
          React.createElement('div', { className: 'text-white/70 text-[10px]' }, `${folder.imageCount} 张`)
        ),
      ]
    });

    if (!ContextMenu || !ContextMenuTrigger || !ContextMenuContent) {
      return React.createElement('div', { key: folder.folderPath }, cardContent);
    }

    return React.createElement(ContextMenu, { key: folder.folderPath },
      React.createElement(ContextMenuTrigger, null, cardContent),
      React.createElement(ContextMenuContent, null,
        React.createElement(ContextMenuItem, { onClick: () => onSelectFolder(folder) }, '打开相册'),
        React.createElement(ContextMenuSeparator),
        React.createElement(ContextMenuItem, { onClick: () => startRename(folder) }, '重命名'),
        React.createElement(ContextMenuItem, {
          onClick: () => onDeleteFolder?.(folder),
          variant: 'destructive',
        }, '从列表移除'),
        React.createElement(ContextMenuSeparator),
        React.createElement(ContextMenuItem, { onClick: onRescan }, '重新扫描'),
      )
    );
  };

  const folderListContent = loading
    ? React.createElement('div', { className: 'text-xs text-neutral-400 dark:text-stone-500 px-1 py-2' }, '扫描中...')
    : folders.length === 0 && customAlbums.length === 0
      ? React.createElement('div', { className: 'text-xs text-neutral-400 dark:text-stone-500 px-1 py-2' }, '暂无文件夹')
      : React.createElement(React.Fragment, null,
          // 自定义相册
          customAlbums.length > 0 && React.createElement('div', { className: 'mb-2' },
            React.createElement('div', { className: 'text-[10px] font-semibold text-neutral-400 dark:text-stone-500 uppercase tracking-wider px-2 py-1' }, '自定义相册'),
            customAlbums.map(album => {
              return React.createElement('div', { key: `album-${album.id}`, className: 'w-full text-left px-3 py-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400 text-sm flex items-center gap-2' },
                React.createElement(FolderIcon),
                React.createElement('span', { className: 'font-medium truncate flex-1' }, album.name),
                React.createElement('span', { className: 'text-xs text-neutral-400 dark:text-stone-500' }, `${album.images.length} 张`),
                onDeleteAlbum && React.createElement('button', {
                  onClick: (e: React.MouseEvent) => { e.stopPropagation(); onDeleteAlbum(album.id); },
                  className: 'text-neutral-300 dark:text-stone-600 hover:text-red-400 transition-colors',
                  title: '删除相册',
                }, React.createElement('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', children: [
                  React.createElement('line', { key: 'x1', x1: '18', y1: '6', x2: '6', y2: '18' }),
                  React.createElement('line', { key: 'x2', x1: '6', y1: '6', x2: '18', y2: '18' }),
                ]})),
              );
            })
          ),
          // 扫描到的文件夹 - 双列缩略图网格
          folders.length > 0 && React.createElement(React.Fragment, null,
            customAlbums.length > 0 && React.createElement('div', { className: 'text-[10px] font-semibold text-neutral-400 dark:text-stone-500 uppercase tracking-wider px-2 py-1' }, '扫描文件夹'),
            React.createElement('div', { className: 'grid grid-cols-2 gap-2' },
              folders.map(renderFolderGridItem)
            )
          ),
        );

  const secondaryActions = [
    {
      icon: React.createElement(RefreshIcon),
      label: '重新扫描',
      onClick: onRescan,
    },
    {
      icon: React.createElement('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        children: [
          React.createElement('path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }),
          React.createElement('polyline', { points: '7 10 12 15 17 10' }),
          React.createElement('line', { x1: '12', y1: '15', x2: '12', y2: '3' }),
        ],
      }),
      label: '新建相册',
      onClick: () => setShowNewAlbumInput(true),
    },
    {
      icon: React.createElement('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        children: [
          React.createElement('path', { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' }),
          React.createElement('polyline', { points: '15 2 15 8 21 8' }),
          React.createElement('line', { x1: '12', y1: '13', x2: '12', y2: '17' }),
          React.createElement('line', { x1: '8', y1: '13', x2: '8', y2: '17' }),
          React.createElement('line', { x1: '16', y1: '13', x2: '16', y2: '17' }),
        ],
      }),
      label: '导入图片',
      onClick: handleImportImages,
    },
    {
      icon: React.createElement('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        children: [
          React.createElement('circle', { cx: '12', cy: '12', r: '3' }),
          React.createElement('path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z' }),
        ],
      }),
      label: '管理文件夹',
      onClick: onOpenModuleSettings,
    },
  ];

  if (!ModuleSidebarShell) {
    return (
      <div className="w-[260px] h-full flex-shrink-0 bg-white/60 dark:bg-stone-800/60 backdrop-blur-md border-r border-white/80 dark:border-stone-700/50 p-4 overflow-y-auto">
        <div className="flex items-center gap-2 mb-4 px-1">
          <ImageIcon />
          <span className="font-bold text-lg text-neutral-800 dark:text-stone-100">图片</span>
        </div>
        <button
          onClick={onAddRoot}
          className="btn-press w-full element-muted hover:element-hover transition-all py-2.5 rounded-xl font-medium mb-4"
        >
          + 添加文件夹
        </button>
        {showNewAlbumInput && (
          <div className="mb-3">
            <input
              type="text"
              className="w-full px-3 py-2 bg-white/50 dark:bg-stone-700/50 border border-white/80 dark:border-stone-600/50 rounded-xl text-sm text-neutral-700 dark:text-stone-200 focus:outline-none focus:ring-1 focus:ring-[var(--element-border)]"
              placeholder="相册名称"
              value={newAlbumName}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewAlbumName(e.target.value)}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === 'Enter') handleCreateAlbum();
                if (e.key === 'Escape') setShowNewAlbumInput(false);
              }}
              autoFocus
            />
          </div>
        )}
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
    );
  }

  return React.createElement(ModuleSidebarShell, {
    moduleId: 'image',
    icon: React.createElement(ImageIcon),
    title: '莲花',
    onOpenModuleSettings,
    searchQuery,
    onSearchChange,
    searchPlaceholder: '搜索文件夹...',
    primaryAction: { label: '+ 添加文件夹', onClick: onAddRoot },
    secondaryActions,
    children: React.createElement(React.Fragment, null,
      showNewAlbumInput && React.createElement('div', { className: 'mb-4' },
        React.createElement('input', {
          type: 'text',
          className: 'w-full px-3 py-2 bg-white/50 dark:bg-stone-700/50 border border-white/80 dark:border-stone-600/50 rounded-xl text-sm text-neutral-700 dark:text-stone-200 focus:outline-none focus:ring-1 focus:ring-[var(--element-border)]',
          placeholder: '相册名称',
          value: newAlbumName,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setNewAlbumName(e.target.value),
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === 'Enter') handleCreateAlbum();
            if (e.key === 'Escape') setShowNewAlbumInput(false);
          },
          autoFocus: true,
        })
      ),
      SecondaryNavShell
        ? React.createElement(SecondaryNavShell, null, folderListContent)
        : React.createElement('div', { className: 'flex-1 overflow-y-auto pr-1 space-y-0.5' }, folderListContent)
    ),
  });
}