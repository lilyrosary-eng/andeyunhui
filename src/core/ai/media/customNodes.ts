/**
 * ComfyUI 自定义节点的**放行名单**。
 *
 * ## 为什么需要
 * 自定义节点是**可执行任意 Python** 的。AI 自建工作流时，Rust 侧的 `audit_graph`
 * 会把「非核心节点」（`object_info` 里 `python_module != "nodes"`）拦下，
 * 要求用户显式放行。
 *
 * ⚠️ 放行只能来自**用户在这里的勾选**，不能由模型通过工具参数自行放行——
 * 否则审计形同虚设，等于把「按模型意愿执行代码」的入口交出去。
 *
 * ## 为什么以「模块名」为单位而不是节点名
 * `object_info` 的 `python_module` 形如 `custom_nodes.ComfyUI_IPAdapter_plus`，
 * 它与 `audit_graph` 的匹配口径**逐字对齐**。按模块放行比按节点放行粒度更合理：
 * 用户对一个节点包的信任是一个整体判断，而不是逐个节点。
 */
import { KEYS } from '@/core/storage/keys';
import { storage } from '@/core/storage';

/** ComfyUI 核心节点的 `python_module` 取值；其余一律视为自定义。 */
const CORE_MODULE = 'nodes';

/**
 * 从 `object_info` 归纳出：**模块名 → 该模块提供的节点类名**（各自排序去重）。
 *
 * 注意这里拿到的就是审计要用的原始模块名，不做任何美化——美化会让放行对不上。
 */
export function customModulesOf(objectInfo: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!objectInfo || typeof objectInfo !== 'object') return out;
  for (const [classType, schema] of Object.entries(objectInfo as Record<string, unknown>)) {
    const mod = (schema as { python_module?: unknown } | null)?.python_module;
    if (typeof mod !== 'string') continue;
    const m = mod.trim();
    if (!m || m === CORE_MODULE) continue;
    (out[m] ??= []).push(classType);
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

/** 读取已放行的模块名清单。解析失败按「一个都没放行」处理（安全侧默认）。 */
export function loadAllowedModules(): string[] {
  const raw = storage.getString(KEYS.ai.comfyuiAllowedModules.key, '');
  if (!raw) return [];
  try {
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 保存放行清单（去重 + 排序，避免同一模块存出多份）。 */
export function saveAllowedModules(list: string[]): void {
  storage.setString(KEYS.ai.comfyuiAllowedModules.key, JSON.stringify([...new Set(list)].sort()));
}
