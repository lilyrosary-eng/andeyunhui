// Agent「计划 / 待办」面板 —— 所有 AI 对话类界面可复用（AI 对话模块 / 浮岛 AI 编程 / 移动端）。
//
// 数据来源：Rust `plan` 工具执行后回传的 `plan` 快照（ai-agent-step 事件的 plan 字段）；
// 待确认状态来自 `ai-plan-approval` 事件（消息上的 planApproval）。
//
// 两种形态：
//   · 只读：标题、进度、每项完成状态（完成划掉）。勾选由 AI 调 mark_done 完成。
//   · 确认闸门：后端 create_plan 后暂停，面板底部渲染「确认并执行 / 重新规划」；
//     传入 onDecision 才渲染按钮，没传就退化成只读（不认识闸门的入口不会被卡住）。

import { memo, useState } from 'react';
import { CheckCircle2, Circle, ChevronDown, ChevronRight, ListTodo, Play, RotateCcw } from 'lucide-react';
import type { PlanSnapshot, PlanApproval } from '@/core/ai/planTypes';

export interface PlanPanelProps {
  plan: PlanSnapshot | null | undefined;
  /** 默认主题 / 浮岛胶囊（深色气泡） */
  variant?: 'default' | 'capsule';
  defaultExpanded?: boolean;
  /** 计划确认闸门状态：state='pending' 时渲染确认/否决按钮 */
  approval?: PlanApproval | null;
  /** 用户决议回调（确认=true / 重新规划=false）。不传则不渲染按钮（只读面板）。 */
  onDecision?: (approved: boolean) => void | Promise<void>;
}

export const PlanPanel = memo(function PlanPanel({
  plan,
  variant = 'default',
  defaultExpanded = true,
  approval,
  onDecision,
}: PlanPanelProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [deciding, setDeciding] = useState(false);
  // 只有「等确认」且调用方真的能处理决议时才算闸门，否则退化成只读。
  const pending = approval?.state === 'pending' && !!onDecision;
  if (!plan) return null;
  // 没有任何待办、也不在等确认 → 没什么可展示（create_plan 刚建的空白计划不占地方）
  if (plan.todos.length === 0 && !pending) return null;

  const total = plan.todos.length;
  const doneCount = plan.todos.filter((t) => t.done).length;
  const progress = total > 0 ? Math.round((doneCount / total) * 100) : 0;
  const capsule = variant === 'capsule';

  const boxCls = capsule
    ? 'border-white/15 bg-white/[0.06]'
    : 'border-sky-300/40 dark:border-sky-800/40 bg-sky-50/60 dark:bg-sky-950/20';
  const accentCls = capsule ? 'text-[#e6c35c]' : 'text-sky-600 dark:text-sky-400';
  const titleCls = capsule ? 'text-white/85' : 'text-neutral-800 dark:text-stone-100';
  const mutedCls = capsule ? 'text-white/45' : 'text-neutral-400 dark:text-stone-500';
  const trackCls = capsule ? 'bg-white/10' : 'bg-sky-200/50 dark:bg-sky-800/50';
  const barCls = capsule ? 'bg-[#e6c35c]' : 'bg-sky-500';
  const dividerCls = capsule ? 'border-white/10' : 'border-sky-200/60 dark:border-sky-800/40';
  const primaryBtn = capsule
    ? 'bg-[#e6c35c] text-[#1c1a14] hover:bg-[#f0d27a]'
    : 'bg-sky-600 text-white hover:bg-sky-500';
  const ghostBtn = capsule
    ? 'border border-white/20 text-white/70 hover:bg-white/10'
    : 'border border-neutral-300 dark:border-stone-600 text-neutral-600 dark:text-stone-300 hover:bg-neutral-100 dark:hover:bg-stone-700/50';

  const decide = async (approved: boolean) => {
    if (deciding || !onDecision) return;
    setDeciding(true);
    try {
      await onDecision(approved);
    } finally {
      setDeciding(false);
    }
  };

  return (
    <div className={`mb-2 rounded-xl border overflow-hidden text-xs ${boxCls}`}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left transition-colors ${
          capsule ? 'hover:bg-white/[0.06]' : 'hover:bg-sky-100/60 dark:hover:bg-sky-900/25'
        }`}
      >
        {expanded ? <ChevronDown size={12} className={accentCls} /> : <ChevronRight size={12} className={accentCls} />}
        <ListTodo size={13} className={accentCls} />
        <span className={`font-medium truncate max-w-[55%] ${titleCls}`} title={plan.title || '执行计划'}>
          {plan.title || '执行计划'}
        </span>
        {pending && (
          <span className={`shrink-0 ${accentCls} opacity-80`}>待确认</span>
        )}
        {total > 0 && (
          <>
            <span className={`shrink-0 ${accentCls} opacity-70`}>{doneCount}/{total}</span>
            <div className={`flex-1 h-1 rounded-full overflow-hidden min-w-[32px] ${trackCls}`}>
              <div className={`h-full ${barCls} transition-all`} style={{ width: `${progress}%` }} />
            </div>
          </>
        )}
      </button>

      {expanded && (
        <div className="px-2 pb-2 space-y-0.5">
          {plan.todos.length === 0 ? (
            <div className={`px-1.5 py-1 ${mutedCls}`}>（还没有待办）</div>
          ) : plan.todos.map((t) => (
            <div key={t.id} className="flex items-start gap-1.5 px-1.5 py-0.5">
              {t.done ? (
                <CheckCircle2 size={13} className={capsule ? 'text-[#e6c35c]' : 'text-emerald-500'} />
              ) : (
                <Circle size={13} className={mutedCls} />
              )}
              <span
                className={`flex-1 leading-relaxed ${
                  t.done
                    ? `line-through ${mutedCls}`
                    : capsule
                      ? 'text-white/75'
                      : 'text-neutral-700 dark:text-stone-200'
                }`}
              >
                {t.content}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 确认闸门 / 决议结果 */}
      {(pending || approval?.state === 'approved' || approval?.state === 'rejected') && (
        <div className={`px-2.5 pb-2 pt-1.5 border-t ${dividerCls}`}>
          {pending ? (
            <>
              <div className={`mb-1.5 ${mutedCls}`}>AI 已提交计划，确认后开始执行</div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void decide(true)}
                  disabled={deciding}
                  className={`btn-press flex items-center gap-1 rounded-lg px-2.5 py-1 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${primaryBtn}`}
                >
                  <Play size={12} /> 确认并执行
                </button>
                <button
                  type="button"
                  onClick={() => void decide(false)}
                  disabled={deciding}
                  className={`btn-press flex items-center gap-1 rounded-lg px-2.5 py-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${ghostBtn}`}
                >
                  <RotateCcw size={12} /> 重新规划
                </button>
              </div>
            </>
          ) : approval?.state === 'approved' ? (
            <div className={capsule ? 'text-[#e6c35c]' : 'text-emerald-600 dark:text-emerald-400'}>
              已确认此计划
            </div>
          ) : (
            <div className={mutedCls}>已否决此计划 · AI 重新规划</div>
          )}
        </div>
      )}
    </div>
  );
});

export default PlanPanel;
