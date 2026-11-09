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
import { BrowserPanel } from './BrowserPanel';
import { VideoStatsView } from './VideoStatsView';
import { PlaylistGridRow } from '@shared/OnlineMusicTemplates';

const { useState, useEffect } = React;

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

/** 平台内容体：所有平台统一走「内嵌浏览器」。
 *
 * 2026-11 起不再按平台分派 API 视图：B 站没有面向第三方客户端的官方接口，
 * 抖音/腾讯/爱奇艺更是必须用浏览器。统一成「浏览器」后，
 * 我们只提供浏览容器，内容由平台官方页面自己加载与播放。
 */
function platformBody(platform: VideoPlatform, _onPlayVideo: (item: OnlineVideoItem) => void) {
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
          supported ? '纯 API' : '浏览器窗口',
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

  // 离开整个网络视频视图时，统一关掉本模块的浏览器窗口。
  // 注意**不能**放在单个平台面板的清理里：切换平台也会卸载面板，那样就永远只能开一个平台。
  useEffect(() => {
    return () => {
      const api: any = (window as any).__HOST_API__;
      for (const p of videoPlatforms) {
        void api?.invoke('browser_close', { target: p.id }).catch(() => {});
      }
    };
  }, []);

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
      { className: 'relative flex-1 flex flex-col bg-neutral-50 dark:bg-stone-900 immersive-safe-top' },
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
                '点击任一平台进入：页面在独立浏览器窗口中打开，登录与播放由官方站点完成；可用「嗅探」列出页面已加载的图片/视频，再自行下载。',
              ),
            ),
    ),
  );
}

export default OnlineVideoView;
