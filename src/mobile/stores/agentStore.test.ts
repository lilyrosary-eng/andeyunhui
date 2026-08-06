import { describe, it, expect } from 'vitest';
import { extractToolCall, parseTimeToMs } from './agentStore';

// 现状固化测试：期望值取当前函数真实输出。
//
// ⚠ 已知缺陷（记录于 .opencode/ 缺陷清单，本轮不修）：
// extractToolCall 的内层正则 /\{(?:[^{}]|\{[^{}]*\})*"tool"...[\s\S]*?\}/
// 中 [\s\S]*?\} 非贪婪，匹配止于第一个 }。当 args 为对象（真实场景恒为对象）时，
// 截取结果缺少外层闭合括号，JSON.parse 失败 → 恒返回 null。

describe('extractToolCall', () => {
  it('空输入返回 null', () => {
    expect(extractToolCall('')).toBeNull();
    expect(extractToolCall(null as unknown as string)).toBeNull();
  });

  it('```json 围栏内完整解析 args 对象', () => {
    const text = '好的，已为你创建。\n```json\n{"tool":"create_calendar","args":{"title":"开会","time":"2026-08-06 20:00"}}\n```';
    const call = extractToolCall(text);
    expect(call).not.toBeNull();
    expect(call!.tool).toBe('create_calendar');
    expect(call!.args.title).toBe('开会');
    expect(call!.args.time).toBe('2026-08-06 20:00');
  });

  it('裸 JSON 结尾解析成功', () => {
    const call = extractToolCall('好的 {"tool":"create_todo","args":{"title":"买菜"}}');
    expect(call).not.toBeNull();
    expect(call!.tool).toBe('create_todo');
    expect(call!.args.title).toBe('买菜');
  });

  it('args 含嵌套对象也完整解析', () => {
    const call = extractToolCall('{"tool":"create_todo","args":{"data":{"k":"v"}}}');
    expect(call).not.toBeNull();
    expect(call!.tool).toBe('create_todo');
  });

  it('无 tool 字段的 JSON 返回 null', () => {
    expect(extractToolCall('```json\n{"hello":"world"}\n```')).toBeNull();
  });

  it('tool 不是字符串返回 null', () => {
    expect(extractToolCall('```json\n{"tool":123,"args":{}}\n```')).toBeNull();
  });

  it('缺 args 返回 null', () => {
    expect(extractToolCall('```json\n{"tool":"create_todo"}\n```')).toBeNull();
  });

  it('普通文本返回 null', () => {
    expect(extractToolCall('今天天气不错，明天记得带伞。')).toBeNull();
  });
});

describe('parseTimeToMs', () => {
  it('合法时间解析为时间戳', () => {
    const ts = parseTimeToMs('2026-08-06 20:00');
    expect(ts).not.toBeNull();
    const d = new Date(ts!);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7); // 8 月（0 基）
    expect(d.getDate()).toBe(6);
    expect(d.getHours()).toBe(20);
    expect(d.getMinutes()).toBe(0);
  });

  it('现状固化：单数字月/日也可解析（\\d{1,2} 允许）', () => {
    expect(parseTimeToMs('2026-8-6 20:00')).not.toBeNull();
    expect(parseTimeToMs('2026-08-6 20:00')).not.toBeNull();
  });

  it('现状固化：13 月被 JS 滚动到次年，不判非法', () => {
    const ts = parseTimeToMs('2026-13-06 20:00');
    expect(ts).not.toBeNull();
    expect(new Date(ts!).getFullYear()).toBe(2027);
  });

  it('非法格式返回 null', () => {
    expect(parseTimeToMs('')).toBeNull();
    expect(parseTimeToMs('2026/08/06 20:00')).toBeNull();
    expect(parseTimeToMs('abcdef')).toBeNull();
    expect(parseTimeToMs('2026-08-06')).toBeNull();
  });
});