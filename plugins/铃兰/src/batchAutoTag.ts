/**
 * 批量「自动匹配并写入」的计划层（纯函数，可单测）
 *
 * 批量与单条最大的区别是**没有人在中间看**：弹窗里点错了一格，用户点确定前还能发现；
 * 批量是几十个文件一起落盘。所以门槛设在这里，而不是设在后端：
 * 打分三维（标题/歌手/专辑各 0..2，满 6）里，只接「标题完全相等且歌手或专辑至少
 * 搭上一项」的候选。够不着就不动那个文件，并在报告里写明为什么不动 ——
 * 「静默少改了几首」是最难排查的那种坏结果。
 *
 * 检索/打分本身不在这里做：由调用方注入 `resolveTop`，与弹窗共用同一条候选链
 * （网易云 → 酷狗 → QQ + 宿主打分引擎），不另立一套。
 */

import { buildDraftPayload } from './tagEditArgs';

/** 自动写入的最低匹配分（满 6 = 标题/歌手/专辑全等） */
export const MIN_AUTO_WRITE_SCORE = 4;

/**
 * 连带换封面要的分数（用户定的默认：只有高分才动封面）。
 *
 * 改三个文本字段错了能一眼看出来，换封面错了要多绕一层（图也进了文件、还占一份留底），
 * 所以门槛比写字段高一档：5 = 标题全等 + 歌手全等 + 专辑至少搭上。
 */
export const MIN_AUTO_COVER_SCORE = 5;

/** 批量只认这三个字段：候选源给不出年份/碟号，硬凑会写成空值 */
export const BATCH_WRITABLE_FIELDS = ['title', 'artist', 'album'] as const;

export interface BatchTrackInput {
  /** 落盘用的真实路径；缺了就没法写，直接跳过 */
  filePath: string;
  title: string;
  artist: string;
  album: string;
}

export interface TopCandidate {
  /** 候选的展示字段（只有 title/artist/album 会被写入） */
  title: string;
  artist: string;
  album: string;
  /** 宿主打分引擎给出的分（0..6，可能为负）；`undefined` = 这条候选**压根没被打过分** */
  score?: number;
  /** 来源标识，仅用于报告里说清「这条是哪来的」 */
  source?: string;
  /** 候选带的封面远程地址（有且分数够高才会连带换） */
  coverUrl?: string;
}

export interface PlannedItem {
  filePath: string;
  /** 直接可以塞进 `music_batch_edit_tracks` 的 items[].draft */
  draft: Record<string, unknown>;
  score: number;
  source: string;
  /** 非空表示这一首除了字段还要换封面 */
  coverUrl?: string;
}

export interface SkippedItem {
  filePath: string;
  title: string;
  reason: string;
}

export interface BatchPlan {
  items: PlannedItem[];
  skipped: SkippedItem[];
}

/** 与后端 `new_batch_id("batch")` 同形（`{kind}_{毫秒}`），撤销按这个串整批回滚 */
export function newClientBatchId(now = Date.now()): string {
  return `batch_${now}`;
}

const sameText = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * 逐首定夺：能写的进 `items`，不能写的进 `skipped` 并带原因。
 *
 * `resolveTop` 返回 null 表示这首没检索到/没排 out 出候选；抛错由调用方决定，
 * 这里不吞异常 —— 一批里首首都抛错和被静默跳过，用户看到的差别只在于有没有报告。
 */
export async function planBatchAutoTag(
  tracks: BatchTrackInput[],
  resolveTop: (t: BatchTrackInput) => Promise<TopCandidate | null>,
): Promise<BatchPlan> {
  const items: PlannedItem[] = [];
  const skipped: SkippedItem[] = [];
  for (const t of tracks) {
    const label = t.title.trim() || '(无标题)';
    if (!t.filePath.trim()) {
      skipped.push({ filePath: '', title: label, reason: '这条没有可写回的文件路径' });
      continue;
    }
    const top = await resolveTop(t);
    if (!top) {
      skipped.push({ filePath: t.filePath, title: label, reason: '没检索到候选，或候选都被打分器淘汰' });
      continue;
    }
    if (top.score === undefined) {
      // 没打过分 ≠ 打了 0 分：本地标题是垃圾（文件名与歌名不符）时候选会被打分器
      // 整批淘汰并退回原顺序，此时说「分数不够」是把我们的没数据甩锅给用户的内容
      skipped.push({
        filePath: t.filePath,
        title: label,
        reason: '这条候选没被打过分（多半是文件里的标题与歌名对不上），自动改不敢下手',
      });
      continue;
    }
    if (top.score < MIN_AUTO_WRITE_SCORE) {
      skipped.push({
        filePath: t.filePath,
        title: label,
        reason: `最高匹配分 ${top.score} 低于自动写入门槛 ${MIN_AUTO_WRITE_SCORE}，宁可不改也不写错`,
      });
      continue;
    }
    // 只下发**非空且确实不同**的字段：文本项空串在后端是「清除」，
    // 而候选给不出这一项时清除等于把用户已有的标签抹掉。
    const changed: Record<string, string> = {};
    for (const key of BATCH_WRITABLE_FIELDS) {
      const v = (top[key] ?? '').trim();
      if (v && !sameText(v, t[key])) changed[key] = v;
    }
    if (Object.keys(changed).length === 0) {
      // 字段都一样就整首跳过：不做「只换封面」这一档 —— 我们没有「这文件本来没封面」
      // 的信息源，盲换会把已有封面盖掉，而那是这份计划里唯一看不见的判断
      skipped.push({ filePath: t.filePath, title: label, reason: '已是这个值，无需写' });
      continue;
    }
    items.push({
      filePath: t.filePath,
      draft: buildDraftPayload(changed),
      score: top.score,
      source: top.source || '?',
      coverUrl: top.coverUrl?.trim() && top.score >= MIN_AUTO_COVER_SCORE ? top.coverUrl.trim() : undefined,
    });
  }
  return { items, skipped };
}

