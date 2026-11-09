/// <reference path="../../../global.d.ts" />
// 网络视频 · 平台页面板（薄封装）
//
// 浏览/登录/嗅探都交给共享壳 `@shared/WebBrowserShell`（图片模块的 pixiv 用的是同一套），
// 这里只补视频特有的两件事：
//   1. 下载目录（localStorage: video_download_dir）；
//   2. 把嗅探到的资源丢进 videoDownloadManager（下载队列在左侧「网络视频」侧栏里展示）。
import React from 'react';
import { WebBrowserShell, type SniffItem } from '@shared/WebBrowserShell';
import { videoDownloadManager, VIDEO_DOWNLOAD_DIR_KEY } from './OnlineVideoDownloadManager';
import { pickDownloadDir } from './pickDir';
import type { VideoPlatform } from './videoPlatforms';

const { useState } = React;

interface Props {
  platform: VideoPlatform;
}

export function BrowserPanel({ platform }: Props) {
  const [dlDir, setDlDir] = useState(localStorage.getItem(VIDEO_DOWNLOAD_DIR_KEY) || '');

  // ⚠ 这里**不做**卸载即关闭窗口的清理：
  //   切换平台会把旧面板卸载掉，若在这里关窗，用户就永远只能同时开一个平台
  //   （这正是之前「没办法同时打开 bili 和抖音」的原因）。
  //   窗口的生命周期交给两处：面板上的「关闭窗口」按钮，以及离开整个网络视频视图时
  //   由 OnlineVideoView 统一关闭。

  const pickDir = async () => {
    const r = await pickDownloadDir();
    if (r) {
      localStorage.setItem(VIDEO_DOWNLOAD_DIR_KEY, r);
      setDlDir(r);
    }
  };

  const enqueue = (item: SniffItem) => {
    if (!dlDir) return;
    const isHls = /\.m3u8(\?|#|$)/i.test(item.url);
    videoDownloadManager.enqueue([
      {
        title: decodeURIComponent(item.url.split('/').pop()?.split('?')[0] || 'resource').slice(0, 60),
        ref: item.url,
        kind: isHls ? 'hls' : 'direct',
        platformId: platform.id,
        referer: item.page,
        subDir: `来自${platform.name}`,
      },
    ]);
  };

  return React.createElement(WebBrowserShell, {
    platform: {
      id: platform.id,
      name: platform.name,
      home: platform.home,
      accent: platform.accent,
      note: platform.note,
    },
    // 没有下载目录时不给下载按钮，避免「点了没反应」
    onDownload: dlDir ? enqueue : undefined,
    extraActions: React.createElement(
      'button',
      {
        onClick: pickDir,
        className:
          'btn-press shrink-0 px-2 py-1.5 rounded-lg text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-stone-700',
        title: '下载目录（嗅探到的直链会存到这里）',
      },
      dlDir ? '目录✓' : '目录',
    ),
  });
}

export default BrowserPanel;
