// 独立「AI 对话」模块 · 会话列表侧栏 —— 复用侧边栏模板（ModuleSidebarShell + NestedNavList）。
// 受控于上层共享的 useAiChat 实例；侧栏只负责展示与切换会话，逻辑全在 hook 内。
import { memo, useMemo, useState } from 'react';
import { Bot, Users, MessageSquare, Trash2, Pencil } from 'lucide-react';
import { ModuleSidebarShell } from '@/components/ModuleSidebarShell';
import { NestedNavList, type NavLayerItem } from '@/components/NestedNavList';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { AiChatCompanionAvatar } from '@/components/ai-chat/AiChatCompanionCard';
import { useCompanionStore } from '@/mobile/stores/companionStore';
import type { Conversation } from '@/components/capsule/types';

export interface AiChatSidebarProps {
  conversations: Conversation[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** 创建群聊：传入选中的伴侣 id（≥2）与可选的群聊名 */
  onNewGroup: (participantIds: string[], groupName?: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onOpenModuleSettings?: () => void;
}

export const AiChatSidebar = memo(function AiChatSidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onNewGroup,
  onDelete,
  onRename,
  onOpenModuleSettings,
}: AiChatSidebarProps) {
  const [query, setQuery] = useState('');
  const [showGroupDialog, setShowGroupDialog] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => (c.title || '').toLowerCase().includes(q));
  }, [conversations, query]);

  const items: NavLayerItem[] = filtered.map((c) => {
    const count = c.messages.length;
    const isGroup = c.mode === 'group';
    return {
      id: c.id,
      icon: isGroup ? <Users size={15} /> : <MessageSquare size={15} />,
      title: c.title || '新对话',
      subtitle: isGroup
        ? `群聊 · ${c.participants?.length ?? 0} 位伴侣`
        : count ? `${count} 条消息` : '暂无消息',
      active: c.id === activeId,
      contextMenu: (
        <>
          <ContextMenuItem onSelect={() => {
            const next = window.prompt('重命名对话', c.title);
            if (next !== null) onRename(c.id, next);
          }}>
            <span className="flex items-center gap-2"><Pencil size={14} /> 重命名</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => onDelete(c.id)}>
            <span className="flex items-center gap-2 text-red-500"><Trash2 size={14} /> 删除</span>
          </ContextMenuItem>
        </>
      ),
    };
  });

  return (
    <ModuleSidebarShell
      moduleId="ai-chat"
      icon={<Bot size={20} />}
      title="AI 对话"
      primaryAction={{ label: '新对话', onClick: onNew }}
      secondaryActions={[{ icon: <Users size={15} />, label: '新群聊', onClick: () => setShowGroupDialog(true) }]}
      onOpenModuleSettings={onOpenModuleSettings}
      searchQuery={query}
      onSearchChange={setQuery}
      searchPlaceholder="搜索对话"
    >
      <NestedNavList
        layers={[{ title: '对话', items, emptyText: '没有匹配的对话' }]}
        onBack={() => {}}
        onItemClick={(item) => onSelect(item.id)}
      />
      {showGroupDialog && (
        <GroupCreateDialog
          onClose={() => setShowGroupDialog(false)}
          onConfirm={(ids, name) => {
            onNewGroup(ids, name);
            setShowGroupDialog(false);
          }}
        />
      )}
    </ModuleSidebarShell>
  );
});

/**
 * 群聊创建弹窗：伴侣多选卡，必须选 ≥2 个伴侣才能确认。
 * 数据不向用户暴露 severity / 争论 / 调侃等设定，维持沉浸感。
 */
function GroupCreateDialog({
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

export default AiChatSidebar;
