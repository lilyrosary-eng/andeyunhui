import { describe, it, expect } from 'vitest';
import {
  collectStorageItems,
  formatBytes,
  storageWarning,
  type StringStore,
  type StorageAudit,
} from './storageAudit';

function fakeStore(entries: Record<string, string>): StringStore {
  const keys = Object.keys(entries);
  return {
    length: keys.length,
    key: (i: number) => keys[i] ?? null,
    getItem: (k: string) => (k in entries ? entries[k] : null),
  };
}

describe('collectStorageItems', () => {
  it('按字节降序，且字节按 UTF-16 计（中文一个字 2 字节）', () => {
    const items = collectStorageItems(
      fakeStore({ a: 'x'.repeat(10), b: '汉'.repeat(4), empty: '' }),
    );
    expect(items.map((i) => i.key)).toEqual(['a', 'b', 'empty']);
    expect(items[0].bytes).toBe(2 + 20); // key 'a' + 10 个 ASCII
    expect(items[1].bytes).toBe(2 + 8); // key 'b' + 4 个汉字
    expect(items[2].bytes).toBe(10); // 只有键名：'empty' 5 字符 × 2
  });

  it('空存储给空数组，不报错', () => {
    expect(collectStorageItems(fakeStore({}))).toEqual([]);
  });
});

describe('formatBytes', () => {
  it('三档单位', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1048576)).toBe('5.00 MB');
  });
});

describe('storageWarning', () => {
  const at = (ratio: number | null, quota: number | null = 10 * 1048576): StorageAudit => ({
    items: [],
    totalBytes: ratio === null ? 0 : Math.round(quota! * ratio),
    quotaBytes: quota,
    usedRatio: ratio,
  });

  it('八成以上才警告', () => {
    expect(storageWarning(at(0.85))).toContain('85.0%');
    expect(storageWarning(at(0.5))).toBeNull();
  });

  it('配额未知时不瞎报', () => {
    expect(storageWarning(at(null, null))).toBeNull();
  });
});
