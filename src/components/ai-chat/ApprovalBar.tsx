// 统一的「需要用户确认」横条。
//
// 两处来源共用同一套视觉与交互：
// - Agent 工具审批（ai-agent-approval → ai_agent_approve）；
// - 协作 ACP 权限请求（collab-permission → collab_permission_reply）。
//
// 组件本身不关心来源，只负责把标题、说明和可选动作摆出来；
// 超时清理由调用方负责（两个后端的超时口径不同）。
import type { ReactNode } from 'react';

export interface ApprovalOption {
  id: string;
  label: string;
  /** primary：主行动（放行/确认）；danger：拒绝/危险动作；缺省为普通描边。 */
  kind?: 'primary' | 'danger';
}

export interface ApprovalBarProps {
  title: string;
  detail?: ReactNode;
  options: ApprovalOption[];
  onSelect: (id: string) => void;
  /** 额外拒绝/取消入口（可以不传，例如 ACP 的选项里已含拒绝）。 */
  onReject?: () => void;
  rejectLabel?: string;
  disabled?: boolean;
  className?: string;
}

const optionClass = (kind: ApprovalOption['kind']) => {
  if (kind === 'primary') {
    return 'border-amber-500/60 bg-white/80 font-medium text-amber-800 hover:bg-white dark:bg-stone-800/60 dark:text-amber-200';
  }
  if (kind === 'danger') {
    return 'border-neutral-300 text-neutral-600 hover:bg-neutral-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800';
  }
  return 'border-amber-500/40 bg-white/60 text-amber-800 hover:bg-white dark:bg-stone-800/50 dark:text-amber-200';
};

export function ApprovalBar({
  title,
  detail,
  options,
  onSelect,
  onReject,
  rejectLabel = '拒绝',
  disabled = false,
  className = '',
}: ApprovalBarProps) {
  return (
    <div className={`rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 ${className}`}>
      <div className="text-xs font-medium text-amber-800 dark:text-amber-200">{title}</div>
      {detail ? (
        <div className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-amber-700/80 dark:text-amber-300/80">
          {detail}
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {options.map((option) => (
          <button
            key={option.id}
            onClick={() => onSelect(option.id)}
            disabled={disabled}
            className={`btn-press rounded-lg border px-3 py-1 text-[11px] disabled:opacity-40 ${optionClass(option.kind)}`}
          >
            {option.label}
          </button>
        ))}
        {onReject && (
          <button
            onClick={onReject}
            disabled={disabled}
            className="btn-press rounded-lg border border-neutral-300 px-3 py-1 text-[11px] text-neutral-600 hover:bg-neutral-100 disabled:opacity-40 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800"
          >
            {rejectLabel}
          </button>
        )}
      </div>
    </div>
  );
}

export default ApprovalBar;
