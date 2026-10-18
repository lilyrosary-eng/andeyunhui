// 文本分块：结构感知 + 小-大（small-to-big）。
//
// 为什么改（2026-10-18）：
//   旧实现是 4000 字符硬滑窗 + 200 重叠。两个问题：
//   1) 中文 4000 字 ≈ 4000~6000 token，接近 nomic-embed-text 的 8192 上限；
//      一个块里塞了十几个主题，embedding 被"平均"掉，语义聚焦变差（检索精度低）。
//   2) 块之间被硬切断，跨块的语义（"上文提到的那个配置"）直接丢失。
//
// 现在的策略（业界常用的 small-to-big / parent-document retrieval）：
//   1) 先按**结构**切：空行分段；Markdown 标题行单独成段。段落是天然的语义单元。
//   2) 段内再按**句末标点**切到 ≤ 800 字（回退到标点处，不在句子中间切断）。
//   3) 相邻子块聚合成 ≤ 3000 字的**父块**。
//   4) 向量只算子块（精准定位），命中后由后端回填父块（上下文完整）。
//
// 实测收益方向：子块变小 ⇒ 向量更聚焦；父块回填 ⇒ 交给 LLM 的上下文不再被切断。
// （定量收益需要评测集，见 docs/plans/plan-rag-knowledge-base.md 的判据。）

/** 单个块。子块与父块统一编址，用 parentIdx 关联。 */
export interface Chunk {
  /** 全局唯一序号（父块与子块共用一套递增序号，父块先编）。 */
  idx: number;
  text: string;
  charStart: number;
  charEnd: number;
  /** 子块所属父块的 idx；父块自身为 null。 */
  parentIdx: number | null;
  /** 是否父块。父块不参与向量检索（vec 为空），只用于命中后回填上下文。 */
  isParent: boolean;
}

/** 子块最大字符数（向量单元）。 */
export const CHILD_SIZE = 800;
/** 子块之间的重叠（只在超长段落被切开时生效）。 */
export const CHILD_OVERLAP = 80;
/** 父块最大字符数（上下文单元）。 */
export const PARENT_SIZE = 3000;

interface Span {
  text: string;
  start: number;
  end: number;
}

/** 句末标点（中英文）。切分时回退到这些字符之后，避免切断句子。 */
const SENTENCE_END = /[。！？；!?;.]/;

/**
 * 按空行切段；Markdown 标题行（# ...）单独成段，保证"标题 + 正文"不会被合并进同一块。
 */
function splitSections(text: string): Span[] {
  const out: Span[] = [];
  const re = /\n{2,}/g;
  let cursor = 0;
  let m: RegExpExecArray | null;

  const pushRaw = (s: number, e: number) => {
    if (e <= s) return;
    const raw = text.slice(s, e);
    if (!raw.trim()) return;
    // 段内如果混入标题行，把标题行拆成独立段（标题通常短，独立成块更利于召回）
    const lines = raw.split('\n');
    let offset = s;
    let bufStart = -1;
    let bufEnd = -1;
    const flush = () => {
      if (bufStart >= 0 && bufEnd > bufStart) {
        const t = text.slice(bufStart, bufEnd);
        if (t.trim()) out.push({ text: t, start: bufStart, end: bufEnd });
      }
      bufStart = -1;
      bufEnd = -1;
    };
    for (const line of lines) {
      const lineStart = offset;
      const lineEnd = offset + line.length;
      offset = lineEnd + 1; // +1 为换行符
      const isHeading = /^\s{0,3}#{1,6}\s/.test(line);
      if (isHeading) {
        flush();
        out.push({ text: line, start: lineStart, end: lineEnd });
      } else {
        if (bufStart < 0) bufStart = lineStart;
        bufEnd = lineEnd;
      }
    }
    flush();
  };

  while ((m = re.exec(text)) !== null) {
    pushRaw(cursor, m.index);
    cursor = m.index + m[0].length;
  }
  pushRaw(cursor, text.length);
  return out;
}

