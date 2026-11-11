/// <reference path="../../../global.d.ts" />
// Web 接口 ·「云」网络视图：左侧站点列表 + 右侧官方网页壳。
//
// 与视频 / 图片模块的在线视图同构（同一套 OnlineSidebarShell + WebBrowserShell），
// 只换平台注册表，保证三处学习成本一致。
const React = window.__HOST_REACT__;
const { useState, useEffect } = React;

import { getWebSites, toWebSite, type WebSite } from './webPlatforms';
import { useNetworkSites } from '@shared/useNetworkSites';
import { OnlineSidebarShell } from '@shared/OnlineSidebarShell';
import { WebBrowserShell } from '@shared/WebBrowserShell';
import { CloudTitleButton, OnlineCloudSwitch } from '@shared/OnlineCloudSwitch';
import { GlobeIcon } from '../WebSidebarShell';

interface Props {
  /** 初始站点（默认第一个） */
  initialSiteId?: string | null;
  onExit: () => void;
  onOpenModuleSettings?: () => void;
}

export function OnlineWebView({ initialSiteId, onExit, onOpenModuleSettings }: Props) {
  // 实时订阅共享注册表（设置里增删站点后立即刷新）
  const sites = useNetworkSites('web').map(toWebSite);
  const [activeId, setActiveId] = useState<string | null>(
    initialSiteId ?? sites[0]?.id ?? null,
  );
  // 从抽屉再选另一个站点时（本视图已挂载）要跟着切，而不是停留在第一次的站点
  useEffect(() => {
    if (initialSiteId) setActiveId(initialSiteId);
  }, [initialSiteId]);
  // 「云」抽屉：在线视图里也能直接切站点 / 回本地服务
  const [cloudOpen, setCloudOpen] = useState(false);
  const site = sites.find((s) => s.id === activeId) ?? null;

  // 离开网络视图时只关本模块的浏览器窗口（不能 close_all，否则会连带关掉视频/图片的）
  useEffect(() => {
    return () => {
      const api: any = (window as any).__HOST_API__;
      for (const s of getWebSites()) {
        void api?.invoke('browser_close', { target: s.id }).catch(() => {});
      }
    };
  }, []);

  const siteList = React.createElement(
    'div',
    { className: 'space-y-1' },
    React.createElement(
      'div',
      { className: 'flex items-center gap-1.5 px-1 text-[11px] text-neutral-400 dark:text-stone-500' },
      React.createElement('span', null, `共 ${sites.length} 个站点`),
      React.createElement('span', { className: 'opacity-40' }, '·'),
      React.createElement('span', null, '官方页面 · 浏览器窗口'),
    ),
    sites.map((s: WebSite) => {
      const isActive = activeId === s.id;
      return React.createElement(
        'button',
        {
          key: s.id,
          onClick: () => setActiveId(s.id),
          className: `w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
            isActive ? 'bg-black/5 dark:bg-white/10' : 'hover:bg-black/[0.03] dark:hover:bg-white/5'
          }`,
        },
        React.createElement(
          'div',
          {
            className: 'flex h-9 w-9 items-center justify-center rounded-lg shrink-0 text-white text-xs font-bold',
            style: { background: s.accent },
          },
          s.name.slice(0, 2),
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
              s.name,
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
            s.desc,
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

  // 标题只做展示：模块切换统一走标题栏右侧「云」按钮（抽屉里有「本地服务」项）
  const titleEl = React.createElement(
    'div',
    {
      className: 'font-bold text-lg text-neutral-800 dark:text-stone-100 flex items-center gap-2',
    },
    '网络站点',
  );

  return React.createElement(
    'div',
    { className: 'absolute inset-0 flex' },
    React.createElement(OnlineSidebarShell, {
      icon: React.createElement(GlobeIcon),
      title: titleEl,
      moduleId: 'web-interface',
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
      {
        className: 'relative flex-1 flex flex-col bg-[#f5f5f0] dark:bg-[#1c1917] immersive-safe-top',
      },
      site
        ? React.createElement(WebBrowserShell, {
            key: site.id,
            platform: {
              id: site.id,
              name: site.name,
              home: site.home,
              accent: site.accent,
              note: site.note,
            },
          })
        : React.createElement(
            'div',
            { className: 'flex-1 flex items-center justify-center text-sm text-neutral-400' },
            '请选择站点',
          ),
    ),
    // 「云」抽屉：在线视图里直接切站点 / 回本地服务
    React.createElement(OnlineCloudSwitch, {
      open: cloudOpen,
      onClose: () => setCloudOpen(false),
      title: '网络站点',
      sectionLabel: '站点来源',
      localLabel: '本地服务',
      localDesc: '本机 Web 服务预设',
      items: sites.map((s) => ({
        id: s.id,
        name: s.name,
        desc: s.desc,
        accent: s.accent,
      })),
      activeId,
      onPick: (id: string) => setActiveId(id),
      onLocal: onExit,
      footer: '只打开官方页面：登录与浏览都在站点自己完成，我们不抓取内容、不批量下载。',
    }),
  );
}

export default OnlineWebView;
