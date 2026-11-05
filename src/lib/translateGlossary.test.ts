import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_GLOSSARY_MAX,
  clearAutoGlossary,
  deleteAutoGlossary,
  isGlossaryOff,
  learnGlossaryPairs,
  listAutoGlossary,
  mergeGlossary,
} from './translateGlossary';
import { saveTranslateSettings, translateSettingsFor } from './translateLanguages';

/** 不依赖 jsdom：给一个最小 localStorage 桩。 */
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  });
});

describe('整句词条的记入', () => {
  it('同一句原文再来一次是覆盖译法，不是多出一条', () => {
    expect(learnGlossaryPairs([{ src: '晴天', dst: 'Sunny Day' }])).toBe(1);
    expect(learnGlossaryPairs([{ src: '晴天', dst: 'A Sunny Day' }])).toBe(0);
    const all = listAutoGlossary();
    expect(all.length).toBe(1);
    expect(all[0].dst).toBe('A Sunny Day');
  });

  it('超上限丢最老的，留下的都是最近写入的', () => {
    const batch = Array.from({ length: AUTO_GLOSSARY_MAX + 20 }, (_, i) => ({
      src: `line-${i}`,
      dst: `L-${i}`,
    }));
    learnGlossaryPairs(batch);
    const all = listAutoGlossary();
    expect(all.length).toBe(AUTO_GLOSSARY_MAX);
    // 最老的 20 句被挤掉
    expect(all.some((p) => p.src === 'line-0')).toBe(false);
    expect(all[all.length - 1].src).toBe(`line-${AUTO_GLOSSARY_MAX + 19}`);
  });

  it('带等号的句子跳过：下发格式是「原句=译句」，多一个等号整行就读歪了', () => {
    const added = learnGlossaryPairs([
      { src: 'a=b', dst: 'ok' },
      { src: 'ok', dst: 'c=d' },
      { src: '正常句', dst: 'normal' },
    ]);
    expect(added).toBe(1);
    expect(listAutoGlossary().map((p) => p.src)).toEqual(['正常句']);
  });

  it('空句/空白句不记，学习失败也不会抛', () => {
    expect(learnGlossaryPairs([{ src: '', dst: 'x' }, { src: '  ', dst: 'y' }, { src: 'z', dst: ' ' }])).toBe(0);
    expect(listAutoGlossary()).toEqual([]);
  });

  it('键里是坏 JSON 就当没有，既不抛也不吃掉已有词条', () => {
    localStorage.setItem('ts_translate_glossary_auto', '{不是 JSON');
    expect(listAutoGlossary()).toEqual([]);
    expect(learnGlossaryPairs([{ src: 'x', dst: 'y' }])).toBe(1);
    expect(listAutoGlossary().length).toBe(1);
  });

  it('删一条与清空都只动学到的，不碰手写词条', () => {
    saveTranslateSettings({ glossary: '手写的=手工译法' });
    learnGlossaryPairs([{ src: 's1', dst: 'd1' }, { src: 's2', dst: 'd2' }]);
    expect(deleteAutoGlossary('s1')).toBe(true);
    expect(deleteAutoGlossary('s1')).toBe(false);
    expect(listAutoGlossary().map((p) => p.src)).toEqual(['s2']);
    expect(translateSettingsFor().glossary).toContain('手写的=手工译法');
    clearAutoGlossary();
    expect(listAutoGlossary()).toEqual([]);
    expect(loadManualUnchanged()).toBe('手写的=手工译法');
  });
});

function loadManualUnchanged(): string | undefined {
  return JSON.parse(localStorage.getItem('ts_translate_settings') ?? '{}').glossary;
}

describe('下发时两边拼在一起', () => {
  it('开着表 = 手写的在前、学到的在后', () => {
    learnGlossaryPairs([{ src: '整句A', dst: 'Line A' }]);
    const merged = mergeGlossary('词B=译B');
    expect(merged).toBe('词B=译B\n整句A=Line A');
  });

  it('只有一边时不留空行，两边都空等于不带术语表', () => {
    expect(mergeGlossary(undefined)).toBeUndefined();
    expect(mergeGlossary('   ')).toBeUndefined();
    learnGlossaryPairs([{ src: 'x', dst: 'y' }]);
    expect(mergeGlossary('')).toBe('x=y');
  });

  it('translateSettingsFor：开着会把学到的并进去；关掉则整段不发，但学到的还在', () => {
    saveTranslateSettings({ glossary: '手写的=手工译法', glossaryOn: true });
    learnGlossaryPairs([{ src: '整句A', dst: 'Line A' }]);
    const on = translateSettingsFor();
    expect(on.glossary).toBe('手写的=手工译法\n整句A=Line A');

    saveTranslateSettings({ glossary: '手写的=手工译法', glossaryOn: false });
    const off = translateSettingsFor();
    expect(off.glossary).toBeUndefined();
    // 关掉只是「本次不注入」，存的表和学到的都不能被顺手清掉
    expect(listAutoGlossary().length).toBe(1);
    expect(loadManualUnchanged()).toBe('手写的=手工译法');
    // 而且发出去的 settings 里不该有前端开关字段（后端契约没有它）
    expect(off).not.toHaveProperty('glossaryOn');
  });

  it('没设过开关算「开着」，只有明确 false 才算关', () => {
    expect(isGlossaryOff({})).toBe(false);
    expect(isGlossaryOff({ glossaryOn: true })).toBe(false);
    expect(isGlossaryOff({ glossaryOn: false })).toBe(true);
    expect(isGlossaryOff({ glossaryOn: 'false' })).toBe(false);
  });
});
