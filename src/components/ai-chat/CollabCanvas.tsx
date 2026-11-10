// AI 协作 · 组态画布（只读布局 + 点节点派单）。
//
// 刻意不做自由拖拽 / 缩放 / 多房间总览：它的职责只有一件事 ——
// 把「这个房间里谁是谁、任务流向谁」一眼画出来，并让点节点等价于选择派单对象。
// 改成员、改主导仍走「编辑」弹窗，不在这里重复一套编辑能力。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CollabAssignment, CollabAssignmentStatus, CollabRoom } from '@/core/ai/aiCollab';
import { agentMeta } from './collabDisplay';

const NODE_W = 176;
const NODE_H = 68;

const STATUS_COLOR: Record<CollabAssignmentStatus, string> = {
  queued: '#94a3b8',
  running: '#0ea5e9',
  waiting: '#f59e0b',
  completed: '#10b981',
  failed: '#ef4444',
  cancelled: '#a8a29e',
};

interface CollabCanvasProps {
  room: CollabRoom;
  assignments: CollabAssignment[];
  /** 当前派单对象（与输入框上方的「派给」共用同一份状态） */
  selectedId: string;
  onSelect: (agentId: string) => void;
}

interface Point {
  x: number;
  y: number;
}

/** 成员名下的任务聚合：只统计未结束与已完成，失败/取消只影响线色。 */
function summarize(assignments: CollabAssignment[]) {
  const latest = [...assignments].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return {
    total: assignments.length,
    running: assignments.filter((a) => a.status === 'running').length,
    waiting: assignments.filter((a) => a.status === 'waiting').length,
    completed: assignments.filter((a) => a.status === 'completed').length,
    color: latest ? STATUS_COLOR[latest.status] : '',
  };
}

