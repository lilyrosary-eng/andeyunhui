/**
 * 技能包（skills.ts）单测——纯函数 + 内存 storage 注入的读写往返。
 * 覆盖：slug 稳定性/中文净化/空兜底、摘要跳标题与截断、存取往返、空白删除、互不影响。
 */
import { describe, it, expect } from 'vitest';
import { createStorage, type Storage, type StorageBackend } from '@/core/storage';
import { skillSlug, skillSummary, loadSkillNotes, saveSkillNotes } from './skills';

function memoryStorage(): { s: Storage; peek: () => Record<string, string> } {
  const map = new Map<string, string>();
  const backend: StorageBackend = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
  return { s: createStorage(backend), peek: () => JSON.parse(map.get('andeyunhui.comfyui.skills') ?? '{}') };
}

describe('skillSlug', () => {
  it('路径净化为稳定 slug', () => {
    expect(skillSlug('Krea-Afterlight.json')).toBe('krea-afterlight-json')
    expect(skillSlug('子目录/我的 工作流.json')).toBe('json')
  })

  it('空串兜底为 workflow', () => {
    expect(skillSlug('')).toBe('workflow')
    expect(skillSlug('///')).toBe('workflow')
  })
})

describe('skillSummary', () => {
  it('跳过空行与 # 标题，取首个有效行', () => {
    expect(skillSummary('\n# 标题\n适用人像特写\n注意别开高清修复')).toBe('适用人像特写')
  })

  it('超长截断加省略号', () => {
    const long = '这'.repeat(80)
    const out = skillSummary(long)
    expect(out.length).toBe(61)
    expect(out.endsWith('…')).toBe(true)
  })

  it('无有效内容返回空串', () => {
    expect(skillSummary('')).toBe('')
    expect(skillSummary('# 只有标题\n\n')).toBe('')
  })
})

describe('load/saveSkillNotes', () => {
  it('存取往返', () => {
    const { s, peek } = memoryStorage();
    saveSkillNotes('krea', '适用人像\nCFG 别超 8', s);
    expect(loadSkillNotes('krea', s)).toBe('适用人像\nCFG 别超 8');
    expect(peek()).toEqual({ krea: '适用人像\nCFG 别超 8' });
  })

  it('空白内容等价删除', () => {
    const { s } = memoryStorage();
    saveSkillNotes('a', 'x', s);
    saveSkillNotes('a', '   ', s);
    expect(loadSkillNotes('a', s)).toBe('');
  })

  it('不同 slug 互不影响', () => {
    const { s } = memoryStorage();
    saveSkillNotes('a', 'A', s);
    saveSkillNotes('b', 'B', s);
    expect(loadSkillNotes('a', s)).toBe('A');
    expect(loadSkillNotes('b', s)).toBe('B');
  })

  it('未写入的 slug 读为空串', () => {
    const { s } = memoryStorage();
    expect(loadSkillNotes('nope', s)).toBe('');
  })
})
