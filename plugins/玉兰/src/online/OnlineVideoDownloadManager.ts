/// <reference path="../../global.d.ts" />
// 网络视频 · 通用下载管理器（对齐音乐模块 NeteaseDownloadManager 单例 + 订阅者模式）
//
// 支持三类资源：
//  - 'bili'  ：哔哩哔哩（先 resolveBili 取直链 → download_file 落地，子目录「来自哔哩哔哩」）
//  - 'direct'：嗅探直链视频/图片/文件（download_video 落地，子目录「来自网络视频」）
//  - 'hls'   ：嗅探到的 m3u8（download_hls 经 ffmpeg 转封装 mp4，子目录「来自网络视频」）
//
// 进度事件 payload 对齐音乐：{ downloaded, total, speed }（hls 阶段 total=0 表示不定长）。
import { resolveBili } from './bilibiliApi';
import type { OnlineVideoItem } from './videoPlatforms';

const hostApi: any = (window as any).__HOST_API__ || { invoke: async () => {}, listen: async () => () => {} };

export const VIDEO_DOWNLOAD_DIR_KEY = 'video_download_dir';
export type DlKind = 'bili' | 'direct' | 'hls';
export type DlStatus = 'queued' | 'downloading' | 'done' | 'error' | 'canceled';

export interface VideoDownloadResource {
  title: string;
  url: string;
  kind: DlKind;
  referer?: string;
  cookie?: string;
  /** 覆盖子目录（默认 bili→来自哔哩哔哩，其余→来自网络视频） */
  subDir?: string;
}

export interface VideoDownloadTask extends VideoDownloadResource {
  id: string;
  status: DlStatus;
  downloaded: number;
  total: number;
  speed: number;
  error?: string;
}

type Listener = (q: VideoDownloadTask[]) => void;

function safeName(s: string): string {
  return (s || 'video').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}
function extOf(url: string, kind: DlKind): string {
  if (kind === 'hls' || /\.m3u8(\?|$)/i.test(url)) return 'mp4';
  if (kind === 'bili') return 'mp4';
  const m = url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : 'mp4';
}
function subDirOf(kind: DlKind, sub?: string): string {
  if (sub) return sub;
  if (kind === 'bili') return '来自哔哩哔哩';
  return '来自网络视频';
}

class VideoDownloadManager {
  private queue: VideoDownloadTask[] = [];
  private listeners = new Set<Listener>();
  private running = 0;
  private maxConcurrent = 2;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn([...this.queue]);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    const snap = [...this.queue];
    this.listeners.forEach((l) => l(snap));
  }
  getQueue(): VideoDownloadTask[] {
    return [...this.queue];
  }
  clearFinished() {
    this.queue = this.queue.filter((q) => q.status !== 'done' && q.status !== 'error' && q.status !== 'canceled');
    this.emit();
  }

  enqueue(items: VideoDownloadResource[]) {
    for (const it of items) {
      this.queue.unshift({
        ...it,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        status: 'queued',
        downloaded: 0,
        total: 0,
        speed: 0,
      });
    }
    this.emit();
    this.pump();
  }

  private async pump() {
    while (this.running < this.maxConcurrent) {
      const task = this.queue.find((q) => q.status === 'queued');
      if (!task) break;
      this.running++;
      this.runOne(task).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async runOne(task: VideoDownloadTask) {
    task.status = 'downloading';
    this.emit();
    const dir = localStorage.getItem(VIDEO_DOWNLOAD_DIR_KEY) || '';
    if (!dir) {
      task.status = 'error';
      task.error = '未设置下载目录（在设置或平台视图里选择）';
      this.emit();
      return;
    }
    const safe = safeName(task.title);
    const sub = subDirOf(task.kind, task.subDir);
    const savePath = `${dir}/${sub}/${safe}.${extOf(task.url, task.kind)}`;
    const progressEvent = `video-dl-progress-${task.id}`;
    let unlisten: any = null;
    try {
      unlisten = await hostApi.listen?.(progressEvent, (e: any) => {
        const p = e?.payload || {};
        task.downloaded = p.downloaded || task.downloaded;
        task.total = p.total || task.total;
        task.speed = p.speed || 0;
        this.emit();
      });
      if (task.kind === 'bili') {
        const info = await resolveBili({ id: task.url, title: task.title, meta: {} } as OnlineVideoItem);
        await hostApi.invoke('download_file', { url: info.url, savePath, progressEvent });
      } else if (task.kind === 'hls') {
        await hostApi.invoke('download_hls', {
          m3u8Url: task.url,
          savePath,
          referer: task.referer || null,
          cookie: task.cookie || null,
          progressEvent,
        });
      } else {
        await hostApi.invoke('download_video', { url: task.url, savePath, progressEvent });
      }
      task.status = 'done';
    } catch (e: unknown) {
      task.status = 'error';
      task.error = String(e);
    } finally {
      if (unlisten) unlisten();
      task.speed = 0;
    }
    this.emit();
  }
}

export const videoDownloadManager = new VideoDownloadManager();
