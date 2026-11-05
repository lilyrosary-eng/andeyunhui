import { describe, expect, it } from 'vitest';
import { baseName, formatMillis } from './tagHistoryView';

describe('写回记录的时间展示', () => {
  it('毫秒时间戳换成到分钟的本地时间', () => {
    // 2026-11-05T05:40:00Z —— 到分钟，不显示秒（面板一行放不下，秒也没意义）
    expect(formatMillis(Date.UTC(2026, 10, 5, 5, 40, 0))).toMatch(/^2026-11-05 \d{2}:\d{2}$/);
  });

  it('坏值一律走「未知时间」，不许把 NaN 打到界面上', () => {
    expect(formatMillis(0)).toBe('未知时间');
    expect(formatMillis(-1)).toBe('未知时间');
    expect(formatMillis(undefined)).toBe('未知时间');
    expect(formatMillis(null)).toBe('未知时间');
    expect(formatMillis(Number.NaN)).toBe('未知时间');
    expect(formatMillis('1700000000000' as unknown as number)).toBe('未知时间');
  });
});

describe('样本路径 → 文件名', () => {
  it('两种斜杠都能取到末段', () => {
    expect(baseName('D:\\音乐\\周杰伦\\晴天.flac')).toBe('晴天.flac');
    expect(baseName('/app/music/a.flac')).toBe('a.flac');
  });

  it('空值与异常输入不抛，取不到末段就退回原样', () => {
    expect(baseName('')).toBe('');
    expect(baseName(undefined as unknown as string)).toBe('');
    // 'a\' 这种以分隔符结尾的路径，末段是空串 —— 显示原串比显示空白有用
    expect(baseName('a\\')).toBe('a\\');
  });
});
