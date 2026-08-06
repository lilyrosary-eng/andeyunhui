import { describe, it, expect } from 'vitest';
import { classifyProfile, type AiProfile } from './chat';

// 现状固化测试：期望值取当前函数真实输出。

function profile(base_url: string): AiProfile {
  return {
    id: 'p1',
    name: 't',
    base_url,
    api_key: '',
    model: 'qwen2.5:14b',
  };
}

describe('classifyProfile', () => {
  it('localhost 视为本地', () => {
    expect(classifyProfile(profile('http://localhost:8080'))).toBe('local');
    expect(classifyProfile(profile('http://127.0.0.1:11434'))).toBe('local');
    expect(classifyProfile(profile('http://0.0.0.0:11434'))).toBe('local');
  });

  it('局域网网段视为本地', () => {
    expect(classifyProfile(profile('http://192.168.1.10:8080'))).toBe('local');
    expect(classifyProfile(profile('http://10.0.0.1:8080'))).toBe('local');
    expect(classifyProfile(profile('http://172.16.5.5:8080'))).toBe('local');
    expect(classifyProfile(profile('http://172.31.5.5:8080'))).toBe('local');
  });

  it('公网视为云端', () => {
    expect(classifyProfile(profile('https://api.openai.com/v1'))).toBe('cloud');
    expect(classifyProfile(profile('https://dashscope.aliyuncs.com'))).toBe('cloud');
    expect(classifyProfile(profile('http://172.32.1.1:8080'))).toBe('cloud'); // 超 172.16-31 段
    expect(classifyProfile(profile(''))).toBe('cloud');
  });
});