/**
 * 请求载荷契约（agent/对话行为评测 · 2026-10-21）
 *
 * 这一层钉的是**发给模型的东西**，不是界面长什么样。
 * 最近几轮的真实 bug 几乎都在这里：重新生成把旧回复一起发出去（模型顺着自己上一版写）、
 * 工具输出被回灌、历史无限增长直到 HTTP 400。这些都不会让界面报错，只会让回答变差，
 * 所以必须有断言，而不是靠手点。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildRequestMessages, safeMessages, estTokens, HARD_MSG_CAP, HARD_TOTAL_CAP, CHAT_HISTORY_LIMIT } from './chatPayload';
import type { ChatMsg } from '@/components/capsule/types';

const msg = (role: 'user' | 'assistant', content: string, extra: Partial<ChatMsg> = {}): ChatMsg => ({
  id: `${role}-${content.slice(0, 8)}`,
  role,
  content,
  ...extra,
});

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // safeMessages 每次都会 console.log 诊断行，测试里静音（保持输出可读）
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

describe('buildRequestMessages', () => {
  it('普通发送：历史 + 本轮 user，注入内容只拼在最后一条 user 上', () => {
    const history = [msg('user', '第一问'), msg('assistant', '第一答')];
    const out = buildRequestMessages(history, msg('user', '第二问'), { inject: '\n[图片描述] 一只猫' });
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ role: 'user', content: '第一问' });
    expect(out[1]).toEqual({ role: 'assistant', content: '第一答' });
    expect(out[2].role).toBe('user');
    expect(out[2].content).toBe('第二问\n[图片描述] 一只猫');
  });

  it('重新生成：history 里已含本轮提问 ⇒ 不再追加 user（否则同一句话出现两遍）', () => {
    // 调用方传的是"这条助手消息之前"的历史，末尾就是本轮提问
    const history = [msg('user', '第一问'), msg('assistant', '第一答'), msg('user', '第二问')];
    const out = buildRequestMessages(history, msg('user', '第二问'), { skipUserAppend: true });
    expect(out).toHaveLength(3);
    expect(out.filter((m) => m.content === '第二问')).toHaveLength(1);
    expect(out[out.length - 1].role).toBe('user');
  });

  it('重新生成：被丢弃的旧回复不在请求里（否则模型会顺着自己上一版继续写）', () => {
    const full = [
      msg('user', '问'), msg('assistant', '旧回复-将被丢弃'), msg('user', '再问'), msg('assistant', '旧回复2-将被丢弃'),
    ];
    // 实际调用方切的就是"最后一条助手消息之前"
    const historyBefore = full.slice(0, 3);
    const out = buildRequestMessages(historyBefore, msg('user', '再问'), { skipUserAppend: true });
    expect(out.map((m) => m.content)).not.toContain('旧回复2-将被丢弃');
    expect(out.map((m) => m.content)).toContain('旧回复-将被丢弃'); // 更早的轮次属于正常历史
  });

  it('toolNote / error 不进请求（本地工具输出回灌只会污染上下文、白烧 token）', () => {
    const history = [
      msg('user', '跑一下状态'),
      msg('assistant', '{"kernel":"running"}', { toolNote: true }),
      msg('assistant', '⚠ 命令失败：EACCES', { error: true }),
      msg('assistant', '内核在运行'),
    ];
    const out = buildRequestMessages(history, msg('user', '继续'));
    const joined = out.map((m) => m.content).join('|');
    expect(joined).not.toContain('{"kernel":"running"}');
    expect(joined).not.toContain('EACCES');
    expect(joined).toContain('内核在运行');
  });

  it('重新生成时历史末尾不是 user → 打印 error 但不抛（不能因为日志把请求打断）', () => {
    const history = [msg('assistant', '孤立的回答')];
    expect(() => buildRequestMessages(history, msg('user', 'x'), { skipUserAppend: true })).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('safeMessages 三重截断', () => {
  it('条数上限：只保留最近 40 条', () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ role: 'user', content: `消息${i}` }));
    const out = safeMessages(many);
    expect(out).toHaveLength(CHAT_HISTORY_LIMIT);
    expect(out[0].content).toBe('消息5'); // 尾部保留：最旧的 5 条被丢
  });

  it(`单条超长（>${HARD_MSG_CAP} 字符）被硬切并留标记`, () => {
    const out = safeMessages([{ role: 'user', content: 'A'.repeat(HARD_MSG_CAP + 500) }]);
    expect(out[0].content.length).toBeLessThanOrEqual(HARD_MSG_CAP + 20);
    expect(out[0].content).toContain('超长已截断');
  });

  it('总 token 超限时从尾部保留，且总量不越界', () => {
    // 每条 8000 字符 CJK ≈ 8000 token；60 条 ≈ 48 万，远超 20 万
    const many = Array.from({ length: 60 }, (_, i) => ({ role: 'user', content: `第${i}条` + '中'.repeat(HARD_MSG_CAP - 5) }));
    const out = safeMessages(many, 60);
    const total = out.reduce((s, m) => s + estTokens(m.content), 0);
    expect(total).toBeLessThanOrEqual(HARD_TOTAL_CAP);
    // 保留的是最新的（末尾内容在）
    expect(out[out.length - 1].content.startsWith('第59条')).toBe(true);
  });
});

describe('estTokens 口径', () => {
  it('中文按 1 字 1 token，英文按 4 字符 1 token', () => {
    expect(estTokens('中文四字')).toBe(4);
    expect(estTokens('abcd')).toBe(1);
    expect(estTokens('')).toBe(0);
  });
});
