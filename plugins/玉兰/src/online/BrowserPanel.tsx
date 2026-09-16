/// <reference path="../../../global.d.ts" />
// 内嵌浏览器面板：把面板区当作浏览器用（输入网址 → 像浏览器一样浏览），
// 额外提供「嗅探」——列出页面加载过的图片/视频资源，带缩略图与信息，可直接下载。
//
// 实现要点：
//  · 真正的浏览由 Rust 侧的**子 webview** 承载（见 src-tauri/src/embedded_browser.rs），
//    它精确铺在下面 hostRef 这个 div 的矩形上；本组件负责把矩形同步过去。
//  · 子 webview 是独立渲染面，**会盖住它范围内的主界面 DOM**，
//    所以嗅探结果做成**右侧抽屉**：打开时浏览器矩形自动收窄，两者永不重叠。
//  · 下载走已有的 download_video / download_hls，Referer 用当前页面地址（多数 CDN 认这个）。
import React from 'react';
import { videoDownloadManager, VIDEO_DOWNLOAD_DIR_KEY, type VideoDownloadTask } from './OnlineVideoDownloadManager';
import { pickDownloadDir } from './pickDir';
import { toPlayableUrl } from './mediaProxy';
import type { VideoPlatform } from './videoPlatforms';
import { GlobeIcon, SearchIcon, DownloadIcon, CloseIcon } from '@shared/icons';

const { useState, useEffect, useRef, useCallback } = React;

const hostApi: any = (window as any).__HOST_API__ || { invoke: async () => undefined };

interface Props {
  platform: VideoPlatform;
}

interface SniffItem {
  url: string;
  kind: string;
  type: 'video' | 'audio' | 'image' | 'other';
  w?: number;
  h?: number;
  tag?: string;
  /** 上报时页面地址，作为下载/缩略图的 Referer */
  page: string;
}

