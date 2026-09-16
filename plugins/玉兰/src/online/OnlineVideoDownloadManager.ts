/// <reference path="../../../global.d.ts" />
// 网络视频 · 通用下载管理器（单例 + 订阅者模式，对齐音乐模块 NeteaseDownloadManager）
//
// 支持三类资源：
//  - 'bili'  ：哔哩哔哩（先 resolveBili 取直链/分片 → download_video 落地，子目录「来自哔哩哔哩」）
//  - 'direct'：平台给出的直链视频（download_video 落地，子目录「来自网络视频」）
//  - 'hls'   ：m3u8（download_hls 经 ffmpeg 转封装 mp4，子目录「来自网络视频」）
//              ⚠️ 当前**没有生产者**：原 m3u8 来源是已删除的网页嗅探，而 B 站返回 MP4 混流。
//              保留此分支是为将来接入返回 m3u8 的平台（Rust 侧 download_hls 亦保留），
//              届时直接 enqueue({ kind: 'hls', ref: m3u8Url }) 即可，无需改动本文件。
//
// ⚠️ 与音乐 download_file 的差异（不可照搬）：
//   · 视频必须走 download_video（8GB 上限 / 无总超时）；download_file 是音乐单曲命令
//     （100MB 上限 / 60s 总超时），拿来下视频必然失败。
//   · B 站 durl 可能多段，download_video 支持按序拼接，故这里把 urls 整段传下去。
//
// 进度事件 payload 对齐音乐：{ downloaded, total, speed }（hls 阶段 total=0 表示不定长）。
import { resolveBili, BILI_REFERER, getBiliCookie } from './bilibiliApi';
import { bumpDownload } from './stats';

const hostApi: any = (window as any).__HOST_API__ || { invoke: async () => {}, listen: async () => () => {} };

export const VIDEO_DOWNLOAD_DIR_KEY = 'video_download_dir';
export type DlKind = 'bili' | 'direct' | 'hls';
export type DlStatus = 'queued' | 'downloading' | 'done' | 'error' | 'canceled';

export interface VideoDownloadResource {
  title: string;
  kind: DlKind;
  /** kind='bili' 时为 bvid；kind='direct' / 'hls' 时为资源直链 */
  ref: string;
  /** 平台 id（统计 + 子目录推导用） */
  platformId?: string;
  /** bilibili 清晰度（qn），缺省用默认值 */
  qn?: number;
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
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }
  private snapshot(): VideoDownloadTask[] {
    return this.queue.map((q) => ({ ...q }));
  }
  private emit() {
    const snap = this.snapshot();
    this.listeners.forEach((l) => l(snap));
  }
  getQueue(): VideoDownloadTask[] {
    return this.snapshot();
  }
  clearFinished() {
    this.queue = this.queue.filter((q) => q.status !== 'done' && q.status !== 'error' && q.status !== 'canceled');
    this.emit();
  }
  remove(id: string) {
    this.queue = this.queue.filter((q) => q.id !== id);
    this.emit();
  }

  enqueue(items: VideoDownloadResource[]) {
    if (!items.length) return;
    for (const it of items) {
      // push（FIFO）：与音乐 NeteaseDownloadManager 一致，批量下载按点击顺序执行
      this.queue.push({
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

  private pump() {
    while (this.running < this.maxConcurrent) {
      const task = this.queue.find((q) => q.status === 'queued');
      if (!task) break;
      this.running++;
      void this.runOne(task).finally(() => {
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
      task.error = '未设置下载目录（在模块设置里选择）';
      this.emit();
      return;
    }

    const safe = safeName(task.title);
    const sub = subDirOf(task.kind, task.subDir);
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
        // 取流：qn 由调用方决定（避免「清晰度下拉无效」）
        const info = await resolveBili({ id: task.ref, title: task.title, meta: { bvid: task.ref } }, task.qn);
        const savePath = `${dir}/${sub}/${safe}.mp4`;
        await hostApi.invoke('download_video', {
          urls: info.urls,
          savePath,
          referer: BILI_REFERER,
          cookie: getBiliCookie() || null,
          progressEvent,
        });
      } else if (task.kind === 'hls') {
        const savePath = `${dir}/${sub}/${safe}.mp4`;
        await hostApi.invoke('download_hls', {
          m3u8Url: task.ref,
          savePath,
          referer: task.referer || null,
          cookie: task.cookie || null,
          progressEvent,
        });
      } else {
        const savePath = `${dir}/${sub}/${safe}.${extOf(task.ref, task.kind)}`;
        await hostApi.invoke('download_video', {
          urls: [task.ref],
          savePath,
          // 直链下载的 Referer 由调用方显式给出（不同 CDN 要求不同，不能写死）
          referer: task.referer || null,
          cookie: task.cookie || null,
          progressEvent,
        });
      }
      task.status = 'done';
      task.downloaded = task.total || task.downloaded;
      bumpDownload(task.platformId || 'unknown');
    } catch (e: unknown) {
      const msg = String(e);
      if (/cancel/i.test(msg)) {
        task.status = 'canceled';
      } else {
        task.status = 'error';
        task.error = msg;
      }
    } finally {
      if (unlisten) unlisten();
      task.speed = 0;
    }
    this.emit();
  }
}

export const videoDownloadManager = new VideoDownloadManager();
