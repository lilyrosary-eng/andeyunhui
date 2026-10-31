// 命令面板排序与作用域解析（纯函数，便于单测钉住手感）
import type { PaletteProvider } from '@/core/commandPalette/registry';

/** 位置感知打分：完全匹配 > 前缀 > 词首 > 包含（越靠前越高）> 子序列。 */
export function scoreText(text: string, query: string): number {
  if (!query) return 1;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (t === q) return 200;
  if (t.startsWith(q)) return 170;
  const idx = t.indexOf(q);
  if (idx >= 0) {
    const prev = idx > 0 ? t[idx - 1] : '';
    const wordStart = !prev || /[\s\-_/·:：.()[\]（）]/.test(prev);
    return (wordStart ? 150 : 120) - Math.min(idx, 30) * 0.5;
  }
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i += 1;
    if (i >= q.length) return 30;
  }
  return 0;
}

export function scoreFields(
  title: string,
  subtitle: string | undefined,
  keywords: string | undefined,
  query: string,
): number {
  return Math.max(
    scoreText(title, query),
    subtitle ? scoreText(subtitle, query) * 0.8 : 0,
    keywords ? scoreText(keywords, query) * 0.55 : 0,
  );
}

export interface ScopeMatch {
  kind: 'static' | 'provider';
  key: string;
  label: string;
}

/** 解析 `音乐:夜曲` / `笔记：xxx` 这类作用域前缀；未知前缀按普通查询处理（避免误伤 `C:\x`）。 */
export function parseScope(
  raw: string,
  providers: PaletteProvider[],
  staticGroups: { key: string; label: string }[],
): { scope: ScopeMatch | null; query: string } {
  const m = /^([^\s:：]{1,16})[:：]\s*(.*)$/.exec(raw);
  if (!m) return { scope: null, query: raw };
  const token = m[1].trim().toLowerCase();
  if (!token) return { scope: null, query: raw };
  const named = [
    ...staticGroups.map((g) => ({ kind: 'static' as const, key: g.key, label: g.label, names: [g.label, g.key] })),
    ...providers.map((p) => ({
      kind: 'provider' as const,
      key: p.id,
      label: p.label,
      names: [p.label, p.id, p.moduleId ?? ''],
    })),
  ];
  const hit = named.find((n) => n.names.some((name) => name && name.toLowerCase() === token));
  if (!hit) return { scope: null, query: raw };
  return { scope: { kind: hit.kind, key: hit.key, label: hit.label }, query: m[2] ?? '' };
}