export function CollabCanvas({ room, assignments, selectedId, onSelect }: CollabCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // 首帧先同步一次，否则要等到窗口变化才第一次画出来。
    setSize({ w: el.clientWidth, h: el.clientHeight });
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ w: rect.width, h: rect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { lead, others, positions } = useMemo(() => {
    const { w, h } = size;
    const leadAgent = room.agents.find((agent) => agent.id === room.leadId) ?? room.agents[0];
    const rest = room.agents.filter((agent) => agent.id !== leadAgent?.id);
    const cx = w / 2;
    const cy = h * 0.56;
    const rx = Math.max(110, Math.min(w * 0.32, 300));
    const ry = Math.max(70, Math.min(h * 0.28, 170));

    const map = new Map<string, Point>();
    map.set('__user', { x: cx, y: Math.max(42, h * 0.12) });
    if (leadAgent) map.set(leadAgent.id, { x: cx, y: cy });

    // 其余成员只铺在下半弧：顶部留给「用户」，避免节点重叠。
    const spread = 100;
    rest.forEach((agent, index) => {
      const offset = rest.length <= 1 ? 0 : (index - (rest.length - 1) / 2) * (spread / (rest.length - 1));
      const angle = ((90 + offset) * Math.PI) / 180;
      map.set(agent.id, { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry });
    });

    return { lead: leadAgent, others: rest, positions: map };
  }, [room, size]);

  const userPoint = positions.get('__user') ?? { x: size.w / 2, y: 42 };
  const leadPoint = lead ? positions.get(lead.id) : undefined;
  const leadStats = lead
    ? summarize(assignments.filter((task) => task.assigneeId === lead.id))
    : null;

  // 一条边 = 一条「默认派单 / 实际派单」关系；没有任务时仍然画淡虚线，表示这是房间成员。
  const edges = others.map((agent) => {
    const point = positions.get(agent.id);
    const stats = summarize(assignments.filter((task) => task.assigneeId === agent.id));
    return { agent, point, stats };
  });

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden" ref={wrapRef}>
      {/* 画布背景网格：弱到只做空间参考，不抢节点的注意力。 */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.35] dark:opacity-[0.18]"
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, rgba(120,113,108,0.45) 1px, transparent 0)',
          backgroundSize: '22px 22px',
        }}
      />

      {size.w > 0 && size.h > 0 && (
        <svg className="absolute inset-0" width={size.w} height={size.h} aria-hidden>
          <defs>
            <marker id="collab-edge-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill="rgba(120,113,108,0.55)" />
            </marker>
          </defs>

          {/* 用户 → 主导：这条线表达「不指定派给谁时的默认接单人」。 */}
          {leadPoint && (
            <>
              <path
                d={`M ${userPoint.x} ${userPoint.y + 22} L ${leadPoint.x} ${leadPoint.y - NODE_H / 2}`}
                stroke={leadStats?.color || 'rgba(120,113,108,0.4)'}
                strokeWidth={leadStats?.running ? 2 : 1.4}
                strokeDasharray={leadStats?.total ? undefined : '4 5'}
                markerEnd="url(#collab-edge-arrow)"
              />
              <text
                x={(userPoint.x + leadPoint.x) / 2 + 8}
                y={(userPoint.y + leadPoint.y) / 2}
                className="fill-neutral-400 text-[10px] dark:fill-stone-500"
              >
                默认派单
              </text>
            </>
          )}

          {/* 主导 → 其他成员：有任务时按最新状态着色，没有任务时是淡虚线（仅表示成员关系）。 */}
          {leadPoint &&
            edges.map(({ agent, point, stats }) => {
              if (!point) return null;
              return (
                <path
                  key={agent.id}
                  d={`M ${leadPoint.x} ${leadPoint.y + NODE_H / 2} L ${point.x} ${point.y - NODE_H / 2}`}
                  stroke={stats.color || 'rgba(120,113,108,0.32)'}
                  strokeWidth={stats.running ? 2 : 1.3}
                  strokeDasharray={stats.total ? undefined : '4 5'}
                  fill="none"
                />
              );
            })}
        </svg>
      )}

      {/* 用户节点：固定顶部，不参与派单选择。 */}
      <div
        className="absolute -translate-x-1/2 -translate-y-1/2"
        style={{ left: userPoint.x, top: userPoint.y }}
      >
        <div className="flex items-center gap-1.5 rounded-full border border-neutral-300 bg-white/90 px-3 py-1.5 text-[11px] text-neutral-500 shadow-sm dark:border-stone-600 dark:bg-stone-800/90 dark:text-stone-300">
          <span className="h-1.5 w-1.5 rounded-full bg-neutral-400" />
          我 · 用户
        </div>
      </div>

      {room.agents.map((agent) => {
        const point = positions.get(agent.id);
        if (!point) return null;
        const isLead = agent.id === lead?.id;
        const selected = agent.id === selectedId;
        const stats = summarize(assignments.filter((task) => task.assigneeId === agent.id));
        return (
          <button
            key={agent.id}
            onClick={() => onSelect(agent.id)}
            title={`${agentMeta(agent)}${agent.persona ? ` · ${agent.persona}` : ''}`}
            className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-2xl border bg-white/95 text-left shadow-sm transition-shadow hover:shadow-md dark:bg-stone-800/95 ${
              selected
                ? 'border-indigo-500 ring-2 ring-indigo-500/30'
                : isLead
                  ? 'border-indigo-400/60'
                  : 'border-neutral-200 dark:border-stone-700'
            }`}
            style={{ left: point.x, top: point.y, width: NODE_W, minHeight: NODE_H }}
          >
            <div className="flex items-center gap-1.5 px-3 pt-2">
              <span className="truncate text-xs font-semibold text-neutral-800 dark:text-stone-100">
                {agent.name}
              </span>
              {isLead && (
                <span className="shrink-0 rounded-full bg-indigo-500/10 px-1.5 py-0.5 text-[9px] font-medium text-indigo-600 dark:text-indigo-300">
                  主导
                </span>
              )}
              <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: stats.color || '#cbd5e1' }} />
            </div>
            <div className="mt-0.5 truncate px-3 text-[10px] text-neutral-400 dark:text-stone-500">
              {agentMeta(agent)}
            </div>
            <div className="flex items-center gap-2 px-3 pb-2 pt-1 text-[10px] text-neutral-500 dark:text-stone-400">
              {stats.running > 0 && <span className="text-sky-600 dark:text-sky-400">执行中 {stats.running}</span>}
              {stats.waiting > 0 && <span className="text-amber-600 dark:text-amber-400">等待 {stats.waiting}</span>}
              {stats.completed > 0 && <span className="text-emerald-600 dark:text-emerald-400">完成 {stats.completed}</span>}
              {stats.total === 0 && <span className="text-neutral-400 dark:text-stone-500">暂无任务</span>}
            </div>
          </button>
        );
      })}

      <div className="pointer-events-none absolute bottom-2 left-3 text-[10px] text-neutral-400 dark:text-stone-500">
        点成员节点选择派单对象，底部输入框发送；实线表示已有任务流向
      </div>
    </div>
  );
}

export default CollabCanvas;
