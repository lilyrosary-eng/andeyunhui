/// <reference path="../global.d.ts" />
// 通用「官方网页壳」面板（视频 / 图片等模块共用）。
//
// 设计目标（三个模块同构）：
//   · 页面由 Rust 侧的**独立浏览器窗口**承载（label = browser-<platform.id>），
//     主界面这里只保留工具条 + 状态 + 嗅探结果抽屉；
//   · 多平台可同时打开（每个 target 一个窗口），登录态存在固定 WebView2 profile 里；
//   · 嗅探结果由 Rust 注入脚本上报并**已在服务端滤掉 js/css/font**，
//     这里只做分组与展示，不再自己猜扩展名。
//
// 为什么不在面板里嵌 webview：Windows/WebView2 下子 webview 会被主 webview 的
// 合成层盖住（白屏），详见 src-tauri/src/embedded_browser.rs 头注释。
import React from 'react';

const { useState, useEffect, useCallback, useRef } = React;

// 图标就地定义：不能复用 ./icons —— 它顶层读 window.__HOST_REACT__，
// 宿主（笔记模块也复用本组件）静态导入时全局还没挂上，渲染会直接白屏。
function SvgIcon({ size = 18, children }: { size?: number; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

const GlobeIcon = ({ size = 18 }: { size?: number }) => (
  <SvgIcon size={size}>
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </SvgIcon>
);

const SearchIcon = ({ size = 18 }: { size?: number }) => (
  <SvgIcon size={size}>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </SvgIcon>
);

const DownloadIcon = ({ size = 18 }: { size?: number }) => (
  <SvgIcon size={size}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </SvgIcon>
);

const CloseIcon = ({ size = 18 }: { size?: number }) => (
  <SvgIcon size={size}>
    <path d="M18 6 6 18M6 6l12 12" />
  </SvgIcon>
);

// 取宿主 API 用函数而不是模块级常量：宿主静态导入本文件时 __HOST_API__ 尚未挂载
const FALLBACK_HOST_API = { invoke: async () => undefined, listen: async () => () => {} };
function hostApi(): any {
  return (window as any).__HOST_API__ || FALLBACK_HOST_API;
}

export interface WebPlatform {
  id: string;
  name: string;
  home: string;
  accent: string;
  /** 附加说明（面板底部一行） */
  note?: string;
  /** 该站点在部分网络环境需要代理（如 pixiv）：卡片上给出明确提示与系统浏览器兜底 */
  needsProxy?: boolean;
}

/** Rust 侧上报的一条资源 */
export interface SniffItem {
  url: string;
  /** media | image | segment | other */
  kind: string;
  /** 元素引用来源：media / img / perf / fetch / xhr */
  it: string;
  w?: number;
  h?: number;
  tag?: string;
  /** 上报时页面地址，作为下载/缩略图的 Referer */
  page: string;
}

export interface WebBrowserShellProps {
  platform: WebPlatform;
  /** 允许把某条资源交给调用方处理（视频=加入下载队列；图片=无） */
  onDownload?: (item: SniffItem) => void;
  /** 未传 onDownload 时隐藏下载按钮 */
  extraActions?: React.ReactNode;
}

const VIDEO_EXT = /\.(mp4|m3u8|flv|webm|mkv|mov|m4v|m4s|ts|avi)(\?|#|$)/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg)(\?|#|$)/i;

/** 把 Rust 的粗分类细化成展示用类型：video / audio / image / segment / other */
export function refineKind(item: SniffItem): 'video' | 'audio' | 'image' | 'segment' | 'other' {
  if (item.kind === 'segment') return 'segment';
  if (item.kind === 'image') return 'image';
  if (AUDIO_EXT.test(item.url)) return 'audio';
  if (VIDEO_EXT.test(item.url)) return 'video';
  if (item.kind === 'media') return 'video';
  return 'other';
}

function normalizeUrl(input: string): string {
  const s = input.trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

function errText(e: unknown): string {
  return typeof e === 'string' ? e : (e as any)?.message || JSON.stringify(e);
}

export function WebBrowserShell({ platform, onDownload, extraActions }: WebBrowserShellProps) {
  const [url, setUrl] = useState(platform.home);
  const [current, setCurrent] = useState('');
  const [items, setItems] = useState<SniffItem[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [windowOpen, setWindowOpen] = useState(false);
  /** 抽屉分组筛选：media=视频+分片 / image / all */
  const [tab, setTab] = useState<'media' | 'image' | 'all'>('media');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const openAt = useCallback(
    async (u: string) => {
      if (!u) return;
      setError(null);
      setBusy(true);
      try {
        await hostApi().invoke('browser_open', {
          target: platform.id,
          url: u,
          title: `安得云荟 · ${platform.name}`,
          // 位置/尺寸已由窗口管理器接管，保留字段只为兼容旧签名
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        });
        if (!mountedRef.current) return;
        setUrl(u);
        setCurrent(u);
        setWindowOpen(true);
        setNotice('已在独立浏览器窗口打开。窗口可自由拖动/缩放，登录状态会保留。');
      } catch (e: unknown) {
        setError(errText(e));
      } finally {
        setBusy(false);
      }
    },
    [platform.id, platform.name],
  );

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
    void hostApi().invoke('browser_focus', { target: platform.id }).catch((e: unknown) => {
      const msg = errText(e);
      if (msg.includes('尚未打开')) {
        setWindowOpen(false);
        setCurrent('');
        setNotice('浏览器窗口已关闭。点「重新加载」可重新打开。');
      } else {
        setError(msg);
      }
    });
  };

  const closeBrowser = () => {
    void hostApi().invoke('browser_close', { target: platform.id }).catch(() => {});
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
      const raw: string[] = (await hostApi().invoke('browser_sniff', { target: platform.id })) || [];
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
              kind: String(it?.kind || 'other'),
              it: String(it?.it || ''),
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
        setNotice('未捕获到资源。先在浏览器窗口里点一下播放/打开图片详情，再点「嗅探」。');
      }
    } catch (e: unknown) {
      setError(`嗅探失败：${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const refined = items.map((it) => ({ it, type: refineKind(it) }));
  const videos = refined.filter((x) => x.type === 'video');
  const audios = refined.filter((x) => x.type === 'audio');
  const segments = refined.filter((x) => x.type === 'segment');
  const images = refined.filter((x) => x.type === 'image');
  const others = refined.filter((x) => x.type === 'other');
  const shown =
    tab === 'image' ? images : tab === 'media' ? [...videos, ...audios, ...segments] : refined;

  const renderRow = (x: { it: SniffItem; type: string }, idx: number) => {
    const { it, type } = x;
    return React.createElement(
      'div',
      {
        key: `${it.url}-${idx}`,
        className:
          'flex gap-2 p-2 rounded-xl hover:bg-neutral-100 dark:hover:bg-stone-700/50',
      },
      React.createElement(
        'div',
        {
          className:
            'w-14 h-9 shrink-0 rounded-lg overflow-hidden bg-neutral-200 dark:bg-stone-700 flex items-center justify-center',
        },
        type === 'image'
          ? React.createElement('img', {
              src: it.url,
              alt: '',
              className: 'w-full h-full object-cover',
              loading: 'lazy',
              referrerPolicy: 'no-referrer',
            })
          : React.createElement('span', { className: 'text-[10px] text-neutral-400' }, type),
      ),
      React.createElement(
        'div',
        { className: 'flex-1 min-w-0' },
        React.createElement(
          'p',
          { className: 'text-[11px] text-neutral-700 dark:text-stone-200 truncate', title: it.url },
          it.url,
        ),
        React.createElement(
          'p',
          { className: 'text-[10px] text-neutral-400 dark:text-stone-500' },
          [type, it.it || null, it.w && it.h ? `${it.w}×${it.h}` : null].filter(Boolean).join(' · '),
        ),
      ),
      onDownload &&
        React.createElement(
          'button',
          {
            onClick: () => onDownload(it),
            className:
              'shrink-0 self-center inline-flex p-1.5 rounded-lg text-neutral-400 hover:text-[var(--element-color-raw)] hover:bg-black/5 dark:hover:bg-white/5',
            title: '下载',
          },
          React.createElement(DownloadIcon, { size: 14 }),
        ),
    );
  };

  const tabBtn = (key: 'media' | 'image' | 'all', label: string, count: number) =>
    React.createElement(
      'button',
      {
        key,
        onClick: () => setTab(key),
        className: `px-2 py-0.5 rounded-md text-[10px] transition-colors ${
          tab === key
            ? 'bg-black/10 dark:bg-white/15 text-neutral-800 dark:text-stone-100'
            : 'text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10'
        }`,
      },
      `${label} ${count}`,
    );

  return React.createElement(
    'div',
    { className: 'relative flex-1 min-h-0 flex flex-col overflow-hidden' },
    // ===== 工具条 =====
    React.createElement(
      'div',
      {
        className:
          'shrink-0 flex flex-wrap items-center gap-2 px-3 py-2 border-b border-neutral-200/60 dark:border-stone-700/60 bg-white/70 dark:bg-stone-800/70 backdrop-blur',
      },
      React.createElement(
        'span',
        { className: 'inline-flex shrink-0', style: { color: platform.accent } },
        React.createElement(GlobeIcon, { size: 16 }),
      ),
      React.createElement(
        'div',
        {
          className:
            'flex items-center gap-2 flex-1 min-w-[140px] bg-neutral-100 dark:bg-stone-700 rounded-xl px-3 py-1.5',
        },
        React.createElement(
          'span',
          { className: 'inline-flex text-neutral-400' },
          React.createElement(SearchIcon, { size: 14 }),
        ),
        React.createElement('input', {
          value: url,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setUrl(e.target.value),
          onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') go();
          },
          placeholder: `输入网址后回车（例：${platform.home}）`,
          className:
            'flex-1 min-w-0 bg-transparent text-xs text-neutral-700 dark:text-stone-200 outline-none',
        }),
      ),
      React.createElement(
        'button',
        {
          onClick: () => go(),
          disabled: busy,
          className: 'btn-press shrink-0 px-3 py-1.5 rounded-xl text-xs text-white disabled:opacity-50',
          style: { background: platform.accent },
        },
        busy ? '打开中…' : '前往',
      ),
      React.createElement(
        'button',
        {
          onClick: focusBrowser,
          className:
            'btn-press shrink-0 px-3 py-1.5 rounded-lg text-xs text-neutral-600 dark:text-stone-300 hover:bg-neutral-100 dark:hover:bg-stone-700',
        },
        '回到浏览器',
      ),
      React.createElement(
        'button',
        {
          onClick: doSniff,
          disabled: busy,
          className: 'btn-press shrink-0 px-3 py-1.5 rounded-xl text-xs text-white disabled:opacity-50',
          style: { background: drawerOpen ? '#6b7280' : platform.accent },
        },
        drawerOpen ? '收起嗅探' : '嗅探',
      ),
      extraActions,
      windowOpen &&
        React.createElement(
          'button',
          {
            onClick: closeBrowser,
            className:
              'btn-press shrink-0 px-2 py-1.5 rounded-lg text-xs text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30',
            title: '关闭浏览器窗口（登录状态不受影响）',
          },
          '关闭窗口',
        ),
    ),
    // ===== 提示 / 错误 / 状态 =====
    notice &&
      React.createElement(
        'div',
        { className: 'shrink-0 px-3 py-1.5 text-xs text-sky-700 dark:text-sky-300 bg-sky-50/70 dark:bg-sky-950/30' },
        notice,
      ),
    error &&
      React.createElement(
        'div',
        { className: 'shrink-0 px-3 py-1.5 text-xs text-red-500 bg-red-50/60 dark:bg-red-950/30 break-all' },
        `打开失败：${error}`,
      ),
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
    // ===== 主体：占位卡片 + 嗅探抽屉 =====
    React.createElement(
      'div',
      { className: 'flex-1 flex min-h-0' },
      React.createElement(
        'div',
        {
          className:
            'flex-1 min-w-0 flex flex-col items-center justify-center gap-3 p-8 bg-white dark:bg-stone-900',
        },
        React.createElement(
          'span',
          { className: 'inline-flex', style: { color: platform.accent } },
          React.createElement(GlobeIcon, { size: 40 }),
        ),
        React.createElement(
          'p',
          { className: 'text-sm font-medium text-neutral-700 dark:text-stone-200' },
          `${platform.name} 在独立浏览器窗口中打开`,
        ),
        React.createElement(
          'p',
          {
            className:
              'text-xs text-neutral-400 dark:text-stone-500 max-w-md text-center leading-relaxed',
          },
          platform.note ||
            '网页、登录与播放都由官方站点自己完成；本窗口只负责发起打开与资源嗅探。',
        ),
        React.createElement(
          'div',
          { className: 'flex items-center gap-2 mt-1' },
          React.createElement(
            'button',
            {
              onClick: focusBrowser,
              className: 'btn-press px-4 py-2 rounded-xl text-sm text-white',
              style: { background: platform.accent },
            },
            '回到浏览器窗口',
          ),
          React.createElement(
            'button',
            {
              onClick: () => go(),
              className:
                'btn-press px-4 py-2 rounded-xl text-sm bg-neutral-100 dark:bg-stone-700 text-neutral-600 dark:text-stone-300',
            },
            current ? '重新加载' : '打开',
          ),
          // 站点被网络阻断时的兜底：交给系统浏览器（它用的是用户自己的代理设置）
          React.createElement(
            'button',
            {
              onClick: () => {
                void hostApi()
                  .invoke('browser_open_external', { url: current || platform.home })
                  .catch((e: unknown) => setError(`调起系统浏览器失败：${errText(e)}`));
              },
              className:
                'btn-press px-4 py-2 rounded-xl text-sm bg-neutral-100 dark:bg-stone-700 text-neutral-600 dark:text-stone-300',
              title: '用系统默认浏览器打开（跟随你浏览器里的代理设置）',
            },
            '系统浏览器打开',
          ),
        ),
        platform.needsProxy &&
          React.createElement(
            'p',
            {
              className:
                'text-[11px] text-amber-600/90 dark:text-amber-400/90 max-w-md text-center leading-relaxed mt-2',
            },
            '这个站点在部分网络环境需要代理。内嵌浏览器跟随 Windows 系统代理；' +
              '若你的梯子是「规则模式」或只对浏览器生效，请把该域名加入代理规则（或开 TUN），' +
              '也可以直接用上面的「系统浏览器打开」。',
          ),
      ),
      drawerOpen &&
        React.createElement(
          'div',
          {
            className:
              'w-80 shrink-0 border-l border-neutral-200/60 dark:border-stone-700/60 flex flex-col bg-white/95 dark:bg-stone-800/95',
          },
          React.createElement(
            'div',
            {
              className:
                'shrink-0 flex items-center gap-2 px-3 py-2 border-b border-neutral-200/60 dark:border-stone-700/60',
            },
            React.createElement(
              'span',
              { className: 'text-xs font-medium text-neutral-700 dark:text-stone-200' },
              `嗅探资源 ${items.length}`,
            ),
            React.createElement(
              'button',
              {
                onClick: () => setDrawerOpen(false),
                className:
                  'ml-auto inline-flex text-neutral-400 hover:text-neutral-700 dark:hover:text-stone-200',
                title: '收起',
              },
              React.createElement(CloseIcon, { size: 14 }),
            ),
          ),
          React.createElement(
            'div',
            { className: 'shrink-0 flex items-center gap-1 px-2 pb-1.5' },
            tabBtn('media', '媒体', videos.length + audios.length + segments.length),
            tabBtn('image', '图片', images.length),
            tabBtn('all', '全部', refined.length),
            others.length > 0 &&
              React.createElement(
                'span',
                { className: 'text-[10px] text-neutral-300 dark:text-stone-600 ml-auto' },
                `其它 ${others.length}`,
              ),
          ),
          React.createElement(
            'div',
            { className: 'flex-1 overflow-y-auto p-1.5 space-y-0.5' },
            items.length === 0
              ? React.createElement(
                  'p',
                  {
                    className:
                      'text-xs text-neutral-400 dark:text-stone-500 p-3 leading-relaxed',
                  },
                  '暂无资源。先在浏览器窗口里打开视频页并点一下播放，再点「嗅探」。',
                )
              : shown.map(renderRow),
          ),
        ),
    ),
  );
}

export default WebBrowserShell;
