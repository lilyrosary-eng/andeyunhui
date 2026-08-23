import { memo, useCallback, useMemo, useRef, useState } from 'react';
import {
  Workflow, Play, Wand2, Save, Loader2, Brain, Database, BookmarkCheck, FileText, CheckCircle2, XCircle,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/**
 * AIWorkflow（AI 工作流 · 对话式蓝图）一期最小可用闭环。
 *
 * 对话驱动：用户一句话 → AI 拆解成「节点链」蓝图 → 渲染为只读节点图（参数可调）→
 * 用户确认后逐节点执行 → 每步写执行日志 → 蓝图持久化（可复用）。
 *
 * 一期节点类型（最小集，全部复用既有后端命令，不上 Rust 引擎）：
 *   - read_notes   读取笔记（aiwork_context_aggregate）
 *   - llm          大模型生成（ai_chat，prompt 内可用 {ref:节点id} 引用前序输出）
 *   - write_note   写入笔记（aiwork_create_note，蓝图终点）
 */
type NodeType = 'read_notes' | 'llm' | 'write_note';

interface WfNode {
  id: string;
  type: NodeType;
  label: string;
  params: Record<string, string>;
  status: 'idle' | 'running' | 'ok' | 'error';
  output?: string;
}

const NODE_ICON: Record<NodeType, React.ReactNode> = {
  read_notes: <Database size={15} />,
  llm: <Brain size={15} />,
  write_note: <BookmarkCheck size={15} />,
};

const NODE_TINT: Record<NodeType, string> = {
  read_notes: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
  llm: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  write_note: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
};

const TYPE_NAME: Record<NodeType, string> = {
  read_notes: '读取笔记',
  llm: '模型生成',
  write_note: '写入笔记',
};

const PLAN_SYSTEM = `你是「蓝图规划器」。用户会给出一个办公/任务需求，请把它拆解成一个可执行的工作流节点列表。
只输出一个严格 JSON 对象，不要 markdown 代码块、不要任何解释。格式：
{"nodes":[{"id":"n1","type":"read_notes","label":"读取笔记","params":{"query":"周报"}},{"id":"n2","type":"llm","label":"生成周报","params":{"system":"你是办公助手","prompt":"请基于以下内容生成一份周报：\\n{ref:n1}"}},{"id":"n3","type":"write_note","label":"存档","params":{"title":"本周周报","ref":"n2"}}]}
可用节点类型：
- read_notes 读取笔记：params 可含 query(关键词) 或 limit(数量)
- llm 模型生成：params.system 为可选系统提示，params.prompt 为用户内容，prompt 内可用 {ref:节点id} 引用前序节点输出
- write_note 写入笔记（作为蓝图终点）：params.title 为笔记标题，params.ref 引用前序节点输出作为正文；或 params.content 直接给正文
id 按 n1、n2、n3 顺序递增。最后一个节点应为 write_note，把成果落到笔记。`;

function uidp(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeParsePlan(raw: string): { nodes: WfNode[] } | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1));
    const arr = obj?.nodes;
    if (!Array.isArray(arr)) return null;
    const nodes: WfNode[] = arr
      .filter((n) => n && typeof n.id === 'string')
      .map((n, i) => {
        const type: NodeType = n.type === 'write_note' ? 'write_note' : n.type === 'read_notes' ? 'read_notes' : 'llm';
        return {
          id: typeof n.id === 'string' ? n.id : `n${i + 1}`,
          type,
          label: typeof n.label === 'string' && n.label ? n.label : TYPE_NAME[type],
          params: (n.params && typeof n.params === 'object' ? n.params : {}) as Record<string, string>,
          status: 'idle' as const,
        };
      });
    return nodes.length ? { nodes } : null;
  } catch {
    return null;
  }
}

/** 把 prompt 中的 {ref:节点id} 替换为前序节点输出 */
function subRefs(s: string, outputs: Map<string, string>): string {
  return s.replace(/\{ref:([\w]+)\}/g, (_, id) => outputs.get(id) ?? `[引用${id}无输出]`);
}

