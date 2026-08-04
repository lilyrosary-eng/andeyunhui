// 语义记忆（L3 + L4）—— 阶段 4 · 深度记忆，Android 优先。
//
// L3 语义检索：把伴侣的摘要记忆 + 核心档案摄取进 RAG 库（rag.sqlite，复用桌面
// rag_service）。对话时对「最近消息」嵌入 → rag_query 检索 Top-K → 注入 system。
// L4 关系脉络：把「六维情感快照」也存进 RAG（meta 带时间戳），AI 能检索
// "你们关系过去的状态"——让 AI 理解关系是怎么一步步走到现在的。
//
// 嵌入走 rag_embed_api（用户配置的模型 endpoint），Android 上云端 API 可用；
// 纯本地 Ollama 仅在桌面可用（Android 无本地 Ollama，需用户在设置配置云端端点）。
//
// 务实设计（避免过度工程）：
// - 摄取时机：对话摘要生成后（已有 summarizeMemory 链路），把摘要作为一条 memory chunk
//   写入；情感快照随 applyDeltas 后写入。
// - 检索时机：发送消息时（doSend），对最近 3 条用户消息嵌入并查询。
// - 失败降级：任何 RAG 调用失败都静默降级为无语义记忆（不影响对话）。

import { invoke } from '@tauri-apps/api/core';
import { useCompanionStore, type Companion } from './companionStore';
import { isBrowserPreview } from './companionStore';
import type { AiProfile } from '../types/chat';

const SOURCE_PREFIX = 'companion-';

/** 是否已初始化 RAG（幂等） */
let initPromise: Promise<boolean> | null = null;
function ensureInit(): Promise<boolean> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      await invoke('rag_init_db');
      return true;
    } catch {
      return false;
    }
  })();
  return initPromise;
}

/** 嵌入端点配置（localStorage；用户可在设置里配云端 OpenAI 兼容嵌入端点） */
const EMBED_KEY = 'andeyunhui.mobile.rag.embed';

