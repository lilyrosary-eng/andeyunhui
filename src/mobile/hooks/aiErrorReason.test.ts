import { describe, it, expect } from 'vitest';
import { guessReason } from './aiErrorReason';

// 现状固化测试：期望值取当前函数真实输出，行为变更需另行评审。

describe('guessReason', () => {
  it('timeout 家族 → 超时文案', () => {
    expect(guessReason('Request timed out after 30s')).toContain('超时');
    expect(guessReason('timeout occurred')).toContain('超时');
    expect(guessReason('连接超时')).toContain('超时');
  });

  it('connection refused 家族 → 电脑未响应文案', () => {
    const reason = guessReason('Connection refused at 192.168.1.5:8080');
    expect(reason).toContain('电脑睡眠');
    expect(guessReason('ECONNREFUSED')).toContain('电脑睡眠');
    expect(guessReason('连接被拒绝')).toContain('电脑睡眠');
  });

  it('dns 家族 → 地址解析文案', () => {
    expect(guessReason('DNS lookup failed')).toContain('无法解析算力源地址');
    expect(guessReason('getaddrinfo ENOTFOUND')).toContain('无法解析算力源地址');
  });

  it('鉴权家族 → API Key 文案', () => {
    expect(guessReason('invalid api key')).toContain('API Key 无效');
    expect(guessReason('Unauthorized')).toContain('API Key 无效');
    expect(guessReason('401 Unauthorized')).toContain('API Key 无效');
  });

  it('其它错误 → 默认文案', () => {
    expect(guessReason('random unknown error')).toBe('算力源暂时不可达，可以重试或改用云端继续对话。');
    expect(guessReason('')).toBe('算力源暂时不可达，可以重试或改用云端继续对话。');
  });
});