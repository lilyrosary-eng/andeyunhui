/// <reference path="../global.d.ts" />
// 密码生成器（跨插件共享 UI）：crypto 插件的「密码生成器」Tab 与 vault 条目编辑器共用。
// 产出逻辑在 ./passwordGen.ts（CSPRNG + 拒绝采样）；这里只负责交互与展示。
const React = window.__HOST_REACT__;
const { useMemo, useState } = React;

import {
  estimatePassphraseEntropy,
  estimatePasswordEntropy,
  generatePassphrase,
  generatePassword,
} from './passwordGen';

type Mode = 'random' | 'phrase';

export interface PasswordGeneratorProps {
  /** 提供后显示「使用」按钮，把当前结果交回调用方 */
  onUse?: (value: string) => void;
  onClose?: () => void;
  /** 紧凑模式：去掉标题栏，用于内嵌在编辑器里 */
  compact?: boolean;
}

/** 一次生成所用的完整配置快照。选项改动不会立刻换值，必须手动点「刷新」。 */
interface GenSnapshot {
  mode: Mode;
  length: number;
  lowercase: boolean;
  uppercase: boolean;
  digits: boolean;
  symbols: boolean;
  excludeAmbiguous: boolean;
  words: number;
  capitalize: boolean;
  appendDigit: boolean;
}

const PRESETS = [
  { label: '标准', length: 20, symbols: true },
  { label: '兼容旧系统', length: 16, symbols: false },
  { label: '超长', length: 40, symbols: true },
];

function strengthLabel(bits: number): { text: string; tone: string } {
  if (bits >= 110) return { text: '极强', tone: 'text-emerald-600 dark:text-emerald-400' };
  if (bits >= 85) return { text: '强', tone: 'text-emerald-600 dark:text-emerald-400' };
  if (bits >= 60) return { text: '中等', tone: 'text-amber-600 dark:text-amber-400' };
  return { text: '偏弱', tone: 'text-red-600 dark:text-red-400' };
}

