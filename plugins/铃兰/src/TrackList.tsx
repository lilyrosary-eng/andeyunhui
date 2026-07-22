/// <reference path="../../global.d.ts" />
// 歌曲列表 — 二级导航：详细歌曲列表
const React = window.__HOST_REACT__;
const { useState, useEffect, useCallback, useRef } = React;
const hostApi = window.__HOST_API__;
import { musicPlayer } from './musicPlayer';
import { formatTime } from '../../_shared/utils';
import { PlusIcon, CheckIcon, MoreIcon, MusicIcon } from '../../_shared/icons';

interface Track {
  id: string;
  filePath: string;
  title: string;
  artist: string;
  album: string;
  durationSecs: number;
  coverPath?: string;
}

interface OtherPlaylist {
  id: string;
  name: string;
}

interface TrackListProps {
  tracks: Track[];
  playlistName: string;
  onSelectTrack: (track: Track, index: number) => void;
  onAddSong: () => void;
  onMoveTrack?: (track: Track, targetPlaylistId: string) => void;
  onRemoveTrack?: (track: Track) => void;
  otherPlaylists?: OtherPlaylist[];
  showAlbum?: boolean;
}

export function TrackList({
  tracks,
  playlistName,
  onSelectTrack,
  onAddSong,
  onMoveTrack,
  onRemoveTrack,
  otherPlaylists = [],
  showAlbum = true,
}: TrackListProps) {
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  // 选择模式：开启后每行显示复选框，行点击切换选中而非播放
  const [selectionMode, setSelectionMode] = useState(false);
  // 哪一行的「...」菜单处于打开状态（按行索引）
  const [openMenuIndex, setOpenMenuIndex] = useState<number | null>(null);
  // 「移动到其他歌单」子菜单是否展开
  const [openSubmenu, setOpenSubmenu] = useState(false);
  // 菜单位置（position: fixed 定位，直接渲染在 overflow-y-auto 容器外部）
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  // 保存每个「...」按钮的 ref，用于定位
  const moreBtnRefs = useRef<Map<number, HTMLButtonElement | null>>(new Map());
  const menuRef = useRef<HTMLDivElement | null>(null);

  const currentTrack = musicPlayer.getCurrentTrack();

  // 切换歌单时自动退出选择模式 + 清空选中 + 关闭菜单
  useEffect(() => {
    setSelectionMode(false);
    setSelectedIndices(new Set());
    setOpenMenuIndex(null);
    setOpenSubmenu(false);
    setMenuPos(null);
  }, [playlistName]);

  // 点击外部关闭「...」菜单
  useEffect(() => {
    if (openMenuIndex === null) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current && !menuRef.current.contains(target)) {
        setOpenMenuIndex(null);
        setOpenSubmenu(false);
        setMenuPos(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [openMenuIndex]);

  // 滚动/窗口大小变化时关闭菜单（fixed 定位需要重新计算）
  useEffect(() => {
    if (openMenuIndex === null) return;
    const close = () => {
      setOpenMenuIndex(null);
      setOpenSubmenu(false);
      setMenuPos(null);
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [openMenuIndex]);

  const handleTrackClick = useCallback((track: Track, index: number, e: React.MouseEvent) => {
    if (selectionMode) {
      // 选择模式下：点击行只切换选中状态，不触发播放
      setSelectedIndices(prev => {
        const next = new Set(prev);
        if (next.has(index)) next.delete(index); else next.add(index);
        return next;
      });
    } else if (e.ctrlKey || e.metaKey) {
      // 普通模式：Ctrl/Cmd+点击 = 多选（保留原有快捷键）
      setSelectedIndices(prev => {
        const next = new Set(prev);
        if (next.has(index)) next.delete(index); else next.add(index);
        return next;
      });
    } else {
      setSelectedIndices(new Set([index]));
      onSelectTrack(track, index);
    }
  }, [onSelectTrack, selectionMode]);

  const handleCheckbox = useCallback((index: number, e: React.ChangeEvent<HTMLInputElement> | React.MouseEvent) => {
    e.stopPropagation();
    setSelectedIndices(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  }, []);

  const handleMoreClick = useCallback((index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (openMenuIndex === index) {
      setOpenMenuIndex(null);
      setOpenSubmenu(false);
      setMenuPos(null);
      return;
    }
    const btn = moreBtnRefs.current.get(index);
    if (btn) {
      const rect = btn.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setOpenMenuIndex(index);
    setOpenSubmenu(false);
  }, [openMenuIndex]);

  const handleMove = useCallback((track: Track, targetId: string) => {
    onMoveTrack?.(track, targetId);
    setOpenMenuIndex(null);
    setOpenSubmenu(false);
    setMenuPos(null);
  }, [onMoveTrack]);

  const handleRemove = useCallback((track: Track) => {
    onRemoveTrack?.(track);
    setOpenMenuIndex(null);
    setOpenSubmenu(false);
    setMenuPos(null);
  }, [onRemoveTrack]);

  // 切换选择模式：退出时清空选中状态
  const toggleSelectionMode = useCallback(() => {
    setSelectionMode(prev => {
      if (prev) setSelectedIndices(new Set());
      return !prev;
    });
  }, []);

  // ========== 渲染：下拉菜单（position: fixed 直接渲染在 overflow-y-auto 外部）==========
  const renderMenuContent = (track: Track) => {
    return React.createElement('div', {
      ref: menuRef,
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
      style: {
        position: 'fixed',
        top: menuPos!.top,
        right: menuPos!.right,
        zIndex: 9999,
      },
      className: 'glass-panel rounded-lg overflow-visible min-w-[180px] py-1 shadow-lg',
      children: [
        otherPlaylists.length > 0
          ? React.createElement('div', {
              key: 'move',
              className: 'relative',
              onMouseEnter: () => setOpenSubmenu(true),
              children: [
                React.createElement('button', {
                  onClick: () => setOpenSubmenu(prev => !prev),
                  className: 'w-full px-3 py-1.5 text-xs text-left text-neutral-700 dark:text-stone-200 hover:bg-[var(--element-muted)] transition-colors flex items-center justify-between',
                  children: [
                    React.createElement('span', { key: 'label' }, '移动到其他歌单'),
                    React.createElement('span', { key: 'arrow', className: 'text-neutral-400 dark:text-stone-500 ml-2 text-sm leading-none' }, '›'),
                  ],
                }),
                openSubmenu ? React.createElement('div', {
                  key: 'submenu',
                  // 向左展开（right-full + mr-1）：主菜单贴窗口右缘定位，子菜单再向右会超出窗口被截断，
                  // 故改为在主菜单左侧弹出，落在窗口内不被裁剪。
                  className: 'absolute right-full top-0 mr-1 glass-panel rounded-lg overflow-y-auto min-w-[160px] max-w-[220px] max-h-[240px] py-1 shadow-lg',
                  style: { zIndex: 10000 },
                  children: otherPlaylists.map(p =>
                    React.createElement('button', {
                      key: p.id,
                      onClick: () => handleMove(track, p.id),
                      className: 'w-full px-3 py-1.5 text-xs text-left text-neutral-700 dark:text-stone-200 hover:bg-[var(--element-muted)] transition-colors truncate block',
                      title: p.name,
                    }, p.name)
                  ),
                }) : null,
              ],
            })
          : React.createElement('div', {
              key: 'move-disabled',
              className: 'px-3 py-1.5 text-xs text-neutral-400 dark:text-stone-500 cursor-not-allowed',
              children: '移动到其他歌单（无其他歌单）',
            }),
        React.createElement('div', {
          key: 'divider',
          className: 'my-1 border-t border-neutral-200/40 dark:border-stone-700/40',
        }),
        React.createElement('button', {
          key: 'remove',
          onClick: () => handleRemove(track),
          className: 'w-full px-3 py-1.5 text-xs text-left text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors',
          children: '移除歌曲',
        }),
      ],
    });
  };

  // 当前打开的菜单对应的 track（供 JSX 末尾渲染使用）
  const openTrack = openMenuIndex !== null ? tracks[openMenuIndex] : null;

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between p-4 border-b border-neutral-200/30 dark:border-stone-700/30 flex-shrink-0 bg-white/60 dark:bg-stone-800/60 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-neutral-700 dark:text-stone-200">{playlistName}</h2>
          <span className="text-xs text-neutral-400 dark:text-stone-500">
            {selectionMode && selectedIndices.size > 0
              ? `已选 ${selectedIndices.size} / ${tracks.length} 首`
              : `${tracks.length} 首`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onAddSong} className="btn-press text-xs text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200 px-2 py-1 rounded-lg transition-colors flex items-center gap-1">
            <PlusIcon />
            添加歌曲
          </button>
          <button
            onClick={toggleSelectionMode}
            className={`btn-press p-1.5 rounded-lg transition-colors ${
              selectionMode
                ? 'text-[var(--element-bg)] bg-[var(--element-muted)]'
                : 'text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200'
            }`}
            title={selectionMode ? '退出选择模式' : '进入选择模式'}
          >
            <CheckIcon />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tracks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-neutral-400 dark:text-stone-500">
            <MusicIcon />
            <p className="text-sm">该歌单暂无歌曲</p>
          </div>
        ) : (
          <div className="divide-y divide-neutral-200/20 dark:divide-stone-700/20">
            {tracks.map((track, index) => {
              const isSelected = selectedIndices.has(index);
              const isCurrent = currentTrack?.filePath === track.filePath;
              const coverUrl = track.coverPath ? hostApi.convertFileSrc(track.coverPath) : null;
              const isMenuOpen = openMenuIndex === index;

              return React.createElement('div', {
                key: track.id,
                onClick: (e: React.MouseEvent) => handleTrackClick(track, index, e),
                className: `flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors relative ${
                  isCurrent
                    ? 'bg-[var(--element-muted)]'
                    : isSelected
                      ? 'bg-black/5 dark:bg-white/5'
                      : 'hover:bg-[var(--element-muted)]'
                }`,
                children: [
                  // 复选框：仅在选择模式下显示
                  selectionMode
                    ? React.createElement('input', {
                        key: 'checkbox',
                        type: 'checkbox',
                        checked: isSelected,
                        onChange: (e: React.ChangeEvent<HTMLInputElement>) => handleCheckbox(index, e),
                        onClick: (e: React.MouseEvent) => e.stopPropagation(),
                        className: 'w-4 h-4 rounded border-neutral-300 dark:border-stone-600 bg-white dark:bg-stone-700 text-[var(--element-bg)] focus:ring-[var(--element-bg)] cursor-pointer flex-shrink-0',
                      })
                    : null,
                  coverUrl ? (
                    React.createElement('div', {
                      key: 'cover',
                      className: 'w-8 h-8 rounded bg-neutral-100 dark:bg-stone-700 overflow-hidden flex-shrink-0',
                      style: { width: '32px', height: '32px' },
                      children: React.createElement('img', {
                        src: coverUrl,
                        alt: '',
                        className: 'w-full h-full object-cover',
                        style: { width: '100%', height: '100%', objectFit: 'cover' },
                      }),
                    })
                  ) : (
                    React.createElement('div', {
                      key: 'cover',
                      className: 'w-8 h-8 rounded bg-[var(--element-muted)] flex items-center justify-center flex-shrink-0',
                      children: React.createElement(MusicIcon),
                    })
                  ),
                  // 标题 + 歌手：flex-1 自动占满剩余空间
                  // 歌手名 truncate 仅在不超出容器宽度时省略，与专辑列规则一致
                  React.createElement('div', {
                    key: 'info',
                    className: 'flex-1 min-w-0',
                  },
                    React.createElement('div', {
                      key: 'title',
                      className: `text-sm truncate ${
                        isCurrent ? 'font-medium text-neutral-800 dark:text-stone-100' : 'text-neutral-700 dark:text-stone-300'
                      }`,
                    }, track.title),
                    React.createElement('div', {
                      key: 'artist',
                      className: 'text-xs text-neutral-400 dark:text-stone-500 truncate',
                    }, track.artist || '未知歌手'),
                  ),
                  // 专辑列：放宽到 100~180px，未超出时完整显示，超出时省略
                  showAlbum ? React.createElement('div', {
                    key: 'album',
                    className: 'text-xs text-neutral-400 dark:text-stone-500 truncate min-w-[100px] max-w-[180px] flex-shrink-0',
                    title: track.album || '',
                    children: track.album || '',
                  }) : null,
                  React.createElement('div', {
                    key: 'duration',
                    className: 'text-xs text-neutral-400 dark:text-stone-500 tabular-nums w-12 text-right flex-shrink-0',
                    children: formatTime(track.durationSecs),
                  }),
                  // 「...」按钮
                  React.createElement('div', {
                    key: 'more',
                    className: 'relative flex-shrink-0',
                  },
                    React.createElement('button', {
                      ref: (el: HTMLButtonElement | null) => { moreBtnRefs.current.set(index, el); },
                      onClick: (e: React.MouseEvent) => handleMoreClick(index, e),
                      className: `btn-press p-1 rounded transition-colors ${
                        isMenuOpen
                          ? 'text-neutral-700 dark:text-stone-200 bg-[var(--element-muted)]'
                          : 'text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200'
                      }`,
                      title: '更多操作',
                    }, React.createElement(MoreIcon)),
                  ),
                ],
              });
            })}
          </div>
        )}
      </div>
      {/* 下拉菜单：放在 overflow-y-auto 外部，用 position:fixed 避免被裁剪 */}
      {openTrack && menuPos ? renderMenuContent(openTrack) : null}
    </div>
  );
}
