// 「译/音」三态切换按钮（可复用模板）
// 供「漫游页播放栏」(RoamView)、“沉浸式播放页播放栏”(NowPlayingView) 等需要就近看到歌词的视图复用。
// 三态循环：关闭 → 译（翻译）→ 音（罗马音音译）→ 关闭；高亮+标签跟随全局 lyricModeStore，自动保持同步。
import React from 'react';
import { useState, useCallback, useEffect } from 'react';
import { lyricModeStore, type LyricMode } from './lyricsSync';

const { IconButton: SharedIconButton } = window.__HOST_UI__ || {};

// 降级：如果共享 IconButton 不可用，使用本地实现（与 PlayerBar 保持一致）
const IconButton = SharedIconButton || function IconButton({
  onClick, title, active, children,
}: {
  onClick: () => void; title: string; active?: boolean; children: React.ReactNode;
}) {
  return React.createElement('button', {
    onClick, title,
    className: 'btn-press p-1.5 rounded-full transition-all duration-150',
    style: {
      color: active ? 'var(--element-bg)' : undefined,
      background: 'transparent',
    },
    onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => {
      (e.currentTarget as HTMLButtonElement).style.background = 'var(--element-muted)';
    },
    onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => {
      (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
    },
  }, children);
};

export default function LyricModeButton() {
  const [lyricMode, setLyricMode] = useState<LyricMode>(() => lyricModeStore.get());

  useEffect(() => {
    return lyricModeStore.subscribe(setLyricMode);
  }, []);

  const onClick = useCallback(() => {
    lyricModeStore.cycle();
  }, []);

  return React.createElement(IconButton, {
    onClick,
    title: lyricMode === 'romaji'
      ? '歌词：音译（罗马音）'
      : lyricMode === 'translate'
        ? '歌词：翻译'
        : '歌词：翻译/音译',
    active: lyricMode !== 'off',
    children: React.createElement('span', {
      style: { fontSize: 10, fontWeight: 600, lineHeight: 1 },
    }, lyricMode === 'romaji' ? '音' : '译'),
  });
}