// 嵌入端点配置解析（插件侧，2026-10-18 新增）。
//
// 背景：此前 ApiEmbedder 的默认端点是硬编码的 `http://localhost:11434/api/embeddings`
// （Ollama）。本机没装 Ollama 时，摄取与检索都必然失败，而面板只显示一句
// 「嵌入请求失败: …」，用户无从下手。这里改成三级解析，并且**每一步都显式打日志**：
//
//   1) 显式配置：localStorage `andeyunhui.mobile.rag.embed`（{endpoint, apiKey, model}）。
//      与主应用「AI 对话」的伴侣记忆**共用同一个 key**（src/core/storage/keys.ts 的
//      KEYS.companion.ragEmbed）—— 在任一处配好，另一处自动生效。
//   2) 复用宿主当前算力来源：ai_get_profiles 的 active profile（base_url + api_key），
//      拼成 OpenAI 兼容的 /v1/embeddings。用户配好聊天模型即可直接跑，不需要再填一遍。
//   3) 兜底：Ollama 本机端点（不保证存在，失败时把真实 HTTP 错误原样抛给 UI）。
//
// 不做「失败退避」：本模块只在用户主动点「摄取 / 提问」时调用，静默跳过反而是欺骗。

import { ragEmbedApi } from '../api/host';
import { ApiEmbedder } from './api-embedder';

/** 与主应用共享的嵌入配置存储 key（勿改名：改了就跟 AI 对话的记忆配置脱钩）。 */
export const EMBED_CONFIG_KEY = 'andeyunhui.mobile.rag.embed';

export interface EmbedConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  /** 配置来源：routing=路由页选定 / explicit=手动端点 / profile=自动猜测。 */
  source: 'routing' | 'explicit' | 'profile';
  /** 来源说明（带 profile 名，便于用户核对）。 */
  label: string;
}

/** profile 的字段是 Rust 侧 snake_case，这里只声明用到的部分。 */
interface AiProfileLite {
  id?: string;
  name?: string;
  base_url?: string;
  api_key?: string;
  /** 模型 id（v1 形状里叫 model）。 */
  model?: string;
}

/**
 * 「这个模型像嵌入模型吗」——按名字判断。
 *
 * 为什么需要：复用算力来源时，用户当前选中的往往是**对话模型**（LM Studio 的 selection
 * 可能是 hy-mt2-1.8b 这类翻译小模型），拿去打 /v1/embeddings 会 404。
 * 而同一个 provider 里常常同时挂着一个真正的嵌入模型（如
 * `text-embedding-nomic-embed-text-v1.5`）。所以优先按名字挑嵌入模型，
 * 挑不到才退回 active（并明确警告）。
 */
const EMBED_NAME_RE = /embed|embedding|bge|gte|m3e|nomic/i;

/** 解析结果缓存（30s）：避免每次提问都 invoke 一次 ai_get_profiles。 */
let cache: { cfg: EmbedConfig; at: number } | null = null;
const CACHE_MS = 30_000;

/** 读显式配置（与主应用 AI 对话共享）。 */
export function getExplicitConfig(): { endpoint: string; apiKey: string; model: string } | null {
  try {
    const raw = localStorage.getItem(EMBED_CONFIG_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as { endpoint?: string; apiKey?: string; model?: string };
    if (!j || !j.endpoint) return null;
    return {
      endpoint: j.endpoint,
      apiKey: j.apiKey ?? '',
      model: j.model || 'text-embedding-3-small',
    };
  } catch (e) {
    console.error('[rag] 读取嵌入配置失败（localStorage）:', e);
    return null;
  }
}

/** 写显式配置（供面板的「嵌入设置」保存）。 */
export function setExplicitConfig(cfg: { endpoint: string; apiKey?: string; model?: string }): void {
  const payload = {
    endpoint: cfg.endpoint.trim(),
    apiKey: (cfg.apiKey ?? '').trim(),
    model: (cfg.model ?? '').trim() || 'text-embedding-3-small',
  };
  localStorage.setItem(EMBED_CONFIG_KEY, JSON.stringify(payload));
  cache = null; // 立即失效，下一次就会用新配置
  console.info('[rag] 嵌入配置已保存:', payload.endpoint, payload.model);
}

/** 清空显式配置（下次回落到「复用算力来源」）。 */
export function clearExplicitConfig(): void {
  localStorage.removeItem(EMBED_CONFIG_KEY);
  cache = null;
  console.info('[rag] 嵌入配置已清空，将复用当前算力来源');
}

/** 把 base_url 拼成 OpenAI 兼容的 embeddings 端点（已含 /v1 时不重复拼）。 */
function toEmbeddingsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/v1') || base.includes('/v1/')
    ? `${base}/embeddings`
    : `${base}/v1/embeddings`;
}

