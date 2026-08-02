// 茑萝 · IDE Agent 计划模式 UI
// 增强现有 planChips（string[]）为结构化计划步骤：{id, text, status}。
// 支持 <plan><step>…</step></plan> XML 标签解析，用户可确认/编辑/跳过步骤。
// 对齐 learn-coding-agent 计划模式 + terax-ai TodoStrip/PlanDiffReview 设计。

const React = window.__HOST_REACT__;
const { useState, useCallback, useEffect } = React;
import { CheckCircle2, Circle, Loader2, SkipForward, ListTodo, ChevronDown, ChevronRight } from 'lucide-react';

// ===== 计划步骤类型 =====
export type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'skipped';

export interface PlanStep {
  id: string;
  text: string;
  status: PlanStepStatus;
}

export interface PlanState {
  steps: PlanStep[];
  /** 计划是否已被用户确认（确认后 agent 开始执行） */
  confirmed: boolean;
  /** 计划是否可见（面板展开/收起） */
  visible: boolean;
}

export const EMPTY_PLAN: PlanState = { steps: [], confirmed: false, visible: true };

// ===== XML 解析：<plan><step>…</step></plan> =====
export function parsePlanXml(raw: string): PlanStep[] | null {
  const planMatch = raw.match(/<plan\b[^>]*>([\s\S]*?)<\/plan>/i);
  if (!planMatch) return null;
  const body = planMatch[1];
  const stepRe = /<step\b[^>]*>([\s\S]*?)<\/step>/gi;
  const steps: PlanStep[] = [];
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = stepRe.exec(body)) !== null) {
    const text = m[1].trim().replace(/^[\d.、\s]+/, ''); // 去掉前缀序号
    if (text) {
      steps.push({ id: 'ps_' + Date.now().toString(36) + '_' + idx, text, status: 'pending' });
      idx++;
    }
  }
  return steps.length > 0 ? steps : null;
}

// ===== 计划面板组件 =====
interface PlanModePanelProps {
  plan: PlanState;
  onUpdate: (plan: PlanState) => void;
  /** 用户确认计划（允许 agent 开始执行） */
  onConfirm: () => void;
  /** 用户拒绝计划（agent 需重新规划） */
  onReject: () => void;
  /** 标记某步骤为当前执行中 */
  onStepActive?: (stepId: string) => void;
  /** 当前正在执行的工具描述（显示在步骤旁） */
  currentActivity?: string;
}

export function PlanModePanel({ plan, onUpdate, onConfirm, onReject, onStepActive, currentActivity }: PlanModePanelProps) {
  const [expanded, setExpanded] = useState(true);

  if (plan.steps.length === 0) return null;

  const toggleStep = (stepId: string) => {
    onUpdate({
      ...plan,
      steps: plan.steps.map((s) => s.id === stepId ? { ...s, status: s.status === 'done' ? 'pending' : 'done' } : s),
    });
  };

  const skipStep = (stepId: string) => {
    onUpdate({
      ...plan,
      steps: plan.steps.map((s) => s.id === stepId ? { ...s, status: 'skipped' } : s),
    });
  };

  const editStep = (stepId: string, text: string) => {
    onUpdate({
      ...plan,
      steps: plan.steps.map((s) => s.id === stepId ? { ...s, text } : s),
    });
  };

  const doneCount = plan.steps.filter((s) => s.status === 'done').length;
  const totalCount = plan.steps.length;
  const progress = Math.round((doneCount / totalCount) * 100);

  return (
    <div className="border border-blue-300/40 dark:border-blue-700/40 rounded-lg bg-blue-50/50 dark:bg-blue-950/20 overflow-hidden text-xs">
      {/* 头部：标题 + 进度 + 展开/收起 */}
      <div
        className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-blue-100/50 dark:hover:bg-blue-900/20 transition-colors"
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? <ChevronDown size={13} className="text-blue-500" /> : <ChevronRight size={13} className="text-blue-500" />}
        <ListTodo size={13} className="text-blue-500" />
        <span className="font-medium text-blue-700 dark:text-blue-300">执行计划</span>
        <span className="text-blue-500/70">{doneCount}/{totalCount}</span>
        {/* 进度条 */}
        <div className="flex-1 h-1 rounded-full bg-blue-200/50 dark:bg-blue-800/50 overflow-hidden min-w-[40px]">
          <div className="h-full bg-blue-500 transition-all" style={{ width: `${progress}%` }} />
        </div>
        {plan.confirmed ? (
          <span className="text-emerald-500 text-[10px] font-medium">已确认</span>
        ) : (
          <span className="text-amber-500 text-[10px] font-medium">待确认</span>
        )}
      </div>

      {expanded && (
        <div className="px-2 pb-2 space-y-0.5">
          {/* 步骤列表 */}
          {plan.steps.map((step, i) => (
            <div
              key={step.id}
              className={`flex items-start gap-1.5 px-1.5 py-1 rounded transition-colors ${
                step.status === 'in_progress' ? 'bg-blue-100/50 dark:bg-blue-900/30' : 'hover:bg-black/5 dark:hover:bg-white/5'
              }`}
            >
              {/* 状态图标 */}
              <button
                onClick={() => toggleStep(step.id)}
                className="mt-0.5 shrink-0"
                title={step.status === 'done' ? '已完成（点击重置）' : '点击标记完成'}
              >
                {step.status === 'done' ? (
                  <CheckCircle2 size={14} className="text-emerald-500" />
                ) : step.status === 'in_progress' ? (
                  <Loader2 size={14} className="text-blue-500 animate-spin" />
                ) : step.status === 'skipped' ? (
                  <SkipForward size={14} className="text-neutral-400" />
                ) : (
                  <Circle size={14} className="text-neutral-400 dark:text-stone-500" />
                )}
              </button>

              {/* 步骤文本 */}
              <span className={`flex-1 ${step.status === 'done' ? 'line-through text-neutral-400' : step.status === 'skipped' ? 'line-through text-neutral-300' : 'text-neutral-700 dark:text-stone-200'}`}>
                {step.text}
              </span>

              {/* 跳过按钮 */}
              {step.status !== 'done' && step.status !== 'skipped' && (
                <button
                  onClick={() => skipStep(step.id)}
                  className="shrink-0 text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-300 opacity-0 group-hover:opacity-100"
                  title="跳过此步骤"
                >
                  <SkipForward size={11} />
                </button>
              )}

              {/* 当前活动提示 */}
              {step.status === 'in_progress' && currentActivity && (
                <span className="text-[10px] text-blue-500 shrink-0 max-w-[120px] truncate">{currentActivity}</span>
              )}
            </div>
          ))}

          {/* 确认/拒绝按钮 */}
          {!plan.confirmed && (
            <div className="flex gap-1.5 pt-1.5">
              <button
                onClick={onConfirm}
                className="flex-1 py-1 rounded text-center bg-blue-500 text-white hover:bg-blue-600 transition-colors font-medium"
              >
                ✅ 确认并执行
              </button>
              <button
                onClick={onReject}
                className="flex-1 py-1 rounded text-center bg-neutral-200 dark:bg-stone-700 text-neutral-600 dark:text-stone-300 hover:bg-neutral-300 dark:hover:bg-stone-600 transition-colors"
              >
                ❌ 重新规划
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
