// 通用歌曲行组件
//
// 设计原则：
//   - 纯展示组件，不含业务逻辑
//   - 所有交互通过 props 回调传入，由各端自己处理
//   - Badge（VIP/无损/Hi-Res）由调用方预计算后传入
//   - 保留紧凑模式（隐藏专辑列）
//
// 使用示例：
//   <TrackRow
//     track={playableTrack}
//     index={i}
//     isPlaying={playingId === track.id}
//     isLiked={favoriteIds?.has(track.id)}
//     badges={[{ label: 'VIP', kind: 'vip' }]}
//     onPlay={() => handlePlay(track)}
//     onLike={(e) => handleLike(e, track)}
//     onOpenArtist={(e) => openArtistDrawer(track.artistId)}
//     onOpenAlbum={(e) => openAlbumDrawer(track.albumId)}
//   />

import React from 'react';
import { PlayIcon, HeartIcon, VideoIcon, DownloadIcon } from 'lucide-react';
import { MusicIcon } from '../../../_shared/icons';

// ============ 类型定义 ============

export interface PlayableTrack {
  id: string;
  filePath: string;
  title: string;
  artist: string;
  album: string;
  durationSecs: number;
  coverPath?: string;
  quality?: string;
  artistId?: number | string;
  albumId?: number | string;
  mvId?: number | string;
}

export interface TrackBadge {
  label: string;
  kind: 'vip' | 'lossless' | 'hires';
}

export interface TrackRowExtras {
  /** 歌手 ID，用于跳转歌手详情 */
  artistId?: string | number;
  /** 专辑 ID，用于跳转专辑详情 */
  albumId?: string | number;
  /** MV ID/hash */
  mvId?: string | number;
  /** 音质标签 */
  badges?: TrackBadge[];
}

export interface TrackRowProps {
  track: PlayableTrack & TrackRowExtras;
  index: number;
  /** 是否正在播放 */
  isPlaying?: boolean;
  /** 当前播放索引（用于显示序号） */
  playIndex?: number;
  /** 是否已收藏 */
  isLiked?: boolean;
  /** 点击歌曲区域 */
  onPlay?: () => void;
  /** 点击播放按钮（防止冒泡） */
  onPlayClick?: (e: React.MouseEvent) => void;
  /** 点击红心 */
  onLike?: (e: React.MouseEvent) => void;
  /** 点击下载 */
  onDownload?: (e: React.MouseEvent) => void;
  /** 点击 MV */
  onPlayMv?: (e: React.MouseEvent) => void;
  /** 点击歌手名 */
  onOpenArtist?: (e: React.MouseEvent) => void;
  /** 点击专辑名 */
  onOpenAlbum?: (e: React.MouseEvent) => void;
  /** 紧凑模式（隐藏专辑列） */
  compact?: boolean;
  /** 品牌色 */
  accentColor?: string;
}

// ============ 工具函数 ============

