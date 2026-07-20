// 文本差异对比 — 纯函数（LCS 行差异 + 字符级差异）
//
// 设计：基于最长公共子序列（LCS）的经典 diff，支持
//   - 行级增/删/不变标记
//   - 字符级差异高亮（用于并排视图中成对的变化行）
//   - 忽略空白差异 / 忽略大小写 的对比时归一化

export type DiffOp = 'equal' | 'add' | 'remove';

export interface DiffLine {
  type: DiffOp;
  text: string;
  aNum?: number; // 在原文 A 中的行号（1-based），remove/equal 有
  bNum?: number; // 在对比文 B 中的行号（1-based），add/equal 有
}

export interface DiffOptions {
  ignoreWhitespace?: boolean;
  ignoreCase?: boolean;
}

function normLine(s: string, opts: DiffOptions): string {
  let t = s;
  if (opts.ignoreWhitespace) t = t.replace(/\s+/g, '');
  if (opts.ignoreCase) t = t.toLowerCase();
  return t;
}

// 行级 LCS diff
export function diffLines(aLines: string[], bLines: string[], opts: DiffOptions = {}): DiffLine[] {
  const n = aLines.length;
  const m = bLines.length;
  // dp[i][j] = LCS 长度(a[i..], b[j..])
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (normLine(aLines[i], opts) === normLine(bLines[j], opts)) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (normLine(aLines[i], opts) === normLine(bLines[j], opts)) {
      result.push({ type: 'equal', text: aLines[i], aNum: i + 1, bNum: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'remove', text: aLines[i], aNum: i + 1 });
      i++;
    } else {
      result.push({ type: 'add', text: bLines[j], bNum: j + 1 });
      j++;
    }
  }
  while (i < n) {
    result.push({ type: 'remove', text: aLines[i], aNum: i + 1 });
    i++;
  }
  while (j < m) {
    result.push({ type: 'add', text: bLines[j], bNum: j + 1 });
    j++;
  }
  return result;
}

export interface DiffStats {
  add: number;
  remove: number;
  equal: number;
}

export function diffStats(lines: DiffLine[]): DiffStats {
  const s: DiffStats = { add: 0, remove: 0, equal: 0 };
  for (const l of lines) {
    if (l.type === 'add') s.add++;
    else if (l.type === 'remove') s.remove++;
    else s.equal++;
  }
  return s;
}

// ============ 字符级差异（用于并排视图中成对的变化行高亮） ============
export interface CharSeg {
  type: DiffOp;
  text: string;
}

function charLcs(a: string, b: string): number[][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

function buildSegs(a: string, b: string, dp: number[][], i: number, j: number, segs: CharSeg[]): void {
  if (i < 0 && j < 0) return;
  if (i >= 0 && j >= 0 && a[i] === b[j]) {
    // 公共字符：先递归，再前置（保持顺序）
    buildSegs(a, b, dp, i - 1, j - 1, segs);
    segs.push({ type: 'equal', text: a[i] });
  } else if (j >= 0 && (i < 0 || dp[i][j + 1] >= dp[i + 1][j])) {
    buildSegs(a, b, dp, i, j - 1, segs);
    segs.push({ type: 'add', text: b[j] });
  } else {
    buildSegs(a, b, dp, i - 1, j, segs);
    segs.push({ type: 'remove', text: a[i] });
  }
}

export interface CharDiffResult {
  a: CharSeg[]; // 原文侧片段（remove 表示被删）
  b: CharSeg[]; // 对比侧片段（add 表示新增）
}

export function charDiff(a: string, b: string): CharDiffResult {
  const dp = charLcs(a, b);
  const segs: CharSeg[] = [];
  buildSegs(a, b, dp, a.length - 1, b.length - 1, segs);
  // 将相邻同类型片段合并，便于渲染
  const merged: CharSeg[] = [];
  for (const seg of segs) {
    const last = merged[merged.length - 1];
    if (last && last.type === seg.type) last.text += seg.text;
    else merged.push({ ...seg });
  }
  // a 侧只保留 equal / remove，b 侧只保留 equal / add
  const fa: CharSeg[] = [];
  const fb: CharSeg[] = [];
  for (const seg of merged) {
    if (seg.type === 'equal') {
      fa.push(seg);
      fb.push(seg);
    } else if (seg.type === 'remove') {
      fa.push(seg);
    } else {
      fb.push(seg);
    }
  }
  return { a: fa, b: fb };
}

// ============ 并排视图的「行」模型 ============
export interface DiffRow {
  left?: DiffLine; // 原文侧（remove / equal）
  right?: DiffLine; // 对比侧（add / equal）
  hasCharDiff?: boolean;
}

// 把行级 diff 对齐成左右两列，连续的 remove/add 块成对，用于字符级高亮。
export function buildRows(lines: DiffLine[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const d = lines[i];
    if (d.type === 'equal') {
      rows.push({ left: d, right: d });
      i++;
    } else {
      const removes: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i].type === 'remove') {
        removes.push(lines[i]);
        i++;
      }
      while (i < lines.length && lines[i].type === 'add') {
        adds.push(lines[i]);
        i++;
      }
      const max = Math.max(removes.length, adds.length);
      for (let k = 0; k < max; k++) {
        const l = removes[k];
        const r = adds[k];
        rows.push({
          left: l ? { ...l, type: 'remove' } : undefined,
          right: r ? { ...r, type: 'add' } : undefined,
          hasCharDiff: !!(l && r),
        });
      }
    }
  }
  return rows;
}

