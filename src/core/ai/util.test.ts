/**
 * util.ts 的持久化瘦身单测 —— 重点是**媒体体积预算**。
 *
 * 为什么值得测：`agentSteps[].meta` 与蓝图 `node.output` 里挂的是完整 media data URL。
 * 早先 sanitizeConv 只截断 content、完全不碰这两处，数 MB base64 被原样写进 localStorage；
 * 配额一爆，写入静默失败 → 用户看到的是「历史记录莫名丢失」（丢的是整个会话）。
 * 这条链路的错误代价是数据丢失，所以把口径钉住。
 */
import { describe, it, expect } from 'vitest';
import { makeConv, sanitizeConv } from './util';

/** 造一个指定长度的假 data URL（字符数 = prefix + n）。 */
const fakeMedia = (mime: string, n: number) => `data:${mime};base64,` + 'A'.repeat(n);

const convWithSteps = (metas: Record<string, unknown>[]) => {
  const c = makeConv();
  c.messages.push({
    id: 'm1',
    role: 'assistant',
    content: 'hi',
    agentSteps: metas.map((meta) => ({ stage: 'tool', name: 'generate_image', meta })),
  } as any);
  return c;
};

/** 取回瘦身后的 step meta（类型宽松，测试只关心字段）。 */
const metasOf = (c: unknown) =>
  (((c as { messages: unknown[] }).messages[0] as { agentSteps: { meta: Record<string, unknown> }[] }).agentSteps).map(
    (s) => s.meta,
  );

describe('sanitizeConv —— 媒体体积预算', () => {
  it('小媒体原样保留', () => {
    const src = fakeMedia('image/png', 1000);
    const out = sanitizeConv(convWithSteps([{ card: 'image', image: src }]));
    const meta = metasOf(out)[0];
    expect(meta.image).toBe(src);
    expect(meta.omitted).toBeUndefined();
  });

  it('超单条上限的媒体被清空，并留下 omitted 说明', () => {
    const out = sanitizeConv(convWithSteps([{ card: 'image', image: fakeMedia('image/png', 400_000) }]));
    const meta = metasOf(out)[0];
    expect(meta.image).toBe('');
    expect(meta.omitted).toBe('image/png');
  });

  it('音频与视频同样受管（不止图片）', () => {
    const out = sanitizeConv(
      convWithSteps([
        { card: 'audio', audio: fakeMedia('audio/mpeg', 400_000) },
        { card: 'video', video: fakeMedia('video/mp4', 400_000) },
      ]),
    );
    const metas = metasOf(out);
    expect(metas[0].audio).toBe('');
    expect(metas[0].omitted).toBe('audio/mpeg');
    expect(metas[1].video).toBe('');
    expect(metas[1].omitted).toBe('video/mp4');
  });

  it('总量超预算时「新的优先」——旧的被丢、最近的保住', () => {
    // 单条 290k（都低于单条上限 300k），6 条共 1.74M > 总量预算 1.5M → 必然要丢。
    // 倒序消耗预算，所以最早的那条最先出局、最后一条必定保住。
    const each = fakeMedia('image/png', 290_000);
    const out = sanitizeConv(
      convWithSteps(new Array(6).fill(null).map(() => ({ card: 'image', image: each }))),
    );
    const metas = metasOf(out);
    expect(metas[5].image).toBe(each); // 最近的保住
    expect(metas[0].image).toBe(''); // 最早的被丢
    expect(metas[0].omitted).toBe('image/png');
  });

  it('蓝图节点的 output 也走同一份预算', () => {
    const c = makeConv();
    (c as unknown as { aiWork: unknown }).aiWork = {
      nodes: [{ id: 'n1', output: fakeMedia('video/mp4', 400_000) }],
    };
    const out = sanitizeConv(c);
    const node = (out as unknown as { aiWork: { nodes: { output: string; outputOmitted?: string }[] } }).aiWork
      .nodes[0];
    expect(node.output).toBe('');
    expect(node.outputOmitted).toBe('video/mp4');
  });

  it('没有媒体时不改动（返回等价对象，代理回归）', () => {
    const out = sanitizeConv(convWithSteps([{ card: 'generic', title: 'x' }]));
    expect(metasOf(out)[0].title).toBe('x');
  });

  it('非 data URL 的媒体（http 直链）不占预算、不被裁剪', () => {
    const url = 'https://example.com/a.png';
    const out = sanitizeConv(convWithSteps([{ card: 'image', image: url }]));
    expect(metasOf(out)[0].image).toBe(url);
  });
});
