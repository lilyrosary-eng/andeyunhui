/**
 * comfyuiConfig.ts 单测——pickPromptAt 的选位口径（与蓝图 image 节点保持一致）。
 * resolveComfyuiConfig 依赖 tauri invoke 与全局 storage，不做单测（其内部选位逻辑即本函数）。
 */
import { describe, it, expect } from 'vitest';
import { pickPromptAt } from './comfyuiConfig';
import type { WorkflowParameter } from './comfyui/params';

/** 造一个 WorkflowParameter 的最小壳（只填 pickPromptAt 关心的字段）。 */
function p(over: Partial<WorkflowParameter>): WorkflowParameter {
  return {
    id: 'id',
    name: 'x',
    label: 'X',
    type: 'string',
    nodeId: '1',
    inputKey: 'text',
    default: '',
    ...over,
  };
}

describe('pickPromptAt', () => {
  it('取首个 prompt 类字符串参数（prompt / prompt_2 均算）', () => {
    const at = pickPromptAt([
      p({ name: 'width', type: 'number', nodeId: '4', inputKey: 'width' }),
      p({ name: 'prompt', nodeId: '2', inputKey: 'text' }),
      p({ name: 'prompt_2', nodeId: '3', inputKey: 'text' }),
    ]);
    expect(at).toEqual({ nodeId: '2', inputKey: 'text' });
  });

  it('跳过非字符串的同名参数（数字型 prompt 不算）', () => {
    const at = pickPromptAt([
      p({ name: 'prompt', type: 'number', nodeId: '9', inputKey: 'value' }),
      p({ name: 'prompt', nodeId: '7', inputKey: 'text' }),
    ]);
    expect(at).toEqual({ nodeId: '7', inputKey: 'text' });
  });

  it('无 prompt 类参数时返回 undefined（不静默选其它位）', () => {
    const at = pickPromptAt([p({ name: 'seed', type: 'number', nodeId: '5', inputKey: 'seed' })]);
    expect(at).toBeUndefined();
  });

  it('空参数表返回 undefined', () => {
    expect(pickPromptAt([])).toBeUndefined();
  });
});
