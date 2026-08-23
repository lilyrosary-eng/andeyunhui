// AIWorkflow（AIGC 工作流编蓝图）独立任务持久化 —— 本地存储，与笔记模块彻底解耦。
// 一个「任务」= 一张可执行的工作流蓝图（节点 + 连线 + 任务描述）。
// 节点类型为 AIGC 原生三元组，全程不触笔记：
//   - prompt  输入 / 起始提示（提供上下文）
//   - llm     模型生成（提示词内可用 {ref:节点id} 引用前序输出）
//   - output  汇聚成产出出（落进 AIWork 独立产物库 aiWork.products）
import { useCallback, useEffect, useMemo, useState } from 'react';
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

/** AIWorkflow 任务状态 Hook —— 把任务列表/选中/变更集中到宿主（Root）托管，
 *  以便共享侧栏（AiChatSidebar）复用同一份数据渲染任务列表，视图组件只拿单个活动文档。 */
export function useAiWorkflows() {
  const [workflows, setWorkflows] = useState<WorkflowDoc[]>(() => loadWorkflows());
  const [activeId, setActiveId] = useState<string | null>(() => null);

  // 首次进入，自动选中列表第一个；删除当前任务后自动回落
  useEffect(() => {
    if (!activeId && workflows.length) setActiveId(workflows[0].id);
  }, [activeId, workflows]);

  // 事实源即状态，任何变更即落盘
  useEffect(() => { persistWorkflows(workflows); }, [workflows]);

  const active = useMemo(() => workflows.find((w) => w.id === activeId) ?? null, [workflows, activeId]);

  /** 对当前活动文档做一次不可变更新（保持引用稳定，自动 bump updatedAt） */
  const updateActive = useCallback((fn: (d: WorkflowDoc) => WorkflowDoc) => {
    setWorkflows((prev) => {
      const i = prev.findIndex((w) => w.id === activeId);
      if (i < 0) return prev;
      const next = [...prev];
      next[i] = { ...fn(prev[i]), updatedAt: Date.now() };
      return next;
    });
  }, [activeId]);

  const newWorkflow = useCallback(() => {
    const doc = createWorkflow();
    setWorkflows((prev) => [doc, ...prev]);
    setActiveId(doc.id);
    return doc.id;
  }, []);

  const selectWorkflow = useCallback((id: string) => setActiveId(id), []);

  const renameWorkflow = useCallback((id: string, name: string) => {
    const n = name.trim() || '未命名任务';
    setWorkflows((prev) => prev.map((w) => (w.id === id ? { ...w, name: n.slice(0, 40), updatedAt: Date.now() } : w)));
  }, []);

  const removeWorkflow = useCallback((id: string) => {
    setWorkflows((prev) => prev.filter((w) => w.id !== id));
    setActiveId((cur) => (cur === id ? null : cur));
  }, []);

  return { workflows, activeId, active, updateActive, newWorkflow, selectWorkflow, renameWorkflow, removeWorkflow };
}