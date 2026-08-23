// 独立「AI 对话」模块 · 左侧共享侧栏 —— 复用侧边栏模板（ModuleSidebarShell + NestedNavList）。
// 按当前子模块切换内容，避免各子模块视图内部再自建第二层侧栏：
//   - chat      会话列表（对话 / 群聊）
//   - work      专属产物库列表（AIWork 独立 AIGC 工作台）
//   - workflow  任务列表（AIWorkflow 蓝图编排，支持建/选/改名/删）
// 逻辑由宿主（Root）托管，侧栏只负责展示与触发动作。
import { memo, useState } from 'react';
import { Bot, Users, MessageSquare, Trash2, Pencil, LayoutGrid, FileText, Workflow } from 'lucide-react';
import { ModuleSidebarShell } from '@/components/ModuleSidebarShell';
import { NestedNavList, type NavLayerItem } from '@/components/NestedNavList';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { GroupCreateDialog } from '@/components/ai-chat/GroupCreateDialog';
import type { Conversation } from '@/components/capsule/types';
import type { AISubmoduleDef } from '@/core/ai/submodules';
import type { WorkflowDoc } from '@/core/ai/aiWorkflows';
import type { AiWorkProduct } from '@/core/ai/aiWorkProducts';

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
  /** work 子模块：专属产物库列表（复用共享侧栏渲染） */
  work?: {
    products: AiWorkProduct[];
    viewingId?: string | null;
    onView: (p: AiWorkProduct) => void;
    onDeleteProduct: (id: string) => void;
  };
  /** workflow 子模块：任务列表（复用共享侧栏渲染） */
  workflow?: {
    workflows: WorkflowDoc[];
    activeId: string | null;
    onSelect: (id: string) => void;
    onNew: () => void;
    onRename: (id: string, name: string) => void;
    onDelete: (id: string) => void;
  };
  /** workflow 子模块切到「产物区」时，左侧侧栏也改为展示产物列表（与产物区共用同一查看器） */
  productMode?: boolean;
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
  work,
  workflow,
  productMode,
}: AiChatSidebarProps) {
  const [query, setQuery] = useState('');
  const [showGroupDialog, setShowGroupDialog] = useState(false);

  const isChat = !submodule || submodule.id === 'chat';
  const isWork = submodule?.id === 'work';
  const isWorkflow = submodule?.id === 'workflow';
  // 产物区：work 子模块恒为产物；workflow 切到「产物区」时也展示产物列表
  const renderProduct = isWork || (isWorkflow && productMode);

  const filtered = conversations.filter((c) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (c.title || '').toLowerCase().includes(q);
  });

  const convItems: NavLayerItem[] = filtered.map((c) => {
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

  const taskItems: NavLayerItem[] = (workflow?.workflows ?? []).map((w) => ({
    id: w.id,
    icon: <Workflow size={15} />,
    title: w.name || '未命名任务',
    subtitle: `${w.nodes.length} 节点`,
    active: w.id === workflow?.activeId,
    contextMenu: (
      <>
        <ContextMenuItem onSelect={() => {
          const next = window.prompt('任务改名', w.name);
          if (next !== null) workflow?.onRename(w.id, next);
        }}>
          <span className="flex items-center gap-2"><Pencil size={14} /> 重命名</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => workflow?.onDelete(w.id)}>
          <span className="flex items-center gap-2 text-red-500"><Trash2 size={14} /> 删除</span>
        </ContextMenuItem>
      </>
    ),
  }));

  const productItems: NavLayerItem[] = (work?.products ?? []).map((p) => ({
    id: p.id,
    icon: <FileText size={15} />,
    title: p.title || 'AI 产出',
    subtitle: new Date(p.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    active: p.id === work?.viewingId,
    contextMenu: (
      <ContextMenuItem onSelect={() => work?.onDeleteProduct(p.id)}>
        <span className="flex items-center gap-2 text-red-500"><Trash2 size={14} /> 删除</span>
      </ContextMenuItem>
    ),
  }));

  return (
    <ModuleSidebarShell
      moduleId="ai-chat"
      icon={renderProduct ? <FileText size={20} /> : isWorkflow ? <Workflow size={20} /> : <Bot size={20} />}
      title={renderProduct ? '专属产物库' : isWorkflow ? '工作流任务' : 'AI 对话'}
      primaryAction={isChat
        ? { label: '新对话', onClick: onNew }
        : !renderProduct && workflow
          ? { label: '新建任务', onClick: workflow.onNew }
          : undefined}
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
            layers={[{ title: '对话', items: convItems, emptyText: query ? '没有匹配的对话' : '暂无对话，点「新对话」开始' }]}
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
      ) : isWorkflow && !renderProduct ? (
        <NestedNavList
          layers={[{ title: '任务', items: taskItems, emptyText: '还没有任务，点「新建任务」创建' }]}
          onBack={() => {}}
          onItemClick={(item) => workflow?.onSelect(item.id)}
        />
      ) : renderProduct ? (
        <NestedNavList
          layers={[{ title: '产物', items: productItems, emptyText: '还没有产出，对话后可保存到专属产物库' }]}
          onBack={() => {}}
          onItemClick={(item) => {
            const p = work?.products.find((x) => x.id === item.id);
            if (p) work?.onView(p);
          }}
        />
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