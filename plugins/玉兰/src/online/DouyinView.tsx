/// <reference path="../../global.d.ts" />
// 抖音 · 特殊视图
// 抖音无稳定公开 Web API、且播放地址强加密，无法像 B 站那样原生取流。
// 特殊处理方式：
//  1) 内嵌网页浏览抖音（用户自行找到想看的视频）；
//  2) 粘贴抖音「分享链接」→ 在网页内打开；
//  3) 点「提取当前视频」→ 对内嵌网页执行 eval 读取 <video> 的直链，
//     若拿到真实 http(s) 地址（非 blob:）则交给我们的播放器去广告播放。
// 注：抖音多数页面视频为 blob/加密流，提取可能失败，属预期（DRM 限制）。
import React from 'react';
import { VideoWebview } from './VideoWebview';
import type { OnlineVideoItem } from './videoPlatforms';
import { CloudIcon, PlayIcon, GlobeIcon } from './onlineIcons';

const { useState, useRef, useCallback } = React;

interface Props {
  onPlayVideo: (item: OnlineVideoItem) => void;
}

export function DouyinView({ onPlayVideo }: Props) {
  const [shareLink, setShareLink] = useState('');
  const [url, setUrl] = useState('https://www.douyin.com');
  const [note, setNote] = useState<string | null>(null);
  const handleRef = useRef<{ evalJs: (code: string) => Promise<string> } | null>(null);

  const onReady = useCallback((h: { evalJs: (code: string) => Promise<string> }) => {
    handleRef.current = h;
  }, []);

  const openShare = () => {
    const link = shareLink.trim();
    if (!link) return;
    // 兼容 v.douyin.com 短链与 www.douyin.com/video/xxx 长链
    setUrl(link.startsWith('http') ? link : `https://${link}`);
    setNote(null);
  };

  const extract = async () => {
    const h = handleRef.current;
    if (!h) {
      setNote('网页尚未就绪，请稍候再试');
      return;
    }
    try {
      const src = await h.evalJs(
        `(() => { const v = document.querySelector('video'); if(!v) return 'NO_VIDEO'; const s = v.src || v.currentSrc || ''; return s || 'NO_SRC'; })()`,
      );
      if (!src || src === 'NO_VIDEO') {
        setNote('当前页面未检测到视频元素');
      } else if (src === 'NO_SRC' || src.startsWith('blob:')) {
        setNote('该视频为加密/blob 流，无法直接提取（抖音 DRM 限制）');
      } else {
        onPlayVideo({ id: `douyin-${Date.now()}`, title: '抖音视频', url: src, meta: { from: 'douyin' } });
        setNote('已提取直链，正在用我们的播放器打开（去广告）');
      }
    } catch (e: unknown) {
      setNote(`提取失败：${String(e)}`);
    }
  };

  return React.createElement('div', { className: 'absolute inset-0 flex flex-col' },
    React.createElement('div', { className: 'shrink-0 flex items-center gap-2 px-4 py-3 border-b border-neutral-200/60 dark:border-stone-700/60 bg-white/70 dark:bg-stone-800/70 backdrop-blur' },
      React.createElement(CloudIcon, { size: 16, style: { color: '#161823' } }),
      React.createElement('span', { className: 'text-sm font-semibold', style: { color: '#161823' } }, '抖音'),
      React.createElement('div', { className: 'flex-1 flex items-center gap-2 max-w-xl' },
        React.createElement('div', { className: 'flex items-center gap-2 flex-1 bg-neutral-100 dark:bg-stone-700 rounded-xl px-3 py-1.5' },
          React.createElement(GlobeIcon, { size: 16, className: 'text-neutral-400' }),
          React.createElement('input', {
            value: shareLink,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => setShareLink(e.target.value),
            onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') openShare(); },
            placeholder: '粘贴抖音分享链接…',
            className: 'flex-1 bg-transparent text-sm text-neutral-700 dark:text-stone-200 outline-none',
          }),
        ),
        React.createElement('button', {
          onClick: openShare,
          className: 'btn-press px-3 py-1.5 rounded-xl text-sm text-white',
          style: { background: '#161823' },
        }, '打开'),
      ),
      React.createElement('button', {
        onClick: extract,
        className: 'btn-press flex items-center gap-1 px-3 py-1.5 rounded-xl text-sm text-white',
        style: { background: '#fe2c55' },
      }, React.createElement(PlayIcon, { size: 14 }), '提取当前视频'),
    ),
    note && React.createElement('div', { className: 'shrink-0 px-4 py-1.5 text-xs text-amber-600 dark:text-amber-400 bg-amber-50/60 dark:bg-amber-950/30' }, note),
    React.createElement('div', { className: 'relative flex-1' },
      React.createElement(VideoWebview, { label: 'video-webview-douyin', url, onReady }),
    ),
  );
}

export default DouyinView;
