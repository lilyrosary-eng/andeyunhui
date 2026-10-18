// AIWorkflow（AIGC 工作流编蓝图）· 右侧节点连线画布 —— 纯内容区，不自带侧栏。
// 任务列表 / 新建 / 改名 / 删除 已并入共享侧栏（AiChatSidebar），由宿主 Root 托管状态。
// 画布基于 React Flow（@xyflow/react，MIT）：
//   - 左入右出端口（Handle），按住端口拖拽拉线 + 橡皮线 + 目标高亮，松手成边
//   - ctrl/⌘+滚轮缩放、空白拖拽平移、Shift+拖拽框选、MiniMap、Controls
//   - isValidConnection 连时即拦：自环 / 重复边 / 成环（不再等执行才报）
//   - Delete/Backspace 删选中节点或边；Ctrl+Z / Ctrl+Shift+Z 撤销重做；Ctrl+D 复制选中
//   - 拖动只在落帧时 commit（修掉旧实现每 pointermove 全量写 localStorage 的性能问题）
// 执行引擎与语义保持原样：Kahn 拓扑排序逐节点跑，prompt → llm（{ref} 引用）→ image（ComfyUI/云端）→ output（产物库）。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Workflow, Play, Wand2, Loader2, Plus, Trash2, Pencil, Brain, BookmarkCheck,
  LayoutGrid, Eraser, CircleDot, X, CheckCircle2, XCircle, Image as ImageIcon,
  Undo2, Redo2, Copy, Square,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position,
  useNodesState, useEdgesState, addEdge, useReactFlow, MarkerType, BackgroundVariant,
  type Node, type Edge, type Connection, type NodeChange, type NodeProps, type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { autoPos, type WorkflowDoc, type WfNode, type WfEdge, type WfNodeType } from '@/core/ai/aiWorkflows';
import { addProduct } from '@/core/ai/aiWorkProducts';
import { MediaOutput } from '@/components/MediaOutput';
import { convertGraphToApi } from '@/core/ai/comfyui/convert';
import { detectWorkflow } from '@/core/ai/comfyui/format';
import { getObjectInfo } from '@/core/ai/comfyui/objectInfo';
import { analyzeWorkflowParameters, applyWorkflowParameters, type Workflow as ComfyWorkflow } from '@/core/ai/comfyui/params';
import { loadSkillNotes, skillSummary } from '@/core/ai/comfyui/skills';
import { storage } from '@/core/storage';
import { KEYS } from '@/core/storage/keys';

const NODE_W = 216;

const TYPE_NAME: Record<WfNodeType, string> = { prompt: '起始输入', llm: '模型生成', image: '图像生成', output: '产出' };
const TYPE_ICON: Record<WfNodeType, React.ReactNode> = {
  prompt: <CircleDot size={15} />,
  llm: <Brain size={15} />,
  image: <ImageIcon size={15} />,
  output: <BookmarkCheck size={15} />,
};
const TYPE_TINT: Record<WfNodeType, string> = {
  prompt: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  llm: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  image: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
  output: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
};
/** MiniMap 节点配色（与 TYPE_TINT 语义色对应） */
const MINIMAP_COLOR: Record<WfNodeType, string> = {
  prompt: '#0ea5e9', llm: '#8b5cf6', image: '#f43f5e', output: '#10b981',
};
/** 每种节点的可编辑参数键 */
const TYPE_PARAMS: Record<WfNodeType, string[]> = {
  prompt: ['prompt'],
  llm: ['system', 'prompt'],
  image: ['prompt'],
  output: ['title', 'content'],
};

const DEFAULT_SYSTEM = '你是专业 AI 助手，输出精炼、结构清晰、可直接使用。';

const PLAN_SYSTEM = `你是「蓝图规划器」。用户给出一个 AIGC 任务需求，请拆解为一个可执行的工作流节点列表。
只输出一个严格 JSON 对象，不要 markdown 代码块、不要任何解释。格式：
{"nodes":[{"id":"n1","type":"prompt","label":"需求输入","params":{"prompt":"..."}},{"id":"n2","type":"llm","label":"草拟","params":{"system":"你是...","prompt":"请基于前文产出：\\n{ref:n1}"}},{"id":"n3","type":"output","label":"汇集成品","params":{"title":"成品标题","content":"{ref:n2}"}}]}
可用节点类型：
- prompt 起始/输入：params.prompt 为本节点提供的上下文文本
- llm 模型生成：params.system 为可选系统提示，params.prompt 为用户内容，可用 {ref:节点id} 引用前序输出
- image 图像生成：params.prompt 为画图提示词（可用 {ref:节点id} 引用前序文本作为画面描述），产出图片
- output 汇聚产出（作为终点）：params.title 为存入产物库时的名字，params.content 可写 {ref:节点id}，留空则自动汇聚上游全部输出
id 按 n1、n2、n3 顺序递增。通常以 output 收尾，把成果落到产物库。`;

function uidp(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 从原始 JSON 文本安全解析蓝图（容忍 markdown 包裹 / 前后杂讯）。 */
function parsePlan(raw: string): { nodes: WfNode[]; edges: WfEdge[] } | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1));
    const arr = obj?.nodes;
    if (!Array.isArray(arr)) return null;
    const ids: string[] = [];
    const nodes: WfNode[] = arr
      .filter((n: unknown) => n && typeof (n as { id?: unknown }).id === 'string')
      .map((n, i) => {
        const nn = n as { id: string; type?: string; label?: string; params?: Record<string, string> };
        const type: WfNodeType =
          nn.type === 'prompt' ? 'prompt' : nn.type === 'output' ? 'output' : nn.type === 'image' ? 'image' : 'llm';
        const id = typeof nn.id === 'string' ? nn.id : `n${i + 1}`;
        ids.push(id);
        return {
          id,
          type,
          label: typeof nn.label === 'string' && nn.label ? nn.label : TYPE_NAME[type],
          params: nn.params && typeof nn.params === 'object' ? nn.params : {},
          x: 0,
          y: 0,
          status: 'idle' as const,
        };
      });
    if (!nodes.length) return null;
    // 蓝图默认按序串联：n_{i} → n_{i+1}
    const edges: WfEdge[] = [];
    for (let i = 0; i < ids.length - 1; i++) {
      edges.push({ id: uidp('e'), source: ids[i], target: ids[i + 1] });
    }
    nodes.forEach((n, i) => {
      n.x = 48 + i * (NODE_W + 96);
      n.y = 80 + (i % 4) * 150;
    });
    return { nodes, edges };
  } catch {
    return null;
  }
}

