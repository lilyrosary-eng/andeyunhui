// 独立「AI 对话」模块 · 左侧共享侧栏 —— 复用侧边栏模板（ModuleSidebarShell + NestedNavList）。
// 按当前子模块切换内容，避免各子模块视图内部再自建第二层侧栏。
// 对 work / workflow 子模块，侧栏顶部有一组「任务区 | 产物区」切换——切换覆盖的就是侧栏本身：
//   - 任务区：二者共用同一份「统一任务」列表（AIWork 流式对话 与 AIWorkflow 蓝图编辑同一条任务）
//   - 产物区：二者共用同一份专属产物库列表
// chat 子模块为纯会话列表，不显示该切换。全部逻辑由宿主（Root）托管，侧栏只负责展示与触发。
import { memo, useState } from 'react';
import { Bot, Users, MessageSquare, Trash2, Pencil, LayoutGrid, FileText, Workflow, Save, Star, Clock, Image as ImageIcon, Video as VideoIcon } from 'lucide-react';
import { ModuleSidebarShell } from '@/components/ModuleSidebarShell';
import { NestedNavList, type NavLayerItem } from '@/components/NestedNavList';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { GroupCreateDialog } from '@/components/ai-chat/GroupCreateDialog';
import { AiWorkTabs, type AiWorkTab } from '@/components/ai-chat/AiWorkTabs';
import type { Conversation } from '@/components/capsule/types';
import type { AISubmoduleDef } from '@/core/ai/submodules';
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
  /** 任务区 / 产物区（受控于宿主；仅 work / workflow 子模块显示切换，chat 忽略） */
  area?: AiWorkTab;
  onAreaChange?: (t: AiWorkTab) => void;
  /** work 子模块：AIWork 会话（任务区） + 专属产物库（产物区） */
  work?: {
    /** 任务区：AIWork 独立对话的会话列表 */
    sessions: Conversation[];
    activeSessionId: string;
    onSelectSession: (id: string) => void;
    onNewSession: () => void;
    onDeleteSession: (id: string) => void;
    onRenameSession: (id: string, title: string) => void;
    /** 产物区：专属产物库列表 */
    products: AiWorkProduct[];
    viewingId?: string | null;
    onView: (p: AiWorkProduct) => void;
    /** 右键「保存」：归档移出记录（文件保留在主目录） */
    onArchive: (id: string) => void;
    /** 右键「收藏」：移动到收藏目录 */
    onFav: (id: string) => void;
    /** 右键「待决」：移动到待决目录 */
    onPending: (id: string) => void;
    /** 右键「删除」：移出记录 + 删除本地文件 */
    onDeleteProduct: (id: string) => void;
  };
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
  area = 'task',
  onAreaChange,
  work,
}: AiChatSidebarProps) {
  const [query, setQuery] = useState('');
  const [showGroupDialog, setShowGroupDialog] = useState(false);

  const isChat = !submodule || submodule.id === 'chat';
  const isWork = submodule?.id === 'work';
  const isWorkflow = submodule?.id === 'workflow';
  const showArea = isWork || isWorkflow;
  const inTask = !showArea || area === 'task';
  const inProduct = showArea && area === 'product';

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

  // work / workflow 子模块 · 任务区：AIWork 对话 与 AIWorkflow 蓝图编辑同一份统一任务列表
  const taskItems: NavLayerItem[] = (work?.sessions ?? []).map((c) => ({
    id: c.id,
    icon: <MessageSquare size={15} />,
    title: c.title || '未命名任务',
    subtitle: c.messages.length ? `${c.messages.length} 条消息` : '暂无消息',
    active: c.id === work?.activeSessionId,
    contextMenu: (
      <>
        <ContextMenuItem onSelect={() => {
          const next = window.prompt('任务改名', c.title);
          if (next !== null) work?.onRenameSession(c.id, next);
        }}>
          <span className="flex items-center gap-2"><Pencil size={14} /> 重命名</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => work?.onDeleteSession(c.id)}>
          <span className="flex items-center gap-2 text-red-500"><Trash2 size={14} /> 删除</span>
        </ContextMenuItem>
      </>
    ),
  }));

  // 产物区（work / workflow 共用）：专属产物库列表 —— 任务区专用卡片渲染
  const productGrid = work && (work.products ?? []).length > 0 && (
    <div className="space-y-0.5">
      {(work.products ?? []).map((p) => {
        const isMedia = p.kind === 'image' || p.kind === 'video';
        const menu = (
          <>
            <ContextMenuItem onSelect={() => work.onArchive(p.id)}>
              <span className="flex items-center gap-2"><Save size={14} /> 保存</span>
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => work.onFav(p.id)}>
              <span className="flex items-center gap-2"><Star size={14} /> 收藏</span>
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => work.onPending(p.id)}>
              <span className="flex items-center gap-2"><Clock size={14} /> 待决</span>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => work.onDeleteProduct(p.id)}>
              <span className="flex items-center gap-2 text-red-500"><Trash2 size={14} /> 删除</span>
            </ContextMenuItem>
          </>
        );

        const card = isMedia ? (
          // 图片 / 视频：矩形缩略占位 + 标题
          <button
            onClick={() => work.onView(p)}
            className={`w-full text-left rounded-xl overflow-hidden border ${
              p.id === work.viewingId
                ? 'border-[var(--element-color-raw)]'
                : 'border-black/5 dark:border-white/5 hover:border-black/10 dark:hover:border-white/10'
            }`}
          >
            <div className="aspect-[16/10] w-full bg-gradient-to-br from-neutral-100 to-neutral-200 dark:from-stone-800 dark:to-stone-900 flex items-center justify-center">
              <span className="text-neutral-400 dark:text-stone-500">
                {p.kind === 'image' ? <ImageIcon size={22} /> : <VideoIcon size={22} />}
              </span>
            </div>
            <div className="px-3 py-2">
              <div className="text-sm truncate">{p.title || 'AI 产物'}</div>
              <div className="text-[11px] opacity-50 mt-0.5">
                {p.kind === 'image' ? '图片' : '视频'} ·{' '}
                {new Date(p.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          </button>
        ) : (
          // 文件 / 文本：文字展示
          <button
            onClick={() => work.onView(p)}
            className={`w-full text-left px-3 py-2 rounded-xl transition-colors flex items-start gap-2.5 ${
              p.id === work.viewingId
                ? 'bg-[var(--element-color-raw)]/10 text-[var(--element-color-raw)]'
                : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400'
            }`}
          >
            <span className="flex-shrink-0 pt-0.5 opacity-60"><FileText size={15} /></span>
            <div className="min-w-0 flex-1">
              <div className="text-sm truncate">{p.title || 'AI 产出'}</div>
              <div className="text-[11px] opacity-50 mt-0.5 line-clamp-2 break-all">
                {p.content || new Date(p.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          </button>
        );
        return (
          <ContextMenu key={p.id}>
            <ContextMenuTrigger className="w-full">{card}</ContextMenuTrigger>
            <ContextMenuContent>{menu}</ContextMenuContent>
          </ContextMenu>
        );
      })}
    </div>
  );

  let title = 'AI 对话';
  if (!isChat && inProduct) title = '专属产物库';
  else if (showArea) title = '任务';

  let icon = <Bot size={20} />;
  if (!isChat && inProduct) icon = <Workflow size={20} />;
  else if (showArea) icon = <Workflow size={20} />;

  const primaryAction = isChat
    ? { label: '新对话', onClick: onNew }
    : inProduct
      ? undefined
      : showArea
        ? { label: '新建任务', onClick: work?.onNewSession ?? (() => {}) }
        : undefined;

  return (
    <ModuleSidebarShell
      moduleId="ai-chat"
      icon={icon}
      title={title}
      primaryAction={primaryAction}
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
      ) : (
        <>
          {showArea && (
            <div className="shrink-0 px-3 pt-2.5">
              <AiWorkTabs value={area} onChange={onAreaChange ?? (() => {})} />
            </div>
          )}
          {inProduct ? (
            <NestedNavList
              layers={[{ title: '产物', children: productGrid ?? <div className="flex-1 flex items-center justify-center text-xs text-neutral-400 dark:text-stone-500 py-8">还没有产出，对话后可保存到专属产物库</div> }]}
              onBack={() => {}}
            />
          ) : showArea ? (
            <NestedNavList
              layers={[{ title: '任务', items: taskItems, emptyText: '还没有任务，点「新建任务」创建' }]}
              onBack={() => {}}
              onItemClick={(item) => work?.onSelectSession(item.id)}
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
        </>
      )}
    </ModuleSidebarShell>
  );
});

export default AiChatSidebar;