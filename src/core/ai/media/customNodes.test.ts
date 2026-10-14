/**
 * 自定义节点放行名单的单测。
 *
 * 这里的口径必须与 Rust 侧 `audit_graph` **逐字对齐**：模块名取自 `object_info`
 * 的 `python_module` 原文（不做任何美化），核心节点（`python_module === 'nodes'`）
 * 不算自定义。对不上的话，用户勾选了却依然被拒——最难查的那种 bug。
 */
import { describe, it, expect } from 'vitest';
import { customModulesOf } from './customNodes';

describe('customModulesOf —— 从 object_info 归纳自定义模块', () => {
  it('按模块分组，核心节点被排除', () => {
    const info = {
      CheckpointLoaderSimple: { python_module: 'nodes' },
      KSampler: { python_module: 'nodes' },
      IPAdapterApply: { python_module: 'custom_nodes.ComfyUI_IPAdapter_plus' },
      IPAdapterModelLoader: { python_module: 'custom_nodes.ComfyUI_IPAdapter_plus' },
    };
    const out = customModulesOf(info);
    expect(Object.keys(out)).toEqual(['custom_nodes.ComfyUI_IPAdapter_plus']);
    expect(out['custom_nodes.ComfyUI_IPAdapter_plus']).toEqual([
      'IPAdapterApply',
      'IPAdapterModelLoader',
    ]);
  });

  it('模块名保持原文（不做美化），否则放行对不上审计', () => {
    const out = customModulesOf({ X: { python_module: '  custom_nodes.Foo  ' } });
    expect(Object.keys(out)).toEqual(['custom_nodes.Foo']);
  });

  it('没有 python_module 的节点被忽略（无法归类）', () => {
    const out = customModulesOf({ A: {}, B: { python_module: '' }, C: { python_module: 42 } });
    expect(out).toEqual({});
  });

  it('核心节点占多数时不产生任何自定义模块', () => {
    const out = customModulesOf({ A: { python_module: 'nodes' }, B: { python_module: 'nodes' } });
    expect(out).toEqual({});
  });

  it('非法输入返回空对象而不是抛错', () => {
    expect(customModulesOf(null)).toEqual({});
    expect(customModulesOf(undefined)).toEqual({});
    expect(customModulesOf('nope')).toEqual({});
    expect(customModulesOf([])).toEqual({});
  });
});
