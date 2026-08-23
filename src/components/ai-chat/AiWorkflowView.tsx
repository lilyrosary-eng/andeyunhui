// AIWorkflow（AIGC 工作流编蓝图）—— 左侧任务侧栏 + 右侧节点连线画布。
// 左侧：任务列表，新建 / 选择 / 改名 / 删除，便于管理多张蓝图。
// 右侧：自由画布。左键点击节点选中、按住拖动移动；右键弹出上下文菜单：
//   - 节点上：编辑参数 / 建立连线 / 删除节点
//   - 空白处：新建节点（起始/生成/产出）、按任务生成蓝图、重新排列、清空
// 节点全部为 AIGC 原生操作（prompt / llm / output），产出落 AIWork 独立产物库，全程与笔记解耦。
// 任务与蓝图本地持久化（aiWorkflows），不依赖后端，沙箱内稳定可用。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Workflow, Play, Wand2, Loader2, Plus, Trash2, Pencil, Brain, BookmarkCheck,
  ListPlus, GitBranch, LayoutGrid, Eraser, CircleDot, X, CheckCircle2, XCircle, FolderPlus,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  loadWorkflows, persistWorkflows, createWorkflow, autoPos,
  WF_KEY,
  type WorkflowDoc, type WfNode, type WfEdge, type WfNodeType,
} from '@/core/ai/aiWorkflows';
import { addProduct } from '@/core/ai/aiWorkProducts';

const NODE_W = 216;
const NODE_H = 96;
const GAP = 64;

const TYPE_NAME: Record<WfNodeType, string> = { prompt: '起始输入', llm: '模型生成', output: '产出' };
const TYPE_ICON: Record<WfNodeType, React.ReactNode> = {
  prompt: <CircleDot size={15} />,
  llm: <Brain size={15} />,
  output: <BookmarkCheck size={15} />,
};
const TYPE_TINT: Record<WfNodeType, string> = {
  prompt: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  llm: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  output: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
};
/** 每种节点的可编辑参数键（含 label 改名） */
const TYPE_PARAMS: Record<WfNodeType, string[]> = {
  prompt: ['prompt'],
  llm: ['system', 'prompt'],
  output: ['title', 'content'],
};

const DEFAULT_SYSTEM = '你是专业 AI 助手，输出精炼、结构清晰、可直接使用。';

