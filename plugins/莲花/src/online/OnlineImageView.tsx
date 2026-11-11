/// <reference path="../../../global.d.ts" />
// 网络图片主视图：左侧平台列表（对齐视频模块的在线视图）+ 右侧官方网页壳。
//
// 形态与「网络视频」完全同构，便于三处（视频 / 笔记 / 图片）保持一套心智模型：
// 侧栏换成源列表 → 主区显示对应内容。
import React from 'react';
import { getImagePlatforms, toImagePlatform, type ImagePlatform } from './imagePlatforms';
import { useNetworkSites } from '@shared/useNetworkSites';
import { OnlineSidebarShell } from '@shared/OnlineSidebarShell';
import { WebBrowserShell } from '@shared/WebBrowserShell';
import { CloudTitleButton, OnlineCloudSwitch } from '@shared/OnlineCloudSwitch';

const { useState, useEffect } = React;

interface Props {
  /** 初始平台（默认第一个；保留参数便于以后加源） */
  initialPlatformId?: string | null;
  onExit: () => void;
  onOpenModuleSettings?: () => void;
}

function ImageIcon() {
  return React.createElement('svg', {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    children: [
      React.createElement('rect', { key: '1', x: '3', y: '3', width: '18', height: '18', rx: '2', ry: '2' }),
      React.createElement('circle', { key: '2', cx: '8.5', cy: '8.5', r: '1.5' }),
      React.createElement('polyline', { key: '3', points: '21 15 16 10 5 21' }),
    ],
  });
}

export function OnlineImageView({ initialPlatformId, onExit, onOpenModuleSettings }: Props) {
  // 实时订阅共享注册表（设置里增删站点后立即刷新）
  const platforms = useNetworkSites('image').map(toImagePlatform);
  const [activeId, setActiveId] = useState<string | null>(
    initialPlatformId ?? platforms[0]?.id ?? null,
  );
  // 从抽屉再选另一个平台时（本视图已挂载），要跟着切，而不是停留在第一次的平台
  useEffect(() => {
    if (initialPlatformId) setActiveId(initialPlatformId);
  }, [initialPlatformId]);
  // 「云」抽屉：在线视图里也能直接切平台/回本地，不必先点 logo 返回
  const [cloudOpen, setCloudOpen] = useState(false);
  const platform = platforms.find((p) => p.id === activeId) ?? null;

  // 离开网络视图时只关本模块的浏览器窗口（不能 close_all，否则会连带关掉视频的）
  useEffect(() => {
    return () => {
      const api: any = (window as any).__HOST_API__;
      for (const p of getImagePlatforms()) {
        void api?.invoke('browser_close', { target: p.id }).catch(() => {});
      }
    };
  }, []);

  const platformList = React.createElement(
    'div',
    { className: 'space-y-1' },
    React.createElement(
      'div',
      { className: 'flex items-center gap-1.5 px-1 text-[11px] text-neutral-400 dark:text-stone-500' },
      React.createElement('span', null, `共 ${platforms.length} 个平台`),
      React.createElement('span', { className: 'opacity-40' }, '·'),
      React.createElement('span', null, '官方页面 · 浏览器窗口'),
    ),
    platforms.map((p: ImagePlatform) => {
      const isActive = activeId === p.id;
      return React.createElement(
        'button',
        {
          key: p.id,
          onClick: () => setActiveId(p.id),
          className: `w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
            isActive ? 'bg-black/5 dark:bg-white/10' : 'hover:bg-black/[0.03] dark:hover:bg-white/5'
          }`,
        },
        React.createElement(
          'div',
          {
            className: 'flex h-9 w-9 items-center justify-center rounded-lg shrink-0 text-white text-xs font-bold',
            style: { background: p.accent },
          },
          p.name.slice(0, 2),
        ),
        React.createElement(
          'div',
          { className: 'flex-1 min-w-0' },
          React.createElement(
            'div',
            { className: 'flex items-center gap-1.5' },
            React.createElement(
              'span',
              { className: 'text-sm font-medium text-neutral-800 dark:text-stone-100 truncate' },
              p.name,
            ),
            React.createElement(
              'span',
              {
                className: 'text-[10px] px-1 rounded shrink-0 text-neutral-400 dark:text-stone-500',
              },
              '浏览器窗口',
            ),
          ),
          React.createElement(
            'p',
            { className: 'text-xs text-neutral-400 dark:text-stone-500 truncate' },
            p.desc,
          ),
        ),
      );
    }),
    React.createElement(
      'p',
      { className: 'px-2 pt-3 text-[11px] leading-relaxed text-neutral-400 dark:text-stone-500' },
      '只打开官方页面：登录与浏览都在站点自己完成，我们不抓取内容、不批量下载。',
    ),
  );

  // 标题只做展示：模块切换统一走标题栏右侧「云」按钮（抽屉里有「本地图库」项）
  const titleEl = React.createElement(
    'div',
    {
      className: 'font-bold text-lg text-neutral-800 dark:text-stone-100 flex items-center gap-2',
    },
    '网络图片',
  );

  return React.createElement(
    'div',
    { className: 'absolute inset-0 flex' },
    React.createElement(OnlineSidebarShell, {
      icon: React.createElement(ImageIcon),
      title: titleEl,
      moduleId: 'image',
      onClose: onExit,
      onOpenModuleSettings,
      titleActions: React.createElement(CloudTitleButton, {
        open: cloudOpen,
        onClick: () => setCloudOpen((v) => !v),
      }),
      children: platformList,
    }),
    React.createElement(
      'div',
      {
        className:
          'relative flex-1 flex flex-col bg-[#f5f5f0] dark:bg-[#1c1917] immersive-safe-top',
      },
      platform
        ? React.createElement(WebBrowserShell, {
            key: platform.id,
            platform: {
              id: platform.id,
              name: platform.name,
              home: platform.home,
              accent: platform.accent,
              note: platform.note,
              needsProxy: platform.needsProxy,
            },
          })
        : React.createElement(
            'div',
            { className: 'flex-1 flex items-center justify-center text-sm text-neutral-400' },
            '请选择平台',
          ),
    ),
    // 「云」抽屉：在线视图里直接切平台 / 回本地图库
    React.createElement(OnlineCloudSwitch, {
      open: cloudOpen,
      onClose: () => setCloudOpen(false),
      title: '网络图片',
      sectionLabel: '图片来源',
      localLabel: '本地图库',
      localDesc: '本机文件夹扫描',
      items: platforms.map((p) => ({
        id: p.id,
        name: p.name,
        desc: p.desc,
        accent: p.accent,
        badge: p.needsProxy ? '需代理' : undefined,
      })),
      activeId,
      onPick: (id: string) => setActiveId(id),
      onLocal: onExit,
      footer:
        '只打开官方页面：登录与浏览都在站点自己完成，我们不抓取内容、不批量下载。',
    }),
  );
}

export default OnlineImageView;