const VIDEO_EXT = /\.(mp4|m3u8|flv|webm|mkv|mov|m4v|m4s|ts|avi)(\?|#|$)/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg)(\?|#|$)/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp)(\?|#|$)/i;

function classify(url: string): SniffItem['type'] {
  if (VIDEO_EXT.test(url)) return 'video';
  if (IMAGE_EXT.test(url)) return 'image';
  if (AUDIO_EXT.test(url)) return 'audio';
  return 'other';
}

/** 地址栏容错：没写协议就补 https:// */
function normalizeUrl(input: string): string {
  const s = input.trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

function prettySize(url: string): string {
  const m = url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : '?';
}

export function BrowserPanel({ platform }: Props) {
  const [url, setUrl] = useState(platform.home);
  const [current, setCurrent] = useState('');
  const [items, setItems] = useState<SniffItem[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dlDir, setDlDir] = useState(localStorage.getItem(VIDEO_DOWNLOAD_DIR_KEY) || '');
  const [queue, setQueue] = useState<VideoDownloadTask[]>([]);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => videoDownloadManager.subscribe(setQueue), []);

  // 把 host div 的矩形同步给 Rust 侧的子 webview
  const syncBounds = useCallback(async () => {
    const el = hostRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    try {
      await hostApi.invoke('browser_set_bounds', { x: r.left, y: r.top, width: r.width, height: r.height });
    } catch {
      /* 浏览器尚未创建时忽略 */
    }
  }, []);

  // 布局变化（窗口缩放、抽屉开关）后重新对齐
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => void syncBounds());
    ro.observe(el);
    const onWinResize = () => void syncBounds();
    window.addEventListener('resize', onWinResize);
    // 抽屉开合会引起布局变化，等一帧后再同步
    const t = window.setTimeout(() => void syncBounds(), 60);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onWinResize);
      window.clearTimeout(t);
    };
  }, [syncBounds, drawerOpen]);

  // 卸载时销毁子 webview，避免它继续盖在界面上
  useEffect(() => {
    return () => {
      void hostApi.invoke('browser_close').catch(() => {});
    };
  }, []);

  const go = useCallback(
    async (target?: string) => {
      const u = normalizeUrl(target ?? url);
      if (!u) return;
      const el = hostRef.current;
      if (!el) return;
      setError(null);
      setBusy(true);
      try {
        const r = el.getBoundingClientRect();
        await hostApi.invoke('browser_open', { url: u, x: r.left, y: r.top, width: r.width, height: r.height });
        setCurrent(u);
      } catch (e: unknown) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [url],
  );

  const doSniff = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const raw: string[] = (await hostApi.invoke('browser_sniff')) || [];
      const merged: SniffItem[] = [];
      const seen = new Set<string>();
      for (const s of raw) {
        try {
          const parsed = JSON.parse(s);
          const page = String(parsed?.page || current || platform.home);
          for (const it of parsed?.items || []) {
            const u = String(it?.url || '');
            if (!u || seen.has(u)) continue;
            seen.add(u);
            merged.push({
              url: u,
              kind: String(it?.src || it?.kind || 'auto'),
              type: classify(u),
              w: Number(it?.w) || undefined,
              h: Number(it?.h) || undefined,
              tag: it?.tag,
              page,
            });
          }
        } catch {
          /* 单条上报解析失败不影响其它 */
        }
      }
      setItems(merged);
      setDrawerOpen(true); // 打开抽屉 → 浏览器矩形自动收窄，避免子 webview 盖住抽屉
      if (merged.length === 0) {
        setNotice('未捕获到资源。可能是页面还没开始播放，或该站点 CSP 阻止了上报（先点一下页面里的播放再嗅探）。');
      }
    } catch (e: unknown) {
      setError(`嗅探失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const pickDir = async () => {
    const r = await pickDownloadDir();
    if (r) {
      localStorage.setItem(VIDEO_DOWNLOAD_DIR_KEY, r);
      setDlDir(r);
    }
  };

  const download = (it: SniffItem) => {
    if (!dlDir) {
      setNotice('请先设置下载目录（点上方「目录」）');
      return;
    }
    const isHls = /\.m3u8(\?|#|$)/i.test(it.url);
    videoDownloadManager.enqueue([
      {
        title: decodeURIComponent(it.url.split('/').pop()?.split('?')[0] || 'resource').slice(0, 60),
        ref: it.url,
        kind: isHls ? 'hls' : 'direct',
        platformId: platform.id,
        referer: it.page,
        subDir: `来自${platform.name}`,
      },
    ]);
  };

  const videoItems = items.filter((x) => x.type === 'video');
  const imageItems = items.filter((x) => x.type === 'image');
  const active = queue.filter((q) => q.status === 'downloading' || q.status === 'queued').length;

  /** 单个资源行：缩略图 + 信息 + 下载 */
  const renderItem = (it: SniffItem, idx: number) =>
    React.createElement(
      'div',
      { key: `${it.url}-${idx}`, className: 'flex gap-2 p-2 rounded-xl hover:bg-neutral-100 dark:hover:bg-stone-700/50' },
      // 缩略图：图片直接显示；视频用 <video preload=metadata> 取首帧（同样要过中继补 Referer）
      React.createElement(
        'div',
        { className: 'w-16 h-10 shrink-0 rounded-lg overflow-hidden bg-neutral-200 dark:bg-stone-700 flex items-center justify-center' },
        it.type === 'image'
          ? React.createElement('img', {
              src: toPlayableUrl(it.url, it.page),
              alt: '',
              className: 'w-full h-full object-cover',
              loading: 'lazy',
            })
          : it.type === 'video' && idx < 40
            ? React.createElement('video', {
                src: toPlayableUrl(it.url, it.page),
                preload: 'metadata',
                muted: true,
                className: 'w-full h-full object-cover',
              })
            : React.createElement('span', { className: 'text-[10px] text-neutral-400' }, it.type),
      ),
      React.createElement(
        'div',
        { className: 'flex-1 min-w-0' },
        React.createElement('p', { className: 'text-[11px] text-neutral-700 dark:text-stone-200 truncate', title: it.url }, it.url),
        React.createElement(
          'p',
          { className: 'text-[10px] text-neutral-400 dark:text-stone-500' },
          [
            it.type,
            prettySize(it.url),
            it.w && it.h ? `${it.w}×${it.h}` : null,
            it.kind,
          ]
            .filter(Boolean)
            .join(' · '),
        ),
      ),
      React.createElement(
        'button',
        {
          onClick: () => download(it),
          className: 'shrink-0 self-center inline-flex p-1.5 rounded-lg text-neutral-400 hover:text-[var(--element-color-raw)] hover:bg-black/5 dark:hover:bg-white/5',
          title: '下载',
        },
        React.createElement(DownloadIcon, { size: 14 }),
      ),
    );

  return React.createElement(
    'div',
    { className: 'absolute inset-0 flex flex-col' },
    // ===== 工具条 =====
    React.createElement(
      'div',
      { className: 'shrink-0 flex items-center gap-2 px-3 py-2 border-b border-neutral-200/60 dark:border-stone-700/60 bg-white/70 dark:bg-stone-800/70 backdrop-blur' },
      React.createElement('span', { className: 'inline-flex shrink-0', style: { color: platform.accent } }, React.createElement(GlobeIcon, { size: 16 })),
      React.createElement(
        'div',
        { className: 'flex items-center gap-2 flex-1 bg-neutral-100 dark:bg-stone-700 rounded-xl px-3 py-1.5' },
        React.createElement('span', { className: 'inline-flex text-neutral-400' }, React.createElement(SearchIcon, { size: 14 })),
        React.createElement('input', {
          value: url,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setUrl(e.target.value),
          onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') void go();
          },
          placeholder: '输入网址后回车（例：https://www.douyin.com）',
          className: 'flex-1 bg-transparent text-xs text-neutral-700 dark:text-stone-200 outline-none',
        }),
      ),
      React.createElement(
        'button',
        { onClick: () => void go(), disabled: busy, className: 'btn-press px-3 py-1.5 rounded-xl text-xs text-white disabled:opacity-50', style: { background: platform.accent } },
        busy ? '处理中…' : '前往',
      ),
      React.createElement(
        'button',
        { onClick: () => void go(current || url), className: 'btn-press px-2 py-1.5 rounded-lg text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-stone-700' },
        '刷新',
      ),
      React.createElement(
        'button',
        {
          onClick: doSniff,
          disabled: busy,
          className: 'btn-press px-3 py-1.5 rounded-xl text-xs text-white disabled:opacity-50',
          style: { background: drawerOpen ? '#6b7280' : platform.accent },
          title: '列出页面加载过的图片/视频资源',
        },
        drawerOpen ? '收起嗅探' : '嗅探',
      ),
      React.createElement(
        'button',
        { onClick: pickDir, className: 'btn-press px-2 py-1.5 rounded-lg text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-stone-700', title: '下载目录' },
        dlDir ? '目录✓' : '目录',
      ),
      React.createElement('span', { className: 'text-xs text-neutral-400 dark:text-stone-500 shrink-0' }, `下载(${active})`),
    ),
    // ===== 提示 / 错误 =====
    notice && React.createElement('div', { className: 'shrink-0 px-3 py-1.5 text-xs text-sky-700 dark:text-sky-300 bg-sky-50/70 dark:bg-sky-950/30' }, notice),
    error && React.createElement('div', { className: 'shrink-0 px-3 py-1.5 text-xs text-red-500 bg-red-50/60 dark:bg-red-950/30 break-all' }, error),
    // ===== 主体：浏览器矩形 + 嗅探抽屉（永不重叠）=====
    React.createElement(
      'div',
      { className: 'flex-1 flex min-h-0' },
      React.createElement('div', { ref: hostRef, className: 'flex-1 min-w-0 bg-white dark:bg-stone-900' }),
      drawerOpen &&
        React.createElement(
          'div',
          { className: 'w-80 shrink-0 border-l border-neutral-200/60 dark:border-stone-700/60 flex flex-col bg-white/95 dark:bg-stone-800/95' },
          React.createElement(
            'div',
            { className: 'shrink-0 flex items-center gap-2 px-3 py-2 border-b border-neutral-200/60 dark:border-stone-700/60' },
            React.createElement('span', { className: 'text-xs font-medium text-neutral-700 dark:text-stone-200' }, `嗅探资源 ${items.length}`),
            React.createElement('span', { className: 'text-[10px] text-neutral-400' }, `视频 ${videoItems.length} · 图片 ${imageItems.length}`),
            React.createElement(
              'button',
              { onClick: () => setDrawerOpen(false), className: 'ml-auto inline-flex text-neutral-400 hover:text-neutral-700 dark:hover:text-stone-200', title: '收起' },
              React.createElement(CloseIcon, { size: 14 }),
            ),
          ),
          React.createElement(
            'div',
            { className: 'flex-1 overflow-y-auto p-1.5 space-y-0.5' },
            items.length === 0
              ? React.createElement('p', { className: 'text-xs text-neutral-400 dark:text-stone-500 p-3 leading-relaxed' }, '暂无资源。先在浏览器里打开视频页并点一下播放，再点「嗅探」。')
              : items.map(renderItem),
          ),
          queue.length > 0 &&
            React.createElement(
              'div',
              { className: 'shrink-0 max-h-40 overflow-y-auto border-t border-neutral-200/60 dark:border-stone-700/60 p-2' },
              React.createElement(
                'div',
                { className: 'flex items-center justify-between mb-1' },
                React.createElement('span', { className: 'text-[11px] font-medium text-neutral-500 dark:text-stone-400' }, '下载队列'),
                React.createElement(
                  'button',
                  { onClick: () => videoDownloadManager.clearFinished(), className: 'text-[10px] text-neutral-400 hover:text-neutral-700 dark:hover:text-stone-200' },
                  '清空已完成',
                ),
              ),
              queue.map((q) => {
                const pct = q.total > 0 ? Math.min(100, Math.round((q.downloaded / q.total) * 100)) : q.status === 'done' ? 100 : 0;
                return React.createElement(
                  'div',
                  { key: q.id, className: 'mb-1' },
                  React.createElement(
                    'div',
                    { className: 'flex items-center gap-2 text-[10px]' },
                    React.createElement('span', { className: 'flex-1 truncate text-neutral-600 dark:text-stone-300' }, q.title),
                    React.createElement(
                      'span',
                      { className: 'text-neutral-400' },
                      q.status === 'downloading' ? `${pct}%` : q.status === 'done' ? '完成' : q.status === 'error' ? '失败' : q.status === 'canceled' ? '已取消' : '排队',
                    ),
                    React.createElement('button', { onClick: () => videoDownloadManager.remove(q.id), className: 'text-neutral-400 hover:text-red-500' }, '×'),
                  ),
                  React.createElement(
                    'div',
                    { className: 'h-0.5 mt-0.5 rounded bg-neutral-200 dark:bg-stone-600 overflow-hidden' },
                    React.createElement('div', { className: 'h-full', style: { width: `${pct}%`, background: platform.accent } }),
                  ),
                  q.status === 'error' && React.createElement('p', { className: 'text-[9px] text-red-500 break-all' }, q.error),
                );
              }),
            ),
        ),
    ),
  );
}

export default BrowserPanel;
