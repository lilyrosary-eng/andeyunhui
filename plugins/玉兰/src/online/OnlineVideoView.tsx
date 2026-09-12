/// <reference path="../../global.d.ts" />
// 视频模块 · 网络视频主视图
// 左侧平台侧栏 + 右侧内容区。内容区无选中平台时显示平台卡片网格；选中后渲染对应平台视图。
// 原生平台（哔哩哔哩）播放走我们的播放器（onPlayVideo 把 VideoFile 交回 VideoModule）。
import React from 'react';
import { OnlineVideoSidebar } from './OnlineVideoSidebar';
import { VIDEO_PLATFORMS, getVideoPlatform, type OnlineVideoItem } from './videoPlatforms';
import { CloudIcon, BackIcon } from './onlineIcons';
import { WebviewPlatformView } from './WebviewPlatformView';
import { BilibiliView } from './BilibiliView';
import { DouyinView } from './DouyinView';

const { useState } = React;

interface Props {
  initialPlatformId: string | null;
  /** 把原生播放地址交回主播放器（复用 VideoPlayer + SMTC） */
  onPlayVideo: (item: OnlineVideoItem) => void;
  onExit: () => void;
}

export function OnlineVideoView({ initialPlatformId, onPlayVideo, onExit }: Props) {
  const [activeId, setActiveId] = useState<string | null>(initialPlatformId);

  const active = activeId ? getVideoPlatform(activeId) : undefined;

  const renderMain = () => {
    if (!active) {
      // 平台卡片网格
      return React.createElement('div', { className: 'h-full overflow-y-auto p-6' },
        React.createElement('h2', { className: 'text-lg font-semibold text-neutral-800 dark:text-stone-100 mb-1' }, '网络视频'),
        React.createElement('p', { className: 'text-sm text-neutral-400 dark:text-stone-500 mb-6' }, '选择平台开始观看 · 原生平台可去广告播放并下载'),
        React.createElement('div', { className: 'grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4' },
          VIDEO_PLATFORMS.map((p) => React.createElement('button', {
            key: p.id,
            onClick: () => setActiveId(p.id),
            className: 'group flex flex-col gap-3 rounded-2xl border border-neutral-200/70 dark:border-stone-700/60 p-5 text-left transition-all hover:shadow-md hover:-translate-y-0.5',
          },
            React.createElement('div', { className: 'flex h-12 w-12 items-center justify-center rounded-xl text-white text-lg font-bold', style: { background: p.accent } }, p.name.slice(0, 1)),
            React.createElement('div', {},
              React.createElement('p', { className: 'text-base font-semibold text-neutral-800 dark:text-stone-100' }, p.name),
              React.createElement('p', { className: 'text-xs mt-1 text-neutral-400 dark:text-stone-500' }, p.desc),
            ),
          )),
        ),
      );
    }

    // 平台内容区头部（返回网格）
    const header = React.createElement('div', { className: 'shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-neutral-200/60 dark:border-stone-700/60' },
      React.createElement('button', {
        onClick: () => setActiveId(null),
        className: 'btn-press p-1.5 rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-stone-700 transition-colors',
        title: '返回平台列表',
      }, React.createElement(BackIcon, { size: 16 })),
      React.createElement(CloudIcon, { size: 16, style: { color: active.accent } }),
      React.createElement('span', { className: 'text-sm font-medium', style: { color: active.accent } }, active.name),
    );

    let body: React.ReactNode;
    if (active.id === 'bilibili') {
      body = React.createElement(BilibiliView, { onPlayVideo });
    } else if (active.id === 'douyin') {
      body = React.createElement(DouyinView, { onPlayVideo });
    } else {
      body = React.createElement(WebviewPlatformView, { platform: active });
    }

    return React.createElement('div', { className: 'absolute inset-0 flex flex-col' }, header, React.createElement('div', { className: 'relative flex-1' }, body));
  };

  return React.createElement('div', { className: 'relative flex h-full w-full overflow-hidden' },
    React.createElement(OnlineVideoSidebar, { activeId, onSelect: setActiveId, onExit }),
    React.createElement('div', { className: 'relative flex-1 h-full bg-[#f5f5f0] dark:bg-[#1c1917]' }, renderMain()),
  );
}

export default OnlineVideoView;
