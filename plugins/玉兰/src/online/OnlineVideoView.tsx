/// <reference path="../../../global.d.ts" />
// 网络视频主视图（纯 API 架构）：左侧平台侧栏 + 右侧内容区。
//
// 架构对齐音乐模块「在线音乐」：
//   平台内容全部走 API（TS 端签名/解析 + Rust 代理转发），播放交给我们的 VideoPlayer，
//   下载由 Rust 落地。**不再使用内嵌网页 / OS 浮窗**，因此没有「浮窗盖住嗅探面板 /
//   不跟随主窗移动 / 尺寸不同步」这一整类问题（旧实现见已删除的 VideoWebview /
//   WebviewPlatformView / SnifferPanel）。
import React from 'react';
import { videoPlatforms, type VideoPlatform, type OnlineVideoItem } from './videoPlatforms';
import { OnlineVideoSidebar, type VideoTempEntry } from './OnlineVideoSidebar';
import { BilibiliView } from './BilibiliView';
import { BrowserPanel } from './BrowserPanel';
import { VideoStatsView } from './VideoStatsView';
import { PlaylistGridRow } from '@shared/OnlineMusicTemplates';

const { useState } = React;

interface Props {
  initialPlatformId?: string | null;
  /** 带上平台 id：宿主用它把播放项登记进「临时播放列表」 */
  onPlayVideo: (platformId: string, item: OnlineVideoItem) => void;
  onExit: () => void;
  onOpenModuleSettings?: () => void;
  temps: VideoTempEntry[];
  activeTempId?: string | null;
  onSelectTemp: (entry: VideoTempEntry) => void;
}

/** 平台内容体：按平台 id 分派到对应视图 */
function platformBody(platform: VideoPlatform, onPlayVideo: (item: OnlineVideoItem) => void) {
  if (platform.id === 'bilibili') return React.createElement(BilibiliView, { onPlayVideo });
  // 抖音 / 腾讯视频 / 爱奇艺：页面链接受 DRM 或签名保护，纯 API 取不到流，
  // 因此把面板区当作浏览器用（内嵌子 webview），视频就在其网页里播放，
  // 再通过「嗅探」列出页面加载的图片/视频资源供下载。
  return React.createElement(BrowserPanel, { platform });
}

function PlatformBody({ platform, onPlayVideo }: { platform: VideoPlatform; onPlayVideo: (item: OnlineVideoItem) => void }) {
  const supported = platform.mode === 'api';
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      'div',
      { className: 'shrink-0 flex items-center gap-3 px-4 py-3 border-b border-neutral-200/60 dark:border-stone-700/60 bg-white/70 dark:bg-stone-800/70 backdrop-blur' },
      React.createElement(
        'div',
        { className: 'min-w-0' },
        React.createElement('p', { className: 'text-base font-semibold truncate', style: { color: platform.accent } }, platform.name),
        React.createElement('p', { className: 'text-xs text-neutral-400 dark:text-stone-500 truncate' }, platform.desc),
      ),
      React.createElement(
        'div',
        { className: 'flex items-center gap-2 ml-auto shrink-0' },
        React.createElement(
          'span',
          { className: 'text-[11px] px-2 py-0.5 rounded-full', style: { color: platform.accent, background: `${platform.accent}1a` } },
          supported ? '纯 API' : '内嵌浏览器',
        ),
        ...(platform.capabilities || []).map((c) =>
          React.createElement(
            'span',
            { key: c, className: 'text-[11px] px-2 py-0.5 rounded-full bg-neutral-100 dark:bg-stone-700 text-neutral-500 dark:text-stone-400' },
            c,
          ),
        ),
      ),
    ),
    platformBody(platform, onPlayVideo),
  );
}

export function OnlineVideoView({
  initialPlatformId,
  onPlayVideo,
  onExit,
  onOpenModuleSettings,
  temps,
  activeTempId,
  onSelectTemp,
}: Props) {
  const [activeId, setActiveId] = useState<string | null>(initialPlatformId ?? null);
  const [showStats, setShowStats] = useState(false);
  const platform = videoPlatforms.find((p) => p.id === activeId) || null;
  // 平台内视图只知道「播了什么」，平台 id 由这里补上再交给宿主
  const playWithPlatform = (item: OnlineVideoItem) => onPlayVideo(activeId || '', item);

  return React.createElement(
    'div',
    { className: 'absolute inset-0 flex' },
    React.createElement(OnlineVideoSidebar, {
      activeId,
      onSelect: (id: string) => {
        setActiveId(id);
        setShowStats(false);
      },
      onExit,
      onOpenModuleSettings,
      onOpenStats: () => setShowStats((v) => !v),
      statsActive: showStats,
      temps,
      activeTempId,
      onSelectTemp,
    }),
    React.createElement(
      'div',
      { className: 'relative flex-1 flex flex-col bg-neutral-50 dark:bg-stone-900' },
      showStats
        ? React.createElement(VideoStatsView, null)
        : platform
          ? React.createElement(PlatformBody, { key: platform.id, platform, onPlayVideo: playWithPlatform })
          : React.createElement(
              'div',
              { className: 'flex-1 flex flex-col items-center justify-center gap-6 p-10' },
              React.createElement(PlaylistGridRow, {
                items: videoPlatforms.map((p) => ({
                  id: p.id,
                  name: p.name,
                  coverUrl: undefined,
                  subtitle: p.desc,
                  accent: p.accent,
                })),
                accent: '#3b82f6',
                onOpen: (id: string | number) => setActiveId(String(id)),
              }),
              React.createElement(
                'p',
                { className: 'text-xs text-neutral-400 dark:text-stone-500 max-w-md text-center' },
                '点击任一平台进入。标「纯 API」的平台可浏览推荐/分区、搜索并去广告播放；标「内嵌浏览器」的平台受 DRM 或签名限制，视频在其网页内播放，可用「嗅探」下载页面加载的图片/视频。',
              ),
            ),
    ),
  );
}

export default OnlineVideoView;
