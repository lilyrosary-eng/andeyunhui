// 正文重建的判据（2026-11-04）：父子两层块要拼回**不重复、不缺字**的文档，
// 命中区间要能算到正确那一段的相对偏移上 —— 这两条直接决定「看原文」是不是骗人。
import { describe, expect, it } from 'vitest';

import { buildSpine, hitSlice } from './spine';
import type { RagChunkRow } from '../api/host';

function row(p: Partial<RagChunkRow> & { idx: number; text: string; char_start: number }): RagChunkRow {
  return {
    id: `c${p.idx}`,
    char_end: p.char_start + p.text.length,
    parent_idx: null,
    dim: 1024,
    embed_model: 'm',
    ...p,
  } as RagChunkRow;
}

describe('buildSpine', () => {
  it('只用父块拼正文，子块不参与（否则内容重复一遍）', () => {
    const rows = [
      row({ idx: 0, text: 'AAAA', char_start: 0 }),
      row({ idx: 1, text: 'BBBB', char_start: 4 }),
      row({ idx: 2, text: 'AA', char_start: 0, parent_idx: 0 }),
      row({ idx: 3, text: 'BB', char_start: 4, parent_idx: 1 }),
    ];
    const spine = buildSpine(rows);
    expect(spine.map((s) => s.text).join('')).toBe('AAAABBBB');
  });

  it('父块之间因 80 字重叠而重复的尾巴会被裁掉', () => {
    // 父块 1 覆盖 [0,12)，父块 2 从 9 起（重叠 3 字）
    const rows = [row({ idx: 0, text: 'x'.repeat(12), char_start: 0 }), row({ idx: 1, text: 'y'.repeat(8), char_start: 9 })];
    const spine = buildSpine(rows);
    const doc = spine.map((s) => s.text).join('');
    expect(doc.length).toBe(17); // 12 + 8 - 3
    expect(spine[1].char_start).toBe(12);
    expect(doc).toBe('x'.repeat(12) + 'y'.repeat(5));
  });

  it('没有父块的旧数据（平铺块）退回用全部块', () => {
    const rows = [
      row({ idx: 0, text: 'abc', char_start: 0, parent_idx: null }),
      row({ idx: 1, text: 'def', char_start: 3, parent_idx: null }),
    ];
    expect(buildSpine(rows).map((s) => s.text).join('')).toBe('abcdef');
  });

  it('乱序入库也按字符位置排序，且 char_start 与拼出的正文位置一致', () => {
    const rows = [
      row({ idx: 2, text: '第二块', char_start: 3 }),
      row({ idx: 1, text: '第一块', char_start: 0 }),
    ];
    const spine = buildSpine(rows);
    expect(spine.map((s) => s.char_start)).toEqual([0, 3]);
  });
});

describe('hitSlice', () => {
  const seg = row({ idx: 1, text: '0123456789', char_start: 100 }); // 覆盖 [100,110)

  it('命中块落在本段内 → 相对本段文本的偏移', () => {
    expect(hitSlice(seg, { start: 102, end: 105 })).toEqual({ from: 2, to: 5 });
  });

  it('跨段的命中只截本段那部分', () => {
    expect(hitSlice(seg, { start: 108, end: 120 })).toEqual({ from: 8, to: 10 });
    expect(hitSlice(seg, { start: 95, end: 103 })).toEqual({ from: 0, to: 3 });
  });

  it('不相交 / 空区间 / 无命中 → null', () => {
    expect(hitSlice(seg, { start: 110, end: 120 })).toBeNull();
    expect(hitSlice(seg, { start: 105, end: 105 })).toBeNull();
    expect(hitSlice(seg, null)).toBeNull();
  });
});
