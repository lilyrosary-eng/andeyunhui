// 全库来源图（2026-11-04 新增）。用户点名要的东西：Obsidian 那种「拖拽互联节点图」。
//
// 与「命中图」的分工：
//   命中图回答「这一次提问为什么选中了这几条」；
//   全库图回答「我这堆资料里哪些其实是一回事」—— 边来自**存量向量的两两余弦**，
//   由后端算好（`rag_source_graph`），前端只拿节点和边，向量一条都不回传。
//
// 为什么库里没有 Obsidian 那样的「双链边」：我们没有文档间链接这一关系，
//   只有 source → chunk 两级 + parent_idx。向量是唯一真实的连边依据。
//
// 维度不符 / 没有向量的来源画成灰点且必然没有连线 —— 那不是「它跟谁都不像」，
//   而是「它压根不参与检索和比较」（换过嵌入模型的老数据就是这样）。
//   这句话必须写在界面上，否则灰点会被读成「这篇跟库里没关系」，是错的。
//
// 布局：手写力导向（斥力 + 边弹簧，相似度越高目标距离越短 + 向心），300 次迭代预计算。
//   确定性布局便于对比两次打开；拖拽只在算好的坐标上叠手动位移，边跟着走。

const React = window.__HOST_REACT__;
const { useState, useEffect, useMemo, useRef } = React;

import { ragSourceGraph, type RagGraphData, type RagGraphEdge, type RagGraphNode } from '../api/host';
import { ragStore, RAG_NS_GENERAL } from '../store/rag-store';
import { colorOf, shortTitle, unitOf, type Drag, type Offsets, type PtrEvt } from '../graph/kit';

const W = 680;
const H = 440;

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

/** 确定性力导向布局（同输入同输出）。 */
function computeLayout(nodes: RagGraphNode[], edges: RagGraphEdge[]): { pts: Node[]; byId: Record<string, number> } {
  const cx = W / 2;
  const cy = H / 2;
  const n = Math.max(1, nodes.length);
  const maxChunks = Math.max(...nodes.map((x) => x.chunks), 1);
  const pts: Node[] = nodes.map((nd, i) => ({
    x: cx + Math.cos((i / n) * Math.PI * 2) * 150,
    y: cy + Math.sin((i / n) * Math.PI * 2) * 130,
    vx: 0,
    vy: 0,
    r: 8 + 9 * Math.sqrt(nd.chunks / maxChunks),
  }));
  const byId: Record<string, number> = {};
  nodes.forEach((nd, i) => {
    byId[nd.id] = i;
  });
  const links = edges
    .map((e) => ({ a: byId[e.a], b: byId[e.b], sim: e.sim }))
    .filter((l) => l.a !== undefined && l.b !== undefined);
  const topSim = Math.max(...links.map((l) => l.sim), 0.0001);

  for (let iter = 0; iter < 300; iter++) {
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i];
        const b = pts[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d = Math.hypot(dx, dy) || 1;
        const f = 2600 / (d * d);
        a.vx += (dx / d) * f;
        a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f;
        b.vy -= (dy / d) * f;
      }
    }
    for (const l of links) {
      const a = pts[l.a];
      const b = pts[l.b];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = Math.hypot(dx, dy) || 1;
      // 越像，弹簧越短 ⇒ 「一回事」的资料自然聚成一团
      const target = 230 - 150 * (l.sim / topSim);
      const diff = (d - target) * 0.011;
      a.vx -= (dx / d) * diff;
      a.vy -= (dy / d) * diff;
      b.vx += (dx / d) * diff;
      b.vy += (dy / d) * diff;
    }
    for (const p of pts) {
      p.vx += (cx - p.x) * 0.0025;
      p.vy += (cy - p.y) * 0.0025;
      p.vx *= 0.82;
      p.vy *= 0.82;
      p.x = Math.max(p.r + 8, Math.min(W - p.r - 8, p.x + p.vx));
      p.y = Math.max(p.r + 8, Math.min(H - p.r - 8, p.y + p.vy));
    }
  }
  return { pts, byId };
}

