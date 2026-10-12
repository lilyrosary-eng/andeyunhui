import { describe, it, expect } from 'vitest';
import { fuzzyScore, bestScore } from './fuzzy';

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
