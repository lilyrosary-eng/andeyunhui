/// <reference path="../../global.d.ts" />
// 网络视频主视图：左侧平台侧栏 + 右侧内容区。
// 对齐音乐模块「在线音乐」路由：选中平台后覆盖整个主内容区。
// 原生引擎开关：每平台独立、存设置（useNativeEngine），关 → 降级为网页播放（WebviewPlatformView）。
import React from 'react';
import { videoPlatforms, type VideoPlatform } from './videoPlatforms';
import { OnlineVideoSidebar } from './OnlineVideoSidebar';
import { BilibiliView } from './BilibiliView';
import { DouyinView } from './DouyinView';
import { WebviewPlatformView } from './WebviewPlatformView';
import type { OnlineVideoItem } from './videoPlatforms';
import { useNativeEngine } from './useNativeEngine';

const { useState } = React;

interface Props {
  initialPlatformId?: string | null;
  onPlayVideo: (item: OnlineVideoItem) => void;
  onExit: () => void;
}

function platformBody(platform: VideoPlatform, nativeOn: boolean, onPlayVideo: (item: OnlineVideoItem) => void) {
  if (platform.id === 'bilibili') {
    return nativeOn ? React.createElement(BilibiliView, { onPlayVideo }) : React.createElement(WebviewPlatformView, { platform });
  }
  if (platform.id === 'douyin') {
    return nativeOn ? React.createElement(DouyinView, { onPlayVideo }) : React.createElement(WebviewPlatformView, { platform });
  }
  // 腾讯/爱奇艺：原生取流受限，恒为网页播放
  return React.createElement(WebviewPlatformView, { platform });
}

function PlatformBody({ platform, onPlayVideo }: { platform: VideoPlatform; onPlayVideo: (item: OnlineVideoItem) => void }) {
  // key={platform.id} 保证切换平台时重新初始化
  const [nativeOn, setNativeOn] = useNativeEngine(platform.id, platform.nativeEngineDefault ?? false);
  const nativeSupported = platform.id === 'bilibili' || platform.id === 'douyin';
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      'div',
      { className: 'shrink-0 flex items-center gap-3 px-4 py-3 border-b border-neutral-200/60 dark:border-stone-700/60 bg-white/70 dark:bg-stone-800/70 backdrop-blur' },
      React.createElement('div', { className: 'min-w-0' },
        React.createElement('p', { className: 'text-base font-semibold truncate', style: { color: platform.accent } }, platform.name),
        React.createElement('p', { className: 'text-xs text-neutral-400 dark:text-stone-500 truncate' }, platform.desc),
      ),
      React.createElement('div', { className: 'flex items-center gap-2 ml-auto' },
        nativeSupported
          ? React.createElement('label', { className: 'flex items-center gap-2 text-xs text-neutral-500 dark:text-stone-400 cursor-pointer select-none' },
              React.createElement('span', null, '原生视频引擎'),
              React.createElement('input', { type: 'checkbox', checked: nativeOn, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setNativeOn(e.target.checked), className: 'accent-sky-500 w-4 h-4' }),
            )
          : React.createElement('span', { className: 'text-xs text-neutral-400 dark:text-stone-500' }, '原生引擎：暂不支持（DRM 限制，仅网页播放）'),
      ),
    ),
    platformBody(platform, nativeOn, onPlayVideo),
  );
}

export function OnlineVideoView({ initialPlatformId, onPlayVideo, onExit }: Props) {
  const [activeId, setActiveId] = useState<string | null>(initialPlatformId ?? null);
  const platform = videoPlatforms.find((p) => p.id === activeId) || null;

  return React.createElement('div', { className: 'absolute inset-0 flex' },
    React.createElement(OnlineVideoSidebar, { activeId, onSelect: setActiveId, onExit }),
    React.createElement('div', { className: 'relative flex-1 flex flex-col bg-neutral-50 dark:bg-stone-900' },
      platform
        ? React.createElement(PlatformBody, { key: platform.id, platform, onPlayVideo })
        : React.createElement('div', { className: 'flex-1 flex flex-col items-center justify-center gap-6 p-10' },
            React.createElement('div', { className: 'grid grid-cols-2 gap-4' },
              videoPlatforms.map((p) =>
                React.createElement('button', {
                  key: p.id,
                  onClick: () => setActiveId(p.id),
                  className: 'btn-press group relative w-52 h-32 rounded-2xl flex flex-col items-center justify-center gap-2 text-white shadow-lg overflow-hidden',
                  style: { background: `linear-gradient(135deg, ${p.accent}, ${p.accent}cc)` },
                },
                  React.createElement('span', { className: 'text-lg font-semibold drop-shadow' }, p.name),
                  React.createElement('span', { className: 'text-xs opacity-90 px-3 text-center' }, p.desc),
                ),
              ),
            ),
            React.createElement('p', { className: 'text-xs text-neutral-400 dark:text-stone-500 max-w-md text-center' }, '点击任一平台进入（默认以官方网页播放器打开；可在上方开关启用「原生视频引擎」以获得去广告播放与嗅探下载能力）'),
          ),
    ),
  );
}

export default OnlineVideoView;
