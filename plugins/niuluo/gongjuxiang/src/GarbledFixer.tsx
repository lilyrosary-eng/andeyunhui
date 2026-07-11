/// <reference path="../../../global.d.ts" />
const React = window.__HOST_REACT__;
const { useState, useMemo, useRef } = React;

import {
  scanFixes,
  applyReplaceMap,
  fullToHalf,
  halfToFull,
  removeInvisible,
  normalizeUnicode,
  simplifiedToTraditional,
  traditionalToSimplified,
  type ScanMode,
  type FixCandidate,
} from './garbled';
import { decodeBytes, autoDecode } from './codec';

function copyText(text: string): void {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
      return;
    }
  } catch {
    /* ignore */
  }
  fallbackCopy(text);
}

function fallbackCopy(text: string): void {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch {
    /* ignore */
  }
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

function openFile(): Promise<{ bytes: Uint8Array; text: string }> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '*/*';
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) {
        resolve({ bytes: new Uint8Array(0), text: '' });
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        let b = new Uint8Array(reader.result as ArrayBuffer);
        if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
          b = b.slice(3); // 去除 UTF-8 BOM
        }
        const preview = decodeBytes(b, 'utf-8', false);
        resolve({ bytes: b, text: preview });
      };
      reader.onerror = () => resolve({ bytes: new Uint8Array(0), text: '' });
      reader.readAsArrayBuffer(file);
    };
    input.click();
  });
}

function pasteInput(): string {
  try {
    return (window as unknown as { clipboardData?: { getData: (t: string) => string } }).clipboardData?.getData('text') || '';
  } catch {
    return '';
  }
}

