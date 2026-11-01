// 命令面板排序与作用域解析（纯函数，便于单测钉住手感）
import type { PaletteProvider } from '@/core/commandPalette/registry';
import { fuzzyScore } from '@/lib/fuzzy';

/**
 * 位置感知打分：委托给全站唯一的 fuzzy 实现（src/lib/fuzzy.ts，Obsidian cx() 移植）。
 * 这里只保留面板的契约：**0 = 不匹配**（调用方按 `<= 0` 过滤），命中为 1~200。
 * 原先本文件自带一套 200/170/150/120/30 阶梯打分，且子序列一律给 30 分不罚跳字，
 * 与 src/lib/fuzzy 的排序手感不一致，故收敛。
 */
export function scoreText(text: string, query: string): number {
  if (!query) return 1;
  return Math.max(0, fuzzyScore(query, text));
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
