/**
 * util.ts 的持久化瘦身单测 —— 重点是**媒体体积预算**。
 *
 * 为什么值得测：`agentSteps[].meta` 与蓝图 `node.output` 里挂的是完整 media data URL。
 * 早先 sanitizeConv 只截断 content、完全不碰这两处，数 MB base64 被原样写进 localStorage；
 * 配额一爆，写入静默失败 → 用户看到的是「历史记录莫名丢失」（丢的是整个会话）。
 * 这条链路的错误代价是数据丢失，所以把口径钉住。
 */
import { describe, it, expect } from 'vitest';
import { makeConv, sanitizeConv, mergeConversations, resolveTitle, isPlaceholderTitle, freezeVersions, stashTail, pickVersion, sanitizeSeed } from './util';

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

/**
 * 会话命名：**只在占位标题上生成一次**。
 *
 * 血案（2026-10-21 用户实测）：旧实现是
 * `const title = c.title || c.messages.length === 0 ? genTitle(content) : c.title;`
 * `||` 优先级高于 `?:`，整个 `c.title || ...` 被当成条件 ⇒ 只要已有标题就每轮重新生成，
 * 表现为「每轮对话会话名都变一次」。
 */
describe('resolveTitle（会话命名只做一次）', () => {
  it('占位标题「新对话」→ 用首轮输入生成', () => {
    expect(resolveTitle({ title: '新对话' }, '帮我写一个排序算法')).toBe('帮我写一个排序算法');
  });

  it('空标题 → 生成', () => {
    expect(resolveTitle({ title: '   ' }, '你好')).toBe('你好');
  });

  it('已有自定义标题 → 第二次、第三次都原样返回（这是那个 bug 的回归卡口）', () => {
    const conv = { title: '排序算法讨论' };
    expect(resolveTitle(conv, '那我换个问法')).toBe('排序算法讨论');
    expect(resolveTitle(conv, '再问一次')).toBe('排序算法讨论');
  });

  it('用户手动改名后上锁 → 即使标题恰好是占位词也保留用户选择', () => {
    expect(resolveTitle({ title: '新对话', titleLocked: true }, '随便说点')).toBe('新对话');
  });

  it('标题上限 18 字并加省略号（沿用 genTitle 口径）', () => {
    const long = '这是一段特别特别长的用户输入用来验证标题截断行为';
    const t = resolveTitle({ title: '新对话' }, long);
    expect(t.length).toBe(19);
    expect(t.endsWith('…')).toBe(true);
  });

  it('isPlaceholderTitle：只有空与内置占位词为真', () => {
    expect(isPlaceholderTitle('')).toBe(true);
    expect(isPlaceholderTitle('新对话')).toBe(true);
    expect(isPlaceholderTitle('群聊')).toBe(true);
    expect(isPlaceholderTitle('新对话记录')).toBe(false);
  });
});

/**
 * 重新生成的多版本（1/2 分页）+ 每版自带的分支尾巴。
 *
 * 要害一：`content` 永远等于 `versions[versionIndex].text`。流式期间 content 是活的、
 * 末位是空占位 —— 回填写错槽位，用户切回去就看到空串或错位文本。
 *
 * 要害二：版本切走时**活跃后续要压回旧版本**，切回来要**原样装回去**。
 * 压漏了 = 旧分支的后续永久丢失；不装回 = 切了版本却看不到那一段对话。
 */
/**
 * 新建对话的 seed 校验。
 *
 * 血案（2026-10-21，用户实测"新建对话就报错"）：侧栏 `onClick={primaryAction.onClick}`
 * 把 MouseEvent 当第一参传给了 `newConversation(seed)`，`{ ...makeConv(), ...seed }`
 * 于是把事件的 `target`（HTMLButtonElement）摊进了会话，持久化时 JSON.stringify
 * 撞上 `__reactFiber$… → FiberNode → stateNode` 的循环引用，整份历史写不进去。
 */
describe('sanitizeSeed（新建对话的种子）', () => {
  it('普通对象原样接受', () => {
    expect(sanitizeSeed({ title: '自定义标题' })).toEqual({ title: '自定义标题' });
  });

  it('空值 / 数组 / 原始值一律拒绝', () => {
    expect(sanitizeSeed(undefined)).toBeUndefined();
    expect(sanitizeSeed(null)).toBeUndefined();
    expect(sanitizeSeed([])).toBeUndefined();
    expect(sanitizeSeed('x')).toBeUndefined();
    expect(sanitizeSeed(3)).toBeUndefined();
  });

  it('React 合成事件被拒绝（就是那次崩溃的输入）', () => {
    const fakeEvent = {
      nativeEvent: { type: 'click' },
      _reactName: 'onClick',
      target: { nodeType: 1, nodeName: 'BUTTON' },
    };
    expect(sanitizeSeed(fakeEvent)).toBeUndefined();
  });

  it('DOM 节点被拒绝', () => {
    expect(sanitizeSeed({ nodeType: 1, nodeName: 'BUTTON' })).toBeUndefined();
  });

  it('非普通对象（类实例）被拒绝，避免把自带原型的东西写进会话', () => {
    class Weird { x = 1; }
    expect(sanitizeSeed(new Weird())).toBeUndefined();
  });
});

