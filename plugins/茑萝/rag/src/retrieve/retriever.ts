// 检索管线：query → 嵌入 → rag_query → top-k。
//
// 与摄取对称：查询文本先经同一嵌入器向量化，再调后端 rag_query 做暴力余弦 top-k。
// 后端「嵌入无关」，支持 ApiEmbedder（API）与 OnnxEmbedder（本地）无缝切换。

import { ragQuery, type RagQueryResponse } from '../api/host';
import { ApiEmbedder, type ApiEmbedderOptions } from '../embed/api-embedder';
import type { Embedder } from '../embed/embedder';

export interface RetrieveOptions {
  topK?: number;
  embedder?: Embedder;
  embedderOptions?: ApiEmbedderOptions;
}

/**
 * 语义检索：返回 top-k 命中（含来源标题、文本、分数）。
 */
export async function retrieve(
  query: string,
  opts: RetrieveOptions = {},
): Promise<RagQueryResponse> {
  if (!query.trim()) return { results: [], total: 0 };
  const embedder = opts.embedder ?? new ApiEmbedder(opts.embedderOptions ?? {});
  const [vec] = await embedder.embed([query]);
  if (!vec || vec.length === 0) return { results: [], total: 0 };
  return ragQuery(vec, opts.topK ?? 6);
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
