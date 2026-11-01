import { describe, it, expect } from 'vitest';
import {
  fuzzyScore,
  bestScore,
  matchQuery,
  makeScorer,
  prepareQuery,
  splitMatches,
} from './fuzzy';

describe('fuzzyScore', () => {
  it('空查询命中一切并给正分', () => {
    expect(fuzzyScore('', 'gpt-4o')).toBeGreaterThan(0);
    expect(fuzzyScore('   ', 'gpt-4o')).toBeGreaterThan(0);
  });

  it('空目标不匹配非空查询', () => {
    expect(fuzzyScore('gpt', '')).toBeLessThan(0);
  });

  it('完全匹配分数最高', () => {
    const exact = fuzzyScore('gpt4o', 'gpt4o');
    const partial = fuzzyScore('gpt', 'gpt-4o');
    expect(exact).toBeGreaterThan(partial);
  });

  it('命中位置越靠前分越高', () => {
    const early = fuzzyScore('gpt', 'gpt-4o');
    const late = fuzzyScore('gpt', 'claude-gpt');
    expect(early).toBeGreaterThan(late);
  });

  it('词首命中加权', () => {
    const afterDash = fuzzyScore('vl', 'qwen-vl-72b');
    expect(afterDash).toBeGreaterThan(fuzzyScore('vl', 'myvlmodel'));
  });

  it('短目标优先于长目标', () => {
    expect(fuzzyScore('llama', 'llama')).toBeGreaterThan(fuzzyScore('llama', 'llama-3.1-70b-instruct-uncensored'));
  });

  it('不包含且不成子序列则不匹配', () => {
    expect(fuzzyScore('xyz', 'gpt-4o')).toBeLessThan(0);
  });

  it('子序列退化：ds 能命中 DeepSeek', () => {
    expect(fuzzyScore('ds', 'DeepSeek')).toBeGreaterThan(0);
    expect(fuzzyScore('dsk', 'DeepSeek')).toBeGreaterThan(0);
  });

  it('子序列跳字越多分越低', () => {
    const tight = fuzzyScore('ds', 'dpsk');
    const loose = fuzzyScore('ds', 'd----p----s----k');
    expect(loose).toBeGreaterThan(0);
    expect(tight).toBeGreaterThan(loose);
  });

  it('大小写不敏感', () => {
    expect(fuzzyScore('GPT', 'gpt-4o')).toBeGreaterThan(0);
  });

  it('中文可匹配且按字符计而非字节', () => {
    expect(fuzzyScore('智谱', '智谱 GLM')).toBeGreaterThan(0);
    expect(fuzzyScore('通义', '通义千问')).toBeGreaterThan(0);
  });

  it('emoji 不破坏匹配（Array.from 而非 charAt）', () => {
    // 🧠 是代理对，charAt 遍历会把它劈成两半导致长度判断错乱
    expect(fuzzyScore('brain', '🧠 brain')).toBeGreaterThan(0);
    expect(fuzzyScore('🧠', '🧠 brain')).toBeGreaterThan(0);
  });

  it('ollama 标签形式可命中', () => {
    expect(fuzzyScore('qwen3', 'qwen3:8b-instruct')).toBeGreaterThan(0);
  });
});

describe('bestScore', () => {
  it('取所有字段里的最高分', () => {
    const s = bestScore('deep', [
      { text: 'DeepSeek 官方', weight: 1.0 },
      { text: 'https://api.deepseek.com/v1', weight: 0.6 },
    ]);
    expect(s).toBeCloseTo(fuzzyScore('deep', 'DeepSeek 官方'));
  });

  it('权重低的字段高分也追不上权重高的字段低分', () => {
    const fields = [
      { text: '完全不同的东西', weight: 1.0 },
      { text: 'DeepSeek', weight: 0.6 },
    ];
    const s = bestScore('deepseek', fields);
    expect(s).toBeCloseTo(fuzzyScore('deepseek', 'DeepSeek') * 0.6);
  });

  it('全不匹配返回负数', () => {
    expect(bestScore('zzz', [{ text: 'abc', weight: 1.0 }, { text: 'def', weight: 1.0 }])).toBeLessThan(0);
  });

  it('空字段列表返回负数', () => {
    expect(bestScore('a', [])).toBeLessThan(0);
  });
});

describe('prepareQuery', () => {
  it('按分隔符切 token，分隔符自成一个 token', () => {
    const p = prepareQuery('qwen-vl 72b');
    expect(p.tokens).toEqual(['qwen', '-', 'vl', '72b']);
  });

  it('CJK 逐字成 token（中文没有大小写边界可切）', () => {
    expect(prepareQuery('智谱').tokens).toEqual(['智', '谱']);
  });

  it('fuzzy 序列去掉空白，且 emoji 不被劈成两半', () => {
    expect(prepareQuery('a b').fuzzy).toEqual(['a', 'b']);
    expect(prepareQuery('🧠x').fuzzy).toEqual(['🧠', 'x']);
  });
});

describe('cx 五项惩罚（Obsidian 移植的行为钉）', () => {
  it('token 能整段命中时，不该退化到逐字符去拿更差的匹配', () => {
    expect(fuzzyScore('ab', 'abx')).toBeGreaterThan(fuzzyScore('ab', 'axb'));
  });

  it('命中被切成更多段要罚', () => {
    const one = fuzzyScore('ds', 'dsk');
    const two = fuzzyScore('ds', 'dxs');
    expect(one).toBeGreaterThan(two);
  });

  it('词内命中要罚，词首要奖', () => {
    expect(fuzzyScore('vl', 'vl-model')).toBeGreaterThan(fuzzyScore('vl', 'myvlmodel'));
  });

  it('中文：空格后的命中优于嵌在词里的命中（这条 Obsidian 不罚，我们补罚）', () => {
    expect(fuzzyScore('夜曲', '伴奏 夜曲')).toBeGreaterThan(fuzzyScore('夜曲', '某夜曲某'));
  });

  it('靠前的命中优于靠后的命中', () => {
    expect(fuzzyScore('pro', 'pro-net')).toBeGreaterThan(fuzzyScore('pro', 'qwen-pro'));
  });
});

describe('matchQuery / splitMatches', () => {
  it('给出命中区间，供高亮使用', () => {
    const m = matchQuery(prepareQuery('vl'), 'qwen-vl-72b');
    expect(m).not.toBeNull();
    expect(m!.ranges).toEqual([[5, 7]]);
    expect(splitMatches('qwen-vl-72b', m!.ranges)).toEqual([
      ['qwen-', false],
      ['vl', true],
      ['-72b', false],
    ]);
  });

  it('不匹配返回 null，空查询给正分且无区间', () => {
    expect(matchQuery(prepareQuery('zzz'), 'gpt-4o')).toBeNull();
    const empty = matchQuery(prepareQuery('   '), 'anything');
    expect(empty!.score).toBeGreaterThan(0);
    expect(empty!.ranges).toEqual([]);
  });

  it('makeScorer 与 fuzzyScore 结果一致（预绑定查询不改变手感）', () => {
    const scorer = makeScorer('deep');
    expect(scorer('DeepSeek 官方')).toBe(fuzzyScore('deep', 'DeepSeek 官方'));
  });
});
