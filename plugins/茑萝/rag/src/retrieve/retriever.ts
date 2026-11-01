// 检索管线：query → 嵌入 → 向量召回 →（可选）重排 → top-k。
//
// 与摄取对称：查询文本先经同一嵌入器向量化，再调后端 rag_query 做暴力余弦 top-k。
// 后端「嵌入无关」：任何能产出同维向量的嵌入器都能接（当前只有 ApiEmbedder）。
//
// 2026-10-18：默认嵌入器改为走 embed-config 的三级解析（显式配置 → 复用算力来源 →
// Ollama 兜底），并在失败时抛出「带端点/模型」的可读错误，不再让 UI 只剩一句
// 「嵌入请求失败」。
//
// 2026-11-01：加入**重排阶段**（rerank，两段式召回）。要点：
//   - 关闭时（默认）走的是**逐字未变**的旧链路：一次 ragQuery(vec, topK, 'general', minScore)。
//   - 开启时：先按 candidateK 召回 → 调 rag_rerank_api 打交叉分 → 按重排分排序 → 截 finalK。
//   - 开启时**不把旧的余弦阈值传给后端**：0.2 是余弦尺度，对 0~1 的 rerank 分毫无意义，
//     误用会在召回阶段就丢掉候选（正是历史上「阈值写死」那一类陷阱的变体）。
//   - 重排失败**降级而不是报错**：退回向量顺序（截 finalK），并把原因回给 UI 显示灰字。
//     用户看到的是「这次没用上重排」，而不是一整条提问失败。

import { ragQuery, ragRerankApi, type RagHit, type RagQueryResponse, type RagRerankResponse } from '../api/host';
import { ApiEmbedder, type ApiEmbedderOptions } from '../embed/api-embedder';
import { createDefaultEmbedder, describeEmbedError, queryPrefixFor, type EmbedConfig } from '../embed/embed-config';
import type { Embedder } from '../embed/embedder';
import { DEGRADED, resolveRerank, type ResolvedRerank } from './rerank-config';

export interface RetrieveOptions {
  /** 最终返回条数（**仅在未启用重排时生效**；启用时由设置里的 finalK 决定）。 */
  topK?: number;
  embedder?: Embedder;
  embedderOptions?: ApiEmbedderOptions;
  /** 最低相似度（余弦尺度，后端可选参数，默认 0 = 不过滤）。启用重排时忽略。 */
  minScore?: number;
  /** 跳过查询缓存（用户手动点「重试」时用）。 */
  bypassCache?: boolean;
  /**
   * 显式指定重排解析结果（探测/调试用）。
   * 传 `null` = 强制不走重排；不传 = 读 localStorage 里的重排设置。
   */
  rerank?: ResolvedRerank | null;
}

/** retrieve 的返回值：RagQueryResponse 的超集，旧调用方按原字段读即可。 */
export interface RetrieveResult extends RagQueryResponse {
  /** 本次是否真的走了重排（false = 向量排序）。 */
  reranked: boolean;
  /** 重排前召回的候选条数（未启用重排时 = results.length）。 */
  candidates: number;
  /** 本次用的重排来源说明。 */
  rerankLabel: string;
  /** 未走重排的原因（灰字展示；走了重排则为空串）。 */
  rerankNote: string;
}

// ============ 查询结果缓存（2026-10-19） ============
//
// 用户经常把同一个问题问两遍（改个措辞再问、或者切 tab 回来重问）。
// 每次都要：嵌入一次（网络/GPU）+ 后端全表余弦。缓存 60s 能省掉整条链。
//
// 失效：库变了（摄取/重建/删除）必须立刻失效，否则会拿旧结果骗人。
// 所以外部要调 `invalidateQueryCache()`；这里再加一层版本号双保险。
//
// ⚠️ key 必须包含**重排的 mode/model/候选数/最终数**（2026-11-01）：
// 否则「刚把重排从 bge-reranker 换成 jina-reranker」的下一个相同问题会命中旧缓存，
// 拿到的还是上一个排序，而 UI 显示的是新配置 —— 这种「配置改了但结果没变」最难归因。
const QUERY_CACHE_TTL_MS = 60_000;
const QUERY_CACHE_MAX = 30;
let cacheVersion = 0;
const queryCache = new Map<string, { res: RetrieveResult; at: number; ver: number }>();

