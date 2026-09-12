/// <reference path="../../global.d.ts" />
// 内嵌网页平台视图（腾讯视频 / 爱奇艺）：仅做"应用内浏览器"，不原生取流（DRM 限制）。
// 新增资源嗅探：在网页内嗅探视频/图片/资源，用户多选下载（m3u8 经 ffmpeg 转 mp4）。
import React from 'react';
import type { VideoPlatform } from './videoPlatforms';
import VideoWebview from './VideoWebview';
import { GlobeIcon } from './onlineIcons';
import { SnifferPanel } from './SnifferPanel';

const { useState, useEffect, useRef, useCallback } = React;

interface Props { platform: VideoPlatform; }

export function WebviewPlatformView({ platform }: Props) {
  const [url, setUrl] = useState(platform.home);
  const [navOpen, setNavOpen] = useState(false);
  const [sniffOpen, setSniffOpen] = useState(false);
  const handleRef = useRef<{ evalJs: (code: string) => Promise<string> } | null>(null);

  const onReady = useCallback((h: { evalJs: (code: string) => Promise<string> }) => {
    handleRef.current = h;
  }, []);
  const sniffEval = useCallback((code: string) => {
    if (handleRef.current) return handleRef.current.evalJs(code);
    return Promise.reject(new Error('网页尚未就绪，请稍候再试'));
  }, []);

  const [draft, setDraft] = useState(platform.home);
  useEffect(() => { setDraft(platform.home); }, [platform.home]);

  return React.createElement('div', { className: 'absolute inset-0 flex flex-col' },
    React.createElement('div', { className: 'shrink-0 flex items-center gap-2 px-3 py-2 border-b border-neutral-200/60 dark:border-stone-700/60 bg-white/70 dark:bg-stone-800/70 backdrop-blur' },
      React.createElement(GlobeIcon, { size: 16, className: 'text-neutral-500' }),
      React.createElement('span', { className: 'text-sm font-medium truncate', style: { color: platform.accent } }, platform.name),
      React.createElement('span', { className: 'text-xs text-neutral-400 dark:text-stone-500 truncate' }, platform.desc),
      React.createElement('div', { className: 'flex-1' }),
      React.createElement('button', {
        onClick: () => setSniffOpen((v) => !v),
        className: 'btn-press px-2 py-1 rounded-lg text-xs text-white',
        style: { background: platform.accent },
      }, '嗅探'),
      React.createElement('button', {
        onClick: () => setNavOpen((v) => !v),
        className: 'btn-press px-2 py-1.5 rounded-lg text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-stone-700 transition-colors',
      }, '地址'),
    ),
    navOpen && React.createElement('div', { className: 'shrink-0 flex items-center gap-2 px-3 py-2 border-b border-neutral-200/60 dark:border-stone-700/60' },
      React.createElement('input', {
        value: draft,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value),
        onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') setUrl(draft); },
        className: 'flex-1 text-xs bg-white dark:bg-stone-700 border border-neutral-200 dark:border-stone-600 rounded-lg px-2 py-1.5 text-neutral-700 dark:text-stone-200',
        placeholder: 'https://',
      }),
      React.createElement('button', {
        onClick: () => setUrl(draft),
        className: 'btn-press px-3 py-1.5 rounded-lg text-xs text-white',
        style: { background: platform.accent },
      }, '前往'),
    ),
    React.createElement('div', { className: 'relative flex-1' },
      React.createElement(VideoWebview, { label: `video-webview-${platform.id}`, url, onReady }),
    ),
    sniffOpen && React.createElement(SnifferPanel, { evalJs: sniffEval, referer: platform.home, onClose: () => setSniffOpen(false) }),
  );
}

export default WebviewPlatformView;
