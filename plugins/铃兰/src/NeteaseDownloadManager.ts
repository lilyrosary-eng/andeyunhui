// 网易云下载队列管理（轻量单例 + 订阅）。
// 与界面解耦：NeteaseView 的「下载」页订阅渲染，index.tsx 监听完成事件做自动入库。
/// <reference path="../../global.d.ts" />
import { downloadNeteaseTrack, getNeteaseQualityBr } from './neteaseApi';

export type NeteaseDownloadStatus = 'queued' | 'downloading' | 'done' | 'error' | 'canceled';

export interface NeteaseDownloadItem {
  id: string;
  songId: number;
  title: string;
  artist: string;
  br: number;
  fileName: string;
  savePath: string; // 完整落盘路径（含 <downloadDir>/来自网易云/ 前缀）
  status: NeteaseDownloadStatus;
  downloaded: number; // 字节
  total: number; // 字节（0 表示未知）
  speed: number; // 字节/秒
  error?: string;
}

export const NETEASE_DOWNLOAD_DIR_KEY = 'netease.downloadDir';

function getDownloadDir(): string {
  try {
    return localStorage.getItem(NETEASE_DOWNLOAD_DIR_KEY) || '';
  } catch {
    return '';
  }
}

// 由下载目录推导「来自网易云」目录，供 index.tsx 自动入库使用。
export function getNeteaseDownloadLibraryDir(): string {
  const dir = getDownloadDir().replace(/[\\/]+$/, '');
  return dir ? `${dir}/来自网易云` : '';
}

type Listener = (queue: NeteaseDownloadItem[]) => void;

class NeteaseDownloadManager {
  private queue: NeteaseDownloadItem[] = [];
  private listeners = new Set<Listener>();
  private running = 0;
  private readonly maxConcurrent = 2;

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    cb(this.snapshot());
    return () => this.listeners.delete(cb);
  }

  getQueue(): NeteaseDownloadItem[] {
    return this.snapshot();
  }

  private snapshot(): NeteaseDownloadItem[] {
    return this.queue.map((q) => ({ ...q }));
  }

  private emit() {
    const snap = this.snapshot();
    this.listeners.forEach((cb) => cb(snap));
  }

  private update(id: string, patch: Partial<NeteaseDownloadItem>) {
    const item = this.queue.find((q) => q.id === id);
    if (!item) return;
    Object.assign(item, patch);
    this.emit();
  }

  enqueue(tracks: { id: number; name: string; artist: string }[], br?: number): void {
    if (!tracks.length) return;
    const downloadDir = getDownloadDir();
    const requestBr = br ?? getNeteaseQualityBr();
    const safe = (s: string) => (s || '未知').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    const base = downloadDir.replace(/[\\/]+$/, '');
    for (const t of tracks) {
      // 文件名与 downloadNeteaseTrack 内规则保持一致（含音质标签），以便 savePath 可预测。
      const qLabel = requestBr >= 999000 ? '无损' : `${Math.round(requestBr / 1000)}k`;
      const ext = requestBr >= 999000 ? 'flac' : 'mp3';
      const fileName = `${safe(t.name)} - ${safe(t.artist)} [${qLabel}].${ext}`;
      const savePath = base ? `${base}/来自网易云/${fileName}` : '';
      const id = `${t.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      this.queue.push({
        id,
        songId: t.id,
        title: t.name,
        artist: t.artist,
        br: requestBr,
        fileName,
        savePath,
        status: 'queued',
        downloaded: 0,
        total: 0,
        speed: 0,
      });
    }
    this.emit();
    this.pump();
  }

  private pump() {
    while (this.running < this.maxConcurrent) {
      const next = this.queue.find((q) => q.status === 'queued');
      if (!next) break;
      this.running++;
      void this.runOne(next.id).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async runOne(id: string): Promise<void> {
    const item = this.queue.find((q) => q.id === id);
    if (!item) return;
    this.update(id, { status: 'downloading' });
    try {
      // 若未设下载目录，downloadNeteaseTrack 内部会弹保存框；入队时 savePath 为空也允许。
      await downloadNeteaseTrack(item.songId, item.title, item.artist, item.br, {
        downloadDir: getDownloadDir(),
        onProgress: (p) => this.update(id, { downloaded: p.downloaded, total: p.total, speed: p.speed }),
      });
      this.update(id, { status: 'done', downloaded: item.total || item.downloaded, speed: 0 });
      // 通知 index.tsx 做自动入库（加入扫描根 + 扫描）。
      const host = (window as any).__HOST_API__;
      if (host && typeof host.emit === 'function') {
        host.emit('netease-download-done', { savePath: item.savePath, libraryDir: getNeteaseDownloadLibraryDir() });
      }
    } catch (e: any) {
      if (e?.message?.includes('cancel') || e?.toString?.().includes('cancel')) {
        this.update(id, { status: 'canceled', speed: 0 });
      } else {
        this.update(id, { status: 'error', error: e?.message || String(e), speed: 0 });
      }
    }
  }

  clearFinished(): void {
    this.queue = this.queue.filter((q) => q.status === 'queued' || q.status === 'downloading');
    this.emit();
  }

  remove(id: string): void {
    this.queue = this.queue.filter((q) => q.id !== id);
    this.emit();
  }
}

export const neteaseDownloadManager = new NeteaseDownloadManager();
