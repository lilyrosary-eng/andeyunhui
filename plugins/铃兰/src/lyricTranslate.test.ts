import { describe, expect, it, vi } from 'vitest';
import {
  buildTranslatablePayload,
  describeOutcome,
  parseLrc,
  rejoinTranslated,
  translateLyrics,
} from './lyricTranslate';

const LRC = [
  '[ti:晴天]',
  '[ar:周杰伦]',
  '[00:12.34]故事的小黄花',
  '[00:16.00]从出生那年就飘着',
  '',
  '[00:20.00][01:20.00]重复的一行',
].join('\n');

describe('LRC 解析与待译内容', () => {
  it('剥掉时间戳前缀，只把正文送去翻译', () => {
    const payload = buildTranslatablePayload(parseLrc(LRC));
    expect(payload).toBe('故事的小黄花\n从出生那年就飘着\n重复的一行');
  });

  it('元信息头不参与翻译', () => {
    const payload = buildTranslatablePayload(parseLrc(LRC));
    expect(payload).not.toContain('[ti:');
    expect(payload).not.toContain('晴天]');
  });

  it('多时间戳连写的行只算一行', () => {
    const lines = parseLrc('[00:20.00][01:20.00]副歌');
    expect(lines[0].stamps).toBe('[00:20.00][01:20.00]');
    expect(lines[0].text).toBe('副歌');
  });
});

describe('译文贴回时间轴', () => {
  it('行数一致时逐行贴回原前缀并保留元信息头与空行', () => {
    const lines = parseLrc(LRC);
    const got = rejoinTranslated(lines, 'Yellow flower of the story\nDrifting since the year I was born\nA repeated line');
    expect(got.aligned).toBe(true);
    expect(got.text).toBe(
      [
        '[ti:晴天]',
        '[ar:周杰伦]',
        '[00:12.34]Yellow flower of the story',
        '[00:16.00]Drifting since the year I was born',
        '',
        '[00:20.00][01:20.00]A repeated line',
      ].join('\n'),
    );
  });

  it('译文里多出的空行被忽略，不算作不对齐', () => {
    const lines = parseLrc('[00:01.00]A\n[00:02.00]B');
    const got = rejoinTranslated(lines, 'x\n\n\ny');
    expect(got.aligned).toBe(true);
    expect(got.text).toBe('[00:01.00]x\n[00:02.00]y');
  });

  it('★ 行数对不上时不硬凑时间轴：退化为纯译文并如实标记', () => {
    // 翻译节点把两行合成一行了 —— 若按位置贴回，后面每一行都会错轴，跟唱逐行错位
    const lines = parseLrc('[00:01.00]A\n[00:02.00]B\n[00:03.00]C');
    const got = rejoinTranslated(lines, 'merged AB\nC');
    expect(got.aligned).toBe(false);
    expect(got.text).toBe('merged AB\nC');
    expect(got.text).not.toContain('[00:');
  });

  it('纯文本（没有时间戳）也能走同一条路', () => {
    const lines = parseLrc('第一行\n第二行');
    const got = rejoinTranslated(lines, 'one\ntwo');
    expect(got.aligned).toBe(true);
    expect(got.text).toBe('one\ntwo');
  });
});

describe('translateLyrics 调用与如实回报', () => {
  it('按时间轴对齐返回，元信息带上实际节点', async () => {
    const invoke = vi.fn(async () => ({
      text: 'one\ntwo\nthree',
      node: 'bing',
      detectedLang: 'zh',
      segments: 1,
      notices: [],
    }));
    const r = await translateLyrics('[00:01.00]A\n[00:02.00]B\n[00:03.00]C', { invoke, targetLang: '英语' });
    expect(r.aligned).toBe(true);
    expect(r.text).toBe('[00:01.00]one\n[00:02.00]two\n[00:03.00]three');
    expect(r.meta).toContain('节点 bing');
    expect(r.meta).toContain('源语言 zh');
  });

  it('所有 notices 原文并入 meta，不截断不改写', async () => {
    const invoke = vi.fn(async () => ({
      text: 'x\ny',
      node: 'mymemory',
      notices: ['bing 失败(502 Bad Gateway)，已兜底到 mymemory', '第 2 段疑似丢行'],
    }));
    const r = await translateLyrics('[00:01.00]A\n[00:02.00]B', { invoke });
    expect(r.meta).toContain('bing 失败(502 Bad Gateway)，已兜底到 mymemory');
    expect(r.meta).toContain('第 2 段疑似丢行');
  });

  it('不对齐时 meta 里明说了原因', async () => {
    const invoke = vi.fn(async () => ({ text: 'merged', node: 'bing' }));
    const r = await translateLyrics('[00:01.00]A\n[00:02.00]B', { invoke });
    expect(r.aligned).toBe(false);
    expect(r.meta).toContain('译文行数与原文不一致');
  });

  it('没有可翻译文本时直接抛错，不空发一次请求', async () => {
    const invoke = vi.fn();
    await expect(translateLyrics('[ti:只有头]\n[ar:只有头]', { invoke })).rejects.toThrow('当前没有可翻译的歌词文本');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('宿主通道缺失时如实报错', async () => {
    await expect(translateLyrics('[00:01.00]A', {})).rejects.toThrow('宿主翻译通道不可用');
  });

  it('兼容只返回裸字符串的老接口形态', async () => {
    const invoke = vi.fn(async () => 'plain translation');
    const r = await translateLyrics('原文一行', { invoke });
    expect(r.text).toBe('plain translation');
    expect(r.aligned).toBe(true);
  });

  it('请求参数名是 camelCase 的 targetLang', async () => {
    const invoke = vi.fn(async () => ({ text: 'a', node: 'bing' }));
    await translateLyrics('[00:01.00]A', { invoke, targetLang: '英语' });
    expect(invoke).toHaveBeenCalledWith('translate_text', { text: 'A', targetLang: '英语' });
  });
});

describe('describeOutcome', () => {
  it('缺字段时用问号而不是假装成功', () => {
    expect(describeOutcome({}, true)).toBe('节点 ?');
  });
  it('缓存命中标出来', () => {
    expect(describeOutcome({ node: 'bing', fromCache: true }, true)).toContain('缓存命中');
  });
});
