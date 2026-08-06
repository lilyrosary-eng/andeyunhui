import { describe, it, expect } from 'vitest';
import { toPlayInfo, weatherLabel, fmtTime } from './helpers';

// 现状固化测试：期望值取当前函数真实输出。

describe('toPlayInfo', () => {
  it('合法字段透传', () => {
    const info = toPlayInfo({
      title: '歌名',
      artist: '歌手',
      album: '专辑',
      is_playing: true,
      media_type: 'music',
      cover_path: '/a/b.png',
      can_prev: true,
      can_next: false,
      source: 'smtc',
      key: 'k1',
    });
    expect(info).toEqual({
      title: '歌名',
      artist: '歌手',
      album: '专辑',
      is_playing: true,
      media_type: 'music',
      cover_path: '/a/b.png',
      can_prev: true,
      can_next: false,
      source: 'smtc',
      key: 'k1',
    });
  });

  it('null/undefined 输入返回空默认值', () => {
    expect(toPlayInfo(null)).toEqual({
      title: '',
      artist: '',
      album: '',
      is_playing: false,
      media_type: '',
      cover_path: null,
      can_prev: false,
      can_next: false,
      source: undefined,
      key: undefined,
    });
  });

  it('类型错误字段被丢弃/规范化', () => {
    const info = toPlayInfo({
      title: 123,
      cover_path: '',
      is_playing: 'yes',
      source: 99,
    });
    expect(info.title).toBe('');
    expect(info.cover_path).toBeNull();
    expect(info.is_playing).toBe(true); // !!'yes' 为 true，属当前行为
    expect(info.source).toBeUndefined();
  });
});

describe('weatherLabel', () => {
  it('null 返回 —', () => {
    expect(weatherLabel(null)).toBe('—');
  });
  it('0 晴', () => {
    expect(weatherLabel(0)).toBe('晴');
  });
  it('1-3 多云', () => {
    expect(weatherLabel(1)).toBe('多云');
    expect(weatherLabel(3)).toBe('多云');
  });
  it('4-48 雾', () => {
    expect(weatherLabel(4)).toBe('雾');
    expect(weatherLabel(48)).toBe('雾');
  });
  it('49-67 雨', () => {
    expect(weatherLabel(49)).toBe('雨');
    expect(weatherLabel(67)).toBe('雨');
  });
  it('68-77 雪', () => {
    expect(weatherLabel(68)).toBe('雪');
    expect(weatherLabel(77)).toBe('雪');
  });
  it('78-82 阵雨', () => {
    expect(weatherLabel(78)).toBe('阵雨');
    expect(weatherLabel(82)).toBe('阵雨');
  });
  it('83-86 阵雪', () => {
    expect(weatherLabel(83)).toBe('阵雪');
    expect(weatherLabel(86)).toBe('阵雪');
  });
  it('95+ 雷暴', () => {
    expect(weatherLabel(95)).toBe('雷暴');
    expect(weatherLabel(100)).toBe('雷暴');
  });
  it('87-94 落在默认 —', () => {
    expect(weatherLabel(87)).toBe('—');
    expect(weatherLabel(94)).toBe('—');
  });
});

describe('fmtTime', () => {
  it('补零格式化', () => {
    const d = new Date(2026, 7, 6, 9, 5);
    expect(fmtTime(d)).toBe('09:05');
    const d2 = new Date(2026, 7, 6, 23, 59);
    expect(fmtTime(d2)).toBe('23:59');
  });
});