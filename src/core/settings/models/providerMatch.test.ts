import { describe, expect, it } from 'vitest';
import { inferProviderName, mergeModels, normalizeBaseUrl, sameBaseUrl } from './providerMatch';

describe('normalizeBaseUrl', () => {
  it('去空白与尾部斜杠', () => {
    expect(normalizeBaseUrl('  https://api.deepseek.com/v1/  ')).toBe('https://api.deepseek.com/v1');
    expect(normalizeBaseUrl('https://x.com///')).toBe('https://x.com');
  });

  it('大小写归一', () => {
    expect(normalizeBaseUrl('HTTPS://API.DeepSeek.COM/v1')).toBe('https://api.deepseek.com/v1');
  });

  it('不剥离 /v1——不同路径可能是不同端点', () => {
    expect(normalizeBaseUrl('https://x.com/v1')).toBe('https://x.com/v1');
    expect(normalizeBaseUrl('https://x.com')).toBe('https://x.com');
  });
});

describe('sameBaseUrl', () => {
  it('归一化后全等即同一供应商', () => {
    expect(sameBaseUrl('https://api.deepseek.com/v1/', ' https://API.deepseek.com/v1 ')).toBe(true);
  });

  it('尾部斜杠差异不影响判定', () => {
    expect(sameBaseUrl('http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434/v1/')).toBe(true);
  });

  it('不同路径不判为同一供应商', () => {
    expect(sameBaseUrl('https://x.com/v1', 'https://x.com')).toBe(false);
  });

  it('空串永不相等（避免「都没填」被当成同一个）', () => {
    expect(sameBaseUrl('', '')).toBe(false);
    expect(sameBaseUrl('   ', '')).toBe(false);
  });
});

describe('inferProviderName', () => {
  it('已知厂商按域名识别', () => {
    expect(inferProviderName('https://api.deepseek.com/v1')).toBe('DeepSeek');
    expect(inferProviderName('https://api.openai.com/v1')).toBe('OpenAI');
    expect(inferProviderName('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe('通义千问');
    expect(inferProviderName('https://open.bigmodel.cn/api/paas/v4')).toBe('智谱 GLM');
    expect(inferProviderName('https://api.anthropic.com/v1')).toBe('Anthropic');
  });

  it('本地端点识别为「本地」', () => {
    expect(inferProviderName('http://localhost:11434/v1')).toBe('本地');
    expect(inferProviderName('http://127.0.0.1:8188')).toBe('本地');
  });

  it('无 scheme 也能解析', () => {
    expect(inferProviderName('api.deepseek.com/v1')).toBe('DeepSeek');
  });

  it('未知域名取首个有信息量的标签并首字母大写', () => {
    expect(inferProviderName('https://api.my-gateway.com/v1')).toBe('My-gateway');
    expect(inferProviderName('https://foo.com/v1')).toBe('Foo');
  });

  it('解析不出返回空串，不编造名字', () => {
    expect(inferProviderName('')).toBe('');
    expect(inferProviderName('   ')).toBe('');
    expect(inferProviderName('not a url')).toBe('');
  });
});

describe('mergeModels —— 增量合并「仅增不减」', () => {
  const m = (model: string, tag?: string) => ({ id: model, model, tag });

  it('只加不减：已有模型一个都不能少', () => {
    const cur = [m('a'), m('b')];
    const { models } = mergeModels(cur, [m('c')]);
    expect(models.map((x) => x.model)).toEqual(['a', 'b', 'c']);
  });

  it('已存在的模型名不重复加入', () => {
    const { models, added } = mergeModels([m('a')], [m('a'), m('b')]);
    expect(models.map((x) => x.model)).toEqual(['a', 'b']);
    expect(added.map((x) => x.model)).toEqual(['b']);
  });

  it('同名已存在时保留原对象（不覆盖用户手调过的字段）', () => {
    const kept = m('a', '用户改过的参数');
    const { models } = mergeModels([kept], [m('a', '端点默认')]);
    expect(models[0]).toBe(kept);
    expect(models[0].tag).toBe('用户改过的参数');
  });

  it('空模型名的占位行不并入', () => {
    const { models, added } = mergeModels([m('a')], [m('   '), m('')]);
    expect(models.map((x) => x.model)).toEqual(['a']);
    expect(added).toEqual([]);
  });

  it('全部已存在时 added 为空（调用方据此走「无新增」提示）', () => {
    const { added } = mergeModels([m('a'), m('b')], [m('a')]);
    expect(added).toEqual([]);
  });

  it('空列表并入等于原样追加', () => {
    const { models } = mergeModels([], [m('a'), m('b')]);
    expect(models.map((x) => x.model)).toEqual(['a', 'b']);
  });
});
