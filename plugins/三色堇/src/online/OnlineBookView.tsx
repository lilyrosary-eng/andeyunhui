/// <reference path="../../../global.d.ts" />
// 网络书库主视图：左侧站点列表 + 右侧官方网页壳。
// 与视频/图片/Web 接口的在线视图同构，只换平台注册表。
const React = window.__HOST_REACT__;
const { useState, useEffect } = React;

import { getBookPlatforms, toBookPlatform, type BookPlatform } from './bookPlatforms';
import { useNetworkSites } from '@shared/useNetworkSites';
import { OnlineSidebarShell } from '@shared/OnlineSidebarShell';
import { WebBrowserShell } from '@shared/WebBrowserShell';
import { CloudTitleButton, OnlineCloudSwitch } from '@shared/OnlineCloudSwitch';

interface Props {
  /** 初始站点（默认第一个） */
  initialSiteId?: string | null;
  onExit: () => void;
  onOpenModuleSettings?: () => void;
}

function BookIcon() {
  return React.createElement('svg', {
    width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    children: [
      React.createElement('path', { key: '1', d: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20' }),
      React.createElement('path', { key: '2', d: 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z' }),
    ],
  });
}

export function OnlineBookView({ initialSiteId, onExit, onOpenModuleSettings }: Props) {
  const platforms = useNetworkSites('book').map(toBookPlatform);
  const [activeId, setActiveId] = useState<string | null>(
    initialSiteId ?? platforms[0]?.id ?? null,
  );
  // 从抽屉再选另一个站点时（本视图已挂载）要跟着切
  useEffect(() => {
    if (initialSiteId) setActiveId(initialSiteId);
  }, [initialSiteId]);
  const [cloudOpen, setCloudOpen] = useState(false);
  const platform = platforms.find((p) => p.id === activeId) ?? null;

  // 离开网络视图时只关本模块的浏览器窗口
  useEffect(() => {
    return () => {
      const api: any = (window as any).__HOST_API__;
      for (const p of getBookPlatforms()) {
        void api?.invoke('browser_close', { target: p.id }).catch(() => {});
      }
    };
  }, []);

  const siteList = React.createElement(
    'div',
    { className: 'space-y-1' },
    React.createElement(
      'div',
      { className: 'flex items-center gap-1.5 px-1 text-[11px] text-neutral-400 dark:text-stone-500' },
      React.createElement('span', null, `共 ${platforms.length} 个站点`),
      React.createElement('span', { className: 'opacity-40' }, '·'),
      React.createElement('span', null, '官方页面 · 浏览器窗口'),
    ),
    platforms.map((p: BookPlatform) => {
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
              { className: 'text-[10px] px-1 rounded shrink-0 text-neutral-400 dark:text-stone-500' },
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
      '只打开官方页面：登录与阅读都在站点自己完成，我们不抓取正文、不批量下载。',
    ),
  );

  // 标题只做展示：模块切换统一走标题栏右侧「云」按钮（抽屉里有「本地书库」项）
  const titleEl = React.createElement(
    'div',
    {
      className: 'font-bold text-lg text-neutral-800 dark:text-stone-100 flex items-center gap-2',
    },
    '网络书库',
  );

  return React.createElement(
    'div',
    { className: 'absolute inset-0 flex' },
    React.createElement(OnlineSidebarShell, {
      icon: React.createElement(BookIcon),
      title: titleEl,
      moduleId: 'reading',
      onClose: onExit,
      onOpenModuleSettings,
      titleActions: React.createElement(CloudTitleButton, {
        open: cloudOpen,
        onClick: () => setCloudOpen((v) => !v),
      }),
      children: siteList,
    }),
    React.createElement(
      'div',
      { className: 'relative flex-1 flex flex-col bg-[#f5f5f0] dark:bg-[#1c1917] immersive-safe-top' },
      platform
        ? React.createElement(WebBrowserShell, {
            key: platform.id,
            platform: {
              id: platform.id,
              name: platform.name,
              home: platform.home,
              accent: platform.accent,
              note: platform.note,
            },
          })
        : React.createElement(
            'div',
            { className: 'flex-1 flex items-center justify-center text-sm text-neutral-400' },
            '请选择站点',
          ),
    ),
    React.createElement(OnlineCloudSwitch, {
      open: cloudOpen,
      onClose: () => setCloudOpen(false),
      title: '网络书库',
      sectionLabel: '书库来源',
      localLabel: '本地书库',
      localDesc: '本机书籍文件',
      items: platforms.map((p) => ({ id: p.id, name: p.name, desc: p.desc, accent: p.accent })),
      activeId,
      onPick: (id: string) => setActiveId(id),
      onLocal: onExit,
      footer: '只打开官方页面：登录与阅读都在站点自己完成，我们不抓取正文、不批量下载。',
    }),
  );
}

export default OnlineBookView;
