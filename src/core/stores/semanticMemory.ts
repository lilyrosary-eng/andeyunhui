// 语义记忆（L3 + L4）—— 阶段 4 · 深度记忆。
//
// 属于「共享功能层」：桌面与移动端共同使用（原住 src/mobile/stores，收拢到 core 消除
// 「桌面依赖移动内幕」的倒挂）。
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
import { useCompanionStore, buildPersonaContext, type Companion, type MemoryEntry } from './companionStore';
import { isBrowserPreview } from './companionStore';
import { storage } from '@/core/storage';
import { KEYS } from '@/core/storage/keys';
// type-only 引用（编译期擦除、零运行时耦合）：AiProfile 是迁移端共有的结构类型，
// 此处仅用于 ai_get_profiles 返回值的类型标注，不引入任何移动端逻辑/运行时依赖。
import type { AiProfile } from '@/mobile/types/chat';

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
const EMBED_KEY = KEYS.companion.ragEmbed.key;

/** 嵌入失败退避：失败后一段时间内不再尝试（避免每轮对话都打一次注定失败的请求）。
 *  典型场景：算力来源是 LM Studio 且只加载了聊天模型，/v1/embeddings 必然 404/报错。 */
let embedBackoffUntil = 0;
const EMBED_BACKOFF_MS = 10 * 60 * 1000;

export interface EmbedConfig {
  endpoint: string;
  apiKey: string;
  model: string;
}
export function getEmbedConfig(): EmbedConfig | null {
  const c = storage.getJSON<EmbedConfig | null>(EMBED_KEY, null);
  return c && c.endpoint ? c : null;
}
export function setEmbedConfig(c: EmbedConfig) {
  storage.setJSON(EMBED_KEY, c);
  embedBackoffUntil = 0; // 用户改配置后立即重试（清退避）
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
  if (Date.now() < embedBackoffUntil) return null; // 退避期内静默跳过
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
    embedBackoffUntil = Date.now() + EMBED_BACKOFF_MS;
    return null;
  } catch {
    embedBackoffUntil = Date.now() + EMBED_BACKOFF_MS;
    return null;
  }
}