/** 把一段按句末标点切成 ≤ maxChars 的片段（回退窗口 160 字）。 */
function splitLong(span: Span, maxChars: number, overlap: number): Span[] {
  if (span.text.length <= maxChars) return [span];
  const out: Span[] = [];
  let i = 0;
  while (i < span.text.length) {
    let end = Math.min(i + maxChars, span.text.length);
    if (end < span.text.length) {
      // 在 [end-160, end) 里找最后一个句末标点，切在它后面
      const from = Math.max(i + 40, end - 160);
      const win = span.text.slice(from, end);
      let cut = -1;
      for (let k = win.length - 1; k >= 0; k--) {
        if (SENTENCE_END.test(win[k])) {
          cut = from + k + 1;
          break;
        }
      }
      if (cut > i) end = cut;
    }
    out.push({
      text: span.text.slice(i, end),
      start: span.start + i,
      end: span.start + end,
    });
    if (end >= span.text.length) break;
    i = Math.max(end - overlap, i + 1);
  }
  return out;
}

/**
 * 文档 → 块列表。
 * @param text 待分块文本（通常是 convert_to_markdown 的结果）
 * @param childSize 子块上限（默认 800）
 * @param parentSize 父块上限（默认 3000）
 */
export function chunkDocument(
  text: string,
  childSize: number = CHILD_SIZE,
  parentSize: number = PARENT_SIZE,
): Chunk[] {
  if (!text || !text.trim()) return [];

  const sections = splitSections(text);
  const childSpans: Span[] = [];
  for (const s of sections) {
    for (const c of splitLong(s, childSize, CHILD_OVERLAP)) childSpans.push(c);
  }
  if (childSpans.length === 0) {
    return [{ idx: 0, text, charStart: 0, charEnd: text.length, parentIdx: null, isParent: true }];
  }

  // 聚合父块：连续子块累计到 <= parentSize（至少 1 个）
  const groups: { start: number; end: number; from: number; to: number }[] = [];
  let gStart = childSpans[0].start;
  let gEnd = childSpans[0].end;
  let gFrom = 0;
  for (let i = 1; i < childSpans.length; i++) {
    const next = childSpans[i];
    if (next.end - gStart <= parentSize) {
      gEnd = next.end;
    } else {
      groups.push({ start: gStart, end: gEnd, from: gFrom, to: i - 1 });
      gStart = next.start;
      gEnd = next.end;
      gFrom = i;
    }
  }
  groups.push({ start: gStart, end: gEnd, from: gFrom, to: childSpans.length - 1 });

  // 编址：父块在前，子块在后
  const chunks: Chunk[] = [];
  let idx = 0;
  const parentIdxByGroup: number[] = [];
  for (const g of groups) {
    parentIdxByGroup.push(idx);
    chunks.push({
      idx: idx++,
      text: text.slice(g.start, g.end),
      charStart: g.start,
      charEnd: g.end,
      parentIdx: null,
      isParent: true,
    });
  }
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    for (let i = g.from; i <= g.to; i++) {
      const c = childSpans[i];
      chunks.push({
        idx: idx++,
        text: c.text,
        charStart: c.start,
        charEnd: c.end,
        parentIdx: parentIdxByGroup[gi],
        isParent: false,
      });
    }
  }
  return chunks;
}

/**
 * 兼容旧调用：纯字符滑窗（不做父子结构）。仅保留给外部只想要"平铺块"的场景。
 * 新代码请用 chunkDocument。
 */
export function chunkText(
  text: string,
  maxChars: number = 4000,
  overlap: number = 200,
): { idx: number; text: string; charStart: number; charEnd: number }[] {
  if (text.length <= maxChars) {
    return [{ idx: 0, text, charStart: 0, charEnd: text.length }];
  }
  const out: { idx: number; text: string; charStart: number; charEnd: number }[] = [];
  let i = 0;
  let idx = 0;
  while (i < text.length) {
    const end = Math.min(i + maxChars, text.length);
    out.push({ idx, text: text.slice(i, end), charStart: i, charEnd: end });
    if (end >= text.length) break;
    i = end - overlap;
    idx++;
  }
  return out;
}
