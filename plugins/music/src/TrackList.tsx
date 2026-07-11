/// <reference path="../../global.d.ts" />
// 歌曲列表 — 二级导航：详细歌曲列表
const React = window.__HOST_REACT__;
const { useState, useEffect, useCallback } = React;
const hostApi = window.__HOST_API__;
import { musicPlayer } from './musicPlayer';
import { formatTime } from '../../_shared/utils';
import { PlusIcon, SearchIcon, CheckIcon, MoreIcon, MusicIcon } from '../../_shared/icons';

interface Track {
  id: string;
  filePath: string;
  title: string;
  artist: string;
  album: string;
  durationSecs: number;
  coverPath?: string;
}

interface TrackListProps {
  tracks: Track[];
  playlistName: string;
  onSelectTrack: (track: Track, index: number) => void;
  onAddSong: () => void;
  showAlbum?: boolean;
}

export function TrackList({ tracks, playlistName, onSelectTrack, onAddSong, showAlbum = true }: TrackListProps) {
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());

  const currentTrack = musicPlayer.getCurrentTrack();

  const filteredTracks = tracks;

  const handleTrackClick = useCallback((track: Track, index: number, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      setSelectedIndices(prev => {
        const next = new Set(prev);
        if (next.has(index)) {
          next.delete(index);
        } else {
          next.add(index);
        }
        return next;
      });
    } else {
      setSelectedIndices(new Set([index]));
      onSelectTrack(track, index);
    }
  }, [onSelectTrack]);

  const handleCheckbox = useCallback((index: number, e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    setSelectedIndices(prev => {
      const next = new Set(prev);
      if (e.target.checked) {
        next.add(index);
      } else {
        next.delete(index);
      }
      return next;
    });
  }, []);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between p-4 border-b border-neutral-200/30 dark:border-stone-700/30 flex-shrink-0 bg-white/60 dark:bg-stone-800/60 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-neutral-700 dark:text-stone-200">{playlistName}</h2>
          <span className="text-xs text-neutral-400 dark:text-stone-500">{tracks.length} 首</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onAddSong} className="btn-press text-xs text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200 px-2 py-1 rounded-lg transition-colors flex items-center gap-1">
            <PlusIcon />
            添加歌曲
          </button>
          <button className="btn-press text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200 p-1.5 rounded-lg">
            <CheckIcon />
          </button>
          <button className="btn-press text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200 p-1.5 rounded-lg">
            <MoreIcon />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filteredTracks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-neutral-400 dark:text-stone-500">
            <MusicIcon />
            <p className="text-sm">该歌单暂无歌曲</p>
          </div>
        ) : (
          <div className="divide-y divide-neutral-200/20 dark:divide-stone-700/20">
            {filteredTracks.map((track, index) => {
              const isSelected = selectedIndices.has(index);
              const isCurrent = currentTrack?.filePath === track.filePath;
              const coverUrl = track.coverPath ? hostApi.convertFileSrc(track.coverPath) : null;

              return React.createElement('div', {
                key: track.id,
                onClick: (e: React.MouseEvent) => handleTrackClick(track, index, e),
                className: `flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors ${
                  isCurrent
                    ? 'bg-[var(--element-muted)]'
                    : isSelected
                      ? 'bg-black/5 dark:bg-white/5'
                      : 'hover:bg-[var(--element-muted)]'
                }`,
                children: [
                  React.createElement('input', {
                    key: 'checkbox',
                    type: 'checkbox',
                    checked: isSelected,
                    onChange: (e: React.ChangeEvent<HTMLInputElement>) => handleCheckbox(index, e),
                    className: 'w-4 h-4 rounded border-neutral-300 dark:border-stone-600 bg-white dark:bg-stone-700 text-[var(--element-bg)] focus:ring-[var(--element-bg)] cursor-pointer',
                  }),
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
                  showAlbum ? React.createElement('div', {
                    key: 'album',
                    className: 'text-xs text-neutral-400 dark:text-stone-500 truncate max-w-24',
                    children: track.album || '',
                  }) : null,
                  React.createElement('div', {
                    key: 'duration',
                    className: 'text-xs text-neutral-400 dark:text-stone-500 tabular-nums w-12 text-right',
                    children: formatTime(track.durationSecs),
                  }),
                  React.createElement('button', {
                    key: 'more',
                    onClick: (e: React.MouseEvent) => e.stopPropagation(),
                    className: 'btn-press p-1 rounded text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200',
                    children: React.createElement(MoreIcon),
                  }),
                ],
              });
            })}
          </div>
        )}
      </div>
    </div>
  );
}