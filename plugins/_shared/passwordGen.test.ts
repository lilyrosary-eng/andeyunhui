// passwordGen 纯逻辑单测：长度/字符集合规、每类必现、排除易混淆、洗牌有效性、熵估计、短语形态。
// 运行环境 vitest node（Node 24 已提供全局 WebCrypto，与 webview 内同一套 getRandomValues）。
import { describe, expect, it } from 'vitest';
import {
  CHAR_SETS,
  estimatePassphraseEntropy,
  estimatePasswordEntropy,
  generatePassphrase,
  generatePassword,
  randomInt,
} from './passwordGen';

const ALL = CHAR_SETS.lowercase + CHAR_SETS.uppercase + CHAR_SETS.digits + CHAR_SETS.symbols;
const AMBIGUOUS = new Set('Il1|O0o`\'"');

describe('randomInt', () => {
  it('落在 [0, bound) 且每个取值都能出现', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = randomInt(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
      seen.add(v);
    }
    expect(seen.size).toBe(7);
  });

  it('非法上界直接拒绝，而不是返回垃圾值', () => {
    expect(() => randomInt(0)).toThrow();
    expect(() => randomInt(-1)).toThrow();
    expect(() => randomInt(1.5)).toThrow();
  });
});

describe('generatePassword', () => {
  it('长度精确、字符只来自启用字符集', () => {
    const pw = generatePassword({ length: 32 });
    expect(pw).toHaveLength(32);
    for (const ch of pw) expect(ALL).toContain(ch);

    const digitsOnly = generatePassword({
      length: 12,
      lowercase: false,
      uppercase: false,
      symbols: false,
    });
    expect(digitsOnly).toHaveLength(12);
    expect(/^\d{12}$/.test(digitsOnly)).toBe(true);
  });

  it('排除易混淆字符时一个都不出现', () => {
    for (let i = 0; i < 50; i++) {
      const pw = generatePassword({ length: 40, excludeAmbiguous: true });
      for (const ch of pw) expect(AMBIGUOUS.has(ch)).toBe(false);
    }
  });

  it('每类必现：长度够时四类齐全，长度不够时抛错', () => {
    for (let i = 0; i < 30; i++) {
      const pw = generatePassword({ length: 4 });
      expect(/[a-z]/.test(pw)).toBe(true);
      expect(/[A-Z]/.test(pw)).toBe(true);
      expect(/[0-9]/.test(pw)).toBe(true);
      expect(/[^a-zA-Z0-9]/.test(pw)).toBe(true);
    }
    expect(() => generatePassword({ length: 3 })).toThrow('长度至少 4 位');
  });

  it('洗牌有效：首字符不总是固定类别', () => {
    const firstClasses = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const first = generatePassword({ length: 8 })[0];
      if (/[a-z]/.test(first)) firstClasses.add('lower');
      else if (/[A-Z]/.test(first)) firstClasses.add('upper');
      else if (/\d/.test(first)) firstClasses.add('digit');
      else firstClasses.add('symbol');
    }
    expect(firstClasses.size).toBeGreaterThanOrEqual(3);
  });

  it('两次生成不相同（同参数也不复用）', () => {
    expect(generatePassword({ length: 20 })).not.toBe(generatePassword({ length: 20 }));
  });

  it('熵估计与字符集规模一致', () => {
    const bits = estimatePasswordEntropy({ length: 16 });
    expect(bits).toBeGreaterThan(100);
    expect(bits).toBeLessThan(110);
    expect(estimatePasswordEntropy({ length: 16, lowercase: true, uppercase: false, digits: false, symbols: false })).toBe(
      Math.floor(16 * Math.log2(26)),
    );
  });
});

describe('generatePassphrase', () => {
  it('词数/音节/分隔符形态正确', () => {
    const phrase = generatePassphrase({ words: 5, syllablesPerWord: 3, separator: '.' });
    const parts = phrase.split('.');
    expect(parts).toHaveLength(5);
    for (const p of parts) {
      // 单音节 = 首辅音(1–2) + 元音(1–2) + 词尾辅音(0–1) → 3–5 字符；3 音节即 9–15 字符
      expect(p).toMatch(/^[a-z]{3,15}$/);
    }
  });

  it('大写与数字选项生效', () => {
    const phrase = generatePassphrase({ words: 4, capitalize: true, appendDigit: true });
    for (const word of phrase.split('-')) {
      expect(/^[A-Z]/.test(word)).toBe(true);
      expect(/\d$/.test(word)).toBe(true);
    }
  });

  it('默认参数熵不低于 90 bit（保守估计）', () => {
    expect(estimatePassphraseEntropy()).toBeGreaterThanOrEqual(90);
    expect(generatePassphrase().split('-')).toHaveLength(4);
  });

  it('越界参数抛错', () => {
    expect(() => generatePassphrase({ words: 1 })).toThrow();
    expect(() => generatePassphrase({ words: 4, syllablesPerWord: 0 })).toThrow();
  });
});
