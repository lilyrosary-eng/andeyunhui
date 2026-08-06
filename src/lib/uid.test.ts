import { describe, it, expect } from 'vitest';
import { uid } from './uid';

// 现状固化测试：格式契约 = 前缀 + Date.now()(base36) + Math.random() 末 4 位(base36)。

describe('uid', () => {
  it('保留前缀', () => {
    expect(uid('c_').startsWith('c_')).toBe(true);
    expect(uid('u_').startsWith('u_')).toBe(true);
  });

  it('格式为前缀 + base36 时间戳 + 4 位随机', () => {
    const id = uid('a_');
    const rest = id.slice(2);
    expect(rest.length).toBeGreaterThanOrEqual(6);
    expect(/^[0-9a-z]+$/.test(rest)).toBe(true);
  });

  it('连续调用不重复', () => {
    const seen = new Set(Array.from({ length: 50 }, () => uid('t_')));
    expect(seen.size).toBe(50);
  });

  it('空前缀也合法', () => {
    expect(uid('')).toBeTruthy();
  });
});
