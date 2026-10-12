// 模糊匹配打分。给供应商 / 模型搜索用。
//
// 为什么不复用现成实现：plugins/茑萝/ide/src/modules/commandPalette.tsx:59-70 有一份
// fuzzyScore，但它编译进插件沙箱的 IIFE，主应用 import 不到；cmdk 虽在 package.json 里，
// 但主应用 0 引用，且它设了 shouldFilter={false} 把自带的 commandScore 关掉了；
// 另有 plugins/莲花/src/index.tsx:274-280 一套子序列匹配和 20+ 处裸 includes。
// 三套实现互不共享，且加起来不到 15 行有效逻辑 —— 这里重写一份主应用可用的。

const SEPARATORS = new Set(['/', '\\', '-', '_', ':', ' ', '.', '@']);

/**
 * 模糊匹配打分。返回 < 0 表示不匹配。
 *
 * 规则：子串优先（位置越靠前、目标越短分越高，词首额外加权）；
 * 子串不中则退化为字符子序列匹配（打 `ds` 能命中 `DeepSeek`）。
 *
 * 用 Array.from 而非 charAt 遍历：charAt 按 UTF-16 码元切，会把 emoji 劈成两半，
 * 导致含 emoji 的模型名（社区模型常见）匹配错乱。
 */
export function fuzzyScore(query: string, target: string): number {
  const q = Array.from(query.trim().toLowerCase());
  const t = Array.from(target.toLowerCase());
  if (q.length === 0) return 1;
  if (t.length === 0) return -1;

  const tJoined = t.join('');
  const qJoined = q.join('');

  const idx = tJoined.indexOf(qJoined);
  if (idx >= 0) {
    let score = 100 - idx;
    // 词首（分隔符后）命中加权：必须远小于位置惩罚的量级（每位移仅 1 分），
    // 否则会出现「靠后的词首命中」反超「最靠前命中」、打翻「越靠前越高」不变量。
    // 取值需落在 (~3, ~7) 才能同时保住测试 4（靠前>靠后）与测试 5（词首>词中）。
    if (idx > 0 && SEPARATORS.has(tJoined[idx - 1])) score += 5;
    score -= t.length * 0.1;
    return score;
  }

  // 子序列：字符按顺序出现即可，跳字计惩罚
  let qi = 0;
  let gaps = 0;
  for (let i = 0; qi < q.length && i < t.length; i++) {
    if (t[i] === q[qi]) qi++;
    else if (qi > 0) gaps++;
  }
  if (qi === q.length) return Math.max(1, 40 - gaps);
  return -1;
}

export interface WeightedField {
  text: string;
  /** 0~1。用于让「名称命中」压过「端点命中」 */
  weight: number;
}

/** 多字段匹配，取加权后最高分。任一字段命中即为命中。 */
export function bestScore(query: string, fields: WeightedField[]): number {
  let best = -1;
  for (const f of fields) {
    const s = fuzzyScore(query, f.text);
    if (s >= 0) best = Math.max(best, s * f.weight);
  }
  return best;
}
