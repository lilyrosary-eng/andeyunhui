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

/** 兜底端点（Ollama 本机，OpenAI 不兼容路径的专用 /api/embeddings）。 */
export const FALLBACK_ENDPOINT = 'http://localhost:11434/api/embeddings';
/** 兜底模型（nomic-embed-text，768 维）。 */
export const FALLBACK_MODEL = 'nomic-embed-text';

export interface EmbedConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  /** 配置来源：explicit=显式配置 / profile=复用算力来源 / fallback=Ollama 兜底。 */
  source: 'explicit' | 'profile' | 'fallback';
  /** 来源说明（带 profile 名，便于用户核对）。 */
  label: string;
}

/** profile 的字段是 Rust 侧 snake_case，这里只声明用到的部分。 */
interface AiProfileLite {
  id?: string;
  name?: string;
  base_url?: string;
  api_key?: string;
}

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
 * 解析嵌入配置（三级回落）。**永不静默**：每一级命中都打一条日志说明用了哪个端点。
 * @param force 跳过缓存（用户点「重新检测」时用）
 */
export async function resolveEmbedConfig(force = false): Promise<EmbedConfig> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.cfg;

  // 1) 显式配置
  const explicit = getExplicitConfig();
  if (explicit) {
    const cfg: EmbedConfig = { ...explicit, source: 'explicit', label: '显式配置' };
    console.info('[rag] 嵌入端点 ← 显式配置:', cfg.endpoint, `模型=${cfg.model}`);
    cache = { cfg, at: Date.now() };
    return cfg;
  }

  // 2) 复用宿主当前算力来源
  try {
    const raw = await window.__HOST_API__.invoke<{ profiles?: AiProfileLite[]; active?: string | null }>(
      'ai_get_profiles',
    );
    const list = (raw?.profiles ?? []).filter((p) => p && p.base_url);
    const active = list.find((p) => p.id === raw?.active) ?? list[0];
    if (active?.base_url) {
      const cfg: EmbedConfig = {
        endpoint: toEmbeddingsUrl(active.base_url),
        apiKey: active.api_key ?? '',
        model: 'text-embedding-3-small',
        source: 'profile',
        label: `算力来源「${active.name || active.id || '未命名'}」`,
      };
      console.info('[rag] 嵌入端点 ← 复用算力来源:', cfg.endpoint, `模型=${cfg.model}`);
      cache = { cfg, at: Date.now() };
      return cfg;
    }
    console.warn('[rag] 没有可用的 AI 算力来源（ai_get_profiles 为空或缺少 base_url），回落到 Ollama 兜底');
  } catch (e) {
    console.error('[rag] 读取 AI 算力来源失败:', e);
  }

  // 3) 兜底
  const cfg: EmbedConfig = {
    endpoint: FALLBACK_ENDPOINT,
    apiKey: '',
    model: FALLBACK_MODEL,
    source: 'fallback',
    label: 'Ollama 本机兜底',
  };
  console.warn('[rag] 嵌入端点 ← Ollama 兜底（若本机没跑 Ollama，摄取/检索会失败）:', cfg.endpoint);
  cache = { cfg, at: Date.now() };
  return cfg;
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

