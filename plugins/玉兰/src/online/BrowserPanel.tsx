/// <reference path="../../../global.d.ts" />
// 网络视频 · 平台页浏览器面板
//
// 页面由 Rust 侧的**独立浏览器窗口**（label = video-browser）承载：
//   · 主界面这里只保留工具条 + 状态 + 嗅探结果抽屉；
//   · 为什么不嵌在面板里：实机验证 Windows/WebView2 下 `Window::add_child` 创建的子
//     webview 始终被主 webview 的合成层盖住（白屏，z-order 无效），详见 embedded_browser.rs 头注释。
//
// 嗅探：注入脚本把资源列表经 `bimedia.localhost/__report/...` 上报，Rust 截获后前端取走；
// 下载走已有的 download_video / download_hls，Referer 用当前页面地址（多数 CDN 认这个）。
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
  // 浏览器窗口是否已由我们打开（关闭后置 false，用于占位卡片的文案）
  const [windowOpen, setWindowOpen] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => videoDownloadManager.subscribe(setQueue), []);

  // 卸载时关闭浏览器窗口，避免它留在桌面上
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      void hostApi.invoke('browser_close').catch(() => {});
    };
  }, []);

  /** 打开指定网址：**不依赖任何 state**（自动加载与手动前往共用） */
  const openAt = useCallback(async (u: string) => {
    if (!u) return;
    setError(null);
    setBusy(true);
    try {
      await hostApi.invoke('browser_open', { url: u, x: 0, y: 0, width: 0, height: 0 });
      if (!mountedRef.current) return;
      setUrl(u);
      setCurrent(u);
      setWindowOpen(true);
      setNotice('已在独立浏览器窗口打开。窗口可自由拖动/缩放，不会遮挡主界面。');
    } catch (e: unknown) {
      const msg = typeof e === 'string' ? e : (e as any)?.message || JSON.stringify(e);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }, []);

  const go = useCallback((target?: string) => openAt(normalizeUrl(target ?? url)), [url, openAt]);

  // 进入平台即自动打开官方页面（旧实现要手动点「前往」，用户只看到空白）
  useEffect(() => {
    let cancelled = false;
    const raf = requestAnimationFrame(() => {
      if (!cancelled) void openAt(platform.home);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [platform.id, openAt]);

  const focusBrowser = () => {
    void hostApi.invoke('browser_focus').catch((e: unknown) => setError(String(e)));
  };

  const closeBrowser = () => {
    void hostApi.invoke('browser_close').catch(() => {});
    setWindowOpen(false);
    setCurrent('');
    setNotice(null);
    setItems([]);
    setDrawerOpen(false);
  };

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
      setDrawerOpen(true);
      if (merged.length === 0) {
        setNotice('未捕获到资源。可能是页面还没开始播放，或该站点 CSP 阻止了上报（先点一下页面里的播放再嗅探）。');
      }
    } catch (e: unknown) {
      setError(`嗅探失败：${typeof e === 'string' ? e : (e as any)?.message || String(e)}`);
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
          [it.type, prettySize(it.url), it.w && it.h ? `${it.w}×${it.h}` : null, it.kind].filter(Boolean).join(' · '),
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
    { className: 'relative flex-1 min-h-0 flex flex-col overflow-hidden' },
    // ===== 工具条 =====
    React.createElement(
      'div',
      { className: 'shrink-0 flex flex-wrap items-center gap-2 px-3 py-2 border-b border-neutral-200/60 dark:border-stone-700/60 bg-white/70 dark:bg-stone-800/70 backdrop-blur' },
      React.createElement('span', { className: 'inline-flex shrink-0', style: { color: platform.accent } }, React.createElement(GlobeIcon, { size: 16 })),
      React.createElement(
        'div',
        { className: 'flex items-center gap-2 flex-1 min-w-[140px] bg-neutral-100 dark:bg-stone-700 rounded-xl px-3 py-1.5' },
        React.createElement('span', { className: 'inline-flex text-neutral-400' }, React.createElement(SearchIcon, { size: 14 })),
        React.createElement('input', {
          value: url,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setUrl(e.target.value),
          onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') go();
          },
          placeholder: '输入网址后回车（例：https://www.douyin.com）',
          className: 'flex-1 min-w-0 bg-transparent text-xs text-neutral-700 dark:text-stone-200 outline-none',
        }),
      ),
      React.createElement(
        'button',
        { onClick: () => go(), disabled: busy, className: 'btn-press shrink-0 px-3 py-1.5 rounded-xl text-xs text-white disabled:opacity-50', style: { background: platform.accent } },
        busy ? '打开中…' : '前往',
      ),
      React.createElement(
        'button',
        { onClick: focusBrowser, className: 'btn-press shrink-0 px-3 py-1.5 rounded-lg text-xs text-neutral-600 dark:text-stone-300 hover:bg-neutral-100 dark:hover:bg-stone-700' },
        '回到浏览器',
      ),
      React.createElement(
        'button',
        { onClick: doSniff, disabled: busy, className: 'btn-press shrink-0 px-3 py-1.5 rounded-xl text-xs text-white disabled:opacity-50', style: { background: drawerOpen ? '#6b7280' : platform.accent } },
        drawerOpen ? '收起嗅探' : '嗅探',
      ),
      React.createElement(
        'button',
        { onClick: pickDir, className: 'btn-press shrink-0 px-2 py-1.5 rounded-lg text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-stone-700', title: '下载目录' },
        dlDir ? '目录✓' : '目录',
      ),
      windowOpen &&
        React.createElement(
          'button',
          { onClick: closeBrowser, className: 'btn-press shrink-0 px-2 py-1.5 rounded-lg text-xs text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30', title: '关闭浏览器窗口' },
          '关闭窗口',
        ),
      React.createElement('span', { className: 'text-xs text-neutral-400 dark:text-stone-500 shrink-0' }, `下载(${active})`),
    ),
    // ===== 提示 / 错误 / 状态 =====
    notice && React.createElement('div', { className: 'shrink-0 px-3 py-1.5 text-xs text-sky-700 dark:text-sky-300 bg-sky-50/70 dark:bg-sky-950/30' }, notice),
    error && React.createElement('div', { className: 'shrink-0 px-3 py-1.5 text-xs text-red-500 bg-red-50/60 dark:bg-red-950/30 break-all' }, `打开失败：${error}`),
    React.createElement(
      'div',
      { className: 'shrink-0 px-3 py-1 text-[11px] text-neutral-400 dark:text-stone-500 truncate' },
      error
        ? '上面是内核返回的错误；可尝试「前往」重开，或检查代理/梯子是否拦截了 WebView2 请求。'
        : busy
          ? '正在打开浏览器窗口…'
          : current
            ? `浏览器窗口已打开：${current}`
            : '浏览器窗口未打开',
    ),
    // ===== 主体：占位卡片（真实页面在独立窗口）+ 嗅探抽屉 =====
    React.createElement(
      'div',
      { className: 'flex-1 flex min-h-0' },
      React.createElement(
        'div',
        { className: 'flex-1 min-w-0 flex flex-col items-center justify-center gap-3 p-8 bg-white dark:bg-stone-900' },
        React.createElement('span', { className: 'inline-flex', style: { color: platform.accent } }, React.createElement(GlobeIcon, { size: 40 })),
        React.createElement('p', { className: 'text-sm font-medium text-neutral-700 dark:text-stone-200' }, `${platform.name} 在独立浏览器窗口中打开`),
        React.createElement(
          'p',
          { className: 'text-xs text-neutral-400 dark:text-stone-500 max-w-md text-center leading-relaxed' },
          '网页、登录与播放都由官方站点自己完成；本窗口只负责发起打开与资源嗅探。' +
            '如果窗口里是空白，通常是代理/梯子拦截了 WebView2 的请求，或站点要求登录。',
        ),
        React.createElement(
          'div',
          { className: 'flex items-center gap-2 mt-1' },
          React.createElement(
            'button',
            { onClick: focusBrowser, className: 'btn-press px-4 py-2 rounded-xl text-sm text-white', style: { background: platform.accent } },
            '回到浏览器窗口',
          ),
          React.createElement(
            'button',
            { onClick: () => go(), className: 'btn-press px-4 py-2 rounded-xl text-sm bg-neutral-100 dark:bg-stone-700 text-neutral-600 dark:text-stone-300' },
            current ? '重新加载' : '打开',
          ),
        ),
        React.createElement('p', { className: 'text-[10px] text-neutral-300 dark:text-stone-600 mt-2' }, '提示：嗅探前先在浏览器窗口里点一下播放，资源才会出现。'),
      ),
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
              ? React.createElement('p', { className: 'text-xs text-neutral-400 dark:text-stone-500 p-3 leading-relaxed' }, '暂无资源。先在浏览器窗口里打开视频页并点一下播放，再点「嗅探」。')
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
