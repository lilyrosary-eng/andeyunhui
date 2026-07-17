/// <reference path="../../../global.d.ts" />
// 茑萝 · 字典生成器（掩码 / 字符集 / 排列组合）
// 三种模式：
//   1. 掩码模式：?l?u?d?s 模式（仿 hashcat）
//   2. 字符集模式：自定义字符集 + 长度范围
//   3. 排列模式：从给定字符集生成所有不重复排列（nPr）
// 自动限制输出条数（默认 10000，防止内存爆炸）
const React = window.__HOST_REACT__;
const { useState, useMemo } = React;

const MASK_SETS: Record<string, string> = {
  '?l': 'abcdefghijklmnopqrstuvwxyz',
  '?u': 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  '?d': '0123456789',
  '?s': '!@#$%^&*()_+-=[]{}|;:,.<>?/',
  '?h': '0123456789abcdef',
  '?H': '0123456789ABCDEF',
};

function expandMask(mask: string): string[] {
  // 将 ?l?u?d 拆为 ['lower-set', 'upper-set', 'digit-set']
  const sets: string[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === '?' && i + 1 < mask.length) {
      const key = mask.slice(i, i + 2);
      const s = MASK_SETS[key];
      if (s) {
        sets.push(s);
        i++;
      } else {
        sets.push(mask[i + 1]);
        i++;
      }
    } else {
      sets.push(mask[i]);
    }
  }
  return sets;
}

function* cartesian(sets: string[]): Generator<string> {
  if (sets.length === 0) { yield ''; return; }
  const idx = new Array(sets.length).fill(0);
  while (true) {
    let out = '';
    for (let i = 0; i < sets.length; i++) out += sets[i][idx[i]];
    yield out;
    // 末位 +1 进位
    let k = sets.length - 1;
    while (k >= 0) {
      idx[k]++;
      if (idx[k] < sets[k].length) break;
      idx[k] = 0;
      k--;
    }
    if (k < 0) return;
  }
}

function* rangeGen(charset: string, minLen: number, maxLen: number): Generator<string> {
  for (let len = minLen; len <= maxLen; len++) {
    const sets = new Array(len).fill(charset);
    yield* cartesian(sets);
  }
}

function* permutations(chars: string[], r: number): Generator<string> {
  if (r === 0) { yield ''; return; }
  if (chars.length < r) return;
  for (let i = 0; i < chars.length; i++) {
    const rest = [...chars.slice(0, i), ...chars.slice(i + 1)];
    for (const tail of permutations(rest, r - 1)) {
      yield chars[i] + tail;
    }
  }
}

function copyText(text: string): void {
  try { navigator.clipboard?.writeText(text); } catch { /* ignore */ }
}

