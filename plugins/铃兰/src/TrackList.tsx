/// <reference path="../../global.d.ts" />
import React from "react";
// 歌曲列表 — 二级导航：详细歌曲列表
const { useState, useEffect, useCallback, useRef } = React;
const hostApi = window.__HOST_API__;
import { musicPlayer } from './musicPlayer';
import { formatTime } from '../../_shared/utils';
import { PlusIcon, CheckIcon, MoreIcon, MusicIcon, HeartIcon, CloudIcon, VideoIcon } from '../../_shared/icons';
import { T, useLang } from '../../_shared/pluginRuntime';

interface Track {
  id: string;
  filePath: string;
  title: string;
  artist: string;
  album: string;
  durationSecs: number;
  coverPath?: string;
  mvPath?: string;
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
  onOpenDrawer?: () => void;
  onMoveTrack?: (track: Track, targetPlaylistId: string) => void;
  onCopyTrack?: (track: Track, targetPlaylistId: string) => void;
  onRemoveTrack?: (track: Track) => void;
  otherPlaylists?: OtherPlaylist[];
  showAlbum?: boolean;
  favoriteIds?: Set<string>;
  onToggleFavorite?: (track: Track) => void;
  onSetCover?: (track: Track) => void;
  onResetCover?: (track: Track) => void;
  onRescanTrack?: (track: Track) => void;
  onEditTrack?: (track: Track, fields: { title?: string; artist?: string; album?: string; trackNumber?: number }) => void;
  // 下载单曲
  onDownloadTrack?: (track: Track) => void;
  // 插入 MV：传入后右键菜单出现「插入 MV」项（用于本地歌曲）。
  onAttachMv?: (track: Track) => void;
  // 播放 MV：track.mvPath 存在时行内显示 MV 图标，点击调用。
  onPlayMv?: (track: Track) => void;
  loadLyricsText?: (track: Track) => Promise<{ text: string; source: string }>;
  saveTrackLyrics?: (track: Track, lyrics: string, saveToLrc: boolean) => Promise<void>;
}

