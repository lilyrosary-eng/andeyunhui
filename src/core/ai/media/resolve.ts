/**
 * 媒体配置解析入口（前端 → Rust 工具通道）。
 *
 * 职责：把「后端清单 + 路由表」（localStorage）解析成本次 agent 请求所需的
 * `media` 参数，供 Rust 侧 GenerateImageTool / GenerateSpeechTool 使用。
 *
 * 与旧的 resolveComfyuiConfig 的分工：
 *   - 旧函数只认 ComfyUI 三键，是「单后端」时代的产物；
 *   - 本模块走通用路由（resolveBackendFromStorage），支持 comfyui / openai 两种后端，
 *     并额外为 comfyui 档解析蓝图工作流（读文件 → 转换 → 找提示词位）。
 *
 * Rust 侧不再做任何路由决策——前端已经按「只降未配置」的约定选定了后端。
 * 解析失败不抛错（媒体是增强能力，不应阻断整轮对话）。
 */
import { invoke } from '@tauri-apps/api/core';
import { storage } from '@/core/storage';
import { convertGraphToApi, type ApiWorkflow } from '@/core/ai/comfyui/convert';
import { detectWorkflow } from '@/core/ai/comfyui/format';
import { getObjectInfo } from '@/core/ai/comfyui/objectInfo';
import { analyzeWorkflowParameters } from '@/core/ai/comfyui/params';
import { pickImageAt, pickPromptAt } from '@/core/ai/comfyuiConfig';
import type { MediaKind } from './backends';
import { resolveChain, loadRoutes, toMediaToolCfg, type MediaToolCfg, type ResolvedBackend } from './routing';
import { loadBackends } from './backends';
import { loadAllowedModules } from './customNodes';

/** 传给 Rust 的媒体参数：按能力分区，key 即 MediaKind。 */
export type MediaPayload = Partial<Record<MediaKind, MediaToolCfg>> & {
  /**
   * 各能力的**后备站**（不含首选，按链顺序）。兜底执行在 Rust 侧 ——
   * 前端在发请求时就退场了，只有 Rust 知道这一站成没成。
   */
  fallbacks?: Partial<Record<MediaKind, MediaToolCfg[]>>;
};

/**
 * 把「已解析出的一个后端」变成可下发的配置。
 * comfyui 档额外解析蓝图工作流（workflow + promptAt）；其余情况直接用路由结果。
 */
async function cfgFor(r: ResolvedBackend): Promise<MediaToolCfg> {
  // 配置期降级**一律记下来**（用户 2026-10-17 定的原则：不许静默）。
  // 这些都会随请求下发，由 Rust 并进运行期提示呈现 + 落日志。
  const notes: string[] = [];
  let cfg = toMediaToolCfg(r);
  // ComfyUI 档带上「已放行的自定义节点模块」：AI 自建工作流的安全审计要它。
  // 来源是用户设置（customNodes.ts），模型无法自行放行。
  if (cfg.backendKind === 'comfyui') {
    cfg = { ...cfg, allowedCustom: loadAllowedModules() };
  }

  // comfyui 档：蓝图工作流需读文件 → 转换 → 分析参数 → 定位提示词位。
  // 失败则退化为「仅 url（+ckpt）」——Rust 侧据此走内置最小 txt2img。
  if (cfg.backendKind === 'comfyui' && cfg.workflowPath) {
    try {
      const json = await invoke<unknown>('comfyui_read_workflow', { path: cfg.workflowPath });
      const k = detectWorkflow(json);
      if (k === 'unknown') {
        notes.push(`蓝图工作流认不出格式（既非 UI 画布图也非 API 工作流），本次退回内置流程`);
      } else {
        const info = await getObjectInfo(cfg.baseUrl).catch(() => undefined);
        if (k === 'ui' && !info) {
          notes.push('取不到 ComfyUI 节点定义（object_info），UI 画布图无法转换，本次退回内置流程');
        }
        let apiWf: ApiWorkflow;
        if (k === 'ui') {
          if (info) {
            const res = convertGraphToApi(json, info);
            if (!res.ok) notes.push(`工作流转换失败（${res.error}），本次退回内置流程`);
            apiWf = res.ok ? res.workflow : ({} as ApiWorkflow);
          } else {
            apiWf = {} as ApiWorkflow;
          }
        } else {
          apiWf = json as ApiWorkflow;
        }
        if (Object.keys(apiWf).length > 0) {
          const params = analyzeWorkflowParameters(apiWf, info);
          const promptAt = pickPromptAt(params);
          const imageAt = pickImageAt(params);
          if (promptAt) {
            return {
              ...cfg,
              workflow: apiWf,
              promptAt,
              ...(imageAt ? { imageAt } : {}),
              ...(notes.length ? { notes } : {}),
            } as MediaToolCfg;
          }
          notes.push('工作流里找不到提示词输入位（text），本次退回内置流程');
        }
      }
    } catch (e) {
      // 以前这里是空 catch —— 用户配了工作流、实际用的是内置流程，**他自己不可能知道**
      notes.push(`蓝图工作流不可用（${String(e).slice(0, 120)}），本次退回内置流程`);
    }
  }
  return notes.length ? { ...cfg, notes } : cfg;
}

/**
 * 为单个能力解析出**整条链**（按顺序，含首选）。
 * 顺序与就绪判据都来自 `resolveChain` / `isBackendReady` —— 与 `resolveOne` 同一套。
 */
async function resolveWholeChain(kind: MediaKind): Promise<MediaToolCfg[]> {
  const list = resolveChain(kind, loadBackends(storage), loadRoutes(storage));
  const out: MediaToolCfg[] = [];
  for (const b of list) out.push(await cfgFor({ kind, backend: b }));
  return out;
}

/**
 * 解析本轮请求需要携带的全部媒体配置（image / vision / speech）。
 * 任一能力无可用后端就不带该键（Rust 工具会给出「未配置」的明确提示）。
 *
 * 链长度 > 1 时把**首选之后的站**放进 `fallbacks` —— 那些是 Rust 侧兜底要用的。
 * 只有一个站就**不带** `fallbacks`（少一份冗余数据）。
 */
export async function resolveMediaConfig(kinds: MediaKind[] = ['image', 'vision', 'speech']): Promise<MediaPayload | null> {
  const out: MediaPayload = {};
  const fallbacks: Partial<Record<MediaKind, MediaToolCfg[]>> = {};
  await Promise.all(
    kinds.map(async (k) => {
      let chain: MediaToolCfg[];
      try {
        chain = await resolveWholeChain(k);
      } catch {
        chain = [];
      }
      if (!chain.length) return;
      out[k] = chain[0];
      if (chain.length > 1) fallbacks[k] = chain.slice(1);
    }),
  );
  if (Object.keys(fallbacks).length > 0) out.fallbacks = fallbacks;
  return Object.keys(out).length ? out : null;
}
