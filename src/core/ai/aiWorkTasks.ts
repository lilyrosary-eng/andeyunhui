// AIWork / AIWorkflow 统一任务：一条 Conversation = 一个可双向编辑的任务。
// AIWork（流式对话，messages）与 AIWorkflow（节点画布，aiWork 蓝图）编辑同一条记录，
// 两个视图切换读写同一任务即可控制粒度并预览效果。
import type { Conversation, WfNode } from '@/components/capsule/types';
import type { WorkflowDoc } from './aiWorkflows';
import { uid, loadConversations, persistConversations, AI_AIWORK_CONVERSATIONS_KEY } from './util';
import { loadWorkflows } from './aiWorkflows';

/** 新任务默认起始节点（对齐旧 WorkflowDoc.createWorkflow）。 */
function defaultPromptNode(): WfNode {
  return {
    id: uid(),
    type: 'prompt',
    label: '起始输入',
    x: 48,
    y: 96,
    params: { prompt: '请描述本次任务希望 AI 完成的目标…' },
    status: 'idle',
  };
}

/** 新建统一任务：带一张默认起始蓝图的对话记录（AIWork 对话 与 AIWorkflow 画布共用）。 */
export function createAiWorkTask(name?: string): Conversation {
  return {
    id: uid(),
    title: (name?.trim() || '未命名任务').slice(0, 40),
    messages: [],
    updatedAt: Date.now(),
    aiWork: { task: '', nodes: [defaultPromptNode()], edges: [] },
  };
}

/** 从统一任务（Conversation）派生 AIWorkflow 文档（供节点画布渲染）。 */
export function workflowFromConv(conv: Conversation): WorkflowDoc {
  const aw = conv.aiWork;
  return {
    id: conv.id,
    name: conv.title || '未命名任务',
    task: aw?.task ?? '',
    nodes: aw?.nodes ?? [],
    edges: aw?.edges ?? [],
    updatedAt: conv.updatedAt ?? 0,
  };
}

/** 把 AIWorkflow 文档（画布编辑结果）回写到统一任务的 aiWork 蓝图。 */
export function applyWorkflowToConv(conv: Conversation, doc: WorkflowDoc): Conversation {
  return {
    ...conv,
    title: doc.name || conv.title,
    aiWork: { ...conv.aiWork, task: doc.task, nodes: doc.nodes, edges: doc.edges },
  };
}

/**
 * 一次性迁移旧版 AIWorkflow 独立任务存储（andeyunhui.aiwork.workflows）进统一任务列表，
 * 避免已有蓝图画布数据因架构切换而消失。仅在统一列表尚未出现任何带蓝图的记录时执行，保证幂等。
 */
export function migrateLegacyWorkflows(): void {
  try {
    const legacy = loadWorkflows();
    if (!legacy.length) return;
    const current = loadConversations(AI_AIWORK_CONVERSATIONS_KEY);
    if (current.some((c) => !!c.aiWork)) return; // 已迁移过 / 用户已建新任务，跳过
    const merged: Conversation[] = [
      ...legacy.map((d): Conversation => ({
        id: d.id,
        title: d.name || '未命名任务',
        messages: [],
        updatedAt: d.updatedAt ?? Date.now(),
        aiWork: { task: d.task, nodes: d.nodes, edges: d.edges },
      })),
      ...current,
    ];
    persistConversations(AI_AIWORK_CONVERSATIONS_KEY, merged);
  } catch {
    // 迁移失败不影响正常使用
  }
}