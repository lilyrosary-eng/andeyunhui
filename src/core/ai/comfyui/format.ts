/**
 * 工作流文件格式判别——UI 画布图（ComfyUI 前端保存的 nodes+links）vs API 工作流（节点 id → class_type+inputs）。
 * 纯函数，无 IO 依赖；供设置面板与蓝图生图节点共用。
 */

/** 判别一个已解析的 JSON 是哪种工作流格式。 */
export function detectWorkflow(json: unknown): 'ui' | 'api' | 'unknown' {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return 'unknown';
  const o = json as Record<string, unknown>;
  // UI 画布图：顶层有 nodes/links 数组（可能还带 version/extra 等键）
  if (Array.isArray(o.nodes) && Array.isArray(o.links)) return 'ui';
  // API 工作流：每个值都是 { class_type, inputs }
  const vals = Object.values(o);
  if (vals.length === 0) return 'unknown';
  const allApi = vals.every(
    (v) =>
      !!v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      'class_type' in (v as Record<string, unknown>) &&
      'inputs' in (v as Record<string, unknown>),
  );
  return allApi ? 'api' : 'unknown';
}
