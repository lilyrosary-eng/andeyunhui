/**
 * util.ts 的持久化瘦身单测 —— 重点是**媒体体积预算**。
 *
 * 为什么值得测：`agentSteps[].meta` 与蓝图 `node.output` 里挂的是完整 media data URL。
 * 早先 sanitizeConv 只截断 content、完全不碰这两处，数 MB base64 被原样写进 localStorage；
 * 配额一爆，写入静默失败 → 用户看到的是「历史记录莫名丢失」（丢的是整个会话）。
 * 这条链路的错误代价是数据丢失，所以把口径钉住。
 */
import { describe, it, expect } from 'vitest';
import { makeConv, sanitizeConv, mergeConversations } from './util';

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

/**
 * mergeConversations —— 跨来源合并会话。
 *
 * 现在有**两个**消费点，且都直接关系「对话会不会丢」：
 *  ① `useAiChat` 的跨 webview 同步（胶囊浮窗 ↔ 主窗口，localStorage 隔离）
 *  ② `CapsuleAide` 挂载时装载后端文件里的 IDE 对话
 *     （此前是 `setAideConversations(list)` 整体替换 → 收起浮岛再打开就被旧文件覆盖，
 *      表现为「切一下就消失」；改为 merge 后本地独有的一律保留）
 *
 * 所以这里把最关键的性质钉住：**任何一侧独有的会话都不能被对方抹掉**。
 */
describe('mergeConversations', () => {
  const conv = (id: string, updatedAt: number, content = 'x') => ({
    id, title: id, updatedAt,
    messages: [{ id: 'm' + id, role: 'assistant' as const, content }],
  });

  it('两侧独有的会话都保留（这是防丢的核心性质）', () => {
    const local = [conv('ac1', 100)];   // 只在浮岛侧存在
    const remote = [conv('c_1', 100)];  // 只在 IDE 文件里存在，且**没有 updatedAt**
    const out = mergeConversations(local, remote);
    expect(out.map((c) => c.id).sort()).toEqual(['ac1', 'c_1']);
  });

  it('远端没有 updatedAt 时不会顶掉同 id 的本地较新版', () => {
    // 后端 AiConversation 结构里没有 updatedAt（只有 id/title/messages），
    // 反序列化回来是 undefined。若不特殊处理，`undefined ?? 0` 会让它被当成"最旧"，
    // 于是 IDE 的旧内容反而覆盖浮岛的新内容 —— 正好是我们要避免的方向。
    const local = [conv('same', 500, '浮岛的新内容')];
    const remote = [conv('same', undefined as unknown as number, 'IDE的旧内容')];
    const out = mergeConversations(local, remote);
    expect(out).toHaveLength(1);
    expect(out[0].messages[0].content).toBe('浮岛的新内容');
  });

  it('远端更新的同 id 会话会采用远端', () => {
    const out = mergeConversations([conv('same', 100, '旧')], [conv('same', 200, '新')]);
    expect(out[0].messages[0].content).toBe('新');
  });

  it('结果按更新时间倒序（最近的在最前）', () => {
    const out = mergeConversations([conv('a', 100)], [conv('b', 300), conv('c', 200)]);
    expect(out.map((c) => c.id)).toEqual(['b', 'c', 'a']);
  });

  it('任一侧为空时原样返回另一侧', () => {
    expect(mergeConversations([], [conv('a', 1)]).map((c) => c.id)).toEqual(['a']);
    expect(mergeConversations([conv('a', 1)], []).map((c) => c.id)).toEqual(['a']);
  });
});
