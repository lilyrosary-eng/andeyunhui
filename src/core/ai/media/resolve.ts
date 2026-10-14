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
import { resolveBackend, loadRoutes, toMediaToolCfg, type MediaToolCfg } from './routing';
import { loadBackends } from './backends';

/** 传给 Rust 的媒体参数：按能力分区，key 即 MediaKind。 */
export type MediaPayload = Partial<Record<MediaKind, MediaToolCfg>>;

/**
 * 为单个能力解析出可传给 Rust 的配置。
 * comfyui 档额外解析蓝图工作流（workflow + promptAt）；其余情况直接用路由结果。
 */
async function resolveOne(kind: MediaKind): Promise<MediaToolCfg | null> {
  const r = resolveBackend(kind, loadBackends(storage), loadRoutes(storage));
  if (!r) return null;
  const cfg = toMediaToolCfg(r);

  // comfyui 档：蓝图工作流需读文件 → 转换 → 分析参数 → 定位提示词位。
  // 失败则退化为「仅 url（+ckpt）」——Rust 侧据此走内置最小 txt2img。
  if (cfg.backendKind === 'comfyui' && cfg.workflowPath) {
    try {
      const json = await invoke<unknown>('comfyui_read_workflow', { path: cfg.workflowPath });
      const k = detectWorkflow(json);
      if (k !== 'unknown') {
        const info = await getObjectInfo(cfg.baseUrl).catch(() => undefined);
        let apiWf: ApiWorkflow;
        if (k === 'ui') {
          if (info) {
            const res = convertGraphToApi(json, info);
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
            return { ...cfg, workflow: apiWf, promptAt, ...(imageAt ? { imageAt } : {}) } as MediaToolCfg;
          }
        }
      }
    } catch {
      /* 蓝图工作流不可用 → 落到 ckpt / 内置档 */
    }
  }
  return cfg;
}

/**
 * 解析本轮请求需要携带的全部媒体配置（image / vision / speech）。
 * 任一能力无可用后端就不带该键（Rust 工具会给出「未配置」的明确提示）。
 */
export async function resolveMediaConfig(kinds: MediaKind[] = ['image', 'vision', 'speech']): Promise<MediaPayload | null> {
  const entries = await Promise.all(
    kinds.map(async (k) => [k, await resolveOne(k).catch(() => null)] as const),
  );
  const out: MediaPayload = {};
  for (const [k, v] of entries) if (v) out[k] = v;
  return Object.keys(out).length ? out : null;
}
