// 嵌入结果缓存（2026-10-19）。
//
// 场景：重建向量时要对同一批块的**同一段文本**重新嵌入；如果用户连点两次「重建」、
// 或者两个来源有重复段落（许可证头、目录页、同一份文档的不同版本），重复请求完全冗余。
//
// 设计取舍：
// - **只在进程内**（Map），不落盘：落盘要处理模型版本、维度变更、过期，收益不值。
// - key = `模型::长度::头64字::尾64字::FNV-1a`：单用 FNV 32 位哈希有碰撞风险，
//   一旦碰撞就会把 A 的向量当成 B 的——这是数据正确性问题，不能用概率赌。
//   把长度与首尾片段拼进 key，实际碰撞概率可忽略。
// - 上限 LRU（默认 500 条），超出淘汰最早写入的。

import type { Embedder } from './embedder';

const MAX_ENTRIES = 500;

const store = new Map<string, number[]>();
let hits = 0;
let misses = 0;

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

function cacheKey(model: string, text: string): string {
  const head = text.slice(0, 64);
  const tail = text.length > 64 ? text.slice(-64) : '';
  return `${model}::${text.length}::${head}::${tail}::${fnv1a(text)}`;
}

function get(k: string): number[] | undefined {
  return store.get(k);
}

function set(k: string, v: number[]): void {
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (!oldest.done) store.delete(oldest.value);
  }
  store.set(k, v);
}

export function cacheStats(): { size: number; hits: number; misses: number } {
  return { size: store.size, hits, misses };
}

export function cacheClear(): void {
  store.clear();
  hits = 0;
  misses = 0;
}

/**
 * 给任意 Embedder 套一层进程内缓存。
 * 只缓存逐条结果；批量请求会被拆成「命中 + 未命中」，未命中的合并成一次请求。
 */
export class CachedEmbedder implements Embedder {
  private inner: Embedder;

  constructor(inner: Embedder) {
    this.inner = inner;
  }

  get dim(): number {
    return this.inner.dim;
  }

  get modelId(): string {
    return this.inner.modelId;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const keys = texts.map((t) => cacheKey(this.modelId, t));
    const out: (number[] | undefined)[] = keys.map((k) => get(k));
    const missingIdx: number[] = [];
    for (let i = 0; i < out.length; i++) {
      if (out[i]) hits++;
      else missingIdx.push(i);
    }
    if (missingIdx.length === 0) {
      console.info(`[rag] 嵌入缓存命中 ${texts.length}/${texts.length}`);
      return out as number[][];
    }
    misses += missingIdx.length;
    const missingTexts = missingIdx.map((i) => texts[i]);
    const fresh = await this.inner.embed(missingTexts);
    if (fresh.length !== missingTexts.length) {
      throw new Error(
        `嵌入缓存层：返回数量不匹配（期望 ${missingTexts.length}，实际 ${fresh.length}）`,
      );
    }
    missingIdx.forEach((idx, j) => {
      out[idx] = fresh[j];
      set(keys[idx], fresh[j]);
    });
    console.info(
      `[rag] 嵌入缓存：命中 ${texts.length - missingIdx.length} / 新算 ${missingIdx.length}（累计 hit=${hits} miss=${misses}）`,
    );
    return out as number[][];
  }
}
