// 检索命中图谱（2026-10-19 新增）。
//
// 为什么是这个形态，而不是 Obsidian 那样的全库 graph：
//   Obsidian 的边来自用户手写的 [[双链]]；我们的库里**没有文档间链接**这一关系，
//   只有 source → chunk 两级 + parent_idx。全库画出来是 200 个点的毛线球，不清晰；
//   要清晰必须先做聚类（那是另一摊工程）。
//   而「一次查询的命中图」天然只有 ≤8 个节点，不需要聚类/降维，
//   而且信息量真实：能一眼看出为什么是这几条被选中、它们是不是来自同一段上下文。
//
// 布局：手写力导向（斥力 + query↔chunk 弹簧 + 向心），260 次迭代预计算后静态渲染。
//   节点少，不需要 d3-force（省 30KB 打包体积，也避免多一个依赖）。
// 边：
//   - query → chunk：线宽/透明度 ∝ 归一化相似度
//   - chunk ↔ chunk：同来源且字符区间相邻 → 虚线（表示"同一段上下文"）
//
// 2026-11-01（重排）：**半径/线宽一律用「本次排序实际用的分」**——
//   重排生效时是 rerank_score，否则是向量余弦分（见 retriever.effectiveScore）。
//   否则会出现「图上最远的节点被排在第一条」这种自相矛盾的图，
//   用户就没法靠这张图核对排序了。
//
// 2026-11-03（拖拽）：节点可拖动。力导向仍然是**确定性预计算**（对比两次检索要靠它），
//   所以拖拽不跑物理、不落回布局，只是在算好的坐标上叠加一层「手动位移」；
//   边读的是叠加后的坐标，因此拖哪个点，连着的线都跟着走。
//   坐标系：svg 用 viewBox，`getBoundingClientRect()` 是视觉 px（含外层 CSS zoom），
//   但 (clientX-rect.left)/rect.width 分子分母同单位，zoom 自己约掉，无需再除缩放比。

const React = window.__HOST_REACT__;
const { useState, useEffect, useMemo, useRef } = React;

import { ragStore, type LastResult } from '../store/rag-store';
import { effectiveScore, scoreLabel } from '../retrieve/retriever';
import type { RagHit } from '../api/host';
import { colorOf, shortTitle, unitOf, type Drag, type Offsets, type PtrEvt } from '../graph/kit';

const W = 680;
const H = 380;

interface Pt {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Laid {
  /** query 节点位置 */
  q: Pt;
  /** 每个 hit 的节点位置与半径 */
  nodes: { p: Pt; r: number; target: number }[];
}

/** 力导向布局（确定性：同样的输入得到同样的图，便于对比两次检索）。 */
function computeLayout(hits: RagHit[]): Laid {
  const cx = W / 2;
  const cy = H / 2;
  const n = Math.max(1, hits.length);
  // 归一化基准用「本次排序的分」的最大值（重排分优先，否则向量分）
  const top = Math.max(...hits.map((h) => effectiveScore(h)), 0.0001);
  const q: Pt = { x: cx, y: cy, vx: 0, vy: 0 };
  const nodes = hits.map((h, i) => {
    const s = effectiveScore(h);
    return {
      p: {
        x: cx + Math.cos((i / n) * Math.PI * 2) * 140,
        y: cy + Math.sin((i / n) * Math.PI * 2) * 110,
        vx: 0,
        vy: 0,
      } as Pt,
      r: 8 + 8 * (s / top),
      // 分数越高，弹簧目标长度越短 ⇒ 越靠近 query（直观表达"更相关"）
      target: 95 + (1 - s / top) * 85,
    };
  });

  for (let iter = 0; iter < 260; iter++) {
    // 节点互斥
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i].p;
        const b = nodes[j].p;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d = Math.hypot(dx, dy) || 1;
        const f = 2200 / (d * d);
        a.vx += (dx / d) * f;
        a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f;
        b.vy -= (dy / d) * f;
      }
    }
    // 弹簧
    for (const nd of nodes) {
      const dx = nd.p.x - q.x;
      const dy = nd.p.y - q.y;
      const d = Math.hypot(dx, dy) || 1;
      const diff = (d - nd.target) * 0.012;
      nd.p.vx -= (dx / d) * diff;
      nd.p.vy -= (dy / d) * diff;
      q.vx += (dx / d) * diff * 0.3;
      q.vy += (dy / d) * diff * 0.3;
    }
    // 向心 + 阻尼 + 边界
    for (const pt of [q, ...nodes.map((x) => x.p)]) {
      pt.vx += (cx - pt.x) * 0.002;
      pt.vy += (cy - pt.y) * 0.002;
      pt.vx *= 0.82;
      pt.vy *= 0.82;
      pt.x += pt.vx;
      pt.y += pt.vy;
      pt.x = Math.max(70, Math.min(W - 70, pt.x));
      pt.y = Math.max(48, Math.min(H - 48, pt.y));
    }
  }
  return { q, nodes };
}

