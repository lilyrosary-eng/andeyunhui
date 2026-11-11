/// <reference path="../../global.d.ts" />
// 音乐抽屉「自定义网站」组的内容页。
//
// 与图片 / 视频模块同构：网页由 Rust 侧的独立浏览器窗口承载（label = music-site-<id>），
// 主界面只保留站点信息与工具条。每个站点一个 target，互不干扰；
// 离开本视图时关掉自己的窗口（不动其它模块的浏览器窗口）。
import React from 'react';
import { WebBrowserShell } from '@shared/WebBrowserShell';
import type { NetworkSite } from '../../_shared/networkSites';

const { useEffect } = React;

export function MusicSiteView({ site }: { site: NetworkSite }) {
  // 取宿主 API 用函数而不是模块级常量：插件脚本可能早于 __HOST_API__ 挂载
  const invoke = (cmd: string, args?: Record<string, unknown>) =>
    (window as any).__HOST_API__?.invoke(cmd, args);

  useEffect(() => {
    const target = `music-site-${site.id}`;
    return () => {
      void Promise.resolve(invoke('browser_close', { target })).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.id]);

  return React.createElement(
    'div',
    { className: 'h-full min-w-0 flex flex-col' },
    React.createElement(
      'div',
      {
        className:
          'shrink-0 flex items-center gap-2 px-4 py-2 border-b border-neutral-200/60 dark:border-stone-700/60 bg-white/70 dark:bg-stone-800/70 backdrop-blur',
      },
      React.createElement(
        'span',
        {
          className: 'flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white',
          style: { background: site.accent || '#6b7280' },
        },
        site.name.slice(0, 1),
      ),
      React.createElement(
        'span',
        { className: 'text-sm font-medium text-neutral-800 dark:text-stone-100 truncate' },
        site.name,
      ),
      React.createElement(
        'span',
        { className: 'text-xs text-neutral-400 dark:text-stone-500 truncate' },
        site.url,
      ),
      React.createElement(
        'span',
        { className: 'ml-auto shrink-0 text-[11px] text-neutral-400 dark:text-stone-500' },
        '自定义网站 · 独立浏览器窗口',
      ),
    ),
    React.createElement(WebBrowserShell, {
      key: site.id,
      platform: {
        id: `music-site-${site.id}`,
        name: site.name,
        home: site.url,
        accent: site.accent || '#6b7280',
        note: site.desc,
      },
    }),
  );
}

export default MusicSiteView;
