// 文本分块：字符级滑窗（复用 IDE 范式 chunkText 4000/200）。
//
// 与文档→Markdown 配合：先 convert_to_markdown 得到纯文本，再分块嵌入、入库。
// 重叠（overlap）保证跨窗口的句子/语义不被切断，提升检索召回。

/** 单块。 */
export interface Chunk {
  idx: number;
  text: string;
  charStart: number;
  charEnd: number;
}

/** 滑窗大小（字符）。 */
export const CHUNK_SIZE = 4000;
/** 窗口重叠（字符）。 */
export const CHUNK_OVERLAP = 200;

/**
 * 字符级滑窗分块。
 * @param text 待分块文本
 * @param maxChars 单块最大字符数（默认 4000）
 * @param overlap 相邻块重叠字符数（默认 200）
 */
export function chunkText(
  text: string,
  maxChars: number = CHUNK_SIZE,
  overlap: number = CHUNK_OVERLAP,
): Chunk[] {
  if (text.length <= maxChars) {
    return [{ idx: 0, text, charStart: 0, charEnd: text.length }];
  }
  const chunks: Chunk[] = [];
  let i = 0;
  let idx = 0;
  while (i < text.length) {
    const end = Math.min(i + maxChars, text.length);
    chunks.push({ idx, text: text.slice(i, end), charStart: i, charEnd: end });
    if (end >= text.length) break;
    i = end - overlap;
    idx++;
  }
  return chunks;
}
