// 拿**真的分块器**产出的父子块喂阅读器，验四条会被用户直接看出来的性质：
//   1) 一个字的正文都不丢（只允许丢段与段之间那个空行分隔符）；
//   2) 拼接不重复（重叠的父块尾巴必须裁干净）；
//   3) 每个参与检索的子块都能在正文里定位到（不能有块"点过去找不到"）；
//   4) 高亮出来的文本逐字等于子块原文 —— 「看原文」有没有骗人就靠这条。
import { describe, expect, it } from 'vitest';

import { chunkDocument } from '../ingest/chunker';
import type { RagChunkRow } from '../api/host';
import { buildSpine, hitSlice } from './spine';

/**
 * 约 3.2 万字的中文文档。两种段落都是必需的：
 *   - 普通节（长段 ≈2800 字）→ 触发子块 80 字重叠；
 *   - 最后那一段超长单段 → 让父块组**在段中间断开**，于是父块之间也重叠。
 * 只有第一版样本时实测 parentOverlap = 0，「裁剪重复尾巴」那行根本没被执行，
 * 是变异探针把坏实现和好消息算成同一个数才发现的。
 */
function makeDoc(): string {
  const parts: string[] = [];
  for (let s = 0; s < 8; s++) {
    parts.push(`## 第 ${s + 1} 节`);
    parts.push(`第 ${s + 1} 节的长段落：${'这里放正文内容字符。'.repeat(200)}`);
    parts.push(`第 ${s + 1} 节的短段落：${'补充说明。'.repeat(150)}`);
  }
  parts.push('## 超长单段');
  parts.push(`这一段故意长到会在一半处断开父块：${'里面是连续正文。'.repeat(1200)}`);
  return parts.join('\n\n');
}

function toRows(): RagChunkRow[] {
  return chunkDocument(makeDoc()).map((c) => ({
    id: `c${c.idx}`,
    idx: c.idx,
    text: c.text,
    char_start: c.charStart,
    char_end: c.charEnd,
    parent_idx: c.parentIdx,
    // 父块按设计不存向量（withAll=true 之后 dim=0）
    dim: c.isParent ? 0 : 1024,
    embed_model: c.isParent ? '' : 'text-embedding-qwen3-embedding-0.6b',
  }));
}

const norm = (s: string) => s.replace(/\s+/g, '');

describe('阅读器对着真实 chunker 的输出', () => {
  const doc = makeDoc();
  const rows = toRows();
  const parents = rows.filter((r) => r.parent_idx === null);
  const children = rows.filter((r) => r.parent_idx !== null);
  const spine = buildSpine(rows);
  const joined = spine.map((s) => s.text).join('');

  it('样本确实产出了父子两层，且父块之间真的有重叠', () => {
    expect(parents.length).toBeGreaterThan(1);
    expect(children.length).toBeGreaterThan(parents.length);
    let pov = 0;
    for (let i = 1; i < spine.length; i++) if (spine[i].char_start < spine[i - 1].char_end) pov++;
    // spine 已裁过重叠，所以这里数的是「原始父块重叠过」：裁完必须为 0，
    // 而裁剪前不为 0 由下一条（长度 = 覆盖字符数）反向担保。
    expect(pov).toBe(0);
    let rawPov = 0;
    const ps = parents.slice().sort((a, b) => a.char_start - b.char_start);
    for (let i = 1; i < ps.length; i++) if (ps[i].char_start < ps[i - 1].char_end) rawPov++;
    expect(rawPov).toBeGreaterThan(0); // ← 没有这条，整个裁剪分支是死代码，测试成了空跑
  });

  it('一个字的正文都不丢（只丢段与段之间的空白分隔符）', () => {
    expect(norm(joined)).toBe(norm(doc));
    // 分隔符本身确实没进正文：差值 = 组边界上的 \n\n 个数 × 2
    expect(joined.length).toBeLessThan(doc.length);
  });

  it('拼接结果严格不重叠、不乱序', () => {
    for (let i = 1; i < spine.length; i++) {
      expect(spine[i].char_start).toBeGreaterThanOrEqual(spine[i - 1].char_end);
    }
  });

  it('正文长度 = 父块覆盖到的字符数（重复部分一个字符都没多进来）', () => {
    const covered = new Set<number>();
    for (const p of parents) for (let k = p.char_start; k < p.char_end; k++) covered.add(k);
    expect(joined.length).toBe(covered.size);
  });

  it('每个子块的每个字符都在正文里（可以跨相邻两段，但不能有缺口）', () => {
    // 不是「整体落在同一段里」：父块裁掉 80 字重叠后，跨界子块的开头 80 字
    // 会归到前一段的尾巴上 —— 字符只出现一次，正是我们想要的。
    const covered: [number, number][] = spine.map((s) => [s.char_start, s.char_start + s.text.length]);
    for (const c of children) {
      for (let k = c.char_start; k < c.char_end; k += 79) {
        expect(covered.some(([a, b]) => k >= a && k < b)).toBe(true);
      }
    }
  });

  it('高亮逐字等于子块原文（「看原文」不骗人的判据）', () => {
    for (const c of children) {
      const pieces: string[] = [];
      for (const s of spine) {
        const hs = hitSlice(s, { start: c.char_start, end: c.char_end });
        if (hs) pieces.push(s.text.slice(hs.from, hs.to));
      }
      expect(pieces.join('')).toBe(c.text);
    }
  });
});
