import { describe, it, expect } from 'vitest';
import { fmtSize } from './formatSize';

// 现状固化测试：字节 → B/KB/MB/GB 四档格式化（期望值取原函数真实输出）。

describe('fmtSize', () => {
  it('0 → 0 B', () => {
    expect(fmtSize(0)).toBe('0 B');
  });

  it('负值走原始 B 档（现状行为）', () => {
    expect(fmtSize(-1)).toBe('-1 B');
  });

  it('NaN 走 0 B 分支', () => {
    expect(fmtSize(NaN)).toBe('0 B');
  });

  it('B 档边界', () => {
    expect(fmtSize(1)).toBe('1 B');
    expect(fmtSize(1023)).toBe('1023 B');
  });

  it('KB 档', () => {
    expect(fmtSize(1024)).toBe('1.0 KB');
    expect(fmtSize(5120)).toBe('5.0 KB');
  });

  it('MB 档（含 1MB 边界）', () => {
    expect(fmtSize(1024 * 1024 - 1)).toBe('1024.0 KB');
    expect(fmtSize(1024 * 1024)).toBe('1.0 MB');
    expect(fmtSize(3.5 * 1024 * 1024)).toBe('3.5 MB');
  });

  it('GB 档（含 1GB 边界）', () => {
    expect(fmtSize(1024 * 1024 * 1024 - 1)).toBe('1024.0 MB');
    expect(fmtSize(1024 * 1024 * 1024)).toBe('1.00 GB');
    expect(fmtSize(2.25 * 1024 * 1024 * 1024)).toBe('2.25 GB');
  });
});
