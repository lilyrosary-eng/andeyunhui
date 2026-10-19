// 重建向量（reembed）：换嵌入模型后，用库里已有的原文重新算一遍向量。
//
// 为什么必须有：自适应维度让"换模型"不再是死功能，但换完之后旧块维度不同，
// 检索会按维度分流跳过它们 —— 数据还在、只是搜不到。此时唯一正确的动作是
// 用 chunks.text 里的原文重算（**不需要用户重新上传文件**）。
//
// 数据安全：
// - 全部批次在内存里算完，最后**一次性**回调 rag_update_vectors —— 取消/失败 = 零改动。
// - 后端在覆盖前自动 VACUUM INTO 备份（保留最近 3 份）。
// - document 侧**不加** query 指令前缀（Qwen3 只要求 query 加）。

import { ragListChunks, ragListSources, ragUpdateVectors, type RagVecUpdate } from '../api/host';
import { createDefaultEmbedder, describeEmbedError } from '../embed/embed-config';
import { CachedEmbedder } from '../embed/cache';
import type { Embedder } from '../embed/embedder';
import { RAG_NS_GENERAL } from '../store/rag-store';

export interface ReembedProgress {
  phase: 'reading' | 'embedding' | 'writing' | 'done';
  done: number;
  total: number;
}

export interface ReembedOptions {
  /** 每批条数（默认 16）。太大会撞端点单请求上限，太小则请求数多。 */
  batchSize?: number;
  onProgress?: (p: ReembedProgress) => void;
  /** 取消标志：调用方置 `aborted = true`，下一批开始前中止（已算的不写库）。 */
  signal?: { aborted: boolean };
  embedder?: Embedder;
}

export interface ReembedResult {
  blocks: number;
  dim: number;
  model: string;
}

/** 单个来源的块数上限：超过这个量说明该拆来源了（否则一次重建的内存/IPC 太大）。 */
const MAX_BLOCKS = 5000;

export async function reembedSource(sourceId: string, opts: ReembedOptions = {}): Promise<ReembedResult> {
  opts.onProgress?.({ phase: 'reading', done: 0, total: 0 });
  const rows = await ragListChunks(sourceId, RAG_NS_GENERAL);
  if (!rows.length) {
    throw new Error('该来源没有可重建的块（可能只有父块，或数据异常）');
  }
  if (rows.length > MAX_BLOCKS) {
    throw new Error(`块数过多（${rows.length} > ${MAX_BLOCKS}），请拆分来源后再重建`);
  }
  console.info(`[rag] 重建开始：source=${sourceId} 块数=${rows.length}`);

  let embedder: Embedder;
  let cfgModel = '';
  if (opts.embedder) {
    embedder = opts.embedder;
  } else {
    const picked = await createDefaultEmbedder();
    embedder = picked.embedder;
    cfgModel = picked.cfg.model;
  }
  const cached = new CachedEmbedder(embedder);

  const batch = Math.max(1, opts.batchSize ?? 16);
  const updates: RagVecUpdate[] = [];
  let dim = 0;

  for (let i = 0; i < rows.length; i += batch) {
    if (opts.signal?.aborted) {
      throw new Error('已取消重建（数据未改动）');
    }
    const slice = rows.slice(i, i + batch);
    let vecs: number[][];
    try {
      vecs = await cached.embed(slice.map((r) => r.text));
    } catch (e) {
      const msg = describeEmbedError(null, e);
      console.error('[rag] 重建嵌入失败:', msg);
      throw new Error(msg);
    }
    if (vecs.length !== slice.length) {
      throw new Error(`重建失败：嵌入数量不匹配（${vecs.length}/${slice.length}）`);
    }
    dim = vecs[0]?.length ?? 0;
    if (!dim) throw new Error('重建失败：嵌入返回空向量');
    slice.forEach((r, k) => {
      updates.push({ id: r.id, vec: vecs[k], embed_model: cfgModel || cached.modelId });
    });
    opts.onProgress?.({
      phase: 'embedding',
      done: Math.min(i + batch, rows.length),
      total: rows.length,
    });
  }

  opts.onProgress?.({ phase: 'writing', done: rows.length, total: rows.length });
  const written = await ragUpdateVectors(sourceId, updates, RAG_NS_GENERAL);
  console.info(`[rag] 重建完成：${written} 块 / ${dim} 维 / ${cfgModel || cached.modelId}`);
  opts.onProgress?.({ phase: 'done', done: written, total: rows.length });
  return { blocks: written, dim, model: cfgModel || cached.modelId };
}

// ============ 一键全部重建 ============

export interface ReembedAllProgress {
  sourceIdx: number;
  sourceTotal: number;
  title: string;
  p: ReembedProgress;
}

export interface ReembedAllResult {
  sources: number;
  blocks: number;
  failed: { title: string; error: string }[];
}

/**
 * 对命名空间内**所有来源**逐个重建（串行）。
 *
 * 与单个重建的差别：批量时每个来源是**独立事务** —— 某个来源失败只跳过它，
 * 已完成的来源保留（不会因为最后一个失败把前面全部回滚）。
 * 取消同理：取消后已完成的来源保留，未开始的不动。
 */
export async function reembedAll(opts: {
  onProgress?: (p: ReembedAllProgress) => void;
  signal?: { aborted: boolean };
  batchSize?: number;
} = {}): Promise<ReembedAllResult> {
  const sources = await ragListSources(RAG_NS_GENERAL);
  if (sources.length === 0) {
    throw new Error('知识库里还没有来源，先摄取文档');
  }
  console.info(`[rag] 全部重建开始：${sources.length} 个来源`);
  let blocks = 0;
  const failed: { title: string; error: string }[] = [];

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (opts.signal?.aborted) {
      console.info(`[rag] 全部重建已取消（已完成 ${i}/${sources.length} 个来源，改动已保留）`);
      throw new Error(`已取消（已完成 ${i}/${sources.length} 个来源，按原文重建过的不会回退）`);
    }
    try {
      const r = await reembedSource(s.id, {
        batchSize: opts.batchSize,
        signal: opts.signal,
        onProgress: (p) =>
          opts.onProgress?.({
            sourceIdx: i,
            sourceTotal: sources.length,
            title: s.title,
            p,
          }),
      });
      blocks += r.blocks;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 取消是控制流，不算失败
      if (opts.signal?.aborted) throw e;
      console.error(`[rag] 「${s.title}」重建失败（跳过，其余继续）:`, msg);
      failed.push({ title: s.title, error: msg });
    }
  }

  console.info(
    `[rag] 全部重建结束：成功 ${sources.length - failed.length}/${sources.length} 个来源，共 ${blocks} 块`,
  );
  return { sources: sources.length - failed.length, blocks, failed };
}
