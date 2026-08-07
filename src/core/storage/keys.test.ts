import { describe, it, expect } from 'vitest';
import { KEYS, MODULE_TOGGLE_PREFIX, moduleToggleKey } from './keys';

function flattenKeys() {
  const out: { name: string; key: string; kind: string; scope: string }[] = [];
  for (const group of Object.values(KEYS)) {
    for (const [name, def] of Object.entries(group)) {
      if (def && typeof def === 'object' && 'key' in def) out.push({ name, key: def.key, kind: def.kind, scope: def.scope });
    }
  }
  return out;
}

describe('KEYS', () => {
  it('stored key 全局不重复', () => {
    const all = flattenKeys();
    const raw = all.map((x) => x.key);
    expect(new Set(raw).size).toBe(raw.length);
  });

  it('每个 key 带合法 kind 与 scope', () => {
    for (const x of flattenKeys()) {
      expect(['flag', 'string', 'json']).toContain(x.kind);
      expect(['desktop', 'mobile', 'shared', 'dev']).toContain(x.scope);
    }
  });

  it('具体 flag 键语义与存量值一致', () => {
    expect(KEYS.app.dataRootGuided.kind).toBe('flag');
    expect(KEYS.app.dataRootGuided.key).toBe('dataRootGuided');
    expect(KEYS.niaoluo.ragVisible.kind).toBe('flag');
    expect(KEYS.theme.reverseColor.kind).toBe('flag');
  });

  it('动态模块开关 key 模板正确', () => {
    expect(moduleToggleKey('notes')).toBe('module_sidebar_collapsed_notes');
    expect(MODULE_TOGGLE_PREFIX).toBe('module_sidebar_collapsed');
  });
});