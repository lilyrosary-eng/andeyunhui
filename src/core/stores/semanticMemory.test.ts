import { describe, it, expect } from 'vitest';
import { stripDataUrls, sanitizeMemoryText } from './semanticMemory';

/**
 * 记忆文本的体积护栏（2026-10-22 血案回归）。
 *
 * 现场：伴侣 `avatar` 存的是 2.98MB 的 base64 data URL，被 `buildPersonaContext`
 * 拼进人设文本 → 沉淀成 `companion://<id>/persona` 记忆块（库里两条 2,984,551 字符）
 * → 普通 AI 对话发「你好」时检索 top-5 把它捞回 system ⇒ 「估算 >32768 token，已终止本轮」。
 *
 * 所以写入端必须：先摘掉二进制，再限长。这两条是"用户能不能正常发一句话"的底线。
 */
describe('stripDataUrls（摘掉内嵌二进制）', () => {
  it('base64 图片 data URL 被替换成占位', () => {
    const png = 'data:image/png;base64,' + 'A'.repeat(200_000);
    const out = stripDataUrls(`头像：${png}`);
    expect(out.length).toBeLessThan(100);
    expect(out).toContain('［已移除内嵌二进制数据］');
    expect(out).not.toContain('base64,');
  });

  it('多个 data URL 全部摘掉（含换行的 base64）', () => {
    const a = 'data:image/jpeg;base64,' + 'QUJD\nREVG'.repeat(1000);
    const b = 'data:audio/wav;base64,' + 'Zm9v'.repeat(1000);
    const out = stripDataUrls(`${a} 中间文字 ${b}`);
    expect(out).toContain('中间文字');
    expect(out.match(/［已移除内嵌二进制数据］/g)?.length).toBe(2);
  });

  it('普通文本（含冒号/分号）不受影响', () => {
    const s = '时间：12:00；格式：text/plain；不含 base64';
    expect(stripDataUrls(s)).toBe(s);
  });
});

describe('sanitizeMemoryText（写入端限长）', () => {
  it('超长文本被截断并带省略标记（≤8000 + 标记）', () => {
    const out = sanitizeMemoryText('字'.repeat(50_000), 'test');
    expect(out.length).toBeLessThanOrEqual(8_000 + 20);
    expect(out.endsWith('…（内容过长已截断）')).toBe(true);
  });

  it('正常长度原样返回', () => {
    const s = '用户：你好\n助手：你好，有什么可以帮你？';
    expect(sanitizeMemoryText(s, 'test')).toBe(s);
  });

  it('3MB 头像 + 人设 → 净化后只剩人设文本（就是那次的脏数据）', () => {
    const avatar = 'data:image/png;base64,' + 'A'.repeat(2_984_426);
    const persona = `【人设画像·你的身份】你是「mia」${avatar}\n性格：温柔`;
    const out = sanitizeMemoryText(persona, 'ingestMemory/persona');
    expect(out.length).toBeLessThan(200);
    expect(out).toContain('你是「mia」');
    expect(out).toContain('性格：温柔');
  });

  it('空串/null 安全', () => {
    expect(sanitizeMemoryText('', 'test')).toBe('');
    expect(sanitizeMemoryText(null as unknown as string, 'test')).toBe('');
  });
});
