/**
 * 媒体路由表（方案 A · 单链）——「能力 → 有序后端 id 列表」。
 *
 * 语义（与用户对齐的关键约定）：
 *   - 按列表顺序找**第一个配置完整**的后端（isBackendReady）作为本次调用目标；
 *   - **降级只针对「未配置」**：列表前面的后端没配好就跳过试下一个；
 *   - 已选中后端**执行失败不转下一个**——用户显式配了本地后端就是想用本地
 *     （可能为隐私、或云端没额度），静默转云端属越权且可能产生费用。
 *   - 全列表都不完整 → 返回 null，调用方给出可自纠的明确错误。
 *
 * 纯函数，Storage 注入可测。
 */
import { storage, type Storage } from '@/core/storage';
import { ROUTES_KEY, loadBackends, isBackendReady, effectiveBaseUrl, effectiveCkpt, effectiveTxt2img, effectiveSelfCheck, effectiveOnFail, type MediaBackend, type MediaKind, ALL_KINDS } from './backends';

/** 路由表：能力 → 有序后端 id 列表。未列出的能力视为「无后端」。 */
export type MediaRoutes = Partial<Record<MediaKind, string[]>>;

/** 读路由表（空对象=未配置）。 */
export function loadRoutes(s: Storage = storage): MediaRoutes {
  const v = s.getJSON<MediaRoutes>(ROUTES_KEY, {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/** 写路由表。 */
export function saveRoutes(routes: MediaRoutes, s: Storage = storage): void {
  s.setJSON(ROUTES_KEY, routes);
}

/** 某能力当前配置的后端 id 列表（未配置返回空数组）。 */
export function routeFor(kind: MediaKind, routes: MediaRoutes): string[] {
  const ids = routes[kind];
  return Array.isArray(ids) ? ids : [];
}

/** 路由解析结果：选中的后端 + 本次能力。 */
export interface ResolvedBackend {
  kind: MediaKind;
  backend: MediaBackend;
}

/**
 * 为一个能力解析出**首个配置完整**的后端。
 * 只跳过「未配置」的后端；不做执行失败后的降级（见文件头约定）。
 * 无可用后端返回 null。
 */
export function resolveBackend(
  kind: MediaKind,
  backends: MediaBackend[],
  routes: MediaRoutes,
  s: Storage = storage,
): ResolvedBackend | null {
  const byId = new Map(backends.map((b) => [b.id, b]));
  for (const id of routeFor(kind, routes)) {
    const b = byId.get(id);
    if (b && isBackendReady(b, kind, s)) return { kind, backend: b };
  }
  return null;
}

/**
 * 为某能力解析出**整条可用链**（按顺序，只含"配置完整"的站）。
 *
 * 判据必须与 `resolveBackend` **完全一致**（同一顺序、同一就绪规则），
 * 否则"首选"与"链首"会不是同一个后端 —— 那种错最难查。
 * 区别只是取全部而非首个：**兜底需要后面的站**。
 */
export function resolveChain(
  kind: MediaKind,
  backends: MediaBackend[],
  routes: MediaRoutes,
  s: Storage = storage,
): MediaBackend[] {
  const byId = new Map(backends.map((b) => [b.id, b]));
  const out: MediaBackend[] = [];
  for (const id of routeFor(kind, routes)) {
    const b = byId.get(id);
    if (b && isBackendReady(b, kind, s)) out.push(b);
  }
  return out;
}

/** 便捷封装：直接从 Storage 读清单与路由并解析。 */
export function resolveBackendFromStorage(kind: MediaKind, s: Storage = storage): ResolvedBackend | null {
  return resolveBackend(kind, loadBackends(s), loadRoutes(s), s);
}

/**
 * 把路由解析结果转成传给 Rust 的媒体配置（ai_chat_agent 的 media 参数）。
 * 只带上**本次调用需要**的字段（后端已由前端选好，Rust 不再做路由决策）。
 */
export interface MediaToolCfg {
  kind: MediaKind;
  backendKind: string;
  baseUrl: string;
  apiKey: string;
  ckpt?: string;
  workflowPath?: string;
  skillSlug?: string;
  /** 后端显示名 —— 运行期提示里指认"是哪一站"用（"本地 ComfyUI 失败"比报端点有用）。 */
  name: string;
  /** 失败策略：`stop` 立刻报错 / `fallback` 转下一站。兜底决策在 Rust 侧做。 */
  onFail?: 'stop' | 'fallback';
  /** openai 档：该能力的模型名。 */
  model?: string;
  /** openai 档：引用哪个档案取凭证（Rust 侧据此解析，避免前端传 key）。 */
  profileId?: string;
  /** comfyui 档：resolve.ts 解析后的 API 工作流（完整节点图）。 */
  workflow?: Record<string, unknown>;
  /** comfyui 档：提示词写入位（Rust 据此把描述插进工作流）。 */
  promptAt?: { nodeId: string; inputKey: string };
  /** comfyui 档：**图片输入位**（Rust 据此把上传后的文件名写进工作流，实现图生图）。 */
  imageAt?: { nodeId: string; inputKey: string };
  /**
   * comfyui 档：用户**已放行**的自定义节点模块名（`object_info` 的 `python_module` 原文）。
   *
   * 只在 AI 自建工作流时被安全审计消费：未在此列出的自定义节点会被拒绝执行。
   * 必须来自用户设置，**不能由模型决定**——见 core/ai/media/customNodes.ts。
   */
  allowedCustom?: string[];
}

/** 由解析结果构造 Rust 侧配置。 */
export function toMediaToolCfg(r: ResolvedBackend): MediaToolCfg {
  const b = r.backend;
  return {
    kind: r.kind,
    name: b.name.trim() || (b.kind === 'comfyui' ? 'ComfyUI' : 'OpenAI 兼容'),
    backendKind: b.kind,
    // ComfyUI 统一取「本地生图」面板的端点（见 effectiveBaseUrl）；其它后端用条目自己的。
    baseUrl: effectiveBaseUrl(b),
    apiKey: b.apiKey.trim(),
    // checkpoint 与采样参数同样统一取「本地生图」面板那一处（见 effectiveCkpt / effectiveTxt2img）。
    // ⚠️ comfyui 档**总是**带上 ckpt（哪怕是空串）：空串是"自动挑一个"的正常值，
    //    不传的话后端分不清"没配"与"配了空"。其它后端沿用旧口径 —— 空就不带。
    ...(b.kind === 'comfyui' || effectiveCkpt(b) ? { ckpt: effectiveCkpt(b) } : {}),
    ...(effectiveTxt2img(b) ? { txt2img: effectiveTxt2img(b) } : {}),
    // 自动自检开关：只在**图像**能力上下发（自检发生在出图之后），
    // 与后端类型无关 —— 云端出图同样该自检。
    ...(r.kind === 'image' ? { selfcheck: effectiveSelfCheck() } : {}),
    // 失败策略随条目下发 —— 兜底决策在 Rust 侧做（只有它知道失败）
    onFail: effectiveOnFail(b),
    ...(b.extras.workflowPath?.trim() ? { workflowPath: b.extras.workflowPath.trim() } : {}),
    ...(b.extras.skillSlug?.trim() ? { skillSlug: b.extras.skillSlug.trim() } : {}),
    ...(b.extras.models?.[r.kind]?.trim() ? { model: b.extras.models[r.kind]!.trim() } : {}),
    ...(b.extras.profileId?.trim() ? { profileId: b.extras.profileId.trim() } : {}),
  };
}

/** 首次调用时的默认路由（迁移用）：按清单里各后端声明的 caps 拼出单链。 */
export function defaultRoutes(backends: MediaBackend[]): MediaRoutes {
  const out: MediaRoutes = {};
  for (const kind of ALL_KINDS) {
    const ids = backends.filter((b) => b.caps.includes(kind)).map((b) => b.id);
    if (ids.length) out[kind] = ids;
  }
  return out;
}
