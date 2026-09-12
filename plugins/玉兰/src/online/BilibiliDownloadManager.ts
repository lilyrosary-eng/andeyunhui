/// <reference path="../../global.d.ts" />
// 哔哩哔哩下载管理器（对齐音乐模块 NeteaseDownloadManager）
// 流程：入队 → 解析真实播放地址（resolveBili）→ 调宿主 download_file 落地到本地。
// 下载目录存 localStorage，落到「<目录>/来自哔哩哔哩/」。
import { resolveBili } from './bilibiliApi';
import type { OnlineVideoItem } from './videoPlatforms';

const hostApi: any = (window as any).__HOST_API__ || { invoke: async () => {}, listen: async () => () => {} };

export const BILIBILI_DOWNLOAD_DIR_KEY = 'bilibili_download_dir';

export type BiliDlStatus = 'queued' | 'downloading' | 'done' | 'error' | 'canceled';

export interface BilibiliDownloadItem {
  id: string;
  title: string;
  status: BiliDlStatus;
  downloaded: number;
  total: number;
  speed: number;
  error?: string;
  url?: string;
}

type Listener = (q: BilibiliDownloadItem[]) => void;

class BilibiliDownloadManager {
  private queue: BilibiliDownloadItem[] = [];
  private listeners = new Set<Listener>();
  private running = false;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn([...this.queue]);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    const snap = [...this.queue];
    this.listeners.forEach((l) => l(snap));
  }

  getQueue(): BilibiliDownloadItem[] {
    return [...this.queue];
  }

  clearFinished() {
    this.queue = this.queue.filter((q) => q.status !== 'done' && q.status !== 'error' && q.status !== 'canceled');
    this.emit();
  }

  enqueue(items: OnlineVideoItem[], quality = 80) {
    for (const it of items) {
      this.queue.unshift({
        id: `${it.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        title: it.title,
        status: 'queued',
        downloaded: 0,
        total: 0,
        speed: 0,
      });
    }
    this.emit();
    this.pump(quality);
  }

  private async pump(quality: number) {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const task = this.queue.find((q) => q.status === 'queued');
        if (!task) break;
        await this.runOne(task, quality);
      }
    } finally {
      this.running = false;
    }
  }

  private async runOne(task: BilibiliDownloadItem, quality: number) {
    const item: OnlineVideoItem = { id: task.id.split('-')[0], title: task.title };
    task.status = 'downloading';
    this.emit();
    try {
      const info = await resolveBili({ ...item, meta: { bvid: task.id.split('-')[0] } });
      task.url = info.url;
      const dir = localStorage.getItem(BILIBILI_DOWNLOAD_DIR_KEY) || '';
      if (!dir) {
        throw new Error('未设置下载目录（在哔哩哔哩设置里选择）');
      }
      const safe = (task.title || 'video').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
      const savePath = `${dir}/来自哔哩哔哩/${safe}.mp4`;
      const taskId = `${task.id}-${Date.now()}`;
      const progressEvent = `bilibili-download-progress-${taskId}`;
      const unlisten = await hostApi.listen?.(progressEvent, (e: any) => {
        const p = e?.payload || {};
        task.downloaded = p.downloaded || task.downloaded;
        task.total = p.total || task.total;
        task.speed = p.speed || 0;
        this.emit();
      });
      await hostApi.invoke('download_file', { url: info.url, savePath, progressEvent });
      if (unlisten) unlisten();
      task.status = 'done';
      task.speed = 0;
    } catch (e: unknown) {
      task.status = 'error';
      task.error = String(e);
      task.speed = 0;
    }
    this.emit();
  }
}

export const bilibiliDownloadManager = new BilibiliDownloadManager();
