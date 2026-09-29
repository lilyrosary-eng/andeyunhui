// 临时播放栏（临时1 / 临时2 / 临时3）
//
// 语义（与用户确认）：
//   - 自动记录：开始播放一个「非漫游电台来源」的播放队列时，自动记入临时栏；
//   - 最多 3 栏，满了自动覆盖最旧（最新队列恒为 临时1，旧的顺延，最旧的丢弃）；
//   - 仅内存（会话级），关闭应用即清空，不落盘；
//   - 点击某栏 → 以该栏队列随机打散进入漫游电台播放（随机逻辑与漫游一致）。
//
// 与漫游电台的隔离：「漫游电台」自身续推出来的队列不记录（否则漫游会不断刷新临时栏），
// 由 musicPlayer.emitQueueChange 携带的 playlistId 判定（漫游为 'roam-active'）。

import type { Track } from './musicPlayer';
import type { RoamSeedTrack } from './RoamSidebar';

export type TempSlotId = 'temp1' | 'temp2' | 'temp3';

export const TEMP_SLOT_IDS: TempSlotId[] = ['temp1', 'temp2', 'temp3'];
export const TEMP_SLOT_LABEL: Record<TempSlotId, string> = { temp1: '临时1', temp2: '临时2', temp3: '临时3' };

/** 单个临时栏（对外视图） */
export interface TempSlotView {
  id: TempSlotId;
  label: string;
  tracks: RoamSeedTrack[];
  addedAt: number;
  /** 队列来源描述（由曲目 id 前缀推断，如「网易云」「本地」） */
  platform: string;
}

// 命中这些 playlistId 的队列不入临时栏（漫游电台自身续推的队列）
const ROAM_QUEUE_IDS = new Set(['roam-active']);

// 记录列表：下标 0 = 最新（临时1），最多 3 条
let records: TempSlotView[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((cb) => { try { cb(); } catch { /* 忽略 */ } });
}

/** 订阅临时栏变化（返回注销函数） */
export function subscribeTempSlots(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** 当前三个临时栏（可能不足 3 个，空栏不返回） */
export function getTempSlots(): TempSlotView[] {
  return records.slice();
}

/** 取某个临时栏的队列快照（用于注入漫游池） */
export function getTempSlotTracks(id: TempSlotId): RoamSeedTrack[] {
  const rec = records.find((r) => r.id === id);
  return rec ? rec.tracks.slice() : [];
}

function trackToSeed(t: Track): RoamSeedTrack {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    cover: t.coverPath,
    durationSecs: t.durationSecs,
    filePath: t.filePath,
    quality: t.quality,
  };
}

function platformName(tracks: TempSlotView['tracks']): string {
  const id = tracks[0]?.id || '';
  if (id.startsWith('netease-')) return '网易云';
  if (id.startsWith('kugou-')) return '酷狗';
  if (id.startsWith('qishui-')) return '汽水';
  return '本地';
}

/**
 * 记录一个播放队列。由 index.tsx 订阅 musicPlayer 的 queueChange 事件调用。
 * 过滤规则：单曲队列 / 漫游电台来源 / 与现有栏完全相同的队列 都不记录。
 */
export function recordQueue(tracks: Track[] | undefined, playlistId: string | null | undefined): void {
  if (!tracks || tracks.length < 2) return; // 单曲不算「队列」
  if (playlistId && ROAM_QUEUE_IDS.has(playlistId)) return; // 漫游电台自身队列不记录

  const seeds = tracks.map(trackToSeed);
  const fingerprint = seeds.map((t) => t.id || t.filePath || t.title).join('\u0001');
  if (records.some((r) => r.tracks.map((t) => t.id || t.filePath || t.title).join('\u0001') === fingerprint)) {
    return; // 同一队列已在栏中，不重复记录（也不打乱现有顺位）
  }

  const entry = {
    tracks: seeds,
    addedAt: Date.now(),
    platform: platformName(seeds),
  };
  // 新队列恒占 临时1，旧内容顺延，超出 3 个丢弃最旧
  records = [
    { id: 'temp1', label: TEMP_SLOT_LABEL.temp1, ...entry },
    ...records.map((r, i) => ({ ...r, id: TEMP_SLOT_IDS[i + 1] ?? r.id, label: TEMP_SLOT_LABEL[TEMP_SLOT_IDS[i + 1] as TempSlotId] ?? r.label })),
  ].slice(0, 3) as TempSlotView[];
  notify();
}

/** 清空全部临时栏（应用级重置用） */
export function clearTempSlots(): void {
  if (!records.length) return;
  records = [];
  notify();
}