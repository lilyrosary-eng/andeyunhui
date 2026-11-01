/**
 * 模糊匹配打分 —— 全站唯一实现。
 *
 * 移植 Obsidian 1.14.5 的 sx()/ux()/cx()（app.js @1256600 起，逐条对过源码），
 * 惩罚项依次为：命中被切成几段 → 命中落在词内而非词边界 → 匹配跨度松 → 命中位置靠后 → 目标串长。
 * 先按 token 顺序匹配，不中才退化为逐字符子序列匹配（两级策略）。
 *
 * 为什么不用现成的模糊库：这五项惩罚加起来不到 30 行，效果比多数 JS 模糊库稳，
 * 而且它对中文友好（见下面 CJK 那条）。
 *
 * 收敛掉的四套旧实现：本文件旧版（子串优先 + 手调加权 5，那个常数必须落在 (~3,~7) 才同时
 * 保住两条测试，是脆的）、command-palette/scoring.ts 的 scoreText（200/170/150/120/30 阶梯，
 * 子序列一律给 30 分不罚跳字）、plugins/茑萝/ide 的 fuzzyScore、plugins/莲花 的子序列匹配。
 */

/** 分隔符/标点（Obsidian rx）：命中点前一个是这些字符 → 算词边界，不计罚分 */
const SEPARATORS = new RegExp(
  "[\\u2000-\\u206F\\u2E00-\\u2E7F\\\\'!\"#$%&()*+,\\-./:;<=>?@\\[\\]^_`{|}~]",
);
/**
 * 中日韩及相关脚本（Obsidian ax）：这些文字没有大小写，camelCase 那条判据对它们恒不成立，
 * 所以单独在 scan() 末尾用「起点前一个字符」补一次词边界判断，否则中文的
 * 「`伴奏 夜曲` 优于 `某夜曲某`」这条手感会丢。
 */
const CJK = new RegExp('[\\u0F00-\\u0FFF\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\uFF66-\\uFF9F]');
const SPACE = /\s/;

/** 把 Obsidian 的相对罚分映射到面板既有的 0~200 量纲（面板的 recent/usage 加分是十位级） */
const MATCH_CEILING = 200;
const PENALTY_SCALE = 60;

export interface PreparedQuery {
  query: string;
  /** 按空白/分隔符/CJK 单字切出的词元序列 */
  tokens: string[];
  /** 逐字符序列（token 匹配不中时的退化路径） */
  fuzzy: string[];
}

export interface MatchResult {
  score: number;
  /** 命中的字符区间 [start, end)，end 不含；已合并相邻区间 */
  ranges: Array<[number, number]>;
}

/**
 * prepareQuery 的单格缓存：一次按键会对几百个候选各调一次打分，
 * 而它们的查询串相同 —— 切分只做一次。
 */
let cacheQuery = '';
let cachePrepared: PreparedQuery | null = null;

export function prepareQuery(query: string): PreparedQuery {
  if (cachePrepared && cacheQuery === query) return cachePrepared;
  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();
  const tokens: string[] = [];
  let start = 0;
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    if (SPACE.test(ch)) {
      if (start !== i) tokens.push(lower.slice(start, i));
      start = i + 1;
      continue;
    }
    if (SEPARATORS.test(ch) || CJK.test(ch)) {
      if (start !== i) tokens.push(lower.slice(start, i));
      tokens.push(ch);
      start = i + 1;
    }
  }
  if (start < lower.length) tokens.push(lower.slice(start));
  // 用 Array.from 而非 split('')：后者按 UTF-16 码元切，会把 emoji 代理对劈成两半
  const prepared: PreparedQuery = { query: trimmed, tokens, fuzzy: Array.from(lower).filter((c) => c !== ' ') };
  cacheQuery = query;
  cachePrepared = prepared;
  return prepared;
}

