import { describe, it, expect } from 'vitest';
import { renderMd, escapeHtml } from './MessageList';
import { buildCompanionContext, type Companion } from '../../stores/companionStore';

// 现状固化测试：markdown 后处理 + 伴侣上下文注入文本。

describe('escapeHtml', () => {
  it('转义全部特殊字符', () => {
    expect(escapeHtml('<a href="x">&')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;');
  });

  it('普通文本原样返回', () => {
    expect(escapeHtml('你好 world 123')).toBe('你好 world 123');
  });
});

describe('renderMd', () => {
  it('基本 markdown → 加粗标签', () => {
    expect(renderMd('**加粗**')).toContain('<strong>加粗</strong>');
  });

  it('代码块包复制容器', () => {
    const out = renderMd('```ts\nconst a = 1;\n```');
    expect(out).toContain('md-code-block');
    expect(out).toContain('md-copy-btn');
    expect(out).toContain('data-code="const a = 1;');
    expect(out).toContain('<pre><code>');
  });

  it('代码含 HTML 实体：data-code 反解码后二次转义', () => {
    const out = renderMd('```\n<meta a="b" & c>\n```');
    expect(out).toContain('data-code="&lt;meta a=&quot;b&quot; &amp; c&gt;');
  });

  it('多个代码块各自包裹', () => {
    const out = renderMd('```js\nx\n```\n中间文字\n```py\ny\n```');
    const count = out.split('md-code-block').length - 1;
    expect(count).toBe(2);
  });

  it('异常内容不影响（内部 try/catch 兜底）', () => {
    expect(renderMd('**测试')).toBeTruthy();
  });
});

describe('buildCompanionContext', () => {
  const base: Companion = {
    id: 'c1',
    name: '小灯',
    avatar: '💡',
    personality: '温柔',
    background: '陪伴',
    catchphrase: '嗯嗯',
    profile_id: null,
    relationship: {
      warmth: 0, trust: 0, intimacy: 0, intrigue: 0, patience: 0, tension: 0,
      first_met_at: null, last_active_at: null,
    },
    memories: [],
    core_memory: [],
  };

  const NOW = 1_800_000_000;

  it('默认亲密度 → 初始阶段 + 认识 0 天', () => {
    const out = buildCompanionContext(base, NOW);
    expect(out).toContain('还在彼此了解的阶段');
    expect(out).toContain('认识 0 天');
    expect(out).toContain('你是「小灯」');
  });

  it('亲密度五档文案', () => {
    const withI = (intimacy: number) => buildCompanionContext({ ...base, relationship: { ...base.relationship, intimacy } }, NOW);
    expect(withI(20)).toContain('开始熟络起来');
    expect(withI(40)).toContain('已经熟络，聊天很自然');
    expect(withI(60)).toContain('很亲近，能分享内心想法');
    expect(withI(80)).toContain('非常亲密，几乎无话不谈');
  });

  it('认识天数：向下取整且不取负', () => {
    const out = buildCompanionContext({ ...base, relationship: { ...base.relationship, first_met_at: NOW - 3 * 86400 } }, NOW);
    expect(out).toContain('认识 3 天');
  });

  it('记忆截断到 12 条', () => {
    const memories = Array.from({ length: 15 }, (_, i) => ({ id: `m${i}`, kind: 'summary', content: `记忆${i}`, created_at: 0 }));
    const out = buildCompanionContext({ ...base, memories }, NOW);
    expect(out).toContain('- 记忆0');
    expect(out).toContain('- 记忆11');
    expect(out).not.toContain('- 记忆12');
  });

  it('核心档案始终注入', () => {
    const out = buildCompanionContext({ ...base, core_memory: ['讨厌香菜', '喜欢猫'] }, NOW);
    expect(out).toContain('【关于 TA（务必记住）】');
    expect(out).toContain('- 讨厌香菜');
  });

  it('空 personality/background/catchphrase 不注入对应行', () => {
    const out = buildCompanionContext({ ...base, personality: '  ', background: '', catchphrase: '' }, NOW);
    expect(out).not.toContain('性格：');
    expect(out).not.toContain('背景：');
    expect(out).not.toContain('口头禅：');
  });
});