/** 库内容变更后调用（摄取/重建/删除）。 */
export function invalidateQueryCache(): void {
  cacheVersion++;
  queryCache.clear();
  console.info('[rag] 查询缓存已失效（库内容变更）');
}

/** 重排签名（进缓存 key）。 */
function rerankSignature(cfg: ResolvedRerank | null | undefined): string {
  if (!cfg || !cfg.usable) return 'off';
  return `${cfg.source}:${cfg.model || '未命名'}:c${cfg.candidateK}f${cfg.finalK}`;
}

/**
 * 语义检索：返回 top-k 命中（含来源标题、文本、分数；启用重排时附带重排分与原排名）。
 */
export async function retrieve(
  query: string,
  opts: RetrieveOptions = {},
): Promise<RetrieveResult> {
  if (!query.trim()) {
    return {
      results: [],
      total: 0,
      reranked: false,
      candidates: 0,
      rerankLabel: '',
      rerankNote: '',
    };
  }

  const rerankCfg = opts.rerank === undefined ? await resolveRerank() : opts.rerank;
  const useRerank = !!rerankCfg?.usable;
  const k = opts.topK ?? 6;
  // 开启重排时：召回 candidateK、返回 finalK；关闭时：完全按旧口径（k + minScore）。
  const candidateK = useRerank ? Math.max(rerankCfg.candidateK, rerankCfg.finalK) : k;
  const finalK = useRerank ? rerankCfg.finalK : k;
  const cacheKey = `${k}|${opts.minScore ?? ''}|${rerankSignature(rerankCfg)}|${query}`;
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
    return {
      results: [],
      total: 0,
      reranked: false,
      candidates: 0,
      rerankLabel: '',
      rerankNote: '嵌入返回空向量',
    };
  }

  // ---- 1) 向量召回 ----
  // 重排开启时**故意不传 minScore**：那是余弦尺度，用它当召回闸门会误杀候选。
  const res = await ragQuery(vec, candidateK, 'general', useRerank ? undefined : opts.minScore);

  let out: RetrieveResult;
  if (!useRerank) {
    // 旧行为，逐字不变：向量顺序、后端已按 k 截断、阈值语义不变。
    out = {
      ...res,
      reranked: false,
      candidates: res.results.length,
      rerankLabel: '',
      // 只有「用户开了重排但这次没能用上」才提示；压根没开（source==='none'）不打扰用户。
      rerankNote:
        rerankCfg && rerankCfg.source !== 'none' ? rerankCfg.reason : '',
    };
  } else {
    out = await applyRerank(query, res, rerankCfg, finalK);
  }

  if (queryCache.size >= QUERY_CACHE_MAX) {
    const oldest = queryCache.keys().next();
    if (!oldest.done) queryCache.delete(oldest.value);
  }
  queryCache.set(cacheKey, { res: out, at: Date.now(), ver: cacheVersion });
  return out;
}

/**
 * 用 rerank API 的分数重排候选并截断。
 * 失败/形状不对时**降级为向量顺序**（截 finalK），并带回可读原因。
 */
