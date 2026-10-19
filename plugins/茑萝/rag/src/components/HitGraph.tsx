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

const React = window.__HOST_REACT__;
const { useState, useEffect, useMemo } = React;

import { ragStore, type LastResult } from '../store/rag-store';
import type { RagHit } from '../api/host';

const W = 680;
const H = 380;

/** 来源配色（按 source_id 稳定取色，浅/深主题都可读）。 */
const PALETTE = ['#d97706', '#059669', '#0284c7', '#7c3aed', '#db2777', '#0891b2', '#65a30d', '#c2410c'];

function colorOf(sourceId: string): string {
  let h = 0;
  for (let i = 0; i < sourceId.length; i++) h = (h * 31 + sourceId.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

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
  const top = Math.max(...hits.map((h) => h.score), 0.0001);
  const q: Pt = { x: cx, y: cy, vx: 0, vy: 0 };
  const nodes = hits.map((h, i) => ({
    p: {
      x: cx + Math.cos((i / n) * Math.PI * 2) * 140,
      y: cy + Math.sin((i / n) * Math.PI * 2) * 110,
      vx: 0,
      vy: 0,
    } as Pt,
    r: 8 + 8 * (h.score / top),
    // 分数越高，弹簧目标长度越短 ⇒ 越靠近 query（直观表达"更相关"）
    target: 95 + (1 - h.score / top) * 85,
  }));

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

function shortTitle(t: string, max = 14): string {
  return t.length > max ? t.slice(0, max) + '…' : t;
}

export function HitGraph() {
  const [last, setLast] = useState<LastResult | null>(() => ragStore.getLastResult());
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    const un = ragStore.subscribeLastResult((r) => {
      setLast(r);
      setSelected(null);
    });
    return un;
  }, []);

  const laid = useMemo(() => (last && last.hits.length ? computeLayout(last.hits) : null), [last]);

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

  const top = Math.max(...last.hits.map((h) => h.score), 0.0001);
  const sel = selected !== null ? last.hits[selected] : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between text-[11px] text-neutral-400 dark:text-stone-500">
        <span>
          查询「{shortTitle(last.query, 20)}」· 命中 {last.hits.length} 条
          {last.dropped > 0 ? ` · 已过滤 ${last.dropped} 条` : ''}
        </span>
        <span>点节点看原文 · 线越粗越相似</span>
      </div>

      <div className="rounded-xl border border-neutral-200/60 dark:border-stone-600/60 bg-white/50 dark:bg-stone-900/30 overflow-hidden">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img">
          {/* query → chunk 关联边 */}
          {last.hits.map((h, i) => {
            const nd = laid.nodes[i];
            const ratio = h.score / top;
            return (
              <line
                key={`e${i}`}
                x1={laid.q.x}
                y1={laid.q.y}
                x2={nd.p.x}
                y2={nd.p.y}
                stroke={colorOf(h.source_id)}
                strokeWidth={0.6 + 2.2 * ratio}
                opacity={0.2 + 0.55 * ratio}
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
              return (
                <line
                  key={`d${i}-${j}`}
                  x1={laid.nodes[i].p.x}
                  y1={laid.nodes[i].p.y}
                  x2={laid.nodes[j].p.x}
                  y2={laid.nodes[j].p.y}
                  stroke="currentColor"
                  className="text-neutral-400 dark:text-stone-500"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  opacity={0.35}
                />
              );
            }),
          )}

          {/* query 节点 */}
          <circle cx={laid.q.x} cy={laid.q.y} r={16} fill="var(--element-bg, #5a7f5d)" opacity={0.95} />
          <text
            x={laid.q.x}
            y={laid.q.y + 4}
            textAnchor="middle"
            fontSize={10}
            fill="#fff"
            style={{ fontWeight: 600 }}
          >
            问题
          </text>

          {/* chunk 节点 */}
          {last.hits.map((h, i) => {
            const nd = laid.nodes[i];
            const active = selected === i;
            return (
              <g
                key={`n${i}`}
                onClick={() => setSelected(active ? null : i)}
                style={{ cursor: 'pointer' }}
              >
                <circle
                  cx={nd.p.x}
                  cy={nd.p.y}
                  r={nd.r + (active ? 3 : 0)}
                  fill={colorOf(h.source_id)}
                  opacity={active ? 1 : 0.85}
                  stroke={active ? '#fff' : 'none'}
                  strokeWidth={2}
                />
                <text
                  x={nd.p.x + nd.r + 5}
                  y={nd.p.y + 3}
                  fontSize={10}
                  className="fill-neutral-600 dark:fill-stone-300"
                >
                  {shortTitle(h.source_title, 12)} · {h.score.toFixed(2)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {sel && (
        <div className="text-[11px] whitespace-pre-wrap rounded-lg border border-neutral-200/60 dark:border-stone-600/60 bg-white/50 dark:bg-stone-900/40 px-3 py-2 text-neutral-600 dark:text-stone-300 max-h-40 overflow-auto">
          {sel.text}
          <div className="mt-1 text-neutral-400 dark:text-stone-500">
            来源：{sel.source_title} · 相似度 {sel.score.toFixed(4)} · 字符区间 [{sel.char_start},{' '}
            {sel.char_end})
          </div>
        </div>
      )}
    </div>
  );
}