/** 节点参数摘要（展示用） */
function paramsSummary(node: WfNode): string {
  const p = node.params;
  const parts: string[] = [];
  if (node.type === 'read_notes') {
    if (p.query) parts.push(`查询「${p.query}」`);
    if (p.limit) parts.push(`上限 ${p.limit} 篇`);
  } else if (node.type === 'llm') {
    const src = p.prompt || p.content || '';
    parts.push(src.length > 60 ? `${src.slice(0, 60)}…` : src || '（含引用前序输出）');
  } else {
    if (p.title) parts.push(`标题「${p.title}」`);
    if (p.ref) parts.push(`正文 ← ${p.ref}`);
    else if (p.content) parts.push(p.content.length > 40 ? `${p.content.slice(0, 40)}…` : p.content);
  }
  return parts.join(' · ') || '（无参数）';
}

interface AiWorkflowViewProps {
  profileId: string;
}

export const AiWorkflowView = memo(function AiWorkflowView({ profileId }: AiWorkflowViewProps) {
  const [task, setTask] = useState('');
  const [nodes, setNodes] = useState<WfNode[]>([]);
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taskRef = useRef(task);
  taskRef.current = task;
  const profileIdRef = useRef(profileId);
  profileIdRef.current = profileId;

  const pushLog = useCallback((line: string) => {
    setLogs((prev) => [...prev.slice(-6), line]);
  }, []);

  // 复用 ai_chat 的一言问答（与 useAiChat.askOnce 同构），供规划器与 llm 节点使用
  const aiAsk = useCallback(async (system: string, userText: string): Promise<string> => {
    const reqId = uidp('wf_req');
    let acc = '';
    let resolveDone: (s: string) => void;
    let rejectDone: (e: unknown) => void;
    const done = new Promise<string>((res, rej) => { resolveDone = res; rejectDone = rej; });
    const unlis: UnlistenFn[] = [];
    unlis.push(await listen<{ requestId: string; delta: string }>('ai-delta', (e) => {
      if (e.payload.requestId !== reqId) return;
      acc += e.payload.delta;
    }));
    unlis.push(await listen<{ requestId: string }>('ai-done', (e) => {
      if (e.payload.requestId !== reqId) return;
      unlis.forEach((u) => u());
      resolveDone(acc);
    }));
    unlis.push(await listen<{ requestId: string; error: string }>('ai-error', (e) => {
      if (e.payload.requestId !== reqId) return;
      unlis.forEach((u) => u());
      rejectDone(new Error(e.payload.error));
    }));
    try {
      await invoke('ai_chat', {
        requestId: reqId,
        profileId: profileIdRef.current,
        messages: [{ role: 'user', content: userText }],
        stream: true,
        system,
      });
      return await done;
    } catch (err) {
      unlis.forEach((u) => u());
      throw err;
    }
  }, []);

  const generatePlan = useCallback(async () => {
    const t = taskRef.current.trim();
    if (!t || planning) return;
    setPlanning(true);
    setError(null);
    setSaved(false);
    setLogs([]);
    try {
      pushLog('AI 正在把需求拆解为蓝图节点…');
      const raw = await aiAsk(PLAN_SYSTEM, `需求：${t}\n请只输出工作流规划 JSON。`);
      const parsed = safeParsePlan(raw);
      if (!parsed) {
        setError('未能解析蓝图结构，请换一种描述再试。');
        pushLog('蓝图解析失败');
        setNodes([]);
        return;
      }
      setNodes(parsed.nodes);
      pushLog(`蓝图生成：${parsed.nodes.length} 个节点`);
      // 立即保存蓝图（复用同一 flowId；首次则新建）
      const fid = `wf_${Date.now()}`;
      setFlowId(fid);
      await invoke('workflow_save', { flowId: fid, name: t.slice(0, 24), json: { task: t, nodes: parsed.nodes } });
      setSaved(true);
    } catch (err) {
      console.error('[AiWorkflow] 生成蓝图失败:', err);
      setError('生成失败：' + String(err).slice(0, 120));
    } finally {
      setPlanning(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planning, aiAsk, pushLog]);

  const patchNode = useCallback((id: string, upd: Partial<WfNode>) => {
    setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, ...upd } : n)));
  }, []);

  const run = useCallback(async () => {
    if (running || !nodes.length) return;
    setRunning(true);
    setError(null);
    setLogs([]);
    const runId = uidp('run');
    const outputs = new Map<string, string>();
    try {
      for (const node of nodes) {
        patchNode(node.id, { status: 'running' });
        pushLog(`▶ ${node.label}`);
        try {
          let output = '';
          if (node.type === 'read_notes') {
            const res = await invoke<Array<{ id: string; title: string; excerpt: string }>>('aiwork_context_aggregate', {
              query: node.params.query || null,
              limit: node.params.limit ? Number(node.params.limit) : null,
            });
            output = res.map((r) => `【${r.title}】\n${r.excerpt}`).join('\n\n') || '（未检索到笔记）';
          } else if (node.type === 'llm') {
            const system = node.params.system || '你是办公助手，输出精炼、结构化。';
            const prompt = subRefs(node.params.prompt || node.params.content || '(请补充提示词)', outputs);
            output = await aiAsk(system, prompt);
          } else {
            // write_note：正文来自引用节点输出，或直接参数 content
            const title = subRefs(node.params.title || '工作流成果', outputs);
            const body = node.params.ref
              ? (outputs.get(node.params.ref) ?? '（引用节点无输出）')
              : subRefs(node.params.content || '(空正文)', outputs);
            const res = await invoke<{ noteId: string; title: string }>('aiwork_create_note', { title, content: body });
            output = `已落地笔记《${res.title}》 noteId=${res.noteId}`;
          }
          outputs.set(node.id, output);
          patchNode(node.id, { status: 'ok', output });
          pushLog(`✓ ${node.label}`);
          await invoke('workflow_log_append', { runId, nodeLabel: node.label, status: 'ok', detail: output.slice(0, 200) });
        } catch (e) {
          patchNode(node.id, { status: 'error', output: String(e).slice(0, 200) });
          pushLog(`✗ ${node.label}`);
          await invoke('workflow_log_append', { runId, nodeLabel: node.label, status: 'error', detail: String(e).slice(0, 200) });
          break; // 任一节点失败即中断
        }
      }
      if (flowId && nodes.length) {
        await invoke('workflow_save', { flowId, name: 'workflow', json: { nodes } });
      }
    } finally {
      setRunning(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, running, aiAsk, patchNode, pushLog, flowId]);

  const canRun = useMemo(() => nodes.length > 0 && !running && !planning, [nodes, running, planning]);
  const doneCount = useMemo(() => nodes.filter((n) => n.status === 'ok').length, [nodes]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      {/* 蓝图工作台标题栏 */}
      <div className="shrink-0 flex items-center gap-3 border-b border-neutral-200/60 px-5 py-3 dark:border-stone-700/60">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
          <Workflow size={16} />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-neutral-800 dark:text-stone-100">AI 工作流 · 对话式蓝图</div>
          <div className="truncate text-xs text-neutral-400 dark:text-stone-500">
            {nodes.length ? `${nodes.length} 个节点 · 已完成 ${doneCount}` : '描述一个任务，AI 把它变成可执行节点链'}
          </div>
        </div>
        {canRun && (
          <button
            onClick={run}
            className="btn-press ml-auto flex items-center gap-1.5 rounded-lg border border-violet-500/40 px-3 py-1.5 text-xs font-medium text-violet-600 transition-colors hover:bg-violet-500/10 dark:text-violet-400"
          >
            <Play size={14} /> 执行蓝图
          </button>
        )}
      </div>

      {/* 需求输入 + 生成蓝图 */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-3">
        <input
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generatePlan(); } }}
          placeholder="描述任务，例如：读取本周笔记，生成周报并存到笔记"
          className="h-9 flex-1 rounded-lg border border-neutral-300/60 bg-white/60 px-3 text-sm text-neutral-800 outline-none transition-colors focus:border-violet-400 dark:border-stone-700/60 dark:bg-stone-800/40 dark:text-stone-200"
        />
        <button
          onClick={generatePlan}
          disabled={planning || !task.trim()}
          className="btn-press flex items-center gap-1.5 rounded-lg bg-violet-600 px-3.5 py-2 text-xs font-medium text-white shadow-sm transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {planning ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
          生成蓝图
        </button>
      </div>

      {/* 节点链 */}
      <div className="relative flex-1 min-h-0 overflow-y-auto px-4 pb-4">
        {!nodes.length && !planning && (
          <div className="mt-10 flex flex-col items-center text-center text-neutral-400 dark:text-stone-500">
            <Workflow size={32} className="mb-3 opacity-40" />
            <div className="text-sm font-medium text-neutral-500 dark:text-stone-400">还没蓝图</div>
            <div className="mt-1 max-w-xs text-xs">在上方描述需求，AI 会把任务拆解为「读取 → 生成 → 写入」的可执行节点链。</div>
          </div>
        )}
        {planning && (
          <div className="mt-10 flex items-center justify-center gap-2 text-violet-500 dark:text-violet-400">
            <Loader2 size={16} className="animate-spin" /> 正在把需求拆解为蓝图…
          </div>
        )}
        {nodes.length > 0 && (
          <div className="space-y-2 pt-1">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 rounded-full border border-neutral-300/60 px-2.5 py-1 text-[11px] text-neutral-400 dark:border-stone-700/60 dark:text-stone-500">
                <FileText size={12} /> 对话式蓝图 · 只读 + 参数可调
              </div>
              {saved && (
                <div className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                  <Save size={12} /> 已保存
                </div>
              )}
            </div>
            {nodes.map((node) => (
              <div
                key={node.id}
                className={`rounded-xl border p-3 transition-colors ${
                  node.status === 'running'
                    ? 'border-violet-400/60 bg-violet-500/5'
                    : node.status === 'error'
                      ? 'border-red-400/50 bg-red-500/5'
                      : 'border-neutral-200/70 bg-white/50 dark:border-stone-700/60 dark:bg-stone-900/30'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`flex h-6 w-6 items-center justify-center rounded-md ${NODE_TINT[node.type]}`}>
                    {NODE_ICON[node.type]}
                  </span>
                  <span className="text-[11px] uppercase tracking-wide text-neutral-400 dark:text-stone-500">{node.id}</span>
                  <input
                    value={node.label}
                    onChange={(e) => patchNode(node.id, { label: e.target.value })}
                    className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-sm font-medium text-neutral-800 outline-none transition-colors hover:border-neutral-300 focus:border-violet-400 dark:text-stone-100"
                  />
                  {node.status === 'running' && <Loader2 size={14} className="animate-spin text-violet-500" />}
                  {node.status === 'ok' && <CheckCircle2 size={14} className="text-emerald-500" />}
                  {node.status === 'error' && <XCircle size={14} className="text-red-500" />}
                </div>
                <div className="mt-2 flex items-center gap-2 text-xs">
                  <span className={`shrink-0 rounded px-1.5 py-0.5 font-medium ${NODE_TINT[node.type]}`}>{TYPE_NAME[node.type]}</span>
                  <span className="min-w-0 flex-1 truncate text-neutral-400 dark:text-stone-500">{paramsSummary(node)}</span>
                </div>
                {node.output && (
                  <div className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-lg bg-black/5 px-2 py-1.5 text-xs text-neutral-500 dark:bg-black/30 dark:text-stone-400">
                    {node.output}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 运行日志 + 错误 */}
      {(logs.length > 0 || error) && (
        <div className="shrink-0 border-t border-neutral-200/60 px-5 py-2.5 dark:border-stone-700/60">
          {error && <div className="mb-1 flex items-center gap-1.5 text-xs text-red-500">{error}</div>}
          <div className="space-y-0.5 font-mono text-[11px] text-neutral-400 dark:text-stone-500">
            {logs.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </div>
      )}
    </div>
  );
});

AiWorkflowView.displayName = 'AiWorkflowView';