/**
 * 歌词 AI 翻译的时间轴保真层
 *
 * 宿主已经有真翻译服务（`translate_text`：多节点 + 按链兜底 + 全链路显式提示，
 * 见 `src-tauri/src/services/ai_service/ai_ocr.rs` 与设置页「翻译节点」），
 * 本模块只解决**歌词特有的那个麻烦**：LRC 的时间戳不能被喂给翻译节点，
 * 而翻译节点又不保证逐行返回（长文本会被切开并发翻译）。
 *
 * 规则：
 * - 时间戳行：剥掉所有 `[mm:ss.xx]` 前缀，只把正文送去翻译，回来再把原前缀贴回去；
 * - 元信息头（`[ti:] [ar:] [by:] [offset:] [length:]` 等）原样保留，不翻译
 *   —— 那是播放器的曲目元信息，翻成中文反而把标签搞味；
 * - **行数对不上时不硬凑**：宁可输出一份没有时间轴的纯文本译文并明说原因，
 *   也不要贴着错位的时间戳 —— 错轴译文会让跟唱逐行错开，比没有轴更坏。
 */

/** 一行 LRC 的解析结果 */
export interface LrcLine {
  /** 原行的时间戳前缀串（可能多个连写），无则 null */
  stamps: string | null;
  /** 元信息头（如 [ti:晴天]），原样保留，null 表示普通行 */
  meta: string | null;
  /** 参与翻译的正文；空串表示这行没内容可译 */
  text: string;
}

const STAMP_RE = /^\s*(\[\d{1,2}:\d{2}(?:\.\d{1,3})?\])+/,metaRe = /^\s*\[[A-Za-z#][A-Za-z0-9_]*:.*\]\s*$/;

/** 拆分时间戳前缀与正文 */
export function parseLrcLine(line: string): LrcLine {
  const stampMatch = line.match(STAMP_RE);
  if (stampMatch) {
    return { stamps: stampMatch[0].trim(), meta: null, text: line.slice(stampMatch[0].length).trim() };
  }
  if (metaRe.test(line)) {
    return { stamps: null, meta: line.trim(), text: '' };
  }
  return { stamps: null, meta: null, text: line.trim() };
}

/** 把 LRC 原文拆成行（保留空行以便整体重建） */
export function parseLrc(raw: string): LrcLine[] {
  return raw.split(/\r?\n/).map(parseLrcLine);
}

/** 待翻译内容：只取有正文的行，逐行连接（行数 = 返回译文应有的行数） */
export function buildTranslatablePayload(lines: LrcLine[]): string {
  return lines.filter((l) => l.meta === null && l.text !== '').map((l) => l.text).join('\n');
}

export interface RejoinResult {
  /** 重建后的文本（对齐时带时间轴；不对齐时是纯译文） */
  text: string;
  /** 译文行数与原文是否一致（false 时 text 没有时间轴） */
  aligned: boolean;
}

/**
 * 把译文贴回原时间轴。
 *
 * 行数一致才贴；否则退化为纯文本，并把原因交给调用方展示。
 * 译文里多出来的空行会被忽略（部分节点会在段间补空行），避免因此误判不对齐。
 */
export function rejoinTranslated(lines: LrcLine[], translated: string): RejoinResult {
  const want = lines.filter((l) => l.meta === null && l.text !== '').length;
  const got = translated
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (want === 0 || got.length !== want) {
    return { text: translated.trim(), aligned: false };
  }
  let i = 0;
  const out = lines.map((l) => {
    if (l.meta !== null) return l.meta;
    if (l.text === '') return '';
    const piece = got[i++];
    return l.stamps ? `${l.stamps}${piece}` : piece;
  });
  return { text: out.join('\n'), aligned: true };
}

export interface TranslateOutcomeLike {
  text?: string;
  node?: string;
  detectedLang?: string | null;
  notices?: string[];
  fromCache?: boolean;
  segments?: number;
}

/** 把结果拼成一行给人看的元信息：实际节点 / 源语言 / 分段 / 缓存 —— 不替用户猜 */
export function describeOutcome(o: TranslateOutcomeLike, aligned: boolean): string {
  const bits: string[] = [];
  bits.push(`节点 ${o.node || '?'}`);
  if (o.detectedLang) bits.push(`源语言 ${o.detectedLang}`);
  if (typeof o.segments === 'number') bits.push(`分段 ${o.segments}`);
  if (o.fromCache) bits.push('缓存命中');
  if (!aligned) bits.push('译文行数与原文不一致，已输出无时间轴版本');
  return bits.join(' · ');
}

export interface TranslateLyricsDeps {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  targetLang?: string;
}

/**
 * 翻译一段 LRC/纯文本歌词。
 *
 * 返回的 `text` 一定可以直接放进歌词编辑器的「修改后」；`meta` 是要如实展示给用户的
 * 过程信息（含所有 notices 原文，不截断不分类改写 —— 对齐宿主翻译工作区的既定原则）。
 */
export async function translateLyrics(
  raw: string,
  deps: TranslateLyricsDeps = {},
): Promise<{ text: string; aligned: boolean; meta: string }> {
  const lines = parseLrc(raw);
  const payload = buildTranslatablePayload(lines);
  if (!payload) throw new Error('当前没有可翻译的歌词文本');

  const invoke = deps.invoke;
  if (!invoke) throw new Error('宿主翻译通道不可用');
  const res = (await invoke('translate_text', {
    text: payload,
    targetLang: deps.targetLang || undefined,
  })) as TranslateOutcomeLike | string;

  // 兼容：老签名直接返回裸字符串
  const outcome: TranslateOutcomeLike = typeof res === 'string' ? { text: res } : res || {};
  const joined = rejoinTranslated(lines, outcome.text || '');
  const notices = Array.isArray(outcome.notices) ? outcome.notices : [];
  const meta = [describeOutcome(outcome, joined.aligned), ...notices].filter(Boolean).join(' | ');
  return { text: joined.text, aligned: joined.aligned, meta };
}
