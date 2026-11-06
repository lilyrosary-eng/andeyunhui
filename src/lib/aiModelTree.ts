/**
 * AI 模型树的整理（纯函数，单独可测）
 *
 * 为什么要单独一层：模型数量多（一个中转站就几十上百条），一条平铺的下拉列表
 * 根本选不动。按**预设厂商**分组、厂商标题在滚动时钉在顶部，才能"看完这家再看那家"。
 * 数据来自后端 `ai_get_config`（v2：providers[] → models[]），
 * 这里只负责把它整理成稳定、可渲染、可搜索的树，不做任何取数。
 */

export interface RawModel {
  id?: string;
  model?: string;
  label?: string | null;
}

export interface RawProvider {
  id?: string;
  name?: string;
  base_url?: string;
  models?: RawModel[];
}

export interface AiModelNode {
  /** 选中后写回 settings.profileId 的值（= ModelEntry.id，与后端 resolve_target 同一套） */
  id: string;
  /** 展示名：优先模型自带的 label，其次上游模型名，最后 id */
  label: string;
}

export interface AiProviderGroup {
  providerId: string;
  /** 厂商标题：name 为空时回落端点主机名，再回落 id，全都没有才叫「未命名供应商」 */
  name: string;
  models: AiModelNode[];
}

/** 端点主机名，用来给没起名的供应商一个可读标题 */
function hostOf(baseUrl?: string): string {
  const s = (baseUrl || '').trim();
  if (!s) return '';
  try {
    return new URL(s).hostname;
  } catch {
    return s.replace(/^https?:\/\//, '').split('/')[0];
  }
}

export function buildModelTree(cfg?: { providers?: RawProvider[] } | null): AiProviderGroup[] {
  const providers = Array.isArray(cfg?.providers) ? cfg!.providers! : [];
  const out: AiProviderGroup[] = [];
  // 顺序按用户自己的配置顺序，不重排 —— 谁把常用的排在前面是用户说了算
  for (const p of providers) {
    const models = (Array.isArray(p?.models) ? p.models : [])
      .filter((m) => typeof m?.id === 'string' && m.id.trim() !== '')
      .map((m) => ({ id: (m!.id as string).trim(), label: (m!.label || '').trim() || (m!.model || '').trim() || (m!.id as string) }));
    if (!models.length) continue;
    out.push({
      providerId: p?.id || '',
      name: (p?.name || '').trim() || hostOf(p?.base_url) || (p?.id || '').trim() || '未命名供应商',
      models,
    });
  }
  return out;
}

/** 在树里找到某个 id 的展示文案（`厂商 · 模型`）；找不到返回 null（= 档案里已删除） */
export function findModelLabel(tree: AiProviderGroup[], id?: string): string | null {
  if (!id) return null;
  for (const g of tree) {
    const hit = g.models.find((m) => m.id === id);
    if (hit) return `${g.name} · ${hit.label}`;
  }
  return null;
}

/** 下拉面板里一屏放不下几百条，给个可滚动的上限由组件自己定；这里只提供扁平计数用于诊断 */
export function countModels(tree: AiProviderGroup[]): number {
  return tree.reduce((n, g) => n + g.models.length, 0);
}
