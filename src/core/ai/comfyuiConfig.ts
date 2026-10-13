/**
 * ComfyUI 生图配置解析（前端 → Rust 工具通道）。
 *
 * 背景：generate_image 工具跑在 Rust 侧，而 ComfyUI 配置存在前端 localStorage，
 * Rust 读不到。故每次 agent 请求前在此解析一次，作为 ai_chat_agent 的 comfyui 参数传入，
 * 落到 ToolContext.comfyui（Rust 侧 ComfyuiToolCfg）。
 *
 * 解析内容与蓝图 image 节点（AiWorkflowView）保持同一套路由语义：
 *   ① 配了端点 + 蓝图指定工作流 → 读文件 →（UI 图则拉 object_info 转换）→ 分析参数 →
 *      产出 { url, workflow, promptAt }（promptAt 即提示词写入位，供 Rust 直接插入描述）；
 *   ② 配了端点 + checkpoint → 产出 { url, ckpt }（Rust 走内置最小 txt2img）；
 *   ③ 未配端点 → 返回 null（Rust 回退云端 image_model）。
 *
 * 解析失败不抛错（生图是增强能力，不应阻断整轮对话）：降级到下一档路由，全不可用返回 null。
 */
import { invoke } from '@tauri-apps/api/core';
import { storage } from '@/core/storage';
import { KEYS } from '@/core/storage/keys';
import { convertGraphToApi, type ApiWorkflow } from '@/core/ai/comfyui/convert';
import { detectWorkflow } from '@/core/ai/comfyui/format';
import { getObjectInfo } from '@/core/ai/comfyui/objectInfo';
import { analyzeWorkflowParameters, type WorkflowParameter } from '@/core/ai/comfyui/params';

/** Rust 侧 ComfyuiToolCfg 的前端镜像（camelCase，与 #[serde(rename_all="camelCase")] 对齐）。 */
export interface ComfyuiToolCfg {
  url: string;
  ckpt?: string;
  workflow?: ApiWorkflow;
  promptAt?: { nodeId: string; inputKey: string };
  /** 蓝图工作流的技能包 slug——生图失败时后端随错误返回，前端据此写回备注。 */
  skillSlug?: string;
}

/**
 * 从工作流参数表里挑出「提示词写入位」（与蓝图 image 节点同口径：首个 prompt 类文本参数）。
 * 找不到返回 undefined——调用方据此降级（不要静默用其它参数位，会让「按描述作画」落空）。
 * 纯函数，便于测试。
 */
export function pickPromptAt(params: WorkflowParameter[]): { nodeId: string; inputKey: string } | undefined {
  const p = params.find((x) => x.type === 'string' && (x.name === 'prompt' || x.name.startsWith('prompt')));
  return p ? { nodeId: p.nodeId, inputKey: p.inputKey } : undefined;
}

/**
 * 从设置与蓝图挂钩解析 ComfyUI 生图配置。无可用配置返回 null。
 * 注意：workflow 未经 applyWorkflowParameters 预填提示词——prompt 由 Rust 侧按
 * promptAt 写入（每次生成都是新描述，前端无从预知）。
 */
export async function resolveComfyuiConfig(): Promise<ComfyuiToolCfg | null> {
  const url = storage.getString(KEYS.ai.comfyuiUrl.key, '').trim();
  if (!url) return null;
  const ckpt = storage.getString(KEYS.ai.comfyuiCkpt.key, '').trim();
  const bpWf = storage.getString(KEYS.ai.comfyuiBlueprintWf.key, '').trim();
  // 技能包 slug：生图失败时随错误上报，前端写回备注（同一坑不踩第二次）
  const skillSlug = storage.getString(KEYS.ai.comfyuiBlueprintWfSlug.key, '').trim();

  if (bpWf) {
    try {
      const json = await invoke<unknown>('comfyui_read_workflow', { path: bpWf });
      const kind = detectWorkflow(json);
      if (kind !== 'unknown') {
        const info = await getObjectInfo(url).catch(() => undefined);
        let apiWf: ApiWorkflow;
        if (kind === 'ui') {
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
          const promptAt = pickPromptAt(analyzeWorkflowParameters(apiWf, info));
          if (promptAt) {
            return { url, workflow: apiWf, promptAt, ...(skillSlug ? { skillSlug } : {}) };
          }
        }
      }
    } catch {
      /* 蓝图工作流不可用 → 落到 checkpoint / 云端档 */
    }
  }

  // 无蓝图工作流：只要端点可用就交给 Rust（由 Rust 判 ckpt 是否齐备并给明确错误）
  // 注意：此档不带 skillSlug——失败写回针对的是「某个具体工作流」的经验，内置流无对应备注对象。
  return ckpt ? { url, ckpt } : { url };
}