/** 拼 `music_batch_edit_tracks` 的参数（items 为空时不该发，调用方自己判） */
export function buildBatchArgs(plan: BatchPlan, batchId: string): {
  items: Array<{ filePath: string; draft: Record<string, unknown> }>;
  batchId: string;
} {
  return { items: plan.items.map((i) => ({ filePath: i.filePath, draft: i.draft })), batchId };
}

/** 后端 `BatchItemResult[]` → 一行给人看的汇总（含被容器丢掉的字段点名） */
export function describeBatchResults(
  results: Array<{ filePath?: string; ok?: boolean; error?: string | null; dropped?: string[] }>,
  plan: BatchPlan,
): string {
  const arr = Array.isArray(results) ? results : [];
  const ok = arr.filter((r) => r.ok).length;
  const failed = arr.filter((r) => !r.ok);
  const dropped = new Set<string>();
  for (const r of arr) for (const d of r.dropped ?? []) dropped.add(d);
  const bits = [`成功 ${ok}/${arr.length}`];
  if (plan.skipped.length) bits.push(`跳过 ${plan.skipped.length} 首`);
  if (dropped.size) bits.push(`${dropped.size} 个字段被容器格式丢掉`);
  if (failed.length) bits.push(`失败 ${failed.length}：${String(failed[0]?.error ?? '')}`);
  return bits.join(' · ');
}

export interface BatchItemResultLike {
  filePath?: string;
  ok?: boolean;
  error?: string | null;
  dropped?: string[];
}

export interface BatchAutoTagReport {
  batchId: string;
  /** 后端确认写成功的文件数（= 可撤销的范围） */
  written: number;
  failed: number;
  /** 连带换掉的封面数 / 换失败的封面数 */
  coversChanged: number;
  coverFailed: number;
  skipped: SkippedItem[];
  /** 各容器格式没帧位而被跳过的字段名（去重） */
  droppedFields: string[];
  summary: string;
}

/**
 * 把计划 + 后端结果收成一份报告。
 *
 * `written` 只算后端点头的那些：批次号里含失败文件的历史行（快照是写盘**之前**记的），
 * 所以撤销整批时失败文件也会被"恢复"成它本来的样子 —— 无害，但不能因此把它算成功。
 *
 * `covers` 是换封面那条通路的逐条结果（走的是 `music_set_cover_url`，与字段写回共用
 * 同一个批次号，所以一次撤销能把字段和封面一起退回）。
 */
export function buildBatchReport(
  plan: BatchPlan,
  batchId: string,
  results: BatchItemResultLike[],
  covers: Array<{ ok?: boolean; error?: string | null }> = [],
): BatchAutoTagReport {
  const arr = Array.isArray(results) ? results : [];
  const cv = Array.isArray(covers) ? covers : [];
  const dropped = new Set<string>();
  for (const r of arr) for (const d of r.dropped ?? []) dropped.add(d);
  const coverFailed = cv.filter((c) => !c?.ok).length;
  const summary = [
    describeBatchResults(arr, plan),
    cv.length ? `封面 ${cv.length - coverFailed}/${cv.length}` : '',
    coverFailed ? String(cv.find((c) => !c?.ok)?.error ?? '换封面失败') : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    batchId,
    written: arr.filter((r) => r.ok).length,
    failed: arr.filter((r) => !r.ok).length,
    coversChanged: cv.length - coverFailed,
    coverFailed,
    skipped: plan.skipped,
    droppedFields: Array.from(dropped),
    summary,
  };
}