/** 摄取一条记忆（摘要 / 核心事实 / 人设画像 / 情感快照） */
export async function ingestMemory(
  companionId: string,
  kind: 'summary' | 'core' | 'persona' | 'snapshot',
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
    const prefixed = kind === 'persona' ? `[人设画像] ${text}`
      : kind === 'snapshot' ? `[关系脉络 ${new Date(now).toLocaleString('zh-CN')}] ${text}`
      : kind === 'core' ? `[核心记忆] ${text}`
      : text;
    await invoke('rag_ingest', {
      source: {
        title: `伴侣记忆·${kind}·${new Date(now).toLocaleString('zh-CN')}`,
        uri: `companion://${companionId}/${kind}/${now}`,
        type: 'memory',
        namespace: 'ai-chat',
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
      namespace: 'ai-chat',
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
  // 人设画像摄取（方案 B：persona 语义独立，与 core 分离，永不随摘要漂移）
  const persona = buildPersonaContext(c);
  if (persona) {
    await ingestMemory(c.id, 'persona', persona, { kind: 'persona' });
  }
  // 核心档案摄取（重写式：每次全量覆盖，保证最新）
  if (c.core_memory?.length) {
    await ingestMemory(c.id, 'core', c.core_memory.join('\n'), { count: c.core_memory.length });
  }
  // 摘要摄取（增量：只摄取最近几条未摄取过的——简化：取最新 3 条）
  // 方案 C·去重：跳过与更早 summary 近似重复的条目，避免同话题反复沉淀向量库。
  const recent = c.memories.slice(0, 3);
  const older = c.memories.slice(3);
  for (const m of recent) {
    if (m.kind !== 'summary') continue;
    if (isDupSummary(m.content, older)) continue;
    await ingestMemory(c.id, 'summary', m.content, { created_at: m.created_at });
  }
}

/** 方案 C·沉淀去重：判断 summary 文本是否与已有 summary 近似（前缀相同 / 相互包含）。 */
function isDupSummary(content: string, existing: MemoryEntry[]): boolean {
  const a = content.trim().replace(/\s+/g, '');
  if (!a) return true;
  for (const m of existing) {
    if (m.kind !== 'summary') continue;
    const b = m.content.trim().replace(/\s+/g, '');
    if (!b) continue;
    if (a === b) return true;
    if (a.length >= 40 && b.startsWith(a.slice(0, 40))) return true;
    if (b.length >= 40 && a.startsWith(b.slice(0, 40))) return true;
    if (a.length > 10 && b.length > 10 && (a.includes(b) || b.includes(a))) return true;
  }
  return false;
}

/**
 * 取回人设画像（persona）文本 —— 方案 B：人设是最稳定、优先级最高的记忆，
 * 永远注入 system 最前，不依赖向量检索命中（即使无嵌入端点也用 buildPersonaContext 兜底）。
 * 返回 '' 表示无伴侣或未启用，调用方据此跳过。
 */
export async function retrievePersona(): Promise<string> {
  const c = useCompanionStore.getState().companion;
  if (!c) return '';
  return buildPersonaContext(c);
}

/** 构建 L3 语义记忆上下文（供 system 注入） */
export async function buildSemanticContext(queryText: string): Promise<string> {
  const hits = await queryMemory(queryText, 4);
  if (!hits.length) return '';
  const lines = hits.map((h) => `- ${h.text}`);
  return '【语义记忆（检索到的过去对话）】\n' + lines.join('\n') + '\n（自然融入，不要逐条复述）';
}

// ───────────────────────────────────────────────────────────────────────────
// 通用 RAG 助手：供 ai-chat 主对话复用（伴侣与对话记忆都落在 'ai-chat' 命名空间，
// 与 ai-ide / ai-gongfang 物理隔离，互不串味）。
// ───────────────────────────────────────────────────────────────────────────

/** 把一轮对话（用户 + 助手）摄取进向量库，形成「永久对话记忆」沉淀。 */
export async function ingestChatTurn(
  userText: string,
  assistantText: string,
  namespace = 'ai-chat',
): Promise<void> {
  if (isBrowserPreview()) return;
  if (!userText.trim() && !assistantText.trim()) return;
  if (!(await ensureInit())) return;
  const combined = `用户：${userText.trim()}\n助手：${assistantText.trim()}`;
  const vecs = await embed([combined]);
  if (!vecs || !vecs[0]) return; // 无嵌入端点 → 静默跳过沉淀（不阻塞对话）
  try {
    const now = Date.now();
    await invoke('rag_ingest', {
      source: {
        title: `对话记录·${new Date(now).toLocaleString('zh-CN')}`,
        uri: `chat://${now}`,
        type: 'chat',
        namespace,
      },
      chunks: [{
        idx: 0,
        text: combined,
        char_start: 0,
        char_end: combined.length,
        vec: vecs[0],
        meta: { kind: 'chat', ts: now },
      }],
    });
  } catch { /* 静默降级：沉淀失败不影响对话 */ }
}

/** 检索对话记忆，返回可直接注入 system 的上下文文本（命中为空时返回 ''）。 */
export async function retrieveChatContext(
  queryText: string,
  namespace = 'ai-chat',
  topK = 5,
): Promise<string> {
  if (isBrowserPreview()) return '';
  if (!(await ensureInit())) return '';
  const vec = await embed([queryText]);
  if (!vec || !vec[0]) return ''; // 无嵌入端点 → 不注入（降级）
  try {
    const res = await invoke<{ results: { text: string; score: number }[] }>('rag_query', {
      queryVec: vec[0],
      topK,
      namespace,
    });
    const hits = res?.results ?? [];
    if (!hits.length) return '';
    const lines = hits.map((h) => `- ${h.text}`);
    return '【长期对话记忆（检索到的相关内容）】\n' + lines.join('\n') + '\n（自然融入回答，不要逐条复述或提及"根据记忆"。）';
  } catch {
    return '';
  }
}