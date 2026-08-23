// AIWork / AIWorkflow 共用内容区分段切换器：任务区 | 产物区。
// 产物区为两模块共用产物库查看区；任务区为各模块主内容（AIWork 对话台 / AIWorkflow 蓝图）。
import { memo } from 'react';
import { ListTree, FileText } from 'lucide-react';

export type AiWorkTab = 'task' | 'product';

interface AiWorkTabsProps {
  value: AiWorkTab;
  onChange: (tab: AiWorkTab) => void;
}

export const AiWorkTabs = memo(function AiWorkTabs({ value, onChange }: AiWorkTabsProps) {
  const base =
    'btn-press flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors';
  const opt = (tab: AiWorkTab, active: boolean, icon: React.ReactNode, label: string) => (
    <button
      onClick={() => onChange(tab)}
      className={`${base} ${
        active
          ? 'bg-[var(--element-color-raw)] text-white shadow-sm'
          : 'text-neutral-500 dark:text-stone-400 hover:bg-[var(--element-muted)]'
      }`}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <div className="flex shrink-0 items-center gap-1 rounded-xl bg-black/5 p-0.5 dark:bg-white/5">
      {opt('task', value === 'task', <ListTree size={14} />, '任务区')}
      {opt('product', value === 'product', <FileText size={14} />, '产物区')}
    </div>
  );
});

export default AiWorkTabs;