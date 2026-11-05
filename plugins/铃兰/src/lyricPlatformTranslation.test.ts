import { describe, expect, it, vi } from 'vitest';
import {
  buildTranslatedLrc,
  fetchExistingTranslation,
  joinKugouLyrics,
  passesRatio,
  parseTimedLrc,
  stampOf,
} from './lyricPlatformTranslation';

describe('时间戳与覆盖率', () => {
  it('stampOf 输出 [mm:ss.xx]', () => {
    expect(stampOf(0)).toBe('[00:00.00]');
    expect(stampOf(72500)).toBe('[01:12.50]');
    expect(stampOf(-5)).toBe('[00:00.00]');
  });

  it('parseTimedLrc 忽略元信息头，支持一行多个时间戳', () => {
    const got = parseTimedLrc('[ti:晴天]\n[00:12.34]A\n[00:20.00][01:20.00]B');
    expect(got).toHaveLength(3);
    expect(got[0]).toEqual({ time_ms: 12340, text: 'A' });
    expect(got[1]).toEqual({ time_ms: 20000, text: 'B' });
    expect(got[2].time_ms).toBe(80000);
  });

  it('覆盖率低于 0.6 判为不合格；空集合也判不合格', () => {
    expect(passesRatio(30, 45)).toBe(true);
    expect(passesRatio(26, 45)).toBe(false);
    expect(passesRatio(0, 0)).toBe(false);
  });
});

describe('拼译文 LRC', () => {
  it('只输出有译文的行，并沿用原时间戳', () => {
    const got = buildTranslatedLrc([
      { time_ms: 1000, text: '原文一', translation: 'one' },
      { time_ms: 2000, text: '原文二', translation: '  ' },
      { time_ms: 3000, text: '原文三', translation: 'three' },
    ]);
    expect(got.text).toBe('[00:01.00]one' + String.fromCharCode(10) + '[00:03.00]three');
    expect(got).toMatchObject({ hit: 2, total: 3 });
  });

  it('酷狗双轨按时间戳挂回；时间戳对不上就不算命中', () => {
    const ok = joinKugouLyrics('[00:01.00]A\n[00:02.00]B', '[00:01.00]x\n[00:02.00]y');
    expect(ok.hit).toBe(2);
    const drift = joinKugouLyrics('[00:01.00]A\n[00:02.00]B', '[00:09.00]x');
    expect(drift.hit).toBe(0);
    expect(drift.total).toBe(2);
  });
});

const okNetease = (hit: number, total: number) =>
  Array.from({ length: total }, (_, i) => ({
    time_ms: i * 1000,
    text: `行${i}`,
    translation: i < hit ? `line${i}` : '',
  }));

function deps(over: Partial<Parameters<typeof fetchExistingTranslation>[0]> = {}) {
  return {
    kw: '晴天 周杰伦',
    neteaseSearch: vi.fn(async () => ({ tracks: [{ id: 1 }] })),
    neteaseLyric: vi.fn(async () => okNetease(45, 45)),
    kugouSearch: vi.fn(async () => [{ hash: 'h1' }]),
    kugouLyric: vi.fn(async () => ({ lyric: '[00:01.00]A', trans: '[00:01.00]x' })),
    ...over,
  };
}

describe('取现成译文的取数顺序', () => {
  it('网易云有达标译文就用它，不再去问酷狗', async () => {
    const d = deps();
    const got = await fetchExistingTranslation(d);
    expect(got).toMatchObject({ source: 'netease', sourceLabel: '网易云', hit: 45, total: 45 });
    expect(d.kugouSearch).not.toHaveBeenCalled();
  });

  it('第一条候选覆盖率不足时换下一条试', async () => {
    const d = deps({
      neteaseSearch: vi.fn(async () => ({ tracks: [{ id: 1 }, { id: 2 }] })),
      neteaseLyric: vi.fn(async (id: number) => (id === 1 ? okNetease(3, 45) : okNetease(40, 45))),
    });
    const got = await fetchExistingTranslation(d);
    expect(got).toMatchObject({ source: 'netease', hit: 40 });
    expect(d.neteaseLyric).toHaveBeenCalledTimes(2);
  });

  it('网易云全都不达标才去酷狗', async () => {
    const d = deps({ neteaseLyric: vi.fn(async () => okNetease(2, 45)) });
    const got = await fetchExistingTranslation(d);
    expect(got).toMatchObject({ source: 'kugou', sourceLabel: '酷狗' });
  });

  it('两边都不达标返回 null，由调用方明说「没有现成译文」', async () => {
    const d = deps({
      neteaseLyric: vi.fn(async () => okNetease(2, 45)),
      kugouLyric: vi.fn(async () => ({ lyric: '[00:01.00]A\n[00:02.00]B', trans: '[00:01.00]x' })),
    });
    expect(await fetchExistingTranslation(d)).toBeNull();
  });

  it('一个平台抛错不挡住另一个', async () => {
    const d = deps({ neteaseSearch: vi.fn(async () => { throw new Error('网络挂了'); }) });
    const got = await fetchExistingTranslation(d);
    expect(got?.source).toBe('kugou');
  });

  it('酷狗没返回 trans 时不发翻译请求也不报错', async () => {
    const d = deps({
      neteaseLyric: vi.fn(async () => okNetease(0, 10)),
      kugouLyric: vi.fn(async () => ({ lyric: '[00:01.00]A' })),
    });
    expect(await fetchExistingTranslation(d)).toBeNull();
  });
});
