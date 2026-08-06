import { describe, it, expect } from 'vitest';
import { dirVectorOf, pickAngleFrame, getSunsetHours } from './motion';

// 现状固化测试：朝向解析 / 角度最近匹配 / 日落近似（期望值取当前真实行为）。

const IDLE_IMGS = [
  { file: 'idleface.png', rel: 'deskpet-assets/pet/idleface.png' },
  { file: 'idleup.png', rel: 'deskpet-assets/pet/idleup.png' },
  { file: 'idledown.png', rel: 'deskpet-assets/pet/idledown.png' },
  { file: 'idleleft.png', rel: 'deskpet-assets/pet/idleleft.png' },
  { file: 'idleright.png', rel: 'deskpet-assets/pet/idleright.png' },
  { file: 'idleleftup.png', rel: 'deskpet-assets/pet/idleleftup.png' },
  { file: 'idlerightup.png', rel: 'deskpet-assets/pet/idlerightup.png' },
  { file: 'idleleftdown.png', rel: 'deskpet-assets/pet/idleleftdown.png' },
  { file: 'idlerightdown.png', rel: 'deskpet-assets/pet/idlerightdown.png' },
];

describe('dirVectorOf', () => {
  it('英文名 8 方向 + 正脸', () => {
    expect(dirVectorOf('idleface.png')).toEqual({ x: 0, y: 0 });
    expect(dirVectorOf('idleup.png')).toEqual({ x: 0, y: -1 });
    expect(dirVectorOf('idledown.png')).toEqual({ x: 0, y: 1 });
    expect(dirVectorOf('idleleft.png')).toEqual({ x: -1, y: 0 });
    expect(dirVectorOf('idleright.png')).toEqual({ x: 1, y: 0 });
    expect(dirVectorOf('idleleftup.png')).toEqual({ x: -1, y: -1 });
    expect(dirVectorOf('idlerightup.png')).toEqual({ x: 1, y: -1 });
    expect(dirVectorOf('idleleftdown.png')).toEqual({ x: -1, y: 1 });
    expect(dirVectorOf('idlerightdown.png')).toEqual({ x: 1, y: 1 });
  });

  it('中文方向名', () => {
    expect(dirVectorOf('常态左.png')).toEqual({ x: -1, y: 0 });
    expect(dirVectorOf('常态上.png')).toEqual({ x: 0, y: -1 });
    expect(dirVectorOf('正脸.png')).toEqual({ x: 0, y: 0 });
    expect(dirVectorOf('前面.png')).toEqual({ x: 0, y: 0 });
  });

  it('无方向信息 → null', () => {
    expect(dirVectorOf('idle.png')).toBeNull();
    expect(dirVectorOf('walk.webm')).toBeNull();
    expect(dirVectorOf('work1.webm')).toBeNull();
  });
});

describe('pickAngleFrame', () => {
  it('正方向取同向帧（角度法根治点积并列）', () => {
    expect(pickAngleFrame(IDLE_IMGS, 100, 0)).toBe(4); // 右 → idleright
    expect(pickAngleFrame(IDLE_IMGS, 0, -100)).toBe(1); // 纯上 → idleup（不放任对角）
    expect(pickAngleFrame(IDLE_IMGS, -100, 0)).toBe(3); // 左 → idleleft
    expect(pickAngleFrame(IDLE_IMGS, 0, 100)).toBe(2); // 下 → idledown
  });

  it('对角方向取对角帧', () => {
    expect(pickAngleFrame(IDLE_IMGS, 100, -100)).toBe(6); // 右上 → idlerightup
    expect(pickAngleFrame(IDLE_IMGS, -100, -100)).toBe(5); // 左上 → idleleftup
    expect(pickAngleFrame(IDLE_IMGS, 100, 100)).toBe(8); // 右下 → idlerightdown
  });

  it('鼠标贴近中心（距 <18px）→ 正脸', () => {
    expect(pickAngleFrame(IDLE_IMGS, 5, 5)).toBe(0);
    expect(pickAngleFrame(IDLE_IMGS, 0, 0)).toBe(0);
  });
});

describe('getSunsetHours', () => {
  it('返回数值且在 0-24 小时之间', () => {
    const h = getSunsetHours(new Date('2024-06-21T12:00:00'));
    expect(typeof h).toBe('number');
    expect(h).toBeGreaterThan(0);
    expect(h).toBeLessThan(24);
  });

  it('同一日期结果确定', () => {
    const d1 = new Date(2026, 2, 15, 12, 0);
    expect(getSunsetHours(d1)).toBe(getSunsetHours(new Date(2026, 2, 15, 12, 0)));
  });

  it('夏至日落晚于冬至（赤纬使然）', () => {
    const summer = getSunsetHours(new Date('2026-06-21T12:00:00'));
    const winter = getSunsetHours(new Date('2026-12-21T12:00:00'));
    expect(summer).toBeGreaterThan(winter);
  });
});