export function LibraryGraph() {
  const [data, setData] = useState<RagGraphData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** 滑条实时值与实际请求值分开：一次全库两两余弦不便宜，拖一下滑条不该发几十次。 */
  const [draft, setDraft] = useState(0.55);
  const [minScore, setMinScore] = useState(0.55);
  const [offsets, setOffsets] = useState<Offsets>({});
  const [hover, setHover] = useState<number | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const movedRef = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => setMinScore(draft), 250);
    return () => clearTimeout(t);
  }, [draft]);

  useEffect(() => {
    let alive = true;
    ragSourceGraph(RAG_NS_GENERAL, minScore)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setErr(null);
        setOffsets({});
        setHover(null);
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[rag] 全库图构建失败:', msg);
        if (alive) setErr(`全库图构建失败：${msg}`);
      });
    return () => {
      alive = false;
    };
  }, [minScore]);

  const laid = useMemo(() => (data && data.nodes.length ? computeLayout(data.nodes, data.edges) : null), [data]);

  const baseOf = (i: number) => laid!.pts[i];
  const pos = (i: number) => {
    const b = baseOf(i);
    const o = offsets[i];
    return o ? { x: b.x + o.x, y: b.y + o.y } : { x: b.x, y: b.y };
  };

  const onPointerDown = (key: number) => (e: PtrEvt) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    movedRef.current = false;
    const o = offsets[key] ?? { x: 0, y: 0 };
    dragRef.current = { key, sx: e.clientX, sy: e.clientY, ox: o.x, oy: o.y, unit: unitOf(rect.width, W) };
  };

  const onPointerMove = (e: PtrEvt) => {
    const d = dragRef.current;
    if (!d) return;
    if (!movedRef.current && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) return;
    movedRef.current = true;
    const b = baseOf(d.key);
    const r = b.r;
    const x = Math.max(r, Math.min(W - r, b.x + d.ox + (e.clientX - d.sx) * d.unit));
    const y = Math.max(r, Math.min(H - r, b.y + d.oy + (e.clientY - d.sy) * d.unit));
    setOffsets((prev) => ({ ...prev, [d.key]: { x: x - b.x, y: y - b.y } }));
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  if (err) {
    return (
      <div className="text-xs text-red-500 rounded-lg border border-red-200/60 dark:border-red-800/40 bg-red-50/60 dark:bg-red-900/20 px-3 py-2">
        ⚠ {err}
      </div>
    );
  }
  if (!data) return <div className="text-xs text-neutral-400 py-6 text-center">全库向量比对中…</div>;
  if (!data.nodes.length) {
    return <div className="text-xs text-neutral-400 dark:text-stone-500 py-8 text-center">库里还没有来源，先到「管理」摄取文档。</div>;
  }
  if (!laid) return null;

  const topSim = Math.max(...data.edges.map((e) => e.sim), 0.0001);
  const idx = laid.byId;
  /** 悬停某个点时，与它相连的点保持亮度（Obsidian 图谱的 hover 语义）。 */
  const neighbor = (i: number) =>
    hover === null ||
    i === hover ||
    data.edges.some((e) => (idx[e.a] === hover && idx[e.b] === i) || (idx[e.b] === hover && idx[e.a] === i));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-neutral-400 dark:text-stone-500">
        <span>
          全库 {data.nodes.length} 个来源 · {data.edges.length} 条相似连线
          {data.stranded > 0 ? ` · ${data.stranded} 个来源无向量/维度不符` : ''}
        </span>
        <label className="flex items-center gap-1.5">
          连边阈值
          <input
            type="range"
            min={0.3}
            max={0.9}
            step={0.05}
            value={draft}
            onChange={(e) => setDraft(parseFloat(e.target.value))}
            className="w-24 accent-[var(--element-bg)]"
            title="只画出相似度不低于这个值的连线"
          />
          <span className="w-8 tabular-nums">{draft.toFixed(2)}</span>
          {Object.keys(offsets).length > 0 && (
            <button
              className="rounded border border-neutral-300/70 px-1.5 py-0.5 hover:bg-black/5 dark:border-stone-600 dark:hover:bg-white/10"
              onClick={() => setOffsets({})}
            >
              重置布局
            </button>
          )}
        </label>
      </div>

      <div className="rounded-xl border border-neutral-200/60 dark:border-stone-600/60 bg-white/50 dark:bg-stone-900/30 overflow-hidden">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-auto block"
          role="img"
          style={{ touchAction: 'none' }}
        >
          {data.edges.map((e, k) => {
            const i = idx[e.a];
            const j = idx[e.b];
            const a = pos(i);
            const b = pos(j);
            const ratio = e.sim / topSim;
            const lit = hover === null || i === hover || j === hover;
            return (
              <line
                key={`e${k}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="currentColor"
                className="text-neutral-400 dark:text-stone-500"
                strokeWidth={0.6 + 2.4 * ratio}
                opacity={(0.18 + 0.5 * ratio) * (lit ? 1 : 0.2)}
                strokeLinecap="round"
              />
            );
          })}

          {data.nodes.map((nd, i) => {
            const p = pos(i);
            const r = laid.pts[i].r;
            const grey = nd.dim === 0 || !nd.current;
            const lit = neighbor(i);
            return (
              <g
                key={nd.id}
                onPointerDown={onPointerDown(i)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onClick={() => {
                  if (movedRef.current) return;
                  ragStore.openReader({ sourceId: nd.id });
                }}
                style={{ cursor: 'grab' }}
              >
                {/* 透明命中圈：小点也好点、也好拖 */}
                <circle cx={p.x} cy={p.y} r={r + 6} fill="transparent" />
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={r}
                  fill={grey ? '#9ca3af' : colorOf(nd.id)}
                  opacity={lit ? 0.9 : 0.25}
                  stroke={grey ? '#6b7280' : 'none'}
                  strokeWidth={1}
                />
                <text
                  x={p.x + r + 5}
                  y={p.y + 3}
                  fontSize={10}
                  className="fill-neutral-600 dark:fill-stone-300"
                  opacity={lit ? 1 : 0.3}
                  style={{ pointerEvents: 'none' }}
                >
                  {shortTitle(nd.title, hover === i ? 20 : 11)}
                  {` · ${nd.chunks} 块`}
                  {grey ? ' · 检索不到' : ''}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="text-[11px] text-neutral-400 dark:text-stone-500">
        拖动节点展开重叠 · 点节点打开它的正文 · 线越粗越相似。
        每个来源只画「它自己最像的前 3 条」——这类嵌入模型的两两余弦天然挤在 0.77~0.81 的窄带上，
        只按绝对阈值会连成一团毛线。
        灰点（标「检索不到」）是<strong>没有向量或维度与当前模型不符</strong>的来源：
        它们不是跟谁都不像，而是压根不参与检索 —— 到「管理」里点「重建」即可恢复。
      </div>
    </div>
  );
}
