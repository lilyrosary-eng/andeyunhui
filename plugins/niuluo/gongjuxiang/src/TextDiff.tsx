/// <reference path="../../../global.d.ts" />
const React = window.__HOST_REACT__;
const { useState, useMemo } = React;

import {
  diffLines,
  diffStats,
  buildRows,
  charDiff,
  unifiedDiff,
  splitDiffContent,
  generateHtmlDiff,
  type DiffLine,
  type CharSeg,
  type DiffOptions,
} from './diff';
import { autoDecode } from './codec';

interface DiffOpts extends DiffOptions {
  ignoreBlank: boolean;
}

function openFile(): Promise<{ bytes: Uint8Array; text: string; name: string }> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '*/*';
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) {
        resolve({ bytes: new Uint8Array(0), text: '', name: '' });
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const b = new Uint8Array(reader.result as ArrayBuffer);
        resolve({ bytes: b, text: autoDecode(b), name: file.name });
      };
      reader.onerror = () => resolve({ bytes: new Uint8Array(0), text: '', name: '' });
      reader.readAsArrayBuffer(file);
    };
    input.click();
  });
}

function downloadText(text: string, filename: string): void {
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    /* ignore */
  }
}

function copyText(text: string): void {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

function openHtmlInBrowser(html: string): void {
  try {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, '_blank');
    if (!w) {
      // 被拦截时退化为下载
      const a = document.createElement('a');
      a.href = url;
      a.download = 'diff_report.html';
      a.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch {
    /* ignore */
  }
}

function normalizeLines(text: string, opts: DiffOpts): string[] {
  let lines = text.split(/\r?\n/);
  if (opts.ignoreBlank) lines = lines.filter((l) => l.trim().length > 0);
  if (opts.ignoreWhitespace) lines = lines.map((l) => l.replace(/\s+/g, ' ').trim());
  if (opts.ignoreCase) lines = lines.map((l) => l.toLowerCase());
  return lines;
}

interface ChipProps {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}

function Chip({ active, onClick, children, title }: ChipProps) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`btn-press px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
        active
          ? 'bg-[var(--element-bg)] text-white border-transparent'
          : 'bg-white/70 dark:bg-stone-800/60 text-neutral-600 dark:text-stone-300 border-white/80 dark:border-stone-700/50 hover:border-[var(--element-border)]'
      }`}
    >
      {children}
    </button>
  );
}

function renderSegs(segs: CharSeg[]): React.ReactNode {
  return segs.map((s, i) => {
    if (s.type === 'equal') return <span key={i}>{s.text}</span>;
    const cls =
      s.type === 'remove'
        ? 'text-red-600 dark:text-red-400 bg-red-100/70 dark:bg-red-900/40 rounded-sm'
        : 'text-green-600 dark:text-green-400 bg-green-100/70 dark:bg-green-900/40 rounded-sm';
    return (
      <span key={i} className={cls}>
        {s.text}
      </span>
    );
  });
}

function gutter(num?: number): React.ReactNode {
  return (
    <span className="select-none w-10 shrink-0 pr-2 text-right text-neutral-300 dark:text-stone-600">
      {num ?? ''}
    </span>
  );
}

