import { describe, it, expect } from 'vitest';
import {
  inferDeskpetAsset,
  isLegacyDeskpetManifest,
  normalizeManifestSources,
  DESKPET_DEFAULT_MANIFEST,
  type DeskpetManifest,
} from './deskpetManifest';

// 现状固化测试：迁移判定 / 素材推断 / 来源归一（期望值取当前函数真实行为）。

function idleManifest(assets: { file: string; rel?: string }[]): DeskpetManifest {
  return {
    states: [
      { id: 'idle', label: '待机', assets: assets.map((a) => ({ ...a, rel: a.rel ?? `deskpet-assets/pet/${a.file}`, kind: 'image' as const, mime: 'image/png' })) },
      { id: 'work', label: '工作', assets: [{ file: 'work1.webm', rel: 'deskpet-assets/pet/work1.webm', kind: 'video', mime: 'video/webm' }] },
    ],
  };
}

const CANONICAL_IDLE = DESKPET_DEFAULT_MANIFEST.states.find((s) => s.id === 'idle')!.assets.map((a) => a.file);

describe('inferDeskpetAsset', () => {
  it('图片扩展名 → image + mime', () => {
    expect(inferDeskpetAsset('a.png')).toEqual({ kind: 'image', mime: 'image/png' });
    expect(inferDeskpetAsset('a.jpg')).toEqual({ kind: 'image', mime: 'image/jpeg' });
    expect(inferDeskpetAsset('a.webp')).toEqual({ kind: 'image', mime: 'image/webp' });
    expect(inferDeskpetAsset('a.gif')).toEqual({ kind: 'image', mime: 'image/gif' });
    expect(inferDeskpetAsset('a.avif')).toEqual({ kind: 'image', mime: 'image/avif' });
  });

  it('视频扩展名 → video + mime', () => {
    expect(inferDeskpetAsset('a.mp4')).toEqual({ kind: 'video', mime: 'video/mp4' });
    expect(inferDeskpetAsset('a.webm')).toEqual({ kind: 'video', mime: 'video/webm' });
    expect(inferDeskpetAsset('a.mov')).toEqual({ kind: 'video', mime: 'video/quicktime' });
  });

  it('大写扩展名小写化', () => {
    expect(inferDeskpetAsset('A.PNG')).toEqual({ kind: 'image', mime: 'image/png' });
  });

  it('多段扩展名取最后一段', () => {
    expect(inferDeskpetAsset('cat.photo.png')).toEqual({ kind: 'image', mime: 'image/png' });
  });

  it('未知扩展名 / 无扩展名 → image/png 兜底', () => {
    expect(inferDeskpetAsset('a.xyz')).toEqual({ kind: 'image', mime: 'image/png' });
    expect(inferDeskpetAsset('noext')).toEqual({ kind: 'image', mime: 'image/png' });
    expect(inferDeskpetAsset('')).toEqual({ kind: 'image', mime: 'image/png' });
  });
});

describe('normalizeManifestSources', () => {
  it('官方 rel 补齐 official', () => {
    const m = idleManifest([{ file: 'idleface.png' }]);
    expect(normalizeManifestSources(m).states[0].assets[0].source).toBe('official');
  });

  it('非官方 rel 补齐 user', () => {
    const m = idleManifest([{ file: 'mycat.png' }]);
    expect(normalizeManifestSources(m).states[0].assets[0].source).toBe('user');
  });

  it('已有 source 保留不动', () => {
    const m = idleManifest([{ file: 'idleface.png' }]);
    m.states[0].assets[0].source = 'user';
    expect(normalizeManifestSources(m).states[0].assets[0].source).toBe('user');
  });

  it('不修改入参（纯函数）', () => {
    const m = idleManifest([{ file: 'mycat.png' }]);
    normalizeManifestSources(m);
    expect(m.states[0].assets[0].source).toBeUndefined();
  });
});

describe('isLegacyDeskpetManifest', () => {
  it('null / undefined / 非数组 states → false', () => {
    expect(isLegacyDeskpetManifest(null)).toBe(false);
    expect(isLegacyDeskpetManifest(undefined)).toBe(false);
    expect(isLegacyDeskpetManifest({} as DeskpetManifest)).toBe(false);
  });

  it('当前缺省清单 → false', () => {
    expect(isLegacyDeskpetManifest(DESKPET_DEFAULT_MANIFEST)).toBe(false);
  });

  it('完整规范 idle + work → false', () => {
    expect(isLegacyDeskpetManifest(idleManifest(CANONICAL_IDLE.map((f) => ({ file: f }))))).toBe(false);
  });

  it('旧文件名 idle1.png → true', () => {
    expect(isLegacyDeskpetManifest(idleManifest([{ file: 'idle1.png' }]))).toBe(true);
  });

  it('中文旧版 常态 → true', () => {
    expect(isLegacyDeskpetManifest(idleManifest([{ file: '常态.png' }]))).toBe(true);
  });

  it('已删除内置 mp4 → true', () => {
    const m = idleManifest(CANONICAL_IDLE.map((f) => ({ file: f })));
    m.states[1].assets = [{ file: 'work1.mp4', rel: 'deskpet-assets/pet/work1.mp4', kind: 'video', mime: 'video/mp4' }];
    expect(isLegacyDeskpetManifest(m)).toBe(true);
  });

  it('idle 缺帧（缺 idleup）→ true', () => {
    const frames = CANONICAL_IDLE.filter((f) => f !== 'idleup.png');
    expect(isLegacyDeskpetManifest(idleManifest(frames.map((f) => ({ file: f }))))).toBe(true);
  });

  it('idle 空 → true', () => {
    expect(isLegacyDeskpetManifest(idleManifest([]))).toBe(true);
  });

  it('idle 文件名与当前缺省不符 → true', () => {
    expect(isLegacyDeskpetManifest(idleManifest([{ file: 'idleold.png' }]))).toBe(true);
  });

  it('user_external_deps 仅在 basename 命中时豁免（路径段不算）', () => {
    const m = idleManifest(CANONICAL_IDLE.map((f) => ({ file: f })));
    m.states[0].assets = [
      { file: 'cat.png', rel: 'deskpet-assets/pet/user_external_deps/cat.png', kind: 'image', mime: 'image/png' },
      { file: 'user_external_deps_1.png', rel: 'deskpet-assets/pet/user_external_deps_1.png', kind: 'image', mime: 'image/png' },
    ];
    expect(isLegacyDeskpetManifest(m)).toBe(false);
  });

  it('无 work 状态跳过 idle 帧检查', () => {
    const m: DeskpetManifest = { states: [{ id: 'idle', label: '待机', assets: [] }] };
    expect(isLegacyDeskpetManifest(m)).toBe(false);
  });
});
