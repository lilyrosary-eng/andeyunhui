// ComfyUI object_info 的会话级获取（按端点缓存）——convertGraphToApi 的必需输入，数 MB 不该反复拉。
// 设置面板（ComfyuiPanel）与蓝图生图节点（AiWorkflowView）共用同一份缓存。
import { invoke } from '@tauri-apps/api/core';

let cache: { forUrl: string; info: Record<string, unknown> } | null = null;

/** 取 object_info；同端点重复调用直接命中缓存。 */
export async function getObjectInfo(comfyuiUrl: string): Promise<Record<string, unknown>> {
  if (cache && cache.forUrl === comfyuiUrl) return cache.info;
  const info = await invoke<Record<string, unknown>>('comfyui_object_info', { comfyuiUrl });
  cache = { forUrl: comfyuiUrl, info };
  return info;
}