export function HitGraph() {
  const [last, setLast] = useState<LastResult | null>(() => ragStore.getLastResult());
  const [selected, setSelected] = useState<number | null>(null);
  const [offsets, setOffsets] = useState<Offsets>({});
  /** 悬停高亮：-1 = query 节点，0..n-1 = 第 i 条命中，null = 没悬停 */
  const [hover, setHover] = useState<number | null>(null);
  /** 悬停 250ms 后的原文预览（点击才钉住到 selected） */
  const [preview, setPreview] = useState<number | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  /** 当前拖拽会话；null = 没在拖 */
  const dragRef = useRef<Drag | null>(null);
  /** 本次手势是否真的拖动过（用于区分「点一下看原文」和「拖完松手」） */
  const movedRef = useRef(false);
  const previewTimer = useRef<number | null>(null);

  useEffect(() => {
    const un = ragStore.subscribeLastResult((r) => {
      setLast(r);
      setSelected(null);
      setPreview(null);
      setOffsets({});
    });
    return un;
  }, []);

  const laid = useMemo(() => (last && last.hits.length ? computeLayout(last.hits) : null), [last]);

  /** 力导向算好的原始坐标（不含手动位移）。 */
  const baseOf = (key: number): { x: number; y: number } =>
    key < 0 ? laid!.q : laid!.nodes[key].p;

  /** 叠加手动位移后的坐标（边和节点都读这个，拖动时线才跟着走）。 */
  const pos = (key: number): { x: number; y: number } => {
    const b = baseOf(key);
    const o = offsets[key];
    return o ? { x: b.x + o.x, y: b.y + o.y } : b;
  };
  const radius = (key: number) => (key < 0 ? 16 : laid!.nodes[key].r);

  /** 悬停某节点时，把「与它无关」的边和节点压暗：同来源的兄弟块算相关（Obsidian 图谱的 hover 语义）。 */
  const litQEdge = (i: number) => hover === null || hover < 0 || i === hover;

  /** 悬停 250ms 后把该节点的原文显示到下方详情框（点击才钉住）；与 CitedChat 同一套路。 */
  const schedulePreview = (i: number) => {
    if (previewTimer.current !== null) clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(() => setPreview(i), 250);
  };
  const cancelPreview = () => {
    if (previewTimer.current !== null) {
      clearTimeout(previewTimer.current);
      previewTimer.current = null;
    }
    setPreview(null);
  };
  useEffect(
    () => () => {
      if (previewTimer.current !== null) clearTimeout(previewTimer.current);
    },
    [],
  );
  const litNode = (i: number) =>
    hover === null || hover < 0 || i === hover || last!.hits[i].source_id === last!.hits[hover].source_id;
  /** 相邻块的虚线：只在它连着悬停节点时才亮（否则一屏虚线反而看不清集群） */
  const litPair = (i: number, j: number) => hover === null || hover < 0 || i === hover || j === hover;

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
    const r = radius(d.key);
    const x = Math.max(r, Math.min(W - r, b.x + d.ox + (e.clientX - d.sx) * d.unit));
    const y = Math.max(r, Math.min(H - r, b.y + d.oy + (e.clientY - d.sy) * d.unit));
    setOffsets((prev) => ({ ...prev, [d.key]: { x: x - b.x, y: y - b.y } }));
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  if (!last) {
    return (
      <div className="text-xs text-neutral-400 dark:text-stone-500 py-8 text-center">
        还没有检索记录。先到「对话」里问一次，命中结果会在这里画成图。
      </div>
    );
  }
  if (!last.hits.length) {
    return (
      <div className="text-xs text-neutral-400 dark:text-stone-500 py-8 text-center">
        最近一次提问「{shortTitle(last.query, 24)}」没有命中任何内容
        {last.dropped > 0 ? `（${last.dropped} 条被阈值过滤）` : ''}。
      </div>
    );
  }
  if (!laid) return null;

  const top = Math.max(...last.hits.map((h) => effectiveScore(h)), 0.0001);
  /** 钉住的优先，没钉住显示悬停预览。 */
  const shownIdx = selected ?? preview;
  const sel = shownIdx !== null ? last.hits[shownIdx] : null;
  /** 本次图的排序依据（重排 or 向量），标题里写清楚，避免把两种分看混。 */
  const scoreName = last.hits.some((h) => h.rerank_score !== undefined) ? '相关度' : '相似度';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between text-[11px] text-neutral-400 dark:text-stone-500">
        <span>
          查询「{shortTitle(last.query, 20)}」· 命中 {last.hits.length} 条
          {last.dropped > 0 ? ` · 已过滤 ${last.dropped} 条` : ''}
          {/* 排序依据写在标题里：两种分的尺度不同，混看会误判「为什么这条大」 */}
          {` · 按${scoreName}排序`}
        </span>
        <span className="flex items-center gap-2">
          <span>拖动节点可展开重叠 · 悬停即预览、点击钉住 · 线越粗{scoreName === '相关度' ? '越相关' : '越相似'}</span>
          {Object.keys(offsets).length > 0 && (
            <button
              className="rounded border border-neutral-300/70 px-1.5 py-0.5 hover:bg-black/5 dark:border-stone-600 dark:hover:bg-white/10"
              onClick={() => setOffsets({})}
              title="清掉手动位移，回到力导向自动布局"
            >
              重置布局
            </button>
          )}
        </span>
      </div>

      <div className="rounded-xl border border-neutral-200/60 dark:border-stone-600/60 bg-white/50 dark:bg-stone-900/30 overflow-hidden">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-auto block"
          role="img"
          style={{ touchAction: 'none' }}
        >
          {/* query → chunk 关联边 */}
          {last.hits.map((h, i) => {
            const q = pos(-1);
            const nd = pos(i);
            const ratio = effectiveScore(h) / top;
            return (
              <line
                key={`e${i}`}
                x1={q.x}
                y1={q.y}
                x2={nd.x}
                y2={nd.y}
                stroke={colorOf(h.source_id)}
                strokeWidth={0.6 + 2.2 * ratio}
                opacity={(0.2 + 0.55 * ratio) * (litQEdge(i) ? 1 : 0.2)}
                strokeLinecap="round"
              />
            );
          })}

          {/* 同一段上下文的相邻块：虚线相连 */}
          {last.hits.map((a, i) =>
            last.hits.map((b, j) => {
              if (j <= i) return null;
              if (a.source_id !== b.source_id) return null;
              const near = Math.abs(a.char_start - b.char_end) < 40 || Math.abs(b.char_start - a.char_end) < 40;
              if (!near) return null;
              const pi = pos(i);
              const pj = pos(j);
              return (
                <line
                  key={`d${i}-${j}`}
                  x1={pi.x}
                  y1={pi.y}
                  x2={pj.x}
                  y2={pj.y}
                  stroke="currentColor"
                  className="text-neutral-400 dark:text-stone-500"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  opacity={0.35 * (litPair(i, j) ? 1 : 0.2)}
                />
              );
            }),
          )}

          {/* query 节点（同样可拖：整个图的中心挪开，方便看压在中间的边） */}
          {(() => {
            const q = pos(-1);
            return (
              <g
                onPointerDown={onPointerDown(-1)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onPointerEnter={() => setHover(-1)}
                onPointerLeave={() => setHover(null)}
                style={{ cursor: 'grab' }}
              >
                <circle cx={q.x} cy={q.y} r={16} fill="var(--element-bg, #5a7f5d)" opacity={0.95} />
                <text
                  x={q.x}
                  y={q.y + 4}
                  textAnchor="middle"
                  fontSize={10}
                  fill="#fff"
                  style={{ fontWeight: 600, pointerEvents: 'none' }}
                >
                  问题
                </text>
              </g>
            );
          })()}

          {/* chunk 节点 */}
          {last.hits.map((h, i) => {
            const nd = pos(i);
            const r = laid.nodes[i].r;
            const active = selected === i;
            return (
              <g
                key={`n${i}`}
                onPointerDown={onPointerDown(i)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onPointerEnter={() => {
                  setHover(i);
                  schedulePreview(i);
                }}
                onPointerLeave={() => {
                  setHover(null);
                  cancelPreview();
                }}
                onClick={() => {
                  // 拖完松手也会派发 click：手势里真拖动过就不当「选中」
                  if (movedRef.current) return;
                  setSelected(active ? null : i);
                }}
                style={{ cursor: 'grab' }}
              >
                {/* 透明命中圈（Obsidian 图谱同款）：小节点也好评处点、拖得住 */}
                <circle cx={nd.x} cy={nd.y} r={r + 6} fill="transparent" />
                <circle
                  cx={nd.x}
                  cy={nd.y}
                  r={r + (active ? 3 : 0)}
                  fill={colorOf(h.source_id)}
                  opacity={active ? 1 : litNode(i) ? 0.85 : 0.25}
                  stroke={active ? '#fff' : 'none'}
                  strokeWidth={2}
                />
                <text
                  x={nd.x + r + 5}
                  y={nd.y + 3}
                  fontSize={10}
                  className="fill-neutral-600 dark:fill-stone-300"
                  opacity={litNode(i) ? 1 : 0.3}
                  style={{ pointerEvents: 'none' }}
                >
                  {shortTitle(h.source_title, hover === i ? 22 : 12)} · {effectiveScore(h).toFixed(2)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {sel && (
        <div
          className={`text-[11px] whitespace-pre-wrap rounded-lg border px-3 py-2 text-neutral-600 dark:text-stone-300 max-h-40 overflow-auto ${
            selected === null
              ? 'border-dashed border-neutral-300/70 bg-white/40 dark:border-stone-600/60 dark:bg-stone-900/30'
              : 'border-neutral-200/60 dark:border-stone-600/60 bg-white/50 dark:bg-stone-900/40'
          }`}
        >
          {selected === null && (
            <div className="mb-1 text-[10px] text-neutral-400 dark:text-stone-500">悬停预览 · 点击节点钉住</div>
          )}
          {sel.text}
          <div className="mt-1 flex items-center justify-between gap-2">
            <span>
              来源：{sel.source_title} · {scoreLabel(sel)} {effectiveScore(sel).toFixed(4)}
              {sel.rerank_score !== undefined
                ? ` · 向量 ${sel.score.toFixed(4)}（原第 ${sel.original_rank}）`
                : ''}
              {' · '}
              字符区间 [{sel.char_start}, {sel.char_end})
            </span>
            <button
              onClick={() =>
                ragStore.openReader({
                  sourceId: sel.source_id,
                  start: sel.char_start,
                  end: sel.char_end,
                  query: last.query,
                })
              }
              className="btn-press shrink-0 rounded border border-neutral-300/70 px-1.5 py-0.5 hover:bg-black/5 dark:border-stone-600 dark:hover:bg-white/10"
            >
              看原文 →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
