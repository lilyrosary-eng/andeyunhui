// 检索管线：query → 嵌入 → rag_query → top-k。
//
// 与摄取对称：查询文本先经同一嵌入器向量化，再调后端 rag_query 做暴力余弦 top-k。
// 后端「嵌入无关」：任何能产出同维向量的嵌入器都能接（当前只有 ApiEmbedder）。
//
// 2026-10-18：默认嵌入器改为走 embed-config 的三级解析（显式配置 → 复用算力来源 →
// Ollama 兜底），并在失败时抛出「带端点/模型」的可读错误，不再让 UI 只剩一句
// 「嵌入请求失败」。

import { ragQuery, type RagQueryResponse } from '../api/host';
import { ApiEmbedder, type ApiEmbedderOptions } from '../embed/api-embedder';
import { createDefaultEmbedder, describeEmbedError, queryPrefixFor, type EmbedConfig } from '../embed/embed-config';
import type { Embedder } from '../embed/embedder';

export interface RetrieveOptions {
  topK?: number;
  embedder?: Embedder;
  embedderOptions?: ApiEmbedderOptions;
  /** 最低相似度（后端可选参数，默认 0 = 不过滤）。 */
  minScore?: number;
  /** 跳过查询缓存（用户手动点「重试」时用）。 */
  bypassCache?: boolean;
}

// ============ 查询结果缓存（2026-10-19） ============
//
// 用户经常把同一个问题问两遍（改个措辞再问、或者切 tab 回来重问）。
// 每次都要：嵌入一次（网络/GPU）+ 后端全表余弦。缓存 60s 能省掉整条链。
//
// 失效：库变了（摄取/重建/删除）必须立刻失效，否则会拿旧结果骗人。
// 所以外部要调 `invalidateQueryCache()`；这里再加一层版本号双保险。
const QUERY_CACHE_TTL_MS = 60_000;
const QUERY_CACHE_MAX = 30;
let cacheVersion = 0;
const queryCache = new Map<string, { res: RagQueryResponse; at: number; ver: number }>();

/** 库内容变更后调用（摄取/重建/删除）。 */
export function invalidateQueryCache(): void {
  cacheVersion++;
  queryCache.clear();
  console.info('[rag] 查询缓存已失效（库内容变更）');
}

/**
 * 语义检索：返回 top-k 命中（含来源标题、文本、分数）。
 */
export async function retrieve(
  query: string,
  opts: RetrieveOptions = {},
): Promise<RagQueryResponse> {
  if (!query.trim()) return { results: [], total: 0 };

  const k = opts.topK ?? 6;
  const cacheKey = `${k}|${opts.minScore ?? ''}|${query}`;
  if (!opts.bypassCache) {
    const hit = queryCache.get(cacheKey);
    if (hit && hit.ver === cacheVersion && Date.now() - hit.at < QUERY_CACHE_TTL_MS) {
      console.info(`[rag] 查询缓存命中（${((Date.now() - hit.at) / 1000).toFixed(1)}s 前的结果）`);
      return hit.res;
    }
  }

  let embedder: Embedder;
  let cfg: EmbedConfig | null = null;
  if (opts.embedder) {
    embedder = opts.embedder;
  } else if (opts.embedderOptions) {
    embedder = new ApiEmbedder(opts.embedderOptions);
  } else {
    const picked = await createDefaultEmbedder();
    embedder = picked.embedder;
    cfg = picked.cfg;
  }

  let vec: number[] | undefined;
  try {
    // instruction-aware 模型（Qwen3-Embedding）要求给 **query** 加任务前缀，
    // document 侧不加。实测区分度 0.284 → 0.370（见 embed-config.queryPrefixFor）。
    const prefixed = queryPrefixFor(cfg?.model ?? embedder.modelId ?? '') + query;
    [vec] = await embedder.embed([prefixed]);
  } catch (e) {
    const msg = describeEmbedError(cfg, e);
    console.error('[rag] 查询嵌入失败:', msg);
    throw new Error(msg);
  }
  if (!vec || vec.length === 0) {
    console.warn('[rag] 嵌入返回空向量，检索跳过');
    return { results: [], total: 0 };
  }
  const res = await ragQuery(vec, k, 'general', opts.minScore);
  if (queryCache.size >= QUERY_CACHE_MAX) {
    const oldest = queryCache.keys().next();
    if (!oldest.done) queryCache.delete(oldest.value);
  }
  queryCache.set(cacheKey, { res, at: Date.now(), ver: cacheVersion });
  return res;
}

/**
 * 把检索命中格式化为注入 LLM 的上下文块（≤ maxChars）。
 */
export function formatRetrievalContext(
  results: RagQueryResponse['results'],
  maxChars = 6000,
): string {
  if (results.length === 0) return '';
  const parts: string[] = [];
  let total = 0;
  for (const r of results) {
    const block = `【来源：${r.source_title}】（相似度 ${r.score.toFixed(3)}）\n${r.text}`;
    if (total + block.length > maxChars) {
      const remain = Math.max(0, maxChars - total);
      parts.push(block.slice(0, remain) + '\n…（上下文截断）');
      break;
    }
    parts.push(block);
    total += block.length;
  }
  return parts.join('\n\n---\n\n');
}
