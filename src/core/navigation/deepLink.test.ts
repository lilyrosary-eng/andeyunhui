import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '@/lib/markdown';
import {
  DEEP_LINK_SCHEME,
  buildDeepLink,
  parseDeepLink,
  resolveDeepLinkFromClick,
  attachDeepLinkClickHandler,
} from './deepLink';

describe('buildDeepLink / parseDeepLink', () => {
  it('实体与 props 原样往返（含 Windows 反斜杠路径与中文）', () => {
    const book = String.raw`D:\书籍\三体.txt`;
    const href = buildDeepLink({ module: 'reading', entity: book, props: { highlightId: 'hl-1' } });
    expect(href.startsWith(`${DEEP_LINK_SCHEME}///reading?`)).toBe(true);
    expect(parseDeepLink(href)).toEqual({
      module: 'reading',
      entity: book,
      props: { highlightId: 'hl-1' },
    });
  });

  it('只有模块时不产生空 entity/props 字段', () => {
    expect(parseDeepLink(buildDeepLink({ module: 'notes' }))).toEqual({ module: 'notes' });
  });

  it('带连字符的模块 id 不被 path 编码吃掉', () => {
    expect(parseDeepLink(buildDeepLink({ module: 'ai-chat', entity: 'x' }))).toEqual({
      module: 'ai-chat',
      entity: 'x',
    });
  });

  it('数字/布尔 props 以字符串往返，对象 props 被丢弃', () => {
    const href = buildDeepLink({
      module: 'music',
      props: { chapterIndex: 3, live: true, nested: { a: 1 } as unknown as string },
    });
    expect(parseDeepLink(href)).toEqual({
      module: 'music',
      props: { chapterIndex: '3', live: 'true' },
    });
  });

  it('保留名 e 让给实体，props 里的 e 被跳过', () => {
    const href = buildDeepLink({ module: 'reading', entity: 'book.txt', props: { e: 'ignored' } });
    expect(parseDeepLink(href)).toEqual({ module: 'reading', entity: 'book.txt' });
  });

  it('非深链一律返回 null；脏百分号编码退回原文而不是抛错', () => {
    expect(parseDeepLink('https://example.com')).toBeNull();
    expect(parseDeepLink('andy-nav:///reading?e=%zz')).toEqual({ module: 'reading', entity: '%zz' });
    expect(parseDeepLink('andy-nav:///%2ZZ')).toEqual({ module: '%2ZZ' });
    expect(parseDeepLink('andy-nav:')).toBeNull();
    expect(parseDeepLink('')).toBeNull();
    expect(parseDeepLink(undefined)).toBeNull();
  });

  it('缺模块就抛（调用方是代码，不是用户输入）', () => {
    expect(() => buildDeepLink({ module: '' })).toThrow();
    expect(() => buildDeepLink({} as { module: string })).toThrow();
  });
});

describe('深链点击代理', () => {
  /** 只实现 closest/getAttribute 的最小假锚点：node 环境没有 DOM */
  function fakeAnchor(href: string | null) {
    const anchor = { getAttribute: () => href };
    return { closest: (sel: string) => (sel === 'a[href]' ? anchor : null) } as unknown as Element;
  }

  it('命中锚点上的深链给出导航目标', () => {
    expect(resolveDeepLinkFromClick(fakeAnchor(buildDeepLink({ module: 'reading', entity: 'b' }))))
      .toEqual({ module: 'reading', entity: 'b' });
  });

  it('普通链接与非锚点都不接管', () => {
    expect(resolveDeepLinkFromClick(fakeAnchor('https://example.com'))).toBeNull();
    expect(resolveDeepLinkFromClick(null)).toBeNull();
    expect(resolveDeepLinkFromClick({ closest: () => null } as unknown as Element)).toBeNull();
  });

  it('无 document 环境下挂载代理不抛错，返回可用的注销函数', () => {
    const detach = attachDeepLinkClickHandler();
    expect(typeof detach).toBe('function');
    detach();
  });
});

// 笔记预览的真相是「md → renderMarkdown → dangerouslySetInnerHTML」这条链，
// 渲染器带协议消毒（javascript:/vbscript:/data:text/html 换成 #）。
// 回链能不能点，取决于它有没有被这套消毒顺手杀掉 —— 只能实测渲染结果，读代码不算验证。
describe('深链活过笔记渲染器', () => {
  it('renderMarkdown 保留 andy-nav: 协议，从渲染出的 href 能还原出同一个导航目标', () => {
    const book = String.raw`D:\书籍\三体.txt`;
    const target = { module: 'reading', entity: book, props: { highlightId: 'h-1' } };
    const html = renderMarkdown(`[回到原文](${buildDeepLink(target)})`);
    const href = /href="([^"]+)"/.exec(html)?.[1];
    expect(href).toBeTruthy();
    expect(html).not.toContain('href="#"');
    // 属性里的 & 被 escapeHtml 写成 &amp;，浏览器读回来还是 &；这里手工还原后必须等价
    expect(parseDeepLink((href || '').replace(/&amp;/g, '&'))).toEqual(target);
  });
});