function toHex(data: Uint8Array, limit = 300): string {
  const slice = data.slice(0, limit);
  let s = '';
  for (const b of slice) s += b.toString(16).padStart(2, '0') + ' ';
  return s.trim();
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

function GarbledFixer() {
  const [input, setInput] = useState('');
  const [rawBytes, setRawBytes] = useState<Uint8Array | null>(null);
  const [mode, setMode] = useState<ScanMode>('smart');
  const [scanning, setScanning] = useState(false);
  const [candidates, setCandidates] = useState<FixCandidate[]>([]);
  const [selected, setSelected] = useState(0);
  const [status, setStatus] = useState('就绪 | 可将文件直接拖入窗口（支持任意格式）');
  const [showHex, setShowHex] = useState(false);

  // 文本清洗（附加）
  const [fullToHalfOn, setFullToHalfOn] = useState(false);
  const [halfToFullOn, setHalfToFullOn] = useState(false);
  const [removeInvisibleOn, setRemoveInvisibleOn] = useState(false);
  const [nfcOn, setNfcOn] = useState(false);
  const [s2tOn, setS2tOn] = useState(false);
  const [t2sOn, setT2sOn] = useState(false);

  const onTextChange = (v: string) => {
    setInput(v);
    setRawBytes(null);
    setCandidates([]);
  };

  const handleOpen = async () => {
    const { bytes, text } = await openFile();
    if (bytes.length) {
      setRawBytes(bytes);
      setInput(text);
      setCandidates([]);
      setStatus(`已加载文件（${bytes.length} 字节）`);
    }
  };

  const handlePaste = async () => {
    let t = '';
    try {
      if (navigator.clipboard && navigator.clipboard.readText) t = await navigator.clipboard.readText();
    } catch {
      /* ignore */
    }
    if (!t) t = pasteInput();
    if (t) {
      onTextChange(t);
      setStatus('已从剪贴板粘贴');
    } else {
      setStatus('无法读取剪贴板（需授予权限）');
    }
  };

  const runScan = () => {
    if (scanning) return;
    const data: Uint8Array | string = rawBytes && rawBytes.length ? rawBytes : input;
    if (typeof data === 'string' && !data.trim()) {
      setStatus('请先粘贴乱码文本或打开文件');
      return;
    }
    setScanning(true);
    setStatus('扫描中…');
    setTimeout(() => {
      const res = scanFixes(data, mode);
      setCandidates(res);
      setScanning(false);
      if (res.length) {
        setSelected(0);
        setStatus(`扫描完成，共找到 ${res.length} 种可行方案（已按评分排序）`);
      } else {
        setStatus('未找到任何可行修复方案。可能文件不是文本或已严重损坏，请尝试其他模式。');
      }
    }, 20);
  };

  const output = useMemo(() => {
    if (!candidates.length) return '';
    const c = candidates[selected] || candidates[0];
    let t = applyReplaceMap(c.text);
    if (fullToHalfOn) t = fullToHalf(t);
    if (halfToFullOn) t = halfToFull(t);
    if (removeInvisibleOn) t = removeInvisible(t);
    if (nfcOn) t = normalizeUnicode(t);
    if (s2tOn) t = simplifiedToTraditional(t);
    if (t2sOn) t = traditionalToSimplified(t);
    return t;
  }, [candidates, selected, fullToHalfOn, halfToFullOn, removeInvisibleOn, nfcOn, s2tOn, t2sOn]);

  const hexData = useMemo(() => {
    if (rawBytes && rawBytes.length) return toHex(rawBytes);
    return toHex(new TextEncoder().encode(input));
  }, [rawBytes, input]);

  const currentSource = rawBytes && rawBytes.length ? 'file' : 'text';

  return (
    <div className="relative h-full flex flex-col">
      {/* 工具栏 */}
      <div className="px-5 py-2.5 border-b border-white/80 dark:border-stone-700/50 flex flex-wrap items-center gap-2">
        <Chip onClick={handlePaste}>粘贴输入</Chip>
        <Chip onClick={handleOpen}>打开文件</Chip>
        <Chip onClick={() => output && copyText(output)}>复制结果</Chip>
        <Chip onClick={() => output && downloadText(output, 'fixed.txt')}>保存结果</Chip>
        <Chip onClick={() => setShowHex(true)}>十六进制侦查</Chip>
        <Chip onClick={() => { onTextChange(''); setRawBytes(null); setStatus('已清空'); }}>清空</Chip>
      </div>

      {/* 修复策略 */}
      <div className="px-5 py-2 border-b border-white/80 dark:border-stone-700/50 flex flex-wrap items-center gap-2">
        <span className="text-xs text-neutral-400 dark:text-stone-500 mr-1">修复策略</span>
        <Chip active={mode === 'smart'} onClick={() => setMode('smart')}>智能优先（常见误配）</Chip>
        <Chip active={mode === 'bruteforce'} onClick={() => setMode('bruteforce')}>暴力遍历（所有编码）</Chip>
        <Chip active={mode === 'double'} onClick={() => setMode('double')}>双重解码（二次乱码）</Chip>
        <button
          onClick={runScan}
          disabled={scanning}
          className="btn-press ml-2 px-4 py-1.5 rounded-lg text-xs font-semibold bg-[var(--element-bg)] text-white disabled:opacity-50"
        >
          {scanning ? '扫描中…' : '开始修复'}
        </button>
        <span className="ml-auto text-[11px] text-neutral-400 dark:text-stone-500">{status}</span>
      </div>

      {/* 文本清洗（附加） */}
      <div className="px-5 py-2 border-b border-white/80 dark:border-stone-700/50 flex flex-wrap items-center gap-2">
        <span className="text-xs text-neutral-400 dark:text-stone-500 mr-1">文本清洗（附加，作用于结果）</span>
        <Chip active={fullToHalfOn} onClick={() => setFullToHalfOn((v) => !v)}>全→半</Chip>
        <Chip active={halfToFullOn} onClick={() => setHalfToFullOn((v) => !v)}>半→全</Chip>
        <Chip active={removeInvisibleOn} onClick={() => setRemoveInvisibleOn((v) => !v)} title="去除零宽/BOM/控制字符">去不可见</Chip>
        <Chip active={nfcOn} onClick={() => setNfcOn((v) => !v)} title="Unicode NFC 归一化">NFC</Chip>
        <Chip active={s2tOn} onClick={() => setS2tOn((v) => !v)}>简→繁</Chip>
        <Chip active={t2sOn} onClick={() => setT2sOn((v) => !v)}>繁→简</Chip>
      </div>

      {/* 输入 + 候选 + 输出 */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-px bg-white/80 dark:bg-stone-700/50 overflow-hidden">
        {/* 左：输入 + 候选列表 */}
        <div className="flex flex-col bg-[#f5f5f0] dark:bg-[#1c1917] min-h-0">
          <div className="px-4 py-2 text-xs text-neutral-400 dark:text-stone-500">
            输入（可直接粘贴或打开文件）· {input.length} 字符 · {currentSource === 'file' ? '文件字节模式' : '文本模式'}
          </div>
          <textarea
            value={input}
            onChange={(e) => onTextChange(e.target.value)}
            spellCheck={false}
            placeholder="粘贴乱码文本，或点击「打开文件」…"
            className="flex-1 w-full resize-none outline-none bg-transparent px-4 pb-4 font-mono text-sm leading-relaxed text-neutral-700 dark:text-stone-200 placeholder:text-neutral-300 dark:placeholder:text-stone-600"
          />
          <div className="border-t border-white/70 dark:border-stone-700/50 px-4 py-2 text-xs text-neutral-400 dark:text-stone-500">
            可行修复方案（按评分排序，点击预览）· 共 {candidates.length} 种
          </div>
          <div className="h-40 overflow-auto border-t border-white/70 dark:border-stone-700/50">
            {candidates.length === 0 ? (
              <div className="px-4 py-3 text-xs text-neutral-300 dark:text-stone-600">
                尚无方案。点击「开始修复」扫描。
              </div>
            ) : (
              candidates.map((c, i) => (
                <button
                  key={i}
                  onClick={() => setSelected(i)}
                  className={`w-full text-left px-4 py-1.5 text-xs font-mono border-b border-white/60 dark:border-stone-800/60 ${
                    i === selected ? 'bg-[var(--element-bg)]/10 text-[var(--element-bg)]' : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-300'
                  }`}
                >
                  <span className="inline-block w-14 text-right mr-2 opacity-70">[{c.score}]</span>
                  {c.desc}
                  <span className="ml-2 opacity-60">{c.text.slice(0, 40).replace(/\n/g, ' ')}…</span>
                </button>
              ))
            )}
          </div>
        </div>

        {/* 右：输出 */}
        <div className="flex flex-col bg-[#f5f5f0] dark:bg-[#1c1917] min-h-0">
          <div className="flex items-center justify-between px-4 py-2 text-xs text-neutral-400 dark:text-stone-500">
            <span>选中方案的完整内容（已应用替换映射）</span>
            <span>{output.length} 字符</span>
          </div>
          <textarea
            value={output}
            readOnly
            spellCheck={false}
            className="flex-1 w-full resize-none outline-none bg-transparent px-4 pb-4 font-mono text-sm leading-relaxed text-green-700 dark:text-green-300"
          />
        </div>
      </div>

      {/* 十六进制弹层 */}
      {showHex && (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center bg-black/40"
          onClick={() => setShowHex(false)}
        >
          <div
            className="bg-white dark:bg-stone-900 rounded-xl p-5 max-w-2xl w-[90%] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-neutral-700 dark:text-stone-200">十六进制预览（前 300 字节）</span>
              <button onClick={() => setShowHex(false)} className="text-neutral-400 hover:text-neutral-700 dark:hover:text-stone-200">关闭</button>
            </div>
            <pre className="text-xs font-mono whitespace-pre-wrap break-all text-neutral-700 dark:text-stone-300 bg-stone-100 dark:bg-stone-800 rounded-lg p-3 max-h-60 overflow-auto">
{hexData}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

export { GarbledFixer };
