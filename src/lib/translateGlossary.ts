/**
 * 术语表的「自动学习」侧室
 *
 * 设置页那块 `原词=译法` 文本框是**用户手写的**，我们不往里写东西 ——
 * 手工词条和机器学来的词条混在一起，用户就没法判断哪行是自己定的、也没法清理。
 * 所以学到的整句对存在另一个键里，下发时再拼到手写词条后面。
 *
 * 只在术语表**关着**的时候学：开着时译文本来就被表约束着，把它记回去等于
 * 把自己的输出当成下一次的标准，越用越死；关着翻才是真信息。
 *
 * 词条形式是「整句 = 整句译文」（用户定的策略，最容易实现也最不会学错），
 * 所以它主要解决的是副歌重复、同一歌手多首歌复用句式这类一致性。
 */

const KEY_AUTO = 'ts_translate_glossary_auto';

/** 滚动上限：术语表整段会进提示词，句子比词组长得多，不能无限长。 */
export const AUTO_GLOSSARY_MAX = 200;

export interface GlossaryPair {
  /** 原文整句 */
  src: string;
  /** 译文整句 */
  dst: string;
}

function readRaw(): unknown {
  try {
    const raw = localStorage.getItem(KEY_AUTO);
    if (!raw || !raw.trim()) return [];
    return JSON.parse(raw);
  } catch {
    // 坏 JSON 不该让翻译链挂掉，也不该把用户已有词条吃掉
    return [];
  }
}

/** 只认形状对的条目：别的类型（手改过、别的版本写过）一律丢掉。 */
function sanitize(list: unknown): GlossaryPair[] {
  if (!Array.isArray(list)) return [];
  const out: GlossaryPair[] = [];
  for (const it of list) {
    const src = (it as GlossaryPair)?.src;
    const dst = (it as GlossaryPair)?.dst;
    if (typeof src !== 'string' || typeof dst !== 'string') continue;
    if (!src.trim() || !dst.trim()) continue;
    out.push({ src: src.trim(), dst: dst.trim() });
  }
  return out;
}

/** 当前学到的整句词条（按写入顺序，最新在后）。 */
export function listAutoGlossary(): GlossaryPair[] {
  return sanitize(readRaw());
}

function writeAuto(list: GlossaryPair[]): void {
  try {
    localStorage.setItem(KEY_AUTO, JSON.stringify(list));
  } catch {
    /* 存不下就算了，不能因为学习失败让译文回不去 */
  }
}

/**
 * 含 `=` 的句子不能当词条：下发时是 `原词=译法` 一行一条，
 * 中间再夹一个等号，模型会把它读成两栏，整行都学歪。这种句子直接跳过。
 */
function isRecordable(pair: GlossaryPair): boolean {
  return !!pair.src.trim() && !!pair.dst.trim() && !pair.src.includes('=') && !pair.dst.includes('=');
}

/**
 * 记入学习到的整句。同一句原文再来一次 → 覆盖旧译法（新译法顶掉旧的），
 * 总数超上限 → 丢最老的。返回**净新增**条数（覆盖不计）。
 */
export function learnGlossaryPairs(pairs: GlossaryPair[]): number {
  const usable = pairs.filter(isRecordable);
  if (!usable.length) return 0;
  const prev = listAutoGlossary();
  const index = new Map(prev.map((p, i) => [p.src, i]));
  let added = 0;
  const next = prev.slice();
  for (const p of usable) {
    const at = index.get(p.src);
    if (at === undefined) {
      index.set(p.src, next.length);
      next.push(p);
      added += 1;
    } else {
      next[at] = p;
    }
  }
  writeAuto(next.length > AUTO_GLOSSARY_MAX ? next.slice(next.length - AUTO_GLOSSARY_MAX) : next);
  return added;
}

/** 删一条（用户在设置页点「删」时用）。返回是否真删掉了。 */
export function deleteAutoGlossary(src: string): boolean {
  const prev = listAutoGlossary();
  const next = prev.filter((p) => p.src !== src);
  if (next.length === prev.length) return false;
  writeAuto(next);
  return true;
}

/** 清空学到的整句（只清学到的，不动手写词条）。 */
export function clearAutoGlossary(): void {
  try {
    localStorage.removeItem(KEY_AUTO);
  } catch {
    /* 忽略 */
  }
}

/**
 * 术语表这次到底用没用。没设过 = 启用（老配置无需迁移），
 * 所以只有明确 `glossaryOn === false` 才算关 —— 关掉才是「学词条」的那条路。
 */
export function isGlossaryOff(settings: { glossaryOn?: unknown }): boolean {
  return settings.glossaryOn === false;
}

/**
 * 把手写词条 + 学到的整句拼成下发给后端的那一段文本。
 * 任一方为空就只给另一方；两边都空返回 undefined（等于不带术语表）。
 */
export function mergeGlossary(manual: string | undefined, auto?: GlossaryPair[]): string | undefined {
  const list = auto ?? listAutoGlossary();
  const autoLines = list.map((p) => `${p.src}=${p.dst}`);
  const head = (manual ?? '').trim();
  if (!head && !autoLines.length) return undefined;
  if (!head) return autoLines.join('\n');
  if (!autoLines.length) return head;
  return `${head}\n${autoLines.join('\n')}`;
}
