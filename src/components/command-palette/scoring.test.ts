import { describe, expect, it } from 'vitest';
import { parseScope, scoreFields, scoreText } from '@/components/command-palette/scoring';
import type { PaletteProvider } from '@/core/commandPalette/registry';

const providers: PaletteProvider[] = [
  { id: 'music:music', label: '音乐', moduleId: 'music', search: () => [] },
  { id: 'host:transfer', label: '中转站', moduleId: 'transfer', search: () => [] },
];
const groups = [
  { key: 'modules', label: '模块' },
  { key: 'notes', label: '笔记' },
];

describe('命令面板打分', () => {
  it('完全匹配优于前缀，前缀优于词首，词首优于任意包含', () => {
    expect(scoreText('夜曲', '夜曲')).toBeGreaterThan(scoreText('夜曲 remix', '夜曲'));
    expect(scoreText('夜曲 remix', '夜曲')).toBeGreaterThan(scoreText('伴奏 夜曲', '夜曲'));
    expect(scoreText('伴奏 夜曲', '夜曲')).toBeGreaterThan(scoreText('某夜曲某', '夜曲'));
  });

  it('标题权重高于副标题', () => {
    expect(scoreFields('夜曲', '周杰伦', undefined, '夜曲')).toBeGreaterThan(
      scoreFields('某首歌', '夜曲', undefined, '夜曲'),
    );
  });
});

describe('作用域解析', () => {
  it('识别 provider 标签并剥离前缀', () => {
    expect(parseScope('音乐:夜曲', providers, groups)).toEqual({
      scope: { kind: 'provider', key: 'music:music', label: '音乐' },
      query: '夜曲',
    });
  });

  it('识别静态分组与全角冒号', () => {
    const r = parseScope('笔记：会议', providers, groups);
    expect(r.scope).toEqual({ kind: 'static', key: 'notes', label: '笔记' });
    expect(r.query).toBe('会议');
  });

  it('未知前缀不误伤普通查询（如 Windows 路径）', () => {
    expect(parseScope('C:\\tmp', providers, groups)).toEqual({ scope: null, query: 'C:\\tmp' });
  });
});