function TextDiff() {
  const [aText, setAText] = useState('');
  const [bText, setBText] = useState('');
  const [aName, setAName] = useState('');
  const [bName, setBName] = useState('');
  const [ignoreBlank, setIgnoreBlank] = useState(false);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [ignoreCase, setIgnoreCase] = useState(false);
  const [context, setContext] = useState(3);
  const [showOnlyDiff, setShowOnlyDiff] = useState(false);
  const [view, setView] = useState<'unified' | 'split' | 'separate'>('unified');
  const [status, setStatus] = useState('就绪');

  const opts: DiffOpts = { ignoreBlank, ignoreWhitespace, ignoreCase };

  const diff = useMemo(
    () => diffLines(normalizeLines(aText, opts), normalizeLines(bText, opts), opts),
    [aText, bText, ignoreBlank, ignoreWhitespace, ignoreCase],
  );
  const stats = useMemo(() => diffStats(diff), [diff]);
  const rows = useMemo(() => buildRows(diff), [diff]);
  const split = useMemo(() => splitDiffContent(diff), [diff]);
  const effContext = showOnlyDiff ? 0 : context;
  const unifiedText = useMemo(
    () => unifiedDiff(normalizeLines(aText, opts), normalizeLines(bText, opts), opts, effContext, aName || '旧版本', bName || '新版本'),
    [aText, bText, ignoreBlank, ignoreWhitespace, ignoreCase, effContext, aName, bName],
  );

  const handleOpenOld = async () => {
    const { text, name } = await openFile();
    if (text) {
      setAText(text);
      setAName(name);
      setStatus(`已加载旧文件: ${name}`);
    }
  };
  const handleOpenNew = async () => {
    const { text, name } = await openFile();
    if (text) {
      setBText(text);
      setBName(name);
      setStatus(`已加载新文件: ${name}`);
    }
  };
  const swap = () => {
    setAText(bText);
    setBText(aText);
    setAName(bName);
    setBName(aName);
    setStatus('已交换左右内容');
  };
  const saveDiff = () => {
    if (!diff.length || unifiedText.trim() === `--- ${aName || '旧版本'}\n+++ ${bName || '新版本'}`) {
      setStatus('没有差异内容可保存');
      return;
    }
    downloadText(unifiedText, 'diff.diff');
    setStatus('差异已保存');
  };
  const genHtml = () => {
    const html = generateHtmlDiff(normalizeLines(aText, opts), normalizeLines(bText, opts), opts);
    openHtmlInBrowser(html);
    setStatus('HTML 报告已生成');
  };
  const clearAll = () => {
    setAText('');
    setBText('');
    setAName('');
    setBName('');
    setStatus('已清空全部内容');
  };

  const statusLine = `旧:${normalizeLines(aText, opts).length} 新:${normalizeLines(bText, opts).length} 删:${stats.remove} 增:${stats.add}`;

  return (
    <div className="h-full flex flex-col">
      {/* 工具栏 */}
      <div className="px-5 py-2.5 border-b border-white/80 dark:border-stone-700/50 flex flex-wrap items-center gap-2">
        <Chip onClick={handleOpenOld}>打开旧文件</Chip>
        <Chip onClick={handleOpenNew}>打开新文件</Chip>
        <Chip onClick={swap}>交换</Chip>
        <span className="w-px h-5 bg-white/80 dark:bg-stone-700/50 mx-1" />
        <Chip onClick={genHtml}>生成HTML报告</Chip>
        <Chip onClick={saveDiff}>保存差异</Chip>
        <Chip onClick={() => copyText(unifiedText)}>复制报告</Chip>
        <Chip onClick={clearAll}>清空全部</Chip>

        <div className="ml-auto flex items-center gap-3 text-xs">
          <span className="text-green-600 dark:text-green-400">+{stats.add}</span>
          <span className="text-red-600 dark:text-red-400">−{stats.remove}</span>
          <span className="text-neutral-400 dark:text-stone-500">={stats.equal}</span>
        </div>
      </div>

      {/* 选项 */}
      <div className="px-5 py-2 border-b border-white/80 dark:border-stone-700/50 flex flex-wrap items-center gap-2">
        <Chip active={ignoreBlank} onClick={() => setIgnoreBlank((v) => !v)}>忽略空行</Chip>
        <Chip active={ignoreWhitespace} onClick={() => setIgnoreWhitespace((v) => !v)}>忽略空格</Chip>
        <Chip active={ignoreCase} onClick={() => setIgnoreCase((v) => !v)}>忽略大小写</Chip>
        <Chip active={showOnlyDiff} onClick={() => setShowOnlyDiff((v) => !v)} title="仅显示差异行（上下文行数置 0）">仅显示差异行</Chip>
        <span className="text-xs text-neutral-400 dark:text-stone-500 ml-2">上下文行数:</span>
        <input
          type="number"
          min={0}
          max={20}
          value={context}
          onChange={(e) => setContext(Math.max(0, Math.min(20, Number(e.target.value) || 0)))}
          className="w-14 px-2 py-1 rounded-lg text-xs border border-white/80 dark:border-stone-700/50 bg-white/70 dark:bg-stone-800/60 text-neutral-700 dark:text-stone-200 outline-none"
        />
      </div>

      {/* 双栏输入 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-white/80 dark:bg-stone-700/50 shrink-0" style={{ height: '34%' }}>
        <div className="flex flex-col bg-[#f5f5f0] dark:bg-[#1c1917] min-h-0">
          <div className="px-4 py-2 text-xs text-neutral-400 dark:text-stone-500">旧版本（Old）{aName ? ` - ${aName}` : ''}</div>
          <textarea
            value={aText}
            onChange={(e) => setAText(e.target.value)}
            spellCheck={false}
            placeholder="粘贴或打开旧文本…"
            className="flex-1 w-full resize-none outline-none bg-transparent px-4 pb-4 font-mono text-sm leading-relaxed text-neutral-700 dark:text-stone-200 placeholder:text-neutral-300 dark:placeholder:text-stone-600"
          />
        </div>
        <div className="flex flex-col bg-[#f5f5f0] dark:bg-[#1c1917] min-h-0">
          <div className="px-4 py-2 text-xs text-neutral-400 dark:text-stone-500">新版本（New）{bName ? ` - ${bName}` : ''}</div>
          <textarea
            value={bText}
            onChange={(e) => setBText(e.target.value)}
            spellCheck={false}
            placeholder="粘贴或打开新文本…"
            className="flex-1 w-full resize-none outline-none bg-transparent px-4 pb-4 font-mono text-sm leading-relaxed text-neutral-700 dark:text-stone-200 placeholder:text-neutral-300 dark:placeholder:text-stone-600"
          />
        </div>
      </div>

      {/* 结果区 */}
      <div className="px-5 py-2 border-y border-white/80 dark:border-stone-700/50 flex items-center gap-2">
        <Chip active={view === 'unified'} onClick={() => setView('unified')}>统一 Diff</Chip>
        <Chip active={view === 'split'} onClick={() => setView('split')}>并排（字符高亮）</Chip>
        <Chip active={view === 'separate'} onClick={() => setView('separate')}>分离差异</Chip>
      </div>

      <div className="flex-1 overflow-auto font-mono text-sm bg-[#f5f5f0] dark:bg-[#1c1917]">
        {diff.length === 0 ? (
          <div className="flex items-center justify-center h-full text-neutral-300 dark:text-stone-600 text-xs">
            在上方输入两段文本以对比
          </div>
        ) : view === 'unified' ? (
          <pre className="whitespace-pre-wrap break-words p-3 text-neutral-700 dark:text-stone-200">
            {unifiedText || '✅ 两个文本完全相同！'}
          </pre>
        ) : view === 'separate' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-white/80 dark:bg-stone-700/50 h-full">
            <div className="flex flex-col bg-[#f5f5f0] dark:bg-[#1c1917] min-h-0">
              <div className="flex items-center justify-between px-4 py-1.5 text-xs text-red-600 dark:text-red-400">
                <span>旧版本（删除的行）</span>
                <Chip onClick={() => copyText(split.removed.join('\n'))}>复制此段</Chip>
              </div>
              <pre className="flex-1 overflow-auto px-4 pb-4 whitespace-pre-wrap break-words text-red-700 dark:text-red-300">
                {split.removed.length ? split.removed.join('\n') : '（无删除行）'}
              </pre>
            </div>
            <div className="flex flex-col bg-[#f5f5f0] dark:bg-[#1c1917] min-h-0">
              <div className="flex items-center justify-between px-4 py-1.5 text-xs text-green-600 dark:text-green-400">
                <span>新版本（新增的行）</span>
                <Chip onClick={() => copyText(split.added.join('\n'))}>复制此段</Chip>
              </div>
              <pre className="flex-1 overflow-auto px-4 pb-4 whitespace-pre-wrap break-words text-green-700 dark:text-green-300">
                {split.added.length ? split.added.join('\n') : '（无新增行）'}
              </pre>
            </div>
          </div>
        ) : (
          <div>
            {rows.map((row, idx) => {
              const cd = row.hasCharDiff && row.left && row.right ? charDiff(row.left.text, row.right.text) : null;
              const leftCls =
                row.left?.type === 'remove'
                  ? 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300'
                  : 'text-neutral-600 dark:text-stone-300';
              const rightCls =
                row.right?.type === 'add'
                  ? 'bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300'
                  : 'text-neutral-600 dark:text-stone-300';
              return (
                <div key={idx} className="flex items-stretch border-b border-white/50 dark:border-stone-800/50">
                  <div className={`flex flex-1 min-w-0 px-2 py-0.5 ${leftCls}`}>
                    {gutter(row.left?.aNum)}
                    <span className="whitespace-pre-wrap break-words flex-1">
                      {cd ? renderSegs(cd.a) : row.left ? row.left.text || ' ' : ''}
                    </span>
                  </div>
                  <div className={`flex flex-1 min-w-0 px-2 py-0.5 border-l border-white/60 dark:border-stone-700/50 ${rightCls}`}>
                    {gutter(row.right?.bNum)}
                    <span className="whitespace-pre-wrap break-words flex-1">
                      {cd ? renderSegs(cd.b) : row.right ? row.right.text || ' ' : ''}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 状态栏 */}
      <div className="px-5 py-1.5 border-t border-white/80 dark:border-stone-700/50 text-[11px] text-neutral-400 dark:text-stone-500">
        {status} | {statusLine} | 快捷键: Ctrl+O 打开, Ctrl+D 对比, Ctrl+W 交换
      </div>
    </div>
  );
}

export { TextDiff };
