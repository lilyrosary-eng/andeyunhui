// 正文重建（阅读器用）：把库里的分块拼回可阅读的文档，并算出命中区间落在哪。
//
// 库里的块是父子两层（`ingest/chunker.ts` 的 chunkDocument）：
//   父块（parent_idx = NULL）≈3000 字，连续覆盖全文，**按设计不存向量**；
//   子块 ≈800 字、带 80 字重叠，参与检索。
//   `rag_list_chunks` 默认只返回带向量的块（那是重建向量的用法），所以拼正文
//   必须带 withAll=true 才拿得到父块；拿不到父块的旧数据（平铺块）退回用全部块。
//   相邻父块可能因重叠而重复一小段：按 char_start 排序后用「已拼到的位置」裁掉重复。

import type { RagChunkRow } from '../api/host';

/** 阅读区间起点（文档绝对字符位置）与它所在块。 */
export interface ReaderAnchor {
  start: number;
  end: number;
}

/** 拼出文档骨架：按字符位置升序、互不重叠的若干段（每段的 char_start 已校正）。 */
export function buildSpine(rows: RagChunkRow[]): RagChunkRow[] {
  const parents = rows.filter((r) => r.parent_idx === null || r.parent_idx === undefined);
  const source = (parents.length ? parents : rows)
    .slice()
    .sort((a, b) => a.char_start - b.char_start || a.idx - b.idx);
  const out: RagChunkRow[] = [];
  let cursor = -1;
  for (const c of source) {
    const from = Math.max(c.char_start, cursor);
    if (from >= c.char_end) continue; // 整段已被前面的块覆盖
    out.push({ ...c, text: c.text.slice(from - c.char_start), char_start: from });
    cursor = c.char_end;
  }
  return out;
}

/**
 * 命中区间与这一段的重叠，坐标相对 `seg.text`（渲染时直接 slice）。
 * 返回 null = 不相交（无命中区间时恒为 null）。
 */
export function hitSlice(seg: RagChunkRow, anchor: ReaderAnchor | null): { from: number; to: number } | null {
  if (!anchor) return null;
  const from = Math.max(seg.char_start, anchor.start);
  const to = Math.min(seg.char_start + seg.text.length, anchor.end);
  if (to <= from) return null;
  return { from: from - seg.char_start, to: to - seg.char_start };
}