/** 把字符串中的 {ref:节点id} 替换为前序输出 */
function subRefs(s: string, outputs: Map<string, string>): string {
  return s.replace(/\{ref:([\w]+)\}/g, (_, id) => outputs.get(id) ?? `[引用${id}无输出]`);
}

/** 拓扑排序（Kahn）。有环或不可达时返回 null。 */
function topoOrder(nodes: WfNode[], edges: WfEdge[]): string[] | null {
  const indeg: Record<string, number> = {};
  const adj: Record<string, string[]> = {};
  for (const n of nodes) { indeg[n.id] = 0; adj[n.id] = []; }
  for (const e of edges) {
    if (indeg[e.source] === undefined || indeg[e.target] === undefined) continue;
    adj[e.source].push(e.target);
    indeg[e.target]++;
  }
  const q: string[] = nodes.filter((n) => indeg[n.id] === 0).map((n) => n.id);
  const out: string[] = [];
  while (q.length) {
    const id = q.shift()!;
    out.push(id);
    for (const t of adj[id] || []) {
      indeg[t]--;
      if (indeg[t] === 0) q.push(t);
    }
  }
  return out.length === nodes.length ? out : null;
}

/* ============ React Flow 适配层 ============ */

type WfStatus = WfNode['status'];
// 注意：用 type 别名而非 interface——RF 的 Node<Data> 要求 Data 可赋 Record<string, unknown>，interface 缺索引签名会报错。
type WfNodeData = { label: string; params: Record<string, string>; status: WfStatus; output?: string };
type WfRfNode = Node<WfNodeData, WfNodeType>;

function wfToRf(n: WfNode): WfRfNode {
  return {
    id: n.id,
    type: n.type,
    position: { x: n.x, y: n.y },
    data: { label: n.label, params: n.params, status: n.status, output: n.output },
  };
}

/** 深拷贝快照（用于撤销栈；WfNode/WfEdge 均为纯数据） */
function snapDoc(d: WorkflowDoc): { nodes: WfNode[]; edges: WfEdge[] } {
  return {
    nodes: d.nodes.map((n) => ({ ...n, params: { ...n.params } })),
    edges: d.edges.map((e) => ({ ...e })),
  };
}

/** 自定义节点卡片：左入右出端口 + 状态/摘要/产出（含图） */
function WfCard({ data, selected, type }: NodeProps<WfRfNode>) {
  const t = (type ?? 'llm') as WfNodeType;
  return (
    <div
      className={`relative cursor-grab select-none rounded-xl border bg-white/90 shadow-sm backdrop-blur transition-shadow dark:bg-stone-900/80 ${
        selected ? 'border-violet-400 shadow-md ring-2 ring-violet-500/20' : 'border-neutral-200/80 hover:border-violet-300 dark:border-stone-700/70'
      } ${data.status === 'running' ? '!border-violet-400' : ''} ${data.status === 'error' ? '!border-red-400' : ''} ${data.status === 'ok' ? '!border-emerald-400' : ''}`}
      style={{ width: NODE_W }}
    >
      <Handle type="target" position={Position.Left} id="in" className="!h-2.5 !w-2.5 !border-violet-400 !bg-white dark:!bg-stone-900" />
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${TYPE_TINT[t]}`}>{TYPE_ICON[t]}</span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-neutral-800 dark:text-stone-100">{data.label}</span>
        {data.status === 'running' && <Loader2 size={13} className="animate-spin text-violet-500" />}
        {data.status === 'ok' && <CheckCircle2 size={13} className="text-emerald-500" />}
        {data.status === 'error' && <XCircle size={13} className="text-red-500" />}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 px-3 pb-2">
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${TYPE_TINT[t]}`}>{TYPE_NAME[t]}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-400 dark:text-stone-500">{summaryOf(t, data.params)}</span>
      </div>
      {data.output && (
        data.output.startsWith('data:image') || data.output.startsWith('data:video') || data.output.startsWith('data:audio') ? (
          <div className="mx-2 mb-2">
            <MediaOutput src={data.output} className="max-h-40 w-full rounded-md border border-neutral-200 object-cover dark:border-stone-700" />
          </div>
        ) : (
          <div className="mx-2 mb-2 max-h-16 overflow-y-auto rounded-md bg-black/5 px-2 py-1.5 text-[11px] leading-relaxed text-neutral-500 dark:bg-black/30 dark:text-stone-400">
            {data.output}
          </div>
        )
      )}
      <Handle type="source" position={Position.Right} id="out" className="!h-2.5 !w-2.5 !border-emerald-500 !bg-white dark:!bg-stone-900" />
    </div>
  );
}

// nodeTypes 必须模块级常量：组件内联对象会导致 RF 每次渲染重建节点（告警 + 性能损失）。
const nodeTypes: NodeTypes = { prompt: WfCard, llm: WfCard, image: WfCard, output: WfCard };

interface MenuState { x: number; y: number; nodeId?: string }

export interface AiWorkflowViewProps {
  profileId: string;
  /** 当前活动任务文档（由宿主通过 useAiWorkflows 提供） */
  doc: WorkflowDoc | null;
  /** 变更活动文档的回调（宿主 updateActive） */
  onUpdate: (fn: (d: WorkflowDoc) => WorkflowDoc) => void;
}

