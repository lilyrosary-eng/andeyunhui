// 独立「AI 对话」模块 · 会话列表侧栏 —— 复用侧边栏模板（ModuleSidebarShell + NestedNavList）。
// 受控于上层共享的 useAiChat 实例；侧栏只负责展示与切换会话，逻辑全在 hook 内。
import { memo, useMemo, useState } from 'react';
import { Bot, Users, MessageSquare, Trash2, Pencil, LayoutGrid } from 'lucide-react';
import { ModuleSidebarShell } from '@/components/ModuleSidebarShell';
import { NestedNavList, type NavLayerItem } from '@/components/NestedNavList';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { GroupCreateDialog } from '@/components/ai-chat/GroupCreateDialog';
import type { Conversation } from '@/components/capsule/types';
import type { AISubmoduleDef } from '@/core/ai/submodules';

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
  /** 子模块切换入口（桌面版接入）：标题区右上角显示「切换」按钮；不传则不显示 */
  submodule?: AISubmoduleDef;
  onOpenSubmoduleSwitcher?: () => void;
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
  submodule,
  onOpenSubmoduleSwitcher,
}: AiChatSidebarProps) {
  const [query, setQuery] = useState('');
  const [showGroupDialog, setShowGroupDialog] = useState(false);

  // 子模块隔离：仅「AI 对话」展示会话列表 / 新群聊；work / workflow 清空内容区
  const isChat = !submodule || submodule.id === 'chat';

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
      primaryAction={isChat ? { label: '新对话', onClick: onNew } : undefined}
      secondaryActions={isChat ? [
        { icon: <Users size={15} />, label: '新群聊', onClick: () => setShowGroupDialog(true) },
      ] : undefined}
      titleActions={onOpenSubmoduleSwitcher ? (
        <button
          onClick={onOpenSubmoduleSwitcher}
          title="切换子模块"
          className="btn-press flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 hover:text-[var(--element-color-raw)] hover:bg-[var(--element-muted)] transition-colors"
        >
          <LayoutGrid size={15} />
          切换
        </button>
      ) : undefined}
      onOpenModuleSettings={onOpenModuleSettings}
      searchQuery={isChat ? query : ''}
      onSearchChange={isChat ? setQuery : undefined}
      searchPlaceholder="搜索对话"
    >
      {isChat ? (
        <>
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
        </>
      ) : (
        <div className="flex-1 flex items-center justify-center px-2">
          <div className="text-center">
            <div className={`text-sm font-semibold ${submodule?.accent.text} ${submodule?.accent.textDark}`}>
              {submodule?.name}
            </div>
            <div className="text-xs text-neutral-400 dark:text-stone-500 mt-1">
              独立工作区 · 能力建设中
            </div>
          </div>
        </div>
      )}
    </ModuleSidebarShell>
  );
});

export default AiChatSidebar;