async function applyRerank(
  query: string,
  recalled: RagQueryResponse,
  cfg: ResolvedRerank,
  finalK: number,
): Promise<RetrieveResult> {
  const hits = recalled.results ?? [];
  const degraded = (note: string): RetrieveResult => ({
    ...recalled,
    // 降级也要遵守 finalK，否则「降级」会顺手多塞几块进 prompt，行为随配置漂移。
    results: hits.slice(0, finalK),
    total: Math.min(hits.length, finalK),
    reranked: false,
    candidates: hits.length,
    rerankLabel: cfg.label,
    rerankNote: note,
  });

  if (hits.length === 0) {
    return { ...recalled, results: [], total: 0, reranked: false, candidates: 0, rerankLabel: cfg.label, rerankNote: '' };
  }

  const documents = hits.map((h) => h.text);
  let scored: RagRerankResponse | null = null;
  try {
    scored = await ragRerankApi(query, documents, {
      endpoint: cfg.endpoint,
      apiKey: cfg.apiKey || undefined,
      model: cfg.model,
      timeoutMs: cfg.timeoutMs,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[rag] 重排调用失败 → ${DEGRADED}：`, msg);
    return degraded(`重排调用失败，${DEGRADED}：${msg}`);
  }

  const items = scored?.results ?? [];
  if (items.length === 0) {
    console.warn(`[rag] 重排端点返回空分数列表 → ${DEGRADED}`);
    return degraded(`重排端点没返回任何分数，${DEGRADED}`);
  }
  const scoreByIdx = new Map<number, number>();
  for (const it of items) {
    if (!Number.isFinite(it.score)) {
      console.warn(`[rag] 重排第 ${it.index} 条分数不是有限数字，忽略该分数`);
      continue;
    }
    if (it.index >= 0 && it.index < hits.length) scoreByIdx.set(it.index, it.score);
  }

  // 打上三个可选字段（后端不返回，纯检索层补写）：
  //   vector_score = 原余弦分（与 score 同值，语义上是「向量阶段的分」）
  //   rerank_score = 交叉编码分
  //   original_rank = 重排前的向量名次（1 起，UI 显示「向量第 N → 重排第 M」）
  const tagged: RagHit[] = hits.map((h, i) => ({
    ...h,
    vector_score: h.score,
    original_rank: i + 1,
    rerank_score: scoreByIdx.get(i),
  }));

  // 排序：有重排分的按分降序；**没被打分的候选**排到最后（而不是冒充 0 分混进中间），
  // 同分时退回向量顺序，保证排序稳定、两次问同一个问题图不变形。
  tagged.sort((a, b) => {
    const av = a.rerank_score;
    const bv = b.rerank_score;
    if (av === undefined && bv !== undefined) return 1;
    if (bv === undefined && av !== undefined) return -1;
    if (av !== undefined && bv !== undefined && av !== bv) return bv - av;
    return (b.vector_score ?? b.score) - (a.vector_score ?? a.score);
  });

  const kept = tagged.slice(0, finalK);
  const unscored = tagged.filter((h) => h.rerank_score === undefined).length;
  if (unscored > 0) {
    console.warn(
      `[rag] 重排只给 ${tagged.length - unscored}/${tagged.length} 条候选打了分（其余按向量顺序排在后面）`,
    );
  }
  console.info(
    `[rag] 重排完成：候选 ${tagged.length} → ${kept.length}（${cfg.label}）` +
      (kept[0]?.rerank_score !== undefined
        ? ` · top1=${kept[0].rerank_score?.toFixed(4)}（向量 ${kept[0].score.toFixed(4)}，原第 ${kept[0].original_rank}）`
        : ''),
  );
  return {
    ...recalled,
    results: kept,
    total: kept.length,
    reranked: true,
    candidates: tagged.length,
    rerankLabel: cfg.label,
    rerankNote: unscored > 0 ? `有 ${unscored} 条候选没被打分，按向量顺序排在后面` : '',
  };
}

/** 命中条上「该用哪个分」：重排分优先，没有则向量分。展示与图谱共用这一条规则。 */
export function effectiveScore(hit: RagHit): number {
  return hit.rerank_score ?? hit.score;
}

/** 分数在 UI 上的名字（重排后叫「相关度」，纯向量时叫「相似度」——混为一谈会误导）。 */
export function scoreLabel(hit: RagHit): string {
  return hit.rerank_score !== undefined ? '相关度' : '相似度';
}

/**
 * 把检索命中格式化为注入 LLM 的上下文块（≤ maxChars）。
 */
export function formatRetrievalContext(
  results: RagHit[],
  maxChars = 6000,
): string {
  if (results.length === 0) return '';
  const parts: string[] = [];
  let total = 0;
  for (const r of results) {
    const block = `【来源：${r.source_title}】（${scoreLabel(r)} ${effectiveScore(r).toFixed(3)}）\n${r.text}`;
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
