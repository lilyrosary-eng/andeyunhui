import { describe, expect, it } from 'vitest';
import type { CapsSourceUi } from '../aiConfigCodec';
import { capacityOutranks, capacityRefreshable, capsRefreshable, inferProviderName, mergeModels, newModelKey, normalizeBaseUrl, refillCapacity, refillCaps, sameBaseUrl } from './providerMatch';

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

describe('newModelKey —— 高亮 key 必须带供应商命名空间', () => {
  it('不同供应商的同名模型 key 不同（否则高亮会串台）', () => {
    expect(newModelKey('pv_a', 'gpt-4o')).not.toBe(newModelKey('pv_b', 'gpt-4o'));
  });

  it('同一供应商同一模型 key 稳定', () => {
    expect(newModelKey('pv_a', 'gpt-4o')).toBe(newModelKey('pv_a', 'gpt-4o'));
  });

  it('分隔符防止拼接歧义', () => {
    // 若直接用字符串相加，('pv_a','b') 与 ('pv_ab','') 会撞成同一个 key
    expect(newModelKey('pv_a', 'b')).not.toBe(newModelKey('pv_ab', ''));
  });
});

describe('capacityRefreshable —— 与后端 CapacitySource::refreshable 同口径', () => {
  it('空值可回填', () => {
    expect(capacityRefreshable('', '')).toBe(true);
    expect(capacityRefreshable('   ', 'manual')).toBe(true);
  });

  it('端点/推断来源可刷新', () => {
    expect(capacityRefreshable('8192', 'provider')).toBe(true);
    expect(capacityRefreshable('8192', 'table')).toBe(true);
  });

  it('手填冻结', () => {
    expect(capacityRefreshable('8192', 'manual')).toBe(false);
  });

  it('有值但来源未知按手填冻结（老数据保守处理）', () => {
    expect(capacityRefreshable('8192', '')).toBe(false);
  });

  it('新增的两种来源（已加载窗口 / 报错学到）同样可刷新', () => {
    expect(capacityRefreshable('8192', 'loaded')).toBe(true);
    expect(capacityRefreshable('8192', 'learned')).toBe(true);
  });
});

/**
 * 来源优先级（2026-10-22）：`table` 是猜的，绝不允许盖掉任何自报值。
 *
 * 场景：本地端点没启动时重扫一次，所有模型都只剩表值；
 * 若没有这道闸门，"已加载 8192"会被降级成"表猜 65536"，压缩阈值跟着虚高，
 * 下一次请求就被上游 400 —— 正是这次要根治的那类问题。
 */
describe('capacityOutranks —— 来源优先级（与 Rust 同序）', () => {
  it('loaded 压过 provider / learned / table', () => {
    expect(capacityOutranks('loaded', 'provider')).toBe(true);
    expect(capacityOutranks('loaded', 'learned')).toBe(true);
    expect(capacityOutranks('loaded', 'table')).toBe(true);
  });

  it('table 谁都压不过（除了空来源）', () => {
    expect(capacityOutranks('table', 'loaded')).toBe(false);
    expect(capacityOutranks('table', 'provider')).toBe(false);
    expect(capacityOutranks('table', 'learned')).toBe(false);
    expect(capacityOutranks('table', '')).toBe(true);
  });

  it('同源可刷新（重扫时值会变）', () => {
    expect(capacityOutranks('table', 'table')).toBe(true);
    expect(capacityOutranks('loaded', 'loaded')).toBe(true);
  });

  it('学到值压过表值，但压不过手填', () => {
    expect(capacityOutranks('learned', 'table')).toBe(true);
    expect(capacityOutranks('learned', 'manual')).toBe(false);
  });
});