// ============ 统一 Diff（带 @@ hunk 头与上下文行） ============
interface UItem {
  t: ' ' | '-' | '+';
  text: string;
  o?: number; // 旧行号
  n?: number; // 新行号
}

export function unifiedDiff(
  oldLines: string[],
  newLines: string[],
  opts: DiffOptions,
  context: number,
  fromLabel: string,
  toLabel: string,
): string {
  const diff = diffLines(oldLines, newLines, opts);
  let oldNo = 0;
  let newNo = 0;
  const items: UItem[] = diff.map((d) => {
    if (d.type === 'equal') {
      oldNo++;
      newNo++;
      return { t: ' ', text: d.text, o: oldNo, n: newNo };
    }
    if (d.type === 'remove') {
      oldNo++;
      return { t: '-', text: d.text, o: oldNo };
    }
    newNo++;
    return { t: '+', text: d.text, n: newNo };
  });

  const changeIdx: number[] = [];
  items.forEach((it, i) => {
    if (it.t !== ' ') changeIdx.push(i);
  });
  if (changeIdx.length === 0) {
    return `--- ${fromLabel}\n+++ ${toLabel}\n`;
  }

  // 将变更聚成簇（簇内间隔 <= 2*context 视为同一 hunk）
  const clusters: number[][] = [];
  let cur = [changeIdx[0]];
  for (let i = 1; i < changeIdx.length; i++) {
    if (changeIdx[i] - changeIdx[i - 1] - 1 <= 2 * context) {
      cur.push(changeIdx[i]);
    } else {
      clusters.push(cur);
      cur = [changeIdx[i]];
    }
  }
  clusters.push(cur);

  const hunks: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  for (const cluster of clusters) {
    const start = Math.max(0, cluster[0] - context);
    const end = Math.min(items.length - 1, cluster[cluster.length - 1] + context);
    let oldCount = 0;
    let newCount = 0;
    for (let k = start; k <= end; k++) {
      if (items[k].t !== '+') oldCount++;
      if (items[k].t !== '-') newCount++;
    }
    let oldStart: number;
    let newStart: number;
    if (items[start].t === '+') oldStart = (start > 0 ? items[start - 1].o! : 0) + 1;
    else oldStart = items[start].o!;
    if (items[start].t === '-') newStart = (start > 0 ? items[start - 1].n! : 0) + 1;
    else newStart = items[start].n!;
    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (let k = start; k <= end; k++) {
      hunks.push(`${items[k].t}${items[k].text}`);
    }
  }
  return hunks.join('\n') + '\n';
}

// ============ 分离差异（仅删除行 / 仅新增行） ============
export interface SplitDiff {
  removed: string[];
  added: string[];
}

export function splitDiffContent(lines: DiffLine[]): SplitDiff {
  return {
    removed: lines.filter((l) => l.type === 'remove').map((l) => l.text),
    added: lines.filter((l) => l.type === 'add').map((l) => l.text),
  };
}

// ============ HTML 报告 ============
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br/>');
}

export function generateHtmlDiff(oldLines: string[], newLines: string[], opts: DiffOptions): string {
  const diff = diffLines(oldLines, newLines, opts);
  const rows = diff
    .map((l) => {
      const cls = l.type === 'remove' ? 'd' : l.type === 'add' ? 'a' : 'e';
      const left = l.type === 'add' ? '' : escHtml(l.text) || '&nbsp;';
      const right = l.type === 'remove' ? '' : escHtml(l.text) || '&nbsp;';
      return `<tr><td class="${cls}">${left}</td><td class="${cls}">${right}</td></tr>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<title>文本差异对比报告</title>
<style>
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 24px; color: #222; }
  h1 { font-size: 18px; }
  table { border-collapse: collapse; width: 100%; font-family: Consolas, "Courier New", monospace; font-size: 13px; }
  td { border: 1px solid #e5e5e5; padding: 2px 8px; vertical-align: top; white-space: pre-wrap; width: 50%; }
  td.d { background: #ffe6e6; }
  td.a { background: #e6ffe6; }
  td.e { background: #fafafa; color: #555; }
</style>
</head>
<body>
  <h1>文本差异对比报告</h1>
  <table>
${rows}
  </table>
</body>
</html>`;
}