const PLAN_SYSTEM = `你是「蓝图规划器」。用户给出一个 AIGC 任务需求，请拆解为一个可执行的工作流节点列表。
只输出一个严格 JSON 对象，不要 markdown 代码块、不要任何解释。格式：
{"nodes":[{"id":"n1","type":"prompt","label":"需求输入","params":{"prompt":"..."}},{"id":"n2","type":"llm","label":"草拟","params":{"system":"你是...","prompt":"请基于前文产出：\\n{ref:n1}"}},{"id":"n3","type":"output","label":"汇集成品","params":{"title":"成品标题","content":"{ref:n2}"}}]}
可用节点类型：
- prompt 起始/输入：params.prompt 为本节点提供的上下文文本
- llm 模型生成：params.system 为可选系统提示，params.prompt 为用户内容，可用 {ref:节点id} 引用前序输出
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
          nn.type === 'prompt' ? 'prompt' : nn.type === 'output' ? 'output' : 'llm';
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
    // 蓝图默认按序连线：n_{i} → n_{i+1}（首尾串联）
    const edges: WfEdge[] = [];
    for (let i = 0; i < ids.length - 1; i++) {
      edges.push({ id: uidp('e'), source: ids[i], target: ids[i + 1] });
    }
    // 相对布局：横向铺开
    nodes.forEach((n, i) => {
      n.x = 48 + i * (NODE_W + GAP);
      n.y = 80 + (i % 4) * 48;
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

interface MenuState { x: number; y: number; nodeId?: string }

interface AiWorkflowViewProps { profileId: string }

export const AiWorkflowView = memo(function AiWorkflowView({ profileId }: AiWorkflowViewProps) {
  const [workflows, setWorkflows] = useState<WorkflowDoc[]>(() => loadWorkflows());
  const [activeId, setActiveId] = useState<string | null>(() => workflows[0]?.id ?? null);
  const active = useMemo(() => workflows.find((w) => w.id === activeId) ?? null, [workflows, activeId]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const profileIdRef = useRef(profileId);
  profileIdRef.current = profileId;

  // 持久化：workflows 状态即事实源，任何变更即落盘
  useEffect(() => { persistWorkflows(workflows); }, [workflows]);

  /** 对当前任务做一次不可变更新（保持引用稳定，自动 bump updatedAt） */
  const updateActive = useCallback((fn: (d: WorkflowDoc) => WorkflowDoc) => {
    setWorkflows((prev) => {
      const i = prev.findIndex((w) => w.id === activeId);
      if (i < 0) return prev;
      const next = [...prev];
      next[i] = { ...fn(prev[i]), updatedAt: Date.now() };
      return next;
    });
  }, [activeId]);

  const selectWorkflow = useCallback((id: string) => {
    setActiveId(id);
    setSelectedId(null);
    setEditingId(null);
    setMenu(null);
    setError(null);
  }, []);

  const newWorkflow = useCallback(() => {
    const doc = createWorkflow();
    setWorkflows((prev) => {
      persistWorkflows([doc, ...prev]);
      return [doc, ...prev];
    });
    setActiveId(doc.id);
    setSelectedId(null);
    setEditingId(null);
    setMenu(null);
  }, []);

  const renameWorkflow = useCallback((id: string) => {
    const cur = workflows.find((w) => w.id === id);
    const name = window.prompt('任务改名', cur?.name || '');
    if (name === null) return;
    const name2 = name.trim() || '未命名任务';
    setWorkflows((prev) => prev.map((w) => (w.id === id ? { ...w, name: name2.slice(0, 40), updatedAt: Date.now() } : w)));
  }, [workflows]);

  const removeWorkflow = useCallback((id: string) => {
    setWorkflows((prev) => prev.filter((w) => w.id !== id));
    setActiveId((cur) => (cur === id ? (workflows.find((w) => w.id !== id)?.id ?? null) : cur));
    setMenu(null);
  }, [workflows]);

  const pushLog = useCallback((line: string) => {
    setLogs((prev) => [...prev.slice(-5), line]);
  }, []);

  /* ============ AI 一言问答（复用 ai_chat 流式事件） ============ */
  const aiAsk = useCallback(async (system: string, userText: string): Promise<string> => {
    const reqId = uidp('wf');
    let acc = '';
    let resolveDone!: (s: string) => void;
    let rejectDone!: (e: unknown) => void;
    const done = new Promise<string>((res, rej) => { resolveDone = res; rejectDone = rej; });
    const un: UnlistenFn[] = [];
    un.push(await listen<{ requestId: string; delta: string }>('ai-delta', (e) => {
      if (e.payload.requestId !== reqId) return;
      acc += e.payload.delta;
    }));
    un.push(await listen<{ requestId: string }>('ai-done', (e) => {
      if (e.payload.requestId !== reqId) return;
      un.forEach((u) => u()); resolveDone(acc);
    }));
    un.push(await listen<{ requestId: string; error: string }>('ai-error', (e) => {
      if (e.payload.requestId !== reqId) return;
      un.forEach((u) => u()); rejectDone(new Error(e.payload.error));
    }));
    try {
      await invoke('ai_chat', {
        requestId: reqId, profileId: profileIdRef.current,
        messages: [{ role: 'user', content: userText }], stream: true, system,
      });
      return await done;
    } catch (err) {
      un.forEach((u) => u()); throw err;
    }
  }, []);

  /* ============ 按任务生成蓝图 ============ */
  const generateBlueprint = useCallback(async () => {
    if (!active || planning || running) return;
    const t = active.task.trim();
    if (!t) { setError('请先在任务框里写一句需求描述'); return; }
    setPlanning(true); setError(null); setLogs([]); setMenu(null);
    try {
      pushLog('AI 正在把需求拆解为蓝图节点…');
      const raw = await aiAsk(PLAN_SYSTEM, `需求：${t}\n请只输出工作流规划 JSON。`);
      const parsed = parsePlan(raw);
      if (!parsed) { setError('未能解析蓝图结构，请换一种描述再试。'); return; }
      updateActive((d) => ({ ...d, nodes: parsed.nodes, edges: parsed.edges }));
      pushLog(`蓝图生成：${parsed.nodes.length} 个节点、${parsed.edges.length} 条连线`);
    } catch (err) {
      setError('生成失败：' + String(err).slice(0, 120));
    } finally {
      setPlanning(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, planning, running, aiAsk, updateActive, pushLog]);

  /* ============ 节点/边操作 ============ */
  const addNode = useCallback((type: WfNodeType, cx?: number, cy?: number) => {
    if (!active) return;
    const nodes = active.nodes;
    const pos = (cx !== undefined && cy !== undefined) ? { x: cx, y: cy } : autoPos(nodes);
    const id = uidp('n');
    const defaults: Record<string, string> =
      type === 'prompt' ? { prompt: '输入本节点要提供的上下文…' }
      : type === 'llm' ? { system: DEFAULT_SYSTEM, prompt: '' }
      : { title: 'AI 成果', content: '' };
    const node: WfNode = { id, type, label: TYPE_NAME[type], ...pos, params: defaults, status: 'idle' };
    updateActive((d) => ({ ...d, nodes: [...d.nodes, node] }));
    setSelectedId(id); setEditingId(id); setMenu(null);
  }, [active, updateActive]);

  const patchNode = useCallback((id: string, upd: Partial<WfNode>) => {
    updateActive((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, ...upd } : n)) }));
  }, [updateActive]);

  const deleteNode = useCallback((id: string) => {
    updateActive((d) => ({
      ...d,
      nodes: d.nodes.filter((n) => n.id !== id),
      edges: d.edges.filter((e) => e.source !== id && e.target !== id),
    }));
    setSelectedId((s) => (s === id ? null : s));
    setEditingId((s) => (s === id ? null : s));
    setMenu(null);
  }, [updateActive]);

  const addEdge = useCallback((source: string, target: string) => {
    updateActive((d) => {
      if (d.edges.some((e) => e.source === source && e.target === target)) return d;
      return { ...d, edges: [...d.edges, { id: uidp('e'), source, target }] };
    });
    setMenu(null);
  }, [updateActive]);

  const deleteEdge = useCallback((edgeId: string) => {
    updateActive((d) => ({ ...d, edges: d.edges.filter((e) => e.id !== edgeId) }));
    setMenu(null);
  }, [updateActive]);

  const autoLayout = useCallback(() => {
    if (!active) return;
    updateActive((d) => ({
      ...d,
      nodes: d.nodes.map((n, i) => ({ ...n, x: 48 + i * (NODE_W + GAP), y: 80 + (i % 4) * 48 })),
    }));
    setMenu(null);
  }, [active, updateActive]);

  const clearCanvas = useCallback(() => {
    if (!active) return;
    updateActive((d) => ({ ...d, nodes: [], edges: [] }));
    setSelectedId(null); setEditingId(null); setMenu(null);
  }, [active, updateActive]);

  /* ============ 节点拖动（左键 + Pointer Capture） ============ */
  const onNodePointerDown = useCallback((e: React.PointerEvent, node: WfNode) => {
    e.stopPropagation();
    setSelectedId(node.id);
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX, startY = e.clientY;
    const ox = node.x, oy = node.y;
    const move = (ev: PointerEvent) => {
      updateActive((d) => ({
        ...d,
        nodes: d.nodes.map((n) => (n.id === node.id
          ? { ...n, x: Math.max(0, Math.round(ox + ev.clientX - startX)), y: Math.max(0, Math.round(oy + ev.clientY - startY)) }
          : n)),
      }));
    };
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }, [updateActive]);

  const onCanvasContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setEditingId(null);
    setMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: WfNode) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedId(node.id); setEditingId(node.id);
    setMenu({ x: e.clientX, y: e.clientY, nodeId: node.id });
  }, []);

  /* ============ 执行蓝图（拓扑序逐节点跑） ============ */
  const run = useCallback(async () => {
    if (!active || running || planning) return;
    if (!active.nodes.length) { setError('画布还没有节点'); return; }
    const order = topoOrder(active.nodes, active.edges);
    if (!order) { setError('检测到环/孤立，无法确定执行顺序，请先修正连线'); return; }
    setRunning(true); setError(null); setLogs([]);
    const outputs = new Map<string, string>();
    // 先重置状态
    updateActive((d) => ({ ...d, nodes: d.nodes.map((n) => ({ ...n, status: 'idle' as const, output: undefined })) }));
    try {
      for (const id of order) {
        const node = workflows.find((w) => w.id === activeId)?.nodes.find((n) => n.id === id);
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
          } else {
            // output：优先 content，否则汇聚直接上游
            let body = '';
            if (node.params.content && node.params.content.trim()) {
              body = subRefs(node.params.content, outputs);
            } else {
              const ins = active.edges.filter((e) => e.target === id).map((e) => outputs.get(e.source));
              body = ins.filter(Boolean).join('\n\n') || '(无上游输出)';
            }
            const title = subRefs(node.params.title || node.label, outputs);
            addProduct(body, title);
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
  }, [active, activeId, workflows, running, planning, aiAsk, patchNode, updateActive, pushLog]);

  /* ============ 尺寸 / 边几何 ============ */
  const contentW = useMemo(() => {
    if (!active || !active.nodes.length) return 800;
    return Math.max(800, ...active.nodes.map((n) => n.x + NODE_W)) + 120;
  }, [active]);
  const contentH = useMemo(() => {
    if (!active || !active.nodes.length) return 600;
    return Math.max(600, ...active.nodes.map((n) => n.y + (heights[n.id] || NODE_H))) + 160;
  }, [active, heights]);

  const edgeNodes = useMemo(() => {
    if (!active) return [];
    const byId = new Map(active.nodes.map((n) => [n.id, n]));
    return active.edges.map((e) => ({
      edge: e,
      sx: (byId.get(e.source)?.x ?? 0) + NODE_W / 2,
      sy: (byId.get(e.source)?.y ?? 0) + (heights[e.source] || NODE_H),
      tx: (byId.get(e.target)?.x ?? 0) + NODE_W / 2,
      ty: (byId.get(e.target)?.y ?? 0),
    }));
  }, [active, heights]);

  const canRun = useMemo(() => !!active && active.nodes.length > 0 && !running && !planning, [active, running, planning]);

  const commitHeight = useCallback((id: string, h: number) => {
    setHeights((prev) => (prev[id] === h ? prev : { ...prev, [id]: h }));
  }, []);

  const nodeTargets = useMemo(() => {
    if (!menu?.nodeId || !active) return [];
    return active.nodes.filter((n) => n.id !== menu.nodeId && !active.edges.some((e) => e.source === menu.nodeId && e.target === n.id));
  }, [menu, active]);

  const activeEdgesForSel = useMemo(() => {
    if (!active || !selectedId) return [];
    return active.edges.filter((e) => e.source === selectedId || e.target === selectedId);
  }, [active, selectedId]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      {/* 顶部标题栏 */}
      <div className="shrink-0 flex items-center gap-3 border-b border-neutral-200/60 px-5 py-3 dark:border-stone-700/60">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
          <Workflow size={16} />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-neutral-800 dark:text-stone-100">AI 工作流 · 任务 + 节点画布</div>
          <div className="truncate text-xs text-neutral-400 dark:text-stone-500">
            {active
              ? `${active.nodes.length} 节点 / ${active.edges.length} 连线 · 左键拖节点,右键出菜单`
              : '先建一个任务,在右侧画布规划 AIGC 工作流'}
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

      <div className="flex min-h-0 flex-1">
        {/* ===== 左：任务侧栏 ===== */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-200/60 dark:border-stone-700/60">
          <div className="shrink-0 flex items-center gap-2 px-4 py-3">
            <ListPlus size={15} className="text-neutral-400 dark:text-stone-500" />
            <span className="text-sm font-semibold text-neutral-700 dark:text-stone-200">任务</span>
            <span className="ml-auto text-[11px] text-neutral-400 dark:text-stone-500">{workflows.length} 个</span>
          </div>
          <div className="shrink-0 px-3 pb-2">
            <button
              onClick={newWorkflow}
              className="btn-press flex w-full items-center justify-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-violet-700"
            >
              <Plus size={14} /> 新建任务
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {workflows.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                <FolderPlus size={22} className="opacity-30" />
                <div className="text-xs text-neutral-400 dark:text-stone-500">还没有任务，点上方创建</div>
              </div>
            ) : (
              <div className="space-y-1">
                {workflows.map((w) => {
                  const isActive = w.id === activeId;
                  return (
                    <div
                      key={w.id}
                      onClick={() => selectWorkflow(w.id)}
                      onContextMenu={(e) => {
                        e.preventDefault(); e.stopPropagation();
                        setMenu({ x: e.clientX, y: e.clientY, nodeId: `task:${w.id}` });
                      }}
                      className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                        isActive ? 'bg-violet-500/10' : 'hover:bg-black/5 dark:hover:bg-white/5'
                      }`}
                    >
                      <Workflow size={14} className={`shrink-0 ${isActive ? 'text-violet-500' : 'text-neutral-400 dark:text-stone-500'}`} />
                      <div className="min-w-0 flex-1">
                        <div className={`truncate text-xs font-medium ${isActive ? 'text-violet-700 dark:text-violet-300' : 'text-neutral-700 dark:text-stone-200'}`}>
                          {w.name}
                        </div>
                        <div className="text-[10px] text-neutral-400 dark:text-stone-500">
                          {w.nodes.length} 节点 · {new Date(w.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                      {isActive && (
                        <button
                          onClick={(e) => { e.stopPropagation(); removeWorkflow(w.id); }}
                          className="opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-red-500 transition-opacity"
                          title="删除任务"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </aside>

        {/* ===== 右侧：任务描述 + 画布 ===== */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* 任务描述行 */}
          {active && (
            <div className="shrink-0 flex items-center gap-2 px-4 pt-3">
              <input
                value={active.name}
                onChange={(e) => patchWorkflowName(active.id, e.target.value, setWorkflows)}
                className="h-8 w-40 rounded-lg border border-neutral-300/60 bg-white/60 px-2.5 text-xs font-semibold text-neutral-800 outline-none transition-colors focus:border-violet-400 dark:border-stone-700/60 dark:bg-stone-800/40 dark:text-stone-100"
                placeholder="任务名"
              />
              <input
                value={active.task}
                onChange={(e) => updateActive((d) => ({ ...d, task: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); generateBlueprint(); } }}
                className="h-8 min-w-0 flex-1 rounded-lg border border-neutral-300/60 bg-white/60 px-3 text-xs text-neutral-800 outline-none transition-colors focus:border-violet-400 dark:border-stone-700/60 dark:bg-stone-800/40 dark:text-stone-200"
                placeholder="用一句话描述任务，例如：构思短视频脚本并按分镜展开成成稿"
              />
              <button
                onClick={generateBlueprint}
                disabled={planning || running || !active.task.trim()}
                className="btn-press flex shrink-0 items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {planning ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                {planning ? '规划中…' : '生成蓝图'}
              </button>
            </div>
          )}

          {/* 画布 */}
          <div
            ref={canvasRef}
            onContextMenu={onCanvasContextMenu}
            onClick={() => { if (!menu) { setSelectedId(null); setEditingId(null); } }}
            className="relative m-3 min-h-0 flex-1 overflow-auto rounded-xl border border-neutral-200/60 bg-[radial-gradient(circle_at_1px_1px,rgba(0,0,0,0.06)_1px,transparent_0)] bg-[length:22px_22px] dark:border-stone-700/60 dark:bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.07)_1px,transparent_0)] dark:bg-[length:22px_22px]"
          >
            {!active ? (
              <div className="flex h-full items-center justify-center text-sm text-neutral-400 dark:text-stone-500">
                ← 先在左侧新建一个任务
              </div>
            ) : (
              <div className="relative" style={{ width: contentW, height: contentH }}>
                {/* 连线层 */}
                <svg className="pointer-events-none absolute inset-0" width={contentW} height={contentH}>
                  {edgeNodes.map(({ edge, sx, sy, tx, ty }) => {
                    const my = (sy + ty) / 2;
                    return (
                      <g key={edge.id}>
                        <path
                          d={`M ${sx} ${sy} C ${sx} ${my}, ${tx} ${my}, ${tx} ${ty}`}
                          fill="none"
                          stroke="rgba(124,58,237,0.55)"
                          strokeWidth={1.6}
                          markerEnd="url(#wf-arrow)"
                        />
                        {/* 连线可点击移除 */}
                        <path
                          d={`M ${sx} ${sy} C ${sx} ${my}, ${tx} ${my}, ${tx} ${ty}`}
                          fill="none"
                          stroke="transparent"
                          strokeWidth={12}
                          className="pointer-events-auto cursor-pointer"
                          onClick={(e) => { e.stopPropagation(); setSelectedId(null); setEditingId(null); deleteEdge(edge.id); }}
                        />
                      </g>
                    );
                  })}
                  <defs>
                    <marker id="wf-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                      <path d="M0,0 L7,4 L0,8 Z" fill="rgba(124,58,237,0.7)" />
                    </marker>
                  </defs>
                </svg>

                {/* 节点层 */}
                {active.nodes.map((node) => {
                  const isSel = node.id === selectedId;
                  return (
                    <div
                      key={node.id}
                      ref={(el) => { if (el) commitHeight(node.id, el.offsetHeight); }}
                      onPointerDown={(e) => onNodePointerDown(e, node)}
                      onContextMenu={(e) => onNodeContextMenu(e, node)}
                      className={`absolute cursor-grab select-none rounded-xl border bg-white/90 shadow-sm backdrop-blur transition-shadow dark:bg-stone-900/80 ${
                        isSel
                          ? 'z-10 border-violet-400 shadow-md ring-2 ring-violet-500/20'
                          : 'border-neutral-200/80 hover:border-violet-300 dark:border-stone-700/70'
                      } ${node.status === 'running' ? '!border-violet-400' : ''} ${node.status === 'error' ? '!border-red-400' : ''} ${node.status === 'ok' ? '!border-emerald-400' : ''}`}
                      style={{ left: node.x, top: node.y, width: NODE_W }}
                    >
                      {/* 顶部输入端口 */}
                      <span className="absolute left-1/2 -top-[5px] h-2.5 w-2.5 -translate-x-1/2 rounded-full border border-violet-400 bg-white dark:bg-stone-900" title="输入" />
                      <div className="flex items-center gap-2 px-3 pt-2.5">
                        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${TYPE_TINT[node.type]}`}>
                          {TYPE_ICON[node.type]}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-neutral-800 dark:text-stone-100">{node.label}</span>
                        <span className="text-[10px] uppercase tracking-wide text-neutral-400 dark:text-stone-500">{node.id}</span>
                        {node.status === 'running' && <Loader2 size={13} className="animate-spin text-violet-500" />}
                        {node.status === 'ok' && <CheckCircle2 size={13} className="text-emerald-500" />}
                        {node.status === 'error' && <XCircle size={13} className="text-red-500" />}
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5 px-3 pb-2">
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${TYPE_TINT[node.type]}`}>{TYPE_NAME[node.type]}</span>
                        <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-400 dark:text-stone-500">
                          {summaryOf(node)}
                        </span>
                      </div>
                      {node.output && (
                        <div className="mx-2 mb-2 max-h-16 overflow-y-auto rounded-md bg-black/5 px-2 py-1.5 text-[11px] leading-relaxed text-neutral-500 dark:bg-black/30 dark:text-stone-400">
                          {node.output}
                        </div>
                      )}
                      {/* 底部输出端口 */}
                      <span className="absolute bottom-[-5px] left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-full border border-emerald-500 bg-white dark:bg-stone-900" title="输出" />
                    </div>
                  );
                })}

                {/* 空态 */}
                {active.nodes.length === 0 && (
                  <div className="pointer-events-none mt-16 flex flex-col items-center text-center text-neutral-400 dark:text-stone-500">
                    <GitBranch size={28} className="mb-2 opacity-40" />
                    <div className="text-sm font-medium text-neutral-500 dark:text-stone-400">画布为空</div>
                    <div className="mt-1 max-w-xs text-xs">右键空白处新建节点，或在上方输入需求「生成蓝图」。</div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 选中节点：属性底栏 */}
          {active && editingId && (() => {
            const node = active.nodes.find((n) => n.id === editingId);
            if (!node) return null;
            return (
              <div className="shrink-0 border-t border-neutral-200/60 px-4 py-3 dark:border-stone-700/60">
                <div className="mb-2 flex items-center gap-2">
                  <span className={`flex h-6 w-6 items-center justify-center rounded-md ${TYPE_TINT[node.type]}`}>{TYPE_ICON[node.type]}</span>
                  <input
                    value={node.label}
                    onChange={(e) => patchNode(node.id, { label: e.target.value })}
                    className="h-7 w-44 rounded-lg border border-transparent bg-transparent px-2 text-sm font-semibold text-neutral-800 outline-none transition-colors hover:border-neutral-300 focus:border-violet-400 dark:text-stone-100"
                  />
                  <span className="text-[11px] text-neutral-400 dark:text-stone-500">[{TYPE_NAME[node.type]}]</span>
                  {/* 改类型 */}
                  <div className="flex items-center gap-1">
                    {(['prompt', 'llm', 'output'] as WfNodeType[]).map((t) => (
                      <button
                        key={t}
                        onClick={() => patchNode(node.id, { type: t, label: node.label || TYPE_NAME[t], params: node.params })}
                        className={`btn-press rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                          node.type === t ? 'bg-violet-500/10 text-violet-600 dark:text-violet-400' : 'text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5'
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <button onClick={() => deleteNode(node.id)} className="btn-press flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-red-500 hover:bg-red-500/10">
                      <Trash2 size={13} /> 删除
                    </button>
                    <button onClick={() => setEditingId(null)} className="btn-press rounded-md p-1 text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-300" title="关闭">
                      <X size={14} />
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {TYPE_PARAMS[node.type].map((k) => (
                    <label key={k} className="flex items-center gap-2 text-xs text-neutral-500 dark:text-stone-400">
                      <span className="w-16 shrink-0">{k}</span>
                      <input
                        value={node.params[k] ?? ''}
                        onChange={(e) => patchNode(node.id, { params: { ...node.params, [k]: e.target.value } })}
                        placeholder={k}
                        className="h-7 min-w-0 flex-1 rounded-md border border-neutral-300/60 bg-white/60 px-2 text-xs text-neutral-800 outline-none transition-colors focus:border-violet-400 dark:border-stone-700/60 dark:bg-stone-800/40 dark:text-stone-200"
                      />
                    </label>
                  ))}
                  {/* 该节点相关连线 */}
                  {activeEdgesForSel.length > 0 && (
                    <div className="col-span-2 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-400 dark:text-stone-500">
                      <span>连线：</span>
                      {activeEdgesForSel.map((e) => {
                        const otherId = e.source === node.id ? e.target : e.source;
                        const other = active.nodes.find((n) => n.id === otherId);
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
            );
          })()}

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
      </div>

      {/* ===== 右键上下文菜单 ===== */}
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div
            className="fixed z-50 min-w-[180px] overflow-hidden rounded-xl border border-neutral-200/80 bg-white/95 p-1 shadow-xl backdrop-blur dark:border-stone-700/70 dark:bg-stone-900/95"
            style={{ left: menu.x, top: menu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {menu.nodeId?.startsWith('task:') ? (
              /* 任务侧栏右键菜单 */
              <>
                <MenuItem onClick={() => { renameWorkflow(menu.nodeId!.slice(5)); }} icon={<Pencil size={14} />} label="重命名" />
                <MenuItem onClick={() => removeWorkflow(menu.nodeId!.slice(5))} icon={<Trash2 size={14} />} label="删除任务" danger />
              </>
            ) : menu.nodeId ? (
              /* 节点右键菜单 */
              <>
                <div className="px-3 py-1.5 text-[11px] font-semibold text-neutral-400 dark:text-stone-500">节点</div>
                <MenuItem onClick={() => { setEditingId(menu.nodeId!); setMenu(null); }} icon={<Pencil size={14} />} label="编辑参数 / 改名" />
                {/* 建立连线 */}
                {nodeTargets.length > 0 && (
                  <>
                    <div className="my-1 flex items-center gap-1 px-3 text-[11px] text-neutral-400 dark:text-stone-500"><GitBranch size={12} /> 建立连线到…</div>
                    {nodeTargets.slice(0, 8).map((t) => (
                      <MenuItem key={t.id} onClick={() => addEdge(menu.nodeId!, t.id)} icon={<GitBranch size={13} />} label={t.label} indent />
                    ))}
                  </>
                )}
                <MenuSep />
                <MenuItem onClick={() => deleteNode(menu.nodeId!)} icon={<Trash2 size={14} />} label="删除节点" danger />
              </>
            ) : (
              /* 空白画布菜单 */
              <>
                <div className="px-3 py-1.5 text-[11px] font-semibold text-neutral-400 dark:text-stone-500">新建节点</div>
                <MenuItem onClick={() => addNode('prompt')} icon={TYPE_ICON.prompt} label="起始输入 (prompt)" />
                <MenuItem onClick={() => addNode('llm')} icon={TYPE_ICON.llm} label="模型生成 (llm)" />
                <MenuItem onClick={() => addNode('output')} icon={TYPE_ICON.output} label="产出 (output)" />
                <MenuSep />
                <MenuItem onClick={generateBlueprint} icon={<Wand2 size={14} />} label="按任务生成蓝图" />
                <MenuItem onClick={autoLayout} icon={<LayoutGrid size={14} />} label="重新排列节点" />
                <MenuItem onClick={clearCanvas} icon={<Eraser size={14} />} label="清空画布" danger />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
});

/** 任务名实时编辑（不经过 updateActive 的 memo 依赖，直接写 state） */
function patchWorkflowName(id: string, value: string, set: React.Dispatch<React.SetStateAction<WorkflowDoc[]>>) {
  set((prev) => prev.map((w) => (w.id === id ? { ...w, name: value.slice(0, 40) } : w)));
}

/** 节点参数摘要（展示用） */
function summaryOf(node: WfNode): string {
  const p = node.params;
  if (node.type === 'prompt') return p.prompt || '（空输入）';
  if (node.type === 'llm') {
    const src = p.prompt || '';
    return src ? (src.length > 30 ? src.slice(0, 30) + '…' : src) : '（含引用前序输出）';
  }
  const t = p.title || 'AI 成果';
  return p.content ? `${t} · 自定义内容` : `${t} · 自动汇聚上游`;
}

function MenuItem({ onClick, icon, label, danger, indent }: {
  onClick: () => void; icon: React.ReactNode; label: string; danger?: boolean; indent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs transition-colors ${
        indent ? 'pl-7 ' : ''
      }${danger ? 'text-red-500 hover:bg-red-500/10' : 'text-neutral-700 hover:bg-violet-500/10 dark:text-stone-200'}`}
    >
      <span className={`shrink-0 ${danger ? '' : 'text-neutral-400 dark:text-stone-500'}`}>{icon}</span>
      {label}
    </button>
  );
}

function MenuSep() {
  return <div className="my-1 h-px bg-neutral-200/70 dark:bg-stone-700/60" />;
}

AiWorkflowView.displayName = 'AiWorkflowView';

export default AiWorkflowView;

// 引用保持，避免 tree-shake 误删（WF_KEY 为持久化键，供外部如需复用）
export { WF_KEY };