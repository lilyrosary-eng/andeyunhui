import { describe, it, expect } from 'vitest';
import {
  scrimPctFor,
  relativeLuminance,
  blurDownscaleEdge,
  WALLPAPER_SCRIM_PCT,
} from './wallpaperProbe';

function rgba(r: number, g: number, b: number, a = 255): number[] {
  return [r, g, b, a];
}

describe('scrimPctFor', () => {
  it('纯色态恒为 100%（分层不改变无壁纸时的任何像素）', () => {
    expect(scrimPctFor(false)).toBe('100%');
  });

  it('壁纸态用旧补丁的实际强度，不跟着面板透明度滑杆跑', () => {
    expect(scrimPctFor(true)).toBe(`${WALLPAPER_SCRIM_PCT}%`);
    expect(WALLPAPER_SCRIM_PCT).toBeLessThanOrEqual(35);
  });
});

describe('relativeLuminance', () => {
  it('纯黑≈0，纯白≈1', () => {
    expect(relativeLuminance(rgba(0, 0, 0))).toBeCloseTo(0, 2);
    expect(relativeLuminance(rgba(255, 255, 255))).toBeCloseTo(1, 2);
  });

  it('中间灰必须远低于 0.5（证明做了 sRGB 线性化，不是直接除 255）', () => {
    const gray = relativeLuminance(rgba(128, 128, 128));
    expect(gray).toBeGreaterThan(0.15);
    expect(gray).toBeLessThan(0.3);
  });

  it('逐像素加权：半黑半白的棋盘 ≈ 0.5，而纯中灰不是', () => {
    const checker = [...rgba(0, 0, 0), ...rgba(255, 255, 255)];
    expect(relativeLuminance(checker)).toBeCloseTo(0.5, 1);
    expect(relativeLuminance(rgba(128, 128, 128))).toBeLessThan(0.3);
  });

  it('空像素集给中性值，不把墨向推到极端', () => {
    expect(relativeLuminance([])).toBe(0.5);
  });

  it('绿比蓝亮（按 WCAG 权重，不是按 RGB 数值大小）', () => {
    expect(relativeLuminance(rgba(0, 255, 0))).toBeGreaterThan(relativeLuminance(rgba(0, 0, 255)));
  });
});

describe('blurDownscaleEdge', () => {
  it('blurPx 越大中间图越小', () => {
    expect(blurDownscaleEdge(12)).toBeLessThan(blurDownscaleEdge(2));
  });

  it('不模糊时给上限，模糊很猛时给下限（图不会缩成 0）', () => {
    expect(blurDownscaleEdge(0)).toBe(240);
    expect(blurDownscaleEdge(600)).toBe(3);
    expect(blurDownscaleEdge(Number.NaN)).toBe(240);
  });
});
