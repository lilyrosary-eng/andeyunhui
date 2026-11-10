// 重排（rerank）配置解析 —— 检索阶段的**第二段打分**。
//
// 为什么要有它：向量检索是「双塔」结构（query 和 document 各算各的向量，只在最后点积一次），
// 它对「哪一段真的回答了这个问题」的判别力有限。重排是「交叉编码」：把 (query, document)
// 成对喂给模型，让注意力在两者之间交互，排序质量明显更高。代价是每次要跑 N 个前向，
// 所以标准做法是「向量召回 candidateK 条 → 重排 → 截 finalK 条」。
//
// ────────────────────────────────────────────────────────────────────────────
// ⚠️ 本模块存在的**第一原则**：绝不再造一个「假本地模型」陷阱。
//
// 嵌入配置（embed-config.ts）有个三级回落，最后会**拿对话模型的端点凑数**并只打一条
// console.warn —— 那是因为嵌入至少有个 Ollama 兜底的合理预期。重排不能照抄：
//   1. **没有兜底端点**。没有 rerank 端点就是不可用，直接降级为向量排序，不猜 URL。
//   2. **绝不把对话模型当 rerank**。只接受名字明确写着 rerank/ranker 的档案；
//      名字里带 embed 的一律排除（嵌入模型喂给 /v1/rerank 会返回常量或 404）。
//   3. **启用前必须真探测**（2 条文档：一条相关、一条无关），并且要求
//      「相关那条得分 > 无关那条」—— 这是「这个端点真的在做重排」的最低证据。
//   4. 任何一步不满足都返回 usable=false + 中文原因，由 UI 用灰字显示
//      「已降级为向量排序」，而不是静默用一半效果的东西冒充全效果。
//
// 不做失败退避：只在用户点「探测 / 保存 / 提问」时调用，静默跳过就是欺骗。
// ────────────────────────────────────────────────────────────────────────────

import { ragRerankApi } from '../api/host';

/** 重排配置存储 key（**独立于嵌入配置**：换重排不该动嵌入端点，反之也一样）。 */
export const RERANK_CONFIG_KEY = 'andeyunhui.mobile.rag.rerank';

/** 候选数量上下限（上限与 Rust `RERANK_MAX_DOCS` 一致，超过会被后端整批拒绝）。 */
export const CANDIDATE_K_MIN = 4;
export const CANDIDATE_K_MAX = 64;
export const CANDIDATE_K_DEFAULT = 20;
/** 最终保留数量上下限（finalK 就是喂进 prompt 的块数，太大反而稀释上下文）。 */
export const FINAL_K_MIN = 1;
export const FINAL_K_MAX = 20;
export const FINAL_K_DEFAULT = 6;
/** 超时（毫秒）：与 Rust 侧同一套钳制规则，前端先把住，避免用户填个 999999。 */
export const RERANK_TIMEOUT_MIN = 500;
export const RERANK_TIMEOUT_MAX = 15000;
export const RERANK_TIMEOUT_DEFAULT = 3000;

/**
 * 重排来源模式：
 *   auto   = 从现有 AI 算力来源里挑**名字像 rerank** 的档案（需要 /v1/rerank）；
 *   manual = 用户自己填端点；
 *   llm    = 用**对话模型打分**（不需要 /v1/rerank —— LM Studio / Ollama 的可用路径）。
 */
export type RerankMode = 'auto' | 'manual' | 'llm';

export interface RerankSettings {
  /** 总开关（off 时检索链路与改造前逐字一致）。 */
  enabled: boolean;
  mode: RerankMode;
  /** 手动模式的基址（会归一化成 /v1/rerank 或保留 /api/rerank）。 */
  baseUrl: string;
  apiKey: string;
  /** 手动模式的模型名。 */
  model: string;
  candidateK: number;
  finalK: number;
  timeoutMs: number;
}

export const RERANK_DEFAULTS: RerankSettings = {
  enabled: false,
  mode: 'auto',
  baseUrl: '',
  apiKey: '',
  model: '',
  candidateK: CANDIDATE_K_DEFAULT,
  finalK: FINAL_K_DEFAULT,
  timeoutMs: RERANK_TIMEOUT_DEFAULT,
};

/** 解析后的可用配置；usable=false 时 reason 必须是能给人看的一句话。 */
export interface ResolvedRerank {
  usable: boolean;
  /** 实际请求的重排端点（usable=false 时为空串）。 */
  endpoint: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  candidateK: number;
  finalK: number;
  /** 实际实现：`api` = /v1/rerank；`llm` = 对话模型打分。 */
  apiMode: 'api' | 'llm';
  /** 命中来源：manual=显式端点 / profile=复用算力来源里的重排模型 / llm=对话模型打分 / none=不可用。 */
  source: 'manual' | 'profile' | 'llm' | 'none';
  /** 展示用一句话（含档案名，便于核对到底用的哪家）。 */
  label: string;
  /** usable=false 的原因（灰字直接显示）。 */
  reason: string;
}

