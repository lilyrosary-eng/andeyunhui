import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { WebBrowserShell } from '../../../plugins/_shared/WebBrowserShell';
import type { NetworkSite } from '../../../plugins/_shared/networkSites';

/**
 * 笔记抽屉「自定义网站」组的内容页。
 *
 * 与图片 / 视频模块一致：网页由 Rust 侧的独立浏览器窗口承载，
 * 这里只保留工具条与提示，不在主界面嵌 webview（Windows/WebView2 下会被合成层盖住）。
 * 每个站点用独立 target（`note-site-<id>`），互不干扰；离开本视图时关掉自己的窗口。
 */
export function NotesSiteView({ site }: { site: NetworkSite | null }) {
  const siteId = site?.id ?? null;

  useEffect(() => {
    if (!siteId) return;
    const target = `note-site-${siteId}`;
    return () => {
      void invoke('browser_close', { target }).catch(() => {});
    };
  }, [siteId]);

  if (!site) {
    return (
      <div className="h-full flex items-center justify-center px-6">
        <p className="text-sm text-neutral-400 dark:text-stone-500 text-center leading-relaxed">
          该自定义网站已被删除。
          <br />
          可在「设置 → 茑萝 → 网络拓展 → 笔记」里重新添加。
        </p>
      </div>
    );
  }

  return (
    <div className="h-full min-w-0 flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-neutral-200/60 dark:border-stone-700/60 bg-white/70 dark:bg-stone-800/70 backdrop-blur">
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white"
          style={{ background: site.accent || '#6b7280' }}
        >
          {site.name.slice(0, 1)}
        </span>
        <span className="text-sm font-medium text-neutral-800 dark:text-stone-100 truncate">
          {site.name}
        </span>
        <span className="text-xs text-neutral-400 dark:text-stone-500 truncate">{site.url}</span>
        <span className="ml-auto shrink-0 text-[11px] text-neutral-400 dark:text-stone-500">
          自定义网站 · 独立浏览器窗口
        </span>
      </div>
      <WebBrowserShell
        key={site.id}
        platform={{
          id: `note-site-${site.id}`,
          name: site.name,
          home: site.url,
          accent: site.accent || '#6b7280',
          note: site.desc,
        }}
      />
    </div>
  );
}

export default NotesSiteView;