export function TrackList({
  tracks,
  playlistName,
  onSelectTrack,
  onAddSong,
  onOpenDrawer,
  onMoveTrack,
  onCopyTrack,
  onRemoveTrack,
  otherPlaylists = [],
  showAlbum = true,
  favoriteIds,
  onToggleFavorite,
  onSetCover,
  onResetCover,
  onRescanTrack,
  onEditTrack,
  onAttachMv,
  onPlayMv,
  loadLyricsText,
  saveTrackLyrics,
}: TrackListProps) {
  useLang();
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  // 选择模式：开启后每行显示复选框，行点击切换选中而非播放
  const [selectionMode, setSelectionMode] = useState(false);
  // 哪一行的「...」菜单处于打开状态（按行索引）
  const [openMenuIndex, setOpenMenuIndex] = useState<number | null>(null);
  // 「移动到 / 复制到 其他歌单」子菜单当前展开项（move=移动，copy=复制，null=未展开）
  const [activeSubmenu, setActiveSubmenu] = useState<'move' | 'copy' | null>(null);
  // 选择模式下的「批量移动 / 批量复制」目标歌单选择浮层（move=批量移动，copy=批量复制，null=未展开）
  const [batchMenu, setBatchMenu] = useState<'move' | 'copy' | null>(null);
  // 菜单位置（position: fixed 定位，直接渲染在 overflow-y-auto 容器外部）
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  // 保存每个「...」按钮的 ref，用于定位
  const moreBtnRefs = useRef<Map<number, HTMLButtonElement | null>>(new Map());
  const menuRef = useRef<HTMLDivElement | null>(null);

  // 自定义「编辑曲目信息」弹窗状态
  const [editingTrack, setEditingTrack] = useState<Track | null>(null);
  const [editDraft, setEditDraft] = useState<{ title: string; artist: string; album: string; trackNumber: string }>({
    title: '', artist: '', album: '', trackNumber: '',
  });

  // 歌词编辑器弹窗状态
  const [lyricsTrack, setLyricsTrack] = useState<Track | null>(null);
  const [lyricsDraft, setLyricsDraft] = useState('');
  const [lyricsSource, setLyricsSource] = useState('none');
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [lyricsError, setLyricsError] = useState<string | null>(null);

  const currentTrack = musicPlayer.getCurrentTrack();

  // 切换歌单时自动退出选择模式 + 清空选中 + 关闭菜单
  useEffect(() => {
    setSelectionMode(false);
    setSelectedIndices(new Set());
    setOpenMenuIndex(null);
    setActiveSubmenu(null);
      setBatchMenu(null);
    setMenuPos(null);
  }, [playlistName]);

  // 点击外部关闭「...」菜单
  useEffect(() => {
    if (openMenuIndex === null) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current && !menuRef.current.contains(target)) {
        setOpenMenuIndex(null);
        setActiveSubmenu(null);
      setBatchMenu(null);
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
      setActiveSubmenu(null);
      setBatchMenu(null);
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
      setActiveSubmenu(null);
      setBatchMenu(null);
      setMenuPos(null);
      return;
    }
    const btn = moreBtnRefs.current.get(index);
    if (btn) {
      const rect = btn.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setOpenMenuIndex(index);
    setActiveSubmenu(null);
      setBatchMenu(null);
  }, [openMenuIndex]);

  const handleMove = useCallback((track: Track, targetId: string) => {
    onMoveTrack?.(track, targetId);
    setOpenMenuIndex(null);
    setActiveSubmenu(null);
      setBatchMenu(null);
    setMenuPos(null);
  }, [onMoveTrack]);

  const handleCopy = useCallback((track: Track, targetId: string) => {
    onCopyTrack?.(track, targetId);
    setOpenMenuIndex(null);
    setActiveSubmenu(null);
      setBatchMenu(null);
    setMenuPos(null);
  }, [onCopyTrack]);

  // ===== 选择模式批量操作 =====
  // 全选 / 取消全选：已全选则清空，否则选中全部
  const allSelected = tracks.length > 0 && selectedIndices.size === tracks.length;
  const toggleSelectAll = useCallback(() => {
    setSelectedIndices(prev =>
      prev.size === tracks.length ? new Set<number>() : new Set(tracks.map((_, i) => i))
    );
  }, [tracks]);

  // 取出当前选中的 Track 列表（供批量操作遍历）
  const getSelectedTracks = () => tracks.filter((_, i) => selectedIndices.has(i));

  // 批量移除：对每首选中曲调用单条移除，再清空选中
  const handleBatchRemove = useCallback(() => {
    getSelectedTracks().forEach(t => onRemoveTrack?.(t));
    setSelectedIndices(new Set());
    setBatchMenu(null);
  }, [onRemoveTrack, selectedIndices, tracks]);

  // 批量移动：逐首调用单条移动（源歌单移除 + 目标歌单加入）
  const handleBatchMove = useCallback((targetId: string) => {
    getSelectedTracks().forEach(t => onMoveTrack?.(t, targetId));
    setSelectedIndices(new Set());
    setBatchMenu(null);
  }, [onMoveTrack, selectedIndices, tracks]);

  // 批量复制：逐首调用单条复制（仅加入目标歌单，源歌单保留）
  const handleBatchCopy = useCallback((targetId: string) => {
    getSelectedTracks().forEach(t => onCopyTrack?.(t, targetId));
    setSelectedIndices(new Set());
    setBatchMenu(null);
  }, [onCopyTrack, selectedIndices, tracks]);

  const handleRemove = useCallback((track: Track) => {
    onRemoveTrack?.(track);
    setOpenMenuIndex(null);
    setActiveSubmenu(null);
      setBatchMenu(null);
    setMenuPos(null);
  }, [onRemoveTrack]);

  // 切换选择模式：退出时清空选中状态
  const toggleSelectionMode = useCallback(() => {
    setSelectionMode(prev => {
      if (prev) setSelectedIndices(new Set());
      return !prev;
    });
  }, []);

  // 打开自定义「编辑曲目信息」弹窗
  const onEditInfo = (t: Track) => {
    setEditingTrack(t);
    setEditDraft({
      title: t.title || '',
      artist: t.artist || '',
      album: t.album || '',
      trackNumber: '',
    });
  };

  const submitEdit = () => {
    if (!editingTrack) return;
    const tn = editDraft.trackNumber.trim() ? Number(editDraft.trackNumber) : NaN;
    onEditTrack?.(editingTrack, {
      title: editDraft.title.trim() || undefined,
      artist: editDraft.artist.trim() || undefined,
      album: editDraft.album.trim() || undefined,
      trackNumber: Number.isNaN(tn) ? undefined : tn,
    });
    setEditingTrack(null);
  };

  // 打开歌词编辑器：从后端加载原始歌词文本
  const openLyricsEditor = async (t: Track) => {
    if (!loadLyricsText) return;
    setLyricsTrack(t);
    setLyricsDraft('');
    setLyricsSource('none');
    setLyricsError(null);
    setLyricsLoading(true);
    try {
      const res = await loadLyricsText(t);
      setLyricsDraft(res?.text ?? '');
      setLyricsSource(res?.source ?? 'none');
    } catch (e) {
      setLyricsError(String(e));
    } finally {
      setLyricsLoading(false);
    }
  };

  const closeLyricsEditor = () => {
    setLyricsTrack(null);
    setLyricsDraft('');
    setLyricsError(null);
  };

  const submitLyrics = async (saveToLrc: boolean) => {
    if (!lyricsTrack || !saveTrackLyrics) return;
    setLyricsError(null);
    try {
      await saveTrackLyrics(lyricsTrack, lyricsDraft, saveToLrc);
      closeLyricsEditor();
    } catch (e) {
      setLyricsError(String(e));
    }
  };

  // ESC 关闭编辑弹窗
  useEffect(() => {
    if (!editingTrack) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEditingTrack(null);
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitEdit();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editingTrack, editDraft]);

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
        // 子菜单渲染辅助：kind='move' 触发移动，kind='copy' 触发复制（两者互不删除源歌曲的语义不同）
        (() => {
          const renderSubmenuTarget = (kind: 'move' | 'copy') => {
            const label = kind === 'move' ? T('music.track.moveTo') : T('music.track.copyTo');
            if (otherPlaylists.length === 0) {
              return React.createElement('div', {
                key: `${kind}-disabled`,
                className: 'px-3 py-1.5 text-xs text-neutral-400 dark:text-stone-500 cursor-not-allowed',
                children: `${label}${T('music.track.noOthers')}`,
              });
            }
            return React.createElement('div', {
              key: kind,
              className: 'relative',
              onMouseEnter: () => setActiveSubmenu(kind),
              children: [
                React.createElement('button', {
                  onClick: () => setActiveSubmenu(prev => prev === kind ? null : kind),
                  className: 'w-full px-3 py-1.5 text-xs text-left text-neutral-700 dark:text-stone-200 hover:bg-[var(--element-muted)] transition-colors flex items-center justify-between',
                  children: [
                    React.createElement('span', { key: 'label' }, label),
                    React.createElement('span', { key: 'arrow', className: 'text-neutral-400 dark:text-stone-500 ml-2 text-sm leading-none' }, '›'),
                  ],
                }),
                activeSubmenu === kind ? React.createElement('div', {
                  key: 'submenu',
                  // 向左展开（right-full + mr-1）：主菜单贴窗口右缘定位，子菜单再向右会超出窗口被截断，
                  // 故改为在主菜单左侧弹出，落在窗口内不被裁剪。
                  className: 'absolute right-full top-0 mr-1 glass-panel rounded-lg overflow-y-auto min-w-[160px] max-w-[220px] max-h-[240px] py-1 shadow-lg',
                  style: { zIndex: 10000 },
                  children: otherPlaylists.map(p =>
                    React.createElement('button', {
                      key: p.id,
                      onClick: () => (kind === 'move' ? handleMove(track, p.id) : handleCopy(track, p.id)),
                      className: 'w-full px-3 py-1.5 text-xs text-left text-neutral-700 dark:text-stone-200 hover:bg-[var(--element-muted)] transition-colors truncate block',
                      title: p.name,
                    }, p.name)
                  ),
                }) : null,
              ],
            });
          };
          return [
            renderSubmenuTarget('move'),
            renderSubmenuTarget('copy'),
          ];
        })(),
        onSetCover ? React.createElement('button', {
          key: 'setCover',
          onClick: () => { onSetCover(track); setOpenMenuIndex(null); },
          className: 'w-full px-3 py-1.5 text-xs text-left text-neutral-700 dark:text-stone-200 hover:bg-[var(--element-muted)] transition-colors',
          children: T('music.track.setCover'),
        }) : null,
        onResetCover ? React.createElement('button', {
          key: 'resetCover',
          onClick: () => { onResetCover(track); setOpenMenuIndex(null); },
          className: 'w-full px-3 py-1.5 text-xs text-left text-neutral-700 dark:text-stone-200 hover:bg-[var(--element-muted)] transition-colors',
          children: T('music.track.resetCover'),
        }) : null,
        onRescanTrack ? React.createElement('button', {
          key: 'rescan',
          onClick: () => { onRescanTrack(track); setOpenMenuIndex(null); },
          className: 'w-full px-3 py-1.5 text-xs text-left text-neutral-700 dark:text-stone-200 hover:bg-[var(--element-muted)] transition-colors',
          children: T('music.track.rescan'),
        }) : null,
        onEditTrack ? React.createElement('button', {
          key: 'edit',
          onClick: () => { onEditInfo(track); setOpenMenuIndex(null); },
          className: 'w-full px-3 py-1.5 text-xs text-left text-neutral-700 dark:text-stone-200 hover:bg-[var(--element-muted)] transition-colors',
          children: T('music.track.editInfo'),
        }) : null,
        onAttachMv ? React.createElement('button', {
          key: 'attach-mv',
          onClick: () => { onAttachMv(track); setOpenMenuIndex(null); },
          className: 'w-full px-3 py-1.5 text-xs text-left text-neutral-700 dark:text-stone-200 hover:bg-[var(--element-muted)] transition-colors',
          children: '插入 MV',
        }) : null,
        React.createElement('div', {
          key: 'divider',
          className: 'my-1 border-t border-neutral-200/40 dark:border-stone-700/40',
        }),
        React.createElement('button', {
          key: 'remove',
          onClick: () => handleRemove(track),
          className: 'w-full px-3 py-1.5 text-xs text-left text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors',
          children: T('music.track.removeSong'),
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
              ? T('music.track.selected', { sel: selectedIndices.size, total: tracks.length })
              : T('music.track.count', { n: tracks.length })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onAddSong} className="btn-press text-xs text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200 px-2 py-1 rounded-lg transition-colors flex items-center gap-1">
            <PlusIcon />
            {T('music.track.addSong')}
          </button>
          <button
            onClick={toggleSelectionMode}
            className={`btn-press p-1.5 rounded-lg transition-colors ${
              selectionMode
                ? 'text-[var(--element-bg)] bg-[var(--element-muted)]'
                : 'text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200'
            }`}
            title={selectionMode ? T('music.track.exitSelect') : T('music.track.enterSelect')}
          >
            <CheckIcon />
          </button>
          {onOpenDrawer && (
            <button
              onClick={onOpenDrawer}
              className="btn-press p-1.5 rounded-lg transition-colors text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200"
              title={T('music.moduleDrawer.title')}
            >
              <CloudIcon />
            </button>
          )}
        </div>
      </div>

      {/* 选择模式工具条：全选 + 批量操作按钮，常态（非选择模式）下整条隐藏 */}
      {selectionMode && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-neutral-200/30 dark:border-stone-700/30 flex-shrink-0 bg-[var(--element-muted)]/50">
          <button
            onClick={toggleSelectAll}
            className="btn-press text-xs px-2.5 py-1 rounded-lg text-neutral-600 dark:text-stone-300 hover:bg-[var(--element-muted)] transition-colors"
          >
            {allSelected ? T('music.track.unselectAll') : T('music.track.selectAll')}
          </button>
          <div className="relative">
            <button
              onClick={() => setBatchMenu(prev => prev === 'move' ? null : 'move')}
              className={`btn-press text-xs px-2.5 py-1 rounded-lg transition-colors ${
                batchMenu === 'move'
                  ? 'text-[var(--element-bg)] bg-[var(--element-muted)]'
                  : 'text-neutral-600 dark:text-stone-300 hover:bg-[var(--element-muted)]'
              }`}
            >
              {T('music.track.batchMove')} ▾
            </button>
            {batchMenu === 'move' && (
              <div className="absolute left-0 top-full mt-1 z-50 glass-panel rounded-lg overflow-y-auto min-w-[160px] max-w-[220px] max-h-[240px] py-1 shadow-lg">
                {otherPlaylists.length === 0 ? (
                  <div className="px-3 py-1.5 text-xs text-neutral-400 dark:text-stone-500 cursor-not-allowed">{T('music.track.noOthers')}</div>
                ) : (
                  otherPlaylists.map(p => (
                    <button
                      key={p.id}
                      onClick={() => handleBatchMove(p.id)}
                      className="w-full px-3 py-1.5 text-xs text-left text-neutral-700 dark:text-stone-200 hover:bg-[var(--element-muted)] transition-colors truncate block"
                      title={p.name}
                    >
                      {p.name}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          <div className="relative">
            <button
              onClick={() => setBatchMenu(prev => prev === 'copy' ? null : 'copy')}
              className={`btn-press text-xs px-2.5 py-1 rounded-lg transition-colors ${
                batchMenu === 'copy'
                  ? 'text-[var(--element-bg)] bg-[var(--element-muted)]'
                  : 'text-neutral-600 dark:text-stone-300 hover:bg-[var(--element-muted)]'
              }`}
            >
              {T('music.track.batchCopy')} ▾
            </button>
            {batchMenu === 'copy' && (
              <div className="absolute left-0 top-full mt-1 z-50 glass-panel rounded-lg overflow-y-auto min-w-[160px] max-w-[220px] max-h-[240px] py-1 shadow-lg">
                {otherPlaylists.length === 0 ? (
                  <div className="px-3 py-1.5 text-xs text-neutral-400 dark:text-stone-500 cursor-not-allowed">{T('music.track.noOthers')}</div>
                ) : (
                  otherPlaylists.map(p => (
                    <button
                      key={p.id}
                      onClick={() => handleBatchCopy(p.id)}
                      className="w-full px-3 py-1.5 text-xs text-left text-neutral-700 dark:text-stone-200 hover:bg-[var(--element-muted)] transition-colors truncate block"
                      title={p.name}
                    >
                      {p.name}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          <button
            onClick={handleBatchRemove}
            className="btn-press text-xs px-2.5 py-1 rounded-lg text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          >
            {T('music.track.batchRemove')}
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {tracks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-neutral-400 dark:text-stone-500">
            <MusicIcon />
            <p className="text-sm">{T('music.track.empty')}</p>
          </div>
        ) : (
          <div className="divide-y divide-neutral-200/20 dark:divide-stone-700/20">
            {tracks.map((track, index) => {
              const isSelected = selectedIndices.has(index);
              const isCurrent = currentTrack?.filePath === track.filePath;
              const coverIsRemote = !!track.coverPath && /^https?:\/\//i.test(track.coverPath);
              const coverUrl = track.coverPath
                ? (coverIsRemote ? track.coverPath : hostApi.convertFileSrc(track.coverPath))
                : null;
              const isMenuOpen = openMenuIndex === index;

              return React.createElement('div', {
                key: track.id,
                onClick: (e: React.MouseEvent) => handleTrackClick(track, index, e),
                className: `flex items-center gap-3 px-3 py-2 mx-1 cursor-pointer transition-colors rounded-lg relative ${
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
                    }, track.artist || T('music.unknownArtist')),
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
                  // 收藏红心按钮
                  onToggleFavorite
                    ? React.createElement('button', {
                        key: 'fav',
                        onClick: (e: React.MouseEvent) => {
                          e.stopPropagation();
                          onToggleFavorite(track);
                        },
                        className: `btn-press p-1 rounded transition-colors flex-shrink-0 ${
                          favoriteIds?.has(track.id || track.filePath)
                            ? 'text-rose-500'
                            : 'text-neutral-400 dark:text-stone-500 hover:text-rose-400'
                        }`,
                        title: T('music.favoriteToggle'),
                      }, React.createElement(HeartIcon, {
                        size: 16,
                        fill: favoriteIds?.has(track.id || track.filePath) ? 'currentColor' : 'none',
                      }))
                    : null,
                  // MV 播放按钮（本地歌曲已插入 MV）
                  onPlayMv && track.mvPath ? React.createElement('button', {
                    key: 'mv',
                    onClick: (e: React.MouseEvent) => {
                      e.stopPropagation();
                      onPlayMv(track);
                    },
                    className: 'btn-jelly p-1.5 rounded-full flex-shrink-0 text-sky-500 hover:text-sky-600 hover:bg-sky-500/10 transition-colors',
                    title: '播放 MV',
                  }, React.createElement(VideoIcon, { size: 16 })) : null,
                  // 「...」按钮
                  React.createElement('div', {
                    key: 'more',
                    className: 'relative flex-shrink-0',
                  },
                    React.createElement('button', {
                      ref: (el: HTMLButtonElement | null): void => { moreBtnRefs.current.set(index, el); },
                      onClick: (e: React.MouseEvent) => handleMoreClick(index, e),
                      className: `btn-press p-1 rounded transition-colors ${
                        isMenuOpen
                          ? 'text-neutral-700 dark:text-stone-200 bg-[var(--element-muted)]'
                          : 'text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200'
                      }`,
                      title: T('music.track.more'),
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

      {/* 自定义元信息编辑弹窗（替代 window.prompt） */}
      {editingTrack && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30 dark:bg-black/50 backdrop-blur-sm p-4"
          onClick={() => setEditingTrack(null)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-white dark:bg-stone-800 shadow-2xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-neutral-800 dark:text-stone-100 mb-5">
              {T('music.track.editInfo')}
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-neutral-500 dark:text-stone-400 mb-1.5">{T('music.track.editTitle')}</label>
                <input
                  type="text"
                  value={editDraft.title}
                  onChange={(e) => setEditDraft((d) => ({ ...d, title: e.target.value }))}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-neutral-200 dark:border-stone-600 bg-white dark:bg-stone-700 text-neutral-800 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-[var(--element-muted)]"
                  placeholder={T('music.track.editTitle')}
                />
              </div>
              <div>
                <label className="block text-xs text-neutral-500 dark:text-stone-400 mb-1.5">{T('music.track.editArtist')}</label>
                <input
                  type="text"
                  value={editDraft.artist}
                  onChange={(e) => setEditDraft((d) => ({ ...d, artist: e.target.value }))}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-neutral-200 dark:border-stone-600 bg-white dark:bg-stone-700 text-neutral-800 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-[var(--element-muted)]"
                  placeholder={T('music.track.editArtist')}
                />
              </div>
              <div>
                <label className="block text-xs text-neutral-500 dark:text-stone-400 mb-1.5">{T('music.track.editAlbum')}</label>
                <input
                  type="text"
                  value={editDraft.album}
                  onChange={(e) => setEditDraft((d) => ({ ...d, album: e.target.value }))}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-neutral-200 dark:border-stone-600 bg-white dark:bg-stone-700 text-neutral-800 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-[var(--element-muted)]"
                  placeholder={T('music.track.editAlbum')}
                />
              </div>
              <div>
                <label className="block text-xs text-neutral-500 dark:text-stone-400 mb-1.5">{T('music.track.editTrackNo')}</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={editDraft.trackNumber}
                  onChange={(e) => setEditDraft((d) => ({ ...d, trackNumber: e.target.value.replace(/[^0-9]/g, '') }))}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-neutral-200 dark:border-stone-600 bg-white dark:bg-stone-700 text-neutral-800 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-[var(--element-muted)]"
                  placeholder={T('music.track.editTrackNo')}
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs text-neutral-500 dark:text-stone-400">{T('music.track.editLyrics')}</label>
                  <button
                    onClick={() => editingTrack && openLyricsEditor(editingTrack)}
                    className="text-xs px-2 py-1 rounded-md bg-neutral-100 dark:bg-stone-700 text-neutral-700 dark:text-stone-300 hover:bg-neutral-200 dark:hover:bg-stone-600 transition-colors"
                  >
                    {T('music.track.editLyricsBtn')}
                  </button>
                </div>
                <div className="w-full px-3 py-2 text-sm rounded-lg border border-neutral-200 dark:border-stone-600 bg-neutral-50 dark:bg-stone-800 text-neutral-500 dark:text-stone-400 truncate">
                  {T('music.track.editLyricsHint')}
                </div>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setEditingTrack(null)}
                className="px-4 py-2 text-sm rounded-lg text-neutral-600 dark:text-stone-300 hover:bg-neutral-100 dark:hover:bg-stone-700 transition-colors"
              >
                {T('common.cancel')}
              </button>
              <button
                onClick={submitEdit}
                className="px-4 py-2 text-sm rounded-lg bg-[var(--element-muted)] text-[var(--element-bg)] hover:opacity-90 transition-colors"
              >
                {T('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 歌词编辑器弹窗 */}
      {lyricsTrack && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 dark:bg-black/60 backdrop-blur-sm p-4"
          onClick={closeLyricsEditor}
        >
          <div
            className="w-full max-w-3xl h-[80vh] flex flex-col rounded-xl bg-white dark:bg-stone-800 shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-neutral-200 dark:border-stone-700 flex items-center justify-between">
              <h3 className="text-base font-semibold text-neutral-800 dark:text-stone-100">
                {T('music.track.lyricsEditorTitle')} — {lyricsTrack.title}
              </h3>
              <button
                onClick={closeLyricsEditor}
                className="text-xl leading-none text-neutral-400 hover:text-neutral-600 dark:text-stone-500 dark:hover:text-stone-300"
                aria-label={T('common.close')}
              >
                ×
              </button>
            </div>
            <div className="px-5 pb-2 text-xs text-neutral-400 dark:text-stone-500">
              {lyricsSource === 'lrc'
                ? T('music.track.lyricsSourceLrc')
                : lyricsSource === 'embedded'
                  ? T('music.track.lyricsSourceEmbedded')
                  : T('music.track.lyricsSourceNone')}
            </div>

            <div className="flex-1 p-4 overflow-hidden">
              {lyricsLoading ? (
                <div className="h-full flex items-center justify-center text-sm text-neutral-500 dark:text-stone-400">
                  {T('music.track.lyricsLoading')}
                </div>
              ) : (
                <textarea
                  value={lyricsDraft}
                  onChange={(e) => setLyricsDraft(e.target.value)}
                  className="w-full h-full resize-none p-4 text-sm leading-relaxed rounded-lg border border-neutral-200 dark:border-stone-600 bg-white dark:bg-stone-900 text-neutral-800 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-[var(--element-muted)] font-mono"
                  placeholder={T('music.track.lyricsPlaceholder')}
                  spellCheck={false}
                />
              )}
            </div>

            {lyricsError && (
              <div className="px-5 py-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20">
                {lyricsError}
              </div>
            )}

            <div className="px-5 py-4 border-t border-neutral-200 dark:border-stone-700 flex justify-end gap-2">
              <button
                onClick={closeLyricsEditor}
                className="px-4 py-2 text-sm rounded-lg text-neutral-600 dark:text-stone-300 hover:bg-neutral-100 dark:hover:bg-stone-700 transition-colors"
              >
                {T('common.cancel')}
              </button>
              <button
                onClick={() => submitLyrics(false)}
                disabled={lyricsLoading}
                className="px-4 py-2 text-sm rounded-lg bg-neutral-100 dark:bg-stone-700 text-neutral-700 dark:text-stone-200 hover:bg-neutral-200 dark:hover:bg-stone-600 transition-colors disabled:opacity-50"
              >
                {T('music.track.lyricsSaveEmbedded')}
              </button>
              <button
                onClick={() => submitLyrics(true)}
                disabled={lyricsLoading}
                className="px-4 py-2 text-sm rounded-lg bg-[var(--element-muted)] text-[var(--element-bg)] hover:opacity-90 transition-colors disabled:opacity-50"
              >
                {T('music.track.lyricsSaveToLrc')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
