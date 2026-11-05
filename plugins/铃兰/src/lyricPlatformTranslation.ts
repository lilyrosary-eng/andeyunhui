/**
 * 「取现成译文」：优先用平台已经有的歌词翻译，而不是一上来就发翻译请求。
 *
 * 为什么值得单独一步：网易云歌词接口本来就返回 `tlyric`（译文）与 `romalrc`（音译），
 * 酷狗返回 `trans`，QQ 的 fcg 也有 `translation` —— 这些是**人工校对过的现成译文**，
 * 质量和专名一致性都强过机器翻译，而且播放链路上早就在用（见 lyricsSync 的「译/音」三态）。
 * 歌词编辑器此前只有「自动获取（只取原文）」和「翻译（走节点）」，两条之间缺一座桥，
 * 结果就是有人翻过的歌也被重新翻译一遍。
 *
 * 判定不靠"有没有返回 trans 字段"，靠**覆盖率**：译文行占原文行的比例低于
 * `MIN_HIT_RATIO` 就当没有（只翻半首歌的译文比没有更坏 —— 用户以为拿到了完整译文）。
 */

export interface ExistingTranslation {
  /** 带时间轴的译文 LRC（只含有译文的那些行） */
  text: string;
  source: 'netease' | 'kugou';
  /** 命中的平台名（给用户看的措辞） */
  sourceLabel: string;
  hit: number;
  total: number;
}

/** 覆盖率低于这个数就判「平台没有现成译文」 */
export const MIN_HIT_RATIO = 0.6;

/** `[mm:ss.xx]` 前缀，与主流 LRC 一致（两位秒 + 两位百分秒） */
export function stampOf(timeMs: number): string {
  const ms = Math.max(0, Math.floor(timeMs));
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}]`;
}

interface TimedLike {
  time_ms?: number;
  text?: string;
  translation?: string;
}

/**
 * 把「带译文的原行」拼成译文 LRC。
 *
 * 只输出有 translation 的行，并沿用原行的时间戳 —— 时间戳来自原文，不重新计算，
 * 所以不会出现"译文贴错轴"。
 */
export function buildTranslatedLrc(
  lines: TimedLike[],
): { text: string; hit: number; total: number } {
  const usable = lines.filter((l) => (l.text || '').trim() !== '' || (l.translation || '').trim() !== '');
  const parts: string[] = [];
  for (const l of usable) {
    const t = (l.translation || '').trim();
    if (!t) continue;
    parts.push(`${stampOf(l.time_ms ?? 0)}${t}`);
  }
  return { text: parts.join(String.fromCharCode(10)), hit: parts.length, total: usable.length };
}

/** 解析 LRC 文本成 {time_ms, text}（只取时间戳行，忽略元信息头） */
export function parseTimedLrc(raw: string): { time_ms: number; text: string }[] {
  const out: { time_ms: number; text: string }[] = [];
  for (const line of (raw || '').split(/\r?\n/)) {
    const stamps = line.match(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g);
    if (!stamps) continue;
    const rest = line.replace(/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g, '').trim();
    if (!rest) continue;
    for (const st of stamps) {
      const m = st.match(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/);
      if (!m) continue;
      const frac = m[3] ? Number(('' + m[3]).padEnd(3, '0').slice(0, 3)) : 0;
      out.push({ time_ms: Number(m[1]) * 60000 + Number(m[2]) * 1000 + frac, text: rest });
    }
  }
  return out;
}

/**
 * 酷狗形态：原文 LRC + 译文 LRC 两条独立文本。
 * 按时间戳把译文挂回原文行，再复用同一个覆盖率判定，避免两条实现各算一套。
 */
export function joinKugouLyrics(
  lyricLrc: string,
  transLrc: string,
): { text: string; hit: number; total: number } {
  const src = parseTimedLrc(lyricLrc);
  const byTime = new Map<number, string>();
  for (const l of parseTimedLrc(transLrc)) {
    if (!byTime.has(l.time_ms)) byTime.set(l.time_ms, l.text);
  }
  return buildTranslatedLrc(src.map((l) => ({ time_ms: l.time_ms, text: l.text, translation: byTime.get(l.time_ms) })));
}

/** 够不够格算「平台有现成译文」 */
export function passesRatio(hit: number, total: number, min = MIN_HIT_RATIO): boolean {
  if (total === 0) return false;
  return hit / total >= min;
}

export interface ExistingTranslationDeps {
  kw: string;
  neteaseSearch: (kw: string, limit: number) => Promise<{ tracks?: { id: number }[] } | null>;
  neteaseLyric: (id: number) => Promise<TimedLike[] | null>;
  kugouSearch: (kw: string, limit: number) => Promise<{ hash?: string; id?: string }[]>;
  kugouLyric: (hash: string) => Promise<{ lyric: string; trans?: string }>;
  /** 每个平台试几条：现成译文常常挂在翻唱/现场版上，多试几条更准，但别无限试 */
  tryCount?: number;
}

const tryN = (d: ExistingTranslationDeps) => d.tryCount ?? 3;

/**
 * 先网易云、后酷狗，任一条达标就返回；都不达标返回 null（调用方须明说「没有现成译文」）。
 */
export async function fetchExistingTranslation(
  deps: ExistingTranslationDeps,
): Promise<ExistingTranslation | null> {
  const n = tryN(deps);

  try {
    const search = await deps.neteaseSearch(deps.kw, n);
    for (const t of (search?.tracks ?? []).slice(0, n)) {
      if (!t?.id) continue;
      const lines = await deps.neteaseLyric(t.id);
      if (!lines?.length) continue;
      const built = buildTranslatedLrc(lines);
      if (passesRatio(built.hit, built.total)) {
        return { text: built.text, source: 'netease', sourceLabel: '网易云', hit: built.hit, total: built.total };
      }
    }
  } catch {
    /* 单个平台失败不该挡住另一个：整体失败时会显式告诉用户没有现成译文 */
  }

  try {
    const list = await deps.kugouSearch(deps.kw, n);
    for (const s of (list ?? []).slice(0, n)) {
      const hash = s?.hash || s?.id;
      if (!hash) continue;
      const got = await deps.kugouLyric(String(hash));
      if (!got?.lyric || !got.trans) continue;
      const built = joinKugouLyrics(got.lyric, got.trans);
      if (passesRatio(built.hit, built.total)) {
        return { text: built.text, source: 'kugou', sourceLabel: '酷狗', hit: built.hit, total: built.total };
      }
    }
  } catch {
    /* 同上 */
  }

  return null;
}
