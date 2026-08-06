import { describe, it, expect } from 'vitest';
import { affinityOf } from './affinity';

// 现状固化测试：六维加权（温暖30/信任20/亲密40/好奇5/耐心5）+ round + clamp [0,100]。

describe('affinityOf', () => {
  it('全 0 → 0', () => {
    expect(affinityOf({})).toBe(0);
  });

  it('缺失维度按 0 计', () => {
    expect(affinityOf({ warmth: 100 })).toBe(30);
    expect(affinityOf({ intimacy: 100 })).toBe(40);
    expect(affinityOf({ trust: 100 })).toBe(20);
    expect(affinityOf({ intrigue: 100 })).toBe(5);
    expect(affinityOf({ patience: 100 })).toBe(5);
  });

  it('六维满分 → 100', () => {
    expect(affinityOf({ warmth: 100, trust: 100, intimacy: 100, intrigue: 100, patience: 100 })).toBe(100);
  });

  it('超上限 clamp 到 100', () => {
    expect(affinityOf({ intimacy: 300 })).toBe(100);
  });

  it('负权重抵消后仍可正（-15+20=5）', () => {
    expect(affinityOf({ warmth: -50, trust: 100 })).toBe(5);
  });

  it('全负 clamp 到 0', () => {
    expect(affinityOf({ warmth: -50, intimacy: -50 })).toBe(0);
  });

  it('加权后四舍五入（0.5 入）', () => {
    expect(affinityOf({ intrigue: 10 })).toBe(1);
    expect(affinityOf({ warmth: 5, trust: 5, intimacy: 5, intrigue: 5, patience: 5 })).toBe(5);
  });

  it('tension 不纳入', () => {
    expect(affinityOf({ tension: 100, warmth: 100 })).toBe(30);
  });
});