describe('freezeVersions（多版本回填）', () => {
  it('没重新生成过 → 只有当前这一版', () => {
    expect(freezeVersions({ content: '只有一版' })).toEqual([{ text: '只有一版' }]);
  });

  it('流式刚结束（末位是空占位）→ 把 content 写进末位', () => {
    expect(freezeVersions({ content: '第二版', versions: [{ text: '第一版' }, { text: '' }], versionIndex: 1 }))
      .toEqual([{ text: '第一版' }, { text: '第二版' }]);
  });

  it('当前显示的是旧版 → 回填自己那一格，不动别的版本（含尾巴）', () => {
    const tail = [{ id: 't1', role: 'user' as const, content: '后续' }];
    expect(freezeVersions({
      content: '第一版',
      versions: [{ text: '第一版', tail }, { text: '第二版' }],
      versionIndex: 0,
    })).toEqual([{ text: '第一版', tail }, { text: '第二版' }]);
  });

  it('index 越界时收敛到合法槽位，不抛错', () => {
    expect(freezeVersions({ content: 'x', versions: [{ text: 'a' }, { text: 'b' }], versionIndex: 99 }))
      .toEqual([{ text: 'a' }, { text: 'x' }]);
    expect(freezeVersions({ content: 'x', versions: [{ text: 'a' }, { text: 'b' }], versionIndex: -3 }))
      .toEqual([{ text: 'x' }, { text: 'b' }]);
  });

  it('老数据是 string[]（2026-10-21 之前）→ 自动升级成 { text }', () => {
    const legacy = ['旧一', '旧二'] as unknown as { text: string }[];
    expect(freezeVersions({ content: '旧二', versions: legacy, versionIndex: 1 }))
      .toEqual([{ text: '旧一' }, { text: '旧二' }]);
  });
});

describe('stashTail / pickVersion（分支尾巴）', () => {
  const tail = [
    { id: 'b1', role: 'user' as const, content: '继续' },
    { id: 'b2', role: 'assistant' as const, content: '续写' },
  ];

  it('切走时把活跃后续压进当前版本', () => {
    const vs = stashTail([{ text: 'A' }, { text: 'B' }], 0, tail);
    expect(vs[0].tail).toEqual(tail);
    expect(vs[1].tail).toBeUndefined();
  });

  it('空后续要清掉旧尾巴，不能保留上一版的分支', () => {
    const vs = stashTail([{ text: 'A', tail }, { text: 'B' }], 0, []);
    expect(vs[0].tail).toBeUndefined();
  });

  it('取版本：正文 + 该版本的后续（没有后续就是空数组）', () => {
    const vs = [{ text: 'A', tail }, { text: 'B' }];
    expect(pickVersion(vs, 0)).toEqual({ text: 'A', tail });
    expect(pickVersion(vs, 1)).toEqual({ text: 'B', tail: [] });
  });

  it('index 越界收敛，不抛错', () => {
    const vs = [{ text: 'A' }];
    expect(pickVersion(vs, 9)).toEqual({ text: 'A', tail: [] });
    expect(stashTail(vs, -1, tail)[0].tail).toEqual(tail);
  });
});

describe('sanitizeConv —— 版本与分支的持久化', () => {
  it('多版本只留最近 5 版，versionIndex 跟着平移', () => {
    const c = makeConv();
    const versions = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7'].map((t) => ({ text: t }));
    c.messages.push({ id: 'm1', role: 'assistant', content: 'v7', versions, versionIndex: 6 });
    const out = sanitizeConv(c);
    const m = out.messages[0];
    expect(m.versions!.map((v) => v.text)).toEqual(['v3', 'v4', 'v5', 'v6', 'v7']);
    expect(m.versionIndex).toBe(4);
  });

  it('分支尾巴也参与瘦身（正文截断 + 媒体丢弃），不是原样写进 localStorage', () => {
    const huge = 'x'.repeat(40_000);
    const c = makeConv();
    c.messages.push({
      id: 'm1',
      role: 'assistant',
      content: '当前',
      versions: [{
        text: '旧版',
        tail: [{ id: 't1', role: 'assistant' as const, content: huge }],
      }],
      versionIndex: 0,
    });
    const out = sanitizeConv(c);
    const t = out.messages[0].versions![0].tail![0];
    expect(t.content.length).toBeLessThan(huge.length);
    expect(t.content.endsWith('…（内容过长已截断）')).toBe(true);
  });
});
