// 独立「AI 对话」模块 · 会话列表侧栏 —— 复用侧边栏模板（ModuleSidebarShell + NestedNavList）。
// 受控于上层共享的 useAiChat 实例；侧栏只负责展示与切换会话，逻辑全在 hook 内。
import { memo, useMemo, useState } from 'react';
import { Bot, Plus, MessageSquare, Trash2, Pencil } from 'lucide-react';
import { ModuleSidebarShell } from '@/components/ModuleSidebarShell';
import { NestedNavList, type NavLayerItem } from '@/components/NestedNavList';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import type { Conversation } from '@/components/capsule/types';

export interface AiChatSidebarProps {
  conversations: Conversation[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onOpenModuleSettings?: () => void;
}

export const AiChatSidebar = memo(function AiChatSidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onRename,
  onOpenModuleSettings,
}: AiChatSidebarProps) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => (c.title || '').toLowerCase().includes(q));
  }, [conversations, query]);

  const items: NavLayerItem[] = filtered.map((c) => {
    const count = c.messages.length;
    return {
      id: c.id,
      icon: <MessageSquare size={15} />,
      title: c.title || '新对话',
      subtitle: count ? `${count} 条消息` : '暂无消息',
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
    </ModuleSidebarShell>
  );
});

export default AiChatSidebar;
