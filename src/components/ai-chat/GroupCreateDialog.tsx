// 群聊创建弹窗（ai-chat 模块）：伴侣多选卡，必须选 ≥2 个伴侣才能确认。
// 数据不向用户暴露 severity / 争论 / 调侃等设定，维持沉浸感。
// 从 AiChatSidebar 内联抽出为独立文件，保持模块归属。
import { useState } from 'react';
import { useCompanionStore } from '@/core/stores/companionStore';
import { AiChatCompanionAvatar } from '@/components/ai-chat/AiChatCompanionCard';

export function GroupCreateDialog({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (participantIds: string[], groupName?: string) => void;
}) {
  const companions = useCompanionStore((s) => s.collection.companions);
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState('');

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const canConfirm = selected.length >= 2;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[420px] max-w-[92vw] max-h-[80vh] overflow-hidden rounded-2xl bg-white dark:bg-stone-900 shadow-2xl border border-neutral-200 dark:border-stone-700 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-4 pb-3 border-b border-neutral-200 dark:border-stone-700">
          <h3 className="text-base font-semibold text-neutral-800 dark:text-stone-100">新建群聊</h3>
          <p className="text-xs text-neutral-400 dark:text-stone-500 mt-1">
            选择至少 2 位伴侣一起聊天
          </p>
        </div>

        <div className="px-5 py-3 overflow-y-auto">
          <div className="grid grid-cols-2 gap-2">
            {companions.map((c) => {
              const on = selected.includes(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => toggle(c.id)}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-xl border transition-colors ${
                    on
                      ? 'border-[var(--element-color-raw)] bg-[var(--element-muted)]'
                      : 'border-neutral-200 dark:border-stone-700 hover:bg-black/5 dark:hover:bg-white/5'
                  }`}
                >
                  <AiChatCompanionAvatar companion={c} size={32} />
                  <span className="text-sm text-neutral-700 dark:text-stone-200 truncate">{c.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-neutral-200 dark:border-stone-700">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="群聊名称（可选）"
            className="w-full px-3 py-2 rounded-lg bg-neutral-100 dark:bg-stone-800 text-sm text-neutral-700 dark:text-stone-200 outline-none focus:ring-1 focus:ring-[var(--element-color-raw)]"
          />
          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs text-neutral-400 dark:text-stone-500">已选 {selected.length} 位</span>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="px-3 py-1.5 rounded-lg text-sm text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5"
              >
                取消
              </button>
              <button
                disabled={!canConfirm}
                onClick={() => canConfirm && onConfirm(selected, name.trim() || undefined)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  canConfirm
                    ? 'element-muted hover:element-hover'
                    : 'bg-neutral-200 dark:bg-stone-700 text-neutral-400 dark:text-stone-500 cursor-not-allowed'
                }`}
              >
                创建群聊
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}