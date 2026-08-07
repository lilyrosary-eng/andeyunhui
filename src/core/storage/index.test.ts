import { describe, it, expect } from 'vitest';
import { createStorage, type StorageBackend } from './index';

function memoryBackend() {
  const map = new Map<string, string>();
  return {
    backend: { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); } } as const,
    map,
  };
}

describe('createStorage', () => {
  it('getString 读后端，无值回退 fallback', () => {
    const { backend } = memoryBackend();
    const s = createStorage(backend);
    expect(s.getString('a', 'd')).toBe('d');
    backend.setItem('a', 'x');
    expect(s.getString('a', 'd')).toBe('x');
  });

  it('setString 写入原样序列化（不 JSON 化）', () => {
    const { backend, map } = memoryBackend();
    const s = createStorage(backend);
    s.setString('a', 'true');
    expect(map.get('a')).toBe('true');
    s.setString('a', '1');
    expect(map.get('a')).toBe('1');
  });

  it('getJSON 解析 / 非法 JSON 回退', () => {
    const { backend } = memoryBackend();
    const s = createStorage(backend);
    backend.setItem('j', '{"b":2}');
    expect(s.getJSON('j', { b: 0 })).toEqual({ b: 2 });
    backend.setItem('j', '{bad');
    expect(s.getJSON('j', { b: 0 })).toEqual({ b: 0 });
  });

  it('setJSON/remove', () => {
    const { map, backend } = memoryBackend();
    const s = createStorage(backend);
    s.setJSON('j', { a: 1 });
    expect(JSON.parse(map.get('j')!)).toEqual({ a: 1 });
    s.remove('j');
    expect(map.has('j')).toBe(false);
  });

  it('后端读抛异常回退 fallback / 写异常静默', () => {
    const boom: StorageBackend = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
    const s = createStorage(boom);
    expect(s.getString('a', 'd')).toBe('d');
    expect(() => s.setString('a', 'v')).not.toThrow();
    expect(s.getJSON('j', 1)).toBe(1);
  });
});