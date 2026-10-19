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

/** 是否已初始化 RAG（幂等） */
let initPromise: Promise<boolean> | null = null;
function ensureInit(): Promise<boolean> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      await invoke('rag_init_db');
      // 启动后延迟 5s 做一次维度自愈（异步、不阻塞对话首轮；见文件末尾注释）
      setTimeout(() => {
        void healEmbeddingDimension().catch((e) =>
          console.warn('[rag-heal] 自愈任务异常:', e),
        );
        // 顺手清理过量的对话记录（后端只在超过 1.5 倍阈值时才动手，删除前自动备份）
        void invoke<number>('rag_prune', { namespace: 'ai-chat', keepRecent: 200 })
          .then((n) => {
            if (n > 0) console.info(`[rag-prune] 已清理 ${n} 条旧对话记录（保留最近 200 条）`);
          })
          .catch((e) => console.warn('[rag-prune] 清理失败（不影响对话）:', e));
      }, 5000);
      return true;
    } catch (e) {
      console.warn('[semanticMemory] rag_init_db 失败（记忆功能降级）:', e);
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
    // 注意：这里**不能再要求 api_key 非空** —— 本地 LM Studio 的 key 可为空/任意，
    // 过滤掉它会导致「本地嵌入明明可用却被判定为未配置」。
    const list = (raw?.profiles ?? []).filter((p) => p && p.id && p.base_url);
    // 优先挑「名字像嵌入模型」的档案：用户当前选中的往往是对话模型，
    // 拿去打 /v1/embeddings 会 404（或在 LM Studio 上被静默替换成已加载的嵌入模型）。
    const EMBED_RE = /embed|embedding|bge|gte|m3e|nomic/i;
    const embedLike = list.find((p) => EMBED_RE.test(p.model ?? '') || EMBED_RE.test(p.name ?? ''));
    const active = embedLike ?? list.find((p) => p.id === raw?.active) ?? list[0];
    if (active && active.base_url) {
      // 兼容 base_url 是否已含 /v1：/v1/embeddings 或 /embeddings 都正确拼接
      const base = active.base_url.replace(/\/+$/, '');
      const endpoint = base.endsWith('/v1') || base.includes('/v1/') ? `${base}/embeddings` : `${base}/v1/embeddings`;
      return {
        endpoint,
        apiKey: active.api_key ?? '',
        // 找到真嵌入模型就用它；否则才退回常见默认（可能不被该端点支持）
        model: embedLike ? (active.model || active.name || '') : 'text-embedding-3-small',
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
  // 摘要去重（2026-10-19 从 syncCompanionToSemantic 迁到这里）：
  // 增量链路（移动端 summarizeMemory → addMemory → ingestMemory）此前**没有任何去重**，
  // 同一话题的连续摘要会各写一条 source，检索时被近似内容占满。
  // 比较对象排除刚写入的最新一条（调用方通常先 addMemory 再 ingestMemory）。
  if (kind === 'summary') {
    const c = useCompanionStore.getState().companion;
    if (c && c.memories.length > 1 && isDupSummary(text, c.memories.slice(1))) {
      console.info('[semanticMemory] 跳过近似重复的摘要（未写入向量库）');
      return;
    }
  }
  const cfg = await resolveEmbedConfig();
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
    // URI 策略（2026-10-19 修）：
    //   persona / core 是「重写式」数据 —— uri 固定 + replace:true，同一份档案永远只有一条 source。
    //   原来 uri 里带 now，每次同步都新增一条 → 库里堆满同一份档案的历史版本，检索被重复内容占满。
    //   summary / snapshot 是「增量」数据 —— 必须保持唯一 uri，历史不能互相覆盖。
    const replace = kind === 'persona' || kind === 'core';
    const uri = replace
      ? `companion://${companionId}/${kind}`
      : `companion://${companionId}/${kind}/${now}`;
    await invoke('rag_ingest', {
      source: {
        title: `伴侣记忆·${kind}·${new Date(now).toLocaleString('zh-CN')}`,
        uri,
        type: 'memory',
        namespace: 'ai-chat',
        replace,
      },
      chunks: [{
        idx: 0,
        text: prefixed,
        char_start: 0,
        char_end: prefixed.length,
        vec: vecs[0],
        embed_model: cfg?.model,
        meta: { kind, companionId, ts: now, ...meta },
      }],
    });
  } catch (e) {
    // 显式打印：静默降级会让"记忆没进库"永远不可见
    console.warn(`[semanticMemory] 摄取 ${kind} 记忆失败（不影响对话）:`, e);
  }
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
    const raw = (res?.results ?? []).map((r) => ({ text: r.text, score: r.score }));
    if (!raw.length) return [];
    // 同样的相对窗口（分数尺度随模型变化，绝对阈值不可靠）
    const top1 = Math.max(...raw.map((h) => h.score));
    return raw.filter((h) => h.score >= top1 - 0.15);
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

/**
 * 把伴侣的**档案**（persona 人设画像 + core 核心档案）同步进语义库。
 *
 * 2026-10-19 修改：
 * - 只同步 persona / core（两者现在都是 `replace:true` + 固定 uri → 永远只有一条，不会堆历史版本）。
 * - **不再顺手同步 summary**：摘要由增量链路（summarizeMemory 后逐条 ingestMemory）负责，
 *   在这里再扫一遍会按"最新 3 条"反复写入 —— 那正是库里同一条摘要出现多次的来源之一。
 */
export async function syncCompanionToSemantic(c: Companion): Promise<void> {
  if (isBrowserPreview()) return;
  const persona = buildPersonaContext(c);
  if (persona) {
    await ingestMemory(c.id, 'persona', persona, { kind: 'persona' });
  }
  if (c.core_memory?.length) {
    await ingestMemory(c.id, 'core', c.core_memory.join('\n'), { count: c.core_memory.length });
  }
}

/** 档案指纹缓存：只有 persona/core 真的变了才重新沉淀（零 LLM 成本）。 */
const COMPANION_SIG_KEY = 'andeyunhui.rag.companionSig';

function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

/**
 * 桌面端自动沉淀伴侣档案（L1 person + L2 core）。
 *
 * 背景：桌面此前**完全没有**档案沉淀链路（只有移动端跑摘要），桌面的 persona/core
 * 只有用户手动点「同步」才会进向量库。这里在每轮对话结束后做一次**指纹比对**，
 * 变了才写 —— 不调 LLM、零 token 成本。
 *
 * 注意：L4 关系快照需要 `summarizeMemory`（一次 LLM 调用），不在本函数里做。
 */
export async function autoSyncCompanion(): Promise<void> {
  try {
    if (isBrowserPreview()) return;
    const c = useCompanionStore.getState().companion;
    if (!c) return;
    const persona = buildPersonaContext(c);
    const core = (c.core_memory ?? []).join('\n');
    if (!persona && !core) return;
    const sig = `${persona.length}:${core.length}:${fnv1a32(persona + '\u0000' + core)}`;
    if (localStorage.getItem(COMPANION_SIG_KEY) === sig) return;
    await syncCompanionToSemantic(c);
    localStorage.setItem(COMPANION_SIG_KEY, sig);
    console.info('[semanticMemory] 伴侣档案已自动同步到语义库（persona/core 变化）');
  } catch (e) {
    console.warn('[semanticMemory] 自动同步伴侣档案失败（不影响对话）:', e);
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
  } catch (e) {
    // 显式打印：静默吞错会让"沉淀失败"永久不可见（库会悄悄漏掉记忆）
    console.warn('[semanticMemory] ingestChatTurn 沉淀失败（不影响对话）:', e);
  }
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
    // 相对窗口过滤（与知识库面板同一套判据）：不同嵌入模型的分数尺度不可比，
    // 固定阈值会误杀或放行。只保留与 top1 相差不超过 REL_WINDOW 的命中。
    const REL_WINDOW = 0.15;
    const top1 = Math.max(...hits.map((h) => h.score));
    const kept = hits.filter((h) => h.score >= top1 - REL_WINDOW);
    if (!kept.length) return '';
    const lines = kept.map((h) => `- ${h.text}`);
    return '【长期对话记忆（检索到的相关内容）】\n' + lines.join('\n') + '\n（自然融入回答，不要逐条复述或提及"根据记忆"。）';
  } catch (e) {
    // 显式打印：静默 catch 会让「维度不匹配导致 0 命中」看起来像「没有相关记忆」
    console.warn('[semanticMemory] rag_query 失败（本轮不注入记忆）:', e);
    return '';
  }
}

// ============ 静默维度自愈（2026-10-19） ============
//
// 背景：换嵌入模型后，库里旧块的向量维度与新模型不同。检索按维度分流会**跳过**它们
// （数据还在，只是搜不到）。AI 对话的伴侣记忆属于 `ai-chat` 命名空间，插件面板看不到
// 也管不了，所以必须由主应用自己修。
//
// 设计约束（用户明确要求：异步、别阻塞主进程）：
// - 只在 `ensureInit` 成功后 **延迟 5s** 触发，绝不阻塞对话首轮
// - 分批（16 条/批），每批之间 `setTimeout(0)` 让出主线程
// - 模块级 `healing` 锁：重入直接返回
// - 无 mismatch 时按 24h 节流；一旦发现 mismatch 立即处理（维度变了不能等一天）
// - 任何失败只 console.warn，不影响对话（embed() 自身还有 10 分钟退避）

const HEAL_KEY = 'andeyunhui.rag.healAt';
const HEAL_INTERVAL_MS = 24 * 60 * 60 * 1000;
const HEAL_BATCH = 16;
let healing = false;

interface RagDimStatLite {
  dim: number;
  chunks: number;
}
interface RagStatsLite {
  sources: number;
  chunks: number;
  dims: RagDimStatLite[];
  models: { model: string; chunks: number }[];
}
interface RagSourceLite {
  id: string;
  title: string;
  embed_dim?: number;
  embed_model?: string;
}
interface RagChunkLite {
  id: string;
  text: string;
  dim: number;
  embed_model: string;
}

const yieldToUi = (): Promise<void> => new Promise((res) => setTimeout(res, 0));

/**
 * 检查并修复 `ai-chat` 命名空间的向量维度（后台静默执行）。
 * 返回实际重建的块数（0 = 无需处理或失败）。
 */
export async function healEmbeddingDimension(opts: { force?: boolean } = {}): Promise<number> {
  if (healing) return 0;
  if (isBrowserPreview()) return 0;
  healing = true;
  const t0 = Date.now();
  let healed = 0;
  try {
    // 1) 当前模型能产出的维度（探针）
    const probe = await embed(['dimension probe']);
    const curDim = probe?.[0]?.length ?? 0;
    if (!curDim) {
      console.warn('[rag-heal] 嵌入端点不可用（或处于退避期），跳过维度自愈');
      return 0;
    }

    // 2) 库里的维度分布
    const stats = await invoke<RagStatsLite>('rag_stats', { namespace: 'ai-chat' });
    const mismatched = (stats.dims ?? []).filter((d) => d.dim !== curDim);
    const last = Number(localStorage.getItem(HEAL_KEY) || 0);
    if (mismatched.length === 0) {
      if (opts.force || Date.now() - last > HEAL_INTERVAL_MS) {
        localStorage.setItem(HEAL_KEY, String(Date.now()));
      }
      return 0;
    }
    console.info(
      `[rag-heal] 发现维度不一致（${mismatched.map((d) => `${d.dim}维×${d.chunks}`).join(', ')}），` +
        `当前模型 ${curDim} 维 → 开始后台重建（不阻塞主进程）`,
    );

    // 3) 逐来源重建；只重算维度不对的块
    const sources = await invoke<RagSourceLite[]>('rag_list_sources', { namespace: 'ai-chat' });
    const cfg = await resolveEmbedConfig();
    const modelName = cfg?.model ?? '';
    for (const s of sources) {
      try {
        const rows = await invoke<RagChunkLite[]>('rag_list_chunks', {
          sourceId: s.id,
          namespace: 'ai-chat',
        });
        const stale = rows.filter((r) => r.dim !== curDim);
        if (stale.length === 0) continue;

        const updates: { id: string; vec: number[]; embed_model?: string }[] = [];
        for (let i = 0; i < stale.length; i += HEAL_BATCH) {
          const slice = stale.slice(i, i + HEAL_BATCH);
          const vecs = await embed(slice.map((r) => r.text));
          if (!vecs || vecs.length !== slice.length) {
            throw new Error(`嵌入失败或数量不匹配（${vecs?.length ?? 0}/${slice.length}）`);
          }
          slice.forEach((r, k) =>
            updates.push({ id: r.id, vec: vecs[k], embed_model: modelName || undefined }),
          );
          await yieldToUi(); // 每批让出主线程
        }
        const n = await invoke<number>('rag_update_vectors', {
          sourceId: s.id,
          updates,
          namespace: 'ai-chat',
        });
        healed += n;
        console.info(`[rag-heal] 「${s.title}」重建 ${n} 块 → ${curDim} 维`);
      } catch (e) {
        // 单个来源失败不影响其它来源；数据由后端事务保证不被破坏
        console.warn(`[rag-heal] 「${s.title}」重建失败（已跳过，原数据未改动）:`, e);
      }
      await yieldToUi();
    }

    if (healed > 0) {
      localStorage.setItem(HEAL_KEY, String(Date.now()));
      console.info(`[rag-heal] 完成：共重建 ${healed} 块，耗时 ${Date.now() - t0}ms`);
    }
  } catch (e) {
    console.warn('[rag-heal] 维度自愈失败（不影响对话）:', e);
  } finally {
    healing = false;
  }
  return healed;
}