/**
 * 解析嵌入配置。**永不静默**：每一级命中都打一条日志说明用了哪个端点。
 *
 * 优先级与宿主 `semanticMemory.resolveEmbedConfig()` 完全一致（2026-11-05 对齐，之前两边相反）：
 *   ① 设置 → 模型 → 嵌入模型（`media_models.embedding`）
 *   ② 手动端点（localStorage `andeyunhui.mobile.rag.embed`，只给自建服务的人）
 *   ③ 自动猜测当前算力来源
 *   ④ 都没有 → 抛错
 *
 * 为什么删掉原来的「Ollama 本机兜底」：那是个隐形入口 —— 三条路都没配时它会悄悄拿
 * `localhost:11434` + `nomic-embed-text` 去试，用户看不到也察觉不到，失败表现成
 * "RAG 莫名其妙没结果"。宁可显式失败。
 * @param force 跳过缓存（用户点「重新检测」时用）
 */
export async function resolveEmbedConfig(force = false): Promise<EmbedConfig> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.cfg;

  // 1) 路由页选定的嵌入模型（宿主配置档案，跨端可读）
  try {
    const cfg2 = await window.__HOST_API__.invoke<{ media_models?: { embedding?: string | null } }>(
      'ai_get_config',
    );
    const want = (cfg2?.media_models?.embedding ?? '').trim();
    if (want) {
      const raw = await window.__HOST_API__.invoke<{ profiles?: AiProfileLite[] }>('ai_get_profiles');
      const hit = (raw?.profiles ?? []).find(
        (p) => p && (p.model ?? '').trim() === want && (p.base_url ?? '').trim(),
      );
      if (hit?.base_url) {
        const c: EmbedConfig = {
          endpoint: toEmbeddingsUrl(hit.base_url),
          apiKey: hit.api_key ?? '',
          model: want,
          source: 'routing',
          label: `路由页选定「${want}」`,
        };
        console.info('[rag] 嵌入端点 ← 路由页选定:', c.endpoint, `模型=${want}`);
        cache = { cfg: c, at: Date.now() };
        return c;
      }
      console.warn(`[rag] 路由页选的嵌入模型「${want}」在配置里找不到对应供应商，继续往下回落`);
    }
  } catch (e) {
    console.warn('[rag] 读取路由页嵌入选择失败，继续往下回落:', e);
  }

  // 2) 手动端点（高级）
  const explicit = getExplicitConfig();
  if (explicit) {
    const cfg: EmbedConfig = { ...explicit, source: 'explicit', label: '手动端点' };
    console.info('[rag] 嵌入端点 ← 手动端点:', cfg.endpoint, `模型=${cfg.model}`);
    cache = { cfg, at: Date.now() };
    return cfg;
  }

  // 3) 自动猜测：复用宿主算力来源。优先挑同名 provider 下的「嵌入模型」，而不是用户当前选中的对话模型。
  try {
    const raw = await window.__HOST_API__.invoke<{ profiles?: AiProfileLite[]; active?: string | null }>(
      'ai_get_profiles',
    );
    const list = (raw?.profiles ?? []).filter((p) => p && p.base_url);
    const active = list.find((p) => p.id === raw?.active) ?? list[0];
    const isEmbedName = (p: AiProfileLite) =>
      EMBED_NAME_RE.test(p.model ?? '') || EMBED_NAME_RE.test(p.name ?? '');
    // ★ 只在**当前那个 provider 的模型里**挑嵌入模型。
    //   原先是全表第一个匹配项，而 v1 兼容视图是 providers × models 一条一档（本机 188 条），
    //   模型列表长的供应商会插队：实测用户当前用的是本机 LM Studio，
    //   却挑中了 `nvidia/embed-qa-4 @ integrate.api.nvidia.com`（远端），
    //   于是「摄取文档」实际把正文发去了第三方，而不是用户自己维护的本地嵌入模型。
    const embedProfile =
      list.find((p) => isEmbedName(p) && p.base_url === active?.base_url) ??
      (active && isEmbedName(active) ? active : undefined) ??
      list.find(isEmbedName);
    const picked = embedProfile ?? active;
    if (picked?.base_url) {
      const usingEmbedModel = !!embedProfile;
      if (!usingEmbedModel) {
        console.warn(
          '[rag] 没找到名字像「嵌入模型」的档案，只能复用当前算力来源的端点。' +
            '若该端点不提供 /v1/embeddings，摄取会失败 —— 请到面板「修改」里显式指定嵌入模型。',
        );
      } else if (embedProfile.base_url !== active?.base_url) {
        // 跨供应商兜底也要说出来：维度、鉴权、是否出网都和用户以为的不一样
        console.warn(
          `[rag] 当前算力来源「${active?.name || active?.id || '?'}」里没有嵌入模型，` +
            `改用其它来源的 ${embedProfile.model || embedProfile.name} @ ${embedProfile.base_url}` +
            `（维度可能与库里已有的向量不一致 → 旧数据会检索不到）。建议在 AI 路由页显式选择嵌入模型。`,
        );
      }
      const cfg: EmbedConfig = {
        endpoint: toEmbeddingsUrl(picked.base_url),
        apiKey: picked.api_key ?? '',
        model: usingEmbedModel
          ? (picked.model || picked.name || '')
          : 'text-embedding-3-small',
        source: 'profile',
        label: usingEmbedModel
          ? `嵌入模型「${picked.model || picked.name}」`
          : `算力来源「${picked.name || picked.id || '未命名'}」`,
      };
      console.info('[rag] 嵌入端点 ← 复用:', cfg.endpoint, `模型=${cfg.model}`, `(${cfg.label})`);
      cache = { cfg, at: Date.now() };
      return cfg;
    }
      console.warn('[rag] 没有可用的 AI 算力来源（ai_get_profiles 为空或缺少 base_url）');
  } catch (e) {
    console.error('[rag] 读取 AI 算力来源失败:', e);
  }

  // 4) 三条路都没配 → 显式失败（原来这里是 Ollama 隐形兜底）
  throw new Error(
    '没有可用的嵌入端点：请到 设置 → 模型 → 「嵌入模型（RAG 记忆 / 知识库）」里选一个，' +
      '或在该面板的「高级」里手动填端点。未配置时对话沉淀与文档摄取都不会执行。',
  );
}

