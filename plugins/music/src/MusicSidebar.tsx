/// <reference path="../../global.d.ts" />
// 音乐侧边栏 — 一级导航：歌单列表
const React = window.__HOST_REACT__;
const { useState, useCallback } = React;
const { ModuleSidebarShell, SecondaryNavShell, ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } = window.__HOST_UI__ || {};

interface Track {
  id: string;
  filePath: string;
  title: string;
  artist: string;
  album: string;
  durationSecs: number;
  coverPath?: string;
}

interface Playlist {
  id: string;
  name: string;
  tracks: Track[];
  type: 'directory' | 'custom';
}

interface MusicSidebarProps {
  playlists: Playlist[];
  selectedPlaylistId: string | null;
  onSelectPlaylist: (playlist: Playlist) => void;
  onSelectFolder: () => void;
  onCreatePlaylist?: (name: string) => void;
  onRenamePlaylist?: (playlist: Playlist, newName: string) => void;
  onDeletePlaylist?: (playlist: Playlist) => void;
  onOpenModuleSettings?: () => void;
  searchQuery?: string;
  onSearchChange?: (value: string) => void;
}

function Music2Icon() {
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
      React.createElement('path', { key: '1', d: 'M9 18V5l12-2v13' }),
      React.createElement('circle', { key: '2', cx: '6', cy: '18', r: '3' }),
      React.createElement('circle', { key: '3', cx: '18', cy: '16', r: '3' }),
    ],
  });
}

function PlusIcon() {
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
      React.createElement('line', { key: '1', x1: '12', y1: '5', x2: '12', y2: '19' }),
      React.createElement('line', { key: '2', x1: '5', y1: '12', x2: '19', y2: '12' }),
    ],
  });
}

export function MusicSidebar({ playlists, selectedPlaylistId, onSelectPlaylist, onSelectFolder, onCreatePlaylist, onRenamePlaylist, onDeletePlaylist, onOpenModuleSettings, searchQuery, onSearchChange }: MusicSidebarProps) {
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [showNewInput, setShowNewInput] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');

  const handleCreatePlaylist = useCallback(() => {
    const name = newPlaylistName.trim();
    if (!name) return;
    onCreatePlaylist?.(name);
    setNewPlaylistName('');
    setShowNewInput(false);
  }, [newPlaylistName, onCreatePlaylist]);

  const startRename = (playlist: Playlist) => {
    setRenamingId(playlist.id);
    setRenameText(playlist.name);
  };

  const confirmRename = (playlist: Playlist) => {
    if (renameText.trim() && renameText !== playlist.name) {
      onRenamePlaylist?.(playlist, renameText.trim());
    }
    setRenamingId(null);
  };

  const renderPlaylistItem = (playlist: Playlist) => {
    const isSelected = selectedPlaylistId === playlist.id;
    const isRenaming = renamingId === playlist.id;
    const count = playlist.tracks.length;

    const buttonContent = isRenaming
      ? React.createElement('input', {
          type: 'text',
          className: 'w-full px-2 py-1 bg-white/50 dark:bg-stone-700/50 border border-white/80 dark:border-stone-600/50 rounded-lg text-sm text-neutral-700 dark:text-stone-200 focus:outline-none focus:ring-1 focus:ring-[var(--element-border)]',
          value: renameText,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setRenameText(e.target.value),
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === 'Enter') confirmRename(playlist);
            if (e.key === 'Escape') setRenamingId(null);
          },
          onBlur: () => confirmRename(playlist),
          autoFocus: true,
          onClick: (e: React.MouseEvent) => e.stopPropagation(),
        })
      : React.createElement('button', {
          onClick: () => onSelectPlaylist(playlist),
          className: `w-full text-left px-3 py-2 rounded-xl transition-colors text-sm ${
            isSelected
              ? 'bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100'
              : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400'
          }`,
          children: [
            React.createElement('div', { key: `name-${playlist.id}`, className: 'font-medium truncate' }, playlist.name),
            React.createElement('div', { key: `count-${playlist.id}`, className: 'text-xs text-neutral-400 dark:text-stone-500 truncate mt-0.5' }, `${count} 首`),
          ],
        });

    if (!ContextMenu || !ContextMenuTrigger || !ContextMenuContent) {
      return React.createElement('div', { key: playlist.id }, buttonContent);
    }

    return React.createElement(ContextMenu, { key: playlist.id },
      React.createElement(ContextMenuTrigger, { className: 'w-full' },
        buttonContent
      ),
      React.createElement(ContextMenuContent, null,
        React.createElement(ContextMenuItem, { onClick: () => onSelectPlaylist(playlist) }, '播放歌单'),
        React.createElement(ContextMenuSeparator),
        React.createElement(ContextMenuItem, { onClick: () => startRename(playlist) }, '重命名'),
        playlist.type === 'custom' ? React.createElement(ContextMenuItem, {
          onClick: () => onDeletePlaylist?.(playlist),
          variant: 'destructive',
        }, '删除歌单') : null,
      )
    );
  };

  const playlistItems = React.createElement(React.Fragment, null,
    playlists.map(renderPlaylistItem)
  );

  const actionItems = React.createElement(React.Fragment, null,
    React.createElement('div', { className: 'border-t border-neutral-200/30 dark:border-stone-700/30 mt-3 pt-3 space-y-1' },
      React.createElement('button', {
        key: 'add-playlist',
        onClick: () => setShowNewInput(true),
        className: 'w-full text-left px-3 py-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-300 text-sm flex items-center gap-2',
        children: [
          React.createElement(PlusIcon),
          React.createElement('span', null, '+ 添加歌单'),
        ],
      }),
    )
  );

  if (!ModuleSidebarShell) {
    return (
      <div className="w-[260px] h-full flex-shrink-0 bg-white/60 dark:bg-stone-800/60 backdrop-blur-md border-r border-white/80 dark:border-stone-700/50 p-4 overflow-y-auto">
        <div className="flex items-center gap-2 mb-4 px-1">
          <Music2Icon />
          <span className="font-bold text-lg text-neutral-800 dark:text-stone-100">音乐</span>
        </div>
        <div className="space-y-0.5">
          {playlistItems}
        </div>
        {actionItems}
      </div>
    );
  }

  return React.createElement(ModuleSidebarShell, {
    moduleId: 'music',
    icon: React.createElement(Music2Icon),
    title: '铃兰',
    onOpenModuleSettings,
    searchQuery,
    onSearchChange,
    searchPlaceholder: '搜索歌单...',
    primaryAction: { label: '+ 添加文件夹', onClick: onSelectFolder },
    children: React.createElement(React.Fragment, null,
      showNewInput && React.createElement('div', { className: 'mb-4' },
        React.createElement('input', {
          type: 'text',
          className: 'w-full px-3 py-2 bg-white/50 dark:bg-stone-700/50 border border-white/80 dark:border-stone-600/50 rounded-xl text-sm text-neutral-700 dark:text-stone-200 focus:outline-none focus:ring-1 focus:ring-[var(--element-border)]',
          placeholder: '歌单名称',
          value: newPlaylistName,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setNewPlaylistName(e.target.value),
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === 'Enter') handleCreatePlaylist();
            if (e.key === 'Escape') setShowNewInput(false);
          },
          autoFocus: true,
        })
      ),
      SecondaryNavShell
        ? React.createElement(SecondaryNavShell, null,
            playlistItems,
            actionItems
          )
        : React.createElement('div', { className: 'flex-1 overflow-y-auto pr-1 space-y-3' },
            playlistItems,
            actionItems
          )
    ),
  });
}