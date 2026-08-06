import { describe, it, expect } from 'vitest';
import { fromPayload, toPayload, type ProfileUi } from './profileCodec';

// 现状固化测试：档案载荷解码/编码（期望值取原函数真实行为）。

const FULL: ProfileUi = {
  id: 'p1',
  name: 'DeepSeek',
  base_url: 'https://api.deepseek.com/v1',
  api_key: 'sk-xxx',
  model: 'deepseek-chat',
  vision_model: 'deepseek-v4-flash',
  temperature: 0.3,
  max_tokens: '2048',
  top_p: '0.7',
  system_prompt: '你是助手',
  thinking: true,
  persona_call_me_as: '小云',
  persona_preset: 'gentle',
  persona_style: '温柔',
};

describe('fromPayload', () => {
  it('完整字段透传', () => {
    const p = fromPayload({ ...FULL, max_tokens: 2048, top_p: 0.7 });
    expect(p).toEqual(FULL);
  });

  it('缺省默认：temperature 0.3 / max_tokens 与 top_p 空串 / thinking false', () => {
    const p = fromPayload({ id: 'p1', name: 'x' });
    expect(p.temperature).toBe(0.3);
    expect(p.max_tokens).toBe('');
    expect(p.top_p).toBe('');
    expect(p.thinking).toBe(false);
    expect(p.name).toBe('x');
    expect(p.base_url).toBe('');
  });

  it('thinking 布尔真值判定', () => {
    expect(fromPayload({ thinking: true }).thinking).toBe(true);
    expect(fromPayload({ thinking: 1 }).thinking).toBe(false);
    expect(fromPayload({ thinking: null }).thinking).toBe(false);
  });

  it('无 id 生成兜底 id（任意 p_ 前缀）', () => {
    const p = fromPayload({});
    expect(p.id).toMatch(/^p_/);
  });
});

describe('toPayload', () => {
  it('完整非空字段透传 trim 值', () => {
    const out = toPayload(FULL);
    expect(out.id).toBe('p1');
    expect(out.name).toBe('DeepSeek');
    expect(out.temperature).toBe(0.3);
    expect(out.vision_model).toBe('deepseek-v4-flash');
    expect(out.system_prompt).toBe('你是助手');
    expect(out.max_tokens).toBe(2048);
    expect(out.top_p).toBeCloseTo(0.7);
  });

  it('空白字段 → null', () => {
    const p = { ...FULL, vision_model: '  ', system_prompt: '', max_tokens: ' ', top_p: '\t', persona_call_me_as: '', thinking: false };
    const out = toPayload(p);
    expect(out.vision_model).toBeNull();
    expect(out.system_prompt).toBeNull();
    expect(out.max_tokens).toBeNull();
    expect(out.top_p).toBeNull();
    expect(out.persona_call_me_as).toBeNull();
    expect(out.thinking).toBeNull();
  });

  it('max_tokens 边界：非法 0/负数/NaN → 1', () => {
    expect(toPayload({ ...FULL, max_tokens: '0' }).max_tokens).toBe(1);
    expect(toPayload({ ...FULL, max_tokens: '-3' }).max_tokens).toBe(1);
    expect(toPayload({ ...FULL, max_tokens: 'abc' }).max_tokens).toBe(1);
    expect(toPayload({ ...FULL, max_tokens: '4096' }).max_tokens).toBe(4096);
  });

  it('top_p clamp 到 [0,1]', () => {
    expect(toPayload({ ...FULL, top_p: '-1' }).top_p).toBe(0);
    expect(toPayload({ ...FULL, top_p: '2' }).top_p).toBe(1);
    expect(toPayload({ ...FULL, top_p: 'abc' }).top_p).toBe(0);
  });

  it('thinking 仅真值 → true，否则 null', () => {
    expect(toPayload({ ...FULL, thinking: true }).thinking).toBe(true);
  });
});