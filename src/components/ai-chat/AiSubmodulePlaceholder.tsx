// AI 对话 · 子模块占位主区（桌面版阶段一：切换骨架已就位，子模块内容后续填充）。
// work(AI 办公) / workflow(AI 工作流) 暂以该占位页呈现，配色与抽屉一致，便于后续逐级落地。
import { memo } from 'react';
import { Wrench } from 'lucide-react';
import type { AISubmoduleDef } from '@/core/ai/submodules';

export const AiSubmodulePlaceholder = memo(function AiSubmodulePlaceholder({
  mod,
}: {
  mod: AISubmoduleDef;
}) {
  const a = mod.accent;
  return (
    <div className="flex-1 flex items-center justify-center overflow-hidden">
      <div className="flex flex-col items-center text-center max-w-md px-6">
        <div
          className={`flex h-16 w-16 items-center justify-center rounded-2xl ${a.bgSoft} ${a.bgSoftDark} ${a.text} ${a.textDark}`}
        >
          {mod.icon}
        </div>
        <h2 className={`mt-4 text-lg font-bold ${a.text} ${a.textDark}`}>{mod.name}</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-stone-400">{mod.desc}</p>
        <div className="mt-6 flex items-center gap-2 rounded-full border border-neutral-200 dark:border-stone-700/60 px-4 py-1.5 text-xs text-neutral-400 dark:text-stone-500">
          <Wrench size={13} />
          子模块骨架已就位，能力正分级落地中
        </div>
      </div>
    </div>
  );
});

export default AiSubmodulePlaceholder;