describe('refillCapacity —— 回填老条目的容量列', () => {
  const row = (model: string, ctx = '', ctxSrc = '', out = '', outSrc = '') => ({
    model, context_tokens: ctx, context_source: ctxSrc, max_output_tokens: out, max_output_source: outSrc,
  });

  it('空值被回填（这是「重扫永远填不上」的主修复）', () => {
    const cur = [row('gpt-4o')];
    const inc = [row('gpt-4o', '128000', 'table', '16384', 'table')];
    const out = refillCapacity(cur, inc);
    expect(out[0].context_tokens).toBe('128000');
    expect(out[0].context_source).toBe('table');
    expect(out[0].max_output_tokens).toBe('16384');
  });

  it('手填的值不被覆盖', () => {
    const cur = [row('gpt-4o', '999', 'manual', '888', 'manual')];
    const inc = [row('gpt-4o', '128000', 'provider', '16384', 'provider')];
    const out = refillCapacity(cur, inc);
    expect(out[0].context_tokens).toBe('999');
    expect(out[0].max_output_tokens).toBe('888');
  });

  it('来源未知但有值（老数据）不被覆盖', () => {
    const cur = [row('gpt-4o', '777', '')];
    const inc = [row('gpt-4o', '128000', 'provider')];
    expect(refillCapacity(cur, inc)[0].context_tokens).toBe('777');
  });

  it('两个字段按各自来源独立判定', () => {
    // 上下文手填（冻结）、最大输出是推断（可刷新）
    const cur = [row('gpt-4o', '999', 'manual', '100', 'table')];
    const inc = [row('gpt-4o', '128000', 'provider', '16384', 'provider')];
    const out = refillCapacity(cur, inc);
    expect(out[0].context_tokens).toBe('999');
    expect(out[0].max_output_tokens).toBe('16384');
  });

  it('本次未发现到的模型原样保留（不增不减）', () => {
    const cur = [row('a', '1', 'table'), row('b', '2', 'table')];
    const out = refillCapacity(cur, [row('a', '999', 'provider')]);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe(cur[1]);
  });

  it('本次端点没报值 → 不清空已有值（离线重扫不该丢数据）', () => {
    const cur = [row('a', '8192', 'loaded', '2048', 'loaded')];
    const out = refillCapacity(cur, [row('a', '', '', '', '')]);
    expect(out[0].context_tokens).toBe('8192');
    expect(out[0].max_output_tokens).toBe('2048');
    expect(out[0]).toBe(cur[0]);
  });

  it('表值不覆盖已加载窗口（来源更弱）', () => {
    const cur = [row('a', '8192', 'loaded')];
    const out = refillCapacity(cur, [row('a', '65536', 'table')]);
    expect(out[0].context_tokens).toBe('8192');
    expect(out[0].context_source).toBe('loaded');
  });

  it('已加载窗口覆盖表值（来源更强）', () => {
    const cur = [row('a', '65536', 'table')];
    const out = refillCapacity(cur, [row('a', '262144', 'loaded')]);
    expect(out[0].context_tokens).toBe('262144');
    expect(out[0].context_source).toBe('loaded');
  });

  it('无变化时返回原对象引用（避免无谓重渲染）', () => {
    const cur = [row('a', '1', 'provider')];
    const out = refillCapacity(cur, [row('a', '1', 'provider')]);
    expect(out[0]).toBe(cur[0]);
  });
});

describe('refillCaps —— 回填老条目的视觉能力位', () => {
  const row = (model: string, vision: boolean, src: CapsSourceUi | '') => ({
    model, caps: { vision, vision_source: src },
  });

  it('老数据（来源未标注）能被新推断填上', () => {
    // 实测场景：GLM-4V-Flash 是改造前落盘的老条目，vision=false 且来源缺失；
    // 重扫时新推断命中名字线索（含 4V）→ 应该被填成 true。
    const out = refillCaps([row('GLM-4V-Flash', false, '')], [row('GLM-4V-Flash', true, 'inferred')]);
    expect(out[0].caps.vision).toBe(true);
    expect(out[0].caps.vision_source).toBe('inferred');
  });

  it('手改的（manual）不被覆盖', () => {
    const out = refillCaps([row('m', true, 'manual')], [row('m', false, 'inferred')]);
    expect(out[0].caps.vision).toBe(true);
    expect(out[0].caps.vision_source).toBe('manual');
  });

  it('provider 能覆盖推断出来的旧值', () => {
    const out = refillCaps([row('m', false, 'inferred')], [row('m', true, 'provider')]);
    expect(out[0].caps.vision).toBe(true);
    expect(out[0].caps.vision_source).toBe('provider');
  });

  it('新值只是推断时不覆盖 provider 旧值', () => {
    // 硬事实不该被名字启发式冲掉
    const out = refillCaps([row('m', true, 'provider')], [row('m', false, 'inferred')]);
    expect(out[0].caps.vision).toBe(true);
    expect(out[0].caps.vision_source).toBe('provider');
  });

  it('无变化时返回原对象引用', () => {
    const cur = [row('m', true, 'inferred')];
    const out = refillCaps(cur, [row('m', true, 'inferred')]);
    expect(out[0]).toBe(cur[0]);
  });

  it('未在本次发现中的模型原样保留', () => {
    const cur = [row('a', false, '')];
    const out = refillCaps(cur, [row('b', true, 'provider')]);
    expect(out[0]).toBe(cur[0]);
  });
});

describe('capsRefreshable 口径', () => {
  it('manual 冻结', () => {
    expect(capsRefreshable('manual', 'provider')).toBe(false);
    expect(capsRefreshable('manual', 'inferred')).toBe(false);
  });
  it('provider 可覆盖非 manual', () => {
    expect(capsRefreshable('', 'provider')).toBe(true);
    expect(capsRefreshable('inferred', 'provider')).toBe(true);
  });
  it('inferred 只覆盖 inferred 与未标注', () => {
    expect(capsRefreshable('inferred', 'inferred')).toBe(true);
    expect(capsRefreshable('', 'inferred')).toBe(true);
    expect(capsRefreshable('provider', 'inferred')).toBe(false);
  });
});
