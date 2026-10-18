import { describe, it, expect } from 'vitest';
import { daysSince } from './clock';

/**
 * daysSince 的语义契约（供「认识 N 天」四处展示共用）：
 * - 未记录（null/undefined/0）→ 0
 * - 同一天 → 0，跨一天 → 1
 * - min 参数只抬高下限，不改变已跨天数
 *
 * 注意：这里只测纯函数部分。todaySec 取的是模块导入时的「今天」，
 * 因此用「相对今天」的输入构造用例，避免把测试写死在某个具体日期上。
 */
describe('daysSince', () => {
  const DAY = 86400;
  // 与 clock.ts 同一口径：今天 00:00 的 epoch 秒
  const today = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  })();

  it('未记录 first_met_at 时返回 0（含 null / undefined / 0 / 负值）', () => {
    expect(daysSince(null)).toBe(0);
    expect(daysSince(undefined)).toBe(0);
    expect(daysSince(0)).toBe(0);
    expect(daysSince(-1)).toBe(0);
  });

  it('同一天认识返回 0 天', () => {
    expect(daysSince(today)).toBe(0);
    expect(daysSince(today + 3600)).toBe(0); // 今天稍后
  });

  it('每跨一个自然日 +1', () => {
    expect(daysSince(today - DAY)).toBe(1);
    expect(daysSince(today - DAY * 3)).toBe(3);
    expect(daysSince(today - DAY * 30)).toBe(30);
  });

  it('min 只抬高下限：不足 1 天也显示 1', () => {
    expect(daysSince(today, 1)).toBe(1);
    expect(daysSince(today - DAY * 5, 1)).toBe(5);
  });

  it('min 为 0 时保持原样（默认口径）', () => {
    expect(daysSince(today - DAY * 2, 0)).toBe(2);
  });
});
