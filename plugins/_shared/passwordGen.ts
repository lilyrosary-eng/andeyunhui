// 高强度密码 / 助记短语生成（跨插件共享）
// 随机性只走 CSPRNG + 拒绝采样：Math.random 的不可预测性不足，`random % n` 在 n 不整除 2^32
// 时存在取模偏差——两者都会让「强度」沦为外观指标。这里每一位输出必须等概率。
// 本模块只负责「产出」；评价仍由 crypto 插件的 PasswordAudit（五维评分）负责，不在此重复一套判据。

export const CHAR_SETS = {
  lowercase: 'abcdefghijklmnopqrstuvwxyz',
  uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?/~',
} as const;

export type CharClass = keyof typeof CHAR_SETS;

/** 易混淆字符：Il1|O0o`'" */
const AMBIGUOUS = new Set('Il1|O0o`\'"');

const U32_RANGE = 0x1_0000_0000;

/** [0, maxExclusive) 上的等概率整数（拒绝采样，消除取模偏差）。 */
export function randomInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > U32_RANGE) {
    throw new Error(`randomInt: 上界非法（${maxExclusive}）`);
  }
  const buffer = new Uint32Array(1);
  const limit = Math.floor(U32_RANGE / maxExclusive) * maxExclusive;
  for (;;) {
    globalThis.crypto.getRandomValues(buffer);
    const value = buffer[0];
    if (value < limit) return value % maxExclusive;
  }
}

function filterAmbiguous(set: string): string {
  let out = '';
  for (const ch of set) if (!AMBIGUOUS.has(ch)) out += ch;
  return out;
}

function enabledSets(opts: PasswordOptions): string[] {
  const keys: CharClass[] = ['lowercase', 'uppercase', 'digits', 'symbols'];
  const exclude = opts.excludeAmbiguous === true;
  return keys
    .filter((k) => opts[k] !== false)
    .map((k) => (exclude ? filterAmbiguous(CHAR_SETS[k]) : CHAR_SETS[k]))
    .filter((s) => s.length > 0);
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

export interface PasswordOptions {
  length: number;
  lowercase?: boolean;
  uppercase?: boolean;
  digits?: boolean;
  symbols?: boolean;
  /** 排除 Il1|O0o`'" —— 手抄/口述场景建议开启 */
  excludeAmbiguous?: boolean;
  /** 每个启用的字符类至少出现一次（默认 true；长度不足时抛错而不是静默降级） */
  requireEach?: boolean;
}

export function generatePassword(opts: PasswordOptions): string {
  const length = Math.floor(opts.length);
  if (!Number.isInteger(length) || length < 4) throw new Error('密码长度至少 4 位');
  if (length > 256) throw new Error('密码长度最多 256 位');

  const sets = enabledSets(opts);
  if (sets.length === 0) throw new Error('至少启用一种字符');

  const requireEach = opts.requireEach !== false;
  if (requireEach && length < sets.length) {
    throw new Error(`长度至少 ${sets.length} 位，才能保证每种字符都出现`);
  }

  const pool = sets.join('');
  const chars: string[] = [];
  if (requireEach) {
    for (const set of sets) chars.push(set[randomInt(set.length)]);
  }
  while (chars.length < length) chars.push(pool[randomInt(pool.length)]);
  // 必须洗牌：否则「每类各一个」的前缀位置固定，等于白送结构信息。
  shuffle(chars);
  return chars.join('');
}

/** 理论熵（bit，向下取整）：按启用字符集大小与长度计，不含 requireEach 的结构约束。 */
export function estimatePasswordEntropy(opts: PasswordOptions): number {
  const poolSize = enabledSets(opts).join('').length;
  return poolSize > 1 ? Math.floor(Math.floor(opts.length) * Math.log2(poolSize)) : 0;
}

// ===================== 助记短语（不需词表资产） =====================

const ONSETS = [
  'b', 'c', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'w', 'z',
  'br', 'cr', 'dr', 'fl', 'gr', 'pl', 'sh', 'st', 'th', 'tr',
];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ai', 'ea', 'ou'];
const CODAS = ['', 'n', 'r', 's', 't', 'l', 'm', 'k'];

export interface PassphraseOptions {
  words?: number;
  syllablesPerWord?: number;
  separator?: string;
  capitalize?: boolean;
  /** 每个词尾追加一位随机数字 */
  appendDigit?: boolean;
}

function syllable(): string {
  return (
    ONSETS[randomInt(ONSETS.length)] +
    VOWELS[randomInt(VOWELS.length)] +
    CODAS[randomInt(CODAS.length)]
  );
}

export function generatePassphrase(opts: PassphraseOptions = {}): string {
  const words = Math.floor(opts.words ?? 4);
  if (words < 2 || words > 12) throw new Error('助记短语词数需在 2–12 之间');
  const perWord = Math.floor(opts.syllablesPerWord ?? 3);
  if (perWord < 1 || perWord > 6) throw new Error('每词音节数需在 1–6 之间');
  const separator = opts.separator ?? '-';

  const parts: string[] = [];
  for (let i = 0; i < words; i++) {
    let word = '';
    for (let s = 0; s < perWord; s++) word += syllable();
    if (opts.capitalize) word = word[0].toUpperCase() + word.slice(1);
    if (opts.appendDigit) word += String(randomInt(10));
    parts.push(word);
  }
  return parts.join(separator);
}

/** 保守熵估计：忽略词尾辅音，只按「首辅音 × 元音」计每音节组合数。 */
export function estimatePassphraseEntropy(opts: PassphraseOptions = {}): number {
  const words = Math.floor(opts.words ?? 4);
  const perWord = Math.floor(opts.syllablesPerWord ?? 3);
  const perSyllable = Math.log2(ONSETS.length * VOWELS.length);
  const digitBits = opts.appendDigit ? Math.log2(10) : 0;
  return Math.floor(words * (perWord * perSyllable + digitBits));
}