function formatDuration(sec: number): string {
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getCoverUrl(track: PlayableTrack): string | null {
  if (!track.coverPath) return null;
  // 网络图片直接返回
  if (/^https?:\/\//i.test(track.coverPath)) return track.coverPath;
  // 本地文件需要通过宿主转换
  const host = (window as any).__HOST_API__;
  if (host?.convertFileSrc) {
    return host.convertFileSrc(track.coverPath);
  }
  return track.coverPath;
}

// ============ 组件 ============

export const TrackRow: React.FC<TrackRowProps> = ({
  track,
  index,
  isPlaying = false,
  playIndex,
  isLiked = false,
  onPlay,
  onPlayClick,
  onLike,
  onDownload,
  onPlayMv,
  onOpenArtist,
  onOpenAlbum,
  compact = false,
  accentColor = '#f44336',
}) => {
  const coverUrl = getCoverUrl(track);
  const isPlayingThis = isPlaying || playIndex === index;

  // 防止点击按钮时触发播放
  const stopPropagation = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('[data-action]')) return;
        onPlay?.();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPlay?.();
        }
      }}
      className="group flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-neutral-200/50 dark:hover:bg-stone-800/50 active:bg-neutral-300/50 dark:active:bg-stone-700/50 transition-colors text-left cursor-pointer"
    >
      {/* 封面 */}
      <div className="w-10 h-10 rounded-md overflow-hidden bg-neutral-200/60 dark:bg-stone-700/60 flex items-center justify-center shrink-0">
        {coverUrl ? (
          <img src={coverUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <MusicIcon size={16} className="text-neutral-400 dark:text-stone-500" />
        )}
      </div>

      {/* 信息区 */}
      <div className="flex-1 min-w-0">
        {/* 歌名 + Badge */}
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-medium text-sm text-neutral-800 dark:text-stone-100 truncate">
            {track.title}
          </span>
          {track.badges?.map((b) => (
            <span
              key={b.label}
              className={
                'shrink-0 text-[9px] font-semibold leading-none px-1 py-0.5 rounded ' +
                (b.kind === 'vip'
                  ? 'text-amber-600 dark:text-amber-400 bg-amber-500/15'
                  : b.kind === 'hires'
                    ? 'text-fuchsia-600 dark:text-fuchsia-400 bg-fuchsia-500/15'
                    : 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/15')
              }
              title={b.label}
            >
              {b.label}
            </span>
          ))}
        </div>

        {/* 歌手 · 专辑 */}
        <div className="text-xs text-neutral-500 dark:text-stone-400 truncate">
          {track.artist ? (
            onOpenArtist ? (
              <button
                data-action="artist"
                onClick={stopPropagation}
                onMouseDown={onOpenArtist}
                className="hover:text-emerald-500 dark:hover:text-emerald-400 hover:underline cursor-pointer"
              >
                {track.artist}
              </button>
            ) : (
              <span>{track.artist}</span>
            )
          ) : null}
          {!compact && track.artist && track.album ? (
            <span className="opacity-50 mx-1">·</span>
          ) : null}
          {track.album ? (
            onOpenAlbum ? (
              <button
                data-action="album"
                onClick={stopPropagation}
                onMouseDown={onOpenAlbum}
                className="hover:text-emerald-500 dark:hover:text-emerald-400 hover:underline cursor-pointer"
              >
                {track.album}
              </button>
            ) : (
              <span>{track.album}</span>
            )
          ) : null}
        </div>
      </div>

      {/* 时长 */}
      <span className="text-xs text-neutral-400 dark:text-stone-500 shrink-0">
        {formatDuration(track.durationSecs)}
      </span>

      {/* 播放中指示器 */}
      {isPlayingThis && (
        <PlayIcon size={14} className="text-blue-500 shrink-0" />
      )}

      {/* MV 按钮 */}
      {track.mvId && onPlayMv && (
        <button
          data-action="mv"
          onClick={(e) => {
            stopPropagation(e);
            onPlayMv(e);
          }}
          className="btn-jelly p-1.5 rounded-full text-neutral-400 dark:text-stone-500 hover:text-sky-500 dark:hover:text-sky-400 hover:bg-sky-500/10 transition-colors shrink-0"
          title="播放 MV（跳转到玉兰）"
        >
          <VideoIcon size={15} />
        </button>
      )}

      {/* 下载按钮 */}
      {onDownload && (
        <button
          data-action="download"
          onClick={(e) => {
            stopPropagation(e);
            onDownload(e);
          }}
          className="btn-jelly p-1.5 rounded-full text-neutral-400 dark:text-stone-500 hover:text-emerald-500 dark:hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors shrink-0"
          title="下载"
        >
          <DownloadIcon size={15} />
        </button>
      )}

      {/* 红心按钮 */}
      {onLike && (
        <button
          data-action="like"
          onClick={(e) => {
            stopPropagation(e);
            onLike(e);
          }}
          className="btn-jelly p-1.5 rounded-full text-neutral-400 dark:text-stone-500 hover:text-rose-500 dark:hover:text-rose-400 hover:bg-rose-500/10 transition-colors shrink-0"
          title={isLiked ? '取消收藏' : '收藏'}
        >
          <HeartIcon
            size={15}
            fill={isLiked ? 'currentColor' : 'none'}
            className={isLiked ? 'text-rose-500 dark:text-rose-400' : ''}
          />
        </button>
      )}

      {/* 播放按钮（单独点击区域） */}
      {onPlay && (
        <button
          data-action="play"
          onClick={(e) => {
            stopPropagation(e);
            onPlayClick?.(e);
            onPlay();
          }}
          disabled={isPlayingThis}
          className="btn-press w-8 h-8 rounded-full bg-neutral-100/70 dark:bg-stone-800/60 text-neutral-600 dark:text-stone-300 flex items-center justify-center disabled:opacity-40 shrink-0"
          title="播放"
        >
          {isPlayingThis ? (
            <PlayIcon size={14} className="text-blue-500" />
          ) : (
            <PlayIcon size={14} />
          )}
        </button>
      )}
    </div>
  );
};

export default TrackRow;