function downloadText(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type Mode = 'mask' | 'charset' | 'permutation';

function DictionaryGen() {
  const [mode, setMode] = useState<Mode>('mask');
  // 掩码
  const [mask, setMask] = useState('?l?l?d?d');
  // 字符集模式
  const [charset, setCharset] = useState('abcdefghijklmnopqrstuvwxyz0123456789');
  const [minLen, setMinLen] = useState(4);
  const [maxLen, setMaxLen] = useState(6);
  // 排列模式
  const [permInput, setPermInput] = useState('abcd');
  const [permR, setPermR] = useState(4);
  // 通用
  const [limit, setLimit] = useState(10000);
  const [results, setResults] = useState<string[]>([]);
  const [totalEst, setTotalEst] = useState(0);
  const [truncated, setTruncated] = useState(false);

  const generate = () => {
    const out: string[] = [];
    let estimated = 0;
    let truncatedFlag = false;

    if (mode === 'mask') {
      const sets = expandMask(mask);
      estimated = sets.reduce((acc, s) => acc * s.length, 1);
      for (const s of cartesian(sets)) {
        if (out.length >= limit) { truncatedFlag = true; break; }
        out.push(s);
      }
    } else if (mode === 'charset') {
      if (!charset) { setResults([]); setTotalEst(0); setTruncated(false); return; }
      for (let len = minLen; len <= maxLen; len++) estimated += Math.pow(charset.length, len);
      for (const s of rangeGen(charset, minLen, maxLen)) {
        if (out.length >= limit) { truncatedFlag = true; break; }
        out.push(s);
      }
    } else {
      const chars = permInput.split('').filter((c, i, a) => a.indexOf(c) === i);
      if (permR > 0 && permR <= chars.length) {
        // nPr = n! / (n-r)!
        let npr = 1;
        for (let i = 0; i < permR; i++) npr *= (chars.length - i);
        estimated = npr;
        for (const s of permutations(chars, permR)) {
          if (out.length >= limit) { truncatedFlag = true; break; }
          out.push(s);
        }
      }
    }

    setResults(out);
    setTotalEst(estimated);
    setTruncated(truncatedFlag);
  };

  const inputCls = 'w-full px-3 py-2 rounded-xl bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm font-mono text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-border)]';
  const labelCls = 'text-xs text-neutral-500 dark:text-stone-400 mb-1 block';

  return (
    <div className="p-5 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex rounded-xl overflow-hidden border border-white/80 dark:border-stone-700/50">
          <button onClick={() => setMode('mask')} className={`px-4 py-1.5 text-sm ${mode === 'mask' ? 'bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100' : 'bg-white/40 dark:bg-stone-800/40 text-neutral-500'}`}>掩码模式</button>
          <button onClick={() => setMode('charset')} className={`px-4 py-1.5 text-sm ${mode === 'charset' ? 'bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100' : 'bg-white/40 dark:bg-stone-800/40 text-neutral-500'}`}>字符集模式</button>
          <button onClick={() => setMode('permutation')} className={`px-4 py-1.5 text-sm ${mode === 'permutation' ? 'bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100' : 'bg-white/40 dark:bg-stone-800/40 text-neutral-500'}`}>排列模式</button>
        </div>
        <button onClick={generate} className="btn-press px-4 py-1.5 rounded-lg bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100 transition-colors ml-auto">生成</button>
      </div>

      <div className="rounded-xl bg-white/50 dark:bg-stone-800/40 border border-white/80 dark:border-stone-700/50 p-4 space-y-3">
        {mode === 'mask' && (
          <>
            <div>
              <span className={labelCls}>掩码（仿 hashcat：?l 小写 / ?u 大写 / ?d 数字 / ?s 符号 / ?h 十六进制小写 / ?H 十六进制大写）</span>
              <input value={mask} onChange={e => setMask(e.target.value)} placeholder="例：?l?l?d?d" className={inputCls} />
            </div>
            <div className="flex gap-2 flex-wrap text-xs">
              {Object.entries(MASK_SETS).map(([k, v]) => (
                <button key={k} onClick={() => setMask(m => m + k)}
                  className="px-2 py-1 rounded-lg bg-white/70 dark:bg-stone-800/70 border border-white/80 dark:border-stone-700/50 text-neutral-600 dark:text-stone-300 hover:bg-white">
                  {k} <span className="text-neutral-400">({v.length} 字符)</span>
                </button>
              ))}
            </div>
          </>
        )}

        {mode === 'charset' && (
          <>
            <div>
              <span className={labelCls}>自定义字符集</span>
              <input value={charset} onChange={e => setCharset(e.target.value)} className={inputCls} />
            </div>
            <div className="flex gap-3 items-center">
              <label className="text-xs text-neutral-600 dark:text-stone-300 flex items-center gap-2">
                最小长度
                <input type="number" min={1} max={10} value={minLen} onChange={e => setMinLen(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                  className="w-20 px-2 py-1 rounded-lg bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm outline-none" />
              </label>
              <label className="text-xs text-neutral-600 dark:text-stone-300 flex items-center gap-2">
                最大长度
                <input type="number" min={1} max={10} value={maxLen} onChange={e => setMaxLen(Math.max(minLen, Math.min(10, parseInt(e.target.value) || 1)))}
                  className="w-20 px-2 py-1 rounded-lg bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm outline-none" />
              </label>
            </div>
          </>
        )}

        {mode === 'permutation' && (
          <>
            <div>
              <span className={labelCls}>字符集（不重复字符）</span>
              <input value={permInput} onChange={e => setPermInput(e.target.value)} placeholder="例：abcd" className={inputCls} />
            </div>
            <label className="text-xs text-neutral-600 dark:text-stone-300 flex items-center gap-2">
              取 r 个进行排列（nPr）
              <input type="number" min={1} max={10} value={permR} onChange={e => setPermR(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                className="w-20 px-2 py-1 rounded-lg bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm outline-none" />
            </label>
          </>
        )}

        <div className="flex items-center gap-3 pt-2 border-t border-white/60 dark:border-stone-700/40">
          <label className="text-xs text-neutral-600 dark:text-stone-300 flex items-center gap-2">
            输出上限
            <input type="number" min={100} max={1000000} value={limit} onChange={e => setLimit(Math.max(100, Math.min(1000000, parseInt(e.target.value) || 100)))}
              className="w-24 px-2 py-1 rounded-lg bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 text-sm outline-none" />
          </label>
        </div>
      </div>

      {results.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-xs text-neutral-500 dark:text-stone-400">
              已生成 {results.length} 条
              {totalEst > results.length && ` / 估算总量 ${totalEst.toLocaleString()}`}
              {truncated && <span className="text-amber-600 dark:text-amber-400 ml-1">（已达上限，未完整生成）</span>}
            </span>
            <div className="flex gap-2">
              <button onClick={() => copyText(results.join('\n'))}
                className="btn-press px-3 py-1 rounded-lg bg-white/70 dark:bg-stone-800/70 border border-white/80 dark:border-stone-700/50 text-xs text-neutral-600 dark:text-stone-300">
                复制全部
              </button>
              <button onClick={() => downloadText(results.join('\n'), 'dictionary.txt')}
                className="btn-press px-3 py-1 rounded-lg bg-white/70 dark:bg-stone-800/70 border border-white/80 dark:border-stone-700/50 text-xs text-neutral-600 dark:text-stone-300">
                下载 .txt
              </button>
            </div>
          </div>
          <div className="rounded-xl bg-white/40 dark:bg-stone-800/40 border border-white/60 dark:border-stone-700/40 max-h-[50vh] overflow-y-auto p-2">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-1 font-mono text-xs">
              {results.slice(0, 2000).map((r, i) => (
                <div key={i} className="px-2 py-0.5 rounded text-neutral-700 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/5">
                  {r}
                </div>
              ))}
            </div>
            {results.length > 2000 && (
              <div className="text-center text-xs text-neutral-400 dark:text-stone-500 py-2">
                （仅显示前 2000 条，已复制 / 下载全部）
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export { DictionaryGen };
