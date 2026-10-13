/**
 * 技能包（skills.ts）单测——纯函数 + 内存 storage 注入的读写往返。
 * 覆盖：slug 稳定性/中文净化/空兜底、摘要跳标题与截断、存取往返、空白删除、互不影响。
 */
import { describe, it, expect } from 'vitest';
import { createStorage, type Storage, type StorageBackend } from '@/core/storage';
import { skillSlug, skillSummary, loadSkillNotes, saveSkillNotes, appendFailNote, recordFailNote, parseSkillFail, recordGenerateFail } from './skills';

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

describe('appendFailNote / recordFailNote（AI 写回备注）', () => {
  const at = new Date(2026, 9, 13, 20, 45); // 2026-10-13 20:45

  it('空备注 → 建「运行失败」小节并记一条', () => {
    const out = appendFailNote('', 'ComfyUI 执行失败: model not found', at)
    expect(out).toBe('## 运行失败\n- 2026-10-13 20:45 ComfyUI 执行失败: model not found')
  })

  it('已有用户手写内容 → 追加小节，不破坏原文', () => {
    const out = appendFailNote('适用人像特写\nCFG 别超 8', 'CUDA out of memory', at)
    expect(out).toContain('适用人像特写\nCFG 别超 8')
    expect(out).toContain('## 运行失败')
    expect(out).toContain('- 2026-10-13 20:45 CUDA out of memory')
  })

  it('已有小节 → 直接续行，不重复小节标题', () => {
    const first = appendFailNote('适用人像', '原因A', at)
    const second = appendFailNote(first, '原因B', at)
    expect(second.match(/## 运行失败/g)?.length).toBe(1)
    expect(second).toContain('原因A')
    expect(second).toContain('原因B')
  })

  it('同因去重：重复原因不再追加（防失败刷屏淹没手写经验）', () => {
    const first = appendFailNote('', 'ComfyUI 执行失败: x', at)
    const second = appendFailNote(first, 'ComfyUI 执行失败: x', at)
    expect(second).toBe(first)
  })

  it('空白原因原样返回（不写空条目）', () => {
    expect(appendFailNote('原备注', '   ', at)).toBe('原备注')
  })

  it('recordFailNote 落盘往返：读-追-写', () => {
    const { s } = memoryStorage()
    saveSkillNotes('krea', '适用人像', s)
    recordFailNote('krea', 'ComfyUI 不可达', s)
    const got = loadSkillNotes('krea', s)
    expect(got).toContain('适用人像')
    expect(got).toContain('ComfyUI 不可达')
  })

  it('recordFailNote 同因不重复写（幂等）', () => {
    const { s } = memoryStorage()
    recordFailNote('krea', '同因', s)
    const once = loadSkillNotes('krea', s)
    recordFailNote('krea', '同因', s)
    expect(loadSkillNotes('krea', s)).toBe(once)
  })
})

describe('parseSkillFail / recordGenerateFail（后端失败原因回写）', () => {
  it('解析 slug 前缀与原因', () => {
    expect(parseSkillFail('[comfyui-skill:krea-json] ComfyUI 执行失败: model not found'))
      .toEqual({ slug: 'krea-json', reason: 'ComfyUI 执行失败: model not found' })
  })

  it('无前缀（云端生图失败）返回 null', () => {
    expect(parseSkillFail('未配置 API Key')).toBeNull()
  })

  it('格式残缺返回 null（缺 ] / 空 slug / 空原因）', () => {
    expect(parseSkillFail('[comfyui-skill:abc 无右括号')).toBeNull()
    expect(parseSkillFail('[comfyui-skill:   ] 原因')).toBeNull()
    expect(parseSkillFail('[comfyui-skill:abc]   ')).toBeNull()
  })

  it('原因超长截断到 160 字', () => {
    const long = 'x'.repeat(400)
    const r = parseSkillFail(`[comfyui-skill:s] ${long}`)
    expect(r?.reason.length).toBe(160)
  })

  it('recordGenerateFail 按前缀写回对应工作流备注', () => {
    const { s } = memoryStorage()
    recordGenerateFail('[comfyui-skill:krea-json] 提示词位缺失', s)
    expect(loadSkillNotes('krea-json', s)).toContain('提示词位缺失')
    // 无前缀不写任何备注
    recordGenerateFail('未配置 API Key', s)
    expect(loadSkillNotes('', s)).toBe('')
  })
})
