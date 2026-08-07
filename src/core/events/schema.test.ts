import { describe, it, expect } from 'vitest';
import { EVENTS, EVENT_PAYLOAD_KEYS } from './schema';

const allNames = () => {
  const out: string[] = [];
  for (const group of Object.values(EVENTS)) {
    for (const v of Object.values(group)) if (typeof v === 'string') out.push(v);
  }
  return out;
};

describe('EVENTS', () => {
  it('事件名不重复', () => {
    const n = allNames();
    expect(new Set(n).size).toBe(n.length);
  });

  it('关键事件存在（AI 四件套 + 转移）', () => {
    expect(EVENTS.ai.delta).toBe('ai-delta');
    expect(EVENTS.ai.done).toBe('ai-done');
    expect(EVENTS.ai.error).toBe('ai-error');
    expect(EVENTS.transfer.peerFound).toBe('transfer-peer-found');
  });

  it('核心事件载荷已登记（以实际 listen<T> 通配类型为据）', () => {
    expect(EVENT_PAYLOAD_KEYS['ai-delta']).toBeDefined();
    expect(EVENT_PAYLOAD_KEYS['transfer-progress']).toBeDefined();
  });
});
