// AIWorkflow（AIGC 工作流编蓝图）独立任务持久化 —— 本地存储，与笔记模块彻底解耦。
// 一个「任务」= 一张可执行的工作流蓝图（节点 + 连线 + 任务描述）。
// 节点类型为 AIGC 原生三元组，全程不触笔记：
//   - prompt  输入 / 起始提示（提供上下文）
//   - llm     模型生成（提示词内可用 {ref:节点id} 引用前序输出）
//   - output  汇聚成产出出（落进 AIWork 独立产物库 aiWork.products）
import { storage } from '@/core/storage';
import { uid } from '@/core/ai/util';

export type WfNodeType = 'prompt' | 'llm' | 'output';

export interface WfNode {
  id: string;
  type: WfNodeType;
  label: string;
  /** 画布相对坐标 */
  x: number;
  y: number;
  params: Record<string, string>;
  status: 'idle' | 'running' | 'ok' | 'error';
  output?: string;
}

export interface WfEdge {
  id: string;
  /** source 节点的输出 → target 节点的输入 */
  source: string;
  target: string;
}

export interface WorkflowDoc {
  id: string;
  name: string;
  /** 用一句话描述任务，供「按任务生成蓝图」 */
  task: string;
  nodes: WfNode[];
  edges: WfEdge[];
  updatedAt: number;
}

export const WF_KEY = 'andeyunhui.aiwork.workflows';
const WF_MAX = 60;

/** 给新节点一个避开已占用位置的起始坐标（简单错位排列）。 */
export function autoPos(existing: WfNode[], index = existing.length): { x: number; y: number } {
  return { x: 48 + index * 44, y: 80 + (index % 6) * 64 };
}

export function loadWorkflows(): WorkflowDoc[] {
  const arr = storage.getJSON<WorkflowDoc[]>(WF_KEY, []);
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((d) => d && d.id && Array.isArray(d.nodes) && Array.isArray(d.edges))
    .map((d) => ({ ...d, edges: d.edges || [], nodes: d.nodes || [] }));
}

/** 落盘（仅截断条数；排序/更新时间由调用方保证）。 */
export function persistWorkflows(list: WorkflowDoc[]): void {
  storage.setJSON(WF_KEY, list.slice(0, WF_MAX));
}

/** 新建空任务（含一个默认 prompt 起始节点）。 */
export function createWorkflow(name?: string): WorkflowDoc {
  return {
    id: uid(),
    name: (name?.trim() || '未命名任务').slice(0, 40),
    task: '',
    nodes: [
      {
        id: uid(),
        type: 'prompt',
        label: '起始输入',
        x: 48,
        y: 96,
        params: { prompt: '请描述本次任务希望 AI 完成的目标…' },
        status: 'idle',
      },
    ],
    edges: [],
    updatedAt: Date.now(),
  };
}