/** 探测结果。 */
export interface RerankProbeResult {
  /** 相关文档得分。 */
  relevantScore: number;
  /** 无关文档得分。 */
  irrelevantScore: number;
  /** 两者的差（重排模型的基本判据：必须 > 0）。 */
  gap: number;
  latencyMs: number;
  scored: number;
  endpoint: string;
  model: string;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 模式归一化：未知值一律回 auto（老配置里没有 llm 字段也能平滑升级）。 */
function normalizeMode(v: unknown): RerankMode {
  return v === 'manual' ? 'manual' : v === 'llm' ? 'llm' : 'auto';
}

/** 读并归一化设置（越界值一律钳制，不做「读到脏数据就整个放弃」）。 */
export function getRerankSettings(): RerankSettings {
  let raw: Partial<RerankSettings> = {};
  try {
    const s = localStorage.getItem(RERANK_CONFIG_KEY);
    if (s) raw = JSON.parse(s) as Partial<RerankSettings>;
  } catch (e) {
    console.error('[rag] 读取重排配置失败（localStorage），已按默认值继续:', e);
  }
  const finalK = clampInt(raw.finalK, FINAL_K_MIN, FINAL_K_MAX, FINAL_K_DEFAULT);
  // candidateK 必须 ≥ finalK，否则「召回 3 条取前 6 条」这种配置毫无意义。
  const candidateK = Math.max(
    clampInt(raw.candidateK, CANDIDATE_K_MIN, CANDIDATE_K_MAX, CANDIDATE_K_DEFAULT),
    finalK,
  );
  return {
    enabled: raw.enabled === true,
    mode: normalizeMode(raw.mode),
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '',
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
    model: typeof raw.model === 'string' ? raw.model.trim() : '',
    candidateK,
    finalK,
    timeoutMs: clampInt(raw.timeoutMs, RERANK_TIMEOUT_MIN, RERANK_TIMEOUT_MAX, RERANK_TIMEOUT_DEFAULT),
  };
}

/** 保存设置（只写入给定字段，其余沿用当前值 + 默认）。 */
export function saveRerankSettings(patch: Partial<RerankSettings>): RerankSettings {
  const merged: RerankSettings = { ...getRerankSettings(), ...patch };
  const normalized: RerankSettings = {
    enabled: merged.enabled === true,
    mode: normalizeMode(merged.mode),
    baseUrl: (merged.baseUrl ?? '').trim(),
    apiKey: (merged.apiKey ?? '').trim(),
    model: (merged.model ?? '').trim(),
    finalK: clampInt(merged.finalK, FINAL_K_MIN, FINAL_K_MAX, FINAL_K_DEFAULT),
    candidateK: CANDIDATE_K_DEFAULT,
    timeoutMs: clampInt(
      merged.timeoutMs,
      RERANK_TIMEOUT_MIN,
      RERANK_TIMEOUT_MAX,
      RERANK_TIMEOUT_DEFAULT,
    ),
  };
  normalized.candidateK = Math.max(
    clampInt(merged.candidateK, CANDIDATE_K_MIN, CANDIDATE_K_MAX, CANDIDATE_K_DEFAULT),
    normalized.finalK,
  );
  localStorage.setItem(RERANK_CONFIG_KEY, JSON.stringify(normalized));
  cache = null;
  console.info(
    `[rag] 重排配置已保存：启用=${normalized.enabled} 模式=${normalized.mode} ` +
      `候选 ${normalized.candidateK} → 最终 ${normalized.finalK}（超时 ${normalized.timeoutMs}ms）`,
  );
  return normalized;
}

/** 清除重排配置（回到「未启用 + 自动模式」）。 */
export function clearRerankSettings(): void {
  localStorage.removeItem(RERANK_CONFIG_KEY);
  cache = null;
  console.info('[rag] 重排配置已清空，检索回到向量排序');
}

/**
 * 重排端点归一化（与主应用 `src/core/settings/embedUrl.ts` 的嵌入版**同一套思路**，
 * 但后缀不同，且必须保留 Ollama 的 `/api/rerank`，所以不复用那个函数）。
 *
 * 规则：
 *   1. 已含 `/rerank` → 原样（用户显式填的 Ollama `/api/rerank` 走这条）；
 *   2. 以 `/v1` 结尾或已含 `/v1/` → 补 `/rerank`；
 *   3. 其它（只有域名 / 以 `/api` 结尾）→ 补 `/v1/rerank`。
 */
export function normalizeRerankEndpoint(raw: string): string {
  const s = (raw || '').trim();
  if (!s) return '';
  const noSlash = s.replace(/\/+$/, '');
  if (/\/rerank$/i.test(noSlash)) return noSlash;
  if (/\/v1$/i.test(noSlash) || /\/v1\//i.test(noSlash)) return `${noSlash}/rerank`;
  return `${noSlash}/v1/rerank`;
}

/**
 * 「这个名字像重排模型吗」。
 *
 * 只认**明确写了重排**的名字：rerank / reranker / ranker / 家族缩写形式（bge-r、jina-r1…）。
 * 用户提到的 bge-reranker / jina / e5 里，`jina`、`e5` 单独出现时更常见的是**嵌入**模型
 * （jina-embeddings-v3、text-embedding-androidlab/e5），把它们当重排模型正是「假本地模型」
 * 的翻版，所以这里一律要求带 rank 字样。
 * 反过来，`/embed/` 出现在名字里就直接否决（哪怕同时带 rank 也交给探测去判）。
 */
const RERANK_NAME_RE = /(rerank|reranker|ranker|rank[-_.]?model|bge[-_.]?r[-_.]?\d|jina[-_.]?r[-_.]?\d)/i;
const EMBED_NAME_RE = /embed/i;

export function looksLikeReranker(name: string): boolean {
  if (!name) return false;
  if (EMBED_NAME_RE.test(name) && !RERANK_NAME_RE.test(name)) return false;
  return RERANK_NAME_RE.test(name);
}

/** profile 字段是 Rust 侧 snake_case，这里只声明用到的部分。 */
interface AiProfileLite {
  id?: string;
  name?: string;
  base_url?: string;
  api_key?: string;
  model?: string;
}

/** 解析结果缓存（30s）：避免每次提问都 invoke 一次 ai_get_profiles。 */
let cache: { cfg: ResolvedRerank; at: number } | null = null;
const CACHE_MS = 30_000;

const DEGRADED = '已降级为向量排序';

function unusable(reason: string, s: RerankSettings, source: 'manual' | 'profile' | 'llm' | 'none'): ResolvedRerank {
  return {
    usable: false,
    endpoint: '',
    apiKey: '',
    model: '',
    timeoutMs: s.timeoutMs,
    candidateK: s.candidateK,
    finalK: s.finalK,
    apiMode: s.mode === 'llm' ? 'llm' : 'api',
    source,
    label: DEGRADED,
    reason,
  };
}

/** LLM 打分比专用 rerank 慢一个数量级：低于 15s 的配置一律抬到 15s（后端上限 60s）。 */
const LLM_TIMEOUT_FLOOR = 15000;

/** 找一个可用于「对话打分」的档案：优先当前激活的那个，其次第一个有 base_url + model 的。 */
async function findLlmProfile(): Promise<{ base_url: string; api_key: string; model: string; label: string } | null> {
  const raw = await window.__HOST_API__.invoke<{ profiles?: AiProfileLite[]; active?: string | null }>(
    'ai_get_profiles',
  );
  const list = (raw?.profiles ?? []).filter((p) => p && p.base_url);
  if (list.length === 0) return null;
  const active = raw?.active ? list.find((p) => p.id === raw.active) : undefined;
  const hit = active || list.find((p) => p.model) || list[0];
  if (!hit?.base_url) return null;
  return {
    base_url: hit.base_url,
    api_key: hit.api_key ?? '',
    model: (hit.model || '').trim(),
    label: `对话模型打分「${hit.name || hit.id || '未命名'}」· ${(hit.model || '').trim() || '（未填模型）'}`,
  };
}

/** 在算力来源里找名字像重排模型的档案（只看名字，**不做任何请求**）。 */
async function findRerankProfile(): Promise<{ base_url: string; api_key: string; model: string; label: string } | null> {
  const raw = await window.__HOST_API__.invoke<{ profiles?: AiProfileLite[]; active?: string | null }>(
    'ai_get_profiles',
  );
  const list = (raw?.profiles ?? []).filter((p) => p && p.base_url);
  const hit = list.find(
    (p) => looksLikeReranker(p.model ?? '') || looksLikeReranker(p.name ?? ''),
  );
  if (!hit?.base_url) return null;
  const model = (hit.model || hit.name || '').trim();
  return {
    base_url: hit.base_url,
    api_key: hit.api_key ?? '',
    model,
    label: `算力来源「${hit.name || hit.id || '未命名'}」· ${model}`,
  };
}

/**
 * 按给定设置解析重排端点（两级：手动端点 → 算力来源里挑重排模型；**没有第三级兜底**）。
 * 不读写缓存 —— 缓存只在 `resolveRerank()` 那一层管，避免「表单里试一下」污染真实检索。
 */
async function resolveFromSettings(s: RerankSettings): Promise<ResolvedRerank> {
  if (!s.enabled) {
    return unusable(`重排未启用（${DEGRADED}）`, s, 'none');
  }
  let cfg: ResolvedRerank;
  if (s.mode === 'llm') {
    // 对话模型打分：完全绕开 /v1/rerank，因此 LM Studio / Ollama 也能用。
    let picked: Awaited<ReturnType<typeof findLlmProfile>> = null;
    try {
      picked = await findLlmProfile();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return unusable(`读取算力来源失败：${msg}（${DEGRADED}）`, s, 'llm');
    }
    if (!picked) {
      cfg = unusable(`没有可用的对话模型（${DEGRADED}）`, s, 'llm');
    } else if (!picked.model) {
      cfg = unusable(`该算力来源没有填模型名，无法用于打分（${DEGRADED}）`, s, 'llm');
    } else {
      cfg = {
        usable: true,
        endpoint: picked.base_url,
        apiKey: picked.api_key,
        model: picked.model,
        timeoutMs: Math.max(s.timeoutMs, LLM_TIMEOUT_FLOOR),
        candidateK: Math.min(s.candidateK, 12),
        finalK: Math.min(s.finalK, s.candidateK),
        apiMode: 'llm',
        source: 'llm',
        label: picked.label,
        reason: '',
      };
    }
  } else if (s.mode === 'manual') {
    const endpoint = normalizeRerankEndpoint(s.baseUrl);
    if (!endpoint || !/^https?:\/\//i.test(endpoint)) {
      cfg = unusable(`手动端点无效：「${s.baseUrl || '（空）'}」不是 http(s) 地址（${DEGRADED}）`, s, 'manual');
    } else if (!s.model) {
      cfg = unusable(`手动模式没填模型名（${DEGRADED}）`, s, 'manual');
    } else {
      cfg = {
        usable: true,
        endpoint,
        apiKey: s.apiKey,
        model: s.model,
        timeoutMs: s.timeoutMs,
        candidateK: s.candidateK,
        finalK: s.finalK,
        apiMode: 'api',
        source: 'manual',
        label: `手动端点 · ${s.model}`,
        reason: '',
      };
    }
  } else {
    let picked: Awaited<ReturnType<typeof findRerankProfile>> = null;
    try {
      picked = await findRerankProfile();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[rag] 读取算力来源失败（重排）:', msg);
      return unusable(`读取算力来源失败：${msg}（${DEGRADED}）`, s, 'profile');
    }
    if (!picked) {
      const why =
        `在算力来源里没找到名字写着 rerank/ranker 的模型。` +
        `**不会拿对话模型凑数**（对话模型没有 /v1/rerank，喂进去只会得到一堆假分数）—— ` +
        `请在「检索设置」里显式填重排端点与模型名，或先接入一个 rerank 模型。`;
      console.warn(`[rag] 重排不可用：${why} ${DEGRADED}`);
      cfg = unusable(why, s, 'profile');
    } else {
      cfg = {
        usable: true,
        endpoint: normalizeRerankEndpoint(picked.base_url),
        apiKey: picked.api_key,
        model: picked.model,
        timeoutMs: s.timeoutMs,
        candidateK: s.candidateK,
        finalK: s.finalK,
        apiMode: 'api',
        source: 'profile',
        label: picked.label,
        reason: '',
      };
    }
  }
  console.info(
    cfg.usable
      ? `[rag] 重排端点 ← ${cfg.source}：${cfg.endpoint} · ${cfg.model}（候选 ${cfg.candidateK} → 最终 ${cfg.finalK}）`
      : `[rag] 重排端点 ← 不可用：${cfg.reason}`,
  );
  return cfg;
}

/**
 * 解析**已保存**的重排配置（检索链路用）。
 * @param force 跳过缓存（用户点「重新探测」/ 刚改过设置时用）
 */
export async function resolveRerank(force = false): Promise<ResolvedRerank> {
  const s = getRerankSettings();
  if (!s.enabled) {
    // 关闭状态不进缓存：它不依赖任何远程信息，而且开关一变就该立刻生效。
    cache = null;
    return unusable(`重排未启用（${DEGRADED}）`, s, 'none');
  }
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.cfg;
  const cfg = await resolveFromSettings(s);
  cache = { cfg, at: Date.now() };
  return cfg;
}

/**
 * 解析**表单里尚未保存**的设置（「探测」按钮用）。
 * 刻意不写缓存：试配置不该污染真实检索用的那份解析结果。
 */
export function resolveRerankWith(s: RerankSettings): Promise<ResolvedRerank> {
  return resolveFromSettings(s);
}

/** 探测用的两条短文档：第 1 条切题、第 2 条明显不切题。 */
const PROBE_QUERY = '路由器每隔几小时掉线，重启能恢复，是什么原因？';
const PROBE_RELEVANT =
  '光猫和路由器同时过热时，PPP 会话会反复掉线；先摸一下设备外壳是否烫手，重启后能恢复几小时，通常是散热或 DHCP 租期问题。';
const PROBE_IRRELEVANT =
  '番茄炒蛋的做法：鸡蛋打散加少许盐，热锅凉油炒至凝固盛出，再下番茄块加糖翻炒，最后回锅混合即可。';

/**
 * 真实探测：2 条短文档，要求「相关的排前面」。
 *
 * 为什么不止步于 HTTP 200：`/v1/rerank` 路径谁都能实现 —— 一个把 query 忽略掉、
 * 只会返回常量分的端点也能返回 200。只有「相关文档分数明显高于无关文档」
 * 才证明它真的在拿 query 和文档做交互打分。
 * @throws 失败时抛中文错误（UI 原样展示）
 */
export async function probeRerankConfig(cfg: ResolvedRerank): Promise<RerankProbeResult> {
  if (!cfg.usable) throw new Error(cfg.reason || '重排配置不可用');
  console.info('[rag] 探测重排端点:', cfg.endpoint, cfg.model, `${cfg.timeoutMs}ms`);
  const t0 = Date.now();
  const res = await ragRerankApi(
    PROBE_QUERY,
    [PROBE_RELEVANT, PROBE_IRRELEVANT],
    {
      endpoint: cfg.endpoint,
      apiKey: cfg.apiKey || undefined,
      model: cfg.model,
      mode: cfg.apiMode,
      timeoutMs: cfg.timeoutMs,
    },
  );
  const latencyMs = Date.now() - t0;
  const items = res?.results ?? [];
  if (items.length !== 2) {
    throw new Error(
      `重排端点只给 ${items.length} 条打了分（应为 2 条）。` +
        `该端点很可能把 top_n 当成「只返回最好的一条」实现了 —— 换成这样的端点，` +
        `检索会莫名丢掉一半候选。`,
    );
  }
  const byIdx = new Map<number, number>();
  for (const it of items) byIdx.set(it.index, it.score);
  const relevantScore = byIdx.get(0);
  const irrelevantScore = byIdx.get(1);
  if (relevantScore === undefined || irrelevantScore === undefined) {
    throw new Error(`重排返回的 index 不是 0/1（收到 ${items.map((i) => i.index).join(', ')}），无法核对`);
  }
  const gap = relevantScore - irrelevantScore;
  if (!(gap > 0)) {
    throw new Error(
      `相关文档没能排到前面（相关 ${relevantScore.toFixed(4)} ≤ 无关 ${irrelevantScore.toFixed(4)}）。` +
        `这说明该端点并没有在做 query-document 交叉打分 —— 已按「不可用」处理，不会启用。`,
    );
  }
  return {
    relevantScore,
    irrelevantScore,
    gap,
    latencyMs,
    scored: items.length,
    endpoint: cfg.endpoint,
    model: res.model || cfg.model,
  };
}

/** 探测 + 一句话结论（UI 直接显示）。 */
export async function describeRerankProbe(cfg: ResolvedRerank): Promise<string> {
  const r = await probeRerankConfig(cfg);
  const weak = r.gap < 0.05;
  return (
    `可用 · ${r.model} · ${r.scored} 条打分耗时 ${r.latencyMs}ms · ` +
    `相关 ${r.relevantScore.toFixed(4)} / 无关 ${r.irrelevantScore.toFixed(4)}（区分度 ${r.gap.toFixed(4)}）` +
    (weak ? ' —— 区分度偏低，建议换重排模型' : '')
  );
}

/** 给 UI 的一句话模式描述（灰字用）。 */
export function rerankModeText(cfg: ResolvedRerank): string {
  if (!cfg.usable) return DEGRADED;
  return `重排 ${cfg.candidateK} → ${cfg.finalK}（${cfg.label}）`;
}

export { DEGRADED };
