import { describe, it, expect } from 'vitest';
import {
  builtinFlags,
  collectProviderItems,
  registerContextMenuProvider,
  subscribeContextMenu,
  visibleProviders,
  type ContextMenuItem,
  type ContextMenuTargetInfo,
} from './registry';

function target(over: Partial<ContextMenuTargetInfo> = {}): ContextMenuTargetInfo {
  return {
    tag: 'DIV',
    editable: false,
    readOnly: false,
    linkHref: null,
    imageSrc: null,
    selectionText: '',
    moduleId: null,
    ...over,
  };
}

describe('builtinFlags 判据', () => {
  it('没有选区就不给复制/剪切（复制空串只是噪音）', () => {
    const f = builtinFlags(target({ editable: true }));
    expect(f.copy).toBe(false);
    expect(f.cut).toBe(false);
    expect(f.paste).toBe(true);
    expect(f.selectAll).toBe(true);
  });

  it('有选区：普通文本给复制，不给剪切粘贴', () => {
    const f = builtinFlags(target({ selectionText: '一段引文' }));
    expect(f.copy).toBe(true);
    expect(f.cut).toBe(false);
    expect(f.paste).toBe(false);
    expect(f.selectAll).toBe(false);
  });

  it('只读区只给全选，不给剪切与粘贴', () => {
    const f = builtinFlags(target({ editable: true, readOnly: true, selectionText: 'x' }));
    expect(f.copy).toBe(true);
    expect(f.cut).toBe(false);
    expect(f.paste).toBe(false);
    expect(f.selectAll).toBe(true);
  });

  it('深链与 http/mailto 可打开，javascript: 只给复制不给打开', () => {
    expect(builtinFlags(target({ tag: 'A', linkHref: 'andy-nav:///reading?e=x' })).openLink).toBe(true);
    expect(builtinFlags(target({ tag: 'A', linkHref: 'https://example.com' })).openLink).toBe(true);
    expect(builtinFlags(target({ tag: 'A', linkHref: 'mailto:a@b.c' })).openLink).toBe(true);
    const evil = builtinFlags(target({ tag: 'A', linkHref: 'javascript:alert(1)' }));
    expect(evil.openLink).toBe(false);
    expect(evil.copyLink).toBe(true);
  });

  it('图片：远程可另存，asset:// 与 data: 不给另存（本来就在本地 / 后端不吃）', () => {
    expect(builtinFlags(target({ tag: 'IMG', imageSrc: 'https://cdn/x.png' })).saveImage).toBe(true);
    expect(builtinFlags(target({ tag: 'IMG', imageSrc: 'asset://localhost/x.png' })).saveImage).toBe(false);
    expect(builtinFlags(target({ tag: 'IMG', imageSrc: 'data:image/png;base64,AAA' })).saveImage).toBe(false);
    expect(builtinFlags(target({ tag: 'IMG', imageSrc: 'asset://localhost/x.png' })).copyImage).toBe(true);
  });

  it('什么都没有时一条内置项都不给（右键菜单不能变成哑键）', () => {
    const f = builtinFlags(target());
    expect(Object.values(f).some(Boolean)).toBe(false);
  });
});

describe('provider 注册表', () => {
  const items: ContextMenuItem[] = [{ id: 'a', label: 'A' }];

  it('不给 moduleId 就全局生效；给了就只在该模块出现', () => {
    const offGlobal = registerContextMenuProvider({ id: 'p-global', build: () => items });
    const offReading = registerContextMenuProvider({ id: 'p-reading', moduleId: 'reading', build: () => items });
    expect(visibleProviders('music').map((p) => p.id)).toContain('p-global');
    expect(visibleProviders('music').map((p) => p.id)).not.toContain('p-reading');
    expect(visibleProviders('reading').map((p) => p.id)).toContain('p-reading');
    offGlobal();
    offReading();
    expect(visibleProviders('reading')).toHaveLength(0);
  });

  it('priority 越大越靠前，同优先级按 id 稳定排序', () => {
    const offs = [
      registerContextMenuProvider({ id: 'low', priority: 1, build: () => items }),
      registerContextMenuProvider({ id: 'high', priority: 9, build: () => items }),
      registerContextMenuProvider({ id: 'mid', priority: 5, build: () => items }),
    ];
    expect(visibleProviders(null).map((p) => p.id)).toEqual(['high', 'mid', 'low']);
    offs.forEach((off) => off());
  });

  it('同 id 重复注册以后者为准（组件重挂时拿到最新闭包）', async () => {
    const offFirst = registerContextMenuProvider({ id: 'dup', build: () => [{ id: 'x', label: 'first' }] });
    const offSecond = registerContextMenuProvider({ id: 'dup', build: () => [{ id: 'x', label: 'second' }] });
    const list = await collectProviderItems(target());
    expect(list.map((i) => i.label)).toEqual(['second']);
    offFirst();
    offSecond();
  });

  it('provider 抛错只丢它自己的条目，其它 provider 照常出', async () => {
    const offBoom = registerContextMenuProvider({
      id: 'boom',
      build: () => { throw new Error('模块自己崩了'); },
    });
    const offOk = registerContextMenuProvider({ id: 'ok', build: () => [{ id: 'k', label: 'kept' }] });
    const list = await collectProviderItems(target());
    expect(list.map((i) => i.label)).toEqual(['kept']);
    offBoom();
    offOk();
  });

  it('build 返回非数组按空处理（异步返回 undefined 也不能把菜单搞炸）', async () => {
    const off = registerContextMenuProvider({
      id: 'bad-shape',
      build: () => undefined as unknown as ContextMenuItem[],
    });
    expect(await collectProviderItems(target())).toEqual([]);
    off();
  });

  it('注册与注销都会通知订阅者（菜单开着时要能重算）', () => {
    let hits = 0;
    const offSub = subscribeContextMenu(() => { hits += 1; });
    const off = registerContextMenuProvider({ id: 'notify', build: () => items });
    expect(hits).toBe(1);
    off();
    expect(hits).toBe(2);
    offSub();
  });

  it('缺 id 或缺 build 直接抛（调用方是代码，早炸比静默好）', () => {
    expect(() => registerContextMenuProvider({ id: '', build: () => [] })).toThrow();
    expect(() => registerContextMenuProvider({ id: 'x' } as unknown as { id: string; build: () => [] })).toThrow();
  });
});