export function PasswordGenerator({ onUse, onClose, compact }: PasswordGeneratorProps) {
  const [mode, setMode] = useState<Mode>('random');
  const [length, setLength] = useState(20);
  const [lowercase, setLowercase] = useState(true);
  const [uppercase, setUppercase] = useState(true);
  const [digits, setDigits] = useState(true);
  const [symbols, setSymbols] = useState(true);
  const [excludeAmbiguous, setExcludeAmbiguous] = useState(true);
  const [words, setWords] = useState(4);
  const [capitalize, setCapitalize] = useState(false);
  const [appendDigit, setAppendDigit] = useState(false);
  const [copied, setCopied] = useState(false);

  // 生成结果只由 snapshot 决定：改选项不会偷换用户已经看中的那一条，
  // 必须显式点「刷新」（助记短语尤其重要，调词数不应丢掉当前短语）。
  const [snapshot, setSnapshot] = useState<GenSnapshot>({
    mode: 'random',
    length: 20,
    lowercase: true,
    uppercase: true,
    digits: true,
    symbols: true,
    excludeAmbiguous: true,
    words: 4,
    capitalize: false,
    appendDigit: false,
  });

  const currentOptions = (modeOverride: Mode = mode): GenSnapshot => ({
    mode: modeOverride,
    length,
    lowercase,
    uppercase,
    digits,
    symbols,
    excludeAmbiguous,
    words,
    capitalize,
    appendDigit,
  });

  const refresh = (modeOverride?: Mode) => setSnapshot({ ...currentOptions(modeOverride) });
  // 切换模式同样不自动生成：用户可能正在对照两种形态，只在点「刷新」时出值。
  const switchMode = (m: Mode) => setMode(m);

  const dirty =
    snapshot.mode !== mode ||
    snapshot.length !== length ||
    snapshot.lowercase !== lowercase ||
    snapshot.uppercase !== uppercase ||
    snapshot.digits !== digits ||
    snapshot.symbols !== symbols ||
    snapshot.excludeAmbiguous !== excludeAmbiguous ||
    snapshot.words !== words ||
    snapshot.capitalize !== capitalize ||
    snapshot.appendDigit !== appendDigit;

  const value = useMemo(() => {
    try {
      if (snapshot.mode === 'random') {
        if (![snapshot.lowercase, snapshot.uppercase, snapshot.digits, snapshot.symbols].some(Boolean)) {
          return '';
        }
        return generatePassword({
          length: snapshot.length,
          lowercase: snapshot.lowercase,
          uppercase: snapshot.uppercase,
          digits: snapshot.digits,
          symbols: snapshot.symbols,
          excludeAmbiguous: snapshot.excludeAmbiguous,
        });
      }
      return generatePassphrase({
        words: snapshot.words,
        capitalize: snapshot.capitalize,
        appendDigit: snapshot.appendDigit,
      });
    } catch {
      return '';
    }
  }, [snapshot]);

  const bits = useMemo(
    () =>
      snapshot.mode === 'random'
        ? estimatePasswordEntropy(snapshot)
        : estimatePassphraseEntropy(snapshot),
    [snapshot],
  );

  const strength = strengthLabel(bits);

  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  const checkbox = (
    label: string,
    checked: boolean,
    onChange: (v: boolean) => void,
    disabled = false,
  ) => (
    <label className={`flex items-center gap-1.5 text-xs ${disabled ? 'opacity-40' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-[var(--element-bg)]"
      />
      {label}
    </label>
  );

  return (
    <div className="flex flex-col gap-3 text-sm text-neutral-700 dark:text-stone-200">
      {!compact && (
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">密码生成器</div>
          {onClose && (
            <button onClick={onClose} className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-300">
              关闭
            </button>
          )}
        </div>
      )}

      <div className="flex gap-1 p-1 rounded-lg bg-black/5 dark:bg-white/5 w-fit">
        {(['random', 'phrase'] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => switchMode(m)}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              mode === m
                ? 'bg-[var(--element-muted)] text-[var(--element-bg)]'
                : 'text-neutral-500 dark:text-stone-400'
            }`}
          >
            {m === 'random' ? '随机字符' : '助记短语'}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/70 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/60">
        <code className="flex-1 min-w-0 break-all font-mono text-[13px] leading-5 select-all">
          {value || '（至少选择一种字符）'}
        </code>
        <button
          onClick={() => refresh()}
          title="按当前选项重新生成"
          className={`shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-xs ${
            dirty
              ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
              : 'hairline hover:bg-black/5 dark:hover:bg-white/10'
          }`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 2v6h-6" />
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
            <path d="M3 22v-6h6" />
            <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
          </svg>
          刷新
        </button>
        <button onClick={copy} className="shrink-0 px-2 py-1 rounded-md text-xs hairline hover:bg-black/5 dark:hover:bg-white/10">
          {copied ? '已复制' : '复制'}
        </button>
        {onUse && (
          <button
            onClick={() => onUse(value)}
            disabled={!value}
            className="shrink-0 px-2 py-1 rounded-md text-xs bg-[var(--element-muted)] text-[var(--element-bg)] disabled:opacity-40"
          >
            使用
          </button>
        )}
      </div>

      <div className="flex items-center gap-3 text-xs">
        <span className={strength.tone}>{strength.text}</span>
        <span className="text-neutral-400 dark:text-stone-500">≈ {bits} bit 熵</span>
        {dirty && (
          <span className="text-amber-600 dark:text-amber-400">选项已更改，点「刷新」生成新值</span>
        )}
      </div>

      {mode === 'random' ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-500 dark:text-stone-400 w-16">长度 {length}</span>
            <input
              type="range"
              min={8}
              max={64}
              value={length}
              onChange={(e) => setLength(Number(e.target.value))}
              className="flex-1"
            />
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {checkbox('小写 a-z', lowercase, setLowercase)}
            {checkbox('大写 A-Z', uppercase, setUppercase)}
            {checkbox('数字 0-9', digits, setDigits)}
            {checkbox('符号 !@#$', symbols, setSymbols)}
          </div>
          <div className="flex flex-wrap gap-3">
            {checkbox('排除易混淆 I l 1 O 0', excludeAmbiguous, setExcludeAmbiguous)}
          </div>
          <div className="flex gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => {
                  setLength(p.length);
                  setLowercase(true);
                  setUppercase(true);
                  setDigits(true);
                  setSymbols(p.symbols);
                  setExcludeAmbiguous(true);
                }}
                className="px-2 py-1 rounded-md text-[11px] hairline hover:bg-black/5 dark:hover:bg-white/10"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-500 dark:text-stone-400 w-16">词数 {words}</span>
            <input
              type="range"
              min={2}
              max={12}
              value={words}
              onChange={(e) => setWords(Number(e.target.value))}
              className="flex-1"
            />
          </div>
          <div className="flex flex-wrap gap-3">
            {checkbox('首字母大写', capitalize, setCapitalize)}
            {checkbox('每词尾加数字', appendDigit, setAppendDigit)}
          </div>
          <p className="text-[11px] text-neutral-400 dark:text-stone-500">
            音节型短语不需要词表资产；熵按「首辅音 × 元音」保守估算，方便口述与手抄。
          </p>
        </div>
      )}
    </div>
  );
}