/** 探测端点是否可用（面板「检测」按钮）：发一条极短文本，返回向量维度或抛错。 */
export async function probeEmbedConfig(cfg: EmbedConfig): Promise<number> {
  console.info('[rag] 探测嵌入端点:', cfg.endpoint, cfg.model);
  const res = await ragEmbedApi(['ping'], {
    endpoint: cfg.endpoint,
    apiKey: cfg.apiKey || undefined,
    model: cfg.model || undefined,
  });
  const dim = res.embeddings?.[0]?.length ?? 0;
  console.info('[rag] 嵌入端点可用，维度 =', dim);
  return dim;
}

/**
 * 按解析出的配置构造默认嵌入器（摄取 / 检索共用，保证同一 namespace 用同一模型）。
 * 返回 cfg 用于错误信息里标明「是哪个端点、哪个模型失败了」。
 */
export async function createDefaultEmbedder(): Promise<{ embedder: ApiEmbedder; cfg: EmbedConfig }> {
  const cfg = await resolveEmbedConfig();
  return {
    embedder: new ApiEmbedder({ endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: cfg.model }),
    cfg,
  };
}

/** 把嵌入失败包装成带端点信息的可读错误（面板会原样显示）。 */
export function describeEmbedError(cfg: EmbedConfig | null, e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (!cfg) return `嵌入失败：${msg}`;
  return `嵌入失败（${cfg.label}：${cfg.endpoint} · ${cfg.model}）：${msg}`;
}

/**
 * 查询侧任务前缀（**只加给 query，不加给 document**）。
 *
 * 实测（2026-10-19，8 文档 / 4 查询，指标用**排序**而不是分数差）：
 *   qwen3-0.6b 无前缀       Recall@1 4/4 · MRR 1.000
 *   qwen3-0.6b + Instruct   Recall@1 4/4 · MRR 1.000
 *   nomic-v1.5 无前缀       Recall@1 2/4 · MRR 0.625
 *   nomic-v1.5 + Instruct   Recall@1 2/4 · MRR 0.625（加前缀反而让 margin 由 +0.008 变 -0.001）
 *
 * ⚠️ 更正：上一版这里写「加前缀区分度 0.284→0.370，提升 30%」是**错的** ——
 * 那是拿「相关分−无关分」的绝对差比较，而加前缀后所有分数整体下移（尺度变了），
 * 绝对差不可比（锚点没对齐）。用排序指标看，前缀对 Qwen3 **没有可测收益**。
 *
 * 保留前缀的唯一理由：Qwen3 官方要求 instruction（对长查询/多语言任务有帮助），
 * 且加前缀实测无副作用。**不要再对外宣称它提升了检索质量**。
 */
export function queryPrefixFor(model: string): string {
  if (/qwen3[-_ .]?embed/i.test(model)) {
    return 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ';
  }
  return '';
}