export interface EmbedConfig {
  endpoint: string;
  apiKey: string;
  model: string;
}
export function getEmbedConfig(): EmbedConfig | null {
  try {
    const raw = localStorage.getItem(EMBED_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as EmbedConfig;
    return c && c.endpoint ? c : null;
  } catch { return null; }
}
export function setEmbedConfig(c: EmbedConfig) {
  try { localStorage.setItem(EMBED_KEY, JSON.stringify(c)); } catch { /* 忽略 */ }
}

/** 解析嵌入配置：显式配置优先；否则自动复用当前算力来源（降门槛）。 */
async function resolveEmbedConfig(): Promise<{ endpoint: string; apiKey: string; model: string } | null> {
  const explicit = getEmbedConfig();
  if (explicit?.endpoint) return explicit;
  // 自动复用：当前算力来源的 base_url + api_key（OpenAI 兼容 /v1/embeddings）
  try {
    const raw = await invoke<{ profiles?: AiProfile[]; active?: string | null }>('ai_get_profiles');
    const list = (raw?.profiles ?? []).filter((p) => p && p.id && p.base_url && p.api_key);
    const active = list.find((p) => p.id === raw?.active) ?? list[0];
    if (active && active.base_url) {
      // 兼容 base_url 是否已含 /v1：/v1/embeddings 或 /embeddings 都正确拼接
      const base = active.base_url.replace(/\/+$/, '');
      const endpoint = base.endsWith('/v1') || base.includes('/v1/') ? `${base}/embeddings` : `${base}/v1/embeddings`;
      return {
        endpoint,
        apiKey: active.api_key ?? '',
        // 用户未指定嵌入模型时用常见默认（失败可提示改用显式配置）
        model: 'text-embedding-3-small',
      };
    }
  } catch { /* 忽略 */ }
  return null;
}

/** 嵌入一批文本（显式配置或自动复用算力来源；都无时静默降级） */
async function embed(texts: string[]): Promise<number[][] | null> {
  if (!texts.length) return null;
  const cfg = await resolveEmbedConfig();
  if (!cfg) return null; // 未配置 → L3 禁用（不阻塞对话）
  try {
    const res = await invoke<{ embeddings: number[][]; dim?: number }>('rag_embed_api', {
      texts,
      endpoint: cfg.endpoint,
      apiKey: cfg.apiKey || null,
      model: cfg.model || null,
    });
    if (res && Array.isArray(res.embeddings)) {
      return res.embeddings as number[][];
    }
    return null;
  } catch {
    return null;
  }
}

/** 摄取一条记忆（摘要 / 核心事实 / 情感快照） */
export async function ingestMemory(
  companionId: string,
  kind: 'summary' | 'core' | 'snapshot',
  text: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  if (isBrowserPreview()) return;
  if (!(await ensureInit())) return;
  const vecs = await embed([text]);
  if (!vecs || !vecs[0]) return;
  try {
    const now = Date.now();
    // 注入 kind 到文本首行：检索结果不含 meta（RagHit 无 meta 字段），
    // 用文本前缀区分类型，注入 system 时更可读。
    const prefixed = kind === 'snapshot' ? `[关系脉络 ${new Date(now).toLocaleString('zh-CN')}] ${text}`
      : kind === 'core' ? `[核心记忆] ${text}`
      : text;
    await invoke('rag_ingest', {
      source: {
        title: `伴侣记忆·${kind}·${new Date(now).toLocaleString('zh-CN')}`,
        uri: `companion://${companionId}/${kind}/${now}`,
        type: 'memory',
      },
      chunks: [{
        idx: 0,
        text: prefixed,
        char_start: 0,
        char_end: prefixed.length,
        vec: vecs[0],
        meta: { kind, companionId, ts: now, ...meta },
      }],
    });
  } catch { /* 静默降级 */ }
}

/** 语义检索：按查询文本召回 Top-K 记忆（仅 text + score，RagHit 无 meta）。 */
export async function queryMemory(
  queryText: string,
  topK = 4,
): Promise<{ text: string; score: number }[]> {
  if (isBrowserPreview()) return [];
  if (!(await ensureInit())) return [];
  const vec = await embed([queryText]);
  if (!vec || !vec[0]) {
    // 本地关键词降级（无 embedding 端点时）：在当前伴侣记忆里做分词匹配。
    // 零依赖零算力，保证 L3 在无 API embedding 时也有基本检索能力。
    return keywordFallback(queryText, topK);
  }
  try {
    const res = await invoke<{ results: { text: string; score: number }[] }>('rag_query', {
      queryVec: vec[0],
      topK,
    });
    return (res?.results ?? []).map((r) => ({ text: r.text, score: r.score }));
  } catch {
    return keywordFallback(queryText, topK);
  }
}

/** 本地关键词检索降级：对伴侣记忆（summary 为主）做包含匹配，按命中词数排序。 */
function keywordFallback(queryText: string, topK: number): { text: string; score: number }[] {
  try {
    const c = useCompanionStore.getState().companion;
    const q = queryText.toLowerCase();
    // 提取查询中的中英文关键词（2+ 字的中文片段 / 英文单词）
    const words = q.match(/[\u4e00-\u9fa5]{2,}|[a-z0-9]{2,}/g) ?? [];
    const pool = c.memories.filter((m) => m.kind === 'summary' || m.kind === 'core');
    const scored = pool
      .map((m) => {
        const text = m.content.toLowerCase();
        let hits = 0;
        for (const w of words) if (text.includes(w)) hits += 1;
        return { text: m.content, score: hits };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return scored;
  } catch {
    return [];
  }
}

/** 把伴侣的摘要记忆批量摄取（补全历史；新摘要由 summarizeMemory 链路增量摄取） */
export async function syncCompanionToSemantic(c: Companion): Promise<void> {
  if (isBrowserPreview()) return;
  // 核心档案摄取（重写式：每次全量覆盖，保证最新）
  if (c.core_memory?.length) {
    await ingestMemory(c.id, 'core', c.core_memory.join('\n'), { count: c.core_memory.length });
  }
  // 摘要摄取（增量：只摄取最近几条未摄取过的——简化：取最新 3 条）
  const recent = c.memories.slice(0, 3);
  for (const m of recent) {
    if (m.kind === 'summary') {
      await ingestMemory(c.id, 'summary', m.content, { created_at: m.created_at });
    }
  }
}

/** 构建 L3 语义记忆上下文（供 system 注入） */
export async function buildSemanticContext(queryText: string): Promise<string> {
  const hits = await queryMemory(queryText, 4);
  if (!hits.length) return '';
  const lines = hits.map((h) => `- ${h.text}`);
  return '【语义记忆（检索到的过去对话）】\n' + lines.join('\n') + '\n（自然融入，不要逐条复述）';
}
