import { describe, it, expect } from 'vitest';
import { describeContextMenuTarget, currentSelectionText } from './describe';
import type { ContextMenuTargetInfo } from './registry';

/**
 * node 环境没有 DOM，用最小假元素：只实现 describe.ts 真正会调的那几个方法。
 * 选择器按内容匹配（宿主改了选择器串也不至于把测试变成假绿）。
 */
function fakeEl(spec: {
  tagName?: string;
  editable?: unknown;
  anchor?: unknown;
  image?: unknown;
  attrs?: Record<string, string | null>;
}) {
  const el = {
    nodeType: 1,
    tagName: spec.tagName || 'DIV',
    getAttribute: (k: string) => spec.attrs?.[k] ?? null,
    closest: (sel: string) => {
      if (sel.includes('textarea')) return (spec.editable ?? null) as Element;
      if (sel === 'a[href]') return (spec.anchor ?? null) as Element;
      if (sel === 'img') return (spec.image ?? null) as Element;
      return null;
    },
  };
  return el as unknown as Element;
}

const anchor = (href: string) => ({
  tagName: 'A',
  getAttribute: (k: string) => (k === 'href' ? href : null),
  closest: () => null,
});
const image = (src: string) => ({
  tagName: 'IMG',
  getAttribute: (k: string) => (k === 'src' ? src : null),
  closest: () => null,
});
const field = (over: { readOnly?: boolean; disabled?: boolean; tag?: string } = {}) => ({
  tagName: over.tag || 'TEXTAREA',
  readOnly: !!over.readOnly,
  disabled: !!over.disabled,
  getAttribute: () => null,
  closest: () => null,
});

const info = { selectionText: '', moduleId: null as string | null };

describe('describeContextMenuTarget', () => {
  it('普通正文：什么都不是，tag 取命中元素', () => {
    const t: ContextMenuTargetInfo = describeContextMenuTarget(fakeEl({ tagName: 'P' }), info);
    expect(t).toEqual({
      tag: 'P',
      editable: false,
      readOnly: false,
      linkHref: null,
      imageSrc: null,
      selectionText: '',
      moduleId: null,
    });
  });

  it('链接里的图片：两个都给（锚点优先决定 tag），另存与打开同时可判', () => {
    const t = describeContextMenuTarget(
      fakeEl({ tagName: 'IMG', anchor: anchor('https://example.com/p'), image: image('https://cdn/a.png') }),
      info,
    );
    expect(t.tag).toBe('A');
    expect(t.linkHref).toBe('https://example.com/p');
    expect(t.imageSrc).toBe('https://cdn/a.png');
  });

  it('本地 asset 图片走 getAttribute，不被绝对化成完整 URL', () => {
    const t = describeContextMenuTarget(
      fakeEl({ tagName: 'IMG', image: { tagName: 'IMG', getAttribute: (k: string) => (k === 'src' ? 'asset://localhost/a.png' : null), closest: () => null } }),
      info,
    );
    expect(t.imageSrc).toBe('asset://localhost/a.png');
  });

  it('输入框：可编辑；readonly / disabled 都算只读', () => {
    expect(describeContextMenuTarget(fakeEl({ editable: field() }), info)).toMatchObject({ editable: true, readOnly: false, tag: 'TEXTAREA' });
    expect(describeContextMenuTarget(fakeEl({ editable: field({ readOnly: true, tag: 'INPUT' }) }), info)).toMatchObject({ editable: true, readOnly: true, tag: 'INPUT' });
    expect(describeContextMenuTarget(fakeEl({ editable: field({ disabled: true }) }), info)).toMatchObject({ readOnly: true });
  });

  it('选区文本会被 trim，模块 id 原样透传', () => {
    const t = describeContextMenuTarget(fakeEl({ tagName: 'SPAN' }), { selectionText: '  引文  ', moduleId: 'reading' });
    expect(t.selectionText).toBe('引文');
    expect(t.moduleId).toBe('reading');
  });

  it('没有 document 时取选区返回空串而不是抛错', () => {
    expect(currentSelectionText()).toBe('');
  });
});
