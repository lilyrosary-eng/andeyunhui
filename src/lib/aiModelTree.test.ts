import { describe, expect, it } from 'vitest';
import { buildModelTree, countModels, findModelLabel, type RawProvider } from './aiModelTree';

const cfg = (providers: RawProvider[]) => ({ providers });

describe('模型树：按预设厂商分组', () => {
  it('分组顺序就是用户自己的配置顺序，不替他重排', () => {
    const tree = buildModelTree(
      cfg([
        { id: 'z', name: 'Z 家', models: [{ id: 'z1', model: 'z-one' }] },
        { id: 'a', name: 'A 家', models: [{ id: 'a1', model: 'a-one' }] },
      ]),
    );
    expect(tree.map((g) => g.name)).toEqual(['Z 家', 'A 家']);
  });

  it('厂商名回落：name → 端点主机名 → id → 未命名供应商', () => {
    const tree = buildModelTree(
      cfg([
        { name: '  ', base_url: 'https://api.deepseek.com/v1', models: [{ id: 'm1' }] },
        { base_url: 'http://localhost:1234/v1', models: [{ id: 'm2' }] },
        { id: 'p3', models: [{ id: 'm3' }] },
        { models: [{ id: 'm4' }] },
      ]),
    );
    expect(tree.map((g) => g.name)).toEqual([
      'api.deepseek.com',
      'localhost',
      'p3',
      '未命名供应商',
    ]);
  });

  it('模型展示名回落：label → 上游模型名 → id', () => {
    const tree = buildModelTree(
      cfg([{ id: 'p', name: 'P', models: [{ id: 'x', label: ' 对外名字 ' }, { id: 'y', model: 'qwen3:8b' }, { id: 'z' }] }]),
    );
    expect(tree[0].models.map((m) => m.label)).toEqual(['对外名字', 'qwen3:8b', 'z']);
    // id 才是写回 profileId 的值，展示名再花也不能改掉它
    expect(tree[0].models.map((m) => m.id)).toEqual(['x', 'y', 'z']);
  });

  it('没有 id 的模型进不了树；整家没可用模型就不该占一格', () => {
    const tree = buildModelTree(
      cfg([
        { id: 'p', name: 'P', models: [{ id: '  ' }, { id: 'ok', model: 'ok-model' }, {} as any] },
        { id: 'q', name: 'Q', models: [] },
        { id: 'r', name: 'R' },
      ]),
    );
    expect(tree.map((g) => g.name)).toEqual(['P']);
    expect(countModels(tree)).toBe(1);
  });

  it('坏输入不抛（后端可能返回空配置）', () => {
    expect(buildModelTree(undefined)).toEqual([]);
    expect(buildModelTree(null)).toEqual([]);
    expect(buildModelTree({ providers: '不是数组' as unknown as RawProvider[] })).toEqual([]);
    expect(countModels([])).toBe(0);
  });
});

describe('选中项的展示文案', () => {
  const tree = buildModelTree(
    cfg([
      { id: 'p', name: 'LM Studio', models: [{ id: 'm1', model: 'qwen3:8b' }, { id: 'm2', model: 'deepseek-r1' }] },
      { id: 'q', name: 'DeepSeek', models: [{ id: 'm3', model: 'deepseek-chat' }] },
    ]),
  );

  it('跨厂商也能定位，返回「厂商 · 模型」', () => {
    expect(findModelLabel(tree, 'm1')).toBe('LM Studio · qwen3:8b');
    expect(findModelLabel(tree, 'm2')).toBe('LM Studio · deepseek-r1');
    expect(findModelLabel(tree, 'm3')).toBe('DeepSeek · deepseek-chat');
  });

  it('档案里已经没有这个 id 时返回 null —— 界面据此说「这次按默认走」', () => {
    expect(findModelLabel(tree, '已删除的模型')).toBeNull();
    expect(findModelLabel(tree, undefined)).toBeNull();
    expect(findModelLabel(tree, '')).toBeNull();
  });
});
