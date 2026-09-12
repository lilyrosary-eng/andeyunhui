/// <reference path="../../global.d.ts" />
// 网络视频 · 嗅探结果面板
// 展示 sniffResources 收集到的资源（按 视频/音频/图片/其他 分组），用户多选后：
//  - 直链（含 mp4/图片/音频/文件）→ download_video
//  - m3u8 → download_hls（ffmpeg 转封装 mp4，带 referer 头）
import React from 'react';
import { sniffResources, type SniffResource } from './sniff';
import { videoDownloadManager, VIDEO_DOWNLOAD_DIR_KEY } from './OnlineVideoDownloadManager';
import { SearchIcon, DownloadIcon, CloseIcon } from './onlineIcons';

const { useState } = React;

interface Props {
  /** 稳定的 eval 函数：在 webview 内执行 JS（网页未就绪时 reject） */
  evalJs: (code: string) => Promise<string>;
  /** m3u8 转封装需要的 Referer（通常传平台首页域） */
  referer?: string;
  onClose: () => void;
}

export function SnifferPanel({ evalJs, referer, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<SniffResource[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [dir, setDir] = useState(localStorage.getItem(VIDEO_DOWNLOAD_DIR_KEY) || '');
  const [msg, setMsg] = useState<string | null>(null);

  const doSniff = async () => {
    setLoading(true);
    setMsg(null);
    try {
      const res = await sniffResources(evalJs);
      setItems(res);
      setChecked(new Set(res.map((r) => r.url)));
      if (res.length === 0) setMsg('未嗅探到媒体资源（可能是加密/blob 流，或页面暂无媒体元素；可先播放视频再嗅探）');
    } catch (e: unknown) {
      setMsg(`嗅探失败：${String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const toggle = (url: string) =>
    setChecked((prev) => {
      const n = new Set(prev);
      if (n.has(url)) n.delete(url);
      else n.add(url);
      return n;
    });

  const pickDir = async () => {
    try {
      const r = await (window as any).__HOST_API__?.invoke?.('open_download_dir_dialog', {});
      if (r) {
        localStorage.setItem(VIDEO_DOWNLOAD_DIR_KEY, r);
        setDir(r);
      }
    } catch {
      const v = prompt('输入下载目录（资源将存到 <目录>/来自网络视频/ 或 /来自哔哩哔哩/）：');
      if (v) {
        localStorage.setItem(VIDEO_DOWNLOAD_DIR_KEY, v);
        setDir(v);
      }
    }
  };

  const downloadSelected = () => {
    if (!dir) {
      setMsg('请先设置下载目录（右下角「目录」）');
      return;
    }
    const sel = items.filter((r) => checked.has(r.url));
    if (sel.length === 0) {
      setMsg('未选择任何资源');
      return;
    }
    const tasks = sel.map((r) => ({
      title: r.url.split('/').pop()?.split('?')[0] || r.url,
      url: r.url,
      kind: (r.type === 'video' && r.ext === 'm3u8') ? ('hls' as const) : ('direct' as const),
      referer: referer || undefined,
    }));
    videoDownloadManager.enqueue(tasks);
    setMsg(`已加入下载队列：${sel.length} 个`);
  };

  const groups: Array<[SniffResource['type'], string]> = [
    ['video', '视频'],
    ['audio', '音频'],
    ['image', '图片'],
    ['other', '其他'],
  ];

  return React.createElement(
    'div',
    { className: 'absolute inset-0 z-30 flex flex-col bg-white/95 dark:bg-stone-800/95 backdrop-blur shadow-xl' },
    React.createElement(
      'div',
      { className: 'flex items-center gap-2 px-3 py-2 border-b border-neutral-200/70 dark:border-stone-700/60' },
      React.createElement(SearchIcon, { size: 16, className: 'text-neutral-500' }),
      React.createElement('span', { className: 'text-sm font-medium flex-1' }, '资源嗅探'),
      React.createElement(
        'button',
        { onClick: doSniff, className: 'btn-press px-3 py-1.5 rounded-lg text-sm text-white bg-sky-500' },
        loading ? '嗅探中…' : '嗅探',
      ),
      React.createElement(
        'button',
        { onClick: onClose, className: 'p-1.5 rounded-lg text-neutral-400 hover:bg-neutral-100 dark:hover:bg-stone-700' },
        React.createElement(CloseIcon, { size: 16 }),
      ),
    ),
    msg &&
      React.createElement(
        'div',
        { className: 'px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400 bg-amber-50/60 dark:bg-amber-950/30' },
        msg,
      ),
    React.createElement(
      'div',
      { className: 'flex-1 overflow-y-auto p-3 space-y-3' },
      groups.map(([type, label]) => {
        const list = items.filter((r) => r.type === type);
        if (list.length === 0) return null;
        return React.createElement(
          'div',
          { key: type },
          React.createElement('p', { className: 'text-xs font-semibold text-neutral-500 dark:text-stone-400 mb-1' }, `${label} (${list.length})`),
          list.map((r) =>
            React.createElement(
              'label',
              { key: r.url, className: 'flex items-start gap-2 p-2 rounded-lg hover:bg-black/[0.03] dark:hover:bg-white/5 cursor-pointer' },
              React.createElement('input', { type: 'checkbox', checked: checked.has(r.url), onChange: () => toggle(r.url), className: 'mt-1' }),
              React.createElement(
                'div',
                { className: 'flex-1 min-w-0' },
                React.createElement('p', { className: 'text-xs text-neutral-700 dark:text-stone-200 break-all' }, r.url),
                React.createElement('span', { className: 'text-[10px] px-1 rounded bg-neutral-200 dark:bg-stone-600 text-neutral-500 dark:text-stone-300' }, r.ext || r.tag),
              ),
            ),
          ),
        );
      }),
      items.length === 0 &&
        !loading &&
        React.createElement('p', { className: 'text-sm text-neutral-400 dark:text-stone-500 text-center mt-8' }, '点击「嗅探」扫描当前网页的媒体资源'),
    ),
    React.createElement(
      'div',
      { className: 'shrink-0 flex items-center gap-2 px-3 py-2 border-t border-neutral-200/70 dark:border-stone-700/60' },
      React.createElement(
        'button',
        { onClick: pickDir, className: 'btn-press px-2 py-1.5 rounded-lg text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-stone-700' },
        dir ? '目录✓' : '目录',
      ),
      React.createElement('div', { className: 'flex-1' }),
      React.createElement(
        'button',
        { onClick: downloadSelected, className: 'btn-press flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm text-white bg-emerald-500' },
        React.createElement(DownloadIcon, { size: 14 }),
        '下载选中',
      ),
    ),
  );
}

export default SnifferPanel;
