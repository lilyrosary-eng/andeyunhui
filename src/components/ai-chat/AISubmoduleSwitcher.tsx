// AI 对话 · 子模块切换抽屉（桌面版）。
// 对齐音乐模块 ModuleDrawer 范式：右侧滑出 + 遮罩 + 卡片配色高亮当前项。
// 去掉了音乐那套 i18n / 折叠子菜单，仅保留三个同级子模块的切换。
import { memo, useEffect, useState } from 'react';
import { X, Check } from 'lucide-react';
import {
  AI_SUBMODULES,
  type AISubmoduleDef,
  type AISubmoduleId,
  type AISubmoduleAccent,
} from '@/core/ai/submodules';

interface AISubmoduleDrawerProps {
  open: boolean;
  current: AISubmoduleId;
  onSelect: (id: AISubmoduleId) => void;
  onClose: () => void;
}

// 单个子模块项：卡片 + 图标 + 标题 + 描述 + 激活对勾（复用 ModuleDrawer 卡片语言）
function SubmoduleItem({
  mod,
  active,
  onSelect,
}: {
  mod: AISubmoduleDef;
  active: boolean;
  onSelect: () => void;
}) {
  const a: AISubmoduleAccent = mod.accent;
  return (
    <button
      onClick={onSelect}
      className={`w-full flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${
        active
          ? `${a.borderActive} ${a.borderActiveDark} ${a.bgActive} ${a.bgActiveDark} hover:brightness-[1.02]`
          : 'border-neutral-200/60 dark:border-stone-700/60 hover:bg-neutral-100/70 dark:hover:bg-stone-700/50'
      }`}
    >
      <div
        className={`flex h-9 w-9 items-center justify-center rounded-lg shrink-0 ${
          active
            ? `${a.bgSoft} ${a.bgSoftDark} ${a.text} ${a.textDark}`
            : 'bg-neutral-200/70 dark:bg-stone-600/50 text-neutral-500 dark:text-stone-300'
        }`}
      >
        {mod.icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium truncate ${
          active ? `${a.text} ${a.textDark}` : 'text-neutral-700 dark:text-stone-200'
        }`}>
          {mod.name}
        </p>
        <p className="text-xs text-neutral-400 dark:text-stone-500 truncate mt-0.5">{mod.desc}</p>
      </div>
      {active && (
        <span
          className={`flex h-5 w-5 items-center justify-center rounded-full ${a.check} text-white shrink-0`}
        >
          <Check size={12} />
        </span>
      )}
    </button>
  );
}

export const AISubmoduleDrawer = memo(function AISubmoduleDrawer({
  open,
  current,
  onSelect,
  onClose,
}: AISubmoduleDrawerProps) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
      const timer = setTimeout(() => setMounted(false), 300);
      return () => clearTimeout(timer);
    }
  }, [open]);

  if (!mounted) return null;

  return (
    <div className="absolute inset-0 z-40 flex justify-end overflow-hidden">
      {/* 遮罩 */}
      <div
        className={`absolute inset-0 bg-black/50 transition-opacity duration-300 ${
          visible ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={onClose}
      />
      {/* 面板 */}
      <div
        className={`relative z-50 h-full w-80 bg-[var(--nav-bg)]/95 backdrop-blur-xl shadow-2xl transform transition-transform duration-300 ease-out flex flex-col ${
          visible ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="shrink-0 flex items-center justify-between px-4 py-4 border-b border-neutral-200/60 dark:border-stone-700/60">
          <h3 className="text-base font-semibold text-neutral-800 dark:text-stone-100">
            切换子模块
          </h3>
          <button
            onClick={onClose}
            className="btn-press p-1.5 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200 transition-colors"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {AI_SUBMODULES.map((mod) => (
            <SubmoduleItem
              key={mod.id}
              mod={mod}
              active={mod.id === current}
              onSelect={() => {
                onSelect(mod.id);
                onClose();
              }}
            />
          ))}
          <p className="text-xs text-neutral-400 dark:text-stone-500 leading-relaxed pt-1">
            AI 对话为基础；AI 办公负责把成果物落地到笔记；AI 工作流以对话驱动蓝图节点，专业可控。
          </p>
        </div>
      </div>
    </div>
  );
});

export default AISubmoduleDrawer;