function AiWorkflowCanvas({ profileId, doc, onUpdate }: AiWorkflowViewProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState(false);
  // 进行中的「生成蓝图」请求 id（供停止）+ 已停止标记。
  // 标记用于**丢弃半截结果**：蓝图是 JSON，截断后必然解析失败，但那句
  // 「未能解析蓝图结构，请换一种描述再试」会误导用户以为是自己的描述有问题。
  const wfReqRef = useRef<string | null>(null);
  const wfStoppedRef = useRef(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);

  const [nodes, setNodes, onNodesChange] = useNodesState<WfRfNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // ref 镜像统一在 effect 里同步（渲染期写 ref 违反 react-hooks/refs）。
  // 这些 ref 只被 RF 回调 / IPC 回调 / 用户事件读取，都在 commit 之后发生，effect 已跑完，不会读到陈旧值。
  const edgesRef = useRef(edges);
  const docRef = useRef(doc);
  useEffect(() => { edgesRef.current = edges; });
  useEffect(() => { docRef.current = doc; });

  // RF 内部状态先改、再推 doc 时置位，让 doc→RF 同步跳过一轮（否则会用旧 doc 覆盖刚拖好的位置）
  const skipSync = useRef(false);
  // 撤销/重做栈本身仍是 refs（避免每次提交都重建大数组），但「栈深度」进 state，
  // 工具栏可用态由 state 驱动——渲染期读 ref.length 违反 react-hooks/refs。
  const past = useRef<{ nodes: WfNode[]; edges: WfEdge[] }[]>([]);
  const future = useRef<{ nodes: WfNode[]; edges: WfEdge[] }[]>([]);
  const [histDepth, setHistDepth] = useState({ past: 0, future: 0 });
  const bumpHist = useCallback(() => {
    setHistDepth({ past: past.current.length, future: future.current.length });
  }, []);

  const profileIdRef = useRef(profileId);
  useEffect(() => { profileIdRef.current = profileId; });
  const { screenToFlowPosition, fitView } = useReactFlow();
  const didFit = useRef(false);

  // 跟随应用明暗主题（class 策略），保证 RF 的边/手柄/背景在暗色下可见
  const [dark, setDark] = useState(() => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  const pushLog = useCallback((line: string) => {
    setLogs((prev) => [...prev.slice(-5), line]);
  }, []);

  /* ============ 带历史的文档提交 ============ */
  const commit = useCallback((fn: (d: WorkflowDoc) => WorkflowDoc) => {
    const d = docRef.current;
    if (!d) return;
    past.current = [...past.current.slice(-49), snapDoc(d)];
    future.current = [];
    onUpdate(fn);
    bumpHist();
  }, [onUpdate, bumpHist]);

  const undo = useCallback(() => {
    const d = docRef.current;
    const prev = past.current.pop();
    if (!d || !prev) return;
    future.current = [...future.current, snapDoc(d)];
    onUpdate((cur) => ({ ...cur, nodes: prev.nodes, edges: prev.edges }));
    bumpHist();
  }, [onUpdate, bumpHist]);

  const redo = useCallback(() => {
    const d = docRef.current;
    const nxt = future.current.pop();
    if (!d || !nxt) return;
    past.current = [...past.current, snapDoc(d)];
    onUpdate((cur) => ({ ...cur, nodes: nxt.nodes, edges: nxt.edges }));
    bumpHist();
  }, [onUpdate, bumpHist]);

  /* ============ doc → RF 同步（外部变更：切任务/生成蓝图/执行态/撤销） ============ */
  useEffect(() => {
    if (skipSync.current) { skipSync.current = false; return; }
    if (!doc) { setNodes([]); setEdges([]); return; }
    const statusById = new Map(doc.nodes.map((n) => [n.id, n.status]));
    setNodes(doc.nodes.map(wfToRf));
    setEdges(doc.edges.map((e) => ({ ...e, animated: statusById.get(e.source) === 'running' })));
  }, [doc, setNodes, setEdges]);

  // 首次拿到节点时适配视野
  useEffect(() => {
    if (!didFit.current && nodes.length) {
      didFit.current = true;
      fitView({ padding: 0.25 });
    }
  }, [nodes, fitView]);

  /* ============ AI 一言问答（复用 ai_chat 流式事件） ============ */
  const aiAsk = useCallback(async (system: string, userText: string): Promise<string> => {
    const reqId = uidp('wf');
    let acc = '';
    let resolveDone!: (s: string) => void;
    let rejectDone!: (e: unknown) => void;
    const done = new Promise<string>((res, rej) => { resolveDone = res; rejectDone = rej; });
    const un: UnlistenFn[] = [];
    wfReqRef.current = reqId;
    un.push(await listen<{ requestId: string; delta: string }>('ai-delta', (e) => {
      if (e.payload.requestId !== reqId) return;
      acc += e.payload.delta;
    }));
    un.push(await listen<{ requestId: string }>('ai-done', (e) => {
      if (e.payload.requestId !== reqId) return;
      if (wfReqRef.current === reqId) wfReqRef.current = null;
      un.forEach((u) => u()); resolveDone(acc);
    }));
    un.push(await listen<{ requestId: string; error: string }>('ai-error', (e) => {
      if (e.payload.requestId !== reqId) return;
      if (wfReqRef.current === reqId) wfReqRef.current = null;
      un.forEach((u) => u()); rejectDone(new Error(e.payload.error));
    }));
    try {
      await invoke('ai_chat', {
        requestId: reqId, profileId: profileIdRef.current,
        // 同 useAiChat：ai_chat 恒流式，没有 stream 参数，这个键只会被静默忽略。
        messages: [{ role: 'user', content: userText }], system,
      });
      return await done;
    } catch (err) {
      un.forEach((u) => u()); throw err;
    }
  }, []);

  /* ============ 按任务生成蓝图 ============ */
  const generateBlueprint = useCallback(async () => {
    if (!doc || planning || running) return;
    const t = doc.task.trim();
    if (!t) { setError('请先在任务描述里写一句需求'); return; }
    setPlanning(true); setError(null); setLogs([]); setMenu(null);
    wfStoppedRef.current = false;
    try {
      // L3 披露：蓝图指定了工作流且有备注时，把备注拼进规划系统提示，AI 按适配场景/参数建议/已知坑规划
      const bpSlug = storage.getString(KEYS.ai.comfyuiBlueprintWfSlug.key, '').trim();
      const bpNotes = bpSlug ? loadSkillNotes(bpSlug).trim() : '';
      const notesSection = bpNotes
        ? `\n\n【当前生图节点将使用的 ComfyUI 工作流备注（规划时请参考：适配场景 / 参数建议 / 已知坑）】\n${bpNotes}`
        : '';
      const raw = await aiAsk(PLAN_SYSTEM + notesSection, `需求：${t}\n请只输出工作流规划 JSON。`);
      // 用户已点「停止」→ 丢弃（截断的 JSON 必然解析失败，那条报错会误导向"描述有问题"）
      if (wfStoppedRef.current) return;
      const parsed = parsePlan(raw);
      if (!parsed) { setError('未能解析蓝图结构，请换一种描述再试。'); return; }
      commit((d) => ({ ...d, nodes: parsed.nodes, edges: parsed.edges }));
      pushLog(`蓝图生成：${parsed.nodes.length} 个节点、${parsed.edges.length} 条连线`);
    } catch (err) {
      setError('生成失败：' + String(err).slice(0, 120));
    } finally {
      setPlanning(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, planning, running, aiAsk, commit, pushLog]);

  /** 停止蓝图生成：标记已停 → 后端取消 → 本地复位（`aiAsk` 的 promise 会随后自行收尾）。 */
  const stopPlan = useCallback(() => {
    const rid = wfReqRef.current;
    if (!rid) return;
    wfStoppedRef.current = true;
    wfReqRef.current = null;
    setPlanning(false);
    void invoke('ai_chat_cancel', { requestId: rid }).catch(() => {});
  }, []);

  /* ============ 节点/边操作 ============ */
  const addNode = useCallback((type: WfNodeType) => {
    const existing = docRef.current?.nodes ?? [];
    const id = uidp('n');
    const center = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const pos = existing.length
      ? { x: Math.max(0, Math.round(center.x - NODE_W / 2)), y: Math.max(0, Math.round(center.y - 40)) }
      : autoPos(existing);
    const defaults: Record<string, string> =
      type === 'prompt' ? { prompt: '输入本节点要提供的上下文…' }
      : type === 'llm' ? { system: DEFAULT_SYSTEM, prompt: '' }
      : type === 'image' ? { prompt: '' }
      : { title: 'AI 成果', content: '' };
    const node: WfNode = { id, type, label: TYPE_NAME[type], ...pos, params: defaults, status: 'idle' };
    commit((d) => ({ ...d, nodes: [...d.nodes, node] }));
    setEditingId(id); setMenu(null);
  }, [commit, screenToFlowPosition]);

  /** 属性栏编辑（入撤销栈） */
  const editNode = useCallback((id: string, upd: Partial<WfNode>) => {
    commit((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, ...upd } : n)) }));
  }, [commit]);

  /** 执行态补丁（不入栈，避免 run 过程刷爆撤销历史） */
  const patchNode = useCallback((id: string, upd: Partial<WfNode>) => {
    onUpdate((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, ...upd } : n)) }));
  }, [onUpdate]);

  const deleteNode = useCallback((id: string) => {
    commit((d) => ({
      ...d,
      nodes: d.nodes.filter((n) => n.id !== id),
      edges: d.edges.filter((e) => e.source !== id && e.target !== id),
    }));
    setEditingId((s) => (s === id ? null : s));
    setMenu(null);
  }, [commit]);

  const deleteEdge = useCallback((edgeId: string) => {
    commit((d) => ({ ...d, edges: d.edges.filter((e) => e.id !== edgeId) }));
    setMenu(null);
  }, [commit]);

  /** 按边分层重排（最长路径分层；环兜底为 0 层） */
  const autoLayout = useCallback(() => {
    const d = docRef.current;
    if (!d || !d.nodes.length) return;
    const preds = new Map<string, string[]>();
    for (const n of d.nodes) preds.set(n.id, []);
    for (const e of d.edges) if (preds.has(e.target)) preds.get(e.target)!.push(e.source);
    const layer = new Map<string, number>();
    const visiting = new Set<string>();
    const layerOf = (id: string): number => {
      const cached = layer.get(id);
      if (cached !== undefined) return cached;
      if (visiting.has(id)) return 0;
      visiting.add(id);
      let L = 0;
      for (const p of preds.get(id) ?? []) L = Math.max(L, layerOf(p) + 1);
      visiting.delete(id);
      layer.set(id, L);
      return L;
    };
    const positioned = new Map<string, { x: number; y: number }>();
    const perLayer = new Map<number, number>();
    for (const n of d.nodes) {
      const L = layerOf(n.id);
      const i = perLayer.get(L) ?? 0;
      perLayer.set(L, i + 1);
      positioned.set(n.id, { x: 48 + L * (NODE_W + 96), y: 80 + i * 150 });
    }
    commit((dd) => ({ ...dd, nodes: dd.nodes.map((n) => (positioned.has(n.id) ? { ...n, ...positioned.get(n.id)! } : n)) }));
    setMenu(null);
  }, [commit]);

  const clearCanvas = useCallback(() => {
    commit((d) => ({ ...d, nodes: [], edges: [] }));
    setEditingId(null); setMenu(null);
  }, [commit]);

  const duplicateSelected = useCallback(() => {
    const ids = selectedNodeIds;
    if (!ids.length) return;
    commit((d) => {
      const clones = d.nodes
        .filter((n) => ids.includes(n.id))
        .map((n) => ({ ...n, id: uidp('n'), x: n.x + 48, y: n.y + 48, label: `${n.label} 副本`, params: { ...n.params }, status: 'idle' as const, output: undefined }));
      return { ...d, nodes: [...d.nodes, ...clones] };
    });
  }, [selectedNodeIds, commit]);

  /* ============ RF 事件 → doc ============ */
  const handleNodesChange = useCallback((changes: NodeChange<WfRfNode>[]) => {
    onNodesChange(changes);
    // 只在拖动落帧时 commit（dragging:false），消灭每帧写盘
    const moved = changes
      .filter((c) => c.type === 'position' && 'id' in c && !(c as { dragging?: boolean }).dragging && (c as { position?: unknown }).position)
      .map((c) => ({ id: (c as { id: string }).id, position: (c as unknown as { position: { x: number; y: number } }).position }));
    if (moved.length) {
      const pos = new Map(moved.map((m) => [m.id, m.position]));
      skipSync.current = true;
      commit((d) => ({ ...d, nodes: d.nodes.map((n) => (pos.has(n.id) ? { ...n, x: pos.get(n.id)!.x, y: pos.get(n.id)!.y } : n)) }));
    }
  }, [onNodesChange, commit]);

  const handleNodesDelete = useCallback((deleted: Node[]) => {
    const ids = new Set(deleted.map((n) => n.id));
    skipSync.current = true;
    commit((d) => ({
      ...d,
      nodes: d.nodes.filter((n) => !ids.has(n.id)),
      edges: d.edges.filter((e) => !ids.has(e.source) && !ids.has(e.target)),
    }));
    setEditingId((s) => (s && ids.has(s) ? null : s));
  }, [commit]);

  const handleEdgesDelete = useCallback((deleted: Edge[]) => {
    const ids = new Set(deleted.map((e) => e.id));
    skipSync.current = true;
    commit((d) => ({ ...d, edges: d.edges.filter((e) => !ids.has(e.id)) }));
  }, [commit]);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return;
    if (edgesRef.current.some((e) => e.source === c.source && e.target === c.target)) return;
    const edge: Edge = {
      id: uidp('e'),
      source: c.source,
      target: c.target,
      sourceHandle: c.sourceHandle ?? undefined,
      targetHandle: c.targetHandle ?? undefined,
    };
    setEdges((eds) => addEdge(edge, eds));
    skipSync.current = true;
    commit((d) => (
      d.edges.some((e) => e.source === edge.source && e.target === edge.target)
        ? d
        : { ...d, edges: [...d.edges, { id: edge.id, source: edge.source, target: edge.target }] }
    ));
  }, [setEdges, commit]);

  /** 连时校验：禁自环 / 禁重复边 / 禁成环（BFS 可达性） */
  const isValidConnection = useCallback((c: Connection | Edge): boolean => {
    const source = c.source;
    const target = c.target;
    if (!source || !target || source === target) return false;
    if (edgesRef.current.some((e) => e.source === source && e.target === target)) return false;
    const adj = new Map<string, string[]>();
    for (const e of edgesRef.current) {
      if (!adj.has(e.source)) adj.set(e.source, []);
      adj.get(e.source)!.push(e.target);
    }
    const seen = new Set<string>();
    const stack = [target];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === source) return false;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const nx of adj.get(cur) ?? []) stack.push(nx);
    }
    return true;
  }, []);

  /* ============ 右键菜单 ============ */
  const onPaneContextMenu = useCallback((e: React.MouseEvent | MouseEvent) => {
    e.preventDefault();
    setEditingId(null);
    setMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    e.preventDefault();
    e.stopPropagation();
    setEditingId(node.id);
    setMenu({ x: e.clientX, y: e.clientY, nodeId: node.id });
  }, []);

  /* ============ 快捷键（输入框内不拦截） ============ */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (k === 'y') { e.preventDefault(); redo(); }
      else if (k === 'd') { e.preventDefault(); duplicateSelected(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, duplicateSelected]);

  /* ============ 执行蓝图（拓扑序逐节点跑，语义与原版一致） ============ */
  const run = useCallback(async () => {
    if (!doc || running || planning) return;
    const nodes = doc.nodes;
    const edges = doc.edges;
    if (!nodes.length) { setError('画布还没有节点'); return; }
    const order = topoOrder(nodes, edges);
    if (!order) { setError('检测到环/孤立，无法确定执行顺序，请先修正连线'); return; }
    setRunning(true); setError(null); setLogs([]);
    const outputs = new Map<string, string>();
    onUpdate((d) => ({ ...d, nodes: d.nodes.map((n) => ({ ...n, status: 'idle' as const, output: undefined })) }));
    try {
      for (const id of order) {
        const node = nodes.find((n) => n.id === id);
        if (!node) continue;
        patchNode(id, { status: 'running' });
        pushLog(`▶ ${node.label}`);
        try {
          let output = '';
          if (node.type === 'prompt') {
            output = subRefs(node.params.prompt || '', outputs);
          } else if (node.type === 'llm') {
            const system = node.params.system || DEFAULT_SYSTEM;
            const prompt = subRefs(node.params.prompt || node.label, outputs);
            output = await aiAsk(system, prompt);
          } else if (node.type === 'image') {
            // 图像生成：prompt 支持 {ref:前序文本}。三条路由（按优先级）：
            //   ① 蓝图指定了 ComfyUI 工作流（KEYS.ai.comfyuiBlueprintWf，设置面板里标记）：
            //      读文件 →（UI 图则拉 object_info 转换成 API）→ 参数分析 → 把 prompt 填进
            //      该工作流的提示词参数 → 提交。复用用户在 ComfyUI 里调好的工作流。
            //   ② 配了 ComfyUI 端点+checkpoint：内置最小 txt2img。
            //   ③ 回落云端 image_model（ai_generate_image，per-profile）。
            const prompt = subRefs(node.params.prompt || node.label, outputs);
            const comfyUrl = storage.getString(KEYS.ai.comfyuiUrl.key, '').trim();
            const comfyCkpt = storage.getString(KEYS.ai.comfyuiCkpt.key, '').trim();
            const bpWf = storage.getString(KEYS.ai.comfyuiBlueprintWf.key, '').trim();
            if (comfyUrl && bpWf) {
              // 运行可见：蓝图工作流有备注时，先把摘要写进运行日志（软披露）
              const bpNotes = storage.getString(KEYS.ai.comfyuiBlueprintWfSlug.key, '').trim();
              if (bpNotes) {
                const n = loadSkillNotes(bpNotes);
                if (n) pushLog(`工作流备注: ${skillSummary(n)}`);
              }
              const json = await invoke<unknown>('comfyui_read_workflow', { path: bpWf });
              const kind = detectWorkflow(json);
              if (kind === 'unknown') throw new Error('蓝图指定的工作流文件无法识别（既非 UI 画布图也非 API 工作流）');
              const info = await getObjectInfo(comfyUrl).catch(() => undefined);
              let apiWf: ComfyWorkflow;
              if (kind === 'ui') {
                if (!info) throw new Error('获取 ComfyUI 节点定义（object_info）失败，无法转换 UI 画布图');
                const res = convertGraphToApi(json, info);
                if (!res.ok) throw new Error(`工作流转换失败: ${res.error}`);
                apiWf = res.workflow;
              } else {
                apiWf = json as ComfyWorkflow;
              }
              const params = analyzeWorkflowParameters(apiWf, info);
              const promptParam = params.find((p) => p.type === 'string' && (p.name === 'prompt' || p.name.startsWith('prompt')));
              if (!promptParam) throw new Error('该工作流没有可填的提示词参数（未找到 prompt 类文本输入）');
              const finalWf = applyWorkflowParameters(apiWf, params, { [promptParam.name]: prompt }, info);
              output = await invoke<string>('comfyui_generate_media', { comfyuiUrl: comfyUrl, workflow: finalWf });
            } else if (comfyUrl && comfyCkpt) {
              output = await invoke<string>('comfyui_generate_media', { prompt, comfyuiUrl: comfyUrl, checkpoint: comfyCkpt });
            } else {
              output = await invoke<string>('ai_generate_image', { prompt, profileId: profileIdRef.current });
            }
          } else {
            let body = '';
            if (node.params.content && node.params.content.trim()) {
              body = subRefs(node.params.content, outputs);
            } else {
              const ins = edges.filter((e) => e.target === id).map((e) => outputs.get(e.source));
              body = ins.filter(Boolean).join('\n\n') || '(无上游输出)';
            }
            const title = subRefs(node.params.title || node.label, outputs);
            await addProduct(body, title);
            output = `已产出《${title}》并存入产物库`;
          }
          outputs.set(id, output);
          patchNode(id, { status: 'ok', output });
          pushLog(`✓ ${node.label}`);
        } catch (e) {
          patchNode(id, { status: 'error', output: String(e).slice(0, 200) });
          pushLog(`✗ ${node.label}`);
          break;
        }
      }
      if (order.length) pushLog('执行结束，进度与产出已保存');
    } finally {
      setRunning(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, running, planning, aiAsk, patchNode, onUpdate, pushLog]);

  const editingNode = useMemo(
    () => (doc && editingId ? doc.nodes.find((n) => n.id === editingId) ?? null : null),
    [doc, editingId],
  );
  const selectedId = selectedNodeIds[0] ?? null;
  const activeEdgesForSel = useMemo(() => {
    if (!doc || !selectedId) return [];
    return doc.edges.filter((e) => e.source === selectedId || e.target === selectedId);
  }, [doc, selectedId]);

  const canRun = !!doc && doc.nodes.length > 0 && !running && !planning;

  // 菜单防屏幕边缘裁剪
  const menuPos = menu
    ? { left: Math.min(menu.x, Math.max(8, (typeof window !== 'undefined' ? window.innerWidth : 0) - 210)), top: Math.min(menu.y, Math.max(8, (typeof window !== 'undefined' ? window.innerHeight : 0) - 260)) }
    : null;

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      {/* 顶部标题栏 */}
      <div className="shrink-0 flex items-center gap-3 border-b border-neutral-200/60 px-5 py-3 dark:border-stone-700/60">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
          <Workflow size={16} />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-neutral-800 dark:text-stone-100">AI 工作流 · 节点画布</div>
          <div className="truncate text-xs text-neutral-400 dark:text-stone-500">
            {doc
              ? `${doc.nodes.length} 节点 / ${doc.edges.length} 连线 · 拖端口连线, 滚轮缩放, 右键菜单`
              : '先在左侧新建一个任务'}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <button onClick={undo} disabled={histDepth.past === 0} title="撤销 (Ctrl+Z)"
            className="btn-press rounded-lg p-1.5 text-neutral-400 transition-colors hover:bg-black/5 hover:text-neutral-600 disabled:opacity-30 dark:hover:bg-white/5 dark:hover:text-stone-300">
            <Undo2 size={15} />
          </button>
          <button onClick={redo} disabled={histDepth.future === 0} title="重做 (Ctrl+Shift+Z)"
            className="btn-press rounded-lg p-1.5 text-neutral-400 transition-colors hover:bg-black/5 hover:text-neutral-600 disabled:opacity-30 dark:hover:bg-white/5 dark:hover:text-stone-300">
            <Redo2 size={15} />
          </button>
          <button onClick={duplicateSelected} disabled={!selectedNodeIds.length} title="复制选中节点 (Ctrl+D)"
            className="btn-press rounded-lg p-1.5 text-neutral-400 transition-colors hover:bg-black/5 hover:text-neutral-600 disabled:opacity-30 dark:hover:bg-white/5 dark:hover:text-stone-300">
            <Copy size={15} />
          </button>
          {canRun && (
            <button
              onClick={run}
              className="btn-press ml-1 flex items-center gap-1.5 rounded-lg border border-violet-500/40 px-3 py-1.5 text-xs font-medium text-violet-600 transition-colors hover:bg-violet-500/10 dark:text-violet-400"
            >
              <Play size={14} /> 执行蓝图
            </button>
          )}
        </div>
      </div>

      {/* 任务描述 + 生成蓝图 */}
      {doc && (
        <div className="shrink-0 flex items-center gap-2 border-b border-neutral-200/60 px-4 py-2.5 dark:border-stone-700/60">
          <input
            value={doc.task}
            onChange={(e) => onUpdate((d) => ({ ...d, task: e.target.value }))}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); generateBlueprint(); } }}
            className="h-8 min-w-0 flex-1 rounded-lg border border-neutral-300/60 bg-white/60 px-3 text-xs text-neutral-800 outline-none transition-colors focus:border-violet-400 dark:border-stone-700/60 dark:bg-stone-800/40 dark:text-stone-200"
            placeholder="用一句话描述任务，例如：构思短视频脚本并按分镜展开成成稿，回车生成蓝图"
          />
          {/* 规划中 → 同一位置变「停止规划」（此前 disabled，长规划无法叫停） */}
          <button
            onClick={() => (planning ? stopPlan() : void generateBlueprint())}
            disabled={!planning && (running || !doc.task.trim())}
            className={`btn-press flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${planning ? 'bg-neutral-700 hover:bg-neutral-800 dark:bg-stone-600 dark:hover:bg-stone-500' : 'bg-violet-600 hover:bg-violet-700'}`}
          >
            {planning ? <Square size={13} /> : <Wand2 size={14} />}
            {planning ? '停止规划' : '生成蓝图'}
          </button>
        </div>
      )}

      {/* 画布（React Flow） */}
      <div className="relative m-3 min-h-0 flex-1 overflow-hidden rounded-xl border border-neutral-200/60 dark:border-stone-700/60">
        {!doc ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-400 dark:text-stone-500">
            ← 先在左侧新建一个任务
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onNodesDelete={handleNodesDelete}
            onEdgesDelete={handleEdgesDelete}
            onNodeContextMenu={onNodeContextMenu}
            onPaneContextMenu={onPaneContextMenu}
            onNodeDoubleClick={(_, node) => setEditingId(node.id)}
            onSelectionChange={({ nodes: sel }) => setSelectedNodeIds(sel.map((n) => n.id))}
            nodeTypes={nodeTypes}
            defaultEdgeOptions={{
              type: 'default',
              markerEnd: { type: MarkerType.ArrowClosed, color: 'rgba(124,58,237,0.7)' },
              style: { stroke: 'rgba(124,58,237,0.55)', strokeWidth: 1.6 },
            }}
            snapToGrid
            snapGrid={[22, 22]}
            deleteKeyCode={['Delete', 'Backspace']}
            selectionOnDrag
            selectionKeyCode="Shift"
            multiSelectionKeyCode="MetaOrControl"
            minZoom={0.2}
            maxZoom={2}
            fitView
            fitViewOptions={{ padding: 0.25 }}
            colorMode={dark ? 'dark' : 'light'}
            className="bg-transparent"
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} color={dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)'} />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              nodeStrokeWidth={3}
              nodeColor={(n) => MINIMAP_COLOR[(n.type as WfNodeType) ?? 'llm']}
              maskColor={dark ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.06)'}
            />
          </ReactFlow>
        )}

        {/* 空画布提示 + 快捷新建 */}
        {doc && doc.nodes.length === 0 && !planning && !running && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center text-neutral-400 dark:text-stone-500">
            <GitBranchPlaceholder />
            <div className="text-sm font-medium text-neutral-500 dark:text-stone-400">画布为空</div>
            <div className="mt-1 max-w-xs text-xs">右键空白处新建节点，或在上方输入需求「生成蓝图」。</div>
          </div>
        )}
        {doc && doc.nodes.length === 0 && !planning && !running && (
          <button
            onClick={() => addNode('prompt')}
            className="absolute right-8 top-4 z-20 flex items-center gap-1 rounded-lg border border-violet-500/40 bg-white/90 px-3 py-1.5 text-xs font-medium text-violet-600 shadow-sm transition-colors hover:bg-violet-50 dark:bg-stone-800/90 dark:text-violet-400 dark:hover:bg-stone-700/70"
          >
            <Plus size={14} /> 新建起始节点
          </button>
        )}
      </div>

      {/* 选中节点：属性底栏 */}
      {editingNode && (
        <div className="shrink-0 border-t border-neutral-200/60 px-4 py-3 dark:border-stone-700/60">
          <div className="mb-2 flex items-center gap-2">
            <span className={`flex h-6 w-6 items-center justify-center rounded-md ${TYPE_TINT[editingNode.type]}`}>{TYPE_ICON[editingNode.type]}</span>
            <input
              value={editingNode.label}
              onChange={(e) => editNode(editingNode.id, { label: e.target.value })}
              className="h-7 w-44 rounded-lg border border-transparent bg-transparent px-2 text-sm font-semibold text-neutral-800 outline-none transition-colors hover:border-neutral-300 focus:border-violet-400 dark:text-stone-100"
            />
            <span className="text-[11px] text-neutral-400 dark:text-stone-500">[{TYPE_NAME[editingNode.type]}]</span>
            <div className="flex items-center gap-1">
              {(['prompt', 'llm', 'image', 'output'] as WfNodeType[]).map((t) => (
                <button
                  key={t}
                  onClick={() => editNode(editingNode.id, { type: t })}
                  className={`btn-press rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                    editingNode.type === t ? 'bg-violet-500/10 text-violet-600 dark:text-violet-400' : 'text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5'
                  }`}
                >
                  {TYPE_NAME[t]}
                </button>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button onClick={() => deleteNode(editingNode.id)} className="btn-press flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-red-500 hover:bg-red-500/10">
                <Trash2 size={13} /> 删除
              </button>
              <button onClick={() => setEditingId(null)} className="btn-press rounded-md p-1 text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-300" title="关闭">
                <X size={14} />
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {TYPE_PARAMS[editingNode.type].map((k) => (
              <label key={k} className="flex items-center gap-2 text-xs text-neutral-500 dark:text-stone-400">
                <span className="w-16 shrink-0">{k}</span>
                <input
                  value={editingNode.params[k] ?? ''}
                  onChange={(e) => editNode(editingNode.id, { params: { ...editingNode.params, [k]: e.target.value } })}
                  placeholder={k}
                  className="h-7 min-w-0 flex-1 rounded-lg border border-neutral-300/60 bg-white/60 px-2 text-xs text-neutral-800 outline-none transition-colors focus:border-violet-400 dark:border-stone-700/60 dark:bg-stone-800/40 dark:text-stone-200"
                />
              </label>
            ))}
            {activeEdgesForSel.length > 0 && (
              <div className="col-span-2 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-400 dark:text-stone-500">
                <span>连线：</span>
                {activeEdgesForSel.map((e) => {
                  const otherId = e.source === editingNode.id ? e.target : e.source;
                  const other = doc?.nodes.find((n) => n.id === otherId);
                  return (
                    <span key={e.id} className="flex items-center gap-1 rounded-md bg-black/5 px-1.5 py-0.5 dark:bg-white/5">
                      {other?.label ?? otherId}
                      <button onClick={() => deleteEdge(e.id)} className="text-neutral-400 hover:text-red-500" title="删连线">
                        <X size={11} />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 运行日志 + 错误 */}
      {(logs.length > 0 || error) && (
        <div className="shrink-0 border-t border-neutral-200/60 px-5 py-2.5 dark:border-stone-700/60">
          {error && <div className="mb-1 flex items-center gap-1.5 text-xs text-red-500">{error}</div>}
          <div className="space-y-0.5 font-mono text-[11px] text-neutral-400 dark:text-stone-500">
            {logs.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </div>
      )}

      {/* ===== 右键上下文菜单（节点 / 空白画布） ===== */}
      {menu && menuPos && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div
            className="fixed z-50 min-w-[180px] overflow-hidden rounded-xl border border-neutral-200/80 bg-white/95 p-1 shadow-xl backdrop-blur dark:border-stone-700/70 dark:bg-stone-900/95"
            style={{ left: menuPos.left, top: menuPos.top }}
            onClick={(e) => e.stopPropagation()}
          >
            {menu.nodeId ? (
              <>
                <div className="px-3 py-1.5 text-[11px] font-semibold text-neutral-400 dark:text-stone-500">节点</div>
                <MenuItem onClick={() => { setEditingId(menu.nodeId!); setMenu(null); }} icon={<Pencil size={14} />} label="编辑参数 / 改名" />
                <div className="my-1 px-3 text-[10px] leading-relaxed text-neutral-400 dark:text-stone-500">按住右侧端口拖到别的节点左侧即可连线</div>
                <MenuSep />
                <MenuItem onClick={() => deleteNode(menu.nodeId!)} icon={<Trash2 size={14} />} label="删除节点" danger />
              </>
            ) : (
              <>
                <div className="px-3 py-1.5 text-[11px] font-semibold text-neutral-400 dark:text-stone-500">新建节点</div>
                <MenuItem onClick={() => addNode('prompt')} icon={TYPE_ICON.prompt} label="起始输入 (prompt)" />
                <MenuItem onClick={() => addNode('llm')} icon={TYPE_ICON.llm} label="模型生成 (llm)" />
                <MenuItem onClick={() => addNode('image')} icon={TYPE_ICON.image} label="图像生成 (image)" />
                <MenuItem onClick={() => addNode('output')} icon={TYPE_ICON.output} label="产出 (output)" />
                <MenuSep />
                <MenuItem onClick={generateBlueprint} icon={<Wand2 size={14} />} label="按任务生成蓝图" />
                <MenuItem onClick={autoLayout} icon={<LayoutGrid size={14} />} label="按连线分层重排" />
                <MenuItem onClick={clearCanvas} icon={<Eraser size={14} />} label="清空画布" danger />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** 空画布占位图标（避免在 JSX 条件里直接写大组件） */
function GitBranchPlaceholder() {
  return (
    <span className="mb-2 flex h-14 w-14 items-center justify-center rounded-2xl bg-black/5 dark:bg-white/5">
      <LayoutGrid size={26} className="opacity-40" />
    </span>
  );
}

/** 节点参数摘要（展示用） */
function summaryOf(type: WfNodeType, p: Record<string, string>): string {
  if (type === 'prompt') return p.prompt || '（空输入）';
  if (type === 'llm') {
    const src = p.prompt || '';
    return src ? (src.length > 30 ? src.slice(0, 30) + '…' : src) : '（含引用前序输出）';
  }
  if (type === 'image') {
    const s = p.prompt || '';
    return s ? (s.length > 30 ? s.slice(0, 30) + '…' : s) : '（图像生成）';
  }
  const t = p.title || 'AI 成果';
  return p.content ? `${t} · 自定义内容` : `${t} · 自动汇聚上游`;
}

function MenuItem({ onClick, icon, label, danger }: {
  onClick: () => void; icon: React.ReactNode; label: string; danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs transition-colors ${
        danger ? 'text-red-500 hover:bg-red-500/10' : 'text-neutral-700 hover:bg-violet-500/10 dark:text-stone-200'
      }`}
    >
      <span className={`shrink-0 ${danger ? '' : 'text-neutral-400 dark:text-stone-500'}`}>{icon}</span>
      {label}
    </button>
  );
}

function MenuSep() {
  return <div className="my-1 h-px bg-neutral-200/70 dark:bg-stone-700/70" />;
}

/** 导出件：包 ReactFlowProvider（useReactFlow 需要） */
export const AiWorkflowView = memo(function AiWorkflowView(props: AiWorkflowViewProps) {
  return (
    <ReactFlowProvider>
      <AiWorkflowCanvas {...props} />
    </ReactFlowProvider>
  );
});
