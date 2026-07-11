import { type ReactNode } from 'react';
import { X } from 'lucide-react';

export interface ModuleSettingsPanelProps {
  title: string;
  icon: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

/** 通用模块设置面板 — 覆盖在主内容区上方 */
export function ModuleSettingsPanel({ title, icon, onClose, children }: ModuleSettingsPanelProps) {
  return (
    <div className="flex-1 h-full overflow-y-auto main-panel-bg p-6 fade-in">
      <div className="max-w-lg mx-auto">
        {/* 标题栏 */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <span className="text-[var(--element-bg)]">{icon}</span>
            <h2 className="text-lg font-semibold text-neutral-800 dark:text-stone-100">{title} 设置</h2>
          </div>
          <button
            onClick={onClose}
            className="btn-press w-8 h-8 flex items-center justify-center rounded-lg text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-300 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* 设置内容 */}
        <div className="space-y-5">
          {children}
        </div>
      </div>
    </div>
  );
}

export default ModuleSettingsPanel;