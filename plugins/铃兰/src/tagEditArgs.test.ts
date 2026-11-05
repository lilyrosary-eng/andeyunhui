import { describe, expect, it } from 'vitest';
import { buildEditArgs, NUMERIC_TAG_FIELDS } from './tagEditArgs';

describe('buildEditArgs：草稿到后端参数', () => {
  it('未改动的键不下发（后端语义是 None=不动）', () => {
    const a = buildEditArgs('/m/a.flac', { title: '新标题', artist: undefined });
    expect(a).toEqual({ filePath: '/m/a.flac', title: '新标题' });
    expect('artist' in a).toBe(false);
  });

  it('文本项空串照发 —— 后端据此清除该字段', () => {
    const a = buildEditArgs('/m/a.flac', { genre: '', comment: '' });
    expect(a.genre).toBe('');
    expect(a.comment).toBe('');
  });

  it('数字项空串/非法值不下发（后端没有"清空数字帧"的语义）', () => {
    const a = buildEditArgs('/m/a.flac', { discNumber: '', trackTotal: '  ', discTotal: 'x' });
    for (const k of NUMERIC_TAG_FIELDS) expect(k in a).toBe(false);
  });

  it('数字项转成数字，小数被截断', () => {
    const a = buildEditArgs('/m/a.flac', { trackNumber: '3', discNumber: '2.9' });
    expect(a.trackNumber).toBe(3);
    expect(a.discNumber).toBe(2);
  });

  it('参数名保持 camelCase（Tauri 只认 camelCase）', () => {
    const a = buildEditArgs('/m/a.flac', { albumArtist: '周杰伦', discNumber: '1' });
    expect(Object.keys(a)).toEqual(['filePath', 'albumArtist', 'discNumber']);
  });

  it('全部 13 个草稿字段都在数字白名单或文本分支里，不会漏', () => {
    const draft = {
      title: 't', artist: 'a', album: 'b', albumArtist: 'c', trackNumber: '1', trackTotal: '9',
      discNumber: '1', discTotal: '2', year: '2003', genre: 'g', composer: 'co', lyricist: 'ly', comment: 'cm',
    };
    const a = buildEditArgs('/m/a.flac', draft);
    for (const k of Object.keys(draft)) expect(k in a).toBe(true);
    expect(Object.keys(a).length).toBe(14); // 13 字段 + filePath
  });
});
