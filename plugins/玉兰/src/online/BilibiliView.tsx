/// <reference path="../../global.d.ts" />
// 哔哩哔哩原生视图：搜索 → 取真实播放地址 → 我们的播放器（去广告）；支持下载。
import React from 'react';
import { searchBili, resolveBili, type BiliSearchResult } from './bilibiliApi';
import { videoDownloadManager, VIDEO_DOWNLOAD_DIR_KEY, type VideoDownloadTask } from './OnlineVideoDownloadManager';
import type { OnlineVideoItem } from './videoPlatforms';
import { SearchIcon, PlayIcon, DownloadIcon, CloudIcon } from './onlineIcons';

const { useState, useEffect, useRef } = React;

const QUALITIES: { qn: number; label: string }[] = [
  { qn: 16, label: '360P' },
  { qn: 32, label: '480P' },
  { qn: 64, label: '720P' },
  { qn: 80, label: '1080P' },
];

interface Props {
  onPlayVideo: (item: OnlineVideoItem) => void;
}

export function BilibiliView({ onPlayVideo }: Props) {
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<BiliSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qn, setQn] = useState(80);
  const [showDownloads, setShowDownloads] = useState(false);
  const [dlQueue, setDlQueue] = useState<VideoDownloadTask[]>([]);
  const [dlDir, setDlDir] = useState(localStorage.getItem(VIDEO_DOWNLOAD_DIR_KEY) || '');

  useEffect(() => {
    const unsub = videoDownloadManager.subscribe(setDlQueue);
    return unsub;
  }, []);

  const doSearch = async () => {
    const kw = keyword.trim();
    if (!kw) return;
    setLoading(true);
    setError(null);
    try {
      const r = await searchBili(kw, 1);
      setResults(r);
      if (r.length === 0) setError('没有找到相关视频');
    } catch (e: unknown) {
      setError(String(e));
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const handlePlay = async (item: BiliSearchResult) => {
    try {
      const info = await resolveBili(item);
      onPlayVideo({
        id: item.id,
        title: item.title,
        author: item.author,
        cover: item.cover,
        url: info.url,
        meta: { bvid: item.id },
      });
    } catch (e: unknown) {
      alert(`播放失败：${String(e)}`);
    }
  };

  const handleDownload = (item: BiliSearchResult) => {
    if (!dlDir) {
      alert('请先设置下载目录（右上角「目录」）');
      return;
    }
    videoDownloadManager.enqueue([{ title: item.title, url: item.id, kind: 'bili', subDir: '来自哔哩哔哩' }]);
    setShowDownloads(true);
  };

  const pickDir = async () => {
    try {
      const r = await (window as any).__HOST_API__?.invoke?.('open_download_dir_dialog', {});
      if (r) {
        localStorage.setItem(VIDEO_DOWNLOAD_DIR_KEY, r);
        setDlDir(r);
      }
    } catch {
      const v = prompt('输入下载目录（视频将存到 <目录>/来自哔哩哔哩/）：');
      if (v) {
        localStorage.setItem(VIDEO_DOWNLOAD_DIR_KEY, v);
        setDlDir(v);
      }
    }
  };

  return React.createElement('div', { className: 'absolute inset-0 flex flex-col' },
    // 顶部工具条
    React.createElement('div', { className: 'shrink-0 flex items-center gap-2 px-4 py-3 border-b border-neutral-200/60 dark:border-stone-700/60 bg-white/70 dark:bg-stone-800/70 backdrop-blur' },
      React.createElement(CloudIcon, { size: 16, style: { color: '#fb7299' } }),
      React.createElement('span', { className: 'text-sm font-semibold', style: { color: '#fb7299' } }, '哔哩哔哩'),
      React.createElement('div', { className: 'flex-1 flex items-center gap-2 max-w-xl' },
        React.createElement('div', { className: 'flex items-center gap-2 flex-1 bg-neutral-100 dark:bg-stone-700 rounded-xl px-3 py-1.5' },
          React.createElement(SearchIcon, { size: 16, className: 'text-neutral-400' }),
          React.createElement('input', {
            value: keyword,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => setKeyword(e.target.value),
            onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') doSearch(); },
            placeholder: '搜索 B 站视频…',
            className: 'flex-1 bg-transparent text-sm text-neutral-700 dark:text-stone-200 outline-none',
          }),
        ),
        React.createElement('button', {
          onClick: doSearch,
          className: 'btn-press px-3 py-1.5 rounded-xl text-sm text-white',
          style: { background: '#fb7299' },
        }, '搜索'),
      ),
      React.createElement('select', {
        value: qn,
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setQn(Number(e.target.value)),
        className: 'text-xs bg-white dark:bg-stone-700 border border-neutral-200 dark:border-stone-600 rounded-lg px-2 py-1.5 text-neutral-700 dark:text-stone-200',
        title: '清晰度（游客态可能受限）',
      }, QUALITIES.map((q) => React.createElement('option', { key: q.qn, value: q.qn }, q.label))),
      React.createElement('button', {
        onClick: pickDir,
        className: 'btn-press px-2 py-1.5 rounded-lg text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-stone-700 transition-colors',
        title: '下载目录',
      }, dlDir ? '目录✓' : '目录'),
      React.createElement('button', {
        onClick: () => setShowDownloads(v => !v),
        className: 'btn-press px-2 py-1.5 rounded-lg text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-stone-700 transition-colors',
      }, `下载(${dlQueue.filter(q => q.status === 'downloading' || q.status === 'queued').length})`),
    ),
    // 主体
    React.createElement('div', { className: 'relative flex-1 overflow-hidden' },
      React.createElement('div', { className: 'absolute inset-0 overflow-y-auto p-4' },
        error && React.createElement('p', { className: 'text-sm text-red-500 mb-3' }, error),
        loading && React.createElement('p', { className: 'text-sm text-neutral-400 dark:text-stone-500' }, '搜索中…'),
        !loading && results.length === 0 && !error && React.createElement('p', { className: 'text-sm text-neutral-400 dark:text-stone-500' }, '搜索你想要的 B 站视频，点击即去广告播放，或下载到本地。'),
        React.createElement('div', { className: 'grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-4' },
          results.map((it) => React.createElement('div', {
            key: it.id,
            className: 'group rounded-2xl overflow-hidden border border-neutral-200/70 dark:border-stone-700/60 bg-white dark:bg-stone-800/60 hover:shadow-md transition-shadow',
          },
            React.createElement('div', { className: 'relative aspect-video bg-neutral-100 dark:bg-stone-700' },
              it.cover && React.createElement('img', { src: it.cover, alt: '', className: 'w-full h-full object-cover' }),
              React.createElement('span', { className: 'absolute bottom-1 right-1 text-[10px] px-1 rounded bg-black/60 text-white' }, it.durationText),
              React.createElement('button', {
                onClick: () => handlePlay(it),
                className: 'absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/30 transition-opacity',
                title: '播放',
              }, React.createElement(PlayIcon, { size: 32, className: 'text-white' })),
            ),
            React.createElement('div', { className: 'p-2.5' },
              React.createElement('p', { className: 'text-sm font-medium text-neutral-800 dark:text-stone-100 line-clamp-2 leading-snug', title: it.title }, it.title),
              React.createElement('p', { className: 'text-xs text-neutral-400 dark:text-stone-500 mt-1 truncate' }, it.author || ''),
              React.createElement('button', {
                onClick: () => handleDownload(it),
                className: 'mt-2 flex items-center gap-1 text-xs text-[#fb7299] hover:underline',
              }, React.createElement(DownloadIcon, { size: 13 }), '下载'),
            ),
          )),
        ),
      ),
      // 下载队列浮层
      showDownloads && React.createElement('div', { className: 'absolute right-3 top-3 w-80 max-h-[70%] overflow-y-auto rounded-2xl border border-neutral-200/70 dark:border-stone-700/60 bg-white/95 dark:bg-stone-800/95 backdrop-blur shadow-xl p-3 z-20' },
        React.createElement('div', { className: 'flex items-center justify-between mb-2' },
          React.createElement('span', { className: 'text-sm font-medium text-neutral-800 dark:text-stone-100' }, '下载队列'),
          React.createElement('button', { onClick: () => setShowDownloads(false), className: 'text-xs text-neutral-400 hover:text-neutral-700' }, '关闭'),
        ),
        dlQueue.length === 0
          ? React.createElement('p', { className: 'text-xs text-neutral-400' }, '暂无任务')
          : dlQueue.map((q) => {
              const pct = q.total > 0 ? Math.min(100, Math.round((q.downloaded / q.total) * 100)) : q.status === 'done' ? 100 : 0;
              return React.createElement('div', { key: q.id, className: 'mb-2' },
                React.createElement('div', { className: 'flex items-center gap-2' },
                  React.createElement('span', { className: 'text-xs flex-1 truncate text-neutral-700 dark:text-stone-200' }, q.title),
                  React.createElement('span', { className: 'text-[10px] text-neutral-400' },
                    q.status === 'downloading' ? `${pct}%` : q.status === 'done' ? '完成' : q.status === 'error' ? '失败' : '排队'),
                ),
                React.createElement('div', { className: 'h-1 mt-1 rounded bg-neutral-200 dark:bg-stone-600 overflow-hidden' },
                  React.createElement('div', { className: 'h-full bg-[#fb7299]', style: { width: `${pct}%` } }),
                ),
                q.status === 'error' && React.createElement('p', { className: 'text-[10px] text-red-500 truncate' }, q.error),
              );
            }),
      ),
    ),
  );
}

export default BilibiliView;