/** 顺序匹配一串词元；不中返回 null。同时统计「词内命中」次数。 */
function scan(
  parts: string[],
  target: string,
  lower: string,
  fuzzyMode: boolean,
): { ranges: Array<[number, number]>; misses: number } | null {
  if (parts.length === 0) return null;
  let cursor = 0;
  let misses = 0;
  const ranges: Array<[number, number]> = [];
  for (const part of parts) {
    const at = lower.indexOf(part, cursor);
    if (at === -1) return null;
    const ch = target.charAt(at);
    if (at > 0 && !SEPARATORS.test(ch) && !CJK.test(ch)) {
      const prev = target.charAt(at - 1);
      // camelCase 边界（MyModel 的 M）与「字母紧跟非字母」都算词首，不计罚分；
      // 反之（小写字母嵌在单词中间）记一次词内命中。
      const camelInside = ch.toLowerCase() !== ch && prev.toLowerCase() !== prev;
      const letterInside =
        ch.toUpperCase() !== ch && !SEPARATORS.test(prev) && !SPACE.test(prev) && !CJK.test(prev);
      // 只在 token 模式下罚「词内命中」：退化到逐字符子序列时，字符本来就是零散命中的，
      // 词边界不携带信息 —— 留着它会让「d----p----s」这种松匹配反超「dpsk」这种紧匹配。
      if (!fuzzyMode && (camelInside || letterInside)) misses += 1;
    }
    const end = at + part.length;
    const last = ranges[ranges.length - 1];
    if (!last || last[1] < at) ranges.push([at, end]);
    else if (last[1] < end) last[1] = end;
    cursor = end;
  }
  // CJK 命中点上面那条判据永远不成立（汉字无大小写），所以按「起点前一个字符」补一次：
  // 前面还是文字 → 说明查询嵌在更长的词里，记一次词内命中。
  const first = ranges[0][0];
  if (first > 0 && CJK.test(target.charAt(first))) {
    const prev = target.charAt(first - 1);
    if (!SEPARATORS.test(prev) && !SPACE.test(prev)) misses += 1;
  }
  return { ranges, misses };
}

/** Obsidian cx()：五项惩罚，0 为完美匹配，越负越差 */
function penalty(
  ranges: Array<[number, number]>,
  queryLength: number,
  targetLength: number,
  misses: number,
): number {
  if (ranges.length === 0) return 0;
  let r = 0;
  r -= Math.max(0, ranges.length - 1);
  r -= misses / 10;
  const first = ranges[0][0];
  r -= (ranges[ranges.length - 1][1] - first + 1 - queryLength) / 100;
  r -= first / 1000;
  r -= targetLength / 1e4;
  return r;
}

/** 打分并给出命中区间（供高亮用）。不匹配返回 null。 */
export function matchQuery(prepared: PreparedQuery, target: string): MatchResult | null {
  if (!prepared.query) return { score: 1, ranges: [] };
  if (!target) return null;
  const lower = target.toLowerCase();
  const hit = scan(prepared.tokens, target, lower, false) ?? scan(prepared.fuzzy, target, lower, true);
  if (!hit) return null;
  const score = MATCH_CEILING + penalty(hit.ranges, prepared.query.length, target.length, hit.misses) * PENALTY_SCALE;
  return { score: Math.max(1, Math.min(MATCH_CEILING, score)), ranges: hit.ranges };
}

/**
 * 单值打分：`< 0` 表示不匹配。
 * 需要反复对一批候选打同一查询时，用 makeScorer（省掉重复取缓存的分支）。
 */
export function fuzzyScore(query: string, target: string): number {
  const m = matchQuery(prepareQuery(query), target);
  return m ? m.score : -1;
}

/** 预绑定查询的打分器：一次切分，多次打分 */
export function makeScorer(query: string): (target: string) => number {
  const prepared = prepareQuery(query);
  return (target: string) => {
    const m = matchQuery(prepared, target);
    return m ? m.score : -1;
  };
}

export interface WeightedField {
  text: string;
  /** 0~1。用于让「名称命中」压过「端点命中」 */
  weight: number;
}

/** 多字段匹配，取加权后最高分。任一字段命中即为命中。 */
export function bestScore(query: string, fields: WeightedField[]): number {
  const prepared = prepareQuery(query);
  let best = -1;
  for (const f of fields) {
    const m = matchQuery(prepared, f.text);
    if (m) best = Math.max(best, m.score * f.weight);
  }
  return best;
}

/**
 * 把命中区间渲染成 <mark> 片段（面板与模块列表共用一套高亮）。
 * 返回 [文本段, 是否命中][]，调用方自己决定渲染成什么标签。
 */
export function splitMatches(target: string, ranges: Array<[number, number]>): Array<[string, boolean]> {
  const out: Array<[string, boolean]> = [];
  let pos = 0;
  for (const [start, end] of ranges) {
    if (start > pos) out.push([target.slice(pos, start), false]);
    out.push([target.slice(start, end), true]);
    pos = end;
  }
  if (pos < target.length) out.push([target.slice(pos), false]);
  return out;
}
